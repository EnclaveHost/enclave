// The per-deployment dispatch over the REAL DeploymentLifecycleRunner (baseline network/), driven by MOCK adapters.
// These tests show routing/refusal behavior only; they do not establish production authority or readiness.
import { DISPATCH_URL } from './helpers/baseline.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, route, binding, good, H, OLD, NEW, CTRL, OTHER } from './helpers/lifecycle-fixture.mjs';
const D = await import(DISPATCH_URL);

const HOST = H('99'), A = H('aa'), B = H('bb');
const blocked = (key) => (e) => e.code === 'LIFECYCLE_ACTIVATION_BLOCKED' && e.missing.some((m) => m.startsWith(key));
const make = (opts = {}, ids = [A]) => {
  const f = fixture({ hostId: HOST, ...opts });
  const d = D.createLifecycleDispatch(f.parts(ids.map((i) => route(i))));
  d.attach(f.hostView(HOST));
  return { f, d };
};
const active = async (opts, ids) => { const x = make(opts, ids); await x.d.activate(); assert.equal(x.d.state()[0].activated, true); return x; };
const settle = () => new Promise((r) => setImmediate(r));

test('every missing safety adapter is an explicit blocker, never a no-op default', () => {
  for (const [key, drop] of [['policy', (p) => delete p.policy], ['verifyQuiescence', (p) => delete p.verifyQuiescence],
    ['journal', (p) => delete p.journal], ['runtime', (p) => delete p.runtime], ['pins', (p) => delete p.pins],
    ['chain.finalize', (p) => { p.chain = { ...p.chain, finalize: undefined }; }],
    ['chain.binding', (p) => { p.chain = { ...p.chain, binding: undefined }; }]]) {
    const p = fixture({ hostId: HOST }).parts([route(A)]); drop(p);
    assert.throws(() => D.createLifecycleDispatch(p), blocked(key), key);
  }
  const f = fixture({ hostId: HOST }), d = D.createLifecycleDispatch(f.parts([route(A)]));
  const view = f.hostView(HOST); delete view.legacyHold;
  assert.throws(() => d.attach(view), blocked('legacyHold'));
});

test('hold mode: a configured route with a missing adapter is owned and HELD; no runner, no evidence, no fallback', async () => {
  const f = fixture({ hostId: HOST }), p = f.parts([route(A)]); delete p.policy;
  const d = D.createLifecycleDispatch({ ...p, onMissing: 'hold' }); d.attach(f.hostView(HOST));
  assert.equal(d.owns(A), true); assert.deepEqual([...d.blocked], ['policy.refusal']);
  await d.activate();
  assert.equal(d.state()[0].activated, false); assert.match(d.state()[0].held, /policy\.refusal/);
  const r = await d.reconcile(A);
  assert.equal(r.status, 'held'); assert.match(r.reason, /adapters missing/);
  assert.equal(f.calls.read.length, 0); assert.equal(f.calls.quiescence.length, 0); assert.equal(f.calls.serve.length, 0);
  assert.ok(f.calls.fence.includes(A)); assert.equal(f.V.records.get(A).status, 'held');
});

test('invalid, duplicate and wrong-ledger routes are refused at construction', () => {
  const bad = [
    [route(A), route(A)],
    [route(A, { newLedger: '0x' + 'e3'.repeat(20) })],
    [route(A, { oldLedger: NEW })],
    [route(A, { controller: '0x' + 'c8'.repeat(20) })],
    [route(A, { deploymentsSchema: 16 })], [route(A, { lifecycleSchema: 1 })], [route(A, { deploymentsSchema: '17' })],
    [route(A, { fallback: 'v1' })], [(() => { const r = route(A); delete r.quiescenceDigest; return r; })()],
    [route(A.toUpperCase().replace('0X', '0x'))], [route(A, { controllerCodeHash: '0x' + '00'.repeat(32) })],
    [route(A, { oldLedger: '0x' + '00'.repeat(20) })], [],
    Array.from({ length: D.MAX_LIFECYCLE_ROUTES + 1 }, (_, i) => route('0x' + i.toString(16).padStart(64, '0'))),
  ];
  for (const routes of bad) assert.throws(() => D.createLifecycleDispatch({ ...fixture({ hostId: HOST }).parts([]), routes }), Error);
  const p = fixture({ hostId: HOST }).parts([route(A)]);
  assert.throws(() => D.createLifecycleDispatch({ ...p, pins: { chainId: 8453, lifecycle: '0x' + 'c8'.repeat(20) } }), /pins/);
  assert.throws(() => D.createLifecycleDispatch({ ...p, chain: { ...p.chain, binding: { ...binding(), deploymentsSchema: 16 } } }), /schema/i);
  assert.throws(() => D.createLifecycleDispatch({ ...p, intervalMs: 30_000 }), /cadence/);
});

