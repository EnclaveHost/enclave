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
//     "serviceIndex"?: { chainId, address, codeHash },
//     "packagesDir": "/abs/dir", "stateRoot": "/abs/dir",
//     "services": [ { "role": "directory-replica", "package": "sha256:<the reviewed package manifest digest>", "memoryMiB": 256, "config": { … } } ] }
//
// What the runner guarantees:
//   - only the reviewed bytes run: the manifest digest is the operator's pin, the bundle must match the manifest;
//   - only public configuration reaches a role: each role's strict validator (roles.mjs); no field that names a secret;
//   - a role's process gets no inherited environment (PATH and the role's own names only), a memory cap, a restart backoff;
//   - the platform host policy gates it exactly as it gates app service on this host (network/host-service-gate.mjs): a ban,
//     an allowlist miss or a deregistration STOPS every role (sticky until the admin's admit); a transient outage keeps
//     serving for the gate's grace; "off" must be written explicitly and is reported as such.
import fs from 'node:fs';
import path from 'node:path';
import { spawn as spawnChild } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROLES, CONFIG_FORMAT, PACKAGE_FORMAT, SECRETISH } from './roles.mjs';

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

/** -> the normalized configuration (throws on anything else). */
export function validateHostServicesConfig(cfg) {
  if (!plain(cfg)) fail('configuration must be an object');
  const allowed = ['format', 'host', 'platformHostPolicy', 'platformHostPolicyMirrors', 'platformHostPolicyRpcs', 'serviceIndex', 'packagesDir', 'stateRoot', 'services'];
  for (const k of Object.keys(cfg)) if (!allowed.includes(k)) fail(`unknown field ${JSON.stringify(k)}${SECRETISH.test(k) ? ' (host services hold no secret)' : ''}`);
  if (cfg.format !== CONFIG_FORMAT) fail(`format must be ${CONFIG_FORMAT}`);
  for (const k of ['packagesDir', 'stateRoot']) if (typeof cfg[k] !== 'string' || !path.isAbsolute(cfg[k])) fail(`${k} must be an absolute path`);
  if (cfg.platformHostPolicy === undefined) fail('platformHostPolicy is required: "production", an explicit platform JSON, or "off" (explicit; not a production configuration)');
  if (!(cfg.platformHostPolicy === 'production' || cfg.platformHostPolicy === 'off' || plain(cfg.platformHostPolicy))) fail('platformHostPolicy: "production" | "off" | { book, hostOwnership, mirrors[] }');
  for (const k of ['platformHostPolicyMirrors', 'platformHostPolicyRpcs'])
    if (cfg[k] !== undefined && (!Array.isArray(cfg[k]) || cfg[k].some((u) => typeof u !== 'string' || !/^https:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/.test(u)))) fail(`${k}: https URLs`);
  if (!plain(cfg.host)) fail('host is required');
  for (const k of Object.keys(cfg.host)) if (!['endpoint', 'publicEndpoints'].includes(k)) fail(`host has an unknown field ${JSON.stringify(k)}`);
  if (cfg.platformHostPolicy !== 'off' && !/^https:\/\/[^\s/?#@]+$/.test(String(cfg.host.endpoint || '').replace(/\/+$/, ''))) fail('host.endpoint: this host\'s registry endpoint (its PUBLIC_URL) is required to enforce the platform host policy');
  if (!Array.isArray(cfg.services) || cfg.services.length < 1 || cfg.services.length > 8) fail('services: 1 to 8 roles');
  const seen = new Set();
  const services = cfg.services.map((s, i) => {
    if (!plain(s)) fail(`services[${i}] must be an object`);
    for (const k of Object.keys(s)) if (!['role', 'package', 'memoryMiB', 'config'].includes(k)) fail(`services[${i}] has an unknown field ${JSON.stringify(k)}`);
    const role = ROLES[s.role];
    if (!role) fail(`services[${i}]: unknown role ${JSON.stringify(s.role)}`);
    if (seen.has(s.role)) fail(`services[${i}]: ${s.role} twice`); seen.add(s.role);
    const memoryMiB = s.memoryMiB ?? 256;
    if (!Number.isInteger(memoryMiB) || memoryMiB < 64 || memoryMiB > 2048) fail(`services[${i}].memoryMiB: 64 to 2048`);
    return { role: s.role, package: s.package, memoryMiB, config: role.validate(s.config) };
  });
  const pe = cfg.host.publicEndpoints ?? {};
  if (!plain(pe)) fail('host.publicEndpoints must map roles to endpoints');
  for (const [r, list] of Object.entries(pe)) {
    if (!seen.has(r)) fail(`host.publicEndpoints names ${r}, which this host does not run`);
    if (!Array.isArray(list) || list.length < 1 || list.length > 4) fail(`host.publicEndpoints.${r}: 1 to 4 endpoints`);
  }
  return { ...cfg, services, host: { endpoint: cfg.host.endpoint ? String(cfg.host.endpoint).replace(/\/+$/, '') : null, publicEndpoints: pe } };
}

/** The env names the existing gate reads (network/platform-host-policy-config.mjs), from the explicit configuration. */
export function policyEnv(cfg) {
  const p = cfg.platformHostPolicy;
  return { ENCLAVE_PLATFORM_HOST_POLICY: typeof p === 'string' ? p : JSON.stringify(p),
    ...(cfg.platformHostPolicyMirrors ? { ENCLAVE_PLATFORM_HOST_POLICY_MIRRORS: cfg.platformHostPolicyMirrors.join(',') } : {}),
    ...(cfg.platformHostPolicyRpcs ? { ENCLAVE_PLATFORM_HOST_POLICY_RPCS: cfg.platformHostPolicyRpcs.join(',') } : {}) };
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
export async function runHostServices(rawCfg, { gate = null, spawn = spawnChild, log = (m) => console.log(new Date().toISOString(), m), intervalMs = 5000,
  backoffMs = 1000, maxBackoffMs = 60000 } = {}) {
  const { cfg, services } = planHostServices(rawCfg);
  if (!gate) {
    const { createHostServiceGate } = await import('../host-service-gate.mjs');
    gate = createHostServiceGate({ env: policyEnv(cfg), chainId: 8453, endpoint: cfg.host.endpoint, stateDir: path.join(cfg.stateRoot, 'host-policy'), log });
  }
  if (cfg.platformHostPolicy === 'off') log('[host-services] platform host policy is EXPLICITLY OFF for these roles: not a production configuration');
  const units = services.map((s) => ({ ...s, child: null, restarts: 0, wait: backoffMs, lastExit: null, timer: null, stopped: false }));
  let stopping = false, refusal = null;
  const start = (u) => {
    if (stopping || refusal || u.child) return;
    const dir = path.join(cfg.stateRoot, u.role);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const argv = [`--max-old-space-size=${u.memoryMiB}`, u.bundle];
    if (u.launch.configFile) {
      const file = path.join(dir, 'config.json');
      fs.writeFileSync(file, JSON.stringify(u.launch.configFile), { mode: 0o600 });
      argv.push(file);
    }
    // no inherited environment: the role's own public names and a PATH, nothing of the host's
    const child = spawn(process.execPath, argv, { cwd: dir, env: { PATH: '/usr/local/bin:/usr/bin:/bin', ...u.launch.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    u.child = child; u.startedAt = Date.now();
    const relay = (stream) => stream?.on('data', (d) => { for (const line of String(d).split('\n').filter(Boolean)) log(`[${u.role}] ${line.slice(0, 500)}`); });
    relay(child.stdout); relay(child.stderr);
    child.on('exit', (code, signal) => {
      u.child = null; u.lastExit = { code, signal, at: Date.now() };
      if (stopping || refusal || u.stopped) return;
      if (Date.now() - u.startedAt > 60000) u.wait = backoffMs;      // it ran: start the backoff over
      u.restarts++; log(`[host-services] ${u.role} exited (${signal || code}); restarting in ${u.wait} ms`);
      u.timer = setTimeout(() => { u.timer = null; start(u); }, u.wait); u.timer.unref?.();
      u.wait = Math.min(maxBackoffMs, u.wait * 2);
    });
    log(`[host-services] ${u.role} started (pid ${child.pid}, package ${u.package.slice(0, 19)}…, ${u.memoryMiB} MiB)`);
  };
  const halt = (u) => { if (u.timer) { clearTimeout(u.timer); u.timer = null; } if (u.child) { u.child.kill('SIGTERM'); } };
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
      await Promise.all(units.map((u) => new Promise((ok) => { if (!u.child) return ok(); u.child.once('exit', ok); halt(u); setTimeout(() => { u.child?.kill('SIGKILL'); ok(); }, 5000).unref?.(); })));
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
      console.log(JSON.stringify({ ok: true, platformHostPolicy: c.platformHostPolicy, services: services.map((s) => ({ role: s.role, kind: s.kind, package: s.package,
        bundleSha256: s.bundleSha256, memoryMiB: s.memoryMiB, env: Object.keys(s.launch.env), configFile: !!s.launch.configFile })) }, null, 2));
    } else if (cmd === 'advertise') {
      const flag = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
      const ads = await advertisements(cfg, { operator: flag('--operator'), slot: Number(flag('--slot') ?? 0), sequence: flag('--sequence') ?? '1', ttlSec: Number(flag('--ttl-days') ?? 30) * 86400 });
      console.log(JSON.stringify(ads, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    } else {
      const running = await runHostServices(cfg);
      for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { running.stop().then(() => process.exit(0)); });
    }
  } catch (e) { console.error(e.message); process.exit(1); }
}
