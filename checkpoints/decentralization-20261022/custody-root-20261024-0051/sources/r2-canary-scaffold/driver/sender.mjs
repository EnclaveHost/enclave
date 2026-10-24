// ONE custody vault `update` per canary step, sent the way the reviewed metal0 operator helper sends its single
// transaction (work/custody-operator-proposal-20261023 lib/proposer.mjs f2a7b81): the same pattern, narrowed to
// this driver's prepared calldata. Not a general engine:
//   - exactly two distinct RPCs; every chain fact must agree at ONE block both serve; an RPC error is an error;
//   - the target's runtime code hash must be the pinned vault's; nonce latest == pending == agreed on both RPCs;
//   - gas = max estimate x 1.25 <= the step's gas cap; maxFee = 2 x base + max tip <= the fee cap;
//   - Base L1 data fee = GasPriceOracle.getL1FeeUpperBound(argument), sized from the EXACT transaction (its real nonce,
//     gas, fees, calldata): argument = max(unsigned, signedMax - 68), where signedMax is the encoding with yParity 1 and
//     r = s = 2^256-1, so the oracle's own +68 signature allowance covers the largest signed form (the same correction
//     as work/custody-operator-fees-20261023 7bf4c94); a smaller argument refuses (l1_size);
//   - Base operator fee = GasPriceOracle.getOperatorFee(gas limit), and isIsthmus() MUST be true: not Isthmus, a revert
//     or an RPC disagreement leaves the fee undetermined, and the step REFUSES (operator_fee). A bound over its pinned
//     allowance refuses too (fee_unbounded): no unaccounted cost is ever allowed;
//   - totalAtBlock = gas x maxFee + L1 bound + operator fee, checked against the step cap, the AGGREGATE canary budget
//     (spent so far + this + the cleanup reserve) and the live balance. These are bounds at the AGREED BLOCK's oracle
//     parameters (L1 fee inputs and operator-fee parameters can change before inclusion); send re-reads them fresh.
//     They are not a timeless guarantee;
//   - send re-runs every check, signs the prepared fields, and writes the signed bytes + hash to a private 0600
//     intent file (temp, fsync, exclusive link, dir fsync) BEFORE any broadcast; a failed write broadcasts nothing;
//   - an intent file blocks any second signing for that step. Unknown outcomes go through resume, which never
//     signs: it reads both RPCs, and only with --rebroadcast re-sends the SAME bytes while the nonce is unused on
//     both. A nonce consumed by another transaction is a final `conflict`.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const lc = (a) => String(a).toLowerCase();
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const hexN = (n) => "0x" + BigInt(n).toString(16);
export const ORACLE = "0x420000000000000000000000000000000000000f";   // Base GasPriceOracle predeploy

export class Refusal extends Error { constructor(code, message) { super(message); this.code = code; } }
const refuse = (code, message) => { throw new Refusal(code, message); };

export const ORACLE_SIGNATURE_ALLOWANCE = 68;   // bytes getL1FeeUpperBound adds to its (unsigned) size argument
// Encoded sizes of the EXACT transaction: unsigned, and the MAXIMUM signed size (yParity 1, r = s = 2^256-1; type 2
// without an access list, as signed here). `argument` is the smallest oracle argument whose size + 68 covers signedMax.
export function txSizes(viem, tx) {
  const unsigned = (viem.serializeTransaction(tx).length - 2) / 2;
  const signedMax = (viem.serializeTransaction(tx, { r: "0x" + "ff".repeat(32), s: "0x" + "ff".repeat(32), yParity: 1 }).length - 2) / 2;
  return { unsigned, signedMax, argument: Math.max(unsigned, signedMax - ORACLE_SIGNATURE_ALLOWANCE) };
}
export function assertCoversSigned({ argument, signedMax }) {
  if (!(Number.isSafeInteger(argument) && argument + ORACLE_SIGNATURE_ALLOWANCE >= signedMax))
    refuse("l1_size", `the L1 fee size ${argument} (+${ORACLE_SIGNATURE_ALLOWANCE} signature bytes) undercounts the signed transaction (${signedMax} bytes)`);
}

