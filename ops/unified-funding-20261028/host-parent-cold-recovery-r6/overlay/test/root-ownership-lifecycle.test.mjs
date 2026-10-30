// ownership r3 suite (AUTHORED, NOT RUN). async r4 UPDATE (only where r3 asserted the old synchronous release object or intent deletion):
// owner release now returns ONE memoized completion promise of { released, fenced, errors } (O1, O2, O3, O5, O8 await it), and a successful
// store/recovery RETAINS the intent next to its matching acknowledgement (O5). Everything else is the r3 file unchanged.
// Runs in the FINAL layered native tree (network/ = generated gate/witness/runtime/serving-permit/
// dispatch + the ownership sidecars, owned-durable-state.mjs, runtime-lock.mjs and lifecycle-host-owned-authority.mjs).
// REAL: generated DeploymentPermitGate / DeploymentLifecycleWitness / createIsolationLifecycleRuntime / serving permit, createPermitCollector,
// the owned protocol journal (openLifecycleJournal), both OWNED durable sidecars over the existing runtime flock, the generated composer and
// the proposed owned composition entry. SYNTHETIC (labelled TEST doubles; no chain, hardware or enforcement evidence): each witness's chain
// reader, readiness, witness transport, manager client, launch plans, boundary hold/allow acks, the canonical-adapter stand-in in O8 and the
// in-memory owned lifecycle journal (test/helpers/ownership-fixture.mjs = candidate test/helpers/lifecycle-fixture.mjs) where noted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createPermitCollector } from '../network/deployment-permit-collector.mjs';
import { DeploymentPermitGate } from '../network/deployment-permit-gate.mjs';
import { createIsolationLifecycleRuntime } from '../network/deployment-isolation-runtime.mjs';
import { openLifecycleJournal } from '../network/deployment-lifecycle-journal.mjs';
import { signServingPermit } from '../network/deployment-serving-permit.mjs';
import { openLockedHostAuthorityJournal } from '../network/deployment-host-authority-journal.mjs';
import { openLockedHostIncarnationJournal } from '../network/lifecycle-host-incarnation-journal.mjs';
import { hostAuthorityContextOf } from '../network/deployment-host-authority.mjs';
import { hostIncarnationOf } from '../network/lifecycle-host-profile.mjs';
import { openOwnedHostRegistryLifecycle, openOwnedHostAuthorityWitness } from '../network/lifecycle-host-owned-authority.mjs';
import { fixture, route, NEW, CTRL as FCTRL, PLATFORM } from './helpers/ownership-fixture.mjs';

const H = b => '0x' + b.repeat(32), A = b => '0x' + b.repeat(20);
const HOST = H('a1'), ID = H('a2'), CTRL = '0x' + 'c7'.repeat(20), REG = A('ab'), CODE = H('23');
const PROFILE = 'independent-host-registry-r1', BUNDLE = 'bed9c19652edce8ca6f337f691a9909c15763e6755ff237139b07f4d84f3260e';
const ARTIFACT = 'e8690734c4fae1f1adfa3525061d5542b314704c997feec2daa09fdecd49f23a';
const PINS = Object.freeze({ chainId: 8453, lifecycle: CTRL, servingPermit: { version: 2, profile: PROFILE } });
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'own-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const tick = () => new Promise(r => setTimeout(r, 20));
const sorted = xs => xs.sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
const reporters = sorted([0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()))).map(a => a.address.toLowerCase());
const hr = (over = {}) => ({ scope: 'host', registry: REG, codeConsistent: true, status: 'online', online: true, generation: '1',
  hardwareId: H('b1'), descriptorDigest: H('b2'), qualificationDigest: H('b3'), resourceDigest: H('b4'), trustAnchorId: H('b5'),
  owner: A('1d'), revision: '1', policyHash: H('55'), reporters: { keys: reporters, threshold: 2, revision: '1' }, ...over });
const ctxOf = over => hostAuthorityContextOf(hr(over), { chainId: 8453, hostId: HOST, registryCodeHash: CODE });
const incOf = (g = '1') => hostIncarnationOf({ registry: REG, status: 'online', generation: g, qualificationDigest: H('c1'), trustAnchorId: H('c2'),
  hardwareId: H('c3'), resourceDigest: H('c4'), descriptorDigest: H('c5') }, { hostId: HOST, registryCodeHash: CODE });
// SYNTHETIC in-memory owned lifecycle journal (host-authority floor + pending rows); its mock incarnation methods are removed so the REAL
// durable incarnation section is the only one (the wrapper refuses a journal that already defines them)
const strip = j => { const { readHostIncarnation, acceptHostIncarnation, bindHostIncarnation, ...rest } = j; return rest; };
const ownedOf = () => strip(fixture({ hostId: HOST }).journal);

