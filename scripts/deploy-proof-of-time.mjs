#!/usr/bin/env node
// deploy-proof-of-time.mjs - compile + deploy contracts/EnclaveProofOfTime.sol,
// then BIND it into the ledger with setProver(). That binding is ONE-SHOT and
// permanent, which is the whole reason this script exists as its own step:
// getting it wrong is not fixable, so the plan is printed and confirmed before
// anything is broadcast.
//
// WHY A SECOND CONTRACT AT ALL. EnclaveDeployments is ~90 bytes under the
// EIP-170 24,576-byte limit. Proof-of-time verification (EIP-712 + ecrecover +
// the block-anchor and window rules) does not fit there, so the ledger keeps
// only what touches money - the provenUntil watermark, the meter clamp, and the
// prover-gated creditProven() - and the protocol lives here. See the header of
// either .sol for the trust analysis; the short version is that a prover can
// advance a watermark and nothing else, and every clamp that moves money is
// re-applied in the ledger.
//
// ORDER MATTERS:
//   1. the ledger must already be deployed (this takes its address immutably);
//   2. deploy this;
//   3. setProver(prover) on the ledger - once, forever;
//   4. publish the address in EnclaveAddressBook under `proofOfTime` so RUNNING
//      enclaves pick it up without a release (scripts/update-address-book.mjs);
//   5. hosts republish their in-CVM proof keys automatically on the next
//      heartbeat (registry schema 3, setProofKey) - no operator action.
// Until step 4 lands, enclaves log "rev-9 ledger but NO prover address" and
// cannot prove: harmless during the ledger's 14-day grace window, and a total
// income stop after it. Do not leave the gap open across the cutover.
//
// THE ADMIN CONSOLE DOES 2-4 AS ONE FLOW: site/admin.html → "Proof of time" →
// "Deploy + bind + publish" (site/components/admin-console/provermig.js) plans
// from live chain state, reuses a prover that already fits, binds from the
// governance wallet and publishes the book key, and resumes if interrupted.
// That is the path for the Trezor-held owner key; this script is the CLI/CI
// path for a key you can put in an env var.
//
// Deps (run from repo root):  npm i viem solc
//
// Usage:
//   DEPLOYER_PRIVATE_KEY=0x... node scripts/deploy-proof-of-time.mjs                # Base SEPOLIA (default)
//   NETWORK=base DEPLOYER_PRIVATE_KEY=0x... node scripts/deploy-proof-of-time.mjs   # Base MAINNET
//
// Env:
//   DEPLOYER_PRIVATE_KEY  required. Pays gas, and becomes this contract's owner
//                         (its ONLY power is setProofWindow). Must ALSO be the
//                         ledger's owner for --bind to work.
//   DEPLOYMENTS_ADDRESS   the rev-9 ledger. Read from the address book when
//                         ADDRESS_BOOK_ADDRESS is set, else required here.
//   REGISTRY_ADDRESS      the schema-3 registry (proof keys are read from it).
//   ADDRESS_BOOK_ADDRESS  optional; resolves the two above.
//   NETWORK               base-sepolia (default) | base
//   RPC_URL               override the chain RPC.
// Flags:
//   --bind                also send setProver() (default: deploy + print the
//                         call to make, so the binding can be a separate,
//                         deliberate transaction from the admin console)
//   --yes                 skip the interactive confirmation (CI)
//   --dry-run             compile + show the plan, do NOT broadcast

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import solc from "solc";
import { createWalletClient, createPublicClient, http, formatEther, getAddress,
         encodeFunctionData, encodeDeployData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const CONTRACT = path.join(REPO, "contracts", "EnclaveProofOfTime.sol");
const ABI_OUT = path.join(REPO, "contracts", "EnclaveProofOfTime.abi.json");

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const ASSUME_YES = args.has("--yes");
const BIND = args.has("--bind");

const NETWORKS = {
  "base-sepolia": { chain: baseSepolia, rpc: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org" },
  "base":         { chain: base,        rpc: "https://mainnet.base.org",  explorer: "https://basescan.org" },
};

function die(msg) { console.error(`\nERROR: ${msg}\n`); process.exit(1); }

const NET = process.env.NETWORK || "base-sepolia";
if (!NETWORKS[NET]) die(`unknown NETWORK "${NET}" (base-sepolia | base)`);
const { chain, rpc, explorer } = NETWORKS[NET];
const RPC = process.env.RPC_URL || rpc;

const PK = process.env.DEPLOYER_PRIVATE_KEY || "";
if (!DRY_RUN && !/^0x[0-9a-fA-F]{64}$/.test(PK)) die("DEPLOYER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key");

// ---- compile (mirrors scripts/build-contract-artifacts.mjs exactly) --------
console.log(`\nCompiling ${path.relative(REPO, CONTRACT)} ...`);
const source = fs.readFileSync(CONTRACT, "utf8");
const out = JSON.parse(solc.compile(JSON.stringify({
  language: "Solidity",
  sources: { "EnclaveProofOfTime.sol": { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    // viaIR, exactly as build-contract-artifacts.mjs does it: since the clock
    // charge landed, emitting Checkpointed's 6 args overflows legacy codegen's
    // stack, and the two paths' bytecode must stay identical either way.
    viaIR: true,
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
})));
const errs = (out.errors || []).filter((e) => e.severity === "error");
if (errs.length) die("solc:\n" + errs.map((e) => e.formattedMessage).join("\n"));
const c = out.contracts["EnclaveProofOfTime.sol"].EnclaveProofOfTime;
const abi = c.abi;
const bytecode = "0x" + c.evm.bytecode.object;
console.log(`  bytecode ${(bytecode.length / 2 - 1).toLocaleString()} bytes · ${abi.filter(f => f.type === "function").length} fns`);

const pub = createPublicClient({ chain, transport: http(RPC) });

// ---- resolve the pair this prover binds to --------------------------------
const BOOK = (process.env.ADDRESS_BOOK_ADDRESS || "").trim();
// EnclaveAddressBook's lookup is addr(bytes32), not get() — every other script
// in this directory uses that name, and this one didn't, so ADDRESS_BOOK_ADDRESS
// resolution failed with a raw viem revert before it could reach any of the
// checks below.
const BOOK_ABI = [{ type: "function", name: "addr", stateMutability: "view",
  inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }] }];
const keyOf = (s) => "0x" + Buffer.from(s, "ascii").toString("hex").padEnd(64, "0");

async function resolve(name, envName, bookKey) {
  const fromEnv = (process.env[envName] || "").trim();
  if (fromEnv) return getAddress(fromEnv);
  if (!BOOK) die(`${envName} is required (or set ADDRESS_BOOK_ADDRESS so ${name} resolves from the book)`);
  const a = await pub.readContract({ address: getAddress(BOOK), abi: BOOK_ABI, functionName: "addr", args: [keyOf(bookKey)] })
    .catch((e) => die(`could not read \`${bookKey}\` from the address book at ${BOOK}: ${e.shortMessage || e.message}`));
  if (/^0x0{40}$/i.test(a)) die(`the address book has no \`${bookKey}\` entry; set ${envName} explicitly`);
  return getAddress(a);
}
const DEPLOYMENTS = await resolve("the ledger", "DEPLOYMENTS_ADDRESS", "deployments");
const REGISTRY = await resolve("the registry", "REGISTRY_ADDRESS", "registry");

// ---- refuse to bind to a pair that cannot work ----------------------------
const LEDGER_ABI = [
  { type: "function", name: "deploymentsSchema", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "leaseSec", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "prover", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "proofRequiredFrom", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "setProver", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [] },
];
const REG_ABI = [{ type: "function", name: "registrySchema", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }];

const [schema, leaseSec, ledgerOwner, boundProver, requiredFrom] = await Promise.all([
  pub.readContract({ address: DEPLOYMENTS, abi: LEDGER_ABI, functionName: "deploymentsSchema" }),
  pub.readContract({ address: DEPLOYMENTS, abi: LEDGER_ABI, functionName: "leaseSec" }),
  pub.readContract({ address: DEPLOYMENTS, abi: LEDGER_ABI, functionName: "owner" }),
  pub.readContract({ address: DEPLOYMENTS, abi: LEDGER_ABI, functionName: "prover" }),
  pub.readContract({ address: DEPLOYMENTS, abi: LEDGER_ABI, functionName: "proofRequiredFrom" }),
]).catch((e) => die(`could not read the ledger at ${DEPLOYMENTS}: ${e.shortMessage || e.message}`));
const regSchema = await pub.readContract({ address: REGISTRY, abi: REG_ABI, functionName: "registrySchema" })
  .catch(() => 1n);

if (Number(schema) < 9) die(`the ledger at ${DEPLOYMENTS} is schema rev ${schema}; proof of time needs rev 9. `
  + `Deploy the rev-9 EnclaveDeployments first (scripts/deploy-deployments.mjs).`);
if (Number(regSchema) < 3) die(`the registry at ${REGISTRY} is schema ${regSchema}; proof of time needs schema 3 `
  + `(it reads each enclave's proofKey). Deploy the schema-3 EnclaveRegistry first — the two go together.`);
// This contract holds the registry AND the ledger as immutables, so it is
// redeployed whenever either moves — which is why a registry bump never
// strands it, and why the pair below must be the pair that is going live.
if (Number(regSchema) > 3) console.log(`  (registry is schema ${regSchema}; proof of time reads only proofKey, which is schema 3 and never moves)`);
if (!/^0x0{40}$/i.test(boundProver)) die(`the ledger already has a prover bound: ${boundProver}. `
  + `setProver is ONE-SHOT and cannot be changed — a new prover needs a new ledger.`);

const cutover = Number(requiredFrom) ? new Date(Number(requiredFrom) * 1000).toISOString() : "never (metering stays on held time)";

console.log(`\n  network         ${NET} (${chain.id})`);
console.log(`  ledger          ${DEPLOYMENTS}  (schema ${schema}, leaseSec ${leaseSec})`);
console.log(`  registry        ${REGISTRY}  (schema ${regSchema})`);
console.log(`  proof cutover   ${cutover}`);
console.log(`  ledger owner    ${ledgerOwner}`);
if (!DRY_RUN) {
  const account = privateKeyToAccount(PK);
  const bal = await pub.getBalance({ address: account.address });
  console.log(`  deployer        ${account.address}  (${formatEther(bal)} ETH)`);
  if (BIND && getAddress(ledgerOwner) !== getAddress(account.address))
    die(`--bind needs the LEDGER's owner (${ledgerOwner}), but the deployer is ${account.address}. `
      + `Deploy without --bind and send setProver from the owner wallet (site/admin.html can do it).`);
}
console.log(`\n  This deploys EnclaveProofOfTime and ${BIND ? "BINDS it into the ledger (ONE-SHOT, PERMANENT)" : "prints the setProver call to send separately"}.`);

if (DRY_RUN) {
  console.log(`\n[dry-run] deploy data: ${encodeDeployData({ abi, bytecode, args: [DEPLOYMENTS, REGISTRY] }).slice(0, 74)}…`);
  console.log("[dry-run] nothing broadcast.\n");
  process.exit(0);
}
if (!ASSUME_YES) {
  const rl = readline.createInterface({ input, output });
  const a = await rl.question(`\nProceed on ${NET}? type "yes": `);
  rl.close();
  if (a.trim() !== "yes") die("aborted");
}

const account = privateKeyToAccount(PK);
const wallet = createWalletClient({ account, chain, transport: http(RPC) });

console.log("\nDeploying ...");
const hash = await wallet.deployContract({ abi, bytecode, args: [DEPLOYMENTS, REGISTRY] });
console.log(`  tx ${hash}`);
const rcpt = await pub.waitForTransactionReceipt({ hash });
if (rcpt.status !== "success") die(`deploy reverted (${explorer}/tx/${hash})`);
const PROVER = getAddress(rcpt.contractAddress);
console.log(`  EnclaveProofOfTime ${PROVER}`);
console.log(`  ${explorer}/address/${PROVER}`);

fs.writeFileSync(ABI_OUT, JSON.stringify(abi, null, 2) + "\n");
console.log(`  wrote ${path.relative(REPO, ABI_OUT)}`);

if (BIND) {
  console.log("\nBinding into the ledger (setProver — one-shot) ...");
  const bh = await wallet.writeContract({ address: DEPLOYMENTS, abi: LEDGER_ABI, functionName: "setProver", args: [PROVER] });
  console.log(`  tx ${bh}`);
  const br = await pub.waitForTransactionReceipt({ hash: bh });
  if (br.status !== "success") die(`setProver reverted (${explorer}/tx/${bh}) — the prover is deployed but NOT bound`);
  console.log("  bound. The ledger will accept watermark advances from this contract only, forever.");
}

console.log(`\nNEXT:`);
if (!BIND) {
  console.log(`  1. bind it (ONE-SHOT, from the ledger owner ${ledgerOwner}):`);
  console.log(`     EnclaveDeployments.setProver(${PROVER})`);
  console.log(`     calldata: ${encodeFunctionData({ abi: LEDGER_ABI, functionName: "setProver", args: [PROVER] })}`);
}
console.log(`  ${BIND ? 1 : 2}. publish it so RUNNING enclaves find it without a release:`);
console.log(`     PROOF_OF_TIME_ADDRESS=${PROVER} node scripts/update-address-book.mjs --set proofOfTime=${PROVER}`);
console.log(`  ${BIND ? 2 : 3}. node scripts/build-contract-artifacts.mjs   (refresh the checked-in ABI + admin console)`);
console.log(`  ${BIND ? 3 : 4}. watch a host's /v1/health .proofOfTime — ready:true and a moving lastRoundAt`);
console.log(`     means it is earning; the cutover is ${cutover}\n`);
