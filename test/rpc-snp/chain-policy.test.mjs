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

// fetchImpl whose first `fails` calls to each RPC are refused as a rate-limited public RPC refuses them.
function flaky(fails, inner = chain(F.DEP_OK, F.VER_OK)) {
  const seen = new Map();
  const calls = [];
  const f = async (rpc, init) => {
    calls.push(rpc);
    const n = (seen.get(rpc) || 0) + 1; seen.set(rpc, n);
    if (n <= fails) return { status: 429, json: async () => { throw new SyntaxError('Unexpected token R'); } };
    return inner(rpc, init);
  };
  f.calls = calls;
  return f;
}
const KEYED = { ...policy, rpcs: ['https://base.example/v2/SECRETKEY', 'https://b.example'] };

test('one refused read per RPC is retried, and the deployment is still admitted', async () => {
  const f = flaky(1);
  const p = await resolveDeploymentPolicy(policy, { fetchImpl: f, now: 3_000_000_000_000, retryMs: 1 });
  assert.deepEqual(p.allowedMeasurements, [F.M]);
  assert.equal(f.calls.length, 6);   // 2 RPCs x (deployment retried + version)
});

test('a read refused twice still fails closed, naming the status but not the RPC URL', async () => {
  const f = flaky(2);
  await assert.rejects(resolveDeploymentPolicy(KEYED, { fetchImpl: f, now: 3_000_000_000_000, retryMs: 1 }),
    (e) => /^eth_call failed: HTTP 429$/.test(e.message) && !e.message.includes('SECRETKEY'));
});

test('a JSON-RPC error is retried once, then fails closed', async () => {
  const f = async () => ({ status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'limit' } }) });
  await assert.rejects(resolveDeploymentPolicy(policy, { fetchImpl: f, now: 3_000_000_000_000, retryMs: 1 }), /^Error: eth_call failed$/);
});

test('a retry does not relax agreement or the chain facts', async () => {
  await assert.rejects(resolveDeploymentPolicy(policy, { fetchImpl: flaky(1, chain(F.DEP_OK, F.VER_OK, { split: true })),
    now: 3_000_000_000_000, retryMs: 1 }), /disagree/);
  await assert.rejects(resolveDeploymentPolicy(policy, { fetchImpl: flaky(1, chain(F.DEP_INACTIVE, F.VER_OK)),
    now: 3_000_000_000_000, retryMs: 1 }), /inactive/);
});
