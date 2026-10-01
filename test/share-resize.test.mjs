import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resizeAfterStop, leaseReleased, leaseAvailable } from '../site/js/core/share-resize.js';
const zero = '0x' + '0'.repeat(64);
const held = { owner: '0xabc', appRef: 'catalog://app/2', cpuMilli: 10, gpuMilli: 0,
  active: true, runner: '0x' + '1'.repeat(64), leaseUntil: 600, blockTimestamp: 1, blockNumber: 1 };
const target = { gpuMilli: 0, cpuMilli: 400 };
const saved = { ...held, ...target, active: false, blockNumber: 2 };
const released = { ...saved, runner: zero, leaseUntil: 0, blockNumber: 3 };
function rig(rows, overrides = {}) {
  const events = []; let time = 0, i = 0;
  return { events, options: { expected: held, target,
    read: async () => { events.push('read'); const row = rows[Math.min(i++, rows.length - 1)]; if (row instanceof Error) throw row; return { ...row }; },
    apply: async x => events.push(['save-shares', x.active]), saved: () => events.push('saved'),
    resume: async () => events.push('resume'),
    sleep: async ms => { events.push('wait'); time += ms; }, now: () => time, timeoutMs: 6000, ...overrides } };
}
test('saves shares and stop together BEFORE waiting; requeues after release', async () => {
  const r = rig([held, saved, released]);
  assert.deepEqual(await resizeAfterStop(r.options), { resumed: true });
  assert.deepEqual(r.events, ['read', ['save-shares', false], 'saved', 'read', 'wait', 'read', 'resume']);
});
test('a stopped app without a lease saves shares and requeues in one transaction', async () => {
  const r = rig([{ ...held, active: false, runner: zero, leaseUntil: 0 }]);
  assert.deepEqual(await resizeAfterStop(r.options), { resumed: true });
  assert.deepEqual(r.events, ['read', ['save-shares', true], 'saved']);
});
test('expired leases with nonzero runner also allow one-transaction requeue', async () => {
  const r = rig([{ ...held, blockTimestamp: 601 }]);
  await resizeAfterStop(r.options);
  assert.deepEqual(r.events, ['read', ['save-shares', true], 'saved']);
});
test('lagging RPCs after receipt and backward block reads do not abandon saved resize', async () => {
  const r = rig([held, held, saved, held, released], { timeoutMs: 15000 });
  await resizeAfterStop(r.options);
  assert.equal(r.events.filter(x => x === 'resume').length, 1);
  assert.equal(r.events.filter(x => Array.isArray(x)).length, 1);
});
test('temporary RPC failure while waiting does not strand the app', async () => {
  const r = rig([held, new Error('RPC offline'), saved, released], { timeoutMs: 15000 });
  await resizeAfterStop(r.options);
  assert.equal(r.events.at(-1), 'resume');
});
test('remaining lease time, not a three-minute cutoff, controls default timeout', async () => {
  const r = rig([held, ...Array(70).fill(saved), released], { timeoutMs: undefined });
  await resizeAfterStop(r.options);
  assert.equal(r.events.at(-1), 'resume');
});
test('expiry is strict and uses chain time, never browser time', async () => {
  assert.equal(leaseReleased({ ...held, leaseUntil: 0 }), false);
  assert.equal(leaseReleased(released), true);
  assert.equal(leaseAvailable({ ...held, blockTimestamp: 600 }), false);
  assert.equal(leaseAvailable({ ...held, blockTimestamp: 601 }), true);
  for (const blockTimestamp of [undefined, null, NaN, Infinity, 0, -1])
    assert.equal(leaseAvailable({ ...held, blockTimestamp }), false);
  for (const leaseUntil of [undefined, null, NaN, Infinity, -1])
    assert.equal(leaseAvailable({ ...held, leaseUntil, blockTimestamp: 601 }), false);
});
test('timeout preserves target shares and never resumes before lease release', async () => {
  const r = rig([held, saved]);
  await assert.rejects(resizeAfterStop(r.options), /old lease.*new shares are saved/);
  assert.equal(r.events.includes('saved'), true);
  assert.equal(r.events.includes('resume'), false);
});
test('external owner/version/shares changes are never overwritten', async () => {
  for (const patch of [{ owner: '0xdef' }, { appRef: 'catalog://app/3' }, { cpuMilli: 20 }, { gpuMilli: 10 }]) {
    const r = rig([{ ...held, ...patch }]);
    await assert.rejects(resizeAfterStop(r.options), /changed/);
    assert.deepEqual(r.events, ['read']);
  }
  for (const patch of [{ owner: '0xdef' }, { appRef: 'catalog://app/3' }, { cpuMilli: 30 }, { active: true }]) {
    const r = rig([held, saved, { ...released, ...patch }]);
    await assert.rejects(resizeAfterStop(r.options), /changed/);
    assert.equal(r.events.includes('resume'), false);
  }
});
test('cancelled first transaction never leaves a stopped deployment', async () => {
  const r = rig([held], { apply: async () => { throw Error('Rejected by wallet'); } });
  await assert.rejects(resizeAfterStop(r.options), /^Error: Rejected by wallet$/);
  assert.deepEqual(r.events, ['read']);
});
test('cancelled requeue retains requested shares and explains how to finish', async () => {
  const r = rig([held, released], { resume: async () => { throw Error('Rejected by wallet'); } });
  await assert.rejects(resizeAfterStop(r.options), /Rejected by wallet.*new shares are saved.*Resize and restart/);
  assert.equal(r.events.includes('saved'), true);
});
test('retry after cancelled requeue can use already-saved shares unchanged', async () => {
  const r = rig([released], { expected: released });
  await resizeAfterStop(r.options);
  assert.deepEqual(r.events, ['read', ['save-shares', true], 'saved']);
});
