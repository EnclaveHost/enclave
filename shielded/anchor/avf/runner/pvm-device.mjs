// pvm-device.mjs -- the owner's handle on the phone that hosts the pVM (PVM-CPU.md "Serving buyers"), over adb on USB:
//   - the loopback doors: `adb reverse` for the phone to reach the host agent and the attach co-signer on this machine, and
//     `adb forward` for this machine to reach the VM's TLS app port and evidence endpoint through the phone's LocalBridge;
//   - the VMs' launches: the release app (host.enclave.pvmcpu) started as a foreground service with one app and, for a lease,
//     that lease's proof pins -- the host VM in the app's main process, each slot VM in its own (AnchorServiceSlotN, ":slotN");
//     each stopped by killing its own process (the VM ends with it), never the others;
//   - the evidence exchange: one line (and optional bytes) to the VM's evidence endpoint behind the bridge's AUTH token,
//     one answer back. The bytes are untrusted: every consumer verifies what it gets (proof-agent.mjs, the relay);
//   - the deployment's options for a launch (its environment, rules, egress port and token): written into the app's PRIVATE
//     files (run-as, umask 077; never /data/local/tmp), read once by the app at launch and deleted there (Main.appOptions).
// Nothing here holds a key. The token is read from the app's external files dir, which other apps on the phone cannot read.
import { execFile } from "node:child_process";
import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";

export const RELEASE_PACKAGE = "host.enclave.pvmcpu";
const SERVICE = "host.enclave.anchor.avf.AnchorService";
export const MAX_SLOTS = 4;
/** A slot's loopback ports (the phone's LocalBridge and this machine's `adb forward`, the same numbers): 17796/17797 for slot 1,
 *  then +10 per slot -- clear of the host VM's 17786/17787 and of each other. */
export const slotPorts = (k) => ({ app: 17786 + 10 * k, evidence: 17787 + 10 * k });

/**
 * The phone's VMs: the HOST VM (the release app's main process: the idle app, the relay tunnel, the host's registered proof
 * key) and up to MAX_SLOTS slot VMs (AnchorServiceSlotN, each in its own process ":slotN": one buyer's app each, sized to its
 * share). The handle returned is the host VM's; `slot(k)` is slot k's, with the same calls.
 */
