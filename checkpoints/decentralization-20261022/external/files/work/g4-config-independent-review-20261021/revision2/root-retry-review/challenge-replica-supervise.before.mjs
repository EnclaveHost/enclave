// revision2 B1 (work/g4-config-independent-review-20261021/revision2): the OPTIONAL challenge service never holds up or breaks
// a host's network, recovers on its own once a transient dependency (release directory, platform host policy, readiness)
// returns, never runs twice, never starts after close, and is never declared serving before it is genuinely ready.
// Readiness follows ledger-index PROGRESS (a ledger above one sync's 2048 ids is not starved by a fixed deadline).
//   node --test test/challenge-replica-supervise.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {keccak256, toBytes} from 'viem';
import {challengeReplicaConfig, startChallengeReplica, superviseChallengeReplica} from '../network/challenge-replica-host.mjs';
import {createNetworkHost} from '../network/enclave-network-host.mjs';
import * as F from './app-zone-fixture.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'challenge-supervise-'));
test.after(() => fs.rmSync(TMP, {recursive: true, force: true}));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 5000) => { for (const t = Date.now() + ms; Date.now() < t; await sleep(20)) if (await f()) return true; return false; };
const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const ENDPOINT = 'https://host-a.example.org', HOST_ID = keccak256(toBytes(ENDPOINT)).toLowerCase(), ZONE = 'app.enclave.host';
const DNS = Buffer.from('export {};\n'), BUNDLE = Buffer.from('export const x = 1;\n');
function release(deliver = true) {
  const dir = fs.mkdtempSync(path.join(TMP, 'release-'));
  const put = () => { fs.writeFileSync(path.join(dir, 'dns.mjs'), DNS, {mode: 0o444}); fs.writeFileSync(path.join(dir, 'network-runtime.bundle.mjs'), BUNDLE, {mode: 0o444});
    fs.writeFileSync(path.join(dir, 'dns.mjs.manifest.json'), JSON.stringify({sha256: sha(DNS), runtimeBundleSha256: sha(BUNDLE)}), {mode: 0o444}); };
  if (deliver) put();
  return {dir, put, pins: {dir, dnsSha256: sha(DNS), runtimeBundleSha256: sha(BUNDLE)}};
}
async function cfgFor(rel) {
  const decl = path.join(fs.mkdtempSync(path.join(TMP, 'decl-')), 'challenge-front.json');
  const c = challengeReplicaConfig({role: 'app-zone-replica', release: rel.pins, zones: {app: ZONE, ip: 'ip.enclave.host'}, ns: {name: 'ns-a.enclave.host'},
    listen: {dns: '127.0.0.1:18153', api: `127.0.0.1:${await freePort()}`}, front: {listen: `127.0.0.1:${await freePort()}`, managed: {zone: ZONE, declarationFile: decl}},
    routeMap: 'http://127.0.0.1:18188/v1/network/routes', chain: {rpcs: ['https://rpc-one.example', 'https://rpc-two.example'], pins: {...F.PINS}},
    shield: {policyFile: '/etc/c/shield-app-policy.json', profileFile: '/etc/c/profile.json', profileDigest: 'sha256:' + 'e'.repeat(64), rpcs: ['https://rpc-one.example', 'https://rpc-two.example']},
    hostPolicy: {policy: 'production', endpoint: ENDPOINT, stateDir: '/var/lib/enclave-challenge/host-policy'}});
  return {cfg: c, decl, state: () => { try { return JSON.parse(fs.readFileSync(decl, 'utf8')).state; } catch { return 'absent'; } }};
}
const fakeGate = (refusal = null) => { const g = {refusal, async check() {}, serviceRefusal: () => g.refusal, start() {}, stop() {}, status: () => ({fake: true})}; return g; };
// a stand-in replica: children counted alive until killed; /health from `ledger()` (size grows as the test says)
function replicaStandIn(cfg, ledger) {
  const kids = []; let alive = 0, maxAlive = 0;
  const spawn = () => { const c = new EventEmitter(); c.pid = 5000 + kids.length; kids.push(c); alive++; maxAlive = Math.max(maxAlive, alive);
    c.kill = () => { if (!c.dead) { c.dead = true; alive--; setImmediate(() => c.emit('exit', 0, 'SIGTERM')); } }; return c; };
  const fetch = async () => { const l = ledger(); return new Response(JSON.stringify({readOnly: true, appChallenge: {mode: 'attested-lease', judgeMode: 'trusted',
    ledgerIndex: {complete: l.complete, size: l.size}, shield: {hostExcluded: false, registry: {profileDigest: cfg.shield.profileDigest}}}})); };
  return {spawn, fetch, kids, alive: () => alive, maxAlive: () => maxAlive};
}

