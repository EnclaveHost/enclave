// async r4 suite (AUTHORED, NOT RUN; root executes). Runs in the FINAL layered native tree whose network/ holds the r4-GENERATED gate/
// witness/runtime/serving-permit (generate-host-authority-permit-candidates.mjs over the pinned baselines), owned-durable-state.mjs,
// both sidecar journals and the existing runtime-lock.mjs (real flock).
// REAL: owned-durable-state + real flock, the generated DeploymentPermitGate / DeploymentLifecycleWitness / createIsolationLifecycleRuntime,
// createPermitCollector, v2 typed signatures (viem), the owned protocol journal (openLifecycleJournal) and real files.
// SYNTHETIC (labelled TEST doubles; not hardware, chain or enforcement evidence): each witness's chain reader, readiness, witness transport,
// the guestd manager client (with explicit await gates), launch plans and boundary hold/allow acknowledgements.
// Cleanup: only this suite's own temp dirs and owner handles (flock fds held in-process; no child process is left by takeRuntimeLock).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { openDurableState, openOwnedLock } from '../network/owned-durable-state.mjs';
import { createPermitCollector } from '../network/deployment-permit-collector.mjs';
import { DeploymentPermitGate } from '../network/deployment-permit-gate.mjs';
import { createIsolationLifecycleRuntime } from '../network/deployment-isolation-runtime.mjs';
import { openLifecycleJournal } from '../network/deployment-lifecycle-journal.mjs';
import { signServingPermit } from '../network/deployment-serving-permit.mjs';
import { openLockedHostAuthorityJournal } from '../network/deployment-host-authority-journal.mjs';
import { hostAuthorityContextOf } from '../network/deployment-host-authority.mjs';
import { openOwnedHostAuthorityWitness } from '../network/lifecycle-host-owned-authority.mjs';

const H = b => '0x' + b.repeat(32), A = b => '0x' + b.repeat(20);
const HOST = H('a1'), ID = H('a2'), CTRL = '0x' + 'c7'.repeat(20), REG = A('ab'), CODE = H('23');
const PINS = Object.freeze({ chainId: 8453, lifecycle: CTRL, servingPermit: { version: 2, profile: 'independent-host-registry-r1' } });
const OPTS = { format: 'R4-TEST', empty: { n: 0 }, validate: x => { assert.equal(typeof x.n, 'number'); return x; }, established: false };
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-own-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));
const gate = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };
const awaitGate = () => { const g = gate(); let entered; const reached = new Promise(r => { entered = r; }); return { p: g.p, open: g.open, entered, reached }; };
const pendingState = async p => Promise.race([p.then(() => 'settled'), tick(30).then(() => 'pending')]);
const excluded = async f => { try { const o = await openOwnedLock(f, { timeoutMs: 150 }); o.release(); return false; } catch { return true; } };
const lockExcluded = async f => { try { const o = await openLockedHostAuthorityJournal(f, { timeoutMs: 150 }); await o.release(); return false; } catch { return true; } };
const sorted = xs => xs.sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
const reporters = sorted([0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()))).map(a => a.address.toLowerCase());
const ctxOf = over => hostAuthorityContextOf({ scope: 'host', registry: REG, codeConsistent: true, status: 'online', online: true, generation: '1',
  hardwareId: H('b1'), descriptorDigest: H('b2'), qualificationDigest: H('b3'), resourceDigest: H('b4'), trustAnchorId: H('b5'),
  owner: A('1d'), revision: '1', policyHash: H('55'), reporters: { keys: reporters, threshold: 2, revision: '1' }, ...over }, { chainId: 8453, hostId: HOST, registryCodeHash: CODE });
const dirFault = (n, label) => { let armed = false, count = 0;
  return { arm() { armed = true; count = 0; }, disarm() { armed = false; },
    io: { ...fs, fsyncSync(fd) { if (armed && fs.fstatSync(fd).isDirectory() && ++count === n) throw Error(label); return fs.fsyncSync(fd); } } }; };

