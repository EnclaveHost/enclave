// UPDATED root r4 generation control (AUTHORED, NOT RUN). The original r4 host-generation.test.mjs (b9b51651) started from an IMPORTED
// running runtime with no saved host incarnation and expected it to serve; under root r3's explicit-only default that positive start is
// OBSOLETE. The original file and its failure evidence are preserved unchanged. completion r2: this control runs root's mock runtime,
// which is NOT the v2 host-authority permit runtime, so after the legitimate explicit adoption the FINAL dispatch must (a) never serve
// it (v2 is mandatory for independent-host-registry-r1) and (b) make authorized forward progress by preparing the queued revocation of
// the stopped context (requeue) instead of holding forever. The positive v2 serve after adoption is the native real-runtime test.
// Runs inside a copy of root r3's tree whose src/network carries the FINAL dispatch and repaired incarnation sidecar.
// TEST DOUBLES: root's mock chain/runtime/inventory (test/helpers/lifecycle-fixture.mjs a5f599b7); the incarnation file is real.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { composeIndependentLifecycle, createSnapshotHostAdmission } from '../src/network/lifecycle-host-authority.mjs';
import { withHostIncarnationJournal } from '../src/network/lifecycle-host-incarnation-journal.mjs';
import { fixture, H, NEW, CTRL, INDEP, PLATFORM, route } from './helpers/lifecycle-fixture.mjs';
const PROFILE = 'independent-host-registry-r1', BUNDLE = 'bed9c19652edce8ca6f337f691a9909c15763e6755ff237139b07f4d84f3260e';
const ARTIFACT = 'e8690734c4fae1f1adfa3525061d5542b314704c997feec2daa09fdecd49f23a', REG = '0x' + 'ab'.repeat(20), REGCODE = H('23');
const HOST = H('a1'), ID = H('a2');
async function world(t) {
  const f = fixture({ hostId: HOST, now: () => 1000 }), state = { generation: '1', status: 'online' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-explicit-')); t.after(() => fs.rmSync(dir, { recursive: true }));
  const journal = withHostIncarnationJournal(f.journal, path.join(dir, 'incarnation.json'));
  const pins = { chainId: 8453, host: HOST, profile: PROFILE, hostRegistry: { artifactSha256: ARTIFACT }, contracts: { registry: { address: REG, codeHash: REGCODE },
    hostOwnership: { address: REG, codeHash: REGCODE }, ledger: { address: NEW, codeHash: H('11') }, lifecycle: { address: CTRL, codeHash: H('22') },
    catalog: { address: '0x' + 'cd'.repeat(20), codeHash: H('24') } } };
  const adapter = { ...f.chain, profile: PROFILE, lifecycleSchema: 3, lifecycleProofSchema: 2, bundleSha256: BUNDLE,
    hostRegistry: { address: REG, runtimeCodeHash: REGCODE, artifactSha256: ARTIFACT }, independence: { complete: false, blockers: ['TEST mock chain/runtime'] },
    async read(id) { return { ...await f.chain.read(id), profile: PROFILE, lifecycleSchema: 3, lifecycleProofSchema: 2,
      hostAuthority: { owner: INDEP, revision: '1', policyHash: H('55'), policyKnown: true }, host: { ownerDenial: null }, emergency: { pending: false },
      hostLifecycle: { codeConsistent: true, registry: REG, status: state.status, online: state.status === 'online', generation: state.generation, owner: INDEP,
        revision: '1', policyHash: H('55'), qualificationDigest: H('61'), trustAnchorId: H('62'), hardwareId: H('63'), resourceDigest: H('64'), descriptorDigest: H('65') } }; } };
  const binding = { lifecycleSchema: 3, profile: PROFILE, bundleSha256: BUNDLE, hostRegistry: REG, hostRegistryCodeHash: REGCODE, hostRegistryArtifactSha256: ARTIFACT };
  const c = composeIndependentLifecycle({ adapter, adapterPins: pins, runtime: f.runtime, journal, inventory: f.inventory, routes: [route(ID, binding)],
    platformWallets: [PLATFORM], capacityHeadroom: 0.05, verifyQuiescence: f.verifyQuiescence, now: () => 1000 });
  c.dispatch.attach(f.hostView(HOST)); await c.dispatch.activate();
  return { f, state, journal, c, adapter };
}
async function explicitOrigin({ f, c, journal }) {     // imported runtime: fenced first, then root r3 explicit adoption of the CURRENT incarnation
  const first = await c.dispatch.reconcile(ID);
  assert.notEqual(first.status, 'running'); assert.equal(f.calls.serve.length, 0, 'no automatic genesis');
  const named = journal.readHostIncarnation(HOST).floor;
  assert.equal((await c.dispatch.adoptHostIncarnation(ID, { generation: named.generation, digest: named.digest })).adopted, true);
  assert.equal(journal.readHostIncarnation(HOST).bound[ID].requeue, true);
  return c.dispatch.reconcile(ID);
}
test('explicit-origin control: adopted app is never served by a non-v2 runtime; an authorized queued revocation is prepared; Offline still fences', async t => {
  const w = await world(t), next = await explicitOrigin(w);
  assert.equal(w.f.calls.serve.length, 0, 'v2 is mandatory for the new profile'); assert.notEqual(next.status, 'running');
  assert.ok(w.f.calls.prepare.some(p => p.target === 'queued'), 'forward progress through the authorized revocation path, not a forever hold');
  w.state.status = 'offline'; await w.c.dispatch.reconcile(ID);
  assert.equal(w.f.calls.serve.length, 0); assert.ok(w.f.calls.fence.length > 0);
});
test('host recovery generation changes the serving authority even with unchanged owner/policy revision', async t => {
  const { state, adapter } = await world(t), a = createSnapshotHostAdmission({ hostId: HOST, profile: PROFILE, now: () => 1000 });
  const before = await a.decision(ID, await adapter.read(ID)); state.generation = '2';
  const after = await a.decision(ID, await adapter.read(ID));
  assert.notDeepEqual(after, before); assert.notEqual(after.hostIncarnation.digest, before.hostIncarnation.digest);
});
test('missed Offline followed by recovered Online cannot resume the explicitly adopted old context', async t => {
  const w = await world(t); await explicitOrigin(w);
  w.state.generation = '2';
  const outcome = await w.c.dispatch.reconcile(ID);
  assert.equal(w.f.calls.serve.length, 0, 'old-generation context is fenced, never renewed'); assert.notEqual(outcome.status, 'running'); assert.ok(w.f.calls.fence.length > 0);
});
