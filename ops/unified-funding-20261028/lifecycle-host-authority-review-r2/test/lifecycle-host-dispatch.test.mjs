// The per-deployment dispatch over the REAL DeploymentLifecycleRunner (baseline network/), driven by MOCK adapters.
// These tests show routing/refusal behavior only; they do not establish production authority or readiness.
// "CHANGED (r2)" marks an r1 expectation that enshrined the centralized architecture; the comment says what it was.
import { DISPATCH_URL } from './helpers/baseline.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, route, binding, good, H, OLD, NEW, CTRL, OTHER, INDEP, PLATFORM } from './helpers/lifecycle-fixture.mjs';
const D = await import(DISPATCH_URL);

const HOST = H('99'), A = H('aa'), B = H('bb');
const blocked = (key) => (e) => e.code === 'LIFECYCLE_ACTIVATION_BLOCKED' && e.missing.some((m) => m.startsWith(key));
const make = (opts = {}, ids = [A], over = {}) => {
  const f = fixture({ hostId: HOST, ...opts });
  const d = D.createLifecycleDispatch(f.parts(ids.map((i) => route(i)), over));
  d.attach(f.hostView(HOST));
  return { f, d };
};
const active = async (opts, ids, over) => { const x = make(opts, ids, over); await x.d.activate(); assert.equal(x.d.state()[0].activated, true); return x; };
const settle = () => new Promise((r) => setImmediate(r));
const targets = (f) => f.calls.prepare.map((p) => p.target);

test('every missing safety adapter is an explicit blocker, never a no-op default', () => {
  for (const [key, drop] of [['authority', (p) => delete p.authority], ['verifyQuiescence', (p) => delete p.verifyQuiescence],
    ['journal', (p) => delete p.journal], ['runtime', (p) => delete p.runtime], ['pins', (p) => delete p.pins],
    ['platformWallets', (p) => delete p.platformWallets], ['capacityHeadroom', (p) => delete p.capacityHeadroom],
    ['chain.finalize', (p) => { p.chain = { ...p.chain, finalize: undefined }; }],
    ['chain.binding', (p) => { p.chain = { ...p.chain, binding: undefined }; }]]) {
    const p = fixture({ hostId: HOST }).parts([route(A)]); drop(p);
    assert.throws(() => D.createLifecycleDispatch(p), blocked(key), key);
  }
  for (const k of ['legacyHold', 'ownerRestriction', 'platformService', 'capacity']) {
    const f = fixture({ hostId: HOST }), d = D.createLifecycleDispatch(f.parts([route(A)]));
    const view = f.hostView(HOST); delete view[k];
    assert.throws(() => d.attach(view), blocked(k), k);
  }
  const p = fixture({ hostId: HOST }).parts([route(A)]);
  for (const w of [[PLATFORM.toUpperCase().replace('0X', '0x')], [PLATFORM, PLATFORM], ['0x' + '00'.repeat(20)], 'x'])
    assert.throws(() => D.createLifecycleDispatch({ ...p, platformWallets: w }), /platformWallets/);
  assert.throws(() => D.createLifecycleDispatch({ ...p, capacityHeadroom: 0.9 }), /capacityHeadroom/);
});

test('hold mode: a configured route with a missing adapter is owned and HELD; no runner, no evidence, no fallback', async () => {
  const f = fixture({ hostId: HOST }), p = f.parts([route(A)]); delete p.authority;
  const d = D.createLifecycleDispatch({ ...p, onMissing: 'hold' }); d.attach(f.hostView(HOST));
  assert.equal(d.owns(A), true); assert.deepEqual([...d.blocked], ['authority.decision']);
  await d.activate();
  assert.equal(d.state()[0].activated, false); assert.match(d.state()[0].held, /authority\.decision/);
  const r = await d.reconcile(A);
  assert.equal(r.status, 'held'); assert.match(r.reason, /adapters missing/);
  assert.equal(f.calls.read.length, 0); assert.equal(f.calls.quiescence.length, 0); assert.equal(f.calls.serve.length, 0);
  assert.ok(f.calls.fence.includes(A)); assert.equal(f.V.records.get(A).status, 'held');
});

