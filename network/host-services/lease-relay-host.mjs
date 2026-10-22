// A DESIGNATED app-funded lease relay, run by a relay operator on an Enclave host (Linux), found by compute hosts through
// the pinned EnclaveServiceIndex (network/lease-relay-discovery.mjs). Compute hosts then need no ETH and no relay of their
// own: the relay operator's capped float pays each claim/renew/release and the app's reserve reimburses it in the same
// transaction.
//
//   node network/host-services/lease-relay-host.mjs init <host-relay.json>             generate the relay key (create-only)
//   node network/host-services/lease-relay-host.mjs descriptor <host-relay.json> --operator 0x…
//                                                              write the descriptor the advertisement commits to
//   node network/host-services/lease-relay-host.mjs advertise <host-relay.json> --operator 0x… --slot N --sequence N [--ttl-days D]
//                                                              the UNSIGNED service-index publication (the operator signs)
//   node network/host-services/lease-relay-host.mjs check <host-relay.json>             validate, verify the package
//   node network/host-services/lease-relay-host.mjs run <host-relay.json>               ...then run and supervise the relay
//
// host-relay.json (format enclave-host-relay/v1): { host: { endpoint, publicEndpoints: ["http(s)://<public address>:<port>/"] },
//   platformHostPolicy: "production" | "off" | {...}, platformHostPolicyMirrors?, platformHostPolicyRpcs?,
//   platformHostPolicyCarriers?: { importDir?, peers?, serviceIndex? }, serviceIndex: {chainId, address, codeHash}, packagesDir,
//   stateRoot, relay: { package: "sha256:<manifest digest>", heapMiB?, port, bind, record, digest, rpc: [2..8 https], quorum,
//   maxFloatEth, minFloatEth, extraCaFile? } }
// relay.heapMiB is the relay process's V8 old-space heap cap (--max-old-space-size), NOT its memory limit: buffers, native and
// code memory are outside it. The process memory limit is the service manager's (relay/systemd/enclave-host-relay.service
// MemoryMax=, which bounds this supervisor and the relay together). relay.memoryMiB (the earlier name) is still accepted as
// exactly the same V8 heap cap; the two may not both be given.
//
// The platform host policy gate is the runner's (runner.mjs policyEnv + policyCarrierFetch -> network/host-service-gate.mjs):
// besides its configured HTTPS mirrors (production: the fleet's) it is shown the same untrusted policy CARRIERS
// (network/policy-carriers.mjs: an operator-imported copy, other hosts' policy mirrors, those advertised in the pinned service
// index), each verified as signed by the book's current owner at a fresh agreed block before the unchanged gate verifies it
// again. So the relay starts from an EMPTY policy cache under an activated, anchored policy with every fleet mirror down,
// and nothing here admits anything the gate does not.
//
// Unlike the discovery roles (roles.mjs: no secret at all), this role HOLDS ONE SECRET: its relay key. It is generated HERE
// (init), written create-only (0600) in this role's own 0700 state directory beside its public address, never imported,
// printed, copied or placed in the configuration (no configuration field may name a key), and handed to the relay only as a
// file path. The key's float is the relay operator's capital, capped (the relay refuses to start above maxFloatEth); funding
// it is the operator's decision. Everything else is the runner's discipline (runner.mjs): only the pinned reviewed bytes
// run, the process gets no inherited environment, a V8 heap cap and a restart backoff, and the platform host policy gates it
// (a ban, an allowlist miss or a deregistration STOPS the relay; sticky until the administrator's admit).
import fs from "node:fs";
import path from "node:path";
import crypto, { createHash } from "node:crypto";
import { spawn as spawnChild } from "node:child_process";
import { pathToFileURL } from "node:url";
import { rpcEndpoint } from "../rpc-identity.mjs";
import { validateCarrierBases } from "../policy-carriers.mjs";
// a field whose name looks like a credential is refused (the same rule as the discovery roles, roles.mjs SECRETISH)
const SECRETISH = /(secret|token|password|passwd|private|mnemonic|seed|apikey|api_key|auth|hmac|credential|key$|keyfile)/i;

