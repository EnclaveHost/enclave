// Standard EIP-7702 account maintenance for ONE account: fund metal0's registry operator C9 (whose delegate, the
// reviewed EnclaveLeaseExecutor 0x8900baca…, has no payable entry) by
//   A  sponsor S, type-4: authorization {8453, 0x0, N} (C9 cleared)  +  call C9 with value V (plain transfer)
//   B  sponsor S, type-4: authorization {8453, executor, N+1} (C9 restored byte-exactly)  +  call S, value 0
// This module is READ-ONLY: it never reads a key, signs or sends. It builds
//   - an EXECUTABLE unsigned plan (prepare: root's quiesce facts checked against the chain, timing profile enforced), or
//   - an OBSERVATION (observe: the same chain facts, NO quiescence asserted, executable:false, "NOT EXECUTABLE").
// Signing and sending live in lib/sender.mjs (injected signers, root approval file bound by hash); nothing is wired.
//
// Everything is specific to C9 and the same executor; createPreparer refuses any other operator, executor, value, cap,
// sponsor or timing unless the caller passes an explicit TEST fixture (the CLI never does).
import { createHash } from "node:crypto";
import { encodeFunctionData, decodeFunctionResult, encodeAbiParameters, keccak256, serializeTransaction, parseAbi } from "viem";
import { hashAuthorization } from "viem/utils";
import { pacedTransport, httpRpc, PACING, realClock, Refusal } from "../vendor/publish.mjs";

export { Refusal };
const lc = (x) => String(x ?? "").toLowerCase();
const hex = (n) => "0x" + BigInt(n).toString(16);
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const refuse = (code, message) => { throw new Refusal(code, message); };
export const ZERO = "0x0000000000000000000000000000000000000000";
const big = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
export const ser = (o) => JSON.parse(JSON.stringify(o, big));

/**
 * The maintenance TIMING profile. PROPOSED (root approval binds its sha256); derived from the protected source:
 *   leaseSec 1800 (ledger; renew() extends from leaseUntil by at most leaseSec, network/lease-gas-owner.mjs 342-345)
 *   renew lead 285 s = renewWindow 300 - 15 (client/lease-executor-client.mjs 428): a keeper renews at <= 285 s left
 *   Lease TTL 300 s (client/lease-executor-client.mjs 567: deadline = head.timestamp + 300)
 *   rollback margin 480 s = stop + 300 s TTL + slack (custody-boot-fee-activation common.py ROLLBACK_MARGIN_S)
 * Needed at the prepare's agreed block, per C9-held lease:
 *   plan age until broadcast <= 120 s  +  maintenance cutoff (first broadcast -> B verified) <= 120 s
 *   + keeper resume margin 360 s (the 285 s renew lead + 60 s to land + 15 s)  +  recovery margin 480 s  = 1080 s  -> 1200 s
 * The former 1800 s could never hold (a lease never has more than ~1800 s left, and quiescing costs up to 360 s first).
 */
export const TIMING = Object.freeze({
  status: "PROPOSED: requires root approval (the approval file binds this profile's sha256)",
  minLeaseRemainingSec: 1200, maxPlanAgeSec: 120, maintenanceCutoffSec: 120, deadlineMarginSec: 60, maxQuiesceAgeSec: 3600,
  derivation: Object.freeze({ leaseSec: 1800, renewLeadSec: 285, leaseTtlSec: 300, keeperResumeMarginSec: 360, recoveryMarginSec: 480,
    sumSec: 1080, sources: ["client/lease-executor-client.mjs:428,567", "network/lease-gas-owner.mjs:342-345 (production a3163e38)", "custody-boot-fee-activation-20261023/common.py:271"] }),
  keeperResume: "the keepers and every C9 signer resume ONLY after the sender reports `verified` (B mined, 2 confirmations on 2 providers, C9 code/nonce/storage/views/binding re-read)",
});
export const timingSha256 = (t = TIMING) => "0x" + sha256(JSON.stringify(ser(t)));

