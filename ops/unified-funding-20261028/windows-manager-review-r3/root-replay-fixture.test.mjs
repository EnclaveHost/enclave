// permit r2 repair tests (AUTHORED, NOT RUN by the author). Portable Linux TEST: in-process exclusion, injected fs/timer
// failures. Nothing here is Windows, NTFS, Hyper-V or Base evidence. Root must run with an owned persistent TMPDIR
// (not tmpfs /tmp: the launch journal refuses tmpfs by design).
// Section 1 is the root's three executed tests (windows-manager-root-review-r1/root.test.mjs) with import paths changed only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openOwnedLog, initializeOwnedLog, TEST_inProcessExclusion} from './candidate/control/windows/vbslike/manager/win-durable.mjs';
import {openPermitJournal} from './candidate/control/windows/vbslike/manager/permit-journal.mjs';
import {PermitGuard, GUARD_PURPOSE} from './candidate/control/windows/vbslike/guard/guard-core.mjs';
import {windowsNumericExclusion, validateExlockQualification, NODE_RUNTIME_PIN, UV_FS_O_EXLOCK_NUMERIC, QUALIFICATION_SCHEMA} from './candidate/control/windows/vbslike/manager/win-exclusion.mjs';
import {PermitEnforcement, CONFIG_SCHEMA, TEST_QUALIFICATION} from './candidate/control/windows/vbslike/manager/permit-enforcement.mjs';
import {hostAuthority, HOST, PINS} from './candidate/test/windows-permit/helpers/world.mjs';

// ---------------- 1. ROOT TESTS (unchanged intent/assertions) ----------------
const D='0x'+'11'.repeat(32);
function logFor(t,purpose='enclave-manager-permit/1') {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'enclave-root-permit-test-'));
 const file=path.join(dir,'journal'); initializeOwnedLog(file,{purpose});
 const ex=TEST_inProcessExclusion();const open=()=>openOwnedLog(file,{purpose,exclusion:ex});
 const log=open();t.after(()=>{log.release();fs.rmSync(dir,{recursive:true,force:true});});return {log,open};
}
test('ROOT release immediately revokes retained admission while retaining physical ownership during withdrawal', async t=>{
 const {log,open}=logFor(t);const j=openPermitJournal(log);
 let finish;const held=new Promise(r=>finish=r);j.hostAuthority.onRelease(()=>held);
 const release=j.release('owner shutdown');await Promise.resolve();
 assert.throws(()=>open(),/owned/);
 let refused=false;try{j.observeAssignment(D,1,1);}catch{refused=true;}
 finish();await release;
 assert.equal(refused,true,'retained journal admitted a new assignment while release was pending');
});
test('ROOT authenticated hash chain does not admit semantically invalid replay rows',t=>{
 const {log,open}=logFor(t);
 log.append('lc',{id:D,row:{generation:-1,revision:1,sequence:0,digest:null,fenced:false,denial:null,binding:null}});log.release();
 const second=open();t.after(()=>second.release());
 assert.throws(()=>openPermitJournal(second),undefined,'negative generation accepted on cold replay');
});
test('ROOT rejected expired registration leaves no armed record invisible to session-death cleanup',async t=>{
 const {log}=logFor(t,GUARD_PURPOSE);
 const guard=new PermitGuard({log,backend:{survey:async()=>({vms:[]}),removeById:async()=>({found:false,removed:false})},bootId:'TEST',now:()=>1000,monotonic:()=>0,maxLaunchMs:0});
 await guard.start();const s=guard.attach({pid:1,created:'TEST',epoch:'a'.repeat(32)});
 assert.throws(()=>guard.register(s,{instanceId:'pp'+'b'.repeat(32),deployment:D,launchEpoch:'c'.repeat(32),wallUntil:999,remainingMs:1}),/deadline already passed/);
 guard.sessionEnded(s,'TEST death');await guard.stop();
 assert.equal(guard.status().armed,0,'rejected registration remains durably armed without a timer or session-death cleanup');
});

