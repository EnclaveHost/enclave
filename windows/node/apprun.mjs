// windows/node/apprun.mjs -- one tenant app, running on this Windows box under wasmtime.
//
// The platform's own manager (wasm/wasm_manager.py) does this on Linux with a patched wasmtime,
// cgroups and per-tenant firewalling. This is the small Windows equivalent: fetch the artifact by
// CID and VERIFY it against that CID, run it as `wasmtime serve` on a loopback port, watch it,
// keep its last log lines, and restart it with backoff.
//
// WHERE AN APP RUNS. There are two paths on this box, and only the first one is sold:
//
//  1. INSIDE THE ENCLAVE (class EnclaveApp below, windows/enclave-rt, windows/enclave-engine/
//     ee-app.cpp). An app built for the enclave:app world is compiled to Pulley bytecode and
//     interpreted inside VTL1 by a no_std wasmtime linked into the enclave image. Its code, its
//     memory and its model calls never leave the enclave. This is what a lease gets.
//  2. IN VTL0 under stock `wasmtime serve` (class App below). wasmtime cannot run in VTL1 - no
//     JIT, no mmap, no Rust std - so this path is the ordinary Windows session, where the owner
//     of the PC can read the app's memory. It is kept for the box owner's own bring-up on the
//     loopback surface (host.mjs runUnleased) and is NEVER given to a tenant's lease: selling it
//     would be selling app hosting the enclave does not cover.
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { encodeRequest, decodeResponse } from "./appframe.mjs";
const execFileAsync = promisify(execFile);

const LOG_LINES = 400;
const START_TIMEOUT_MS = 120_000;      // a first cold start compiles the component
const PROBE_MS = 2_000;

/**
 * The launch line: the platform's own (wasm/wasm_manager.py serve template) minus the flags a
 * STOCK wasmtime rejects, which it rejects hard, before it even reads the module. Measured on this
 * box against wasmtime 49.0.0 for Windows: `-S egress=`, `-S loopback-allow=`, `-S vault=` and
 * `-W set-epochs=` are unknown options and abort the launch; everything below parses and works.
 *
 * What their absence costs, stated because it bounds what this node may honestly host:
 *  - no `-S loopback-allow`: there is no cross-app loopback wall, so this box runs only apps
 *    belonging to ONE owner (chain.mjs claimPolicy) and caps how many at once.
 *  - no `-S egress`: an app's outbound traffic leaves from this machine's own address, never a
 *    deployment's dedicated IPv6.
 *  - no ggml/sd/nvenc wasi-nn backends in a stock build: an LLM or diffusion app cannot run here.
 *    (ONNX does work, through the inbox onnxruntime.dll, but a GPU target silently lands on the
 *    CPU without the platform's strict-GPU patch, so this node does not offer it.)
 */
export function serveArgs({ wasmPath, port, memBytes, dataDir, env = {}, allowHttp = true, p3 = true }) {
  const a = ["serve", "-Scli"];
  if (allowHttp) a.push("-Shttp");                                   // wasi:http, in and out
  if (p3) a.push("-Sp3", "-W", "component-model-async");             // a p3 component needs it; a p2 one ignores it
  a.push("-O", "pooling-allocator=n");
  if (dataDir) a.push("--dir", `${dataDir}::/data`);
  for (const [k, v] of Object.entries(env)) a.push("--env", `${k}=${v}`);
  if (memBytes) a.push("-W", `max-memory-size=${memBytes}`);
  a.push("--addr", `127.0.0.1:${port}`, wasmPath);
  return a;
}

