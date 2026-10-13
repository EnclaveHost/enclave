#!/usr/bin/env node
// scripts/deploy-host-paymaster.mjs -- deploy EnclaveHostPaymaster (contracts/EnclaveHostPaymaster.sol): the ERC-4337
// paymaster that pays a new host's first register(), once per piece of hardware, on the relay's voucher.
//
//   VERIFIER=0x...                 the relay's voucher key's ADDRESS (HOST_SPONSOR_VERIFIER_KEY on the relay box)
//   DEPLOYER_PRIVATE_KEY=0x...     pays the deploy (and the deposit); becomes the owner until --owner accepts
//   NETWORK=base | base-sepolia    (default base-sepolia)
//   REGISTRY=0x...                 default: the live EnclaveRegistry on Base
//   MAX_COST_WEI=...               per-operation cap (default 1e14 = 0.0001 ETH; a register() costs ~2.3e12 at 0.01 gwei)
//   --deposit=<eth>                fund the EntryPoint deposit right after (anyone may add more later: deposit())
//   --owner=0x...                  start the two-step hand-over to this owner (it accepts with acceptOwnership())
//   PAYMASTER=0x...                resume against one already deployed: skip the deploy, do the deposit / --owner
//   --dry-run                      compile and print; send nothing
//   --yes                          skip the confirmation
// Compiles with solc-js exactly as the foundry tests do (0.8.35, optimizer 200, viaIR). Writes the ABI and a
// deployment record under contracts/.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import solc from "solc";
import { createWalletClient, createPublicClient, http, formatEther, parseEther, getAddress, isAddress, encodeDeployData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const CONTRACT = path.join(REPO, "contracts", "EnclaveHostPaymaster.sol");
const ABI_OUT = path.join(REPO, "contracts", "EnclaveHostPaymaster.abi.json");
const ENTRYPOINT_08 = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
const LIVE_REGISTRY = "0x868eB7fc5B5A84B2FF082eafc9bf40b7AAc5CCAC";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n) => { const a = argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : ""; };
const DRY_RUN = flag("dry-run"), ASSUME_YES = flag("yes");
function die(msg) { console.error(`\nERROR: ${msg}\n`); process.exit(1); }