export function createPvmDevice({ adb, serial, pkg = RELEASE_PACKAGE, vmName, relay, name, agentPort, attachPort, egressPort = 0,
                                  bridgeApp = 17786, bridgeEvidence = 17787, slots = 0, log = () => {} }) {
  if (!adb || !serial) throw new Error("pvm-device: adb and the phone's serial are required");
  if (!/^[a-z0-9-]{1,29}$/.test(vmName || "")) throw new Error("pvm-device: vmName must be 1..29 of [a-z0-9-] (a slot's instance is <vmName>s<k>)");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name || "")) throw new Error("pvm-device: name must be the tunnel name");
  if (!/^wss?:\/\/\S+$/.test(relay || "")) throw new Error("pvm-device: relay must be the relay's ws(s) fleet-tunnel URL");
  if (!Number.isInteger(slots) || slots < 0 || slots > MAX_SLOTS) throw new Error(`pvm-device: slots must be 0..${MAX_SLOTS}`);
  const run = (args, { timeoutMs = 60000, input = null } = {}) => new Promise((resolve, reject) => {
    const p = execFile(adb, ["-s", serial, ...args], { timeout: timeoutMs, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`adb ${args.slice(0, 2).join(" ")}: ${(stderr || err.message).toString().trim().slice(0, 300)}`));
      else resolve(stdout.toString().replace(/\r/g, ""));
    });
    if (input !== null) { p.stdin.end(input); }
  });
  const sh = (cmd, opts) => run(["shell", cmd], opts);

  /** The doors: idempotent (an existing mapping is left as it is). USB reconnects drop them, so every tick calls this. */
  async function ensurePorts() {
    const fw = await run(["forward", "--list"]), rv = await run(["reverse", "--list"]).catch(() => "");
    const want = [];
    const fwd = [bridgeApp, bridgeEvidence];
    for (let k = 1; k <= slots; k++) fwd.push(slotPorts(k).app, slotPorts(k).evidence);
    for (const p of fwd) if (!fw.includes(`tcp:${p} tcp:${p}`)) want.push(run(["forward", `tcp:${p}`, `tcp:${p}`]));
    for (const p of [agentPort, attachPort, egressPort].filter(Boolean)) if (!rv.includes(`tcp:${p} tcp:${p}`)) want.push(run(["reverse", `tcp:${p}`, `tcp:${p}`]));
    await Promise.all(want);
    return want.length;
  }

  async function installedApkSha() {
    const p = (await sh(`pm path ${pkg}`)).split("\n").find((l) => l.startsWith("package:"));
    if (!p) return null;
    return (await sh(`sha256sum ${p.slice(8).trim()}`)).slice(0, 64);
  }
  const capture = (label) => sh(`run-as ${pkg} cat files/capture/${label}.log`).catch(() => "");

  /**
   * One VM's handle. k = 0: the host VM (the main process, its idle app: labels "idle-..."); k >= 1: slot k (process ":slotk",
   * instance <vmName>s<k>, labels "s<k>-...", files with the suffix "-slot<k>").
   */
  function vm(k) {
    const slot = k > 0, suffix = slot ? `-slot${k}` : "";
    const ports = slot ? slotPorts(k) : { app: bridgeApp, evidence: bridgeEvidence };
    const proc = slot ? `${pkg}:slot${k}` : pkg, service = slot ? `${SERVICE}Slot${k}` : SERVICE;
    const instance = slot ? `${vmName}s${k}` : vmName, appFile = `files/app${suffix}.wasm`, optsFile = `files/app-opts${suffix}`;
    const labelOk = (label) => slot ? label.startsWith(`s${k}-`) : !/^s[0-9]-/.test(label);
    let token = null;

    /** The component into the app's own files (an app cannot read /data/local/tmp), checked by hash on the phone. */
    async function stageApp(file, sha256) {
      const tmp = `/data/local/tmp/pvm-host-app-${sha256.slice(0, 16)}${suffix}.wasm`;
      await run(["push", file, tmp], { timeoutMs: 300000 });
      await sh(`run-as ${pkg} mkdir -p files && run-as ${pkg} cp ${tmp} ${appFile} && rm -f ${tmp}`);
      const got = (await sh(`run-as ${pkg} sha256sum ${appFile}`)).slice(0, 64);
      if (got !== sha256) throw new Error(`the staged component is ${got}, not ${sha256}`);
      return `/data/user/0/${pkg}/${appFile}`;
    }

    /** The launch's options file (text: ENV/WAF/EGRESS lines, Main.appOptions) into the app's private files, checked by hash;
     *  null removes any left over. */
    async function stageOptions(text) {
      if (text === null) { await sh(`run-as ${pkg} rm -f ${optsFile}`); return; }
      if (!/^[A-Z]{3,6} [0-9a-f ]+(\n[A-Z]{3,6} [0-9a-f ]+)*\n?$/.test(text)) throw new Error("stageOptions: not an options file");
      // over `adb shell`'s stdin (the shell protocol waits for the remote end; `exec-in` from a child process dropped the
      // bytes when its stdin closed first: measured), into a 0600 file the app's uid owns, renamed into place
      await sh(`run-as ${pkg} sh -c 'umask 077; cat > ${optsFile}.tmp && mv ${optsFile}.tmp ${optsFile}'`, { input: text });
      const got = (await sh(`run-as ${pkg} sha256sum ${optsFile}`)).slice(0, 64);
      if (got !== crypto.createHash("sha256").update(text).digest("hex")) throw new Error("the staged options file does not match");
    }

    const pidOf = async () => { const p = (await sh(`pidof ${proc}`).catch(() => "")).trim(); return /^[0-9]+$/.test(p) ? p : null; };
    /** End this VM only, by killing its own process (run-as: the app's uid; the VM ends with its client process). Never
     *  force-stop: that ends every process of the app, the other slots' VMs with them. */
    async function stop() {
      const pid = await pidOf();
      if (!pid) return;
      await sh(`run-as ${pkg} kill ${pid}`).catch(() => {});
      for (let i = 0; i < 20 && await pidOf() === pid; i++) await new Promise((r) => setTimeout(r, 500));
      if (await pidOf() === pid) throw new Error(`${proc} (pid ${pid}) did not end`);
    }

    /**
     * Start the VM serving the staged app until stopped (APP serve=https-p256). proofPins: the six pins, or null (idle).
     * A slot: memMib sizes its VM instance (resized to it before it runs), cpus 1 gives it one vCPU, appMem bounds the app.
     */
    async function launch({ proofPins = null, label, attachSigner = null, sock = 0, memMib = 0, appMem = 0, vmMib = 0, cpus = 0, opts = false }) {
      if (!/^[A-Za-z0-9._-]{1,80}$/.test(label || "") || !labelOk(label)) throw new Error(`launch: label must be 1..80 of [A-Za-z0-9._-]${slot ? `, starting s${k}-` : ""}`);
      if (proofPins !== null && !/^[0-9]+( 0x[0-9a-f]+){5}$/.test(proofPins)) throw new Error("launch: proofPins must be the six canonical pins");
      const mem = appMem || memMib;
      if (!Number.isInteger(sock) || sock < 0 || sock > 65535 || !Number.isInteger(mem) || (mem && (mem < 16 || mem > 1024)))
        throw new Error("launch: sock must be a port (0 = a wasi:http app) and the app's memory 16..1024 MiB");
      if (slot && (!Number.isInteger(vmMib) || vmMib < 256 || vmMib > 8192 || ![0, 1].includes(cpus))) throw new Error("launch: a slot VM needs vmMib 256..8192 and cpus 0|1");
      token = null;
      const extras = [`--es mode app`, `--es vmname ${instance}`, `--es app /data/user/0/${pkg}/${appFile}`, `--ei app_serve_s 0`, `--ei app_tls 2`,
                      `--es name ${name}`, `--es capture ${label}`, `--ei bridge_app ${ports.app}`, `--ei bridge_evidence ${ports.evidence}`,
                      ...(slot ? [`--ez slot true`, `--ei mem ${vmMib}`, `--ez resize true`, ...(cpus ? [`--ei cpus ${cpus}`] : [])]
                               : [`--es relay ${relay}`, ...(agentPort ? [`--es host_agent http://127.0.0.1:${agentPort}`] : []),
                                  ...(attachSigner ? [`--es attach_signer ${attachSigner}`] : [])]),
                      ...(proofPins ? [`--es proof_pins '${proofPins}'`] : []),
                      ...(sock ? [`--ei app_sock ${sock}`] : []), ...(mem && (sock || slot) ? [`--ei app_mem ${mem}`] : []),
                      ...(opts ? [`--ez app_opts true`] : [])];
      await stop();
      const out = await sh(`am start-foreground-service -n ${pkg}/${service} ${extras.join(" ")}`);
      if (!/Starting service/.test(out)) throw new Error(`the service did not start: ${out.trim().slice(0, 200)}`);
      log({ ev: "device-launch", slot: k, label, idle: proofPins === null, ...(slot ? { vmMib, cpus } : {}) });
    }
    /** The VM of this launch still serves: its process runs and its capture says serving, with no end since. */
    async function alive(label) {
      if (!await pidOf()) return false;
      // the running session is this VM's newest capture: an older label's file may still say "serving" (a killed VM writes no end)
      const newest = (await sh(`run-as ${pkg} ls -t files/capture`).catch(() => "")).split("\n").map((l) => l.trim().replace(/\.log$/, "")).find((l) => l && labelOk(l));
      if (newest !== label) return false;
      const text = await capture(label);
      return text.includes("APP serving https-p256") && !/CONTROL closed|CONTROL error|APP served |HOST FAIL/.test(text);
    }

    /** Wait until the capture says the app serves (resolves the line) or the run failed (rejects with the line). */
    async function waitServing(label, timeoutMs = 240000, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
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
      const t = (await sh(`cat /storage/emulated/0/Android/data/${pkg}/files/bridge-token${suffix}`)).trim();
      if (!/^[0-9a-f]{64}$/.test(t)) throw new Error("no bridge token on the phone (the VM is not serving https-p256)");
      token = t;
      return t;
    }

    /** One exchange with the VM's evidence endpoint: the answer's text (the VM closes after one answer). */
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
      const a = await once();
      if (/bridge: AUTH <token> first/.test(a)) { token = null; await readToken(); return once(); }   // a re-launched VM wrote a new token
      return a;
    }

    /** The proof agent's carrier, as a fetch: POST <line> -> the VM's one-line answer. The URL is ignored (one VM per handle). */
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
  return { ...host, ensurePorts, installedApkSha, sh, serial, name, slots, slot: slotOf };
}

/** sha256 of a file, hex. */
export function fileSha256(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