// protocol world over OWNED sidecars (real gate/runtime/collector/witnesses; synthetic reader/manager/readiness/boundary)
async function world(t, { now = () => Date.now() } = {}) {
  const dir = tmp(t), operator = privateKeyToAccount(generatePrivateKey());
  const witnesses = sorted([0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey())));
  const policy = { witnesses: witnesses.map(w => w.address), threshold: 3, revision: 1 };
  const S = { ctx: ctxOf(), block: H('e1'), allows: [], healthGate: null };
  const evidence = () => ({ context: S.ctx, status: 'online', blockHash: S.block, blockNumber: '7', proofVerified: true });
  const assignment = id => ({ deployment: id, host: HOST, operator: operator.address, state: 'running', generation: 3, policyRevision: 1, admitted: true, funded: true,
    authorityTier: 'finalized', proofVerified: true, observedAt: Math.floor(now() / 1000), blockTimestamp: Math.floor(now() / 1000), blockHash: S.block });
  const authority = { async read(id) { return { assignment: assignment(id), policy, hostAuthority: evidence(), hostAdmitted: true }; } };    // SYNTHETIC reader
  const health = { async verify(id, host, generation) { if (S.healthGate) await S.healthGate;                                                 // SYNTHETIC readiness
    return { verified: true, deployment: id, host, generation, ready: true, validUntil: Math.floor(now() / 1000) + 60 }; } };
  const W = await Promise.all(witnesses.map((w, i) => openOwnedHostAuthorityWitness({ sidecarFile: path.join(dir, `w${i}-ha.json`), pins: PINS, account: w,
    journal: openLifecycleJournal(path.join(dir, `w${i}.json`)), authority, health, now })));
  t.after(() => W.forEach(x => x.release('TEST teardown')));
  const fetchImpl = async (url, { body }) => { const i = Number(new URL(url).hostname.slice(1, 2)), req = JSON.parse(body);                     // SYNTHETIC transport
    try { return { ok: true, body: [Buffer.from(JSON.stringify(await W[i].witness.permit(req.record, req.operatorSignature)))] }; } catch { return { ok: false, body: [] }; } };
  const collectPermit = createPermitCollector({ pins: PINS, account: operator, fetchImpl, endpoints: witnesses.map((w, i) => ({ url: `https://w${i}.witness.test/`, address: w.address })) });
  const journal = openLifecycleJournal(path.join(dir, 'host.json'));
  const owner = await openLockedHostAuthorityJournal(path.join(dir, 'gate-ha.json')); t.after(() => owner.release('TEST teardown'));
  const gate = new DeploymentPermitGate({ pins: PINS, journal, now, hostAuthority: owner.journal });
  const vms = new Map(); let n = 0;
  const client = { async findByName(id) { return vms.get(id) ?? null; }, async spawn(body) { const view = { id: `vm-${++n}`, name: body.name, status: 'running' }; vms.set(body.name, view); return { view }; },
    async remove(x) { for (const [k, v] of vms) if (v.id === x || k === x) vms.delete(k); } };                                                 // SYNTHETIC manager
  const boundaries = { async hold(id) { return { deployment: id, ingress: true, storage: true, secrets: true }; },
    async allow(id, grant) { S.allows.push(grant); return { deployment: id, generation: grant.generation, validUntil: grant.validUntil, expiryEnforced: true, hostAuthority: grant.hostAuthority }; } };
  const runtime = createIsolationLifecycleRuntime({ client, gate, journal, collectPermit, boundaries, host: HOST, now,
    plans: { async read(id) { return { verified: true, host: HOST, body: { name: id }, stagingEnforced: true }; } },
    readiness: { async verify({ deployment, generation, view }) { return { verified: true, ready: true, deployment, host: HOST, generation, instance: view.id, validUntil: now() + 60000 }; } } });
  const snapshot = state => ({ schema: 2, id: ID, verified: true, authorityTier: 'finalized', blockAt: now(), blockHash: S.block, thisHost: HOST, enabled: true, admitted: true, funded: true,
    policy, hostAuthorityEvidence: evidence(), assignment: { state, host: HOST, operator: operator.address, generation: state === 'running' ? 3 : 2, revision: 1 } });
  return { dir, S, W, gate, owner, runtime, journal, snapshot, operator, vms };
}

