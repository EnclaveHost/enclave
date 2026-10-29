// async r4 suite + root r8 ROOT boundary tests + completion r5 section (AUTHORED, NOT RUN; root executes). Runs in the FINAL layered native
// tree whose network/ holds the r5-GENERATED gate/witness/runtime/serving-permit (generate-host-authority-permit-candidates.mjs over the
// pinned baselines), owned-durable-state.mjs, both sidecar journals, lifecycle-host-owned-authority.mjs, the generated composer/dispatch
// and the existing runtime-lock.mjs (real flock); test/helpers/ownership-fixture.mjs = candidate test/helpers/lifecycle-fixture.mjs.
// REAL: owned-durable-state + real flock, the generated DeploymentPermitGate / DeploymentLifecycleWitness / createIsolationLifecycleRuntime,
// createPermitCollector, v2 typed signatures (viem), the owned protocol journal (openLifecycleJournal), the proposed owned composition and
// cold-recovery entry, and real files.
// SYNTHETIC (labelled TEST doubles; not hardware, chain or enforcement evidence): each witness's chain reader, readiness, witness transport,
// the guestd manager client (with explicit await gates), launch plans, boundary hold/allow acknowledgements, the canonical-adapter stand-in
// and the in-memory parent lifecycle journal used by the composition cases.
// COMPATIBILITY DELTA vs the 16 executed r4 tests (completion r5 policy): A1-A4, D1, G1-G8 are byte-for-byte the same assertions.
//   D2: the history now also holds the durable `unproven` record written when the acknowledgement's final sync failed, so the assertions
//       select the `recovered` line instead of assuming one line (still exactly one recovery, outcome 'landed', seq 3, owner recorded).
//   D3: recovery now REQUIRES the actual owner lock of the file, so both recoveries run under openOwnedLock; the failed recovery
//       acknowledgement adds an `unproven` line, so the count is of `recovered` lines (still 2).
//   D4: the refusal is asserted for an OWNED handle (an unowned handle now refuses earlier, for lack of ownership).
// The three ROOT tests are copied verbatim from ownership-runtime-boundary-r8 (world() gains allowGate exactly as root's r8 world, plus
// holdGate/holdError/removeError controls used only by the r5 section).
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
import { openOwnedHostAuthorityWitness, openOwnedHostRegistryLifecycle, recoverOwnedHostSidecars } from '../network/lifecycle-host-owned-authority.mjs';
import { fixture, route, NEW, CTRL as FCTRL, PLATFORM } from './helpers/ownership-fixture.mjs';

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
const historyOf = f => fs.readFileSync(`${f}.history`, 'utf8').trim().split('\n').map(JSON.parse);

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
  const h = historyOf(f).filter(l => l.recovered === true);                     // r5: the durable `unproven` line precedes it
  assert.equal(h.length, 1); assert.equal(h[0].outcome, 'landed'); assert.equal(h[0].intent.seq, 3); assert.ok(h[0].by);
  assert.ok(historyOf(f).some(l => l.unproven === 3), 'r5: the failed final sync is durably recorded');
  assert.equal(openDurableState(f, { ...OPTS, established: true }).state.n, 2, 'positive: clean only after verified acknowledgement');
});
test('D3 recovery FINAL acknowledgement fault also survives a fresh open; a later successful recovery clears it', async t => {
  const f = path.join(tmp(t), 'state.json'), storeFault = dirFault(2, 'TEST state rename dirsync failure');
  const s = openDurableState(f, { ...OPTS, fsImpl: storeFault.io }); s.store({ n: 1 }); storeFault.arm();
  assert.throws(() => s.store({ n: 2 }), /state rename/); storeFault.disarm(); s.release();
  const recFault = dirFault(3, 'TEST recovery acknowledgement dirsync failure');   // recover: file dirsync, history dirsync, ACK dirsync
  const o1 = await openOwnedLock(f);
  const r1 = openDurableState(f, { ...OPTS, established: true, fsImpl: recFault.io, owner: o1 }); recFault.arm();
  assert.throws(() => r1.recover(), /recovery acknowledgement/); recFault.disarm();
  assert.throws(() => r1.state, /uncertain/, 'still latched in this process');
  assert.equal((await r1.release()).released, true);
  const o2 = await openOwnedLock(f); t.after(() => o2.release());
  const fresh = openDurableState(f, { ...OPTS, established: true, owner: o2 });
  assert.throws(() => fresh.state, /uncertain/, 'a failed recovery acknowledgement never reopens clean');
  assert.equal(fresh.recover(), 'landed'); assert.equal(fresh.state.n, 2);
  assert.equal(historyOf(f).filter(l => l.recovered === true).length, 2, 'both recovery attempts retained in provenance');
  assert.equal(openDurableState(f, { ...OPTS, established: true }).state.n, 2);
});
test('D4 established sidecar + marker loss refuses with established coupling; no recovery into empty state', async t => {
  const f = path.join(tmp(t), 'state.json'); openDurableState(f, OPTS).store({ n: 1 });
  for (const x of ['', '.established']) fs.rmSync(`${f}${x}`);
  const owner = await openOwnedLock(f); t.after(() => owner.release());
  const s = openDurableState(f, { ...OPTS, established: true, owner });
  assert.throws(() => s.state, /missing|established/); assert.throws(() => s.recover(), /missing/); assert.equal(fs.existsSync(f), false);
});

