// Deterministic lifecycle tests for the storage-indexer supervisor (network/host-services/storage-indexer-host.mjs):
// stop() against in-flight admission and in-flight PostgreSQL start, overlapping ticks, spawn errors, stop idempotence,
// startup timeout without orphans, and the preserved backoff. Admission and indexd are injected (deps); PostgreSQL
// starts through the REAL startPostgres with an injected spawn (fake children) and a real Unix socket for readiness.
// THE ASSERTION: after `await stop()` no child of the supervisor runs and no pending callback can start one.
// A negative control runs root's reproduction scenario (work/storage-stop-race-proof.mjs) on the PRIOR candidate
// (21a3552d...) and requires the race to reproduce there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { superviseReplica, startPostgres, validateConfig, canonicalHostEndpoint, descriptorBytes, verifyDescriptor } from '../network/host-services/storage-indexer-host.mjs';
import { hostIdOfEndpoint } from '../network/host-service-gate.mjs';
import { validatePolicy, POLICY_FORMAT } from '../network/platform-host-policy.mjs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tick0 = () => new Promise((r) => setImmediate(r));
let nextPid = 40000;

class FakeChild extends EventEmitter {
  constructor({ failSpawn = false } = {}) {
    super(); this.pid = failSpawn ? undefined : nextPid++; this.exitCode = null; this.signalCode = null; this.kills = [];
    if (failSpawn) setImmediate(() => this.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
  }
  get running() { return this.pid !== undefined && this.exitCode === null && this.signalCode === null; }
  kill(sig) {
    this.kills.push(sig);
    if (!this.running) return false;
    setImmediate(() => { if (!this.running) return; this.signalCode = sig; this.emit('exit', null, sig); });
    return true;
  }
  crash(code = 1) { this.exitCode = code; this.emit('exit', code, null); }
}

function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esi-life-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = { format: 'enclave-storage-indexer-host/v1', host: { endpoint: 'https://host.example' }, platformHostPolicy: 'off', replica: 'r1',
    package: { dir: path.join(dir, 'pkg'), manifest: 'sha256:' + '0'.repeat(64) }, pgBin: path.join(dir, 'pgbin'), stateRoot: path.join(dir, 'state'),
    runtimeDir: path.join(dir, 'run'), credentialsDir: path.join(dir, 'cred'), descriptorFile: path.join(dir, 'd.json'),
    adminAddress: '127.0.0.1:1', appAddress: '127.0.0.1:2', advertiseURL: 'https://r1.example' };
  fs.mkdirSync(path.join(cfg.stateRoot, 'r1/postgres'), { recursive: true }); fs.writeFileSync(path.join(cfg.stateRoot, 'r1/postgres/PG_VERSION'), '18\n');
  const sockFile = path.join(cfg.runtimeDir, 'r1/pg/.s.PGSQL.5432');
  const children = [], servers = [];
  let pgReady = true, pgFailSpawn = false, admit = { admit: false, reason: 'refused (initial)' }, pendingAdmit = null, admissions = 0, concurrent = 0, maxConcurrent = 0;
  const pgSpawn = () => {
    const c = new FakeChild({ failSpawn: pgFailSpawn }); c.kind = 'postgres'; children.push(c);
    if (c.pid !== undefined && pgReady) { fs.mkdirSync(path.dirname(sockFile), { recursive: true }); const s = net.createServer().listen(sockFile); servers.push(s);
      c.once('exit', () => s.close()); }
    return c;
  };
  t.after(() => servers.forEach((s) => s.close()));
  const deps = {
    admission: async () => {
      admissions++; concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
      try { if (pendingAdmit) return await pendingAdmit.promise; return admit; } finally { concurrent--; }
    },
    startPostgres: (c, o) => startPostgres(c, { ...o, spawn: pgSpawn, readyTimeoutMs: o.readyTimeoutMs ?? 3000 }),
    startIndexd: () => { const c = new FakeChild(); c.kind = 'indexd'; children.push(c); return c; },
  };
  const gate = { start() {}, stop() {}, status: () => ({}) };
  const logs = [];
  return {
    cfg, deps, gate, children, logs,
    log: (m) => logs.push(m),
    live: () => children.filter((c) => c.running),
    spawned: (kind) => children.filter((c) => c.kind === kind).length,
    set admit(v) { admit = v; }, set pgReady(v) { pgReady = v; }, set pgFailSpawn(v) { pgFailSpawn = v; },
    holdAdmission() { let resolve; const promise = new Promise((r) => { resolve = r; }); pendingAdmit = { promise }; return (v) => { pendingAdmit = null; resolve(v); }; },
    stats: () => ({ admissions, maxConcurrent }),
  };
}
const ADMIT = { admit: true, reason: 'fixture admit', pkg: {} };
const sup = (w, o = {}) => superviseReplica(w.cfg, { gate: w.gate, deps: w.deps, log: w.log, intervalMs: 3_600_000, backoffMs: 50, ...o });