export const PRODUCTION = Object.freeze({
  chainId: 8453,
  operator: "0xc9d0835cd8ebc7eae84304d9db0a76253eebe6ab",           // metal0's registry operator (C9)
  executor: "0x8900baca2167873ba2f8a8bae8b4876e6396d343",           // EnclaveLeaseExecutor: the ONLY restore target
  executorCodeHash: "0xdd893cd48b7c102dc266949d027c33d396a7f8884533ee81b3b2275048ec9ab2",
  delegationCodeHash: "0xe2f1317f7b76520f746c22fe4898b7ad32d7a6947a4c11a766fdcdd55bf88bbe",   // keccak(0xef0100||executor)
  reserve: "0x12a3f873041dec436daa0085b766a399a6fa3639",            // EnclaveLeaseGasReserve (begin() checks the code hash)
  reserveCodeHash: "0xcc00efe9c79c17b34ef9edc2720939030834bf168abc52cea14dcb224304a979",
  ledger: "0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b",             // EnclaveDeployments rev 16d (leaseUntil, runnerOperator)
  ledgerCodeHash: "0x71d50076336283e774ba2ef8d5cbf7602e9cdc5dd918a7e7390c743367766682",
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
  timing: TIMING,
  // documentation only: this module reads neither (lib/sender.mjs takes injected signers; production wiring is NOT written)
  keySources: Object.freeze({
    operatorAuthorizations: "C9 registry key: root-only /home/steven/Projects/enclave/metal/config.json field registryKey",
    sponsorTransactions: "the sponsor 0x29479bf0…647c's signer: root-provided",
  }),
});

const EXECUTOR_ABI = parseAbi(["function nonceOf(bytes32 id) view returns (uint64)", "function authorizationCharged() view returns (bool)"]);
const RESERVE_ABI = parseAbi(["function executor() view returns (address)", "function delegationCodeHash() view returns (bytes32)"]);
const ORACLE_ABI = parseAbi(["function getL1FeeUpperBound(uint256) view returns (uint256)", "function isIsthmus() view returns (bool)",
  "function getOperatorFee(uint256) view returns (uint256)"]);
// the production release's ledger tuple (metal-deabf8f90 network/lease-gas-owner.mjs, sha256 a3163e38…), verbatim
const DEPLOYMENT_TUPLE = [{ name: "id", type: "bytes32" }, { name: "owner", type: "address" }, { name: "appRef", type: "string" }, { name: "ports", type: "string" },
  { name: "configCid", type: "string" }, { name: "gpuMilli", type: "uint16" }, { name: "cpuMilli", type: "uint16" }, { name: "appPort", type: "uint32" },
  { name: "isPublic", type: "bool" }, { name: "active", type: "bool" }, { name: "createdAt", type: "uint64" }, { name: "rate", type: "uint256" },
  { name: "balance6", type: "uint256" }, { name: "spent6", type: "uint256" }, { name: "runner", type: "bytes32" }, { name: "runnerOperator", type: "address" },
  { name: "leaseUntil", type: "uint64" }];
export const LEDGER_ABI = [{ type: "function", name: "get", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "tuple", components: DEPLOYMENT_TUPLE }] },
  { type: "function", name: "leaseSec", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] }];
export const ORACLE_SIGNATURE_ALLOWANCE = 68;

export const designatorOf = (executor) => "0xef0100" + lc(executor).slice(2);
export const nonceSlot = (cfg, id) => keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [id, cfg.slots.nonces]));
export const authorizedSlot = (cfg) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [cfg.executor, cfg.slots.authorized]));

