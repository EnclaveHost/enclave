#!/usr/bin/env node
// local-hub.mjs -- the relay's REAL tunnel hub (relay/tunnel.js createTunnelHub) on this machine, with the pVM CPU tier's
// admission policy (relay/pvm-cpu-tier.mjs), so the phone attaches end to end over `adb reverse` without touching the
// production relay. The pins are the caller's: Google's attestation roots (the hub's defaults), the build's code hash (pins.py
// computes it from the APK's v4 signature), the APK signing authority, the model and its self-test reference. Unlike
// host/local-hub.mjs (the dealt-pads hub: the v1 list, no tier policy) this hub is configured for the pVM CPU tier alone.
//   node cpu/local-hub.mjs --port 18443 --code-hash H --authority A --model-sha S --selftest-sha R --min-tok-s F
//                          [--min-mem-mib M] [--seconds N]
// One JSON line per event on stdout: listening, the hub's own log lines (attach verdicts, "pvm-cpu ADMITTED/REFUSED"),
// and the hub's row for the name on every change (onChange) -- where the relay-owned tier and pvmCpu show. Exits after --seconds (default 900).
import http from "node:http";
import { createTunnelHub } from "../../../../relay/tunnel.js";
import { pvmCpuPolicy } from "../../../../relay/pvm-cpu-tier.mjs";

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const need = ["--code-hash", "--authority", "--model-sha", "--selftest-sha", "--min-tok-s"];
if (need.some((k) => !arg(k))) { console.error(`usage: local-hub.mjs ${need.map((k) => k + " X").join(" ")} [--port P] [--min-mem-mib M] [--seconds N]`); process.exit(2); }
const emit = (o) => process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n");
const pvmCpu = pvmCpuPolicy({ codeHashes: [arg("--code-hash")], authorityHashes: [arg("--authority")],
  models: [{ sha256: arg("--model-sha"), name: "e2b-q4_0", selftestSha256: arg("--selftest-sha"), minDecodeTokS: Number(arg("--min-tok-s")),
             minMemMib: Number(arg("--min-mem-mib", "0")) }] });
// v2 (pad-binding transcript) attaches are judged against the pvm-cpu build's code hash; the APK authority is the avf pin.
// No pad builds: this hub never deals pads.
const attest = { avf: { codeHashes: [], padCodeHashes: [], authorityHashes: [arg("--authority")] }, pvmCpu };
const log = console.log; console.log = (...a) => { emit({ hub: a.map(String).join(" ") }); };
const hub = createTunnelHub({ allow: [], attest, onChange: (why, name) => emit({ change: why, name, row: hub.origins().find((o) => o.name === name) || null }) });
const server = http.createServer((_req, res) => res.end("local hub"));
server.on("upgrade", (req, socket, head) => hub.handleUpgrade(req, socket, head));
const port = Number(arg("--port", "18443"));
server.listen(port, "127.0.0.1", () => emit({ listening: `ws://127.0.0.1:${port}/v1/fleet-tunnel` }));
setTimeout(() => { emit({ end: "time" }); console.log = log; process.exit(0); }, Number(arg("--seconds", "900")) * 1000).unref();
process.on("SIGTERM", () => { emit({ end: "SIGTERM" }); process.exit(0); });
