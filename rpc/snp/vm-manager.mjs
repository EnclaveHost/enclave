// vm-manager.mjs - the host's manager for whole-VM SEV-SNP apps (catalog runtime "sev-snp-vm"), so a fleet host's
// supervisor can claim and run one like any other app: node rpc/snp/vm-manager.mjs CONFIG.json
//
// metal0's per-app manager (guestd) runs catalog wasm components inside a pinned guest image. An app such as Enclave
// RPC is instead its own measured VM: its own kernel, initrd and dm-verity root (rpc/snp/build_image.py), terabyte
// chain disks that must persist across leases, and a user-mode NIC for its peer-to-peer clients. This manager speaks
// the SAME /vms contract the supervisor already uses for guestd, over the same authenticated channel
// (guestd-control/1, windows/vbslike/manager/control.mjs, keyed by guestd's own pairing key), and launches through
// the existing rpc/snp/launch.py, so the QEMU command line, and therefore the launch measurement, is unchanged.
//
// What the host operator decides, in CONFIG.bindings[<deployment id>]: which image directory, run directory, chain
// disks and host port forward that deployment gets. A deployment with no binding is refused; a binding is exclusive
// (its disks belong to that deployment alone). What the chain decides, and the request carries from the catalog
// version: the measurement allowlist, the image's root hash, OVMF and cmdline hashes, vCPUs and memory. The image on
// disk must match all of them before anything starts.
//
// An instance is "running" only once its front proves, through rpc/snp/attested-fetch.mjs (the gateway's own check),
// a launch measurement from the version's allowlist and HOST_DATA equal to the deployment id. Until then it is
// "starting"; a unit that ended is "failed". Nothing here reaps on silence: an RPC with terabytes of state is stopped
// only by an explicit DELETE.
//
// The app's address. With CONFIG.certs set, an attested guest also gets the certificate for its name in the app zone
// (<first 8 hex of the deployment id>.app.enclave.host), so a browser reaches it like any other app. The guest made the
// key and the request; this manager reads the request over the attested, pinned connection, checks it is for that very
// key and name, has the platform's certificate service issue for it (the host operator signs the ask, exactly as the
// supervisor does for guestd's apps: the relay checks the signature, the live lease and the host), and hands the chain
// back to the guest, which serves it only if it verifies there. No key is here at any point. What it then writes to
// <stateDir>/<deployment id>.route.json is the host network agent's cue to admit and route the app.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash, X509Certificate } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ControlServer, parseKey } from "../../windows/vbslike/manager/control.mjs";
import { createAttestedFetch } from "./attested-fetch.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ID32 = /^0x[0-9a-f]{64}$/, HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`);
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
export const OVMF_DEFAULT = "/home/steven/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd";   // launch.py's OVMF
export const ATTEST_EVERY_MS = 5 * 60_000;
export const APP_ZONE = "app.enclave.host";
const CERT_RETRY_MIN_MS = 60_000, CERT_RETRY_MAX_MS = 60 * 60_000;

export const idFor = (name) => "sv" + sha256(String(name).toLowerCase()).slice(0, 16);
const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

/** The request's snpVm plan, as the supervisor derives it from the catalog version. Strict: unknown fields refuse. */
export function parsePlan(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) throw fail(400, "snpVm plan must be an object");
  const allowed = ["appRef", "vcpus", "memMiB", "measurements", "vcpuType", "image"];
  const extra = Object.keys(p).filter((k) => !allowed.includes(k));
  if (extra.length) throw fail(400, `unknown snpVm plan field ${extra[0]}`);
  if (!/^catalog:\/\/0x[0-9a-f]{64}\/\d+$/.test(String(p.appRef))) throw fail(400, "snpVm.appRef must be catalog://<appId>/<index>");
  if (!Number.isInteger(p.vcpus) || p.vcpus < 1 || p.vcpus > 64) throw fail(400, "snpVm.vcpus must be 1..64");
  if (!Number.isInteger(p.memMiB) || p.memMiB < 1024 || p.memMiB > 1 << 20) throw fail(400, "snpVm.memMiB must be 1024..1048576");
  if (!Array.isArray(p.measurements) || !p.measurements.length || p.measurements.some((m) => !HEX(96).test(m)))
    throw fail(400, "snpVm.measurements must be 48-byte hex launch measurements");
  if (p.vcpuType !== "EPYC-v4") throw fail(400, "snpVm.vcpuType must be EPYC-v4 (the type launch.py boots)");
  const im = p.image || {};
  for (const k of ["rootHash", "ovmfSha256", "cmdlineSha256"]) if (!HEX(64).test(String(im[k]))) throw fail(400, `snpVm.image.${k} must be 32-byte hex`);
  return { appRef: p.appRef, vcpus: p.vcpus, memMiB: p.memMiB, measurements: [...p.measurements], vcpuType: p.vcpuType,
           image: { rootHash: im.rootHash, ovmfSha256: im.ovmfSha256, cmdlineSha256: im.cmdlineSha256 } };
}

