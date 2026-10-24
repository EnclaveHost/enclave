// Standard EIP-7702 account maintenance for ONE account: fund metal0's registry operator C9 (whose delegate, the
// reviewed EnclaveLeaseExecutor 0x8900baca…, has no payable entry) by
//   A  sponsor S, type-4: authorization {8453, 0x0, N} (C9 cleared)  +  call C9 with value V (plain transfer)
//   B  sponsor S, type-4: authorization {8453, executor, N+1} (C9 restored byte-exactly)  +  call S, value 0
// UNSIGNED PREPARATION ONLY. This module never reads a key, never signs, never sends: it has no wallet, no account and
// no broadcast method. It builds a reviewable plan; signing and sending need separate approval and are not implemented.
//
// Everything here is specific to C9 and the same executor; createPreparer refuses any other operator, executor, value,
// cap or sponsor unless the caller passes an explicit TEST fixture (the CLI never does).
import { createHash } from "node:crypto";
import { encodeFunctionData, decodeFunctionResult, encodeAbiParameters, keccak256, serializeTransaction, parseAbi } from "viem";
import { hashAuthorization } from "viem/utils";
import { pacedTransport, httpRpc, PACING, realClock, Refusal } from "../vendor/publish.mjs";

export { Refusal };
const lc = (x) => String(x ?? "").toLowerCase();
const hex = (n) => "0x" + BigInt(n).toString(16);
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const refuse = (code, message) => { throw new Refusal(code, message); };
export const ZERO = "0x0000000000000000000000000000000000000000";

export const PRODUCTION = Object.freeze({
  chainId: 8453,
  operator: "0xc9d0835cd8ebc7eae84304d9db0a76253eebe6ab",           // metal0's registry operator (C9)
  executor: "0x8900baca2167873ba2f8a8bae8b4876e6396d343",           // EnclaveLeaseExecutor: the ONLY restore target
  executorCodeHash: "0xdd893cd48b7c102dc266949d027c33d396a7f8884533ee81b3b2275048ec9ab2",
  delegationCodeHash: "0xe2f1317f7b76520f746c22fe4898b7ad32d7a6947a4c11a766fdcdd55bf88bbe",   // keccak(0xef0100||executor)
  reserve: "0x12a3f873041dec436daa0085b766a399a6fa3639",            // EnclaveLeaseGasReserve (begin() checks the code hash)
  reserveCodeHash: "0xcc00efe9c79c17b34ef9edc2720939030834bf168abc52cea14dcb224304a979",
  sponsor: "0x29479bf04ed889d46a7afb7f292b9bb26e12647c",            // the canary agent EOA (proposed; root re-checks)
  valueWei: 5_000_000_000_000n,                                      // V = 0.000005 ETH, exactly
  feeCapWei: 2_000_000_000_000n,                                     // aggregate outer fees of A + B (L2 + L1 + operator)
  gas: Object.freeze({ A: 50_000n, B: 47_000n }),                    // fixed limits; every path measured on anvil (tests)
  oracle: "0x420000000000000000000000000000000000000f",
  rpcs: Object.freeze(["https://mainnet.base.org", "https://base.public.blockpi.network/v1/rpc/public"]),
  readDepth: 2,
  slots: Object.freeze({                                             // EnclaveLeaseExecutor ERC-7201 namespaces
    nonces: "0xd4303515233e7d5d6aff53061198d268e21693bbe46ee8802da444a318c9fa00",
    authorized: "0xa56564ef639f1ba7b44970246267b2ab8c83a9eb9d0bde5c2e8a5ec36c96cb00",
  }),
  quiesce: Object.freeze({ deadlineMarginSec: 60, minLeaseRemainingSec: 1800, maxQuiesceAgeSec: 3600 }),
  // documentation only: this tool reads neither (a later, separately approved signer would)
  keySources: Object.freeze({
    operatorAuthorizations: "C9 registry key: root-only /home/steven/Projects/enclave/metal/config.json field registryKey",
    sponsorTransactions: "the sponsor 0x29479bf0…647c's signer: root-provided",
  }),
});

const EXECUTOR_ABI = parseAbi(["function nonceOf(bytes32 id) view returns (uint64)", "function authorizationCharged() view returns (bool)",
  "function reserve() view returns (address)"]);
const RESERVE_ABI = parseAbi(["function executor() view returns (address)", "function delegationCodeHash() view returns (bytes32)"]);
const ORACLE_ABI = parseAbi(["function getL1FeeUpperBound(uint256) view returns (uint256)", "function isIsthmus() view returns (bool)",
  "function getOperatorFee(uint256) view returns (uint256)"]);
