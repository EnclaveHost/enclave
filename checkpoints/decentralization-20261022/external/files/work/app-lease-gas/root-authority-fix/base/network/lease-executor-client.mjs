// work/app-lease-gas/client/lease-executor-client.mjs - design B, shared by Linux (supervisor.js) and Windows
// (windows/node/chain.mjs): a host's claim / renew / release paid from the APP's ETH reserve
// (contracts/EnclaveLeaseGasReserve.sol), signed locally by the operator key (EIP-7702-delegated to
// contracts/EnclaveLeaseExecutor.sol), sent by a relay.
//
// TRUST (round 3, root review):
//   - A RELAY (startLeaseRelay / checkRelayRequest) is permissionless, but it relays ONLY for the reserve and executor
//     it pinned (address AND runtime code hash). Before it spends anything it verifies: the operator's code is the
//     EIP-7702 designator 0xef0100||executor, or the request carries a valid authorization to exactly that executor
//     (right chain, right signer, the account's current nonce); the EIP-712 Lease signature recovers to the operator;
//     the payee is the relay; the nonce lane and deadline; the reserve's policy; that the app's reserve will pay at
//     least the relay's own cost (the owner's gas-price cap, the signed maximum, balance, per-op and epoch caps); and
//     a simulation of the exact transaction. Payment is atomic by the verified code: finish() pays or everything
//     reverts. It is never a call-anything service: no other target, no other function, bounded body, time and
//     concurrency, one send at a time per relay key.
//   - A HOST never takes a relay's word. A landed lease is verified against its OWN RPCs (all must agree): the
//     transaction's target and exact calldata, the receipt's status, a LeaseGasPaid log emitted by the reserve with
//     this deployment, operator, kind and the signed payee, the operator's nonce lane past this lease, and the ledger's
//     effect. Relays are tried in turn with per-request and overall timeouts; an untrusted refusal never stops the
//     failover, only a refusal the host verifies itself (its own policy read or simulation) does. A lost response is
//     recovered from the chain (the nonce lane and the reserve's logs); a nonce consumed by anything else is NOT
//     taken as this operation's success.
import http from "node:http";
import { getAddress, concat, encodeFunctionData, decodeFunctionData, decodeEventLog, decodeErrorResult, keccak256, hashTypedData,
         recoverAddress, isAddress, isHex, encodeAbiParameters } from "viem";
import { recoverAuthorizationAddress } from "viem/utils";

export const KIND = Object.freeze({ claim: 1, renew: 2, release: 3 });
const KIND_NAME = ["", "claim", "renew", "release"];
export const STATUS = ["Ready", "Paused", "Blocked", "Unknown", "Retired", "Disabled", "Inactive", "LeaseLive", "LeaseExpired",
  "NotRunner", "NotOperator", "ClaimantNotAllowed", "ClaimCooldown", "ClaimLimitReached", "NotInRenewWindow", "OverRateCap",
  "ExtensionTooShort", "ReleaseNotSponsored", "EmptyReserve", "EpochCapReached", "BadKind", "ProofKeyMissing", "BondRequired"];
export const WHY = {
  Paused: "app-funded lease gas is paused by the platform", Blocked: "this deployment or operator is blocked by platform moderation",
  Unknown: "no such deployment on this reserve's ledger", Retired: "the ledger is retired", Disabled: "the app's owner has not enabled a lease-gas reserve",
  Inactive: "the deployment is stopped", LeaseLive: "the lease is still live (a claim is valid only after it expires)",
  LeaseExpired: "the lease expired (claim it instead)", NotRunner: "this operator does not hold the lease",
  NotOperator: "this operator is not that enclave's active registry operator", ClaimantNotAllowed: "the app's owner does not allow this host to claim it",
  ClaimCooldown: "claim cooldown (the same host re-claiming too soon, or another claim within the interval)",
  ClaimLimitReached: "the app's sponsored-claim limit for this epoch is reached", NotInRenewWindow: "not yet inside the app's renew window",
  OverRateCap: "the host's price is over the app's rate cap", ExtensionTooShort: "the lease this would buy is shorter than the app's minimum",
  ReleaseNotSponsored: "the app's owner does not sponsor releases", EmptyReserve: "the app's lease-gas reserve is empty: its owner must deposit",
  EpochCapReached: "the app's lease-gas spending cap for this epoch is reached", BadKind: "unknown operation kind",
  ProofKeyMissing: "the enclave has no proof key registered and the ledger's proof cutover has passed (setProofKey is the operator's own transaction)",
  BondRequired: "the ledger requires a claim bond (USDC collateral) this operator has not posted" };

export const CANONICAL_LENGTH = 388;
/** Upper estimates of a whole relay transaction's gas per kind (measured receipts, test/lease-executor-e2e.test.mjs:
 *  claim 290-327k, renew 150-183k, release 134k), with headroom: what a host signs as its maximum and a relay quotes. */