export const RELAY_HOST_FORMAT = "enclave-host-relay/v1";
export const PACKAGE_FORMAT = "enclave-host-service-package/v1";
export const ROLE = Object.freeze({ role: "lease-relay", entry: "network/lease-relay-service.mjs", kind: "relay" });
const sha = (b) => createHash("sha256").update(b).digest("hex");
const plain = (o) => !!o && typeof o === "object" && !Array.isArray(o);
const fail = (m) => { throw new Error(`host relay: ${m}`); };
const DECIMAL = /^(0|[1-9][0-9]{0,6})(\.[0-9]{1,18})?$/;
const REGISTERED_ENDPOINT = /^https:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/;
const absPath = (v, what) => { if (typeof v !== "string" || !path.isAbsolute(v) || v.includes("\0")) fail(`${what} must be an absolute path`); return v; };

/** -> the normalized configuration (throws on anything else; no field may name a secret). */
export function validateHostRelayConfig(cfg) {
  if (!plain(cfg)) fail("configuration must be an object");
  const top = ["format", "host", "platformHostPolicy", "platformHostPolicyMirrors", "platformHostPolicyRpcs", "platformHostPolicyCarriers", "serviceIndex", "packagesDir", "stateRoot", "relay"];
  for (const k of Object.keys(cfg)) if (!top.includes(k)) fail(`unknown field ${JSON.stringify(k)}${SECRETISH.test(k) ? " (the key is generated by init, never configured)" : ""}`);
  if (cfg.format !== RELAY_HOST_FORMAT) fail(`format must be ${RELAY_HOST_FORMAT}`);
  absPath(cfg.packagesDir, "packagesDir"); absPath(cfg.stateRoot, "stateRoot");
  if (!(cfg.platformHostPolicy === "production" || cfg.platformHostPolicy === "off" || plain(cfg.platformHostPolicy)))
    fail('platformHostPolicy is required: "production", an explicit platform JSON, or "off" (explicit; not a production configuration)');
  if (cfg.platformHostPolicyMirrors !== undefined && (!Array.isArray(cfg.platformHostPolicyMirrors)
      || cfg.platformHostPolicyMirrors.some((u) => typeof u !== "string" || !/^https:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/.test(u)))) fail("platformHostPolicyMirrors: https URLs");
  // the policy's own RPC quorum: the runner's rule (https; http only on loopback; one vote per provider)
  if (cfg.platformHostPolicyRpcs !== undefined) {
    if (!Array.isArray(cfg.platformHostPolicyRpcs) || cfg.platformHostPolicyRpcs.length < 1 || cfg.platformHostPolicyRpcs.length > 8) fail("platformHostPolicyRpcs: 1 to 8 RPC URLs");
    const ids = cfg.platformHostPolicyRpcs.map((u, i) => { try { return rpcEndpoint(u).identity; } catch { return fail(`platformHostPolicyRpcs[${i}]: https (http only on loopback), without credentials`); } });
    if (new Set(ids).size !== ids.length) fail("platformHostPolicyRpcs: distinct providers");
  }
  // the policy carriers: the runner's shape and rules (network/host-services/runner.mjs), the shared base-URL validator
  const pc = cfg.platformHostPolicyCarriers;
  if (pc !== undefined) {
    if (!plain(pc) || Object.keys(pc).some((k) => !["importDir", "peers", "serviceIndex"].includes(k))) fail("platformHostPolicyCarriers: { importDir?, peers?, serviceIndex? }");
    if (pc.importDir !== undefined) absPath(pc.importDir, "platformHostPolicyCarriers.importDir");
    try { validateCarrierBases(pc.peers ?? [], "platformHostPolicyCarriers.peers"); } catch (e) { fail(e.message); }
    if (pc.serviceIndex !== undefined && typeof pc.serviceIndex !== "boolean") fail("platformHostPolicyCarriers.serviceIndex: true or false");
    if (pc.serviceIndex && !cfg.serviceIndex) fail("platformHostPolicyCarriers.serviceIndex needs the pinned serviceIndex");
    if (cfg.platformHostPolicy === "off") fail('platformHostPolicyCarriers with platformHostPolicy "off": nothing would use them');
  }
  if (!plain(cfg.host)) fail("host is required");
  for (const k of Object.keys(cfg.host)) if (!["endpoint", "publicEndpoints"].includes(k)) fail(`host has an unknown field ${JSON.stringify(k)}`);
  // the runner's rule (runner.mjs validateHostServicesConfig): the EXACT registered endpoint, which may carry a path (e.g.
  // https://api.enclave.host/t/metal0); https only, no credentials, query, fragment or whitespace
  if (cfg.platformHostPolicy !== "off" && !REGISTERED_ENDPOINT.test(String(cfg.host.endpoint || "").replace(/\/+$/, ""))) fail("host.endpoint: this host's registry endpoint (its PUBLIC_URL) is required to enforce the platform host policy");
  const pe = cfg.host.publicEndpoints ?? [];
  if (!Array.isArray(pe) || pe.length > 4) fail("host.publicEndpoints: 0 to 4 endpoints (where compute hosts reach this relay)");
  const r = cfg.relay;
  if (!plain(r)) fail("relay is required");
  const allowed = ["package", "heapMiB", "memoryMiB", "port", "bind", "record", "digest", "rpc", "quorum", "maxFloatEth", "minFloatEth", "extraCaFile"];
  for (const k of Object.keys(r)) if (!allowed.includes(k)) fail(`relay has an unknown field ${JSON.stringify(k)}${SECRETISH.test(k) ? " (the key is generated by init, never configured)" : ""}`);
  if (!/^sha256:[0-9a-f]{64}$/.test(String(r.package))) fail("relay.package must pin the reviewed manifest digest (sha256:<64 hex>)");
  if (r.heapMiB !== undefined && r.memoryMiB !== undefined) fail("relay.heapMiB and relay.memoryMiB (its earlier name) are the same V8 heap cap: give one");
  const heapMiB = r.heapMiB ?? r.memoryMiB ?? 256;
  if (!Number.isInteger(heapMiB) || heapMiB < 128 || heapMiB > 1024) fail("relay.heapMiB: 128 to 1024 (the V8 old-space heap cap, not a process memory limit)");
  if (!Number.isInteger(r.port) || r.port < 1 || r.port > 65535) fail("relay.port must be a port");
  if (typeof r.bind !== "string" || !/^(127\.0\.0\.1|0\.0\.0\.0|::|::1|(\d{1,3}\.){3}\d{1,3})$/.test(r.bind)) fail("relay.bind must be an IP literal");
  absPath(r.record, "relay.record");
  if (!/^sha256:[0-9a-f]{64}$/.test(String(r.digest))) fail("relay.digest must be the reviewed record's sha256:<64 hex>");
  if (!Array.isArray(r.rpc) || r.rpc.length < 2 || r.rpc.length > 8) fail("relay.rpc: 2 to 8 https Base RPCs of distinct providers");
  const ids = new Set();
  for (const [i, u] of r.rpc.entries()) {
    let e; try { e = rpcEndpoint(u); } catch (x) { fail(`relay.rpc[${i}]: ${x.message}`); }
    if (!String(u).startsWith("https://")) fail(`relay.rpc[${i}] must be https`);
    if (ids.has(e.identity)) fail(`relay.rpc[${i}] repeats a provider`); ids.add(e.identity);
  }
  if (!Number.isInteger(r.quorum) || r.quorum < 2 || r.quorum > r.rpc.length || r.quorum <= r.rpc.length / 2) fail("relay.quorum: a strict majority of relay.rpc, at least 2");
  for (const k of ["maxFloatEth", "minFloatEth"]) if (typeof r[k] !== "string" || !DECIMAL.test(r[k]) || Number(r[k]) <= 0) fail(`relay.${k} must be a positive decimal ETH amount`);
  if (Number(r.minFloatEth) >= Number(r.maxFloatEth)) fail("relay.minFloatEth must be below relay.maxFloatEth");
  if (r.extraCaFile !== undefined) absPath(r.extraCaFile, "relay.extraCaFile");
  const { memoryMiB: _legacy, ...relay } = r;
  return { ...cfg, host: { endpoint: cfg.host.endpoint ? String(cfg.host.endpoint).replace(/\/+$/, "") : null, publicEndpoints: pe }, relay: { ...relay, heapMiB } };
}