// ---------------- helpers ----------------
const A = '0x' + 'aa'.repeat(32), B = '0x' + 'bb'.repeat(32), BH = '0x' + 'cc'.repeat(32);
const IID = 'pp' + 'd'.repeat(32), GUIDV = '12345678-1234-1234-1234-123456789abc';
const row = (o = {}) => ({ generation: 1, revision: 1, sequence: 0, digest: null, fenced: false, denial: null, binding: null, ...o });
const inst = (o = {}) => ({ instanceId: IID, deployment: D, generation: 1, launchEpoch: 'c'.repeat(32), managerEpoch: 'e'.repeat(32), state: 'staging',
  stagingWallUntil: 5000, vmId: null, appId: null, runtimeId: null, image: null, recordSha256: null, permit: null, reason: null, error: null, at: 1, ...o });
const haEntry = (c, offline = null, bound = {}) => ({ floor: { hostGeneration: c.hostGeneration, ownerRevision: c.ownerRevision, digest: c.digest, context: c, offline }, bound });
/** append raw (well-chained) records, release, then cold-open the journal semantics */
function replay(t, records) {
  const { log, open } = logFor(t);
  for (const [k, d] of records) log.append(k, d);
  log.release();
  const again = open(); t.after(() => again.release());
  return () => openPermitJournal(again);
}

// ---------------- 2. release: admissions revoked at BEGIN, physical ownership until confirmed withdrawal ----------------
test('r2 release: every admission path refuses while withdrawal-direction writes still land under the held handle', async (t) => {
  const { open, log } = logFor(t); const j = openPermitJournal(log);
  const ha1 = hostAuthority();
  j.hostAuthority.accept(HOST, ha1); j.observeAssignment(D, 1, 1); j.putInstance(inst(), { admission: true });
  let finish; const held = new Promise((r) => { finish = r; }); j.hostAuthority.onRelease(() => held);
  const release = j.release('TEST');
  assert.throws(() => j.assertLive(), /revoked/); assert.throws(() => j.hostAuthority.assertLive(), /revoked/);
  assert.throws(() => j.permit(D, { generation: 1, revision: 1, sequence: 1, digest: A }), /revoked/);
  assert.throws(() => j.restoreDenial(D, 1), /revoked|restoration/);
  assert.throws(() => j.hostAuthority.accept(HOST, hostAuthority({ hostGeneration: '2' })), /revoked/);
  assert.throws(() => j.hostAuthority.bind(HOST, D, ha1, { kind: 'fresh-queued-start', at: 1 }), /revoked/);
  assert.throws(() => j.putInstance(inst({ instanceId: 'pp' + 'e'.repeat(32) }), { admission: true }), /revoked/);
  assert.throws(() => j.hostAuthority.onRelease(() => {}), /releasing/);
  // narrow cleanup authority
  j.fence(D, 1); j.deny(D, { blockNumber: 3 });
  j.putInstance(inst({ state: 'removing', reason: 'TEST withdraw' }));
  assert.throws(() => open(), /owned/, 'physical handle must stay held while withdrawal is pending');
  finish(); assert.deepEqual(await release, { released: true });
  const again = open(); t.after(() => again.release());
  const j2 = openPermitJournal(again);
  assert.equal(j2.read(D).fenced, true); assert.equal(j2.instance(IID).state, 'removing');
});

test('r2 release: a rejected listener keeps the handle owned and admissions revoked; release() retries only the failed listener', async (t) => {
  const { open, log } = logFor(t); const j = openPermitJournal(log);
  let okCalls = 0, badCalls = 0, fail = true;
  j.hostAuthority.onRelease(() => { okCalls++; });
  j.hostAuthority.onRelease(() => { badCalls++; if (fail) throw Error('TEST withdrawal not confirmed'); });
  const first = await j.release('TEST');
  assert.equal(first.released, false); assert.equal(first.retryable, true); assert.match(first.errors[0], /not confirmed/);
  assert.throws(() => open(), /owned/, 'a failed withdrawal must not let a new owner start');
  assert.throws(() => j.observeAssignment(D, 1, 1), /revoked/, 'admissions stay revoked after a failed release');
  fail = false;
  assert.deepEqual(await j.release('TEST retry'), { released: true });
  assert.equal(okCalls, 1, 'a succeeded listener is not re-run'); assert.equal(badCalls, 2);
  const again = open(); again.release();
});