test('positive control: admitted -> PostgreSQL and indexd run; stop -> nothing runs', async (t) => {
  const w = world(t); w.admit = ADMIT;
  const s = await sup(w);
  assert.equal(w.spawned('postgres'), 1); assert.equal(w.spawned('indexd'), 1);
  assert.deepEqual([s.status().postgres, s.status().indexd], [true, true]);
  await s.stop();
  assert.equal(w.live().length, 0, 'every child exited');
  assert.deepEqual([s.status().postgres, s.status().indexd], [false, false]);
});

test('stop during an in-flight ADMISSION: the pending admit can never start anything (root reproduction scenario)', async (t) => {
  const w = world(t);
  const s = await sup(w);                                   // initial decision: refused
  const release = w.holdAdmission();
  const pending = s.tick();                                 // the decision is now in flight
  await tick0();
  await s.stop();
  assert.equal(w.live().length, 0, 'nothing runs when stop() resolves');
  const before = w.children.length;
  release(ADMIT);                                           // the late admit arrives after the terminal stop
  await pending; await tick0(); await new Promise((r) => setTimeout(r, 100));
  assert.equal(w.children.length, before, 'no child was spawned after stop()');
  assert.equal(w.live().length, 0);
  assert.equal(s.status().postgres, false);
});

test('stop during an in-flight PostgreSQL START (awaiting its socket): the start is aborted and its child stopped', async (t) => {
  const w = world(t);
  const s = await sup(w);
  w.admit = ADMIT; w.pgReady = false;                       // the server never answers its socket
  const pending = s.tick();
  for (let i = 0; i < 20 && w.spawned('postgres') === 0; i++) await tick0();
  assert.equal(w.spawned('postgres'), 1, 'PostgreSQL was spawned and is awaiting readiness');
  await s.stop();
  assert.equal(w.live().length, 0, 'the half-started PostgreSQL was stopped before stop() resolved');
  await pending;
  assert.equal(w.spawned('indexd'), 0, 'indexd never started');
  assert.equal(w.children.length, 1);
});

test('a start that completes during stop() is never kept (late readiness)', async (t) => {
  const w = world(t);
  // PostgreSQL that becomes ready only after stop() was called: startPostgres resolves, the tick must stop it
  // the slow start is installed BEFORE the supervisor is built (it copies its deps at construction)
  let gate, entered = 0; const slow = new Promise((r) => { gate = r; });
  w.deps.startPostgres = async () => { entered++; await slow; const c = new FakeChild(); c.kind = 'postgres'; w.children.push(c); return c; };
  const s = await sup(w);                                   // initial decision: refused (nothing started)
  w.admit = ADMIT;
  const pending = s.tick();
  for (let i = 0; i < 20 && !entered; i++) await tick0();
  assert.equal(entered, 1, 'the tick is inside the PostgreSQL start when stop() is called');
  let stopResolved = false;
  const stopping = s.stop().then(() => { stopResolved = true; });
  for (let i = 0; i < 10; i++) await tick0();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(stopResolved, false, 'stop() does not resolve while a start is in flight (it waits for the acting tick)');
  gate();                                                   // the start completes after stop() began
  await stopping; await pending;
  assert.equal(stopResolved, true);
  assert.equal(entered, 1, 'no second start was attempted');
  assert.equal(w.live().length, 0, 'the late PostgreSQL was stopped');
  assert.equal(w.spawned('indexd'), 0);
});

test('overlapping ticks share one decision; one PostgreSQL and one indexd', async (t) => {
  const w = world(t);
  const s = await sup(w);
  const release = w.holdAdmission();
  const ticks = Array.from({ length: 10 }, () => s.tick());
  await tick0();
  assert.equal(w.stats().maxConcurrent, 1, 'never two decisions at once');
  release(ADMIT); await Promise.all(ticks);
  assert.equal(w.spawned('postgres'), 1); assert.equal(w.spawned('indexd'), 1);
  await Promise.all([s.tick(), s.tick(), s.tick()]);
  assert.equal(w.spawned('postgres'), 1, 'running processes are not started again'); assert.equal(w.spawned('indexd'), 1);
  await s.stop(); assert.equal(w.live().length, 0);
});

test('PostgreSQL spawn error (no exit event): the start fails cleanly, nothing orphaned, the supervisor keeps deciding', async (t) => {
  const w = world(t);
  const s = await sup(w);
  w.admit = ADMIT; w.pgFailSpawn = true;
  await s.tick();
  assert.equal(w.live().length, 0);
  assert.ok(w.logs.some((l) => /PostgreSQL failed to start: spawn ENOENT/.test(l)), w.logs.join('\n'));
  w.pgFailSpawn = false;
  await s.tick();
  assert.equal(s.status().postgres, true, 'the next decision starts it normally');
  await s.stop(); assert.equal(w.live().length, 0);
});

