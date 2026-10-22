// Ledger state, import planning, parity and escrow conservation for the rev-16d -> rev-17 cutover.
// Pure planning functions take plain data; I/O goes through a `read` function so the same code runs against the
// live snapshot (agreed reads), the fork, or a test fixture.
import { encodeFunctionData, encodeAbiParameters, keccak256 } from 'viem';
import { LEDGER_ABI } from './abis.mjs';

const MC = [{ type: 'function', name: 'aggregate3', stateMutability: 'payable', inputs: [{ type: 'tuple[]', name: 'calls', components: [
  { type: 'address', name: 'target' }, { type: 'bool', name: 'allowFailure' }, { type: 'bytes', name: 'callData' }] }],
  outputs: [{ type: 'tuple[]', name: 'r', components: [{ type: 'bool', name: 'success' }, { type: 'bytes', name: 'returnData' }] }] }];
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const ZERO32 = '0x' + '0'.repeat(64), ZERO = '0x' + '0'.repeat(40);
const lc = (a) => String(a).toLowerCase();
export const SIDE = ['feeOf', 'earnOf', 'capOf', 'refundableOf', 'ownerEscrow6', 'provenUntil'];

/** Read every record and its side mappings from `ledger` through `node` (a ForkNode or any {read, pub}). */
export async function readLedger(node, ledger, { blockNumber } = {}) {
  const r = (fn, args = []) => node.read(ledger, LEDGER_ABI, fn, args, blockNumber);
  const count = Number(await r('count'));
  const recs = [];
  for (let i = 0; i < count; i += 50) recs.push(...await r('getPage', [BigInt(i), 50n]));
  const calls = recs.flatMap((d) => SIDE.map((fn) => ({ target: ledger, allowFailure: false, callData: encodeFunctionData({ abi: LEDGER_ABI, functionName: fn, args: [d.id] }) })));
  const res = [];
  for (let i = 0; i < calls.length; i += 120) res.push(...await node.read(MULTICALL3, MC, 'aggregate3', [calls.slice(i, i + 120)], blockNumber));
  const { decodeFunctionResult } = await import('viem');
  const dec = (fn, data) => decodeFunctionResult({ abi: LEDGER_ABI, functionName: fn, data });
  return recs.map((d, i) => {
    const v = (fn) => dec(fn, res[i * SIDE.length + SIDE.indexOf(fn)].returnData);
    const fee = v('feeOf'), earn = v('earnOf');
    return { ...d, fee: { recipient: fee[0], rate6: fee[1] }, earn: { rate6: earn[0], escrow6: earn[1], creditedUntil: earn[2] }, cap6: v('capOf'),
      refundable6: v('refundableOf'), ownerEscrow6: v('ownerEscrow6'), provenUntil: v('provenUntil') };
  });
}

// ---- import planning (the admin-console engine's semantics: delta, resumable, chunked by calibrated gas) ----
const strBytes = (v) => new TextEncoder().encode(String(v ?? '')).length;
export const recordImportGas = (d) => Math.ceil(1.2 * (270_000 + 730 * (strBytes(d.appRef) + strBytes(d.ports) + strBytes(d.configCid))));
const GAS_BUDGET = 9_000_000, MAX_RECORDS = 6, SIDE_CHUNK = 40;
export const cleanLease = (d) => ({ ...d, runner: ZERO32, runnerOperator: ZERO, leaseUntil: 0n });
const tuple = (d) => ({ id: d.id, owner: d.owner, appRef: d.appRef, ports: d.ports, configCid: d.configCid, gpuMilli: d.gpuMilli, cpuMilli: d.cpuMilli,
  appPort: d.appPort, isPublic: d.isPublic, active: d.active, createdAt: d.createdAt, rate: d.rate, balance6: d.balance6, spent6: d.spent6,
  runner: d.runner, runnerOperator: d.runnerOperator, leaseUntil: d.leaseUntil });
