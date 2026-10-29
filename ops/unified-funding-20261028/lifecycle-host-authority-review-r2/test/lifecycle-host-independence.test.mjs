// The GENERATED host candidate with the platform host policy ON (a gate with createHostServiceGate's interface whose
// answers the test sets: ban, outage). Separate process from lifecycle-host-candidate.test.mjs because a non-off gate
// also installs chain.setLeaseRelayPolicy for this process. Lifecycle adapters are MOCKS; no production qualification.
import { Host, D, HOSTID, A, C, settle, quiet, box, serve, ingress, platformGate } from './helpers/candidate-host.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, route, INDEP, PLATFORM } from './helpers/lifecycle-fixture.mjs';

const BAN = 'platform host policy: this host is banned';
async function hosted({ state = 'running', owner = INDEP, P = { service: BAN, newWork: BAN }, f = fixture({ hostId: HOSTID, state }) } = {}) {
  f.S.owner = owner;
  const d = D.createLifecycleDispatch(f.parts([route(A)]));
  const { h } = await box(Host, d, { platformPolicy: platformGate(P) }); serve(h);
  await d.activate(); assert.equal(d.state()[0].activated, true);
  return { f, d, h, P };
}

test('independently owned host: serves the routed app through a platform ban and outage; the legacy app is still refused', async () => {
  const { f, d, h, P } = await hosted();
  for (let i = 0; i < 5; i++) assert.equal((await d.reconcile(A)).status, 'running');
  const g = await ingress(h, A);
  assert.equal(g.platformRefused, false, 'no platform veto on the routed app\'s ingress'); assert.equal(g.lifecycleRefused, false);
  const legacy = await ingress(h, C);
  assert.equal(legacy.status, 403); assert.equal(legacy.platformRefused, true, 'untouched legacy apps are NOT made independent');
  quiet(h, ['enforceOff']); await h.tick(); await h.tick();
  P.service = 'platform host policy: no authenticated admit within the grace (outage)';
  assert.equal((await d.reconcile(A)).status, 'running');
  assert.equal(f.calls.stop.length, 0); assert.equal(f.calls.submit.length, 0); assert.equal(f.calls.serve.length, 6);
});

test('independently owned host: a queued routed app starts despite the platform new-work refusal', async () => {
  const { f, d } = await hosted({ state: 'queued' });
  assert.equal((await d.reconcile(A)).status, 'pending');
  assert.deepEqual(f.calls.prepare.map((p) => p.target), ['running']); assert.equal(f.calls.submit.length, 1);
});

test('host owned by a pinned platform wallet: the ban is the owner\'s legitimate stop (local fence + ledger revocation)', async () => {
  const { f, d, h } = await hosted({ owner: PLATFORM });
  assert.equal((await d.reconcile(A)).status, 'pending');
  assert.ok(f.calls.stop.includes(A)); assert.deepEqual(f.calls.prepare.map((p) => p.target), ['queued']);
  assert.equal((await ingress(h, A)).lifecycleRefused, true);
  await d.reconcile(A); assert.equal(f.calls.submit.length, 1, 'never resent');
});

test('ownership transfer to the platform wallet makes its ban apply; a replayed older revision cannot undo it', async () => {
  const { f, d, h } = await hosted();
  assert.equal((await d.reconcile(A)).status, 'running');
  f.S.owner = PLATFORM; f.S.revision = 2;
  assert.equal((await d.reconcile(A)).status, 'pending'); assert.deepEqual(f.calls.prepare.map((p) => p.target), ['queued']);
  f.S.owner = INDEP; f.S.revision = 1;
  assert.equal((await d.reconcile(A)).status, 'pending');
  assert.equal(d.state()[0].hostAuthority, null, 'the replayed revision is not accepted');
  assert.equal((await ingress(h, A)).lifecycleRefused, true);
  assert.equal(f.calls.submit.length, 1);
});

test('restart on a platform-owned host under new-work refusal: authenticated running state is served by each fresh host', async () => {
  const f = fixture({ hostId: HOSTID });
  for (let boot = 0; boot < 2; boot++) {
    const { d, h } = await hosted({ owner: PLATFORM, P: { service: null, newWork: 'not admitting new work' }, f });
    assert.equal((await d.reconcile(A)).status, 'running', `boot ${boot}`);
    assert.equal((await ingress(h, A)).lifecycleRefused, false);
  }
  assert.equal(f.calls.serve.length, 2); assert.equal(f.calls.submit.length, 0);
});

test('the box owner\'s own control still stops an independently hosted app (not a platform veto)', async () => {
  const { f, d, h } = await hosted();
  assert.equal((await d.reconcile(A)).status, 'running');
  h.caps.paused = true;
  assert.deepEqual(await h.enforceOff(), [A]);
  await settle(); await d.reconcile(A);
  assert.ok(f.calls.stop.includes(A)); assert.deepEqual(f.calls.prepare.map((p) => p.target), ['queued']);
});
