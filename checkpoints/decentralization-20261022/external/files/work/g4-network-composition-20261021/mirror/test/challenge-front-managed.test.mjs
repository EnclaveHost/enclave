// The app-zone-replica's MANAGED front (network/challenge-replica-host.mjs front.managed; work/challenge-host-tls-20261021):
// TLS belongs to the host's service-tls role, so this front is plaintext on loopback only, answers only the host-derived
// challenge origin, proves its declared key, and declares serving/stopped with the host policy gate's decisions.
// The service-tls side (real TLS, restrictions behind it, spoofed declarations) is in test/service-tls.test.mjs.
//   node --test test/challenge-front-managed.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {createHash, randomBytes} from 'node:crypto';
import {keccak256, toBytes} from 'viem';
import {challengeReplicaConfig, startChallengeReplica, startReplicaFront, challengeReplicaAdDraft} from '../network/challenge-replica-host.mjs';
import {frontProof, frontDeclarationRefusal, proofMatches, FRONT_PROOF_PATH, DECLARATION_TTL_MS} from '../network/challenge-front-declaration.mjs';
import {hostChallengeName} from '../network/host-service-names.mjs';
import {createNetworkHost} from '../network/enclave-network-host.mjs';
import * as F from './app-zone-fixture.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'challenge-managed-'));
test.after(() => fs.rmSync(TMP, {recursive: true, force: true}));
const H = (c) => c.repeat(64);
const ENDPOINT = 'https://host-a.example.org', HOST_ID = keccak256(toBytes(ENDPOINT)).toLowerCase(), ZONE = 'app.enclave.host';
const NAME = hostChallengeName(HOST_ID, ZONE);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
// the same shape as test/challenge-replica-host.test.mjs base(), with a managed front
const base = (front = {listen: '127.0.0.1:18292', managed: {zone: ZONE, declarationFile: '/var/lib/enclave/network/challenge-front.json'}}) => ({
  role: 'app-zone-replica', release: {dir: '/opt/enclave-challenge/releases/x', dnsSha256: H('a'), runtimeBundleSha256: H('b')},
  zones: {app: ZONE, ip: 'ip.enclave.host'}, ns: {name: 'ns-a.enclave.host'}, listen: {dns: '127.0.0.1:18153', api: '127.0.0.1:8154'}, front,
  routeMap: 'http://127.0.0.1:18188/v1/network/routes', chain: {rpcs: ['https://rpc-one.example', 'https://rpc-two.example'], pins: {...F.PINS}},
  shield: {policyFile: '/etc/c/shield-app-policy.json', profileFile: '/etc/c/profile.json', profileDigest: 'sha256:' + H('e'), rpcs: ['https://rpc-one.example', 'https://rpc-two.example']},
  hostPolicy: {policy: 'production', endpoint: ENDPOINT, stateDir: '/var/lib/enclave-challenge/host-policy'}});
const fakeGate = () => { const g = {refusal: null, async check() {}, serviceRefusal: () => g.refusal, start() {}, stop() {}, status: () => ({fake: true, refusal: g.refusal})}; return g; };
function get(port, target, headers = {}) {
  return new Promise((ok, no) => {
    const r = http.request({host: '127.0.0.1', port, path: target, method: headers.method || 'GET', agent: false, headers: {host: NAME, ...headers}}, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} ok({status: res.statusCode, body: j}); }); });
    r.on('error', no); r.end();
  });
}

