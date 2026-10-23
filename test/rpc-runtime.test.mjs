// network/rpc-runtime.mjs without any chain: strict config validation (pins, loopback, untrusted sources, no secrets, no
// unbudgeted local cache, an optional untrusted S3 archive, reviewed host tools), refusals at startup that must leave
// nothing behind (missing or wrong binary, a held, legacy or non-private stateDir, an unsafe archive access file; the
// kernel lock file persists and is released), and the head fan-out order (root store first, relay second). Offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateRuntimeConfig, startRpcRuntime, createHeadFanout, PINNED_BUILDS, CONFIG_FORMAT, LABELS } from '../network/rpc-runtime.mjs';
import { takeRuntimeLock } from '../network/runtime-lock.mjs';

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

test('a valid config normalizes with explicit defaults: loopback bind, no access-list hint, bounded gossip, no cache, no archive', () => {
  const c = validateRuntimeConfig(base());
  assert.equal(c.format, 'enclave-rpc-runtime/v2');
  assert.equal(c.witnessArchive, null);
  assert.deepEqual({ ...c.hostTools }, { flock: '/usr/bin/flock', curl: '/usr/bin/curl' });
  assert.match(c.binaries.witnessCheck.build, /ef320298/);
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
  bad({ format: 'enclave-rpc-runtime/v1' }, /v1 had an unbudgeted local cache/);
  const b0 = base().binaries;
  for (const old of ['fab2f1cea2f69a8b2e676f8ffb51d0014408f99b5f92397566772e96e1c1ae93', 'a33770482356c92861b77c3630e840761208c6c183aa5a67db795a44e8f85acf'])
    bad({ binaries: { ...b0, witnessCheck: { ...b0.witnessCheck, sha256: old } } }, /not a tested build/);   // the aca81764 helpers: no `block` op
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

test('no unbudgeted local cache; the S3/Sia archive is optional, untrusted, credential-free in config; host tools are reviewed absolute paths', () => {
  assert.equal(validateRuntimeConfig(base({ witnessCache: null })).witnessCache, null, 'explicit: null = no local cache');
  bad({ witnessCache: { kind: 'dir', path: '/var/cache/enclave/witness' } }, /central NVMe cache budget/);
  bad({ witnessCache: { kind: 'dir', path: '/x', maxBytes: 1 << 30 } }, /central NVMe cache budget/);
  const arc = { kind: 's3', endpoint: 'https://s3.example.net', bucket: 'enclave-witness', accessFile: '/etc/enclave/rpc-runtime/s3-access.json' };
  const c = validateRuntimeConfig(base({ witnessArchive: arc }));
  assert.deepEqual({ ...c.witnessArchive }, { kind: 's3', endpoint: 'https://s3.example.net', bucket: 'enclave-witness', region: 'us-east-1', prefix: 'enclave-witness',
    accessFile: '/etc/enclave/rpc-runtime/s3-access.json', writes: false }, 'archive writes are off unless asked (they reveal which state this node read)');
  assert.equal(validateRuntimeConfig(base({ witnessArchive: null })).witnessArchive, null, 'rollback: null = no archive');
  bad({ witnessArchive: { ...arc, kind: 'dir' } }, /must be "s3"/);
  bad({ witnessArchive: { ...arc, endpoint: 'http://s3.example.net' } }, /witnessArchive.endpoint/);
  bad({ witnessArchive: { ...arc, endpoint: 'https://s3.example.net/bucket?x=1' } }, /bare https origin/);
  bad({ witnessArchive: { ...arc, bucket: 'Bad_Bucket' } }, /bucket/);
  bad({ witnessArchive: { ...arc, writes: 'yes' } }, /boolean/);
  bad({ witnessArchive: { ...arc, accessFile: 'access.json' } }, /absolute path/);
  bad({ witnessArchive: { ...arc, secretAccessKey: 'x' } }, /holds no secret/);
  bad({ hostTools: { flock: 'flock' } }, /absolute path/);
  bad({ hostTools: { lockTool: '/usr/bin/flock' } }, /unknown field/);
});

// the lock file persists by design (never unlinked); it must be empty and free again after a refusal
function stateFiles(dir) { return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => !['runs', 'gossip', 'runtime.lock'].includes(f)) : []; }
async function lockFree(dir) {
  const lock = path.join(dir, 'runtime.lock');
  assert.equal(fs.statSync(lock).size, 0, 'the lock file stays, empty');
  const release = await takeRuntimeLock(lock); release();
}
test('startup refusals leave nothing behind: a missing binary, a binary that is not the pinned build, a held, legacy or shared stateDir', async () => {
  const stateDir = path.join(TMP, 's1');
  await assert.rejects(startRpcRuntime(base({ stateDir })), /binaries\.listener: .* cannot be read/);
  assert.deepEqual(stateFiles(stateDir), [], 'no state file');
  assert.deepEqual(fs.readdirSync(path.join(stateDir, 'runs')), [], 'no run directory');
  await lockFree(stateDir);

  const fake = path.join(TMP, 'not-the-listener'); fs.writeFileSync(fake, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const pin = 'cd'.repeat(32);
  const accepted = { ...PINNED_BUILDS, listener: { [pin]: 'pretend pin' } };
  const b = base().binaries;
  await assert.rejects(startRpcRuntime(base({ stateDir, binaries: { ...b, listener: { path: fake, sha256: pin } } }), { acceptedBuilds: accepted }),
    new RegExp(`has sha256 ${createHash('sha256').update(fs.readFileSync(fake)).digest('hex')}, not the pinned ${pin}`));
  assert.deepEqual(stateFiles(stateDir), []);
  assert.deepEqual(fs.readdirSync(path.join(stateDir, 'runs')), []);
  await lockFree(stateDir);

  // a live owner (here: this process, through the same kernel lock) refuses a second runtime; the file is untouched
  const held = await takeRuntimeLock(path.join(stateDir, 'runtime.lock'));
  try { await assert.rejects(startRpcRuntime(base({ stateDir })), /in use by a running runtime/); } finally { held(); }
  // a nonempty legacy (PID-file) lock is refused and never removed or rewritten, even if its pid is dead
  const legacy = path.join(TMP, 's-legacy'); fs.mkdirSync(legacy, { mode: 0o700 });
  fs.writeFileSync(path.join(legacy, 'runtime.lock'), JSON.stringify({ pid: process.pid, startTime: '1' }) + '\n', { mode: 0o600 });
  await assert.rejects(startRpcRuntime(base({ stateDir: legacy })), /legacy runtime lock/);
  assert.match(fs.readFileSync(path.join(legacy, 'runtime.lock'), 'utf8'), /"startTime":"1"/);
  // a stateDir others can read or write is refused before any lock or file
  const open = path.join(TMP, 's-open'); fs.mkdirSync(open, { mode: 0o755 }); fs.chmodSync(open, 0o755);
  await assert.rejects(startRpcRuntime(base({ stateDir: open })), /private \(0700\)/);
  assert.deepEqual(fs.readdirSync(open), []);
  // an archive access file that others can read is refused right after the lock, before any binary is staged
  const acc = path.join(TMP, 'access.json'); fs.writeFileSync(acc, JSON.stringify({ accessKeyId: 'abcdefgh', secretAccessKey: 'abcdefghijkl' }), { mode: 0o644 }); fs.chmodSync(acc, 0o644);
  const s2 = path.join(TMP, 's2');
  await assert.rejects(startRpcRuntime(base({ stateDir: s2, witnessArchive: { kind: 's3', endpoint: 'https://s3.example.net', bucket: 'witness', accessFile: acc } })), /owner only \(0600\)/);
  assert.ok(!fs.existsSync(path.join(s2, 'runs')), 'nothing was staged');
  await lockFree(s2);
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

test('glibc runtime: only a tested exact set, only for Helios and the helper; binary staging copy or verify-in-place', async () => {
  const { PINNED_GLIBC_RUNTIMES } = await import('../network/rpc-runtime.mjs');
  const [label, files] = Object.entries(PINNED_GLIBC_RUNTIMES)[0];
  const g = { dir: '/opt/rpc-runtime/glibc', files: { ...files }, binaries: ['helios', 'witnessCheck'] };
  const c = validateRuntimeConfig(base({ glibcRuntime: g, binaryStaging: 'verify-in-place' }));
  assert.equal(c.glibcRuntime.build, label); assert.equal(c.binaryStaging, 'verify-in-place');
  assert.equal(validateRuntimeConfig(base()).binaryStaging, 'copy', 'copy stays the default');
  assert.equal(validateRuntimeConfig(base()).glibcRuntime, null);
  bad({ glibcRuntime: { ...g, files: { ...files, 'libc.so.6': 'ab'.repeat(32) } } }, /not a tested glibc runtime/);
  bad({ glibcRuntime: { ...g, binaries: ['listener'] } }, /helios and\/or witnessCheck/);
  bad({ glibcRuntime: { ...g, binaries: [] } }, /helios and\/or witnessCheck/);
  bad({ glibcRuntime: { ...g, files: { ...files, 'libpthread.so.0': 'ab'.repeat(32) } } }, /unknown field/);
  bad({ glibcRuntime: { ...g, dir: 'glibc' } }, /absolute path/);
  bad({ binaryStaging: 'symlink' }, /copy or verify-in-place/);
});

test('verify-in-place refuses a binary others could replace (group/other-writable file or directory), before anything starts', async () => {
  const dir = path.join(TMP, 'inplace'); fs.mkdirSync(dir, { mode: 0o755 }); fs.chmodSync(dir, 0o755);
  const fake = path.join(dir, 'listener'); fs.writeFileSync(fake, '#!/bin/sh\n', { mode: 0o555 }); fs.chmodSync(fake, 0o555);
  const pin = createHash('sha256').update(fs.readFileSync(fake)).digest('hex');
  const accepted = { ...PINNED_BUILDS, listener: { [pin]: 'test file' } };
  const b = base().binaries;
  const cfg = (stateDir) => base({ stateDir, binaryStaging: 'verify-in-place', binaries: { ...b, listener: { path: fake, sha256: pin } } });
  fs.chmodSync(fake, 0o575);                                        // group-writable file
  await assert.rejects(startRpcRuntime(cfg(path.join(TMP, 'ip1')), { acceptedBuilds: accepted }), /writable by no one else \(verify-in-place\)/);
  fs.chmodSync(fake, 0o555); fs.chmodSync(dir, 0o775);              // group-writable directory above it
  await assert.rejects(startRpcRuntime(cfg(path.join(TMP, 'ip2')), { acceptedBuilds: accepted }), /writable by no one else \(verify-in-place\)/);
  fs.chmodSync(dir, 0o755);
  // the positive in-place path (every parent owned by root or this user) runs in the guest chroot E2E; here, inside the test's
  // user namespace, the host's real-root parents appear as the overflow uid and are refused too, as they should be
  await lockFree(path.join(TMP, 'ip2'));
});