const NETWORKS = {
  "base-sepolia": { chain: baseSepolia, rpc: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org" },
  "base":         { chain: base,        rpc: "https://mainnet.base.org",  explorer: "https://basescan.org" },
};
const NET = process.env.NETWORK || "base-sepolia";
if (!NETWORKS[NET]) die(`unknown NETWORK "${NET}" (base-sepolia | base)`);
const { chain, rpc, explorer } = NETWORKS[NET];
const RPC = process.env.RPC_URL || rpc;

const VERIFIER = (process.env.VERIFIER || "").trim();
if (!isAddress(VERIFIER)) die("VERIFIER must be the relay voucher key's address");
const REGISTRY = getAddress((process.env.REGISTRY || LIVE_REGISTRY).trim());
const MAX_COST = BigInt(process.env.MAX_COST_WEI || "100000000000000");
const DEPOSIT = opt("deposit") ? parseEther(opt("deposit")) : 0n;
const OWNER = opt("owner");
if (OWNER && !isAddress(OWNER)) die("--owner must be an address");
const PK = process.env.DEPLOYER_PRIVATE_KEY || "";
if (!DRY_RUN && !/^0x[0-9a-fA-F]{64}$/.test(PK)) die("DEPLOYER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key");

console.log(`\nCompiling ${path.relative(REPO, CONTRACT)} ...`);
const out = JSON.parse(solc.compile(JSON.stringify({
  language: "Solidity",
  sources: { "EnclaveHostPaymaster.sol": { content: fs.readFileSync(CONTRACT, "utf8") } },
  settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true,
              outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
})));
const errs = (out.errors || []).filter((e) => e.severity === "error");
if (errs.length) die("solc:\n" + errs.map((e) => e.formattedMessage).join("\n"));
const c = out.contracts["EnclaveHostPaymaster.sol"].EnclaveHostPaymaster;
const abi = c.abi, bytecode = "0x" + c.evm.bytecode.object;
console.log(`  bytecode ${(bytecode.length / 2 - 1).toLocaleString()} bytes`);

const pub = createPublicClient({ chain, transport: http(RPC) });
for (const [n, a] of [["EntryPoint v0.8", ENTRYPOINT_08], ["EnclaveRegistry", REGISTRY]])
  if ((await pub.getCode({ address: a })) === undefined) die(`${n} ${a} has no code on ${NET}`);
const args = [ENTRYPOINT_08, REGISTRY, getAddress(VERIFIER), MAX_COST];
console.log(`\n  network    ${NET}\n  entryPoint ${ENTRYPOINT_08}\n  registry   ${REGISTRY}\n  verifier   ${getAddress(VERIFIER)}`
          + `\n  maxCost    ${formatEther(MAX_COST)} ETH per operation\n  deposit    ${formatEther(DEPOSIT)} ETH\n  owner      ${OWNER || "(the deployer)"}`);
if (DRY_RUN) {
  console.log(`\n[dry-run] deploy data: ${encodeDeployData({ abi, bytecode, args }).slice(0, 74)}…\n[dry-run] nothing broadcast.\n`);
  process.exit(0);
}
const account = privateKeyToAccount(PK);
const bal = await pub.getBalance({ address: account.address });
console.log(`  deployer   ${account.address} (${formatEther(bal)} ETH)`);
if (bal <= DEPOSIT) die("the deployer cannot cover the deposit and the gas");
if (!ASSUME_YES) {
  const rl = readline.createInterface({ input, output });
  const a = await rl.question(`\nDeploy on ${NET}? type "yes": `);
  rl.close();
  if (a.trim() !== "yes") die("aborted");
}
const wallet = createWalletClient({ account, chain, transport: http(RPC) });
const send = async (what, p) => {
  const hash = await p; console.log(`  ${what}: tx ${hash}`);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") die(`${what} reverted (${explorer}/tx/${hash})`);
  return r;
};
const recFile = path.join(REPO, "contracts", "deployments", `host-paymaster-${NET}.json`);
let PM, record;
if (process.env.PAYMASTER) {
  PM = getAddress(process.env.PAYMASTER.trim());
  record = fs.existsSync(recFile) ? JSON.parse(fs.readFileSync(recFile, "utf8")) : { network: NET, address: PM };
  console.log(`  resuming against EnclaveHostPaymaster ${PM}`);
} else {
  const rcpt = await send("deploy", wallet.deployContract({ abi, bytecode, args }));
  PM = getAddress(rcpt.contractAddress);
  console.log(`  EnclaveHostPaymaster ${PM}\n  ${explorer}/address/${PM}`);
  record = { network: NET, address: PM, deployTx: rcpt.transactionHash, block: Number(rcpt.blockNumber), entryPoint: ENTRYPOINT_08,
             registry: REGISTRY, verifier: getAddress(VERIFIER), maxCostPerOpWei: String(MAX_COST), deployer: account.address };
}
// A public RPC can answer a receipt before it serves the new code: a gas estimate then prices a call to an empty
// account (21k) and the call reverts out of gas (it did, 2026-10-11). Wait for the code, and never estimate these.
for (let i = 0; ; i++) {
  if ((await pub.getCode({ address: PM })) !== undefined) break;
  if (i > 30) die(`${PM} still shows no code on ${RPC}`);
  await new Promise((r) => setTimeout(r, 2000));
}
if (DEPOSIT > 0n) {
  const r = await send("deposit", wallet.writeContract({ address: PM, abi, functionName: "deposit", value: DEPOSIT, gas: 150_000n }));
  record.depositTx = r.transactionHash; record.depositWei = String(DEPOSIT);
}
if (OWNER) {
  const r = await send("transferOwnership", wallet.writeContract({ address: PM, abi, functionName: "transferOwnership", args: [getAddress(OWNER)], gas: 100_000n }));
  record.pendingOwner = getAddress(OWNER); record.transferTx = r.transactionHash;
}
fs.writeFileSync(ABI_OUT, JSON.stringify(abi, null, 2) + "\n");
fs.mkdirSync(path.dirname(recFile), { recursive: true });
fs.writeFileSync(recFile, JSON.stringify(record, null, 1) + "\n");
console.log(`  wrote ${path.relative(REPO, ABI_OUT)} and ${path.relative(REPO, recFile)}`);
console.log(`\nNEXT: set HOST_PAYMASTER=${PM} on the relay (beside HOST_SPONSOR_VERIFIER_KEY / HOST_SPONSOR_BUNDLER_KEY)`
          + (OWNER ? `; ${OWNER} accepts ownership with acceptOwnership()` : "") + "\n");
