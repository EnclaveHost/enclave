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
//   - A HOST never takes a relay's word. A landed lease is verified against its OWN RPC quorum: the
//     transaction's target and exact calldata, the receipt's status, a LeaseGasPaid log emitted by the reserve with
//     this deployment, operator, kind and the signed payee, the operator's nonce lane past this lease, and the ledger's
//     effect. Relays are tried in turn with per-request and overall timeouts; an untrusted refusal never stops the
//     failover, only a refusal the host verifies itself (its own policy read or simulation) does. A lost response is
//     recovered from the chain (the nonce lane and the reserve's logs); a nonce consumed by anything else is NOT
//     taken as this operation's success.
import http from "node:http";
import fs from "node:fs";
import { strictWriteFile } from "../network/lease-release-journal.mjs";
import { getAddress, concat, encodeFunctionData, decodeFunctionData, decodeFunctionResult, decodeEventLog, decodeErrorResult, keccak256, hashTypedData,
         recoverAddress, isAddress, isHex, encodeAbiParameters, formatTransactionRequest, parseTransaction, recoverTransactionAddress, recoverMessageAddress } from "viem";
import { recoverAuthorizationAddress } from "viem/utils";
import { leaseDeploymentPins, leaseRpcSet, verifiedLeaseAuthority } from "./lease-executor-authority.mjs";
export { leaseDeploymentPins, verifiedLeaseAuthority } from "./lease-executor-authority.mjs";

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
async function withTimeout(p, ms, what) {
  let timer;
  try { return await Promise.race([p, new Promise((_, no) => { timer = setTimeout(() => no(new Error(`${what}: no answer within ${ms} ms`)), ms); })]); }
  finally { clearTimeout(timer); }
}

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
    // the reserve's sizing: the UNSIGNED transaction (72-byte envelope bound) plus, for a claim (a key's first lease carries
    // the EIP-7702 authorization), the authorization's 105 bytes - an upper quote either way
    l1 = (await client.readContract({ address: oracle, abi: L1_ABI, functionName: "getL1FeeUpperBound",
      args: [BigInt(CANONICAL_LENGTH + 72 + (kind === "claim" ? 105 : 0))] })) * l1Bps / 10000n;
  return EST_GAS[kind] * gasPrice + l1;
}

/** Fees a relay would send with now: priority 0.001 gwei, max fee 2x base + priority. */
export async function currentFees(client, priorityFee = 1_000_000n) {
  const base = (await client.getBlock()).baseFeePerGas ?? 0n;
  return { base, priorityFee, maxFeePerGas: base * 2n + priorityFee, effective: base + priorityFee };
}

/** Verify the exact lease intent and its canonical receipt through the caller's RPC quorum. */
export async function verifyLeaseReceipt({ rpc, pins, operator, hash, want, payees }) {
    return rpc.agree(rpc.peers, async ({ client: c }) => {
      const [tx, rc] = await Promise.all([c.getTransaction({ hash }), c.getTransactionReceipt({ hash })]);
      if (lc(tx.hash) !== lc(hash) || lc(rc.transactionHash) !== lc(hash) || !HEX32.test(rc.blockHash || "") ||
          lc(tx.blockHash) !== lc(rc.blockHash) || tx.blockNumber !== rc.blockNumber)
        throw new Error("the transaction and receipt do not identify the same block");
      if (!tx.to || getAddress(tx.to) !== getAddress(operator)) throw new Error("the transaction does not call this operator");
      if (Number(tx.chainId) !== pins.chainId || BigInt(tx.value) !== 0n) throw new Error("wrong lease chain or value");
      const call = decodeFunctionData({ abi: EXECUTOR_ABI, data: tx.input });
      if (call.functionName !== "lease" || (tx.input.length - 2) / 2 !== CANONICAL_LENGTH) throw new Error("not a canonical lease call");
      const l = call.args[0];
      if (l.id !== want.id || Number(l.kind) !== want.kind || l.enclaveId !== want.enclaveId || BigInt(l.nonce) !== want.nonce) throw new Error("another lease than the one signed");
      if (BigInt(l.deadline) !== want.deadline || BigInt(l.maxChargeWei) !== want.maxChargeWei)
        throw new Error("the lease deadline or maximum charge differs from the signed intent");
      if (payees && !payees.some((p) => lc(p) === lc(l.payee))) throw new Error("a payee this host never signed");
      if (rc.status !== "success") throw new Error(`the lease transaction reverted (${hash})`);
      const paid = rc.logs.filter((g) => lc(g.address) === lc(pins.reserve)).map((g) => { try { return decodeEventLog({ abi: RESERVE_ABI, data: g.data, topics: g.topics }); } catch { return null; } })
        .find((ev) => ev?.eventName === "LeaseGasPaid" && ev.args.id === want.id && lc(ev.args.operator) === lc(operator) && Number(ev.args.kind) === want.kind && lc(ev.args.payee) === lc(l.payee));
      if (!paid) throw new Error("no LeaseGasPaid from the reserve for this lease");
      const ledger = pins.ledger;
      const at = { blockHash: rc.blockHash, requireCanonical: true };
      const [rcCode, exCode, opCode, data, nonceData] = await Promise.all([
        rpc.request(c, "eth_getCode", [pins.reserve, at]), rpc.request(c, "eth_getCode", [pins.executor, at]),
        rpc.request(c, "eth_getCode", [operator, at]),
        rpc.request(c, "eth_call", [{ to: ledger, data: encodeFunctionData({ abi: LEDGER_ABI, functionName: "get", args: [want.id] }) }, at]),
        rpc.request(c, "eth_call", [{ to: operator,
          data: encodeFunctionData({ abi: EXECUTOR_ABI, functionName: "nonceOf", args: [want.id] }) }, at]),
      ]);
      if (keccak256(rcCode) !== pins.reserveCodeHash || keccak256(exCode) !== pins.executorCodeHash ||
          lc(opCode) !== designator(pins.executor)) throw new Error("unreviewed lease code at the receipt block");
      const d = decodeFunctionResult({ abi: LEDGER_ABI, functionName: "get", data });
      const landedNonce = BigInt(decodeFunctionResult({ abi: EXECUTOR_ABI, functionName: "nonceOf", data: nonceData }));
      if (landedNonce <= want.nonce) throw new Error("the executor did not consume this lease nonce");
      if (paid.args.chargedWei > want.maxChargeWei) throw new Error("the charge exceeds the signed maximum");
      if (want.kind === 1 && (lc(d.runnerOperator) !== lc(operator) || d.runner !== want.enclaveId)) throw new Error("the ledger does not show this claim");
      if (want.kind === 3 && !/^0x0{40}$/i.test(d.runnerOperator)) throw new Error("the ledger does not show the release");
      if (want.kind === 2 && lc(d.runnerOperator) !== lc(operator)) throw new Error("the ledger does not show this renewal");
      return { hash, blockNumber: rc.blockNumber, blockHash: lc(rc.blockHash), chargedWei: paid.args.chargedWei, payee: paid.args.payee, receipt: rc };
    }, "the landed lease").then(({ value: v }) => ({ ...v, receiptP: Promise.resolve(v.receipt) }));
}

