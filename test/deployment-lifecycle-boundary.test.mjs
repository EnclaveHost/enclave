import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { keccak256, toBytes } from 'viem';
import { openLifecycleJournal } from '../network/deployment-lifecycle-journal.mjs';
import { ownLifecycleJournal } from '../network/deployment-journal-owner.mjs';
import { signServingPermit, verifyServingPermit } from '../network/deployment-serving-permit.mjs';
import { DeploymentPermitGate } from '../network/deployment-permit-gate.mjs';
import { DeploymentLifecycleWitness } from '../network/deployment-lifecycle-witness.mjs';
import { lifecycleWitnessHandler } from '../network/deployment-witness-http.mjs';

const accounts = Array.from({ length: 5 }, () => privateKeyToAccount(generatePrivateKey()));
const id = keccak256(toBytes('boundary app')), host = keccak256(toBytes('boundary host'));
const pins = { chainId: 8453, lifecycle: accounts[4].address };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-boundary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = { dir, now: 1_000_000, mono: 0, callbacks: new Set(),
    record: { deployment: id, host, generation: 2, policyRevision: 1, sequence: 1, issuedAt: 1000, validUntil: 1020 },
    assignment: { deployment: id, host, operator: accounts[4].address, generation: 2, policyRevision: 1,
      state: 'running', admitted: true, funded: true, proofVerified: true, authorityTier: 'safe', blockTimestamp: 1000, observedAt: 1000 },
    policy: { revision: 1, threshold: 3, witnesses: accounts.slice(0, 4).map(a => a.address) } };
  f.journal = openLifecycleJournal(path.join(dir, 'gate.json'));
  f.envelope = async (r = f.record) => ({ record: r, signatures: await Promise.all(accounts.slice(0, 3).map(a => signServingPermit(a, pins, r))) });
  f.gate = new DeploymentPermitGate({ pins, journal: f.journal, now: () => f.now, monotonic: () => f.mono,
    timers: { set: fn => { f.callbacks.add(fn); return fn; }, clear: fn => f.callbacks.delete(fn) } });
  t.after(() => f.gate.close());
  return f;
}
test('expiry revokes streams and writes even without another reconciliation', async t => {
  const f = fixture(t); await f.gate.install(await f.envelope(), f);
  let closed = 0; f.gate.track(id, { host, generation: 2 }, () => { closed++; });
  f.now += 18000; f.mono += 18000;
  for (const fn of [...f.callbacks]) fn();
  assert.equal(closed, 1);
  assert.throws(() => f.gate.assert(id, { host, generation: 2 }), /no current/);
});
test('monotonic deadline and clock rollback prevent extending a permit', async t => {
  const f = fixture(t); const envelope = await f.envelope(); await f.gate.install(envelope, f);
  f.mono = 19000; // wall clock stalled but monotonic time advanced
  assert.throws(() => f.gate.assert(id, { host, generation: 2 }), /clock/);
  await assert.rejects(f.gate.install(envelope, f), /closed/);
});
test('permanent fence survives gate recreation and rejects the same generation', async t => {
  const f = fixture(t); await f.gate.install(await f.envelope(), f); f.gate.fence(id, 2); f.gate.close();
  const next = new DeploymentPermitGate({ pins, journal: openLifecycleJournal(path.join(f.dir, 'gate.json')), now: () => f.now });
  t.after(() => next.close());
  await assert.rejects(next.install(await f.envelope(), f), /fenced/);
});
test('a concurrent revocation wins over asynchronous signature verification', async t => {
  const f = fixture(t), envelope = await f.envelope();
  const installing = f.gate.install(envelope, f); f.gate.hold(id);
  await assert.rejects(installing, /superseded/);
  assert.throws(() => f.gate.assert(id, { host, generation: 2 }), /no current/);
});
test('kernel journal ownership excludes another writer and releases cleanly', { skip: process.platform !== 'linux' }, async t => {
  const f = fixture(t), file = path.join(f.dir, 'exclusive.json');
  const first = await ownLifecycleJournal(file, { initialize: true });
  await assert.rejects(ownLifecycleJournal(file), /lock|owned|in use/i);
  first.journal.observeAssignment(id, 2, 1); first.close();
  assert.throws(() => first.journal.read(id), /closed/);
  const next = await ownLifecycleJournal(file); t.after(() => next.close());
  assert.equal(next.journal.read(id).generation, 2);
});
function witness(f, index = 0, signer = accounts[index]) {
  return new DeploymentLifecycleWitness({ pins, account: signer,
    journal: openLifecycleJournal(path.join(f.dir, `witness-${index}.json`)), now: () => f.now,
    authority: { read: async () => f }, health: { verify: async () => ({ verified: true, deployment: id,
      host, generation: 2, ready: true, validUntil: 1020 }) } });
}
test('real HTTP witness refuses foreign operators and produces a verifiable permit signature', async t => {
  const f = fixture(t), w = witness(f);
  const server = http.createServer(lifecycleWitnessHandler(w)); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { w.close(); server.closeAllConnections(); server.close(); });
  const endpoint = `http://127.0.0.1:${server.address().port}/lifecycle/permit`;
  const post = signature => fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ record: f.record, operatorSignature: signature }), signal: AbortSignal.timeout(5000) });
  assert.equal((await post(await signServingPermit(accounts[1], pins, f.record))).status, 403);
  const response = await post(await signServingPermit(accounts[4], pins, f.record)); assert.equal(response.status, 200);
  const signed = await response.json();
  const other = await Promise.all(accounts.slice(1, 3).map(a => signServingPermit(a, pins, f.record)));
  await verifyServingPermit({ record: f.record, signatures: [signed.signature, ...other] }, { pins, ...f, nowSec: 1000 });
  w.fence(id, 2);
  assert.equal((await post(await signServingPermit(accounts[4], pins, f.record))).status, 403);
});
test('a witness persists before signing and refuses an equivocal or fenced request after restart', async t => {
  const f = fixture(t); let signs = 0;
  const account = { ...accounts[0], signTypedData: async data => {
    const disk = openLifecycleJournal(path.join(f.dir, 'witness-0.json')).read(id);
    assert.equal(disk.sequence, Number(data.message.sequence)); signs++;
    return accounts[0].signTypedData(data);
  } };
  const first = witness(f, 0, account);
  await first.permit(f.record, await signServingPermit(accounts[4], pins, f.record)); first.close();
  const next = witness(f, 0, account), equivocal = { ...f.record, validUntil: 1019 };
  await assert.rejects(next.permit(equivocal, await signServingPermit(accounts[4], pins, equivocal)), /equivocation/);
  next.fence(id, 2);
  await assert.rejects(next.permit(f.record, await signServingPermit(accounts[4], pins, f.record)), /fenced/);
  assert.equal(signs, 1);
});
test('a real open HTTP stream is destroyed by permit expiry', { timeout: 6000 }, async t => {
  const f = fixture(t), now = Math.floor(Date.now() / 1000);
  f.assignment.blockTimestamp = now; f.assignment.observedAt = now;
  const record = { ...f.record, issuedAt: now, validUntil: now + 4 };
  const gate = new DeploymentPermitGate({ pins, journal: f.journal });
  await gate.install(await f.envelope(record), f);
  let closed;
  const closePromise = new Promise(resolve => { closed = resolve; });
  const server = http.createServer((req, res) => {
    const release = gate.track(id, { host, generation: 2 }, () => { res.destroy(); closed(); });
    res.on('close', release); res.writeHead(200); res.write('open\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { gate.close(); server.closeAllConnections(); server.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}`, { signal: AbortSignal.timeout(5000) });
  const reader = response.body.getReader(); assert.equal((await reader.read()).done, false);
  await closePromise;
  await assert.rejects(reader.read());
  assert.throws(() => gate.assert(id, { host, generation: 2 }), /no current/);
});
test('an unresponsive authority adapter times out without signing or writing a permit', async t => {
  const f = fixture(t); let signed = 0;
  const w = new DeploymentLifecycleWitness({ pins, account: { ...accounts[0], signTypedData: async () => { signed++; } },
    journal: f.journal, authority: { read: () => new Promise(() => {}) }, health: { verify: async () => ({}) }, requestTimeoutMs: 20 });
  await assert.rejects(w.permit(f.record, '0x'), /deadline/);
  assert.equal(signed, 0); assert.equal(f.journal.read(id).digest, null);
  w.close();
});