/** The reviewed package: its manifest must hash to the pin, its bundle to the manifest. */
export function loadRelayPackage(packagesDir, pin) {
  const file = path.join(packagesDir, `${ROLE.role}.package.json`);
  const raw = fs.readFileSync(file);
  if ("sha256:" + sha(raw) !== pin) fail(`package manifest ${file} is not the pinned ${pin}`);
  const m = JSON.parse(raw);
  if (m.format !== PACKAGE_FORMAT || m.role !== ROLE.role || m.entry !== ROLE.entry || m.kind !== ROLE.kind) fail("the manifest is not the lease-relay role's package");
  const bundle = path.join(packagesDir, path.basename(m.bundle));
  const bytes = fs.readFileSync(bundle);
  if (sha(bytes) !== m.bundleSha256 || bytes.length !== m.bytes) fail(`bundle ${bundle} does not match its manifest`);
  return { manifest: m, bundle, pin };
}

const stateDir = (cfg) => path.join(cfg.stateRoot, ROLE.role);
const files = (cfg) => ({ dir: stateDir(cfg), key: path.join(stateDir(cfg), "relay.key"), address: path.join(stateDir(cfg), "relay.address"),
  state: path.join(stateDir(cfg), "relay-send.json"), descriptor: path.join(stateDir(cfg), "descriptor.json") });