export const EST_GAS = Object.freeze({ claim: 380_000n, renew: 230_000n, release: 180_000n });
const ZERO32 = `0x${"00".repeat(32)}`;
const LEASE_TUPLE = { type: "tuple", name: "l", components: [{ name: "id", type: "bytes32" }, { name: "kind", type: "uint8" },
  { name: "enclaveId", type: "bytes32" }, { name: "nonce", type: "uint64" }, { name: "deadline", type: "uint64" },
  { name: "payee", type: "address" }, { name: "maxChargeWei", type: "uint256" }] };
export const EXECUTOR_ABI = [
  { type: "function", name: "lease", stateMutability: "nonpayable", inputs: [LEASE_TUPLE, { name: "signature", type: "bytes" }], outputs: [] },
  { type: "function", name: "nonceOf", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint64" }] },
  { type: "function", name: "reserve", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "error", name: "Expired", inputs: [] }, { type: "error", name: "BadSignature", inputs: [] },
  { type: "error", name: "BadNonce", inputs: [{ name: "expected", type: "uint64" }] }, { type: "error", name: "BadKind", inputs: [] },
  { type: "error", name: "NotCanonical", inputs: [] },
];
const RESERVE_TUPLE = [{ name: "balanceWei", type: "uint128" }, { name: "maxPerOpWei", type: "uint64" }, { name: "epochCapWei", type: "uint64" },
  { name: "enabled", type: "bool" }, { name: "claimPolicy", type: "uint8" }, { name: "sponsorRelease", type: "bool" }, { name: "renewWindow", type: "uint32" },
  { name: "minExtension", type: "uint32" }, { name: "claimCooldown", type: "uint32" }, { name: "epochSec", type: "uint32" }, { name: "maxGasPrice", type: "uint64" },
  { name: "maxClaimsPerEpoch", type: "uint8" }, { name: "epochIndex", type: "uint32" }, { name: "epochSpentWei", type: "uint96" }, { name: "epochClaims", type: "uint8" },
  { name: "lastClaimAt", type: "uint64" }, { name: "lastClaimOperator", type: "address" }];
export const RESERVE_ABI = [
  { type: "function", name: "statusOf", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "uint8" }, { type: "bytes32" }, { type: "address" }],
    outputs: [{ type: "uint8" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "reserveOf", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "tuple", components: RESERVE_TUPLE }] },
  { type: "function", name: "executor", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "ledger", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "limits", stateMutability: "view", inputs: [], outputs: [{ name: "maxGasPriceCeiling", type: "uint64" },
    { name: "overheadClaimGas", type: "uint32" }, { name: "overheadRenewGas", type: "uint32" }, { name: "overheadReleaseGas", type: "uint32" },
    { name: "minClaimInterval", type: "uint32" }, { name: "l1Bps", type: "uint16" }] },
  { type: "function", name: "l1Oracle", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "error", name: "Refused", inputs: [{ name: "status", type: "uint8" }] },
  { type: "event", name: "LeaseGasPaid", inputs: [{ name: "id", type: "bytes32", indexed: true }, { name: "owner", type: "address", indexed: true },
    { name: "operator", type: "address", indexed: true }, { name: "payee", type: "address" }, { name: "kind", type: "uint8" }, { name: "gas", type: "uint256" },
    { name: "gasPrice", type: "uint256" }, { name: "l1FeeWei", type: "uint256" }, { name: "chargedWei", type: "uint256" }] },
];
const LEDGER_ABI = [{ type: "function", name: "get", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "tuple", components: [
  { name: "id", type: "bytes32" }, { name: "owner", type: "address" }, { name: "appRef", type: "string" }, { name: "ports", type: "string" },
  { name: "configCid", type: "string" }, { name: "gpuMilli", type: "uint16" }, { name: "cpuMilli", type: "uint16" }, { name: "appPort", type: "uint32" },
  { name: "isPublic", type: "bool" }, { name: "active", type: "bool" }, { name: "createdAt", type: "uint64" }, { name: "rate", type: "uint256" },
  { name: "balance6", type: "uint256" }, { name: "spent6", type: "uint256" }, { name: "runner", type: "bytes32" }, { name: "runnerOperator", type: "address" },
  { name: "leaseUntil", type: "uint64" }] }] }];
const L1_ABI = [{ type: "function", name: "getL1FeeUpperBound", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] }];
const ERRORS = [...RESERVE_ABI, ...EXECUTOR_ABI, { type: "error", name: "Error", inputs: [{ type: "string" }] }].filter((x) => x.type === "error");
const TYPES = { Lease: [{ name: "reserve", type: "address" }, { name: "id", type: "bytes32" }, { name: "kind", type: "uint8" },
  { name: "enclaveId", type: "bytes32" }, { name: "nonce", type: "uint64" }, { name: "deadline", type: "uint64" },
  { name: "payee", type: "address" }, { name: "maxChargeWei", type: "uint256" }] };

