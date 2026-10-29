// Owner-scoped admission against the REAL baseline host-admission-policy.mjs / catalog-policy.js (read only), with a
// MOCK agreeing reader (no RPC). The dispatch end-to-end cases use the real runner and the mock lifecycle fixture.
import { AUTHORITY_URL, DISPATCH_URL, BASE_NETWORK } from './helpers/baseline.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, route, H, NEW, CTRL, INDEP, PLATFORM } from './helpers/lifecycle-fixture.mjs';
const AU = await import(AUTHORITY_URL);
const D = await import(DISPATCH_URL);
const P = await import(new URL('host-admission-policy.mjs', BASE_NETWORK).href);
const { catalogAdmissionRefusal } = await import(new URL('../site/js/core/catalog-policy.js', BASE_NETWORK).href);

const HOST = H('99'), A = H('aa'), APP = '0x' + 'cd'.repeat(32), REF = `catalog://${APP}/1`;
const OWNERSHIP = '0x' + '0e'.repeat(20), CATALOG = '0x' + 'ca'.repeat(20);
const policy = (over = {}) => ({ version: 1, chainId: 8453, ownershipContract: OWNERSHIP, hostId: HOST, requireCatalogApproval: false,
  denyDeployments: [], denyAppRefs: [], ...over });
const app = (over = {}) => ({ appId: APP, versionCount: 2, active: true, ...over });
const ver = (over = {}) => ({ cid: 'bafy', createdAt: '1', yanked: false, approval: 0, ...over });
const refuse = (p, o = {}) => AU.independentAdmissionRefusal(p, { hostId: HOST, deploymentId: A, appRef: REF, app: app(o.app), version: ver(o.ver), forPrivate: o.forPrivate });

// MOCK LeaseReader.agreed: one "block", answers per view, records which contract each view was read from.
function reader(W) {
  const seen = [];
  return { seen, async agreed(fn) {
    if (W.down) throw Error('chain quorum unavailable');
    const client = { async readContract({ address, functionName, args }) { seen.push([functionName, address]);
      if (functionName === 'authority') return [W.owner, '0x' + '00'.repeat(20), BigInt(W.revision), W.policyHash];
      if (functionName === 'getApp') return { ...app(), ...W.app };
      if (functionName === 'getVersion') return { version: '1', ...ver(), ...W.ver, createdAt: BigInt((W.ver?.createdAt) ?? 1) };
      throw Error(`unexpected view ${functionName}`); } };
    return { ...(await fn(client, 100n)), hash: H('77'), blockNumber: '100', timestamp: W.timestamp ?? Date.now() };
  } };
}
const world = (doc = policy(), over = {}) => ({ owner: INDEP, revision: 1, policyHash: P.hostAdmissionPolicyHash(doc), doc, ...over });

test('integrity and publisher consent always apply; catalog-owner moderation applies only when the host owner elects it', () => {
  const off = policy();
  assert.equal(refuse(off), null, 'pending approval: no mandatory central moderation');
  assert.equal(refuse(off, { ver: { approval: 2 } }), null, 'a catalog-owner rejection is not a veto on this host');
  assert.match(refuse(off, { ver: { yanked: true } }), /publisher has yanked/);
  assert.match(refuse(off, { app: { active: false } }), /publisher has delisted/);
  assert.match(refuse(off, { ver: { cid: '' } }), /content commitment/);
  assert.match(refuse(off, { app: { versionCount: 1 } }), /no such app version/);
  assert.match(refuse(off, { app: { appId: '0x' + 'ce'.repeat(32) } }), /no such app version/);
  assert.match(refuse(policy({ denyDeployments: [A] })), /declines/);
  assert.match(refuse(policy({ denyAppRefs: [REF] })), /declines/);
  assert.throws(() => refuse(policy({ hostId: H('98') })), /another host/);
  assert.throws(() => AU.independentAdmissionRefusal(off, { hostId: HOST, deploymentId: A, appRef: 'https://x', app: app(), version: ver() }), /catalog app reference/);
  const on = policy({ requireCatalogApproval: true });
  assert.match(refuse(on), /catalog moderation/);
  assert.match(refuse(on, { forPrivate: true }), /requires current catalog approval/);
  assert.match(refuse(on, { ver: { approval: 2 } }), /rejected/);
  assert.equal(refuse(on, { ver: { approval: 1 } }), null);
});