// ---------------- actual generated gate/runtime over the owned permit journal ----------------
async function world(t) {
  const dir = tmp(t), operator = privateKeyToAccount(generatePrivateKey()), now = () => Date.now();
  const witnesses = sorted([0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey())));
  const policy = { witnesses: witnesses.map(w => w.address), threshold: 3, revision: 1 };
  const S = { ctx: ctxOf(), block: H('e1'), allows: [], healthGate: null, lookupGate: null, spawnGate: null, removeGate: null, removeError: null,
    allowGate: null, holdGate: null, holdError: null, calls: { spawn: 0, lookup: 0, remove: 0 } };
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
  const boundaries = {                                                                                                                         // SYNTHETIC boundary acks
    async hold(id) { if (S.holdGate) { const wait = S.holdGate; S.holdGate = null; wait.entered(); await wait.p; } if (S.holdError) throw Error(S.holdError);
      return { deployment: id, ingress: true, storage: true, secrets: true }; },
    async allow(id, grant) { if (S.allowGate) { const wait = S.allowGate; S.allowGate = null; wait.entered(); await wait.p; } S.allows.push(grant); return { deployment: id, generation: grant.generation, validUntil: grant.validUntil, expiryEnforced: true, hostAuthority: grant.hostAuthority }; } };
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

// ROOT additional failure boundaries. Same real generated runtime, journals and flock; TEST manager/boundary.
test('ROOT settled withdrawal failure must remain fenced at later owner close', async t => {
 const w=await world(t);await serving(w);w.S.removeError='ROOT persistent removal failure';
 w.gate.hold(ID,'ROOT permit withdrawn');await tick(30);
 const result=await w.owner.release('ROOT later owner close');
 console.log('ROOT settled failure',JSON.stringify({result,instances:w.vms.size}));
 assert.equal(result.fenced,true,'settled failure must not be forgotten');assert.equal(await lockExcluded(w.haFile),true);
});
test('ROOT completed staging remains owned until compute is actually withdrawn', async t => {
 const w=await world(t);const result=await w.runtime.ensureStaged(ID,w.snapshot('queued'));assert.equal(result.ready,true);assert.equal(w.vms.size,1);
 const close=await w.owner.release('ROOT close before first serve');
 console.log('ROOT staged release',JSON.stringify({close,instances:w.vms.size}));
 assert.equal(close.released,true);assert.equal(w.vms.size,0,'completed stage is still owned compute');
});
test('ROOT delayed allow must settle before an owner releases exclusion', async t => {
 const w=await world(t);await w.runtime.ensureStaged(ID,w.snapshot('queued'));const g=awaitGate();w.S.allowGate=g;
 const servingResult=w.runtime.serve(ID,w.snapshot('running')).then(()=>({ok:true}),e=>({ok:false,error:e.message}));await g.reached;
 const completion=w.owner.release('ROOT close while allow pending');const state=await pendingState(completion);const excluded=await lockExcluded(w.haFile);
 g.open();const outcome=await servingResult;await completion;
 console.log('ROOT delayed allow',JSON.stringify({state,excluded,outcome}));
 assert.equal(state,'pending','an in-flight allow still owns the withdrawal barrier');assert.equal(excluded,true);assert.equal(outcome.ok,false);
});

