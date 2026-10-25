// The storage-indexer HOST ROLE: one Sia indexer replica (indexd G-C2 + its own PostgreSQL 18) supervised on an Enclave
// host under the SAME platform host policy gate as app service (network/host-service-gate.mjs). Like the lease relay
// (network/host-services/lease-relay-host.mjs) it is a KEYED role (the replica's wallet phrase), so it has its own
// supervisor instead of runner.mjs's no-secret ROLES; it keeps the runner's discipline: pinned package bytes, no inherited
// environment, memory caps, restart backoff, and the gate's refusal stops it (sticky until the admin's admit).
//
//   node network/host-services/storage-indexer-host.mjs check  <host.json>    validate, verify package + descriptor, print the plan
//   node network/host-services/storage-indexer-host.mjs init   <host.json>    (admitted host only) initdb + database + base config
//   node network/host-services/storage-indexer-host.mjs run    <host.json>    supervise PostgreSQL + indexd while admitted
//   node network/host-services/storage-indexer-host.mjs backup <host.json> <out.cms> <owner-cert.pem>
//   node network/host-services/storage-indexer-host.mjs restore <host.json> <in.cms> <owner-key.pem> <owner-cert.pem>
//
// Admission (no new authority):
//   1. the platform host policy admits THIS host (its registry id = keccak256(host.endpoint)): the administrator's
//      anchored policy (bans, allowlist), the registry row ACTIVE, the accepted owner. Anything else refuses.
//   2. the replica descriptor (enclave-service-descriptor/v1, kind "storage", role "storage-indexer") names this host's
//      registry id, this replica and this exact package, and is signed by THIS HOST'S REGISTRY OPERATOR, read from the
//      same agreed snapshot the gate uses. Another operator's or another host's descriptor refuses.
//   3. which replicas a deployment writes to is the deployment owner's sia-s3 configuration; discovery ads go through
//      the service index (kind storage = 3), which is metadata, not authority.
// "off" for the platform policy must be written explicitly; the role then refuses to run unless --ungated-test is given
// (fixtures only), and says so.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn as spawnChild } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { verifyMessage } from 'viem';

export const CONFIG_FORMAT = 'enclave-storage-indexer-host/v1';
export const DESCRIPTOR_FORMAT = 'enclave-service-descriptor/v1';
export const ROLE = 'storage-indexer';
export const KIND = 'storage';
const SECRETISH = /(secret|password|phrase|seed|private|mnemonic|token|key)(?!.*(file|dir|cert|pin))/i;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const plain = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const fail = (m) => { throw new Error(`storage-indexer host: ${m}`); };
const lc = (s) => String(s || '').toLowerCase();
const normEndpoint = (e) => String(e || '').replace(/\/+$/, '');
/**
 * A registered host endpoint (the registry entry's PUBLIC_URL), e.g. https://api.enclave.host/t/metal0. The SAME syntax
 * the platform host policy accepts for an endpoint (network/platform-host-policy.mjs KINDS.endpoint: lowercase host,
 * optional port, path of [A-Za-z0-9._~/-]), with no credentials, query or fragment, and no empty, "." or ".." path
 * segment. Canonical form = trailing slashes stripped, exactly what hostIdOfEndpoint (network/host-service-gate.mjs)
 * hashes; nothing else is rewritten, so the registry id is unchanged. -> the canonical endpoint, or null.
 */
export function canonicalHostEndpoint(e) {
  const c = normEndpoint(e);
  if (!/^https:\/\/[a-z0-9.-]{1,180}(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~/-]{0,200})?$/.test(c)) return null;
  const pathPart = c.slice(c.indexOf('/', 8));
  if (c.indexOf('/', 8) !== -1 && pathPart.split('/').slice(1).some((seg) => seg === '' || seg === '.' || seg === '..')) return null;
  const port = /:([0-9]{1,5})(?:\/|$)/.exec(c.slice(8));
  if (port && (Number(port[1]) < 1 || Number(port[1]) > 65535)) return null;
  return c;
}