export const ORACLE_SIGNATURE_ALLOWANCE = 68;

export const designatorOf = (executor) => "0xef0100" + lc(executor).slice(2);
export const nonceSlot = (cfg, id) => keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [id, cfg.slots.nonces]));
export const authorizedSlot = (cfg) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [cfg.executor, cfg.slots.authorized]));

/** Pins are production unless an explicit test fixture is passed; any fixture must keep the same shape and rules. */
export function checkConfig(cfg) {
  if (cfg.chainId === 0 || !Number.isSafeInteger(cfg.chainId)) refuse("config", "chain id must be a real chain (never 0: a chain-0 authorization replays on every chain)");
  if (lc(cfg.sponsor) === lc(cfg.operator)) refuse("config", "the sponsor must be a separate account (the nonce rules below assume it)");
  if (lc(designatorOf(cfg.executor)) === "0xef0100" + ZERO.slice(2)) refuse("config", "the restore target cannot be the zero address");
  if (keccak256(designatorOf(cfg.executor)) !== cfg.delegationCodeHash) refuse("config", "delegationCodeHash is not keccak(0xef0100||executor)");
  if (!(cfg.valueWei > 0n) || !(cfg.feeCapWei > 0n)) refuse("config", "value and fee cap must be positive");
  return cfg;
}

/** The two authorization tuples C9's key would sign, and the exact digests (keccak(0x05 || rlp([chainId, address, nonce]))). */
export function authorizations(cfg, N) {
  const n = BigInt(N);
  const A = { chainId: cfg.chainId, address: ZERO, nonce: Number(n) };
  const B = { chainId: cfg.chainId, address: lc(cfg.executor), nonce: Number(n + 1n) };
  return [A, B].map((t, i) => ({ label: i === 0 ? "A: clear (address 0)" : "B: restore the same executor", tuple: t,
    digest: hashAuthorization({ chainId: t.chainId, address: t.address, nonce: t.nonce }), signer: lc(cfg.operator) }));
}

const MAXSIG = { r: "0x" + "ff".repeat(32), s: "0x" + "ff".repeat(32), yParity: 1 };
/** The unsigned type-4 transaction (authorization signatures as placeholders), and its worst-case encoded sizes. */
export function transaction(cfg, which, { s, N, maxFeePerGas, maxPriorityFeePerGas }) {
  const [authA, authB] = authorizations(cfg, N);
  const auth = which === "A" ? authA : authB;
  const tx = { type: "eip7702", chainId: cfg.chainId, nonce: Number(BigInt(s) + (which === "A" ? 0n : 1n)),
    to: which === "A" ? lc(cfg.operator) : lc(cfg.sponsor), value: which === "A" ? cfg.valueWei : 0n, data: "0x",
    gas: cfg.gas[which], maxFeePerGas: BigInt(maxFeePerGas), maxPriorityFeePerGas: BigInt(maxPriorityFeePerGas) };
  const withMax = { ...tx, authorizationList: [{ ...auth.tuple, ...MAXSIG }] };
  const unsigned = (serializeTransaction(withMax).length - 2) / 2;
  const signedMax = (serializeTransaction(withMax, MAXSIG).length - 2) / 2;
  const argument = Math.max(unsigned, signedMax - ORACLE_SIGNATURE_ALLOWANCE);
  if (argument + ORACLE_SIGNATURE_ALLOWANCE < signedMax) refuse("l1_size", "the L1 size undercounts the signed transaction");
  return { tx, auth, sizes: { unsigned, signedMax, argument } };
}

/**
 * The reviewable plan from facts read at ONE agreed block. `oracle` = { l1UpperBound(size), isIsthmus(), operatorFee(gas) }
 * at that block. Refuses (never raises a cap, never changes V) when anything does not fit.
 */
