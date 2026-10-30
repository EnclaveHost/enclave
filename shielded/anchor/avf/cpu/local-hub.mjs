#!/usr/bin/env node
// local-hub.mjs -- the relay's REAL tunnel hub (relay/tunnel.js createTunnelHub) on this machine, with the pVM CPU tier's
// admission policy (relay/pvm-cpu-tier.mjs), so the phone attaches end to end over `adb reverse` without touching the
// production relay. The pins are the caller's: Google's attestation roots (the hub's defaults), the build's code hash (pins.py
// computes it from the APK's v4 signature), the APK signing authority, the model and its self-test reference. Unlike
// host/local-hub.mjs (the dealt-pads hub: the v1 list, no tier policy) this hub is configured for the pVM CPU tier alone.
//   node cpu/local-hub.mjs --port 18443 --code-hash H[,H2] --authority A --model-sha S --selftest-sha R --min-tok-s F
//                          [--min-mem-mib M] [--seconds N]
//                          [--app-id <sha256> [--runtime-id <hex>] --app-port 18445 --app-name <tunnel name>] [--evidence-port 18446]
//                          [--sealed-port 18448] [--web-port 18447 --web-origin http://127.0.0.1:18450]
// With --app-id (the LAB serving prototype, NOT production): the hub issues each pVM attach a fresh ABI/2 nonce, verifies
// the app's evidence itself (relay/pvm-app-attest.mjs; runtime pinned to --runtime-id, default the pVM runtime), publishes
// the verified app at GET /pvm-app/<name> (the transport key a client pins), and splices each TCP connection on
// --app-port raw to that app: TLS terminates in the VM, this hub and the phone carry ciphertext and log sizes only.
// One JSON line per event on stdout: listening, the hub's own log lines (attach verdicts, "pvm-cpu ADMITTED/REFUSED"),
// and the hub's row for the name on every change (onChange) -- where the relay-owned tier and pvmCpu show. Exits after --seconds (default 900).
import http from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";
import { createTunnelHub } from "../../../../relay/tunnel.js";
import { pvmCpuPolicy } from "../../../../relay/pvm-cpu-tier.mjs";
import { createWebCarrier } from "./web-carrier.mjs";

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const need = ["--code-hash", "--authority", "--model-sha", "--selftest-sha", "--min-tok-s"];
if (need.some((k) => !arg(k))) { console.error(`usage: local-hub.mjs ${need.map((k) => k + " X").join(" ")} [--port P] [--min-mem-mib M] [--seconds N]`); process.exit(2); }
const emit = (o) => process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n");
// --code-hash: one build, or a comma list (a same-key update: INSTANCE-BINDING.md)
const pvmCpu = pvmCpuPolicy({ codeHashes: arg("--code-hash").split(","), authorityHashes: [arg("--authority")],
  models: [{ sha256: arg("--model-sha"), name: "e2b-q4_0", selftestSha256: arg("--selftest-sha"), minDecodeTokS: Number(arg("--min-tok-s")),
             minMemMib: Number(arg("--min-mem-mib", "0")) }] });
// v2 (pad-binding transcript) attaches are judged against the pvm-cpu build's code hash; the APK authority is the avf pin.
// No pad builds: this hub never deals pads.
const PIXEL_RUNTIME = '{"cache":"none","cpuFeatures":"baseline","execution":"interpreter","hostIsa":"aarch64","name":"wasmtime","targetIsa":"pulley64","version":"49.0.0","wx":"enforced"}';
const appId = arg("--app-id");
const pvmApp = appId ? { appIds: [appId.toLowerCase()], runtimeIds: [(arg("--runtime-id") || createHash("sha256").update(PIXEL_RUNTIME).digest("hex")).toLowerCase()] } : null;
const attest = { avf: { codeHashes: [], padCodeHashes: [], authorityHashes: [arg("--authority")] }, pvmCpu, ...(pvmApp ? { pvmApp } : {}) };
const log = console.log; console.log = (...a) => { emit({ hub: a.map(String).join(" ") }); };
const hub = createTunnelHub({ allow: [], attest, onChange: (why, name) => emit({ change: why, name, row: hub.origins().find((o) => o.name === name) || null }) });
const server = http.createServer((req, res) => {
  const m = /^\/pvm-app\/([A-Za-z0-9_-]{1,64})$/.exec(req.url || "");
  if (m) {   // the relay-verified app facts (public): what a client pins before it sends a byte
    const row = hub.origins().find((o) => o.name === m[1]);
    res.writeHead(row && row.pvmApp ? 200 : 404, { "content-type": "application/json" });
    return res.end(JSON.stringify(row && row.pvmApp ? { name: m[1], ...row.pvmApp, lab: "NOT PRODUCTION" } : { error: "no verified app" }));
  }
  res.end("local hub");
});
server.on("upgrade", (req, socket, head) => hub.handleUpgrade(req, socket, head));
const port = Number(arg("--port", "18443"));
server.listen(port, "127.0.0.1", () => emit({ listening: `ws://127.0.0.1:${port}/v1/fleet-tunnel`, lab: pvmApp ? "serving prototype, NOT PRODUCTION" : undefined }));
if (arg("--app-port")) {   // LAB: raw TCP -> the verified app's TLS in the VM (hub.spliceRaw); the hub logs sizes only
  const appName = arg("--app-name");
  const raw = net.createServer((sock) => { const ok = hub.spliceRaw(appName, sock); emit({ raw: ok ? "stream opened" : "refused: no verified app", name: appName }); });
  raw.listen(Number(arg("--app-port")), "127.0.0.1", () => emit({ rawListening: `tcp://127.0.0.1:${arg("--app-port")} -> ${appName}` }));
}
if (arg("--evidence-port")) {   // LAB: raw TCP -> the VM's evidence endpoint (a client's nonce in, fresh evidence out)
  const appName = arg("--app-name");
  const ev = net.createServer((sock) => { const ok = hub.spliceRaw(appName, sock, "pvm-evidence"); emit({ raw: ok ? "evidence stream opened" : "evidence refused: no attested attach", name: appName }); });
  ev.listen(Number(arg("--evidence-port")), "127.0.0.1", () => emit({ evidenceListening: `tcp://127.0.0.1:${arg("--evidence-port")} -> ${appName}` }));
}
if (arg("--sealed-port")) {   // LAB, the browser channel: raw TCP -> one HPKE-sealed request to the verified app's key
  const appName = arg("--app-name");
  const se = net.createServer((sock) => { const ok = hub.spliceRaw(appName, sock, "pvm-app-sealed"); emit({ raw: ok ? "sealed stream opened" : "sealed refused: no verified app", name: appName }); });
  se.listen(Number(arg("--sealed-port")), "127.0.0.1", () => emit({ sealedListening: `tcp://127.0.0.1:${arg("--sealed-port")} -> ${appName}` }));
}
// LAB, the browser channel's carrier (cpu/web-carrier.mjs): POST /evidence and /sealed, bytes to the VM and back.
if (arg("--web-port")) {
  createWebCarrier({ port: Number(arg("--web-port")), origin: arg("--web-origin"), evidencePort: Number(arg("--evidence-port")),
                     sealedPort: Number(arg("--sealed-port")), emit, recordEvidence: arg("--record-evidence") });   // LAB: public evidence, kept for offline re-verification
}
setTimeout(() => { emit({ end: "time" }); console.log = log; process.exit(0); }, Number(arg("--seconds", "900")) * 1000).unref();
process.on("SIGTERM", () => { emit({ end: "SIGTERM" }); process.exit(0); });
