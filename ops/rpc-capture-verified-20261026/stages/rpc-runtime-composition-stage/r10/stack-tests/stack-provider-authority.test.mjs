// COMPOSED STACK (r3): the wg-provider chain authority after the r3 hand union of attested-authority.mjs (lineage local
// verifier mode + route attested verifier / txBackend). Real module; the boundary is recorded: no request leaves the process.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { providerChainAuthority } from '../network/wg-provider/attested-authority.mjs';
const RPC = ['https://rpc-a.example/', 'https://rpc-b.example/'], V = 'http://127.0.0.1:28590/';
const fetched = [], realFetch = globalThis.fetch;
globalThis.fetch = async (...a) => { fetched.push(String(a[0])); throw new Error('stack test: no network'); };
after(() => { globalThis.fetch = realFetch; });
const noRead = { readFile: () => { throw new Error('a refused config must not read a replica config'); } };
test('quorum is unchanged: the RPC list, no verifier, no txBackend', () => {
  const a = providerChainAuthority({ rpc: RPC });
  assert.equal(a.mode, 'quorum'); assert.deepEqual(a.rpc, RPC); assert.deepEqual(a.leaseReaderOptions, {}); assert.equal(a.verifier, null); assert.equal(a.txBackend, null);
});
test('the lineage LOCAL verifier mode survives the composition (leases read through it)', () => {
  const a = providerChainAuthority({ rpc: RPC, chainAuthority: 'verifier', chainVerifier: V });
  assert.equal(a.mode, 'verifier'); assert.deepEqual(a.leaseReaderOptions, { authority: 'verifier', verifier: V }); assert.equal(a.txBackend, null);
  assert.match(a.describe, /local loopback verifier/);
});
test('the local-verifier provider mode never carries host services: the policy is never read through another authority (r10)', async () => {
  const { providerHostPolicyRuntime } = await import('../network/wg-provider/attested-authority.mjs');
  const { providerHostServices } = await import('../network/wg-provider/host-services-config.mjs');
  const lv = providerChainAuthority({ rpc: RPC, chainAuthority: 'verifier', chainVerifier: V });
  const hs = providerHostServices({ zone: 'app.enclave.host', platformHostPolicy: { book: '0x' + '11'.repeat(20), hostOwnership: '0x' + '22'.repeat(20), mirrors: ['https://mirror.example/policy'] } }, { roles: ['ingress'] });
  assert.throws(() => providerHostPolicyRuntime(hs, lv, { stateDir: '/nonexistent-never-written' }), /never mixed/);
  assert.equal(providerHostPolicyRuntime(null, lv, { stateDir: '/nonexistent-never-written' }), null);
  assert.deepEqual(fetched, [], 'no request left the process');
});
test('ONE explicit authority, no fallback, no mixed config: every refusal is explicit', () => {
  const t = (cfg, re) => assert.throws(() => providerChainAuthority(cfg, noRead), re);
  t({ rpc: RPC, chainVerifier: V }, /chainVerifier is set but chainAuthority is not verifier/);
  t({ rpc: RPC, chainAuthority: 'verifier' }, /needs chainVerifier/);
  t({ rpc: RPC, attestedVerifier: {} }, /attestedVerifier is set but chainAuthority is not "attested-verifier"/);
  t({ rpc: RPC, txBackend: { url: 'http://127.0.0.1:8545' } }, /txBackend is only used with chainAuthority "attested-verifier"/);
  t({ chainAuthority: 'attested-verifier', rpc: RPC, attestedVerifier: {} }, /rpc is not used with chainAuthority "attested-verifier"/);
  t({ chainAuthority: 'attested-verifier', chainVerifier: V, attestedVerifier: {} }, /chainVerifier is not used/);
  t({ chainAuthority: 'attested-verifier', pricePerGiB6: 1, attestedVerifier: {} }, /needs txBackend/);
  t({ chainAuthority: 'attested-verifier', txBackend: { url: 'http://127.0.0.1:8545' }, attestedVerifier: {} }, /txBackend is set but this provider is not paid/);
  t({ chainAuthority: 'attested-verifier' }, /attestedVerifier: .* is required/);
  t({ chainAuthority: 'public-fallback', rpc: RPC }, /chainAuthority must be quorum, verifier or attested-verifier/);
  t({ rpc: [RPC[0]] }, /two or more RPC endpoints required/);
  t({ chainAuthority: 'attested-verifier', rpc: RPC, chainVerifier: V, attestedVerifier: {} }, /rpc is not used/);
  assert.deepEqual(fetched, [], 'no request left the process');
});