// =====================================================================================================================
// RELAY
// =====================================================================================================================

/** A relay's pinned configuration: the reserve and executor it serves, by address AND code hash. */
export async function pinRelayContracts({ client, clients = [client], deployment, ...options }) {
  return (await verifiedLeaseAuthority({ ...options, clients, deployment })).pins;
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

const definiteRejection = (m) => /insufficient funds|intrinsic gas|exceeds block gas|invalid sender|invalid signature|max fee per gas less than block base fee|fee cap|transaction type not supported/i.test(m);
const alreadyKnown = (m) => /already known|known transaction|already imported/i.test(m);
/** Broadcast the IDENTICAL signed bytes to every provider of the quorum set (never a re-signature).
 *  -> "accepted" (a provider answered this hash or knows it) | "rejected" (every provider refused definitively: nothing
 *  can be pending) | "unknown" (no clear answer: the bytes may be in a mempool - resolved from the chain, never re-signed) */
export async function broadcastRaw(rpc, raw, hash) {
  const rs = await Promise.allSettled(rpc.peers.map((p) => rpc.request(p.client, "eth_sendRawTransaction", [raw])));
  let accepted = 0, rejected = 0;
  for (const r of rs) {
    if (r.status === "fulfilled" && lc(String(r.value)) === lc(hash)) { accepted++; continue; }
    const m = r.status === "fulfilled" ? `answered ${String(r.value).slice(0, 20)}` : String(r.reason?.details || r.reason?.shortMessage || r.reason?.message || r.reason);
    if (alreadyKnown(m)) accepted++; else if (r.status === "rejected" && definiteRejection(m)) rejected++;
  }
  return accepted ? "accepted" : rejected === rs.length ? "rejected" : "unknown";
}

/** RELAY: check, simulate, sign ONCE, broadcast the same bytes to every provider, and confirm the payment from the
 *  receipt (the event emitted by the PINNED reserve), all through the RPC quorum - no single provider is required.
 *  sentState ({get, set}, startLeaseRelay's durable record of this key's last signed transaction): while that one is
 *  unresolved (its nonce not yet consumed on the quorum), nothing new is signed - its bytes are re-broadcast instead. */
export async function relayLease({ client: singleClient, clients = [singleClient], wallet, pinned, signed,
  quorum, confirmations = 0, maxBlockAgeSecs, allowLoopbackHttp = false, rpcTimeoutMs, now,
  gas = 600_000n, receiptTimeoutMs = 120_000, sentState = null }) {
  const verified = await verifiedLeaseAuthority({ clients, deployment: pinned, quorum, confirmations, maxBlockAgeSecs,
    allowLoopbackHttp, timeoutMs: rpcTimeoutMs, now });
  pinned = verified.pins;
  if (wallet.chain?.id !== pinned.chainId) throw new Error("relay wallet chain differs from reviewed deployment");
  const client = verified.client;
  const rpc = leaseRpcSet(clients, { quorum, allowLoopbackHttp, timeoutMs: rpcTimeoutMs });
  const payee = wallet.account.address;
  const nonce = await client.getTransactionCount({ address: payee });
  const sent = sentState?.get();
  if (sent) {
    if (nonce > sent.nonce) sentState.set(null);   // its nonce is consumed on the quorum: resolved
    else {
      await broadcastRaw(rpc, sent.raw, sent.hash); // the SAME bytes again, never a new signature or a new nonce
      throw new LeaseRefusal("RelayBusy", `this relay's transaction ${sent.hash} (nonce ${sent.nonce}) is unresolved: re-broadcast, not re-signed; retry shortly`);
    }
  }
  const c = await checkRelayRequest({ client, pinned, payee, signed });
  const tx = { account: wallet.account, to: signed.operator, data: c.data, authorizationList: c.authorizationList, gas,
               nonce, maxPriorityFeePerGas: c.fees.priorityFee, maxFeePerGas: c.fees.maxFeePerGas };
  try {
    await rpc.agree(rpc.peers, async ({ client: peer }) => {
      await rpc.request(peer, "eth_call", [formatTransactionRequest(tx),
        { blockHash: verified.block.hash, requireCanonical: true }]);
      return true;
    }, "relay simulation");
  } catch (e) { throw new LeaseRefusal("Simulation", `simulation: ${reasonOf(e)}`); }
  verified.assertFresh();
  const raw = await wallet.account.signTransaction({ chainId: pinned.chainId, type: c.authorizationList ? "eip7702" : "eip1559", nonce, to: signed.operator,
    data: c.data, value: 0n, gas, maxFeePerGas: c.fees.maxFeePerGas, maxPriorityFeePerGas: c.fees.priorityFee,
    ...(c.authorizationList ? { authorizationList: c.authorizationList } : {}) });
  const hash = keccak256(raw);
  sentState?.set({ nonce, raw, hash });           // durable BEFORE any provider has the bytes
  const outcome = await broadcastRaw(rpc, raw, hash);
  if (outcome === "rejected") { sentState?.set(null); throw new LeaseRefusal("Rejected", `every provider refused the transaction ${hash}: nothing was sent`); }
  // accepted, or unknown (a lost reply): the hash is this relay's own - the quorum shows whether it landed
  const deadline = Date.now() + receiptTimeoutMs;
  for (;;) {
    try {
      const landed = await verifyLeaseReceipt({ rpc, pins: pinned, operator: signed.operator, hash, want: signed.lease, payees: [payee] });
      const receipt = landed.receipt;
      const paid = receipt.logs.filter((l) => lc(l.address) === lc(pinned.reserve))
        .map((l) => { try { return decodeEventLog({ abi: RESERVE_ABI, data: l.data, topics: l.topics }); } catch { return null; } })
        .find((ev) => ev?.eventName === "LeaseGasPaid" && ev.args.id === signed.lease.id &&
          lc(ev.args.operator) === lc(signed.operator) && lc(ev.args.payee) === lc(payee) && Number(ev.args.kind) === signed.lease.kind)?.args;
      sentState?.set(null);
      return { hash, receipt, paid, expectedCharge: c.expectedCharge, broadcast: outcome };
    } catch (e) {
      if (Date.now() >= deadline) throw new Error(`lease ${hash} is not quorum-confirmed (broadcast ${outcome}): ${reasonOf(e)}; it stays this relay's unresolved transaction`);
      await sleep(500);
    }
  }
}

/** The relay's persisted send state is EXACTLY {} (nothing unresolved) or {nonce, raw, hash} with hash = keccak256(raw).
 *  -> null (empty) | the record. Anything else throws: it is never read as empty, so it is never cleared or overwritten. */
export function parseRelaySendRecord(text, where) {
  const bad = (why) => { throw new Error(`${where}: not a relay send record (${why}); settle it by hand`); };
  let j; try { j = JSON.parse(text); } catch { bad("not JSON"); }
  if (!j || typeof j !== "object" || Array.isArray(j)) bad("not an object");
  const keys = Object.keys(j).sort().join(",");
  if (keys === "") return null;
  if (keys !== "hash,nonce,raw") bad(`fields ${keys.slice(0, 80)}; expected exactly nonce, raw, hash or none`);
  if (!Number.isSafeInteger(j.nonce) || j.nonce < 0) bad("nonce");
  if (typeof j.raw !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(j.raw)) bad("raw");
  if (typeof j.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(j.hash) || keccak256(j.raw) !== j.hash.toLowerCase()) bad("hash");
  return j;
}
export const RELAY_SEND_RECORD_MAX_BYTES = 64 * 1024;

/**
 * A minimal open relay over HTTP. GET /v1/info -> {chainId, reserve, executor, payee, canonicalLength}; POST /v1/lease.
 * Bounded: body <= 4 KiB, request time, concurrency (excess -> 503), and ONE send at a time from this relay's key.
 */
export async function startLeaseRelay({ client, clients = [client], wallet, deployment, quorum, confirmations = 0,
  maxBlockAgeSecs, allowLoopbackHttp = false, rpcTimeoutMs, now, host = "127.0.0.1", port = 0,
                                        maxBody = 4096, maxConcurrent = 4, requestTimeoutMs = 60_000, receiptTimeoutMs = 120_000, log = () => {}, stateFile = null,
                                        descriptor = null }) {
  const options = { clients, deployment, quorum, confirmations, maxBlockAgeSecs, allowLoopbackHttp, timeoutMs: rpcTimeoutMs, now };
  // this key's last signed, not-yet-resolved transaction: persisted strictly (temp, fsync, rename, dir fsync) BEFORE its
  // broadcast when a stateFile is configured, so a restarted relay re-broadcasts those bytes instead of signing anew
  const pinned = await pinRelayContracts(options);
  if (wallet.chain?.id !== pinned.chainId) throw new Error("relay wallet chain differs from reviewed deployment");
  let sent = null;
  let st = null;
  if (stateFile) try { st = fs.lstatSync(stateFile); } catch (e) { if (e.code !== "ENOENT") throw e; }   // none yet: nothing unresolved
  if (st) {
    if (!st.isFile() || st.size > RELAY_SEND_RECORD_MAX_BYTES)
      throw new Error(`${stateFile}: not a relay send record (a regular file of at most ${RELAY_SEND_RECORD_MAX_BYTES} bytes is required); settle it by hand`);
    const j = parseRelaySendRecord(fs.readFileSync(stateFile, "utf8"), stateFile);
    if (j) {
      // only THIS key's own transaction on this chain at the recorded nonce: another key's record is refused, not re-broadcast
      const bad = (why) => { throw new Error(`${stateFile}: not this relay's send record (${why}); settle it by hand`); };
      let tx; try { tx = parseTransaction(j.raw); } catch { bad("not a signed transaction"); }
      if (tx.chainId !== pinned.chainId || tx.nonce !== j.nonce) bad(`chain ${tx.chainId}, nonce ${tx.nonce}`);
      const signer = await recoverTransactionAddress({ serializedTransaction: j.raw }).catch(() => bad("no recoverable signature"));
      if (getAddress(signer) !== getAddress(wallet.account.address)) bad("signed by another key");
      sent = j;
    }
  }
  const sentState = { get: () => sent, set: (x) => { if (stateFile) strictWriteFile(stateFile, JSON.stringify(x || {})); sent = x; } };
  let inflight = 0, sendQueue = Promise.resolve();
  // the signed statement /v1/info carries (verifyRelayStatement): renewed each minute, signed by this relay's own key
  let statement = null;
  const signedStatement = async () => {
    const issuedAt = Math.floor(Date.now() / 1000);
    if (statement && issuedAt - statement.issuedAt < 60) return statement.value;
    const message = relayStatementMessage({ chainId: pinned.chainId, reserve: pinned.reserve, executor: pinned.executor, payee: wallet.account.address, issuedAt });
    statement = { issuedAt, value: { message, signature: await wallet.account.signMessage({ message }) } };
    return statement.value;
  };
  if (descriptor !== null && (!Buffer.isBuffer(descriptor) || descriptor.length > 4096)) throw new Error("the relay descriptor must be at most 4096 bytes");
  const server = http.createServer(async (req, res) => {
    const reply = (status, body) => { if (res.writableEnded) return; res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v))); };
    req.setTimeout(10_000, () => { reply(408, { error: "timeout" }); req.destroy(); });
    if (req.method === "GET" && req.url === "/v1/info")
      return reply(200, { chainId: pinned.chainId, reserve: pinned.reserve, executor: pinned.executor, payee: wallet.account.address, canonicalLength: CANONICAL_LENGTH,
        statement: await signedStatement() });
    // the exact descriptor bytes this relay's service-index advertisement commits to (its sha256), when it has one
    if (req.method === "GET" && req.url === "/v1/descriptor") {
      if (!descriptor) return reply(404, { error: "not_found" });
      res.writeHead(200, { "content-type": "application/json" }); return res.end(descriptor);
    }
    if (req.method !== "POST" || req.url !== "/v1/lease") return reply(404, { error: "not_found" });
    if (inflight >= maxConcurrent) return reply(503, { error: "busy" });
    inflight++;
    let pendingJob = null;
    try {
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > maxBody) return reply(413, { error: "too_large" }); chunks.push(c); }
      let signed;
      try { signed = parseRelayRequest(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { return reply(400, { error: e.code || "bad_json", message: String(e.message).slice(0, 200) }); }
      // one send at a time from this key (its account nonce), and therefore per operator too
      // A timed-out HTTP response must not unlock this key while the original job can still broadcast.
      pendingJob = sendQueue.then(() => relayLease({ ...options, rpcTimeoutMs, wallet, pinned, signed, sentState, receiptTimeoutMs }));
      sendQueue = pendingJob.catch(() => {});
      const r = await withTimeout(pendingJob, requestTimeoutMs, "relay");
      log(`[relay] ${r.receipt.status} ${r.hash} paid ${r.paid?.chargedWei ?? "none"}`);
      reply(200, { hash: r.hash, status: r.receipt.status, paid: r.paid });
    } catch (e) {
      reply(e instanceof LeaseRefusal ? 422 : 502, { error: e.code || "relay_failed", message: String(e.message).slice(0, 300) });
    } finally {
      if (pendingJob) pendingJob.then(() => { inflight--; }, () => { inflight--; });
      else inflight--;
    }
  });
  server.headersTimeout = 10_000; server.requestTimeout = requestTimeoutMs + 5_000;
  await new Promise((ok) => server.listen(port, host, ok));
  return { url: `http://${host}:${server.address().port}`, pinned,
    close: async () => {
      await new Promise((ok) => { server.closeAllConnections?.(); server.close(() => ok()); });
      await sendQueue;
    } };
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

