// work/app-lease-gas/client/lease-executor-client.mjs - design B, shared by Linux (supervisor.js) and Windows
// (windows/node/chain.mjs): a host's claim / renew / release paid from the APP's ETH reserve
// (contracts/EnclaveLeaseGasReserve.sol), signed locally by the operator key (EIP-7702-delegated to
// contracts/EnclaveLeaseExecutor.sol), relayed by ANY relay (startLeaseRelay below, or anyone's equivalent).
//
//   host:   status() -> buildLease() -> signLease() [+ the key's one-time 7702 authorization] -> submitToRelays()
//   relay:  relayLease(): simulate (a refusal costs nobody anything), send, return the receipt; the reserve pays the
//           relay in the same transaction.
//   adapter: createLeaseSender() -> { claim, renew, release } with the two call shapes the hosts already use.
// The host never needs ETH and never falls back to spending its own: a refusal is an explicit error with the
// reserve's own status word.
import http from "node:http";
import { getAddress, concat, encodeFunctionData, decodeEventLog, decodeErrorResult, numberToHex } from "viem";

export const KIND = Object.freeze({ claim: 1, renew: 2, release: 3 });
export const STATUS = ["Ready", "Paused", "Blocked", "Unknown", "Retired", "Disabled", "Inactive", "LeaseLive", "LeaseExpired",
  "NotRunner", "NotOperator", "ClaimantNotAllowed", "ClaimCooldown", "ClaimLimitReached", "NotInRenewWindow", "OverRateCap",
  "ExtensionTooShort", "ReleaseNotSponsored", "EmptyReserve", "EpochCapReached", "BadKind"];
const WHY = {
  Paused: "app-funded lease gas is paused by the platform", Blocked: "this deployment or operator is blocked by platform moderation",
  Unknown: "no such deployment on this reserve's ledger", Retired: "the ledger is retired", Disabled: "the app's owner has not enabled a lease-gas reserve",
  Inactive: "the deployment is stopped", LeaseLive: "the lease is still live (a claim is valid only after it expires)",
  LeaseExpired: "the lease expired (claim it instead)", NotRunner: "this operator does not hold the lease",
  NotOperator: "this operator is not that enclave's active registry operator", ClaimantNotAllowed: "the app's owner does not allow this host to claim it",
  ClaimCooldown: "claim cooldown (the same host re-claiming too soon, or another claim in the last interval)",
  ClaimLimitReached: "the app's sponsored-claim limit for this epoch is reached", NotInRenewWindow: "not yet inside the app's renew window",
  OverRateCap: "the host's price is over the app's rate cap", ExtensionTooShort: "the lease this would buy is shorter than the app's minimum",
  ReleaseNotSponsored: "the app's owner does not sponsor releases", EmptyReserve: "the app's lease-gas reserve is empty",
  EpochCapReached: "the app's lease-gas spending cap for this epoch is reached", BadKind: "unknown operation kind" };

export const RESERVE_ABI = [
  { type: "function", name: "statusOf", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "uint8" }, { type: "bytes32" }, { type: "address" }],
    outputs: [{ type: "uint8" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "executor", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "error", name: "Refused", inputs: [{ name: "status", type: "uint8" }] },
  { type: "event", name: "LeaseGasPaid", inputs: [{ name: "id", type: "bytes32", indexed: true }, { name: "owner", type: "address", indexed: true },
    { name: "operator", type: "address", indexed: true }, { name: "payee", type: "address" }, { name: "kind", type: "uint8" }, { name: "gas", type: "uint256" },
    { name: "gasPrice", type: "uint256" }, { name: "l1FeeWei", type: "uint256" }, { name: "chargedWei", type: "uint256" }] },
];
const LEASE_TUPLE = { type: "tuple", components: [{ name: "id", type: "bytes32" }, { name: "kind", type: "uint8" }, { name: "enclaveId", type: "bytes32" },
  { name: "nonce", type: "uint64" }, { name: "deadline", type: "uint64" }] };
