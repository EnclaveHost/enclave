// The finality adapter alone (pure): without minted evidence it stays 'unsafe' and names its gates; caller JSON with
// production labels is refused. Positive upgrades (safe / finalized) come only from the source-binding adapters and
// are exercised in test/source-binding.anvil.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFinality } from '../src/forced-inclusion.mjs';

const rc = { blockNumber: 100n, blockHash: '0x' + 'aa'.repeat(32) };
const outcome = { state: 'l2-included', level: 'unsafe', receipt: rc };
const L1 = '0x' + 'bb'.repeat(32);
test('no evidence: unsafe with explicit gates; labelled JSON (l1-execution-proof / base-derivation) is NOT evidence', () => {
  const none = classifyFinality({ outcome, depositL1BlockHash: L1 });
  assert.deepEqual([none.level, none.depositL1Final, none.gates.length], ['unsafe', false, 2]);
  const l1json = { kind: 'l1-receipt', verifiedBy: 'l1-execution-proof', trust: 'local-validated-pair', blockHash: L1, finalized: true };
  const l2json = { kind: 'l2-receipt', verifiedBy: 'base-derivation', trust: 'local-validated-pair', blockNumber: 100n, blockHash: rc.blockHash, safe: true, finalized: true };
  assert.throws(() => classifyFinality({ outcome, depositL1BlockHash: L1, l1Evidence: l1json }), (e) => e.code === 'l1-evidence-unverified');
  assert.throws(() => classifyFinality({ outcome, depositL1BlockHash: L1, l2Evidence: l2json }), (e) => e.code === 'l2-evidence-unverified');
  assert.throws(() => classifyFinality({ outcome: { ...outcome, state: 'pending' }, depositL1BlockHash: L1 }), (e) => e.code === 'no-included-outcome');
});