export async function buildPlan({ cfg = PRODUCTION, facts, quiesce, oracle }) {
  checkConfig(cfg);
  const f = facts;
  // the account states this plan is for
  if (lc(f.operatorCode) !== designatorOf(cfg.executor)) refuse("operator_code", "C9 is not delegated to exactly the reviewed executor; this plan applies only to that state");
  if (f.plainTransferReverts !== true) refuse("premise", "a plain transfer to C9 does not revert: this maintenance is not needed (fund it directly after review)");
  if (lc(f.sponsorCode) !== "0x") refuse("sponsor_code", "the sponsor must be a plain EOA with no code (no delegation)");
  if (f.executorCodeHash !== cfg.executorCodeHash) refuse("executor_code", "the executor's runtime is not the reviewed one");
  if (f.reserveCodeHash !== cfg.reserveCodeHash) refuse("reserve_code", "the reserve's runtime is not the reviewed one");
  if (lc(f.reserveExecutor) !== lc(cfg.executor) || f.reserveDelegationCodeHash !== cfg.delegationCodeHash) refuse("reserve_binding", "the reserve is not bound to this executor");
  for (const [who, n] of [["operator", f.operatorNonce], ["sponsor", f.sponsorNonce]])
    if (!(n.atBlock === n.latest && n.latest === n.pending)) refuse("nonce", `the ${who}'s nonce is not settled (agreed ${n.atBlock}, latest ${n.latest}, pending ${n.pending}): a transaction may be in flight`);
  // quiescence (root-provided; nothing assumed)
  const q = checkQuiesce(cfg, quiesce, f.blockTimestamp);
  // fees: L2 cap + L1 bound for the maximum signed size + Isthmus operator fee, per transaction; aggregate cap
  if ((await oracle.isIsthmus()) !== true) refuse("operator_fee", "the GasPriceOracle reports no Isthmus operator fee: undetermined, not bounded");
  const fees = { maxFeePerGas: 2n * BigInt(f.baseFeePerGas) + BigInt(f.maxPriorityFeePerGas), maxPriorityFeePerGas: BigInt(f.maxPriorityFeePerGas) };
  const out = {};
  let total = 0n;
  for (const which of ["A", "B"]) {
    const t = transaction(cfg, which, { s: f.sponsorNonce.latest, N: f.operatorNonce.latest, ...fees });
    const l2 = t.tx.gas * fees.maxFeePerGas, l1 = BigInt(await oracle.l1UpperBound(t.sizes.argument)), op = BigInt(await oracle.operatorFee(t.tx.gas));
    out[which] = { ...t, fee: { l2MaxWei: l2, l1UpperBoundWei: l1, operatorFeeWei: op, totalWei: l2 + l1 + op } };
    total += l2 + l1 + op;
  }
  if (total > cfg.feeCapWei) refuse("fee_cap", `the bounded outer fees ${total} wei exceed the cap ${cfg.feeCapWei} wei; refused (the cap is not raised)`);
  if (BigInt(f.sponsorBalance) < cfg.valueWei + total) refuse("sponsor_balance", `the sponsor holds ${f.sponsorBalance} wei, less than V + bounded fees (${cfg.valueWei + total})`);
  const N = BigInt(f.operatorNonce.latest), s = BigInt(f.sponsorNonce.latest), str = (x) => (typeof x === "bigint" ? x.toString() : x);
  const ser = (o) => JSON.parse(JSON.stringify(o, (_k, v) => str(v)));
  const plan = {
    v: 1, kind: "enclave-operator-7702-maintenance/unsigned", status: "UNSIGNED; not approved; nothing signed or sent",
    pins: ser({ chainId: cfg.chainId, operator: cfg.operator, executor: cfg.executor, executorCodeHash: cfg.executorCodeHash, delegationCodeHash: cfg.delegationCodeHash,
      reserve: cfg.reserve, reserveCodeHash: cfg.reserveCodeHash, sponsor: cfg.sponsor, valueWei: cfg.valueWei, feeCapWei: cfg.feeCapWei, keySources: cfg.keySources }),
    observed: ser({ block: f.block, blockHash: f.blockHash, blockTimestamp: f.blockTimestamp, rpcs: f.rpcs, operatorNonce: N, operatorBalanceWei: f.operatorBalance,
      sponsorNonce: s, sponsorBalanceWei: f.sponsorBalance, operatorCode: f.operatorCode, storage: f.storage, executorViews: f.executorViews,
      plainTransferReverts: f.plainTransferReverts, codelessTransferSimulation: f.codelessTransferSimulation }),
    quiesce: q,
    authorizationsToSign: authorizations(cfg, N).map((a) => ser({ ...a, signer: cfg.operator, rule: "sponsor-executed: nonce = C9's current nonce (A) and +1 (B); chainId 8453, never 0" })),
    transactions: ["A", "B"].map((w) => ser({ label: w, sender: cfg.sponsor, unsigned: { ...out[w].tx, authorizationList: [{ ...out[w].auth.tuple, signature: `authorizationsToSign[${w === "A" ? 0 : 1}]` }] },
      encodedBytes: { ...out[w].sizes, oracleSignatureAllowance: ORACLE_SIGNATURE_ALLOWANCE }, fee: out[w].fee })),
    fees: ser({ totalBoundWei: total, capWei: cfg.feeCapWei, note: "per tx: L2 cap (gas x maxFeePerGas) + GasPriceOracle L1 upper bound for the maximum signed size (authorization signature included) + Isthmus operator fee for the gas limit, at the agreed block. Not a guarantee against later changes." }),
    order: ["Sign A's and B's authorizations (C9 key) and both transactions (sponsor) BEFORE anything is broadcast.",
      "Write both signed raw transactions to a private 0600 journal (fsynced, exclusive) BEFORE any broadcast; never log them.",
      "Broadcast A then B immediately (sponsor nonces s, s+1 enforce the order; B can never run before A)."],
    verifyAfterA: ser({ operatorCode: "0x", operatorNonce: N + 1n, operatorBalanceWei: `>= observed + ${cfg.valueWei} (exactly + V unless others pay C9)`,
      storageUnchanged: f.storage, receiptStatus: 1 }),
    verifyAfterB: ser({ operatorCode: designatorOf(cfg.executor), operatorCodeHash: cfg.delegationCodeHash, operatorNonce: N + 2n, storageUnchanged: f.storage,
      executorViewsUnchanged: f.executorViews, reserveBindingUnchanged: { executor: cfg.executor, delegationCodeHash: cfg.delegationCodeHash },
      confirmations: 2, providers: 2 }),
    recovery: RECOVERY,
    limits: LIMITS,
  };
  const text = JSON.stringify(plan, null, 1) + "\n";
  return { plan, text, planHash: "0x" + sha256(text) };
}