test('readiness follows ledger-index progress: a ledger larger than one sync completes past readyMs; a stall or the cap still refuses', async () => {
  const rel = release(), {cfg, state} = await cfgFor(rel);
  // 5 "syncs" of 2048 ids, one every 120 ms; readyMs 300 alone would refuse at ~6144 (the poll is every 250 ms)
  const t0 = Date.now(), grow = () => { const k = Math.min(5, 1 + Math.floor((Date.now() - t0) / 120)); return {size: k * 2048, complete: k === 5}; };
  const s = replicaStandIn(cfg, grow), seen = [];
  const h = await startChallengeReplica(cfg, {spawn: s.spawn, fetch: s.fetch, gate: fakeGate(), readyMs: 300, stallMs: 400, maxReadyMs: 5000,
    log: (m) => seen.push(m), declareEveryMs: 60_000, gateIntervalMs: 60_000});
  try {
    assert.ok(Date.now() - t0 >= 450, 'it waited for completion beyond readyMs'); assert.equal(state(), 'serving');
  } finally { await h.close(); }
  assert.equal(state(), 'stopped'); assert.equal(s.alive(), 0);
  // a stall (no growth, never complete): refused stallMs after the last growth, with the index position; nothing left running
  const rel2 = release(), c2 = await cfgFor(rel2), s2 = replicaStandIn(c2.cfg, () => ({size: 4096, complete: false}));
  const a = Date.now();
  await assert.rejects(startChallengeReplica(c2.cfg, {spawn: s2.spawn, fetch: s2.fetch, gate: fakeGate(), readyMs: 300, stallMs: 400, maxReadyMs: 5000}),
    /did not become ready .*ledger index at 4096 ids/);
  assert.ok(Date.now() - a < 1500, 'no growth: no extension beyond readyMs'); assert.equal(c2.state(), 'stopped'); assert.equal(s2.alive(), 0);
  // growth forever, never complete: bounded by maxReadyMs
  const rel3 = release(), c3 = await cfgFor(rel3); let n = 0; const s3 = replicaStandIn(c3.cfg, () => ({size: (n += 10), complete: false}));
  const b = Date.now();
  await assert.rejects(startChallengeReplica(c3.cfg, {spawn: s3.spawn, fetch: s3.fetch, gate: fakeGate(), readyMs: 300, stallMs: 300, maxReadyMs: 900}), /did not become ready/);
  const took = Date.now() - b; assert.ok(took >= 850 && took < 2200, `capped by maxReadyMs (${took} ms)`); assert.equal(s3.alive(), 0);
});

test('supervised: a transient policy refusal and a missing release recover on their own; one child at a time; serving only once ready', async () => {
  const rel = release(false), {cfg, state} = await cfgFor(rel);
  const gate = fakeGate('platform host policy: no authenticated admit yet (chain quorum unavailable)');
  const s = replicaStandIn(cfg, () => ({size: 9, complete: true})), logs = [];
  const sup = superviseChallengeReplica(cfg, {spawn: s.spawn, fetch: s.fetch, gate, retryMs: 40, maxRetryMs: 80, readyMs: 2000, log: (m) => logs.push(m),
    declareEveryMs: 60_000, gateIntervalMs: 60_000});
  try {
    assert.ok(await until(() => sup.status().attempts >= 2), 'retried while the release is missing');
    assert.ok(logs.some((l) => /not started \(attempt 1; .*unaffected\): .*release: dns\.mjs must be a regular file/.test(l)), logs.join('\n'));
    assert.equal(sup.handle, null); assert.notEqual(state(), 'serving'); assert.equal(s.kids.length, 0, 'nothing spawned before the release and the policy allow it');
    rel.put();                                                      // the release is delivered again (e.g. after a reinstall)
    assert.ok(await until(() => logs.some((l) => /not started .*platform host policy/.test(l))), 'next: the policy refusal, still retried');
    assert.equal(s.kids.length, 0);
    gate.refusal = null;                                            // the chain quorum is back: admitted
    assert.ok(await until(() => sup.handle !== null), 'started after the dependencies returned: ' + logs.join(' | '));
    assert.equal(state(), 'serving'); assert.ok(logs.some((l) => /started on attempt \d+/.test(l)));
    const n = sup.status().attempts; await sleep(200);
    assert.equal(sup.status().attempts, n, 'no attempt after the start'); assert.equal(s.maxAlive(), 1, 'never two children'); assert.equal(s.kids.length, 1);
  } finally { await sup.close(); }
  assert.equal(state(), 'stopped'); assert.equal(s.alive(), 0); assert.equal(sup.handle, null);
  const k = s.kids.length; await sleep(200); assert.equal(s.kids.length, k, 'nothing starts after close');
});

