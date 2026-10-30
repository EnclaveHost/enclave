// The GENERATED host candidate (baseline windows/node/host.mjs + the pinned insertions), against the baseline's fake Base
// RPC and the REAL baseline chain.mjs, compared with the unmodified baseline Host. The candidate is written to a temp
// dir; its relative imports resolve to the read-only baseline (helpers/baseline.mjs). Lifecycle adapters are MOCKS:
// these tests show which host paths a routed id can and cannot reach, not production authority or readiness.
import { BASELINE_HOST, BASE_TEST, BASE_NODE, GENERATOR_URL, DISPATCH_URL, registerCandidate } from './helpers/baseline.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, route, H, OLD } from './helpers/lifecycle-fixture.mjs';

process.env.NODE_OPERATOR_KEY = '0x' + '7f'.repeat(32);
process.env.NODE_PROOF_KEY = '0x' + '5a'.repeat(32);
delete process.env.ENCLAVE_NETWORK_WALLET_HOLD;
const { fakeBaseRpc, DEPLOYMENTS, CATALOG } = await import(new URL('helpers/fake-base-rpc.mjs', BASE_TEST).href);
assert.equal(DEPLOYMENTS, OLD, 'the fixture old ledger is the fake legacy ledger');
const rpc = await fakeBaseRpc();
const chain = await import(new URL('chain.mjs', BASE_NODE).href);
chain.addresses.deployments = DEPLOYMENTS; chain.addresses.appCatalog = CATALOG; chain.loadOperator(); chain.loadProofKey();
const { generateHostCandidate } = await import(GENERATOR_URL);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-host-candidate-'));
const candidateFile = path.join(tmp, 'host.lifecycle-candidate.mjs');
fs.writeFileSync(candidateFile, generateHostCandidate(fs.readFileSync(BASELINE_HOST, 'utf8')).source);
registerCandidate(pathToFileURL(candidateFile).href);
const { Host } = await import(pathToFileURL(candidateFile).href);
const { Host: BaselineHost } = await import(new URL('host.mjs', BASE_NODE).href);
const D = await import(DISPATCH_URL);

const dirs = [tmp];
after(() => { rpc.close(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const endpoint = 'https://api.enclave.host/t/lifecycle-routing-test', HOSTID = chain.enclaveIdOf(endpoint);
const A = H('aa'), C = H('cc');
const version = { cid: 'bafy', version: '1', vramMb: 0, gpuGflops: 0, memMb: 512, cpuGflops: 0, createdAt: 1n, verified: true, yanked: false, ports: '', approval: 1, config: '{}' };
const settle = () => new Promise((r) => setImmediate(r));
const quiet = (h, keep = []) => { for (const n of ['followBook', 'enforceOff', 'ensureRegistered', 'ensurePriced', 'scanLedger', 'retireForeignRecovered']) if (!keep.includes(n)) h[n] = async () => {}; };
const row = (rid, h, over = {}) => ({ id: rid, owner: chain.operatorAddress(), appRef: 'catalog://0x' + 'cd'.repeat(32) + '/1', ports: '', configCid: '',
  gpuMilli: 0, cpuMilli: 100, appPort: 8000, isPublic: true, active: true, createdAt: 1n, rate: 1n, balance6: 1000000n, spent6: 0n,
  runner: h.enclaveId, runnerOperator: chain.operatorAddress(), leaseUntil: BigInt(Math.floor(Date.now() / 1000) + 3600), ...over });

async function box(Cls, dispatch = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-host-')); dirs.push(dir);
  const policyLog = [], checkpoints = [];
  const h = new Cls({ dir, endpoint, name: 'test', appsEnabled: true, vcpus: 8, ramGb: 16, cpuPricePerSec6: 0,
    hostAdmission: { hostId: HOSTID, refusal: async (q) => { policyLog.push(String(q?.deploymentId ?? '?').toLowerCase()); return null; } },
    checkpointBatch: async (due) => { checkpoints.push(...due.map((d) => d.id)); return [{ ids: due.map((d) => d.id) }]; },
    ...(dispatch ? { lifecycleDispatch: dispatch } : {}) });
  h.chainReady = true; h.registered = { cpuPricePerSec6: '0' }; await h.refreshOwners();
  const spies = { consider: [], ensureApp: [] };
  const consider = h.consider.bind(h);
  h.consider = async (id, o) => { spies.consider.push(String(id).toLowerCase()); return consider(id, o); };
  h.ensureApp = async (id) => { spies.ensureApp.push(String(id).toLowerCase()); return h.records.get(id) || null; };
  return { h, spies, policyLog, checkpoints };
}
const serve = (h) => { rpc.row.current = null; rpc.rows.current = [row(A, h), row(C, h)]; rpc.catalog.current = version; };

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
  'adapters missing (hold mode)': () => { const f = fixture({ hostId: HOSTID }), p = f.parts([route(A)]); delete p.policy; delete p.verifyQuiescence;
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

test('the owner turning hosting off stops the routed app through the host\'s own restriction, without a transaction', async () => {
  const f = fixture({ hostId: HOSTID }), d = D.createLifecycleDispatch(f.parts([route(A)]));
  const { h } = await box(Host, d); serve(h);
  await d.activate();
  assert.equal((await d.reconcile(A)).status, 'running');
  h.caps.paused = true;
  const r = await d.reconcile(A);
  assert.equal(r.status, 'held'); assert.match(r.reason, /hosting off/);
  assert.ok(f.calls.stop.includes(A)); assert.equal(f.calls.submit.length, 0);
  h.caps.paused = false;
  assert.equal((await d.reconcile(A)).status, 'running');
});

test('a legacy ledger moved by the address book holds the route; nothing switches to the new ledger', async () => {
  const f = fixture({ hostId: HOSTID }), d = D.createLifecycleDispatch(f.parts([route(A)]));
  const { h } = await box(Host, d); serve(h);
  await d.activate();
  const was = chain.addresses.deployments;
  try {
    chain.addresses.deployments = '0x' + 'd1'.repeat(20);
    const r = await d.reconcile(A);
    assert.equal(r.status, 'held'); assert.match(r.reason, /old ledger/); assert.equal(f.calls.read.length, 0);
    assert.equal(h.lifecycle.owns(A), true);
  } finally { chain.addresses.deployments = was; }
  assert.equal(chain.addresses.deployments, OLD);
});
