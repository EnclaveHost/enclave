#!/usr/bin/env node
// Deploy EnclaveKeyAttestations: the registry of which enclave image each
// attested session key was generated in (docs/design/sessions.md §10, phase g).
// A SessionVaultFactory pins it as an immutable (deploy-session-vault.mjs
// --key-attestations <addr>), so this goes first.
//
//   NETWORK=base-sepolia DEPLOYER_PRIVATE_KEY=0x... [OWNER=0x..] [ATTESTOR=0x..] node scripts/deploy-key-attestations.mjs
//   NETWORK=base         DEPLOYER_PRIVATE_KEY=0x... OWNER=0x<governance> ATTESTOR=0x<relay attestor> node scripts/deploy-key-attestations.mjs
//   NETWORK=local RPC_URL=http://127.0.0.1:8545 OWNER=0x.. node scripts/deploy-key-attestations.mjs --yes
//
// Flags:
//   --dry-run            compile + print the plan, send nothing
//   --yes                no confirmation prompt
// Env:
//   OWNER        governance: names/removes attestors, revokes bindings. REQUIRED on base; elsewhere the
//                deployer by default. Ownership moves only in two steps (transferOwnership + acceptOwnership).
//   ATTESTOR     optional initial attestor (the relay key that submits attest()), set by the constructor in
//                the same transaction. More are named later by the owner (setAttestor).
//   RPC_URL      override the network's public RPC.
//
// Compiled with solc-js, optimizer runs 200, legacy codegen (no viaIR: nothing here needs it). The Foundry
// suite compiles the same source with via_ir (foundry.toml's global setting); the node test
// (test/sessions-attest.test.mjs) runs THIS script's bytecode against a real SessionVaultFactory.
//
// Pointing the book's "keyAttestations" key at the result is a governance transaction (the book owner),
// printed at the end - not done here.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import solc from "solc";
import { createPublicClient, createWalletClient, http, getAddress, isAddress, formatEther, encodeDeployData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia, foundry } from "viem/chains";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SOURCE = path.join(REPO, "contracts", "EnclaveKeyAttestations.sol");
const OUT_DIR = path.join(REPO, "contracts", "deployments");

