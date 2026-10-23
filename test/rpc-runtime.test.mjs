// network/rpc-runtime.mjs without any chain: strict config validation (pins, loopback, untrusted sources, no secrets,
// optional history-only cache), refusals at startup that must leave nothing behind (missing or wrong binary, a held
// stateDir), and the head fan-out order (root store first, relay second). Offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateRuntimeConfig, startRpcRuntime, createHeadFanout, PINNED_BUILDS, CONFIG_FORMAT, LABELS } from '../network/rpc-runtime.mjs';
import { procIdentity } from '../network/gossip-head-source.mjs';

const TMP = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'rpc-runtime-unit-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const first = (role) => Object.keys(PINNED_BUILDS[role])[0];
const SIGNER = '0xaf6e19be0f9ce7f8afd49a1824851023a8249e8a';
const base = (over = {}) => ({
  format: CONFIG_FORMAT, chain: { chainId: 8453, unsafeSigner: SIGNER },
  binaries: { listener: { path: '/opt/enclave/bin/enclave-base-head-listener', sha256: first('listener') },
    helios: { path: '/opt/enclave/bin/helios', sha256: first('helios') }, witnessCheck: { path: '/opt/enclave/bin/witness-check', sha256: first('witnessCheck') } },
  proofSources: { untrusted: ['https://base-a.example/', 'https://base-b.example/'] }, verifier: { port: 8545 }, stateDir: '/var/lib/enclave/rpc-runtime', ...over });
const bad = (over, re) => assert.throws(() => validateRuntimeConfig(base(over)), re);

test('a valid config normalizes with explicit defaults: loopback bind, no access-list hint, bounded gossip, no cache', () => {
  const c = validateRuntimeConfig(base());
  assert.equal(c.verifier.bind, '127.0.0.1');
  assert.equal(c.proofSources.accessListHint, false);
  assert.deepEqual({ ...c.gossip }, { maxPeers: 20, discovery: 'bounded', sessionSecs: 3600, restartIfNoHeadMs: 120000 });
  assert.equal(c.witnessCache, null);
  assert.equal(c.chain.unsafeSigner, SIGNER);
  assert.match(c.binaries.helios.build, /enclave-base-evm/);
  assert.match(LABELS.independence, /NOT provider-independent/);
  assert.match(LABELS.head, /UNSAFE/);
});

test('pins: chain, signer, format and only tested binary builds', () => {
  bad({ format: 'enclave-rpc-runtime/v0' }, /format/);
  bad({ chain: { chainId: 84532, unsafeSigner: SIGNER } }, /chainId must be 8453/);
  bad({ chain: { chainId: 8453, unsafeSigner: '0x' + '0'.repeat(40) } }, /unsafeSigner/);
  bad({ chain: { chainId: 8453 } }, /unsafeSigner is required/);
  const b = base().binaries;
  bad({ binaries: { ...b, helios: { ...b.helios, sha256: 'ab'.repeat(32) } } }, /not a tested build/);
  bad({ binaries: { ...b, helios: { ...b.helios, sha256: b.listener.sha256 } } }, /not a tested build/);   // a listener digest is not a Helios build
  bad({ binaries: { listener: b.listener, helios: b.helios } }, /witnessCheck is required/);
  bad({ binaries: { ...b, witnessCheck: { ...b.witnessCheck, path: 'bin/witness-check' } } }, /absolute path/);
  // a caller (never the file) may widen the table, e.g. for a test stand-in
  const extra = { ...PINNED_BUILDS, helios: { ...PINNED_BUILDS.helios, ['ab'.repeat(32)]: 'test' } };
  assert.equal(validateRuntimeConfig(base({ binaries: { ...b, helios: { ...b.helios, sha256: 'ab'.repeat(32) } } }), { acceptedBuilds: extra }).binaries.helios.build, 'test');
});

