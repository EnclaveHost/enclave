// The GENERATED host candidate (baseline windows/node/host.mjs + the pinned insertions), against the baseline's fake Base
// RPC and the REAL baseline chain.mjs, compared with the unmodified baseline Host. Lifecycle adapters are MOCKS: these
// tests show which host paths a routed id can and cannot reach, not production authority or readiness.
import { rpc, chain, Host, BaselineHost, D, HOSTID, A, C, settle, quiet, row, box, serve, ingress } from './helpers/candidate-host.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, route, OLD } from './helpers/lifecycle-fixture.mjs';

async function legacyScenario(Cls) {
  const b = await box(Cls); quiet(b.h, ['scanLedger']); serve(b.h); rpc.chainTx.mine = false;
  b.h.tracked.add(C);
  await b.h.scanLedger();   // A: held by this box on chain but untracked -> the legacy scan re-tracks it
  const calls0 = rpc.calls.length;
  await b.h.consider(A).catch(() => {});
  const hintRpc = rpc.calls.length > calls0;
  await b.h.tick();
  return { lifecycle: b.h.lifecycle ?? null, trackedA: b.h.tracked.has(A), hintRpc, policy: [...b.policyLog].sort(),
    ensureApp: [...b.spies.ensureApp].sort(), readiness: b.h.leaseReadiness().deployments.map((r) => `${r.id}:${r.status}`).sort() };
}

test('zero routes: the candidate host behaves exactly like the baseline host', async () => {
  const base = await legacyScenario(BaselineHost), cand = await legacyScenario(Host);
  assert.equal(base.trackedA, true, 'precondition: the legacy scan re-tracks a lease this box holds');
  assert.equal(base.hintRpc, true, 'precondition: a legacy consider reads the ledger');
  assert.deepEqual(cand, base);
});

const builders = {
  'configured but not activated': () => { const f = fixture({ hostId: HOSTID }); return { f, d: D.createLifecycleDispatch(f.parts([route(A)])) }; },
  'adapters missing (hold mode)': () => { const f = fixture({ hostId: HOSTID }), p = f.parts([route(A)]); delete p.authority; delete p.verifyQuiescence;
    return { f, d: D.createLifecycleDispatch({ ...p, onMissing: 'hold' }) }; },
};
for (const [mode, build] of Object.entries(builders)) {
  test(`routed app (${mode}) never reaches a legacy claim/renew/release/prove/restart path; the unrelated app does`, async () => {
    const { f, d } = build();
    const b = await box(Host, d), h = b.h; quiet(h, ['scanLedger']); serve(h); rpc.chainTx.mine = true;
    assert.equal(h.records.get(A).status, 'held'); assert.equal(h.records.get(A).lifecycle, true);
    h.tracked.add(A); h.tracked.add(C);
    const sent0 = rpc.chainTx.sent.length, calls0 = rpc.calls.length;
    for (const force of [false, true]) {
      const r = await h.consider(A, { force });
      assert.equal(r.accepted, false); assert.equal(r.standing, 'lifecycle'); assert.equal(r.claimAttempted, undefined);
    }
    assert.match((await h.restart(A, row(A, h))).reason, /lifecycle route/);
    const rr = await h.restartRequest(A, { authorization: 'Bearer x' }, { read: async () => { throw Error('a routed restart must not read v1'); } });
    assert.equal(rr.status, 409);
    await assert.rejects(h.runUnleased({ id: A }), /lifecycle route/);
    assert.equal((await ingress(h, A)).lifecycleRefused, true, 'an unactivated route is not served');
    assert.equal(rpc.calls.length, calls0, 'no RPC at all for the routed entry points');
    await h.tick(); await h.tick();
    assert.ok(!b.policyLog.includes(A), 'no legacy wallet/policy pass for the routed id');
    assert.ok(b.policyLog.length >= 1, 'the unrelated legacy app is still reconciled');
    assert.ok(!b.spies.ensureApp.includes(A)); assert.deepEqual(b.spies.consider.filter((x) => x === A), [A, A], 'only the two direct hints');
    assert.equal(h.leaseReadiness().deployments.find((r) => r.id === A).status, 'lifecycle');
    const renewed = await h.renewDue();
    assert.ok(![...renewed.renewed, ...renewed.failed, ...renewed.skipped].includes(A));
    const legacyServing = { status: 'running', leaseUntil: Math.floor(Date.now() / 1000) + 3600, rate6: '1', isolation: { instance: 'vm' }, servingSeenAt: Date.now() };
    h.records.set(A, { ...h.records.get(A), ...legacyServing }); h.records.set(C, { id: C, ...legacyServing });
    await h.proveAll();
    assert.deepEqual(b.checkpoints, [C], 'a v1 checkpoint covers the legacy app only');
    h.tracked.delete(A); await h.scanLedger();
    assert.equal(h.tracked.has(A), false, 'the legacy scan does not re-adopt a routed lease');
    assert.equal(rpc.chainTx.sent.length, sent0, 'no legacy transaction');
    assert.equal(f.calls.read.length, 0); assert.equal(f.calls.submit.length, 0);
    assert.equal((await d.reconcile(A)).status, 'held');
  });
}