test('managed front configuration: the name is the host\'s own; loopback only; no static key; never with policy "off"; static stays as it was', () => {
  const c = challengeReplicaConfig(base());
  assert.equal(c.front.mode, 'managed'); assert.equal(c.front.hostId, HOST_ID, 'keccak256 of hostPolicy.endpoint exactly');
  assert.equal(c.front.name, NAME); assert.equal(c.front.origin, `https://${NAME}`);
  assert.deepEqual(c.front.listen, {ip: '127.0.0.1', port: 18292});
  assert.equal(challengeReplicaConfig(base({...base().front, origin: `https://${NAME}`})).front.origin, `https://${NAME}`, 'the derived origin may be written');
  const bad = {
    'a public bind': [{...base().front, listen: '0.0.0.0:443'}, /loopback/],
    'a LAN bind': [{...base().front, listen: '192.168.8.238:18292'}, /loopback/],
    'a static key beside it': [{...base().front, certFile: '/etc/c/front.pem', keyFile: '/etc/c/front.key'}, /conflicts with front.certFile\/keyFile/],
    'only a cert file': [{...base().front, certFile: '/etc/c/front.pem'}, /conflicts/],
    'another origin': [{...base().front, origin: 'https://challenge-a.example.org'}, /derived challenge origin/],
    'another host\'s origin': [{...base().front, origin: `https://${hostChallengeName('0x' + '11'.repeat(32), ZONE)}`}, /derived challenge origin/],
    'an unknown field': [{...base().front, managed: {...base().front.managed, name: 'evil.example'}}, /unknown field/],
    'a relative declaration': [{...base().front, managed: {...base().front.managed, declarationFile: 'decl.json'}}, /absolute/],
    'a bad zone': [{...base().front, managed: {...base().front.managed, zone: 'Not A Zone'}}, /front.managed.zone/],
  };
  for (const [what, [front, re]] of Object.entries(bad)) assert.throws(() => challengeReplicaConfig(base(front)), re, what);
  const off = base(); off.hostPolicy = {policy: 'off'};
  assert.throws(() => challengeReplicaConfig(off), /refused with hostPolicy "off"/);
  const owner = {...base(), role: 'owner-responder', zones: {challenge: 'acme.owner.example'}}; delete owner.routeMap; delete owner.chain;
  assert.throws(() => challengeReplicaConfig(owner), /only the app-zone-replica/);
  // the static front: exactly as before (plus its mode)
  const st = challengeReplicaConfig(base({listen: '203.0.113.7:443', certFile: '/etc/c/front.pem', keyFile: '/etc/c/front.key', origin: 'https://challenge-a.example.org'}));
  assert.deepEqual(st.front, {mode: 'static', listen: {ip: '203.0.113.7', port: 443}, certFile: '/etc/c/front.pem', keyFile: '/etc/c/front.key', origin: 'https://challenge-a.example.org'});
  // the service-index draft advertises the derived origin (still an unsigned draft)
  const d = challengeReplicaAdDraft(c, {chainId: 8453, index: '0x' + '9a'.repeat(20), operator: '0x' + '42'.repeat(20), slot: 0, sequence: 1, expiresAt: 1900000000, ttlSec: 86400});
  assert.deepEqual(d.typedData.message.endpoints, [`https://${NAME}/`]);
});

test('the network host refuses a managed front whose endpoint is not this runner\'s', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'nethost-'));
  const cfg = {relay: 'http://127.0.0.1:9', checkers: ['0x' + '22'.repeat(20)], apps: 'all', wgBinary: '/bin/true', nodeBinary: process.execPath, workerModule: '/bin/true'};
  await assert.rejects(createNetworkHost({config: {...cfg, challengeReplica: base()}, runner: '0x' + '11'.repeat(32), directory: dir, authorize: () => true,
    fetch: async () => new Response('{}', {status: 404})}), /front.managed: hostPolicy.endpoint is not this host's registry endpoint/);
  // the right runner passes this check (and is then refused by the release check, before anything binds)
  await assert.rejects(createNetworkHost({config: {...cfg, challengeReplica: base()}, runner: HOST_ID, directory: dir, authorize: () => true,
    fetch: async () => new Response('{}', {status: 404})}), /release: dns.mjs must be a regular file/);
});

