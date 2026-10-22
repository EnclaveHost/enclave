// The Enclave host challenge service (network/challenge-replica-host.mjs + enclave-network-host.mjs challengeReplica):
// configuration judged before anything binds (no trust defaults, legacy central inputs refused), the exact derived child
// environment, the pinned release, the unsigned service-index draft, and END TO END: the reviewed release built by
// scripts/build-challenge-replica-release.mjs, started by the host package (production judge mode), serving an Enclave
// Shield guest's app-zone push through its HTTPS front after the Windows host's real session keeper attested its
// (synthetic) TPM boot, answering in DNS, refusing invalid evidence and a banned host, and restarting after its process
// dies. SYNTHETIC TPM/VBS/chain/CA (test/challenge-replica-chain.mjs): not hardware, not a public CA, nothing deployed.
// Run inside an unshared network namespace (test/run-certificate-hosted.sh); needs openssl.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import https from 'node:https';
import dgram from 'node:dgram';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {challengeReplicaConfig, challengeReplicaEnv, verifyReplicaRelease, challengeReplicaAdDraft, startChallengeReplica, ROLES, hostPolicyGateEnv} from '../network/challenge-replica-host.mjs';
import {CARRIER_MIRROR} from '../network/policy-carriers.mjs';
import {createNetworkHost} from '../network/enclave-network-host.mjs';
import {appZoneShieldParty} from '../network/app-zone-shield.mjs';
import * as F from './app-zone-fixture.mjs';
import * as S from './app-zone-shield-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = {skip: !S.haveOpenssl && 'openssl absent'};
const H = (c) => c.repeat(64);
const base = () => ({role: 'app-zone-replica', release: {dir: '/opt/enclave-challenge/releases/x', dnsSha256: H('a'), runtimeBundleSha256: H('b')},
  zones: {app: 'app.enclave.host', ip: 'ip.enclave.host'}, ns: {name: 'ns-a.enclave.host', names: ['ns-a.enclave.host', 'ns-b.enclave.host']},
  listen: {dns: '203.0.113.7:53', api: '127.0.0.1:8154'}, front: {listen: '203.0.113.7:443', certFile: '/etc/c/front.pem', keyFile: '/etc/c/front.key', origin: 'https://challenge-a.example.org'},
  routeMap: 'https://directory.example.org/v1/network/routes',
  chain: {rpcs: ['https://rpc-one.example', 'https://rpc-two.example', 'https://rpc-three.example'], pins: {...F.PINS}},
  shield: {policyFile: '/etc/c/shield-app-policy.json', profileFile: '/etc/c/profile.json', profileDigest: 'sha256:' + H('e'), rpcs: ['https://rpc-one.example', 'https://rpc-two.example']},
  hostPolicy: {policy: 'production', endpoint: 'https://host-a.example.org', stateDir: '/var/lib/enclave-challenge/host-policy'}});
// a controllable platform host policy gate (the real one is network/host-service-gate.mjs)
const fakeGate = () => { const g = {refusal: null, async check() {}, serviceRefusal: () => g.refusal, start() {}, stop() {}, status: () => ({fake: true, refusal: g.refusal})}; return g; };

if (process.env.INJECT_FAILURE) test('INJECTED FAILURE (negative control: the suite must exit nonzero)', () => assert.fail('injected'));

