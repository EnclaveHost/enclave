import { test } from 'node:test';
import assert from 'node:assert/strict';
import { versionAllocation } from '../site/js/core/version-allocation.js';
const input = { bought: { gpuMilli: 100, cpuMilli: 140 }, gpuPct: 13, cpuMinimum: () => 2,
  rev: 13, maxGpu: 1000, availability: { gpuShareFree: 0.1, cpuShareFree: 0 } };

test('10% reserved plus 10% free admits 13%, retaining CPU even on a full node', () => {
  assert.deepEqual(versionAllocation(input), { target: { gpuMilli: 130, cpuMilli: 140 }, resized: true, reason: '' });
  assert.deepEqual(input.bought, { gpuMilli: 100, cpuMilli: 140 });
});
test('uses the target version minimum and preserves excess reservations', () => {
  assert.equal(versionAllocation({ ...input, gpuPct: 52 }).reason.includes('only 10%'), true);
  const fits = versionAllocation({ ...input, gpuPct: 8, availability: null });
  assert.equal(fits.resized, false); assert.equal(fits.reason, '');
});
test('requires only the delta, including exact boundary and fractional reservations', () => {
  assert.equal(versionAllocation({ ...input, availability: { gpuShareFree: .03 } }).reason, '');
  assert.match(versionAllocation({ ...input, availability: { gpuShareFree: .029 } }).reason, /only 2.9%/);
  assert.equal(versionAllocation({ ...input, bought: { gpuMilli: 105, cpuMilli: 145 } }).target.cpuMilli, 145);
});
test('unknown capacity fails closed only for a pool that grows', () => {
  for (const gpuShareFree of [undefined, null, '0.1', NaN, Infinity, -1, 2])
    assert.match(versionAllocation({ ...input, availability: { gpuShareFree } }).reason, /unavailable/);
  assert.match(versionAllocation({ ...input, cpuMinimum: () => 15 }).reason, /additional CPU/);
});
test('platform limits and old ledger coupling apply to the proposed allocation', () => {
  assert.match(versionAllocation({ ...input, rev: 5 }).reason, /ledger/);
  assert.match(versionAllocation({ ...input, maxGpu: 120 }).reason, /limit/);
  assert.match(versionAllocation({ ...input, cpuMinimum: () => 101 }).reason, /limit/);
  assert.equal(versionAllocation({ ...input, rev: 12 }).target.gpuMilli, 140);
});
