// Run Enclave host-service packages on an Enclave host (network/host-services/roles.mjs; work/hosted-service-placement).
//
//   node network/host-services/runner.mjs check <host-services.json>     validate, verify every package, print the plan
//   node network/host-services/runner.mjs run <host-services.json>       ...then start and supervise the roles
//   node network/host-services/runner.mjs advertise <host-services.json> --operator 0x.. --slot N --sequence N [--ttl-days D]
//                                                                         the UNSIGNED service-index publication for each
//                                                                         role (the operator signs and sends it; nothing here)
//
// host-services.json:
//   { "format": "enclave-host-services/v1",
//     "host": { "endpoint": "<this host's registry endpoint (its PUBLIC_URL)>", "publicEndpoints": { "<role>": ["http://A.B.C.D:P/"] } },
//     "platformHostPolicy": "production" | "off" | { book, hostOwnership, mirrors[], activation?, rpcs?, minAgree? },
//     "platformHostPolicyMirrors"?: ["https://…"], "platformHostPolicyRpcs"?: ["https://…", …],
//     "platformHostPolicyCarriers"?: { "importDir"?: "/abs/dir", "peers"?: ["http(s)://<host>/platform-policy"], "serviceIndex"?: true },
//     "serviceIndex"?: { chainId, address, codeHash },
//     "packagesDir": "/abs/dir", "stateRoot": "/abs/dir",
//     "services": [ { "role": "directory-replica", "package": "sha256:<the reviewed package manifest digest>", "heapMiB": 256, "config": { … } } ] }
//
// Policy documents without the fleet (network/policy-carriers.mjs): the gate below is the unchanged platform host policy
// gate; besides its configured HTTPS mirrors (production: the fleet's) it is shown untrusted CARRIERS - an operator-imported
// copy (importDir), this host's own policy-mirror store (read from disk, so the role need not be running), other hosts'
// policy mirrors (peers) and those advertised in the pinned service index (serviceIndex: true). Each candidate must be signed
// by the book's current owner at a fresh agreed block before the gate sees it, and the gate still requires the anchored
// digest, its own signature check, the sequence high-water and the bans. So a fresh host with an empty cache starts while
// the book anchors a policy and every fleet mirror is down, and a policy-mirror host does not need its own mirror to start.
//
// What the runner guarantees:
//   - only the reviewed bytes run: the manifest digest is the operator's pin, the bundle must match the manifest;
//   - only public configuration reaches a role: each role's strict validator (roles.mjs); no field that names a secret;
//   - a role's process gets no inherited environment (PATH and the role's own names only), a V8 heap cap (heapMiB, passed as
//     --max-old-space-size: it bounds the JavaScript old-space heap only, NOT the process's resident memory - buffers,
//     native and code memory are outside it; the process memory limit is the host service manager's, e.g. systemd
//     MemoryMax= on the runner's unit, which bounds every role it starts), and a restart backoff that also covers a
//     failed spawn;
//   - the platform host policy gates it exactly as it gates app service on this host (network/host-service-gate.mjs): a ban,
//     an allowlist miss or a deregistration STOPS every role (sticky until the admin's admit); a transient outage keeps
//     serving for the gate's grace; "off" must be written explicitly and is reported as such.
import { chainVerifierOf } from '../verified-chain.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn as spawnChild } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PRODUCTION_BOOK, PRODUCTION_HOST_OWNERSHIP } from '../platform-host-policy-config.mjs';
import { ROLES, CONFIG_FORMAT, PACKAGE_FORMAT, SECRETISH } from './roles.mjs';
import { CARRIER_MIRROR, validateCarrierBases } from '../policy-carriers.mjs';
import { rpcEndpoint } from '../rpc-identity.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const plain = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const fail = (m) => { throw new Error(`host services: ${m}`); };

/** The reviewed package for `role`: its manifest must hash to `pin` (sha256:<hex>), its bundle to the manifest. */
export function loadPackage(packagesDir, role, pin) {
  if (!ROLES[role]) fail(`unknown role ${JSON.stringify(role)}`);
  if (!/^sha256:[0-9a-f]{64}$/.test(String(pin))) fail(`${role}: package must pin the reviewed manifest digest (sha256:<64 hex>)`);
  const manifestFile = path.join(packagesDir, `${role}.package.json`);
  const raw = fs.readFileSync(manifestFile);
  if ('sha256:' + sha(raw) !== pin) fail(`${role}: package manifest ${manifestFile} is not the pinned ${pin}`);
  const m = JSON.parse(raw);
  if (m.format !== PACKAGE_FORMAT || m.role !== role || m.entry !== ROLES[role].entry || m.kind !== ROLES[role].kind) fail(`${role}: the manifest is not this role's package`);
  const bundle = path.join(packagesDir, path.basename(m.bundle));
  const bytes = fs.readFileSync(bundle);
  if (sha(bytes) !== m.bundleSha256 || bytes.length !== m.bytes) fail(`${role}: bundle ${bundle} does not match its manifest`);
  return { manifest: m, bundle, pin };
}

