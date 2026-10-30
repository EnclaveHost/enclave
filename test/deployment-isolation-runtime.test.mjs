import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { keccak256, toBytes } from 'viem';
import { IsolationManagerClient } from '../windows/node/isolation-client.mjs';
import { createIsolationLifecycleRuntime } from '../network/deployment-isolation-runtime.mjs';
import { DeploymentPermitGate } from '../network/deployment-permit-gate.mjs';
import { DeploymentLifecycleWitness } from '../network/deployment-lifecycle-witness.mjs';
import { createPermitCollector } from '../network/deployment-permit-collector.mjs';
import { lifecycleWitnessHandler } from '../network/deployment-witness-http.mjs';
import { openLifecycleJournal } from '../network/deployment-lifecycle-journal.mjs';
const accounts = Array.from({ length: 5 }, () => privateKeyToAccount(generatePrivateKey()));
const id = keccak256(toBytes('manager app')), host = keccak256(toBytes('manager host'));
async function setup(t, { boundaryTimeoutMs = 3000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-manager-'));
  const f = { dir, now: 1000000, mono: 0, vm: null, spawnCount: 0, removed: [], timers: new Set(), grants: [], servers: [] };
  const listen = async handler => { const server = http.createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening'); f.servers.push(server); return `http://127.0.0.1:${server.address().port}`; };
  const managerUrl = await listen(async (req, res) => {
    const reply = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/vms') return reply(f.inventoryUnknown ? 503 : 200, f.inventoryUnknown ? { error: 'unknown' } : { vms: f.vm ? [f.vm] : [] });
    if (req.method === 'POST' && req.url === '/vms') {
      f.spawnCount++; const parts = []; for await (const c of req) parts.push(c); const body = JSON.parse(Buffer.concat(parts));
      if (f.refuse) return reply(403, { error: 'refused fixture launch' });
      f.vm = { id: `fixture-${f.spawnCount}`, name: body.name, status: 'running', appReady: true, recovered: false };
      return reply(201, f.vm);
    }
    if (req.method === 'DELETE') {
      const instance = req.url.split('/').at(-1);
      if (f.vm?.id === instance) { f.removed.push(f.vm.id); f.vm = null; }
      return reply(200, { removed: true });
    }
    return reply(404, { error: 'not found' });
  });
  const pins = { chainId: 8453, lifecycle: accounts[4].address };
  const policy = { revision: 1, threshold: 3, witnesses: accounts.slice(0, 4).map(a => a.address) };
  const assignment = { deployment: id, host, operator: accounts[4].address, generation: 2, policyRevision: 1, state: 'running',
    admitted: true, funded: true, proofVerified: true, authorityTier: 'safe', blockTimestamp: 1000, observedAt: 1000 };
  const endpoints = [];
  for (let i = 0; i < 4; i++) {
    const w = new DeploymentLifecycleWitness({ pins, account: accounts[i], now: () => f.now,
      journal: openLifecycleJournal(path.join(dir, `witness-${i}.json`)), authority: { read: async () => ({ assignment, policy }) },
      health: { verify: async () => ({ verified: true, deployment: id, host, generation: 2, ready: !!f.vm, validUntil: 1020 }) } });
    endpoints.push({ address: accounts[i].address, url: await listen(lifecycleWitnessHandler(w)) });
  }
  f.journal = openLifecycleJournal(path.join(dir, 'host.json'));
  f.gate = new DeploymentPermitGate({ pins, journal: f.journal, now: () => f.now, monotonic: () => f.mono,
    timers: { set: cb => { f.timers.add(cb); return cb; }, clear: cb => f.timers.delete(cb) } });
  const body = IsolationManagerClient.spawnBody({ image: 'fixture-image', name: id, appPort: 8080, derive: { fixture: true }, isPublic: true, hasSecrets: false });
  const plan = { verified: true, body, host, stagingEnforced: true };
  f.boundaries = {
    hold: async deployment => ({ deployment, ingress: true, storage: true, secrets: true }),
    allow: async (deployment, grant) => { f.grants.push(grant); return { deployment, ...grant, expiryEnforced: true }; },
  };
  f.runtime = createIsolationLifecycleRuntime({ host, journal: f.journal, gate: f.gate, now: () => f.now, boundaryTimeoutMs,
    client: new IsolationManagerClient({ base: managerUrl }), plans: { read: async () => plan },
    readiness: { verify: async ({ view, generation }) => ({ verified: true, ready: true, deployment: id, host,
      generation, instance: view.id, validUntil: f.now + 20000 }) },
    collectPermit: createPermitCollector({ pins, account: accounts[4], endpoints, allowLoopbackHttp: true, timeoutMs: 2000 }),
    boundaries: f.boundaries,
  });
  f.queued = { assignment: { state: 'queued', generation: 1, revision: 1, host } };
  f.running = { assignment: { state: 'running', generation: 2, revision: 1, host }, policy, servingContext: { assignment, policy } };
  t.after(async () => { f.gate.close(); await new Promise(resolve => setTimeout(resolve, 20)); for (const s of f.servers) { s.closeAllConnections(); s.close(); } fs.rmSync(dir, { recursive: true, force: true }); });
  return f;
}
test('real manager HTTP client and four witness endpoints stage, admit and retire a runtime on permit expiry', async t => {
  const f = await setup(t);
  assert.equal((await f.runtime.ensureStaged(id, f.queued)).ready, true);
  assert.equal(f.spawnCount, 1); assert.equal(f.grants.length, 0);
  assert.equal((await f.runtime.health(id, 2)).ready, true);
  await f.runtime.serve(id, f.running);
  assert.equal(f.grants[0].generation, 2); assert.equal(f.grants[0].validUntil, 1018000);
  f.now += 18000; f.mono += 18000;
  for (const expire of [...f.timers]) expire();
  const deadline = Date.now() + 1000;
  while (f.vm && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.vm, null); assert.deepEqual(f.removed, ['fixture-1']);
  assert.throws(() => f.gate.assert(id, { host, generation: 2 }), /no current/);
});
async function until(check) {
  const deadline = Date.now() + 2000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check(), 'expected asynchronous action did not complete');
}
function expire(f) {
  f.now += 18000; f.mono += 18000;
  for (const callback of [...f.timers]) callback();
}
test('permit expiry removes the concrete VM while boundary allow and hold both hang', async t => {
  const f = await setup(t, { boundaryTimeoutMs: 100 });
  await f.runtime.ensureStaged(id, f.queued);
  let allowing = false, signal;
  f.boundaries.allow = (_id, _grant, options) => { allowing = true; signal = options.signal; return new Promise(() => {}); };
  f.boundaries.hold = () => new Promise(() => {});
  const serving = assert.rejects(f.runtime.serve(id, f.running), /timed out/);
  await until(() => allowing);
  expire(f);
  await until(() => f.vm === null);
  assert.deepEqual(f.removed, ['fixture-1']);
  await serving;
  assert.equal(signal.aborted, true);
});
test('a delayed allow acknowledgment after revocation cannot restore serving', async t => {
  const f = await setup(t);
  await f.runtime.ensureStaged(id, f.queued);
  let acknowledge;
  f.boundaries.allow = (deployment, grant) => new Promise(resolve => {
    acknowledge = () => resolve({ deployment, ...grant, expiryEnforced: true });
  });
  const serving = assert.rejects(f.runtime.serve(id, f.running), /no current serving permit/);
  await until(() => acknowledge);
  expire(f);
  acknowledge();
  await serving;
  await until(() => f.vm === null);
  assert.throws(() => f.gate.assert(id, { host, generation: 2 }), /no current/);
});
test('stop removes staged compute even if boundary withdrawal times out', async t => {
  const f = await setup(t, { boundaryTimeoutMs: 25 });
  await f.runtime.ensureStaged(id, f.queued);
  f.boundaries.hold = () => new Promise(() => {});
  await assert.rejects(f.runtime.stop(id), /hold timed out/);
  assert.equal(f.vm, null);
  assert.equal(f.journal.read(id).runtime, null);
});
test('expiry removes only the verified instance, never a replacement with the same deployment name', async t => {
  const f = await setup(t, { boundaryTimeoutMs: 25 });
  await f.runtime.ensureStaged(id, f.queued);
  await f.runtime.serve(id, f.running);
  f.vm = { ...f.vm, id: 'replacement' };
  f.boundaries.hold = () => new Promise(() => {});
  expire(f);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(f.vm.id, 'replacement');
  assert.deepEqual(f.removed, []);
});
test('refused startups get durable distinct attempt identities while unknown inventory never spawns', async t => {
  const f = await setup(t); f.refuse = true;
  const first = await f.runtime.ensureStaged(id, f.queued), second = await f.runtime.ensureStaged(id, f.queued);
  assert.equal(first.ended, true); assert.notEqual(first.instance, second.instance);
  assert.equal(f.journal.read(id).attemptSequence, 2);
  f.inventoryUnknown = true;
  await assert.rejects(f.runtime.ensureStaged(id, f.queued), /unknown/);
  assert.equal(f.spawnCount, 2); assert.equal(f.grants.length, 0);
});
test('a retired failed boot can be replaced within the queued generation without clearing crash accounting', async t => {
  const f = await setup(t);
  await f.runtime.ensureStaged(id, f.queued);
  f.vm.status = 'failed';
  const failed = await f.runtime.ensureStaged(id, f.queued);
  assert.equal(failed.ended, true);
  f.journal.failure(id, { identity: failed.instance, now: f.now, random: () => 0 });
  assert.equal(await f.runtime.stop(id), true);
  assert.equal(f.journal.read(id).runtime, null);
  const replacement = await f.runtime.ensureStaged(id, f.queued);
  assert.equal(replacement.ready, true); assert.notEqual(replacement.instance, failed.instance);
  assert.equal(f.journal.read(id).restart.failures, 1);
});
