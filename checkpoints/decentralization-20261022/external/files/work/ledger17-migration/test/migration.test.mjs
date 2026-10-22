// Unit tests for the rev-17 migration tooling: guards, gates, import planning, parity, drift, conservation.
// No live network. One local plain anvil (no fork) for the fork guard's refusal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { decodeFunctionData, keccak256, toHex } from 'viem';
import { assertLiveUrl, rpc, LIVE } from '../lib/live.mjs';
import { ForkNode, refuseLiveWrite } from '../lib/fork.mjs';
import { assertCanRetire, assertCanImport, assertCanSeal, assertCanBack } from '../lib/gates.mjs';
import { planImport, parity, drift, escrowConservation, cleanLease, prefixSlot } from '../lib/ledgerstate.mjs';
import { LEDGER_ABI } from '../lib/abis.mjs';

const Z32 = '0x' + '0'.repeat(64), Z = '0x' + '0'.repeat(40);
const rec = (i, o = {}) => ({ id: keccak256(toHex('rec' + i)), owner: '0x' + String(i).padStart(40, '1'), appRef: 'catalog://a/' + i, ports: '', configCid: i % 3 ? '' : 'x'.repeat(2000),
  gpuMilli: 0, cpuMilli: 100, appPort: 8080, isPublic: true, active: true, createdAt: 1n, rate: 100n, balance6: 1000n, spent6: 5n,
  runner: keccak256(toHex('h')), runnerOperator: '0x' + 'a'.repeat(40), leaseUntil: 99n,
  fee: { recipient: Z, rate6: 0n }, earn: { rate6: 80n, escrow6: 0n, creditedUntil: 0n }, cap6: 100n, refundable6: 0n, ownerEscrow6: 0n, provenUntil: 0n, ...o });

test('live layer: only allowlisted https endpoints, only read methods', async () => {
  assert.equal(assertLiveUrl(LIVE.state[0]), LIVE.state[0]);
  assert.throws(() => assertLiveUrl('http://mainnet.base.org'), /https/);
  assert.throws(() => assertLiveUrl('https://user:pw@mainnet.base.org'), /credentials/);
  assert.throws(() => assertLiveUrl('https://evil.example/rpc'), /allowlist/);
  for (const m of ['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign', 'personal_sign', 'anvil_impersonateAccount'])
    await assert.rejects(rpc(LIVE.state[0], m, []), /read-only/);
  assert.throws(() => refuseLiveWrite(LIVE.state[0]), /never writes to a live endpoint/);
  refuseLiveWrite('http://127.0.0.1:8545');
});

test('gates refuse with the exact unmet conditions', () => {
  const all = { codeVerified: true, parametersEqual: true, bindingsSet: true, rehearsalPassed: true, clientReadiness: true, escrowPlan: true };
  assertCanRetire(all);
  assert.throws(() => assertCanRetire({ ...all, clientReadiness: false }), /client readiness/);
  assert.throws(() => assertCanRetire({ ...all, codeVerified: false, rehearsalPassed: false }), /verified builds.*rehearsal passed/);
  assert.throws(() => assertCanImport({ sourceRetired: false }), /not retired/);
  assertCanImport({ sourceRetired: true });
  assert.throws(() => assertCanSeal({ total: 3, ok: 2, bad: [{ id: 'x', field: 'missing' }] }), /1 parity failure/);
  assertCanSeal({ total: 3, ok: 3, bad: [] });
  assert.throws(() => assertCanBack({ importsSealed: false }), /owner-refundable/);
});

test('import plan: deterministic, delta-resumable, lease cleared, chunked by gas and count', () => {
  const src = Array.from({ length: 20 }, (_, i) => rec(i, { cap6: i % 4 ? 100n : 250n, fee: i === 5 ? { recipient: '0x' + 'f'.repeat(40), rate6: 7n } : { recipient: Z, rate6: 0n } }));
  const a = planImport(src, []), b = planImport([...src].reverse(), []);
  assert.deepEqual(a.map((t) => t.data), b.map((t) => t.data), 'order-independent');
  const imp = a.filter((t) => t.kind === 'importDeployments');
  for (const t of imp) {
    const { args } = decodeFunctionData({ abi: LEDGER_ABI, data: t.data });
    assert.ok(args[0].length <= 6);
    for (const d of args[0]) { assert.equal(d.runner, Z32); assert.equal(d.leaseUntil, 0n); assert.equal(d.runnerOperator.toLowerCase(), Z); }
    assert.ok(t.gasModel <= 9_000_000 + 2_000_000);
  }
  assert.equal(imp.reduce((n, t) => n + t.ids.length, 0), 20);
  assert.equal(a.filter((t) => t.kind === 'importFees').reduce((n, t) => n + t.ids.length, 0), 1);
  assert.equal(a.filter((t) => t.kind === 'importCaps').reduce((n, t) => n + t.ids.length, 0), 5);
  // resume: the target already holds the first 12 with their side mappings
  const target = src.slice(0, 12).map((d) => cleanLease(d));
  const rest = planImport(src, target);
  assert.equal(rest.filter((t) => t.kind === 'importDeployments').reduce((n, t) => n + t.ids.length, 0), 8);
  assert.equal(planImport(src, src.map(cleanLease)).length, 0, 'complete import plans nothing');
});