test('invalid, duplicate and wrong-ledger routes are refused at construction', () => {
  const bad = [
    [route(A), route(A)], [route(A, { newLedger: '0x' + 'e3'.repeat(20) })], [route(A, { oldLedger: NEW })],
    [route(A, { controller: '0x' + 'c8'.repeat(20) })], [route(A, { deploymentsSchema: 16 })], [route(A, { lifecycleSchema: 1 })],
    [route(A, { deploymentsSchema: '17' })], [route(A, { fallback: 'v1' })], [(() => { const r = route(A); delete r.quiescenceDigest; return r; })()],
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
  assert.throws(() => { d.platformWallets.push(INDEP); }, TypeError);
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

test('BEFORE handoff: a legacy release intent, legacy activity or another legacy ledger keeps the route held; the intent is retained', async () => {
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
  assert.equal(d.state()[0].activated, true); assert.equal(f.calls.read.length, 0);
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
  assert.deepEqual(targets(f), ['running']); assert.equal(f.calls.submit.length, 1);
  for (let i = 0; i < 3; i++) assert.equal((await d.reconcile(A)).status, 'pending');
  assert.equal(f.calls.submit.length, 1); assert.ok(f.calls.resolve.length >= 3);
  assert.equal(f.rows.get(A).pending.digest, H('44'), 'the exact intent stays journaled');
  assert.deepEqual(f.V.records.get(A).cpuShare, 0.1, 'the start reservation is visible to the host capacity view');
});

test('a snapshot from another ledger or controller is refused and never served', async () => {
  for (const over of [{ ledger: OLD }, { controller: '0x' + 'c8'.repeat(20) }, { id: B }]) {
    const { f, d } = await active();
    f.S.over.set(A, over);
    assert.equal((await d.reconcile(A)).status, 'held');
    assert.equal(f.calls.serve.length, 0); assert.ok(f.calls.fence.includes(A));
  }
});

// CHANGED (r2): r1 asserted "a moved legacy ledger holds an activated route without entering the runner". After a
// finalized handoff the old global address book is not a runtime dependency of the new ledger.
test('AFTER handoff: old address-book ledger changes do not disable the pinned new ledger', async () => {
  const { f, d } = await active();
  for (const ledger of [OTHER, '0x' + '00'.repeat(20), null]) {
    f.V.ledger = ledger;
    assert.equal((await d.reconcile(A)).status, 'running');
  }
  assert.equal(f.calls.serve.length, 3); assert.equal(f.calls.submit.length, 0);
});

test('AFTER handoff: a legacy release hold refuses new starts only; a running app keeps serving', async () => {
  const run = await active();
  run.f.V.holds.set(A, 'unknown v1 intent');
  assert.equal((await run.d.reconcile(A)).status, 'running');
  const q = await active({ state: 'queued' });
  q.f.V.holds.set(A, 'unknown v1 intent');
  assert.equal((await q.d.reconcile(A)).status, 'held');
  assert.equal(q.f.calls.ensureStaged.length, 0); assert.equal(q.f.calls.prepare.length, 0);
  assert.equal(q.f.V.holds.get(A), 'unknown v1 intent', 'never cleared');
});

// CHANGED (r2): r1 moved the legacy ledger during the runner await. That is no longer a refusal after handoff; a
// local owner restriction arriving during the read is the remaining context change, and it must not serve.
test('a local restriction across the runner await prevents serving and records a revocation', async () => {
  const { f, d } = await active();
  f.S.onRead = () => { f.S.onRead = null; void d.restrict(A, 'the owner of this box turned hosting off'); };
  const r = await d.reconcile(A);
  assert.equal(r.status, 'held'); assert.match(r.reason, /changed during reconcile/);
  assert.equal(f.calls.serve.length, 0); assert.deepEqual(targets(f), ['queued']); assert.equal(f.calls.submit.length, 1);
});

// CHANGED (r2): r1 ended "only a forced hint clears it -> running". The owner stop is now recorded on the ledger, so the
// journaled revocation is retained (no resend, no invented cancellation) after the hint clears the local hold.
test('a restriction arriving mid-reconcile stops at once; the runner records the stop; a forced hint clears only the local hold', async () => {
  const { f, d } = await active();
  let release; f.S.readGate = new Promise((r) => { release = r; });
  const p = d.reconcile(A); await settle();
  const local = await d.restrict(A, 'the owner of this box turned hosting off');
  assert.equal(local.status, 'held'); assert.ok(f.calls.stop.length >= 1, 'fenced and stopped immediately, before any chain answer');
  release(); f.S.readGate = null;
  await p; await settle(); await d.reconcile(A);
  assert.equal(f.calls.serve.length, 0); assert.deepEqual(targets(f), ['queued']); assert.equal(f.calls.submit.length, 1);
  assert.equal(d.considerHint(A).standing, 'lifecycle');
  d.considerHint(A, { force: true });
  assert.equal((await d.reconcile(A)).status, 'pending');
  assert.equal(f.calls.submit.length, 1); assert.equal(f.rows.get(A).pending.target, 'queued');
});

test('concurrent reconciles and passes join: one runner execution per deployment', async () => {
  const { f, d } = await active();
  let release; f.S.readGate = new Promise((r) => { release = r; });
  const all = Promise.all([d.reconcile(A), d.reconcile(A), d.pass(), d.pass()]);
  await settle(); release(); f.S.readGate = null;
  await all;
  assert.equal(f.calls.read.length, 1); assert.equal(f.calls.serve.length, 1);
});

// CHANGED (r2): r1 held BEFORE the runner on unknown policy (read 0), which also blocked pending reconciliation. Unknown
// now refuses serving at the effect (fence, no stop) while the runner still reads; a refusal records a revocation.
test('host admission: unknown fences without stopping, a refusal stops and queues, a malformed answer is unknown', async () => {
  const { f, d } = await active();
  f.S.decisionError = 'quorum unavailable';
  assert.equal((await d.reconcile(A)).status, 'held'); assert.equal(f.calls.stop.length, 0); assert.equal(f.calls.serve.length, 0);
  assert.equal(f.calls.read.length, 1, 'the runner still read authenticated state');
  f.S.decisionError = null; f.S.decision = () => ({});
  assert.equal((await d.reconcile(A)).status, 'held'); assert.equal(f.calls.stop.length, 0); assert.equal(f.calls.serve.length, 0);
  f.S.decision = null; f.S.refusal = 'this host owner declines this deployment';
  assert.equal((await d.reconcile(A)).status, 'pending'); assert.equal(f.calls.stop.length, 1);
  assert.deepEqual(targets(f), ['queued']); assert.equal(f.calls.submit.length, 1);
});

// CHANGED (r2): r1 asserted "platform service refusal stops". That is now true only on a platform-owned host.
test('independent host: a platform ban or outage is not a veto; platform-owned host: it is the owner\'s legitimate stop', async () => {
  const ind = await active();
  ind.f.V.service = 'platform host policy: this host is banned'; ind.f.V.newWork = 'platform host policy: banned';
  for (let i = 0; i < 5; i++) assert.equal((await ind.d.reconcile(A)).status, 'running');
  assert.equal(ind.f.calls.stop.length, 0); assert.equal(ind.f.calls.submit.length, 0);
  assert.equal(ind.d.ingressRefusal(A), null);
  assert.equal(ind.d.state()[0].hostAuthority.platformOwned, false);
  const own = await active(); own.f.S.owner = PLATFORM;
  own.f.V.service = 'platform host policy: this host is banned';
  assert.equal((await own.d.reconcile(A)).status, 'pending');
  assert.ok(own.f.calls.stop.includes(A)); assert.deepEqual(targets(own.f), ['queued']);
  assert.match(own.d.ingressRefusal(A), /not serving|banned/);
});

test('new-work refusal on a platform-owned host blocks a start, never a running app; an independent host starts', async () => {
  const run = await active(); run.f.S.owner = PLATFORM; run.f.V.newWork = 'not admitting new work';
  assert.equal((await run.d.reconcile(A)).status, 'running');
  const q = await active({ state: 'queued' }); q.f.S.owner = PLATFORM; q.f.V.newWork = 'not admitting new work';
  assert.equal((await q.d.reconcile(A)).status, 'held');
  assert.equal(q.f.calls.ensureStaged.length, 0); assert.equal(q.f.calls.prepare.length, 0);
  const ind = await active({ state: 'queued' }); ind.f.V.newWork = 'not admitting new work';
  assert.equal((await ind.d.reconcile(A)).status, 'pending'); assert.deepEqual(targets(ind.f), ['running']);
});

test('a pending intent is reconciled read-only under new-work denial, platform refusal or unknown admission; never resent', async () => {
  const { f, d } = await active({ state: 'queued' });
  assert.equal((await d.reconcile(A)).status, 'pending'); assert.equal(f.calls.submit.length, 1);
  const r0 = f.calls.resolve.length;
  f.S.owner = PLATFORM; f.V.newWork = 'not admitting'; f.V.service = 'banned';
  assert.equal((await d.reconcile(A)).status, 'pending');
  f.S.decisionError = 'rpc outage';
  assert.equal((await d.reconcile(A)).status, 'pending');
  assert.equal(f.calls.resolve.length, r0 + 2); assert.equal(f.calls.submit.length, 1); assert.equal(f.calls.prepare.length, 1);
});

test('restart: a fresh dispatch (no in-memory status) serves an authenticated running app despite new-work refusal', async () => {
  const f = fixture({ hostId: HOST }); f.S.owner = PLATFORM; f.V.newWork = 'not admitting new work';
  for (let boot = 0; boot < 2; boot++) {
    const d = D.createLifecycleDispatch(f.parts([route(A)])); d.attach(f.hostView(HOST)); await d.activate();
    assert.equal((await d.reconcile(A)).status, 'running', `boot ${boot}`);
  }
  assert.equal(f.calls.serve.length, 2); assert.equal(f.calls.submit.length, 0);
});

test('a local owner stop is never blocked by online denial; a chain outage defers only the ledger record', async () => {
  const { f, d } = await active();
  f.S.decisionError = 'rpc outage'; f.V.newWork = 'not admitting'; f.V.capacity = { paused: true };
  f.S.onRead = () => { throw Error('every RPC down'); };
  await d.restrict(A, 'the owner of this box turned hosting off');
  assert.ok(f.calls.stop.includes(A), 'stopped locally at once'); await settle(); await d.reconcile(A);
  assert.equal(f.calls.submit.length, 0, 'no ledger record without an authenticated read');
  f.S.onRead = null;
  await d.reconcile(A);
  assert.deepEqual(targets(f), ['queued']); assert.equal(f.calls.submit.length, 1);
  await d.reconcile(A); assert.equal(f.calls.submit.length, 1);
});

test('host authority replay, equivocation and foreign bindings are unknown, never allow', async () => {
  const { f, d } = await active();
  f.S.revision = 5; assert.equal((await d.reconcile(A)).status, 'running');
  f.S.revision = 4; assert.equal((await d.reconcile(A)).status, 'held');
  f.S.revision = 5; f.S.owner = '0x' + '2d'.repeat(20); assert.equal((await d.reconcile(A)).status, 'held');
  f.S.owner = INDEP;
  for (const over of [{ hostId: H('98') }, { deployment: B }, { validUntil: Date.now() - 1 }, { owner: 'nope' }, { revision: 5 }, { extra: 1 }]) {
    f.S.decision = (id) => ({ hostId: HOST, deployment: id, owner: INDEP, revision: '5', policyHash: H('55'), refusal: null, validUntil: Date.now() + 60_000, ...over });
    assert.equal((await d.reconcile(A)).status, 'held', JSON.stringify(over));
  }
  assert.equal(f.calls.serve.length, 1); assert.equal(f.calls.stop.length, 0);
});

test('ownership transfer: to a platform wallet the platform policy applies; away from it, it stops applying', async () => {
  const q = await active({ state: 'queued' }); q.f.V.service = 'banned'; q.f.V.newWork = 'banned';
  q.f.S.owner = PLATFORM; q.f.S.revision = 1;
  assert.equal((await q.d.reconcile(A)).status, 'queued'); assert.equal(q.f.calls.ensureStaged.length, 0);
  q.f.S.owner = INDEP; q.f.S.revision = 2;
  assert.equal((await q.d.reconcile(A)).status, 'pending'); assert.deepEqual(targets(q.f), ['running']);
  const r = await active(); r.f.V.service = 'banned';
  assert.equal((await r.d.reconcile(A)).status, 'running');
  r.f.S.owner = PLATFORM; r.f.S.revision = 2;
  assert.equal((await r.d.reconcile(A)).status, 'pending'); assert.deepEqual(targets(r.f), ['queued']);
});

test('capacity: unknown shares, a full box, the headroom or hosting off refuse a start; allocations count', async () => {
  for (const [why, set] of [['shares', (f) => f.S.over.set(A, { resources: undefined })],
    ['full', (f) => { f.V.capacity = { paused: false, cpuCap: 1, gpuCap: 1, cpuUsed: 0.9, gpuUsed: 0 }; }],
    ['headroom', (f) => { f.V.capacity = { paused: false, cpuCap: 0.5, gpuCap: 1, cpuUsed: 0.36, gpuUsed: 0 }; }],
    ['paused', (f) => { f.V.capacity = { paused: true, cpuCap: 1, gpuCap: 1, cpuUsed: 0, gpuUsed: 0 }; }],
    ['malformed', (f) => { f.V.capacity = { paused: false }; }]]) {
    const { f, d } = await active({ state: 'queued' }); set(f);
    assert.equal((await d.reconcile(A)).status, 'held', why);
    assert.equal(f.calls.ensureStaged.length, 0, why); assert.equal(f.calls.prepare.length, 0, why);
  }
  const ok = await active({ state: 'queued' }); ok.f.V.capacity = { paused: false, cpuCap: 0.5, gpuCap: 1, cpuUsed: 0.34, gpuUsed: 0 };
  assert.equal((await ok.d.reconcile(A)).status, 'pending');
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
