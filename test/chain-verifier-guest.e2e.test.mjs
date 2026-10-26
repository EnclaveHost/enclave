// END-TO-END: the local chain verifier LAUNCHED THE LINUX GUEST WAY, in the guest's own userland:
//   * the production base image's rootfs (Debian 12, glibc 2.36, node v20; extracted read-only as GUEST_ROOTFS), hard-link
//     copied, with this commit's image files installed at their image paths: /opt/metal/{gsup,chain-verifier}.mjs, the
//     runtime's import closure under /app/network, and /opt/rpc-runtime (the PINNED Helios 8250f08a and helper 4fe0cd3b, run
//     through the pinned glibc runtime, copied and hashed into a 0700 run directory on the guest tmpfs; IMAGE.json);
//     NOT modelled: the real base's uid-1000 ownership (in this user namespace every file appears as root), which is why
//     the image uses copy staging (tools/image-inputs.py gates verify-in-place on the base's real owners);
//   * gsup's REAL child supervision and chain-verifier block (test/fixtures/gsup-chain-verifier-harness.mjs, sliced from the
//     installed gsup.mjs) under the guest's node, chroot'ed, /proc and /dev bind-mounted, sharing the test's loopback;
//   * the supervisor's REAL consumer: host wallet admission from the shipped bundle (windows/node/host-admission.bundle.mjs,
//     hostAdmissionFromEnv), given exactly the names gsup composed, on A's canonical reth --dev chain with real contracts.
// TEST-ONLY, labelled: the listener's `listen` is the reth stand-in (its `commitment` is the REAL pinned release listener),
// so the fixture image's IMAGE.json names that stand-in and a test entry that accepts its digest; proof sources are loopback
// http proxies. SYNTHETIC head authority (a TEST sequencer key). Not an SNP guest, not a VM boot, not Base evidence.
//   env: GUEST_ROOTFS, CHAIN_VERIFIER_INPUTS (flat pinned files), RIG_CHAIN_NODE=reth (+RIG_RETH_*, the -2935 genesis),
//        TEST_TMP. Runs inside `unshare -r -n` (root in the user namespace: chroot and bind mounts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { stringToHex, pad } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { startRig, haveTools, KEYS } from './helpers/cli-independent-rig.mjs';
import { hostAdmissionPolicyHash } from '../network/host-admission-policy.mjs';
import { CHAIN_VERIFIER_FORMAT, REFUSING_VERIFIER, VERIFIER_PORT_RANGE } from '../metal/guest/chain-verifier.mjs';
import net from 'node:net';

const { GUEST_ROOTFS, CHAIN_VERIFIER_INPUTS } = process.env;
const skip = haveTools() || (!GUEST_ROOTFS && 'GUEST_ROOTFS not set') || (!CHAIN_VERIFIER_INPUTS && 'CHAIN_VERIFIER_INPUTS not set')
  || (process.env.RIG_CHAIN_NODE !== 'reth' && 'needs the canonical-trie rig (RIG_CHAIN_NODE=reth)');
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(process.env.TEST_TMP || '/tmp', 'guest-e2e-'));
const R = path.join(TMP, 'guest-root');
const SEQ_KEY = '0x' + '5e'.repeat(32), seqSigner = privateKeyToAccount(SEQ_KEY).address;
const OUT = path.join(REPO, 'contracts/foundry/out');
const art = (file, name) => { const j = JSON.parse(fs.readFileSync(path.join(OUT, file, `${name}.json`), 'utf8')); return { abi: j.abi, bytecode: j.bytecode.object, linkReferences: j.bytecode.linkReferences || {} }; };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATE = path.join(R, 'mnt/ramdisk/enclave-chain-verifier/state');
let rig, book, bookAbi, leaseId, proxy, providers, own, ownAbi, port, guest, HA;
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
async function until(pred, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await pred()) return; } catch {} await sleep(250); }
  throw new Error(`timed out: ${what} | last decision: ${JSON.stringify(lastDecision)} | guest log: ${guest?.log().slice(-1500)}`);
}
async function rpc(url, method, params = []) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10000) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
}
const alive = (pid) => { try { return !/\) [ZX] /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; } };
const cmdline = (pid) => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { return []; } };