// ---------------- completion r5 ----------------
const doubleFault = (n, label) => { let armed = false, count = 0;   // TEST: final dirsync n fails AND the acknowledgement retraction rename fails
  return { arm() { armed = true; count = 0; }, disarm() { armed = false; },
    io: (f) => ({ ...fs, fsyncSync(fd) { if (armed && fs.fstatSync(fd).isDirectory() && ++count === n) throw Error(label); return fs.fsyncSync(fd); },
      renameSync(src, dst) { if (armed && src === `${f}.commit`) throw Error('TEST retraction failure'); return fs.renameSync(src, dst); } }) }; };
test('R1 store double fault (final ACK sync AND retraction) never reopens clean; recovery needs THIS file\'s actual lock; owned recovery then reopen', async t => {
  const d = tmp(t), f = path.join(d, 'x.json'), fault = doubleFault(3, 'TEST final ack fsync'), io = fault.io(f);
  const s = openDurableState(f, { ...OPTS, fsImpl: io }); s.store({ n: 1 }); fault.arm();
  assert.throws(() => s.store({ n: 2 }), /retraction ALSO failed/); fault.disarm(); await s.release();
  assert.ok(fs.existsSync(`${f}.commit`), 'the visible (unproven) acknowledgement is still there');
  const unowned = openDurableState(f, { ...OPTS, established: true });
  assert.throws(() => unowned.state, /uncertain/); assert.throws(() => unowned.recover(), /actual owner lock/);
  const other = await openOwnedLock(path.join(d, 'other.json')); t.after(() => other.release());
  assert.throws(() => openDurableState(f, { ...OPTS, established: true, owner: other }).recover(), /another file/, 'an owner lock of another file is not ownership');
  const owner = await openOwnedLock(f); t.after(() => owner.release());
  await assert.rejects(openOwnedLock(f, { timeoutMs: 150 }), undefined, 'same-file owner exclusion while recovering');
  const own = openDurableState(f, { ...OPTS, established: true, owner });
  assert.throws(() => own.state, /uncertain/, 'a fresh OWNER does not silently clear it either');
  assert.equal(own.recover(), 'landed'); assert.equal(own.state.n, 2); assert.equal(own.verification().recovered, 'landed');
  assert.equal(openDurableState(f, { ...OPTS, established: true }).state.n, 2, 'positive after explicit owned recovery');
});
test('R2 recovery double fault (recovery ACK sync AND retraction) never reopens clean; a second owned recovery succeeds', async t => {
  const f = path.join(tmp(t), 'x.json'), s = openDurableState(f, OPTS); s.store({ n: 1 });
  fs.rmSync(`${f}.commit`);                                                     // TEST: an unacknowledged write (intent without acknowledgement)
  const fault = doubleFault(3, 'TEST recovery ack fsync'), o1 = await openOwnedLock(f);
  const r1 = openDurableState(f, { ...OPTS, established: true, owner: o1, fsImpl: fault.io(f) }); fault.arm();
  assert.throws(() => r1.recover(), /retraction ALSO failed/); fault.disarm(); await r1.release();
  assert.throws(() => openDurableState(f, { ...OPTS, established: true }).state, /uncertain/, 'visible recovery ACK is not proof');
  const o2 = await openOwnedLock(f); t.after(() => o2.release());
  const r2 = openDurableState(f, { ...OPTS, established: true, owner: o2 });
  assert.throws(() => r2.state, /uncertain/); assert.equal(r2.recover(), 'landed'); assert.equal(r2.state.n, 1);
  assert.ok(historyOf(f).some(l => l.unproven === 2) && historyOf(f).filter(l => l.recovered).length === 2);
});
test('R3 missing or malformed intent REFUSES owned recovery: nothing synthesized from current bytes', async t => {
  const f = path.join(tmp(t), 'x.json'); openDurableState(f, OPTS).store({ n: 1 });
  const owner = await openOwnedLock(f); t.after(() => owner.release());
  fs.renameSync(`${f}.intent`, `${f}.intent.saved`);
  assert.throws(() => openDurableState(f, { ...OPTS, established: true, owner }).recover(), /intent record missing/);
  assert.equal(fs.existsSync(`${f}.intent`), false, 'no synthesized intent');
  fs.writeFileSync(`${f}.intent`, '{"format":"owned-durable-intent/v2","file":"x.json","seq":"2"}');
  assert.throws(() => openDurableState(f, { ...OPTS, established: true, owner }).recover(), /malformed/);
});
test('R4 owned BOOT verification: a freshly acquired owner syncs + records provenance before use; a failing verification stays uncertain', async t => {
  const f = path.join(tmp(t), 'x.json'); openDurableState(f, OPTS).store({ n: 4 });
  const o1 = await openOwnedLock(f), v = openDurableState(f, { ...OPTS, established: true, owner: o1 });
  assert.equal(v.state.n, 4); assert.equal(v.verification().seq, 2); assert.ok(historyOf(f).some(l => l.outcome === 'open-verified' && l.by === o1.id));
  await v.release();
  const fault = dirFault(1, 'TEST boot verification dirsync failure'), o2 = await openOwnedLock(f); t.after(() => o2.release()); fault.arm();
  const bad = openDurableState(f, { ...OPTS, established: true, owner: o2, fsImpl: fault.io });
  assert.throws(() => bad.state, /verification failed/);
});
test('R5 a settled failure is cleared ONLY by explicit proof (authenticated Stop: confirmed absence + acknowledged hold); then release succeeds', async t => {
  const w = await world(t); await serving(w); w.S.removeError = 'TEST manager remove rejected';
  w.gate.hold(ID, 'TEST permit withdrawn'); await tick(30);
  assert.equal(w.gate.withdrawalFailures().length, 1, 'recorded after its Promise settled');
  assert.throws(() => w.gate.withdrawalProven(ID, { absent: true }), /proven absence/);
  w.S.removeError = null;
  assert.equal(await w.runtime.stop(ID), true); assert.equal(w.vms.size, 0);
  assert.equal(w.gate.withdrawalFailures().length, 0);
  assert.equal((await w.owner.release('TEST release after proven stop')).released, true);
});
test('R6 late allow after close with a FAILING boundary hold: compute removal still starts, the owner stays fenced (no silent late effect)', async t => {
  const w = await world(t); await w.runtime.ensureStaged(ID, w.snapshot('queued')); const ag = awaitGate(); w.S.allowGate = ag;
  const serve = w.runtime.serve(ID, w.snapshot('running')).then(() => 'served', e => e.message); await ag.reached;
  w.S.holdError = 'TEST boundary hold rejected';
  const completion = w.owner.release('TEST release during allow');
  ag.open();
  assert.notEqual(await serve, 'served');
  const r = await completion; assert.equal(r.fenced, true); assert.equal(w.vms.size, 0, 'independent compute removal started'); assert.equal(await lockExcluded(w.haFile), true);
});
test('R7 HUNG allow: the bounded boundary call times out, the late effect is withdrawn by an acknowledged fence, then (only then) the owner releases', async t => {
  const w = await world(t); await w.runtime.ensureStaged(ID, w.snapshot('queued')); const ag = awaitGate(); w.S.allowGate = ag;   // never opened
  const serve = w.runtime.serve(ID, w.snapshot('running')).then(() => 'served', e => e.message); await ag.reached;
  const completion = w.owner.release('TEST release during hung allow');
  assert.equal(await pendingState(completion), 'pending'); assert.equal(await lockExcluded(w.haFile), true);
  assert.match(await serve, /timed out|no current serving permit/);                                     // default boundaryTimeoutMs (3000)
  assert.equal((await completion).released, true); assert.equal(w.vms.size, 0);
  ag.open();
});
test('R8 witness owner release waits for the in-flight signing request to SETTLE (aborted is not proof of more than "no signature returned")', async t => {
  const w = await world(t), hg = gate(); w.S.healthGate = hg.p;
  const s = Math.floor(Date.now() / 1000), record = { deployment: ID, host: HOST, generation: 3, policyRevision: 1, sequence: 1, issuedAt: s, validUntil: s + 20, hostAuthority: w.S.ctx };
  const pending = w.W[0].witness.permit(record, await signServingPermit(w.operator, PINS, record)).then(() => 'signed', e => e.message); await tick();
  const completion = w.W[0].release('TEST witness owner release');
  assert.equal(await pendingState(completion), 'pending'); assert.equal(await lockExcluded(path.join(w.dir, 'w0-ha.json')), true);
  hg.open();
  assert.notEqual(await pending, 'signed'); assert.equal((await completion).released, true);
});