export const httpRpc = (timeoutMs = 15_000) => async (url, method, params) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  if (!r.ok) throw new Error(`${new URL(url).host} ${method}: HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw Object.assign(new Error(`${new URL(url).host} ${method}: ${String(j.error.message || j.error.code).slice(0, 200)}`), { rpcError: j.error });
  return j.result;
};

// viem: the pinned repo's viem module (encode/decode, serialize/parse, keccak256, privateKeyToAccount via accounts)
export function createSender({ viem, accounts, rpcs, rpc = httpRpc(), dir, vault, vaultCodeHash, now = () => Date.now(),
                               sleep = (ms) => new Promise((r) => setTimeout(r, ms)), fsImpl = fs, cfg = {} }) {
  const C = { confirmations: 2, readDepth: 2, maxPrepAgeSec: 1800, receiptPolls: 60, pollMs: 4000, ...cfg };
  if (!Array.isArray(rpcs) || rpcs.length !== 2 || rpcs[0] === rpcs[1]) throw new Error("exactly two distinct RPCs");
  if (!dir) throw new Error("a private directory is required");
  const ORACLE_ABI = [
    { type: "function", name: "getL1FeeUpperBound", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
    { type: "function", name: "isIsthmus", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
    { type: "function", name: "getOperatorFee", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  ];
  const both = (method, params) => Promise.all(rpcs.map((u) => rpc(u, method, params)));
  const agree = async (what, method, params) => {
    const r = await both(method, params);
    if (JSON.stringify(r[0]) !== JSON.stringify(r[1])) refuse("rpc_disagree", `the RPCs disagree on ${what}`);
    return r[0];
  };
  const unsignedTx = (t) => ({ type: "eip1559", chainId: 8453, nonce: Number(t.nonce), to: vault, value: 0n, data: t.data,
    gas: BigInt(t.gas), maxFeePerGas: BigInt(t.maxFeePerGas), maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas) });

  async function agreedBlock() {
    const ids = await both("eth_chainId", []);
    if (ids.some((x) => Number(x) !== 8453)) refuse("chain", "an RPC is not on Base");
    const heads = (await both("eth_blockNumber", [])).map((x) => BigInt(x));
    const n = (heads[0] < heads[1] ? heads[0] : heads[1]) - BigInt(C.readDepth);
    const blocks = await both("eth_getBlockByNumber", [hexN(n), false]);
    if (!blocks[0] || !blocks[1] || lc(blocks[0].hash) !== lc(blocks[1].hash)) refuse("rpc_disagree", `the RPCs disagree on block ${n}`);
    const latest = await both("eth_getBlockByNumber", ["latest", false]);
    const base = latest.map((b) => BigInt(b.baseFeePerGas)).reduce((a, x) => (x > a ? x : a), BigInt(blocks[0].baseFeePerGas));
    return { number: n, hash: lc(blocks[0].hash), baseFee: base };
  }
  async function observe(from) {
    const blk = await agreedBlock();
    const at = { blockHash: blk.hash, requireCanonical: true };
    const code = await agree("vault code", "eth_getCode", [vault, at]);
    if (viem.keccak256(code) !== vaultCodeHash) refuse("vault_code", "the vault's runtime code hash is not the pinned original");
    const nonceAt = BigInt(await agree("nonce at block", "eth_getTransactionCount", [from, at]));
    const nl = (await both("eth_getTransactionCount", [from, "latest"])).map(BigInt), np = (await both("eth_getTransactionCount", [from, "pending"])).map(BigInt);
    const all = [nonceAt, ...nl, ...np];
    if (all.some((x) => x !== all[0])) refuse("nonce", "the owner's nonce is not settled (agreed/latest/pending differ): a transaction may be in flight");
    const balance = BigInt(await agree("balance", "eth_getBalance", [from, at]));
    const call = (to, data, f) => agree(`eth_call ${to} ${data.slice(0, 10)}`, "eth_call", [{ to, data, ...(f ? { from: f } : {}) }, at]);
    return { blk, at, call, nonce: all[0], balance };
  }
  // worst-case pricing; caps: { gas, maxFeePerGas, l1FeeWei, operatorFeeWei }
  async function pricing(o, { from, data, caps, nonce, gasFixed = null, fees = null }) {
    const P = { from, to: vault, data, value: "0x0" };
    await o.call(vault, data, from);                                                       // the exact update simulates (reverts throw)
    const est = (await both("eth_estimateGas", [P, hexN(o.blk.number)])).map(BigInt);
    const estMax = est[0] > est[1] ? est[0] : est[1];
    const gas = gasFixed ?? (estMax * 5n + 3n) / 4n;
    if (estMax > gas) refuse("gas", `the estimate ${estMax} exceeds the prepared gas ${gas}`);
    if (gas > BigInt(caps.gas)) refuse("gas", `gas ${gas} exceeds the step cap ${caps.gas}`);
    let prio, maxFee;
    if (fees) { prio = BigInt(fees.maxPriorityFeePerGas); maxFee = BigInt(fees.maxFeePerGas); }
    else { const tips = (await both("eth_maxPriorityFeePerGas", [])).map(BigInt); prio = tips[0] > tips[1] ? tips[0] : tips[1]; maxFee = 2n * o.blk.baseFee + prio; }
    if (maxFee > BigInt(caps.maxFeePerGas)) refuse("fees", `maxFeePerGas ${maxFee} exceeds the cap ${caps.maxFeePerGas}`);
    if (prio > maxFee) refuse("fees", "priority fee above max fee");
    if (maxFee < o.blk.baseFee + prio) refuse("fees", `the base fee ${o.blk.baseFee} no longer fits the prepared max fee: prepare again`);
    // the L1 data fee: sized from the EXACT transaction (its real nonce), conservatively for its maximum signed encoding
    const sizes = txSizes(viem, unsignedTx({ nonce, gas, maxFeePerGas: maxFee, maxPriorityFeePerGas: prio, data }));
    assertCoversSigned(sizes);
    const oracle = (functionName, args = []) => o.call(ORACLE, viem.encodeFunctionData({ abi: ORACLE_ABI, functionName, args }))
      .then((d) => viem.decodeFunctionResult({ abi: ORACLE_ABI, functionName, data: d }));
    let l1;
    try { l1 = await oracle("getL1FeeUpperBound", [BigInt(sizes.argument)]); }
    catch (e) { if (e instanceof Refusal) throw e; refuse("fee_unbounded", `the L1 data-fee bound could not be read (${String(e.message).slice(0, 120)}): no unaccounted cost is allowed`); }
    // the operator fee: the oracle's own computation for the gas LIMIT (non-decreasing in gas used), or no send at all
    let isthmus, opFee;
    try { isthmus = await oracle("isIsthmus"); }
    catch (e) { if (e instanceof Refusal) throw e; refuse("operator_fee", `the GasPriceOracle cannot report the operator fee (isIsthmus(): ${String(e.message).slice(0, 120)}); an undetermined fee blocks sending`); }
    if (isthmus !== true) refuse("operator_fee", "the GasPriceOracle reports no Isthmus operator-fee support; the operator fee is undetermined and sending stays blocked");
    try { opFee = await oracle("getOperatorFee", [gas]); }
    catch (e) { if (e instanceof Refusal) throw e; refuse("operator_fee", `getOperatorFee(${gas}) failed (${String(e.message).slice(0, 120)}); an undetermined fee blocks sending`); }
    if (l1 > BigInt(caps.l1FeeWei)) refuse("fee_unbounded", `L1 fee upper bound ${l1} exceeds its pinned allowance ${caps.l1FeeWei}`);
    if (opFee > BigInt(caps.operatorFeeWei)) refuse("fee_unbounded", `operator fee ${opFee} exceeds its pinned allowance ${caps.operatorFeeWei}`);
    const l2 = gas * maxFee, total = l2 + l1 + opFee;
    return { gas, maxFeePerGas: maxFee, maxPriorityFeePerGas: prio, estimates: est.map(String), sizes, l2MaxWei: l2, l1FeeUpperBound: l1, operatorFeeBound: opFee, totalAtBlockWei: total };
  }

  // ---- the intent file: one private, exclusive, fsynced record per step, written BEFORE broadcast ----
  const fsyncDir = (d) => { const fd = fsImpl.openSync(d, "r"); try { fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); } };
  const intentPath = (stepId) => path.join(dir, `tx-${stepId}.json`);
  const readIntent = (stepId) => JSON.parse(fsImpl.readFileSync(intentPath(stepId), "utf8"));
  function writeIntent(rec, { create = false } = {}) {
    const final = intentPath(rec.stepId), tmp = path.join(dir, `.tx-${rec.stepId}.${process.pid}.${now()}.tmp`);
    const fd = fsImpl.openSync(tmp, "wx", 0o600);
    try { fsImpl.writeFileSync(fd, JSON.stringify(rec, null, 1) + "\n"); fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); }
    if (create) { try { fsImpl.linkSync(tmp, final); } finally { fsImpl.unlinkSync(tmp); } }
    else fsImpl.renameSync(tmp, final);
    fsyncDir(dir);
  }
  const publicOf = (rec) => ({ stepId: rec.stepId, txHash: rec.txHash, nonce: rec.nonce, status: rec.status, broadcasts: rec.broadcasts, receipt: rec.receipt || null,
    costWei: rec.costWei || null, note: rec.note || null });

  // ---- prepare: chain reads only, no key ----
  // budget: { remainingWei (aggregate budget - spent - cleanup reserve still owed), reserveWei (cleanup reserve) }
  async function prepare({ stepId, stepHash, from, data, caps, budget }) {
    if (fsImpl.existsSync(intentPath(stepId))) refuse("intent", "this step already has a signed intent: use resume");
    const o = await observe(from);
    const pr = await pricing(o, { from, data, caps, nonce: o.nonce });
    if (pr.totalAtBlockWei > BigInt(budget.remainingWei)) refuse("aggregate_budget", `worst case ${pr.totalAtBlockWei} wei exceeds the remaining aggregate canary budget ${budget.remainingWei} wei`);
    if (o.balance < pr.totalAtBlockWei + BigInt(budget.reserveWei)) refuse("balance", `balance ${o.balance} < worst case ${pr.totalAtBlockWei} + cleanup reserve ${budget.reserveWei}`);
    const prepared = { v: 1, stepId, stepHash, preparedAt: new Date(now()).toISOString(), dataSha256: sha256(Buffer.from(data.slice(2), "hex")),
      tx: { type: "eip1559", chainId: 8453, from: lc(from), to: vault, value: "0", nonce: o.nonce.toString(), gas: pr.gas.toString(),
            maxFeePerGas: pr.maxFeePerGas.toString(), maxPriorityFeePerGas: pr.maxPriorityFeePerGas.toString() },
      observed: { block: o.blk.number.toString(), blockHash: o.blk.hash, rpcs: rpcs.map((u) => new URL(u).host), balanceWei: o.balance.toString(), baseFeePerGas: o.blk.baseFee.toString(),
        estimates: pr.estimates, l2MaxWei: pr.l2MaxWei.toString(), l1FeeUpperBoundWei: pr.l1FeeUpperBound.toString(), operatorFeeBoundWei: pr.operatorFeeBound.toString(),
        totalAtBlockWei: pr.totalAtBlockWei.toString(),
        encodedBytes: { unsigned: pr.sizes.unsigned, signedMax: pr.sizes.signedMax, oracleArgument: pr.sizes.argument, oracleSignatureAllowance: ORACLE_SIGNATURE_ALLOWANCE },
        feeNote: "L2 cap + GasPriceOracle L1 data-fee upper bound for the maximum signed size + the oracle's operator fee for the gas limit, at the agreed block's oracle parameters; send re-reads them. Not a guarantee against later L1-fee or operator-parameter changes.",
        remainingBudgetWei: String(budget.remainingWei), cleanupReserveWei: String(budget.reserveWei) } };
    prepared.preparedHash = "0x" + sha256(JSON.stringify(prepared));
    return prepared;
  }

  // ---- send: fresh checks, key (callback), sign, intent, broadcast, verify ----
  async function send({ prepared, data, confirm, readKey, caps, budget }) {
    if (confirm !== prepared.preparedHash) refuse("confirm", "--confirm must equal the prepared hash");
    const { preparedHash, ...rest } = prepared;
    if ("0x" + sha256(JSON.stringify(rest)) !== preparedHash) refuse("prepared", "the prepared record does not hash to its preparedHash");
    if (sha256(Buffer.from(data.slice(2), "hex")) !== prepared.dataSha256) refuse("prepared", "the calldata is not the prepared calldata");
    if (fsImpl.existsSync(intentPath(prepared.stepId))) refuse("intent", "a signed intent already exists for this step: use resume (never signs twice)");
    if (now() - Date.parse(prepared.preparedAt) > C.maxPrepAgeSec * 1000) refuse("stale_prepare", "the prepared record is too old: prepare again");
    const o = await observe(prepared.tx.from);
    if (o.nonce.toString() !== prepared.tx.nonce) refuse("nonce", `the owner nonce moved since prepare (${prepared.tx.nonce} -> ${o.nonce})`);
    const pr = await pricing(o, { from: prepared.tx.from, data, caps, nonce: o.nonce, gasFixed: BigInt(prepared.tx.gas), fees: prepared.tx });
    if (pr.totalAtBlockWei > BigInt(budget.remainingWei)) refuse("aggregate_budget", "the worst case no longer fits the remaining aggregate budget");
    if (o.balance < pr.totalAtBlockWei + BigInt(budget.reserveWei)) refuse("balance", "the balance no longer covers the worst case plus the cleanup reserve");
    let account;
    try { account = accounts.privateKeyToAccount(await readKey()); } catch { refuse("key", "the owner key could not be read or is malformed"); }
    if (lc(account.address) !== prepared.tx.from) refuse("key", "the key does not belong to the pinned canary owner");
    let raw;
    try { raw = await account.signTransaction(unsignedTx({ ...prepared.tx, data })); } catch { refuse("sign", "signing failed"); }
    account = null;
    const txHash = viem.keccak256(raw);
    const p = viem.parseTransaction(raw);
    if (lc(p.to) !== vault || lc(p.data) !== lc(data) || (p.value || 0n) !== 0n || String(p.nonce) !== prepared.tx.nonce || p.chainId !== 8453) refuse("sign", "the signed transaction differs from the prepared one");
    const rec = { stepId: prepared.stepId, stepHash: prepared.stepHash, preparedHash, from: prepared.tx.from, nonce: prepared.tx.nonce, txHash, raw,
      worstCaseWei: pr.totalAtBlockWei.toString(), operatorFeeBoundWei: pr.operatorFeeBound.toString(), signedAt: new Date(now()).toISOString(), status: "signed", broadcasts: [] };
    writeIntent(rec, { create: true });                                                      // durable BEFORE any broadcast
    return broadcastAndVerify(rec, data);
  }

  async function broadcastAndVerify(rec, data) {
    for (const u of rpcs) {
      let r;
      try { r = { rpc: new URL(u).host, at: new Date(now()).toISOString(), result: lc(await rpc(u, "eth_sendRawTransaction", [rec.raw])) }; }
      catch (e) { r = { rpc: new URL(u).host, at: new Date(now()).toISOString(), error: String(e.message).slice(0, 200) }; }
      if (r.result && r.result !== rec.txHash) r.error = `answered another hash ${r.result}`;
      rec.broadcasts.push(r);
    }
    rec.status = "broadcast"; writeIntent(rec);
    for (let i = 0; i < C.receiptPolls; i++) {
      const v = await checkOutcome(rec, data).catch((e) => ({ status: "unknown", note: e.message }));
      if (["verified", "failed", "conflict"].includes(v.status)) { Object.assign(rec, v); writeIntent(rec); return publicOf(rec); }
      rec.note = v.note; await sleep(C.pollMs);
    }
    rec.status = "unknown"; writeIntent(rec);
    return publicOf(rec);
  }

  // the journaled transaction's outcome from both RPCs; never signs. Cost = gasUsed x effectiveGasPrice + receipt l1Fee
  // + the prepared operator-fee BOUND (conservative: the ledger never under-counts).
  async function checkOutcome(rec, data) {
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
    const r = rcpts[0], bn = BigInt(r.blockNumber);
    const heads = (await both("eth_blockNumber", [])).map(BigInt);
    if (heads.some((h) => h - bn < BigInt(C.confirmations))) return { status: "pending", note: "awaiting confirmations" };
    const txs = await both("eth_getTransactionByHash", [rec.txHash]);
    for (const t of txs) if (!t || lc(t.from) !== rec.from || lc(t.to) !== vault || BigInt(t.value) !== 0n || (data && lc(t.input) !== lc(data)) || BigInt(t.nonce) !== BigInt(rec.nonce) || lc(t.blockHash) !== lc(r.blockHash))
      return { status: "failed", note: "the mined transaction does not match the intent (from/to/value/data/nonce/block)" };
    if (r.l1Fee === undefined || r.l1Fee === null) return { status: "failed", note: "the receipt carries no l1Fee: the cost cannot be accounted" };
    const costWei = (BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice) + BigInt(r.l1Fee) + BigInt(rec.operatorFeeBoundWei)).toString();
    const receipt = { blockNumber: bn.toString(), blockHash: lc(r.blockHash), status: BigInt(r.status) === 1n ? "success" : "reverted", gasUsed: BigInt(r.gasUsed).toString(),
      effectiveGasPrice: BigInt(r.effectiveGasPrice).toString(), l1Fee: BigInt(r.l1Fee).toString() };
    return { status: BigInt(r.status) === 1n ? "verified" : "failed", note: BigInt(r.status) === 1n ? "mined and confirmed" : "the transaction reverted (its cost is still spent)", receipt, costWei };
  }

  async function resume({ stepId, data = null, rebroadcast = false }) {
    let rec; try { rec = readIntent(stepId); } catch { refuse("intent", "no signed intent for this step"); }
    if (viem.keccak256(rec.raw) !== rec.txHash || rec.stepId !== stepId) refuse("intent", "the intent record is inconsistent");
    if (["verified", "failed", "conflict"].includes(rec.status)) return publicOf(rec);
    const v = await checkOutcome(rec, data).catch((e) => ({ status: "unknown", note: e.message }));
    if (["verified", "failed", "conflict"].includes(v.status)) { Object.assign(rec, v); writeIntent(rec); return publicOf(rec); }
    if (!rebroadcast) { rec.note = v.note; writeIntent(rec); return { ...publicOf(rec), status: v.status, hint: "not landed yet: resume --rebroadcast re-sends the SAME bytes" }; }
    const latest = (await both("eth_getTransactionCount", [rec.from, "latest"])).map(BigInt);
    if (latest.some((n) => n !== BigInt(rec.nonce))) refuse("nonce", "the nonce is no longer the intent's on both RPCs: not re-sending");
    return broadcastAndVerify(rec, data);
  }

  return { prepare, send, resume, observe, status: (stepId) => publicOf(readIntent(stepId)) };
}

// The cost of transactions root sent with the EXISTING CLI (deployment create/stop, lease-gas configure/deposit), read
// from both RPCs (they must agree). Per tx: gasUsed x effectiveGasPrice + receipt l1Fee + value + the pinned
// operator-fee allowance (conservative). Refuses a missing, unconfirmed, reverted-but-unexplained or foreign transaction.
export async function receiptCosts({ rpc = httpRpc(), rpcs, txHashes, from, operatorFeeWei, confirmations = 2 }) {
  if (!Array.isArray(rpcs) || rpcs.length !== 2 || rpcs[0] === rpcs[1]) throw new Error("exactly two distinct RPCs");
  if (!Array.isArray(txHashes) || !txHashes.length || txHashes.some((h) => !/^0x[0-9a-f]{64}$/.test(String(h)))) refuse("txs", "txHashes: one or more lowercase 0x hashes");
  const both = (m, p) => Promise.all(rpcs.map((u) => rpc(u, m, p)));
  const heads = (await both("eth_blockNumber", [])).map(BigInt);
  const rows = [];
  let total = 0n;
  for (const h of txHashes) {
    const [r, t] = await Promise.all([both("eth_getTransactionReceipt", [h]), both("eth_getTransactionByHash", [h])]);
    if (!r[0] || !r[1] || lc(r[0].blockHash) !== lc(r[1].blockHash) || !t[0] || !t[1]) refuse("txs", `${h}: not mined, or the RPCs disagree`);
    if (lc(t[0].from) !== lc(from)) refuse("txs", `${h}: not sent by the canary owner`);
    if (heads.some((x) => x - BigInt(r[0].blockNumber) < BigInt(confirmations))) refuse("txs", `${h}: not yet confirmed`);
    if (r[0].l1Fee === undefined || r[0].l1Fee === null) refuse("txs", `${h}: the receipt carries no l1Fee`);
    const cost = BigInt(r[0].gasUsed) * BigInt(r[0].effectiveGasPrice) + BigInt(r[0].l1Fee) + BigInt(t[0].value) + BigInt(operatorFeeWei);
    total += cost;
    rows.push({ txHash: h, status: BigInt(r[0].status) === 1n ? "success" : "reverted", to: lc(t[0].to), valueWei: BigInt(t[0].value).toString(), gasUsed: BigInt(r[0].gasUsed).toString(), costWei: cost.toString() });
  }
  return { costWei: total.toString(), txs: rows };
}