// ---------------- owned-durable-state: asynchronous owner withdrawal ----------------
test('A1 delayed async withdrawal: the real flock stays held (new owner EXCLUDED while cleanup is incomplete), then released after success', async t => {
  const f = path.join(tmp(t), 'state.json'), owner = await openOwnedLock(f); t.after(() => owner.release());
  const s = openDurableState(f, { ...OPTS, owner }); const g = gate(); let done = false;
  s.onRelease(async () => { await g.p; done = true; });
  const completion = s.release('TEST shutdown');
  assert.throws(() => s.state, /released/, 'old handle refuses synchronously');
  assert.equal(s.release('again'), completion, 'idempotent: the same completion');
  assert.equal(await excluded(f), true, 'no new acquisition BEFORE the withdrawal completed'); assert.equal(done, false);
  assert.equal(await pendingState(completion), 'pending');
  g.open();
  assert.deepEqual(await completion, { released: true, fenced: false, errors: [] }); assert.equal(done, true);
  assert.equal(await excluded(f), false, 'positive: the next owner acquires after confirmed cleanup');
});
test('A2 rejected or synchronously failing withdrawal stays FENCED: lock held, completion never rejects, no unhandled rejection', async t => {
  const f = path.join(tmp(t), 'state.json'), owner = await openOwnedLock(f);
  const s = openDurableState(f, { ...OPTS, owner });
  s.onRelease(async () => { await tick(); throw Error('TEST manager removal failed'); });
  s.onRelease(() => { throw Error('TEST synchronous boundary failure'); });
  s.onRelease(() => 'ok');
  const r = await s.release('TEST shutdown');
  assert.equal(r.released, false); assert.equal(r.fenced, true); assert.equal(r.errors.length, 2);
  assert.equal(await excluded(f), true, 'a fenced owner keeps excluding the next owner');
  assert.throws(() => s.onRelease(() => {}), /already released/);
});
test('A3 bounded withdrawal deadline FENCES (never releases by timeout)', async t => {
  const f = path.join(tmp(t), 'state.json'), owner = await openOwnedLock(f);
  const s = openDurableState(f, { ...OPTS, owner, withdrawDeadlineMs: 40 });
  s.onRelease(() => new Promise(() => {}));                                     // TEST: a withdrawal that never acknowledges
  const r = await s.release('TEST shutdown');
  assert.equal(r.fenced, true); assert.match(String(r.errors[0]?.message), /deadline/);
  assert.equal(await excluded(f), true);
});
test('A4 lock loss starts the withdrawal on the next use (assertLive) and the old handle refuses', async t => {
  const f = path.join(tmp(t), 'state.json'), owner = await openOwnedLock(f);
  const s = openDurableState(f, { ...OPTS, owner }); let why = null; s.onRelease(r => { why = r; });
  fs.unlinkSync(`${f}.lock`);
  assert.throws(() => s.assertLive(), /ownership lost/); assert.match(String(why), /ownership lost/);
  assert.throws(() => s.state, /released/); assert.throws(() => s.store({ n: 5 }), /released/);
});

