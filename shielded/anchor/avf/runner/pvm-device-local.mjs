// pvm-device-local.mjs -- pvm-device.mjs's handle on the phone, for a host agent that runs ON the phone (STANDALONE.md): the
// Enclave app's AgentService runs this agent under the app's own uid, so the app's private files are this process's files,
// and the app's own processes (the host VM's, each slot's) are this process's to see and to signal. Only a launch needs
// Android: a foreground service can be started by the app, not by a plain process, so it goes to AgentService's control
// endpoint (loopback, behind a token in the app's private files), and so does finding and ending the app's own processes: a
// program the app runs sees no other process in /proc, not even the app's (measured on the Pixel 10, Android 17: Node's
// /proc held only itself). There are no doors: the VMs' bridges, the host surface,
// the attach co-signer and the egress port are all this phone's loopback already.
//
// The same calls and the same checks as pvm-device.mjs (the host agent cannot tell them apart), with two changes:
//   - a VM is alive when the process that runs it says so in files/run/<instance>.alive ("<pid> <label>", written by the
//     VM's own process at "APP serving https-p256", Main.markAlive) and that pid is still that process (AgentService's
//     process list): crosvm is another uid's, and Android may bring a VM's process back with no VM in it (2026-10-11);
//   - the bridge token is read from the app's private files (files/bridge-token[-slotK], LocalBridge).
import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RELEASE_PACKAGE, MAX_SLOTS, slotPorts } from "./pvm-device.mjs";

export { RELEASE_PACKAGE, MAX_SLOTS, slotPorts };
const SERVICE = "host.enclave.anchor.avf.AnchorService";

/** AgentService's control endpoint: launch a VM service, list this app's processes, end one VM process. */
export function controlClient({ port, tokenFile, timeoutMs = 20000 }) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("pvm-device-local: control port must be 1024..65535");
  const token = () => {
    const t = fs.readFileSync(tokenFile, "utf8").trim();
    if (!/^[0-9a-f]{64}$/.test(t)) throw new Error("pvm-device-local: no control token in the app's files");
    return t;
  };
  async function call(method, route, body) {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(`http://127.0.0.1:${port}${route}`, { method, signal: ac.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${token()}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const a = await r.json().catch(() => ({}));
      if (r.status !== 200) throw new Error(String(a.error || r.status).slice(0, 200));
      return a;
    } finally { clearTimeout(t); }
  }
  return {
    async launch(service, extras) {
      const a = await call("POST", "/launch", { service, extras }).catch((e) => { throw new Error(`the service did not start: ${e.message}`); });
      if (a.ok !== true) throw new Error("the service did not start");
    },
    async procs() { const a = await call("GET", "/procs"); return Array.isArray(a.procs) ? a.procs : []; },
    async kill(proc) { const a = await call("POST", "/kill", { process: proc }); if (a.ok !== true) throw new Error(`${proc} did not end`); },
  };
}

/**
 * The phone's VMs, from inside the phone: the same handle as createPvmDevice. files: the app's private files dir
 * (Context.getFilesDir), apk: the installed APK (ApplicationInfo.sourceDir), control: AgentService's { port, tokenFile }.
 */