export const NETWORKS = {
  "base-sepolia": { chain: baseSepolia, rpc: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org" },
  base: { chain: base, rpc: "https://mainnet.base.org", explorer: "https://basescan.org", ownerRequired: true },
  local: { chain: foundry, rpc: "http://127.0.0.1:8545" },
};
const ZERO = "0x0000000000000000000000000000000000000000";

function die(msg) { const e = new Error(msg); e.fatal = true; throw e; }

/** solc-js, optimizer runs 200, legacy codegen. */
export function compileKeyAttestations() {
  const inputJson = {
    language: "Solidity",
    sources: { "EnclaveKeyAttestations.sol": { content: fs.readFileSync(SOURCE, "utf8") } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(inputJson)));
  const errs = (out.errors || []).filter((e) => e.severity === "error");
  if (errs.length) die("solc:\n" + errs.map((e) => e.formattedMessage).join("\n"));
  const c = out.contracts["EnclaveKeyAttestations.sol"].EnclaveKeyAttestations;
  const size = c.evm.deployedBytecode.object.length / 2;
  if (size > 24576) die(`EnclaveKeyAttestations is ${size} bytes, over EIP-170`);
  return { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object, deployedBytecode: "0x" + c.evm.deployedBytecode.object, size };
}

/** Deploy and verify. Returns the address; throws on any mismatch. */
export async function deployKeyAttestations({ rpc, chain, privateKey, owner, attestor = ZERO, log = console.log,
  dryRun = false, confirm = async () => true }) {
  const art = compileKeyAttestations();
  const account = privateKeyToAccount(privateKey);
  const pc = createPublicClient({ chain, transport: http(rpc) });
  const wc = createWalletClient({ chain, account, transport: http(rpc) });
  const chainId = await pc.getChainId();
  if (chainId !== chain.id) die(`RPC is chain ${chainId}, expected ${chain.id}`);
  if (!isAddress(owner || "") || getAddress(owner) === ZERO) die("owner address missing/invalid");
  if (!isAddress(attestor || "")) die("attestor address invalid");
  owner = getAddress(owner);
  attestor = getAddress(attestor);
  const bal = await pc.getBalance({ address: account.address });
  log(`deployer  ${account.address}  (${formatEther(bal)} ETH)`);
  log(`chain     ${chainId}`);
  log(`owner     ${owner}${owner === account.address ? " (the deployer)" : ""}`);
  log(`attestor  ${attestor === ZERO ? "none (the owner names one later: setAttestor)" : attestor}`);
  log(`size      EnclaveKeyAttestations ${art.size} B (EIP-170 24576)`);
  if (dryRun) return { dryRun: true };
  if (!(await confirm())) die("aborted");

  const hash = await wc.sendTransaction({ data: encodeDeployData({ abi: art.abi, bytecode: art.bytecode, args: [owner, attestor] }), to: null });
  log(`  EnclaveKeyAttestations: ${hash}`);
  const rc = await pc.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (rc.status !== "success" || !rc.contractAddress) die(`EnclaveKeyAttestations failed (${hash})`);
  const address = getAddress(rc.contractAddress);

  // verify what landed against what was asked for: the exact runtime code (no immutables), and the state
  const code = await pc.getCode({ address });
  if (String(code).toLowerCase() !== art.deployedBytecode.toLowerCase()) die(`code at ${address} is not the compiled runtime`);
  const r = (functionName, args = []) => pc.readContract({ address, abi: art.abi, functionName, args });
  const got = { owner: getAddress(await r("owner")), pendingOwner: getAddress(await r("pendingOwner")),
    attestor: attestor === ZERO ? true : await r("isAttestor", [attestor]), zeroIsAttestor: await r("isAttestor", [ZERO]) };
  if (got.owner !== owner) die(`owner() = ${got.owner}, expected ${owner}`);
  if (got.pendingOwner !== ZERO) die(`pendingOwner() = ${got.pendingOwner}, expected none`);
  if (got.attestor !== true) die(`isAttestor(${attestor}) is false`);
  if (got.zeroIsAttestor !== false) die("isAttestor(0) is true");
  log(`verified  ${address} (${(code.length - 2) / 2} B): runtime code, owner and attestor match`);
  return { chainId, address, owner, attestor, tx: hash, block: Number(rc.blockNumber) };
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(n);
  const network = process.env.NETWORK || "base-sepolia";
  const net = NETWORKS[network] || die(`unknown NETWORK ${network} (base, base-sepolia, local)`);
  const rpc = process.env.RPC_URL || net.rpc;
  let pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk && !flag("--dry-run")) {
    const rl = readline.createInterface({ input, output });
    pk = (await rl.question("DEPLOYER_PRIVATE_KEY: ")).trim();
    rl.close();
  }
  if (flag("--dry-run") && !pk) pk = "0x" + "11".repeat(32);
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk || "")) die("DEPLOYER_PRIVATE_KEY must be 0x + 64 hex");
  const ownerEnv = (process.env.OWNER || "").trim();
  if (!ownerEnv && net.ownerRequired) die(`OWNER is required on ${network} (the governance address, never defaulted)`);
  const owner = ownerEnv || privateKeyToAccount(pk).address;
  const attestor = (process.env.ATTESTOR || "").trim() || ZERO;
  const res = await deployKeyAttestations({
    rpc, chain: net.chain, privateKey: pk, owner, attestor,
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
  const file = path.join(OUT_DIR, `key-attestations-${network}.json`);
  const record = { network, ...res, deployedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
  console.log(`\nwrote ${path.relative(REPO, file)}`);
  console.log(`\nNext:`);
  console.log(`  1. SessionVaultFactory with it: NETWORK=${network} node scripts/deploy-session-vault.mjs --key-attestations ${res.address}`);
  console.log(`  2. (governance, the book owner) EnclaveAddressBook.set("keyAttestations", ${res.address})`);
  if (res.attestor === ZERO) console.log(`  3. (the owner, ${res.owner}) setAttestor(<relay attestor>, true)`);
  if (net.explorer) console.log(`${net.explorer}/address/${res.address}`);
}

if (import.meta.url === url.pathToFileURL(process.argv[1] || "").href) {
  main().catch((e) => { console.error(`\nERROR: ${e.message}\n`); process.exit(1); });
}
