// Cold start of a host's own public service roles (ROOT-HOST-SERVICE-COLD-REVIEW, 2026-10-23): a host with NO app yet runs
// its host services (directory/bootstrap replica, policy mirror, route-dns transport) only on its operator's explicit
// opt-in and only once the platform host policy admits it - on the REAL daemon (node network/privacy-agent.mjs --config,
// and the bundle network/build.mjs ships) and the REAL enrollment pass. No app, lease or policy is faked: the policy is
// the unchanged gate (network/host-service-gate.mjs) reading a local chain + mirror (test/helpers/platform-policy-world.mjs)
// or, unconfigured, the production policy with no network at all; every *.enclave.host lookup is refused and logged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { generatePrivateKey } from 'viem/accounts';
import { keccak256, toBytes } from 'viem';
import { platformPolicyWorld } from './helpers/platform-policy-world.mjs';
import { createNetworkEnroll, readHostServicesFile } from '../windows/node/network-enroll.mjs';
import { checkBundle } from '../network/bundle-checks.mjs';
import { lockedInputs } from '../scripts/locked-inputs.mjs';
import { PRODUCTION_BOOK } from '../network/platform-host-policy-config.mjs';
import { rawDigest } from '../network/shield-expectation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINT = 'https://host.policy.example', RUNNER = keccak256(toBytes(ENDPOINT)).toLowerCase(), OPERATOR = '0x' + '44'.repeat(20);
const HS = { zone: 'app.alice-net.org', exits: ['e1'.repeat(16)], ports: { 'directory-replica': 18188 } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freeTcp = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const count = (text, re) => (text.match(new RegExp(re.source, 'g')) || []).length;
const PRELOAD = `import net from 'node:net'; import dns from 'node:dns'; import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const enclave = (h) => /(^|\\.)enclave\\.host\\.?$/i.test(String(h || ''));
const refuse = (h) => { fs.appendFileSync(process.env.BLOCK_LOG, String(h) + '\\n'); return Object.assign(new Error('blocked ' + h), { code: 'ENOTFOUND' }); };
const lookup = dns.lookup, plookup = dns.promises.lookup;
dns.lookup = function (h, ...a) { if (enclave(h)) return process.nextTick(a.at(-1), refuse(h)); return lookup.call(this, h, ...a); };
dns.promises.lookup = async function (h, ...a) { if (enclave(h)) throw refuse(h); return plookup.call(this, h, ...a); };
syncBuiltinESMExports();
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...a) { const o = Array.isArray(a[0]) ? a[0][0] : (a[0] && typeof a[0] === 'object' ? a[0] : null);
  if (o && enclave(o.host)) { const e = refuse(o.host); process.nextTick(() => this.destroy(e)); return this; } return connect.apply(this, a); };
process.on('SIGUSR2', () => console.error('ACTIVE RESOURCES ' + JSON.stringify(process.getActiveResourcesInfo())));`;

// a Linux host's privacy agent config (this rig runs Linux; the Windows-only Shield/TPM branch is not exercised here)
async function hostRig(t, { apps = 0, hostServices = HS, addressBook = '0x' + '00'.repeat(20), endpoint = ENDPOINT, runner = RUNNER, worker = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-cold-')), f = (n) => path.join(dir, n);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(f('operator.key'), generatePrivateKey(), { mode: 0o600 });
  fs.writeFileSync(f('expected.json'), JSON.stringify({ appRef: 'catalog://0x' + '12'.repeat(32) + '/1', configCid: '' }));
  for (const n of ['runtime.json', 'min-tcb.json']) fs.writeFileSync(f(n), '{}');
  fs.writeFileSync(f('vcek.der'), 'not used before an app is probed'); fs.writeFileSync(f('preload.mjs'), PRELOAD); fs.writeFileSync(f('blocked.log'), '');
  fs.mkdirSync(f('state'));
  const app = { deploymentId: '0x' + 'ab'.repeat(32), names: ['app1.alice-net.org'], expectedFile: f('expected.json') };
  const deadDirs = [`http://127.0.0.1:${await freeTcp()}/`];
  const cfg = { version: 2, directory: f('state'), operatorKeyFile: f('operator.key'), runner, ...(endpoint ? { endpoint } : {}),
    apps: apps ? [app] : [], dns: ['9.9.9.9'], upstream: `http://127.0.0.1:${await freeTcp()}`,
    chain: { rpc: ['https://127.0.0.2:1', 'https://127.0.0.3:1'], addressBook,
             authorityPins: { deployments: '0x' + '11'.repeat(20), registry: '0x' + '22'.repeat(20), connectivity: '0x' + '00'.repeat(20), sessionVaultFactory: '0x' + '00'.repeat(20) } },
    linux: { runtimeFile: f('runtime.json'), minTcbFile: f('min-tcb.json'), vcekFile: f('vcek.der') },
    enclaveNetwork: { directories: deadDirs, checkers: ['0x' + '45'.repeat(20)], apps: 'all', control: true,
      wgBinary: process.execPath, nodeBinary: process.execPath, workerModule: path.join(ROOT, 'network', 'windows-circuit-worker.mjs'),
      serviceWorkerModule: worker ? path.join(ROOT, 'network', 'host-service-ingress.mjs') : path.join(dir, 'absent-host-service-ingress.mjs'),
      ...(hostServices !== null ? { hostServices } : {}) } };
  const rig = { dir, f, cfg, app, file: f('privacy-config.json'), state: f('state') };
  rig.write = (c = cfg) => fs.writeFileSync(rig.file, JSON.stringify(c), { mode: 0o600 });
  rig.write();
  return rig;
}
function daemon(t, rig, { env = {}, script = path.join(ROOT, 'network/privacy-agent.mjs') } = {}) {
  const child = spawn(process.execPath, ['--import', pathToFileURL(rig.f('preload.mjs')).href, script, '--config', rig.file],
    { env: { ...process.env, ENCLAVE_PLATFORM_HOST_POLICY: '', ENCLAVE_PLATFORM_HOST_POLICY_RPCS: '', ...env, BLOCK_LOG: rig.f('blocked.log') }, stdio: ['ignore', 'pipe', 'pipe'] });
  const d = { child, out: '' };
  child.stdout.on('data', (b) => { d.out += b; }); child.stderr.on('data', (b) => { d.out += b; });
  d.exited = new Promise((ok) => child.once('exit', (code, signal) => ok({ code, signal })));
  d.until = async (re, ms = 20_000, n = 1) => { const end = Date.now() + ms; while (Date.now() < end && count(d.out, re) < n && child.exitCode === null) await sleep(100);
    assert.ok(count(d.out, re) >= n, `expected ${n}x ${re} in:\n${d.out.slice(-3000)}`); };
  d.stop = async () => { if (child.exitCode !== null || child.signalCode !== null) return d.exited; child.kill('SIGTERM');
    const r = await Promise.race([d.exited, sleep(20_000).then(() => null)]);
    if (!r) { child.kill('SIGUSR2'); await sleep(500); }                                       // what still holds it (test diagnostics)
    return r; };
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await Promise.race([d.exited, sleep(5000)]); });
  return d;
}
const STARTED = /host services: \{/, HELD = /host services held: platform host policy:/, STOPPED = /host services stopped: platform host policy:/;
const policyWorld = (t) => platformPolicyWorld(t, { hosts: { [RUNNER]: { endpoint: ENDPOINT, operator: OPERATOR, owner: '0x' + '55'.repeat(20), active: true } } });
const fast = (w) => w.env({ ENCLAVE_PLATFORM_HOST_POLICY_INTERVAL_SEC: '1', ENCLAVE_PLATFORM_HOST_POLICY_GRACE_SEC: '6' });

test('zero apps: host services only after the platform admits; an admin ban stops them (grants withdrawn), the unban restarts them', { timeout: 120_000 }, async (t) => {
  const w = await policyWorld(t); await w.publish({ deny: [{ kind: 'operator', value: OPERATOR, reason: 'abuse' }] });   // banned before the host starts
  const rig = await hostRig(t), d = daemon(t, rig, { env: fast(w) });
  await d.until(/no apps: running this host's services only/);
  await d.until(/host services held: platform host policy: banned by platform policy/);
  for (let i = 0; i < 40 && !fs.existsSync(path.join(rig.state, 'status.json')); i++) await sleep(250);
  assert.ok(fs.existsSync(path.join(rig.state, 'status.json')), 'the app-less agent started (its status is written)');
  assert.equal(count(d.out, STARTED), 0, 'a banned host starts no host service');
  await w.publish({ deny: [] });                                                                 // the admin's unban
  await d.until(STARTED);
  await d.until(/host service circuits: .*directories unavailable/);                             // they really run (and retry)
  await w.publish({ deny: [{ kind: 'operator', value: OPERATOR, reason: 'abuse' }] });          // banned again while serving
  await d.until(STOPPED); assert.match(d.out, /host services stopped: platform host policy: banned by platform policy #\d+ \(operator\): abuse/);
  w.setDown(true); await sleep(3000);
  assert.equal(count(d.out, STARTED), 1, 'an outage after a known ban never resurrects them');
  w.setDown(false); await w.publish({ deny: [] });
  await d.until(STARTED, 20_000, 2);
  assert.equal(d.child.exitCode, null, 'the agent never exited');
  const exit = await d.stop(); assert.ok(exit && exit.code === 0, `clean exit: ${JSON.stringify(exit)}\n${d.out.slice(-1500)}`);
  assert.equal(fs.readFileSync(rig.f('blocked.log'), 'utf8'), '', 'no enclave.host name was looked up or connected to');
});

test('zero apps, unknown chain policy: the production policy with no network holds them (the agent runs); a fresh host never serves on an unread policy', { timeout: 60_000 }, async (t) => {
  // no ENCLAVE_PLATFORM_HOST_POLICY: the production chain and address book turn the production policy ON by default
  const rig = await hostRig(t, { addressBook: PRODUCTION_BOOK }), d = daemon(t, rig);
  await d.until(/no apps: running this host's services only/);
  await d.until(HELD);
  await sleep(6000);
  assert.equal(count(d.out, STARTED), 0, 'never started while the policy cannot be read');
  assert.equal(d.child.exitCode, null, 'the agent keeps running (and keeps asking)');
  const exit = await d.stop(); assert.ok(exit && exit.code === 0, JSON.stringify(exit));
});

test('zero apps, the local policy down from the start: held; once it answers and admits, started', { timeout: 60_000 }, async (t) => {
  const w = await policyWorld(t); await w.publish({ deny: [] }); w.setDown(true);
  const rig = await hostRig(t), d = daemon(t, rig, { env: fast(w) });
  await d.until(HELD); await sleep(3000);
  assert.equal(count(d.out, STARTED), 0);
  w.setDown(false); await d.until(STARTED);
  await d.stop();
});

test('first app added and last app removed (live reload) never touch host services; a restart with no app starts them again', { timeout: 120_000 }, async (t) => {
  const w = await policyWorld(t); await w.publish({ deny: [] });
  const rig = await hostRig(t);
  let d = daemon(t, rig, { env: fast(w) });
  await d.until(STARTED);
  rig.write({ ...rig.cfg, apps: [rig.app] }); d.child.kill('SIGHUP');                          // the first app
  await d.until(/config reloaded: 1 apps \(1 added, 0 changed\)/);
  rig.write({ ...rig.cfg, apps: [] }); d.child.kill('SIGHUP');                                   // the last app removed
  await d.until(/config reloaded: 1 apps \(0 added, 0 changed\)/);                                 // (a dropped app is left to its lease)
  await sleep(2500);
  assert.equal(count(d.out, STARTED), 1, 'host services started once and were never restarted');
  assert.doesNotMatch(d.out, /host services stopped|HOST SERVICES REFUSED/);
  let t0 = Date.now(), exit = await d.stop();
  assert.ok(exit?.code === 0, `SIGTERM -> ${JSON.stringify(exit)} after ${Date.now() - t0} ms:\n${d.out.slice(-4000)}`);
  d = daemon(t, rig, { env: fast(w) });                                                        // the restart: the file has no app now
  await d.until(/no apps: running this host's services only/); await d.until(STARTED);
  // SIGTERM right away, often during the agent's own startup: it must EXIT (0, or 1 "stopped during startup"), never hang
  // (counterexample: a stop during start()'s last status write left its five intervals running - the process never exited)
  t0 = Date.now(); exit = await d.stop();
  assert.ok(exit?.code === 0 || (exit?.code === 1 && /privacy agent stopped during startup/.test(d.out)), `SIGTERM -> ${JSON.stringify(exit)} after ${Date.now() - t0} ms:\n${d.out.slice(-4000)}`);
});

test('zero apps: refused before anything binds without a usable host-services block or with the policy off', { timeout: 60_000 }, async (t) => {
  const exitOf = async (rig, env = {}) => { const d = daemon(t, rig, { env }); const e = await Promise.race([d.exited, sleep(20_000).then(() => null)]); return { e, out: d.out }; };
  const cases = [
    [{ hostServices: null }, /^version 2 app configuration required\s*$/m, 'no hostServices: refused exactly as before'],
    [{ hostServices: { ...HS, exits: [] } }, /an empty app list runs only this host's services, and they are refused \(invalid hostServices block: hostServices\.exits/, 'malformed block'],
    [{ hostServices: { ...HS, futureField: 1 } }, /they are refused \(invalid hostServices block: hostServices: unknown field/, 'a newer release\'s block'],
    [{ worker: false }, /they are refused \(the host-service ingress worker is missing/, 'no ingress worker'],
    [{ endpoint: ENDPOINT + '/' }, /they are refused \(the runner is not keccak256 of this host's endpoint/, 'runner != keccak(endpoint)'],
    [{}, /they need the platform host policy on \(not the production chain\/book/, 'policy off (a non-production book, nothing configured)'],
  ];
  for (const [opts, re, why] of cases) {
    const { e, out } = await exitOf(await hostRig(t, opts));
    assert.equal(e?.code, 1, `${why}: exit 1\n${out}`); assert.match(out, re, why);
    assert.doesNotMatch(out, /host services: \{|control circuits/, `${why}: nothing started`);
  }
  // explicitly off is off: still refused for an app-less host
  const w = await policyWorld(t);
  const { e, out } = await exitOf(await hostRig(t), { ...fast(w), ENCLAVE_PLATFORM_HOST_POLICY: 'off' });
  assert.equal(e?.code, 1); assert.match(out, /need the platform host policy on \(ENCLAVE_PLATFORM_HOST_POLICY=off/);
});

test('with an app, an "off" policy keeps the earlier behavior (host services start at once); on, they wait for the admit', { timeout: 60_000 }, async (t) => {
  let rig = await hostRig(t, { apps: 1 }), d = daemon(t, rig);
  await d.until(STARTED); await d.stop();
  const w = await policyWorld(t); await w.publish({ deny: [{ kind: 'operator', value: OPERATOR, reason: 'abuse' }] });
  rig = await hostRig(t, { apps: 1 }); d = daemon(t, rig, { env: fast(w) });
  await d.until(HELD); await sleep(1500);
  assert.equal(count(d.out, STARTED), 0, 'a banned host with apps runs no host service either');
  assert.doesNotMatch(d.out, /no apps:/);
  await d.stop();
});

// ---- the shipped bundle: network/build.mjs bundles the agent from network/entries/privacy-agent.mjs (the main guard) ----
const bundleOpts = { bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent',
  banner: { js: 'import {createRequire as bundleRequire} from "node:module"; const require=bundleRequire(import.meta.url);' } };

test('bundled library command lines: without the guard, the runner.mjs a carrier-configured challenge replica loads EXITS the bundle; with it, nothing runs', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-guard-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const probe = async (guard) => { const file = path.join(dir, `${guard ? 'guarded' : 'bare'}.mjs`);
    await build({ ...bundleOpts, stdin: { contents: `${guard ? "import './main-guard.mjs';\n" : ''}await import('./host-services/runner.mjs'); console.log('agent still running');`, resolveDir: path.join(ROOT, 'network'), loader: 'js' }, outfile: file });
    try { return { code: 0, out: execFileSync(process.execPath, [file, '--config', path.join(dir, 'privacy-config.json')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
    catch (e) { return { code: e.status, out: String(e.stdout) + String(e.stderr) }; } };
  const bare = await probe(false);
  assert.equal(bare.code, 2, 'the counterexample: the bundled runner ran its own command line'); assert.match(bare.out, /usage: runner\.mjs check\|run\|advertise/);
  const guarded = await probe(true);
  assert.deepEqual(guarded, { code: 0, out: 'agent still running\n' });
  // the build check: the agent bundled from its source (two main checks: its own and runner.mjs's) is refused; from its entry, accepted
  const bare2 = path.join(dir, 'agent-bare.mjs'), entry = path.join(dir, 'privacy-agent.mjs');
  await build({ ...bundleOpts, entryPoints: [path.join(ROOT, 'network/privacy-agent.mjs')], outfile: bare2 });
  assert.throws(() => checkBundle(bare2), /2 bundled "main module" checks/);
  await build({ ...bundleOpts, entryPoints: [path.join(ROOT, 'network/entries/privacy-agent.mjs')], outfile: entry });
  assert.equal(checkBundle(entry, { guarded: true }).guarded, true);
  assert.throws(() => checkBundle(bare2, { guarded: true }), /main guard is not in the bundle/);
  // imported (not run): no daemon starts, the library is there
  const imported = execFileSync(process.execPath, ['--input-type=module', '-e', `const m=await import(${JSON.stringify(pathToFileURL(entry).href)}); console.log(typeof m.runPrivacy, typeof m.PrivacyAgent);`], { encoding: 'utf8', cwd: dir });
  assert.equal(imported.trim(), 'function function');
});

test('the shipped bundle runs the app-less daemon: admitted -> host services', { timeout: 90_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bundle-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'privacy-agent.mjs');
  await build({ ...bundleOpts, entryPoints: [path.join(ROOT, 'network/entries/privacy-agent.mjs')], outfile: file });
  const w = await policyWorld(t); await w.publish({ deny: [] });
  const rig = await hostRig(t), d = daemon(t, rig, { env: fast(w), script: file });
  await d.until(/no apps: running this host's services only/); await d.until(STARTED);
  assert.ok((await d.stop())?.code === 0);
});

// ---- enrollment: the fresh box's only opt-in (ENCLAVE_HOST_SERVICES_FILE) and the zero-app write ----
function enrollRig(t, { hostServicesFile = null, rows = [], refusal = () => null, worker = true, endpoint = ENDPOINT, addressBook = PRODUCTION_BOOK } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-cold-enroll-')), agentDir = path.join(dir, 'agent'), policyFile = path.join(dir, 'policy.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(agentDir); fs.writeFileSync(policyFile, JSON.stringify({ cpu: { runtimeId: 'ab'.repeat(32) }, gpu: {} }));
  if (worker) { fs.mkdirSync(path.join(dir, 'bin')); fs.writeFileSync(path.join(dir, 'bin', 'host-service-ingress.mjs'), '// the staged worker'); }
  const D = '0x' + '11'.repeat(32), APP = '0x' + '5a'.repeat(32), CID = 'bafkreibjbefi32gvjrd54lhdizq6zlywym6urcuztzvi455xfv23tyjnza';
  const vm = { name: D, status: 'running', appReady: true, catalog: { app: APP, version: 4 }, cid: CID, appId: 'ef'.repeat(32), runtimeId: 'ab'.repeat(32), componentSha256: rawDigest(CID), derivation: 'enclave-catalog-bundle/1', gpuMilli: 0, startedAt: 1 };
  const w = { dir, restarts: 0, logs: [], rows, refusal, row: { id: D, appRef: `catalog://${APP}/4`, configCid: '{}', runner: RUNNER, active: true, isPublic: true, leaseUntil: 9999999999n } };
  const config = { agentDir, binDir: path.join(dir, 'bin'), nodeBinary: 'node.exe', operatorKeyFile: 'op.key', runner: RUNNER, endpoint, relayBase: 'https://api.enclave.host',
    policyFile, tpmBinary: 'tpmattest.exe', tpmSha256: 'aa'.repeat(32), addressBook, chainRpc: ['https://rpc'], enclaveNetwork: { checkers: ['0x' + '57'.repeat(20)] }, hostServicesFile };
  w.enroll = createNetworkEnroll({ agentDir, binDir: path.join(dir, 'bin'), runner: RUNNER, relayBase: 'https://api.enclave.host', restartAgent: async () => { w.restarts++; }, config, log: (m) => w.logs.push(m),
    fetch: async () => ({ ok: true, json: async () => ({ domains: {} }) }), rows: async () => w.rows, version: async () => ({ cid: CID }), vms: async () => [vm],
    hostServiceRefusal: () => w.refusal() });
  w.file = path.join(agentDir, 'privacy-config.json'); w.exists = () => fs.existsSync(w.file); w.read = () => JSON.parse(fs.readFileSync(w.file, 'utf8')); w.raw = () => fs.readFileSync(w.file, 'utf8');
  return w;
}
const optInFile = (t, body) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-optin-')); t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const f = path.join(d, 'host-services.json'); if (body !== undefined) fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body)); return f; };

test('enrollment, fresh box: no opt-in -> nothing written (as before); a valid opt-in -> an app-less config for host services; the first app joins it without a restart', async (t) => {
  let w = enrollRig(t);
  assert.equal((await w.enroll.pass()).changed, false); assert.equal(w.exists(), false, 'no app, no opt-in: the agent keeps waiting');
  const challengeReplica = { reviewed: true, note: 'carried byte-for-byte, judged by the agent' };
  w = enrollRig(t, { hostServicesFile: optInFile(t, { hostServices: HS, challengeReplica }) });
  const r = await w.enroll.pass();
  assert.equal(r.changed, true); assert.equal(r.apps, 0);
  const c = w.read();
  assert.deepEqual(c.apps, []); assert.deepEqual(c.enclaveNetwork.hostServices, HS); assert.deepEqual(c.enclaveNetwork.challengeReplica, challengeReplica);
  assert.equal(path.basename(c.enclaveNetwork.serviceWorkerModule), 'host-service-ingress.mjs');
  assert.equal(Object.keys(c.enclaveNetwork).at(-1), 'challengeReplica', 'the agent-facing section keeps its order (walletAdmission would stay last)');
  assert.ok(w.logs.some((l) => /written for this host's services only \(no app yet\)/.test(l)));
  const steady = w.raw();
  for (let i = 0; i < 3; i++) assert.equal((await w.enroll.pass()).changed, false);
  assert.equal(w.raw(), steady, 'steady across passes'); assert.equal(w.restarts, 0);
  w.rows = [w.row];                                                                               // the first app is leased
  assert.equal((await w.enroll.pass()).changed, true);
  assert.equal(w.read().apps.length, 1); assert.deepEqual(w.read().enclaveNetwork.hostServices, HS, 'host services kept');
  assert.equal(w.restarts, 0, 'the first app is a reload, not a restart (host services keep running)');
});

test('enrollment, fresh box: a refused host, an invalid block or an unusable opt-in file writes no app-less config', async (t) => {
  let w = enrollRig(t, { hostServicesFile: optInFile(t, { hostServices: HS }), refusal: () => 'platform host policy: banned by platform policy #2 (operator): abuse' });
  assert.equal((await w.enroll.pass()).changed, false); assert.equal(w.exists(), false);
  assert.ok(w.logs.some((l) => /no app yet, and the platform host policy refuses this host \(platform host policy: banned/.test(l)));
  w.refusal = () => null; assert.equal((await w.enroll.pass()).changed, true, 'the admin\'s admit: written on the next pass');
  w = enrollRig(t, { hostServicesFile: optInFile(t, { hostServices: { ...HS, exits: [] } }) });
  const r = await w.enroll.pass();
  assert.equal(r.changed, false); assert.equal(w.exists(), false); assert.match(r.hostServicesError, /exits/);
  for (const [body, re] of [[undefined, /missing/], ['{not json', /JSON|Unexpected|Expected/], [{ hostServices: HS, extra: 1 }, /must be \{ hostServices, challengeReplica\?, hostServicesPolicy\? \}/],
    [{ challengeReplica: {} }, /must be \{ hostServices/], [{ hostServices: HS, challengeReplica: [] }, /challengeReplica must be an object/]]) {
    w = enrollRig(t, { hostServicesFile: optInFile(t, body) });
    const x = await w.enroll.pass();
    assert.equal(w.exists(), false); assert.match(x.hostServicesOptInError, re);
    assert.ok(w.logs.some((l) => /HOST SERVICES OPT-IN NOT APPLIED/.test(l)));
  }
  assert.match((await readHostServicesFile('relative/host-services.json')).error, /absolute path/);
  // a config the agent would refuse is never written (the \Enclave\Network task would restart it every 10 s)
  for (const [opts, re] of [[{ worker: false }, /worker is not staged/], [{ endpoint: ENDPOINT + '/' }, /runner is not keccak256/],
    [{ addressBook: '0x' + '44'.repeat(20) }, /platform host policy is off for this config/]]) {
    w = enrollRig(t, { hostServicesFile: optInFile(t, { hostServices: HS }), ...opts });
    assert.equal((await w.enroll.pass()).changed, false); assert.equal(w.exists(), false);
    assert.ok(w.logs.some((l) => re.test(l) && /the privacy agent would refuse them/.test(l)), w.logs.join('\n'));
  }
});

test('enrollment, existing box: the opt-in file is the source while configured (a change restarts once); an unusable file keeps the config\'s blocks', async (t) => {
  const file = optInFile(t, { hostServices: HS });
  const w = enrollRig(t, { hostServicesFile: file, rows: [] });
  w.rows = [w.row]; await w.enroll.pass();
  assert.deepEqual(w.read().enclaveNetwork.hostServices, HS); assert.equal(w.restarts, 0, 'fresh: no restart');
  const HS2 = { ...HS, exits: ['e1'.repeat(16), 'e3'.repeat(16)] };
  fs.writeFileSync(file, JSON.stringify({ hostServices: HS2 }));
  await w.enroll.pass(); assert.deepEqual(w.read().enclaveNetwork.hostServices, HS2); assert.equal(w.restarts, 1, 'restarted once on the new block');
  await w.enroll.pass(); assert.equal(w.restarts, 1);
  const before = w.raw();
  fs.writeFileSync(file, '{broken');
  const r = await w.enroll.pass();
  assert.equal(w.raw(), before, 'an unusable file never drops or rewrites the running block'); assert.equal(w.restarts, 1); assert.ok(r.hostServicesOptInError);
});

// ---- release dependencies: every npm input exactly as the committed lockfile pins it ----
test('locked inputs: the governing lockfile per node_modules tree; a version drift, an extraneous package or an outside input is refused', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'locked-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const put = (rel, obj) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), typeof obj === 'string' ? obj : JSON.stringify(obj)); };
  put('package-lock.json', { lockfileVersion: 3, packages: { '': {}, 'node_modules/viem': { version: '2.53.1' }, 'node_modules/@noble/curves': { version: '1.9.1' }, 'node_modules/a/node_modules/b': { version: '2.0.0' } } });
  put('relay/package-lock.json', { lockfileVersion: 3, packages: { 'node_modules/ws': { version: '8.21.1' } } });
  put('node_modules/viem/package.json', { name: 'viem', version: '2.53.1' }); put('node_modules/@noble/curves/package.json', { name: '@noble/curves', version: '1.9.1' });
  put('node_modules/a/node_modules/b/package.json', { name: 'b', version: '2.0.0' }); put('relay/node_modules/ws/package.json', { name: 'ws', version: '8.21.1' });
  const r = lockedInputs(dir, ['src/x.mjs', 'node_modules/viem/_esm/index.js', 'node_modules/@noble/curves/esm/secp256k1.js', 'node_modules/a/node_modules/b/i.js', 'relay/node_modules/ws/lib/x.js']);
  assert.deepEqual(r.packages, { 'node_modules/@noble/curves': '1.9.1', 'node_modules/a/node_modules/b': '2.0.0', 'node_modules/viem': '2.53.1', 'relay/node_modules/ws': '8.21.1' });
  assert.deepEqual(Object.keys(r.lockfiles).sort(), ['package-lock.json', 'relay/package-lock.json']);
  put('relay/node_modules/ws/package.json', { name: 'ws', version: '8.18.0' });
  assert.throws(() => lockedInputs(dir, ['relay/node_modules/ws/lib/x.js']), /relay\/node_modules\/ws is ws@8\.18\.0, but relay\/package-lock\.json pins ws@8\.21\.1: install with npm ci/);
  put('node_modules/extra/package.json', { name: 'extra', version: '1.0.0' });
  assert.throws(() => lockedInputs(dir, ['node_modules/extra/i.js']), /extraneous/);
  assert.throws(() => lockedInputs(dir, ['../outside/node_modules/x/i.js']), /outside the tree/);
  assert.throws(() => lockedInputs(dir, ['sdk/node_modules/x/i.js']), /no lockfile governs sdk\//);
  // the repository itself: every npm input of the shipped privacy agent is locked
  const ours = lockedInputs(ROOT, ['node_modules/viem/package.json', 'node_modules/ws/package.json']);
  assert.ok(ours.packages['node_modules/viem'] && ours.lockfiles['package-lock.json']);
});