export class LeaseRefusal extends Error { constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); } }
export const designator = (impl) => concat(["0xef0100", getAddress(impl)]).toLowerCase();
const lc = (a) => String(a).toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`${what}: no answer within ${ms} ms`)), ms).unref?.())]);

/** The Lease typed-data digest exactly as the executor computes it (verifyingContract = the operator's own address). */
export function leaseDigest({ chainId, operator, reserve, lease }) {
  return hashTypedData({ domain: { name: "EnclaveLeaseExecutor", version: "1", chainId, verifyingContract: getAddress(operator) },
    types: TYPES, primaryType: "Lease", message: { reserve: getAddress(reserve), ...lease } });
}
export const leaseCalldata = (lease, signature) => encodeFunctionData({ abi: EXECUTOR_ABI, functionName: "lease", args: [lease, signature] });

/** The reserve's error / executor error / revert string in words. */
export function reasonOf(e) {
  for (let x = e; x; x = x.cause) {
    const data = typeof x.data === "string" ? x.data : x.data?.data;
    if (typeof data === "string" && /^0x[0-9a-f]{8}/i.test(data)) {
      try {
        const d = decodeErrorResult({ abi: ERRORS, data });
        if (d.errorName === "Refused") return `Refused: ${STATUS[Number(d.args[0])]}`;
        return d.args?.length ? `${d.errorName}: ${d.args[0]}` : d.errorName;
      } catch {}
    }
  }
  return (e?.shortMessage || e?.message || String(e)).split("\n")[0].slice(0, 300);
}

/** Every client must give the same answer (the host's own RPCs, never a relay's). */
async function agreed(clients, f, what) {
  const xs = await Promise.all(clients.map(f));
  const key = (x) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  if (xs.some((x) => key(x) !== key(xs[0]))) throw new Error(`the host's RPCs disagree on ${what}`);
  return xs[0];
}

/** POLICY eligibility (the reserve's statusOf) - not a promise the money suffices; see preflight(). */
export async function policy({ client, reserve, id, kind, enclaveId = ZERO32, operator }) {
  const [st, availableWei, epochLeftWei, maxPerOpWei] = await client.readContract({ address: reserve, abi: RESERVE_ABI, functionName: "statusOf",
    args: [id, KIND[kind], enclaveId, getAddress(operator)] });
  return { status: STATUS[Number(st)] || `status ${st}`, availableWei, epochLeftWei, maxPerOpWei };
}

/** The charge a lease of `kind` may reach at `gasPrice` (an UPPER estimate: EST_GAS x price + the L1 bound share). */
export async function quote({ client, reserve, kind, gasPrice }) {
  const [lim, oracle] = await Promise.all([client.readContract({ address: reserve, abi: RESERVE_ABI, functionName: "limits" }),
                                           client.readContract({ address: reserve, abi: RESERVE_ABI, functionName: "l1Oracle" })]);
  const l1Bps = BigInt(lim[5]);
  let l1 = 0n;
  if (l1Bps > 0n && lc(oracle) !== lc("0x0000000000000000000000000000000000000000"))
    l1 = (await client.readContract({ address: oracle, abi: L1_ABI, functionName: "getL1FeeUpperBound", args: [BigInt(CANONICAL_LENGTH + 120)] })) * l1Bps / 10000n;
  return EST_GAS[kind] * gasPrice + l1;
}

/** Fees a relay would send with now: priority 0.001 gwei, max fee 2x base + priority. */
export async function currentFees(client, priorityFee = 1_000_000n) {
  const base = (await client.getBlock()).baseFeePerGas ?? 0n;
  return { base, priorityFee, maxFeePerGas: base * 2n + priorityFee, effective: base + priorityFee };
}

// =====================================================================================================================
// RELAY
// =====================================================================================================================