export class App {
  constructor({ id, wasmtime, wasmPath, port, memMb = 512, env = {}, allowHttp = false, dir, log = () => {} }) {
    Object.assign(this, { id, wasmtime, wasmPath, port, memMb, env, allowHttp, dir, log });
    this.proc = null; this.lines = []; this.state = "stopped"; this.startedAt = 0; this.restarts = 0;
    this.lastError = ""; this.exitCode = null; this.backoffMs = 1000;
  }
  push(s) {
    for (const line of String(s).split(/\r?\n/)) if (line) this.lines.push(`${new Date().toISOString()} ${line}`);
    while (this.lines.length > LOG_LINES) this.lines.shift();
  }
  logs(n = 100) { return this.lines.slice(-n); }
  status() {
    return { id: this.id, state: this.state, port: this.port, pid: this.proc?.pid || null, startedAt: this.startedAt || null,
             restarts: this.restarts, exitCode: this.exitCode, error: this.lastError || null, memMb: this.memMb,
             artifact: path.basename(this.wasmPath) };
  }
  async start() {
    if (this.proc) return;
    if (!fs.existsSync(this.wasmPath)) throw new Error(`artifact missing: ${this.wasmPath}`);
    this.state = "starting"; this.exitCode = null; this.lastError = "";
    const dataDir = path.join(this.dir, "appdata", this.id.replace(/[^a-z0-9-]/gi, "_"));
    fs.mkdirSync(dataDir, { recursive: true });
    const args = serveArgs({ wasmPath: this.wasmPath, port: this.port, memBytes: this.memMb * 1024 * 1024,
                             dataDir, env: this.env, allowHttp: this.allowHttp });
    this.push(`[node] ${this.wasmtime} ${args.join(" ")}`);
    // The guest's environment is the --env list above and nothing else: there is no inherit-env
    // here, so the app cannot read this machine's variables.
    const proc = spawn(this.wasmtime, args, { cwd: this.dir, windowsHide: true,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP } });
    this.proc = proc;
    proc.stdout.on("data", (d) => this.push(d));
    proc.stderr.on("data", (d) => this.push(d));
    proc.on("exit", (code, sig) => {
      this.exitCode = code ?? -1; this.proc = null;
      const was = this.state; this.state = "exited";
      this.push(`[node] wasmtime exited (${code ?? sig})`);
      if (was !== "stopping") this.scheduleRestart();
    });
    proc.on("error", (e) => { this.lastError = e.message; this.push(`[node] spawn failed: ${e.message}`); });
    const ok = await this.waitReady(START_TIMEOUT_MS);
    if (!ok) { this.lastError = "the app did not answer on its port"; this.state = "failed"; this.push("[node] " + this.lastError); throw new Error(this.lastError); }
    this.state = "running"; this.startedAt = Date.now(); this.backoffMs = 1000;
    this.log(`app ${this.id.slice(0, 10)} running on 127.0.0.1:${this.port}`);
  }
  scheduleRestart() {
    if (this._timer) return;
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    this.restarts++;
    this.push(`[node] restarting in ${Math.round(wait / 1000)}s (restart ${this.restarts})`);
    this._timer = setTimeout(() => { this._timer = null; this.start().catch((e) => this.push(`[node] restart failed: ${e.message}`)); }, wait);
  }
  async stop() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (!this.proc) { this.state = "stopped"; return; }
    this.state = "stopping";
    const p = this.proc;
    try { p.kill(); } catch {}
    await new Promise((r) => { const t = setTimeout(r, 4000); p.once("exit", () => { clearTimeout(t); r(); }); });
    this.proc = null; this.state = "stopped";
  }
  /** Is something listening yet? A component compiles on first launch, which can take a while. */
  waitReady(ms) {
    const t0 = Date.now();
    const once = () => new Promise((res) => {
      const s = net.connect(this.port, "127.0.0.1");
      const done = (v) => { try { s.destroy(); } catch {} res(v); };
      s.once("connect", () => done(true)); s.once("error", () => done(false));
      setTimeout(() => done(false), PROBE_MS);
    });
    return (async () => {
      for (;;) {
        if (!this.proc) return false;
        if (await once()) return true;
        if (Date.now() - t0 > ms) return false;
        await new Promise((r) => setTimeout(r, 500));
      }
    })();
  }
  /** The liveness a proof-of-time checkpoint means: it answered, just now. */
  async alive() { return this.state === "running" && !!this.proc && await this.waitReady(PROBE_MS); }
}