test('untrusted proof sources: explicit, bounded, distinct, no credentials, never plain http off-host, never the verifier itself', () => {
  bad({ proofSources: { untrusted: [] } }, /1 to 16/);
  bad({ proofSources: {} }, /untrusted is required/);
  bad({ proofSources: { untrusted: Array.from({ length: 17 }, (_, i) => `https://s${i}.example/`) } }, /1 to 16/);
  bad({ proofSources: { untrusted: ['http://base.example/'] } }, /untrusted\[0\]/);
  bad({ proofSources: { untrusted: ['https://user:pw@base.example/'] } }, /untrusted\[0\]/);
  bad({ proofSources: { untrusted: ['https://base.example/?apikey=1'] } }, /query string/);
  bad({ proofSources: { untrusted: ['https://a.example/', 'https://a.example/'] } }, /repeats/);
  bad({ proofSources: { untrusted: ['http://127.0.0.1:8545/'] } }, /verifier's own port/);
  bad({ proofSources: { untrusted: ['https://a.example/'], accessListHint: 'yes' } }, /boolean/);
  assert.equal(validateRuntimeConfig(base({ proofSources: { untrusted: ['http://127.0.0.1:9545/'] } })).proofSources.untrusted[0], 'http://127.0.0.1:9545/', 'a local proof source is allowed (still untrusted)');
});

test('no secrets, no unknown fields, no public bind, bounded limits', () => {
  bad({ apiKey: 'x' }, /unknown field "apiKey" \(this config holds no secret\)/);
  bad({ proofSources: { untrusted: ['https://a.example/'], authToken: 'x' } }, /holds no secret/);
  bad({ verifier: { port: 8545, bind: '0.0.0.0' } }, /unknown field "bind"/);
  bad({ verifier: { port: 0 } }, /verifier.port/);
  bad({ gossip: { maxPeers: 51 } }, /maxPeers/);
  bad({ gossip: { discovery: 'crawl' } }, /discovery/);
  bad({ limits: { firstHeadTimeoutMs: 1 } }, /firstHeadTimeoutMs/);
  bad({ stateDir: 'state' }, /stateDir must be an absolute path/);
});

test('the witness cache is optional, local, outside stateDir; other caches are not part of this composition', () => {
  assert.deepEqual({ ...validateRuntimeConfig(base({ witnessCache: { kind: 'dir', path: '/var/cache/enclave/witness' } })).witnessCache }, { kind: 'dir', path: '/var/cache/enclave/witness' });
  assert.equal(validateRuntimeConfig(base({ witnessCache: null })).witnessCache, null, 'explicit rollback: null = no cache');
  bad({ witnessCache: { kind: 's3', path: '/x' } }, /must be "dir"/);
  bad({ witnessCache: { kind: 'dir', path: '/var/lib/enclave/rpc-runtime/cache' } }, /outside stateDir/);
});

function stateFiles(dir) { return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f !== 'runs' && f !== 'gossip') : []; }
test('startup refusals leave nothing behind: a missing binary, a binary that is not the pinned build, a held stateDir', async () => {
  const stateDir = path.join(TMP, 's1');
  await assert.rejects(startRpcRuntime(base({ stateDir })), /binaries\.listener: .* cannot be read/);
  assert.deepEqual(stateFiles(stateDir), [], 'no lock or state file');
  assert.deepEqual(fs.readdirSync(path.join(stateDir, 'runs')), [], 'no run directory');

  const fake = path.join(TMP, 'not-the-listener'); fs.writeFileSync(fake, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const pin = 'cd'.repeat(32);
  const accepted = { ...PINNED_BUILDS, listener: { [pin]: 'pretend pin' } };
  const b = base().binaries;
  await assert.rejects(startRpcRuntime(base({ stateDir, binaries: { ...b, listener: { path: fake, sha256: pin } } }), { acceptedBuilds: accepted }),
    new RegExp(`has sha256 ${createHash('sha256').update(fs.readFileSync(fake)).digest('hex')}, not the pinned ${pin}`));
  assert.deepEqual(stateFiles(stateDir), []);
  assert.deepEqual(fs.readdirSync(path.join(stateDir, 'runs')), []);

  const me = procIdentity(process.pid);
  fs.writeFileSync(path.join(stateDir, 'runtime.lock'), JSON.stringify({ pid: process.pid, startTime: me.startTime }) + '\n');
  await assert.rejects(startRpcRuntime(base({ stateDir })), /in use by a running runtime/);
  assert.ok(fs.existsSync(path.join(stateDir, 'runtime.lock')), 'a live owner\'s lock is never removed');
  fs.writeFileSync(path.join(stateDir, 'runtime.lock'), JSON.stringify({ pid: process.pid, startTime: '1' }) + '\n');   // recycled pid
  await assert.rejects(startRpcRuntime(base({ stateDir })), /cannot be read/, 'a stale lock is taken over (then the missing binary refuses)');
  assert.deepEqual(stateFiles(stateDir), []);
  await assert.rejects(startRpcRuntime(base({ stateDir }), { signal: AbortSignal.abort() }), /stopped before start/);
});

test('head fan-out: the root store binds first, then the relay; a refused root drops the head; relay refusals are counted', async () => {
  const order = [];
  let bind = true, accept = { accepted: true };
  const roots = { offer: async () => { order.push('roots'); return bind ? { blockHash: '0x' } : null; } };
  const relay = { offer: async () => { order.push('relay'); return accept; } };
  let firstHead = 0;
  const f = createHeadFanout({ roots, relay, onFirstHead: () => { firstHead++; } });
  await f.onCommitment({}, { number: 1 });
  assert.deepEqual(order, ['roots', 'relay']);
  assert.equal(firstHead, 1);
  bind = false;
  await assert.rejects(f.onCommitment({}, { number: 2 }), /root store refused/);
  assert.deepEqual(order, ['roots', 'relay', 'roots'], 'the relay never sees a head whose root was not bound');
  bind = true; accept = { accepted: false, reason: 'stale or future block' };
  await f.onCommitment({}, { number: 3 });
  assert.equal(f.counters.relayRefused['stale or future block'], 1);
  await f.onCommitment({}, { number: 4 });
  assert.equal(firstHead, 1, 'the first-head signal fires once');
  assert.deepEqual({ offered: f.counters.offered, rootsBound: f.counters.rootsBound, rootsRefused: f.counters.rootsRefused, relayAccepted: f.counters.relayAccepted }, { offered: 4, rootsBound: 3, rootsRefused: 1, relayAccepted: 1 });
});
