// network/privacy-agent.mjs: each app's guest proof renews on its own, and a round waits a bounded time for the chain.
// 2026-10-16 01:41:42Z every k11-4 app's authorization lapsed at once: one round waited on its slowest step (a new
// partition's probe, or a chain read through a failing control circuit) past the 60-s proofs of all the others.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PrivacyAgent} from '../network/privacy-agent.mjs';
import {defaultNetworkPolicy,validateNetworkPolicy} from '../network/network-policy.mjs';

const runner = '0x' + '22'.repeat(32), A = '0x' + 'aa'.repeat(32), B = '0x' + 'bb'.repeat(32);
const expected = id => ({appRef: 'catalog://x/1', configCid: 'bafy' + id.slice(2, 10), appSha256: '11'.repeat(32), runtimeId: 'r1'});

async function rig(t, {probe, refresh}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'privacy-proofs-')); t.after(async () => { await new Promise(res => setTimeout(res, 50)); await fs.rm(dir, {recursive: true, force: true, maxRetries: 5}); });
  let clock = 1_900_000_000_000;
  const now = () => clock;
  const lease = (id, extra = {}) => ({id, runner, owner: '0x' + '33'.repeat(20), active: true, isPublic: true, appRef: expected(id).appRef,
    configCid: expected(id).configCid, chainId: 8453, deployments: '0x' + '44'.repeat(20), leaseUntil: clock + 86_400_000,
    blockNumber: clock / 1000, blockTime: clock, validUntil: clock + 120_000, ...extra});
  const cache = new Map(), held = [];
  const leaseReader = {
    refresh: ids => refresh(ids, () => { const rows = ids.map(id => lease(id)); for (const r of rows) cache.set(r.id, r); return rows; }),
    get: id => cache.get(id) || null,
    hold: ms => { held.push(ms); for (const r of cache.values()) r.validUntil = Math.max(r.validUntil, clock + 60_000); return [...cache.keys()]; },
  };
  const logs = [];
  const network = {runtime: {}, providers: async () => [], onNetwork: () => true, localRoutes: false,
    policyFor: async app => validateNetworkPolicy(defaultNetworkPolicy(app.deploymentId))};
  const apps = [A, B].map(id => ({deploymentId: id, names: [id.slice(2, 10) + '.app.enclave.host'], expected: expected(id)}));
  const agent = new PrivacyAgent({apps, runner, leaseReader, probe, directory: dir, dns: ['1.1.1.1'], network, chainDeadlineMs: 50,
    now, log: m => logs.push(m)});
  t.after(() => { agent.closed = true; });
  return {agent, logs, held, cache, lease, tick: ms => { clock += ms; }, now};
}
const verdict = id => ({verified: true, deploymentId: id, appSha256: '11'.repeat(32), runtimeId: 'r1', spkiSha256: '55'.repeat(32)});

test('one app whose probe hangs does not hold up another app\'s proof renewals', async t => {
  const calls = {[A]: 0, [B]: 0};
  const r = await rig(t, {refresh: async (ids, rows) => rows(),
    probe: (id) => { calls[id]++; return id === B ? new Promise(() => {}) : Promise.resolve(verdict(id)); }});
  await r.agent.refreshAuthorization();
  await new Promise(res => setImmediate(res));
  assert.equal(r.agent.admission.allows(A), true, 'A is proven');
  assert.equal(r.agent.admission.allows(B), false, 'B is still being asked');
  for (let i = 0; i < 6; i++) {                 // 90 s: well past A's first 60-s proof
    r.tick(15_000);
    await r.agent.refreshAuthorization();
    await new Promise(res => setImmediate(res));
    assert.equal(r.agent.admission.allows(A), true, `A stays allowed at +${(i + 1) * 15} s`);
  }
  assert.ok(calls[A] >= 3, 'A was re-proven on its own schedule');
  assert.equal(calls[B], 1, 'the hanging probe is not stacked up');
});

test('a chain read that hangs past the deadline goes on with the held leases, and is not doubled', async t => {
  let hang = false, reads = 0;
  const r = await rig(t, {refresh: async (ids, rows) => { reads++; return hang ? new Promise(() => {}) : rows(); },
    probe: async id => verdict(id)});
  await r.agent.refreshAuthorization();
  await r.agent.refreshProofs();
  assert.equal(r.agent.admission.allows(A), true);
  hang = true; r.tick(15_000);
  const t0 = Date.now();
  await r.agent.refreshAuthorization();
  assert.ok(Date.now() - t0 < 2000, 'the round did not wait for the chain');
  assert.ok(r.logs.some(m => /no chain answer within 0.05 s; 2 running lease\(s\) held/.test(m)), r.logs.join('\n'));
  assert.equal(r.held.length, 1);
  r.tick(15_000);
  await r.agent.refreshAuthorization();
  assert.equal(reads, 2, 'a read still running is not started again');
  assert.ok(r.logs.some(m => /previous chain read has not finished/.test(m)));
  await r.agent.refreshProofs();
  assert.equal(r.agent.admission.allows(A), true, 'held leases and fresh proofs keep the app on');
});

test('a proof survives a re-read of the same lease while the guest is asked; a changed config voids it', async t => {
  const release = {};
  const r = await rig(t, {refresh: async (ids, rows) => rows(), probe: id => new Promise(res => { release[id] = () => res(verdict(id)); })});
  await r.agent.refreshAuthorization();
  const gate = r.agent.admission;
  // the same lease, read again at a later block while A's probe is out
  r.tick(5_000); gate.observeLease(r.lease(A));
  release[A](); release[B](); await r.agent.refreshProofs();
  assert.equal(gate.allows(A), true, 'a fresher read of the same lease keeps the proof');
  // a different config while the probe is out: no proof
  const id = A; gate.revoke(id);
  const run = gate.attest(id, () => new Promise(res => { setImmediate(() => { gate.leases.set(id, {...gate.leases.get(id), configCid: 'bafyother'}); res(verdict(id)); }); }));
  await assert.rejects(run, /no matching current app expectation|fresh bound guest proof required/);
});