export function checkQuiesce(cfg, q, blockTs) {
  if (!q || q.providedBy !== "root") refuse("quiesce", "the quiescence facts must be provided by root (quiesce.json)");
  if (!Array.isArray(q.signersStopped) || q.signersStopped.length === 0) refuse("quiesce", "root must list every stopped C9 signer (control, lease keepers, boot/funding tools)");
  if (!Number.isSafeInteger(q.providedAt) || blockTs - q.providedAt > cfg.quiesce.maxQuiesceAgeSec || q.providedAt > blockTs + 120) refuse("quiesce", "the quiescence facts are stale or from the future");
  if (!Number.isSafeInteger(q.lastSponsoredLeaseDeadline)) refuse("quiesce", "the last outstanding sponsored Lease deadline is required (0 if none was ever signed)");
  if (!(blockTs > q.lastSponsoredLeaseDeadline + cfg.quiesce.deadlineMarginSec)) refuse("quiesce", "a sponsored Lease signed by C9 may still be valid at the agreed block: wait until its deadline has passed on chain");
  if (!Array.isArray(q.leases)) refuse("quiesce", "the live leases held by C9 must be listed (empty if none)");
  const leases = q.leases.map((l) => {
    if (!/^0x[0-9a-f]{64}$/.test(lc(l.id)) || !Number.isSafeInteger(l.expiry)) refuse("quiesce", "each lease needs a 32-byte id and an expiry");
    const remaining = l.expiry - blockTs;
    if (remaining < cfg.quiesce.minLeaseRemainingSec) refuse("lease_window", `lease ${l.id} has ${remaining} s left, under the required ${cfg.quiesce.minLeaseRemainingSec} s: renew it first or accept its lapse explicitly (outside this tool)`);
    return { id: lc(l.id), expiry: l.expiry, remainingSec: remaining };
  });
  return { providedBy: q.providedBy, providedAt: q.providedAt, signersStopped: q.signersStopped, lastSponsoredLeaseDeadline: q.lastSponsoredLeaseDeadline, leases,
    requirement: "Every C9 signer stays stopped until B is verified: the lease client signs a NEW authorization when C9 is not delegated (client/lease-executor-client.mjs 463-464, 573-574), which would race B." };
}

