#!/usr/bin/env node
// Deploy the sessions contracts: SessionVaultLib (linked library), then
// SessionVaultFactory (which deploys the SessionVault implementation in its
// constructor). Ownerless and immutable - the deployer keeps no power over
// anything it deploys here. Design: docs/design/sessions.md.
//
//   NETWORK=base-sepolia DEPLOYER_PRIVATE_KEY=0x... node scripts/deploy-session-vault.mjs
//   NETWORK=base         DEPLOYER_PRIVATE_KEY=0x... node scripts/deploy-session-vault.mjs --max-vault 250
//   NETWORK=local RPC_URL=http://127.0.0.1:8545 USDC=0x.. BOOK=0x.. ROUTER=0x.. node scripts/deploy-session-vault.mjs --yes
//
// Flags:
//   --dry-run            compile + print the plan, send nothing
//   --yes                no confirmation prompt
//   --max-vault <usd>    beta cap: no deposit may lift one vault above this (default 250)
//   --key-attestations <addr>   EnclaveKeyAttestations (default: none -> measurement-bound grants refused)
// Env overrides: RPC_URL, USDC, BOOK, ROUTER, KEY_ATTESTATIONS, MAX_VAULT_USD.
//
// Pointing the book's "sessionVaultFactory" key at the result is a governance
// transaction (the book owner), printed at the end - not done here.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import solc from "solc";
import { linkBytecode } from "../site/js/lib/contract-linker.js";
import {
  createPublicClient, createWalletClient, http, getAddress, isAddress, formatEther, parseUnits, encodeDeployData,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia, foundry } from "viem/chains";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SOURCE = path.join(REPO, "contracts", "SessionVault.sol");
const OUT_DIR = path.join(REPO, "contracts", "deployments");

export const NETWORKS = {
  "base-sepolia": { chain: baseSepolia, rpc: "https://sepolia.base.org",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", explorer: "https://sepolia.basescan.org" },
  base: { chain: base, rpc: "https://mainnet.base.org",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    book: "0xab214342d5A490150A4A977063A2f88E21F80907",
    router: "0xf17157b42ebbd65E33dD592878A8f1769C69d56A", explorer: "https://basescan.org" },
  local: { chain: foundry, rpc: "http://127.0.0.1:8545" },
};
const ZERO = "0x0000000000000000000000000000000000000000";

function die(msg) { const e = new Error(msg); e.fatal = true; throw e; }

/** solc-js with the settings foundry.toml pins for this file (viaIR, runs = 1). */
export function compileSessionVault() {
  const inputJson = {
    language: "Solidity",
    sources: { "SessionVault.sol": { content: fs.readFileSync(SOURCE, "utf8") } },
    settings: {
      optimizer: { enabled: true, runs: 1 },
      viaIR: true,
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.bytecode.linkReferences",
        "evm.deployedBytecode.object", "evm.deployedBytecode.linkReferences"] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(inputJson)));
  const errs = (out.errors || []).filter((e) => e.severity === "error");
  if (errs.length) die("solc:\n" + errs.map((e) => e.formattedMessage).join("\n"));
  const c = (n) => out.contracts["SessionVault.sol"][n];
  for (const n of ["SessionVault", "SessionVaultFactory", "SessionVaultLib"]) {
    const size = c(n).evm.deployedBytecode.object.length / 2;
    if (size > 24576) die(`${n} is ${size} bytes, over EIP-170`);
  }
  return {
    vault: { abi: c("SessionVault").abi, size: c("SessionVault").evm.deployedBytecode.object.length / 2 },
    factory: { abi: c("SessionVaultFactory").abi, bytecode: "0x" + c("SessionVaultFactory").evm.bytecode.object,
      linkReferences: c("SessionVaultFactory").evm.bytecode.linkReferences },
    lib: { abi: c("SessionVaultLib").abi, bytecode: "0x" + c("SessionVaultLib").evm.bytecode.object },
  };
}