test('r2 release: the REAL r18 gate closes through the journal listener and new gate work is refused at release begin', async (t) => {
  const { log } = logFor(t); const j = openPermitJournal(log);
  const { DeploymentPermitGate } = await import('./candidate/control/network/deployment-permit-gate.mjs');
  const gate = new DeploymentPermitGate({ pins: PINS, journal: j, hostAuthority: j.hostAuthority });
  let staged = 0; gate.stage(D, () => { staged++; });
  const p = j.release('TEST');
  assert.equal(gate.ownerLive(), false);
  assert.throws(() => gate.work(Promise.resolve()), /closed/);
  assert.deepEqual(await p, { released: true }); assert.equal(staged, 1, 'staged compute withdrawn by the gate close');
});

// ---------------- 3. replay semantics ----------------
test('r2 replay: positive cold reopen reproduces every section written through the journal API', async (t) => {
  const { open, log } = logFor(t); const j = openPermitJournal(log);
  const ha1 = hostAuthority(), ha2 = hostAuthority({ hostGeneration: '2' });
  j.observeAssignment(D, 1, 1, A); j.permit(D, { generation: 1, revision: 1, sequence: 1, digest: B });
  j.deny(D, { blockNumber: 7 }); j.restoreDenial(D, 8); j.fence(D, 1);
  j.hostAuthority.accept(HOST, ha1); j.hostAuthority.bind(HOST, D, ha1, { kind: 'fresh-queued-start', at: 1 });
  assert.equal(j.hostAuthority.observe(HOST, { proofVerified: true, status: 'offline', context: ha2, blockHash: BH, blockNumber: '9' }), 'recorded');
  j.hostAuthority.unbind(HOST, D);
  j.putInstance(inst(), { admission: true });
  j.putInstance(inst({ state: 'staged', vmId: GUIDV, appId: 'app', runtimeId: 'rt', image: 'img' }));
  j.putInstance(inst({ state: 'serving', vmId: GUIDV, appId: 'app', runtimeId: 'rt', image: 'img', permit: { digest: B, sequence: 1, wallUntil: 9000 } }));
  j.putInstance(inst({ state: 'removing', vmId: GUIDV, appId: 'app', runtimeId: 'rt', image: 'img', permit: { digest: B, sequence: 1, wallUntil: 9000 } }));
  j.putInstance(inst({ state: 'removed', vmId: GUIDV, appId: 'app', runtimeId: 'rt', image: 'img', permit: { digest: B, sequence: 1, wallUntil: 9000 }, confirmed: { by: 'survey', at: 2, vmId: GUIDV } }));
  const before = { lc: j.read(D), ha: j.hostAuthority.read(HOST), inst: j.instance(IID) };
  assert.deepEqual(await j.release(), { released: true });
  const again = open(); t.after(() => again.release());
  const j2 = openPermitJournal(again);
  assert.deepEqual({ lc: j2.read(D), ha: j2.hostAuthority.read(HOST), inst: j2.instance(IID) }, before);
  assert.equal(j2.hostAuthority.read(HOST).floor.offline.hostGeneration, '2');
  assert.throws(() => j2.putInstance(inst({ state: 'staging' }), { admission: true }), /never revived/);
  assert.match(j2.provenance().authenticity, /none from the chain/);
});