test('PostgreSQL that never answers within the readiness timeout is stopped (no orphan)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esi-to-'));
  const kids = [];
  const cfg = { pgBin: dir, stateRoot: dir, runtimeDir: dir, replica: 'r1' };
  await assert.rejects(startPostgres(cfg, { spawn: () => { const c = new FakeChild(); kids.push(c); return c; }, readyTimeoutMs: 400 }), /timed out waiting for PostgreSQL socket/);
  assert.equal(kids.length, 1); assert.equal(kids[0].running, false, 'the timed-out server was stopped');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('indexd spawn error and error+exit are each handled exactly once; restarts follow the backoff; stop clears a pending restart', async (t) => {
  const w = world(t); w.admit = ADMIT;
  let mode = 'error-only';                                  // backoff 200 ms: failure 1 at ~0, restart ~200 (failure 2), next ~600
  w.deps.startIndexd = () => {
    const c = new FakeChild({ failSpawn: mode === 'error-only' }); c.kind = 'indexd'; w.children.push(c);
    if (mode === 'error-and-exit') setImmediate(() => { c.emit('error', new Error('boom')); c.crash(2); });
    return c;
  };
  const s = await sup(w, { backoffMs: 200 });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(s.status().restarts, 1, 'a spawn error without exit schedules exactly one restart');
  mode = 'error-and-exit';
  await new Promise((r) => setTimeout(r, 300));              // the restart at ~200 ms runs, then error+exit
  const r = s.status().restarts;
  assert.equal(r, 2, 'error followed by exit is ONE failure');
  mode = 'ok';
  const gaps = [];
  await s.stop();                                           // stops while a backoff restart is pending
  const n = w.children.length;
  await new Promise((r2) => setTimeout(r2, 700));
  assert.equal(w.children.length, n, 'a pending backoff restart never fires after stop()');
  assert.equal(w.live().length, 0);
  void gaps;
});

test('stop() is idempotent and safe when overlapping: one shutdown, every caller resolves', async (t) => {
  const w = world(t); w.admit = ADMIT;
  const s = await sup(w);
  const [pg, ix] = [w.children.find((c) => c.kind === 'postgres'), w.children.find((c) => c.kind === 'indexd')];
  const a = s.stop(), b = s.stop();
  assert.equal(a, b, 'the same terminal stop');
  await Promise.all([a, b]); await s.stop();
  assert.deepEqual(ix.kills, ['SIGTERM'], 'indexd signalled once'); assert.deepEqual(pg.kills, ['SIGINT'], 'PostgreSQL signalled once');
  assert.equal(w.live().length, 0);
  await s.tick();
  assert.equal(w.children.length, 2, 'a tick after stop does nothing');
});

test('NEGATIVE CONTROL: root\'s reproduction scenario reproduces the race on the PRIOR candidate 21a3552d', async () => {
  const bytes = fs.readFileSync(path.join(HERE, 'fixtures/prior-21a3552d-storage-indexer-host.mjs.txt'), 'utf8');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '21a3552d17dbe0584757eb7f212e05bef4897ae7648febc453d67467bc21ef8f');
  const start = bytes.indexOf('export async function superviseReplica('), end = bytes.indexOf('\n/** Encrypted logical backup:', start);
  const source = bytes.slice(start, end).replace('export async function', 'async function');
  let mode = 'refuse', unblock, pgStarts = 0;
  const ctx = vm.createContext({ console, Date, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    fs: { existsSync: () => true }, path: { join: (...x) => x.join('/') }, validateConfig: (x) => x, dataDir: () => '/fixture',
    admission: async () => (mode === 'refuse' ? { admit: false, reason: 'fixture' } : new Promise((r) => { unblock = r; })),
    startPostgres: async () => { pgStarts++; return { exitCode: null, signalCode: null }; },
    stopChild: async (c) => { if (c) c.exitCode = 0; }, startIndexd: () => new EventEmitter() });
  vm.runInContext(source + '\nglobalThis.subject = superviseReplica;', ctx);
  const s = await ctx.subject({ replica: 'fixture', stateRoot: '/fixture', host: { endpoint: 'https://fixture.invalid' } },
    { gate: { start() {}, stop() {}, status: () => ({}) }, log: () => {}, intervalMs: 3_600_000 });
  mode = 'pending';
  const pending = s.tick(); await Promise.resolve();
  await s.stop();
  const atStop = pgStarts;
  unblock({ admit: true, reason: 'fixture', pkg: {} }); await pending;
  assert.ok(pgStarts > atStop, 'the prior candidate starts PostgreSQL after stop() resolved: this suite detects the race');
  await s.stop();
});

