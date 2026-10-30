// host-registry r2 + host-authority completion r2 (AUTHORED, NOT RUN): ACTUAL EnclaveHostLifecycleRegistry (reviewed artifact, normal
// constructor, qualified zero-ETH enrollment) + actual schema3 ledger/library/controller/prover + the FINAL LAYERED adapter (root r3
// b648a3ed + host-authority permit second stage) + the FINAL dispatch (root r3 9a155041 + completion r2 stage) + composer + owned journal
// with the repaired durable incarnation section + the REAL v2 runtime/gate/witness/collector (test/helpers/real-v2-host.mjs), on owned
// Anvil 8453. TEST fixtures: manager/plans/readiness/boundary acks, witness transport, closure doubles, finality authority, receipts.
// This does NOT establish real Host isolation, production hardware enforcement, positive Base authority, real qualification verifiers,
// an independent Offline submitter or production migration.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { toFunctionSelector, getAddress, keccak256, toBytes, decodeFunctionData } from 'viem';
import { useAnvil, mine, warp, HOST, chainNow, send, tx, step, codeHash, ZERO32, S } from './fixtures/r5-world.mjs';
import { worldHR, reg, RA, REG, deployRegistry, ownerOffline, quorumOffline, offlineIntent, recoverHost, fund } from './fixtures/host-registry-world.mjs';
import { composeIndependentLifecycle, createSnapshotHostAdmission } from '../network/lifecycle-host-authority.mjs';
import { hostProfile, schema3Binding, SCHEMA3_HOST_PROFILE, exactUint64, hostIncarnationOf } from '../network/lifecycle-host-profile.mjs';
import { parseLifecycleRoutes } from '../network/lifecycle-host-dispatch.mjs';
import { openLifecycleJournal } from '../network/deployment-lifecycle-journal.mjs';
import { withHostIncarnationJournal, hostIncarnationSection } from '../network/lifecycle-host-incarnation-journal.mjs';
import { validateHostRegistryArtifact, HOST_REGISTRY_PROFILE, HOST_REGISTRY_ARTIFACT_SHA256 } from '../network/lifecycle-host-registry-profile.mjs';
import { generateHostRegistryCandidate, SCHEMA3_ADAPTER_SHA256 } from '../src-tools/generate-lifecycle-host-registry-adapter-candidate.mjs';
import { generateHostRegistryHostFiles, HOST_INPUT_SHA256, MARKER } from '../src-tools/generate-lifecycle-host-registry-host-candidate.mjs';
import { generateHostAuthorityPermitFiles, INPUT_SHA256 as PERMIT_INPUTS, MARKER as PERMIT_MARKER } from '../src-tools/generate-host-authority-permit-candidates.mjs';
import { generateHostAuthorityDispatch, MARKER as DISPATCH_MARKER } from '../src-tools/generate-host-authority-dispatch-candidate.mjs';
import { fixture, route, PLATFORM } from './helpers/host-fixture.mjs';
import { realV2Host } from './helpers/real-v2-host.mjs';
import { L3 } from './fixtures/schema3-world.mjs';
useAnvil();

const ROOT = new URL('..', import.meta.url).pathname, rd = f => fs.readFileSync(path.join(ROOT, f));
const HCOMP = '/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/unified-funding-20261028/lifecycle-schema3-host-composition-r1/src/network';
const sha = b => createHash('sha256').update(b).digest('hex');
const clone = o => JSON.parse(JSON.stringify(o));
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hostreg-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

