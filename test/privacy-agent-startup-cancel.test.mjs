// A stop that arrives while the REAL daemon (node network/privacy-agent.mjs --config FILE) is still starting. Each case holds
// the daemon at one startup await, deterministically: a test preload wraps that production method so its promise is
// returned only after SIGTERM has been delivered and the daemon's own handler has run (no sleep decides the order). Then:
//   * network  - createNetworkHost, its direct runtime and qualification canary already listening (DirectRuntime.listen);
//   * control  - the Enclave-network control transport's first round (WgControlTransport.start);
//   * authorization - the agent's first chain/policy round (PrivacyAgent.refreshAuthorization, inside start);
//   * final-snapshot - the agent's last startup status write (the snapshot start awaits after its proofs).
// A stop there is the stop the operator asked for: the daemon releases everything it holds, its listeners included, and
// EXITS BY ITSELF with code 0 (before this, code 1, "privacy agent stopped during startup", as if startup had failed).
// A genuine failure is still a failure even when a stop arrived meanwhile: the same final-snapshot hold with a status file
// that cannot be written exits 1 with its own error. And a release that FAILS is never a clean stop: with a fault injected
// into the network manager's close or the agent's closing status write (FAULT), every later step is still attempted (the
// local router and the network host's listeners close) and the daemon exits 1 - during startup and after it. Same configuration as test/privacy-agent-lifecycle.test.mjs (no Enclave
// authority, every *.enclave.host lookup refused and logged), plus control circuits to a local directory that refuses.
//   run: node --test --test-concurrency=1 test/privacy-agent-startup-cancel.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import dgram from 'node:dgram';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generatePrivateKey } from 'viem/accounts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENT = path.join(ROOT, 'network', 'privacy-agent.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-startup-cancel-'));
const f = (n) => path.join(dir, n);
const ZONE = 'probe.alice-net.org', NAME = `probe-node1.${ZONE}`;
const freeTcp = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const freeUdp = async () => { const u = dgram.createSocket('udp4'); await new Promise((r) => u.bind(0, '127.0.0.1', r)); const p = u.address().port; await new Promise((r) => u.close(r)); return p; };
const tcpFree = (port) => new Promise((ok) => { const s = net.createServer().once('error', () => ok(false)).listen(port, '127.0.0.1', () => s.close(() => ok(true))); });
const udpFree = (port) => new Promise((ok) => { const u = dgram.createSocket('udp4'); u.once('error', () => { u.close(); ok(false); }); u.bind(port, '127.0.0.1', () => u.close(() => ok(true))); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

// the lifecycle test's preload (enclave.host refused and logged), then the hold for HOLD_BOUNDARY
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
// a stop that does not exit says what is still holding the process (diagnostics only)
process.on('SIGUSR2', () => console.error('ACTIVE RESOURCES ' + JSON.stringify(process.getActiveResourcesInfo())));
const B = process.env.HOLD_BOUNDARY;
// released only by SIGTERM, and only after the daemon's own SIGTERM handler (registered after this one) has run
let release; const stopped = new Promise((r) => { release = r; });
process.on('SIGTERM', () => setImmediate(release));
let held = false;
const hold = (what, p) => { if (what !== B || held) return p; held = true; p.catch(() => {}); console.error('HOLD ' + what);
  return stopped.then(() => { console.error('RELEASE ' + what); return p; }); };
const { DirectRuntime } = await import(${JSON.stringify(url('network/direct-runtime.mjs'))});
const { WgControlTransport } = await import(${JSON.stringify(url('network/wg-control.mjs'))});
const { EnclaveNetworkManager } = await import(${JSON.stringify(url('network/wg-manager.mjs'))});
const { LocalAppRouter } = await import(${JSON.stringify(url('network/local-app-router.mjs'))});
const { PrivacyAgent } = await import(${JSON.stringify(url('network/privacy-agent.mjs'))});
const FAULT = process.env.FAULT;
const managerClose = EnclaveNetworkManager.prototype.close, routerClose = LocalAppRouter.prototype.close;
EnclaveNetworkManager.prototype.close = async function () { await managerClose.call(this);
  if (FAULT === 'manager-close') throw new Error('injected manager close failure'); };
LocalAppRouter.prototype.close = function () { const r = routerClose.call(this); console.error('ROUTER CLOSED'); return r; };
const listen = DirectRuntime.prototype.listen, wgStart = WgControlTransport.prototype.start, P = PrivacyAgent.prototype;
const { start, refreshAuthorization, refreshProofs, snapshot } = P;
DirectRuntime.prototype.listen = function () { return hold('network', listen.call(this)); };
WgControlTransport.prototype.start = function () { return hold('control', wgStart.call(this)); };
// start() awaits refreshAuthorization, then refreshProofs, then its final snapshot: the phase moves on as each one settles
// (these callbacks are attached before start's own continuation, so they run first)
P.start = function () { this.startupPhase = 'authorization'; return start.call(this).then((r) => { console.error('AGENT STARTED'); return r; }); };
P.refreshAuthorization = function () { const p = refreshAuthorization.call(this);
  if (this.startupPhase !== 'authorization') return p;
  this.startupPhase = 'authorizing'; p.then(() => { this.startupPhase = 'proofs'; }, () => {}); return hold('authorization', p); };
P.refreshProofs = function () { const p = refreshProofs.call(this);
  if (this.startupPhase === 'proofs') { this.startupPhase = 'proving'; p.then(() => { this.startupPhase = 'final'; }, () => {}); } return p; };
P.snapshot = function () { const p = snapshot.call(this);
  if (FAULT === 'status-write' && this.closed) return p.then(() => { throw new Error('injected status write failure'); });
  if (this.startupPhase !== 'final') return p; this.startupPhase = 'done'; return hold('final-snapshot', p); };
console.error('PRELOAD HOOKED ' + (B || 'none'));`;

before(() => {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-subj', `/CN=${NAME}`, '-days', '1',
    '-keyout', f('canary.key'), '-out', f('canary.pem')], { stdio: 'ignore' });
  fs.writeFileSync(f('token'), 'ab'.repeat(32), { mode: 0o600 });
  fs.writeFileSync(f('operator.key'), generatePrivateKey(), { mode: 0o600 });
  fs.writeFileSync(f('expected.json'), JSON.stringify({ appRef: 'catalog://0x' + '12'.repeat(32) + '/1', configCid: '' }));
  for (const n of ['runtime.json', 'min-tcb.json']) fs.writeFileSync(f(n), '{}');
  fs.writeFileSync(f('vcek.der'), 'not used before an app is probed');
  fs.writeFileSync(f('preload.mjs'), PRELOAD);
  // the GENERATED preload must parse (a preload that does not is a harness failure that looks like a daemon failure)
  const check = spawnSync(process.execPath, ['--check', f('preload.mjs')], { encoding: 'utf8' });
  assert.equal(check.status, 0, `generated preload does not parse:\n${check.stderr}`);
});

async function daemonCase(name, { statusDir = false } = {}) {
  const state = f(`state-${name}`); fs.mkdirSync(state);
  if (statusDir) fs.mkdirSync(path.join(state, 'status.json'));       // the agent cannot write its status: a genuine failure
  const ports = { https: await freeTcp(), http: await freeTcp(), udp: await freeUdp(), upstream: await freeTcp(), directory: await freeTcp() };
  const file = f(`privacy-config-${name}.json`), blockLog = f(`blocked-${name}.log`); fs.writeFileSync(blockLog, '');
  fs.writeFileSync(file, JSON.stringify({ version: 2, directory: state, operatorKeyFile: f('operator.key'), runner: '0x' + '42'.repeat(32),
    apps: [{ deploymentId: '0x' + 'ab'.repeat(32), names: ['app1.alice-net.org'], expectedFile: f('expected.json') }],
    dns: ['9.9.9.9'], upstream: `http://127.0.0.1:${ports.upstream}`,
    chain: { rpc: ['https://127.0.0.2:1', 'https://127.0.0.3:1'], addressBook: '0x' + '00'.repeat(20),
             authorityPins: { deployments: '0x' + '11'.repeat(20), registry: '0x' + '22'.repeat(20), connectivity: '0x' + '00'.repeat(20), sessionVaultFactory: '0x' + '00'.repeat(20) } },
    linux: { runtimeFile: f('runtime.json'), minTcbFile: f('min-tcb.json'), vcekFile: f('vcek.der') },
    enclaveNetwork: { directories: [`http://127.0.0.1:${ports.directory}/`], checkers: ['0x' + '45'.repeat(20)], apps: 'all', control: true,
      wgBinary: process.execPath, nodeBinary: process.execPath, workerModule: path.join(ROOT, 'network', 'windows-circuit-worker.mjs'),
      direct: { address: '44.0.0.7', bindHost: '127.0.0.1', httpsPort: ports.https, httpPort: ports.http, qualificationFile: f(`qualification-${name}.json`),
        probe: { independent: true, probeZone: ZONE, hostname: NAME, keyFile: f('canary.key'), certFile: f('canary.pem'), tokenFile: f('token'),
                 udpPort: ports.udp, bindHost: '127.0.0.1', manifestFile: f(`manifest-${name}.json`) } } } }), { mode: 0o600 });
  return { ports, file, blockLog, state };
}
const released = async (p) => ({ https: await tcpFree(p.https), http: await tcpFree(p.http), udp: await udpFree(p.udp) });
const within = (p, ms) => Promise.race([p, sleep(ms).then(() => null)]);