/** Generate the relay key ONCE (create-only, 0600, in a 0700 directory); write its public address beside it. */
export async function initRelayKey(rawCfg) {
  const cfg = validateHostRelayConfig(rawCfg), f = files(cfg);
  fs.mkdirSync(f.dir, { recursive: true, mode: 0o700 }); fs.chmodSync(f.dir, 0o700);
  if (fs.existsSync(f.key)) {
    if (!fs.existsSync(f.address)) fail(`${f.key} exists without its public address file: settle by hand (this tool never reads the key)`);
    return { created: false, address: fs.readFileSync(f.address, "utf8").trim() };
  }
  const { privateKeyToAccount } = await import("viem/accounts");
  const d = Buffer.from(crypto.generateKeyPairSync("ec", { namedCurve: "secp256k1" }).privateKey.export({ format: "jwk" }).d, "base64url");
  if (d.length !== 32) fail("generated key has the wrong length");
  const address = privateKeyToAccount("0x" + d.toString("hex")).address;
  fs.writeFileSync(f.key, d.toString("hex") + "\n", { flag: "wx", mode: 0o600 });
  fs.writeFileSync(f.address, address + "\n", { flag: "wx", mode: 0o644 });
  d.fill(0);
  return { created: true, address };
}

/** The descriptor the service-index advertisement commits to (the relay serves it at /v1/descriptor). */
export async function writeRelayDescriptor(rawCfg, { operator }) {
  const cfg = validateHostRelayConfig(rawCfg), f = files(cfg);
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(operator))) fail("--operator 0x… (the address that signs the advertisement) is required");
  const { relayDescriptor } = await import("../lease-relay-discovery.mjs");
  const { parseDeploymentRecord } = await import("../lease-gas-owner.mjs");
  const dep = parseDeploymentRecord(fs.readFileSync(cfg.relay.record), { expectedDigest: cfg.relay.digest });
  const pkg = loadRelayPackage(cfg.packagesDir, cfg.relay.package);
  const payee = fs.readFileSync(f.address, "utf8").trim();
  const bytes = relayDescriptor({ operator, payee, chainId: dep.chainId, reserve: dep.reserve, packagePin: cfg.relay.package, bundleSha256: pkg.manifest.bundleSha256 });
  fs.writeFileSync(f.descriptor, bytes, { mode: 0o644 });
  return { file: f.descriptor, sha256: "0x" + sha(bytes), payee };
}