/** Deploy and verify. Returns the addresses; throws on any mismatch. */
export async function deploySessionVault({ rpc, chain, privateKey, usdc, book, router, keyAttestations = ZERO,
  maxVault6, log = console.log, dryRun = false, confirm = async () => true }) {
  const art = compileSessionVault();
  const account = privateKeyToAccount(privateKey);
  const pc = createPublicClient({ chain, transport: http(rpc) });
  const wc = createWalletClient({ chain, account, transport: http(rpc) });
  const chainId = await pc.getChainId();
  if (chainId !== chain.id) die(`RPC is chain ${chainId}, expected ${chain.id}`);
  for (const [k, v] of Object.entries({ usdc, book, router })) {
    if (!isAddress(v || "")) die(`${k} address missing/invalid`);
    if ((await pc.getCode({ address: v }))?.length <= 2) die(`${k} ${v} has no code on chain ${chainId}`);
  }
  const bal = await pc.getBalance({ address: account.address });
  log(`deployer  ${account.address}  (${formatEther(bal)} ETH)`);
  log(`chain     ${chainId}`);
  log(`usdc      ${usdc}\nbook      ${book}\nrouter    ${router}\nkeyAtt    ${keyAttestations}`);
  log(`cap       ${Number(maxVault6) / 1e6} USDC per vault`);
  log(`sizes     SessionVault ${art.vault.size} B (EIP-170 24576)`);
  if (dryRun) return { dryRun: true };
  if (!(await confirm())) die("aborted");

  const send = async (label, data) => {
    const hash = await wc.sendTransaction({ data, to: null });
    log(`  ${label}: ${hash}`);
    const rc = await pc.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (rc.status !== "success" || !rc.contractAddress) die(`${label} failed (${hash})`);
    return { address: getAddress(rc.contractAddress), hash, block: rc.blockNumber };
  };

  const lib = await send("SessionVaultLib", art.lib.bytecode);
  const linked = linkBytecode(art.factory.bytecode, art.factory.linkReferences,
    { "SessionVault.sol:SessionVaultLib": lib.address });
  const factoryData = encodeDeployData({ abi: art.factory.abi, bytecode: linked,
    args: [usdc, book, router, keyAttestations, maxVault6] });
  const factory = await send("SessionVaultFactory", factoryData);

  // verify what landed against what was asked for
  const impl = await pc.readContract({ address: factory.address, abi: art.factory.abi, functionName: "implementation" });
  const r = (fn) => pc.readContract({ address: impl, abi: art.vault.abi, functionName: fn });
  const got = { usdc: await r("usdc"), book: await r("book"), router: await r("router"),
    keyAttestations: await r("keyAttestations"), maxVault6: await r("maxVault6"), factory: await r("factory"),
    owner: await r("owner") };
  const want = { usdc: getAddress(usdc), book: getAddress(book), router: getAddress(router),
    keyAttestations: getAddress(keyAttestations), maxVault6: BigInt(maxVault6), factory: factory.address,
    owner: "0x0000000000000000000000000000000000000001" };
  for (const k of Object.keys(want))
    if (String(got[k]).toLowerCase() !== String(want[k]).toLowerCase()) die(`implementation.${k} = ${got[k]}, expected ${want[k]}`);
  const implCode = await pc.getCode({ address: impl });
  log(`verified  implementation ${impl} (${(implCode.length - 2) / 2} B), immutables match`);
  return { chainId, lib: lib.address, factory: factory.address, implementation: impl,
    tx: { lib: lib.hash, factory: factory.hash }, block: Number(factory.block) };
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(n);
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const network = process.env.NETWORK || "base-sepolia";
  const net = NETWORKS[network] || die(`unknown NETWORK ${network} (base, base-sepolia, local)`);
  const rpc = process.env.RPC_URL || net.rpc;
  const usdc = process.env.USDC || net.usdc;
  const book = process.env.BOOK || net.book;
  const router = process.env.ROUTER || net.router;
  const keyAttestations = opt("--key-attestations") || process.env.KEY_ATTESTATIONS || ZERO;
  const maxUsd = opt("--max-vault") || process.env.MAX_VAULT_USD || "250";
  const maxVault6 = parseUnits(String(maxUsd), 6);
  let pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk && !flag("--dry-run")) {
    const rl = readline.createInterface({ input, output });
    pk = (await rl.question("DEPLOYER_PRIVATE_KEY: ")).trim();
    rl.close();
  }
  if (flag("--dry-run") && !pk) pk = "0x" + "11".repeat(32);
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk || "")) die("DEPLOYER_PRIVATE_KEY must be 0x + 64 hex");
  const res = await deploySessionVault({
    rpc, chain: net.chain, privateKey: pk, usdc, book, router, keyAttestations, maxVault6,
    dryRun: flag("--dry-run"),
    confirm: async () => {
      if (flag("--yes")) return true;
      const rl = readline.createInterface({ input, output });
      const a = (await rl.question(`Deploy to ${network}? [y/N] `)).trim().toLowerCase();
      rl.close();
      return a === "y" || a === "yes";
    },
  });
  if (res.dryRun) return;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `sessions-${network}.json`);
  const record = { network, ...res, usdc, book, router, keyAttestations, maxVault6: maxVault6.toString(),
    deployedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
  console.log(`\nwrote ${path.relative(REPO, file)}`);
  console.log(`\nNext (governance, the book owner): EnclaveAddressBook(${book}).set("sessionVaultFactory", ${res.factory})`);
  if (net.explorer) console.log(`${net.explorer}/address/${res.factory}`);
}

if (import.meta.url === url.pathToFileURL(process.argv[1] || "").href) {
  main().catch((e) => { console.error(`\nERROR: ${e.message}\n`); process.exit(1); });
}