// ---- the guest fixture image -------------------------------------------------------------------------------------------
function put(rel, bytes, mode) {           // a new inode (the rootfs copy is hard-linked to the read-only extraction)
  const p = path.join(R, rel); fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.rmSync(p, { force: true }); fs.writeFileSync(p, bytes); fs.chmodSync(p, mode);
}
function closure(rel, seen = new Set()) {   // the runtime's local import closure (as the overlay tool installs it)
  if (seen.has(rel)) return seen; seen.add(rel);
  const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
  for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"\n]*?from\s*['"](\.\.?\/[^'"]+)['"]|import\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g))
    closure(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1] || m[2])), seen);
  return seen;
}
function buildGuestRoot() {
  const r = spawnSync('cp', ['-al', GUEST_ROOTFS, R]); assert.equal(r.status, 0, String(r.stderr));
  for (const d of ['mnt/ramdisk', 'tmp', 'proc', 'dev']) fs.mkdirSync(path.join(R, d), { recursive: true });
  fs.chmodSync(path.join(R, 'tmp'), 0o1777);
  put('opt/metal/gsup.mjs', fs.readFileSync(path.join(REPO, 'metal/guest/gsup.mjs')), 0o644);
  put('opt/metal/chain-verifier.mjs', fs.readFileSync(path.join(REPO, 'metal/guest/chain-verifier.mjs')), 0o644);
  for (const f of closure('network/rpc-runtime-main.mjs')) put(path.join('app', f), fs.readFileSync(path.join(REPO, f)), 0o644);
  const pins = JSON.parse(fs.readFileSync(path.join(REPO, 'metal/chain-verifier-image.json'), 'utf8'));
  for (const [role, b] of Object.entries(pins.binaries)) if (role !== 'listener') {
    const bytes = fs.readFileSync(path.join(CHAIN_VERIFIER_INPUTS, path.basename(b.path))); assert.equal(sha(bytes), b.sha256, role);
    put(b.path.slice(1), bytes, 0o555);
  }
  for (const [n, digest] of Object.entries(pins.glibcRuntime.files)) {
    const bytes = fs.readFileSync(path.join(CHAIN_VERIFIER_INPUTS, n)); assert.equal(sha(bytes), digest, n);
    put(path.join(pins.glibcRuntime.dir, n).slice(1), bytes, n.startsWith('ld-linux') ? 0o555 : 0o444);
  }
  // TEST-ONLY: the reth listener stand-in (its shebang points at the guest's node) and the real pinned listener it delegates to
  const real = fs.readFileSync(path.join(CHAIN_VERIFIER_INPUTS, path.basename(pins.binaries.listener.path))); assert.equal(sha(real), pins.binaries.listener.sha256);
  put('opt/rpc-runtime/real-listener', real, 0o555);
  const standin = fs.readFileSync(path.join(REPO, 'test/fixtures/reth-gossip-listener.mjs'), 'utf8').replace(/^#!.*\n/, '#!/usr/local/bin/node\n');
  put(pins.binaries.listener.path.slice(1), standin, 0o555);
  for (const f of ['op-commitment.mjs', 'listener-start-record.json', 'rpc-runtime-launcher.mjs', 'guest-launcher.mjs', 'gsup-chain-verifier-harness.mjs'])
    put(path.join('app/test/fixtures', f), fs.readFileSync(path.join(REPO, 'test/fixtures', f)), 0o644);
  put('app/test/fixtures/control.json', '{}', 0o666);
  put('app/test/fixtures/guest-launch-env.json', JSON.stringify({ LAUNCH_LISTENER_SHA256: sha(standin), LAUNCH_LISTENER_ENV: JSON.stringify({
    REAL_LISTENER: '/opt/rpc-runtime/real-listener', FIXTURES_DIR: '/app/test/fixtures', RIG_RPC: rig.rpc, FEED_CONTROL: '/app/test/fixtures/control.json' }) }), 0o644);
  put('opt/rpc-runtime/IMAGE.json', JSON.stringify({ ...pins, entry: '/app/test/fixtures/guest-launcher.mjs',
    binaries: { ...pins.binaries, listener: { path: pins.binaries.listener.path, sha256: sha(standin) } }, provenance: { test: 'FIXTURE image: listener stand-in + test entry' } }), 0o644);
  for (const d of ['opt', 'opt/rpc-runtime', 'opt/rpc-runtime/glibc']) fs.chmodSync(path.join(R, d), 0o755);
}
const setControl = (c) => { fs.rmSync(path.join(R, 'app/test/fixtures/control.json'), { force: true }); fs.writeFileSync(path.join(R, 'app/test/fixtures/control.json'), JSON.stringify(c)); };

/** gsup (sliced) inside the guest userland; -> {p, log(), supEnv: Promise, pids() (chain-verifier starts in order)} */
function startGuest(name, fw) {
  put(`app/test/fixtures/fw-${name}.json`, JSON.stringify(fw), 0o644);
  const p = spawn('unshare', ['-m', '--propagation', 'private', 'sh', '-c',
    `mount --rbind /proc '${R}/proc' && mount --rbind /dev '${R}/dev' && exec chroot '${R}' /usr/local/bin/node /app/test/fixtures/gsup-chain-verifier-harness.mjs /app/test/fixtures/fw-${name}.json`],
  { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
  let out = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((r) => p.once('exit', (code, sig) => r({ code, sig })));
  const supEnv = until(() => /^SUPENV /m.test(out), 30000, `${name}: SUPENV`).then(() => JSON.parse(out.match(/^SUPENV (.*)$/m)[1]));
  const pids = () => [...out.matchAll(/started chain-verifier pid=(\d+)/g)].map((m) => Number(m[1]));
  return { p, exited, supEnv, pids, log: () => out };
}
/** guest poweroff: every process of the fixture, whatever its process group */
function powerOff(g) {
  try { process.kill(-g.p.pid, 'SIGKILL'); } catch {}
  for (const pid of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x)).map(Number))
    if (cmdline(pid).some((a) => a.startsWith('/opt/rpc-runtime/') || a.startsWith('/app/test/fixtures/') || a.includes('/mnt/ramdisk/enclave-chain-verifier'))) { try { process.kill(pid, 'SIGKILL'); } catch {} }
}
const fixtureProcs = () => fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x)).map(Number).filter((pid) => alive(pid)
  && cmdline(pid).some((a) => a.startsWith('/opt/rpc-runtime/') || a.startsWith('/app/test/fixtures/') || a.includes('/mnt/ramdisk/enclave-chain-verifier')));