/** -> normalized config (throws). Only public configuration: secrets come from credentialsDir files (systemd credentials). */
export function validateConfig(cfg) {
  if (!plain(cfg)) fail('configuration must be an object');
  const allowed = ['format', 'host', 'platformHostPolicy', 'platformHostPolicyMirrors', 'platformHostPolicyRpcs', 'replica', 'package', 'pgBin',
    'stateRoot', 'runtimeDir', 'credentialsDir', 'descriptorFile', 'adminAddress', 'appAddress', 'advertiseURL', 'memoryMiB', 'pgLibDir', 'syncer'];
  for (const k of Object.keys(cfg)) if (!allowed.includes(k)) fail(`unknown field ${JSON.stringify(k)}${SECRETISH.test(k) ? ' (secrets come only from credentialsDir)' : ''}`);
  if (cfg.format !== CONFIG_FORMAT) fail(`format must be ${CONFIG_FORMAT}`);
  if (!plain(cfg.host) || Object.keys(cfg.host).some((k) => k !== 'endpoint')) fail('host: { endpoint } only');
  const endpoint = canonicalHostEndpoint(cfg.host.endpoint);
  if (!endpoint) fail("host.endpoint: this host's registered endpoint (its PUBLIC_URL), e.g. https://api.enclave.host/t/<name>: https, lowercase host, no credentials, query, fragment or dot/empty path segments");
  if (cfg.platformHostPolicy === undefined) fail('platformHostPolicy is required: "production", an explicit platform JSON, or "off" (explicit; fixtures only)');
  if (!(cfg.platformHostPolicy === 'production' || cfg.platformHostPolicy === 'off' || plain(cfg.platformHostPolicy))) fail('platformHostPolicy: "production" | "off" | { book, hostOwnership, mirrors[] }');
  for (const k of ['platformHostPolicyMirrors', 'platformHostPolicyRpcs'])
    // https only; plain http solely for loopback fixtures (a production policy RPC or mirror is never 127.0.0.1)
    if (cfg[k] !== undefined && (!Array.isArray(cfg[k]) || cfg[k].some((u) => typeof u !== 'string' || !/^(https:\/\/[^\s?#@]+|http:\/\/127\.0\.0\.1:[0-9]{1,5}(\/[^\s?#@]*)?)$/.test(u)))) fail(`${k}: https URLs`);
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(String(cfg.replica))) fail('replica: [a-z0-9][a-z0-9-]{0,30}');
  if (!plain(cfg.package) || typeof cfg.package.dir !== 'string' || !path.isAbsolute(cfg.package.dir) || !/^sha256:[0-9a-f]{64}$/.test(String(cfg.package.manifest)))
    fail('package: { dir: <absolute unpacked package>, manifest: "sha256:<digest of its MANIFEST.sha256>" }');
  if (cfg.pgLibDir !== undefined && (typeof cfg.pgLibDir !== 'string' || !path.isAbsolute(cfg.pgLibDir))) fail('pgLibDir must be an absolute path');
  const syncer = { address: ':9981', bootstrap: true, ...(cfg.syncer || {}) };
  if (!plain(cfg.syncer ?? {}) || Object.keys(syncer).some((k) => !['address', 'bootstrap'].includes(k)) || typeof syncer.bootstrap !== 'boolean' || !/^(127\.0\.0\.1)?:[0-9]{1,5}$/.test(String(syncer.address)))
    fail('syncer: { address: ":<port>" | "127.0.0.1:<port>", bootstrap: boolean }');
  for (const k of ['pgBin', 'stateRoot', 'runtimeDir', 'credentialsDir', 'descriptorFile']) if (typeof cfg[k] !== 'string' || !path.isAbsolute(cfg[k])) fail(`${k} must be an absolute path`);
  for (const k of ['adminAddress', 'appAddress']) if (!/^127\.0\.0\.1:[0-9]{1,5}$/.test(String(cfg[k]))) fail(`${k}: 127.0.0.1:<port> (loopback only)`);
  if (!/^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/.test(String(cfg.advertiseURL))) fail('advertiseURL: https://<host>[:port] (the replica URL sia-s3 deployments use)');
  const mem = { indexd: 1024, postgres: 1024, ...(cfg.memoryMiB || {}) };
  for (const [k, v] of Object.entries(mem)) if (!['indexd', 'postgres'].includes(k) || !Number.isInteger(v) || v < 128 || v > 8192) fail('memoryMiB: { indexd, postgres } 128..8192');
  return { ...cfg, host: { endpoint }, memoryMiB: mem, syncer };
}

/** The pinned package: MANIFEST.sha256 must hash to the pin and every file in it must verify. -> { indexd, geoip, manifest } */
export function verifyPackage(dir, pin) {
  const raw = fs.readFileSync(path.join(dir, 'MANIFEST.sha256'));
  if ('sha256:' + sha(raw) !== pin) fail(`package manifest is not the pinned ${pin}`);
  const lines = raw.toString().trim().split('\n');
  for (const line of lines) {
    const m = /^([0-9a-f]{64})  \.\/(.+)$/.exec(line);
    if (!m || m[2].includes('..')) fail(`malformed manifest line ${JSON.stringify(line.slice(0, 80))}`);
    if (sha(fs.readFileSync(path.join(dir, m[2]))) !== m[1]) fail(`package file ${m[2]} does not match its manifest`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'PACKAGE.json'), 'utf8'));
  return { indexd: path.join(dir, pkg.indexd.file), geoip: path.join(dir, pkg.geoip.file), indexdSha256: pkg.indexd.sha256, manifest: pin };
}

/** The replica descriptor bytes this host would serve, for the operator to sign (EIP-191 personal_sign of these exact bytes). */
export function descriptorBytes({ operator, hostId, replica, packagePin, advertiseURL, indexdSha256 }) {
  return JSON.stringify({ format: DESCRIPTOR_FORMAT, operator: lc(operator), kind: KIND, role: ROLE, hostId: lc(hostId), replica,
    package: packagePin, applicationAPI: advertiseURL, indexd: { sha256: indexdSha256, capabilities: ['cas-v4', 'fence', 'op-nonce'] } });
}

/** -> the descriptor's operator if it is this replica's exact descriptor and the operator signed these bytes (throws otherwise). */
export async function verifyDescriptor(file, { hostId, replica, packagePin, advertiseURL }) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!plain(d) || typeof d.descriptor !== 'string' || !/^0x[0-9a-f]{130}$/i.test(String(d.signature))) fail('descriptor file: { descriptor: "<bytes>", signature: "0x<65 bytes>" }');
  const x = JSON.parse(d.descriptor);
  if (x.format !== DESCRIPTOR_FORMAT || x.kind !== KIND || x.role !== ROLE) fail('descriptor is not a storage-indexer service descriptor');
  if (lc(x.hostId) !== lc(hostId)) fail(`descriptor names host ${x.hostId}, not this host ${hostId}`);
  if (x.replica !== replica) fail(`descriptor names replica ${x.replica}, not ${replica}`);
  if (x.package !== packagePin) fail(`descriptor names package ${x.package}, not the pinned ${packagePin}`);
  if (x.applicationAPI !== advertiseURL) fail(`descriptor advertises ${x.applicationAPI}, not ${advertiseURL}`);
  if (!/^0x[0-9a-f]{40}$/.test(String(x.operator))) fail('descriptor operator must be an address');
  if (!(await verifyMessage({ address: x.operator, message: d.descriptor, signature: d.signature }))) fail(`descriptor is not signed by its operator ${x.operator}`);
  return { operator: lc(x.operator), descriptor: d.descriptor };
}

/** The env names the existing gate reads (network/platform-host-policy-config.mjs), from the explicit configuration. */
export function policyEnv(cfg, extra = {}) {
  const p = cfg.platformHostPolicy;
  return { ENCLAVE_PLATFORM_HOST_POLICY: typeof p === 'string' ? p : JSON.stringify(p),
    ...(cfg.platformHostPolicyMirrors ? { ENCLAVE_PLATFORM_HOST_POLICY_MIRRORS: cfg.platformHostPolicyMirrors.join(',') } : {}),
    ...(cfg.platformHostPolicyRpcs ? { ENCLAVE_PLATFORM_HOST_POLICY_RPCS: cfg.platformHostPolicyRpcs.join(',') } : {}), ...extra };
}

const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, no) => { const t = setTimeout(() => no(new Error(`${what} timed out after ${ms} ms`)), ms); t.unref?.(); })]);
const registrySnapshots = new WeakMap();
/** This host's registry row, read with the gate's OWN configuration (same RPC set, quorum rule, book and ownership
 *  contract) at an agreed block, through the exported reader - never through the gate's mutable decision state. */
