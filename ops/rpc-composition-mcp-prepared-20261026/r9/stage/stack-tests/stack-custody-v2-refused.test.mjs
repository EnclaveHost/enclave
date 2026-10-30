// COMPOSED STACK (r3): v2 custody stays REFUSED with the local verifier (custody/v2/quorum.mjs), alone or mixed, with the REAL
// verifier client of network/chain-authority.mjs, and the refusal makes no request (recorded boundary).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { base } from 'viem/chains';
import { createChainAuthority } from '../network/chain-authority.mjs';
import { createQuorumReader } from '../custody/v2/quorum.mjs';
import { recorder } from './helpers-recorder.mjs';
const V = await recorder('verifier'); after(() => V.close());
test('v2 quorum reader refuses the verifier client alone and mixed, before any request', () => {
  const auth = createChainAuthority({ verifier: V.url, chain: base });
  const other = { getBlockNumber: async () => 1n, getBlock: async () => ({}) };
  for (const clients of [[auth.client], [other, auth.client]])
    assert.throws(() => createQuorumReader({ clients, minAgree: 1 }), (e) => e.code === 'chain_verifier_unsupported' && /requireCanonical/.test(e.message));
  assert.equal(V.calls.length, 0);
});