function chunkByGas(items) {
  const out = []; let cur = [], used = 0;
  for (const it of items) { const g = recordImportGas(it); if (cur.length && (used + g > GAS_BUDGET || cur.length >= MAX_RECORDS)) { out.push(cur); cur = []; used = 0; } cur.push(it); used += g; }
  if (cur.length) out.push(cur);
  return out;
}
/** Transactions that bring `target` (its current records) to `source` (snapshot F records). Deterministic order. */
export function planImport(source, target) {
  const have = new Map(target.map((d) => [lc(d.id), d]));
  const sorted = [...source].sort((a, b) => (lc(a.id) < lc(b.id) ? -1 : 1));
  const todo = sorted.filter((d) => !have.has(lc(d.id))).map(cleanLease);
  const txs = chunkByGas(todo).map((c, i) => ({ label: `importDeployments batch ${i + 1} (${c.length})`, kind: 'importDeployments', ids: c.map((d) => d.id),
    gasModel: 120_000 + c.reduce((s, d) => s + recordImportGas(d), 0), data: encodeFunctionData({ abi: LEDGER_ABI, functionName: 'importDeployments', args: [c.map(tuple)] }) }));
  const tgt = (d) => have.get(lc(d.id));
  const side = (kind, rows, fn, args) => { for (let i = 0; i < rows.length; i += SIDE_CHUNK) { const c = rows.slice(i, i + SIDE_CHUNK);
    txs.push({ label: `${kind} batch ${i / SIDE_CHUNK + 1} (${c.length})`, kind, ids: c.map((d) => d.id), gasModel: 100_000 + 45_000 * c.length,
      data: encodeFunctionData({ abi: LEDGER_ABI, functionName: fn, args: args(c) }) }); } };
  side('importFees', sorted.filter((d) => BigInt(d.fee.rate6) > 0n && !(tgt(d) && BigInt(tgt(d).fee.rate6) === BigInt(d.fee.rate6) && lc(tgt(d).fee.recipient) === lc(d.fee.recipient))),
    'importFees', (c) => [c.map((d) => d.id), c.map((d) => d.fee.recipient), c.map((d) => BigInt(d.fee.rate6))]);
  side('importEarn', sorted.filter((d) => BigInt(d.earn.rate6) > 0n && !(tgt(d) && BigInt(tgt(d).earn.rate6) === BigInt(d.earn.rate6))),
    'importEarn', (c) => [c.map((d) => d.id), c.map((d) => BigInt(d.earn.rate6))]);
  // importDeployments defaults the cap to the rate; only a different real cap needs a call
  side('importCaps', sorted.filter((d) => BigInt(d.cap6) !== (tgt(d) ? BigInt(tgt(d).cap6) : BigInt(d.rate))),
    'importCaps', (c) => [c.map((d) => d.id), c.map((d) => BigInt(d.cap6))]);
  return txs;
}

/** The DNS-label reservation of an imported id: _prefixTaken (slot 24, mapping(bytes4 => bool)). */
export const prefixSlot = (id) => keccak256(encodeAbiParameters([{ type: 'bytes4' }, { type: 'uint256' }], [id.slice(0, 10), 24n]));

