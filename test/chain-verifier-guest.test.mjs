// The local chain verifier's Linux guest launch (metal/guest/chain-verifier.mjs): the operator's opt-in, checked by the
// REAL launcher (metal/enclave-metal.mjs, fake QEMU copying out the fw_cfg file) and again in the guest; the runtime config
// it builds from the image's committed pin record is accepted by the runtime's own validator; the supervisor's two chain
// authority names come only from it; absent leaves everything as before. Offline; no VM.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { checkChainVerifier, guestChainVerifier, withChainVerifierEnv, runtimeConfigFor, readVerifierImage, writeChainVerifierConfig,
  REFUSING_VERIFIER, CHAIN_VERIFIER_FORMAT, CHAIN_AUTHORITY_NAMES } from '../metal/guest/chain-verifier.mjs';
import { validateRuntimeConfig } from '../network/rpc-runtime.mjs';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'chain-verifier-guest-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const SIGNER = '0xaf6e19be0f9ce7f8afd49a1824851023a8249e8a';
const OK = (over = {}) => ({ format: CHAIN_VERIFIER_FORMAT, unsafeSigner: SIGNER, proofSources: ['https://holder-a.example.net/', 'https://holder-b.example.net/'], port: 8546, ...over });
const IMAGE_FILE = path.join(REPO, 'metal/chain-verifier-image.json');

test('the setting: checked, canonical, bounded; archive, cache, reserved ports, credentials and implicit providers refused', () => {
  const v = checkChainVerifier({ ...OK(), unsafeSigner: SIGNER.toUpperCase().replace('0X', '0x'), gossip: { maxPeers: 10, discovery: 'off' }, limits: { firstHeadTimeoutMs: 60000 } });
  assert.deepEqual(Object.keys(v), ['format', 'unsafeSigner', 'proofSources', 'port', 'gossip', 'limits']);
  assert.equal(v.unsafeSigner, SIGNER);
  for (const [what, over, re] of [
    ['no source', { proofSources: [] }, /1\.\.16 explicit proof source/],
    ['plain http', { proofSources: ['http://holder.example.net/'] }, /https/],
    ['credentials', { proofSources: ['https://u:p@holder.example.net/'] }, /without credentials/],
    ['query', { proofSources: ['https://holder.example.net/?key=1'] }, /without credentials, query/],
    ['repeat', { proofSources: ['https://a.example.net/', 'https://a.example.net/'] }, /repeats/],
    ['supervisor port', { port: 8080 }, /guest's own ports/],
    ['RAD port', { port: 8443 }, /guest's own ports/],
    ['low port', { port: 80 }, /1024\.\.65535/],
    ['zero signer', { unsafeSigner: '0x' + '0'.repeat(40) }, /unsafeSigner/],
    ['format', { format: 'enclave-chain-verifier/v0' }, /format/],
    ['archive', { witnessArchive: { kind: 's3' } }, /no curl/],
    ['cache', { witnessCache: { kind: 'dir' } }, /no reviewed NVMe budget kind/],
    ['unknown', { rpcs: ['https://x.example/'] }, /unknown field rpcs/],
    ['gossip', { gossip: { maxPeers: 99 } }, /maxPeers/],
  ]) assert.throws(() => checkChainVerifier(OK(over)), re, what);
  assert.throws(() => checkChainVerifier(OK({ proofSources: ['http://127.0.0.1:9545/'] })), /https/, 'loopback http only with the test option');
  assert.equal(checkChainVerifier(OK({ proofSources: ['http://127.0.0.1:9545/'] }), { allowLoopbackHttp: true }).proofSources[0], 'http://127.0.0.1:9545/');
});

test('the committed image pin record builds a runtime config the runtime itself accepts (v2, pinned builds, glibc runtime, in place)', () => {
  const image = readVerifierImage(IMAGE_FILE);
  assert.ok(image, 'metal/chain-verifier-image.json is a valid image record');
  const cfg = runtimeConfigFor(checkChainVerifier(OK({ gossip: { discovery: 'bounded' } })), image);
  const c = validateRuntimeConfig(cfg);
  assert.equal(c.format, 'enclave-rpc-runtime/v2');
  assert.equal(c.verifier.bind, '127.0.0.1'); assert.equal(c.verifier.port, 8546);
  assert.equal(c.binaryStaging, 'copy');
  assert.deepEqual([...c.glibcRuntime.binaries], ['helios', 'witnessCheck']);
  assert.match(c.binaries.listener.build, /release profile/);
  assert.match(c.binaries.witnessCheck.build, /ef320298/);
  assert.equal(c.witnessArchive, null); assert.equal(c.witnessCache, null);
  assert.deepEqual([...c.proofSources.untrusted], ['https://holder-a.example.net/', 'https://holder-b.example.net/']);
  assert.equal(c.stateDir, '/mnt/ramdisk/enclave-chain-verifier/state');
});

test('the guest view and the supervisor names: absent unchanged; valid sets exactly two names; invalid or no image refuses', () => {
  const flavor = { CHAIN_ID: '8453', ADDRESS_BOOK_ADDRESS: '0x' + '11'.repeat(20), ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: 'http://127.0.0.1:1234/' };
  const image = readVerifierImage(IMAGE_FILE);
  const absent = guestChainVerifier(undefined, { image });
  assert.deepEqual(absent, { configured: false, ok: false, url: null, message: null });
  const legacy = withChainVerifierEnv(flavor, absent);
  for (const k of CHAIN_AUTHORITY_NAMES) assert.equal(k in legacy, false, `${k} never comes from another channel`);
  assert.deepEqual(legacy, { CHAIN_ID: '8453', ADDRESS_BOOK_ADDRESS: flavor.ADDRESS_BOOK_ADDRESS });

  const ok = guestChainVerifier(OK(), { image });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.argv('/x/rpc-runtime.json'), ['/usr/local/bin/node', '/app/network/rpc-runtime-main.mjs', 'run', '/x/rpc-runtime.json']);
  const env = withChainVerifierEnv(flavor, ok);
  assert.equal(env.ENCLAVE_CHAIN_AUTHORITY, 'verifier'); assert.equal(env.ENCLAVE_CHAIN_VERIFIER, 'http://127.0.0.1:8546/');
  assert.match(ok.message, /refuse until it is ready/);

  for (const [what, cv] of [['invalid', guestChainVerifier(OK({ port: 8080 }), { image })], ['no image', guestChainVerifier(OK(), { imageFile: path.join(tmp, 'absent.json') })]]) {
    assert.equal(cv.configured, true, what); assert.equal(cv.ok, false, what);
    assert.match(cv.message, /REFUSED .*every verified chain read refuses; no provider fallback/, what);
    const e = withChainVerifierEnv(flavor, cv);
    assert.equal(e.ENCLAVE_CHAIN_AUTHORITY, 'verifier', `${what}: still the verifier authority, never the provider quorum`);
    assert.equal(e.ENCLAVE_CHAIN_VERIFIER, REFUSING_VERIFIER);
  }
  // the config file: private directory, owner-only file, exactly the runtime config
  const cv = guestChainVerifier(OK(), { image: { ...image, configDir: path.join(tmp, 'cfg') } });
  const file = writeChainVerifierConfig(cv);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), cv.runtimeConfig);
});