/** Start the daemon held at `boundary` ('started': not held, once its start has completed), SIGTERM it there;
 *  -> {exit, out, ports, blockLog}. */
async function stopWhileHeld(boundary, opts = {}) {
  const c = await daemonCase(boundary + (opts.statusDir ? '-genuine' : '') + (opts.fault ? '-' + opts.fault : ''), opts);
  const child = spawn(process.execPath, ['--import', pathToFileURL(f('preload.mjs')).href, AGENT, '--config', c.file],
    { env: { ...process.env, BLOCK_LOG: c.blockLog, HOLD_BOUNDARY: boundary, FAULT: opts.fault || '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = boundary === 'started' ? 'AGENT STARTED' : 'HOLD ' + boundary;
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((ok) => child.once('exit', (code, signal) => ok({ code, signal })));
  try {
    const t0 = Date.now();
    while (!out.includes(ready) && child.exitCode === null && Date.now() - t0 < 45_000) await sleep(50);
    assert.ok(out.includes(ready), `the daemon never reached ${boundary}:\n${out.slice(-3000)}`);
    assert.equal(child.exitCode, null, out.slice(-3000));
    child.kill('SIGTERM');
    const exit = await within(exited, 20_000);
    if (!exit) { child.kill('SIGUSR2'); await sleep(500); }     // diagnostics for the failure message only
    assert.ok(exit, `the daemon did not exit after SIGTERM at ${boundary}:\n${out.slice(-3000)}`);
    if (boundary !== 'started') assert.match(out, new RegExp('RELEASE ' + boundary), 'the held step returned after the stop');
    assert.equal((out.match(/PRELOAD HOOKED/g) || []).length, 1, 'one daemon, hooked once');
    assert.ok((out.match(/qualification canary /g) || []).length <= 1, 'the agent module ran its daemon once (the preload shares its module instance)');
    return { exit, out, ports: c.ports, blockLog: c.blockLog };
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await within(exited, 5000); }
}

for (const boundary of ['network', 'control', 'authorization', 'final-snapshot']) {
  test(`SIGTERM while startup is held at ${boundary}: the daemon releases everything and exits 0 by itself`, { timeout: 90_000 }, async () => {
    const { exit, out, ports, blockLog } = await stopWhileHeld(boundary);
    assert.equal(exit.signal, null, 'it exited by itself, not by a signal default');
    assert.equal(exit.code, 0, `a stop during startup is not a startup failure:\n${out.slice(-3000)}`);
    assert.match(out, /privacy agent stopped during startup/, 'and it says the stop came during startup');
    assert.deepEqual(await released(ports), { https: true, http: true, udp: true }, 'the canary and the direct runtime are closed');
    assert.equal(fs.readFileSync(blockLog, 'utf8'), '', 'no enclave.host name was looked up or connected to');
  });
}

test('a GENUINE startup failure while a stop is pending still exits 1 with its own error, after releasing everything', { timeout: 90_000 }, async () => {
  const { exit, out, ports } = await stopWhileHeld('final-snapshot', { statusDir: true });
  assert.equal(exit.signal, null);
  assert.equal(exit.code, 1, out.slice(-3000)); assert.match(out, /EISDIR/);
  assert.doesNotMatch(out, /privacy agent stopped during startup/, 'the failure is reported as itself, not as the stop');
  assert.deepEqual(await released(ports), { https: true, http: true, udp: true });
});

for (const [fault, said] of [['manager-close', /injected manager close failure/], ['status-write', /injected status write failure/]]) {
  // the daemon's final error: the stop during startup AND what failed releasing it (no exact wording)
  const reported = new RegExp('stopped during startup[^\\n]*' + said.source);
  test(`a stop during startup whose release fails (${fault}) still closes everything else and exits 1, not as a clean stop`, { timeout: 90_000 }, async () => {
    const { exit, out, ports } = await stopWhileHeld('final-snapshot', { fault });
    assert.equal(exit.signal, null);
    assert.equal(exit.code, 1, out.slice(-3000)); assert.match(out, said);
    assert.match(out, reported, 'reported as a cancelled startup whose release failed, not as a clean cancellation');
    assert.match(out, /ROUTER CLOSED/, 'the agent\'s later close steps still ran');
    assert.deepEqual(await released(ports), { https: true, http: true, udp: true }, 'and the network host closed its listeners');
  });
}

test('a stop AFTER startup whose release fails (manager-close) still closes everything else and exits 1', { timeout: 90_000 }, async () => {
  const { exit, out, ports } = await stopWhileHeld('started', { fault: 'manager-close' });
  assert.equal(exit.signal, null);
  assert.equal(exit.code, 1, out.slice(-3000)); assert.match(out, /injected manager close failure/); assert.match(out, /stop incomplete/);
  assert.match(out, /ROUTER CLOSED/);
  assert.deepEqual(await released(ports), { https: true, http: true, udp: true });
});
