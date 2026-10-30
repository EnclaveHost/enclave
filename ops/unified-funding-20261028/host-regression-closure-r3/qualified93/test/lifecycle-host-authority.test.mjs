// SUPERSEDES review-r2/test/lifecycle-host-authority.test.mjs (the r3 run excludes that file by name; it is not edited).
// Owner-scoped admission against the REAL baseline host-admission-policy.mjs / catalog-policy.js (read only), with a
// MOCK agreeing reader (no RPC). The dispatch end-to-end cases use the real runner and the mock lifecycle fixture.
// "CHANGED (r3)" marks an r2 expectation that enshrined a central veto, with the reason.
import { AUTHORITY_URL, DISPATCH_URL, BASE_NETWORK } from './helpers/baseline.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, route, resources, H, NEW, CTRL, INDEP, PLATFORM } from './helpers/lifecycle-fixture.mjs';
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

function reader(W) {
  const seen = [];
  return { seen, async agreed(fn) {
    if (W.down) throw Error('chain quorum unavailable');
    const client = { async readContract({ address, functionName }) { seen.push([functionName, address]);
      if (functionName === 'authority') return [W.owner, '0x' + '00'.repeat(20), BigInt(W.revision), W.policyHash];
      if (functionName === 'getApp') return { ...app(), ...W.app };
      if (functionName === 'getVersion') return { version: '1', ...ver(), ...W.ver, createdAt: BigInt((W.ver?.createdAt) ?? 1) };
      throw Error(`unexpected view ${functionName}`); } };
    return { ...(await fn(client, 100n)), hash: H('77'), blockNumber: '100', timestamp: W.timestamp ?? Date.now() };
  } };
}
const world = (doc = policy(), over = {}) => ({ owner: INDEP, revision: 1, policyHash: P.hostAdmissionPolicyHash(doc), doc, ...over });

// CHANGED (r3): r2 asserted "publisher has yanked/delisted" as ALWAYS-ON integrity. setActive/yankVersion leave the pinned
// version CID unchanged; making them mandatory kept a global veto for the publisher (Enclave for its own apps). They are
// now part of the moderation a host owner may elect, and plain metadata otherwise.
test('integrity always applies; publisher listing and catalog-owner moderation apply only when the host owner elects them', () => {
  const off = policy();
  assert.equal(refuse(off), null, 'pending approval: no mandatory central moderation');
  assert.equal(refuse(off, { ver: { approval: 2 } }), null, 'a catalog-owner rejection is not a veto on this host');
  assert.equal(refuse(off, { ver: { yanked: true } }), null, 'a publisher yank of the same committed artifact is not a veto');
  assert.equal(refuse(off, { app: { active: false } }), null, 'a publisher delisting is not a veto');
  assert.deepEqual(AU.publisherListing({ app: app({ active: false }), version: ver({ yanked: true }) }), { delisted: true, yanked: true });
  assert.match(refuse(off, { ver: { cid: '' } }), /content commitment/);
  assert.match(refuse(off, { ver: { createdAt: '0' } }), /content commitment/);
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
  assert.match(refuse(on, { ver: { approval: 1, yanked: true } }), /catalog moderation: .*yanked/, 'elected moderation includes the publisher yank');
  assert.match(refuse(on, { app: { active: false }, ver: { approval: 1 } }), /catalog moderation: .*delisted/);
  assert.equal(refuse(on, { ver: { approval: 1 } }), null);
});

test('legacy admission is not mutated: hostAdmissionRefusal still applies mandatory platform moderation', () => {
  const legacy = P.hostAdmissionRefusal(policy(), { hostId: HOST, deploymentId: A, appRef: REF, version: { ...ver(), active: true } });
  assert.equal(legacy, catalogAdmissionRefusal({ ...ver(), active: true }, { ...ver(), active: true }, { forPrivate: false }));
  assert.match(legacy, /requires catalog approval/);
  assert.match(P.hostAdmissionRefusal(policy(), { hostId: HOST, deploymentId: A, appRef: REF, version: { ...ver({ approval: 1, yanked: true }), active: true } }), /yanked/);
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
  W.timestamp = undefined; W.revision = 3; W.doc = policy();
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
  const { f, d } = await routed(world(policy(), { ver: { approval: 0 } }), { service: 'platform host policy: banned' });
  for (let i = 0; i < 3; i++) assert.equal((await d.reconcile(A)).status, 'running');
  assert.equal(f.calls.serve.length, 3); assert.equal(f.calls.submit.length, 0);
  assert.equal(d.state()[0].hostAuthority.owner, INDEP);
});

// CHANGED (r3): r2 listed "publisher yank" among the stops with no election. It is now a stop only under elected moderation.
test('end to end: elected moderation (incl. a publisher yank) or a deny list stops and records a revocation', async () => {
  for (const [doc, over] of [[policy({ requireCatalogApproval: true }), { ver: { approval: 2 } }], [policy({ denyDeployments: [A] }), {}],
    [policy({ requireCatalogApproval: true }), { ver: { approval: 1, yanked: true } }]]) {
    const { f, d } = await routed(world(doc, over));
    assert.equal((await d.reconcile(A)).status, 'pending');
    assert.ok(f.calls.stop.includes(A)); assert.deepEqual(f.calls.prepare.map((p) => p.target), ['queued']);
  }
});