test('O1 owner release withdraws the installed grant AND the tracked resources; retained gate/runtime/journal refuse start/serve/adopt; next owner acquires', async t => {
  const w = await world(t);
  await w.runtime.ensureStaged(ID, w.snapshot('queued')); await w.runtime.serve(ID, w.snapshot('running'));
  const g = w.S.allows.at(-1), allows = w.S.allows.length; let closed = null;
  w.gate.track(ID, { host: HOST, generation: 3, hostAuthority: g.hostAuthority }, reason => { closed = reason; });
  assert.equal(w.vms.size, 1);
  assert.deepEqual(await w.owner.release('TEST owner release'), { released: true, fenced: false, errors: [] });
  await tick();
  assert.match(String(closed), /owner/, 'the tracked resource close callback ran with the owner-release reason');
  assert.equal(w.vms.size, 0, 'the runtime\'s own tracked compute resource was revoked');
  assert.equal(w.gate.closed, true);
  assert.throws(() => w.gate.assert(ID, { host: HOST, generation: 3, hostAuthority: g.hostAuthority }), /no current serving permit/);
  await assert.rejects(w.runtime.serve(ID, w.snapshot('running')));
  await assert.rejects(w.runtime.ensureStaged(ID, w.snapshot('queued')));
  await assert.rejects(w.runtime.adoptHostAuthority(ID, w.snapshot('running')));
  assert.equal(w.vms.size, 0, 'no start through a retained reference'); assert.equal(w.S.allows.length, allows, 'no grant through a retained reference');
  assert.throws(() => w.owner.journal.read(HOST), /released/);
  assert.throws(() => w.owner.journal.accept(HOST, ctxOf({ revision: '2' })), /released/);
  const next = await openLockedHostAuthorityJournal(path.join(w.dir, 'gate-ha.json'));
  assert.equal(next.journal.read(HOST).floor.digest, g.hostAuthority, 'the durable floor survives for the next single owner'); await next.release();
});
test('O2 witness owner release while signing awaits readiness: the in-flight request is cancelled, no signature released', async t => {
  const w = await world(t);
  let open; w.S.healthGate = new Promise(r => { open = r; });
  const s = Math.floor(Date.now() / 1000), record = { deployment: ID, host: HOST, generation: 3, policyRevision: 1, sequence: 1, issuedAt: s, validUntil: s + 20, hostAuthority: w.S.ctx };
  const pending = w.W[0].witness.permit(record, await signServingPermit(w.operator, PINS, record));
  await tick();
  const refused = assert.rejects(pending, /closed|abort|released/); // observe before any awaited timeout can reject
  const release = w.W[0].release('TEST witness owner release');
  assert.equal(await Promise.race([release.then(() => 'released'), tick().then(() => 'pending')]), 'pending', 'actual readiness work has not settled');
  open();
  await refused;
  assert.equal((await release).released, true);
  assert.equal(w.W[0].witness.closed, true);
  assert.throws(() => w.W[0].hostAuthority.read(HOST), /released/);
});
test('O3 failure to withdraw stays FENCED: the flock is kept, a second owner cannot acquire, the old handle refuses', async t => {
  const f = path.join(tmp(t), 'ha.json'), first = await openLockedHostAuthorityJournal(f);
  first.journal.onRelease(() => { throw Error('TEST boundary did not acknowledge withdrawal'); });
  const p = first.release('TEST release'), r = await p; assert.equal(r.released, false); assert.equal(r.fenced, true); assert.equal(r.errors.length, 1);
  assert.equal(first.release('again'), p, 'idempotent: the same completion, still fenced');
  await assert.rejects(openLockedHostAuthorityJournal(f, { timeoutMs: 300 }));
  assert.throws(() => first.journal.read(HOST), /released/);
});
test('O4 lock loss (lock file removed) is detected: authority withdrawn, every operation refuses', async t => {
  const f = path.join(tmp(t), 'inc.json'), first = await openLockedHostIncarnationJournal({ readHostAuthority: () => null }, f);
  let withdrawn = null; first.journal.onHostIncarnationRelease(reason => { withdrawn = reason; });
  first.journal.acceptHostIncarnation(HOST, incOf());
  fs.unlinkSync(`${f}.lock`);
  assert.throws(() => first.journal.readHostIncarnation(HOST), /ownership lost/); assert.match(String(withdrawn), /ownership lost/);
  assert.throws(() => first.journal.acceptHostIncarnation(HOST, incOf('2')), /released/);
  assert.throws(() => first.journal.recoverHostIncarnation(), /released/);
});
for (const kind of ['permit', 'incarnation']) test(`O5 ${kind}: post-rename directory fsync failure survives a NEW owner; explicit verified recovery keeps history; owned pending untouched`, async t => {
  const d = tmp(t), f = path.join(d, `${kind}.json`), owned = ownedOf();
  owned.prepareTransition(ID, { digest: H('77'), payload: 'PUBLIC_TEST_INTENT' });                                // financial pending evidence (synthetic)
  let dirFsyncs = 0, armed = false;
  const fsImpl = { ...fs, fsyncSync(fd) { if (armed && fs.fstatSync(fd).isDirectory() && ++dirFsyncs === 2) throw Error('owned injected post-rename directory fsync failure'); return fs.fsyncSync(fd); } };
  const open = o => kind === 'permit' ? openLockedHostAuthorityJournal(f, o) : openLockedHostIncarnationJournal(owned, f, o);
  const write = (j, g) => kind === 'permit' ? j.accept(HOST, ctxOf({ generation: g })) : j.acceptHostIncarnation(HOST, incOf(g));
  const read = j => kind === 'permit' ? j.read(HOST) : j.readHostIncarnation(HOST);
  const recover = j => kind === 'permit' ? j.recover() : j.recoverHostIncarnation();
  const first = await open({ fsImpl }); write(first.journal, '1'); armed = true;
  assert.throws(() => write(first.journal, '2'), /injected|uncertain/); assert.throws(() => read(first.journal), /uncertain/);
  assert.equal((await first.release('TEST process exit')).released, true); assert.ok(fs.existsSync(`${f}.intent`), 'the durable intent record survives the process/owner');
  const second = await open({}); t.after(() => second.release('TEST teardown'));
  assert.throws(() => read(second.journal), /uncertain/, 'a new owner alone never clears ambiguity');
  assert.throws(() => write(second.journal, '3'), /uncertain/, 'and never writes over it');
  assert.equal(recover(second.journal), 'landed');
  assert.ok(fs.existsSync(`${f}.intent`) && fs.existsSync(`${f}.commit`), 'r4: the intent is retained beside its matching acknowledgement');
  const g = read(second.journal); assert.equal(kind === 'permit' ? g.floor.hostGeneration : g.floor.generation, '2', 'verified intended state, not a reset');
  const history = fs.readFileSync(`${f}.history`, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(history.length, 1); assert.equal(history[0].outcome, 'landed'); assert.ok(history[0].by && history[0].intent.after && history[0].intent.owner);
  assert.equal(owned.read(ID).pending.payload, 'PUBLIC_TEST_INTENT', 'owned financial pending evidence untouched');
});
test('O6 established sidecar + marker loss refuses in the actual coupling (owned journal floor), never repopulated; a fresh host is established at open', async t => {
  const d = tmp(t), owned = ownedOf();
  const fresh = await openLockedHostAuthorityJournal(path.join(d, 'p.json'), { ownedJournal: owned, hostId: HOST });
  assert.ok(fs.existsSync(path.join(d, 'p.json')) && fs.existsSync(path.join(d, 'p.json.established')), 'established at open, before any handoff'); await fresh.release();
  owned.acceptHostAuthority(HOST, { revision: '1', owner: A('1d'), policyHash: H('55') });                        // the owned journal is established
  fs.rmSync(path.join(d, 'p.json')); fs.rmSync(path.join(d, 'p.json.established'));
  const lost = await openLockedHostAuthorityJournal(path.join(d, 'p.json'), { ownedJournal: owned, hostId: HOST }); t.after(() => lost.release());
  assert.throws(() => lost.journal.read(HOST), /established/); assert.throws(() => lost.journal.accept(HOST, ctxOf()), /established/);
  assert.throws(() => lost.journal.recover(), /missing/, 'no recovery into an empty first use');
  assert.equal(fs.existsSync(path.join(d, 'p.json')), false, 'never repopulated');
  const inc = await openLockedHostIncarnationJournal(owned, path.join(d, 'i.json'), { hostId: HOST }); t.after(() => inc.release());
  assert.throws(() => inc.journal.readHostIncarnation(HOST), /established/); assert.equal(fs.existsSync(path.join(d, 'i.json')), false);
});
test('O7 clean restart positive: released owner, new owner reads the same floor and writes forward', async t => {
  const f = path.join(tmp(t), 'inc.json'), a = await openLockedHostIncarnationJournal({ readHostAuthority: () => null }, f);
  a.journal.acceptHostIncarnation(HOST, incOf()); await a.release();
  const b = await openLockedHostIncarnationJournal({ readHostAuthority: () => null }, f); t.after(() => b.release());
  assert.equal(b.journal.readHostIncarnation(HOST).floor.generation, '1'); b.journal.acceptHostIncarnation(HOST, incOf('2'));
  assert.equal(b.journal.readHostIncarnation(HOST).floor.generation, '2');
});
test('O8 proposed owned composition: v2 + owned handles required; single owner; release closes the gate, stops the dispatch, retained references refuse', async t => {
  const f = fixture({ hostId: HOST, now: () => 1000 }), d = tmp(t), owned = strip(f.journal);
  const pins = { chainId: 8453, host: HOST, profile: PROFILE, hostRegistry: { artifactSha256: ARTIFACT }, contracts: { registry: { address: REG, codeHash: CODE },
    hostOwnership: { address: REG, codeHash: CODE }, ledger: { address: NEW, codeHash: H('11') }, lifecycle: { address: FCTRL, codeHash: H('22') }, catalog: { address: A('cd'), codeHash: H('24') } } };
  const adapter = { ...f.chain, profile: PROFILE, lifecycleSchema: 3, lifecycleProofSchema: 2, bundleSha256: BUNDLE, hostRegistry: { address: REG, runtimeCodeHash: CODE, artifactSha256: ARTIFACT },
    independence: { complete: false, blockers: ['TEST synthetic canonical adapter'] } };                                                     // SYNTHETIC adapter stand-in
  const binding = { lifecycleSchema: 3, profile: PROFILE, bundleSha256: BUNDLE, hostRegistry: REG, hostRegistryCodeHash: CODE, hostRegistryArtifactSha256: ARTIFACT };
  const parts = { hostId: HOST, journalFile: path.join(d, 'parent.json'), incarnationFile: path.join(d, 'inc.json'), permitFile: path.join(d, 'permit.json'), pins: PINS,
    adapter, adapterPins: pins, client: { findByName: async () => null, spawn: async () => ({}), remove: async () => {} }, plans: { read: async () => null },
    readiness: { verify: async () => null }, boundaries: { hold: async id => ({ deployment: id, ingress: true, storage: true, secrets: true }), allow: async () => ({}) },
    collectPermit: async () => { throw Error('TEST: no witness quorum in this case'); }, routes: [route(ID, binding)], platformWallets: [PLATFORM], capacityHeadroom: 0.05,
    verifyQuiescence: f.verifyQuiescence, now: () => 1000, timeoutMs: 300 };
  await assert.rejects(openOwnedHostRegistryLifecycle({ ...parts, pins: { chainId: 8453, lifecycle: CTRL, profile: PROFILE } }), /servingPermit/, 'no v1 fallback');
  await assert.rejects(openOwnedHostRegistryLifecycle({ ...parts, ownedJournal: null }), /owned lifecycle journal/);
  const c = await openOwnedHostRegistryLifecycle(parts);
  assert.equal(c.runtime.hostAuthorityPermit, true); assert.equal(c.hostAuthority.hostAuthorityOwned, true); assert.equal(c.journal.hostIncarnationOwned, true);
  await assert.rejects(openOwnedHostRegistryLifecycle(parts), undefined, 'a second composition cannot acquire while the first owns the host');
  c.dispatch.attach(f.hostView(HOST));
  const before = JSON.stringify(c.journal.read(ID));
  const p = c.release('TEST composition release');
  assert.equal(c.gate.closed, true, 'the gate closes synchronously at release start');
  const r = await p; assert.equal(r.released, true); assert.equal(r.permit.released, true); assert.equal(r.incarnation.released, true);
  assert.equal(c.release('again'), p, 'idempotent: the same completion');
  await assert.rejects(c.runtime.ensureStaged(ID, { assignment: { state: 'queued', host: HOST } }));
  await assert.rejects(c.runtime.adoptHostAuthority(ID, {}));
  await assert.rejects(c.dispatch.adoptHostIncarnation(ID, { generation: '1', digest: H('99') }));
  assert.throws(() => c.journal.readHostIncarnation(HOST), /released/); assert.throws(() => c.hostAuthority.read(HOST), /released/);
  assert.throws(() => c.journal.prepareTransition(ID, { digest: H('78'), payload: 'TEST' }), /released/, 'r4: forwarded journal writes are owner-guarded');
  assert.equal(c.journal.read(ID).pending, openLifecycleJournal(parts.journalFile).read(ID).pending, 'r4: scoped read-only reconciliation stays available');
  assert.equal(JSON.stringify(openLifecycleJournal(parts.journalFile).read(ID)), before, 'the owned lifecycle journal (pending/mined) is untouched by release');
  const again = await openOwnedHostRegistryLifecycle(parts); assert.equal((await again.release()).permit.released, true, 'the next single owner acquires after withdrawal');
});
