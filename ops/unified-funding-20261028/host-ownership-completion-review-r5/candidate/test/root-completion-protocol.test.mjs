// host-authority completion r2 protocol suite (AUTHORED, NOT RUN). REAL generated modules: deployment-serving-permit (v2), createPermitCollector,
// DeploymentLifecycleWitness, DeploymentPermitGate, createIsolationLifecycleRuntime, the owned protocol journal, both durable sidecars and
// the existing runtime flock. TEST DOUBLES, and only these: witness transport (in-process fetch), each witness's chain reader (same-block
// assignment + host evidence), manager client, plans, readiness and boundary hold/allow acks. Not production enforcement or Base authority.
// ownership r3: ONLY C6's injection/recovery lines changed: the failure now hits the SECOND directory fsync (after the state rename) and
// recover() returns the verified outcome ('landed') instead of true.
// completion r5: ONLY C6's third sidecar (`m`) is opened with the ACTUAL owner lock of its file (recovery now requires it); assertions unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createPermitCollector } from '../network/deployment-permit-collector.mjs';
import { DeploymentLifecycleWitness } from '../network/deployment-lifecycle-witness.mjs';
import { DeploymentPermitGate } from '../network/deployment-permit-gate.mjs';
import { createIsolationLifecycleRuntime } from '../network/deployment-isolation-runtime.mjs';
import { openLifecycleJournal } from '../network/deployment-lifecycle-journal.mjs';
import { openHostAuthorityJournal, openLockedHostAuthorityJournal } from '../network/deployment-host-authority-journal.mjs';
import { hostAuthorityContextOf, isHostAuthorityPermit, servingContextOf } from '../network/deployment-host-authority.mjs';
import { hostIncarnationSection, withHostIncarnationJournal } from '../network/lifecycle-host-incarnation-journal.mjs';
import { hostIncarnationOf } from '../network/lifecycle-host-profile.mjs';
import { openOwnedLock } from '../network/owned-durable-state.mjs';

const H = b => '0x' + b.repeat(32), A = b => '0x' + b.repeat(20);
const HOST = H('a1'), ID = H('a2'), ID2 = H('a3'), FOREIGN = H('f1'), CTRL = '0x' + 'c7'.repeat(20), REG = A('ab'), CODE = H('23');
const PROFILE = 'independent-host-registry-r1';
const PINS = Object.freeze({ chainId: 8453, lifecycle: CTRL, servingPermit: { version: 2, profile: PROFILE } });
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hac-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const sorted = xs => xs.sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
const reporters = sorted([0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()))).map(a => a.address.toLowerCase());
const hr = (over = {}) => ({ scope: 'host', registry: REG, codeConsistent: true, status: 'online', online: true, generation: '1',
  hardwareId: H('b1'), descriptorDigest: H('b2'), qualificationDigest: H('b3'), resourceDigest: H('b4'), trustAnchorId: H('b5'),
  owner: A('1d'), revision: '1', policyHash: H('55'), reporters: { keys: reporters, threshold: 2, revision: '1' }, ...over });
const ctxOf = (over, hostId = HOST) => hostAuthorityContextOf(hr(over), { chainId: 8453, hostId, registryCodeHash: CODE });

