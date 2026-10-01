import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters } from 'viem';
import { catGetVersion, CAT_SEL, VER_SCHEMA, encCall } from '../site/js/core/chain.js';

test('reads the exact deployed version without trusting a cached version count', async () => {
  const original = globalThis.fetch, calls = [], appId = '0x' + 'a'.repeat(64);
  const types = { str: 'string', uint: 'uint256', bool: 'bool', addr: 'address', bytes32: 'bytes32' };
  const abi = [{ type: 'tuple[]', components: VER_SCHEMA.map(f => ({ name: f.k, type: types[f.t] })) }];
  const version = { cid: 'bafk-test', version: '1.0.70', vramMb: 51200n, gpuGflops: 320000n,
    memMb: 4096n, cpuGflops: 10n, createdAt: 1n, verified: true, yanked: false, ports: 'http', approval: 1n,
    config: JSON.stringify({ gpuOptional: true, cpuFallback: { memMb: 38912, cpuGflops: 20 } }) };
  let missing = false;
  globalThis.fetch = async (_url, init) => {
    const { params } = JSON.parse(init.body), data = params[0].data; calls.push(data);
    const result = data === '0x' + CAT_SEL.catalogSchema ? '0x7' : encodeAbiParameters(abi, [missing ? [] : [version]]);
    return { ok: true, json: async () => ({ result }) };
  };
  try {
    const found = await catGetVersion(appId, 70);
    assert.equal(found.version, '1.0.70');
    assert.equal(found.memMb, 4096);
    assert.equal(JSON.parse(found.config).cpuFallback.memMb, 38912);
    assert.equal(calls.at(-1), encCall(CAT_SEL.getVersionsPage,
      [{ t: 'bytes32', v: appId }, { t: 'uint', v: 70 }, { t: 'uint', v: 1 }]));
    missing = true;
    await assert.rejects(catGetVersion(appId, 70), /version is unavailable/);
  } finally { globalThis.fetch = original; }
});