async function registryRow(gate, hostId) {
  const rc = gate.runtime.config;
  let snap = registrySnapshots.get(gate);
  if (!snap) {
    const { quorumSnapshot } = await import('../host-policy-runtime.mjs');
    snap = quorumSnapshot({ rpcs: rc.rpcs, minAgree: rc.minAgree ?? null }); registrySnapshots.set(gate, snap);
  }
  const { readPolicyFacts } = await import('../platform-host-policy.mjs');
  const facts = await snap((at) => readPolicyFacts(at, { book: rc.book, hostOwnership: rc.hostOwnership, registryIds: [hostId] }));
  return facts.hosts[hostId];
}

/**
 * The admission decision for this host + replica, now. -> { admit, reason, hostId, operator }.
 * gate: the platform host policy gate (createHostServiceGate) for this host's endpoint.
 */
export async function admission(cfg, gate, { ungatedTest = false } = {}) {
  const { hostIdOfEndpoint } = await import('../host-service-gate.mjs');
  const hostId = hostIdOfEndpoint(cfg.host.endpoint);
  const pkg = verifyPackage(cfg.package.dir, cfg.package.manifest);
  let d;
  try { d = await verifyDescriptor(cfg.descriptorFile, { hostId, replica: cfg.replica, packagePin: cfg.package.manifest, advertiseURL: cfg.advertiseURL }); }
  catch (e) { return { admit: false, reason: e.message, hostId }; }
  if (!gate.enabled) {
    return ungatedTest ? { admit: true, reason: 'platform host policy OFF (fixture only, not a production configuration)', hostId, operator: d.operator, pkg }
                       : { admit: false, reason: 'platform host policy is off: the storage-indexer role runs only under the platform host policy', hostId };
  }
  await withTimeout(gate.check(), 30000, 'platform host policy check').catch(() => {});
  const refused = gate.serviceRefusal();
  if (refused) return { admit: false, reason: refused, hostId };
  // the registry row from the gate's own runtime (same RPC quorum, same authority): bind the descriptor to it
  let row;
  try { row = await withTimeout(registryRow(gate, hostId), 30000, 'registry read'); }
  // transient (RPC/mirror): the gate itself still admits this host (its bounded grace); never a reason to stop a running replica
  catch (e) { return { admit: false, transient: true, reason: `registry row unreadable: ${String(e.message || e).slice(0, 160)}`, hostId }; }
  if (!row || !row.active) return { admit: false, reason: 'host registry entry is not active', hostId };
  if (normEndpoint(row.endpoint) !== cfg.host.endpoint) return { admit: false, reason: `registry endpoint ${row.endpoint} is not ${cfg.host.endpoint}`, hostId };
  if (lc(row.operator) !== d.operator) return { admit: false, reason: `descriptor operator ${d.operator} is not this host's registry operator ${lc(row.operator)}`, hostId };
  return { admit: true, reason: 'admitted by the platform host policy; descriptor signed by the registry operator', hostId, operator: d.operator, pkg };
}

