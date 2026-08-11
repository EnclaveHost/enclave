#!/usr/bin/env node
// update-address-book.mjs — the one-transaction follow-up to any contract
// redeploy: diff the LIVE EnclaveAddressBook against the repo's current
// addresses (enclaves/gpu/tinfoil-config.yml — run the deploy script and/or
// sync-contract-addresses.sh first) and push the changes with one owner
// setMany. Enclaves, the site, relays, and the CLI follow within a poll.
//
// Interactive like the other contract scripts; flags/env for CI:
//
//   node scripts/update-address-book.mjs                     # prompts
//   node scripts/update-address-book.mjs --set registry=0x…  # explicit entry (repeatable)
//   NETWORK=base DEPLOYER_PRIVATE_KEY=0x... node scripts/update-address-book.mjs --yes
//
// Env: DEPLOYER_PRIVATE_KEY (owner; prompted hidden if unset) · NETWORK · RPC_URL
//      ADDRESS_BOOK_ADDRESS (defaults to the value baked in the gpu config)

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import readline from "node:readline/promises";
import rlSync from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { createWalletClient, createPublicClient, http, getAddress, stringToHex, hexToString } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const CONFIG_GPU = path.join(REPO, "enclaves", "gpu", "tinfoil-config.yml");
const NETWORKS = {
  "base-sepolia": { chain: baseSepolia, rpc: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org" },
  "base":         { chain: base, rpc: "https://mainnet.base.org", explorer: "https://basescan.org" },
};
const ENTRIES = [
  { key: "registry",     env: "REGISTRY_ADDRESS" },
  { key: "deployments",  env: "DEPLOYMENTS_ADDRESS" },
  { key: "appCatalog",   env: "APP_CATALOG_ADDRESS" },
  { key: "proofOfTime",  env: "PROOF_OF_TIME_ADDRESS" },
  { key: "enclavePay",   env: "FORWARDER_ADDRESS" },
];
const args = process.argv.slice(2);
const ASSUME_YES = args.includes("--yes");
const die = (m) => { console.error("error: " + m); process.exit(1); };

function promptSecret(query) {
  return new Promise((resolve) => {
    const rl = rlSync.createInterface({ input, output, terminal: true });
    rl._writeToOutput = (s) => { if (!rl._muted) output.write(s); };
    rl.question(query, (ans) => { rl.close(); output.write("\n"); resolve(ans.trim()); });
    rl._muted = true;
  });
}
async function promptText(query) {
  const rl = readline.createInterface({ input, output });
  const ans = (await rl.question(query)).trim();
  rl.close();
  return ans;
}
async function chooseNetwork() {
  let n = process.env.NETWORK;
  if (!n && !ASSUME_YES && input.isTTY) {
    const keys = Object.keys(NETWORKS);
    output.write("\nSelect network:\n");
    keys.forEach((k, i) => output.write(`  ${i + 1}) ${k}${k === "base" ? "  (MAINNET - real funds)" : "  (testnet)"}\n`));
    const ans = await promptText(`Enter number or name [1=${keys[0]}]: `);
    if (!ans) n = keys[0]; else if (/^\d+$/.test(ans)) n = keys[parseInt(ans, 10) - 1]; else n = ans;
  }
  return (n || "base-sepolia").toLowerCase();
}

const abi = [
  { type: "function", name: "all", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32[]" }, { type: "address[]" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "setMany", stateMutability: "nonpayable",
    inputs: [{ name: "keys_", type: "bytes32[]" }, { name: "values", type: "address[]" }], outputs: [] },
];

/* `deployments` and `proofOfTime` are not two independent keys — they are one
   binding, spelled twice, and getting the pair wrong is the quietest money bug
   on the platform. A ledger meters its runners against a watermark only its
   BOUND prover may advance (setProver, one-shot); EnclaveProofOfTime holds its
   ledger as an IMMUTABLE. So a prover that belongs to a different ledger is not
   degraded, it is inert: every checkpoint a host posts reverts, provenUntil
   never moves, and past the ledger's proofRequiredFrom every seller earns
   exactly zero while the fleet reports itself healthy.
   Neither address looks wrong on its own, which is why nothing else catches it.
   Checked against the state this setMany would LEAVE (both keys may move in the
   same transaction, and that is the normal cutover), and only ever advisory
   before the confirm prompt — retiring to address(0) and staging a not-yet-bound
   ledger are both legitimate. */
async function checkProverPair(after, pub, output) {
  const led = after.deployments, pot = after.proofOfTime;
  if (!led || /^0x0{40}$/i.test(led)) return;
  const one = (address, name, outs) => pub.readContract({ address, functionName: name, args: [],
    abi: [{ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type: outs }] }] }).catch(() => null);
  const [bound, at] = await Promise.all([one(led, "prover", "address"), one(led, "proofRequiredFrom", "uint64")]);
  if (bound === null) return;                       // pre-rev-9 ledger: no proof of time at all
  const warn = (s) => output.write(`  !! ${s}\n`);
  const when = Number(at || 0) ? new Date(Number(at) * 1000).toISOString().slice(0, 16).replace("T", " ") + "Z" : null;
  const dead = when ? `from ${when} it pays every host NOTHING` : "hosts stay on held-time metering";
  output.write("\n");
  if (/^0x0{40}$/i.test(bound)) {
    warn(`the ledger ${led} has NO prover bound — ${dead}.`);
    warn(`   bind one built against THIS ledger first: scripts/deploy-proof-of-time.mjs --bind`);
  } else if (!pot || /^0x0{40}$/i.test(pot)) {
    warn(`the ledger's prover is ${bound} but the book has no \`proofOfTime\` — running enclaves`);
    warn(`   cannot find it and will not prove. Add --set proofOfTime=${bound}`);
  } else if (pot.toLowerCase() !== bound.toLowerCase()) {
    warn(`\`proofOfTime\` ${pot} is NOT the prover this ledger accepts (${bound}) — every`);
    warn(`   checkpoint would revert. The ledger's binding is frozen; the book must match it.`);
  } else {
    const its = await one(pot, "deployments", "address");
    if (its && its.toLowerCase() !== led.toLowerCase())
      warn(`prover ${pot} was built against ledger ${its}, not ${led} — it can credit nothing here.`);
    else output.write(`  proof of time  ${pot}  bound to this ledger ✓${when ? `  (cutover ${when})` : ""}\n`);
  }
}