export const EXECUTOR_ABI = [
  { type: "function", name: "lease", stateMutability: "nonpayable", inputs: [LEASE_TUPLE, { type: "bytes" }, { type: "address" }], outputs: [] },
  { type: "function", name: "nonceOf", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint64" }] },
  { type: "error", name: "Expired", inputs: [] }, { type: "error", name: "BadSignature", inputs: [] },
  { type: "error", name: "BadNonce", inputs: [{ name: "expected", type: "uint64" }] }, { type: "error", name: "BadKind", inputs: [] },
];
const ERRORS = [...RESERVE_ABI, ...EXECUTOR_ABI, { type: "error", name: "Error", inputs: [{ type: "string" }] }].filter((x) => x.type === "error");

export class LeaseRefusal extends Error { constructor(code, message) { super(message); this.code = code; } }
const designator = (impl) => concat(["0xef0100", impl]).toLowerCase();

/** The reserve's verdict, in words; throws LeaseRefusal unless Ready. */
export async function status({ client, reserve, id, kind, enclaveId = `0x${"00".repeat(32)}`, operator }) {
  const [st, availableWei, epochLeftWei, maxPerOpWei] = await client.readContract({ address: reserve, abi: RESERVE_ABI, functionName: "statusOf",
    args: [id, KIND[kind], enclaveId, getAddress(operator)] });
  const word = STATUS[Number(st)] || `status ${st}`;
  if (word !== "Ready") throw new LeaseRefusal(word, `${kind} ${id} refused: ${WHY[word] || word}`);
  return { status: word, availableWei, epochLeftWei, maxPerOpWei };
}

/** The Lease the key will sign: its next nonce for this deployment, a short deadline. */
export async function buildLease({ client, reserve, operator, id, kind, enclaveId = `0x${"00".repeat(32)}`, ttlSec = 600 }) {
  const executor = await client.readContract({ address: reserve, abi: RESERVE_ABI, functionName: "executor" });
  const code = ((await client.getCode({ address: operator })) || "0x").toLowerCase();
  const nonce = code === designator(executor)
    ? await client.readContract({ address: operator, abi: EXECUTOR_ABI, functionName: "nonceOf", args: [id] })
    : 0n;   // not yet delegated to the executor: its namespace was never written
  const block = await client.getBlock();
  return { executor, lease: { id, kind: KIND[kind], enclaveId, nonce: BigInt(nonce), deadline: block.timestamp + BigInt(ttlSec) } };
}

/** Sign LOCALLY (EIP-712, verifyingContract = the operator's own address) and, only while the key is not yet
 *  delegated to the executor, its EIP-7702 authorization (the relay's transaction carries it; the key pays nothing). */
export async function signLease({ client, account, reserve, executor, lease }) {
  const signature = await account.signTypedData({
    domain: { name: "EnclaveLeaseExecutor", version: "1", chainId: client.chain.id, verifyingContract: account.address },
    types: { Lease: [{ name: "reserve", type: "address" }, { name: "id", type: "bytes32" }, { name: "kind", type: "uint8" },
                     { name: "enclaveId", type: "bytes32" }, { name: "nonce", type: "uint64" }, { name: "deadline", type: "uint64" }] },
    primaryType: "Lease", message: { reserve: getAddress(reserve), ...lease } });
  const code = ((await client.getCode({ address: account.address })) || "0x").toLowerCase();
  const authorization = code === designator(executor) ? null
    : await account.signAuthorization({ contractAddress: executor, chainId: client.chain.id,
                                        nonce: await client.getTransactionCount({ address: account.address }) });
  return { operator: account.address, lease, signature, authorization };
}

/** The relay's error in words (Refused(status) / executor errors / a revert string). */
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
  return (e?.shortMessage || e?.message || String(e)).split("\n")[0];
}

const toJson = (v) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
const fromJsonLease = (l) => ({ id: l.id, kind: Number(l.kind), enclaveId: l.enclaveId, nonce: BigInt(l.nonce), deadline: BigInt(l.deadline) });
const fromJsonAuth = (a) => a ? { address: a.address, chainId: Number(a.chainId), nonce: Number(a.nonce), r: a.r, s: a.s, yParity: Number(a.yParity) } : null;

/** RELAY side: simulate, then send the operator's signed lease (with its authorization if any) and return the
 *  receipt plus what the reserve paid. A simulation refusal costs nothing. Anyone with a funded key can run this. */
export async function relayLease({ client, wallet, signed, payee = wallet.account.address, gas = 600_000n, priorityFee = 1_000_000n }) {
  const data = encodeFunctionData({ abi: EXECUTOR_ABI, functionName: "lease", args: [signed.lease, signed.signature, payee] });
  const authorizationList = signed.authorization ? [signed.authorization] : undefined;
  try { await client.call({ account: wallet.account, to: signed.operator, data, authorizationList, gas }); }
  catch (e) { throw new LeaseRefusal("Simulation", `the lease would not go through: ${reasonOf(e)}`); }
  // the reserve pays at most min(tx.gasprice, the owner's cap): a relay bidding more only loses money
  const base = (await client.getBlock()).baseFeePerGas ?? 0n;
  const hash = await wallet.sendTransaction({ to: signed.operator, data, authorizationList, gas,
                                             maxPriorityFeePerGas: priorityFee, maxFeePerGas: base * 2n + priorityFee });
  const receipt = await client.waitForTransactionReceipt({ hash });
  let paid = null;
  for (const l of receipt.logs) {
    try { const ev = decodeEventLog({ abi: RESERVE_ABI, data: l.data, topics: l.topics }); if (ev.eventName === "LeaseGasPaid") paid = ev.args; } catch {}
  }
  return { hash, receipt, paid };
}