function world(t, { now = () => Date.now() } = {}) {
  const dir = tmp(t), operator = privateKeyToAccount(generatePrivateKey());
  const witnesses = sorted([0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey())));
  const policy = { witnesses: witnesses.map(w => w.address), threshold: 3, revision: 1 };
  const S = { ctx: ctxOf(), status: 'online', block: H('e1'), allows: [], reads: [0, 0, 0], onRead: null };
  const evidence = () => ({ context: S.ctx, status: S.status, blockHash: S.block, blockNumber: '7', proofVerified: true });
  const assignment = id => ({ deployment: id, host: HOST, operator: operator.address, state: 'running', generation: 3, policyRevision: 1, admitted: true, funded: true,
    authorityTier: 'finalized', proofVerified: true, observedAt: Math.floor(now() / 1000), blockTimestamp: Math.floor(now() / 1000), blockHash: S.block });
  // TEST DOUBLE: EACH witness's own authenticated reader with its own read counter; a v2 permit reads 3 times per witness:
  // (1) initial, (2) after readiness, (3) the FINAL read after the signature was produced internally. onRead(i, n) acts at a chosen read.
  const authorityFor = i => ({ async read(id) { const n = ++S.reads[i]; await S.onRead?.(i, n);
    return { assignment: assignment(id), policy, hostAuthority: evidence(), hostAdmitted: true }; } });
  const health = { async verify(id, host, generation) { return { verified: true, deployment: id, host, generation, ready: true, validUntil: Math.floor(now() / 1000) + 60 }; } };
  const W = witnesses.map((w, i) => new DeploymentLifecycleWitness({ pins: PINS, account: w, journal: openLifecycleJournal(path.join(dir, `w${i}.json`)),
    authority: authorityFor(i), health, now, hostAuthorityJournal: openHostAuthorityJournal(path.join(dir, `w${i}-ha.json`)) }));
  const fetchImpl = async (url, { body }) => { const i = Number(new URL(url).hostname.slice(1, 2)), req = JSON.parse(body);
    try { return { ok: true, body: [Buffer.from(JSON.stringify(await W[i].permit(req.record, req.operatorSignature)))] }; } catch { return { ok: false, body: [] }; } };
  const collectPermit = createPermitCollector({ pins: PINS, account: operator, fetchImpl,
    endpoints: witnesses.map((w, i) => ({ url: `https://w${i}.witness.test/`, address: w.address })) });
  const hostFile = path.join(dir, 'host.json'), haFile = path.join(dir, 'gate-ha.json');
  const journal = openLifecycleJournal(hostFile);
  const gate = new DeploymentPermitGate({ pins: PINS, journal, now, hostAuthority: openHostAuthorityJournal(haFile) });
  const reopenGate = () => new DeploymentPermitGate({ pins: PINS, journal: openLifecycleJournal(hostFile), now, hostAuthority: openHostAuthorityJournal(haFile) });
  const vms = new Map(); let n = 0;
  const client = { async findByName(id) { return vms.get(id) ?? null; },
    async spawn(body) { const view = { id: `vm-${++n}`, name: body.name, status: 'running' }; vms.set(body.name, view); return { view }; },
    async remove(x) { for (const [k, v] of vms) if (v.id === x || k === x) vms.delete(k); } };
  const boundaries = { async hold(id) { return { deployment: id, ingress: true, storage: true, secrets: true }; },
    async allow(id, grant) { S.allows.push({ id, ...grant }); return { deployment: id, generation: grant.generation, validUntil: grant.validUntil, expiryEnforced: true, hostAuthority: grant.hostAuthority }; } };
  const runtime = createIsolationLifecycleRuntime({ client, gate, journal, collectPermit, boundaries, host: HOST, now,
    plans: { async read(id) { return { verified: true, host: HOST, body: { name: id }, stagingEnforced: true }; } },
    readiness: { async verify({ deployment, generation, view }) { return { verified: true, ready: true, deployment, host: HOST, generation, instance: view.id, validUntil: now() + 60000 }; } } });
  const snapshot = (state, id = ID) => ({ schema: 2, id, verified: true, authorityTier: 'finalized', blockAt: now(), blockHash: S.block, thisHost: HOST,
    enabled: true, admitted: true, funded: true, policy, hostAuthorityEvidence: evidence(),
    assignment: { state, host: HOST, operator: operator.address, generation: state === 'running' ? 3 : 2, revision: 1 } });
  return { S, W, gate, reopenGate, runtime, collectPermit, snapshot, policy, journal, dir };
}
const start = async (w, id = ID) => { await w.runtime.ensureStaged(id, w.snapshot('queued', id)); await w.runtime.serve(id, w.snapshot('running', id)); };
const record = (seq, hostAuthority, id = ID) => { const s = Math.floor(Date.now() / 1000);
  return { deployment: id, host: HOST, generation: 3, policyRevision: 1, sequence: seq, issuedAt: s, validUntil: s + 20, hostAuthority }; };