/** The host's OWN relay service on this machine (ENCLAVE_LEASE_GAS_LOCAL_RELAY): http is accepted only for an exact
 *  loopback origin with an explicit port - 127.0.0.1 or [::1], never a name that DNS could answer - and nothing else. */
export function validateLocalRelayUrl(url) {
  let u; try { u = new URL(url); } catch { throw new Error(`not a URL: ${String(url).slice(0, 80)}`); }
  if (u.username || u.password || u.pathname !== "/" || u.search || u.hash) throw new Error("a local relay is a bare loopback origin (no credentials, path or query)");
  if (!["http:", "https:"].includes(u.protocol) || !["127.0.0.1", "[::1]"].includes(u.hostname) || !u.port)
    throw new Error(`a local relay must be http://127.0.0.1:<port> or http://[::1]:<port> on this machine (got ${u.protocol}//${u.host})`);
  return u.origin;
}

/**
 * A relay's SIGNED self-statement (GET /v1/info .statement): the relay KEY states the chain, reserve, executor and payee it
 * serves, at a time. A host that found a relay through the service index (lease-relay-discovery.mjs) uses it only when
 * the statement recovers to the payee the relay's committed descriptor named: the endpoint then answers AS that relay,
 * whatever the transport (a plain-http public endpoint included). It proves nothing more: relays stay untrusted and every
 * landed lease is still verified on the host's own RPC quorum.
 */