export function checkConfig(cfg) {
  if (cfg.chainId === 0 || !Number.isSafeInteger(cfg.chainId)) refuse("config", "chain id must be a real chain (never 0: a chain-0 authorization replays on every chain)");
  if (lc(cfg.sponsor) === lc(cfg.operator)) refuse("config", "the sponsor must be a separate account (the nonce rules below assume it)");
  if (lc(cfg.executor) === ZERO) refuse("config", "the restore target cannot be the zero address");
  if (keccak256(designatorOf(cfg.executor)) !== cfg.delegationCodeHash) refuse("config", "delegationCodeHash is not keccak(0xef0100||executor)");
  if (!(cfg.valueWei > 0n) || !(cfg.feeCapWei > 0n)) refuse("config", "value and fee cap must be positive");
  const t = cfg.timing;
  if (!t || !(t.minLeaseRemainingSec >= t.derivation.sumSec) || t.maintenanceCutoffSec > 120 || t.maxPlanAgeSec > 120)
    refuse("config", "the timing profile must keep >= its derived sum, a <= 120 s cutoff and a <= 120 s plan age");
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

/** Every state precondition; `collect` turns refusals into findings (observation) instead of throwing (prepare). */
function checkState(cfg, f, collect) {
  const out = [];
  const req = (ok, code, message) => { if (ok) return; if (collect) out.push({ code, message }); else refuse(code, message); };
  req(lc(f.operatorCode) === designatorOf(cfg.executor), "operator_code", "C9 is not delegated to exactly the reviewed executor; this plan applies only to that state");
  req(f.plainTransferReverts === true, "premise", "a plain transfer to C9 does not revert: this maintenance is not needed (fund it directly after review)");
  req(lc(f.sponsorCode) === "0x", "sponsor_code", "the sponsor must be a plain EOA with no code (no delegation)");
  req(f.executorCodeHash === cfg.executorCodeHash, "executor_code", "the executor's runtime is not the reviewed one");
  req(f.reserveCodeHash === cfg.reserveCodeHash, "reserve_code", "the reserve's runtime is not the reviewed one");
  req(f.ledgerCodeHash === cfg.ledgerCodeHash, "ledger_code", "the ledger's runtime is not the reviewed rev 16d");
  req(lc(f.reserveExecutor) === lc(cfg.executor) && f.reserveDelegationCodeHash === cfg.delegationCodeHash, "reserve_binding", "the reserve is not bound to this executor");
  for (const [who, n] of [["operator", f.operatorNonce], ["sponsor", f.sponsorNonce]])
    req(n.atBlock === n.latest && n.latest === n.pending, "nonce", `the ${who}'s nonce is not settled (agreed ${n.atBlock}, latest ${n.latest}, pending ${n.pending}): a transaction may be in flight`);
  return out;
}

/** Fees for A and B at the agreed block: L2 cap + L1 bound for the maximum signed size + Isthmus operator fee. */
async function priceTransactions(cfg, f, oracle) {
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
  return { out, total, capExceeded: total > cfg.feeCapWei, sponsorShort: BigInt(f.sponsorBalance) < cfg.valueWei + total };
}

/** Lease timing at the agreed block from CHAIN leaseUntil values; `collect` for observation. */
function leaseTiming(cfg, f, ids, collect) {
  const out = [], rows = [];
  for (const id of ids) {
    const l = f.leases?.[lc(id)];
    if (!l) { (collect ? out.push({ code: "lease_read", message: `no chain read for lease ${id}` }) : refuse("lease_read", `no chain read for lease ${id}`)); continue; }
    const remaining = Number(l.leaseUntil) - f.blockTimestamp;
    const row = { id: lc(id), active: l.active, runnerOperator: lc(l.runnerOperator), leaseUntil: Number(l.leaseUntil), rate: String(l.rate), remainingSec: remaining,
      headroomSec: remaining - cfg.timing.minLeaseRemainingSec, latestPrepareAt: Number(l.leaseUntil) - cfg.timing.minLeaseRemainingSec };
    rows.push(row);
    const problems = [];
    if (!l.active) problems.push(["lease_holder", `deployment ${id} is not active`]);
    if (lc(l.runnerOperator) !== lc(cfg.operator)) problems.push(["lease_holder", `deployment ${id} is not held by C9 (runner operator ${l.runnerOperator})`]);
    if (remaining < cfg.timing.minLeaseRemainingSec) problems.push(["lease_window", `lease ${id} has ${remaining} s left at the agreed block, under the ${cfg.timing.minLeaseRemainingSec} s the timing profile requires`]);
    for (const [code, message] of problems) collect ? out.push({ code, message }) : refuse(code, message);
  }
  return { rows, findings: out };
}

export function checkQuiesce(cfg, q, f) {
  const T = cfg.timing, blockTs = f.blockTimestamp;
  if (!q || q.providedBy !== "root") refuse("quiesce", "the quiescence facts must be provided by root (quiesce.json)");
  if (!Array.isArray(q.signersStopped) || q.signersStopped.length === 0) refuse("quiesce", "root must list every stopped C9 signer (control, lease keepers and relays, boot/funding tools)");
  if (!Number.isSafeInteger(q.providedAt) || blockTs - q.providedAt > T.maxQuiesceAgeSec || q.providedAt > blockTs + 120) refuse("quiesce", "the quiescence facts are stale or from the future");
  if (!Number.isSafeInteger(q.lastSponsoredLeaseDeadline)) refuse("quiesce", "the last outstanding sponsored Lease deadline is required (0 if none was ever signed)");
  if (!(blockTs > q.lastSponsoredLeaseDeadline + T.deadlineMarginSec)) refuse("quiesce", "a sponsored Lease signed by C9 may still be valid at the agreed block: wait until its deadline has passed on chain");
  if (!Array.isArray(q.leases)) refuse("quiesce", "the live leases held by C9 must be listed (empty if none)");
  for (const l of q.leases) {
    if (!/^0x[0-9a-f]{64}$/.test(lc(l.id)) || !Number.isSafeInteger(l.expiry)) refuse("quiesce", "each lease needs a 32-byte id and an expiry");
    const chain = f.leases?.[lc(l.id)];
    if (!chain || Number(chain.leaseUntil) !== l.expiry) refuse("quiesce", `root's expiry for ${l.id} is not the chain's leaseUntil at the agreed block (stale facts): re-read`);
  }
  const timing = leaseTiming(cfg, f, q.leases.map((l) => l.id), false);
  return { providedBy: q.providedBy, providedAt: q.providedAt, signersStopped: q.signersStopped, lastSponsoredLeaseDeadline: q.lastSponsoredLeaseDeadline, leases: timing.rows,
    requirement: "Every C9 signer stays stopped until the sender reports `verified`: the lease client signs a NEW authorization when C9 is not delegated (client/lease-executor-client.mjs 463-464, 573-574), which would race B." };
}

const planCommon = (cfg, f, priced) => {
  const N = BigInt(f.operatorNonce.latest), s = BigInt(f.sponsorNonce.latest);
  return {
    pins: ser({ chainId: cfg.chainId, operator: cfg.operator, executor: cfg.executor, executorCodeHash: cfg.executorCodeHash, delegationCodeHash: cfg.delegationCodeHash,
      reserve: cfg.reserve, reserveCodeHash: cfg.reserveCodeHash, ledger: cfg.ledger, ledgerCodeHash: cfg.ledgerCodeHash, sponsor: cfg.sponsor, valueWei: cfg.valueWei,
      feeCapWei: cfg.feeCapWei, gas: cfg.gas, keySources: cfg.keySources }),
    timing: { ...ser(cfg.timing), sha256: timingSha256(cfg.timing) },
    observed: ser({ block: f.block, blockHash: f.blockHash, blockTimestamp: f.blockTimestamp, rpcs: f.rpcs, operatorNonce: N, operatorBalanceWei: f.operatorBalance,
      sponsorNonce: s, sponsorBalanceWei: f.sponsorBalance, operatorCode: f.operatorCode, storage: f.storage, executorViews: f.executorViews, leaseSec: f.leaseSec,
      plainTransferReverts: f.plainTransferReverts, codelessTransferSimulation: f.codelessTransferSimulation, baseFeePerGas: f.baseFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas }),
    authorizationsToSign: authorizations(cfg, N).map((a) => ser({ ...a, rule: "sponsor-executed: nonce = C9's current nonce (A) and +1 (B); chainId 8453, never 0" })),
    transactions: ["A", "B"].map((w) => ser({ label: w, sender: cfg.sponsor, unsigned: { ...priced.out[w].tx, authorizationList: [{ ...priced.out[w].auth.tuple, signature: `authorizationsToSign[${w === "A" ? 0 : 1}]` }] },
      encodedBytes: { ...priced.out[w].sizes, oracleSignatureAllowance: ORACLE_SIGNATURE_ALLOWANCE }, fee: priced.out[w].fee })),
    fees: ser({ totalBoundWei: priced.total, capWei: cfg.feeCapWei, capExceeded: priced.capExceeded, sponsorShort: priced.sponsorShort,
      note: "per tx: L2 cap (gas x maxFeePerGas) + GasPriceOracle L1 upper bound for the maximum signed size (authorization signature included) + Isthmus operator fee for the gas limit, at the agreed block." }),
    verifyAfterA: ser({ operatorCode: "0x", operatorNonce: N + 1n, operatorBalanceWei: `>= observed + ${cfg.valueWei}`, storageUnchanged: f.storage, receiptStatus: 1 }),
    verifyAfterB: ser({ operatorCode: designatorOf(cfg.executor), operatorCodeHash: cfg.delegationCodeHash, operatorNonce: N + 2n, storageUnchanged: f.storage,
      executorViewsUnchanged: f.executorViews, reserveBindingUnchanged: { executor: cfg.executor, delegationCodeHash: cfg.delegationCodeHash }, confirmations: 2, providers: 2 }),
    recovery: RECOVERY, limits: LIMITS,
  };
};

/**
 * The EXECUTABLE unsigned plan from facts read at ONE agreed block. `oracle` = { l1UpperBound(size), isIsthmus(), operatorFee(gas) }.
 * Refuses (never raises a cap, never changes V or the timing profile) when anything does not fit.
 */
export async function buildPlan({ cfg = PRODUCTION, facts, quiesce, oracle }) {
  checkConfig(cfg);
  const f = facts;
  checkState(cfg, f, false);
  const q = checkQuiesce(cfg, quiesce, f);
  const priced = await priceTransactions(cfg, f, oracle);
  if (priced.capExceeded) refuse("fee_cap", `the bounded outer fees ${priced.total} wei exceed the cap ${cfg.feeCapWei} wei; refused (the cap is not raised)`);
  if (priced.sponsorShort) refuse("sponsor_balance", `the sponsor holds ${f.sponsorBalance} wei, less than V + bounded fees (${cfg.valueWei + priced.total})`);
  const plan = { v: 2, kind: "enclave-operator-7702-maintenance/executable", executable: true, status: "UNSIGNED; executable only with a matching root approval file",
    ...planCommon(cfg, f, priced), quiesce: q, broadcastDeadline: f.blockTimestamp + cfg.timing.maxPlanAgeSec,
    order: ["Sign A's and B's authorizations (C9 key) and both transactions (sponsor) BEFORE anything is broadcast (lib/sender.mjs).",
      "Write both signed raw transactions to a private 0600 journal (O_EXCL, fsynced, dir fsynced) BEFORE any broadcast; never log them.",
      `Broadcast A then B before broadcastDeadline; verify B within ${cfg.timing.maintenanceCutoffSec} s of the first broadcast; resume keepers only on 'verified'.`] };
  const text = JSON.stringify(plan, null, 1) + "\n";
  return { plan, text, planHash: "0x" + sha256(text) };
}

/** OBSERVATION: the same chain facts and a fee preview; NOTHING about quiescence is asserted; never executable. */
export async function buildObservation({ cfg = PRODUCTION, facts, leaseIds = [], oracle }) {
  checkConfig(cfg);
  const f = facts;
  const findings = checkState(cfg, f, true);
  const timing = leaseTiming(cfg, f, leaseIds, true);
  findings.push(...timing.findings);
  let priced = null;
  try { priced = await priceTransactions(cfg, f, oracle); if (priced.capExceeded) findings.push({ code: "fee_cap", message: `fees ${priced.total} > cap ${cfg.feeCapWei}` }); if (priced.sponsorShort) findings.push({ code: "sponsor_balance", message: "sponsor balance below V + fees" }); }
  catch (e) { if (!(e instanceof Refusal)) throw e; findings.push({ code: e.code, message: e.message }); }
  const window = timing.rows.length ? { latestPrepareAt: Math.min(...timing.rows.map((r) => r.latestPrepareAt)), secondsLeftForAPrepare: Math.min(...timing.rows.map((r) => r.headroomSec)) } : null;
  const obs = { v: 2, kind: "enclave-operator-7702-maintenance/observation", executable: false, banner: "NOT EXECUTABLE: observation only. Quiescence is NOT asserted; no signer may use this file.",
    ...(priced ? planCommon(cfg, f, priced) : { observed: ser(f) }), leases: timing.rows, window, findings,
    feasibility: "An executable prepare needs, at its agreed block: root's quiesce.json (all C9 signers stopped, last sponsored Lease deadline + 60 s passed) and every listed lease >= minLeaseRemainingSec. With renewals at <= 285 s left and leases of ~1800 s, that requires the listed leases' last renewals to lie within leaseSec - minLeaseRemainingSec - (300 + 60) s of each other (240 s at 1800/1200)." };
  delete obs.verifyAfterA; delete obs.verifyAfterB;
  const text = JSON.stringify(obs, null, 1) + "\n";
  return { observation: obs, text, hash: "0x" + sha256(text) };
}

export const RECOVERY = Object.freeze([
  { state: "a-reverted", when: "A's authorization skipped, C9 still delegated (its nonce moved, or it was re-delegated)", effect: "A's call hits the executor and reverts; V stays with the sponsor; only gas is spent", action: "stop; re-read; a new plan (new nonces, new signatures, new approval)" },
  { state: "a-frontrun-funded", when: "A's authorization skipped because a third party already applied it (C9 codeless, nonce N+1)", effect: "A's value call to the CODELESS C9 SUCCEEDS: C9 is funded although our authorization did not apply", action: "B (nonce N+1) is valid: rebroadcast the SAME journaled B" },
  { state: "a-mined-b-missing", when: "A mined, B not (dropped, delayed, crash, cutoff)", effect: "C9 is a funded plain account; the reserve refuses it; relayed lease() calls SUCCEED AS NO-OPS (no renewal)", action: "sender resume --rebroadcast: the SAME journaled B while C9's nonce is N+1; keep every signer stopped" },
  { state: "b-stale", when: "A mined, then C9's nonce moved (any C9 transaction or a lease client's own authorization)", effect: "the journaled B is stale; C9 stays codeless (or was re-delegated by that authorization)", action: "read the code: exact designator = restored (verify storage); otherwise a NEW restore (C9 self-sends, nonce = current + 1, or a new sponsored B) after fresh review and approval" },
  { state: "reorg", when: "a reorg drops A and/or B", effect: "both can be re-included as the same signed bytes while the nonces are unchanged", action: "resume --rebroadcast (identical bytes only); verify only after 2 confirmations on 2 providers" },
  { state: "verified", when: "B mined and every post-condition re-read on both providers", effect: "C9 restored (code hash e2f1317f), nonce N+2, storage unchanged, funded", action: "resume the keepers and signers" },
]);
export const LIMITS = Object.freeze([
  "An unsigned prepare cannot eth_call the real transactions (no authorization signature exists yet). Its live checks are the plain-transfer revert (the premise) and, where a provider supports state overrides, the transfer to a codeless C9. The actual EIP-7702 processing is exercised only on anvil (revm, Prague) with throwaway keys.",
  "The deployed executor runtime (dd893cd4…), reserve (cc00efe9…) and ledger (71d50076…) are pinned by hash; the storage-preservation test runs the reviewed executor SOURCE (sha256 dc605ffa…) rebuilt locally, not the deployed bytes.",
  "Base's sequencer txpool rules for type-4 transactions are not verified here; a refused submission is a no-op, not a partial state.",
  "The last sponsored Lease deadline and the stopped signers come from root (quiesce.json); lease expiries are read from the chain and must equal root's list.",
]);

/** Read-only facts at one agreed block on two providers (paced, budgeted; the vendored reviewed transport). */
export function createPreparer({ cfg = PRODUCTION, rpc = httpRpc(15_000), clock = realClock, pacing = PACING, fixture = false } = {}) {
  checkConfig(cfg);
  if (!fixture) for (const k of Object.keys(PRODUCTION)) if (JSON.stringify(cfg[k], big) !== JSON.stringify(PRODUCTION[k], big)) throw Error(`config ${k} must be the production value`);
  const rpcs = [...cfg.rpcs];
  if (rpcs.length !== 2 || rpcs[0] === rpcs[1]) throw Error("exactly two distinct RPCs");
  let transport;
  const both = (m, p) => Promise.all(rpcs.map((u) => transport.send(u, m, p)));
  const agree = async (what, m, p) => { const r = await both(m, p); if (JSON.stringify(r[0]) !== JSON.stringify(r[1])) refuse("rpc_disagree", `the providers disagree on ${what}`); return r[0]; };
  async function facts(leaseIds) {
    transport = pacedTransport({ rpc, pacing, clock });
    const ids = await both("eth_chainId", []);
    if (ids.some((x) => Number(x) !== cfg.chainId)) refuse("chain", "a provider is not on the pinned chain");
    const heads = (await both("eth_blockNumber", [])).map(BigInt);
    const n = (heads[0] < heads[1] ? heads[0] : heads[1]) - BigInt(cfg.readDepth);
    const blocks = await both("eth_getBlockByNumber", [hex(n), false]);
    if (!blocks[0] || lc(blocks[0].hash) !== lc(blocks[1]?.hash)) refuse("rpc_disagree", `the providers disagree on block ${n}`);
    const blockAgeSec = clock.now()/1000 - Number(BigInt(blocks[0].timestamp));
    if (blockAgeSec > cfg.timing.maxPlanAgeSec || blockAgeSec < -120) refuse('stale', 'The agreed block is stale or too far in the future');
    const latest = await both("eth_getBlockByNumber", ["latest", false]);
    const baseFee = latest.map((b) => BigInt(b.baseFeePerGas)).reduce((a, x) => (x > a ? x : a), BigInt(blocks[0].baseFeePerGas));
    const at = { blockHash: lc(blocks[0].hash), requireCanonical: true };
    const code = (a) => agree(`code of ${a}`, "eth_getCode", [a, at]);
    const call = async (to, abi, fn, args = []) => decodeFunctionResult({ abi, functionName: fn, data: await agree(`${to} ${fn}`, "eth_call", [{ to, data: encodeFunctionData({ abi, functionName: fn, args }) }, at]) });
    const operatorCode = lc(await code(cfg.operator)), sponsorCode = lc(await code(cfg.sponsor));
    const executorCodeHash = keccak256(await code(cfg.executor)), reserveCodeHash = keccak256(await code(cfg.reserve)), ledgerCodeHash = keccak256(await code(cfg.ledger));
    const reserveExecutor = lc(await call(cfg.reserve, RESERVE_ABI, "executor")), reserveDelegationCodeHash = await call(cfg.reserve, RESERVE_ABI, "delegationCodeHash");
    const nonce = async (a) => ({ atBlock: Number(BigInt(await agree("nonce", "eth_getTransactionCount", [a, at]))),
      latest: Number((await both("eth_getTransactionCount", [a, "latest"])).map(BigInt).reduce((x, y) => (x === y ? x : -1n))),
      pending: Number((await both("eth_getTransactionCount", [a, "pending"])).map(BigInt).reduce((x, y) => (x === y ? x : -1n))) });
    const operatorNonce = await nonce(cfg.operator), sponsorNonce = await nonce(cfg.sponsor);
    const operatorBalance = BigInt(await agree("balance", "eth_getBalance", [cfg.operator, at])).toString();
    const sponsorBalance = BigInt(await agree("balance", "eth_getBalance", [cfg.sponsor, at])).toString();
    const ids_ = [...new Set(leaseIds.map(lc))].filter((x) => /^0x[0-9a-f]{64}$/.test(x));
    // leases from the CHAIN (the production release's ledger tuple)
    const leaseSec = ids_.length ? (await call(cfg.ledger, LEDGER_ABI, "leaseSec")).toString() : null;
    const leases = {};
    for (const id of ids_) { const d = await call(cfg.ledger, LEDGER_ABI, "get", [id]); leases[id] = { active: d.active, runnerOperator: lc(d.runnerOperator), leaseUntil: Number(d.leaseUntil), rate: d.rate.toString() }; }
    // the executor's state in C9's storage, raw (readable even while C9 is codeless) and through the executor's views
    const storage = { authorized: await agree("authorized slot", "eth_getStorageAt", [cfg.operator, authorizedSlot(cfg), at]), nonces: {} };
    for (const id of ids_) storage.nonces[id] = await agree("nonce slot", "eth_getStorageAt", [cfg.operator, nonceSlot(cfg, id), at]);
    const delegated = operatorCode === designatorOf(cfg.executor);
    const executorViews = { authorizationCharged: delegated ? await call(cfg.operator, EXECUTOR_ABI, "authorizationCharged") : null, nonceOf: {} };
    if (delegated) for (const id of ids_) executorViews.nonceOf[id] = (await call(cfg.operator, EXECUTOR_ABI, "nonceOf", [id])).toString();
    const transferChecks = await Promise.allSettled(rpcs.map(u => transport.send(u, "eth_call", [{ from: cfg.sponsor, to: cfg.operator, value: hex(cfg.valueWei) }, at])));
    for (const r of transferChecks) if (r.status === 'rejected' && !/revert/i.test(String(r.reason?.rpcError?.message || '')))
      refuse('premise_unavailable', 'A provider did not return an EVM revert for the plain transfer; transport failures are not evidence of a nonpayable delegate');
    const plainTransferReverts = transferChecks.every(r => r.status === 'rejected');
    let codelessTransferSimulation;
    try { await both("eth_call", [{ from: cfg.sponsor, to: cfg.operator, value: hex(cfg.valueWei) }, at, { [cfg.operator]: { code: "0x" } }]); codelessTransferSimulation = "succeeds with C9 codeless (state override)"; }
    catch (e) { if (e instanceof Refusal) throw e; codelessTransferSimulation = "not available from these providers (state override unsupported or refused)"; }
    const tips = (await both("eth_maxPriorityFeePerGas", [])).map(BigInt);
    const oracleCall = (fn, args = []) => call(cfg.oracle, ORACLE_ABI, fn, args);
    return { facts: { block: n.toString(), blockHash: at.blockHash, blockTimestamp: Number(BigInt(blocks[0].timestamp)), rpcs: rpcs.map((u) => new URL(u).host),
      operatorCode, sponsorCode, executorCodeHash, reserveCodeHash, ledgerCodeHash, reserveExecutor, reserveDelegationCodeHash, operatorNonce, sponsorNonce,
      operatorBalance, sponsorBalance, storage, executorViews, leases, leaseSec, plainTransferReverts, codelessTransferSimulation,
      baseFeePerGas: baseFee, maxPriorityFeePerGas: tips[0] > tips[1] ? tips[0] : tips[1] },
      oracle: { isIsthmus: () => oracleCall("isIsthmus"), l1UpperBound: (size) => oracleCall("getL1FeeUpperBound", [BigInt(size)]), operatorFee: (g) => oracleCall("getOperatorFee", [g]) } };
  }
  async function prepare({ quiesce }) {
    const { facts: f, oracle } = await facts((quiesce?.leases || []).map((l) => l.id));
    const built = await buildPlan({ cfg, facts: f, quiesce, oracle });
    if (clock.now()/1000 > built.plan.broadcastDeadline) refuse('stale', 'Preparation exhausted the plan freshness window');
    return { ...built, requests: transport.stats.requests };
  }
  async function observe({ leaseIds = [] } = {}) {
    const { facts: f, oracle } = await facts(leaseIds);
    const built = await buildObservation({ cfg, facts: f, leaseIds, oracle });
    return { ...built, requests: transport.stats.requests };
  }
  return { prepare, observe };
}