export function createLocalPvmDevice({ files, apk = null, control, pkg = RELEASE_PACKAGE, vmName, relay, name, agentPort, attachPort,
                                       egressPort = 0, bridgeApp = 17786, bridgeEvidence = 17787, slots = 0, log = () => {},
                                       app = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (typeof files !== "string" || !path.isAbsolute(files)) throw new Error("pvm-device-local: files must be the app's files dir (absolute)");
  if (!/^[a-z0-9-]{1,29}$/.test(vmName || "")) throw new Error("pvm-device-local: vmName must be 1..29 of [a-z0-9-] (a slot's instance is <vmName>s<k>)");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name || "")) throw new Error("pvm-device-local: name must be the tunnel name");
  if (!/^wss?:\/\/\S+$/.test(relay || "")) throw new Error("pvm-device-local: relay must be the relay's ws(s) fleet-tunnel URL");
  if (!Number.isInteger(slots) || slots < 0 || slots > MAX_SLOTS) throw new Error(`pvm-device-local: slots must be 0..${MAX_SLOTS}`);
  const ctl = app || controlClient(control || {});   // { launch, procs, kill }: AgentService (tests pass their own)
  const f = (...p) => path.join(files, ...p);
  const readText = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
  /** write 0600 under a temporary name, then rename into place */
  const writePrivate = (p, data) => {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, p);
  };
  const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

  async function installedApkSha() {
    if (!apk) return null;
    const h = crypto.createHash("sha256");
    for await (const c of fs.createReadStream(apk)) h.update(c);
    return h.digest("hex");
  }
  const capture = async (label) => /^[A-Za-z0-9._-]{1,80}$/.test(label || "") ? readText(f("capture", `${label}.log`)) : "";

  function vm(k) {
    const slot = k > 0, suffix = slot ? `-slot${k}` : "";
    const ports = slot ? slotPorts(k) : { app: bridgeApp, evidence: bridgeEvidence };
    const proc = slot ? `${pkg}:slot${k}` : pkg, service = slot ? `${SERVICE}Slot${k}` : SERVICE;
    const instance = slot ? `${vmName}s${k}` : vmName, appFile = `app${suffix}.wasm`, optsFile = `app-opts${suffix}`;
    const labelOk = (label) => slot ? label.startsWith(`s${k}-`) : !/^s[0-9]-/.test(label);
    let token = null;

    async function stageApp(file, sha256) {
      const bytes = fs.readFileSync(file);
      if (sha(bytes) !== sha256) throw new Error(`the staged component is ${sha(bytes)}, not ${sha256}`);
      writePrivate(f(appFile), bytes);
      const got = sha(fs.readFileSync(f(appFile)));
      if (got !== sha256) throw new Error(`the staged component is ${got}, not ${sha256}`);
      return f(appFile);
    }

    async function stageOptions(text) {
      if (text === null) { fs.rmSync(f(optsFile), { force: true }); return; }
      if (!/^[A-Z]{3,6} [0-9a-f ]+(\n[A-Z]{3,6} [0-9a-f ]+)*\n?$/.test(text)) throw new Error("stageOptions: not an options file");
      writePrivate(f(optsFile), text);
      if (sha(fs.readFileSync(f(optsFile))) !== sha(Buffer.from(text))) throw new Error("the staged options file does not match");
    }

    const pidOf = async () => { const p = (await ctl.procs()).find((x) => x.name === proc); return p ? Number(p.pid) : null; };
    /** End this VM only, by ending its own process (the VM ends with its client process). Never the app's others. */
    async function stop() {
      if (!await pidOf()) return;
      await ctl.kill(proc);
      if (await pidOf()) throw new Error(`${proc} did not end`);
    }

    async function launch({ proofPins = null, label, attachSigner = null, sock = 0, memMib = 0, appMem = 0, vmMib = 0, cpus = 0, opts = false }) {
      if (!/^[A-Za-z0-9._-]{1,80}$/.test(label || "") || !labelOk(label)) throw new Error(`launch: label must be 1..80 of [A-Za-z0-9._-]${slot ? `, starting s${k}-` : ""}`);
      if (proofPins !== null && !/^[0-9]+( 0x[0-9a-f]+){5}$/.test(proofPins)) throw new Error("launch: proofPins must be the six canonical pins");
      const mem = appMem || memMib;
      if (!Number.isInteger(sock) || sock < 0 || sock > 65535 || !Number.isInteger(mem) || (mem && (mem < 16 || mem > 1024)))
        throw new Error("launch: sock must be a port (0 = a wasi:http app) and the app's memory 16..1024 MiB");
      if (slot && (!Number.isInteger(vmMib) || vmMib < 256 || vmMib > 8192 || ![0, 1].includes(cpus))) throw new Error("launch: a slot VM needs vmMib 256..8192 and cpus 0|1");
      token = null;
      const extras = [["mode", "s", "app"], ["vmname", "s", instance], ["app", "s", f(appFile)], ["app_serve_s", "i", 0], ["app_tls", "i", 2],
                      ["name", "s", name], ["capture", "s", label], ["bridge_app", "i", ports.app], ["bridge_evidence", "i", ports.evidence],
                      ...(slot ? [["slot", "z", true], ["mem", "i", vmMib], ["resize", "z", true], ...(cpus ? [["cpus", "i", cpus]] : [])]
                               : [["relay", "s", relay], ...(agentPort ? [["host_agent", "s", `http://127.0.0.1:${agentPort}`]] : []),
                                  ...(attachSigner ? [["attach_signer", "s", attachSigner]] : [])]),
                      ...(proofPins ? [["proof_pins", "s", proofPins]] : []),
                      ...(sock ? [["app_sock", "i", sock]] : []), ...(mem && (sock || slot) ? [["app_mem", "i", mem]] : []),
                      ...(opts ? [["app_opts", "z", true]] : [])];
      await stop();
      fs.rmSync(f("run", `${instance}.alive`), { force: true });
      await ctl.launch(service, extras);
      log({ ev: "device-launch", slot: k, label, idle: proofPins === null, ...(slot ? { vmMib, cpus } : {}) });
    }

    /** This launch's VM still serves: its process says so (files/run/<instance>.alive, this label, a pid that is still this
     *  process), and its capture says serving with no end since. */
    async function alive(label) {
      const m = readText(f("run", `${instance}.alive`)).trim().match(/^([0-9]+) ([A-Za-z0-9._-]{1,80})$/);
      if (!m || m[2] !== label) return false;
      if (await pidOf() !== Number(m[1])) return false;
      const text = await capture(label);
      return text.includes("APP serving https-p256") && !/CONTROL closed|CONTROL error|APP served |HOST FAIL/.test(text);
    }

    async function waitServing(label, timeoutMs = 240000) {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        const text = await capture(label);
        const ok = text.split("\n").find((l) => l.includes("APP serving https-p256"));
        if (ok) return { line: ok, text };
        const bad = text.split("\n").find((l) => /APP refused|HOST FAIL|CONFIG ERROR|CONTROL closed|CONTROL error/.test(l));
        if (bad) throw new Error(`the VM did not serve: ${bad.slice(0, 300)}`);
        await sleep(3000);
      }
      throw new Error(`the VM did not serve within ${Math.round(timeoutMs / 1000)} s`);
    }

    async function readToken() {
      const t = readText(f(`bridge-token${suffix}`)).trim();
      if (!/^[0-9a-f]{64}$/.test(t)) throw new Error("no bridge token on the phone (the VM is not serving https-p256)");
      token = t;
      return t;
    }

    async function exchange(line, extra = null, timeoutMs = 25000) {
      if (/[\r\n]/.test(line)) throw new Error("exchange: one line");
      if (!token) await readToken();
      const once = () => new Promise((resolve, reject) => {
        const s = net.connect(ports.evidence, "127.0.0.1");
        const chunks = []; let size = 0;
        const t = setTimeout(() => { s.destroy(); reject(new Error(`no answer from the VM in ${timeoutMs} ms`)); }, timeoutMs);
        s.on("connect", () => { s.write(`AUTH ${token}\n${line}\n`); if (extra) s.write(extra); });
        s.on("data", (d) => { size += d.length; if (size > (1 << 20)) { s.destroy(); reject(new Error("answer over 1 MiB")); } else chunks.push(d); });
        s.on("error", (e) => { clearTimeout(t); reject(e); });
        s.on("close", () => { clearTimeout(t); resolve(Buffer.concat(chunks).toString("utf8")); });
      });
      // the VM's process opens its bridges just after it logs "serving": on the phone itself (no adb round trip) the first
      // connect can come before the listener (measured 2026-10-13: ECONNREFUSED right after vm-serving), so a refused
      // connection is tried again for up to 10 s
      const tryOnce = async () => {
        for (let i = 0; ; i++) {
          try { return await once(); }
          catch (e) { if (e.code !== "ECONNREFUSED" || i >= 20) throw e; await sleep(500); }
        }
      };
      const a = await tryOnce();
      if (/bridge: AUTH <token> first/.test(a)) { token = null; await readToken(); return tryOnce(); }
      return a;
    }

    const carrierFetch = async (_url, { body } = {}) => {
      const line = String(body || "").replace(/\n$/, "");
      try { const a = await exchange(line); return { status: 200, text: async () => a }; }
      catch (e) { return { status: 502, text: async () => JSON.stringify({ error: e.message }) }; }
    };
    return { stageApp, stageOptions, launch, stop, capture, alive, waitServing, readToken, exchange, carrierFetch,
             slot: k, appPort: ports.app, evidencePort: ports.evidence, vmName: instance, process: proc };
  }

  const host = vm(0), handles = new Map([[0, host]]);
  const slotOf = (k) => {
    if (!Number.isInteger(k) || k < 1 || k > slots) throw new Error(`pvm-device: no slot ${k} (this phone has ${slots})`);
    if (!handles.has(k)) handles.set(k, vm(k));
    return handles.get(k);
  };
  async function readOffer() { const t = readText(f("offer.json")); return t.trim() ? t.slice(0, 4096) : null; }
  /** The hosting panel's settings (the agent writes them now; the app's screen is the panel): whole, then renamed in place. */
  async function writeOffer(text) {
    if (Buffer.byteLength(text) > 4096) throw new Error("the settings are larger than 4096 bytes");
    const t = f(`offer.json.${process.pid}.tmp`);
    fs.writeFileSync(t, text, { mode: 0o600 }); fs.renameSync(t, f("offer.json"));
  }
  return { ...host, ensurePorts: async () => 0, selectTransport: async () => "local", installedApkSha, name, slots, slot: slotOf,
           transport: () => ({ via: "local", target: "this phone" }), readOffer, writeOffer, useSlots: () => {}, agentPort, attachPort, egressPort };
}
