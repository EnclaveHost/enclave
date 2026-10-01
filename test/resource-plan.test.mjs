import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resourceHosts, cpuMinimumOn } from '../site/js/core/resource-plan.js';

const host = (name, ram, gf, more = {}) => ({ id: name, name, eligible: true, serving: true,
  availability: { nodeRamGb: ram, nodeGflops: gf, gpu: false, cpuShareFree: 1, ...more } });
const spec = { memMb: 8 * 1024, cpuGflops: 100, volumes: [] };

test('a tiny host does not impose its ceiling or percentage floor on larger hosts', () => {
  const [tiny, large] = resourceHosts(spec, [host('tiny', 4, 200), host('large', 64, 2000)]);
  assert.ok(tiny.reason);
  assert.equal(large.reason, '');
  assert.equal(large.mins.cpuPct, 13);
  assert.equal(large.spec.nodeRamGb, 64);
});
test('missing hardware is unavailable rather than invented from fleet defaults', () => {
  const [unknown] = resourceHosts(spec, [host('unknown', undefined, 1000)]);
  assert.equal(unknown.mins, null);
  assert.match(unknown.reason, /unavailable/);
});
test('CPU-only destinations are checked against the app fallback, not its GPU-mode RAM', () => {
  const app = { ...spec, memMb: 4096, vramMb: 8192, gpuGflops: 100000, gpuOptional: true,
    cpuFallback: { memMb: 48 * 1024, cpuGflops: 500 } };
  const [small, large, gpu] = resourceHosts(app, [host('small', 32, 1000), host('large', 64, 1000),
    host('gpu', 32, 1000, { gpu: true, cardVramGb: 24, cardTflops: 200 })]);
  assert.match(small.reason, /fallback/);
  assert.equal(cpuMinimumOn(large, 0), 75);
  assert.equal(cpuMinimumOn(gpu, 500), 13);
});
test('host choices respect model overrides and isolation requirements', () => {
  const gpu = host('gpu', 64, 1000, { isolation: 'snp-guest-per-app', volumes: [{ name: 'stock' }] });
  assert.equal(resourceHosts({ ...spec, volumes: ['stock'] }, [gpu])[0].reason, '');
  assert.ok(resourceHosts(spec, [gpu], JSON.stringify({ config: { volumes: ['other'] } }))[0].reason);
  assert.ok(resourceHosts(spec, [gpu], JSON.stringify({ isolation: { gpuTee: true } }))[0].reason);
});