const corrupt = {
  'negative revision': [['lc', { id: D, row: row({ revision: -1 }) }]],
  'generation rollback': [['lc', { id: D, row: row({ generation: 2 }) }], ['lc', { id: D, row: row({ generation: 1 }) }]],
  'revision rollback': [['lc', { id: D, row: row({ revision: 3 }) }], ['lc', { id: D, row: row({ revision: 2 }) }]],
  'sequence equivocation': [['lc', { id: D, row: row({ sequence: 1, digest: A }) }], ['lc', { id: D, row: row({ sequence: 1, digest: B }) }]],
  'sequence rollback': [['lc', { id: D, row: row({ sequence: 2, digest: A }) }], ['lc', { id: D, row: row({ sequence: 1, digest: B }) }]],
  'new generation keeps old sequence': [['lc', { id: D, row: row({ sequence: 1, digest: A }) }], ['lc', { id: D, row: row({ generation: 2, sequence: 1, digest: A }) }]],
  'binding equivocation': [['lc', { id: D, row: row({ binding: A }) }], ['lc', { id: D, row: row({ binding: B }) }]],
  'unfenced without newer assignment': [['lc', { id: D, row: row({ fenced: true }) }], ['lc', { id: D, row: row() }]],
  'denial floor rollback': [['lc', { id: D, row: row({ denial: { blockNumber: 5 } }) }], ['lc', { id: D, row: row({ denial: { blockNumber: 4 } }) }]],
  'sequence without digest': [['lc', { id: D, row: row({ sequence: 1 }) }]],
  'unknown lc field': [['lc', { id: D, row: { ...row(), extra: 1 } }]],
  'string generation': [['lc', { id: D, row: row({ generation: '1' }) }]],
  'uppercase deployment id': [['lc', { id: '0x' + 'AA'.repeat(32), row: row() }]],
  'unknown record kind': [['bogus', { x: 1 }]],
  'instance first record not staging': [['inst', { instanceId: IID, rec: inst({ state: 'serving' }) }]],
  'instance revived': [['inst', { instanceId: IID, rec: inst() }], ['inst', { instanceId: IID, rec: inst({ state: 'removing' }) }],
    ['inst', { instanceId: IID, rec: inst({ state: 'removed', confirmed: { by: 'survey', at: 1 } }) }], ['inst', { instanceId: IID, rec: inst() }]],
  'instance launch epoch changed': [['inst', { instanceId: IID, rec: inst() }], ['inst', { instanceId: IID, rec: inst({ launchEpoch: 'f'.repeat(32) }) }]],
  'instance unknown field': [['inst', { instanceId: IID, rec: { ...inst(), secrets: true } }]],
  'instance removal back to serving': [['inst', { instanceId: IID, rec: inst() }], ['inst', { instanceId: IID, rec: inst({ state: 'removing' }) }],
    ['inst', { instanceId: IID, rec: inst({ state: 'serving', vmId: GUIDV, appId: 'a', runtimeId: 'r', permit: { digest: A, sequence: 1, wallUntil: 1 } }) }]],
  'removed without confirmation': [['inst', { instanceId: IID, rec: inst() }], ['inst', { instanceId: IID, rec: inst({ state: 'removing' }) }], ['inst', { instanceId: IID, rec: inst({ state: 'removed' }) }]],
  'host authority rollback': [['ha', { hostId: HOST, entry: haEntry(hostAuthority({ hostGeneration: '2' })) }], ['ha', { hostId: HOST, entry: haEntry(hostAuthority()) }]],
  'host authority forged digest': [['ha', { hostId: HOST, entry: haEntry({ ...hostAuthority(), policyHash: A }) }]],
  'Offline cleared at same generation': [['ha', { hostId: HOST, entry: haEntry(hostAuthority(), { hostGeneration: '1', ownerRevision: '1', digest: hostAuthority().digest, blockHash: BH, blockNumber: '1' }) }],
    ['ha', { hostId: HOST, entry: haEntry(hostAuthority()) }]],
};
for (const [name, records] of Object.entries(corrupt))
  test(`r2 replay refuses a well-chained but impossible journal: ${name}`, (t) => {
    assert.throws(replay(t, records), /permit journal|unknown/);
  });

test('r2 replay: an injected flush failure latches the handle; the landed intent is replayed (outcome unknown is conservative)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enclave-r2-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'journal'); initializeOwnedLog(file, { purpose: 'enclave-manager-permit/1' });
  let failFsync = false;
  const fsImpl = { ...fs, constants: fs.constants, fsyncSync: (fd) => { if (failFsync) throw Error('TEST injected flush failure'); return fs.fsyncSync(fd); } };
  const ex = TEST_inProcessExclusion();
  const log = openOwnedLog(file, { purpose: 'enclave-manager-permit/1', exclusion: ex, fsImpl });
  const j = openPermitJournal(log);
  failFsync = true;
  assert.throws(() => j.putInstance(inst(), { admission: true }), /outcome unknown/);
  assert.throws(() => j.instance(IID), /failed/, 'a latched handle refuses every later use');
  assert.equal((await j.release()).released, true);
  const again = openOwnedLog(file, { purpose: 'enclave-manager-permit/1', exclusion: ex }); t.after(() => again.release());
  assert.equal(openPermitJournal(again).instance(IID).state, 'staging', 'the unacknowledged staging intent is present: next startup must survey/remove it');
});