// ---------------------------------------------------------------------------------------------------------------- runtime

const pgEnv = (cfg) => ({ PATH: `${cfg.pgBin}:/usr/bin:/bin`, LC_ALL: 'C', TZ: 'UTC', ...(cfg.pgLibDir ? { LD_LIBRARY_PATH: cfg.pgLibDir } : {}) });
const dataDir = (cfg) => path.join(cfg.stateRoot, cfg.replica, 'postgres');
const stateDir = (cfg) => path.join(cfg.stateRoot, cfg.replica, 'state');
const sockDir = (cfg) => path.join(cfg.runtimeDir, cfg.replica, 'pg');
const run = (bin, args, opts = {}) => new Promise((ok, no) => {
  const c = spawnChild(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts }); let out = '';
  c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
  c.on('error', no); c.on('exit', (code) => (code === 0 ? ok(out) : no(new Error(`${path.basename(bin)} exited ${code}: ${out.slice(-400)}`))));
});

/** initdb (peer auth, socket only) + the indexd database + the non-secret base config + the pinned GeoIP database. */
export async function initReplica(cfg) {
  const pkg = verifyPackage(cfg.package.dir, cfg.package.manifest);
  const data = dataDir(cfg);
  if (fs.existsSync(path.join(data, 'PG_VERSION'))) fail(`${data} is already initialised`);
  for (const d of [data, stateDir(cfg), sockDir(cfg), path.join(cfg.stateRoot, cfg.replica, 'outbox')]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  await run(path.join(cfg.pgBin, 'initdb'), ['-D', data, '--auth-local=peer', '--auth-host=reject', '--encoding=UTF8', '--locale=C.UTF-8', '-U', os.userInfo().username], { env: pgEnv(cfg) });
  const pg = await startPostgres(cfg);
  try { await run(path.join(cfg.pgBin, 'createdb'), ['-h', sockDir(cfg), 'indexd'], { env: pgEnv(cfg) }); }
  finally { await stopChild(pg, 'SIGINT'); }
  fs.copyFileSync(pkg.geoip, path.join(stateDir(cfg), path.basename(pkg.geoip)));
  return { data, state: stateDir(cfg) };
}

/** The full indexd.yml in the runtime dir (0600), from public config + credential files; never logged. -> path */
export function renderIndexdConfig(cfg) {
  const read = (n) => fs.readFileSync(path.join(cfg.credentialsDir, n), 'utf8').trim();
  const phrase = read('recovery-phrase'), admin = read('admin-password');
  const words = phrase.split(/\s+/);
  if (!(words.length === 12 || words.length === 24) || !/^[a-z ]+$/.test(phrase)) fail('recovery-phrase credential: 12 or 24 lowercase words');
  if (admin.length < 24 || !/^[A-Za-z0-9._~-]+$/.test(admin)) fail('admin-password credential: >= 24 URL-safe characters');
  const y = (s) => JSON.stringify(s);
  const text = [`recoveryPhrase: ${y(phrase)}`, 'autoOpenWebUI: false', `directory: ${y(stateDir(cfg))}`,
    'adminAPI:', `  address: ${y(cfg.adminAddress)}`, `  password: ${y(admin)}`,
    'applicationAPI:', `  address: ${y(cfg.appAddress)}`, `  advertiseURL: ${y(cfg.advertiseURL)}`,
    'syncer:', `  address: ${y(cfg.syncer.address)}`, `  bootstrap: ${cfg.syncer.bootstrap}`, '  enableUPnP: false', 'consensus:', '  network: mainnet', 'explorer:', '  enabled: false', '  url: ""',
    'database:', `  host: ${y(sockDir(cfg))}`, '  port: 5432', `  user: ${y(os.userInfo().username)}`, '  password: ""', '  database: indexd', '  sslmode: disable',
    'log:', '  stdout:', '    enabled: true', '    level: info', '    format: json', '  file:', '    enabled: false', ''].join('\n');
  const dir = path.join(cfg.runtimeDir, cfg.replica, 'indexd');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'indexd.yml'), tmp = file + '.' + process.pid;
  fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.renameSync(tmp, file);
  return file;
}

