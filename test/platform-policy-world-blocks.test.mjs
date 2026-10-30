import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { platformPolicyWorld } from './helpers/platform-policy-world.mjs';

test('policy RPC fixture keeps a numbered block immutable across quorum reads', { timeout: 10000 }, async (t) => {
  const world = await platformPolicyWorld(t);
  const rpc = async (url, method, params) => {
    const res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error, undefined);
    return body.result;
  };
  const first = await rpc(world.rpcs[0], 'eth_getBlockByNumber', ['latest', false]);
  await delay(1200);
  for (const url of world.rpcs) {
    assert.deepEqual(await rpc(url, 'eth_getBlockByNumber', [first.number, false]), first);
    assert.deepEqual(await rpc(url, 'eth_getBlockByHash', [first.hash, false]), first);
  }
  const latest = await rpc(world.rpcs[0], 'eth_getBlockByNumber', ['latest', false]);
  assert.ok(BigInt(latest.number) > BigInt(first.number));
  assert.equal(BigInt(latest.timestamp) - BigInt(first.timestamp), BigInt(latest.number) - BigInt(first.number));
});
