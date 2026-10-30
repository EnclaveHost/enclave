// host-registry r2: ACTUAL EnclaveHostLifecycleRegistry (reviewed artifact, normal constructor, qualified enrollment) + actual schema3
// ledger/library/controller/prover + the GENERATED host-registry adapter + generated composer/dispatch + owned journal, on owned Anvil 8453.
// Runtime/manager/host view, closure doubles, finality authority and receipts are labelled TEST fixtures. This does NOT establish real
// Host isolation, positive Base authority, real qualification verifiers, an independent Offline submitter or production migration.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { toFunctionSelector, getAddress, keccak256, toBytes } from 'viem';
import { useAnvil, mine, HOST, chainNow, send, tx, step, codeHash, ZERO32, S } from './fixtures/r5-world.mjs';
import { worldHR, reg, RA, REG, deployRegistry, ownerOffline, quorumOffline, offlineIntent, recoverHost } from './fixtures/host-registry-world.mjs';
import { composeIndependentLifecycle, createSnapshotHostAdmission } from '../network/lifecycle-host-authority.mjs';
import { hostProfile, schema3Binding, SCHEMA3_HOST_PROFILE } from '../network/lifecycle-host-profile.mjs';
import { parseLifecycleRoutes } from '../network/lifecycle-host-dispatch.mjs';
import { openLifecycleJournal } from '../network/deployment-lifecycle-journal.mjs';
import { validateHostRegistryArtifact, HOST_REGISTRY_PROFILE, HOST_REGISTRY_ARTIFACT_SHA256 } from '../network/lifecycle-host-registry-profile.mjs';
import { generateHostRegistryCandidate, SCHEMA3_ADAPTER_SHA256 } from '../src-tools/generate-lifecycle-host-registry-adapter-candidate.mjs';
import { generateHostRegistryHostFiles, HOST_INPUT_SHA256 } from '../src-tools/generate-lifecycle-host-registry-host-candidate.mjs';
import { fixture, route, PLATFORM } from './helpers/host-fixture.mjs';
useAnvil();

const ROOT = new URL('..', import.meta.url).pathname, rd = f => fs.readFileSync(path.join(ROOT, f));
const HCOMP = '/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/unified-funding-20261028/lifecycle-schema3-host-composition-r1/src/network';
const sha = b => createHash('sha256').update(b).digest('hex');
const clone = o => JSON.parse(JSON.stringify(o));

async function setup(t) {
  const w = await worldHR({ payout: 'owner' }); await step(w, 'queued', 'TEST initial enrollment'); await mine();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostreg-composed-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = fixture({ hostId: HOST, state: 'queued', now: chainNow }); f.V.ledger = w.contracts.legacyLedger.toLowerCase();
  f.S.staged = { ready: true, ended: false, instance: 'TEST-i' }; f.S.health = { ready: true, ended: false, instance: 'TEST-i' };
  const R = w.pins.contracts.registry;
  const hr = { hostRegistry: R.address.toLowerCase(), hostRegistryCodeHash: R.codeHash, hostRegistryArtifactSha256: HOST_REGISTRY_ARTIFACT_SHA256 };
  const routes = [route(w.id, { oldLedger: f.V.ledger, newLedger: w.contracts.ledger.toLowerCase(), controller: w.contracts.lifecycle.toLowerCase(),
    lifecycleSchema: 3, profile: HOST_REGISTRY_PROFILE, bundleSha256: w.adapter().bundleSha256, ...hr,
    ledgerCodeHash: w.pins.contracts.ledger.codeHash, controllerCodeHash: w.pins.contracts.lifecycle.codeHash })];
  const file = path.join(dir, 'journal.json');
  const compose = async (over = {}) => {
    const journal = openLifecycleJournal(file), c = composeIndependentLifecycle({ adapter: w.adapter(), adapterPins: w.pins, runtime: f.runtime, journal,
      inventory: f.inventory, routes, platformWallets: [PLATFORM], capacityHeadroom: 0, verifyQuiescence: f.verifyQuiescence, now: chainNow, ...over });
    c.dispatch.attach(f.hostView(HOST)); await c.dispatch.activate(); return { c, journal };
  };
  return { w, f, routes, compose, ...await compose() };
}
async function until(dispatch, id, wanted) {
  let last;
  for (let i = 0; i < 6; i++) { last = await dispatch.reconcile(id); if (last.status === wanted) return last; await mine(); }
  assert.fail(`expected ${wanted}: ${JSON.stringify(last)}`);
}