async function setup(t) {
  const w = await worldHR({ payout: 'owner' }); await step(w, 'queued', 'TEST initial enrollment'); await mine();
  const dir = tmp(t);
  const f = fixture({ hostId: HOST, state: 'queued', now: chainNow }); f.V.ledger = w.contracts.legacyLedger.toLowerCase();
  const v2 = realV2Host(w, { dir, host: HOST, now: chainNow });
  const R = w.pins.contracts.registry;
  const hr = { hostRegistry: R.address.toLowerCase(), hostRegistryCodeHash: R.codeHash, hostRegistryArtifactSha256: HOST_REGISTRY_ARTIFACT_SHA256 };
  const routes = [route(w.id, { oldLedger: f.V.ledger, newLedger: w.contracts.ledger.toLowerCase(), controller: w.contracts.lifecycle.toLowerCase(),
    lifecycleSchema: 3, profile: HOST_REGISTRY_PROFILE, bundleSha256: w.adapter().bundleSha256, ...hr,
    ledgerCodeHash: w.pins.contracts.ledger.codeHash, controllerCodeHash: w.pins.contracts.lifecycle.codeHash })];
  const file = path.join(dir, 'journal.json'), incFile = path.join(dir, 'host-incarnation.json');
  const compose = async (over = {}) => {   // a fresh process view over the SAME durable files (restart); manager VMs persist
    const journal = withHostIncarnationJournal(openLifecycleJournal(file), incFile);
    const c = composeIndependentLifecycle({ adapter: w.adapter(), adapterPins: w.pins, runtime: v2.runtimeFor(journal), journal,
      inventory: v2.inventory, routes, platformWallets: [PLATFORM], capacityHeadroom: 0, verifyQuiescence: f.verifyQuiescence, now: chainNow, ...over });
    c.dispatch.attach(f.hostView(HOST)); await c.dispatch.activate(); return { c, journal };
  };
  return { w, f: { ...f, calls: v2.calls }, v2, routes, compose, ...await compose() };
}
async function until(dispatch, id, wanted, n = 8) {
  let last;
  for (let i = 0; i < n; i++) { last = await dispatch.reconcile(id); if (last.status === wanted) return last; await mine(); }
  assert.fail(`expected ${wanted}: ${JSON.stringify(last)}`);
}
const settle = async (d, id, n = 3) => { let r; for (let i = 0; i < n; i++) { r = await d.reconcile(id); await mine(); } return r; };