// ---- the supervisor's consumer -----------------------------------------------------------------------------------------
let policyDir, pinsFile;
function admission(env) {
  return HA.hostAdmissionFromEnv({ hostId: rig.runner, rpc: [providers.url], addressBook: book, env: { ...env,
    ENCLAVE_HOST_OWNERSHIP: own.toLowerCase(), ENCLAVE_HOST_REGISTRY_PIN: rig.addresses.registry.toLowerCase(), ENCLAVE_HOST_CATALOG_PIN: rig.addresses.catalog.toLowerCase(),
    ENCLAVE_HOST_POLICY_DIR: policyDir, ENCLAVE_HOST_ID: rig.runner, ENCLAVE_CONTRACT_PINS_FILE: pinsFile } });
}
const request = () => ({ deploymentId: leaseId, appRef: `catalog://${rig.appId}/1` });
let lastDecision;   // named in until()'s timeout message
// refused as UNKNOWN for a chain reason: never admitted, never a policy refusal, and never the consumer's own configuration
// (a missing pin also yields unknown, which would make these checks pass for the wrong reason)
const unknownForChain = (d, why) => { assert.ok(d.unknown && !d.refusal, `${why}: ${JSON.stringify(d)}`); assert.doesNotMatch(d.unknown, /contract pin|policy dir|ENCLAVE_HOST_/, why); };
async function decide(env) { try { return (lastDecision = await admission(env).decision(request())); } catch (e) { return (lastDecision = { unknown: String(e.message) }); } }
function startProxy() {
  const st = { mode: 'ok' };
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', async () => {
    if (st.mode === 'down') { res.writeHead(503); return res.end(); }
    try { res.end(JSON.stringify(await (await fetch(rig.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: b })).json())); } catch { res.writeHead(502); res.end(); }
  }); });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, st, url: `http://127.0.0.1:${srv.address().port}/` })));
}
function startProviders() {   // stand-in for the provider RPC quorum: it must never be asked once the verifier is chosen
  const st = { hits: 0 };
  const srv = http.createServer((q, res) => { st.hits++; res.writeHead(503); res.end(); });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, st, url: `http://127.0.0.1:${srv.address().port}/` })));
}
async function freePortIn([lo, hi]) {      // a free loopback port in [lo, hi]
  for (let i = 0; i < 200; i++) {
    const p = lo + Math.floor(Math.random() * (hi - lo + 1));
    if (await new Promise((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(p, '127.0.0.1', () => s.close(() => r(true))); })) return p;
  }
  throw new Error(`no free port in ${lo}..${hi}`);
}
const waitTx = async (rc) => until(async () => BigInt(await rpc(`http://127.0.0.1:${port}/`, 'eth_blockNumber')) >= rc.blockNumber + 2n, 90000, 'verifier past the write');

