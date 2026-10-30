// r3 capacity through the GENERATED host candidate (baseline host.mjs + this task's insertions) and its REAL
// Host.shareUse / occupies / cpuShareFree / capRefusal / enforceOff, the real dispatch and the root-fixed runner.
// Lifecycle chain/runtime/inventory/journal are MOCKS (helpers/lifecycle-fixture.mjs); the box uses the baseline's fake
// Base RPC. Not production capacity, isolation or attestation evidence.
import { CANDIDATE_HOST_URL } from './helpers/baseline.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, route, H } from './helpers/lifecycle-fixture.mjs';
const { Host, D, HOSTID, A, C, box, serve, settle } = await import(CANDIDATE_HOST_URL);

const B = H('bb');
const near = (x, y) => Math.abs(x - y) < 1e-9;
async function hosted(f, ids, { caps = null } = {}) {
  const d = D.createLifecycleDispatch(f.parts(ids.map((i) => route(i))));
  const { h } = await box(Host, d); serve(h);
  if (caps) h.caps = { ...h.caps, ...caps };
  await d.activate(); assert.ok(d.state().every((r) => r.activated));
  return { d, h };
}

test('restart: Host.shareUse counts recovered allocations; legacy and lifecycle new work wait until they are known', async () => {
  const f = fixture({ hostId: HOSTID }); f.S.state.set(B, 'queued');
  f.S.inventoryError = (id) => (id === A ? 'manager restarted; a recovered VM names no deployment' : null);
  const one = await hosted(f, [A, B]);
  assert.equal(one.h.shareUse().cpu, 0);
  assert.ok(one.d.capacityUnresolved());
  assert.equal(one.h.cpuShareFree(), 0, 'the box offers nothing new while a recovered allocation is unknown');
  assert.match(one.h.capRefusal(C, { cpuShare: 0.1 }), /not started: lifecycle capacity recovery unresolved/);
  const [ra, rb] = await one.d.pass();
  assert.equal(ra.status, 'running'); assert.equal(rb.status, 'held'); assert.equal(f.calls.ensureStaged.length, 0);
  f.S.inventoryError = null;
  await one.d.pass();
  assert.deepEqual(f.calls.ensureStaged, [B]); assert.equal(f.calls.submit.length, 1);
  assert.ok(near(one.h.shareUse().cpu, 0.2), `two allocations of 0.1 (got ${one.h.shareUse().cpu})`);
  assert.equal(one.h.capRefusal(C, { cpuShare: 0.1 }), null);
  assert.ok(one.h.cpuShareFree() > 0);
  // a fresh host process and dispatch: no in-process reservation, records start empty
  const two = await hosted(f, [A, B]);
  assert.equal(two.h.shareUse().cpu, 0); assert.equal(two.h.cpuShareFree(), 0);
  await two.d.pass();
  assert.ok(near(two.h.shareUse().cpu, 0.2), 'recovered: A from its listed VM + authenticated shares, B from its journaled running intent');
  assert.equal(f.calls.submit.length, 1, 'the pending intent is reconciled, never resent');
  assert.equal(two.d.capacityUnresolved(), null);
});

test('simultaneous starts in one Promise.all pass cannot over-admit the real host caps', async () => {
  const f = fixture({ hostId: HOSTID, state: 'queued' });
  const { d, h } = await hosted(f, [A, B], { caps: { cpuShare: 0.2, gpuShare: 1, paused: false } });
  const r = await d.pass();
  assert.equal(f.calls.ensureStaged.length, 1, 'one start fits beside the headroom, two do not');
  assert.deepEqual(r.map((x) => x.status).sort(), ['held', 'pending']);
  assert.ok(near(h.shareUse().cpu, 0.1));
});

test('fenced uncertainty and failed removal stay in Host.shareUse; only a confirmed stop releases (real enforceOff)', async () => {
  const f = fixture({ hostId: HOSTID });
  const { d, h } = await hosted(f, [A]);
  assert.equal((await d.reconcile(A)).status, 'running'); assert.ok(near(h.shareUse().cpu, 0.1));
  f.S.onRead = () => { throw Error('every RPC down'); };
  assert.equal((await d.reconcile(A)).status, 'held');
  assert.ok(near(h.shareUse().cpu, 0.1), 'a fence or unknown chain frees nothing'); assert.equal(Host.occupies(h.records.get(A)), true);
  f.S.onRead = null; f.S.stopResult = false; h.caps.paused = true;
  assert.deepEqual(await h.enforceOff(), [A]);
  await settle();
  assert.ok(near(h.shareUse().cpu, 0.1), 'a removal the manager did not confirm keeps the allocation');
  f.S.stopResult = true;
  assert.deepEqual(await h.enforceOff(), [A], 'still occupying: hosting-off retries the stop');
  await settle();
  assert.equal(h.shareUse().cpu, 0); assert.equal(Host.occupies(h.records.get(A)), false);
  assert.deepEqual(f.calls.prepare.map((p) => p.target), ['queued'], 'the owner stop is recorded once');
});
