// Host-service lifecycle (stop/ban races) on the REAL control flow: HostServiceTransport over the real WgCircuitRuntime
// (plain mode), real WgGrants signing real requests to two real WgProvider instances behind their real control HTTP
// servers on loopback (guard 127.0.0.1, exit 127.0.0.2), and the real host-service ingress worker process. Only the
// WireGuard data plane is a stand-in: a small "wg" process that forwards the exit's control API (what the guard tunnel
// carries) and reports readiness. The privacy agent's host-service judge is the ACTUAL code block of
// network/privacy-agent.mjs (sliced from the source, run with its free variables bound), so this file is also the
// control on an older tree. Nothing here reaches a real network, chain, key or production host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import * as hst from '../network/host-service-transport.mjs';
import { WgCircuitRuntime } from '../network/wg-circuit-runtime.mjs';
import { WgGrants } from '../network/wg-grants.mjs';
import { WgProvider } from '../network/wg-provider/provider.mjs';
import { createControl } from '../network/wg-provider/control.mjs';
import { hostServiceNames, hostRpcName } from '../network/host-service-names.mjs';

const { HostServiceTransport } = hst;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '0x' + 'a1'.repeat(32), ZONE = 'svc.example', APP = '0x' + 'ab'.repeat(32), ZERO = '0x' + '0'.repeat(64);
const BAN = 'platform host policy: banned by platform policy #7 (operator): abuse';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deferred = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return Object.assign(p, { resolve }); };
async function until(cond, ms = 20_000, what = 'condition') { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return; await sleep(25); } assert.fail('timed out waiting for ' + what); }

