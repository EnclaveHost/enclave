import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resizeAfterStop, leaseReleased } from '../site/js/core/share-resize.js';
const zero = '0x' + '0'.repeat(64);
const held = { owner: '0xabc', appRef: 'catalog://app/2', cpuMilli: 10, gpuMilli: 0,
  active: true, runner: '0x' + '1'.repeat(64), leaseUntil: 10 };
const released = { ...held, active: false, runner: zero, leaseUntil: 0 };
function rig(rows, overrides = {}) {
  const events = []; let time = 0, i = 0;
  return { events, options: { expected: held, read: async () => { events.push('read'); return { ...rows[Math.min(i++, rows.length - 1)] }; },
    suspend: async () => events.push('suspend'), apply: async x => events.push(['apply', x.resume]),
    sleep: async ms => { events.push('wait'); time += ms; }, now: () => time, timeoutMs: 6000, ...overrides } };
}
test('waits for explicit lease release before resizing and restoring active state', async () => {
  const r = rig([held, { ...held, active: false }, released]);
  assert.deepEqual(await resizeAfterStop(r.options), { resumed: true });
  assert.deepEqual(r.events, ['read', 'suspend', 'read', 'wait', 'read', ['apply', true]]);
});
test('a deployment already suspended remains suspended after resize', async () => {
  const r = rig([released]);
  assert.deepEqual(await resizeAfterStop(r.options), { resumed: false });
  assert.deepEqual(r.events, ['read', 'read', ['apply', false]]);
});
test('an expired lease is not a release; timeouts never submit new shares', async () => {
  assert.equal(leaseReleased({ ...held, active: false, leaseUntil: 0 }), false);
  assert.equal(leaseReleased({ ...released, leaseUntil: 1 }), false);
  const r = rig([held, { ...held, active: false, leaseUntil: 0 }]);
  await assert.rejects(resizeAfterStop(r.options), /has not released.*may be suspended/);
  assert.equal(r.events.some(e => Array.isArray(e)), false);
});
test('concurrent resume prevents resize', async () => {
  const r = rig([held, { ...released, active: true }]);
  await assert.rejects(resizeAfterStop(r.options), /resumed elsewhere/);
  assert.equal(r.events.some(e => Array.isArray(e)), false);
});
test('stale owner, version or shares cannot suspend or resize another state', async () => {
  for (const patch of [{ owner: '0xdef' }, { appRef: 'catalog://app/3' }, { cpuMilli: 20 }, { gpuMilli: 10 }]) {
    const r = rig([{ ...held, ...patch }]);
    await assert.rejects(resizeAfterStop(r.options), /deployment changed/);
    assert.deepEqual(r.events, ['read']);
  }
  const r = rig([held, { ...released, appRef: 'catalog://app/3' }]);
  await assert.rejects(resizeAfterStop(r.options), /deployment changed/);
  assert.equal(r.events.some(e => Array.isArray(e)), false);
});
test('rejected resize reports partial completion and never resumes by itself', async () => {
  const r = rig([held, released], { apply: async () => { throw new Error('Rejected by wallet'); } });
  await assert.rejects(resizeAfterStop(r.options), /Rejected by wallet.*may be suspended/);
});
test('failed reads and rejected suspension do not change shares', async () => {
  const r = rig([held], { suspend: async () => { throw new Error('Rejected suspension'); } });
  await assert.rejects(resizeAfterStop(r.options), /^Error: Rejected suspension$/);
  assert.deepEqual(r.events, ['read']);
  const q = rig([held], { read: async () => { throw new Error('RPC unavailable'); } });
  await assert.rejects(resizeAfterStop(q.options), /RPC unavailable/);
  assert.deepEqual(q.events, []);
});