/** The UNSIGNED service-index publication for this relay (kind relay; the operator signs and sends it). */
export async function relayAdvertisement(rawCfg, { operator, slot, sequence, ttlSec = 30 * 86400, now = Math.floor(Date.now() / 1000) }) {
  const cfg = validateHostRelayConfig(rawCfg), f = files(cfg);
  const si = await import("../service-index.mjs");
  if (!cfg.serviceIndex) fail("serviceIndex (the pinned index) is required to prepare an advertisement");
  if (!cfg.host.publicEndpoints.length) fail("host.publicEndpoints: where compute hosts reach this relay (a public address; not a DigitalOcean one)");
  const pin = si.validateIndexPin(cfg.serviceIndex);
  const bytes = fs.readFileSync(f.descriptor);
  const d = JSON.parse(bytes.toString("utf8"));
  if (d.operator !== String(operator).toLowerCase()) fail("the descriptor names another operator: run `descriptor` for this operator first");
  if (!Number.isInteger(slot) || !/^[1-9][0-9]*$/.test(String(sequence))) fail("advertise needs --slot N and --sequence N (> 0)");
  const input = si.validateAdInput({ slot, kind: "relay", endpoints: cfg.host.publicEndpoints, ttlSec, descriptor: si.descriptorHash(bytes) });
  const typed = si.publishTypedData({ chainId: pin.chainId, index: pin.address, operator, slot: input.slot, kind: input.kind, sequence: BigInt(sequence),
    expiresAt: BigInt(now + ttlSec), descriptor: input.descriptor, endpoints: input.endpoints });
  return { role: ROLE.role, kind: "relay", endpoints: input.endpoints, descriptor: bytes.toString(), descriptorHash: input.descriptor, typedData: typed, signed: false };
}

/** The plan: the verified package, the launch environment (public names, and the key only as a path). No process started. */
export function planHostRelay(rawCfg) {
  const cfg = validateHostRelayConfig(rawCfg), f = files(cfg);
  const pkg = loadRelayPackage(cfg.packagesDir, cfg.relay.package);
  if (!fs.existsSync(f.key) || !fs.existsSync(f.address)) fail(`no relay key yet: run \`init\` (it is generated on this host; nothing is imported)`);
  const r = cfg.relay;
  const env = { LEASE_RELAY_RECORD: r.record, LEASE_RELAY_DIGEST: r.digest, LEASE_RELAY_RPCS: r.rpc.join(","), LEASE_RELAY_QUORUM: String(r.quorum),
    LEASE_RELAY_MAX_FLOAT_ETH: r.maxFloatEth, LEASE_RELAY_MIN_FLOAT_ETH: r.minFloatEth, LEASE_RELAY_LISTEN: `${r.bind.includes(":") ? `[${r.bind}]` : r.bind}:${r.port}`,
    LEASE_RELAY_KEY_FILE: f.key, LEASE_RELAY_STATE: f.state, ...(fs.existsSync(f.descriptor) ? { LEASE_RELAY_DESCRIPTOR: f.descriptor } : {}),
    ...(r.extraCaFile ? { NODE_EXTRA_CA_CERTS: r.extraCaFile } : {}) };
  return { cfg, files: f, bundle: pkg.bundle, bundleSha256: pkg.manifest.bundleSha256, env, payee: fs.readFileSync(f.address, "utf8").trim() };
}

/** The runner-shaped view of this configuration that runner.mjs policyEnv / policyCarrierFetch read (no roles: the relay
 *  is not one of them; a policy-mirror on the same host is reached through platformHostPolicyCarriers.importDir). */
const policyView = (cfg) => ({ platformHostPolicy: cfg.platformHostPolicy, platformHostPolicyMirrors: cfg.platformHostPolicyMirrors,
  platformHostPolicyRpcs: cfg.platformHostPolicyRpcs, platformHostPolicyCarriers: cfg.platformHostPolicyCarriers, serviceIndex: cfg.serviceIndex, services: [] });