// The only environment a role inherits besides its own names. On Windows a process without SystemRoot cannot initialise
// Winsock or the system crypto provider (sockets and randomness fail), so the two OS directory names (not secrets) are
// carried there, and PATH is the system directory; elsewhere a fixed PATH only.
function baseEnv() {
  if (process.platform !== 'win32') return { PATH: '/usr/local/bin:/usr/bin:/bin' };
  const root = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
  return { SystemRoot: root, WINDIR: process.env.WINDIR || root, PATH: `${root}\\System32` };
}

/** -> the normalized configuration (throws on anything else). */
export function validateHostServicesConfig(cfg) {
  if (!plain(cfg)) fail('configuration must be an object');
  const allowed = ['format', 'host', 'platformHostPolicy', 'platformHostPolicyMirrors', 'platformHostPolicyRpcs', 'platformHostPolicyCarriers', 'serviceIndex', 'packagesDir', 'stateRoot', 'services', 'chainAuthority', 'chainVerifier'];
  for (const k of Object.keys(cfg)) if (!allowed.includes(k)) fail(`unknown field ${JSON.stringify(k)}${SECRETISH.test(k) ? ' (host services hold no secret)' : ''}`);
  if (cfg.format !== CONFIG_FORMAT) fail(`format must be ${CONFIG_FORMAT}`);
  for (const k of ['packagesDir', 'stateRoot']) if (typeof cfg[k] !== 'string' || !path.isAbsolute(cfg[k])) fail(`${k} must be an absolute path`);
  if (cfg.platformHostPolicy === undefined) fail('platformHostPolicy is required: "production", an explicit platform JSON, or "off" (explicit; not a production configuration)');
  if (!(cfg.platformHostPolicy === 'production' || cfg.platformHostPolicy === 'off' || plain(cfg.platformHostPolicy))) fail('platformHostPolicy: "production" | "off" | { book, hostOwnership, mirrors[] }');
  if (cfg.platformHostPolicyMirrors !== undefined && (!Array.isArray(cfg.platformHostPolicyMirrors) || cfg.platformHostPolicyMirrors.some((u) => typeof u !== 'string' || !/^https:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/.test(u)))) fail('platformHostPolicyMirrors: https URLs');
  // the policy's own RPC quorum: https (http only on loopback), one vote per provider (network/rpc-identity.mjs)
  // chainAuthority 'verifier' + chainVerifier (loopback): the platform policy, its carriers and the index carriers read
  // the local proof-backed verifier instead of the RPC quorum (no fallback)
  try { chainVerifierOf({ chainAuthority: cfg.chainAuthority, chainVerifier: cfg.chainVerifier }, 'host services'); } catch (e) { fail(e.message); }
  if (cfg.platformHostPolicyRpcs !== undefined) {
    if (!Array.isArray(cfg.platformHostPolicyRpcs) || cfg.platformHostPolicyRpcs.length < 1 || cfg.platformHostPolicyRpcs.length > 8) fail('platformHostPolicyRpcs: 1 to 8 RPC URLs');
    const ids = cfg.platformHostPolicyRpcs.map((u, i) => { try { return rpcEndpoint(u).identity; } catch (e) { return fail(`platformHostPolicyRpcs[${i}]: https (http only on loopback), without credentials`); } });
    if (new Set(ids).size !== ids.length) fail('platformHostPolicyRpcs: distinct providers');
  }
  const pc = cfg.platformHostPolicyCarriers;
  if (pc !== undefined) {
    if (!plain(pc) || Object.keys(pc).some((k) => !['importDir', 'peers', 'serviceIndex'].includes(k))) fail('platformHostPolicyCarriers: { importDir?, peers?, serviceIndex? }');
    if (pc.importDir !== undefined && (typeof pc.importDir !== 'string' || !path.isAbsolute(pc.importDir))) fail('platformHostPolicyCarriers.importDir must be an absolute path');
    try { validateCarrierBases(pc.peers ?? [], 'platformHostPolicyCarriers.peers'); } catch (e) { fail(e.message); }
    if (pc.serviceIndex !== undefined && typeof pc.serviceIndex !== 'boolean') fail('platformHostPolicyCarriers.serviceIndex: true or false');
    if (pc.serviceIndex && !cfg.serviceIndex) fail('platformHostPolicyCarriers.serviceIndex needs the pinned serviceIndex');
    if (cfg.platformHostPolicy === 'off') fail('platformHostPolicyCarriers with platformHostPolicy "off": nothing would use them');
  }
  if (!plain(cfg.host)) fail('host is required');
  for (const k of Object.keys(cfg.host)) if (!['endpoint', 'publicEndpoints'].includes(k)) fail(`host has an unknown field ${JSON.stringify(k)}`);
  // exactly as registered (the host id is keccak256 of it): an https URL, optionally with a path (relay tunnels register
  // https://api.enclave.host/t/<name>), without credentials, query or fragment
  if (cfg.platformHostPolicy !== 'off' && !/^https:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/.test(String(cfg.host.endpoint || '').replace(/\/+$/, ''))) fail('host.endpoint: this host\'s registry endpoint (its PUBLIC_URL) is required to enforce the platform host policy');
  if (!Array.isArray(cfg.services) || cfg.services.length < 1 || cfg.services.length > 8) fail('services: 1 to 8 roles');
  const seen = new Set();
  const services = cfg.services.map((s, i) => {
    if (!plain(s)) fail(`services[${i}] must be an object`);
    if (s.memoryMiB !== undefined) fail(`services[${i}].memoryMiB is now heapMiB: it caps the V8 heap (--max-old-space-size), not the process's memory; set the process limit in the host's service manager`);
    for (const k of Object.keys(s)) if (!['role', 'package', 'heapMiB', 'config'].includes(k)) fail(`services[${i}] has an unknown field ${JSON.stringify(k)}`);
    const role = ROLES[s.role];
    if (!role) fail(`services[${i}]: unknown role ${JSON.stringify(s.role)}`);
    if (seen.has(s.role)) fail(`services[${i}]: ${s.role} twice`); seen.add(s.role);
    const heapMiB = s.heapMiB ?? 256;
    if (!Number.isInteger(heapMiB) || heapMiB < 64 || heapMiB > 2048) fail(`services[${i}].heapMiB: 64 to 2048 (V8 old-space heap cap)`);
    return { role: s.role, package: s.package, heapMiB, config: role.validate(s.config) };
  });
  // a policy mirror carries THIS platform's documents: its book and ownership extension must be the gate's
  const pm = services.find((s) => s.role === 'policy-mirror');
  if (pm && cfg.platformHostPolicy !== 'off') {
    const p = cfg.platformHostPolicy === 'production' ? { book: PRODUCTION_BOOK, hostOwnership: PRODUCTION_HOST_OWNERSHIP } : cfg.platformHostPolicy;
    if (String(p.book).toLowerCase() !== pm.config.book || String(p.hostOwnership).toLowerCase() !== pm.config.hostOwnership) fail('policy-mirror: book and hostOwnership must be the platformHostPolicy\'s');
  }
  const pe = cfg.host.publicEndpoints ?? {};
  if (!plain(pe)) fail('host.publicEndpoints must map roles to endpoints');
  for (const [r, list] of Object.entries(pe)) {
    if (!seen.has(r)) fail(`host.publicEndpoints names ${r}, which this host does not run`);
    if (!Array.isArray(list) || list.length < 1 || list.length > 4) fail(`host.publicEndpoints.${r}: 1 to 4 endpoints`);
  }
  return { ...cfg, services, host: { endpoint: cfg.host.endpoint ? String(cfg.host.endpoint).replace(/\/+$/, '') : null, publicEndpoints: pe } };
}