test('configuration: explicit trust inputs only; legacy central inputs, lab modes and malformed values are refused before anything binds', () => {
  const cfg = challengeReplicaConfig(base());
  assert.equal(cfg.role, 'app-zone-replica'); assert.deepEqual(cfg.nsNames, ['ns-a.enclave.host', 'ns-b.enclave.host']);
  assert.deepEqual(ROLES, ['app-zone-replica', 'owner-responder']);
  const bad = {
    'legacy relay': [(c) => { c.relay = 'https://api.enclave.host'; }, /legacy central input/],
    'legacy certificate service': [(c) => { c.certsApi = 'https://api.enclave.host'; }, /legacy central input/],
    'fleet secret': [(c) => { c.secret = 'x'; }, /legacy central input/],
    'lab judge mode': [(c) => { c.judgeMode = 'lab-unsigned'; }, /legacy central input/],
    'unknown field': [(c) => { c.extra = 1; }, /unknown field/],
    'no evidence family': [(c) => { delete c.shield; }, /at least one evidence family/],
    'public API bind': [(c) => { c.listen.api = '0.0.0.0:8154'; }, /loopback/],
    'one RPC': [(c) => { c.chain.rpcs = ['https://rpc-one.example']; }, /2 to 8 RPCs/],
    'same RPC host twice': [(c) => { c.chain.rpcs = ['https://rpc-one.example/a', 'https://rpc-one.example/b']; }, /distinct hosts/],
    'http RPC': [(c) => { c.shield.rpcs = ['http://rpc-one.example', 'https://rpc-two.example']; }, /https/],
    'zero pin': [(c) => { c.chain.pins.registry = '0x' + '0'.repeat(40); }, /contract address/],
    'unpinned release': [(c) => { c.release.dnsSha256 = 'latest'; }, /reviewed 64-hex/],
    'relative release dir': [(c) => { c.release.dir = 'releases/x'; }, /absolute/],
    'profile without digest': [(c) => { c.shield.profileDigest = ''; }, /profileDigest/],
    'bad measurement': [(c) => { c.snp = {measurements: ['ab'.repeat(32)]}; }, /96-hex/],
    'ns not listed': [(c) => { c.ns.names = ['ns-b.enclave.host']; }, /including ns.name/],
    'uppercase zone': [(c) => { c.zones.app = 'App.Enclave.host'; }, /lowercase DNS zone/],
    'public http route map': [(c) => { c.routeMap = 'http://directory.example.org/routes'; }, /loopback/],
    'front origin with a path': [(c) => { c.front.origin = 'https://challenge-a.example.org/x'; }, /https origin/],
    'too many peers': [(c) => { c.peers = Array.from({length: 9}, (_, i) => `https://p${i}.example.org`); }, /at most 8/],
    'no host policy': [(c) => { delete c.hostPolicy; }, /hostPolicy must be an object/],
    'implicit host policy': [(c) => { c.hostPolicy = {policy: 'default'}; }, /"production", "off" or an explicit/],
    'host policy without endpoint': [(c) => { delete c.hostPolicy.endpoint; }, /registry endpoint/],
    'host policy without state': [(c) => { delete c.hostPolicy.stateDir; }, /hostPolicy.stateDir/],
    'off with an endpoint': [(c) => { c.hostPolicy = {policy: 'off', endpoint: 'https://host-a.example.org'}; }, /takes no endpoint/],
    'malformed explicit policy': [(c) => { c.hostPolicy.policy = {book: '0x0'}; }, /hostPolicy.policy/],
  };
  for (const [what, [mutate, re]] of Object.entries(bad)) {
    const c = base(); mutate(c);
    assert.throws(() => challengeReplicaConfig(c), re, what);
  }
  // the owner responder: its own zone, no ledger/catalog chain, no route map, no peers
  const owner = {...base(), role: 'owner-responder', zones: {challenge: 'acme.owner.example'}};
  delete owner.routeMap; delete owner.chain;
  assert.equal(challengeReplicaConfig(owner).zones.challenge, 'acme.owner.example');
  assert.throws(() => challengeReplicaConfig({...owner, chain: base().chain}), /belongs to the app-zone-replica role/);
  assert.throws(() => challengeReplicaConfig({...owner, peers: []}), /belong to the app-zone-replica role/);
});