// ---- 1-3: provenance and generators (pure; inputs pinned) ----------------------------------------------------------------------
test('artifact: exact reviewed runtime/creation/ABI/settings/source provenance; any byte or source drift refuses', () => {
  const bytes = rd('deploy/lifecycle/host-registry/EnclaveHostLifecycleRegistry.json'), src = rd('deploy/lifecycle/host-registry/EnclaveHostLifecycleRegistry.sol');
  const a = validateHostRegistryArtifact(bytes, { sourceBytes: src });
  assert.equal(a.artifactSha256, HOST_REGISTRY_ARTIFACT_SHA256); assert.equal((a.runtime.length - 2) / 2, 23968); assert.equal((a.creation.length - 2) / 2, 23994);
  assert.ok(!a.abi.some(x => x.type === 'constructor')); assert.ok(!a.abi.some(x => x.name === 'heartbeat'));
  const m = Buffer.from(bytes); m[m.length - 3] ^= 1; assert.throws(() => validateHostRegistryArtifact(m), /not the pinned/);
  assert.throws(() => validateHostRegistryArtifact(bytes, { sourceBytes: Buffer.concat([src, Buffer.from('\n')]) }), /not the qualified/);
});
test('generators: schema3 adapter 07d02fca and the three Host files are restored byte for byte; overlays are exactly the generated outputs', () => {
  const input = rd('test/inputs/schema3-adapter.mjs').toString('utf8');
  assert.equal(sha(input), SCHEMA3_ADAPTER_SHA256);
  const g = generateHostRegistryCandidate(input);
  assert.equal(g.source, rd('network/deployment-chain-adapter.mjs').toString('utf8'));
  assert.throws(() => generateHostRegistryCandidate(g.source), /is not the pinned/);
  assert.throws(() => generateHostRegistryCandidate(input.replace('S3', 'S4')), /is not the pinned/);
  const inputs = Object.fromEntries(Object.keys(HOST_INPUT_SHA256).map(f => [f, fs.readFileSync(path.join(HCOMP, f), 'utf8')]));
  for (const [f, r] of Object.entries(generateHostRegistryHostFiles(inputs))) {
    assert.equal(r.baselineSha256, HOST_INPUT_SHA256[f]); assert.equal(r.source, rd(`network/${f}`).toString('utf8'), f);
  }
});
test('Host profile helper: existing profiles unchanged; exact new profile; no schema>= or wrong-profile fallback', () => {
  assert.deepEqual(hostProfile('independent-r1'), { profile: 'independent-r1', lifecycleSchema: 2 });
  assert.deepEqual(Object.keys(hostProfile(SCHEMA3_HOST_PROFILE)), ['profile', 'lifecycleSchema', 'lifecycleProofSchema', 'bundleSha256']);
  const p = hostProfile(HOST_REGISTRY_PROFILE);
  assert.equal(p.lifecycleSchema, 3); assert.equal(p.lifecycleProofSchema, 2); assert.equal(p.hostRegistryArtifactSha256, HOST_REGISTRY_ARTIFACT_SHA256);
  assert.throws(() => hostProfile('independent-host-registry-r2'), /unsupported/);
  const b = { ledger: '0x' + 'e2'.repeat(20), controller: '0x' + 'c7'.repeat(20), deploymentsSchema: 17, lifecycleSchema: 3, ledgerCodeHash: '0x' + '11'.repeat(32),
    controllerCodeHash: '0x' + '22'.repeat(32), profile: HOST_REGISTRY_PROFILE, bundleSha256: p.bundleSha256, hostRegistry: '0x' + 'ab'.repeat(20),
    hostRegistryCodeHash: '0x' + '33'.repeat(32), hostRegistryArtifactSha256: HOST_REGISTRY_ARTIFACT_SHA256 };
  assert.equal(schema3Binding(b), true);
  assert.throws(() => schema3Binding({ ...b, lifecycleSchema: 4 }), /schema3/);
  assert.throws(() => schema3Binding({ ...b, hostRegistryArtifactSha256: '0'.repeat(64) }), /exact registry/);
  const r = { deployment: '0x' + '44'.repeat(32), oldLedger: '0x' + 'd0'.repeat(20), newLedger: b.ledger, controller: b.controller, deploymentsSchema: 17, lifecycleSchema: 3,
    ledgerCodeHash: b.ledgerCodeHash, controllerCodeHash: b.controllerCodeHash, quiescenceDigest: '0x' + '55'.repeat(32), profile: b.profile, bundleSha256: b.bundleSha256,
    hostRegistry: b.hostRegistry, hostRegistryCodeHash: b.hostRegistryCodeHash, hostRegistryArtifactSha256: HOST_REGISTRY_ARTIFACT_SHA256 };
  assert.equal(parseLifecycleRoutes([r], b).size, 1);
  assert.throws(() => parseLifecycleRoutes([{ ...r, hostRegistry: '0x' + 'cd'.repeat(20) }], b), /host registry identity/);
  const { hostRegistry: _a, hostRegistryCodeHash: _b, hostRegistryArtifactSha256: _c, ...schema3Route } = r;
  assert.throws(() => parseLifecycleRoutes([{ ...schema3Route, profile: SCHEMA3_HOST_PROFILE }], b), /missing|differs/);
});