test('C1 same-generation Offline (real signed envelope) cannot be undone by an older Online context, survives reopen; qualified gen2 restores', async t => {
  const w = world(t); await start(w);
  const old = await w.collectPermit(record(2, w.S.ctx), w.policy), priorOnline = servingContextOf(PINS, w.snapshot('running'));
  await w.gate.install(old, priorOnline);                                               // valid while Online
  w.S.status = 'offline'; w.S.block = H('e2');
  await assert.rejects(w.gate.install(old, servingContextOf(PINS, w.snapshot('running'))), /offline/);
  assert.throws(() => w.gate.assert(ID, { host: HOST, generation: 3, hostAuthority: w.S.ctx.digest }), /no current serving permit/);
  await assert.rejects(w.gate.install(old, priorOnline), /recorded Offline/, 'stale Online evidence cannot restore after authenticated Offline at same generation');
  await assert.rejects(w.reopenGate().install(old, priorOnline), /recorded Offline/);
  assert.equal(w.gate.hostAuthority.read(HOST).floor.offline.hostGeneration, '1');
  assert.equal(await w.runtime.stop(ID), true, 'explicitly confirm manager absence and retire the old runtime before this TEST queued origin');
  w.S.ctx = ctxOf({ generation: '2', qualificationDigest: H('c3') }); w.S.status = 'online'; w.S.block = H('e3');
  await start(w);                                                                        // fresh queued handoff to the NEW qualified generation
  assert.equal(w.S.allows.at(-1).hostAuthority, w.S.ctx.digest); assert.equal(w.gate.hostAuthority.read(HOST).floor.offline, null);
});
test('C2 two simultaneous app grants: another host\'s authority/Offline preserves both; THIS host\'s Offline withdraws both', async t => {
  const w = world(t); await start(w, ID); await start(w, ID2);
  const g1 = w.S.allows.find(a => a.id === ID), g2 = w.S.allows.find(a => a.id === ID2);
  w.gate.observeHostAuthority(ctxOf({}, FOREIGN));
  assert.equal(w.gate.observeHostEvidence({ context: ctxOf({}, FOREIGN), status: 'offline', blockHash: H('e9'), blockNumber: '9', proofVerified: true }), 'recorded');
  assert.equal(w.gate.observeHostEvidence({ context: w.S.ctx, status: 'offline', blockHash: H('e9'), proofVerified: false }), 'ignored', 'unqualified status is never a veto');
  assert.equal(w.gate.assert(ID, { host: HOST, generation: 3, hostAuthority: g1.hostAuthority }), g1.validUntil);
  assert.equal(w.gate.assert(ID2, { host: HOST, generation: 3, hostAuthority: g2.hostAuthority }), g2.validUntil);
  assert.equal(w.gate.observeHostEvidence({ context: w.S.ctx, status: 'offline', blockHash: H('e8'), blockNumber: '8', proofVerified: true }), 'recorded');
  assert.throws(() => w.gate.assert(ID, { host: HOST, generation: 3, hostAuthority: g1.hostAuthority }), /no current serving permit/);
  assert.throws(() => w.gate.assert(ID2, { host: HOST, generation: 3, hostAuthority: g2.hostAuthority }), /no current serving permit/);
});
test('C3 witness FINAL asynchronous read: Offline or close during it wins (no obsolete signature, durable Offline); unchanged state still signs', async t => {
  const w = world(t); await w.runtime.ensureStaged(ID, w.snapshot('queued'));
  w.S.onRead = async (i, n) => { if (n === 3) { w.S.status = 'offline'; w.S.block = H('e4'); } };     // exactly a witness's post-sign read
  await assert.rejects(w.runtime.serve(ID, w.snapshot('running')), /quorum/); assert.equal(w.S.allows.length, 0);
  assert.ok(w.W.some(x => x.hostAuthorityJournal.read(HOST)?.floor.offline), 'a witness recorded its own authenticated Offline');
  const v = world(t); await v.runtime.ensureStaged(ID, v.snapshot('queued'));
  v.S.onRead = async (i, n) => { if (n === 3) v.W[i].close(); };                                      // close during this witness's final read
  await assert.rejects(v.runtime.serve(ID, v.snapshot('running')), /quorum/); assert.equal(v.S.allows.length, 0);
  assert.deepEqual(v.S.reads, [3, 3, 3], 'each witness reached its final read before refusing');
  const u = world(t); await start(u); assert.equal(u.S.allows.length, 1, 'legitimate unchanged state signs and serves');
});
test('C4 a hold while gate.install awaits verification supersedes it; no grant', async t => {
  const w = world(t); await start(w);
  const env = await w.collectPermit(record(2, w.S.ctx), w.policy), p = w.gate.install(env, servingContextOf(PINS, w.snapshot('running')));
  w.gate.hold(ID, 'TEST owner hold during install');
  await assert.rejects(p, /superseded/);
  assert.throws(() => w.gate.assert(ID, { host: HOST, generation: 3, hostAuthority: w.S.ctx.digest }), /no current serving permit/);
});
test('C5 v2 is mandatory for the new profile at direct protocol entry points; v1 runtime refuses new-profile snapshots', async t => {
  assert.throws(() => isHostAuthorityPermit({ chainId: 8453, lifecycle: CTRL, profile: PROFILE }), /requires pins.servingPermit/);
  assert.throws(() => new DeploymentPermitGate({ pins: { ...PINS }, journal: openLifecycleJournal(path.join(tmp(t), 'g.json')) }), /durable host authority journal/);
  const d = tmp(t), v1gate = new DeploymentPermitGate({ pins: { chainId: 8453, lifecycle: CTRL }, journal: openLifecycleJournal(path.join(d, 'h.json')) });
  const rt = createIsolationLifecycleRuntime({ client: { findByName: async () => null, spawn: async () => ({}), remove: async () => {} }, gate: v1gate,
    journal: openLifecycleJournal(path.join(d, 'r.json')), collectPermit: async () => { throw Error('never collected'); }, host: HOST,
    boundaries: { hold: async id => ({ deployment: id, ingress: true, storage: true, secrets: true }), allow: async () => ({}) },
    plans: { read: async () => null }, readiness: { verify: async () => null } });
  assert.equal(rt.hostAuthorityPermit, false);
  await assert.rejects(rt.serve(ID, { profile: PROFILE, assignment: { host: HOST, state: 'running', generation: 3 } }), /v2 host-authority permits/);
});
test('C6 repaired dispatch incarnation sidecar: same-gen Offline persists, lost/malformed refuse, post-rename dir fsync latches, explicit recover, owned coupling', async t => {
  const d = tmp(t), f = path.join(d, 'inc.json');
  const x = (status, generation = '1') => hostIncarnationOf({ registry: REG, status, generation, qualificationDigest: H('c1'), trustAnchorId: H('c2'),
    hardwareId: H('c3'), resourceDigest: H('c4'), descriptorDigest: H('c5') }, { hostId: HOST, registryCodeHash: CODE });
  const j = hostIncarnationSection(f);
  j.acceptHostIncarnation(HOST, x('online')); j.acceptHostIncarnation(HOST, x('offline'));
  assert.equal(hostIncarnationSection(f).readHostIncarnation(HOST).floor.context.status, 'offline');
  assert.throws(() => hostIncarnationSection(f).acceptHostIncarnation(HOST, x('online')), /recorded Offline/);
  const g2 = hostIncarnationSection(f); g2.acceptHostIncarnation(HOST, x('online', '2')); assert.equal(g2.readHostIncarnation(HOST).floor.offline, null);
  fs.unlinkSync(f); assert.throws(() => g2.readHostIncarnation(HOST), /lost|changed/); assert.throws(() => hostIncarnationSection(f).readHostIncarnation(HOST), /missing/);
  const f2 = path.join(d, 'inc2.json'), k = hostIncarnationSection(f2); k.acceptHostIncarnation(HOST, x('online'));
  const raw = JSON.parse(fs.readFileSync(f2, 'utf8')); raw.hosts[HOST].floor.context.generation = '999'; fs.writeFileSync(f2, JSON.stringify(raw));
  assert.throws(() => k.readHostIncarnation(HOST)); assert.throws(() => hostIncarnationSection(f2).readHostIncarnation(HOST), /malformed|match|digest/);
  const f3 = path.join(d, 'inc3.json'), f3owner = await openOwnedLock(f3), m = hostIncarnationSection(f3, { owner: f3owner }); m.acceptHostIncarnation(HOST, x('online'));
  t.after(() => m.release());
  const original = fs.fsyncSync; let dirFsyncs = 0;   // 1st directory fsync = the intent rename, 2nd = the STATE rename
  fs.fsyncSync = fd => { if (fs.fstatSync(fd).isDirectory() && ++dirFsyncs === 2) throw Object.assign(Error('owned injected directory fsync failure'), { code: 'EIO' }); return original(fd); };
  try { assert.throws(() => m.acceptHostIncarnation(HOST, x('online', '2')), /owned injected/); } finally { fs.fsyncSync = original; }
  assert.throws(() => m.readHostIncarnation(HOST), /uncertain/, 'renamed bytes never authorize by themselves');
  assert.equal(m.recover(), 'landed'); assert.equal(m.readHostIncarnation(HOST).floor.generation, '2', 'explicit recovery only after durable proof');
  const owned = { readHostAuthority: () => ({ floor: { revision: '1', owner: A('1d'), policyHash: H('55') }, holds: {} }) };
  const coupled = withHostIncarnationJournal(owned, path.join(d, 'never-created.json'));
  coupled.readHostAuthority(HOST);
  assert.throws(() => coupled.readHostIncarnation(HOST), /established host authority/, 'an established owned journal never makes a missing sidecar first use');
});
test('C7 gate/witness sidecar: Offline floor survives reopen, marker loss refuses, owned coupling refuses, and the runtime flock excludes a second writer', async t => {
  const d = tmp(t), f = path.join(d, 'ha.json'), j = openHostAuthorityJournal(f); j.accept(HOST, ctxOf());
  assert.equal(j.observe(HOST, { context: ctxOf(), status: 'offline', blockHash: H('e5'), blockNumber: '5', proofVerified: true }), 'recorded');
  assert.throws(() => openHostAuthorityJournal(f).accept(HOST, ctxOf({ revision: '2' })), /recorded Offline/);
  fs.unlinkSync(`${f}.established`); assert.throws(() => openHostAuthorityJournal(f).read(HOST), /marker/);
  assert.throws(() => openHostAuthorityJournal(path.join(d, 'none.json'), { established: () => true }).read(HOST), /established/);
  const lf = path.join(d, 'locked.json'), first = await openLockedHostAuthorityJournal(lf);
  await assert.rejects(openLockedHostAuthorityJournal(lf, { timeoutMs: 200 }));
  first.release();
  const second = await openLockedHostAuthorityJournal(lf); second.release();
});