export const RECOVERY = Object.freeze([
  { state: "A's authorization skipped, C9 still delegated (its nonce moved, or it was re-delegated)", effect: "A's call hits the executor and reverts; V stays with the sponsor; only gas is spent", action: "stop; re-read; a new plan (new nonces, new signatures)" },
  { state: "A's authorization skipped because a third party already applied it (C9 codeless, nonce N+1)", effect: "A's value call to the CODELESS C9 SUCCEEDS: C9 is funded although our authorization did not apply", action: "B (nonce N+1) is valid: broadcast it; verify" },
  { state: "A mined, B not yet (dropped, delayed, crash)", effect: "C9 is a funded plain account; the reserve refuses it; relayed lease() calls SUCCEED AS NO-OPS (no renewal)", action: "re-broadcast the SAME journaled B (valid while C9's nonce is N+1); keep every signer stopped" },
  { state: "A mined, then C9's nonce moved (any C9 transaction or a lease client's own authorization)", effect: "the presigned B is stale; C9 stays codeless (or was re-delegated by that authorization)", action: "read the code: if it is the exact designator, restoration happened; otherwise a NEW restore authorization (C9 self-sends with nonce = current + 1, or a new sponsored B) after fresh review" },
  { state: "a reorg drops A and/or B", effect: "both can be re-included as the same signed bytes while the nonces are unchanged", action: "re-broadcast the journaled bytes; verify only after 2 confirmations on 2 providers" },
  { state: "B mined", effect: "C9 restored (code hash e2f1317f), nonce N+2, storage unchanged", action: "verify, then resume the signers" },
]);
export const LIMITS = Object.freeze([
  "This unsigned preparation cannot eth_call the real transactions: an authorization signature does not exist yet. The live checks are: the plain transfer to C9 REVERTS today (the premise), and, where a provider supports state overrides, the transfer to a codeless C9 succeeds. The actual EIP-7702 processing is exercised only on anvil (revm, Prague) with throwaway keys (test/protocol.test.mjs).",
  "The deployed executor runtime (dd893cd4…) and reserve (cc00efe9…) are pinned by hash; the storage-preservation test runs the reviewed executor SOURCE (sha256 dc605ffa…) rebuilt locally, not the deployed bytes.",
  "Base's sequencer txpool rules for type-4 transactions (e.g. authorities with pending transactions) are not verified here; a refused submission is a no-op, not a partial state.",
  "Lease expiries and the last sponsored Lease deadline come from root (quiesce.json); this tool does not derive them.",
]);