/** A relay's pinned configuration: the reserve and executor it serves, by address AND code hash. */
export async function pinRelayContracts({ client, reserve, reserveCodeHash, executorCodeHash }) {
  reserve = getAddress(reserve);
  const executor = getAddress(await client.readContract({ address: reserve, abi: RESERVE_ABI, functionName: "executor" }));
  const [rc, ec, back] = await Promise.all([client.getCode({ address: reserve }), client.getCode({ address: executor }),
    client.readContract({ address: executor, abi: EXECUTOR_ABI, functionName: "reserve" })]);
  if (!rc || keccak256(rc) !== lc(reserveCodeHash)) throw new Error(`reserve ${reserve} is not the pinned code`);
  if (!ec || keccak256(ec) !== lc(executorCodeHash)) throw new Error(`executor ${executor} is not the pinned code`);
  if (getAddress(back) !== reserve) throw new Error("the executor serves another reserve");
  return { chainId: client.chain.id, reserve, executor };
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
/** Shape-check an untrusted request body (no chain access). -> the signed lease object, or throws LeaseRefusal("BadRequest"). */
export function parseRelayRequest(b) {
  const bad = (m) => { throw new LeaseRefusal("BadRequest", m); };
  if (!b || typeof b !== "object") bad("not an object");
  const l = b.lease || {};
  if (!isAddress(b.operator || "")) bad("operator");
  if (!HEX32.test(l.id || "") || !HEX32.test(l.enclaveId || "")) bad("lease id / enclaveId");
  if (![1, 2, 3].includes(Number(l.kind))) bad("lease kind");
  for (const k of ["nonce", "deadline", "maxChargeWei"]) if (!/^\d{1,78}$/.test(String(l[k] ?? ""))) bad(`lease ${k}`);
  if (!isAddress(l.payee || "")) bad("lease payee");
  if (!/^0x[0-9a-fA-F]{130}$/.test(b.signature || "")) bad("signature must be 65 bytes");
  let authorization = null;
  if (b.authorization) {
    const a = b.authorization;
    if (!isAddress(a.address || "") || !HEX32.test(a.r || "") || !HEX32.test(a.s || "") || ![0, 1].includes(Number(a.yParity))) bad("authorization");
    authorization = { address: getAddress(a.address), chainId: Number(a.chainId), nonce: Number(a.nonce), r: a.r, s: a.s, yParity: Number(a.yParity) };
    if (!Number.isSafeInteger(authorization.chainId) || !Number.isSafeInteger(authorization.nonce)) bad("authorization numbers");
  }
  return { operator: getAddress(b.operator), signature: b.signature, authorization,
           lease: { id: l.id, kind: Number(l.kind), enclaveId: l.enclaveId, nonce: BigInt(l.nonce), deadline: BigInt(l.deadline),
                    payee: getAddress(l.payee), maxChargeWei: BigInt(l.maxChargeWei) } };
}

/** Everything a relay verifies BEFORE it spends: see the file header. -> { data, authorizationList, fees, expectedCharge } */
export async function checkRelayRequest({ client, pinned, payee, signed, priorityFee = 1_000_000n, minDeadlineSec = 20 }) {
  const { operator, lease, signature, authorization } = signed;
  const refuse = (code, m) => { throw new LeaseRefusal(code, m); };
  if (getAddress(lease.payee) !== getAddress(payee)) refuse("WrongPayee", `the lease pays ${lease.payee}, not this relay`);
  const block = await client.getBlock();
  if (lease.deadline < block.timestamp + BigInt(minDeadlineSec)) refuse("Expired", "the lease's deadline is (nearly) past");
  // EIP-7702: a delegated account's code IS the 23-byte designator 0xef0100||implementation (EXTCODEHASH = its keccak)
  const code = lc((await client.getCode({ address: operator })) || "0x");
  const delegated = code === designator(pinned.executor);
  if (!delegated) {
    if (code !== "0x" && !code.startsWith("0xef0100")) refuse("NotAnOperatorKey", "the operator address holds contract code (not an EOA)");
    if (!authorization) refuse("NotDelegated", "the operator is not delegated to the pinned executor and carries no authorization");
    if (getAddress(authorization.address) !== pinned.executor) refuse("WrongExecutor", "the authorization delegates to another contract");
    if (authorization.chainId !== pinned.chainId && authorization.chainId !== 0) refuse("WrongChain", "the authorization is for another chain");
    let signer = null;
    try { signer = await recoverAuthorizationAddress({ authorization }); } catch {}
    if (!signer || getAddress(signer) !== operator) refuse("BadAuthorization", "the authorization is not signed by the operator");
    const n = await client.getTransactionCount({ address: operator });
    if (authorization.nonce !== n) refuse("StaleAuthorization", `the authorization's nonce ${authorization.nonce} is not the account's ${n}`);
  }
  const recovered = await recoverAddress({ hash: leaseDigest({ chainId: pinned.chainId, operator, reserve: pinned.reserve, lease }), signature });
  if (getAddress(recovered) !== operator) refuse("BadSignature", "the lease is not signed by the operator for this reserve");
  const nextNonce = delegated ? await client.readContract({ address: operator, abi: EXECUTOR_ABI, functionName: "nonceOf", args: [lease.id] }) : 0n;
  if (BigInt(nextNonce) !== lease.nonce) refuse("BadNonce", `the operator's next nonce for this deployment is ${nextNonce}`);
  const kindName = KIND_NAME[lease.kind];
  const pol = await policy({ client, reserve: pinned.reserve, id: lease.id, kind: kindName, enclaveId: lease.enclaveId, operator });
  if (pol.status !== "Ready") refuse(pol.status, WHY[pol.status] || pol.status);
  // the relay is paid at min(its effective gas price, the owner's cap, the admin's ceiling): refuse to work at a loss
  const fees = await currentFees(client, priorityFee);
  const ledger = await client.readContract({ address: pinned.reserve, abi: RESERVE_ABI, functionName: "ledger" });
  const d = await client.readContract({ address: ledger, abi: LEDGER_ABI, functionName: "get", args: [lease.id] });
  const r = await client.readContract({ address: pinned.reserve, abi: RESERVE_ABI, functionName: "reserveOf", args: [lease.id, d.owner] });
  const lim = await client.readContract({ address: pinned.reserve, abi: RESERVE_ABI, functionName: "limits" });
  if (BigInt(r.maxGasPrice) < fees.effective || BigInt(lim[0]) < fees.effective)
    refuse("UnderpaidGasPrice", `the app's gas price cap ${r.maxGasPrice} is below the current fee ${fees.effective}: the relay would be underpaid`);
  const expectedCharge = await quote({ client, reserve: pinned.reserve, kind: kindName, gasPrice: fees.effective });
  if (expectedCharge > lease.maxChargeWei) refuse("OverSignedMax", `the expected charge ${expectedCharge} exceeds the signed maximum ${lease.maxChargeWei}`);
  if (expectedCharge > BigInt(r.balanceWei) || expectedCharge > BigInt(r.maxPerOpWei) || expectedCharge > pol.epochLeftWei)
    refuse("Unaffordable", "the app's reserve, per-operation cap or epoch cap does not cover the expected charge");
  const data = leaseCalldata(lease, signature);
  if ((data.length - 2) / 2 !== CANONICAL_LENGTH) refuse("NotCanonical", "not the canonical encoding");
  return { data, authorizationList: delegated ? undefined : [authorization], fees, expectedCharge };
}

/** RELAY: check, simulate, send, and confirm the payment from the receipt (the event emitted by the PINNED reserve). */
export async function relayLease({ client, wallet, pinned, signed, gas = 600_000n, receiptTimeoutMs = 120_000 }) {
  const payee = wallet.account.address;
  const c = await checkRelayRequest({ client, pinned, payee, signed });
  const tx = { account: wallet.account, to: signed.operator, data: c.data, authorizationList: c.authorizationList, gas,
               maxPriorityFeePerGas: c.fees.priorityFee, maxFeePerGas: c.fees.maxFeePerGas };
  try { await client.call(tx); } catch (e) { throw new LeaseRefusal("Simulation", `simulation: ${reasonOf(e)}`); }
  const hash = await wallet.sendTransaction(tx);
  const receipt = await withTimeout(client.waitForTransactionReceipt({ hash }), receiptTimeoutMs, "receipt");
  let paid = null;
  for (const l of receipt.logs) {
    if (lc(l.address) !== lc(pinned.reserve)) continue;   // only the pinned reserve's own events count
    try { const ev = decodeEventLog({ abi: RESERVE_ABI, data: l.data, topics: l.topics });
      if (ev.eventName === "LeaseGasPaid" && lc(ev.args.payee) === lc(payee) && lc(ev.args.operator) === lc(signed.operator) && ev.args.id === signed.lease.id) paid = ev.args;
    } catch {}
  }
  return { hash, receipt, paid, expectedCharge: c.expectedCharge };
}

/**
 * A minimal open relay over HTTP. GET /v1/info -> {chainId, reserve, executor, payee, canonicalLength}; POST /v1/lease.
 * Bounded: body <= 4 KiB, request time, concurrency (excess -> 503), and ONE send at a time from this relay's key.
 */
export async function startLeaseRelay({ client, wallet, reserve, reserveCodeHash, executorCodeHash, host = "127.0.0.1", port = 0,
                                        maxBody = 4096, maxConcurrent = 4, requestTimeoutMs = 60_000, log = () => {} }) {
  const pinned = await pinRelayContracts({ client, reserve, reserveCodeHash, executorCodeHash });
  let inflight = 0, sendQueue = Promise.resolve();
  const server = http.createServer(async (req, res) => {
    const reply = (status, body) => { if (res.writableEnded) return; res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v))); };
    req.setTimeout(10_000, () => { reply(408, { error: "timeout" }); req.destroy(); });
    if (req.method === "GET" && req.url === "/v1/info")
      return reply(200, { chainId: pinned.chainId, reserve: pinned.reserve, executor: pinned.executor, payee: wallet.account.address, canonicalLength: CANONICAL_LENGTH });
    if (req.method !== "POST" || req.url !== "/v1/lease") return reply(404, { error: "not_found" });
    if (inflight >= maxConcurrent) return reply(503, { error: "busy" });
    inflight++;
    try {
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > maxBody) return reply(413, { error: "too_large" }); chunks.push(c); }
      let signed;
      try { signed = parseRelayRequest(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { return reply(400, { error: e.code || "bad_json", message: String(e.message).slice(0, 200) }); }
      // one send at a time from this key (its account nonce), and therefore per operator too
      const job = sendQueue.then(() => withTimeout(relayLease({ client, wallet, pinned, signed }), requestTimeoutMs, "relay"));
      sendQueue = job.catch(() => {});
      const r = await job;
      log(`[relay] ${r.receipt.status} ${r.hash} paid ${r.paid?.chargedWei ?? "none"}`);
      reply(200, { hash: r.hash, status: r.receipt.status, paid: r.paid });
    } catch (e) {
      reply(e instanceof LeaseRefusal ? 422 : 502, { error: e.code || "relay_failed", message: String(e.message).slice(0, 300) });
    } finally { inflight--; }
  });
  server.headersTimeout = 10_000; server.requestTimeout = requestTimeoutMs + 5_000;
  await new Promise((ok) => server.listen(port, host, ok));
  return { url: `http://${host}:${server.address().port}`, pinned,
           close: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(() => ok()); }) };
}

