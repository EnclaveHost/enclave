import test from 'node:test';
import assert from 'node:assert/strict';
import {createProbeScheduler} from '../network/probe-scheduler.mjs';

test('a hung public route cannot block local authorization renewal', async () => {
  const schedule = createProbeScheduler();
  let release;
  const route = schedule('app', true, () => new Promise(r => { release = r; }));
  assert.equal(await schedule('app', false, () => 'fresh proof'), 'fresh proof');
  release(); await route;
});

test('local TPM reports remain serialized and recover after rejection', async () => {
  const schedule = createProbeScheduler(), order = [];
  let release;
  const first = schedule('app', false, () => new Promise((_, reject) => {
    order.push('first'); release = () => reject(new Error('busy'));
  }));
  const second = schedule('app', false, () => order.push('second'));
  await Promise.resolve(); assert.deepEqual(order, ['first']);
  release(); await assert.rejects(first, /busy/); await second;
  assert.deepEqual(order, ['first', 'second']);
});