/** Whether the gate is shown carriers (configured ones, or this host's own policy-mirror store). */
const usesCarriers = (cfg) => cfg.platformHostPolicy !== 'off' && (!!cfg.platformHostPolicyCarriers || cfg.services.some((s) => s.role === 'policy-mirror'));
/** The env names the existing gate reads (network/platform-host-policy-config.mjs), from the explicit configuration. The
 *  carrier set is one more mirror origin (CARRIER_MIRROR, answered by policyCarrierFetch). */
export function policyEnv(cfg) {
  const p = cfg.platformHostPolicy;
  const mirrors = [...(cfg.platformHostPolicyMirrors || []), ...(usesCarriers(cfg) ? [CARRIER_MIRROR] : [])];
  return { ENCLAVE_PLATFORM_HOST_POLICY: typeof p === 'string' ? p : JSON.stringify(p),
    ...(mirrors.length ? { ENCLAVE_PLATFORM_HOST_POLICY_MIRRORS: mirrors.join(',') } : {}),
    ...(cfg.platformHostPolicyRpcs ? { ENCLAVE_PLATFORM_HOST_POLICY_RPCS: cfg.platformHostPolicyRpcs.join(',') } : {}),
    ...(cfg.chainAuthority === 'verifier' ? { ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: cfg.chainVerifier } : {}) };
}
/**
 * The fetch the gate uses: CARRIER_MIRROR answered from this host's carriers (importDir, its policy-mirror store, peers,
 * service-index policy mirrors), each candidate signed by the book's current owner at a fresh agreed block of the policy's
 * own RPC quorum; everything else goes to `fetch`.
 */