/** Settles exactly once per child: on its first 'exit', or on an 'error' when no process is (still) running (a spawn
 *  failure emits 'error' and never 'exit'). -> { done: Promise<{ code, signal, error }>, settled } */
function watch(child) {
  if (child.__esiWatch) return child.__esiWatch;
  let settle; const done = new Promise((r) => { settle = r; });
  const w = { done, settled: false };
  const fin = (v) => { if (w.settled) return; w.settled = true; settle(v); };
  child.once('exit', (code, signal) => fin({ code, signal, error: null }));
  child.on('error', (error) => { if (!child.pid || child.exitCode !== null || child.signalCode !== null) fin({ code: null, signal: null, error }); });
  if ((child.exitCode !== null && child.exitCode !== undefined) || child.signalCode) fin({ code: child.exitCode, signal: child.signalCode, error: null });
  child.__esiWatch = w;
  return w;
}
const alive = (child) => !!child && !watch(child).settled;

/** Terminates `child` (signal, then SIGKILL after ms) and resolves once it has exited. Safe for a child that never
 *  spawned, one that already exited, and repeated or concurrent calls (they share the same completion). */
function stopChild(child, signal = 'SIGTERM', ms = 60000) {
  if (!child) return Promise.resolve();
  const w = watch(child);
  if (w.settled) return w.done;
  try { child.kill(signal); } catch {}
  const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, ms); t.unref?.();
  return w.done.finally(() => clearTimeout(t));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms, what) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(200); } fail(`timed out waiting for ${what}`); };
