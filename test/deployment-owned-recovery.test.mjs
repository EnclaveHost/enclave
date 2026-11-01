import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { ownLifecycleJournal, recoverLifecycleJournal } from '../network/deployment-journal-owner.mjs';
import { openLifecycleJournal } from '../network/deployment-lifecycle-journal.mjs';
const id = '0x' + '12'.repeat(32), digest = '0x' + '34'.repeat(32), other = '0x' + '56'.repeat(32);
const intent = { digest, payload: '{"intent":"never-repeat"}' };
const helper = new URL('./helpers/owned-lifecycle-child.mjs', import.meta.url);
const sha = b => createHash('sha256').update(b).digest('hex');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-recovery-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  return path.join(dir, 'state.json');
}
function child(mode, file) {
  return spawnSync(process.execPath, [helper.pathname, mode, file], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
}
// Faults are injected only into the journal filesystem interface; flock,
// writes, reads, process death and recovery run against the real Linux kernel.
function faults(file) {
  let armed = null, renamed = null;
  const api = { ...fs,
    renameSync(from, to) {
      if (armed === 'before-state' && to === file) { armed = null; throw Error('injected before state rename'); }
      if (armed === 'ack-retract' && from === file + '.commit') throw Error('injected acknowledgement retraction failure');
      fs.renameSync(from, to); renamed = to;
    },
    fsyncSync(fd) {
      if (fs.fstatSync(fd).isDirectory() && armed === 'after-state' && renamed === file) {
        armed = null; throw Error('injected state directory sync failure');
      }
      if (fs.fstatSync(fd).isDirectory() && armed === 'after-ack' && renamed === file + '.commit') {
        armed = 'ack-retract'; throw Error('injected acknowledgement directory sync failure');
      }
      fs.fsyncSync(fd);
    } };
  return { api, arm(mode) { armed = mode; } };
}

test('owned enrollment, graceful close and reopen preserve pending and mined transitions', async t => {
  const file = fixture(t);
  await assert.rejects(ownLifecycleJournal(file), /missing/);
  const a = await ownLifecycleJournal(file, { initialize: true });
  a.journal.prepareTransition(id, intent);
  a.journal.archiveMined(id, digest, { transactionHash: other, blockHash: other, blockNumber: 30 });
  a.journal.prepareTransition(id, { digest: other, payload: '{"next":true}' });
  await a.close();
  const b = await ownLifecycleJournal(file); t.after(() => b.close());
  assert.equal(b.journal.read(id).pending.digest, other);
  assert.equal(b.journal.read(id).minedTransitions[0].digest, digest);
  assert.ok(b.verification().sha256);
  assert.throws(() => b.journal.prepareTransition(id, intent), /unresolved/);
  assert.equal(b.journal.read(id).pending.digest, other); // caller refusal is not owner loss
});

test('exact child death releases the flock and preserves its fence, crash count and pending intent', async t => {
  const file = fixture(t), seed = await ownLifecycleJournal(file, { initialize: true }); await seed.close();
  const c = fork(helper, ['hold', file], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], execArgv: [] });
  t.after(async () => { if (c.exitCode === null && c.signalCode === null) { const done = once(c, 'exit'); c.kill('SIGKILL'); await done; } });
  let timer;
  try { await Promise.race([once(c, 'message'), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('child readiness deadline')), 3000); })]); }
  finally { clearTimeout(timer); }
  await assert.rejects(ownLifecycleJournal(file), /in use/);
  const dead = once(c, 'exit'); c.kill('SIGKILL'); const [, signal] = await dead; assert.equal(signal, 'SIGKILL');
  const b = await ownLifecycleJournal(file); t.after(() => b.close());
  const row = b.journal.read(id);
  assert.equal(row.fenced, true); assert.equal(row.restart.failures, 1); assert.deepEqual(row.pending, intent);
  assert.throws(() => b.journal.prepareTransition(id, { digest: other, payload: '{}' }), /unresolved/);
});

for (const [fault, outcome, pending] of [['after-state', 'landed', intent], ['before-state', 'not-landed', null]]) {
  test(`${fault} is held on restart and explicit recovery classifies exact retained bytes as ${outcome}`, async t => {
    const file = fixture(t), f = faults(file);
    const a = await ownLifecycleJournal(file, { initialize: true, fsImpl: f.api });
    let withdrawn = 0; a.onRelease(() => { withdrawn++; });
    f.arm(fault); assert.throws(() => a.journal.prepareTransition(id, intent), /uncertain/);
    assert.equal(withdrawn, 1); await a.close();
    const evidence = fs.readFileSync(file + '.intent');
    const cold = child('open', file); assert.equal(cold.status, 73, cold.stderr); assert.match(cold.stderr, /uncertain/);
    const result = await recoverLifecycleJournal(file);
    assert.equal(result.outcome, outcome); assert.equal(result.servingAuthorized, false);
    assert.deepEqual(fs.readFileSync(file + '.intent'), evidence);
    const b = await ownLifecycleJournal(file); t.after(() => b.close());
    assert.deepEqual(b.journal.read(id).pending, pending);
  });
}