export async function policyCarrierFetch(cfg, { fetch = globalThis.fetch, log = () => {} } = {}) {
  if (!usesCarriers(cfg)) return fetch;
  const { resolveHostPolicyConfig } = await import('../platform-host-policy-config.mjs');
  const { hostPolicySnapshot } = await import('../host-policy-runtime.mjs');
  const pcm = await import('../policy-carriers.mjs');
  const resolved = resolveHostPolicyConfig({ env: policyEnv(cfg), chainId: 8453 });
  const { book, hostOwnership, rpcs, minAgree, chainAuthority, chainVerifier } = resolved.config;
  if (chainAuthority !== 'verifier' && (!rpcs || !rpcs.length)) fail('platform host policy carriers need the policy\'s RPC quorum (platformHostPolicyRpcs or the platform\'s rpcs)');
  const pc = cfg.platformHostPolicyCarriers || {};
  const mirror = cfg.services.find((s) => s.role === 'policy-mirror');
  const carriers = [
    ...(pc.importDir ? [pcm.fileCarrier(pc.importDir)] : []),
    ...(mirror ? [pcm.fileCarrier(path.join(mirror.config.stateDir, 'documents'))] : []),
    ...pcm.httpCarriers(pc.peers || [], { fetch }),
    ...(pc.serviceIndex ? [pcm.indexCarriers({ pin: cfg.serviceIndex, peers: rpcs, fetch, log, chainAuthority, chainVerifier })] : []),
  ];
  const verify = pcm.freshVerifier({ snapshot: hostPolicySnapshot({ rpcs, minAgree, chainAuthority, chainVerifier }), book, hostOwnership });
  return pcm.carrierFetch({ carriers, verify, fetch, log });
}

/** The plan: what would run, from which verified bytes, with which public configuration. No process is started. */
export function planHostServices(rawCfg) {
  const cfg = validateHostServicesConfig(rawCfg);
  const services = cfg.services.map((s) => {
    const pkg = loadPackage(cfg.packagesDir, s.role, s.package);
    const launch = ROLES[s.role].launch(s.config);
    return { ...s, bundle: pkg.bundle, bundleSha256: pkg.manifest.bundleSha256, kind: pkg.manifest.kind, launch };
  });
  return { cfg, services };
}

/**
 * Start and supervise the plan. gate: { start(), stop(), check(), serviceRefusal(), status() } (default: the platform host
 * policy gate for this host, network/host-service-gate.mjs). -> { status(), stop() }.
 */