test.before(async () => {
  if (skip) return;
  rig = await startRig();
  assert.notEqual(await rig.rpcCall('eth_getCode', ['0x0000F90827F1C53a10cb7A02335B175320002935', 'latest']), '0x', 'needs the EIP-2935 genesis');
  const B = art('EnclaveAddressBook.sol', 'EnclaveAddressBook'); bookAbi = B.abi;
  book = await rig.deploy(B);
  await rig.write(rig.wc(KEYS.deployer), book, bookAbi, 'set', [stringToHex('deployments', { size: 32 }), rig.addresses.ledger]);
  await rig.write(rig.wc(KEYS.deployer), book, bookAbi, 'set', [stringToHex('registry', { size: 32 }), rig.addresses.registry]);
  leaseId = rig.createdId(await rig.create(KEYS.owner));
  const O = art('EnclaveHostOwnership.sol', 'EnclaveHostOwnership'); ownAbi = O.abi;
  own = await rig.deploy(O, [rig.addresses.registry]);
  await rig.write(rig.wc(KEYS.operator), own, ownAbi, 'proposeOwner', [rig.runner, rig.owner]);
  await rig.write(rig.wc(KEYS.owner), own, ownAbi, 'acceptOwner', [rig.runner]);
  policyDir = path.join(TMP, 'host-policy'); fs.mkdirSync(policyDir);
  pinsFile = path.join(TMP, 'contract-pins.json');
  const none = '0x' + '00'.repeat(20);   // network/contract-pins.mjs: the optional pins are present, zero when not deployed
  fs.writeFileSync(pinsFile, JSON.stringify({ version: 1, chainId: 8453, contracts: { registry: rig.addresses.registry, deployments: rig.addresses.ledger, appCatalog: rig.addresses.catalog, proofOfTime: book,
    enclavePay: none, verificationFees: none, sessionVaultFactory: none, secretVaultV2: none } }));
  proxy = await startProxy(); providers = await startProviders();
  HA = await import(path.join(REPO, 'windows/node/host-admission.bundle.mjs'));
  port = await freePortIn(VERIFIER_PORT_RANGE);   // the guest checker takes only 50000..57999
  buildGuestRoot();
});
test.after(async () => {
  if (guest) powerOff(guest);
  proxy?.srv.close(); providers?.srv.close();
  await rig?.stop();
  fs.rmSync(TMP, { recursive: true, force: true });
});
const T = { skip, timeout: 400000 };
const CONFIG = () => ({ format: CHAIN_VERIFIER_FORMAT, unsafeSigner: seqSigner.toLowerCase(), proofSources: [proxy.url], port, gossip: { discovery: 'off' },
  limits: { firstHeadTimeoutMs: 300000 } });