test('the declaration contract: refusal reasons, proof matching, bounded validity', () => {
  const key = randomBytes(32).toString('hex'), nonce = randomBytes(32).toString('hex'), now = Date.now();
  assert.ok(proofMatches(key, nonce, frontProof(key, nonce)));
  assert.equal(proofMatches(key, nonce, frontProof(randomBytes(32).toString('hex'), nonce)), false);
  for (const p of [null, '', 'zz', 'a'.repeat(63), 7]) assert.equal(proofMatches(key, nonce, p), false);
  const expect = {hostId: HOST_ID, name: NAME, origin: `https://${NAME}`, frontPort: 18292, release: {dnsSha256: H('a'), runtimeBundleSha256: H('b')}};
  const good = {version: 1, kind: 'enclave-challenge-front', hostId: HOST_ID, role: 'app-zone-replica', name: NAME, origin: `https://${NAME}`, release: expect.release,
    state: 'serving', pid: 1, front: '127.0.0.1:18292', proofKey: key, issuedAt: now, expiresAt: now + DECLARATION_TTL_MS};
  assert.equal(frontDeclarationRefusal(good, expect, now), null);
  assert.match(frontDeclarationRefusal({...good, issuedAt: now + 60_000, expiresAt: now + 61_000}, expect, now), /malformed validity/, 'issued in the future');
  assert.match(frontDeclarationRefusal({...good, state: 'stopped', reason: 'closed'}, expect, now), /stopped \(closed\)/);
  assert.match(frontDeclarationRefusal({...good, front: '[::1]:18292'}, expect, now), /another address/, 'service-tls pipes to 127.0.0.1 only');
  assert.match(frontDeclarationRefusal({...good, proofKey: undefined}, expect, now), /no proof key/);
  assert.match(frontDeclarationRefusal([], expect, now), /not a declaration/);
  assert.match(frontDeclarationRefusal({...good, version: 2}, expect, now), /v1/);
});

test('lifecycle: the front serves only while admitted and the replica is ready; it declares serving (heartbeat), stopped on refusal and close', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'release-'));
  const dns = Buffer.from('export {};\n'), bundle = Buffer.from('export const x = 1;\n');
  fs.writeFileSync(path.join(dir, 'dns.mjs'), dns, {mode: 0o444}); fs.writeFileSync(path.join(dir, 'network-runtime.bundle.mjs'), bundle, {mode: 0o444});
  fs.writeFileSync(path.join(dir, 'dns.mjs.manifest.json'), JSON.stringify({sha256: sha(dns), runtimeBundleSha256: sha(bundle)}), {mode: 0o444});
  const declDir = fs.mkdtempSync(path.join(TMP, 'decl-')), file = path.join(declDir, 'challenge-front.json');
  const frontPort = await freePort(), apiPort = await freePort();   // nothing listens on apiPort: the stand-in has no API
  const cfg = challengeReplicaConfig({...base({listen: `127.0.0.1:${frontPort}`, managed: {zone: ZONE, declarationFile: file}}), listen: {dns: '127.0.0.1:18153', api: `127.0.0.1:${apiPort}`},
    release: {dir, dnsSha256: sha(dns), runtimeBundleSha256: sha(bundle)}});
  // a stand-in replica process (no real child) whose /health states the configured role
  const health = {readOnly: true, appChallenge: {mode: 'attested-lease', judgeMode: 'trusted', ledgerIndex: {complete: true}, shield: {hostExcluded: false, registry: {profileDigest: cfg.shield.profileDigest}}}};
  const children = [];
  const spawn = () => { const c = new EventEmitter(); c.pid = 4000 + children.length; c.kill = () => setImmediate(() => c.emit('exit', 0, 'SIGTERM')); children.push(c); return c; };
  const gate = fakeGate(), logs = [];
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const h = await startChallengeReplica(cfg, {spawn, gate, fetch: async () => new Response(JSON.stringify(health)), log: (m) => logs.push(m), gateIntervalMs: 40, declareEveryMs: 60, readyMs: 5000});
  try {
    let d = read();
    assert.equal(d.state, 'serving'); assert.equal(d.front, `127.0.0.1:${frontPort}`); assert.equal(d.hostId, HOST_ID); assert.equal(d.name, NAME); assert.equal(d.origin, `https://${NAME}`);
    assert.deepEqual(d.release, {dnsSha256: sha(dns), runtimeBundleSha256: sha(bundle)}); assert.match(d.proofKey, /^[0-9a-f]{64}$/); assert.ok(d.expiresAt - d.issuedAt <= DECLARATION_TTL_MS);
    const key1 = d.proofKey;
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o640, 'readable by the service-tls reader, writable by nobody else');
    // the proof: only the holder of the declared key can answer a fresh nonce; Host must be the challenge origin
    const nonce = randomBytes(32).toString('hex');
    const p = await get(frontPort, FRONT_PROOF_PATH, {'x-enclave-front-nonce': nonce});
    assert.equal(p.status, 200); assert.ok(proofMatches(d.proofKey, nonce, p.body.proof));
    assert.equal((await get(frontPort, FRONT_PROOF_PATH, {'x-enclave-front-nonce': 'x'})).status, 400);
    assert.equal((await get(frontPort, FRONT_PROOF_PATH, {'x-enclave-front-nonce': nonce, host: 'evil.example.test'})).status, 421);
    assert.equal((await get(frontPort, '/health', {host: `${NAME}:443`})).status, 502, 'Host with :443 accepted; the stand-in replica API is absent');
    assert.equal((await get(frontPort, '/v1/txt')).status, 404); assert.equal((await get(frontPort, '/v1/app-challenge')).status, 405);
    // heartbeat
    const first = d.expiresAt; await new Promise((r) => setTimeout(r, 200)); d = read(); assert.ok(d.expiresAt > first, 'the heartbeat extends the declaration');
    // the platform host policy refuses this host: stopped declared, the front closed
    gate.refusal = 'banned by the platform';
    for (let i = 0; i < 100 && read().state !== 'stopped'; i++) await new Promise((r) => setTimeout(r, 20));
    d = read(); assert.equal(d.state, 'stopped'); assert.match(d.reason, /banned/); assert.equal(d.proofKey, undefined, 'a stopped declaration carries no key');
    await assert.rejects(get(frontPort, '/health'), 'the front is closed');
    await new Promise((r) => setTimeout(r, 150)); assert.equal(read().state, 'stopped', 'no heartbeat while stopped');
    // admitted again: a new front, a new key
    gate.refusal = null;
    for (let i = 0; i < 100 && read().state !== 'serving'; i++) await new Promise((r) => setTimeout(r, 20));
    const again = read(); assert.equal(again.state, 'serving'); assert.match(again.proofKey, /^[0-9a-f]{64}$/); assert.notEqual(again.proofKey, key1, 'a new key per front start');
  } finally { await h.close(); }
  const last = read(); assert.equal(last.state, 'stopped'); assert.equal(last.reason, 'closed');
  await assert.rejects(get(frontPort, '/health'), 'closed');
  assert.deepEqual(fs.readdirSync(declDir), ['challenge-front.json'], 'no temp files left');
});

