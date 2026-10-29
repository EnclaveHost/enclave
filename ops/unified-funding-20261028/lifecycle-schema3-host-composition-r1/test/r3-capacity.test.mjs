// r3 capacity recovery through the REAL dispatch + REAL (root-fixed) runner, MOCK chain/runtime/inventory/journal.
// Shows the allocation rules only (what frees, what retains, what blocks new starts). The generated real Host's
// Host.shareUse/occupies path is r3-capacity-host.test.mjs. No production capacity or attestation claim.
import { DISPATCH_URL } from './helpers/baseline.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, route, H } from './helpers/lifecycle-fixture.mjs';
const D = await import(DISPATCH_URL);

const HOST = H('99'), A = H('aa'), B = H('bb');
const settle = () => new Promise((r) => setImmediate(r));
async function setup({ ids = [A], state = 'running', f = fixture({ hostId: HOST, state }), view = null } = {}) {
  const d = D.createLifecycleDispatch(f.parts(ids.map((i) => route(i))));
  d.attach(view ? view(f) : f.hostView(HOST)); await d.activate();
  assert.ok(d.state().every((r) => r.activated));
  return { f, d };
}
const alloc = (d, id) => d.state().find((r) => r.id === id).allocation;
const rec = (f, id) => f.V.records.get(id);
// a capacity view that sums the dispatch's own allocations from the host records (as Host.shareUse does)
const summed = (cap) => (f) => ({ ...f.hostView(HOST), capacity: (id) => {
  let cpu = 0; for (const [k, r] of f.V.records) if (k !== id && r.lifecycleAllocated === true) cpu += r.cpuShare || 0;
  return { paused: false, cpuCap: cap, gpuCap: 1, cpuUsed: cpu, gpuUsed: 0 }; } });

test('attach: every route starts unresolved and new work is held until its allocation is observed', async () => {
  const f = fixture({ hostId: HOST });
  const d = D.createLifecycleDispatch(f.parts([route(A)])); d.attach(f.hostView(HOST));
  assert.equal(alloc(d, A).state, 'unresolved'); assert.match(d.capacityUnresolved(), /recovery unresolved for 1 route/);
  assert.equal(rec(f, A).lifecycleAllocated, true, 'an unknown allocation occupies the box');
  await d.activate(); await d.reconcile(A);
  assert.equal(alloc(d, A).state, 'committed'); assert.equal(d.capacityUnresolved(), null);
  assert.equal(rec(f, A).cpuShare, 0.1);
});

test('recovered running allocation is retained through unknown chain, unknown admission and unknown inventory', async () => {
  const { f, d } = await setup();
  assert.equal((await d.reconcile(A)).status, 'running'); assert.equal(rec(f, A).cpuShare, 0.1);
  f.S.onRead = () => { throw Error('every RPC down'); };
  assert.equal((await d.reconcile(A)).status, 'held');
  assert.deepEqual([alloc(d, A).state, rec(f, A).cpuShare, rec(f, A).lifecycleAllocated], ['committed', 0.1, true], 'a fence never frees');
  f.S.onRead = null; f.S.decisionError = 'quorum unavailable';
  assert.equal((await d.reconcile(A)).status, 'held'); assert.equal(rec(f, A).cpuShare, 0.1);
  f.S.decisionError = null; f.S.inventoryError = 'manager 503';
  assert.equal((await d.reconcile(A)).status, 'running', 'runtime health/serving continues while the inventory is unknown');
  assert.equal(alloc(d, A).state, 'committed'); assert.equal(rec(f, A).cpuShare, 0.1);
  assert.equal(f.calls.stop.length, 0);
});

test('failed or timed-out removal keeps the allocation; only a confirmed stop releases it', async () => {
  const { f, d } = await setup();
  await d.reconcile(A);
  f.S.stopResult = false;
  assert.match((await d.restrict(A, 'the owner of this box turned hosting off')).reason, /stop not confirmed/);
  await settle(); await settle();
  assert.deepEqual([alloc(d, A).state, rec(f, A).cpuShare], ['committed', 0.1], 'a VM that may still run stays counted');
  f.S.stopResult = undefined; f.S.stopError = 'DELETE /vms timed out';
  assert.match((await d.restrict(A, 'still off')).reason, /withdrawal failed|timed out/);
  await settle(); await settle();
  assert.deepEqual([alloc(d, A).state, rec(f, A).cpuShare], ['committed', 0.1]);
  f.S.stopError = null; f.S.stopResult = true;
  await d.restrict(A, 'still off'); await settle(); await settle(); await d.reconcile(A);
  assert.equal(f.rows.get(A).pending?.target, 'queued', 'the owner stop is recorded as a revocation');
  assert.deepEqual([alloc(d, A).state, rec(f, A).cpuShare, rec(f, A).lifecycleAllocated], ['none', 0, false], 'confirmed retirement + a revocation intent: released');
});