// ---------------- 4. guard: validation before durable arm; durable record owns cleanup ----------------
const backendNone = { survey: async () => ({ vms: [] }), removeById: async () => ({ found: false, removed: false }) };
const REG = { instanceId: 'pp' + 'b'.repeat(32), deployment: D, launchEpoch: 'c'.repeat(32) };
test('r2 guard: invalid admission fields write nothing', async (t) => {
  const { log } = logFor(t, GUARD_PURPOSE);
  const guard = new PermitGuard({ log, backend: backendNone, bootId: 'TEST', now: () => 1000, monotonic: () => 0, maxLaunchMs: 0 });
  await guard.start(); const s = guard.attach({ pid: 1, created: 'TEST', epoch: 'a'.repeat(32) });
  const n = log.rows().length;
  for (const bad of [{ remainingMs: 0, wallUntil: 5000 }, { remainingMs: 1e9, wallUntil: 5000 }, { remainingMs: 10, wallUntil: 5000, kind: 'serving' },
    { remainingMs: 10, wallUntil: 5000, launchEpoch: 'x' }, { remainingMs: 10, wallUntil: 1000 }])
    assert.throws(() => guard.register(s, { ...REG, ...bad }));
  assert.equal(log.rows().length, n, 'a refused registration is never durable');
  await guard.stop();
});
test('r2 guard: timer installation failure after the durable arm expires the instance (never armed without a timer)', async (t) => {
  const { log } = logFor(t, GUARD_PURPOSE);
  let breakTimers = false;
  const timers = { set: (fn, ms) => { if (breakTimers) { breakTimers = false; throw Error('TEST timer failure'); } return setTimeout(fn, ms); }, clear: clearTimeout };
  const guard = new PermitGuard({ log, backend: backendNone, bootId: 'TEST', now: () => 1000, monotonic: () => 0, maxLaunchMs: 0, timers });
  await guard.start(); const s = guard.attach({ pid: 1, created: 'TEST', epoch: 'a'.repeat(32) });
  breakTimers = true;
  assert.throws(() => guard.register(s, { ...REG, wallUntil: 60_000, remainingMs: 30_000 }), /not armed/);
  assert.equal(guard.status().armed, 0); assert.deepEqual(guard.status().unguarded, []);
  await guard.stop();
  assert.equal(guard.regs.get(REG.instanceId).state, 'removed');
});
test('r2 guard: a write whose outcome is unknown is owned and removed, never forgotten', async (t) => {
  const { log } = logFor(t, GUARD_PURPOSE);
  // TEST wrapper: the record LANDS, then the append reports a flush failure once. (Models the outcome-unknown branch only;
  // real win-durable latching refuses all later writes, which is covered by the permit-journal flush test above.)
  let failNext = false, latched = null;
  const flaky = { ...log, append: (k, d, o) => { if (failNext && k === 'reg') { failNext = false; log.append(k, d, o); latched = 'TEST flush failure'; throw Error(latched); } return log.append(k, d, o); },
    failed: () => latched ?? log.failed() };
  const guard = new PermitGuard({ log: flaky, backend: backendNone, bootId: 'TEST', now: () => 1000, monotonic: () => 0, maxLaunchMs: 0 });
  await guard.start(); const s = guard.attach({ pid: 1, created: 'TEST', epoch: 'a'.repeat(32) });
  failNext = true;
  assert.throws(() => guard.register(s, { ...REG, wallUntil: 60_000, remainingMs: 30_000 }), /flush failure/);
  await guard.stop();
  const states = log.rows().filter((r) => r.kind === 'reg').map((r) => r.data.rec.state);
  assert.deepEqual(states, ['armed', 'removing', 'removed']);
});
test('r2 guard: session death and stop cover a durable armed record that has no live timer', async (t) => {
  const { log } = logFor(t, GUARD_PURPOSE);
  const guard = new PermitGuard({ log, backend: backendNone, bootId: 'TEST', now: () => 1000, monotonic: () => 0, maxLaunchMs: 0 });
  await guard.start(); const s = guard.attach({ pid: 1, created: 'TEST', epoch: 'a'.repeat(32) });
  guard.register(s, { ...REG, wallUntil: 60_000, remainingMs: 30_000 });
  const l = guard.live.get(REG.instanceId); clearTimeout(l.timer); guard.live.delete(REG.instanceId);   // simulate a lost timer
  assert.deepEqual(guard.status().unguarded, [REG.instanceId], 'an unguarded armed record is visible');
  guard.sessionEnded(s, 'TEST death'); await guard.stop();
  assert.equal(guard.regs.get(REG.instanceId).state, 'removed');
});
test('r2 guard: an expired renew writes nothing and keeps the previous deadline in force', async (t) => {
  const { log } = logFor(t, GUARD_PURPOSE);
  let wall = 1000;
  const guard = new PermitGuard({ log, backend: backendNone, bootId: 'TEST', now: () => wall, monotonic: () => 0, maxLaunchMs: 0 });
  await guard.start(); const s = guard.attach({ pid: 1, created: 'TEST', epoch: 'a'.repeat(32) });
  guard.register(s, { ...REG, wallUntil: 60_000, remainingMs: 30_000 });
  guard.bindVm(s, { instanceId: REG.instanceId, vmId: GUIDV });
  const n = log.rows().length, old = guard.live.get(REG.instanceId);
  wall = 50_000;
  assert.throws(() => guard.renew(s, { instanceId: REG.instanceId, permitDigest: 'a'.repeat(64), wallUntil: 49_000, remainingMs: 10 }), /deadline already passed/);
  assert.equal(log.rows().length, n); assert.equal(guard.live.get(REG.instanceId), old);
  await guard.stop();
});
test('r2 guard: an impossible replayed registration refuses the guard', (t) => {
  const { log, open } = logFor(t, GUARD_PURPOSE);
  log.append('reg', { instanceId: REG.instanceId, rec: { ...REG, appId: null, kind: 'staging', vmId: null, permitDigest: null, wallUntil: 1,
    session: { epoch: 'a'.repeat(32), pid: 1, created: 'TEST' }, bootId: 'TEST', state: 'removed', at: 1, error: null, reason: null } });
  log.release();
  const again = open(); t.after(() => again.release());
  assert.throws(() => new PermitGuard({ log: again, backend: backendNone, bootId: 'TEST', monotonic: () => 0 }), /guard journal/);
});