// ---------------- owned-durable-state: retained intent + acknowledgement ----------------
// sequence numbers: the established:false open stores the empty state as seq 1, so { n: 1 } is seq 2 and { n: 2 } is seq 3.
test('D1 positive: clean store keeps intent + matching acknowledgement; a fresh open is clean and writes forward', async t => {
  const f = path.join(tmp(t), 'state.json'), s = openDurableState(f, OPTS); s.store({ n: 1 });
  assert.ok(fs.existsSync(`${f}.intent`) && fs.existsSync(`${f}.commit`), 'evidence retained, acknowledged');
  const again = openDurableState(f, { ...OPTS, established: true }); assert.equal(again.failed(), null); assert.equal(again.state.n, 1);
  again.store({ n: 2 }); assert.equal(openDurableState(f, { ...OPTS, established: true }).state.n, 2);
});
test('D2 store FINAL acknowledgement directory-sync fault (3rd dir fsync) survives a fresh open; owned explicit recovery verifies + keeps history', async t => {
  const f = path.join(tmp(t), 'state.json'), fault = dirFault(3, 'TEST final acknowledgement dirsync failure');
  const s = openDurableState(f, { ...OPTS, fsImpl: fault.io }); s.store({ n: 1 }); fault.arm();
  assert.throws(() => s.store({ n: 2 }), /final acknowledgement/); fault.disarm();
  assert.throws(() => s.state, /uncertain/); s.release();
  assert.ok(fs.existsSync(`${f}.intent`), 'the sole ambiguity evidence was never deleted');
  assert.ok(fs.readdirSync(path.dirname(f)).some(x => x.startsWith('state.json.commit.unacknowledged-3-')), 'the retracted acknowledgement is retained');
  const reopened = openDurableState(f, { ...OPTS, established: true });
  assert.match(String(reopened.failed()), /uncertain/); assert.throws(() => reopened.state, /uncertain/); assert.throws(() => reopened.store({ n: 3 }), /uncertain/);
  const owner = await openOwnedLock(f); t.after(() => owner.release());
  const own = openDurableState(f, { ...OPTS, established: true, owner });
  assert.equal(own.recover(), 'landed'); assert.equal(own.state.n, 2);
  const h = fs.readFileSync(`${f}.history`, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(h.length, 1); assert.equal(h[0].outcome, 'landed'); assert.equal(h[0].intent.seq, 3); assert.ok(h[0].by);
  assert.equal(openDurableState(f, { ...OPTS, established: true }).state.n, 2, 'positive: clean only after verified acknowledgement');
});
test('D3 recovery FINAL acknowledgement fault also survives a fresh open; a later successful recovery clears it', async t => {
  const f = path.join(tmp(t), 'state.json'), storeFault = dirFault(2, 'TEST state rename dirsync failure');
  const s = openDurableState(f, { ...OPTS, fsImpl: storeFault.io }); s.store({ n: 1 }); storeFault.arm();
  assert.throws(() => s.store({ n: 2 }), /state rename/); storeFault.disarm(); s.release();
  const recFault = dirFault(3, 'TEST recovery acknowledgement dirsync failure');   // recover: file dirsync, history dirsync, ACK dirsync
  const r1 = openDurableState(f, { ...OPTS, established: true, fsImpl: recFault.io }); recFault.arm();
  assert.throws(() => r1.recover(), /recovery acknowledgement/); recFault.disarm();
  assert.throws(() => r1.state, /uncertain/, 'still latched in this process');
  const fresh = openDurableState(f, { ...OPTS, established: true });
  assert.throws(() => fresh.state, /uncertain/, 'a failed recovery acknowledgement never reopens clean');
  assert.equal(fresh.recover(), 'landed'); assert.equal(fresh.state.n, 2);
  assert.equal(fs.readFileSync(`${f}.history`, 'utf8').trim().split('\n').length, 2, 'both recovery attempts retained in provenance');
  assert.equal(openDurableState(f, { ...OPTS, established: true }).state.n, 2);
});
test('D4 established sidecar + marker loss refuses with established coupling; no recovery into empty state', async t => {
  const f = path.join(tmp(t), 'state.json'); openDurableState(f, OPTS).store({ n: 1 });
  for (const x of ['', '.established']) fs.rmSync(`${f}${x}`);
  const s = openDurableState(f, { ...OPTS, established: true });
  assert.throws(() => s.state, /missing|established/); assert.throws(() => s.recover(), /missing/); assert.equal(fs.existsSync(f), false);
});

// ---------------- actual generated gate/runtime over the owned permit journal ----------------
async function world(t) {
  const dir = tmp(t), operator = privateKeyToAccount(generatePrivateKey()), now = () => Date.now();
  const witnesses = sorted([0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey())));
  const policy = { witnesses: witnesses.map(w => w.address), threshold: 3, revision: 1 };
  const S = { ctx: ctxOf(), block: H('e1'), allows: [], healthGate: null, lookupGate: null, spawnGate: null, removeGate: null, removeError: null, calls: { spawn: 0, lookup: 0, remove: 0 } };
  const evidence = () => ({ context: S.ctx, status: 'online', blockHash: S.block, blockNumber: '7', proofVerified: true });
  const assignment = id => ({ deployment: id, host: HOST, operator: operator.address, state: 'running', generation: 3, policyRevision: 1, admitted: true, funded: true,
    authorityTier: 'finalized', proofVerified: true, observedAt: Math.floor(now() / 1000), blockTimestamp: Math.floor(now() / 1000), blockHash: S.block });
  const authority = { async read(id) { return { assignment: assignment(id), policy, hostAuthority: evidence(), hostAdmitted: true }; } };   // SYNTHETIC reader
  const health = { async verify(id, host, generation) { if (S.healthGate) await S.healthGate;                                                // SYNTHETIC readiness
    return { verified: true, deployment: id, host, generation, ready: true, validUntil: Math.floor(now() / 1000) + 60 }; } };
  const W = await Promise.all(witnesses.map((w, i) => openOwnedHostAuthorityWitness({ sidecarFile: path.join(dir, `w${i}-ha.json`), pins: PINS, account: w,
    journal: openLifecycleJournal(path.join(dir, `w${i}.json`)), authority, health, now })));
  t.after(() => W.forEach(x => x.release('TEST teardown')));
  const fetchImpl = async (url, { body }) => { const i = Number(new URL(url).hostname.slice(1, 2)), req = JSON.parse(body);                    // SYNTHETIC transport
    try { return { ok: true, body: [Buffer.from(JSON.stringify(await W[i].witness.permit(req.record, req.operatorSignature)))] }; } catch { return { ok: false, body: [] }; } };
  const collectPermit = createPermitCollector({ pins: PINS, account: operator, fetchImpl, endpoints: witnesses.map((w, i) => ({ url: `https://w${i}.witness.test/`, address: w.address })) });
  const journal = openLifecycleJournal(path.join(dir, 'host.json')), haFile = path.join(dir, 'gate-ha.json');
  const owner = await openLockedHostAuthorityJournal(haFile); t.after(() => owner.release('TEST teardown'));
  const g = new DeploymentPermitGate({ pins: PINS, journal, now, hostAuthority: owner.journal, onError: () => {} });
  const vms = new Map(); let n = 0;
  const client = {                                                                                                                             // SYNTHETIC manager with await gates
    async findByName(id) { S.calls.lookup++; const w = S.lookupGate; S.lookupGate = null; if (w) { w.entered(); await w.p; } return vms.get(id) ?? null; },
    async spawn(body) { S.calls.spawn++; const w = S.spawnGate; S.spawnGate = null; if (w) { w.entered(); await w.p; }
      const view = { id: `vm-${++n}`, name: body.name, status: 'running' }; vms.set(body.name, view); return { view }; },
    async remove(x) { S.calls.remove++; const w = S.removeGate; S.removeGate = null; if (w) { w.entered(); await w.p; }
      if (S.removeError) throw Error(S.removeError); for (const [k, v] of vms) if (v.id === x || k === x) vms.delete(k); } };
  const boundaries = { async hold(id) { return { deployment: id, ingress: true, storage: true, secrets: true }; },                             // SYNTHETIC boundary acks
    async allow(id, grant) { S.allows.push(grant); return { deployment: id, generation: grant.generation, validUntil: grant.validUntil, expiryEnforced: true, hostAuthority: grant.hostAuthority }; } };
  const runtime = createIsolationLifecycleRuntime({ client, gate: g, journal, collectPermit, boundaries, host: HOST, now,
    plans: { async read(id) { return { verified: true, host: HOST, body: { name: id }, stagingEnforced: true }; } },                            // SYNTHETIC plans
    readiness: { async verify({ deployment, generation, view }) { return { verified: true, ready: true, deployment, host: HOST, generation, instance: view.id, validUntil: now() + 60000 }; } } });
  const snapshot = state => ({ schema: 2, id: ID, verified: true, authorityTier: 'finalized', blockAt: now(), blockHash: S.block, thisHost: HOST, enabled: true, admitted: true, funded: true,
    policy, hostAuthorityEvidence: evidence(), assignment: { state, host: HOST, operator: operator.address, generation: state === 'running' ? 3 : 2, revision: 1 } });
  return { dir, haFile, S, W, gate: g, owner, runtime, journal, snapshot, operator, vms };
}
const serving = async w => { await w.runtime.ensureStaged(ID, w.snapshot('queued')); await w.runtime.serve(ID, w.snapshot('running')); return w.S.allows.at(-1); };

