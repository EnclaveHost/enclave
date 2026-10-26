import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keccak256, toBytes } from 'viem';
import { openLifecycleJournal } from '../network/deployment-lifecycle-journal.mjs';
const id = keccak256(toBytes('journal deployment')), digest = keccak256(toBytes('permit'));
const setup = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-journal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return path.join(dir, 'state.json'); };
test('a witness fence and crash budget survive process restart and same-generation policy edits', t => {
  const file = setup(t); let j = openLifecycleJournal(file);
  j.observeAssignment(id, 3, 1); j.permit(id, { generation: 3, revision: 1, sequence: 1, digest });
  j.fence(id, 3); j.failure(id, { identity: 'dead', now: 1000, random: () => 0 });
  j = openLifecycleJournal(file); assert.equal(j.decision(id, 1001).start, false);
  j.observeAssignment(id, 3, 2);
  assert.throws(() => j.permit(id, { generation: 3, revision: 2, sequence: 2, digest }), /fenced/);
  assert.throws(() => j.observeAssignment(id, 2, 1), /rollback/);
  j.observeAssignment(id, 4, 2);
  j.permit(id, { generation: 4, revision: 2, sequence: 1, digest });
  assert.equal(j.read(id).restart.failures, 1);
});
test('ambiguous transaction submission holds exact intent through restart', t => {
  const file = setup(t); let j = openLifecycleJournal(file);
  j.prepareTransition(id, { digest, payload: '{"generation":2}' });
  j = openLifecycleJournal(file);
  assert.throws(() => j.prepareTransition(id, { digest: keccak256(toBytes('other')), payload: '{}' }), /unresolved/);
  assert.throws(() => j.settleTransition(id, keccak256(toBytes('other'))), /wrong/);
  j.settleTransition(id, digest); assert.equal(openLifecycleJournal(file).read(id).pending, null);
});
test('corrupt journal is held without overwriting, and a failed durable write never grants permission', t => {
  const file = setup(t); fs.writeFileSync(file, 'corrupt');
  let j = openLifecycleJournal(file); assert.throws(() => j.observeAssignment(id, 1, 1), /unreadable/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'corrupt');
  fs.unlinkSync(file);
  const broken = { ...fs, fsyncSync() { throw Error('disk flush failed'); } };
  j = openLifecycleJournal(file, { fsImpl: broken });
  assert.throws(() => j.observeAssignment(id, 1, 1), /disk flush/);
  assert.throws(() => j.read(id), /write failed/);
  assert.equal(fs.existsSync(file), false);
});
test('operationally mined intents remain durable until their exact finalized receipts settle', t => {
  const file = setup(t); let j = openLifecycleJournal(file);
  j.prepareTransition(id, { digest, payload: '{"generation":2}' });
  j.archiveMined(id, digest, { transactionHash: keccak256(toBytes('tx')), blockHash: keccak256(toBytes('block')), blockNumber: 30 });
  j = openLifecycleJournal(file);
  assert.equal(j.read(id).pending, null); assert.equal(j.read(id).minedTransitions[0].digest, digest);
  j.prepareTransition(id, { digest: keccak256(toBytes('next')), payload: '{"generation":3}' });
  assert.throws(() => j.settleMined(id, keccak256(toBytes('wrong'))), /unknown/);
  j.settleMined(id, digest); assert.equal(j.read(id).minedTransitions.length, 0);
});
test('same-generation host bindings and successor votes cannot conflict through restart', t => {
  const file = setup(t); let j = openLifecycleJournal(file);
  j.observeAssignment(id, 2, 1, digest);
  j.voteSuccessor(id, { generation: 3, previous: digest, digest, payload: '{}' });
  j = openLifecycleJournal(file);
  assert.throws(() => j.observeAssignment(id, 2, 1, keccak256(toBytes('other host'))), /conflicting/);
  assert.throws(() => j.voteSuccessor(id, { generation: 3, previous: digest, digest: keccak256(toBytes('other successor')), payload: '{}' }), /conflicting/);
});