test('parity catches every field, missing records, uncleared leases and missing prefix reservations', () => {
  const src = [rec(1), rec(2)], tgt = src.map(cleanLease);
  const prefix = Object.fromEntries(src.map((d) => [d.id.toLowerCase(), true]));
  assert.equal(parity(src, tgt, prefix).bad.length, 0);
  for (const [f, v] of [['owner', '0x' + '9'.repeat(40)], ['appRef', 'x'], ['configCid', 'y'], ['cpuMilli', 1], ['active', false], ['rate', 1n], ['balance6', 1n], ['spent6', 9n], ['createdAt', 2n]]) {
    const t = [{ ...tgt[0], [f]: v }, tgt[1]];
    assert.ok(parity(src, t, prefix).bad.some((b) => b.field === f), f);
  }
  assert.ok(parity(src, [tgt[0]], prefix).bad.some((b) => b.field === 'missing'));
  assert.ok(parity(src, [{ ...tgt[0], leaseUntil: 5n }, tgt[1]], prefix).bad.some((b) => b.field === 'lease not cleared'));
  assert.ok(parity(src, [{ ...tgt[0], earn: { rate6: 1n } }, tgt[1]], prefix).bad.some((b) => b.field === 'earn.rate6'));
  assert.ok(parity(src, [{ ...tgt[0], cap6: 1n }, tgt[1]], prefix).bad.some((b) => b.field === 'cap6'));
  assert.ok(parity(src, tgt, { [src[0].id.toLowerCase()]: true }).bad.some((b) => b.field === 'prefix reservation'));
  assert.match(prefixSlot(src[0].id), /^0x[0-9a-f]{64}$/);
});

test('drift reports owner edits and creations on the old ledger after F', () => {
  const F = [rec(1), rec(2)];
  const now = [{ ...F[0], configCid: 'changed' }, F[1], rec(3)];
  const d = drift(F, now);
  assert.deepEqual(d.map((x) => x.field).sort(), ['configCid', 'created after F']);
});

test('escrow conservation: every old escrow unit goes to exactly one place; backing never exceeds recovery or need', () => {
  const post = [
    rec(1, { earn: { escrow6: 1000n }, refundable6: 600n, balance6: 50n, rate: 100n }),          // refund, then sweepable remainder
    rec(2, { earn: { escrow6: 900n }, refundable6: 0n, balance6: 5000n, rate: 100n }),           // no owner escrow, still fundable: stuck
    rec(3, { earn: { escrow6: 0n }, refundable6: 0n, balance6: 0n, rate: 0n }),                   // free
  ];
  const imported = post.map((d) => ({ ...d, earn: { rate6: d.rate === 0n ? 0n : 80n } }));
  const c = escrowConservation(post, imported);
  for (const r of c.rows) {
    assert.equal(r.refundToOwner6 + r.sweepToPayout6 + r.stuck6, r.escrow6);
    assert.ok(r.platformBacks6 <= r.sweepToPayout6 && r.platformBacks6 <= r.newNeeds6);
    assert.ok(r.ownerMayReback6 <= r.refundToOwner6);
  }
  assert.equal(c.rows[0].sweepToPayout6, 400n);
  assert.equal(c.rows[1].stuck6, 900n);
  assert.equal(c.rows[1].newNeeds6, (5000n * 80n + 99n) / 100n);
  assert.equal(c.totals.stuck6, 900n);
});

test('fork guard refuses a node that is not a fork of the snapshot block on chain 31337', async () => {
  const port = await new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
  const child = spawn('anvil', ['--port', String(port), '--host', '127.0.0.1', '--silent', '--chain-id', '31337'], { stdio: 'ignore' });
  try {
    const node = new ForkNode(child, port, 123n, LIVE.state[0]);
    for (let i = 0; i < 100; i++) { try { await node.raw('eth_chainId', []); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    await assert.rejects(node.assertGuarded(), /fork block/);
    await assert.rejects(node.send({ from: node.account(0), to: Z, data: '0x', label: 'x' }), /fork block/);
    assert.equal(node.guarded, false);
  } finally { child.kill('SIGKILL'); }
});