test('G1 owner release waits for the ACTUAL runtime revokeInstance (delayed manager removal); next owner excluded until it completes; then acquires', async t => {
  const w = await world(t), g = await serving(w), rg = awaitGate(); w.S.removeGate = rg;
  const completion = w.owner.release('TEST owner release');
  assert.throws(() => w.gate.assert(ID, { host: HOST, generation: 3, hostAuthority: g.hostAuthority }), /no current serving permit/, 'refused synchronously');
  await assert.rejects(w.runtime.ensureStaged(ID, w.snapshot('queued')), /closed/, 'no new runtime work through the retained reference');
  await rg.reached;
  assert.equal(await pendingState(completion), 'pending'); assert.equal(await lockExcluded(w.haFile), true, 'excluded BEFORE the instance removal completed');
  assert.equal(w.vms.size, 1);
  rg.open();
  assert.deepEqual(await completion, { released: true, fenced: false, errors: [] }); assert.equal(w.vms.size, 0);
  assert.equal(await lockExcluded(w.haFile), false, 'positive: acquisition after confirmed cleanup');
});
test('G2 rejected manager removal keeps the owner FENCED (lock held), completion reports the failure', async t => {
  const w = await world(t); await serving(w);
  w.S.removeError = 'TEST manager remove rejected';
  const r = await w.owner.release('TEST owner release');
  assert.equal(r.fenced, true); assert.equal(r.released, false); assert.ok(r.errors.length >= 1);
  assert.equal(await lockExcluded(w.haFile), true);
});
test('G3 close while the INITIAL manager lookup awaits: no spawn is ever initiated; release completes; retained runtime refuses new work', async t => {
  const w = await world(t), lg = awaitGate(); w.S.lookupGate = lg;
  const staging = w.runtime.ensureStaged(ID, w.snapshot('queued'));
  await lg.reached;
  const completion = w.owner.release('TEST owner release during lookup');
  assert.equal(await pendingState(completion), 'pending', 'the in-flight start is awaited before the lock goes');
  lg.open();
  await assert.rejects(staging, /closed|revoked/);
  assert.equal(w.S.calls.spawn, 0, 'no spawn after close'); assert.equal(w.vms.size, 0);
  assert.equal((await completion).released, true);
  await assert.rejects(w.runtime.ensureStaged(ID, w.snapshot('queued')), /closed/); assert.equal(w.S.calls.spawn, 0);
});
test('G4 spawn initiated BEFORE close: release cannot finish until the resulting instance is removed and absence confirmed', async t => {
  const w = await world(t), sg = awaitGate(); w.S.spawnGate = sg;
  const staging = w.runtime.ensureStaged(ID, w.snapshot('queued'));
  await sg.reached;
  const completion = w.owner.release('TEST owner release during spawn');
  assert.equal(await lockExcluded(w.haFile), true, 'excluded while the pre-close spawn is unresolved');
  sg.open();
  await assert.rejects(staging, /closed|revoked/);
  assert.equal((await completion).released, true); assert.equal(w.S.calls.spawn, 1);
  assert.equal(w.vms.size, 0, 'the spawned instance was removed before the owner released'); assert.ok(w.S.calls.lookup >= 2, 'absence confirmed by a lookup');
});
test('G5 pre-close spawn whose removal FAILS keeps the owner fenced', async t => {
  const w = await world(t), sg = awaitGate(); w.S.spawnGate = sg;
  const staging = w.runtime.ensureStaged(ID, w.snapshot('queued'));
  await sg.reached;
  const completion = w.owner.release('TEST owner release during spawn'); w.S.removeError = 'TEST manager remove rejected';
  sg.open();
  await assert.rejects(staging);
  const r = await completion; assert.equal(r.fenced, true); assert.equal(await lockExcluded(w.haFile), true);
});
test('G6 positive control: an unchanged live owner stages and serves normally (no spurious r4 refusal)', async t => {
  const w = await world(t), g = await serving(w);
  assert.equal(w.gate.assert(ID, { host: HOST, generation: 3, hostAuthority: g.hostAuthority }), g.validUntil); assert.equal(w.vms.size, 1);
});
test('G7 lock loss: the OLD gate assert refuses on use (not only on a later journal write) and withdraws the tracked resource', async t => {
  const w = await world(t), g = await serving(w);
  fs.unlinkSync(`${w.haFile}.lock`);
  assert.throws(() => w.gate.assert(ID, { host: HOST, generation: 3, hostAuthority: g.hostAuthority }), /no current serving permit/);
  assert.equal(w.gate.closed, true); await tick(); assert.equal(w.vms.size, 0);
});
test('G8 witness lock loss while signing awaits readiness: the request is cancelled, no signature released', async t => {
  const w = await world(t), hg = gate(); w.S.healthGate = hg.p;
  const s = Math.floor(Date.now() / 1000), record = { deployment: ID, host: HOST, generation: 3, policyRevision: 1, sequence: 1, issuedAt: s, validUntil: s + 20, hostAuthority: w.S.ctx };
  const pending = w.W[0].witness.permit(record, await signServingPermit(w.operator, PINS, record));
  await tick();
  fs.unlinkSync(path.join(w.dir, 'w0-ha.json.lock'));
  hg.open();
  await assert.rejects(pending, /ownership lost|closed|abort|released/);
  assert.equal(w.W[0].witness.closed, true);
});
