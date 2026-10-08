// LAB, one-off: main's tunnel hub + the CPU-only pVM policy (relay branch pvm/cpu-only), control only (no splices).
import http from "node:http";
import { createTunnelHub } from "/home/steven/Projects/enclave-pvm-cpuonly/relay/tunnel.js";
import { pvmCpuPolicy, avfAttestWithPvmCpu } from "/home/steven/Projects/enclave-pvm-cpuonly/relay/pvm-cpu-tier.mjs";
const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const emit = (o) => process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n");
const pvmCpu = pvmCpuPolicy({ codeHashes: [arg("--code-hash")], authorityHashes: [arg("--authority")], runtimeIds: [arg("--runtime-id")] });
const attest = { allowedMeasurements: [], avf: avfAttestWithPvmCpu(null, pvmCpu), pvmCpu };   // exactly what api-relay builds from PVM_CPU_* alone
const log = console.log; console.log = (...a) => emit({ hub: a.map(String).join(" ") }); console.warn = console.log;
const hub = createTunnelHub({ allow: [], attest, onChange: (why, name) => emit({ change: why, name, row: hub.origins().find((o) => o.name === name) || null }) });
const server = http.createServer((req, res) => res.end("local hub"));
server.on("upgrade", (req, socket, head) => hub.handleUpgrade(req, socket, head));
server.listen(Number(arg("--port", "18443")), "127.0.0.1", () => emit({ listening: `ws://127.0.0.1:${arg("--port", "18443")}/v1/fleet-tunnel` }));
setTimeout(() => { emit({ end: "time" }); process.exit(0); }, Number(arg("--seconds", "300")) * 1000).unref();
