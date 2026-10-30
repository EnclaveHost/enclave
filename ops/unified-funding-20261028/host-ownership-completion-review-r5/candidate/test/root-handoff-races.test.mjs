// ownership r3 post-runtime-await races (AUTHORED, NOT RUN). Same world as root's test/root-final-await.test.mjs (host-authority-adoption-
// final-await-r3), run in root r3's tree whose src/network carries the FINAL generated dispatch + ownership incarnation sidecar
// (+ owned-durable-state.mjs, runtime-lock.mjs). REAL: the generated composer/dispatch and the durable host-incarnation file.
// MOCKS (explicit TEST doubles, not EVM or production qualification): root's chain/runtime/inventory/app journal
// (test/helpers/lifecycle-fixture.mjs) and the runtime adoptHostAuthority/revokeHostAuthority hooks.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { composeIndependentLifecycle } from '../src/network/lifecycle-host-authority.mjs';
import { withHostIncarnationJournal } from '../src/network/lifecycle-host-incarnation-journal.mjs';
import { fixture, H, NEW, CTRL, INDEP, PLATFORM, route } from './helpers/lifecycle-fixture.mjs';
const PROFILE = 'independent-host-registry-r1', BUNDLE = 'bed9c19652edce8ca6f337f691a9909c15763e6755ff237139b07f4d84f3260e';
const ARTIFACT = 'e8690734c4fae1f1adfa3525061d5542b314704c997feec2daa09fdecd49f23a', REG = '0x' + 'ab'.repeat(20), REGCODE = H('23');
const HOST = H('a1'), ID = H('a2');
async function world(t) {
  const f = fixture({ hostId: HOST, now: () => 1000 }), state = { generation: '1', status: 'online', owner: INDEP, revision: '1', policyHash: H('55') };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-races-')); t.after(() => fs.rmSync(dir, { recursive: true }));
  const journal = withHostIncarnationJournal(f.journal, path.join(dir, 'incarnation.json'));
  const pins = { chainId: 8453, host: HOST, profile: PROFILE, hostRegistry: { artifactSha256: ARTIFACT }, contracts: { registry: { address: REG, codeHash: REGCODE },
    hostOwnership: { address: REG, codeHash: REGCODE }, ledger: { address: NEW, codeHash: H('11') }, lifecycle: { address: CTRL, codeHash: H('22') },
    catalog: { address: '0x' + 'cd'.repeat(20), codeHash: H('24') } } };
  const adapter = { ...f.chain, profile: PROFILE, lifecycleSchema: 3, lifecycleProofSchema: 2, bundleSha256: BUNDLE,
    hostRegistry: { address: REG, runtimeCodeHash: REGCODE, artifactSha256: ARTIFACT }, independence: { complete: false, blockers: ['TEST mock chain/runtime'] },
    async read(id) { return { ...await f.chain.read(id), profile: PROFILE, lifecycleSchema: 3, lifecycleProofSchema: 2,
      hostAuthority: { owner: state.owner, revision: state.revision, policyHash: state.policyHash, policyKnown: true }, host: { ownerDenial: null }, emergency: { pending: false },
      hostLifecycle: { codeConsistent: true, registry: REG, status: state.status, online: state.status === 'online', generation: state.generation, owner: state.owner,
        revision: state.revision, policyHash: state.policyHash, qualificationDigest: H('61'), trustAnchorId: H('62'), hardwareId: H('63'), resourceDigest: H('64'), descriptorDigest: H('65') } }; } };
  const binding = { lifecycleSchema: 3, profile: PROFILE, bundleSha256: BUNDLE, hostRegistry: REG, hostRegistryCodeHash: REGCODE, hostRegistryArtifactSha256: ARTIFACT };
  const hooks = { adopt: 0, revoke: 0, during: null };
  f.runtime.hostAuthorityPermit = true;                                                       // explicit TEST runtime hooks; no real enforcement claimed
  f.runtime.adoptHostAuthority = async () => { hooks.adopt++; await hooks.during?.(state); };
  f.runtime.revokeHostAuthority = async () => { hooks.revoke++; };
  const c = composeIndependentLifecycle({ adapter, adapterPins: pins, runtime: f.runtime, journal, inventory: f.inventory, routes: [route(ID, binding)],
    platformWallets: [PLATFORM], capacityHeadroom: 0.05, verifyQuiescence: f.verifyQuiescence, now: () => 1000 });
  c.dispatch.attach(f.hostView(HOST)); await c.dispatch.activate();
  await c.dispatch.reconcile(ID);                                                             // imported runtime fenced; no automatic genesis
  return { f, state, journal, c, hooks, named: journal.readHostIncarnation(HOST).floor };
}
for (const [name, during] of [
  ['owner/revision change', s => { s.owner = '0x' + '9a'.repeat(20); s.revision = '2'; }],
  ['policy change at the same revision', s => { s.policyHash = H('56'); }],
  ['canonical Offline', s => { s.status = 'offline'; }],
  ['qualified recovery to generation 2', s => { s.generation = '2'; }]]) test(`${name} INSIDE the awaited runtime handoff aborts before binding and revokes the v2 handoff`, async t => {
  const w = await world(t); w.hooks.during = during;
  await assert.rejects(w.c.dispatch.adoptHostIncarnation(ID, { generation: w.named.generation, digest: w.named.digest }), /adoption aborted after the runtime handoff/);
  assert.equal(w.hooks.adopt, 1, 'the actual post-quiescence runtime handoff was reached');
  assert.equal(w.hooks.revoke, 1, 'the runtime/gate handoff is revoked, never left as a stale grant');
  assert.equal(w.journal.readHostIncarnation(HOST).bound[ID], undefined, 'no durable binding for the old context');
  assert.equal(w.f.calls.serve.length, 0);
});
test('unchanged canonical authority after the awaited handoff: binds exactly once, then canonical Queued, then ONE new Running', async t => {
  const w = await world(t);
  assert.equal((await w.c.dispatch.adoptHostIncarnation(ID, { generation: w.named.generation, digest: w.named.digest })).adopted, true);
  assert.equal(w.hooks.adopt, 1); assert.equal(w.hooks.revoke, 0);
  const b = w.journal.readHostIncarnation(HOST).bound[ID]; assert.equal(b.digest, w.named.digest); assert.equal(b.requeue, true);
  const targets = x => w.f.calls.prepare.filter(p => p.target === x).length;
  await w.c.dispatch.reconcile(ID);
  assert.equal(targets('queued'), 1, 'the authorized queued revocation of the stopped context is prepared once'); assert.equal(w.f.calls.serve.length, 0);
  w.f.journal.settleTransition(ID); w.f.S.state.set(ID, 'queued');                           // TEST: the chain accepted that exact Queued intent
  for (let i = 0; i < 3 && targets('running') === 0; i++) await w.c.dispatch.reconcile(ID);
  assert.equal(w.journal.readHostIncarnation(HOST).bound[ID].requeue, false, 'requeue cleared only once the assignment is no longer running');
  assert.equal(targets('running'), 1, 'a fresh start is prepared exactly once'); assert.equal(targets('queued'), 1);
  w.f.journal.settleTransition(ID); w.f.S.state.set(ID, 'running');                          // TEST: the chain accepted that exact Running intent
  for (let i = 0; i < 3 && w.f.calls.serve.length === 0; i++) await w.c.dispatch.reconcile(ID);
  assert.equal(w.f.calls.serve.length, 1, 'served once under the fresh canonical Running'); assert.equal(targets('running'), 1); assert.equal(w.hooks.adopt, 1);
});
