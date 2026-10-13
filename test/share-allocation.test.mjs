import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shareBounds, changeShares } from '../site/js/core/share-allocation.js';

const options = { mins: { cpuPct: 5, cpuPctNoGpu: 44, gpuPct: 0 }, maxGpu: 1000, rev: 13 };
const saved = { cpuMilli: 650, gpuMilli: 800 };

test('a draft can never drag below the CPU or required GPU minimum', () => {
  assert.equal(changeShares(saved, 'cpu', 0, options).cpuMilli, 50);
  assert.equal(changeShares(saved, 'gpu', 0, { ...options, mins: { ...options.mins, gpuPct: 80 } }).gpuMilli, 800);
});
test('fallback raises the shared CPU floor and preserves the GPU allocation', () => {
  assert.deepEqual(changeShares(saved, 'cpu', 10, options, true), { cpuMilli: 440, gpuMilli: 800 });
  assert.deepEqual(changeShares(saved, 'cpu', 720, options, true), { cpuMilli: 720, gpuMilli: 800 });
});
test('CPU-only allocation enforces fallback minimum in the same gesture', () => {
  assert.deepEqual(changeShares({ cpuMilli: 50, gpuMilli: 800 }, 'gpu', 0, options), { cpuMilli: 440, gpuMilli: 0 });
});
test('fractional shares survive and ranges enforce platform maxima', () => {
  assert.deepEqual(changeShares(saved, 'cpu', 651, options), { cpuMilli: 651, gpuMilli: 800 });
  assert.equal(changeShares(saved, 'cpu', 2000, options).cpuMilli, 1000);
  assert.equal(changeShares(saved, 'gpu', 2000, { ...options, maxGpu: 900 }).gpuMilli, 900);
});
test('reading bounds or editing a draft never mutates the saved allocation', () => {
  const below = { cpuMilli: 10, gpuMilli: 0 };
  shareBounds(below, options, true); changeShares(below, 'cpu', 700, options);
  assert.deepEqual(below, { cpuMilli: 10, gpuMilli: 0 });
});
test('an impossible fallback does not invent a valid percentage or drop the GPU', () => {
  const tooLarge = { ...options, mins: { ...options.mins, cpuPctNoGpu: 140 } };
  assert.equal(shareBounds(saved, tooLarge, true).cpuMin, 1400);
  assert.deepEqual(changeShares(saved, 'cpu', 1000, tooLarge, true), saved);
  assert.deepEqual(changeShares(saved, 'gpu', 0, tooLarge), saved);
});
test('host CPU routing and older ledger coupling remain enforceable', () => {
  assert.equal(changeShares(saved, 'cpu', 0, { ...options, cpuMinimum: () => 70 }).cpuMilli, 700);
  assert.equal(changeShares(saved, 'cpu', 1000, { ...options, rev: 12 }).cpuMilli, 800);
  assert.equal(changeShares(saved, 'gpu', 100, { ...options, rev: 12 }).gpuMilli, 650);
});