// ---- registered endpoints (production shape https://api.enclave.host/t/<name>) ----
const POLICY = (value) => ({ format: POLICY_FORMAT, chainId: 8453, book: '0x' + 'b0'.repeat(20), registry: '0x' + 'e0'.repeat(20), hostOwnership: '0x' + 'c0'.repeat(20),
  sequence: 1, issuedAt: 1, expiresAt: 0, maxStaleSec: 0, previousDigest: '0x' + '00'.repeat(32), mode: 'denylist', deny: [{ kind: 'endpoint', value, reason: 'x' }], admit: [] });
const policyAccepts = (v) => { try { validatePolicy(POLICY(v)); return true; } catch { return false; } };

test('registered host endpoints WITH a path are accepted; canonical form keeps the registry id; malformed ones refused', async (t) => {
  const w = world(t);
  const accepted = { 'https://api.enclave.host/t/metal0': 'https://api.enclave.host/t/metal0', 'https://api.enclave.host/t/nucbox-k11-4': 'https://api.enclave.host/t/nucbox-k11-4',
    'https://api.enclave.host/t/nucbox-k11-4/': 'https://api.enclave.host/t/nucbox-k11-4', 'https://host.example': 'https://host.example',
    'https://host.example:8443/a/b-c_d.e~f': 'https://host.example:8443/a/b-c_d.e~f' };
  for (const [input, canon] of Object.entries(accepted)) {
    const cfg = validateConfig({ ...w.cfg, host: { endpoint: input } });
    assert.equal(cfg.host.endpoint, canon, `${input} canonical`);
    assert.equal(hostIdOfEndpoint(cfg.host.endpoint), hostIdOfEndpoint(input), `${input}: the registry id is unchanged by canonicalization`);
    assert.ok(policyAccepts(canon), `${input}: the platform host policy accepts the same endpoint syntax`);
  }
  const refused = ['https://user:pw@api.enclave.host/t/metal0', 'https://api.enclave.host/t/metal0?x=1', 'https://api.enclave.host/t/metal0#f', 'http://api.enclave.host/t/metal0',
    'https://API.enclave.host/t/metal0', 'https://api.enclave.host/t/../metal0', 'https://api.enclave.host/t/./metal0', 'https://api.enclave.host//t/metal0', 'https://api.enclave.host/t//metal0',
    'https://api.enclave.host:0/t', 'https://api.enclave.host:70000/t', 'https://api.enclave.host/t/metal0 x', 'https://api.enclave.host/t/%2e%2e', 'api.enclave.host/t/metal0', ''];
  for (const e of refused) {
    assert.equal(canonicalHostEndpoint(e), null, `${JSON.stringify(e)} refused`);
    assert.throws(() => validateConfig({ ...w.cfg, host: { endpoint: e } }), /host\.endpoint/, `${JSON.stringify(e)} refused by validateConfig`);
  }
});

test('a descriptor signed by the operator binds to exactly the registered /t/<name> host; another host or operator refuses', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esi-desc-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const op = privateKeyToAccount(generatePrivateKey()), other = privateKeyToAccount(generatePrivateKey());
  const metal0 = hostIdOfEndpoint('https://api.enclave.host/t/metal0'), nucbox = hostIdOfEndpoint('https://api.enclave.host/t/nucbox-k11-4');
  assert.notEqual(metal0, nucbox);
  const pin = 'sha256:' + '1'.repeat(64), url = 'https://r1.indexer.example';
  const write = async (name, signer, hostId) => { const bytes = descriptorBytes({ operator: signer.address, hostId, replica: 'r1', packagePin: pin, advertiseURL: url, indexdSha256: 'e6' });
    const f = path.join(dir, name); fs.writeFileSync(f, JSON.stringify({ descriptor: bytes, signature: await signer.signMessage({ message: bytes }) })); return f; };
  const want = { hostId: hostIdOfEndpoint(validateConfig({ ...world(t).cfg, host: { endpoint: 'https://api.enclave.host/t/metal0/' } }).host.endpoint), replica: 'r1', packagePin: pin, advertiseURL: url };
  assert.equal(want.hostId, metal0, 'the config path yields the registered id');
  const ok = await verifyDescriptor(await write('ok.json', op, metal0), want);
  assert.equal(ok.operator, op.address.toLowerCase());
  await assert.rejects(verifyDescriptor(await write('nucbox.json', op, nucbox), want), /descriptor names host 0x[0-9a-f]+, not this host/);
  const forged = JSON.parse(fs.readFileSync(await write('o.json', op, metal0), 'utf8'));
  forged.signature = await other.signMessage({ message: forged.descriptor });
  fs.writeFileSync(path.join(dir, 'forged.json'), JSON.stringify(forged));
  await assert.rejects(verifyDescriptor(path.join(dir, 'forged.json'), want), /is not signed by its operator/);
});