test('a declaration that cannot be written is logged and never serves; a crafted public managed front is refused at start', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'release2-'));
  const dns = Buffer.from('export {};\n'), bundle = Buffer.from('export const y = 2;\n');
  fs.writeFileSync(path.join(dir, 'dns.mjs'), dns, {mode: 0o444}); fs.writeFileSync(path.join(dir, 'network-runtime.bundle.mjs'), bundle, {mode: 0o444});
  fs.writeFileSync(path.join(dir, 'dns.mjs.manifest.json'), JSON.stringify({sha256: sha(dns), runtimeBundleSha256: sha(bundle)}), {mode: 0o444});
  const file = path.join(TMP, 'absent-dir', 'challenge-front.json'), frontPort = await freePort();
  const cfg = challengeReplicaConfig({...base({listen: `127.0.0.1:${frontPort}`, managed: {zone: ZONE, declarationFile: file}}), release: {dir, dnsSha256: sha(dns), runtimeBundleSha256: sha(bundle)}});
  const health = {readOnly: true, appChallenge: {mode: 'attested-lease', judgeMode: 'trusted', ledgerIndex: {complete: true}, shield: {hostExcluded: false, registry: {profileDigest: cfg.shield.profileDigest}}}};
  const spawn = () => { const c = new EventEmitter(); c.pid = 5000; c.kill = () => setImmediate(() => c.emit('exit', 0, 'SIGTERM')); return c; };
  const logs = [];
  const h = await startChallengeReplica(cfg, {spawn, gate: fakeGate(), fetch: async () => new Response(JSON.stringify(health)), log: (m) => logs.push(m), declareEveryMs: 1000});
  try {
    assert.ok(logs.some((l) => /declaration serving not written \(ENOENT\); service-tls does not front it/.test(l)), logs.join('\n'));
    assert.equal(fs.existsSync(file), false);
  } finally { await h.close(); }
  await assert.rejects(startReplicaFront({...cfg, front: {...cfg.front, listen: {ip: '0.0.0.0', port: 0}}}), /binds loopback only/);
});