// =====================================================================================================================
// HOST
// =====================================================================================================================

/** A relay URL a host may contact: https, or plain http to loopback only when explicitly allowed (tests). */
export function validateRelayUrl(url, { allowLoopbackHttp = false } = {}) {
  let u; try { u = new URL(url); } catch { throw new Error(`not a URL: ${String(url).slice(0, 80)}`); }
  if (u.username || u.password) throw new Error("relay URLs carry no credentials");
  if (u.protocol === "https:") return u.origin;
  if (u.protocol === "http:" && allowLoopbackHttp && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) return u.origin;
  throw new Error(`relay URL must be https (got ${u.protocol}//${u.hostname})`);
}

async function boundedFetchJson(fetchImpl, url, init, timeoutMs, maxBytes = 16_384) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { ...init, signal: ctl.signal });
    const reader = r.body?.getReader?.();
    let text = "";
    if (reader) {
      let n = 0; const dec = new TextDecoder();
      for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; if (n > maxBytes) { ctl.abort(); throw new Error("relay answer too large"); } text += dec.decode(value, { stream: true }); }
    } else text = await r.text();
    let j = {}; try { j = JSON.parse(text); } catch {}
    return { status: r.status, body: j };
  } finally { clearTimeout(t); }
}

/**
 * The host client. clients: the host's OWN RPC clients (every one must agree on what verifies a landing).
 *   const lc = createLeaseClient({ clients, account, reserve, relays });
 *   await lc.claim(id, enclaveId) / lc.renew(id) / lc.release(id)  -> { hash, receipt }   (verified; throws LeaseRefusal)
 *   lc.asClaimTx(fn, args) -> a hash promise with .receipt (supervisor.js sendClaimTx's shape)
 */