// The stand-in data plane: outer -> forward the exit's control API to controlListen (the guard tunnel's job); inner ->
// ready (egress: a loopback echo stands in for the tunnel's SOCKS). A hold file delays outer-ready (a slow handshake).
const FAKE_WG = `#!${process.execPath}
import net from 'node:net'; import fs from 'node:fs'; import path from 'node:path'; import readline from 'node:readline';
fs.writeFileSync(path.join(process.env.HSL_PIDS, String(process.pid)), '');
const out = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
const listen = (addr, onConn) => new Promise((r) => { const [h, p] = addr.split(':'); net.createServer(onConn).listen(+p, h, r); });
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const v = JSON.parse(line);
  if (v.type === 'outer') {
    while (fs.existsSync(process.env.HSL_HOLD_OUTER)) await new Promise((r) => setTimeout(r, 20));
    const [th, tp] = v.control.split(':');
    await listen(v.controlListen, (s) => { const u = net.connect(+tp, th); s.pipe(u).pipe(s); s.on('error', () => u.destroy()); u.on('error', () => s.destroy()); });
    out({ type: 'outer-ready', control: v.controlListen, guardSocks: v.guardSocks.listen });
  } else if (v.type === 'inner') {
    if (v.egress) await listen(v.egress.listen, (s) => s.pipe(s));
    out({ type: 'ready', ...(v.egress ? { egress: v.egress.listen } : {}) });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

// processes (children of this test) whose command line mentions the world's directory: the stand-in wg and the workers
function procsUnder(dir) {
  const found = [];
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid) || +pid === process.pid) continue;
    try { if (fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(dir)) found.push(+pid); } catch {}
  }
  return found;
}

// exitRpc: the exits' operators opted in to carrying hosts' public RPC names (hostServices.rpc); hostRpc: this host serves the
// public-rpc role (its ports name it, so it asks for rpc-<b32>)
async function world(t, { exitZone = ZONE, exits = 1, serviceWorker = path.join(ROOT, 'network/host-service-ingress.mjs'), exitRpc = false, hostRpc = false } = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'hsl-'));
  fs.mkdirSync(path.join(dir, 'pids'));
  const wgBinary = path.join(dir, 'fake-wg.mjs'); fs.writeFileSync(wgBinary, FAKE_WG, { mode: 0o755 });
  process.env.HSL_PIDS = path.join(dir, 'pids'); process.env.HSL_HOLD_OUTER = path.join(dir, 'hold-outer');
  const account = privateKeyToAccount(generatePrivateKey());
  const now = () => Date.now();
  const lease = { active: true, runner: HOST, runnerOperator: account.address.toLowerCase(), validUntil: now() + 3600e3, leaseUntil: now() + 3600e3, isPublic: false, owner: '0x' + '55'.repeat(20) };
  const kernel = () => ({ peers: new Map(), setPeer: async function (p) { this.peers.set(p.key, { ...p }); }, removePeer: async function (p) { this.peers.delete(p.key); }, sync: async () => {}, listPeers: async () => [] });
  const servers = [], w = { dir, account, logs: [], exitAdmit: { admit: true }, hold: null, asked: [], revokes: [] };
  const log = (m) => w.logs.push(m);
  async function provider(id, address, roles, extra = {}) {
    const signer = privateKeyToAccount(generatePrivateKey());
    const ports = { exit: 51820, guard: 51821, control: 0 };
    const p = new WgProvider({ config: { providerId: id, roles, pricePerGiB6: 0, publicAddress: address, exitKey: Buffer.alloc(32, id.charCodeAt(0)).toString('base64'),
      guardKey: Buffer.alloc(32, id.charCodeAt(1) + 1).toString('base64'), ports, checkers: [], ...extra }, signer, kernel: kernel(),
      leases: async (x) => (x === APP ? { ...lease } : null), hosts: async (x) => (x === HOST ? { active: true, operator: account.address.toLowerCase() } : null),
      policyMemory: { get: async () => undefined, set: async () => {} }, log });
    const ctl = await createControl({ provider: p, info: () => ({}), port: 0, host: address, log }); servers.push(ctl);
    ports.control = ctl.port;
    const record = { providerId: id, operator: signer.address.toLowerCase(), address, ports: { ...ports }, wgExitKey: p.config.exitKey, wgGuardKey: p.config.guardKey,
      eligibleRoles: roles, pricePerGiB6: 0, qualifiedUntil: now() + 3600e3, region: id.slice(0, 2) };
    return { p, record };
  }
  w.guard = await provider('a1'.repeat(16), '127.0.0.1', ['guard']);
  // the exit's own half of the platform host policy (wg-provider admitHost): an admit, and a seam that holds the decision
  // so a grant request is IN FLIGHT at the exit while the host stops
  const exitHostAdmission = async (ids) => { w.asked.push(Date.now()); if (w.hold) await w.hold; return { [ids[0]]: { ...w.exitAdmit } }; };
  w.exitList = [];
  for (let i = 0; i < exits; i++) {
    const e = await provider(`e${i + 1}`.repeat(16), `127.0.0.${2 + i}`, ['ingress', 'egress'], { hostServices: { zone: exitZone, ...(exitRpc ? { rpc: true } : {}) } });
    e.p.hostAdmission = exitHostAdmission;
    const revoke = e.p.revoke.bind(e.p); e.p.revoke = async (env) => { const r = await revoke(env); w.revokes.push({ exit: e.record.providerId, key: env.request.wgPublicKey }); return r; };
    w.exitList.push(e);
  }
  w.exit = w.exitList[0];
  w.servicePeers = (e = w.exit) => [...e.p.peers.values()].filter((p) => p.role === 'service');
  w.providers = () => [w.guard.record, ...w.exitList.map((e) => e.record)];
  // the loopback role a public visitor reaches through the circuit (directory replica)
  const role = http.createServer((req, res) => res.end('directory-replica ' + req.headers.host)); servers.push({ close: () => { role.closeAllConnections?.(); role.close(); } });
  await new Promise((r) => role.listen(0, '127.0.0.1', r));
  w.rolePort = role.address().port;
  // the host's public RPC role stand-in (the transport routes bytes; network/public-rpc.mjs itself is test/public-rpc.test.mjs)
  const rpcRole = http.createServer((req, res) => res.end('public-rpc ' + req.headers.host)); servers.push({ close: () => { rpcRole.closeAllConnections?.(); rpcRole.close(); } });
  await new Promise((r) => rpcRole.listen(0, '127.0.0.1', r));
  w.config = { zone: ZONE, exits: w.exitList.map((e) => e.record.providerId), ports: { 'directory-replica': w.rolePort, ...(hostRpc ? { 'public-rpc': rpcRole.address().port } : {}) } };
  w.runtime = new WgCircuitRuntime({ directory: path.join(dir, 'rt'), wgBinary, nodeBinary: process.execPath, workerModule: path.join(ROOT, 'network/windows-circuit-worker.mjs'),
    serviceWorkerModule: serviceWorker, platform: 'plain', grants: new WgGrants({ account, runner: HOST }), authorize: () => true, forward: (s) => s.destroy(), log });
  w.grants = w.runtime.grants;
  w.transport = (over = {}) => new HostServiceTransport({ runtime: w.runtime, providers: async () => w.providers(), grants: w.grants, hostId: HOST, config: w.config, log, ...over });
  w.pause = () => { w.hold = deferred(); return w.hold; };
  w.release = () => { const h = w.hold; w.hold = null; h?.resolve(); };
  w.procs = () => procsUnder(dir);
  // a public visitor: HTTP through the circuit's ingress worker (its port-80 side), Host = the derived name
  w.visit = (c, name = hostServiceNames(HOST, ZONE)['directory-replica']) => new Promise((resolve) => {
    const cfg = JSON.parse(fs.readFileSync(path.join(c.isolation.directory, 'worker.json'), 'utf8'));
    // a fresh connection per visit (agent false): the ingress routes a raw connection by its FIRST request's Host
    http.get({ host: '127.0.0.1', port: cfg.httpPort, path: '/', headers: { host: name }, timeout: 3000, agent: false }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve(b)); })
      .on('error', (e) => resolve('error ' + e.code)).on('timeout', function () { this.destroy(); resolve('timeout'); });
  });
  t.after(async () => { w.release(); try { fs.rmSync(process.env.HSL_HOLD_OUTER, { force: true }); } catch {} await w.runtime.close(); for (const s of servers) s.close();
    for (const pid of w.procs()) { try { process.kill(pid, 'SIGKILL'); } catch {} } fs.rmSync(dir, { recursive: true, force: true }); });
  return w;
}

// The privacy agent's host-service block exactly as network/privacy-agent.mjs has it (from `if(hostServicesConfig){` up to
// `hostGate.start();`), with its free variables bound to `env`. -> {judge, env}; the switch's state is env.hostServices.
function agentJudge(w, { refusal }) {
  const src = fs.readFileSync(path.join(ROOT, 'network/privacy-agent.mjs'), 'utf8');
  const end = src.indexOf('    hostGate.start();\n'), begin = src.lastIndexOf('  if(hostServicesConfig){\n', end);
  assert.ok(begin > 0 && end > begin, 'the host-service block of privacy-agent.mjs');
  const body = src.slice(begin + '  if(hostServicesConfig){\n'.length, end);
  const env = { hostServices: null, hostServicesConfig: w.config, stopping: false, hostGate: { serviceRefusal: refusal }, cfg: { runner: HOST },
    network: { runtime: w.runtime, providers: async () => w.providers(), grants: w.grants }, log: (m) => w.logs.push(m),
    HostServiceTransport, hostServiceLifecycle: hst.hostServiceLifecycle };
  // eslint-disable-next-line no-new-func
  const judge = new Function('env', `with (env) {\n${body}\nreturn judge;\n}`)(env);
  env.current = () => (typeof env.hostServices?.judge === 'function' ? env.hostServices.current : env.hostServices);
  env.stop = async () => { env.stopping = true; await env.hostServices?.close(); };
  return { judge, env };
}
const ups = (w) => w.logs.filter((l) => /^host service circuit up/.test(l)).length;

test('root race, real runtime: close() while the exit grant is in flight withdraws the late circuit; no circuit, grant, child or timer survives', { timeout: 60_000 }, async (t) => {
  const w = await world(t);
  w.pause();
  const tr = w.transport();
  const starting = tr.start();
  await until(() => w.asked.length === 1, 20_000, 'the exit grant request in flight');
  const closing = tr.close(), again = tr.close();
  w.release();                                 // the exit processes the grant it was already sent (it cannot be recalled)
  await closing; await starting;
  assert.equal(tr.circuits.size, 0, 'no circuit inserted into the closed transport');
  assert.equal(tr.timer, null, 'no interval created after close');
  assert.deepEqual(w.servicePeers(), [], 'the exit holds no service peer: the late grant was withdrawn');
  assert.equal(w.revokes.length, 1, 'exactly one signed withdrawal reached the exit');
  assert.equal(ups(w), 0, 'the circuit never came up');
  await until(() => w.procs().length === 0, 10_000, 'every circuit child process gone');
  assert.equal(w.runtime.closed, false, 'the runtime itself (apps\' circuits) stays open');
  assert.equal(w.runtime.active.size, 0);
  assert.equal(again, closing, 'close() is idempotent: one promise');
});

test('close() during a slow tunnel handshake ends the startup at once: no exit grant is ever asked, nothing lingers', { timeout: 60_000 }, async (t) => {
  const w = await world(t);
  fs.writeFileSync(process.env.HSL_HOLD_OUTER, '');
  const tr = w.transport();
  const starting = tr.start();
  await until(() => w.guard.p.peers.size === 1 && w.procs().length >= 1, 20_000, 'the guard grant and the tunnel process');
  const t0 = Date.now();
  await tr.close(); await starting;
  assert.ok(Date.now() - t0 < 10_000, 'the stop does not wait for the 45-s handshake timeout');
  fs.rmSync(process.env.HSL_HOLD_OUTER, { force: true });
  await sleep(300);
  assert.equal(w.asked.length, 0, 'the exit was never asked');
  assert.deepEqual(w.servicePeers(), []);
  assert.equal(tr.circuits.size, 0); assert.equal(tr.timer, null);
  await until(() => w.procs().length === 0, 10_000, 'the tunnel process gone');
  assert.ok(w.logs.some((l) => /host service circuit startup ended: circuit startup cancelled/.test(l)), w.logs.join('\n'));
  assert.equal(tr.strikes.size, 0, 'a cancelled startup is no strike against the providers');
});

test('a ban during BACKGROUND reconcile: the live circuit is withdrawn first, the one still being built is withdrawn when it answers', { timeout: 90_000 }, async (t) => {
  const w = await world(t, { exits: 2 });
  const second = w.exitList[1].record, qualified = second.qualifiedUntil;
  second.qualifiedUntil = Date.now() - 1;                    // the second exit qualifies only later
  const tr = w.transport();
  await tr.start();
  assert.equal(tr.circuits.size, 1); assert.ok(tr.timer, 'serving: the 15-s timer runs');
  const live = [...tr.circuits.values()][0];
  assert.match(await w.visit(live), /^directory-replica /, 'the first circuit serves its role');
  second.qualifiedUntil = qualified; w.pause();
  const round = tr.reconcile();                              // what the 15-s timer does
  await until(() => w.asked.length === 2, 20_000, 'the second exit grant in flight');
  const closing = tr.close();
  await until(() => w.servicePeers(w.exitList[0]).length === 0, 20_000, 'the live circuit withdrawn while the other startup is still pending');
  assert.equal(w.servicePeers(w.exitList[1]).length, 0, 'nothing granted yet at the second exit');
  w.release();
  await closing; await round;
  assert.deepEqual(w.servicePeers(w.exitList[1]), [], 'the late grant withdrawn too');
  assert.equal(w.revokes.length, 2);
  assert.equal(tr.circuits.size, 0); assert.equal(tr.timer, null);
  assert.ok(live.closed);
  await until(() => w.procs().length === 0, 10_000, 'every child gone');
});

test('delayed failure: the exit REFUSES the grant it was holding while the host stopped: nothing to withdraw, no strike, clean stop', { timeout: 60_000 }, async (t) => {
  const w = await world(t);
  w.pause(); w.exitAdmit = { admit: false, reason: 'banned by platform policy #7 (operator): abuse' };
  const tr = w.transport();
  const starting = tr.start();
  await until(() => w.asked.length === 1, 20_000, 'the exit grant request in flight');
  const closing = tr.close(); w.release();
  await closing; await starting;
  assert.equal(w.revokes.length, 0, 'an explicit refusal left no peer: no withdrawal sent');
  assert.ok(!w.logs.some((l) => /not withdrawn/.test(l)), 'and none needed');
  assert.deepEqual(w.servicePeers(), []); assert.equal(tr.circuits.size, 0); assert.equal(tr.strikes.size, 0);
  await until(() => w.procs().length === 0, 10_000, 'every child gone');
});

test('delayed failure AFTER a grant (the exit granted other names): the runtime withdraws that grant before its tunnel ends', { timeout: 60_000 }, async (t) => {
  const w = await world(t, { exitZone: 'other.example' });
  const tr = w.transport();
  await tr.start();
  assert.equal(tr.circuits.size, 0);
  assert.ok(w.logs.some((l) => /the exit granted other names/.test(l)), w.logs.join('\n'));
  assert.deepEqual(w.servicePeers(), [], 'the mismatched grant does not stay at the exit until it expires');
  assert.equal(w.revokes.length, 1);
  assert.equal(tr.strikes.size, 1, 'a provider failure still counts against the exit (unchanged)');
  await tr.close();
  await until(() => w.procs().length === 0, 10_000, 'every child gone');
});

test('the privacy agent switch: a ban DURING the first startup stops it at once; the admin\'s re-admit starts a fresh transport that serves', { timeout: 90_000 }, async (t) => {
  const w = await world(t);
  let refusal = null;
  const { judge, env } = agentJudge(w, { refusal: () => refusal });
  w.pause();
  const first = judge();
  await until(() => w.asked.length === 1, 20_000, 'the first startup holding at the exit');
  const h1 = env.current(); assert.ok(h1, 'a transport is starting');
  refusal = BAN;                                             // the platform admin bans this host
  const banned = judge();                                    // the 2-s timer's next judgment
  await Promise.race([banned, sleep(1000)]);
  assert.equal(env.current(), null, 'the ban is acted on while the startup is still pending');
  assert.ok(h1.closed, 'the starting transport is closed (its startup cancelled)');
  w.release();                                               // the exit answers the request it already had
  await banned; await first;
  await until(() => w.revokes.length === 1, 20_000, 'the late grant withdrawn');
  assert.deepEqual(w.servicePeers(), [], 'no public service for a banned host');
  assert.equal(ups(w), 0, 'no circuit came up after the ban was known');
  assert.equal(h1.timer, null);
  assert.ok(w.logs.some((l) => l === 'host services stopped: ' + BAN), w.logs.join('\n'));
  await until(() => w.procs().length === 0, 10_000, 'every child of the stopped startup gone');
  // explicit fresh admit: a NEW transport, never the stopped one
  refusal = null; await judge();
  const h2 = env.current(); assert.ok(h2 && h2 !== h1);
  await until(() => h2.circuits.size === 1, 30_000, 'the fresh transport\'s circuit')
    .catch(e => { throw new Error(e.message + '\n' + w.logs.join('\n'), { cause: e }); });
  assert.match(await w.visit([...h2.circuits.values()][0]), /^directory-replica /);
  assert.equal(w.servicePeers().length, 1, 'exactly the fresh transport\'s peer at the exit');
  await h1.close();                                          // a late close of the old one changes nothing
  assert.equal(env.current(), h2); assert.equal(h2.circuits.size, 1);
  await env.stop();
  assert.deepEqual(w.servicePeers(), []); assert.equal(h2.timer, null);
  await until(() => w.procs().length === 0, 10_000, 'every child gone after the agent stop');
});

test('the privacy agent switch: a ban during a BACKGROUND round of a serving transport withdraws everything; app circuits are untouched', { timeout: 90_000 }, async (t) => {
  const w = await world(t, { exits: 2 });
  // a healthy app on the SAME runtime: an egress-only app circuit through the same providers
  const app = await w.runtime.start({ deploymentId: APP, names: [], kind: 'network', guard: w.guard.record, exit: w.exitList[0].record, egress: true });
  // through the app's gated egress entry to its tunnel (the stand-in echoes): write, read the echo, then close
  const echo = () => new Promise((resolve) => { const [h, p] = app.egress.split(':'); let b = ''; const s = net.connect(+p, h, () => s.write('ping'));
    s.on('data', (d) => { b += d; if (b.length >= 4) s.end(); }); s.on('close', () => resolve(b)); s.on('error', () => resolve('error')); s.setTimeout(5000, () => s.destroy()); });
  assert.equal(await echo(), 'ping');
  const second = w.exitList[1].record, qualified = second.qualifiedUntil; second.qualifiedUntil = Date.now() - 1;
  let refusal = null;
  const { judge, env } = agentJudge(w, { refusal: () => refusal });
  await judge();
  const h = env.current();
  await until(() => h.circuits.size === 1 && h.timer, 30_000, 'serving one exit');
  second.qualifiedUntil = qualified; w.pause();
  const round = h.reconcile();
  await until(() => w.asked.length === 2, 20_000, 'the background round holding at the second exit');
  refusal = BAN; await Promise.race([judge(), sleep(1000)]);
  assert.equal(env.current(), null, 'stopped while its background round is pending');
  await until(() => w.servicePeers(w.exitList[0]).length === 0, 20_000, 'the serving circuit withdrawn at once');
  w.release(); await round;
  await until(() => w.revokes.length === 2, 20_000, 'the background round\'s late grant withdrawn');
  for (const e of w.exitList) assert.deepEqual(w.servicePeers(e), []);
  assert.equal(h.circuits.size, 0); assert.equal(h.timer, null);
  // the app: same circuit, still carrying traffic, its exit peer kept
  assert.equal(app.closed, false); assert.ok(w.runtime.active.has(app));
  assert.equal(await echo(), 'ping');
  assert.equal([...w.exitList[0].p.peers.values()].filter((p) => p.role === 'exit' && p.deploymentId === APP).length, 1);
  await env.stop(); await app.close('test end');
});

test('agent stop during a startup: close() resolves only after the cancelled startup ended; a later judge() starts nothing', { timeout: 60_000 }, async (t) => {
  const w = await world(t);
  const { judge, env } = agentJudge(w, { refusal: () => null });
  w.pause();
  void judge();
  await until(() => w.asked.length === 1, 20_000, 'the startup holding at the exit');
  const stopping = env.stop();
  let done = false; void stopping.then(() => { done = true; });
  await sleep(200);
  assert.equal(done, false, 'the stop waits for the startup it cancelled');
  w.release(); await stopping;
  assert.deepEqual(w.servicePeers(), []); assert.equal(w.revokes.length, 1);
  await judge(); await sleep(200);
  assert.equal(env.current(), null); assert.equal(w.asked.length, 1, 'nothing started after the stop');
  await until(() => w.procs().length === 0, 10_000, 'every child gone');
});

test('root probe shape (a runtime that ignores the stop): the late circuit is withdrawn and closed, never inserted; no timer', { timeout: 30_000 }, async () => {
  const { EventEmitter } = await import('node:events');
  const provider = (id, address, roles) => ({ providerId: id, address, eligibleRoles: roles, pricePerGiB6: 0, qualifiedUntil: Date.now() + 60000, wgExitKey: 'exit-test', wgGuardKey: 'guard-test' });
  const exit = provider('e1'.repeat(16), '192.0.2.1', ['ingress']), guard = provider('a1'.repeat(16), '192.0.2.2', ['guard']);
  let begin, release, options, circuit, revokes = 0;
  const began = new Promise((r) => { begin = r; });
  const runtime = { start: async (opts) => { options = opts; begin(); await new Promise((r) => { release = r; });
    circuit = Object.assign(new EventEmitter(), { closed: false, providers: { guard: opts.guard, exit: opts.exit }, service: { control: '127.0.0.1:1', exitKey: 'test' }, close: async () => { circuit.closed = true; } });
    return circuit; } };
  const lines = [];
  const transport = new HostServiceTransport({ runtime, providers: async () => [guard, exit], grants: { revoke: async () => { revokes++; } }, hostId: HOST,
    config: { zone: ZONE, exits: [exit.providerId], ports: { 'directory-replica': 18188 } }, log: (m) => lines.push(m) });
  const starting = transport.start();
  await began;
  const closing = transport.close();
  assert.equal(options.signal?.aborted, true, 'the runtime is told to stop');
  release(); await closing; await starting;
  assert.equal(transport.closed, true); assert.equal(options.gate(), false);
  assert.equal(circuit.closed, true, 'returned circuit closed');
  assert.equal(transport.circuits.size, 0, 'nothing inserted after close');
  assert.equal(revokes, 1, 'its grant withdrawn');
  assert.equal(transport.timer, null, 'no timer created after close');
  assert.ok(!lines.some((l) => /circuit up/.test(l)), 'the late circuit never counted as up');
});

test('a startup that outlives the stop\'s settle bound: close() resolves at the bound; the late circuit is still withdrawn when it answers', { timeout: 30_000 }, async (t) => {
  const { EventEmitter } = await import('node:events');
  const provider = (id, address, roles) => ({ providerId: id, address, eligibleRoles: roles, pricePerGiB6: 0, qualifiedUntil: Date.now() + 60000, wgExitKey: 'exit-test', wgGuardKey: 'guard-test' });
  const exit = provider('e1'.repeat(16), '192.0.2.1', ['ingress']), guard = provider('a1'.repeat(16), '192.0.2.2', ['guard']);
  let release, circuit, revokes = 0; const began = deferred(), lines = [];
  const runtime = { start: async (opts) => { began.resolve(); await new Promise((r) => { release = r; });
    circuit = Object.assign(new EventEmitter(), { closed: false, providers: { guard: opts.guard, exit: opts.exit }, service: { control: '127.0.0.1:1', exitKey: 'late' }, close: async () => { circuit.closed = true; } });
    return circuit; } };
  const transport = new HostServiceTransport({ runtime, providers: async () => [guard, exit], grants: { revoke: async () => { revokes++; } }, hostId: HOST, settleMs: 200,
    config: { zone: ZONE, exits: [exit.providerId], ports: { 'directory-replica': 18188 } }, log: (m) => lines.push(m) });
  // close()'s settle timer is unref'd (a stop never keeps a process alive by itself) and this stand-in startup holds no I/O:
  // the test holds the event loop while it waits, as the real in-flight request and children do
  const hold = setInterval(() => {}, 1000); t.after(() => clearInterval(hold));
  const starting = transport.start();
  await began;
  await transport.close();                                   // resolves at the 200-ms bound; the startup is still running
  assert.ok(lines.some((l) => /still running 0.2 s after the stop/.test(l)), lines.join('\n'));
  release(); await starting;
  assert.equal(circuit.closed, true, 'the late circuit is closed when it answers');
  assert.equal(revokes, 1, 'and its grant withdrawn');
  assert.equal(transport.circuits.size, 0); assert.equal(transport.timer, null);
  assert.ok(!lines.some((l) => /circuit up/.test(l)));
});

test('opt-in public RPC origin: a host serving public-rpc asks for rpc-<b32>, an opted-in exit grants it, a visitor reaches the role by that name, and a ban withdraws it', { timeout: 90_000 }, async (t) => {
  const w = await world(t, { exitRpc: true, hostRpc: true });
  const rpc = hostRpcName(HOST, ZONE);
  let refusal = null;
  const { judge, env } = agentJudge(w, { refusal: () => refusal });
  await judge();
  const h = env.current();
  await until(() => h.circuits.size === 1, 30_000, 'the service circuit with the RPC name');
  const [peer] = w.servicePeers();
  assert.deepEqual(peer.names, [...Object.values(hostServiceNames(HOST, ZONE)), rpc], 'the exit granted the three derived names and the RPC origin');
  assert.equal(peer.rpc, true);
  const c = [...h.circuits.values()][0];
  assert.equal(await w.visit(c, rpc), 'public-rpc ' + rpc, 'the RPC name reaches the public-rpc role');
  assert.equal(await w.visit(c), 'directory-replica ' + hostServiceNames(HOST, ZONE)['directory-replica'], 'the other roles are unchanged');
  refusal = BAN; await judge();
  await until(() => w.servicePeers().length === 0, 20_000, 'the ban withdraws the grant (the RPC name with it)');
  assert.equal(env.current(), null);
  await env.stop();
});

test('an opted-in exit gives a host WITHOUT the role exactly its three names (unchanged grant)', { timeout: 60_000 }, async (t) => {
  const plain = await world(t, { exitRpc: true, hostRpc: false });
  const a = plain.transport(); await a.start();
  await until(() => a.circuits.size === 1, 30_000, 'a plain host on an opted-in exit');
  assert.deepEqual(plain.servicePeers()[0].names, Object.values(hostServiceNames(HOST, ZONE)), 'the exact three-name grant');
  assert.equal(plain.servicePeers()[0].rpc, false);
  assert.doesNotMatch(await plain.visit([...a.circuits.values()][0], hostRpcName(HOST, ZONE)), /^public-rpc/, 'no RPC name is routed for a host that did not ask');
  await a.close();
});

test('a host serving public-rpc is refused BY NAME at an exit whose operator did not opt in (never a mismatched grant)', { timeout: 60_000 }, async (t) => {
  const wants = await world(t, { exitRpc: false, hostRpc: true });
  const b = wants.transport(); await b.start();
  await until(() => wants.logs.some((l) => /does not carry host public RPC names \(its operator has not opted in: hostServices\.rpc\)/.test(l)), 30_000, 'the exit refuses by name');
  assert.equal(b.circuits.size, 0); assert.deepEqual(wants.servicePeers(), []);
  await b.close();
});