test('gsup: the verifier starts before the supervisor, as a supervised child, and its names wrap the supervisor env last', () => {
  const g = fs.readFileSync(path.join(REPO, 'metal/guest/gsup.mjs'), 'utf8');
  assert.match(g, /import \{ guestChainVerifier, withChainVerifierEnv, writeChainVerifierConfig \} from '\.\/chain-verifier\.mjs';/);
  // two supervisor starts: the direct control guest's (indented, in startDirectControl: its bound plan, no verifier) and the
  // legacy one (top level, after the verifier block)
  assert.equal(g.match(/start\('supervisor', /g).length, 2);
  assert.match(g, /^ {2}start\('supervisor', \['\/usr\/local\/bin\/node', '\/app\/supervisor\.js'\], plan\.env, \{ cwd: '\/app' \}\);$/m);
  const a = g.indexOf('// --- chain verifier (opt-in'), b = g.indexOf('// --- end chain verifier'), s = g.indexOf("\nstart('supervisor', ['/usr/local/bin/node', '/app/supervisor.js'], ");
  assert.ok(a > 0 && b > a && s > b, 'the verifier block precedes the legacy supervisor start');
  assert.match(g.slice(a, b), /const CHAIN_VERIFIER = CONTROL \? null : guestChainVerifier\(fw\.chainVerifier\);/);
  assert.match(g.slice(a, b), /start\('chain-verifier', CHAIN_VERIFIER\.argv\(writeChainVerifierConfig\(CHAIN_VERIFIER\)\), CHAIN_VERIFIER\.env, \{ cwd: '\/app' \}\);/);
  assert.match(g, /start\('supervisor', \['\/usr\/local\/bin\/node', '\/app\/supervisor\.js'\], withChainVerifierEnv\(MC_LEGACY\.withPolicyCarriersEnv\(/);
  assert.match(g, /POLICY_CARRIERS\), CHAIN_VERIFIER\), \{ cwd: '\/app' \}\);/);
});

// ---- the REAL launcher (fake QEMU), as test/relay-policy-carriers.test.mjs drives it --------------------------------------
const PUB = 'https://metal-test.example.net';
function launch(cfgOver, { direct = null } = {}) {
  const t = fs.mkdtempSync(path.join(tmp, 'launch-'));
  fs.mkdirSync(path.join(t, 'dist')); fs.mkdirSync(path.join(t, 'tmp'));
  fs.writeFileSync(path.join(t, 'dist', 'vmlinuz'), 'k'); fs.writeFileSync(path.join(t, 'dist', 'initramfs.cpio.gz'), 'i');
  fs.writeFileSync(path.join(t, 'pair.key'), 'ab'.repeat(32) + '\n', { mode: 0o600 });
  if (direct) fs.writeFileSync(path.join(t, 'direct.json'), JSON.stringify(direct));
  fs.writeFileSync(path.join(t, 'fake-qemu'), ['#!/bin/sh', 'while [ $# -gt 0 ]; do',
    '  if [ "$1" = -fw_cfg ]; then case "$2" in name=opt/org.enclave.metal,file=*) cp "${2#name=opt/org.enclave.metal,file=}" "$FAKE_QEMU_OUT.tmp" && mv "$FAKE_QEMU_OUT.tmp" "$FAKE_QEMU_OUT";; esac; fi',
    '  shift', 'done', 'exec sleep 30'].join('\n') + '\n', { mode: 0o755 });
  const cfg = { mode: 'snp', name: 'verifier-test', cpus: 1, memMiB: 512, measureGflops: false, dist: path.join(t, 'dist'), ovmf: path.join(t, 'ovmf.fd'),
    qemu: path.join(t, 'fake-qemu'), relayUrl: 'wss://relay.example.test/v1/fleet-tunnel', publicUrl: PUB,
    isolation: { backend: 'snp-guest-per-app', managerUrl: 'http://10.0.2.2:8095', dataAddr: '10.0.2.2:8096', pairingKeyFile: path.join(t, 'pair.key') },
    ...(direct ? { control: 'direct', direct: path.join(t, 'direct.json'), relayUrl: undefined, hostfwd: [{ host: 18444, guest: 8444 }] } : {}), ...cfgOver };
  for (const k of Object.keys(cfg)) if (cfg[k] === undefined) delete cfg[k];
  fs.writeFileSync(path.join(t, 'config.json'), JSON.stringify(cfg));
  const out = path.join(t, 'fwcfg.json');
  const p = spawn(process.execPath, [path.join(REPO, 'metal/enclave-metal.mjs'), '--config', path.join(t, 'config.json')],
    { env: { ...process.env, TMPDIR: path.join(t, 'tmp'), FAKE_QEMU_OUT: out }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; p.stdout.on('data', (d) => { log += d; }); p.stderr.on('data', (d) => { log += d; });
  const exited = new Promise((r) => p.on('exit', (code) => r(code)));
  return { out, p, exited, log: () => log };
}
async function launched(cfgOver = {}, o = {}) {
  const run = launch(cfgOver, o);
  try {
    for (let i = 0; i < 200 && !fs.existsSync(run.out); i++) { if (run.p.exitCode !== null) break; await new Promise((r) => setTimeout(r, 50)); }
    if (!fs.existsSync(run.out)) return { refused: true, code: await Promise.race([run.exited, new Promise((r) => setTimeout(() => r('running'), 3000))]), log: run.log() };
    return { fw: JSON.parse(fs.readFileSync(run.out, 'utf8')), log: run.log() };
  } finally { if (run.p.exitCode === null && run.p.signalCode === null) { run.p.kill('SIGTERM'); await run.exited; } }
}

test('the real launcher: the opt-in crosses fw_cfg in its checked form; invalid refuses the launch; absent stays absent', async () => {
  const r = await launched({ chainVerifier: { ...OK(), unsafeSigner: SIGNER.toUpperCase().replace('0X', '0x') } });
  assert.ok(!r.refused, r.log);
  assert.deepEqual(r.fw.chainVerifier, JSON.parse(JSON.stringify(checkChainVerifier(OK()))));
  assert.match(r.log, /local chain verifier: 2 proof source\(s\), guest loopback port 8546/);
  for (const [what, over, re] of [['reserved port', { port: 8091 }, /guest's own ports/], ['no sources', { proofSources: [] }, /explicit proof source/],
    ['archive', { witnessArchive: {} }, /no curl/]]) {
    const x = await launched({ chainVerifier: OK(over) }); assert.equal(x.refused, true, what); assert.match(x.log, re, what);
  }
  const off = await launched({});
  assert.ok(!off.refused, off.log); assert.equal('chainVerifier' in off.fw, false, 'absent: nothing crosses');
});