test('routes are immutable after construction and the dispatch attaches once', () => {
  const f = fixture({ hostId: HOST }), rs = [route(A)];
  const d = D.createLifecycleDispatch(f.parts(rs));
  rs.push(route(B)); rs[0].deployment = B;
  assert.equal(d.owns(A), true); assert.equal(d.owns(B), false);
  assert.throws(() => { d.routes()[0].deployment = B; }, TypeError);
  assert.throws(() => { d.owns = () => false; }, TypeError);
  d.attach(f.hostView(HOST));
  assert.throws(() => d.attach(f.hostView(HOST)), /already attached/);
});

test('an unactivated route is held: fenced, no chain read, no transaction', async () => {
  const { f, d } = make();
  const r = await d.reconcile(A);
  assert.equal(r.status, 'held'); assert.match(r.reason, /not activated/);
  assert.equal(f.calls.read.length, 0); assert.equal(f.calls.prepare.length, 0); assert.ok(f.calls.fence.length >= 1);
});

test('activation requires proof-qualified evidence binding exactly this route', async () => {
  for (const q of [(r) => ({ ...good(r), digest: H('34') }), (r) => ({ ...good(r), proofVerified: false }),
    (r) => ({ ...good(r), authorityTier: 'safe' }), (r) => ({ ...good(r), ledger: NEW }), (r) => ({ ...good(r), deployment: B }),
    (r) => ({ ...good(r), quiescent: false }), (r) => ({ ...good(r), verified: 'true' }), () => { throw Error('no evidence'); }]) {
    const { f, d } = make(); f.S.quiescence = q;
    await d.activate();
    assert.equal(d.state()[0].activated, false);
    assert.equal((await d.reconcile(A)).status, 'held'); assert.equal(f.calls.read.length, 0);
  }
});

test('a legacy release intent, legacy activity or another legacy ledger keeps the route held; the intent is retained', async () => {
  const { f, d } = make();
  f.V.holds.set(A, 'sponsored release may still land');
  await d.activate(); assert.match(d.state()[0].held, /release intent/); assert.equal(f.calls.quiescence.length, 0);
  assert.equal(f.V.holds.get(A), 'sponsored release may still land');
  f.V.holds.delete(A); f.V.activity.set(A, ['a legacy renewal in flight']);
  await d.activate(); assert.match(d.state()[0].held, /legacy work/);
  f.V.activity.delete(A); f.V.ledger = OTHER;
  await d.activate(); assert.match(d.state()[0].held, /old ledger/);
  f.V.ledger = OLD; f.S.quiescence = (r) => { f.V.ledger = OTHER; return good(r); };   // moves across the evidence await
  await d.activate(); assert.equal(d.state()[0].activated, false);
  f.V.ledger = OLD; f.S.quiescence = good;
  await d.activate(); assert.equal(d.state()[0].activated, true);
});

test('an idle healthy v2 app is served on cadence with no transaction at all', async () => {
  const { f, d } = await active();
  for (let i = 0; i < 25; i++) await d.pass();
  assert.equal(f.calls.serve.length, 25);
  assert.equal(f.calls.prepare.length, 0); assert.equal(f.calls.submit.length, 0);
  assert.equal(f.V.records.get(A).status, 'running'); assert.equal(f.V.records.get(A).lifecycle, true);
});

test('a real transition is submitted once; an unresolved intent is never resubmitted', async () => {
  const { f, d } = await active({ state: 'queued' });
  assert.equal((await d.reconcile(A)).status, 'pending');
  assert.deepEqual(f.calls.prepare.map((p) => p.target), ['running']); assert.equal(f.calls.submit.length, 1);
  for (let i = 0; i < 3; i++) assert.equal((await d.reconcile(A)).status, 'pending');
  assert.equal(f.calls.submit.length, 1); assert.ok(f.calls.resolve.length >= 3);
  assert.equal(f.rows.get(A).pending.digest, H('44'), 'the exact intent stays journaled');
});

test('a snapshot from another ledger or controller is refused and never served', async () => {
  for (const over of [{ ledger: OLD }, { controller: '0x' + 'c8'.repeat(20) }, { id: B }]) {
    const { f, d } = await active();
    f.S.over.set(A, over);
    assert.equal((await d.reconcile(A)).status, 'held');
    assert.equal(f.calls.serve.length, 0); assert.ok(f.calls.fence.includes(A));
  }
});