const socketUp = (file) => new Promise((ok) => { const s = net.connect(file); s.once('connect', () => { s.destroy(); ok(true); }); s.once('error', () => ok(false)); });
const relayLines = (s, log, tag) => s?.on?.('data', (d) => { for (const l of String(d).split('\n').filter(Boolean)) log(`[${tag}] ${l.slice(0, 300)}`); });

/** PostgreSQL for this replica: Unix socket only, no TCP, peer auth. -> the child once its socket answers. If the start
 *  is aborted (signal), times out, or the server exits or fails to spawn first, the child is stopped (never orphaned)
 *  and this throws. */
export async function startPostgres(cfg, { log = () => {}, spawn = spawnChild, signal = null, readyTimeoutMs = 60000 } = {}) {
  if (signal?.aborted) fail('PostgreSQL start aborted');
  fs.mkdirSync(sockDir(cfg), { recursive: true, mode: 0o700 });
  const child = spawn(path.join(cfg.pgBin, 'postgres'), ['-D', dataDir(cfg), '-c', 'listen_addresses=', '-c', `unix_socket_directories=${sockDir(cfg)}`,
    '-c', 'shared_buffers=128MB', '-c', 'max_connections=50', '-c', 'jit=off'], { env: pgEnv(cfg), stdio: ['ignore', 'pipe', 'pipe'] });
  const w = watch(child);
  relayLines(child.stdout, log, 'postgres'); relayLines(child.stderr, log, 'postgres');
  try {
    await waitFor(async () => {
      if (signal?.aborted) fail('PostgreSQL start aborted');
      if (w.settled) { const r = await w.done; fail(`PostgreSQL ${r.error ? `failed to start: ${r.error.message}` : `exited (${r.signal || r.code}) before its socket answered`}`); }
      return socketUp(path.join(sockDir(cfg), '.s.PGSQL.5432'));
    }, readyTimeoutMs, 'PostgreSQL socket');
  } catch (e) { await stopChild(child, 'SIGINT', 15000); throw e; }
  return child;
}

