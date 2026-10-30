// Root tests against unchanged r4. Scripted HTTP response loss, actual WebCrypto P256 signing.
// No RPC, real wallet, funds, network or production storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGasFundCall } from '../client-r1/funding-codec.mjs';
import { MemoryV2Store, newGasKey } from '../client-repair-r4/lib/v2-store.mjs';
import { confirmGasFund, relayClient } from '../client-repair-r4/lib/funding-client.mjs';
import { cfg, runtime, NOW, DEP, TX } from '../client-repair-r4/test/fixtures.mjs';

async function attempt(response) {
  const k = await newGasKey(crypto.subtle);
  const sid = TX('73');
  const deadline = NOW + 300n;
  const nonce = 1n << 64n;
  const intent = { payer: cfg.vault, deployment: DEP, expectedOwner: cfg.legacyVault,
    ethOut: 20_000_000_000_000n, maxUsdcIn6: 50_000n, fee: 500, deadline };
  const call = buildGasFundCall(cfg, { domainVersion: '2', now: NOW, sessionId: sid, nonce,
    action: 10, intent, fee: 50_000n, deadline });
  const record = { ...k, sid };
  const review = { call, deployment: DEP, totals: { maxUsdcIn6: 50_000n, fee6: 50_000n,
    totalMaximum6: 100_000n, balance6: 1_000_000n } };
  const store = new MemoryV2Store();
  let sends = 0;
  const relay = relayClient('https://fixture.invalid', async () => { sends++; return response; });
  await assert.rejects(confirmGasFund({ runtime, store, record, review, relay,
    rpc: async () => { throw Error('RPC must not be reached after response loss'); }, now: NOW }));
  assert.equal(sends, 1);
  return { entry: await store.getJournal(`gas-exec:${sid}:${nonce}`), call };
}

test('body loss after HTTP headers is UNKNOWN, never a proven refusal', async () => {
  const { entry } = await attempt({ status: 200, ok: true, text: async () => { throw new TypeError('terminated response body'); } });
  assert.equal(entry.status, 'unknown');
});

test('gateway 502 after dispatch is UNKNOWN, never proof that execute was not admitted', async () => {
  const { entry } = await attempt({ status: 502, ok: false, text: async () => 'Bad Gateway' });
  assert.equal(entry.status, 'unknown');
});

test('unknown execution retains exact call for independent settlement checks after reload', async () => {
  const { entry, call } = await attempt({ status: 200, ok: true, text: async () => { throw new TypeError('terminated response body'); } });
  assert.equal(entry.call?.args, call.args);
  assert.equal(entry.call?.digest, call.digest);
});