/** Does the bound image on disk match what the catalog version pins? Returns the launch config launch.py takes. */
export function launchConfigFor(name, binding, plan, { readFile = fs.readFileSync, ovmf = OVMF_DEFAULT } = {}) {
  const meta = JSON.parse(readFile(path.join(binding.image, "IMAGE.json"), "utf8"));
  if (meta.rootHash !== plan.image.rootHash) throw fail(409, `the bound image's root hash ${String(meta.rootHash).slice(0, 12)}… is not the version's`);
  if (sha256(Buffer.from(meta.cmdline)) !== plan.image.cmdlineSha256) throw fail(409, "the bound image's cmdline is not the version's");
  if (sha256(readFile(binding.ovmf || ovmf)) !== plan.image.ovmfSha256) throw fail(409, "this host's OVMF is not the version's");
  if (binding.cpus !== plan.vcpus) throw fail(409, `the binding boots ${binding.cpus} vCPUs, the version's measurement is for ${plan.vcpus}`);
  return { image: binding.image, run: binding.run, memoryMiB: plan.memMiB, cpus: plan.vcpus, disks: binding.disks,
           hostfwd: binding.hostfwd, hostData: name.slice(2) };
}

export function validateConfig(c) {
  if (!c || typeof c !== "object") throw new Error("config must be an object");
  if (!/^127\.0\.0\.1:\d+$/.test(String(c.listen))) throw new Error("listen must be 127.0.0.1:<port>");
  for (const [name, b] of Object.entries(c.bindings || {})) {
    if (!ID32.test(name)) throw new Error(`binding ${name} is not a lowercase deployment id`);
    for (const k of ["image", "run", "unit", "attestOrigin"]) if (typeof b[k] !== "string" || !b[k]) throw new Error(`binding ${name}: ${k} is required`);
    if (!/^[A-Za-z0-9@._-]+$/.test(b.unit)) throw new Error(`binding ${name}: unit name is not safe`);
    if (!Number.isInteger(b.cpus) || b.cpus < 1) throw new Error(`binding ${name}: cpus is required`);
    if (!Array.isArray(b.disks) || !Array.isArray(b.hostfwd)) throw new Error(`binding ${name}: disks and hostfwd must be lists`);
  }
  const disks = Object.values(c.bindings || {}).flatMap((b) => b.disks.map((d) => path.resolve(d.path)));
  if (new Set(disks).size !== disks.length) throw new Error("a disk is bound to more than one deployment");
  if (c.certs !== undefined) {
    const k = c.certs;
    if (!k || typeof k !== "object") throw new Error("certs must be an object");
    for (const f of ["relay", "endpoint"]) if (!/^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(String(k[f])) || String(k[f]).endsWith("/")) throw new Error(`certs.${f} must be an https URL without a trailing slash`);
    if (!!k.operatorKeyFile === !!k.operatorConfigFile) throw new Error("certs needs exactly one of operatorKeyFile and operatorConfigFile");
  }
  return c;
}

/** The app-zone name a deployment is reached at. */
export const appNameFor = (name, zone = APP_ZONE) => `${String(name).toLowerCase().slice(2, 10)}.${zone}`;