// ---------------- 5. enforcement: removal not blocked by hung startup/cleanup; honest hold acknowledgment ----------------
function enforcementWith(t, manager, dataPlane) {
  const { log } = logFor(t); const journal = openPermitJournal(log);
  const config = { schema: CONFIG_SCHEMA, pins: PINS, host: HOST, maxStagingMs: 60_000, derivations: ['enclave-catalog-bundle/1'], qualification: TEST_QUALIFICATION, retryMs: 100 };
  const e = new PermitEnforcement({ config, manager, journal, dataPlane });
  journal.putInstance(inst({ managerEpoch: manager.epoch }), { admission: true });
  return { e, journal };
}
test('r2 enforcement: a hung raw startup does not block withdrawal; absence is confirmed only after the launch settles', async (t) => {
  let settle; const spawn = new Promise((r) => { settle = r; });
  const manager = { epoch: 'e'.repeat(32), domains: new Map(), backend: { survey: async () => ({ vms: [] }) }, removeRecord: async () => ({}) };
  const { e, journal } = enforcementWith(t, manager, { closeInstance() {} });
  e.spawns.set(IID, spawn);
  await assert.rejects(e.withdraw(IID, 'TEST'), /still in flight/);
  assert.equal(journal.instance(IID).state, 'remove-failed');
  settle(); e.spawns.delete(IID);
  const end = Date.now() + 3000;
  while (journal.instance(IID).state !== 'removed' && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  assert.equal(journal.instance(IID).state, 'removed');
});
test('r2 enforcement: a hung installed removal stays owned and unconfirmed; a failed data-plane close is not acknowledged as ingress withdrawn', async (t) => {
  let finish; const hung = new Promise((r) => { finish = r; });
  const manager = { epoch: 'e'.repeat(32), domains: new Map([[IID, {}]]), backend: { survey: async () => ({ vms: [] }) },
    removeRecord: () => hung.then(() => { manager.domains.delete(IID); }) };
  const { e, journal } = enforcementWith(t, manager, { closeInstance() { throw Error('TEST close failed'); } });
  const ack = await e.hold(IID, 'TEST hold');
  assert.equal(ack.ingress, false); assert.match(ack.basis.ingress, /FAILED/);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(journal.instance(IID).state, 'remove-failed');
  assert.match(journal.instance(IID).error, /still running/);
  finish();
  const end = Date.now() + 3000;
  while (journal.instance(IID).state !== 'removed' && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  assert.equal(journal.instance(IID).state, 'removed');
});

// ---------------- 6. Windows numeric EXLOCK adapter (TEST doubles only: NOT a Windows qualification) ----------------
const Q = { schema: QUALIFICATION_SCHEMA, nodeVersion: NODE_RUNTIME_PIN.version, execSha256: NODE_RUNTIME_PIN.execSha256, flag: UV_FS_O_EXLOCK_NUMERIC,
  crossProcessOpenRefused: true, crossProcessRenameRefused: true, crossProcessDeleteRefused: true, holderDeathReleases: true, sameProcessSecondOpenRefused: true,
  evidenceSha256: '0'.repeat(64), qualifiedBy: 'root' };
const RT = { platform: 'win32', version: NODE_RUNTIME_PIN.version, execPath: NODE_RUNTIME_PIN.execPath, execSha256: NODE_RUNTIME_PIN.execSha256 };
test('r2 EXLOCK adapter: refuses without an exact qualification, on another runtime, or on Linux', () => {
  const fsImpl = { constants: { O_RDWR: 2 }, openSync() { throw Error('must not open'); }, closeSync() {} };
  assert.throws(() => windowsNumericExclusion({ qualification: null, runtime: RT, fsImpl }), /qualification/);
  assert.throws(() => windowsNumericExclusion({ qualification: { ...Q, holderDeathReleases: false }, runtime: RT, fsImpl }), /holderDeathReleases/);
  assert.throws(() => windowsNumericExclusion({ qualification: Q, runtime: { ...RT, platform: 'linux' }, fsImpl }), /Windows-only/);
  assert.throws(() => windowsNumericExclusion({ qualification: Q, runtime: { ...RT, execSha256: 'f'.repeat(64) }, fsImpl }), /pinned/);
  assert.throws(() => windowsNumericExclusion({ qualification: Q, runtime: RT, fsImpl: { ...fsImpl, constants: { O_RDWR: 2, UV_FS_O_EXLOCK: 1 } } }), /differs/);
  assert.throws(() => validateExlockQualification({ ...Q, extra: 1 }), /unknown or missing/);
});
test('r2 EXLOCK adapter: an ignored flag (second open succeeds) refuses and closes both handles; a sharing violation passes', () => {
  const closed = [];
  let n = 0;
  const ignoring = { constants: { O_RDWR: 2 }, openSync: () => ++n, closeSync: (fd) => closed.push(fd) };
  const ex = windowsNumericExclusion({ qualification: Q, runtime: RT, fsImpl: ignoring });
  assert.throws(() => ex.open('C:\\x'), (e) => e.code === 'EXLOCK_UNQUALIFIED');
  assert.deepEqual(closed.sort(), [1, 2]);
  let first = true;
  const honouring = { constants: { O_RDWR: 2 }, openSync: () => { if (first) { first = false; return 7; } throw Object.assign(Error('busy'), { code: 'EBUSY' }); }, closeSync() {} };
  assert.equal(windowsNumericExclusion({ qualification: Q, runtime: RT, fsImpl: honouring }).open('C:\\x'), 7);
});
