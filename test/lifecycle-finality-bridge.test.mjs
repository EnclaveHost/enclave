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

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function entered(check) {
  const end = Date.now() + 2000;
  while (!check() && Date.now() < end) await new Promise(r => setTimeout(r, 1));
  assert.ok(check(), 'fixture callback entered');
}
test('a timed-out callback retains the one-operation slot until its actual completion', async () => {
  const f = fixture(), raw = deferred(); let calls = 0;
  const snapshot = f.create({ deadlineMs: 20, readAnchor: () => ++calls === 1 ? raw.promise : Promise.resolve(f.anchor) });
  try {
    await assert.rejects(snapshot(() => true), /deadline/);
    await assert.rejects(snapshot(() => true), /busy/);
    assert.equal(calls, 1); assert.equal(f.saved, undefined);
    raw.resolve(f.anchor);
    await new Promise(r => setImmediate(r));
    assert.equal((await snapshot(() => 'fresh operation')).value, 'fresh operation');
    assert.equal(calls, 2);
  } finally { raw.resolve(f.anchor); await snapshot.close(); }
});
test('close revokes retained clients but waits for a cancellation-ignoring callback', async () => {
  const f = fixture(), raw = deferred(), snapshot = f.create(); let client, waiting = false, drained = false;
  const operation = snapshot(async c => { client = c; waiting = true; await raw.promise; return true; });
  const rejected = assert.rejects(operation, /closed/);
  try {
    await entered(() => waiting);
    const closing = snapshot.close(); assert.equal(snapshot.close(), closing);
    closing.then(() => { drained = true; });
    await rejected;
    assert.equal(drained, false); assert.equal(f.saved, undefined);
    await assert.rejects(client.getBalance({ address: '0x0000000000000000000000000000000000000001' }), /closed/);
    await assert.rejects(snapshot(() => true), /closed/);
    raw.resolve(); await closing;
    assert.equal(drained, true); assert.equal(f.saved, undefined);
  } finally { raw.resolve(); await snapshot.close(); await rejected; }
});
test('a journal owner retains its kernel lock through the bridge raw callback drain', async t => {
  const { ownLifecycleJournal } = await import('../network/deployment-journal-owner.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-finality-')), file = path.join(dir, 'journal.json');
  const owner = await ownLifecycleJournal(file, { initialize: true }), f = fixture(), raw = deferred();
  const snapshot = f.create({ journal: owner.journal }); let waiting = false;
  owner.onRelease(() => snapshot.close());
  t.after(async () => { raw.resolve(); await owner.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const operation = snapshot(async () => { waiting = true; await raw.promise; return true; });
  const rejected = assert.rejects(operation, /closed/);
  await entered(() => waiting);
  const closing = owner.close();
  await rejected;
  assert.throws(() => owner.journal.readAnchor(8453), /closed/);
  await assert.rejects(ownLifecycleJournal(file), /in use/);
  raw.resolve(); assert.equal((await closing).released, true);
  const next = await ownLifecycleJournal(file);
  try { assert.equal(next.journal.readAnchor(8453), null); }
  finally { await next.close(); }
});