test('legacy admission is not mutated: hostAdmissionRefusal still applies mandatory platform moderation', () => {
  const legacy = P.hostAdmissionRefusal(policy(), { hostId: HOST, deploymentId: A, appRef: REF, version: { ...ver(), active: true } });
  assert.equal(legacy, catalogAdmissionRefusal({ ...ver(), active: true }, { ...ver(), active: true }, { forPrivate: false }));
  assert.match(legacy, /requires catalog approval/);
});

test('scoped host authority: the production hash-checked commitment, a revision floor, freshness', async () => {
  const W = world(policy({ denyAppRefs: [REF] }));
  const r = reader(W), a = AU.createScopedHostAuthority({ hostId: HOST, ownershipContract: OWNERSHIP, reader: r, loadPolicy: async () => W.doc });
  const s = await a.snapshot();
  assert.equal(s.owner, INDEP); assert.equal(s.revision, '1'); assert.deepEqual(s.policy.denyAppRefs, [REF]);
  assert.deepEqual(r.seen[0], ['authority', OWNERSHIP]);
  W.revision = 2; W.owner = PLATFORM; assert.equal((await a.snapshot()).owner, PLATFORM);
  W.revision = 1; W.owner = INDEP; await assert.rejects(a.snapshot(), /replay/);
  W.revision = 2; W.owner = '0x' + '2d'.repeat(20); await assert.rejects(a.snapshot(), /equivocation/);
  W.owner = PLATFORM; W.timestamp = Date.now() - 120_000; await assert.rejects(a.snapshot(), /expired/);
  W.timestamp = undefined; W.revision = 3; W.doc = policy();   // committed hash no longer matches the served document
  await assert.rejects(a.snapshot(), /does not match/);
  W.policyHash = '0x' + '00'.repeat(32);
  assert.equal((await a.snapshot()).policy.requireCatalogApproval, false, 'no commitment: the production default policy');
  W.down = true; await assert.rejects(a.snapshot(), /quorum/);
});

async function routed(W, { state = 'running', service = null } = {}) {
  const f = fixture({ hostId: HOST, state }), r = reader(W);
  const ownership = AU.createScopedHostAuthority({ hostId: HOST, ownershipContract: OWNERSHIP, reader: r, loadPolicy: async () => W.doc });
  const authority = AU.createIndependentHostAdmission({ hostId: HOST, ownership, readCatalog: AU.catalogVersionReader({ reader: r, catalog: CATALOG }) });
  const d = D.createLifecycleDispatch(f.parts([route(A)], { authority }));
  d.attach(f.hostView(HOST)); f.V.service = service; await d.activate();
  return { f, d, r };
}

test('end to end (real policy code, real runner): an independent host serves a pending-approval app under a platform ban', async () => {
  const W = world(policy(), { ver: { approval: 0 } });
  const { f, d } = await routed(W, { service: 'platform host policy: banned' });
  for (let i = 0; i < 3; i++) assert.equal((await d.reconcile(A)).status, 'running');
  assert.equal(f.calls.serve.length, 3); assert.equal(f.calls.submit.length, 0);
  assert.equal(d.state()[0].hostAuthority.owner, INDEP);
});

