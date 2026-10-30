// COMPOSED STACK (r3): the local chain authority (network/chain-authority.mjs) with RECORDED boundaries: a loopback verifier
// recorder and a "public RPC" recorder named in every legacy RPC env. Proves: unsafe tier only (safe/finalized refused before any
// request), explicit selection only, a failing verifier never falls back to a public RPC, unknown methods refused locally.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { base } from 'viem/chains';
import { chainAuthorityFromEnv, createChainAuthority, isVerifierClient } from '../network/chain-authority.mjs';
import { recorder, msgOf } from './helpers-recorder.mjs';
const V = await recorder('verifier'), P = await recorder('public-rpc');
after(async () => { await V.close(); await P.close(); });
for (const k of ['BASE_RPC', 'BASE_RPCS', 'RPC_FALLBACKS']) process.env[k] = P.url;
test('selection is explicit: a verifier URL without the selection, an unknown authority, a selection without URL all refuse', () => {
  assert.equal(chainAuthorityFromEnv({}), null);
  assert.throws(() => chainAuthorityFromEnv({ ENCLAVE_CHAIN_VERIFIER: V.url }, { chain: base }), /is not verifier/);
  assert.throws(() => chainAuthorityFromEnv({ ENCLAVE_CHAIN_AUTHORITY: 'public' }, { chain: base }), /must be quorum or verifier/);
  assert.throws(() => chainAuthorityFromEnv({ ENCLAVE_CHAIN_AUTHORITY: 'verifier' }, { chain: base }), /needs ENCLAVE_CHAIN_VERIFIER/);
  assert.throws(() => createChainAuthority({ verifier: 'https://verifier.example/', chain: base }));   // loopback only
});
test('unsafe tier only; a failing verifier is a refusal, never a public-RPC fallback; unknown methods refused locally', async () => {
  const auth = chainAuthorityFromEnv({ ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: V.url }, { chain: base });
  assert.equal(auth.mode, 'verifier'); assert.ok(isVerifierClient(auth.client));
  const d = auth.describe(); assert.equal(d.tier, 'unsafe'); assert.equal(d.finality, 'none');
  for (const tag of ['safe', 'finalized'])
    await assert.rejects(auth.client.request({ method: 'eth_getBlockByNumber', params: [tag, false] }), (e) => /no safe or finalized tier/.test(msgOf(e)));
  assert.equal(V.calls.length, 0, 'safe/finalized refused before any request');
  await assert.rejects(auth.client.request({ method: 'debug_traceTransaction', params: ['0x' + '00'.repeat(32)] }), (e) => /not a proof-backed or own-backend method/.test(msgOf(e)));
  assert.equal(V.calls.length, 0, 'an unknown method is refused locally');
  await assert.rejects(auth.client.request({ method: 'eth_getBlockByNumber', params: ['latest', false] }));
  assert.ok(V.calls.length >= 1, 'the head read went to the verifier');
  assert.ok(V.calls.every((c) => c.method === 'POST'));
  assert.deepEqual(P.calls, [], 'NO request reached the public RPC named in BASE_RPC/BASE_RPCS/RPC_FALLBACKS');
});