test('the child environment is derived, complete and minimal: trusted judge, no relay/secret/inherited variables', () => {
  const env = challengeReplicaEnv(challengeReplicaConfig({...base(), snp: {measurements: ['44'.repeat(48)]}, peers: ['https://challenge-b.example.org']}),
    {basePath: '/usr/bin', systemRoot: undefined});
  assert.deepEqual(Object.keys(env).sort(), ['APP_CHALLENGE_AUTH', 'APP_CHALLENGE_JUDGE_MODE', 'APP_CHALLENGE_MEASUREMENTS', 'APP_CHALLENGE_PEERS', 'APP_CHALLENGE_PINS',
    'APP_CHALLENGE_RPCS', 'APP_CHALLENGE_SHIELD_POLICY', 'APP_CHALLENGE_SHIELD_PROFILE', 'APP_CHALLENGE_SHIELD_PROFILE_DIGEST', 'APP_CHALLENGE_SHIELD_RPCS', 'APP_ZONE',
    'DNS_API_BIND', 'DNS_API_PORT', 'DNS_BIND', 'DNS_PORT', 'DNS_READ_ONLY', 'IP_ZONE', 'NS_NAME', 'NS_NAMES', 'PATH', 'ROUTE_MAP_URL'].sort());
  assert.equal(env.APP_CHALLENGE_JUDGE_MODE, 'trusted'); assert.equal(env.DNS_READ_ONLY, '1'); assert.equal(env.PATH, '/usr/bin');
  assert.equal(JSON.parse(env.APP_CHALLENGE_PINS).registry, F.PINS.registry);
  const owner = {...base(), role: 'owner-responder', zones: {challenge: 'acme.owner.example'}}; delete owner.routeMap; delete owner.chain;
  const oe = challengeReplicaEnv(challengeReplicaConfig(owner), {basePath: '/usr/bin'});
  assert.equal(oe.DNS_CHALLENGE_AUTH, 'attested'); assert.equal(oe.CHALLENGE_ZONE, 'acme.owner.example'); assert.equal(oe.ATTESTED_JUDGE_MODE, 'trusted');
  for (const k of ['DNS_READ_ONLY', 'APP_ZONE', 'IP_ZONE', 'ROUTE_MAP_URL', 'SECRET', 'DNS_TXT_KEY']) assert.equal(oe[k], undefined, k);
});