/** Field-by-field parity of the target against snapshot F. Every difference is a reason to refuse the seal. */
export function parity(source, target, prefixTaken = null) {
  const byId = new Map(target.map((d) => [lc(d.id), d]));
  const bad = [];
  const F = ['id', 'owner', 'appRef', 'ports', 'configCid', 'gpuMilli', 'cpuMilli', 'appPort', 'isPublic', 'active', 'createdAt', 'rate', 'balance6', 'spent6'];
  for (const s of source) {
    const t = byId.get(lc(s.id));
    if (!t) { bad.push({ id: s.id, field: 'missing' }); continue; }
    for (const f of F) if (lc(s[f]) !== lc(t[f])) bad.push({ id: s.id, field: f, source: String(s[f]), target: String(t[f]) });
    if (BigInt(t.leaseUntil) !== 0n || t.runner !== ZERO32 || lc(t.runnerOperator) !== lc(ZERO)) bad.push({ id: s.id, field: 'lease not cleared' });
    if (BigInt(s.fee.rate6) !== BigInt(t.fee.rate6) || (BigInt(s.fee.rate6) > 0n && lc(s.fee.recipient) !== lc(t.fee.recipient))) bad.push({ id: s.id, field: 'fee' });
    if (BigInt(s.earn.rate6) !== BigInt(t.earn.rate6)) bad.push({ id: s.id, field: 'earn.rate6', source: String(s.earn.rate6), target: String(t.earn.rate6) });
    if (BigInt(s.cap6) !== BigInt(t.cap6)) bad.push({ id: s.id, field: 'cap6', source: String(s.cap6), target: String(t.cap6) });
    if (prefixTaken && prefixTaken[lc(s.id)] !== true) bad.push({ id: s.id, field: 'prefix reservation' });
  }
  if (target.length !== source.length) bad.push({ field: 'count', source: source.length, target: target.length });
  return { total: source.length, ok: source.length - new Set(bad.map((b) => b.id)).size, bad };
}

/** Owner-controlled changes on the OLD ledger after F (they did not migrate; owners re-apply them on the new one). */
export function drift(atF, now) {
  const byId = new Map(now.map((d) => [lc(d.id), d]));
  const out = [];
  for (const s of atF) { const n = byId.get(lc(s.id)); if (!n) continue;
    for (const f of ['appRef', 'configCid', 'gpuMilli', 'cpuMilli', 'active', 'owner']) if (lc(s[f]) !== lc(n[f])) out.push({ id: s.id, field: f, atF: String(s[f]), now: String(n[f]) });
    if (BigInt(s.cap6) !== BigInt(n.cap6)) out.push({ id: s.id, field: 'cap6', atF: String(s.cap6), now: String(n.cap6) }); }
  for (const n of now) if (!atF.some((s) => lc(s.id) === lc(n.id))) out.push({ id: n.id, field: 'created after F' });
  return out;
}

/** Escrow conservation per record, from the OLD ledger after every lease lapsed (post): what the owner's refund push
 *  pays (R), what governance's sweep can recover to payout (S, only where the old ledger allows it), what stays stuck,
 *  and what the NEW record needs to back its imported balance (N = ceil(balance6 * rate6 / rate), as _splitFunding). */
export function escrowConservation(postOld, imported) {
  const byId = new Map(imported.map((d) => [lc(d.id), d]));
  const rows = [];
  for (const d of postOld) {
    const E = BigInt(d.earn.escrow6), R = BigInt(d.refundable6);
    const imp = byId.get(lc(d.id));
    const B = imp ? BigInt(imp.balance6) : 0n, rate = imp ? BigInt(imp.rate) : 0n, r6 = imp ? BigInt(imp.earn.rate6) : 0n;
    const N = rate === 0n || r6 === 0n ? 0n : (B * r6 + rate - 1n) / rate;
    // after the push refund the old record has balance6 0 when R > 0; otherwise its balance stays and sweepEscrow
    // (needs balance6 < rate, no live lease) can only take the remainder when that holds
    const balanceAfterRefund = R > 0n ? 0n : BigInt(d.balance6);
    const sweepable = E - R > 0n && balanceAfterRefund < BigInt(d.rate);
    const S = sweepable ? E - R : 0n, stuck = E - R - S;
    rows.push({ id: d.id, owner: d.owner, escrow6: E, refundToOwner6: R, sweepToPayout6: S, stuck6: stuck, newNeeds6: N,
      platformBacks6: N < S ? N : S, ownerMayReback6: N - (N < S ? N : S) < R ? N - (N < S ? N : S) : R });
  }
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0n);
  return { rows, totals: Object.fromEntries(['escrow6', 'refundToOwner6', 'sweepToPayout6', 'stuck6', 'newNeeds6', 'platformBacks6', 'ownerMayReback6'].map((k) => [k, sum(k)])) };
}
