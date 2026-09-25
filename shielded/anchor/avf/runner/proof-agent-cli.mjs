#!/usr/bin/env node
// proof-agent-cli.mjs -- run the posting agent (proof-agent.mjs) as the owner's process. Secrets stay out of the config and
// out of argv:
//   PROOF_AGENT_RPC=<the chain's RPC URL; it may embed a provider key>  OPERATOR_KEY_FILE=<a file holding 0x + 64 hex, mode 0600>
//   node shielded/anchor/avf/runner/proof-agent-cli.mjs --config <agent.json> --state <dir> [--once | --ticks N | --release]
// A config of format enclave-pvm-runner-agent/v1 (RUNNER-AGENT.md) runs the LIFECYCLE agent around the proofs (register or
// setProofKey, claim, renew, heartbeat); --release then means: settle what is in flight, a final proof, release, and exit.
// The config (format enclave-pvm-proof-agent/v1, checkAgentConfig) holds only public values: the chain id, the address book
// or the three contract addresses, the deployment, the runner endpoint, the operator ADDRESS, the carrier URL, the evidence
// pins of the build, and the owner's fee cap. The key file must be readable by its owner only; its address must be the
// config's operator. One JSON line per event on stdout; SIGINT/SIGTERM stop after the current tick and release the lock.
// Exit 0 when every tick it ran ended without an error outcome, 1 otherwise, 2 on a usage or configuration refusal.
import fs from "node:fs";
import { createProofAgent, checkAgentConfig } from "./proof-agent.mjs";
import { createRunnerAgent, checkRunnerConfig, RUNNER_CONFIG_FORMAT } from "./runner-agent.mjs";

const argv = process.argv.slice(2);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const die = (m, code = 2) => { console.error(`proof-agent: ${m}`); process.exit(code); };
const cfgPath = val("--config"), stateDir = val("--state");
if (!cfgPath || !stateDir) die("usage: proof-agent-cli.mjs --config <agent.json> --state <dir> [--once | --ticks N | --release]");
const releaseNow = argv.includes("--release");
const ticks = argv.includes("--once") ? 1 : val("--ticks") ? Number(val("--ticks")) : Infinity;
if (!(ticks >= 1)) die("--ticks must be a positive integer");

let config, checked;   // the agent re-checks the raw object itself; the checked copy only supplies the chain id here
let runnerMode = false;
try {
  config = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  runnerMode = !!config && config.format === RUNNER_CONFIG_FORMAT;
  checked = runnerMode ? checkRunnerConfig(config).proof : checkAgentConfig(config);
} catch (e) { die(e.message); }
if (releaseNow && !runnerMode) die("--release needs a runner config (format enclave-pvm-runner-agent/v1): the proof agent alone never releases");
const rpc = process.env.PROOF_AGENT_RPC || "";
if (!/^https?:\/\/\S+$/.test(rpc)) die("PROOF_AGENT_RPC must be the chain's http(s) RPC URL (it is not taken from argv or the config: it may embed a provider key)");
const keyFile = process.env.OPERATOR_KEY_FILE || "";
if (!keyFile) die("OPERATOR_KEY_FILE must name the operator key file (the key is never taken from argv, the config or the environment itself)");
let key;
try {
  const st = fs.statSync(keyFile);
  if (!st.isFile()) die(`${keyFile} is not a regular file`);
  if (st.mode & 0o077) die(`${keyFile} is readable by others (mode ${(st.mode & 0o777).toString(8)}): chmod 600 it`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) die(`${keyFile} is not owned by this user`);
  key = fs.readFileSync(keyFile, "utf8").trim();
} catch (e) { die(`cannot read OPERATOR_KEY_FILE: ${e.message}`); }
if (!/^0x[0-9a-f]{64}$/i.test(key)) die(`${keyFile} does not hold one 0x + 64 hex private key`);

const V = await import("viem"), { privateKeyToAccount } = await import("viem/accounts");
const account = privateKeyToAccount(key); key = null;
const chain = { id: Number(checked.chainId), name: `chain-${checked.chainId}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
const publicClient = V.createPublicClient({ chain, transport: V.http(rpc, { retryCount: 2, retryDelay: 500, timeout: 20000 }) });
const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));

let agent;
try { agent = await (runnerMode ? createRunnerAgent : createProofAgent)({ config, publicClient, account, stateDir, log }); } catch (e) { die(e.message); }
const ac = new AbortController();
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { log({ ev: "signal", signal: s, note: "stopping after the current tick" }); ac.abort(); });
let bad = 0;
try {
  const st = await agent.start();
  log({ ev: "started", addresses: st.addresses, recovered: st.recovered && st.recovered.kind, proofKey: st.attested && st.attested.proofKey, attestReason: st.attestReason });
  if (releaseNow) {
    const r = await agent.stop({ release: true });
    log({ ev: "stop", kind: r.kind, proof: r.proof && r.proof.kind, release: r.release && r.release.kind });
    bad = ["released", "not-our-lease"].includes(r.kind) ? 0 : 1;
  } else {
    const outs = await agent.run({ ticks, signal: ac.signal });
    bad = outs.filter((o) => o.kind === "error").length;
  }
} catch (e) { log({ ev: "fatal", reason: e.shortMessage || e.message }); bad = 1; }
finally { agent.close(); }
process.exitCode = bad ? 1 : 0;