/** A minimal open relay over HTTP: POST /v1/lease {operator, lease, signature, authorization}. */
export async function startLeaseRelay({ client, wallet, host = "127.0.0.1", port = 0, log = () => {} }) {
  const server = http.createServer(async (req, res) => {
    const reply = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(toJson(body))); };
    if (req.method !== "POST" || req.url !== "/v1/lease") return reply(404, { error: "not_found" });
    const chunks = []; for await (const c of req) chunks.push(c);
    let b; try { b = JSON.parse(Buffer.concat(chunks).toString()); } catch { return reply(400, { error: "bad_json" }); }
    try {
      const r = await relayLease({ client, wallet, signed: { operator: getAddress(b.operator), lease: fromJsonLease(b.lease), signature: b.signature,
                                                            authorization: fromJsonAuth(b.authorization) } });
      log(`[relay] ${r.receipt.status} ${r.hash} paid ${r.paid?.chargedWei}`);
      reply(200, { hash: r.hash, status: r.receipt.status, paid: r.paid });
    } catch (e) { reply(e.code === "Simulation" ? 422 : 502, { error: e.code || "relay_failed", message: e.message.slice(0, 400) }); }
  });
  await new Promise((ok) => server.listen(port, host, ok));
  return { url: `http://${host}:${server.address().port}`, close: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(() => ok()); }) };
}

/** HOST side: offer the SAME signed lease to independent relays in turn; the first that lands it wins (the key's
 *  per-deployment nonce makes a second landing impossible). */
export async function submitToRelays({ urls, signed, fetchImpl = fetch }) {
  const errors = [];
  for (const url of urls) {
    try {
      const r = await fetchImpl(`${url}/v1/lease`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(toJson(signed)) });
      const j = await r.json();
      if (r.status === 200 && j.status === "success") return { relay: url, ...j };
      errors.push(`${url}: ${j.message || j.error || j.status}`);
      if (r.status === 422) break;   // a refusal the chain would give every relay: no point asking the next
    } catch (e) { errors.push(`${url}: ${e.message}`); }
  }
  throw new LeaseRefusal("NotRelayed", `no relay landed the lease: ${errors.join("; ")}`);
}

/**
 * The host ADAPTER (Linux supervisor and Windows node alike):
 *   const s = createLeaseSender({ client, account, reserve, relays, log });
 *   await s.claim(id, enclaveId) / s.renew(id) / s.release(id)  -> { hash, receipt }   (throws LeaseRefusal)
 *   s.asClaimTx(fn, args) -> a hash promise with .receipt  (supervisor.js sendClaimTx's shape)
 * The receipt is the relay transaction's, fetched from the chain the host reads (not the relay's word).
 */
export function createLeaseSender({ client, account, reserve, relays, log = () => {}, ttlSec = 600 }) {
  if (!relays?.length) throw new Error("lease-gas: at least one relay URL is required");
  reserve = getAddress(reserve);
  async function run(kind, id, enclaveId) {
    await status({ client, reserve, id, kind, enclaveId, operator: account.address });
    const { executor, lease } = await buildLease({ client, reserve, operator: account.address, id, kind, enclaveId, ttlSec });
    const signed = await signLease({ client, account, reserve, executor, lease });
    const r = await submitToRelays({ urls: relays, signed });
    const receipt = await client.waitForTransactionReceipt({ hash: r.hash });
    log(`[lease-gas] ${kind} ${id} relayed by ${r.relay} in ${r.hash}${signed.authorization ? " (carrying this key's 7702 delegation)" : ""}; `
      + `the app's reserve paid ${r.paid?.chargedWei ?? "?"} wei`);
    return { hash: r.hash, receipt };
  }
  return {
    claim: (id, enclaveId) => run("claim", id, enclaveId),
    renew: (id) => run("renew", id),
    release: (id) => run("release", id),
    asClaimTx(functionName, args) {
      const started = run(functionName, args[0], args[1]);
      const p = started.then((x) => x.hash);
      p.receipt = started.then((x) => x.receipt);
      return p;
    },
  };
}

export const _test = { toJson, fromJsonLease, fromJsonAuth, numberToHex };
