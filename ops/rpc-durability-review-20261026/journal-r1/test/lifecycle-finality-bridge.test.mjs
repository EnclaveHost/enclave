import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keccak256, toBytes } from 'viem';
import { createLifecycleFinalitySnapshot } from '../network/lifecycle-finality-bridge.mjs';
import { openLifecycleJournal } from '../network/deployment-lifecycle-journal.mjs';
const hash = x => keccak256(toBytes(x));
function fixture() {
  const f = { calls: [], now: 2000000,
    anchor: { tier: 'l1-finalized-derived', base: { number: 100, hash: hash('base'), stateRoot: hash('state'), outputRoot: hash('output'), timestamp: 1000 },
      l1: { number: 30, hash: hash('l1'), timestamp: 1100 } } };
  f.verifier = { request: async (method, params) => {
    f.calls.push({ method, params });
    if (method === 'eth_chainId') return '0x2105';
    if (method === 'eth_getBlockByNumber') return { number: '0x64', hash: f.wrongHash || f.anchor.base.hash,
      stateRoot: f.wrongRoot || f.anchor.base.stateRoot, timestamp: '0x3e8' };
    if (method === 'eth_getBalance') return '0x123';
    throw Error('unconfigured fixture method');
  } };
  const journal = { readAnchor: () => f.saved || null, acceptAnchor: (_chain, anchor) => { f.saved = structuredClone(anchor); } };
  f.create = extras => createLifecycleFinalitySnapshot({ readAnchor: async () => f.anchor, verifier: f.verifier,
    maxAnchorAgeSec: 1800, now: () => f.now, journal, ...extras });
  return f;
}
test('bridge pins every state read to the independently authenticated derived hash and closes retained clients', async () => {
  const f = fixture(); let saved;
  const result = await f.create()(async client => { saved = client; return client.getBalance({ address: '0x0000000000000000000000000000000000000001' }); });
  assert.equal(result.value, 291n); assert.equal(result.evidence.tier, 'l1-finalized-derived');
  assert.deepEqual(f.calls.find(x => x.method === 'eth_getBalance').params[1], { blockHash: f.anchor.base.hash });
  await assert.rejects(saved.getBalance({ address: '0x0000000000000000000000000000000000000001' }), /closed/);
});
test('ASR labels, mismatched local roots, and genuinely old anchors cannot be relabeled as current', async () => {
  const f = fixture(); f.anchor.tier = 'asr-finalized';
  await assert.rejects(f.create()(() => true), /ASR/); assert.equal(f.calls.length, 0);
  f.anchor.tier = 'l1-finalized-derived'; f.wrongRoot = hash('wrong root');
  await assert.rejects(f.create()(() => true), /does not match/);
  delete f.wrongRoot; f.now = 4000000;
  await assert.rejects(f.create()(() => true), /age bound/);
  assert.throws(() => createLifecycleFinalitySnapshot({ verifier: f.verifier }), /reader is required/);
});
test('failed durable anchoring or a hung derivation callback refuses without granting a snapshot', async () => {
  const f = fixture();
  await assert.rejects(f.create({ journal: { readAnchor: () => null, acceptAnchor: () => { throw Error('disk full'); } } })(() => true), /disk full/);
  await assert.rejects(f.create({ readAnchor: () => new Promise(() => {}), deadlineMs: 20 })(() => true), /deadline/);
});
test('a restarted bridge rejects a prior derived anchor using the durable journal floor', async t => {
  const f = fixture(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-anchor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'journal.json');
  await f.create({ journal: openLifecycleJournal(file) })(() => true);
  const restarted = f.create({ journal: openLifecycleJournal(file) });
  f.anchor.base.number--;
  await assert.rejects(restarted(() => true), /rollback/);
  f.anchor.base.number++; f.anchor.l1.hash = hash('contradictory finalized L1');
  await assert.rejects(restarted(() => true), /rollback/);
  assert.equal(openLifecycleJournal(file).readAnchor(8453).base.number, 100);
});
test('replication delay cannot publish a snapshot that aged past its original bound', async t => {
  const f = fixture(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-commit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'journal.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, deployments: [], authorityAnchors: {} }));
  let committed = false;
  const journal = openLifecycleJournal(file, { requireCommit: true, commit: async ({ bytes, sha256 }) => {
    assert.deepEqual(bytes, fs.readFileSync(file)); assert.equal(sha256.length, 64);
    committed = true; f.now = 4000000; return true;
  } });
  await assert.rejects(f.create({ journal })(() => 'must not publish'), /age bound/);
  assert.equal(committed, true); // durable progress is not a freshness grant
  assert.equal(journal.readAnchor(8453).base.number, 100);
});
test('snapshot deadline aborts durable commit; late ACK cannot release a value', async t => {
  const f = fixture(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-abort-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'journal.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, deployments: [], authorityAnchors: {} }));
  let ack, signal, published = false;
  const journal = openLifecycleJournal(file, { requireCommit: true, commit: q => {
    signal = q.signal; return new Promise(resolve => { ack = resolve; });
  } });
  const pending = f.create({ journal, deadlineMs: 50 })(() => 'secret').then(v => { published = true; return v; });
  await assert.rejects(pending, /deadline/);
  assert.equal(signal.aborted, true); ack(true); await new Promise(resolve => setImmediate(resolve));
  assert.equal(published, false); assert.throws(() => journal.readAnchor(8453), /failed/);
});