async function main() {
  const netName = await chooseNetwork();
  const net = NETWORKS[netName]; if (!net) die(`unknown network "${netName}"`);
  const rpc = process.env.RPC_URL || net.rpc;
  const cfg = fs.readFileSync(CONFIG_GPU, "utf8");
  const book = process.env.ADDRESS_BOOK_ADDRESS
    || (cfg.match(/-\s*ADDRESS_BOOK_ADDRESS:\s*"(0x[0-9a-fA-F]{40})"/) || [])[1]
    || die("no ADDRESS_BOOK_ADDRESS (deploy the book first: scripts/deploy-address-book.mjs)");

  const pub = createPublicClient({ chain: net.chain, transport: http(rpc) });
  const [keysHex, values] = await pub.readContract({ address: book, abi, functionName: "all" });
  const owner = await pub.readContract({ address: book, abi, functionName: "owner" });
  const live = {};
  keysHex.forEach((k, i) => { live[hexToString(k, { size: 32 }).replace(/\0+$/, "")] = getAddress(values[i]); });

  // desired = repo config values, overridden by any --set key=0x… flags
  const desired = {};
  for (const e of ENTRIES) {
    const m = cfg.match(new RegExp(`-\\s*${e.env}:\\s*"(0x[0-9a-fA-F]{40})"`));
    if (m) desired[e.key] = getAddress(m[1]);
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--set") continue;
    const m = /^([A-Za-z0-9_-]{1,31})=(0x[0-9a-fA-F]{40})$/.exec(args[i + 1] || "");
    if (!m) die(`--set wants key=0xaddress, got "${args[i + 1]}"`);
    desired[m[1]] = getAddress(m[2]);
  }

  output.write(`\nEnclaveAddressBook ${book} (${netName}) · owner ${owner}\n\n`);
  const pad = (s) => String(s).padEnd(14);
  const diff = [];
  for (const [key, want] of Object.entries(desired)) {
    const cur = live[key] || null;
    const changed = !cur || cur.toLowerCase() !== want.toLowerCase();
    output.write(`  ${pad(key)} ${cur || "(unset)"}${changed ? `  ->  ${want}` : "   (unchanged)"}\n`);
    if (changed) diff.push([key, want]);
  }
  for (const [key, cur] of Object.entries(live))
    if (!(key in desired)) output.write(`  ${pad(key)} ${cur}   (in the book only; left alone)\n`);
  if (!diff.length) { output.write("\nnothing to change.\n"); return; }

  // Every consumer on the platform resolves its contracts THROUGH this book and
  // adopts whatever it finds within one poll — the supervisor's claim path, the
  // relays' ledger reads, the site. So a transposed hex digit here does not fail
  // loudly at the keyboard, it repoints the fleet at an address with nothing
  // behind it. The book itself cannot check (address(0) is the documented way
  // to RETIRE a key, so it must stay legal), which is exactly why the tool that
  // drives it should. --allow-codeless is the deliberate override for pointing
  // at a contract that is not deployed yet.
  const codeless = [];
  for (const [key, want] of diff) {
    if (/^0x0{40}$/i.test(want)) continue;                       // retiring a key
    const code = await pub.getCode({ address: want }).catch(() => null);
    if (!code || code === "0x") codeless.push([key, want]);
  }
  if (codeless.length) {
    output.write("\n");
    for (const [key, want] of codeless)
      output.write(`  !! ${pad(key)} ${want}   HAS NO CODE on ${netName}\n`);
    if (!args.includes("--allow-codeless"))
      die(`refusing: ${codeless.length} target address(es) have no contract on ${netName}. `
        + `Check for a typo, or pass --allow-codeless if you really mean to point at a future deployment.`);
    output.write("  (--allow-codeless: proceeding anyway)\n");
  }

  await checkProverPair({ ...live, ...desired }, pub, output);

  if (!ASSUME_YES) {
    if (!input.isTTY) die("not a terminal — pass --yes to confirm non-interactively");
    const ans = await promptText(`\nSend setMany(${diff.length})${netName === "base" ? " on MAINNET" : ""}? [y/N]: `);
    if (!/^y(es)?$/i.test(ans)) { output.write("aborted, nothing sent.\n"); return; }
  }

  let pk0 = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk0) {
    if (ASSUME_YES || !input.isTTY) die("DEPLOYER_PRIVATE_KEY is required");
    pk0 = await promptSecret("Owner (deployer) private key (input hidden, paste and press Enter): ");
  }
  if (!pk0) die("no private key provided");
  const account = privateKeyToAccount(pk0.startsWith("0x") ? pk0 : "0x" + pk0);
  if (account.address.toLowerCase() !== owner.toLowerCase())
    die(`that key is ${account.address}, but the book's owner is ${owner}`);
  const wallet = createWalletClient({ account, chain: net.chain, transport: http(rpc) });

  const h = await wallet.writeContract({ address: book, abi, functionName: "setMany",
    args: [diff.map(([k]) => stringToHex(k, { size: 32 })), diff.map(([, v]) => v)],
    // Explicit gas: don't trust a load-balanced RPC's estimate (a lagging
    // backend once estimated the seed as a codeless call — out-of-gas revert).
    gas: 100_000n + 80_000n * BigInt(diff.length) });
  const r = await pub.waitForTransactionReceipt({ hash: h });
  output.write(`  setMany ${r.status} ${net.explorer}/tx/${h}\n`);
  if (r.status !== "success") die(`setMany REVERTED — the book is unchanged: ${net.explorer}/tx/${h}`);
  output.write("  enclaves/site/relays follow within one poll (≤5 min); no redeploys needed.\n");
}

main().catch((e) => die(e.shortMessage || e.message || String(e)));