// ---- actual owned composition: two sidecar locks + parent lock; fenced reconciliation; cold recovery ----
async function composition(t, { removeError = null } = {}) {
  const f = fixture({ hostId: HOST, now: () => 1000 }), d = tmp(t);
  const { readHostIncarnation, acceptHostIncarnation, bindHostIncarnation, ...rest } = f.journal;   // SYNTHETIC in-memory parent journal
  const owned = { ...rest, beginAttempt: () => 1, rememberRuntime: (id, { instance, generation, now }) => ({ instance, generation, startedAt: now }) };
  const pins = { chainId: 8453, host: HOST, profile: 'independent-host-registry-r1', hostRegistry: { artifactSha256: 'e8690734c4fae1f1adfa3525061d5542b314704c997feec2daa09fdecd49f23a' },
    contracts: { registry: { address: REG, codeHash: CODE }, hostOwnership: { address: REG, codeHash: CODE }, ledger: { address: NEW, codeHash: H('11') },
      lifecycle: { address: FCTRL, codeHash: H('22') }, catalog: { address: A('cd'), codeHash: H('24') } } };
  const BUNDLE = 'bed9c19652edce8ca6f337f691a9909c15763e6755ff237139b07f4d84f3260e', ARTIFACT = pins.hostRegistry.artifactSha256;
  const adapter = { ...f.chain, profile: 'independent-host-registry-r1', lifecycleSchema: 3, lifecycleProofSchema: 2, bundleSha256: BUNDLE,
    hostRegistry: { address: REG, runtimeCodeHash: CODE, artifactSha256: ARTIFACT }, independence: { complete: false, blockers: ['TEST synthetic canonical adapter'] } };
  const binding = { lifecycleSchema: 3, profile: 'independent-host-registry-r1', bundleSha256: BUNDLE, hostRegistry: REG, hostRegistryCodeHash: CODE, hostRegistryArtifactSha256: ARTIFACT };
  const vms = new Map(), S = { removeError };
  const client = { async findByName(id) { return vms.get(id) ?? null; },                                                                      // SYNTHETIC manager
    async spawn(body) { const view = { id: 'vm-c1', name: body.name, status: 'running' }; vms.set(body.name, view); return { view }; },
    async remove(x) { if (S.removeError) throw Error(S.removeError); for (const [k, v] of vms) if (v.id === x || k === x) vms.delete(k); } };
  const parts = { hostId: HOST, ownedJournal: owned, incarnationFile: path.join(d, 'inc.json'), permitFile: path.join(d, 'permit.json'), parentLockFile: path.join(d, 'parent.json'),
    pins: PINS, adapter, adapterPins: pins, client, plans: { read: async id => ({ verified: true, host: HOST, body: { name: id }, stagingEnforced: true }) },
    readiness: { verify: async ({ deployment, generation, view }) => ({ verified: true, ready: true, deployment, host: HOST, generation, instance: view.id, validUntil: 1000 + 60000 }) },
    boundaries: { hold: async id => ({ deployment: id, ingress: true, storage: true, secrets: true }), allow: async () => ({}) },
    collectPermit: async () => { throw Error('TEST: no witness quorum in this case'); }, routes: [route(ID, binding)], platformWallets: [PLATFORM], capacityHeadroom: 0.05,
    verifyQuiescence: f.verifyQuiescence, now: () => 1000, timeoutMs: 200 };
  const snapshot = { schema: 2, id: ID, verified: true, authorityTier: 'finalized', blockAt: 1000, blockHash: H('e1'), thisHost: HOST, enabled: true, admitted: true, funded: true, policy: {},
    hostAuthorityEvidence: { context: ctxOf(), status: 'online', blockHash: H('e1'), blockNumber: '7', proofVerified: true },
    assignment: { state: 'queued', host: HOST, operator: A('0e'), generation: 2, revision: 1 } };
  return { parts, owned, vms, S, snapshot, d };
}
test('C1 composition FENCED by a failed staged-compute withdrawal keeps BOTH sidecar locks and the parent lock; scoped reconciliation still reads; writes refuse', async t => {
  const x = await composition(t), c = await openOwnedHostRegistryLifecycle(x.parts);
  const staged = await c.runtime.ensureStaged(ID, x.snapshot); assert.equal(staged.ready, true); assert.equal(x.vms.size, 1);
  x.S.removeError = 'TEST manager remove rejected';
  const p = c.release('TEST release'); assert.equal(c.release('again'), p, 'one completion published before callbacks');
  const r = await p; assert.equal(r.fenced, true); assert.equal(r.permit.fenced, true); assert.equal(r.incarnation.fenced, true); assert.equal(x.vms.size, 1);
  assert.equal(await excluded(x.parts.permitFile), true); assert.equal(await excluded(x.parts.incarnationFile), true); assert.equal(await excluded(x.parts.parentLockFile), true);
  await assert.rejects(openOwnedHostRegistryLifecycle(x.parts), undefined, 'no second owner while fenced');
  assert.deepEqual(c.journal.read(ID), x.owned.read(ID), 'scoped read-only reconciliation stays available');
  assert.throws(() => c.journal.prepareTransition(ID, { digest: H('79'), payload: 'TEST' }), /released/);
});
test('C2 cold restart: an unacknowledged sidecar write refuses composition; explicit owned recovery under the parent + both locks; composition serves again', async t => {
  const x = await composition(t), c1 = await openOwnedHostRegistryLifecycle(x.parts);
  await assert.rejects(recoverOwnedHostSidecars({ ...x.parts }), undefined, 'recovery excluded while a composition owns the host');
  assert.equal((await c1.release('TEST shutdown')).released, true);
  fs.rmSync(`${x.parts.permitFile}.commit`);                                    // TEST: the permit sidecar's last write has no acknowledgement
  await assert.rejects(openOwnedHostRegistryLifecycle(x.parts), /uncertain/);
  assert.equal(await excluded(x.parts.parentLockFile), false, 'the refused composition released every lock');
  const rec = await recoverOwnedHostSidecars({ ...x.parts });
  assert.equal(rec.incarnation, 'clean'); assert.equal(rec.permit, 'landed'); assert.equal(rec.released, true);
  const c2 = await openOwnedHostRegistryLifecycle(x.parts);
  assert.equal((await c2.runtime.ensureStaged(ID, x.snapshot)).ready, true, 'positive: usable again after verified recovery');
  assert.equal((await c2.release('TEST shutdown')).released, true); assert.equal(x.vms.size, 0, 'staged compute withdrawn at release');
});
