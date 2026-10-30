// Root's three regressions (../root-regression.test.mjs, preserved UNCHANGED and still expected to FAIL against r4),
// ported to the successor lib. UNREVIEWED, NOT RUN. The three assertions are identical. Differences, all required by
// the successor's binding rules and listed here so they can be reviewed:
//   1. confirmGasFund comes from ../lib/gas-execution.mjs (relayClient is still r4's, unchanged);
//   2. the record is a COMPLETE stored gas record (newGasRecord: owner, vault, chain, relay, factory, implementation;
//      status "open") instead of { ...key, sid }: the successor refuses to sign for a record it cannot bind;
//   3. relayBase = the record's relay (https://fixture.invalid, the same base root used);
//   4. the RPC answers ONLY the pre-send anchor read (eth_getBlockByNumber "latest") and throws, exactly like root's
//      stub, for any call once the relay has been reached ("RPC must not be reached after response loss").
// Actual WebCrypto P-256 signing and scripted HTTP response loss, as in root's file. No network, wallet or funds.
// execute-expiry-recovery-r1: ported VERBATIM; only the import specifiers changed (candidate = ../sdk/funding/*, core =
// canonical source/sdk/funding/*; cfg/runtime from ./exec-fixtures.mjs, built with the canonical codec).
import test from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../../../source/node_modules/viem/_esm/index.js';
import { buildGasFundCall } from '../../../source/sdk/funding/funding-codec.mjs';
import { MemoryV2Store, newGasKey, newGasRecord } from '../../../source/sdk/funding/v2-store.mjs';
import { relayClient } from '../../../source/sdk/funding/funding-client.mjs';
import { confirmGasFund } from '../sdk/funding/gas-execution.mjs';
import { cfg, runtime, NOW, DEP, TX, FACTORY, IMPL } from './exec-fixtures.mjs';

async function attempt(response) {
  const k = await newGasKey(crypto.subtle);
  const sid = TX('73');
  const deadline = NOW + 300n;
  const nonce = 1n << 64n;
  const intent = { payer: cfg.vault, deployment: DEP, expectedOwner: cfg.legacyVault,
    ethOut: 20_000_000_000_000n, maxUsdcIn6: 50_000n, fee: 500, deadline };
  const call = buildGasFundCall(cfg, { domainVersion: '2', now: NOW, sessionId: sid, nonce,
    action: 10, intent, fee: 50_000n, deadline });
  const record = Object.assign(newGasRecord({ key: k, chainId: 8453, relay: 'https://fixture.invalid', owner: cfg.owner,
    vault: cfg.vault, factory: FACTORY, implementation: IMPL, label: 'root regression', now: Number(NOW) }), { sid, status: 'open' });
  const review = { call, deployment: DEP, totals: { maxUsdcIn6: 50_000n, fee6: 50_000n,
    totalMaximum6: 100_000n, balance6: 1_000_000n } };
  const store = new MemoryV2Store();
  let sends = 0;
  const relay = relayClient('https://fixture.invalid', async () => { sends++; return response; });
  const rpc = async (method, params) => {
    if (sends > 0) throw Error('RPC must not be reached after response loss');
    if (method === 'eth_getBlockByNumber' && params[0] === 'latest') {
      return { number: '0x64', hash: `0x${'5c'.repeat(32)}`, timestamp: toHex(NOW) };
    }
    throw Error(`only the pre-send anchor read is answered (${method})`);
  };
  await assert.rejects(confirmGasFund({ runtime, store, record, review, relay, relayBase: 'https://fixture.invalid',
    rpc, now: NOW }));
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