/**
 * The env an app sees. There is no inherit-env anywhere: a component gets exactly this list, the
 * same names the platform's manager passes (wasm/wasm_manager.py), plus one of ours.
 * ENCLAVE_INFERENCE_URL is this node's own loopback endpoint into the VBS enclave, which is the
 * only outbound address an app here has any reason to reach: the model stays in VTL1 and the
 * untrusted card still only ever sees masked activations.
 */
export function appEnv({ config = "", memMb = 512, inferenceUrl = "" } = {}) {
  const env = { ENCLAVE_MEM_MB: String(memMb) };
  if (config) env.ENCLAVE_CONFIG = config;
  if (inferenceUrl) env.ENCLAVE_INFERENCE_URL = inferenceUrl;
  return env;
}

/** Fetch an artifact by CID and verify it against that CID (the platform's own verifier). */
export async function fetchArtifact({ cid, dir, python = "python", gateway = "https://ipfs.enclave.host", maxBytes = 128 * 1024 * 1024, log = () => {} }) {
  if (!/^[A-Za-z0-9]{10,100}$/.test(String(cid || ""))) throw new Error(`not a CID: ${cid}`);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `ipfs-${cid}.wasm`);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return { path: out, cached: true };
  const script = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "fetch-cid.py");
  log(`fetching ${cid} from ${gateway} (CID-verified)`);
  const { stdout } = await execFileAsync(python, [script, cid, out, String(maxBytes), gateway], { maxBuffer: 4 << 20 });
  log(`artifact ${cid}: ${stdout.trim()}`);
  return { path: out, cached: false, note: stdout.trim() };
}

/** Layer 0 = a core module, 1 = a component. `wasmtime serve` needs a component. */
export function wasmLayer(file) {
  const fd = fs.openSync(file, "r"); const b = Buffer.alloc(8);
  fs.readSync(fd, b, 0, 8, 0); fs.closeSync(fd);
  if (b.subarray(0, 4).toString("binary") !== "\0asm") throw new Error("not a wasm file");
  return b.readUInt16LE(6);
}

/**
 * The host interfaces an artifact needs that this box cannot provide, found BEFORE it is launched.
 *
 * Import names live in a component as plain strings, so a scan for them is exact enough for the
 * one question being asked: does this artifact want something only the platform's own patched
 * runtime has. It exists because the alternative is what actually happened - the box claimed a
 * lease on the platform's wasi-nn inference app, stock wasmtime refused the import, and the lease
 * sat there restarting every 60 seconds while the tenant's row read "running on nucbox-k11".
 *
 * wasi:nn is the platform's in-enclave inference interface, served by a PATCHED wasmtime against
 * an attested model volume (memory: enclave-ggml-backend, nan-model-volumes). This box has
 * neither: stock wasmtime 49, and the one model here is the enclave's own, reachable over
 * loopback at ENCLAVE_INFERENCE_URL. An app built for wasi-nn cannot use that instead - it is a
 * different contract - so the honest answer is to refuse the work and let the lease go.
 */
export function missingHostInterfaces(file) {
  const bytes = fs.readFileSync(file);
  const needs = [];
  if (bytes.includes("wasi:nn/")) needs.push("wasi-nn (the platform's in-enclave inference interface, which needs a patched wasmtime and an attested model volume)");
  if (bytes.includes("enclave:set/") || bytes.includes("wasi:threads/")) needs.push("guest threads (SET spawn, which needs the platform's patched wasmtime)");
  return needs;
}