/** Read-only facts at one agreed block on two providers (paced, budgeted; the vendored reviewed transport). */
export function createPreparer({ cfg = PRODUCTION, rpc = httpRpc(15_000), clock = realClock, pacing = PACING, fixture = false } = {}) {
  checkConfig(cfg);
  if (!fixture) for (const k of Object.keys(PRODUCTION)) if (JSON.stringify(cfg[k], (_k, v) => (typeof v === "bigint" ? v.toString() : v)) !== JSON.stringify(PRODUCTION[k], (_k, v) => (typeof v === "bigint" ? v.toString() : v))) throw Error(`config ${k} must be the production value`);
  const rpcs = [...cfg.rpcs];
  if (rpcs.length !== 2 || rpcs[0] === rpcs[1]) throw Error("exactly two distinct RPCs");
  let transport;
  const both = (m, p) => Promise.all(rpcs.map((u) => transport.send(u, m, p)));
  const agree = async (what, m, p) => { const r = await both(m, p); if (JSON.stringify(r[0]) !== JSON.stringify(r[1])) refuse("rpc_disagree", `the providers disagree on ${what}`); return r[0]; };
  async function prepare({ quiesce }) {
    transport = pacedTransport({ rpc, pacing, clock });
    const ids = await both("eth_chainId", []);
    if (ids.some((x) => Number(x) !== cfg.chainId)) refuse("chain", "a provider is not on the pinned chain");
    const heads = (await both("eth_blockNumber", [])).map(BigInt);
    const n = (heads[0] < heads[1] ? heads[0] : heads[1]) - BigInt(cfg.readDepth);
    const blocks = await both("eth_getBlockByNumber", [hex(n), false]);
    if (!blocks[0] || lc(blocks[0].hash) !== lc(blocks[1]?.hash)) refuse("rpc_disagree", `the providers disagree on block ${n}`);
    const latest = await both("eth_getBlockByNumber", ["latest", false]);
    const baseFee = latest.map((b) => BigInt(b.baseFeePerGas)).reduce((a, x) => (x > a ? x : a), BigInt(blocks[0].baseFeePerGas));
    const at = { blockHash: lc(blocks[0].hash), requireCanonical: true };
    const code = (a) => agree(`code of ${a}`, "eth_getCode", [a, at]);
    const call = async (to, abi, fn, args = []) => decodeFunctionResult({ abi, functionName: fn, data: await agree(`${to} ${fn}`, "eth_call", [{ to, data: encodeFunctionData({ abi, functionName: fn, args }) }, at]) });
    const operatorCode = lc(await code(cfg.operator)), sponsorCode = lc(await code(cfg.sponsor));
    const executorCodeHash = keccak256(await code(cfg.executor)), reserveCodeHash = keccak256(await code(cfg.reserve));
    const reserveExecutor = lc(await call(cfg.reserve, RESERVE_ABI, "executor")), reserveDelegationCodeHash = await call(cfg.reserve, RESERVE_ABI, "delegationCodeHash");
    const nonce = async (a) => ({ atBlock: Number(BigInt(await agree("nonce", "eth_getTransactionCount", [a, at]))),
      latest: Number((await both("eth_getTransactionCount", [a, "latest"])).map(BigInt).reduce((x, y) => (x === y ? x : -1n))),
      pending: Number((await both("eth_getTransactionCount", [a, "pending"])).map(BigInt).reduce((x, y) => (x === y ? x : -1n))) });
    const operatorNonce = await nonce(cfg.operator), sponsorNonce = await nonce(cfg.sponsor);
    const operatorBalance = BigInt(await agree("balance", "eth_getBalance", [cfg.operator, at])).toString();
    const sponsorBalance = BigInt(await agree("balance", "eth_getBalance", [cfg.sponsor, at])).toString();
    // the executor's state in C9's storage, raw (readable even while C9 is codeless) and through the executor's views
    const leaseIds = (quiesce?.leases || []).map((l) => lc(l.id)).filter((x) => /^0x[0-9a-f]{64}$/.test(x));
    const storage = { authorized: await agree("authorized slot", "eth_getStorageAt", [cfg.operator, authorizedSlot(cfg), at]), nonces: {} };
    for (const id of leaseIds) storage.nonces[id] = await agree("nonce slot", "eth_getStorageAt", [cfg.operator, nonceSlot(cfg, id), at]);
    const executorViews = { authorizationCharged: operatorCode === designatorOf(cfg.executor) ? await call(cfg.operator, EXECUTOR_ABI, "authorizationCharged") : null, nonceOf: {} };
    if (operatorCode === designatorOf(cfg.executor)) for (const id of leaseIds) executorViews.nonceOf[id] = (await call(cfg.operator, EXECUTOR_ABI, "nonceOf", [id])).toString();
    // the premise, live: a plain transfer of V to C9 reverts today
    let plainTransferReverts;
    try { await both("eth_call", [{ from: cfg.sponsor, to: cfg.operator, value: hex(cfg.valueWei) }, at]); plainTransferReverts = false; }
    catch (e) { if (e instanceof Refusal) throw e; plainTransferReverts = true; }
    // optional: the codeless transfer under a state override (not every provider supports overrides; unsupported is recorded)
    let codelessTransferSimulation;
    try { await both("eth_call", [{ from: cfg.sponsor, to: cfg.operator, value: hex(cfg.valueWei) }, at, { [cfg.operator]: { code: "0x" } }]); codelessTransferSimulation = "succeeds with C9 codeless (state override)"; }
    catch (e) { if (e instanceof Refusal) throw e; codelessTransferSimulation = "not available from these providers (state override unsupported or refused)"; }
    const tips = (await both("eth_maxPriorityFeePerGas", [])).map(BigInt);
    const oracleCall = (fn, args = []) => call(cfg.oracle, ORACLE_ABI, fn, args);
    const facts = { block: n.toString(), blockHash: at.blockHash, blockTimestamp: Number(BigInt(blocks[0].timestamp)), rpcs: rpcs.map((u) => new URL(u).host),
      operatorCode, sponsorCode, executorCodeHash, reserveCodeHash, reserveExecutor, reserveDelegationCodeHash, operatorNonce, sponsorNonce,
      operatorBalance, sponsorBalance, storage, executorViews, plainTransferReverts, codelessTransferSimulation,
      baseFeePerGas: baseFee, maxPriorityFeePerGas: tips[0] > tips[1] ? tips[0] : tips[1] };
    const built = await buildPlan({ cfg, facts, quiesce, oracle: { isIsthmus: () => oracleCall("isIsthmus"), l1UpperBound: (size) => oracleCall("getL1FeeUpperBound", [BigInt(size)]), operatorFee: (g) => oracleCall("getOperatorFee", [g]) } });
    return { ...built, requests: transport.stats.requests };
  }
  return { prepare };
}
