// Pending-intent reconciliation under each kind of ACCEPTED online denial (real runner, mock adapters). Companion to the
// dispatch file's case, whose owner switch at an unchanged revision is (correctly) an equivocation -> unknown admission.
import { DISPATCH_URL } from './helpers/baseline.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, route, H, PLATFORM } from './helpers/lifecycle-fixture.mjs';
const D = await import(DISPATCH_URL);
const HOST = H('99'), A = H('aa');

async function pendingStart() {
  const f = fixture({ hostId: HOST, state: 'queued' });
  const d = D.createLifecycleDispatch(f.parts([route(A)])); d.attach(f.hostView(HOST)); await d.activate();
  assert.equal((await d.reconcile(A)).status, 'pending'); assert.equal(f.calls.submit.length, 1);
  return { f, d };
}

for (const [name, deny] of [
  ['an accepted platform-owner refusal (new revision)', (f) => { f.S.owner = PLATFORM; f.S.revision = 2; f.V.service = 'banned'; f.V.newWork = 'banned'; }],
  ['a platform-owner new-work refusal only', (f) => { f.S.owner = PLATFORM; f.S.revision = 2; f.V.newWork = 'not admitting'; }],
  ['the host owner\'s committed refusal', (f) => { f.S.refusal = 'this host owner declines this deployment'; }],
  ['unknown admission', (f) => { f.S.decisionError = 'rpc outage'; }],
  ['a full box', (f) => { f.V.capacity = { paused: false, cpuCap: 0.1, gpuCap: 1, cpuUsed: 0.1, gpuUsed: 0 }; }],
  ['the box owner turning hosting off', (f) => { f.V.owner = 'the owner of this box turned hosting off'; }],
]) {
  test(`a journaled start intent is reconciled read-only under ${name}; never resent, never replaced`, async () => {
    const { f, d } = await pendingStart();
    const resolved = f.calls.resolve.length;
    deny(f);
    for (let i = 0; i < 3; i++) assert.equal((await d.reconcile(A)).status, 'pending');
    assert.equal(f.calls.resolve.length, resolved + 3, 'the exact intent is resolved each pass');
    assert.equal(f.calls.submit.length, 1); assert.equal(f.calls.prepare.length, 1);
    assert.equal(f.rows.get(A).pending.digest, H('44'));
    if (!f.S.decisionError) assert.equal(d.state()[0].hostAuthority?.owner ?? null, f.S.decisionError ? null : f.S.owner);
  });
}
