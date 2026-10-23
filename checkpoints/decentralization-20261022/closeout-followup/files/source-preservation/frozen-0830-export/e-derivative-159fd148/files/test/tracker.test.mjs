// The duplicate-execution guard alone (pure): commitments, L1 nonce discipline, evidence-gated resolution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ForcedInclusionTracker } from '../src/forced-inclusion.mjs';

const head = (timestamp) => ({ number: 10, hash: '0x' + 'aa'.repeat(32), timestamp, verifiedBy: 'signed-head' });
test('one open commitment per key; replays are not new sends; L1 resends keep the nonce; only verified evidence frees a slot', () => {
  const t = new ForcedInclusionTracker();
  const k = 'lease:8453:op:id';
  assert.equal(t.admit(k, '0x01', { nonce: '3', deadline: '1000' }).replay, false);
  assert.equal(t.admit(k, '0x01', {}).replay, true);
  assert.throws(() => t.admit(k, '0x02', {}), (e) => e.code === 'ambiguous-duplicate');
  t.checkL1Send(k, 7);
  t.checkL1Send(k, 7);                                                   // re-broadcast / fee bump: same nonce
  assert.throws(() => t.checkL1Send(k, 8), (e) => e.code === 'l1-nonce-change');
  assert.throws(() => t.resolveFailedL1(k, { status: 'reverted', nonce: 7, blockHash: '0xb' }, { verifiedBy: 'rpc', headerHash: '0xb' }), (e) => e.code === 'l1-receipt-unverified');
  assert.throws(() => t.resolveFailedL1(k, { status: 'success', nonce: 7, blockHash: '0xb' }, { verifiedBy: 'l1-light-client', headerHash: '0xb' }), (e) => e.code === 'not-failed');
  assert.throws(() => t.resolveFailedL1(k, { status: 'reverted', nonce: 6, blockHash: '0xb' }, { verifiedBy: 'l1-light-client', headerHash: '0xb' }), (e) => e.code === 'l1-receipt-mismatch');
  t.resolveFailedL1(k, { status: 'reverted', nonce: 7, blockHash: '0xb', transactionHash: '0xc' }, { verifiedBy: 'l1-light-client', headerHash: '0xb' });
  assert.equal(t.get(k).state, 'dead');
  assert.equal(t.admit(k, '0x02', {}).replay, false, 'a new commitment once the old one is provably dead');
  // expiry: verified head past the deadline, nonce untouched
  const k2 = 'lease:8453:op:id2';
  t.admit(k2, '0x05', { nonce: '4', deadline: '1000' });
  assert.throws(() => t.resolveExpiredLease(k2, { head: head(1000), executorNonce: 4n }), (e) => e.code === 'not-expired');
  assert.throws(() => t.resolveExpiredLease(k2, { head: { ...head(2000), verifiedBy: 'rpc' }, executorNonce: 4n }), (e) => e.code === 'unverified-head');
  assert.throws(() => t.resolveExpiredLease(k2, { head: head(2000), executorNonce: 5n }), (e) => e.code === 'nonce-consumed');
  t.resolveExpiredLease(k2, { head: head(2000), executorNonce: 4n });
  assert.throws(() => t.mark(k2, 'l1-sent', {}), (e) => e.code === 'state-regression');
  // durable: round-trips through JSON
  const back = new ForcedInclusionTracker(JSON.parse(JSON.stringify(t)));
  assert.equal(back.get(k2).state, 'dead');
});
