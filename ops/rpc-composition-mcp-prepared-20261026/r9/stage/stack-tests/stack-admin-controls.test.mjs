// COMPOSED STACK (r3): the measured control guest's config after the r2/r3 resolution of measured-control.mjs: the verifier-only
// guest (chainVerifier expose "attested") refuses every serving/admin member; a normal control guest keeps the admin members
// (platformPolicyCarriers) with their refusals. Real module (metal/guest/measured-control.mjs), no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalDirectConfig, CONFIG_FORMAT, checkPolicyCarriers } from '../metal/guest/measured-control.mjs';
const a = (n) => '0x' + n.toString(16).padStart(40, '0');
const RAW = () => ({ format: CONFIG_FORMAT, chainId: 8453,
  contracts: { registry: a(0x11), deployments: a(0x12), appCatalog: a(0x13), proofOfTime: a(0x14), enclavePay: a(0), verificationFees: a(0), sessionVaultFactory: a(0), secretVaultV2: a(0) },
  profileDigest: null, rpcs: ['https://rpc-a.example/v1', 'https://rpc-b.example'], quorum: 2, releaseId: 'ab'.repeat(32),
  replicas: { gateways: ['http://192.0.2.10:8189', 'https://replica.example'], storagePlan: null },
  identity: { publicUrl: 'https://verifier.example.org', repo: 'owner/enclave', operator: a(0x99) },
  selling: { cpuPrice6: null, payout: null }, isolation: { managerUrl: 'http://10.0.2.2:8095', dataAddr: '10.0.2.2:8096' }, hostAdmissionSha256: null, controlPort: 8444,
  chainVerifier: { format: 'enclave-chain-verifier/v1', unsafeSigner: '0x' + '9a'.repeat(20), proofSources: ['http://10.0.2.2:28545/'], port: 50546, expose: 'attested' } });
test('the verifier-only guest binds its chainVerifier and refuses every serving/admin member', () => {
  const cfg = canonicalDirectConfig(RAW());
  assert.equal(cfg.chainVerifier.expose, 'attested');
  for (const k of ['mcp', 'platformApi', 'nativeControl', 'leaseGas', 'ownerNomination'])
    assert.throws(() => canonicalDirectConfig({ ...RAW(), [k]: {} }), new RegExp(`verifier-only guest: remove ${k}`));
});
test('admin policy carriers stay available to a control guest, with their refusals (no host directory, no self, no Enclave origin)', () => {
  assert.deepEqual(checkPolicyCarriers({ peers: ['https://peer.example.org'] }), { peers: ['https://peer.example.org'] });
  assert.throws(() => checkPolicyCarriers({ importDir: '/srv/policy' }), /host directory is not visible/);
  assert.throws(() => checkPolicyCarriers({ peers: ['https://verifier.example.org'] }, { publicUrl: 'https://verifier.example.org' }), /this host itself/);
  assert.throws(() => checkPolicyCarriers({ peers: ['https://x.enclave.host'] }), /names an Enclave origin/);
});