test('a moved legacy ledger holds an activated route without entering the runner', async () => {
  const { f, d } = await active();
  f.V.ledger = OTHER;
  const r = await d.reconcile(A);
  assert.equal(r.status, 'held'); assert.match(r.reason, /old ledger/); assert.equal(f.calls.read.length, 0);
});

test('a context change across the runner await prevents serving and fences', async () => {
  const { f, d } = await active();
  f.S.onRead = () => { f.V.ledger = OTHER; };
  const r = await d.reconcile(A);
  assert.equal(r.status, 'held'); assert.match(r.reason, /changed during reconcile/);
  assert.equal(f.calls.serve.length, 0); assert.ok(f.calls.fence.length >= 1);
});

test('a restriction arriving mid-reconcile stops locally; only a forced hint clears it', async () => {
  const { f, d } = await active();
  let release; f.S.readGate = new Promise((r) => { release = r; });
  const p = d.reconcile(A); await settle();
  await d.restrict(A, 'the owner of this box turned hosting off');
  release(); f.S.readGate = null;
  assert.equal((await p).status, 'held');
  assert.equal(f.calls.serve.length, 0); assert.equal(f.calls.prepare.length, 0); assert.ok(f.calls.stop.length >= 1);
  assert.equal((await d.reconcile(A)).status, 'held');
  assert.equal(d.considerHint(A).standing, 'lifecycle'); assert.equal((await d.reconcile(A)).status, 'held');
  d.considerHint(A, { force: true });
  assert.equal((await d.reconcile(A)).status, 'running');
});

test('concurrent reconciles and passes join: one runner execution per deployment', async () => {
  const { f, d } = await active();
  let release; f.S.readGate = new Promise((r) => { release = r; });
  const all = Promise.all([d.reconcile(A), d.reconcile(A), d.pass(), d.pass()]);
  await settle(); release(); f.S.readGate = null;
  await all;
  assert.equal(f.calls.read.length, 1); assert.equal(f.calls.serve.length, 1);
});

test('v2 policy: unknown holds without stopping, a refusal stops, a malformed answer holds', async () => {
  const { f, d } = await active();
  f.S.policy = () => { throw Error('quorum unavailable'); };
  assert.equal((await d.reconcile(A)).status, 'held'); assert.equal(f.calls.stop.length, 0); assert.equal(f.calls.read.length, 0);
  f.S.policy = () => 'catalog version yanked';
  assert.equal((await d.reconcile(A)).status, 'held'); assert.equal(f.calls.stop.length, 1);
  f.S.policy = () => ({});
  assert.equal((await d.reconcile(A)).status, 'held'); assert.equal(f.calls.read.length, 0);
  f.S.policy = () => null;
  assert.equal((await d.reconcile(A)).status, 'running');
});

test('platform service refusal stops; a new-work refusal blocks a start but not a running app', async () => {
  const run = await active();
  assert.equal((await run.d.reconcile(A)).status, 'running');
  run.f.V.newWork = 'platform policy outage grace';
  assert.equal((await run.d.reconcile(A)).status, 'running');
  run.f.V.service = 'this host is banned';
  assert.equal((await run.d.reconcile(A)).status, 'held'); assert.ok(run.f.calls.stop.includes(A));
  const q = await active({ state: 'queued' });
  q.f.V.newWork = 'not admitting new work';
  assert.equal((await q.d.reconcile(A)).status, 'held');
  assert.equal(q.f.calls.ensureStaged.length, 0); assert.equal(q.f.calls.prepare.length, 0);
});

test('a claim hint never reconciles or claims a routed id', async () => {
  const { f, d } = await active();
  const r = d.considerHint(A, { force: true });
  assert.equal(r.accepted, false); assert.equal(r.standing, 'lifecycle'); assert.equal(r.claimAttempted, undefined);
  assert.equal(f.calls.read.length, 0);
});

test('start runs its own off-chain cadence on an injected timer', async () => {
  const { f, d } = await active();
  let fn, ms; d.start({ setInterval: (g, m) => { fn = g; ms = m; return { unref() {} }; } });
  assert.equal(ms, 5000);
  await settle(); fn(); await settle(); await settle();
  assert.ok(f.calls.serve.length >= 1); assert.equal(f.calls.submit.length, 0);
  d.stop({ clearInterval() {} });
  assert.equal(CTRL, binding().controller);
});