test('activated route: v2 cadence, legacy tick, keeper and hints run concurrently with one runner execution and no transaction', async () => {
  const f = fixture({ hostId: HOSTID }), d = D.createLifecycleDispatch(f.parts([route(A)]));
  const b = await box(Host, d), h = b.h; quiet(h, ['scanLedger']); serve(h); rpc.chainTx.mine = true;
  h.tracked.add(A); h.tracked.add(C);
  await d.activate();
  assert.equal(d.state()[0].activated, true, 'activation uses the real host callbacks: old ledger, release journal, idle legacy state');
  const sent0 = rpc.chainTx.sent.length;
  let release; f.S.readGate = new Promise((r) => { release = r; });
  const all = Promise.all([d.pass(), d.reconcile(A), h.tick(), h.renewDue(), h.consider(A), h.tick(), d.pass()]);
  await settle(); release(); f.S.readGate = null;
  await all;
  assert.equal(f.calls.read.length, 1); assert.equal(f.calls.serve.length, 1);
  assert.ok(!b.policyLog.includes(A)); assert.ok(b.policyLog.length >= 1);
  assert.equal(h.records.get(A).status, 'running'); assert.equal(h.records.get(A).lifecycle, true);
  for (let i = 0; i < 10; i++) await d.pass();
  assert.equal(f.calls.serve.length, 11);
  assert.equal(f.calls.prepare.length, 0); assert.equal(f.calls.submit.length, 0);
  assert.equal(rpc.chainTx.sent.length, sent0);
});

// CHANGED (r2): r1 asserted "stops ... without a transaction" and "running again" after unpausing. The owner's stop is
// now recorded through the runner/chain adapter as ONE queue revocation (mock chain; no legacy transaction); after
// unpausing the journaled intent is reconciled, never resent or silently dropped.
test('the owner turning hosting off: the real enforceOff -> #giveUp path stops at once, then the runner records the stop', async () => {
  const f = fixture({ hostId: HOSTID }), d = D.createLifecycleDispatch(f.parts([route(A)]));
  const { h } = await box(Host, d); serve(h);
  await d.activate();
  assert.equal((await d.reconcile(A)).status, 'running'); assert.equal(h.records.get(A).status, 'running');
  const sent0 = rpc.chainTx.sent.length;
  h.caps.paused = true;
  assert.deepEqual(await h.enforceOff(), [A], 'the host\'s own off-enforcement reaches the routed app');
  assert.ok(f.calls.stop.includes(A), 'fenced and stopped before any ledger answer');
  assert.equal((await ingress(h, A)).lifecycleRefused, true);
  await settle(); await d.reconcile(A);
  assert.deepEqual(f.calls.prepare.map((p) => p.target), ['queued']); assert.equal(f.calls.submit.length, 1);
  h.caps.paused = false;
  assert.equal((await d.reconcile(A)).status, 'pending'); assert.equal(f.calls.submit.length, 1);
  assert.equal(rpc.chainTx.sent.length, sent0, 'no legacy transaction');
});

// CHANGED (r2): r1 asserted that a moved address-book ledger holds an ACTIVATED route. It still holds activation; after
// the finalized handoff the old global book is no longer a runtime dependency of the routed app.
test('address-book ledger change: holds activation BEFORE handoff; does not disable the routed app AFTER it', async () => {
  const f = fixture({ hostId: HOSTID }), d = D.createLifecycleDispatch(f.parts([route(A)]));
  const { h } = await box(Host, d); serve(h);
  const was = chain.addresses.deployments;
  try {
    chain.addresses.deployments = '0x' + 'd1'.repeat(20);
    await d.activate(); assert.match(d.state()[0].held, /old ledger/); assert.equal(f.calls.quiescence.length, 0);
    assert.equal((await d.reconcile(A)).status, 'held'); assert.equal(f.calls.read.length, 0);
    chain.addresses.deployments = was;
    await d.activate(); assert.equal(d.state()[0].activated, true);
    for (const moved of ['0x' + 'd1'.repeat(20), '0x' + 'd2'.repeat(20)]) {
      chain.addresses.deployments = moved;
      assert.equal((await d.reconcile(A)).status, 'running');
      assert.equal((await ingress(h, A)).lifecycleRefused, false);
    }
    assert.equal(h.lifecycle.owns(A), true); assert.equal(f.calls.submit.length, 0);
  } finally { chain.addresses.deployments = was; }
  assert.equal(chain.addresses.deployments, OLD);
});