test('visible acknowledgement with failed sync and failed retraction is held in a new process', async t => {
  const file = fixture(t), f = faults(file);
  const a = await ownLifecycleJournal(file, { initialize: true, fsImpl: f.api });
  f.arm('after-ack'); assert.throws(() => a.journal.prepareTransition(id, intent), /retraction ALSO failed/); await a.close();
  assert.ok(fs.existsSync(file + '.commit'));
  const cold = child('open', file); assert.equal(cold.status, 73, cold.stderr); assert.match(cold.stderr, /final acknowledgement sync failed/);
  const result = await recoverLifecycleJournal(file); assert.equal(result.outcome, 'landed');
  const reopened = child('open', file); assert.equal(reopened.status, 0, reopened.stderr);
  assert.deepEqual(JSON.parse(reopened.stdout).pending, intent);
});

test('legacy import requires reviewed exact bytes and retains unresolved submissions', async t => {
  const file = fixture(t); openLifecycleJournal(file).prepareTransition(id, intent);
  const bytes = fs.readFileSync(file);
  await assert.rejects(ownLifecycleJournal(file), /legacy import/);
  await assert.rejects(ownLifecycleJournal(file, { importSha256: '0'.repeat(64) }), /hash mismatch/);
  assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(fs.existsSync(file + '.established'), false);
  const a = await ownLifecycleJournal(file, { importSha256: sha(bytes) });
  assert.deepEqual(fs.readFileSync(file), bytes); assert.deepEqual(a.journal.read(id).pending, intent); await a.close();
  await assert.rejects(ownLifecycleJournal(file, { importSha256: sha(bytes) }), /unestablished/);
});

test('missing established state cannot be recreated by enrollment or recovery', async t => {
  const file = fixture(t), a = await ownLifecycleJournal(file, { initialize: true });
  a.journal.prepareTransition(id, intent); await a.close(); fs.unlinkSync(file);
  await assert.rejects(ownLifecycleJournal(file, { initialize: true }), /missing/);
  await assert.rejects(recoverLifecycleJournal(file), /missing/);
  assert.equal(fs.existsSync(file), false);
});

test('unclassifiable state and missing intent refuse recovery without overwriting evidence', async t => {
  const file = fixture(t), f = faults(file), a = await ownLifecycleJournal(file, { initialize: true, fsImpl: f.api });
  f.arm('after-state'); assert.throws(() => a.journal.prepareTransition(id, intent)); await a.close();
  fs.appendFileSync(file, ' '); const bytes = fs.readFileSync(file);
  await assert.rejects(recoverLifecycleJournal(file), /neither/); assert.deepEqual(fs.readFileSync(file), bytes);
  fs.unlinkSync(file + '.intent');
  await assert.rejects(recoverLifecycleJournal(file), /intent record missing/); assert.deepEqual(fs.readFileSync(file), bytes);
});

test('same-size external rewrite closes the owner and triggers withdrawal', async t => {
  const file = fixture(t), a = await ownLifecycleJournal(file, { initialize: true });
  a.journal.observeAssignment(id, 1, 1); let withdrawn = 0; a.onRelease(() => { withdrawn++; });
  const stat = fs.statSync(file), bytes = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, bytes.replace('"generation":1', '"generation":2')); fs.utimesSync(file, stat.atime, stat.mtime);
  assert.throws(() => a.journal.read(id), /lost or changed/); assert.equal(withdrawn, 1);
  assert.throws(() => a.journal.read(id), /closed/); await a.close();
});

test('one reentrant close waits for serving withdrawal before releasing exclusion', async t => {
  const file = fixture(t), a = await ownLifecycleJournal(file, { initialize: true });
  let finish, reentrant; a.onRelease(() => { reentrant = a.close(); return new Promise(resolve => { finish = resolve; }); });
  const closing = a.close(); assert.equal(reentrant, closing); assert.equal(a.close(), closing);
  assert.throws(() => a.journal.read(id), /closed/); await assert.rejects(ownLifecycleJournal(file), /in use/);
  finish(); assert.equal((await closing).released, true);
  const b = await ownLifecycleJournal(file); await b.close();
});

for (const type of ['rejection', 'deadline']) {
  test(`withdrawal ${type} fences the owner and keeps its flock held`, async t => {
    const file = fixture(t), a = await ownLifecycleJournal(file, { initialize: true, withdrawDeadlineMs: 15 });
    a.onRelease(() => type === 'rejection' ? Promise.reject(Error('boundary still open')) : new Promise(() => {}));
    const result = await a.close(); assert.equal(result.released, false); assert.equal(result.fenced, true);
    await assert.rejects(ownLifecycleJournal(file), /in use/);
    assert.throws(() => a.journal.prepareTransition(id, intent), /closed/);
  });
}
