// Live integration: runs only when ENCLAVE_RPC_ORIGIN and ENCLAVE_RPC_MEASUREMENT name a
// running rpc/snp enclave front (it talks to AMD KDS for the VCEK chain).
//   ENCLAVE_RPC_ORIGIN=https://127.0.0.1:18443 ENCLAVE_RPC_MEASUREMENT=<hex> node --test test/rpc-snp/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAttestedFetch } from '../../rpc/snp/attested-fetch.mjs';
import { createRpcGateway } from '../../rpc/gateway.mjs';

const origin = process.env.ENCLAVE_RPC_ORIGIN, measurement = process.env.ENCLAVE_RPC_MEASUREMENT;
const skip = !(origin && measurement) && 'set ENCLAVE_RPC_ORIGIN and ENCLAVE_RPC_MEASUREMENT';

test('gateway reads mainnet L1 through the attested enclave', { skip }, async () => {
  const f = createAttestedFetch({ attested: { [origin]: { allowedMeasurements: [measurement] } } });
  const gw = createRpcGateway({ upstreams: { ethereum: [origin + '/l1'] }, fetchImpl: f, timeoutMs: 20000 });
  const chain = await gw.request('ethereum', { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] });
  assert.equal(chain.result, '0x1');
  const head = await gw.request('ethereum', { jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] });
  assert.match(head.result, /^0x[0-9a-f]+$/);
  assert.equal(f.pins.get(origin).measurement, measurement);
});

test('an enclave whose measurement is not allowlisted is refused', { skip }, async () => {
  const f = createAttestedFetch({ attested: { [origin]: { allowedMeasurements: ['00'.repeat(48)] } } });
  await assert.rejects(f(origin + '/l1', { method: 'POST', body: '{}' }), /attestation refused/);
});

test('concurrent first requests share one attestation', { skip }, async () => {
  const f = createAttestedFetch({ attested: { [origin]: { allowedMeasurements: [measurement] } } });
  const gw = createRpcGateway({ upstreams: { ethereum: [origin + '/l1'] }, fetchImpl: f, timeoutMs: 3000 });
  const rows = await Promise.all(['eth_chainId', 'eth_blockNumber', 'net_version'].map((method, id) =>
    gw.request('ethereum', { jsonrpc: '2.0', id, method, params: [] })));
  assert.ok(rows.every((r) => r.result), JSON.stringify(rows));
});

test('a stale key pin re-attests once and then succeeds', { skip }, async () => {
  const f = createAttestedFetch({ attested: { [origin]: { allowedMeasurements: [measurement] } } });
  const first = await f(origin + '/l1', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
  assert.equal((await first.json()).result, '0x1');
  const real = f.pins.get(origin);
  f.pins.set(origin, { ...real, spki: '00'.repeat(32) });  // as if the enclave rebooted with a new key
  const again = await f(origin + '/l1', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_chainId', params: [] }) });
  assert.equal((await again.json()).result, '0x1');
  assert.equal(f.pins.get(origin).spki, real.spki);
});

test('HOST_DATA must match the policy', { skip }, async () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] });
  const wrong = createAttestedFetch({ attested: { [origin]: { allowedMeasurements: [measurement], hostData: 'ab'.repeat(32) } } });
  await assert.rejects(wrong(origin + '/l1', { method: 'POST', body }), /HOST_DATA/);
  const f = createAttestedFetch({ attested: { [origin]: { allowedMeasurements: [measurement] } } });
  await f(origin + '/l1', { method: 'POST', body });
  const right = createAttestedFetch({ attested: { [origin]: { allowedMeasurements: [measurement], hostData: f.pins.get(origin).hostData } } });
  assert.equal((await (await right(origin + '/l1', { method: 'POST', body })).json()).result, '0x1');
});

test('re-attestation after a dropped pin works on a new connection', { skip, timeout: 180000 }, async () => {
  // The front resets or resumes a cached TLS session without its certificate (prod r10, 2026-11-06).
  // Seen from the control VM (192.168.8.249); over loopback Node cached no session and it passed anyway.
  const f = createAttestedFetch({ attested: { [origin]: { allowedMeasurements: [measurement] } } });
  const call = async (id) => (await (await f(origin + '/l1', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'eth_chainId', params: [] }) })).json()).result;
  assert.equal(await call(1), '0x1');
  for (const id of [2, 3]) {
    await new Promise((r) => setTimeout(r, 35000));  // past the front's 30 s idle close, so attestation reconnects
    f.pins.delete(origin);
    assert.equal(await call(id), '0x1');
  }
});
