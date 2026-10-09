// pvm-device.mjs -- the owner's handle on the phone that hosts the pVM (PVM-CPU.md "Serving buyers"), over adb on USB:
//   - the loopback doors: `adb reverse` for the phone to reach the host agent and the attach co-signer on this machine, and
//     `adb forward` for this machine to reach the VM's TLS app port and evidence endpoint through the phone's LocalBridge;
//   - the VM's launch: the release app (host.enclave.pvmcpu) started as a foreground service with one app and, for a lease,
//     that lease's proof pins; stopped with force-stop (the VM ends with the app's process);
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

export function createPvmDevice({ adb, serial, pkg = RELEASE_PACKAGE, vmName, relay, name, agentPort, attachPort, egressPort = 0,
                                  bridgeApp = 17786, bridgeEvidence = 17787, log = () => {} }) {
  if (!adb || !serial) throw new Error("pvm-device: adb and the phone's serial are required");
  if (!/^[a-z0-9-]{1,32}$/.test(vmName || "")) throw new Error("pvm-device: vmName must be 1..32 of [a-z0-9-]");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name || "")) throw new Error("pvm-device: name must be the tunnel name");
  if (!/^wss?:\/\/\S+$/.test(relay || "")) throw new Error("pvm-device: relay must be the relay's ws(s) fleet-tunnel URL");
  const run = (args, { timeoutMs = 60000, input = null } = {}) => new Promise((resolve, reject) => {
    const p = execFile(adb, ["-s", serial, ...args], { timeout: timeoutMs, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`adb ${args.slice(0, 2).join(" ")}: ${(stderr || err.message).toString().trim().slice(0, 300)}`));
      else resolve(stdout.toString().replace(/\r/g, ""));
    });
    if (input !== null) { p.stdin.end(input); }
  });
  const sh = (cmd, opts) => run(["shell", cmd], opts);
  let token = null;

  /** The doors: idempotent (an existing mapping is left as it is). USB reconnects drop them, so every tick calls this. */
  async function ensurePorts() {
    const fw = await run(["forward", "--list"]), rv = await run(["reverse", "--list"]).catch(() => "");
    const want = [];
    for (const p of [bridgeApp, bridgeEvidence]) if (!fw.includes(`tcp:${p} tcp:${p}`)) want.push(run(["forward", `tcp:${p}`, `tcp:${p}`]));
    for (const p of [agentPort, attachPort, egressPort].filter(Boolean)) if (!rv.includes(`tcp:${p} tcp:${p}`)) want.push(run(["reverse", `tcp:${p}`, `tcp:${p}`]));
    await Promise.all(want);
    return want.length;
  }

  async function installedApkSha() {
    const p = (await sh(`pm path ${pkg}`)).split("\n").find((l) => l.startsWith("package:"));
    if (!p) return null;
    return (await sh(`sha256sum ${p.slice(8).trim()}`)).slice(0, 64);
  }

  /** The component into the app's own files (an app cannot read /data/local/tmp), checked by hash on the phone. */
  async function stageApp(file, sha256) {
    const tmp = `/data/local/tmp/pvm-host-app-${sha256.slice(0, 16)}.wasm`;
    await run(["push", file, tmp], { timeoutMs: 300000 });
    await sh(`run-as ${pkg} mkdir -p files && run-as ${pkg} cp ${tmp} files/app.wasm && rm -f ${tmp}`);
    const got = (await sh(`run-as ${pkg} sha256sum files/app.wasm`)).slice(0, 64);
    if (got !== sha256) throw new Error(`the staged component is ${got}, not ${sha256}`);
    return `/data/user/0/${pkg}/files/app.wasm`;
  }

  /** The launch's options file (text: ENV/WAF/EGRESS lines, Main.appOptions) into the app's private files, checked by hash;
   *  null removes any left over. */
  async function stageOptions(text) {
    if (text === null) { await sh(`run-as ${pkg} rm -f files/app-opts`); return; }
    if (!/^[A-Z]{3,6} [0-9a-f ]+(\n[A-Z]{3,6} [0-9a-f ]+)*\n?$/.test(text)) throw new Error("stageOptions: not an options file");
    // over `adb shell`'s stdin (the shell protocol waits for the remote end; `exec-in` from a child process dropped the
    // bytes when its stdin closed first: measured), into a 0600 file the app's uid owns, renamed into place
    await sh(`run-as ${pkg} sh -c 'umask 077; cat > files/app-opts.tmp && mv files/app-opts.tmp files/app-opts'`, { input: text });
    const got = (await sh(`run-as ${pkg} sha256sum files/app-opts`)).slice(0, 64);
    if (got !== crypto.createHash("sha256").update(text).digest("hex")) throw new Error("the staged options file does not match");
  }

  /** Start the VM serving the staged app until stopped (APP serve=https-p256). proofPins: the six pins, or null (idle). */
  async function launch({ proofPins = null, label, attachSigner = null, sock = 0, memMib = 0, opts = false }) {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(label || "")) throw new Error("launch: label must be 1..80 of [A-Za-z0-9._-]");
    if (proofPins !== null && !/^[0-9]+( 0x[0-9a-f]+){5}$/.test(proofPins)) throw new Error("launch: proofPins must be the six canonical pins");
    if (!Number.isInteger(sock) || sock < 0 || sock > 65535 || !Number.isInteger(memMib) || (memMib && (memMib < 16 || memMib > 1024)))
      throw new Error("launch: sock must be a port (0 = a wasi:http app) and memMib 16..1024");
    token = null;
    const extras = [`--es mode app`, `--es vmname ${vmName}`, `--es app /data/user/0/${pkg}/files/app.wasm`, `--ei app_serve_s 0`, `--ei app_tls 2`,
                    `--es relay ${relay}`, `--es name ${name}`, `--es capture ${label}`, `--ei bridge_app ${bridgeApp}`, `--ei bridge_evidence ${bridgeEvidence}`,
                    ...(agentPort ? [`--es host_agent http://127.0.0.1:${agentPort}`] : []),
                    ...(attachSigner ? [`--es attach_signer ${attachSigner}`] : []),
                    ...(proofPins ? [`--es proof_pins '${proofPins}'`] : []),
                    ...(sock ? [`--ei app_sock ${sock}`, ...(memMib ? [`--ei app_mem ${memMib}`] : [])] : []),
                    ...(opts ? [`--ez app_opts true`] : [])];
    await sh(`am force-stop ${pkg}`);
    const out = await sh(`am start-foreground-service -n ${pkg}/${SERVICE} ${extras.join(" ")}`);
    if (!/Starting service/.test(out)) throw new Error(`the service did not start: ${out.trim().slice(0, 200)}`);
    log({ ev: "device-launch", label, idle: proofPins === null });
  }
  const stop = () => sh(`am force-stop ${pkg}`);
  /** The VM of this launch still serves: the app's process runs and its capture says serving, with no end since. */
  async function alive(label) {
    const pid = (await sh(`pidof ${pkg}`).catch(() => "")).trim();
    if (!/^[0-9]+/.test(pid)) return false;
    // the running session is the newest capture: an older label's file may still say "serving" (a killed VM writes no end)
    const newest = (await sh(`run-as ${pkg} ls -t files/capture`).catch(() => "")).split("\n")[0].trim();
    if (newest !== `${label}.log`) return false;
    const text = await capture(label);
    return text.includes("APP serving https-p256") && !/CONTROL closed|CONTROL error|APP served |HOST FAIL/.test(text);
  }
  const capture = (label) => sh(`run-as ${pkg} cat files/capture/${label}.log`).catch(() => "");

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
    const t = (await sh(`cat /storage/emulated/0/Android/data/${pkg}/files/bridge-token`)).trim();
    if (!/^[0-9a-f]{64}$/.test(t)) throw new Error("no bridge token on the phone (the VM is not serving https-p256)");
    token = t;
    return t;
  }

  /** One exchange with the VM's evidence endpoint: the answer's text (the VM closes after one answer). */
  async function exchange(line, extra = null, timeoutMs = 25000) {
    if (/[\r\n]/.test(line)) throw new Error("exchange: one line");
    if (!token) await readToken();
    const once = () => new Promise((resolve, reject) => {
      const s = net.connect(bridgeEvidence, "127.0.0.1");
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

  /** The proof agent's carrier, as a fetch: POST <line> -> the VM's one-line answer. The URL is ignored (one VM). */
  const carrierFetch = async (_url, { body } = {}) => {
    const line = String(body || "").replace(/\n$/, "");
    try { const a = await exchange(line); return { status: 200, text: async () => a }; }
    catch (e) { return { status: 502, text: async () => JSON.stringify({ error: e.message }) }; }
  };

  return { ensurePorts, installedApkSha, stageApp, stageOptions, launch, stop, capture, alive, waitServing, readToken, exchange, carrierFetch, sh,
           appPort: bridgeApp, evidencePort: bridgeEvidence, serial, name, vmName };
}

/** sha256 of a file, hex. */
export function fileSha256(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