/** Signs as the host operator, with the key the host's supervisor and network agent already use. The key is read on
 *  first use, kept inside the signer, and never logged or returned. */
export function operatorSigner(certs, { readFile = fs.readFileSync } = {}) {
  let account = null;
  return async (message) => {
    if (!account) {
      const key = certs.operatorKeyFile ? String(readFile(certs.operatorKeyFile, "utf8")).trim()
        : JSON.parse(readFile(certs.operatorConfigFile, "utf8")).registryKey;
      const { privateKeyToAccount } = await import("viem/accounts");
      account = privateKeyToAccount(/^0x/.test(key) ? key : "0x" + key);
    }
    return account.signMessage({ message });
  };
}

const execP = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 600_000 },
  (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) })));

/** The manager's state and routes, with the host effects injected so tests can drive it. */
export class SnpVmManager {
  constructor(cfg, { exec = execP, attest = null, now = () => Date.now(), readFile = fs.readFileSync, writeFile = fs.writeFileSync,
                     launcher = path.join(HERE, "launch.py"), ovmf = OVMF_DEFAULT, diskUsers = processesWithArgs,
                     fetch = globalThis.fetch, sign = null, csr = null } = {}) {
    this.cfg = validateConfig(cfg); this.exec = exec; this.now = now; this.readFile = readFile; this.writeFile = writeFile;
    this.diskUsers = diskUsers;
    this.launcher = launcher; this.ovmf = ovmf;
    this.attest = attest || ((name, b, plan) => defaultAttest(b.attestOrigin, plan.measurements, name.slice(2)));
    this.instances = new Map();   // id -> { id, name, unit, plan, status, startedAt, attestedAt, error, channel, cert }
    this.fetch = fetch; this.sign = sign || (cfg.certs ? operatorSigner(cfg.certs, { readFile }) : null);
    // the certificate service's own request parser and signed text (relay/certs.js), so this cannot drift from what it accepts
    this.csr = csr || (() => import("../../relay/certs.js").then((m) => ({ parse: m.parseCsr, message: m.issueMessage })));
    this.stateDir = cfg.stateDir || path.join(HERE, "state");
  }

  binding(name) { return this.cfg.bindings?.[String(name).toLowerCase()] || null; }
  async unitActive(unit) { return (await this.exec("systemctl", ["--user", "is-active", "--quiet", unit + ".service"])).code === 0; }

  /** After a restart of this manager: a bound unit that is running is that deployment's instance (plan from disk). */
  async recover() {
    for (const [name, b] of Object.entries(this.cfg.bindings || {})) {
      if (!(await this.unitActive(b.unit))) continue;
      let plan = null; try { plan = JSON.parse(this.readFile(path.join(this.stateDir, name + ".plan.json"), "utf8")); } catch {}
      this.instances.set(idFor(name), { id: idFor(name), name, unit: b.unit, plan, status: "starting", startedAt: this.now(), recovered: true });
    }
  }

  health() {
    return { backend: "snp-vm", proto: "guestd-control/1", bindings: Object.keys(this.cfg.bindings || {}),
             supports: { snpVm: true, ports: false, secrets: false }, instances: this.instances.size };
  }

  async refresh(inst) {
    const b = this.binding(inst.name);
    if (!(await this.unitActive(inst.unit))) {
      if (inst.status !== "failed") { inst.status = "failed"; inst.error = inst.error || "the VM's unit is not running"; }
      return inst;
    }
    if (!inst.plan) { inst.status = "starting"; inst.error = "plan unknown since this manager restarted; waiting for the supervisor to re-launch"; return inst; }
    if (inst.status === "running" && this.now() - (inst.attestedAt || 0) < ATTEST_EVERY_MS) { this.certifySoon(inst, b); return inst; }
    try {
      const channel = await this.attest(inst.name, b, inst.plan);
      inst.status = "running"; inst.attestedAt = this.now(); inst.error = null;
      inst.channel = channel && typeof channel.fetch === "function" ? channel : null;
      this.certifySoon(inst, b);
    } catch (e) {
      inst.status = inst.status === "running" ? "starting" : inst.status;   // a lost attestation demotes; it never fails a live VM
      inst.error = `not attested yet: ${e.message}`;
    }
    return inst;
  }