/** This host's platform host policy gate for the relay: the runner's env and carrier fetch, network/host-service-gate.mjs. */
export async function hostRelayGate(cfg, { fetch = globalThis.fetch, log = () => {}, gateIntervalMs = null } = {}) {
  const { policyEnv, policyCarrierFetch } = await import("./runner.mjs");
  const { createHostServiceGate } = await import("../host-service-gate.mjs");
  const view = policyView(cfg);
  return createHostServiceGate({ env: policyEnv(view), chainId: 8453, endpoint: cfg.host.endpoint, stateDir: path.join(cfg.stateRoot, "host-policy"), log,
    fetch: await policyCarrierFetch(view, { fetch, log }), ...(gateIntervalMs ? { intervalMs: gateIntervalMs } : {}) });
}

/**
 * Run and supervise the relay. gate: { start(), stop(), check(), serviceRefusal(), status() } (default: hostRelayGate, the
 * runner's gate and carriers). -> { payee, status(), stop() }.
 * Lifecycle: each child is finalized exactly once, by whichever of 'exit', 'error' (when no process is running) or a throwing
 * spawn reports it first; a restart waits out its backoff (a gate check never starts a second one); after stop() nothing is
 * started again, including by a gate check that was still pending.
 */
export async function runHostRelay(rawCfg, { gate = null, spawn = spawnChild, fetch = globalThis.fetch, log = (m) => console.log(new Date().toISOString(), m), intervalMs = 5000,
  backoffMs = 1000, maxBackoffMs = 60000, gateIntervalMs = null } = {}) {
  const plan = planHostRelay(rawCfg), { cfg } = plan;
  if (!gate) gate = await hostRelayGate(cfg, { fetch, log, gateIntervalMs });
  if (cfg.platformHostPolicy === "off") log("[host-relay] platform host policy is EXPLICITLY OFF for this relay: not a production configuration");
  const u = { child: null, restarts: 0, wait: backoffMs, lastExit: null, timer: null, startedAt: 0 };
  let stopping = false, refusal = null, applying = null;
  const start = () => {
    if (stopping || refusal || u.child || u.timer) return;           // a pending restart keeps its backoff
    // no inherited environment: the relay's own public names, the key as a PATH, and a PATH
    let child;
    try {
      child = spawn(process.execPath, [`--max-old-space-size=${cfg.relay.heapMiB}`, plan.bundle], { cwd: plan.files.dir,
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", ...plan.env }, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) { u.startedAt = Date.now(); return ended(null, { error: e }); }
    u.child = child; u.startedAt = Date.now();
    const relay = (stream) => stream?.on("data", (d) => { for (const line of String(d).split("\n").filter(Boolean)) log(`[lease-relay] ${line.slice(0, 500)}`); });
    relay(child.stdout); relay(child.stderr);
    // 'error': the process could not be spawned (no 'exit' may follow), or a signal could not be delivered (it may still run)
    child.on("error", (e) => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return ended(child, { error: e });
      log(`[host-relay] the relay (pid ${child.pid}): ${e.code || e.message}; still running`);
    });
    child.on("exit", (code, signal) => ended(child, { code, signal }));
    if (child.pid !== undefined) log(`[host-relay] relay started (pid ${child.pid}, package ${cfg.relay.package.slice(0, 19)}…, payee ${plan.payee}, V8 heap cap ${cfg.relay.heapMiB} MiB)`);
  };
  // one end per child, whichever reports it first; a stale report (an earlier child) changes nothing
  const ended = (child, how) => {
    if (child) { if (u.child !== child || child.relayEnded) return; child.relayEnded = true; }
    u.child = null; u.lastExit = { code: how.code ?? null, signal: how.signal ?? null, ...(how.error ? { error: how.error.code || how.error.message } : {}), at: Date.now() };
    if (stopping || refusal) return;
    if (Date.now() - u.startedAt > 60000) u.wait = backoffMs;       // it ran: start the backoff over
    u.restarts++; log(`[host-relay] the relay ${how.error ? `could not start (${how.error.code || how.error.message})` : `exited (${how.signal || how.code})`}; restarting in ${u.wait} ms`);
    u.timer = setTimeout(() => { u.timer = null; start(); }, u.wait); u.timer.unref?.();
    u.wait = Math.min(maxBackoffMs, u.wait * 2);
  };
  const halt = () => {
    if (u.timer) { clearTimeout(u.timer); u.timer = null; }
    if (u.child) { try { u.child.kill("SIGTERM"); } catch (e) { log(`[host-relay] SIGTERM failed (${e.code || e.message})`); } }
  };
  // one gate check at a time; its outcome is ignored once stop() has begun
  const apply = () => (applying ||= (async () => {
    await gate.check().catch(() => {});
    if (stopping) return;
    const r = gate.serviceRefusal();
    if (r && !refusal) { refusal = r; log(`[host-relay] STOPPING the relay: ${r}`); halt(); }
    else if (!r && refusal) { log(`[host-relay] admitted again: starting the relay (${refusal} cleared)`); refusal = null; }
    if (!refusal) start();
  })().finally(() => { applying = null; }));
  gate.start?.();
  await apply();
  const timer = setInterval(() => void apply(), intervalMs); timer.unref?.();
  return {
    payee: plan.payee,
    status: () => ({ platformHostPolicy: gate.status?.() ?? null, refusal, running: !!u.child, pid: u.child?.pid ?? null, restarts: u.restarts, lastExit: u.lastExit,
      restartPending: !!u.timer, heapMiB: cfg.relay.heapMiB, payee: plan.payee }),
    async stop() {
      stopping = true; clearInterval(timer); gate.stop?.();
      const child = u.child;
      if (!child) { halt(); return; }
      await new Promise((ok) => {
        if (child.relayEnded) return ok();
        child.once("exit", ok);
        child.once("error", () => { if (child.relayEnded) ok(); });
        halt();
        setTimeout(() => { if (!child.relayEnded) { try { child.kill("SIGKILL"); } catch {} } ok(); }, 5000).unref?.();
      });
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, file, ...rest] = process.argv.slice(2);
  const usage = "usage: lease-relay-host.mjs init|descriptor|advertise|check|run <host-relay.json> [--operator 0x.. --slot N --sequence N --ttl-days D]";
  if (!["init", "descriptor", "advertise", "check", "run"].includes(cmd) || !file) { console.error(usage); process.exit(2); }
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  const flag = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  try {
    if (cmd === "init") console.log(JSON.stringify(await initRelayKey(cfg)));
    else if (cmd === "descriptor") console.log(JSON.stringify(await writeRelayDescriptor(cfg, { operator: flag("--operator") })));
    else if (cmd === "advertise") console.log(JSON.stringify(await relayAdvertisement(cfg, { operator: flag("--operator"), slot: Number(flag("--slot") ?? 0),
      sequence: flag("--sequence") ?? "1", ttlSec: Number(flag("--ttl-days") ?? 30) * 86400 }), (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    else if (cmd === "check") {
      const p = planHostRelay(cfg), c = p.cfg;
      const warnings = c.platformHostPolicy !== "off" && !c.platformHostPolicyCarriers ? ["no platform host policy carrier (platformHostPolicyCarriers): the only policy mirrors are the configured HTTPS ones (production: the fleet's four), so with them down a fresh host cannot load an anchored policy and the relay will not start"] : [];
      console.log(JSON.stringify({ ok: true, payee: p.payee, bundleSha256: p.bundleSha256, heapMiB: c.relay.heapMiB, platformHostPolicy: c.platformHostPolicy,
        policyCarriers: c.platformHostPolicyCarriers ?? null, warnings, env: Object.keys(p.env) }, null, 2));
    }
    else {
      const running = await runHostRelay(cfg);
      // the supervision timers are unref'd (library use). As a service the supervisor must STAY UP while no relay runs - a
      // fresh host not yet admitted, or a sticky platform-policy refusal - or it would exit 0, systemd (Restart=on-failure)
      // would not restart a clean exit, and the admin's later authenticated admit (unban) would never start the relay. As
      // runner.mjs: until SIGTERM/SIGINT.
      const alive = setInterval(() => {}, 1 << 30);
      for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { clearInterval(alive); running.stop().then(() => process.exit(0)); });
    }
  } catch (e) { console.error(e.message); process.exit(1); }
}