// ---- 1-3: provenance and generators (pure; inputs pinned) ----------------------------------------------------------------------
test('artifact: exact reviewed runtime/creation/ABI/settings/source provenance; any byte or source drift refuses', () => {
  const bytes = rd('deploy/lifecycle/host-registry/EnclaveHostLifecycleRegistry.json'), src = rd('deploy/lifecycle/host-registry/EnclaveHostLifecycleRegistry.sol');
  const a = validateHostRegistryArtifact(bytes, { sourceBytes: src });
  assert.equal(a.artifactSha256, HOST_REGISTRY_ARTIFACT_SHA256); assert.equal((a.runtime.length - 2) / 2, 23968); assert.equal((a.creation.length - 2) / 2, 23994);
  assert.ok(!a.abi.some(x => x.type === 'constructor')); assert.ok(!a.abi.some(x => x.name === 'heartbeat' || x.name === 'registry'));
  const m = Buffer.from(bytes); m[m.length - 3] ^= 1; assert.throws(() => validateHostRegistryArtifact(m), /not the pinned/);
  assert.throws(() => validateHostRegistryArtifact(bytes, { sourceBytes: Buffer.concat([src, Buffer.from('\n')]) }), /not the qualified/);
});
test('generators: BOTH layers reproduce the final adapter and dispatch byte for byte; inputs pinned, markers present, no double application', () => {
  const input = rd('test/inputs/schema3-adapter.mjs').toString('utf8');
  assert.equal(sha(input), SCHEMA3_ADAPTER_SHA256);
  const g1 = generateHostRegistryCandidate(input);                                     // layer 1: root r3 canonical-registry adapter (b648a3ed)
  assert.equal(sha(g1.source), PERMIT_INPUTS['deployment-chain-adapter.mjs']);
  assert.throws(() => generateHostRegistryCandidate(g1.source), /is not the pinned/);
  const base = Object.fromEntries(Object.keys(PERMIT_INPUTS).filter(f => f !== 'deployment-chain-adapter.mjs').map(f => [f, rd(`test/inputs/permit-base/${f}`).toString('utf8')]));
  const g2 = generateHostAuthorityPermitFiles({ ...base, 'deployment-chain-adapter.mjs': g1.source });   // layer 2: host-authority permit
  for (const [f, r] of Object.entries(g2)) { assert.equal(r.baselineSha256, PERMIT_INPUTS[f]); assert.ok(r.source.includes(PERMIT_MARKER), f); assert.equal(r.source, rd(`network/${f}`).toString('utf8'), f); }
  assert.throws(() => generateHostAuthorityPermitFiles({ ...base, 'deployment-chain-adapter.mjs': g2['deployment-chain-adapter.mjs'].source }), /is not the pinned/);
  const inputs = Object.fromEntries(Object.keys(HOST_INPUT_SHA256).map(f => [f, fs.readFileSync(path.join(HCOMP, f), 'utf8')]));
  for (const [f, h] of Object.entries(HOST_INPUT_SHA256)) { assert.match(h, /^[0-9a-f]{64}$/); assert.equal(sha(inputs[f]), h, f); assert.ok(!inputs[f].includes(MARKER)); }
  const host = generateHostRegistryHostFiles(inputs);                                    // root r3 corrected host generator 7073e59c
  for (const f of ['lifecycle-host-authority.mjs', 'lifecycle-host-profile.mjs']) assert.equal(host[f].source, rd(`network/${f}`).toString('utf8'), f);
  const d = generateHostAuthorityDispatch(host['lifecycle-host-dispatch.mjs'].source);  // completion r2 dispatch stage over root's output
  assert.ok(d.source.includes(DISPATCH_MARKER)); assert.equal(d.source, rd('network/lifecycle-host-dispatch.mjs').toString('utf8'));
  assert.throws(() => generateHostAuthorityDispatch(d.source), /is not the pinned/);
});
test('Host profile helper: existing profiles unchanged; exact new profile and exact uint64 host generation', () => {
  assert.deepEqual(hostProfile('independent-r1'), { profile: 'independent-r1', lifecycleSchema: 2 });
  assert.deepEqual(Object.keys(hostProfile(SCHEMA3_HOST_PROFILE)), ['profile', 'lifecycleSchema', 'lifecycleProofSchema', 'bundleSha256']);
  const p = hostProfile(HOST_REGISTRY_PROFILE);
  assert.equal(p.lifecycleSchema, 3); assert.equal(p.lifecycleProofSchema, 2); assert.equal(p.hostRegistryArtifactSha256, HOST_REGISTRY_ARTIFACT_SHA256);
  assert.throws(() => hostProfile('independent-host-registry-r2'), /unsupported/);
  assert.equal(exactUint64('18446744073709551615', 'g'), '18446744073709551615');
  assert.throws(() => exactUint64('18446744073709551616', 'g'), /outside uint64/); assert.throws(() => exactUint64(2 ** 53, 'g'), /exact integer/);
  assert.throws(() => exactUint64(1.5, 'g')); assert.throws(() => exactUint64('01', 'g'));
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

// ---- 4-16: actual local EVM, final layered adapter, real v2 runtime --------------------------------------------------------------
test('actual enrollment at 0 wei for operator and owner; one canonical registry is registry AND hostOwnership at ONE block', async () => {
  const w = await worldHR(), a = w.adapter(), s = await a.read(w.id);
  assert.deepEqual(w.zeroEth, { before: { operator: 0n, owner: 0n }, after: { operator: 0n, owner: 0n } });
  assert.equal(a.profile, HOST_REGISTRY_PROFILE); assert.equal(a.hostRegistry.runtimeCodeHash, REG.runtimeCodeHash);
  assert.equal(await codeHash(w.contracts.registry), REG.runtimeCodeHash);
  assert.equal(s.profile, HOST_REGISTRY_PROFILE); assert.equal(s.lifecycleSchema, 3); assert.equal(s.lifecycleProofSchema, 2); assert.equal(s.verified, true);
  const L = s.hostLifecycle;
  assert.equal(L.verified, undefined, 'no nested authority claim'); assert.equal(L.codeConsistent, true);
  assert.equal(L.status, 'online'); assert.equal(L.generation, '1'); assert.equal(L.qualificationDigest, w.enrollment.qualificationDigest.toLowerCase());
  assert.equal(L.owner, w.hostOwner.address.toLowerCase()); assert.equal(L.revision, '1'); assert.deepEqual(L.reporters.keys, w.reporters.map(x => x.address.toLowerCase()));
  assert.equal(s.hostAuthority.owner, L.owner); assert.equal(s.host.active, true); assert.equal(s.admitted, true);
  assert.equal(s.hostAuthorityEvidence.blockHash, s.blockHash.toLowerCase()); assert.equal(s.hostAuthorityEvidence.blockNumber, String(s.blockNumber));
  const [owner, , revision] = await S.pub.readContract({ address: w.contracts.registry, abi: RA, functionName: 'authority', args: [HOST], blockNumber: BigInt(s.blockNumber) });
  assert.equal(owner.toLowerCase(), L.owner); assert.equal(revision, 1n);
  assert.notEqual(getAddress(w.hostOwner.address), getAddress(w.operator.address)); assert.notEqual(getAddress(w.payer.address), getAddress(w.hostOwner.address));
});
test('composer start through the REAL v2 runtime: signed permit grant from the actual adapter snapshot; owner stop persists across reopen', async t => {
  const { w, f, v2, c, journal, compose } = await setup(t), before = w.sent.length;
  await until(c.dispatch, w.id, 'running'); assert.equal(w.sent.length, before + 1); assert.ok(f.calls.serve.length > 0);
  const grant = f.calls.allow.at(-1), current = (await w.adapter().read(w.id)).hostAuthorityEvidence.context;
  assert.equal(grant.hostAuthority, current.digest, 'the boundary grant is bound to the exact current host authority');
  assert.equal(v2.gate().hostAuthority.read(HOST).bound[w.id].kind, 'fresh-queued-start');
  assert.equal(journal.readHostAuthority(HOST).floor.owner, w.hostOwner.address.toLowerCase());
  const inc = journal.readHostIncarnation(HOST); assert.equal(inc.floor.generation, '1'); assert.equal(inc.bound[w.id].digest, inc.floor.digest);
  const priorServe = f.calls.serve.length; await c.dispatch.restrict(w.id, 'TEST local owner stops service');
  await until(c.dispatch, w.id, 'queued'); assert.equal(f.calls.serve.length, priorServe);
  const reopened = await compose(); await reopened.c.dispatch.reconcile(w.id);
  assert.equal(f.calls.serve.length, priorServe); assert.equal(w.sent.length, before + 2, 'one start and one revoke, no restart replay');
});
test('mined start with lost reply reconciles after composer restart without resending (host-registry profile, real v2 runtime)', async t => {
  const { w, f, c, journal, compose } = await setup(t), before = w.sent.length; w.loseResponse = true;
  await c.dispatch.reconcile(w.id); assert.equal(w.sent.length, before + 1); assert.ok(journal.read(w.id).pending);
  await mine(); w.loseResponse = false; const reopened = await compose();
  await until(reopened.c.dispatch, w.id, 'running'); assert.equal(w.sent.length, before + 1); assert.ok(f.calls.serve.length > 0);
});
test('canonical Offline by the accepted owner: durable same-generation denial in the actual dispatch; a stale Online read never restores', async t => {
  const { w, f, c, journal } = await setup(t); await until(c.dispatch, w.id, 'running');
  const beforeOff = await S.pub.getBlockNumber();
  await ownerOffline(w); await mine();                                           // operator key never used
  const priorServe = f.calls.serve.length;
  await settle(c.dispatch, w.id, 4);
  assert.equal(f.calls.serve.length, priorServe, 'no serving after canonical Offline');
  assert.equal(journal.readHostIncarnation(HOST).floor.offline.generation, '1', 'same-generation Offline persisted without an identity increment');
  const a = w.adapter(), s = await a.read(w.id);
  assert.equal(s.hostLifecycle.status, 'offline'); assert.equal(s.host.active, false); assert.equal(s.admitted, false);
  const d = await createSnapshotHostAdmission({ hostId: HOST, profile: HOST_REGISTRY_PROFILE, now: chainNow }).decision(w.id, s);
  assert.match(d.refusal, /canonical host registry is offline/); assert.equal(d.hostIncarnation.generation, '1'); assert.equal(d.hostIncarnation.status, 'offline');
  await assert.rejects(a.prepare(w.id, s, 'running', 'TEST start while Offline'), /offline/);
  w.auth.pin = beforeOff;                                                        // an OLDER Online observation at the same generation
  await c.dispatch.reconcile(w.id); w.auth.pin = null;
  assert.equal(f.calls.serve.length, priorServe); assert.equal(journal.readHostIncarnation(HOST).floor.offline.generation, '1');
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
  await fund(w.operator);                                                       // separately funded for these operator metadata transactions
  for (const sig of ['heartbeat(bytes32)', 'register(string,string,bytes32)', 'setActive(bytes32,bool)'])
    await assert.rejects(send(w.operator, { to: w.contracts.registry, data: toFunctionSelector(sig) + HOST.slice(2) }), sig);
  await tx(w.operator, w.contracts.registry, RA, 'setPrices', [HOST, 11n, 0n]);
  await tx(w.operator, w.contracts.registry, RA, 'setCaps', [HOST, 1n, 'test2']);
  assert.equal(Number((await reg(w, 'hostState', [HOST]))[1]), 2); assert.equal((await reg(w, 'get', [HOST])).active, false);
  const s1 = await w.adapter().read(w.id); assert.equal(s1.hostLifecycle.status, 'offline'); assert.equal(s1.admitted, false);
  await assert.rejects(quorumOffline(w, w.reporters.slice(0, 2), { evidenceDigest: keccak256(toBytes('TEST other evidence')) }), 'a second Offline digest is not a transition');
  await recoverHost(w); await mine();
  const s2 = await w.adapter().read(w.id);
  assert.equal(s2.hostLifecycle.status, 'online'); assert.equal(s2.hostLifecycle.generation, '2'); assert.equal(s2.admitted, true);
  assert.notEqual(s2.hostLifecycle.qualificationDigest, s1.hostLifecycle.qualificationDigest);
  await assert.rejects(quorumOffline(w, w.reporters.slice(0, 2), { generation: 1n }), 'stale generation');
});
test('pin refusals: separate (even internally consistent) ownership registry, wrong code/artifact, wrong composer profile, no durable section', async t => {
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
  await assert.rejects(compose({ journal: openLifecycleJournal(path.join(tmp(t), 'j.json')) }), /durable host incarnation/);
});
test('same block and authority: no nested verified for rpc-quorum; pre-registry block and stale runtime pin are unknown', async () => {
  const w = await worldHR();
  w.auth.pin = w.beforeRegistry; await assert.rejects(w.adapter().read(w.id)); w.auth.pin = null;
  const stale = clone(w.pins); stale.contracts.ledger.codeHash = '0x' + '66'.repeat(32);
  assert.throws(() => w.adapter({ pins: stale }));
  const q = await w.adapter({ kind: 'rpc-quorum' }).read(w.id);
  assert.equal(q.verified, false); assert.equal(q.hostLifecycle.verified, undefined); assert.equal(q.hostLifecycle.codeConsistent, true);
  assert.equal(q.hostAuthorityEvidence.proofVerified, false, 'code-consistent but chain-unqualified evidence carries no authority');
  await assert.rejects(createSnapshotHostAdmission({ hostId: HOST, profile: HOST_REGISTRY_PROFILE, now: chainNow }).decision(w.id, q));
  assert.equal((await offlineIntent(w)).generation, 1n);
});
test('missed Offline: old context fenced durably; unknown cannot rebind; explicit adoption -> v2 gate handoff -> authorized queued transition -> fresh start serves', async t => {
  const { w, f, v2, c, journal, compose } = await setup(t); await until(c.dispatch, w.id, 'running');
  const served = f.calls.serve.length, sent = w.sent.length;
  await quorumOffline(w); await recoverHost(w); await mine();                   // Offline is never observed by this host
  await settle(c.dispatch, w.id);
  assert.equal(f.calls.serve.length, served, 'the old app context is not served under the recovered generation');
  const st = journal.readHostIncarnation(HOST);
  assert.equal(st.floor.generation, '2'); assert.equal(st.bound[w.id].generation, '1'); const decoded = w.sent.slice(sent).map(t => ({ to: t.to.toLowerCase(), ...decodeFunctionData({ abi: L3.LIFECYCLE, data: t.data }) }));
  assert.equal(decoded.length, 1, 'exactly one revocation transition');
  assert.equal(decoded[0].to, w.contracts.lifecycle.toLowerCase());
  assert.equal(decoded[0].functionName, 'transition');
  assert.equal(decoded[0].args[0].id, w.id);
  assert.equal(decoded[0].args[0].target, 1, 'Queued revocation is allowed; no Running effect');
  assert.equal(Number((await w.assignment())[1]), 1, 'actual chain assignment is Queued');
  const r1 = await compose(); await settle(r1.c.dispatch, w.id);                // restart: the durable binding still fences
  assert.equal(f.calls.serve.length, served); assert.equal(r1.journal.readHostIncarnation(HOST).bound[w.id].generation, '1');
  w.auth.pin = w.beforeRegistry;                                                // unknown chain state: reads fail
  await r1.c.dispatch.reconcile(w.id);
  await assert.rejects(r1.c.dispatch.adoptHostIncarnation(w.id, { generation: '2', digest: st.floor.digest }), 'adoption needs its own fresh read');
  assert.notEqual(r1.c.dispatch.ingressRefusal(w.id), null);
  w.auth.pin = null;
  assert.equal(r1.journal.readHostIncarnation(HOST).bound[w.id].generation, '1', 'unknown never clears or rebinds');
  await assert.rejects(r1.c.dispatch.adoptHostIncarnation(w.id, { generation: '1', digest: st.bound[w.id].digest }), /exact current/);
  await assert.rejects(r1.c.dispatch.adoptHostIncarnation(w.id, { generation: 2, digest: st.floor.digest }), /exact current/);
  const ok = await r1.c.dispatch.adoptHostIncarnation(w.id, { generation: '2', digest: st.floor.digest });
  assert.equal(ok.generation, '2'); assert.equal(v2.vms.has(w.id), false, 'old runtime removed by the confirmed stop');
  assert.equal(v2.gate().hostAuthority.read(HOST).bound[w.id].kind, 'explicit-adoption', 'v2 gate handoff under the adoption\'s final fresh read');
  assert.equal(r1.journal.readHostIncarnation(HOST).bound[w.id].requeue, true);
  const restart = r1.journal.decision(w.id, chainNow()), assignment = (await w.adapter().read(w.id)).assignment;
  assert.equal(assignment.crashHeld, false, 'no owner resume bypass');
  const nextAt = Math.max(restart.nextAt ?? 0, assignment.startAfter ?? 0);
  assert.ok(Number.isSafeInteger(nextAt));
  console.log('ROOT policy-clock evidence', JSON.stringify({restart,assignment,now:chainNow(),nextAt}));
  const waitMs = Math.max(0, nextAt-chainNow()+1000);
  assert.ok(waitMs <= 60000, 'bounded actual policy delay');
  await new Promise(resolve=>setTimeout(resolve,waitMs)); await mine(); // real elapsed time preserves permit gate monotonic/wall-clock guard
  await until(r1.c.dispatch, w.id, 'running', 12);
  assert.ok(f.calls.serve.length > served, 'the adopted app makes forward progress and serves again');
  assert.equal(w.sent.length, sent + 2, 'exactly one authorized queued transition and one fresh Running start; nothing invented');
  assert.deepEqual(w.sent.slice(sent).map(t=>decodeFunctionData({abi:L3.LIFECYCLE,data:t.data}).args[0].target), [1,2], 'exact Queued then Running targets');
  const after = r1.journal.readHostIncarnation(HOST).bound[w.id];
  assert.equal(after.generation, '2'); assert.equal(after.requeue, false);
});
test('stale prepared Running refuses at the submit boundary before the sender; the journaled intent is kept, never resent', async t => {
  const { w, f, compose } = await setup(t), base = w.adapter(); let trip = true;
  const adapter = { ...base, async prepare(id, s, target, reason) {
    const i = await base.prepare(id, s, target, reason);
    if (target === 'running' && trip) { trip = false; await ownerOffline(w); await mine(); }   // host goes Offline after preparation
    return i; } };
  const { c, journal } = await compose({ adapter }), before = w.sent.length;
  await c.dispatch.reconcile(w.id);
  assert.equal(w.sent.length, before, 'nothing was broadcast'); const pending = journal.read(w.id).pending; assert.ok(pending);
  await settle(c.dispatch, w.id);
  assert.equal(w.sent.length, before, 'never resent'); assert.equal(journal.read(w.id).pending?.digest ?? pending.digest, pending.digest, 'not overwritten');
  assert.notEqual(Number((await w.assignment())[1]), 2); assert.equal(f.calls.serve.length, 0);
});
test('old-context pending Running transaction resolves canonically without resend after missed Offline, recovery and restart', async t => {
  const { w, f, c, journal, compose } = await setup(t), before = w.sent.length; w.loseResponse = true;
  await c.dispatch.reconcile(w.id); assert.equal(w.sent.length, before + 1); assert.ok(journal.read(w.id).pending); w.loseResponse = false;
  assert.equal(journal.readHostIncarnation(HOST).bound[w.id].generation, '1', 'bound before the effect');
  await quorumOffline(w); await recoverHost(w); await mine();
  const r = await compose(); await settle(r.c.dispatch, w.id, 4);
  assert.equal(w.sent.length, before + 1, 'no resend'); assert.equal(r.journal.read(w.id).pending, null, 'resolved from the canonical receipt');
  assert.equal(Number((await w.assignment())[1]), 2); assert.equal(f.calls.serve.length, 0, 'the generation-1 start is not served under generation 2');
});
test('a current valid Offline needs no fresh qualification; the deployment-owner stop path stays available on an Offline host', async () => {
  const w = await worldHR(); await step(w, 'queued', 'TEST queue'); await warp(7200);   // past the 3600 s qualification expiry
  const s0 = await w.adapter().read(w.id); assert.equal(s0.hostLifecycle.qualificationExpired, true); assert.equal(s0.hostLifecycle.status, 'online');
  await ownerOffline(w); await mine();
  const s1 = await w.adapter().read(w.id); assert.equal(s1.hostLifecycle.status, 'offline'); assert.equal(s1.admitted, false);
  await step(w, 'stopped', 'TEST deployment owner stops on an Offline host'); assert.equal(Number((await w.assignment())[1]), 3);
});
test('durable host incarnation journal: exact uint64, rollback/equivocation refused, binding only to the floor, survives reopen', async t => {
  const file = path.join(tmp(t), 'inc.json'), j = hostIncarnationSection(file);
  const L = (generation, q = '0x' + '61'.repeat(32)) => ({ status: 'online', registry: '0x' + 'ab'.repeat(20), generation, qualificationDigest: q });
  const x = g => hostIncarnationOf(L(g), { hostId: HOST, registryCodeHash: '0x' + '33'.repeat(32) });
  const big = x('18446744073709551614'); j.acceptHostIncarnation(HOST, big);
  assert.equal(j.readHostIncarnation(HOST).floor.generation, '18446744073709551614'); assert.equal(j.readHostIncarnation(HOST).genesis, big.digest);
  assert.throws(() => j.acceptHostIncarnation(HOST, x('5')), /rollback/);
  assert.throws(() => j.acceptHostIncarnation(HOST, hostIncarnationOf(L('18446744073709551614', '0x' + '62'.repeat(32)), { hostId: HOST })), /equivocation/);
  assert.throws(() => j.acceptHostIncarnation(HOST, { ...big, generation: '7' }), /digest/);
  const id = '0x' + '44'.repeat(32);
  assert.throws(() => j.bindHostIncarnation(HOST, id, { generation: '5', digest: x('5').digest, reason: 'x', at: 1 }), /durable current/);
  j.bindHostIncarnation(HOST, id, { generation: big.generation, digest: big.digest, reason: 'TEST', at: 1 });
  const top = x('18446744073709551615'); j.acceptHostIncarnation(HOST, top);
  const again = hostIncarnationSection(file).readHostIncarnation(HOST);                 // reopened from disk
  assert.equal(again.floor.generation, '18446744073709551615'); assert.equal(again.bound[id].generation, '18446744073709551614'); assert.equal(again.genesis, big.digest);
});
