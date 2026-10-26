import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keccak256, toBytes } from 'viem';
import { openLifecycleJournal } from '../network/deployment-lifecycle-journal.mjs';
import { DeploymentLifecycleRunner } from '../network/deployment-lifecycle-runner.mjs';
const id = keccak256(toBytes('driver deployment'));
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-runner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = { now: 100000, calls: [], ready: true, ended: false, stagedReady: true, stagedEnded: false, confirmStop: true,
    snapshot: { schema: 2, id, verified: true, authorityTier: 'safe', blockAt: 100000, enabled: true, admitted: true, funded: true,
      thisHost: 'host', assignment: { state: 'running', host: 'host', generation: 2, revision: 1, startAfter: 0, crashHeld: false } } };
  const journal = openLifecycleJournal(path.join(dir, 'journal.json'));
  const chain = {
    read: async () => f.snapshot,
    prepare: async (_id, s, target) => { f.calls.push(`prepare:${target}`);
      const payload = JSON.stringify({ generation: s.assignment.generation, target });
      return { payload, digest: keccak256(toBytes(payload)) }; },
    submit: async () => { f.calls.push('submit'); if (f.uncertain) throw Error('response lost'); },
    resolve: async (_id, pending) => ({ verified: true, digest: pending.digest, outcome: f.confirmed ? 'confirmed' : 'unknown' }),
  };
  const runtime = {
    fence: async () => f.calls.push('fence'), stop: async () => { f.calls.push('stop'); return f.confirmStop; },
    health: async () => ({ ready: f.ready, ended: f.ended, instance: 'instance-1' }),
    serve: async () => f.calls.push('serve'),
    ensureStaged: async () => { f.calls.push('stage'); return { ready: f.stagedReady, ended: f.stagedEnded, instance: 'staged-1' }; },
  };
  f.runner = new DeploymentLifecycleRunner({ chain, runtime, journal, now: () => f.now, random: () => 0 });
  f.journal = journal; return f;
}
test('healthy self-hosting produces no recurring state transaction', async t => {
  const f = fixture(t);
  for (let i = 0; i < 100; ++i) { f.now += 10000; f.snapshot.blockAt = f.now;
    assert.equal((await f.runner.reconcile(id)).status, 'running'); }
  assert.equal(f.calls.filter(x => x.startsWith('prepare') || x === 'submit').length, 0);
});
test('a crash records queued once and an ambiguous submission never resubmits another intent', async t => {
  const f = fixture(t); f.ready = false; f.ended = true; f.uncertain = true;
  assert.equal((await f.runner.reconcile(id)).status, 'pending');
  assert.equal((await f.runner.reconcile(id)).status, 'pending');
  assert.equal(f.calls.filter(x => x === 'prepare:queued').length, 1);
  assert.equal(f.calls.filter(x => x === 'submit').length, 1);
  assert.equal(f.journal.read(id).restart.failures, 1);
});
test('readiness failure, stale authority and unconfirmed retirement never start a replacement', async t => {
  const f = fixture(t); f.ready = false;
  assert.equal((await f.runner.reconcile(id)).status, 'held');
  f.ended = true; f.confirmStop = false;
  assert.equal((await f.runner.reconcile(id)).status, 'held');
  f.snapshot.blockAt = 0;
  assert.equal((await f.runner.reconcile(id)).status, 'held');
  assert.equal(f.calls.includes('stage'), false); assert.equal(f.calls.includes('submit'), false);
});
test('queued startup failures back off without writing queued again', async t => {
  const f = fixture(t); f.snapshot.assignment.state = 'queued'; f.stagedReady = false; f.stagedEnded = true;
  assert.equal((await f.runner.reconcile(id)).status, 'queued');
  assert.equal((await f.runner.reconcile(id)).status, 'queued');
  assert.equal(f.calls.filter(x => x === 'stage').length, 1);
  assert.equal(f.calls.includes('submit'), false);
});
test('running is submitted only after readiness and is not served until confirmed', async t => {
  const f = fixture(t); f.snapshot.assignment.state = 'queued';
  assert.equal((await f.runner.reconcile(id)).status, 'pending');
  assert.equal(f.calls.includes('prepare:running'), true); assert.equal(f.calls.includes('serve'), false);
});
test('reserve exhaustion fences before a single stopped transition', async t => {
  const f = fixture(t); f.snapshot.funded = false;
  assert.equal((await f.runner.reconcile(id)).status, 'pending');
  assert.deepEqual(f.calls, ['fence', 'stop', 'prepare:stopped', 'submit']);
});
test('host-specific rejection queues its own running assignment but never disables it globally', async t => {
  const f = fixture(t); f.snapshot.admitted = false;
  assert.equal((await f.runner.reconcile(id)).status, 'pending');
  assert.deepEqual(f.calls, ['fence', 'stop', 'prepare:queued', 'submit']);
});
test('a host cannot stop a running assignment belonging to another host', async t => {
  const f = fixture(t); f.snapshot.assignment.host = 'other'; f.snapshot.funded = false;
  assert.equal((await f.runner.reconcile(id)).status, 'elsewhere');
  assert.deepEqual(f.calls, ['fence', 'stop']);
});
test('a queued deployment remains available for other eligible hosts', async t => {
  const f = fixture(t); f.snapshot.assignment.state = 'queued'; f.snapshot.admitted = false;
  assert.equal((await f.runner.reconcile(id)).status, 'queued');
  assert.deepEqual(f.calls, ['fence', 'stop']);
});
test('a fresh proof of an older assignment cannot roll back the durable generation floor', async t => {
  const f = fixture(t);
  assert.equal((await f.runner.reconcile(id)).status, 'running');
  f.calls.length = 0; f.snapshot.assignment.generation = 1;
  assert.equal((await f.runner.reconcile(id)).status, 'held');
  assert.deepEqual(f.calls, ['fence']);
  assert.equal(f.journal.read(id).generation, 2);
});