test('supervised close: a start in progress is cancelled at once (not after its readiness bound); a late success is closed and awaited', async () => {
  const rel = release(), {cfg, state} = await cfgFor(rel);
  const s = replicaStandIn(cfg, () => ({size: 0, complete: false}));
  const sup = superviseChallengeReplica(cfg, {spawn: s.spawn, fetch: s.fetch, gate: fakeGate(), readyMs: 60_000, stallMs: 60_000, retryMs: 40});
  assert.ok(await until(() => s.kids.length === 1), 'a start is waiting for readiness');
  const t = Date.now(); await sup.close();
  assert.ok(Date.now() - t < 2000, `close did not wait for the 60 s readiness (${Date.now() - t} ms)`);
  assert.equal(s.alive(), 0); assert.equal(state(), 'stopped'); assert.equal(sup.handle, null);
  await sleep(150); assert.equal(s.kids.length, 1, 'no retry after close');
  // a start that ignores cancellation and SUCCEEDS after close(): closed exactly once, and close() resolves only after that
  let closes = 0, release1;
  const late = {status: () => ({}), close: async () => { await sleep(50); closes++; }};
  const sup2 = superviseChallengeReplica(cfg, {start: () => new Promise((r) => { release1 = () => r(late); }), retryMs: 40});
  await sleep(10); assert.equal(typeof release1, 'function', 'the start is in flight');
  const done = sup2.close(); let resolved = false; done.then(() => { resolved = true; });
  await sleep(30); assert.equal(resolved, false, 'close awaits the start in flight'); release1();
  await done; assert.equal(closes, 1, 'the late handle was closed'); assert.equal(sup2.handle, null);
  // close() right after creation (before the deferred first start ran): nothing starts at all
  let started = 0; const sup4 = superviseChallengeReplica(cfg, {start: async () => { started++; return late; }}); await sup4.close(); await sleep(30);
  assert.equal(started, 0, 'no start after close');
  // a supervisor never runs two starts at once, even if attempts pile up
  let concurrent = 0, peak = 0, calls = 0;
  const sup3 = superviseChallengeReplica(cfg, {start: async () => { calls++; concurrent++; peak = Math.max(peak, concurrent); await sleep(60); concurrent--; throw new Error('transient'); }, retryMs: 10, maxRetryMs: 10});
  await sleep(400); await sup3.close();
  assert.ok(calls >= 3, `retried (${calls})`); assert.equal(peak, 1, 'one start at a time');
});

test('the network host: an unavailable challenge service never delays or breaks the network; it starts once its release returns', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'nethost-'));
  const rel = release(false), {cfg: c, state} = await cfgFor(rel);
  const raw = {role: 'app-zone-replica', release: rel.pins, zones: {app: ZONE, ip: 'ip.enclave.host'}, ns: {name: 'ns-a.enclave.host'},
    listen: {dns: '127.0.0.1:18153', api: `127.0.0.1:${c.listen.api.port}`}, front: {listen: `127.0.0.1:${c.front.listen.port}`, managed: {zone: ZONE, declarationFile: c.front.declarationFile}},
    routeMap: 'http://127.0.0.1:18188/v1/network/routes', chain: {rpcs: ['https://rpc-one.example', 'https://rpc-two.example'], pins: {...F.PINS}},
    shield: {policyFile: '/etc/c/shield-app-policy.json', profileFile: '/etc/c/profile.json', profileDigest: c.shield.profileDigest, rpcs: ['https://rpc-one.example', 'https://rpc-two.example']},
    hostPolicy: {policy: 'production', endpoint: ENDPOINT, stateDir: '/var/lib/enclave-challenge/host-policy'}};
  const base = {relay: 'http://127.0.0.1:9', checkers: ['0x' + '22'.repeat(20)], apps: 'all', wgBinary: '/bin/true', nodeBinary: process.execPath, workerModule: '/bin/true'};
  const s = replicaStandIn(c, () => ({size: 1, complete: true})), logs = [];
  const t = Date.now();
  const host = await createNetworkHost({config: {...base, challengeReplica: raw}, runner: HOST_ID, directory: dir, authorize: () => true,
    fetch: async () => new Response('{}', {status: 404}), log: (m) => logs.push(m),
    challengeOptions: {spawn: s.spawn, fetch: s.fetch, gate: fakeGate(), retryMs: 40, maxRetryMs: 80, readyMs: 2000, declareEveryMs: 60_000, gateIntervalMs: 60_000}});
  try {
    assert.ok(Date.now() - t < 1500, 'the network host did not wait for the challenge service');
    assert.equal(host.challengeReplica, null);
    assert.ok(await until(() => logs.some((l) => /challenge replica not started \(attempt 1; this host's network and every app's routes are unaffected\)/.test(l))), logs.join('\n'));
    rel.put();
    assert.ok(await until(() => host.challengeReplica !== null), 'recovered without a privacy-agent restart: ' + logs.join(' | '));
    assert.equal(state(), 'serving'); assert.equal(host.challengeService.status().running, true);
  } finally { await host.close(); }
  assert.equal(state(), 'stopped'); assert.equal(s.alive(), 0);
  // static configuration is still judged before anything binds (fatal, as before)
  await assert.rejects(createNetworkHost({config: {...base, challengeReplica: {...raw, certsApi: 'https://api.enclave.host'}}, runner: HOST_ID, directory: dir, authorize: () => true,
    fetch: async () => new Response('{}', {status: 404})}), /legacy central input/);
  await assert.rejects(createNetworkHost({config: {...base, challengeReplica: raw}, runner: '0x' + '11'.repeat(32), directory: dir, authorize: () => true,
    fetch: async () => new Response('{}', {status: 404})}), /hostPolicy.endpoint is not this host's registry endpoint/);
});