test('a pending running intent and an ambiguous launch are commitments; a fresh process recovers them before new starts', async () => {
  const f = fixture({ hostId: HOST, state: 'queued' });
  const one = await setup({ f });
  f.S.staged = { ready: false, ended: false, reason: 'launch outcome unknown' };
  assert.equal((await one.d.reconcile(A)).reason, 'starting without a serving permit');
  f.S.views.set(A, null);   // the manager does not list it (yet): an ambiguous POST may still create it
  await one.d.reconcile(A);
  assert.deepEqual([alloc(one.d, A).state, alloc(one.d, A).reserved, rec(f, A).cpuShare], ['committed', true, 0.1], 'unsent? unknown: the reservation stays');
  f.S.views.delete(A); f.S.staged = { ready: true };
  assert.equal((await one.d.reconcile(A)).status, 'pending'); assert.equal(f.calls.submit.length, 1);
  // restart: no in-process reservation; the journaled running intent and the listed VM are the evidence
  f.V.records.clear(); f.S.state.set(B, 'queued');
  const two = await setup({ f, ids: [A, B] });
  assert.equal(alloc(two.d, A).state, 'unresolved');
  await two.d.pass();
  assert.deepEqual([alloc(two.d, A).state, alloc(two.d, A).commitment, rec(f, A).cpuShare], ['committed', true, 0.1]);
  assert.equal(f.calls.submit.length, 2, 'A never resent; B started once the recovered allocation was known');
});

test('an unresolved route blocks every other route\'s NEW start; its own serving continues', async () => {
  const f = fixture({ hostId: HOST }); f.S.state.set(B, 'queued');
  f.S.inventoryError = (id) => (id === A ? 'no domain is named A, but 1 VM names no deployment' : null);
  const { d } = await setup({ f, ids: [A, B] });
  const [ra, rb] = await d.pass();
  assert.equal(ra.status, 'running', 'health and serving of the recovered app are not held');
  assert.equal(rb.status, 'held'); assert.match(rb.reason, /capacity recovery unresolved for 1 other lifecycle route/);
  assert.equal(f.calls.ensureStaged.length, 0); assert.equal(f.calls.prepare.length, 0);
  assert.match(d.capacityUnresolved(), /names no deployment|unresolved/);
  f.S.inventoryError = null;
  await d.pass();
  assert.equal(alloc(d, A).state, 'committed'); assert.deepEqual(f.calls.ensureStaged, [B]);
});

test('simultaneous starts in one Promise.all pass see each other\'s reservations', async () => {
  const f = fixture({ hostId: HOST, state: 'queued' });
  const { d } = await setup({ f, ids: [A, B], view: summed(0.2) });   // 0.1 + 0.05 headroom fits once, not twice
  const r = await d.pass();
  assert.equal(f.calls.ensureStaged.length, 1, 'exactly one start took the room');
  assert.deepEqual(r.map((x) => x.status).sort(), ['held', 'pending']);
  const refused = r.find((x) => x.status === 'held');
  assert.match(refused.reason, /capacity: CPU 0.1/);
});

test('an unobserved runtime of a held (not yet activated) route still counts', async () => {
  const f = fixture({ hostId: HOST }); f.S.quiescence = () => { throw Error('no finalized evidence yet'); };
  const d = D.createLifecycleDispatch(f.parts([route(A)])); d.attach(f.hostView(HOST)); await d.activate();
  assert.equal(d.state()[0].activated, false);
  await d.reconcile(A);   // inventory only: a VM named A is listed, no chain read
  assert.equal(f.calls.read.length, 0); assert.equal(alloc(d, A).state, 'unresolved', 'listed, shares unknown: blocks new work');
  assert.ok(d.capacityUnresolved());
  f.S.retiredVms.add(A);  // the manager confirms nothing named A exists
  await d.reconcile(A);
  assert.equal(alloc(d, A).state, 'none'); assert.equal(d.capacityUnresolved(), null);
});
