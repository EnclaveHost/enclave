// The metal0 registry operator's ONE transaction: EnclaveHostOwnership(0xbbd885…).proposeOwner(metal0, Enclave wallet).
// Exactly the public, simulated plan custody-v2-live-20261023/evidence/metal0-enrollment-unsigned-20261023.json (tx 1;
// tx 2, acceptOwner, is the Enclave admin wallet's and is NOT handled here). No other target, function, argument or value.
//
//   prepare (default): two RPCs, one agreed block. Check the ownership code hash, its registry, the host entry (active,
//     operator, payout, endpoint), the authority (owner and pending zero), the nonce (latest == pending on both), the
//     simulation, gas, fees, the Base L1 fee upper bound, the caps and the balance. Writes a public prepared plan
//     (no key is read).
//   send: requires the CURRENT prepared plan's hash and an explicit flag. It re-runs every check fresh, then reads the
//     operator key through a callback, derives and compares the address, and signs exactly the prepared fields. The
//     signed bytes and hash go to a private 0600 journal (fsynced, exclusive) BEFORE any broadcast. Then it broadcasts
//     and verifies the receipt.
//   resume: never signs. With the journal's bytes it checks the chain; only with --rebroadcast does it re-send the SAME
//     bytes, and only while the nonce is still unused.
// Every chain fact needs both RPCs to agree; an RPC error is an error, never "absent".
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { encodeFunctionData, decodeFunctionResult, encodeAbiParameters, keccak256, serializeTransaction, parseTransaction, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const lc = (a) => String(a).toLowerCase();
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const hexN = (n) => "0x" + BigInt(n).toString(16);

export const PLAN_FILE_SHA256 = "9f6eba17c9c479e9006849316f1708f37ee6680f37a990e57e07c421b86e6b82";
export const PRODUCTION = Object.freeze({
  chainId: 8453,
  ownership: "0xbbd885d3e9bc33609387bb9710e91c1905fe6ee7",
  ownershipCodeHash: "0xe38a0e160dd929c366bccd30636285458c288ada475f1b74ffc3289febf1d5dd",
  registry: "0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac",
  hostId: "0x4dde6d1b33034333dd86f1f4cd5528b0118ad99c3f903e270ebeaf4533e068be",
  hostEndpoint: "https://api.enclave.host/t/metal0",
  operator: "0xc9d0835cd8ebc7eae84304d9db0a76253eebe6ab",
  // the operator is an EIP-7702-delegated EOA: the lease executor's delegation must stay EXACTLY as it is (root
  // 2026-10-23; work/lease-enrollment-signing/trust.mjs executor/executorRuntimeHash/delegationCodeHash). A plain
  // EOA, another target or any other code refuses; this transaction neither touches nor re-delegates it.
  operatorDelegation: "0xef01008900baca2167873ba2f8a8bae8b4876e6396d343",
  operatorDelegationCodeHash: "0xe2f1317f7b76520f746c22fe4898b7ad32d7a6947a4c11a766fdcdd55bf88bbe",
  delegationTarget: "0x8900baca2167873ba2f8a8bae8b4876e6396d343",
  delegationTargetCodeHash: "0xdd893cd48b7c102dc266949d027c33d396a7f8884533ee81b3b2275048ec9ab2",
  proposed: "0x0b2d009c0c9af05b12100d77f3c815fea822ee61",   // the Enclave admin wallet (also metal0's payout wallet)
  data: "0x03ba33a44dde6d1b33034333dd86f1f4cd5528b0118ad99c3f903e270ebeaf4533e068be0000000000000000000000000b2d009c0c9af05b12100d77f3c815fea822ee61",
  oracle: "0x420000000000000000000000000000000000000f",       // Base GasPriceOracle predeploy
  rpcs: Object.freeze(["https://mainnet.base.org", "https://base.public.blockpi.network/v1/rpc/public"]),
  keyFile: "/home/steven/Projects/enclave/metal/config.json",  // field registryKey; read only by --send, at runtime
  caps: Object.freeze({ gas: 150_000n, maxFeePerGas: 100_000_000n /* 0.1 gwei */, totalWei: 5_000_000_000_000n /* 0.000005 ETH */ }),
  confirmations: 2, readDepth: 2, maxPlanAgeSec: 3600, receiptPolls: 60, pollMs: 4000,
});

const OWNERSHIP_ABI = [
  { type: "function", name: "proposeOwner", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [] },
  { type: "function", name: "registry", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "authority", stateMutability: "view", inputs: [{ type: "bytes32" }],
    outputs: [{ type: "address", name: "owner" }, { type: "address", name: "pendingOwner" }, { type: "uint64", name: "revision" }, { type: "bytes32", name: "policyHash" }] },
];
const REGISTRY_GET = [{ type: "function", name: "get", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bytes" }] }];
const ORACLE_ABI = [{ type: "function", name: "getL1FeeUpperBound", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] }];
const ZERO = "0x0000000000000000000000000000000000000000";

export class Refusal extends Error { constructor(code, message) { super(message); this.code = code; } }
const refuse = (code, message) => { throw new Refusal(code, message); };

/** The public plan file must be exactly the reviewed one and carry exactly these constants. */
export function checkPublicPlan(text) {
  const cfg = PRODUCTION;
  if (sha256(text) !== PLAN_FILE_SHA256) refuse("plan_file", "the public enrollment plan file differs from the reviewed one");
  const p = JSON.parse(text), tx = p.unsigned?.[0], pre = p.preconditions || {};
  const want = { chainId: cfg.chainId, to: cfg.ownership, value: "0x0", data: cfg.data, from: PRODUCTION.operator };
  for (const [k, v] of Object.entries(want)) if (lc(tx?.[k]) !== lc(v)) refuse("plan_file", `plan tx1.${k} differs`);
  for (const [k, v] of [["ownershipContract", cfg.ownership], ["ownershipCodeHash", cfg.ownershipCodeHash], ["ownershipRegistry", cfg.registry],
    ["hostId", cfg.hostId], ["hostEndpoint", cfg.hostEndpoint], ["hostOperator", PRODUCTION.operator], ["payoutWallet", cfg.proposed]])
    if (lc(pre[k]) !== lc(v)) refuse("plan_file", `plan precondition ${k} differs`);
  if (encodeFunctionData({ abi: OWNERSHIP_ABI, functionName: "proposeOwner", args: [cfg.hostId, cfg.proposed] }) !== cfg.data) refuse("plan_file", "calldata is not proposeOwner(hostId, proposed)");
  return p;
}

// the registry's schema-4 Enclave tuple, read like EnclaveSecretVaultV2._hostOf: head words 3 (operator), 6 (active),
// 10 (payoutWallet), and the endpoint string at word 0's offset; later schemas append fields
export function parseRegistryEntry(ret) {
  const b = Buffer.from(String(ret).slice(2), "hex");
  const word = (off) => { if (off + 32 > b.length) refuse("host_entry", "registry answer too short"); return BigInt("0x" + b.subarray(off, off + 32).toString("hex")); };
  const base = Number(word(0));
  if (base + 11 * 32 > b.length) refuse("host_entry", "registry answer is not a schema-4 entry");
  const w = (i) => word(base + i * 32);
  const addr = (v) => { if (v >> 160n) refuse("host_entry", "malformed address"); return "0x" + v.toString(16).padStart(40, "0"); };
  const active = w(6); if (active > 1n) refuse("host_entry", "malformed active flag");
  const eo = base + Number(w(0)), len = Number(word(eo));
  if (eo + 32 + len > b.length) refuse("host_entry", "malformed endpoint");
  return { endpoint: b.subarray(eo + 32, eo + 32 + len).toString("utf8"), operator: addr(w(3)), active: active === 1n, payoutWallet: addr(w(10)) };
}

/** JSON-RPC over fetch with a deadline; an error answer throws. */
export const httpRpc = (timeoutMs = 15_000) => async (url, method, params) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  if (!r.ok) throw new Error(`${new URL(url).host} ${method}: HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw Object.assign(new Error(`${new URL(url).host} ${method}: ${String(j.error.message || j.error.code).slice(0, 200)}`), { rpcError: j.error });
  return j.result;
};

// codeHashOf: a TEST seam only (a fake chain cannot produce the deployed ownership/executor bytecode); the CLI never
// passes it. The operator's 7702 designator is always hashed with keccak256.
export function createProposer({ cfg = PRODUCTION, rpc = httpRpc(), readKey = null, dir, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), fsImpl = fs,
                                 codeHashOf = keccak256 } = {}) {
  if (!dir) throw new Error("a working directory is required");
  // the transaction's target can never differ from production: only the operator address (tests sign with their own
  // key), the RPC URLs and the polling cadence may
  for (const k of ["chainId", "ownership", "ownershipCodeHash", "registry", "hostId", "hostEndpoint", "proposed", "data", "oracle",
    "operatorDelegation", "operatorDelegationCodeHash", "delegationTarget", "delegationTargetCodeHash"])
    if (cfg[k] !== PRODUCTION[k]) throw new Error(`config ${k} must be the production value`);
  for (const k of ["gas", "maxFeePerGas", "totalWei"]) if (cfg.caps?.[k] !== PRODUCTION.caps[k]) throw new Error(`cap ${k} must be the production value`);
  const rpcs = [...cfg.rpcs];
  if (rpcs.length !== 2 || rpcs[0] === rpcs[1]) throw new Error("exactly two distinct RPCs");
  const PREP = path.join(dir, "prepared"), JOUR = path.join(dir, "journal");
  const both = (method, params) => Promise.all(rpcs.map((u) => rpc(u, method, params)));
  const agree = async (what, method, params) => {
    const r = await both(method, params);
    if (JSON.stringify(r[0]) !== JSON.stringify(r[1])) refuse("rpc_disagree", `the RPCs disagree on ${what}`);
    return r[0];
  };
  const unsignedTx = (t) => ({ type: "eip1559", chainId: cfg.chainId, nonce: Number(t.nonce), to: cfg.ownership, value: 0n, data: cfg.data,
    gas: BigInt(t.gas), maxFeePerGas: BigInt(t.maxFeePerGas), maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas) });

  // ---- one agreed block and every fact at it ----
  async function agreedBlock() {
    const ids = await both("eth_chainId", []);
    if (ids.some((x) => Number(x) !== cfg.chainId)) refuse("chain", "an RPC is not on Base");
    const heads = (await both("eth_blockNumber", [])).map((x) => BigInt(x));
    const n = (heads[0] < heads[1] ? heads[0] : heads[1]) - BigInt(cfg.readDepth);
    const blocks = await both("eth_getBlockByNumber", [hexN(n), false]);
    if (!blocks[0] || !blocks[1] || lc(blocks[0].hash) !== lc(blocks[1].hash)) refuse("rpc_disagree", `the RPCs disagree on block ${n}`);
    const latest = await both("eth_getBlockByNumber", ["latest", false]);
    const base = latest.map((b) => BigInt(b.baseFeePerGas)).reduce((a, x) => (x > a ? x : a), BigInt(blocks[0].baseFeePerGas));
    return { number: n, hash: lc(blocks[0].hash), baseFee: base, timestamp: Number(blocks[0].timestamp) };
  }
  async function observe() {
    const blk = await agreedBlock();
    const at = { blockHash: blk.hash, requireCanonical: true };
    const call = (to, data, from) => agree(`eth_call ${to} ${data.slice(0, 10)}`, "eth_call", [{ to, data, ...(from ? { from } : {}) }, at]);
    const code = await agree("ownership code", "eth_getCode", [cfg.ownership, at]);
    if (codeHashOf(code) !== cfg.ownershipCodeHash) refuse("ownership_code", "EnclaveHostOwnership code hash differs from the reviewed one");
    const reg = decodeFunctionResult({ abi: OWNERSHIP_ABI, functionName: "registry", data: await call(cfg.ownership, encodeFunctionData({ abi: OWNERSHIP_ABI, functionName: "registry" })) });
    if (lc(reg) !== lc(cfg.registry)) refuse("ownership_registry", "the ownership extension names another registry");
    const regCode = await agree("registry code", "eth_getCode", [cfg.registry, at]);
    if (!regCode || regCode === "0x") refuse("host_entry", "the registry has no code");
    const host = parseRegistryEntry(await call(cfg.registry, encodeFunctionData({ abi: REGISTRY_GET, functionName: "get", args: [cfg.hostId] })));
    if (!host.active) refuse("host_entry", "the host entry is not active");
    if (lc(host.operator) !== lc(cfg.operator)) refuse("host_entry", "the host's registry operator differs");
    if (lc(host.payoutWallet) !== lc(cfg.proposed)) refuse("host_entry", "the host's payout wallet is not the proposed Enclave wallet (owner and seat flag would disagree)");
    if (host.endpoint !== cfg.hostEndpoint) refuse("host_entry", "the host endpoint differs");
    const [owner, pendingOwner, revision, policyHash] = decodeFunctionResult({ abi: OWNERSHIP_ABI, functionName: "authority",
      data: await call(cfg.ownership, encodeFunctionData({ abi: OWNERSHIP_ABI, functionName: "authority", args: [cfg.hostId] })) });
    const authority = { owner: lc(owner), pendingOwner: lc(pendingOwner), revision: revision.toString(), policyHash };
    const nonceAt = BigInt(await agree("nonce at block", "eth_getTransactionCount", [cfg.operator, at]));
    const nl = (await both("eth_getTransactionCount", [cfg.operator, "latest"])).map(BigInt), np = (await both("eth_getTransactionCount", [cfg.operator, "pending"])).map(BigInt);
    const balance = BigInt(await agree("balance", "eth_getBalance", [cfg.operator, at]));
    // the operator's code: exactly the reviewed EIP-7702 delegation to the reviewed executor runtime
    const opCode = lc(await agree("operator code", "eth_getCode", [cfg.operator, at]));
    if (opCode !== cfg.operatorDelegation || keccak256(opCode) !== cfg.operatorDelegationCodeHash)
      refuse("operator", opCode === "0x" ? "the operator has no EIP-7702 delegation (the reviewed lease-executor delegation is missing)" : "the operator's code is not the reviewed EIP-7702 delegation");
    const target = await agree("delegation target code", "eth_getCode", [cfg.delegationTarget, at]);
    if (codeHashOf(target) !== cfg.delegationTargetCodeHash) refuse("operator", "the delegation target's runtime differs from the reviewed executor");
    return { blk, at, call, host, regCodeHash: keccak256(regCode), authority, nonceAt, nonceLatest: nl, noncePending: np, balance,
             operatorCodeHash: keccak256(opCode), delegationTargetCodeHash: cfg.delegationTargetCodeHash };
  }
  function authorityState(o, verifiedJournal) {
    const a = o.authority, P = lc(cfg.proposed);
    if (a.owner === P) return "accepted";
    if (a.owner !== ZERO) refuse("authority", `the host already has another owner ${a.owner}`);
    if (a.pendingOwner === P) return verifiedJournal ? "proposed" : refuse("authority", "the proposal is already pending, but not from a verified journal entry of this tool");
    if (a.pendingOwner !== ZERO) refuse("authority", `another owner ${a.pendingOwner} is pending`);
    return "ready";
  }
  function checkNonce(o) {
    const all = [o.nonceAt, ...o.nonceLatest, ...o.noncePending];
    if (all.some((x) => x !== all[0])) refuse("nonce", "the operator's nonce is not settled (latest/pending/agreed differ): a transaction may be in flight");
    return all[0];
  }
  async function pricing(o, gasFixed = null, fees = null) {
    const P = { from: cfg.operator, to: cfg.ownership, data: cfg.data, value: "0x0" };
    await o.call(cfg.ownership, cfg.data, cfg.operator);                                   // the exact call succeeds (reverts throw)
    const est = (await both("eth_estimateGas", [P, hexN(o.blk.number)])).map(BigInt);
    const estMax = est[0] > est[1] ? est[0] : est[1];
    const gas = gasFixed ?? (estMax * 5n + 3n) / 4n;                                        // +25 %
    if (estMax > gas) refuse("gas", `the estimate ${estMax} exceeds the prepared gas ${gas}`);
    if (gas > cfg.caps.gas) refuse("gas", `gas ${gas} exceeds the cap ${cfg.caps.gas}`);
    let prio, maxFee;
    if (fees) ({ maxPriorityFeePerGas: prio, maxFeePerGas: maxFee } = { maxPriorityFeePerGas: BigInt(fees.maxPriorityFeePerGas), maxFeePerGas: BigInt(fees.maxFeePerGas) });
    else {
      const tips = (await both("eth_maxPriorityFeePerGas", [])).map(BigInt);
      prio = tips[0] > tips[1] ? tips[0] : tips[1];
      maxFee = 2n * o.blk.baseFee + prio;
    }
    if (maxFee > cfg.caps.maxFeePerGas) refuse("fees", `maxFeePerGas ${maxFee} exceeds the cap ${cfg.caps.maxFeePerGas}`);
    if (prio > maxFee) refuse("fees", "priority fee above max fee");
    if (maxFee < o.blk.baseFee + prio) refuse("fees", `the current base fee ${o.blk.baseFee} no longer fits the prepared max fee ${maxFee}: prepare again`);
    const size = (serializeTransaction(unsignedTx({ nonce: 0, gas, maxFeePerGas: maxFee, maxPriorityFeePerGas: prio })).length - 2) / 2;
    const l1 = decodeFunctionResult({ abi: ORACLE_ABI, functionName: "getL1FeeUpperBound",
      data: await o.call(cfg.oracle, encodeFunctionData({ abi: ORACLE_ABI, functionName: "getL1FeeUpperBound", args: [BigInt(size)] })) });
    const total = gas * maxFee + l1;
    if (total > cfg.caps.totalWei) refuse("cap", `the worst-case cost ${total} wei exceeds the cap ${cfg.caps.totalWei}`);
    return { gas, maxFeePerGas: maxFee, maxPriorityFeePerGas: prio, estimates: est.map(String), l1FeeUpperBound: l1, totalMaxWei: total, unsignedSize: size };
  }

  // ---- the journal: one private, exclusive, fsynced record per signed transaction ----
  const ensureDir = (d, mode) => { fsImpl.mkdirSync(d, { recursive: true, mode }); fsImpl.chmodSync(d, mode); };
  const fsyncDir = (d) => { const fd = fsImpl.openSync(d, "r"); try { fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); } };
  const journalFiles = () => (fsImpl.existsSync(JOUR) ? fsImpl.readdirSync(JOUR).filter((f) => /^0x[0-9a-f]{64}\.json$/.test(f)) : []);
  const readJournal = (planHash) => JSON.parse(fsImpl.readFileSync(path.join(JOUR, `${planHash}.json`), "utf8"));
  function writeJournal(rec, { create = false } = {}) {
    ensureDir(JOUR, 0o700);
    const final = path.join(JOUR, `${rec.planHash}.json`), tmp = path.join(JOUR, `.${rec.planHash}.${process.pid}.${now()}.tmp`);
    const fd = fsImpl.openSync(tmp, "wx", 0o600);
    try { fsImpl.writeFileSync(fd, JSON.stringify(rec, null, 1) + "\n"); fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); }
    if (create) { try { fsImpl.linkSync(tmp, final); } finally { fsImpl.unlinkSync(tmp); } }   // exclusive: an existing record wins
    else fsImpl.renameSync(tmp, final);
    fsyncDir(JOUR);
  }
  const verifiedJournal = () => journalFiles().some((f) => { try { return JSON.parse(fsImpl.readFileSync(path.join(JOUR, f), "utf8")).status === "verified"; } catch { return false; } });
  const publicOf = (rec) => ({ planHash: rec.planHash, txHash: rec.txHash, nonce: rec.nonce, status: rec.status, broadcasts: rec.broadcasts, receipt: rec.receipt || null, note: rec.note || null });

  // ---- prepare ----
  async function prepare({ planText }) {
    checkPublicPlan(planText);
    const o = await observe();
    const state = authorityState(o, verifiedJournal());
    if (state !== "ready") return { status: state, authority: o.authority, block: o.blk.number.toString() };
    const nonce = checkNonce(o);
    const pr = await pricing(o);
    const plan = { v: 1, tool: "custody-operator-propose", planFileSha256: PLAN_FILE_SHA256, preparedAt: new Date(now()).toISOString(),
      tx: { type: "eip1559", chainId: cfg.chainId, from: lc(cfg.operator), to: cfg.ownership, value: "0", data: cfg.data, nonce: nonce.toString(),
            gas: pr.gas.toString(), maxFeePerGas: pr.maxFeePerGas.toString(), maxPriorityFeePerGas: pr.maxPriorityFeePerGas.toString() },
      caps: { gas: cfg.caps.gas.toString(), maxFeePerGas: cfg.caps.maxFeePerGas.toString(), totalWei: cfg.caps.totalWei.toString() },
      observed: { block: o.blk.number.toString(), blockHash: o.blk.hash, rpcs, ownershipCodeHash: cfg.ownershipCodeHash, registry: cfg.registry, registryCodeHash: o.regCodeHash,
                  host: { id: cfg.hostId, ...o.host }, authority: o.authority,
                  operatorCode: { delegation: cfg.operatorDelegation, codeHash: o.operatorCodeHash, target: cfg.delegationTarget, targetCodeHash: o.delegationTargetCodeHash }, nonce: nonce.toString(), balanceWei: o.balance.toString(),
                  estimates: pr.estimates, baseFeePerGas: o.blk.baseFee.toString(), l1FeeUpperBoundWei: pr.l1FeeUpperBound.toString(), totalMaxWei: pr.totalMaxWei.toString(),
                  balanceSufficient: o.balance >= pr.totalMaxWei, fundingNeededWei: (o.balance >= pr.totalMaxWei ? 0n : pr.totalMaxWei - o.balance).toString() } };
    const text = JSON.stringify(plan, null, 1) + "\n";
    const planHash = "0x" + sha256(text);
    ensureDir(PREP, 0o755);
    fsImpl.writeFileSync(path.join(PREP, `${planHash}.json`), text, { flag: "wx", mode: 0o644 });
    fsImpl.writeFileSync(path.join(PREP, "current.tmp"), planHash + "\n"); fsImpl.renameSync(path.join(PREP, "current.tmp"), path.join(PREP, "current"));
    return { status: "prepared", planHash, plan };
  }

  function loadCurrentPlan(planHash) {
    if (!/^0x[0-9a-f]{64}$/.test(String(planHash))) refuse("plan_hash", "--plan-hash must be the prepared plan's 0x sha256");
    let cur; try { cur = fsImpl.readFileSync(path.join(PREP, "current"), "utf8").trim(); } catch { refuse("plan_hash", "no prepared plan"); }
    if (cur !== planHash) refuse("plan_hash", "--plan-hash is not the CURRENT prepared plan");
    const text = fsImpl.readFileSync(path.join(PREP, `${planHash}.json`), "utf8");
    if ("0x" + sha256(text) !== planHash) refuse("plan_hash", "the prepared plan file does not hash to --plan-hash");
    const plan = JSON.parse(text);
    if (plan.planFileSha256 !== PLAN_FILE_SHA256 || lc(plan.tx.to) !== cfg.ownership || plan.tx.data !== cfg.data || plan.tx.value !== "0" || lc(plan.tx.from) !== lc(cfg.operator) || plan.tx.chainId !== cfg.chainId)
      refuse("plan_hash", "the prepared plan is not this tool's transaction");
    return plan;
  }

  // ---- send: fresh checks, key, sign, journal, broadcast, verify ----
  async function send({ planHash, confirm, planText }) {
    if (confirm !== true) refuse("confirm", "--send needs the explicit broadcast flag");
    checkPublicPlan(planText);
    if (journalFiles().length) refuse("journal", "a signed transaction is already journaled: use --resume (this tool never signs twice)");
    const plan = loadCurrentPlan(planHash);
    if (now() - Date.parse(plan.preparedAt) > cfg.maxPlanAgeSec * 1000) refuse("stale_plan", "the prepared plan is older than the allowed age: prepare again");
    const o = await observe();
    if (authorityState(o, false) !== "ready") refuse("authority", "the authority is no longer zero/zero");
    const nonce = checkNonce(o);
    if (nonce.toString() !== plan.tx.nonce) refuse("nonce", `the operator nonce moved since prepare (${plan.tx.nonce} -> ${nonce})`);
    if (o.regCodeHash !== plan.observed.registryCodeHash) refuse("host_entry", "the registry code changed since prepare");
    const pr = await pricing(o, BigInt(plan.tx.gas), plan.tx);
    if (o.balance < pr.totalMaxWei) refuse("balance", `the operator balance ${o.balance} wei is below the worst-case cost ${pr.totalMaxWei} wei`);
    // the key: read only now, never logged; the derived address must be the registered operator
    if (typeof readKey !== "function") refuse("key", "no key reader");
    let account;
    try { const k = await readKey(); account = privateKeyToAccount(String(k).startsWith("0x") ? k : "0x" + k); }
    catch { refuse("key", "the operator key could not be read or is malformed"); }
    if (lc(account.address) !== lc(cfg.operator)) refuse("key", "the key does not belong to the registered operator");
    let raw;
    try { raw = await account.signTransaction(unsignedTx(plan.tx)); } catch { refuse("sign", "signing failed"); }
    account = null;
    const txHash = keccak256(raw);
    const parsed = parseTransaction(raw);
    if (lc(parsed.to) !== cfg.ownership || parsed.data !== cfg.data || (parsed.value || 0n) !== 0n || String(parsed.nonce) !== plan.tx.nonce) refuse("sign", "the signed transaction differs from the plan");
    const rec = { planHash, from: lc(cfg.operator), nonce: plan.tx.nonce, txHash, raw, signedAt: new Date(now()).toISOString(), status: "signed", broadcasts: [] };
    writeJournal(rec, { create: true });                                                     // durable BEFORE any broadcast
    return await broadcastAndVerify(rec);
  }

  async function broadcastAndVerify(rec) {
    for (const u of rpcs) {
      let r;
      try { r = { rpc: new URL(u).host, at: new Date(now()).toISOString(), result: lc(await rpc(u, "eth_sendRawTransaction", [rec.raw])) }; }
      catch (e) { r = { rpc: new URL(u).host, at: new Date(now()).toISOString(), error: String(e.message).slice(0, 200) }; }
      if (r.result && r.result !== rec.txHash) r.error = `answered another hash ${r.result}`;
      rec.broadcasts.push(r);
    }
    rec.status = "broadcast";
    writeJournal(rec);
    return await awaitReceipt(rec);
  }

  async function awaitReceipt(rec) {
    for (let i = 0; i < cfg.receiptPolls; i++) {
      const v = await checkOutcome(rec).catch((e) => ({ status: "unknown", note: e.message }));
      if (["verified", "failed", "conflict"].includes(v.status)) { Object.assign(rec, v); writeJournal(rec); return publicOf(rec); }
      rec.note = v.note; await sleep(cfg.pollMs);
    }
    rec.status = "unknown"; writeJournal(rec);
    return publicOf(rec);
  }

  // the journaled transaction's outcome, from both RPCs; never signs
  async function checkOutcome(rec) {
    const rcpts = await both("eth_getTransactionReceipt", [rec.txHash]);
    if (rcpts.every((r) => !r)) {
      const latest = (await both("eth_getTransactionCount", [rec.from, "latest"])).map(BigInt);
      if (latest.every((n) => n > BigInt(rec.nonce))) {
        const txs = await both("eth_getTransactionByHash", [rec.txHash]);
        if (txs.every((t) => !t)) return { status: "conflict", note: `nonce ${rec.nonce} was used by another transaction; this one never landed. Stop: nothing is re-signed` };
      }
      return { status: "pending", note: "no receipt yet" };
    }
    if (!rcpts[0] || !rcpts[1] || lc(rcpts[0].blockHash) !== lc(rcpts[1].blockHash)) return { status: "pending", note: "the RPCs do not yet agree on the receipt" };
    const r = rcpts[0];
    const heads = (await both("eth_blockNumber", [])).map(BigInt), bn = BigInt(r.blockNumber);
    if (heads.some((h) => h - bn < BigInt(cfg.confirmations))) return { status: "pending", note: "awaiting confirmations" };
    const txs = await both("eth_getTransactionByHash", [rec.txHash]);
    for (const t of txs) if (!t || lc(t.from) !== rec.from || lc(t.to) !== cfg.ownership || BigInt(t.value) !== 0n || lc(t.input) !== lc(cfg.data) || BigInt(t.nonce) !== BigInt(rec.nonce) || lc(t.blockHash) !== lc(r.blockHash))
      return { status: "failed", note: "the mined transaction does not match the journal (from/to/value/data/nonce/block)" };
    if (BigInt(r.status) !== 1n) return { status: "failed", note: "the transaction reverted", receipt: { blockNumber: bn.toString(), blockHash: lc(r.blockHash), status: "reverted" } };
    const o = await observe();
    if (o.blk.number < bn) return { status: "pending", note: "the agreed read block is behind the receipt" };
    const P = lc(cfg.proposed), a = o.authority;
    if (!((a.owner === ZERO && a.pendingOwner === P) || a.owner === P)) return { status: "failed", note: `after the receipt the authority is owner ${a.owner} pending ${a.pendingOwner}` };
    return { status: "verified", note: a.owner === P ? "already accepted by the Enclave wallet" : "pending owner = Enclave wallet; next: its acceptOwner",
             receipt: { blockNumber: bn.toString(), blockHash: lc(r.blockHash), status: "success", gasUsed: BigInt(r.gasUsed).toString(), confirmationsAtCheck: (heads[0] - bn).toString(),
                        authorityAfter: { ...a, atBlock: o.blk.number.toString() } } };
  }

  // ---- resume: the journaled bytes only ----
  async function resume({ planHash, rebroadcast = false }) {
    let rec; try { rec = readJournal(planHash); } catch { refuse("journal", "no journal record for this plan hash"); }
    if (keccak256(rec.raw) !== rec.txHash || rec.planHash !== planHash) refuse("journal", "the journal record is inconsistent");
    if (rec.status === "verified" || rec.status === "conflict") return publicOf(rec);
    const v = await checkOutcome(rec).catch((e) => ({ status: "unknown", note: e.message }));
    if (["verified", "failed", "conflict"].includes(v.status)) { Object.assign(rec, v); writeJournal(rec); return publicOf(rec); }
    if (!rebroadcast) { rec.note = v.note; writeJournal(rec); return { ...publicOf(rec), status: v.status, hint: "not landed yet: --resume --rebroadcast re-sends the SAME bytes" }; }
    // re-send the same bytes only while the nonce is still unused on both RPCs
    const latest = (await both("eth_getTransactionCount", [rec.from, "latest"])).map(BigInt);
    if (latest.some((n) => n !== BigInt(rec.nonce))) refuse("nonce", "the nonce is no longer the journaled one on both RPCs: not re-sending");
    return await broadcastAndVerify(rec);
  }

  return { prepare, send, resume, observe, status: (planHash) => publicOf(readJournal(planHash)) };
}

// test helper: the ABI encodings a fake chain answers with
export const abi = { OWNERSHIP_ABI, REGISTRY_GET, ORACLE_ABI, encodeAbiParameters, getAddress };