export const RELAY_STATEMENT_FORMAT = "enclave-lease-relay-statement/v1";
export const relayStatementMessage = ({ chainId, reserve, executor, payee, issuedAt }) =>
  JSON.stringify({ format: RELAY_STATEMENT_FORMAT, chainId, reserve: lc(reserve), executor: lc(executor), payee: lc(payee), issuedAt });
/** -> the statement's payee (checksummed); throws unless it is exactly `expectedPayee`'s signature over THIS deployment, fresh. */
export async function verifyRelayStatement(info, { expectedPayee, pins, now = Date.now(), maxAgeSec = 600 }) {
  const st = info?.statement;
  if (!st || typeof st.message !== "string" || st.message.length > 1024 || !/^0x[0-9a-fA-F]{130}$/.test(String(st.signature || ""))) throw new Error("no signed relay statement");
  let m; try { m = JSON.parse(st.message); } catch { throw new Error("the relay statement is not JSON"); }
  if (m.format !== RELAY_STATEMENT_FORMAT || m.chainId !== pins.chainId || lc(m.reserve) !== lc(pins.reserve) || lc(m.executor) !== lc(pins.executor))
    throw new Error("the relay statement names another chain, reserve or executor");
  if (!isAddress(String(m.payee || "")) || lc(m.payee) !== lc(expectedPayee) || lc(info.payee) !== lc(expectedPayee)) throw new Error("the relay statement names another payee than its advertisement");
  if (!Number.isSafeInteger(m.issuedAt) || Math.abs(Math.floor(now / 1000) - m.issuedAt) > maxAgeSec) throw new Error("the relay statement is stale or from the future");
  const signer = await recoverMessageAddress({ message: st.message, signature: st.signature });
  if (lc(signer) !== lc(expectedPayee)) throw new Error("the relay statement is not signed by the advertised relay key");
  return getAddress(expectedPayee);
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
 * The host client. clients: the host's OWN distinct RPC clients, with a strict majority quorum. deployment: locally
 * reviewed chain/address/runtime pins (the owner's digest-verified deployment record), never a relay's advertised data.
 *   const lc = createLeaseClient({ clients, account, reserve, deployment, relays });
 *   await lc.claim(id, enclaveId) / lc.renew(id) / lc.release(id)  -> { hash, receipt }   (verified; throws LeaseRefusal)
 *   lc.asClaimTx(fn, args) -> a hash promise with .receipt (supervisor.js sendClaimTx's shape)
 */
export function createLeaseClient({ client, clients = [client], account, reserve, deployment, relays = [], localRelays = [], allowLoopbackHttp = false, fetchImpl = fetch,
                                    quorum, confirmations, maxBlockAgeSecs, rpcTimeoutMs, now,
                                    requestTimeoutMs = 20_000, overallTimeoutMs = 180_000, ttlSec = 300, log = () => {}, onSigned = null,
                                    consumedRecheckMs = [2_000, 4_000, 8_000, 16_000], discoverRelays = null, admitDiscoveredRelay = null,
                                    nonceSettleMs = 60_000, nonceSettlePollMs = 2_000 }) {
  if (!relays?.length && !localRelays?.length && typeof discoverRelays !== "function") throw new Error("lease-gas: at least one relay URL (or relay discovery) is required");
  if (admitDiscoveredRelay !== null && typeof admitDiscoveredRelay !== "function") throw new Error("lease-gas: admitDiscoveredRelay must be a function");
  // the host's own relay first (no network path outside this machine), then the others as alternates
  const urls = [...localRelays.map((u) => validateLocalRelayUrl(u)), ...relays.map((u) => validateRelayUrl(u, { allowLoopbackHttp }))];
  if (new Set(urls).size !== urls.length) throw new Error("lease-gas relays repeat an origin");
  reserve = getAddress(reserve);
  const pins = leaseDeploymentPins(deployment);
  if (reserve !== pins.reserve) throw new Error("lease-gas reserve differs from the reviewed deployment record");
  const rpc = leaseRpcSet(clients, { quorum, allowLoopbackHttp, timeoutMs: rpcTimeoutMs });
  const authority = () => verifiedLeaseAuthority({ clients, deployment: pins, quorum, confirmations, maxBlockAgeSecs,
    allowLoopbackHttp, timeoutMs: rpcTimeoutMs, now });
  const executor = async () => (await authority()).pins.executor;

  /** `who`'s executor nonce for `id` (its own storage; only meaningful while `who` is delegated to the pinned executor). */
  async function nonceAt(id, verified, who = account.address) {
    const c = verified.client;
    const code = lc((await c.getCode({ address: who })) || "0x");
    if (code !== designator(pins.executor)) return 0n;
    return BigInt(await c.readContract({ address: who, abi: EXECUTOR_ABI, functionName: "nonceOf", args: [id] }));
  }
  const nonceOf = async (id) => nonceAt(id, await authority());

  async function renewLeadMs(id, fallbackMs) {
    const c = (await authority()).client;
    const d = await c.readContract({ address: pins.ledger, abi: LEDGER_ABI, functionName: "get", args: [id] });
    const r = await c.readContract({ address: reserve, abi: RESERVE_ABI, functionName: "reserveOf", args: [id, d.owner] });
    if (!r.enabled) return fallbackMs; // the actual send refuses Disabled; no operator-paid fallback
    return Math.min(fallbackMs, Math.max(5, Number(r.renewWindow) - 15) * 1000);
  }

  const verifyLanded = (hash, want, payees, operator = account.address) => verifyLeaseReceipt({ rpc, pins, operator, hash, want, payees });

  /** The chain's own record: a LeaseGasPaid by `operator` (default: this key) for `id` from `fromBlock` whose transaction
   *  is THIS lease, through the PINNED reserve. */
  async function findLanded(want, fromBlock, payees, operator = account.address) {
    const answers = await Promise.allSettled(clients.map((c) => withTimeout(
      c.getContractEvents({ address: reserve, abi: RESERVE_ABI, eventName: "LeaseGasPaid", args: { id: want.id, operator }, fromBlock }),
      requestTimeoutMs, "lease logs")));
    const hashes = [...new Set(answers.filter((a) => a.status === "fulfilled")
      .flatMap((a) => a.value.slice(-32).map((g) => g.transactionHash)))];
    for (const hash of hashes) { try { return await verifyLanded(hash, want, payees, operator); } catch {} }
    return null;
  }

  // An EIP-7702 authorization names the operator ACCOUNT's nonce, which a relay checks at the chain head
  // (checkRelayRequest, its confirmations 0), while this client reads at its verified block, `confirmations` behind.
  // Right after a transaction of this key (proveAndRelease: the final proof, then the release) that block may not hold it
  // yet: the authorization is stale on arrival and the signed lease is held to its deadline (metal0 2026-10-21: 23591 vs
  // 23592). So while the operator is not delegated, the verified block is refreshed until its account nonce is the quorum's
  // head nonce, bounded; past the bound nothing is signed (NonceUnsettled). The head reads only decide whether to WAIT
  // (unread by a quorum: no wait, as before): the signed nonce is always the verified block's.
  async function settledAuthority() {
    const until = Date.now() + nonceSettleMs;
    for (;;) {
      const v = await authority();
      if (lc((await v.client.getCode({ address: account.address })) || "0x") === designator(pins.executor)) return v;
      const at = await v.client.getTransactionCount({ address: account.address });
      const heads = (await Promise.allSettled(rpc.peers.map((p) => rpc.request(p.client, "eth_getTransactionCount", [account.address, "latest"]))))
        .filter((x) => x.status === "fulfilled").map((x) => Number(BigInt(x.value))).sort((a, b) => b - a);
      if (heads.length < rpc.required || heads[rpc.required - 1] <= at) return v;
      if (Date.now() >= until)
        throw new LeaseRefusal("NonceUnsettled", `the operator's account nonce at the verified block ${v.block.number} is ${at}, the RPC quorum's head says `
          + `${heads[rpc.required - 1]}: a transaction of this key is not in a verified block yet; nothing was signed`);
      await sleep(nonceSettlePollMs);
    }
  }

  async function run(kindName, id, enclaveId = ZERO32) {
    const kind = KIND[kindName];
    const verified = await settledAuthority(), c = verified.client, ex = pins.executor;
    const pol = await policy({ client: c, reserve, id, kind: kindName, enclaveId, operator: account.address });
    if (pol.status !== "Ready") throw new LeaseRefusal(pol.status, `${kindName} ${id} refused: ${WHY[pol.status] || pol.status}`);
    const nonce = await nonceAt(id, verified);
    const head = verified.block;
    const fromBlock = head.number;
    const fees = await currentFees(c);
    const r = await c.readContract({ address: reserve, abi: RESERVE_ABI, functionName: "reserveOf",
      args: [id, (await c.readContract({ address: pins.ledger, abi: LEDGER_ABI, functionName: "get", args: [id] })).owner] });
    // the host's own maximum: the upper quote at min(the owner's cap, 2x the current fee)
    const priceCap = BigInt(r.maxGasPrice) < fees.effective * 2n ? BigInt(r.maxGasPrice) : fees.effective * 2n;
    const maxChargeWei = await quote({ client: c, reserve, kind: kindName, gasPrice: priceCap });
    const deadline = head.timestamp + BigInt(ttlSec);
    const want = { id, kind, enclaveId, nonce, deadline, maxChargeWei };
    const code = lc((await c.getCode({ address: account.address })) || "0x");
    const authorizationNonce = await c.getTransactionCount({ address: account.address });
    verified.assertFresh();
    const authorization = code === designator(ex) ? null
      : await account.signAuthorization({ contractAddress: ex, chainId: pins.chainId, nonce: authorizationNonce });
    const payees = [], errors = [], answered = [];
    const started = Date.now();
    // this machine's relay, then configured relays, then relays found in the service index (each AUTHENTICATED below:
    // its signed statement must recover to the payee its committed descriptor named, and with the host's platform policy on
    // its operator must be admitted by that policy NOW: admitDiscoveredRelay is asked immediately before signing, every
    // time, so a cached endpoint list never carries authority). Discovery failing is not fatal while another relay is
    // configured; with none left the operation ends NotRelayed (never operator-paid).
    let found = [];
    if (discoverRelays) { try { found = await discoverRelays(); } catch (e) { errors.push(`relay discovery: ${String(e.message).slice(0, 200)}`); } }
    const entries = [...urls.map((url) => ({ url, payee: null })),
      ...found.filter((r) => r && !urls.includes(r.origin)).map((r) => ({ url: r.origin, payee: r.payee, operator: r.operator, discovered: true }))];
    for (const { url, payee: advertised, operator: relayOperator, discovered } of entries) {
      if (Date.now() - started > overallTimeoutMs) break;
      try {
        const info = await boundedFetchJson(fetchImpl, `${url}/v1/info`, {}, requestTimeoutMs);
        if (info.status !== 200 || Number(info.body.chainId) !== pins.chainId || !isAddress(info.body.reserve || "") || getAddress(info.body.reserve) !== reserve
            || !isAddress(info.body.executor || "") || getAddress(info.body.executor) !== ex
            || !isAddress(info.body.payee || "")) { errors.push(`${url}: does not serve this chain and reserve`); continue; }
        if (discovered) {
          try { await verifyRelayStatement(info.body, { expectedPayee: advertised, pins, now: Date.now() }); }
          catch (e) { errors.push(`${url}: ${e.message}`); continue; }
          if (admitDiscoveredRelay) {
            const a = await admitDiscoveredRelay(relayOperator).catch((e) => ({ admit: false, reason: `platform host policy unreadable: ${e?.message || e}` }));
            if (a?.admit !== true) { errors.push(`${url}: operator ${relayOperator} refused by the platform host policy (${String(a?.reason || "no decision").slice(0, 160)})`); continue; }
          }
        }
        const lease = { id, kind, enclaveId, nonce, deadline, payee: getAddress(info.body.payee), maxChargeWei };
        verified.assertFresh();
        const signature = await account.signTypedData({ domain: { name: "EnclaveLeaseExecutor", version: "1", chainId: pins.chainId, verifyingContract: account.address },
          types: TYPES, primaryType: "Lease", message: { reserve, ...lease } });
        payees.push(lease.payee);
        // The caller's durable journal (onSigned) must accept this signed lease BEFORE any relay sees it. If it cannot,
        // the operation stops here: no POST to this relay or any later one (leases already POSTed were journaled).
        if (onSigned) {
          try { await onSigned({ nonce, deadline, payee: lease.payee, kind: kindName,
            lease: { ...lease }, fromBlock, operator: account.address, reserve, executor: ex, chainId: pins.chainId, ledger: pins.ledger }); }
          catch (e) {
            throw new LeaseRefusal("NotPersisted", `${kindName} ${id}: the signed lease could not be made durable (${String(e?.message || e).slice(0, 200)}); it was sent to no relay`);
          }
        }
        // The complete intent is durable BEFORE the relay sees it, allowing exact receipt recovery after restart.
        const body = JSON.stringify({ operator: account.address, lease, signature, authorization }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
        const ans = await boundedFetchJson(fetchImpl, `${url}/v1/lease`, { method: "POST", headers: { "content-type": "application/json" }, body }, requestTimeoutMs);
        if (ans.status === 200 && HEX32.test(ans.body.hash || "")) {
          answered.push(ans.body.hash);
          // the relay's word is a hint: verify it on the host's own RPCs (bounded wait for inclusion)
          const t0 = Date.now();
          for (;;) {
            try { const v = await verifyLanded(ans.body.hash, want, payees); log(`[lease-gas] ${kindName} ${id} landed in ${v.hash} via ${url}; the app's reserve paid ${v.chargedWei} wei`);
                  return { hash: v.hash, receipt: await v.receiptP, verified: v }; }
            catch (e) { if (Date.now() - t0 > requestTimeoutMs) { errors.push(`${url}: its answer did not verify (${e.message})`); break; } await sleep(1000); }
          }
        } else errors.push(`${url}: ${ans.status} ${String(ans.body.error || "")} ${String(ans.body.message || "").slice(0, 160)}`);
      } catch (e) {
        if (e instanceof LeaseRefusal && e.code === "NotPersisted") throw e;   // never fall through to the next relay
        errors.push(`${url}: ${String(e.message).slice(0, 160)}`);
      }
      // before the next relay: did this lease land anyway (a lost answer)? And is the refusal real (the host's own view)?
      const landed = await findLanded(want, fromBlock, payees).catch(() => null);
      if (landed) { log(`[lease-gas] ${kindName} ${id} landed in ${landed.hash} (found on chain)`); return { hash: landed.hash, receipt: await landed.receiptP, verified: landed }; }
      if (await nonceOf(id) !== nonce) {
        // The nonce moved, so SOME lease with it landed - possibly THIS one, whose receipt a rate-limited or lagging RPC
        // quorum could not confirm yet (2026-10-21: a claim reported NonceConsumed after its own transaction landed).
        // Before calling it another operation, the hashes this host's relays reported and the reserve's log are checked
        // again, a bounded few times. Only a quorum-verified receipt of exactly this signed intent is success; when none
        // verifies, it stays NonceConsumed.
        for (const wait of consumedRecheckMs) {
          await sleep(wait);
          for (const h of answered) {
            try { const v = await verifyLanded(h, want, payees); log(`[lease-gas] ${kindName} ${id} landed in ${v.hash} (verified on re-check after its nonce moved)`);
                  return { hash: v.hash, receipt: await v.receiptP, verified: v }; } catch {}
          }
          const late = await findLanded(want, fromBlock, payees).catch(() => null);
          if (late) { log(`[lease-gas] ${kindName} ${id} landed in ${late.hash} (found on chain on re-check)`); return { hash: late.hash, receipt: await late.receiptP, verified: late }; }
        }
        throw new LeaseRefusal("NonceConsumed", `${kindName} ${id}: the lease nonce ${nonce} was consumed and no receipt of this signed lease verified `
          + `(re-checked ${consumedRecheckMs.length} times); not this one's success`);
      }
      const again = await policy({ client: (await authority()).client, reserve, id, kind: kindName, enclaveId, operator: account.address });
      if (again.status !== "Ready") throw new LeaseRefusal(again.status, `${kindName} ${id} refused: ${WHY[again.status] || again.status}`);
    }
    throw new LeaseRefusal("NotRelayed", `no relay landed the ${kindName}: ${errors.slice(0, 6).join("; ")}`);
  }

  /**
   * Settle a lease SIGNED earlier (a durable journal entry, possibly from before a restart, possibly by ANOTHER key or
   * under another deployment record) from the chain, bound to the identity RECORDED with it - never to this client's
   * current key or configuration (root review 20:21Z):
   *   landed   - a quorum-verified receipt of exactly this intent by the RECORDED operator, and ONLY when the recorded
   *              chain, reserve, executor and ledger are all present and equal to this client's pinned ones (the only
   *              success; a matching-field receipt in another or an unrecorded domain is not this operation);
   *   consumed - the RECORDED operator's own executor nonce lane moved past it: a FENCE, not proof that it ran. Only when
   *              the recorded chain, reserve, executor and ledger are this client's pinned ones (the lane is that
   *              operator's storage under that executor's namespace);
   *   expired  - its deadline is behind a quorum-verified block of the RECORDED chain (it can then land nowhere): a
   *              fence too, never a success;
   *   pending  - it may still land, or the record cannot be settled automatically (`why`): the caller keeps it HELD.
   * want: {id, kind, enclaveId, nonce, deadline, maxChargeWei}; payees: every payee signed;
   * recorded: {operator, chainId, reserve, executor, ledger} as journaled (a missing field is unknown, never assumed).
   */
  async function resolveSigned(want, fromBlock, payees, recorded = {}) {
    const operator = recorded.operator && isAddress(String(recorded.operator)) ? getAddress(recorded.operator) : null;
    if (!operator) return { state: "pending", why: "the journal entry names no operator: settle it by hand from the chain" };
    const same = (a, b) => !!a && lc(a) === lc(b);
    const sameChain = recorded.chainId !== undefined && recorded.chainId !== null && Number(recorded.chainId) === pins.chainId;
    // the RECORDED domain is this client's pinned one, every field present and equal: only then can a receipt or a
    // nonce here say anything about the recorded operation (root review P1/P2: a matching-field receipt in another
    // domain, or for an entry without its domain, is NOT the recorded lease's success)
    const sameDomain = sameChain && same(recorded.reserve, pins.reserve) && same(recorded.executor, pins.executor) && same(recorded.ledger, pins.ledger);
    if (sameDomain) {
      const landed = await findLanded(want, fromBlock, payees, operator).catch(() => null);
      if (landed) return { state: "landed", verified: landed };
    }
    const verified = await authority();
    const block = Number(verified.block.number);
    if (!sameChain) return { state: "pending", block, why: `the lease was signed for chain ${recorded.chainId ?? "unknown"}; this client is pinned to chain ${pins.chainId}` };
    if (sameDomain) {
      const n = await nonceAt(want.id, verified, operator);
      if (n > want.nonce) return { state: "consumed", block };
    }
    if (verified.block.timestamp > want.deadline) {
      if (sameDomain) {
        // a landing at or before the deadline is in a block at or below this one: look once more before fencing
        const again = await findLanded(want, fromBlock, payees, operator).catch(() => null);
        if (again) return { state: "landed", verified: again };
      }
      // past its deadline on the RECORDED chain it can never land, in any domain: a fence, never a success
      return { state: "expired", block };
    }
    return sameDomain ? { state: "pending", block }
      : { state: "pending", block, why: "the lease was signed under another (or an unrecorded) reserve/executor/ledger: held until its deadline on its chain" };
  }

  return {
    claim: (id, enclaveId) => run("claim", id, enclaveId),
    renew: (id) => run("renew", id),
    release: (id) => run("release", id),
    nonceOf, findLanded, verifyLanded, executor, renewLeadMs, resolveSigned,
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
export async function preflight({ client: singleClient, clients = [singleClient], account, reserve, deployment, id, kind, enclaveId = ZERO32, from,
  quorum, confirmations, maxBlockAgeSecs, allowLoopbackHttp = false, rpcTimeoutMs, now }) {
  const verified = await verifiedLeaseAuthority({ clients, deployment, quorum, confirmations, maxBlockAgeSecs,
    allowLoopbackHttp, timeoutMs: rpcTimeoutMs, now });
  if (getAddress(reserve) !== verified.pins.reserve) throw new Error("lease-gas reserve differs from reviewed pins");
  const client = verified.client, ex = verified.pins.executor;
  const code = lc((await client.getCode({ address: account.address })) || "0x");
  const nonce = code === designator(ex) ? BigInt(await client.readContract({ address: account.address, abi: EXECUTOR_ABI, functionName: "nonceOf", args: [id] })) : 0n;
  const head = await client.getBlock();
  const fees = await currentFees(client);
  const maxChargeWei = await quote({ client, reserve, kind, gasPrice: fees.effective * 2n });
  const lease = { id, kind: KIND[kind], enclaveId, nonce, deadline: head.timestamp + 300n, payee: getAddress(from), maxChargeWei };
  const authorizationNonce = await client.getTransactionCount({ address: account.address });
  verified.assertFresh();
  const signature = await account.signTypedData({ domain: { name: "EnclaveLeaseExecutor", version: "1", chainId: client.chain.id, verifyingContract: account.address },
    types: TYPES, primaryType: "Lease", message: { reserve: getAddress(reserve), ...lease } });
  verified.assertFresh();
  const authorization = code === designator(ex) ? null
    : await account.signAuthorization({ contractAddress: ex, chainId: client.chain.id, nonce: authorizationNonce });
  try {
    const rpc = leaseRpcSet(clients, { quorum, allowLoopbackHttp, timeoutMs: rpcTimeoutMs });
    await rpc.agree(rpc.peers, async ({ client: peer }) => {
      await withTimeout(peer.call({ account: getAddress(from), to: account.address, data: leaseCalldata(lease, signature), gas: 600_000n,
        authorizationList: authorization ? [authorization] : undefined, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.priorityFee }),
      rpcTimeoutMs ?? 15_000, "preflight");
      return true;
    }, "preflight success");
    return { ok: true, maxChargeWei };
  } catch (e) { return { ok: false, reason: reasonOf(e), maxChargeWei }; }
}

export const _test = { encodeAbiParameters };
