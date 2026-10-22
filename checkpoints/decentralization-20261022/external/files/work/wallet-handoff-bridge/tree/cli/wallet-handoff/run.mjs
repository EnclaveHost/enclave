#!/usr/bin/env node
// Wallet handoff for the reviewed adapter release, from the CLI's durable signer journal to MetaMask in the browser.
//
//   node cli/wallet-handoff/run.mjs serve   --rpc A,B,C [--quorum 2] [--confirmations 2] [--state-dir DIR | --journal DIR]
//            --publication publication.json --upgrade upgrade.json --profile network-profile-base.json
//            --artifact s3-ipfs-adapter.wasm [--upload upload.json] [--max-fee-gwei 0.5] [--gas-cap 2000000] [--port 0]
//   node cli/wallet-handoff/run.mjs status  (same plan options)          what the chain and the journal say, per step
//   node cli/wallet-handoff/run.mjs list | show <intent> | resolve <intent> | attach <intent> <0xhash> | abandon <intent>
//            --rpc … [--state-dir DIR | --journal DIR]                  the signer's own commands on the same journal
//
// The journal is the CLI's: <--state-dir>/signer, else $XDG_CONFIG_HOME/enclave/independent-signer (as `enclave
// --independent … signer …` uses it). `serve` prints one loopback URL carrying a per-process token after '#': open it
// in the browser where MetaMask is installed. Nothing is asked of MetaMask until a button on that page is pressed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { QuorumChain } from "../independent.mjs";
import { intentJournal, signerCommand } from "../independent-signer.mjs";
import { rpcEndpoint } from "../../network/rpc-identity.mjs";
import { adapterReleasePlan } from "./release-adapter.mjs";
import { createBridge } from "./bridge.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flags = {}, pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--json") flags.json = true;
  else if (argv[i].startsWith("--")) { if (i + 1 >= argv.length) die(`${argv[i]} needs a value`); flags[argv[i].slice(2)] = argv[++i]; }
  else pos.push(argv[i]);
}
function die(m) { process.stderr.write(`wallet-handoff: ${m}\n`); process.exit(2); }
const say = (m) => process.stdout.write(m + "\n");
const jout = (o) => say(JSON.stringify(o, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2));
const readJson = (f, what) => { if (!f) die(`--${what} FILE is required`); return JSON.parse(fs.readFileSync(f, "utf8")); };

const [cmd, ...rest] = pos;
if (!cmd) die("usage: run.mjs serve|status|list|show|resolve|attach|abandon … (see the header of this file)");
const journalDir = path.resolve(flags.journal || (flags["state-dir"] ? path.join(flags["state-dir"], "signer")
  : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "enclave", "independent-signer")));
if (!flags.rpc) die("--rpc URL,URL[,…] is required (at least two independent RPCs; every chain fact is agreed by a quorum)");
const rpcs = flags.rpc.split(",").map((u) => { try { return rpcEndpoint(u.trim()).url.href.replace(/\/$/, ""); } catch (e) { die(e.message); } });
const chainId = Number(flags["chain-id"] || 8453);
const chain = new QuorumChain({ rpcs, chainId, quorum: Number(flags.quorum || 2), confirmations: Number(flags.confirmations ?? 2),
  maxBlockAgeMs: Number(flags["max-block-age"] || 120) * 1000 });
const waitOpts = { timeoutMs: Number(flags["wait-secs"] || 180) * 1000, pollMs: 2000 };

function plan() {
  const catalogAbi = JSON.parse(fs.readFileSync(path.join(HERE, "../../contracts/EnclaveAppCatalog.abi.json"), "utf8"));
  const ledgerAbi = JSON.parse(fs.readFileSync(path.join(HERE, "../../contracts/EnclaveDeployments.abi.json"), "utf8"));
  if (!flags.artifact) die("--artifact FILE is required: the release is only handed off for the exact reviewed bytes");
  const upload = flags.upload ? readJson(flags.upload, "upload") : null;
  return adapterReleasePlan({ publication: readJson(flags.publication, "publication"), upgrade: readJson(flags.upgrade, "upgrade"),
    profile: readJson(flags.profile, "profile"), artifact: fs.readFileSync(flags.artifact), catalogAbi, ledgerAbi,
    artifactOrigins: upload?.verifiedOrigins || [] });
}

if (cmd === "serve" || cmd === "status") {
  const p = plan();
  if (Number(p.chainId) !== chainId) die(`the release is for chain ${p.chainId}; pass --chain-id ${p.chainId}`);
  const bridge = createBridge({ chain, plan: p, journalDir, maxFeeGwei: Number(flags["max-fee-gwei"] || 0.5), gasCap: BigInt(flags["gas-cap"] || 2_000_000),
    waitOpts, log: (m) => process.stderr.write(`wallet-handoff: ${m}\n`) });
  if (cmd === "status") {
    const s = await bridge.state({ fresh: true });
    if (flags.json) jout(s);
    else {
      say(`account ${s.from} on chain ${s.chainId}; journal ${s.journal}`);
      for (const b of s.blocking) say(`BLOCKING: intent ${b.id} (${b.state}, nonce ${b.nonce}) was not prepared by this release; settle it first`);
      for (const u of s.unreadable) say(`UNREADABLE: ${u.id}.json (${u.why})`);
      for (const st of s.steps) {
        say(`${st.id}: ${st.verdict.state}${st.verdict.reason ? ` - ${st.verdict.reason}` : ""}${st.verdict.block ? ` (agreed block ${st.verdict.block.number})` : ""}`);
        if (st.intent) say(`  intent ${st.intent.id}: ${st.intent.state}${st.intent.claimed ? ", handed to the wallet" : ""}${st.intent.hash ? `, ${st.intent.hash}` : ""}, nonce ${st.intent.nonce}`);
      }
    }
    process.exit(0);
  }
  const { url, close } = await bridge.listen({ port: Number(flags.port || 0) });
  process.stderr.write("wallet-handoff: serving on loopback only. Open this link in the browser where MetaMask is installed (it carries this process's token; do not share it):\n");
  say(url);
  const stop = async () => { await close(); process.exit(0); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
} else {
  const journal = intentJournal(journalDir);
  try { await signerCommand(cmd, rest, { chain, journal, say, jout, json: !!flags.json, waitOpts }); }
  catch (e) { process.stderr.write(`wallet-handoff: ${e.message}\n`); process.exit(1); }
  process.exit(0);
}
