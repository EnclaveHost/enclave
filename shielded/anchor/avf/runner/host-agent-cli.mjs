#!/usr/bin/env node
// host-agent-cli.mjs -- run the pVM host agent (host-agent.mjs) as the owner's service, beside the phone on USB:
//   HOST_AGENT_RPC=<the chain's RPC URL; it may embed a provider key>  OPERATOR_KEY_FILE=<0x + 64 hex, mode 0600>
//   node shielded/anchor/avf/runner/host-agent-cli.mjs --config <host.json> --state <dir> [--once]
// It serves, on loopback only: the host surface the relay reaches through the phone's tunnel (config device.agentPort, over
// `adb reverse`) and the attach co-signer (device.attachPort), which signs the relay's attach challenge for the owner's own VM
// instance only (attach-cosigner.mjs). One JSON line per event on stdout. SIGINT/SIGTERM stop after the current round, leaving
// any lease to run on (a restart picks it up from the state dir); nothing is released by a signal.
import fs from "node:fs";
import path from "node:path";
import { createHostAgent, checkHostConfig } from "./host-agent.mjs";
import { createPvmDevice } from "./pvm-device.mjs";
import { createAttachCosigner, serveAttachCosigner } from "./attach-cosigner.mjs";

const argv = process.argv.slice(2);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const die = (m, code = 2) => { console.error(`host-agent: ${m}`); process.exit(code); };
const cfgPath = val("--config"), stateDir = val("--state");
if (!cfgPath || !stateDir) die("usage: host-agent-cli.mjs --config <host.json> --state <dir> [--once]");
let config, cfg;
try { config = JSON.parse(fs.readFileSync(cfgPath, "utf8")); cfg = checkHostConfig(config); } catch (e) { die(e.message); }
const rpc = process.env.HOST_AGENT_RPC || "";
if (!/^https?:\/\/\S+$/.test(rpc)) die("HOST_AGENT_RPC must be the chain's http(s) RPC URL (never argv or the config: it may embed a provider key)");
const keyFile = process.env.OPERATOR_KEY_FILE || "";
if (!keyFile) die("OPERATOR_KEY_FILE must name the operator key file");
let key;
try {
  const st = fs.statSync(keyFile);
  if (!st.isFile() || st.mode & 0o077) die(`${keyFile} must be a regular file readable by its owner only (chmod 600)`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) die(`${keyFile} is not owned by this user`);
  key = fs.readFileSync(keyFile, "utf8").trim();
} catch (e) { die(`cannot read OPERATOR_KEY_FILE: ${e.message}`); }
if (!/^0x[0-9a-f]{64}$/i.test(key)) die(`${keyFile} does not hold one 0x + 64 hex private key`);

const V = await import("viem"), { privateKeyToAccount } = await import("viem/accounts");
const account = privateKeyToAccount(key); key = null;
const chain = { id: Number(cfg.chainId), name: `chain-${cfg.chainId}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
const publicClient = V.createPublicClient({ chain, transport: V.http(rpc, { retryCount: 2, retryDelay: 600, timeout: 20000 }) });
const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));

const d = cfg.device;
const device = createPvmDevice({ adb: d.adb, serial: d.serial, vmName: d.vmName, relay: `${cfg.relayOrigin.replace(/^https:/, "wss:")}/v1/fleet-tunnel`,
  name: cfg.name, agentPort: d.agentPort, attachPort: d.attachPort, egressPort: cfg.egress ? cfg.egress.port : 0,
  bridgeApp: d.bridgeApp || 17786, bridgeEvidence: d.bridgeEvidence || 17787, log });
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const cosigner = createAttachCosigner({ account, name: cfg.name, relay: cfg.relayOrigin, codeHashes: cfg.evidence.allowedCodeHashes,
  authorityHashes: cfg.evidence.allowedAuthorityHashes, rootPins: cfg.evidence.rootPins, instanceIds: cfg.evidence.instanceIds,
  journalFile: path.join(stateDir, "attach-journal.jsonl") });
const attach = await serveAttachCosigner(cosigner, { host: "127.0.0.1", port: d.attachPort });
log({ ev: "attach-cosigner", listen: `127.0.0.1:${attach.port}` });
const agent = await createHostAgent({ config, publicClient, account, stateDir, device, log });
const srv = await agent.serve(d.agentPort);
log({ ev: "host-surface", listen: `127.0.0.1:${d.agentPort}`, operator: account.address, enclaveId: cfg.enclaveId, endpoint: cfg.endpoint });

let stopping = false;
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { log({ ev: "signal", signal: s }); stopping = true; });
const once = argv.includes("--once");
let bad = 0;
while (!stopping) {
  try { const r = await agent.tick(); if (once) { log({ ev: "tick", ...r }); break; } }
  catch (e) { bad++; log({ ev: "tick-error", error: e.shortMessage || e.message }); if (once) break; }
  for (let i = 0; i < 30 && !stopping; i++) await new Promise((r) => setTimeout(r, 1000));
}
await agent.stop({ release: false }).catch(() => {});
srv.close(); attach.close(); cosigner.close();
process.exitCode = bad && once ? 1 : 0;