  /** The certificate pass never holds up a status answer; it paces itself (inst.cert.nextAt) and reports into inst.cert. */
  certifySoon(inst, b) {
    if (!this.cfg.certs || !inst.channel) return null;
    const c = inst.cert ||= { name: appNameFor(inst.name, this.cfg.certs.zone), failures: 0 };
    if (c.busy || this.now() < (c.nextAt || 0)) return null;
    c.busy = true;
    return (c.pass = this.certify(inst, b, c).then(() => { c.failures = 0; c.error = null; }, (e) => {
      c.failures += 1; c.error = e.message;
      c.nextAt = this.now() + (e.retryMs || Math.min(CERT_RETRY_MAX_MS, CERT_RETRY_MIN_MS * 2 ** (c.failures - 1)));
    }).finally(() => { c.busy = false; }));
  }

  /** One pass: nothing to do while the guest's key has a certificate short of 2/3 of its life; otherwise ask and deliver. */
  async certify(inst, b, c) {
    const { relay, endpoint } = this.cfg.certs, ch = inst.channel, origin = b.attestOrigin;
    const got = await ch.fetch(origin + "/.well-known/enclave-csr", { signal: AbortSignal.timeout(20_000) });
    if (got.status === 404) throw Object.assign(new Error("this guest image asks for no certificate"), { retryMs: CERT_RETRY_MAX_MS });
    if (!got.ok) throw new Error(`the guest's certificate request answered ${got.status}`);
    const pem = await got.text(), spki = ch.spki();   // the key the attested report names, pinned on this very connection
    if (c.spki === spki && this.now() < c.renewAt) return;
    const { parse, message } = await this.csr();
    const req = parse(pem, c.name);   // exactly CN == SAN == the app name, or it throws
    if (!spki || req.spkiHash !== spki) throw new Error("the guest's certificate request is not for its attested key");
    const ts = Math.floor(this.now() / 1000);
    const opSig = await this.sign(message(c.name, endpoint, req.spkiHash, ts));
    const r = await this.fetch(relay + "/v1/certs/issue", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: c.name, csr: pem, endpoint, ts, opSig }), signal: AbortSignal.timeout(120_000) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 202) { c.state = "ordered"; c.nextAt = this.now() + Math.max(5, Number(j.retryAfterSec) || 60) * 1000; return; }
    if (r.status !== 200 || typeof j.certPem !== "string") throw new Error(`the certificate service answered ${r.status}${j.code ? ` (${j.code})` : ""}`);
    const leaf = new X509Certificate(j.certPem);
    if (sha256(leaf.publicKey.export({ type: "spki", format: "der" })) !== spki) throw new Error("the issued certificate is not for the guest's key");
    // The guest checks the chain itself (its key, its name, a root its image trusts, in date) before it serves it.
    const put = await ch.fetch(origin + "/.well-known/enclave-cert", { method: "POST", headers: { "content-type": "application/x-pem-file", "content-length": String(Buffer.byteLength(j.certPem)) },
      body: j.certPem, signal: AbortSignal.timeout(30_000) });
    const ans = await put.json().catch(() => ({}));
    if (put.status !== 200 || ans.installed !== true) throw new Error(`the guest refused the chain: ${ans.error || put.status}`);
    const from = Date.parse(leaf.validFrom), to = Date.parse(leaf.validTo);
    Object.assign(c, { spki, state: "installed", notAfter: to, renewAt: from + (to - from) * 2 / 3, nextAt: this.now() + CERT_RETRY_MIN_MS });
    this.persistRoute(inst, b, c);
  }

  /** What the host's network agent needs to admit and route this app: written only once the guest serves its certificate. */
  persistRoute(inst, b, c) {
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    this.writeFile(path.join(this.stateDir, inst.name + ".route.json"), JSON.stringify({
      deploymentId: inst.name, name: c.name, port: Number(new URL(b.attestOrigin).port), appRef: inst.plan.appRef,
      measurements: inst.plan.measurements, rootHash: inst.plan.image.rootHash, certNotAfter: c.notAfter }) + "\n", { mode: 0o600 });
  }

  dropRoute(name) { fs.rmSync(path.join(this.stateDir, name + ".route.json"), { force: true }); }

  view(i) {
    return { id: i.id, name: i.name, status: i.status, kind: "snp-vm", unit: i.unit, appRef: i.plan?.appRef ?? null,
             measurements: i.plan?.measurements ?? null, startedAt: i.startedAt ?? null, attestedAt: i.attestedAt ?? null,
             ...(i.error ? { error: i.error } : {}), ...(i.recovered ? { recovered: true } : {}),
             ...(i.cert ? { certificate: { name: i.cert.name, state: i.cert.state ?? "pending", notAfter: i.cert.notAfter ?? null,
                                           ...(i.cert.error ? { error: i.cert.error } : {}) } } : {}) };
  }

  async spawn(body) {
    const name = String(body?.name || "").toLowerCase();
    if (!ID32.test(name)) throw fail(400, "name must be the deployment id");
    const b = this.binding(name);
    if (!b) throw fail(403, `no snp-vm binding for ${name} on this host`);
    const plan = parsePlan(body.snpVm);
    const id = idFor(name);
    if (await this.unitActive(b.unit)) {
      const cur = this.instances.get(id);
      if (cur && !cur.plan) { cur.plan = plan; this.persistPlan(name, plan); }   // a recovered VM, re-launched from the same record
      // adoptable only as the version it was launched as: a record for another version must stop this VM first
      if (cur?.plan && sha256(JSON.stringify(cur.plan)) !== sha256(JSON.stringify(plan))) throw fail(409, `${name} runs here as ${cur.plan.appRef}; stop it before launching another version`);
      throw fail(409, `${name} already runs here`, { id });
    }
    const launch = launchConfigFor(name, b, plan, { readFile: this.readFile, ovmf: this.ovmf });
    const busy = this.diskUsers(b.disks.map((d) => path.resolve(d.path)));
    if (busy.length) throw fail(409, `the bound disks are open in another process (${busy.join(", ")}); nothing was started`);
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const cfgPath = path.join(this.stateDir, name + ".launch.json");
    this.writeFile(cfgPath, JSON.stringify(launch, null, 2) + "\n", { mode: 0o600 });
    this.persistPlan(name, plan);
    this.dropRoute(name);   // a new VM has a new key: no route until it serves its own certificate
    await this.exec("systemctl", ["--user", "reset-failed", b.unit + ".service"]);
    const r = await this.exec("systemd-run", ["--user", "--unit=" + b.unit, "--collect", "-p", "KillMode=mixed", "-p", "TimeoutStopSec=7min",
      "-p", "Description=Enclave SNP VM app " + name.slice(0, 10), "/usr/bin/python3", "-I", this.launcher, cfgPath]);
    if (r.code !== 0) throw fail(500, `systemd-run failed: ${r.stderr.trim().slice(0, 300)}`);
    const inst = { id, name, unit: b.unit, plan, status: "starting", startedAt: this.now() };
    this.instances.set(id, inst);
    return { ...this.view(inst), recordSha256: sha256(JSON.stringify(plan)) };
  }

  persistPlan(name, plan) {
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    this.writeFile(path.join(this.stateDir, name + ".plan.json"), JSON.stringify(plan) + "\n", { mode: 0o600 });
  }

  async get(id) { const i = this.instances.get(id); return i ? this.view(await this.refresh(i)) : null; }
  async list() { const out = []; for (const i of this.instances.values()) out.push(this.view(await this.refresh(i))); return out; }

  async remove(id) {
    const i = this.instances.get(id);
    if (!i) return { absent: true };
    const r = await this.exec("systemctl", ["--user", "stop", i.unit + ".service"]);
    if (r.code !== 0 && (await this.unitActive(i.unit))) throw fail(500, `stopping ${i.unit} failed: ${r.stderr.trim().slice(0, 200)}`, { id });
    this.instances.delete(id);
    this.dropRoute(i.name);
    return { absent: false };
  }

  /** The /vms contract, as guestd answers it (status codes the supervisor already reads). */
  async handle({ method, path: p, body }) {
    const u = new URL(p, "http://x"), route = u.pathname.replace(/\/+$/, "") || "/";
    const json = () => { try { return JSON.parse(body || "{}"); } catch { throw fail(400, "body is not JSON"); } };
    try {
      if (method === "GET" && route === "/health") return { status: 200, body: this.health() };
      if (method === "GET" && route === "/vms") return { status: 200, body: { vms: await this.list() } };
      if (method === "POST" && route === "/vms/lease") return { status: 200, body: { unvouched: [] } };
      if (method === "POST" && route === "/vms") return { status: 201, body: await this.spawn(json()) };
      const m = route.match(/^\/vms\/(sv[0-9a-f]{16})$/);
      if (m && method === "GET") { const v = await this.get(m[1]); return v ? { status: 200, body: v } : { status: 404, body: { error: "not_found" } }; }
      if (m && method === "DELETE") { const r = await this.remove(m[1]); return r.absent ? { status: 404, body: { error: "not_found" } } : { status: 200, body: { ok: true } }; }
      return { status: 404, body: { error: "not_found" } };
    } catch (e) { return { status: e.status || 500, body: { error: e.message, ...(e.id ? { id: e.id } : {}) } }; }
  }
}