/**
 * An app running INSIDE the enclave.
 *
 * Same surface as `App` above (start/stop/alive/logs/state) so host.mjs treats the two the same,
 * but there is no process, no port and no restart loop: the app is bytecode loaded into VTL1 and a
 * request is a call through the enclave gate. If the enclave goes, every app in it goes with it,
 * which is the honest failure mode - they live in its memory.
 *
 * `hostCmd` is the agent's line protocol to the enclave host (ee-host.c on loopback). Everything
 * this class does is four commands: appabi, appopen, apphandle, appclose.
 */
export class EnclaveApp {
  constructor({ id, cwasmPath, hostCmd, log = () => {}, memMb = 0 }) {
    this.id = id; this.cwasmPath = cwasmPath; this.hostCmd = hostCmd; this.log = log;
    this.memMb = memMb;
    this.slot = 0; this.state = "stopped"; this.lines = []; this.loadUs = 0;
    this.inTee = true;                       // what host.mjs records and /availability publishes
  }
  #say(m) {
    this.lines.push(`${new Date().toISOString()} ${m}`);
    if (this.lines.length > LOG_LINES) this.lines.splice(0, this.lines.length - LOG_LINES);
    this.log(m);
  }
  logs(n = 200) { return this.lines.slice(-n); }
  /** Load the bytecode into the enclave. The enclave copies it in and answers with a slot. */
  async start() {
    this.state = "starting";
    const r = await this.hostCmd(`appopen ${this.cwasmPath}`);
    const [slot, us] = String(r).trim().split(/\s+/);
    this.slot = Number(slot) || 0;
    this.loadUs = Number(us) || 0;
    if (!this.slot) { this.state = "failed"; throw new Error("the enclave did not return an app slot"); }
    this.state = "running";
    this.#say(`loaded into the enclave as slot ${this.slot} in ${(this.loadUs / 1000).toFixed(1)} ms`);
    return this;
  }
  async stop() {
    if (this.slot) { try { await this.hostCmd(`appclose ${this.slot}`); } catch (e) { this.#say(`appclose: ${e.message}`); } }
    this.slot = 0; this.state = "stopped";
  }
  /** Is the enclave still carrying this app? The gate answering at all is the liveness signal. */
  async alive() {
    if (!this.slot) return false;
    try { return Number(await this.hostCmd("appabi")) >= 1; } catch { return false; }
  }
  /**
   * One request, in and out through the gate. Returns the same shape the VTL0 proxy path returns,
   * so /x/<id> does not care which kind of app answered.
   */
  async handle({ method = "GET", pathRest = "/", headers = {}, body = Buffer.alloc(0) } = {}) {
    if (!this.slot) return { status: 503, headers: { "content-type": "application/json" },
                             body: Buffer.from(JSON.stringify({ error: "not_loaded", id: this.id })) };
    const frame = encodeRequest({ method, path: pathRest, headers, body });
    const r = await this.hostCmd(`apphandle ${this.slot} ${frame.toString("hex")}`);
    const [hex, us] = String(r).trim().split(/\s+/);
    const resp = decodeResponse(Buffer.from(hex, "hex"));
    this.lastUs = Number(us) || 0;
    return { status: resp.status, headers: resp.headers, body: resp.body, inTee: true, enclaveUs: this.lastUs };
  }
}

/**
 * Compile a component to the bytecode the enclave interprets (windows/enclave-rt/precompile).
 * Cranelift runs HERE, in VTL0, and never inside the enclave: what crosses the gate is data for a
 * target that has no machine code at all, which is what makes an enclave able to run it.
 */
export async function precompile({ wasmPath, outPath, exe, log = () => {} }) {
  if (!fs.existsSync(exe)) throw new Error(`no bytecode compiler at ${exe} (windows/enclave-rt/build-win.cmd)`);
  const t0 = Date.now();
  const { stdout } = await execFileAsync(exe, [wasmPath, outPath], { maxBuffer: 4 << 20 });
  log(`bytecode: ${String(stdout).trim()} in ${Date.now() - t0} ms`);
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 64) throw new Error("the compiler produced no bytecode");
  return outPath;
}