export async function runHostServices(rawCfg, { gate = null, spawn = spawnChild, fetch = globalThis.fetch, log = (m) => console.log(new Date().toISOString(), m), intervalMs = 5000,
  backoffMs = 1000, maxBackoffMs = 60000, gateIntervalMs = null } = {}) {
  const { cfg, services } = planHostServices(rawCfg);
  if (!gate) {
    const { createHostServiceGate } = await import('../host-service-gate.mjs');
    gate = createHostServiceGate({ env: policyEnv(cfg), chainId: 8453, endpoint: cfg.host.endpoint, stateDir: path.join(cfg.stateRoot, 'host-policy'), log,
      fetch: await policyCarrierFetch(cfg, { fetch, log }), ...(gateIntervalMs ? { intervalMs: gateIntervalMs } : {}) });
  }
  if (cfg.platformHostPolicy === 'off') log('[host-services] platform host policy is EXPLICITLY OFF for these roles: not a production configuration');
  const units = services.map((s) => ({ ...s, child: null, restarts: 0, wait: backoffMs, lastExit: null, timer: null, stopped: false }));
  let stopping = false, refusal = null;
  const start = (u) => {
    if (stopping || refusal || u.child || u.timer) return;          // a pending restart keeps its backoff
    const dir = path.join(cfg.stateRoot, u.role);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const argv = [`--max-old-space-size=${u.heapMiB}`, u.bundle];      // a V8 heap cap, not a process memory limit
    if (u.launch.configFile) {
      const file = path.join(dir, 'config.json');
      fs.writeFileSync(file, JSON.stringify(u.launch.configFile), { mode: 0o600 });
      argv.push(file);
    }
    // no inherited environment: the role's own public names and a PATH, nothing of the host's
    let child;
    try { child = spawn(process.execPath, argv, { cwd: dir, env: { ...baseEnv(), ...u.launch.env }, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { u.startedAt = Date.now(); return ended(u, null, { error: e }); }
    u.child = child; u.startedAt = Date.now();
    const relay = (stream) => stream?.on('data', (d) => { for (const line of String(d).split('\n').filter(Boolean)) log(`[${u.role}] ${line.slice(0, 500)}`); });
    relay(child.stdout); relay(child.stderr);
    // 'error': the process could not be spawned (EAGAIN, ENOMEM, EACCES...) - no 'exit' may follow - or a signal could not
    // be delivered to it (it may still be running). Either is handled; neither throws out of the runner.
    child.on('error', (e) => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return ended(u, child, { error: e });
      log(`[host-services] ${u.role} (pid ${child.pid}): ${e.code || e.message}; still running`);
    });
    child.on('exit', (code, signal) => ended(u, child, { code, signal }));
    if (child.pid !== undefined) log(`[host-services] ${u.role} started (pid ${child.pid}, package ${u.package.slice(0, 19)}…, V8 heap cap ${u.heapMiB} MiB)`);
  };
  // one end per child, whichever of 'exit' / 'error' (or a throwing spawn) reports it first
  const ended = (u, child, how) => {
    if (child && u.child !== child) return;
    if (child) { if (child.ended) return; child.ended = true; }
    u.child = null; u.lastExit = { code: how.code ?? null, signal: how.signal ?? null, ...(how.error ? { error: how.error.code || how.error.message } : {}), at: Date.now() };
    if (stopping || refusal || u.stopped) return;
    if (Date.now() - u.startedAt > 60000) u.wait = backoffMs;      // it ran: start the backoff over
    u.restarts++; log(`[host-services] ${u.role} ${how.error ? `could not start (${how.error.code || how.error.message})` : `exited (${how.signal || how.code})`}; restarting in ${u.wait} ms`);
    u.timer = setTimeout(() => { u.timer = null; start(u); }, u.wait); u.timer.unref?.();
    u.wait = Math.min(maxBackoffMs, u.wait * 2);
  };
  const halt = (u) => { if (u.timer) { clearTimeout(u.timer); u.timer = null; } if (u.child) { try { u.child.kill('SIGTERM'); } catch (e) { log(`[host-services] ${u.role}: SIGTERM failed (${e.code || e.message})`); } } };
  const apply = async () => {
    await gate.check().catch(() => {});
    const r = gate.serviceRefusal();
    if (r && !refusal) { refusal = r; log(`[host-services] STOPPING every role: ${r}`); units.forEach(halt); }
    else if (!r && refusal) { log(`[host-services] admitted again: starting roles (${refusal} cleared)`); refusal = null; }
    if (!refusal) units.forEach(start);
  };
  gate.start?.();
  await apply();
  const timer = setInterval(() => void apply(), intervalMs); timer.unref?.();
  return {
    status: () => ({ platformHostPolicy: gate.status?.() ?? null, refusal, services: units.map((u) => ({ role: u.role, kind: u.kind, package: u.package,
      bundleSha256: u.bundleSha256, running: !!u.child, pid: u.child?.pid ?? null, restarts: u.restarts, lastExit: u.lastExit })) }),
    async stop() {
      stopping = true; clearInterval(timer); gate.stop?.();
      await Promise.all(units.map((u) => new Promise((ok) => { if (!u.child) { halt(u); return ok(); } u.child.once('exit', ok); halt(u); setTimeout(() => { try { u.child?.kill('SIGKILL'); } catch {} ok(); }, 5000).unref?.(); })));
    },
  };
}

/** The UNSIGNED service-index publication of each role this host serves (network/service-index.mjs; the operator signs). */
export async function advertisements(rawCfg, { operator, slot, sequence, ttlSec = 30 * 86400, now = Math.floor(Date.now() / 1000) }) {
  const si = await import('../service-index.mjs');
  const { cfg, services } = planHostServices(rawCfg);
  if (!cfg.serviceIndex) fail('serviceIndex (the pinned index) is required to prepare advertisements');
  const pin = si.validateIndexPin(cfg.serviceIndex);
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(operator)) || !Number.isInteger(slot) || !/^[1-9][0-9]*$/.test(String(sequence))) fail('advertise needs --operator 0x…, --slot N and --sequence N (> 0)');
  return services.filter((s) => cfg.host.publicEndpoints[s.role]).map((s, i) => {
    // the descriptor names the exact package a candidate claims to run (a claim, not proof: clients verify what is served)
    // (the shape service-index.mjs verifyDescriptor reads: format, operator and kind, then the role's own fields)
    const descriptor = Buffer.from(JSON.stringify({ format: 'enclave-service-descriptor/v1', operator: String(operator).toLowerCase(), kind: s.kind,
      role: s.role, package: s.package, bundleSha256: s.bundleSha256 }));
    const input = si.validateAdInput({ slot: slot + i, kind: s.kind, endpoints: cfg.host.publicEndpoints[s.role], ttlSec, descriptor: si.descriptorHash(descriptor) });
    const typed = si.publishTypedData({ chainId: pin.chainId, index: pin.address, operator, slot: input.slot, kind: input.kind, sequence: BigInt(sequence),
      expiresAt: BigInt(now + ttlSec), descriptor: input.descriptor, endpoints: input.endpoints });
    return { role: s.role, kind: s.kind, endpoints: input.endpoints, descriptor: descriptor.toString(), descriptorHash: input.descriptor, typedData: typed, signed: false };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, file, ...rest] = process.argv.slice(2);
  const usage = 'usage: runner.mjs check|run|advertise <host-services.json> [--operator 0x.. --slot N --sequence N --ttl-days D]';
  if (!['check', 'run', 'advertise'].includes(cmd) || !file) { console.error(usage); process.exit(2); }
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  try {
    if (cmd === 'check') {
      const { cfg: c, services } = planHostServices(cfg);
      const warnings = c.platformHostPolicy !== 'off' && !usesCarriers(c) ? ['no platform host policy carrier (platformHostPolicyCarriers or a policy-mirror role): the only policy mirrors are the configured HTTPS ones (production: the fleet\'s four), so with them down a fresh host cannot load an anchored policy and will not start'] : [];
      console.log(JSON.stringify({ ok: true, platformHostPolicy: c.platformHostPolicy, policyCarriers: usesCarriers(c) ? { ...(c.platformHostPolicyCarriers || {}), ownPolicyMirror: c.services.some((s) => s.role === 'policy-mirror') } : null,
        warnings, services: services.map((s) => ({ role: s.role, kind: s.kind, package: s.package,
        bundleSha256: s.bundleSha256, heapMiB: s.heapMiB, env: Object.keys(s.launch.env), configFile: !!s.launch.configFile })) }, null, 2));
    } else if (cmd === 'advertise') {
      const flag = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
      const ads = await advertisements(cfg, { operator: flag('--operator'), slot: Number(flag('--slot') ?? 0), sequence: flag('--sequence') ?? '1', ttlSec: Number(flag('--ttl-days') ?? 30) * 86400 });
      console.log(JSON.stringify(ads, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    } else {
      const running = await runHostServices(cfg);
      // the supervision timers are unref'd (library use). As a service the runner must STAY UP while no role runs - a
      // fresh host not yet admitted, or a sticky platform-policy refusal - or it would exit 0, systemd would not restart a
      // clean exit, and the admin's later authenticated admit (unban) would never restart the roles. Until SIGTERM/SIGINT.
      const alive = setInterval(() => {}, 1 << 30);
      // SIGBREAK: how a Windows supervisor (windows-supervisor: CTRL_BREAK to the runner's process group) asks it to stop
      for (const sig of ['SIGTERM', 'SIGINT', 'SIGBREAK']) process.on(sig, () => { clearInterval(alive); running.stop().then(() => process.exit(0)); });
    }
  } catch (e) { console.error(e.message); process.exit(1); }
}