test('the release must hold exactly the pinned bytes; the service-index advertisement is only an unsigned draft', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenge-release-'));
  try {
    const sha = (b) => require256(b);
    const dns = Buffer.from('export {};\n'), bundle = Buffer.from('export const x = 1;\n');
    fs.writeFileSync(path.join(dir, 'dns.mjs'), dns, {mode: 0o444}); fs.writeFileSync(path.join(dir, 'network-runtime.bundle.mjs'), bundle, {mode: 0o444});
    fs.writeFileSync(path.join(dir, 'dns.mjs.manifest.json'), JSON.stringify({sha256: sha(dns), runtimeBundleSha256: sha(bundle)}), {mode: 0o444});
    const rel = {dir, dnsSha256: sha(dns), runtimeBundleSha256: sha(bundle)};
    assert.equal(verifyReplicaRelease(rel).dnsSha256, sha(dns));
    assert.throws(() => verifyReplicaRelease({...rel, dnsSha256: H('0')}), /not the pinned/);
    assert.throws(() => verifyReplicaRelease({...rel, runtimeBundleSha256: H('0')}), /not the pinned/);
    fs.chmodSync(path.join(dir, 'dns.mjs'), 0o666);
    assert.throws(() => verifyReplicaRelease(rel), /writable/);
    fs.chmodSync(path.join(dir, 'dns.mjs'), 0o444);
    fs.renameSync(path.join(dir, 'dns.mjs'), path.join(dir, 'real.mjs')); fs.symlinkSync(path.join(dir, 'real.mjs'), path.join(dir, 'dns.mjs'));
    assert.throws(() => verifyReplicaRelease(rel), /regular file/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  const cfg = challengeReplicaConfig(base());
  const d = challengeReplicaAdDraft(cfg, {chainId: 8453, index: '0x' + '9a'.repeat(20), operator: '0x' + '42'.repeat(20), slot: 0, sequence: 1, expiresAt: 1900000000, ttlSec: 30 * 86400});
  assert.equal(d.typedData.message.kind, 4, 'kind dns'); assert.deepEqual(d.typedData.message.endpoints, ['https://challenge-a.example.org/'], 'the index validator\'s normalized origin');
  assert.equal(d.typedData.message.descriptor, '0x' + require256(Buffer.from(d.descriptorJson)));
  assert.match(d.notice, /unsigned draft/);
  assert.throws(() => challengeReplicaAdDraft(challengeReplicaConfig({...base(), front: {...base().front, origin: 'https://127.0.0.1'}}),
    {chainId: 8453, index: '0x' + '9a'.repeat(20), operator: '0x' + '42'.repeat(20), slot: 0, sequence: 1, expiresAt: 1900000000, ttlSec: 86400}), /non-public/);
});
function require256(b) { return createHash('sha256').update(b).digest('hex'); }

test('a replica that cannot be spawned is retried with backoff, then refused as not ready; nothing is left running', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenge-spawnfail-'));
  try {
    const dns = Buffer.from('export {};\n'), bundle = Buffer.from('export const x = 1;\n');
    fs.writeFileSync(path.join(dir, 'dns.mjs'), dns, {mode: 0o444}); fs.writeFileSync(path.join(dir, 'network-runtime.bundle.mjs'), bundle, {mode: 0o444});
    fs.writeFileSync(path.join(dir, 'dns.mjs.manifest.json'), JSON.stringify({sha256: require256(dns), runtimeBundleSha256: require256(bundle)}), {mode: 0o444});
    const cfg = challengeReplicaConfig({...base(), release: {dir, dnsSha256: require256(dns), runtimeBundleSha256: require256(bundle)}});
    const {EventEmitter} = await import('node:events');
    let spawns = 0;
    const spawn = () => { spawns++; const c = new EventEmitter(); c.pid = undefined; c.kill = () => {}; setImmediate(() => c.emit('error', Object.assign(new Error('spawn ENOENT'), {code: 'ENOENT'}))); return c; };
    const logs = [];
    await assert.rejects(startChallengeReplica(cfg, {spawn, gate: fakeGate(), fetch: async () => { throw new Error('ECONNREFUSED'); }, log: (m) => logs.push(m), readyMs: 30_000}),
      /did not become ready \(spawn error ENOENT\)/);
    assert.ok(spawns >= 3, `retried (${spawns} spawns)`); assert.ok(logs.some((l) => /restart in/.test(l)));
    const after = spawns; await new Promise((r) => setTimeout(r, 2500));
    assert.equal(spawns, after, 'no restart after the refusal');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('the REAL platform host policy gate: a fresh host without an authenticated admit starts nothing (production policy, no network)', {timeout: 120_000}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenge-gate-'));
  try {
    const dns = Buffer.from('export {};\n'), bundle = Buffer.from('export const x = 1;\n');
    fs.writeFileSync(path.join(dir, 'dns.mjs'), dns, {mode: 0o444}); fs.writeFileSync(path.join(dir, 'network-runtime.bundle.mjs'), bundle, {mode: 0o444});
    fs.writeFileSync(path.join(dir, 'dns.mjs.manifest.json'), JSON.stringify({sha256: require256(dns), runtimeBundleSha256: require256(bundle)}), {mode: 0o444});
    fs.mkdirSync(path.join(dir, 'policy'));
    const cfg = challengeReplicaConfig({...base(), release: {dir, dnsSha256: require256(dns), runtimeBundleSha256: require256(bundle)},
      hostPolicy: {policy: 'production', endpoint: 'https://host-a.example.org', stateDir: path.join(dir, 'policy')}});
    let spawns = 0;
    await assert.rejects(startChallengeReplica(cfg, {spawn: () => { spawns++; throw new Error('must not spawn'); }, fetch: async () => { throw new Error('offline'); }}),
      /not started: platform host policy/);
    assert.equal(spawns, 0, 'nothing ran before an authenticated admit');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('host policy carriers (first host without the fleet): the integrated carriers, explicit only; the gate is shown the reserved carrier origin', () => {
  const book = '0xab214342d5a490150a4a977063a2f88e21f80907', own = '0x' + 'bb'.repeat(20);
  const withCarriers = (hp) => challengeReplicaConfig({...base(), hostPolicy: {policy: 'production', endpoint: 'https://host-a.example.org', stateDir: '/var/lib/c/host-policy', ...hp}});
  const c = withCarriers({carriers: {importDir: '/var/lib/c/policy-import', policyMirrorStateDir: '/var/lib/enclave-host-services/policy-mirror'}, mirrors: ['https://mirror.example.org/platform-policy']});
  const {env, shape} = hostPolicyGateEnv(c.hostPolicy);
  assert.equal(env.ENCLAVE_PLATFORM_HOST_POLICY, 'production');
  assert.deepEqual(env.ENCLAVE_PLATFORM_HOST_POLICY_MIRRORS.split(','), ['https://mirror.example.org/platform-policy', CARRIER_MIRROR]);
  assert.deepEqual(shape.platformHostPolicyCarriers, {importDir: '/var/lib/c/policy-import'});
  assert.deepEqual(shape.services, [{role: 'policy-mirror', config: {stateDir: '/var/lib/enclave-host-services/policy-mirror'}}]);
  const explicit = withCarriers({policy: {book, hostOwnership: own, mirrors: []}, carriers: {importDir: '/var/lib/c/policy-import'}, rpcs: ['https://rpc-one.example', 'https://rpc-two.example']});
  const e2 = hostPolicyGateEnv(explicit.hostPolicy).env;
  assert.equal(JSON.parse(e2.ENCLAVE_PLATFORM_HOST_POLICY).book, book); assert.equal(e2.ENCLAVE_PLATFORM_HOST_POLICY_RPCS, 'https://rpc-one.example/,https://rpc-two.example/');
  assert.equal(hostPolicyGateEnv(withCarriers({}).hostPolicy).env.ENCLAVE_PLATFORM_HOST_POLICY_MIRRORS, undefined, 'no carriers: the gate is unchanged');
  for (const [hp, re] of [[{carriers: {}}, /names no carrier/], [{carriers: {importDir: 'relative'}}, /absolute/], [{carriers: {secret: '/x'}}, /unknown field/],
    [{mirrors: ['http://mirror.example.org/p']}, /https/], [{rpcs: ['https://one.example']}, /2 to 8 RPCs/]]) assert.throws(() => withCarriers(hp), re);
  assert.throws(() => challengeReplicaConfig({...base(), hostPolicy: {policy: 'off', carriers: {importDir: '/x'}}}), /takes no endpoint, stateDir, mirrors, rpcs or carriers/);
});

test('the REAL gate with carriers, fresh offline host: still nothing starts, and the carrier origin is answered locally (never fetched)', {timeout: 120_000}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenge-carriers-'));
  try {
    const dns = Buffer.from('export {};\n'), bundle = Buffer.from('export const x = 1;\n');
    fs.writeFileSync(path.join(dir, 'dns.mjs'), dns, {mode: 0o444}); fs.writeFileSync(path.join(dir, 'network-runtime.bundle.mjs'), bundle, {mode: 0o444});
    fs.writeFileSync(path.join(dir, 'dns.mjs.manifest.json'), JSON.stringify({sha256: require256(dns), runtimeBundleSha256: require256(bundle)}), {mode: 0o444});
    for (const d of ['policy', 'import', 'mirror-store/documents']) fs.mkdirSync(path.join(dir, d), {recursive: true});
    const cfg = challengeReplicaConfig({...base(), release: {dir, dnsSha256: require256(dns), runtimeBundleSha256: require256(bundle)},
      hostPolicy: {policy: 'production', endpoint: 'https://host-a.example.org', stateDir: path.join(dir, 'policy'),
        carriers: {importDir: path.join(dir, 'import'), policyMirrorStateDir: path.join(dir, 'mirror-store')}}});
    const asked = []; let spawns = 0;
    await assert.rejects(startChallengeReplica(cfg, {spawn: () => { spawns++; throw new Error('must not spawn'); },
      fetch: async (u) => { asked.push(String(u?.url ?? u)); throw new Error('offline'); }}), /not started: platform host policy/);
    assert.equal(spawns, 0);
    assert.ok(!asked.some((u) => u.includes('policy-carriers.invalid')), 'the reserved carrier origin reached the network: ' + asked.join(' '));
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('the network host judges challengeReplica before anything binds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenge-nethost-'));
  try {
    const cfg = {relay: 'http://127.0.0.1:9', checkers: ['0x' + '22'.repeat(20)], apps: 'all', wgBinary: '/bin/true', nodeBinary: process.execPath, workerModule: '/bin/true'};
    await assert.rejects(createNetworkHost({config: {...cfg, challengeReplica: {...base(), certsApi: 'https://api.enclave.host'}}, directory: dir, authorize: () => true,
      fetch: async () => new Response('{}', {status: 404})}), /challengeReplica: legacy central input/);
    // a START failure (here: the release directory is gone, as after a full reinstall of Program Files) is logged and never
    // takes the host's network down (work/g4-config-independent-review-20261021 C3)
    const logs = [];
    const h2 = await createNetworkHost({config: {...cfg, challengeReplica: {...base(), release: {...base().release, dir: path.join(dir, 'missing')}}}, directory: dir,
      authorize: () => true, fetch: async () => new Response('{}', {status: 404}), log: (m) => logs.push(m)});
    for (let i = 0; i < 100 && !logs.some((l) => l.includes('challenge replica not started')); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(logs.some((l) => /challenge replica not started .*release: dns\.mjs must be a regular file/.test(l)), logs.join('\n'));
    assert.equal(h2.challengeReplica, null, 'nothing started'); await h2.close();
    const host = await createNetworkHost({config: cfg, directory: dir, authorize: () => true, fetch: async () => new Response('{}', {status: 404})});
    assert.equal(host.challengeReplica, null, 'absent: nothing started'); await host.close();
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

// ---- end to end ---------------------------------------------------------------------------------------------------------
const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
async function udpFreePort() { for (;;) { const p = await freePort(); const u = dgram.createSocket('udp4'); const ok = await new Promise((r) => { u.once('error', () => r(false)); u.bind(p, '127.0.0.1', () => r(true)); }); u.close(); if (ok) return p; } }
async function ask(port, name) {
  const h = Buffer.alloc(12); h.writeUInt16BE(0x4242, 0); h.writeUInt16BE(1, 4);
  const q = Buffer.concat([h, ...name.split('.').map((v) => Buffer.concat([Buffer.from([v.length]), Buffer.from(v)])), Buffer.from([0, 0, 16, 0, 1])]);
  const s = dgram.createSocket('udp4');
  try {
    const got = once(s, 'message');
    s.send(q, port, '127.0.0.1');
    const [m] = await Promise.race([got, new Promise((_, no) => setTimeout(() => no(new Error('UDP timeout')), 2000))]);
    return m;
  } finally { s.close(); }
}
function frontPost(chain, port, p, method = 'POST', {route = '/v1/app-challenge', headers = {}} = {}) {
  return new Promise((ok, no) => {
    const r = https.request({host: '127.0.0.1', port, path: route, method, ca: fs.readFileSync(chain.caFile), servername: undefined,
      headers: {'content-type': 'application/json', ...(p ? {'x-attested-sig': p.sig} : {}), ...headers}}, (res) => {
      const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => { let b = null; try { b = JSON.parse(Buffer.concat(c).toString()); } catch {} ok({status: res.statusCode, body: b}); });
    });
    r.on('error', no); r.end(p ? p.body : undefined);
  });
}

test('end to end: the built release, started by the host package, serves a Shield guest push through its HTTPS front; refusals; restart', {...options, timeout: 180_000}, async (t) => {
  const {startShieldChain} = await import('./challenge-replica-chain.mjs');
  const chain = await startShieldChain();
  t.after(() => chain.close());
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'challenge-release-built-'));
  t.after(() => fs.rmSync(out, {recursive: true, force: true}));
  const built = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-challenge-replica-release.mjs'), out], {encoding: 'utf8'}).trim().split('\n').at(-1));
  // a second build gives the same bytes (and --expect-sha256 refuses anything else)
  const out2 = fs.mkdtempSync(path.join(os.tmpdir(), 'challenge-release-built2-'));
  t.after(() => fs.rmSync(out2, {recursive: true, force: true}));
  assert.equal(JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-challenge-replica-release.mjs'), out2, '--expect-sha256', built.dnsSha256], {encoding: 'utf8'}).trim()).dnsSha256, built.dnsSha256);
  const stages = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('challenge-replica-release-')).length;
  const before = stages();
  assert.throws(() => execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-challenge-replica-release.mjs'), path.join(out2, 'x'), '--expect-sha256', H('0')], {stdio: 'pipe'}));
  assert.equal(stages(), before, 'a refused build leaves no staging directory');
  assert.equal(fs.existsSync(path.join(out2, 'x')), false, 'nothing written for an unexpected artifact');

  const replica = async (name) => {
    const dns = await udpFreePort(), api = await freePort(), front = await freePort();
    const cfg = challengeReplicaConfig({role: 'app-zone-replica', release: {dir: out, dnsSha256: built.dnsSha256, runtimeBundleSha256: built.runtimeBundleSha256},
      zones: {app: F.ZONE, ip: 'ip.enclave.host'}, ns: {name: `ns-${name}.enclave.host`}, listen: {dns: `127.0.0.1:${dns}`, api: `127.0.0.1:${api}`},
      front: {listen: `127.0.0.1:${front}`, certFile: chain.front.certFile, keyFile: chain.front.keyFile, origin: `https://challenge-${name}.example.org`},
      hostPolicy: {policy: 'production', endpoint: 'https://host-' + name + '.example.org', stateDir: path.join(out, 'policy-' + name)},
      routeMap: chain.routeMapUrl, chain: {rpcs: chain.rpcUrls, pins: chain.pins},
      shield: {policyFile: chain.policyFile, profileFile: chain.profileFile, profileDigest: chain.digest, rpcs: chain.rpcUrls}});
    const logs = [];
    const gate = fakeGate();
    const h = await startChallengeReplica(cfg, {extraCaFile: chain.caFile, log: (m) => logs.push(m), readyMs: 90_000, gate, gateIntervalMs: 250});
    t.after(() => h.close());
    return {h, cfg, dns, api, front: h.frontPort, logs, gate};
  };
  const A = await replica('a'), B = await replica('b');
  assert.equal(A.h.env.APP_CHALLENGE_JUDGE_MODE, 'trusted', 'production judge mode');
  // the Windows host attests at both, through the replica's app-zone party
  const keeper = chain.keeper(chain.world, S.ENDPOINT, {'challenge-a.example.org': `http://127.0.0.1:${A.api}`, 'challenge-b.example.org': `http://127.0.0.1:${B.api}`});
  const targets = ['a', 'b'].map((n) => ({url: `https://challenge-${n}.example.org`, party: appZoneShieldParty(F.ZONE), path: '/v1/app-zone/shield-session'}));
  const s = await keeper.refresh(targets);
  assert.deepEqual(s.failed, []); assert.equal(s.done.length, 2);
  // a Shield guest's push, over HTTPS through each host's front; answered in DNS
  const push = (o = {}) => S.shieldPush(F.guestKey(), {signer: chain.world.idks.privateKey, ...o});
  for (const R of [A, B]) {
    const p = push(), r = await frontPost(chain, R.front, p);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const m = await ask(R.dns, p.name);
    assert.equal(m.readUInt16BE(6), 1); assert.ok(m.includes(Buffer.from(p.value)));
  }
  // refusals through the front: another TPM's report, launcher-only evidence, wrong zone, a banned host; nothing answered
  for (const [what, p, re] of [['other IDKS', push({signer: chain.other.idks.privateKey}), /Shield attestation refused/],
    ['launcher-only', push({doc: {launcherOnly: true}}), /VBS report missing/], ['wrong zone', push({name: '_acme-challenge.7ae476a3.example.org'}), /not this deployment/]]) {
    const r = await frontPost(chain, A.front, p); assert.equal(r.status, 403, what); assert.match(r.body.message, re, what);
  }
  chain.state.hosts[S.HOST_ID].active = false;
  for (const R of [A, B]) { const p = push(), r = await frontPost(chain, R.front, p); assert.equal(r.status, 403); assert.match(r.body.message, /not an active registry host/);
    assert.ok(!(await ask(R.dns, p.name)).includes(Buffer.from(p.value)), 'the refused value is not answered (earlier accepted values may still be live)'); }
  chain.restore();
  // the front carries only the role's routes, bounded, without credentials
  assert.equal((await frontPost(chain, A.front, null, 'GET')).status, 405);
  assert.equal((await frontPost(chain, A.front, null, 'POST', {route: '/v1/txt'})).status, 404, 'another role\'s route');
  assert.equal((await frontPost(chain, A.front, push(), 'POST', {headers: {authorization: 'Bearer x'}})).status, 400);
  assert.equal((await frontPost(chain, A.front, {body: Buffer.alloc(40000, 0x20), sig: 'x'}, 'POST')).status, 413);
  const sess = await frontPost(chain, A.front, {body: Buffer.from('{}'), sig: ''}, 'POST', {route: '/v1/app-zone/shield-session/challenge'});
  assert.ok(sess.status >= 400 && sess.status < 500 && sess.body, 'the session route reaches the replica');
  // the platform bans host B (its own host policy gate refuses service): B's front and DNS stop; A keeps serving
  B.gate.refusal = 'platform host policy: banned by the platform administrator';
  let down = false;
  for (let i = 0; i < 60 && !down; i++) { await new Promise((r) => setTimeout(r, 250)); down = B.h.status().serving === false; }
  assert.ok(down, 'B stopped on its host policy refusal'); assert.match(B.h.status().stoppedFor, /banned/);
  await assert.rejects(frontPost(chain, B.front, push()), 'B\'s front is closed');
  await assert.rejects(ask(B.dns, '_acme-challenge.7ae476a3.' + F.ZONE), 'B answers no DNS');
  assert.equal((await frontPost(chain, A.front, push())).status, 200, 'A unaffected');
  B.gate.refusal = null;   // the admin's admit
  let up = false;
  for (let i = 0; i < 240 && !up; i++) { await new Promise((r) => setTimeout(r, 250)); up = B.h.status().serving === true; }
  assert.ok(up, 'B serves again after the admit: ' + B.logs.slice(-3).join(' | '));
  const kb = chain.keeper(chain.world, S.ENDPOINT, {'challenge-b.example.org': `http://127.0.0.1:${B.api}`});
  assert.deepEqual((await kb.refresh([targets[1]])).failed, []);
  assert.equal((await frontPost(chain, B.front, push())).status, 200);
  // the replica process dies: the host package restarts it; a fresh host session makes pushes verify again
  const pid = A.h.pid(); process.kill(pid, 'SIGKILL');
  let back = false;
  for (let i = 0; i < 120 && !back; i++) { await new Promise((r) => setTimeout(r, 250)); back = A.h.pid() !== null && A.h.pid() !== pid && (await A.h.health().catch(() => ({ok: false}))).ok; }
  assert.ok(back, 'restarted and healthy: ' + A.logs.slice(-3).join(' | '));
  const lost = await frontPost(chain, A.front, push()); assert.equal(lost.status, 403, 'host sessions live in replica memory: a restart needs a new one');
  const k2 = chain.keeper(chain.world, S.ENDPOINT, {'challenge-a.example.org': `http://127.0.0.1:${A.api}`});
  assert.deepEqual((await k2.refresh([targets[0]])).failed, []);
  assert.equal((await frontPost(chain, A.front, push())).status, 200);
});