test('end to end: the host owner\'s elected moderation, deny list or publisher yank stops and records a revocation', async () => {
  for (const [doc, over] of [[policy({ requireCatalogApproval: true }), { ver: { approval: 2 } }], [policy({ denyDeployments: [A] }), {}],
    [policy(), { ver: { yanked: true } }]]) {
    const { f, d } = await routed(world(doc, over));
    assert.equal((await d.reconcile(A)).status, 'pending');
    assert.ok(f.calls.stop.includes(A)); assert.deepEqual(f.calls.prepare.map((p) => p.target), ['queued']);
  }
});

test('end to end: on a host its pinned wallet owns, the platform ban is the owner\'s stop', async () => {
  const { f, d } = await routed(world(policy(), { owner: PLATFORM }), { service: 'platform host policy: banned' });
  assert.equal((await d.reconcile(A)).status, 'pending'); assert.deepEqual(f.calls.prepare.map((p) => p.target), ['queued']);
});

test('end to end: an ownership/catalog outage is unknown (fenced, not stopped, never allowed)', async () => {
  const W = world(); const { f, d } = await routed(W);
  W.down = true;
  assert.equal((await d.reconcile(A)).status, 'held');
  assert.equal(f.calls.serve.length, 0); assert.equal(f.calls.stop.length, 0); assert.equal(f.calls.read.length, 1);
});

test('composer: wires the r6 adapter interface with bindings from its reviewed pins; missing parts are named blockers', async () => {
  const f = fixture({ hostId: HOST });
  const pins = { host: HOST, contracts: { ledger: { address: NEW, codeHash: H('11') }, lifecycle: { address: CTRL, codeHash: H('22') },
    hostOwnership: { address: OWNERSHIP, codeHash: H('23') }, catalog: { address: CATALOG, codeHash: H('24') } } };
  const W = world(), r = reader(W);
  const adapter = { ...f.chain, async read(id) { const { ledger, controller, ...s } = await f.chain.read(id); return s; } };   // r6 shape: no ledger/controller labels
  assert.throws(() => AU.composeIndependentLifecycle({ adapter, adapterPins: { host: HOST, contracts: {} } }), (e) => e.code === 'LIFECYCLE_ACTIVATION_BLOCKED' && e.missing.includes('adapterPins.contracts.hostOwnership'));
  assert.throws(() => AU.composeIndependentLifecycle({ adapter, adapterPins: pins, runtime: f.runtime, journal: f.journal, routes: [route(A)],
    platformWallets: [], capacityHeadroom: 0, verifyQuiescence: f.verifyQuiescence }), (e) => e.missing.includes('reader.agreed') && e.missing.includes('loadPolicy'));
  const c = AU.composeIndependentLifecycle({ adapter, adapterPins: pins, reader: r, loadPolicy: async () => W.doc, runtime: f.runtime, journal: f.journal,
    routes: [route(A)], platformWallets: [PLATFORM], capacityHeadroom: 0.05, verifyQuiescence: f.verifyQuiescence });
  assert.equal(c.hostId, HOST); assert.equal(c.dispatch.binding.ledger, NEW); assert.equal(c.dispatch.binding.controller, CTRL);
  assert.ok(c.gaps.length >= 4); assert.deepEqual([...c.missing], []);
  c.dispatch.attach(f.hostView(HOST)); await c.dispatch.activate();
  assert.equal((await c.dispatch.reconcile(A)).status, 'running');
  assert.deepEqual(r.seen.find(([fn]) => fn === 'authority'), ['authority', OWNERSHIP], 'ownership read from the pinned EnclaveHostOwnership');
  assert.deepEqual(r.seen.find(([fn]) => fn === 'getApp'), ['getApp', CATALOG], 'catalog read from the pinned catalog');
  const held = AU.composeIndependentLifecycle({ adapter, adapterPins: pins, runtime: f.runtime, journal: f.journal, routes: [route(A)],
    platformWallets: [], capacityHeadroom: 0, verifyQuiescence: f.verifyQuiescence, onMissing: 'hold' });
  assert.ok(held.missing.includes('reader.agreed')); assert.ok(held.dispatch.blocked.includes('authority.decision'));
});