/** indexd for this replica: no inherited environment, a memory limit, its config from the runtime dir. -> the child */
export function startIndexd(cfg, pkg, { log = () => {}, spawn = spawnChild } = {}) {
  const config = renderIndexdConfig(cfg);
  const child = spawn(pkg.indexd, [], { cwd: stateDir(cfg), stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', HOME: stateDir(cfg), INDEXD_CONFIG_FILE: config, INDEXD_DATA_DIR: stateDir(cfg), GOMEMLIMIT: `${Math.floor(cfg.memoryMiB.indexd / 2)}MiB` } });
  watch(child);
  relayLines(child.stdout, log, 'indexd'); relayLines(child.stderr, log, 'indexd');
  return child;
}

/**
 * Supervise while admitted. Refusal (ban, allowlist miss, inactive/deregistered, wrong operator/descriptor, package
 * change): stop indexd, then PostgreSQL (data kept), and stay stopped until admitted again. Crashes restart with backoff.
 * stop() is TERMINAL and idempotent: it aborts an in-flight PostgreSQL start, waits for the in-flight decision, then
 * stops both processes; after `await stop()` no child of this supervisor runs and no pending callback can start one.
 * deps (tests): { admission, startPostgres, startIndexd } replace the real ones.
 * -> { status(), stop(), tick() }
 */
export async function superviseReplica(rawCfg, { gate = null, ungatedTest = false, log = (m) => console.log(new Date().toISOString(), m), intervalMs = 5000,
  backoffMs = 1000, maxBackoffMs = 60000, deps = {} } = {}) {
  const d = { admission, startPostgres, startIndexd, ...deps };
  const cfg = validateConfig(rawCfg);
  if (!gate) {
    const { createHostServiceGate } = await import('../host-service-gate.mjs');
    gate = createHostServiceGate({ env: policyEnv(cfg), chainId: 8453, endpoint: cfg.host.endpoint, stateDir: path.join(cfg.stateRoot, cfg.replica, 'host-policy'), log });
  }
  if (!fs.existsSync(path.join(dataDir(cfg), 'PG_VERSION'))) fail(`replica ${cfg.replica} is not initialised (run init on an admitted host)`);
  const st = { pg: null, indexd: null, refusal: 'not checked yet', admitted: false, restarts: 0, wait: backoffMs, timer: null, stopping: false, stopped: null,
    lastExit: null, pkg: null, inflight: null, phase: 'idle', abort: new AbortController() };
  const clearRestart = () => { if (st.timer) { clearTimeout(st.timer); st.timer = null; } };
  const shutdown = async (why) => {
    clearRestart();
    if (st.indexd || st.pg) log(`[storage-indexer] stopping replica ${cfg.replica}: ${why}`);
    const i = st.indexd; st.indexd = null; await stopChild(i, 'SIGTERM', 180000);
    const p = st.pg; st.pg = null; await stopChild(p, 'SIGINT', 150000);
  };
  const scheduleRestart = () => {
    if (st.stopping || !st.admitted || st.timer) return;
    st.restarts++; log(`[storage-indexer] indexd restarting in ${st.wait} ms`);
    st.timer = setTimeout(() => { st.timer = null; if (!st.stopping) startIndexdNow(); }, st.wait); st.timer.unref?.();
    st.wait = Math.min(maxBackoffMs, st.wait * 2);
  };
  const startIndexdNow = () => {
    if (st.stopping || !st.admitted || st.indexd || !alive(st.pg) || st.timer) return;   // a pending backoff restart owns the next start
    let child;
    try { child = d.startIndexd(cfg, st.pkg, { log }); }
    catch (e) { st.lastExit = { code: null, signal: null, error: e.message, at: Date.now() }; log(`[storage-indexer] indexd failed to start: ${e.message}`); scheduleRestart(); return; }
    st.indexd = child; const started = Date.now();
    // exactly once per child, whether it exits, fails to spawn ('error' without 'exit'), or both
    watch(child).done.then(({ code, signal, error }) => {
      if (st.indexd === child) st.indexd = null;
      st.lastExit = { code, signal, error: error ? error.message : null, at: Date.now() };
      if (st.stopping || !st.admitted) return;
      if (Date.now() - started > 60000) st.wait = backoffMs;
      log(`[storage-indexer] indexd ${error ? `failed: ${error.message}` : `exited (${signal || code})`}`);
      scheduleRestart();
    });
    log(`[storage-indexer] indexd started (pid ${child.pid}) for replica ${cfg.replica}`);
  };
  const tick = async () => {
    if (st.stopping) return;
    st.phase = 'deciding';                                     // spawns nothing; stop() need not wait for it (an RPC may hang)
    const a = await d.admission(cfg, gate, { ungatedTest });
    st.phase = 'acting';
    if (st.stopping) return;                                   // stop() arrived while deciding: never act on that decision
    if (!a.admit && a.transient && st.admitted) { log(`[storage-indexer] keeping replica ${cfg.replica} running through a transient read failure: ${a.reason}`); return; }
    if (!a.admit) {
      if (st.admitted || st.refusal !== a.reason || Date.now() - (st.refusalLogged || 0) > 60000) {
        log(`[storage-indexer] NOT running replica ${cfg.replica}: ${a.reason}`); st.refusalLogged = Date.now();
      }
      st.admitted = false; st.refusal = a.reason; await shutdown(a.reason); return;
    }
    if (!st.admitted) log(`[storage-indexer] replica ${cfg.replica} admitted: ${a.reason}`);
    st.admitted = true; st.refusal = null; st.pkg = a.pkg;
    if (!alive(st.pg)) {
      st.pg = null;
      const pg = await d.startPostgres(cfg, { log, signal: st.abort.signal });
      if (st.stopping) { await stopChild(pg, 'SIGINT', 150000); return; }   // started across a stop: never kept
      st.pg = pg; log('[storage-indexer] PostgreSQL started (socket only)');
    }
    if (st.stopping) return;
    startIndexdNow();
  };
  // one decision at a time: overlapping ticks (timer, callers) share the in-flight one
  const once = () => {
    if (st.inflight) return st.inflight;
    st.inflight = (async () => { try { await tick(); } catch (e) { log(`[storage-indexer] tick: ${e.message}`); } })().finally(() => { st.inflight = null; st.phase = 'idle'; });
    return st.inflight;
  };
  gate.start?.();
  await once();
  // NOT unref'd: while refused, PostgreSQL and indexd are stopped and this timer is what keeps the supervisor alive
  const iv = setInterval(() => { if (!st.stopping) void once(); }, intervalMs);
  return {
    tick: () => (st.stopping ? Promise.resolve() : once()),
    status: () => ({ replica: cfg.replica, admitted: st.admitted, refusal: st.refusal, postgres: alive(st.pg), indexd: alive(st.indexd),
      indexdPid: st.indexd?.pid ?? null, restarts: st.restarts, lastExit: st.lastExit, stopped: st.stopping, platformHostPolicy: gate.status?.() ?? null }),
    stop() {
      return (st.stopped ||= (async () => {
        st.stopping = true; clearInterval(iv); clearRestart(); st.abort.abort(); gate.stop?.();
        // a tick that is STARTING or STOPPING processes finishes first (an aborted PostgreSQL start stops its own child);
        // a tick still DECIDING is not awaited: it re-checks `stopping` before acting, so it can never start anything
        if (st.inflight && st.phase !== 'deciding') await st.inflight;
        await shutdown('supervisor stopped');
      })());
    },
  };
}

/** Encrypted logical backup: pg_dump -Fc | zstd | CMS AuthEnvelopedData (AES-256-GCM) to the owner's certificate. */
export async function backupReplica(cfg, outFile, ownerCert) {
  const sh = `set -o pipefail; "${cfg.pgBin}/pg_dump" -Fc -h "${sockDir(cfg)}" -d indexd | zstd -q -12 | openssl cms -encrypt -binary -aes-256-gcm -outform DER -out "${outFile}.part" "${ownerCert}"`;
  await run('/bin/bash', ['-c', sh], { env: pgEnv(cfg) });
  fs.renameSync(outFile + '.part', outFile);
  const digest = sha(fs.readFileSync(outFile));
  fs.writeFileSync(outFile + '.sha256', `${digest}  ${path.basename(outFile)}\n`);
  return digest;
}

/** Restore into THIS replica's empty indexd database (PostgreSQL running): digest, decrypt, decompress, pg_restore. */
export async function restoreReplica(cfg, inFile, ownerKey, ownerCert) {
  const want = fs.readFileSync(inFile + '.sha256', 'utf8').split(/\s+/)[0];
  if (sha(fs.readFileSync(inFile)) !== want) fail(`backup ${inFile} does not match its digest`);
  // a restore goes into a freshly initialised replica BEFORE its indexd ever starts (indexd would create its schema)
  const temp = (await socketUp(path.join(sockDir(cfg), '.s.PGSQL.5432'))) ? null : await startPostgres(cfg);
  try {
    const sh = `set -o pipefail; openssl cms -decrypt -binary -inform DER -in "${inFile}" -inkey "${ownerKey}" -recip "${ownerCert}" | zstd -q -d | "${cfg.pgBin}/pg_restore" --exit-on-error --single-transaction -h "${sockDir(cfg)}" -d indexd`;
    await run('/bin/bash', ['-c', sh], { env: pgEnv(cfg) });
  } finally { if (temp) await stopChild(temp, 'SIGINT'); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, file, ...rest] = process.argv.slice(2);
  const usage = 'usage: storage-indexer-host.mjs check|init|run|backup|restore <host.json> [...]';
  if (!['check', 'init', 'run', 'backup', 'restore'].includes(cmd) || !file) { console.error(usage); process.exit(2); }
  try {
    const cfg = validateConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
    const { createHostServiceGate } = await import('../host-service-gate.mjs');
    const gate = createHostServiceGate({ env: policyEnv(cfg), chainId: 8453, endpoint: cfg.host.endpoint, stateDir: path.join(cfg.stateRoot, cfg.replica, 'host-policy') });
    if (cmd === 'check') { const a = await admission(cfg, gate); console.log(JSON.stringify({ admit: a.admit, reason: a.reason, hostId: a.hostId, operator: a.operator ?? null }, null, 2)); process.exit(a.admit ? 0 : 1); }
    if (cmd === 'init') { const a = await admission(cfg, gate); if (!a.admit) fail(`refusing init: ${a.reason}`); console.log(JSON.stringify(await initReplica(cfg))); process.exit(0); }
    if (cmd === 'backup') { console.log(await backupReplica(cfg, rest[0], rest[1])); process.exit(0); }
    if (cmd === 'restore') { await restoreReplica(cfg, rest[0], rest[1], rest[2]); console.log('restored'); process.exit(0); }
    const sup = await superviseReplica(cfg, { gate });
    for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { sup.stop().then(() => process.exit(0)); });
  } catch (e) { console.error(e.message); process.exit(1); }
}