/** PIDs of QEMU processes whose command line names any of these paths (a VM still holding a bound disk). */
export function processesWithArgs(paths) {
  const out = [];
  for (const pid of fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    let argv; try { argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"); } catch { continue; }
    if (!/qemu-system-x86_64$/.test(argv[0] || "")) continue;
    if (paths.some((p) => argv.some((a) => a.includes(p)))) out.push(pid);
  }
  return out;
}

/** The gateway's own attestation check against this host's forward of the guest's front. Returns the attested channel:
 *  a fetch pinned to the key the report names, and that key's SPKI SHA-256. */
export async function defaultAttest(origin, measurements, hostData) {
  const f = createAttestedFetch({ attested: { [origin]: { allowedMeasurements: measurements, hostData } } });
  const r = await f(origin + "/health", { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`front /health answered ${r.status}`);
  return { fetch: f, spki: () => f.pins.get(origin)?.spki ?? null };
}

export function serve(manager, key) {
  const ctl = new ControlServer({ key, handle: (req) => manager.handle(req) });
  return http.createServer(async (req, res) => {
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > 1 << 20) { res.writeHead(413).end(); return; } chunks.push(c); }
    const body = Buffer.concat(chunks).toString("utf8");
    const u = new URL(req.url, "http://127.0.0.1");
    let out;
    if (req.method === "GET" && u.pathname === "/control/hello") out = ctl.hello();
    else if (req.method === "POST" && u.pathname === "/control/session") { let j = {}; try { j = JSON.parse(body || "{}"); } catch {} out = ctl.session(j); }
    else out = await ctl.call({ method: req.method, path: req.url, headers: req.headers, body });
    const raw = Buffer.from(JSON.stringify(out.body ?? {}));
    res.writeHead(out.status, { "content-type": "application/json", "content-length": raw.length, ...(out.headers || {}) });
    res.end(raw);
  });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const st = fs.statSync(cfg.keyFile);
  if (st.mode & 0o077) throw new Error(`${cfg.keyFile} must be 0600`);
  const key = parseKey(fs.readFileSync(cfg.keyFile, "utf8"));
  const m = new SnpVmManager(cfg, { launcher: cfg.launcher || path.join(HERE, "launch.py") });
  await m.recover();
  const [host, port] = cfg.listen.split(":");
  serve(m, key).listen(Number(port), host, () => console.log(JSON.stringify({ event: "listening", listen: cfg.listen,
    bindings: Object.keys(cfg.bindings || {}), recovered: [...m.instances.values()].map((i) => i.name) })));
}
