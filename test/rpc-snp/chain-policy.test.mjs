// Offline: rpc/snp/chain-policy.mjs admission decisions over ABI encodings produced by viem
// (chain-policy.fixtures.mjs), so the decoder is checked against an independent encoder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDeploymentPolicy } from '../../rpc/snp/chain-policy.mjs';
import * as F from './chain-policy.fixtures.mjs';

const LEDGER = '0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b', CATALOG = '0x18419ca2b502d423a8de6269aeee171a378626e3';
const policy = { rpcs: ['https://a.example', 'https://b.example'], ledger: LEDGER, catalog: CATALOG,
  deployment: F.DID, owner: F.OWNER, appId: F.APP, versionIndex: 1 };

function chain(dep, ver, { split } = {}) {
  return async (rpc, init) => {
    const { params: [{ to }] } = JSON.parse(init.body);
    const result = to === LEDGER ? (split && rpc === policy.rpcs[1] ? F.DEP_INACTIVE : dep) : ver;
    return { json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
  };
}
const resolve = (dep, ver, o) => resolveDeploymentPolicy(policy, { fetchImpl: chain(dep, ver, o), now: 3_000_000_000_000 });

test('an active, leased, owner-held deployment of the approved version is admitted', async () => {
  const p = await resolve(F.DEP_OK, F.VER_OK);
  assert.deepEqual(p.allowedMeasurements, [F.M]);
  assert.equal(p.hostData, F.DID.slice(2));
  assert.equal(p.version, '1.0.0');
});

test('every chain fact is required', async () => {
  for (const [dep, ver, why] of [
    [F.DEP_OTHER_OWNER, F.VER_OK, /owner/], [F.DEP_INACTIVE, F.VER_OK, /inactive/],
    [F.DEP_OTHER_VERSION, F.VER_OK, /different app version/], [F.DEP_NO_LEASE, F.VER_OK, /lease/],
    [F.DEP_OK, F.VER_PENDING, /not approved/], [F.DEP_OK, F.VER_YANKED, /not approved/],
    [F.DEP_OK, F.VER_NO_MEASUREMENT, /no SNP measurement/]]) {
    await assert.rejects(resolve(dep, ver), why);
  }
});

test('Base RPCs must agree, and one RPC is not enough', async () => {
  await assert.rejects(resolve(F.DEP_OK, F.VER_OK, { split: true }), /disagree/);
  await assert.rejects(resolveDeploymentPolicy({ ...policy, rpcs: ['https://a.example'] }, { fetchImpl: chain(F.DEP_OK, F.VER_OK) }), /two/);
});