test('absent opt-in: legacy unchanged (no names, no verifier); invalid opt-in: the verifier authority at a refusing URL, never the providers', T, async () => {
  const absent = startGuest('absent', { testSupervisorBase: { CHAIN_ID: '8453', ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: 'http://127.0.0.1:1/' } });
  const e1 = await absent.supEnv;
  assert.deepEqual(e1, { CHAIN_ID: '8453' }, 'no chain-authority name from any other channel; nothing added');
  assert.deepEqual(absent.pids(), []);
  powerOff(absent); await absent.exited;
  const invalid = startGuest('invalid', { chainVerifier: { ...CONFIG(), port: 8080 } });
  const e2 = await invalid.supEnv;
  assert.deepEqual(e2, { ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: REFUSING_VERIFIER });
  assert.match(invalid.log(), /chain verifier REFUSED .*guest's own ports.*no provider fallback/);
  assert.deepEqual(invalid.pids(), [], 'nothing started');
  const d = await decide(e2);
  unknownForChain(d, 'refused as unknown, never admitted');
  assert.equal(providers.st.hits, 0, 'the provider quorum was never asked');
  powerOff(invalid); await invalid.exited;
});

test('cold start in the guest userland: the verifier starts before the supervisor names; readers refuse until it is ready and while no proof source answers', T, async () => {
  proxy.st.mode = 'down'; setControl({ frozen: true });
  guest = startGuest('main', { chainVerifier: CONFIG() });
  const env = await guest.supEnv;
  assert.deepEqual(env, { ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: `http://127.0.0.1:${port}/` });
  await until(() => guest.pids().length === 1, 30000, 'chain-verifier started');
  const runtimePid = guest.pids()[0];
  assert.deepEqual(cmdline(runtimePid).slice(0, 3), ['/usr/local/bin/node', '/app/test/fixtures/guest-launcher.mjs', 'run']);
  assert.ok(fs.readlinkSync(`/proc/${runtimePid}/exe`).endsWith('/usr/local/bin/node') && fs.readlinkSync(`/proc/${runtimePid}/exe`) !== process.execPath, 'the guest\'s own node');
  assert.match(guest.log(), /chain verifier configured: 1 proof source\(s\)/);
  // booting is not readiness: no verified decision yet, and no provider asked
  await sleep(4000);
  assert.equal(fs.existsSync(path.join(STATE, 'ready.json')), false);
  let d = await decide(env);
  unknownForChain(d, 'booting: no verified decision yet');
  setControl({});                                                         // heads flow; proof sources still down
  await until(() => fs.existsSync(path.join(STATE, 'ready.json')), 300000, 'verifier ready');
  assert.equal(Number(await rpc(env.ENCLAVE_CHAIN_VERIFIER, 'eth_chainId')), 8453);
  const st = readJson(path.join(STATE, 'status.json'));
  assert.equal(st.binaries.staging, 'copy');
  assert.deepEqual(st.binaries.glibcRuntime.for, ['helios', 'witnessCheck']);
  const helios = readJson(path.join(STATE, 'children.json')).find((c) => c.role === 'helios');
  const [loader, flag, libDir, heliosBin] = cmdline(helios.pid);
  const runDir = path.dirname(libDir);
  assert.match(runDir, /^\/mnt\/ramdisk\/enclave-chain-verifier\/state\/runs\/r\d+-[0-9a-f]{12}$/, 'a fresh run directory on the guest tmpfs');
  assert.deepEqual([loader, flag, libDir, heliosBin], [`${runDir}/glibc/ld-linux-x86-64.so.2`, '--library-path', `${runDir}/glibc`, `${runDir}/bin/helios`],
    'Helios runs from its hashed copy through the copied pinned glibc runtime (the guest glibc 2.36 cannot run it)');
  assert.equal((fs.statSync(path.join(R, runDir)).mode & 0o777), 0o700);
  d = await decide(env);
  unknownForChain(d, 'ready but no proof source answers: refused as unknown, not admitted');
  proxy.st.mode = 'ok';
  await until(async () => (await decide(env)).refusal === null, 60000, 'admitted once a proof source answers');
  assert.equal(providers.st.hits, 0, 'no provider fallback at any point');
});

test('the supervisor consumer through the guest verifier follows the owner\'s policy and the admin\'s catalog moderation', T, async () => {
  const env = await guest.supEnv;
  const doc = { version: 1, chainId: 8453, ownershipContract: own.toLowerCase(), hostId: rig.runner, requireCatalogApproval: false, denyDeployments: [leaseId.toLowerCase()], denyAppRefs: [] };
  const h = hostAdmissionPolicyHash(doc);
  fs.writeFileSync(path.join(policyDir, `${h}.json`), JSON.stringify(doc));
  await waitTx(await rig.write(rig.wc(KEYS.owner), own, ownAbi, 'setPolicy', [rig.runner, h]));
  await until(async () => (await decide(env)).refusal === 'this host owner declines this deployment', 60000, 'owner decline');
  await waitTx(await rig.write(rig.wc(KEYS.owner), own, ownAbi, 'setPolicy', [rig.runner, pad('0x', { size: 32 })]));
  await until(async () => (await decide(env)).refusal === null, 60000, 'owner clears');
  await waitTx(await rig.write(rig.wc(KEYS.deployer), rig.addresses.catalog, rig.A.catalog.abi, 'setActive', ['hello', false]));
  await until(async () => /delisted/.test((await decide(env)).refusal || ''), 60000, 'admin delisting');
  assert.equal(providers.st.hits, 0);
});

test('supervision: a SIGKILLed verifier is restarted by gsup and reaps its orphaned Helios; a SIGTERMed one stops cleanly and comes back', T, async () => {
  const env = await guest.supEnv;
  const [first] = guest.pids();
  const oldHelios = readJson(path.join(STATE, 'children.json')).find((c) => c.role === 'helios');
  const readyAt = readJson(path.join(STATE, 'ready.json')).readyAt;
  process.kill(first, 'SIGKILL');
  await until(() => guest.pids().length === 2, 30000, 'gsup restarted it');
  assert.match(guest.log(), /chain-verifier exited code=null sig=SIGKILL; restarting/);
  await until(() => (readJson(path.join(STATE, 'ready.json'))?.readyAt || 0) > readyAt, 300000, 'ready again after SIGKILL');
  assert.equal(alive(oldHelios.pid), false, 'the orphaned Helios was reaped by its recorded identity');
  assert.ok(readJson(path.join(STATE, 'status.json')).reaped.recorded >= 1);
  assert.equal(Number(await rpc(env.ENCLAVE_CHAIN_VERIFIER, 'eth_chainId')), 8453);

  const second = guest.pids()[1];
  const kids = readJson(path.join(STATE, 'children.json'));
  const readyAt2 = readJson(path.join(STATE, 'ready.json')).readyAt;
  process.kill(second, 'SIGTERM');
  await until(() => guest.pids().length === 3, 30000, 'gsup restarted it after SIGTERM');
  assert.match(guest.log(), /chain-verifier exited code=0 sig=null; restarting/, 'SIGTERM: a clean exit 0');
  for (const k of kids) assert.equal(alive(k.pid), false, `${k.role} stopped with its runtime`);
  await until(() => (readJson(path.join(STATE, 'ready.json'))?.readyAt || 0) > readyAt2, 300000, 'ready again after SIGTERM');
  assert.equal((await decide(env)).unknown, undefined, 'serving verified decisions again');
  assert.equal(providers.st.hits, 0);
});

test('guest poweroff leaves no fixture process; the kernel lock file stays empty', T, async () => {
  powerOff(guest); await guest.exited;
  await until(() => fixtureProcs().length === 0, 15000, 'every fixture process gone');
  assert.equal(fs.statSync(path.join(STATE, 'runtime.lock')).size, 0);
  guest = null;
});