test('end to end: a publisher delist or yank of the same artifact, with no elected moderation, keeps serving', async () => {
  for (const over of [{ ver: { yanked: true } }, { app: { active: false } }]) {
    const { f, d } = await routed(world(policy(), over));
    for (let i = 0; i < 2; i++) assert.equal((await d.reconcile(A)).status, 'running');
    assert.equal(f.calls.stop.length, 0); assert.equal(f.calls.submit.length, 0);
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

// r3: one authenticated block. The independent-profile adapter's own fields are the decision; nothing re-read elsewhere.
const indepSnap = (over = {}) => ({ id: A, thisHost: HOST, verified: true, profile: 'independent-r1', resources: resources(), forPrivate: false,
  hostAuthority: { owner: INDEP, revision: '4', policyHash: H('55'), policyKnown: true }, host: { ownerDenial: null }, ...over });
test('snapshot admission: derived from the independent-profile snapshot only; unknown policy is unknown, never a decision', async () => {
  const a = AU.createSnapshotHostAdmission({ hostId: HOST });
  const d = await a.decision(A, indepSnap());
  assert.deepEqual([d.hostId, d.deployment, d.owner, d.revision, d.policyHash, d.refusal], [HOST, A, INDEP, '4', H('55'), null]);
  assert.equal((await a.decision(A, indepSnap({ host: { ownerDenial: 'this host owner declines this deployment' } }))).refusal, 'this host owner declines this deployment');
  for (const [over, err] of [[{ profile: undefined }, /independent-profile/], [{ thisHost: H('98') }, /independent-profile/], [{ verified: false }, /independent-profile/],
    [{ id: H('bb') }, /independent-profile/], [{ hostAuthority: { owner: '0x' + '00'.repeat(20), revision: '4', policyHash: H('55'), policyKnown: true } }, /ownership unavailable/],
    [{ hostAuthority: { owner: INDEP, revision: '4', policyHash: H('55'), policyKnown: false }, host: { ownerDenial: 'host owner policy unavailable: x' } }, /policy unknown/],
    [{ hostAuthority: { owner: INDEP, revision: 4, policyHash: H('55'), policyKnown: true } }, /malformed/]])
    await assert.rejects(a.decision(A, indepSnap(over)), err, JSON.stringify(over));
});

// CHANGED (r3): r2's composer accepted any adapter shape plus a separate reader/loadPolicy and reported ADAPTER_GAPS. It now
// requires the GENERATED independent-profile adapter (a legacy-profile adapter still applies the central gates) and takes
// admission from its snapshot. This uses a MOCK adapter with that shape; the real one is tested in the r6 tree
// (test/r6/r3-independent-profile.test.mjs, jobs/root-r3-adapter-tests.sh).
test('composer: only an independent-profile adapter; bindings from its reviewed pins; named blockers carried through', async () => {
  const f = fixture({ hostId: HOST });
  const pins = { host: HOST, profile: 'independent-r1', contracts: { ledger: { address: NEW, codeHash: H('11') }, lifecycle: { address: CTRL, codeHash: H('22') },
    hostOwnership: { address: OWNERSHIP, codeHash: H('23') }, catalog: { address: CATALOG, codeHash: H('24') } } };
  const blockers = ['EnclaveDeployments.retire() ... (mock text)'];
  const adapter = { ...f.chain, profile: 'independent-r1', independence: { complete: false, blockers },
    async read(id) { const { ledger, controller, ...s } = await f.chain.read(id);
      return { ...s, profile: 'independent-r1', hostAuthority: { owner: INDEP, revision: '1', policyHash: H('55'), policyKnown: true }, host: { ownerDenial: null } }; } };
  const parts = { runtime: f.runtime, journal: f.journal, inventory: f.inventory, routes: [route(A)], platformWallets: [PLATFORM], capacityHeadroom: 0.05, verifyQuiescence: f.verifyQuiescence };
  assert.throws(() => AU.composeIndependentLifecycle({ adapter, adapterPins: { ...pins, profile: undefined }, ...parts }), (e) => e.missing.some((m) => m.startsWith('adapterPins.profile')));
  assert.throws(() => AU.composeIndependentLifecycle({ adapter: { ...adapter, profile: undefined }, adapterPins: pins, ...parts }), (e) => e.missing.some((m) => m.startsWith('adapter.profile')));
  assert.throws(() => AU.composeIndependentLifecycle({ adapter, adapterPins: pins, ...parts, inventory: undefined }), (e) => e.missing.includes('inventory.findByName'));
  const c = AU.composeIndependentLifecycle({ adapter, adapterPins: pins, ...parts });
  assert.equal(c.hostId, HOST); assert.equal(c.dispatch.binding.ledger, NEW); assert.equal(c.dispatch.binding.controller, CTRL);
  assert.deepEqual(c.gaps, blockers); assert.equal(c.independence.complete, false); assert.deepEqual([...c.missing], []);
  c.dispatch.attach(f.hostView(HOST)); await c.dispatch.activate();
  assert.equal((await c.dispatch.reconcile(A)).status, 'running');
  assert.equal(c.dispatch.state()[0].hostAuthority.owner, INDEP);
  const held = AU.composeIndependentLifecycle({ adapter: { ...adapter, profile: undefined }, adapterPins: pins, ...parts, onMissing: 'hold' });
  assert.ok(held.missing.some((m) => m.startsWith('adapter.profile'))); assert.ok(held.dispatch.blocked.length > 0);
});
