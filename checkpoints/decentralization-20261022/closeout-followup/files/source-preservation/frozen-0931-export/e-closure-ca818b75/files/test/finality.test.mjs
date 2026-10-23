// The finality adapter alone (pure): upgrades only on named-verifier evidence about the RIGHT blocks; fails closed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFinality } from '../src/forced-inclusion.mjs';

const rc = { blockNumber: 100n, blockHash: '0x' + 'aa'.repeat(32) };
const outcome = { state: 'l2-included', level: 'unsafe', receipt: rc };
const L1 = '0x' + 'bb'.repeat(32);
test('no evidence: unsafe with explicit gates; evidence only from named verifiers, for the right blocks, never from the submitter', () => {
  const none = classifyFinality({ outcome, depositL1BlockHash: L1 });
  assert.deepEqual([none.level, none.depositL1Final, none.gates.length], ['unsafe', false, 2]);
  const l1ok = { verifiedBy: 'l1-execution-proof', blockHash: L1, finalized: true, source: 'reth-local' };
  const l2safe = { verifiedBy: 'base-derivation', blockNumber: 100n, blockHash: rc.blockHash, safe: true, finalized: false, source: 'holder' };
  assert.equal(classifyFinality({ outcome, depositL1BlockHash: L1, l1Evidence: l1ok, l2Evidence: l2safe }).level, 'safe');
  assert.equal(classifyFinality({ outcome, depositL1BlockHash: L1, l1Evidence: l1ok, l2Evidence: { ...l2safe, finalized: true } }).level, 'finalized');
  assert.equal(classifyFinality({ outcome, depositL1BlockHash: L1, l1Evidence: { ...l1ok, finalized: false }, l2Evidence: { ...l2safe, finalized: true } }).level, 'safe', 'no finalized L2 without a finalized L1 deposit block');
  assert.throws(() => classifyFinality({ outcome, depositL1BlockHash: L1, l1Evidence: { ...l1ok, verifiedBy: 'rpc' } }), (e) => e.code === 'l1-evidence-unverified');
  assert.throws(() => classifyFinality({ outcome, depositL1BlockHash: L1, l1Evidence: { ...l1ok, verifiedBy: 'test-anvil-l1' } }), (e) => e.code === 'l1-evidence-unverified');
  assert.throws(() => classifyFinality({ outcome, depositL1BlockHash: L1, l1Evidence: { ...l1ok, blockHash: rc.blockHash } }), (e) => e.code === 'l1-evidence-mismatch');
  assert.throws(() => classifyFinality({ outcome, depositL1BlockHash: L1, l2Evidence: { ...l2safe, verifiedBy: 'sequencer' } }), (e) => e.code === 'l2-evidence-unverified');
  assert.throws(() => classifyFinality({ outcome, depositL1BlockHash: L1, l2Evidence: { ...l2safe, blockHash: '0x' + 'cc'.repeat(32) } }), (e) => e.code === 'l2-evidence-mismatch');
  assert.throws(() => classifyFinality({ outcome, depositL1BlockHash: L1, l2Evidence: { ...l2safe, source: 'https://seq' }, submittedVia: 'https://seq' }), (e) => e.code === 'evidence-not-independent');
  assert.throws(() => classifyFinality({ outcome: { ...outcome, state: 'pending' }, depositL1BlockHash: L1 }), (e) => e.code === 'no-included-outcome');
});