export function createLeaseClient({ client, clients = [client], account, reserve, relays, allowLoopbackHttp = false, fetchImpl = fetch,
                                    requestTimeoutMs = 20_000, overallTimeoutMs = 180_000, ttlSec = 300, log = () => {}, onSigned = null }) {
  if (!relays?.length) throw new Error("lease-gas: at least one relay URL is required");
  const urls = relays.map((u) => validateRelayUrl(u, { allowLoopbackHttp }));
  reserve = getAddress(reserve);
  const c0 = clients[0];
  let executorP = null;
  const executor = () => (executorP ||= c0.readContract({ address: reserve, abi: RESERVE_ABI, functionName: "executor" }).then(getAddress));

  async function nonceOf(id, blockNumber) {
    const ex = await executor();
    return agreed(clients, async (c) => {
      const code = lc((await c.getCode({ address: account.address, blockNumber })) || "0x");
      if (code !== designator(ex)) return 0n;
      return BigInt(await c.readContract({ address: account.address, abi: EXECUTOR_ABI, functionName: "nonceOf", args: [id], blockNumber }));
    }, "the lease nonce");
  }

  /** Verify on the host's own RPCs that `hash` is THIS operator's lease `want` (id, kind, enclaveId, nonce) landing. */
  async function verifyLanded(hash, want, payees) {
    return agreed(clients, async (c) => {
      const [tx, rc] = await Promise.all([c.getTransaction({ hash }), c.getTransactionReceipt({ hash })]);
      if (!tx.to || getAddress(tx.to) !== getAddress(account.address)) throw new Error("the transaction does not call this operator");
      const call = decodeFunctionData({ abi: EXECUTOR_ABI, data: tx.input });
      if (call.functionName !== "lease" || (tx.input.length - 2) / 2 !== CANONICAL_LENGTH) throw new Error("not a canonical lease call");
      const l = call.args[0];
      if (l.id !== want.id || Number(l.kind) !== want.kind || l.enclaveId !== want.enclaveId || BigInt(l.nonce) !== want.nonce) throw new Error("another lease than the one signed");
      if (payees && !payees.some((p) => lc(p) === lc(l.payee))) throw new Error("a payee this host never signed");
      if (rc.status !== "success") throw new Error(`the lease transaction reverted (${hash})`);
      const paid = rc.logs.filter((g) => lc(g.address) === lc(reserve)).map((g) => { try { return decodeEventLog({ abi: RESERVE_ABI, data: g.data, topics: g.topics }); } catch { return null; } })
        .find((ev) => ev?.eventName === "LeaseGasPaid" && ev.args.id === want.id && lc(ev.args.operator) === lc(account.address) && Number(ev.args.kind) === want.kind && lc(ev.args.payee) === lc(l.payee));
      if (!paid) throw new Error("no LeaseGasPaid from the reserve for this lease");
      const ledger = await c.readContract({ address: reserve, abi: RESERVE_ABI, functionName: "ledger" });
      const d = await c.readContract({ address: ledger, abi: LEDGER_ABI, functionName: "get", args: [want.id], blockNumber: rc.blockNumber });
      if (want.kind === 1 && (lc(d.runnerOperator) !== lc(account.address) || d.runner !== want.enclaveId)) throw new Error("the ledger does not show this claim");
      if (want.kind === 3 && !/^0x0{40}$/i.test(d.runnerOperator)) throw new Error("the ledger does not show the release");
      if (want.kind === 2 && lc(d.runnerOperator) !== lc(account.address)) throw new Error("the ledger does not show this renewal");
      return { hash, blockNumber: rc.blockNumber, chargedWei: paid.args.chargedWei, payee: paid.args.payee };
    }, "the landed lease").then((v) => ({ ...v, receiptP: c0.getTransactionReceipt({ hash }) }));
  }

  /** The chain's own record: a LeaseGasPaid by this operator for `id` from `fromBlock` whose transaction is THIS lease. */
  async function findLanded(want, fromBlock, payees) {
    const logs = await c0.getContractEvents({ address: reserve, abi: RESERVE_ABI, eventName: "LeaseGasPaid", args: { id: want.id, operator: account.address }, fromBlock });
    for (const g of logs) { try { return await verifyLanded(g.transactionHash, want, payees); } catch {} }
    return null;
  }

  async function run(kindName, id, enclaveId = ZERO32) {
    const kind = KIND[kindName];
    const ex = await executor();
    const pol = await policy({ client: c0, reserve, id, kind: kindName, enclaveId, operator: account.address });
    if (pol.status !== "Ready") throw new LeaseRefusal(pol.status, `${kindName} ${id} refused: ${WHY[pol.status] || pol.status}`);
    const nonce = await nonceOf(id);
    const head = await c0.getBlock();
    const fromBlock = head.number;
    const fees = await currentFees(c0);
    const r = await c0.readContract({ address: reserve, abi: RESERVE_ABI, functionName: "reserveOf",
      args: [id, (await c0.readContract({ address: await c0.readContract({ address: reserve, abi: RESERVE_ABI, functionName: "ledger" }), abi: LEDGER_ABI, functionName: "get", args: [id] })).owner] });
    // the host's own maximum: the upper quote at min(the owner's cap, 2x the current fee)
    const priceCap = BigInt(r.maxGasPrice) < fees.effective * 2n ? BigInt(r.maxGasPrice) : fees.effective * 2n;
    const maxChargeWei = await quote({ client: c0, reserve, kind: kindName, gasPrice: priceCap });
    const want = { id, kind, enclaveId, nonce };
    const deadline = head.timestamp + BigInt(ttlSec);
    const code = lc((await c0.getCode({ address: account.address })) || "0x");
    const authorization = code === designator(ex) ? null
      : await account.signAuthorization({ contractAddress: ex, chainId: c0.chain.id, nonce: await c0.getTransactionCount({ address: account.address }) });
    const payees = [], errors = [];
    const started = Date.now();
    for (const url of urls) {
      if (Date.now() - started > overallTimeoutMs) break;
      try {
        const info = await boundedFetchJson(fetchImpl, `${url}/v1/info`, {}, requestTimeoutMs);
        if (info.status !== 200 || Number(info.body.chainId) !== c0.chain.id || !isAddress(info.body.reserve || "") || getAddress(info.body.reserve) !== reserve
            || !isAddress(info.body.payee || "")) { errors.push(`${url}: does not serve this chain and reserve`); continue; }
        const lease = { id, kind, enclaveId, nonce, deadline, payee: getAddress(info.body.payee), maxChargeWei };
        const signature = await account.signTypedData({ domain: { name: "EnclaveLeaseExecutor", version: "1", chainId: c0.chain.id, verifyingContract: account.address },
          types: TYPES, primaryType: "Lease", message: { reserve, ...lease } });
        payees.push(lease.payee);
        if (onSigned) await onSigned({ nonce, deadline, payee: lease.payee, kind: kindName });   // durable record BEFORE the relay sees it
        const body = JSON.stringify({ operator: account.address, lease, signature, authorization }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
        const ans = await boundedFetchJson(fetchImpl, `${url}/v1/lease`, { method: "POST", headers: { "content-type": "application/json" }, body }, requestTimeoutMs);
        if (ans.status === 200 && HEX32.test(ans.body.hash || "")) {
          // the relay's word is a hint: verify it on the host's own RPCs (bounded wait for inclusion)
          const t0 = Date.now();
          for (;;) {
            try { const v = await verifyLanded(ans.body.hash, want, payees); log(`[lease-gas] ${kindName} ${id} landed in ${v.hash} via ${url}; the app's reserve paid ${v.chargedWei} wei`);
                  return { hash: v.hash, receipt: await v.receiptP, verified: v }; }
            catch (e) { if (Date.now() - t0 > requestTimeoutMs) { errors.push(`${url}: its answer did not verify (${e.message})`); break; } await sleep(1000); }
          }
        } else errors.push(`${url}: ${ans.status} ${String(ans.body.error || "")} ${String(ans.body.message || "").slice(0, 160)}`);
      } catch (e) { errors.push(`${url}: ${String(e.message).slice(0, 160)}`); }
      // before the next relay: did this lease land anyway (a lost answer)? And is the refusal real (the host's own view)?
      const landed = await findLanded(want, fromBlock, payees).catch(() => null);
      if (landed) { log(`[lease-gas] ${kindName} ${id} landed in ${landed.hash} (found on chain)`); return { hash: landed.hash, receipt: await landed.receiptP, verified: landed }; }
      if (await nonceOf(id) !== nonce) throw new LeaseRefusal("NonceConsumed", `${kindName} ${id}: the lease nonce ${nonce} was consumed by another operation; not this one's success`);
      const again = await policy({ client: c0, reserve, id, kind: kindName, enclaveId, operator: account.address });
      if (again.status !== "Ready") throw new LeaseRefusal(again.status, `${kindName} ${id} refused: ${WHY[again.status] || again.status}`);
    }
    throw new LeaseRefusal("NotRelayed", `no relay landed the ${kindName}: ${errors.slice(0, 6).join("; ")}`);
  }

  return {
    claim: (id, enclaveId) => run("claim", id, enclaveId),
    renew: (id) => run("renew", id),
    release: (id) => run("release", id),
    nonceOf, findLanded, verifyLanded, executor,
    asClaimTx(functionName, args) {
      const started = run(functionName, args[0], args[1]);
      const p = started.then((x) => x.hash);
      p.receipt = started.then((x) => x.receipt);
      p.receipt.catch(() => {});
      return p;
    },
  };
}
/** Round-2 name, kept for the hunks that import it. */
export const createLeaseSender = createLeaseClient;

/** An executable PREFLIGHT for an owner / host: simulate a lease of `kind` exactly as a relay would send it, signed by
 *  `account` (a host key) for a placeholder payee `from`. Returns {ok, reason}. Policy eligibility alone is not enough. */
export async function preflight({ client, account, reserve, id, kind, enclaveId = ZERO32, from }) {
  const ex = getAddress(await client.readContract({ address: reserve, abi: RESERVE_ABI, functionName: "executor" }));
  const code = lc((await client.getCode({ address: account.address })) || "0x");
  const nonce = code === designator(ex) ? BigInt(await client.readContract({ address: account.address, abi: EXECUTOR_ABI, functionName: "nonceOf", args: [id] })) : 0n;
  const head = await client.getBlock();
  const fees = await currentFees(client);
  const maxChargeWei = await quote({ client, reserve, kind, gasPrice: fees.effective * 2n });
  const lease = { id, kind: KIND[kind], enclaveId, nonce, deadline: head.timestamp + 300n, payee: getAddress(from), maxChargeWei };
  const signature = await account.signTypedData({ domain: { name: "EnclaveLeaseExecutor", version: "1", chainId: client.chain.id, verifyingContract: account.address },
    types: TYPES, primaryType: "Lease", message: { reserve: getAddress(reserve), ...lease } });
  const authorization = code === designator(ex) ? null
    : await account.signAuthorization({ contractAddress: ex, chainId: client.chain.id, nonce: await client.getTransactionCount({ address: account.address }) });
  try {
    await client.call({ account: getAddress(from), to: account.address, data: leaseCalldata(lease, signature), gas: 600_000n,
                        authorizationList: authorization ? [authorization] : undefined, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.priorityFee });
    return { ok: true, maxChargeWei };
  } catch (e) { return { ok: false, reason: reasonOf(e), maxChargeWei }; }
}

export const _test = { encodeAbiParameters };
