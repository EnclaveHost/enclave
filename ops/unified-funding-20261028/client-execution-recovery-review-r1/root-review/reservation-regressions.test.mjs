// Independent root checks. Real P-256 signing; scripted relay, no network or funds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmGasFund, executionBlockers } from '../lib/gas-execution.mjs';
import { relayClient } from '../../client-repair-r4/lib/funding-client.mjs';
import { setup, reviewFor, runtime, NOW, RELAY_BASE, relayFor, countingSubtle } from '../test/exec-fixtures.mjs';

test('an existing reservation for different terms remains unresolved after intent_conflict', async () => {
  const x = await setup();
  let posts = 0;
  const relay = relayClient(RELAY_BASE, async () => {
    posts++;
    return { status: 409, ok: false, text: async () => JSON.stringify({
      code: 'intent_conflict',
      error: 'this nonce already belongs to different signed terms; reconcile it before submitting another intent',
    }) };
  });
  await assert.rejects(confirmGasFund({ runtime, store: x.store, record: x.record,
    review: reviewFor(x.record), relay, relayBase: RELAY_BASE, rpc: x.W.rpc, now: NOW }));
  const entries = await x.store.listJournal();
  assert.equal(posts, 1);
  assert.equal(entries[0].status, 'unknown');
  assert.equal(executionBlockers(entries, x.record).length, 1);
});

test('the store already rejects a duplicate local id for the same key; the original hold remains', async () => {
  const x = await setup();
  const r = relayFor(x.W, { mode: 'unreachable' });
  const subtle = countingSubtle();
  const args = { runtime, store: x.store, relay: r.relay, relayBase: RELAY_BASE, rpc: x.W.rpc, now: NOW, subtle };
  await assert.rejects(confirmGasFund({ ...args, record: x.record, review: reviewFor(x.record) }));
  const duplicate = { ...x.record, id: `${x.record.id}-imported-copy` };
  await assert.rejects(x.store.saveKey(duplicate), e => e.code === 'record_id');
  assert.equal(executionBlockers(await x.store.listJournal(), x.record).length, 1);
  assert.deepEqual([r.posts, subtle.n], [1, 1], 'no extra dispatch or signature');
});