// ---- 4-11: actual local EVM --------------------------------------------------------------------------------------------------------
test('actual enrollment: one canonical registry is registry AND hostOwnership; Online/generation/qualification/owner/reporters at ONE block', async () => {
  const w = await worldHR(), a = w.adapter(), s = await a.read(w.id);
  assert.equal(a.profile, HOST_REGISTRY_PROFILE); assert.equal(a.hostRegistry.runtimeCodeHash, REG.runtimeCodeHash);
  assert.equal(await codeHash(w.contracts.registry), REG.runtimeCodeHash);
  assert.equal(s.profile, HOST_REGISTRY_PROFILE); assert.equal(s.lifecycleSchema, 3); assert.equal(s.lifecycleProofSchema, 2); assert.equal(s.verified, true);
  const L = s.hostLifecycle;
  assert.equal(L.status, 'online'); assert.equal(L.generation, 1); assert.equal(L.qualificationDigest, w.enrollment.qualificationDigest.toLowerCase());
  assert.equal(L.owner, w.hostOwner.address.toLowerCase()); assert.equal(L.revision, '1'); assert.deepEqual(L.reporters.keys, w.reporters.map(x => x.address.toLowerCase()));
  assert.equal(s.hostAuthority.owner, L.owner); assert.equal(s.host.active, true); assert.equal(s.admitted, true);
  // same block: the exposed tuple IS the registry's authority at the snapshot block
  const [owner, , revision] = await S.pub.readContract({ address: w.contracts.registry, abi: RA, functionName: 'authority', args: [HOST], blockNumber: BigInt(s.blockNumber) });
  assert.equal(owner.toLowerCase(), L.owner); assert.equal(revision, 1n);
  assert.notEqual(getAddress(w.hostOwner.address), getAddress(w.operator.address)); assert.notEqual(getAddress(w.payer.address), getAddress(w.hostOwner.address));
});
test('composer start, serve and owner stop persist in the real journal across reopen (host-registry profile)', async t => {
  const { w, f, c, journal, compose } = await setup(t), before = w.sent.length;
  await until(c.dispatch, w.id, 'running'); assert.equal(w.sent.length, before + 1); assert.ok(f.calls.serve.length > 0);
  assert.equal(journal.readHostAuthority(HOST).floor.owner, w.hostOwner.address.toLowerCase());
  const priorServe = f.calls.serve.length; await c.dispatch.restrict(w.id, 'TEST local owner stops service');
  await until(c.dispatch, w.id, 'queued'); assert.equal(f.calls.serve.length, priorServe);
  const reopened = await compose(); await reopened.c.dispatch.reconcile(w.id);
  assert.equal(f.calls.serve.length, priorServe); assert.equal(w.sent.length, before + 2, 'one start and one revoke, no restart replay');
});
test('mined start with lost reply reconciles after composer restart without resending (host-registry profile)', async t => {
  const { w, f, c, journal, compose } = await setup(t), before = w.sent.length; w.loseResponse = true;
  await c.dispatch.reconcile(w.id); assert.equal(w.sent.length, before + 1); assert.ok(journal.read(w.id).pending);
  await mine(); w.loseResponse = false; const reopened = await compose();
  await until(reopened.c.dispatch, w.id, 'running'); assert.equal(w.sent.length, before + 1); assert.ok(f.calls.serve.length > 0);
});
test('canonical Offline by the accepted owner with the operator absent: no new start/serving; owner stop and reconciliation remain', async t => {
  const { w, f, c } = await setup(t); await until(c.dispatch, w.id, 'running');
  await ownerOffline(w); await mine();                                           // operator key never used
  const priorServe = f.calls.serve.length;
  for (let i = 0; i < 4; i++) { await c.dispatch.reconcile(w.id); await mine(); }
  assert.equal(f.calls.serve.length, priorServe, 'no serving after canonical Offline');
  const a = w.adapter(), s = await a.read(w.id);
  assert.equal(s.hostLifecycle.status, 'offline'); assert.equal(s.host.active, false); assert.equal(s.admitted, false);
  const d = await createSnapshotHostAdmission({ hostId: HOST, profile: HOST_REGISTRY_PROFILE, now: chainNow }).decision(w.id, s);
  assert.match(d.refusal, /canonical host registry is offline/);
  await assert.rejects(a.prepare(w.id, s, 'running', 'TEST start while Offline'));
  if (Number((await w.assignment())[1]) === 2) { await step(w, 'queued', 'TEST deployment owner stops'); assert.equal(Number((await w.assignment())[1]), 1); }
  assert.notEqual(Number((await w.assignment())[1]), 2, 'the deployment is not left running on an Offline host');
});
test('reporter quorum Offline despite failed operator; old quorum after policy change and old owner after transfer are rejected', async () => {
  const w = await worldHR();
  await tx(w.hostOwner, w.contracts.registry, RA, 'setHostPolicy', [HOST, w.policy(w.reporters2), ZERO32]);     // revision 2
  await assert.rejects(quorumOffline(w, w.reporters.slice(0, 2)), 'old reporters at the current revision');
  await assert.rejects(quorumOffline(w, w.reporters.slice(0, 2), { authorityRevision: 1n }), 'old reporters at the old revision');
  await tx(w.hostOwner, w.contracts.registry, RA, 'proposeHostOwner', [HOST, w.nextOwner.address]);
  await tx(w.nextOwner, w.contracts.registry, RA, 'acceptHostOwner', [HOST, w.policy(w.reporters), ZERO32]);    // revision 3, quorum A again
  await assert.rejects(ownerOffline(w, w.hostOwner), 'previous owner cannot deactivate');
  await assert.rejects(quorumOffline(w, w.reporters2.slice(0, 2)), 'revision-2 quorum after the owner change');
  await assert.rejects(quorumOffline(w, w.reporters.slice(0, 1)), 'below threshold');
  await quorumOffline(w, w.reporters.slice(0, 2)); await mine();
  const s = await w.adapter().read(w.id);
  assert.equal(s.hostLifecycle.status, 'offline'); assert.equal(s.hostLifecycle.owner, w.nextOwner.address.toLowerCase()); assert.equal(s.hostLifecycle.revision, '3');
  assert.equal(s.hostAuthority.owner, w.nextOwner.address.toLowerCase()); assert.equal(s.admitted, false);
});
test('no legacy heartbeat/reactivation: metadata edits keep Offline; only a new qualified generation returns Online', async () => {
  const w = await worldHR(); await quorumOffline(w); await mine();
  for (const sig of ['heartbeat(bytes32)', 'register(string,string,bytes32)', 'setActive(bytes32,bool)'])
    await assert.rejects(send(w.operator, { to: w.contracts.registry, data: toFunctionSelector(sig) + HOST.slice(2) }), sig);
  await tx(w.operator, w.contracts.registry, RA, 'setPrices', [HOST, 11n, 0n]);
  await tx(w.operator, w.contracts.registry, RA, 'setCaps', [HOST, 1n, 'test2']);
  assert.equal(Number((await reg(w, 'hostState', [HOST]))[1]), 2); assert.equal((await reg(w, 'get', [HOST])).active, false);
  const s1 = await w.adapter().read(w.id); assert.equal(s1.hostLifecycle.status, 'offline'); assert.equal(s1.admitted, false);
  await assert.rejects(quorumOffline(w, w.reporters.slice(0, 2), { evidenceDigest: keccak256(toBytes('TEST other evidence')) }), 'a second Offline digest is not a transition');
  await recoverHost(w); await mine();
  const s2 = await w.adapter().read(w.id);
  assert.equal(s2.hostLifecycle.status, 'online'); assert.equal(s2.hostLifecycle.generation, 2); assert.equal(s2.admitted, true);
  assert.notEqual(s2.hostLifecycle.qualificationDigest, s1.hostLifecycle.qualificationDigest);
  await assert.rejects(quorumOffline(w, w.reporters.slice(0, 2), { generation: 1n }), 'stale generation');
});
test('pin refusals: separate (even internally consistent) ownership registry, wrong code/artifact, wrong composer profile', async t => {
  const { w, routes, compose } = await setup(t);
  const second = await deployRegistry(w.admin), pins = clone(w.pins);
  pins.contracts.hostOwnership = { address: second, codeHash: await codeHash(second) };          // same runtime hash, different contract
  assert.equal(pins.contracts.hostOwnership.codeHash, w.pins.contracts.registry.codeHash);
  assert.throws(() => w.adapter({ pins }), /SAME canonical host registry/);
  const bad = clone(w.pins); bad.contracts.registry.codeHash = bad.contracts.hostOwnership.codeHash = '0x' + '77'.repeat(32);
  assert.throws(() => w.adapter({ pins: bad }), /not the reviewed EnclaveHostLifecycleRegistry runtime/);
  assert.throws(() => w.adapter({ pins: { ...clone(w.pins), hostRegistry: { artifactSha256: '0'.repeat(64) } } }), /pins.hostRegistry/);
  assert.throws(() => w.adapter({ pins: { ...clone(w.pins), hostRegistry: undefined } }), /pins.hostRegistry/);
  await assert.rejects(compose({ adapterPins: pins }), /hostOwnership/);
  await assert.rejects(compose({ adapterPins: { ...clone(w.pins), profile: SCHEMA3_HOST_PROFILE } }), /adapter.profile/);
  const { hostRegistry: _x, ...noIdentity } = routes[0];
  await assert.rejects(compose({ routes: [noIdentity] }), /missing/);
});
test('same-block refusals: a block before the registry existed or a stale runtime pin is unknown state, never allow', async () => {
  const w = await worldHR();
  w.auth.pin = w.beforeRegistry; await assert.rejects(w.adapter().read(w.id)); w.auth.pin = null;
  const stale = clone(w.pins); stale.contracts.ledger.codeHash = '0x' + '66'.repeat(32);
  assert.throws(() => w.adapter({ pins: stale }));
  const s = await w.adapter().read(w.id); assert.equal(s.verified, true);
  assert.equal((await offlineIntent(w)).generation, 1n);
});
