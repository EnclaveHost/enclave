#!/usr/bin/env node
// Deploy EnclaveSecretVault (docs/security/secret-custody.md, "Production rollout").
//
//   NETWORK=base  DEPLOYER_PRIVATE_KEY=0x… node scripts/deploy-secret-vault.mjs --dry-run      compile + print the plan
//   NETWORK=base  DEPLOYER_PRIVATE_KEY=0x… node scripts/deploy-secret-vault.mjs                 deploy (asks first)
//   NETWORK=local RPC_URL=http://127.0.0.1:8545 BOOK=0x… DEPLOYER_PRIVATE_KEY=0x… node scripts/deploy-secret-vault.mjs --yes
//
// The vault has NO owner, NO admin and NO proxy: the deployer key holds no power over it after the deployment transaction.
// Its one constructor argument is the address book it resolves the ledger (and the SessionVault factory) through: on Base,
// EnclaveAddressBook 0xab214342d5A490150A4A977063A2f88E21F80907.
//
// NOT done here, printed at the end for governance (the book owner, a Trezor) to sign: book.set("secretVault", <vault>).
// Until that transaction, nothing in the platform (site, CLI, relay) uses the vault unless configured by hand.
//
// Compiled with solc-js 0.8.35, optimizer runs 200, viaIR (the Foundry suite compiles the same source the same way).
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import solc from "solc";
import { createPublicClient, createWalletClient, http, getAddress, isAddress, encodeFunctionData, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia, foundry } from "viem/chains";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SOURCE = path.join(REPO, "contracts", "EnclaveSecretVault.sol");
export const NETWORKS = {
  base: { chain: base, rpc: "https://api.enclave.host/rpc/base", book: "0xab214342d5A490150A4A977063A2f88E21F80907", explorer: "https://basescan.org" },
  "base-sepolia": { chain: baseSepolia, rpc: "https://api.enclave.host/rpc/base-sepolia", book: null, explorer: "https://sepolia.basescan.org" },
  local: { chain: foundry, rpc: "http://127.0.0.1:8545", book: null },
};
const die = (m) => { const e = new Error(m); e.fatal = true; throw e; };

export function compileSecretVault() {
  const out = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity",
    sources: { "EnclaveSecretVault.sol": { content: fs.readFileSync(SOURCE, "utf8") } },
    settings: { viaIR: true, optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } } } })));
  const errs = (out.errors || []).filter((e) => e.severity === "error");
  if (errs.length) die("solc:\n" + errs.map((e) => e.formattedMessage).join("\n"));
  const c = out.contracts["EnclaveSecretVault.sol"].EnclaveSecretVault;
  const size = c.evm.deployedBytecode.object.length / 2;
  if (size > 24576) die(`EnclaveSecretVault is ${size} bytes, over EIP-170`);
  return { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object, size };
}

export async function deploySecretVault({ rpc, chain, privateKey, book, log = console.log, dryRun = false, confirm = async () => true }) {
  if (!isAddress(book || "")) die("BOOK (the address book) is required for this network");
  const art = compileSecretVault();
  log(`EnclaveSecretVault: ${art.size} bytes runtime; constructor(book = ${getAddress(book)})`);
  if (dryRun) { log("dry run: nothing sent"); return null; }
  const account = privateKeyToAccount(privateKey);
  const pc = createPublicClient({ chain, transport: http(rpc) });
  const wc = createWalletClient({ chain, account, transport: http(rpc) });
  if ((await pc.getChainId()) !== chain.id) die(`the RPC is not chain ${chain.id}`);
  if ((await pc.getCode({ address: book })) === undefined) die(`no contract at the book address ${book}`);
  if (!(await confirm(`deploy from ${account.address} on chain ${chain.id}?`))) die("aborted");
  const hash = await wc.deployContract({ abi: art.abi, bytecode: art.bytecode, args: [book] });
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== "success" || !r.contractAddress) die(`deployment reverted: ${hash}`);
  const vault = getAddress(r.contractAddress);
  // verify what is on chain: the book it reads, and that the deployer holds nothing (there is nothing TO hold). A public RPC
  // can answer the receipt before it serves the new code (10-14: "book returned no data" on the first read), so retry.
  let gotBook = null;
  for (let i = 0; i < 20 && !gotBook; i++) {
    gotBook = await pc.readContract({ address: vault, abi: art.abi, functionName: "book" }).catch(() => null);
    if (!gotBook) await new Promise((r) => setTimeout(r, 1500));
  }
  if (!gotBook) die(`deployed ${vault} (tx ${hash}) but no RPC answered book() yet: verify it by hand`);
  if (getAddress(gotBook) !== getAddress(book)) die(`the vault reads book ${gotBook}, not ${book}`);
  log(`deployed ${vault} (tx ${hash}, block ${r.blockNumber})`);
  const setData = encodeFunctionData({ abi: [{ type: "function", name: "set", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [] }],
                                      functionName: "set", args: [stringToHex("secretVault", { size: 32 }), vault] });
  log(`\nGOVERNANCE STEP (not sent): the book owner signs\n  to:   ${getAddress(book)}\n  data: ${setData}\n  (EnclaveAddressBook.set("secretVault", ${vault}))`);
  return { vault, hash, setData };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const net = NETWORKS[process.env.NETWORK || ""] || die(`NETWORK must be one of ${Object.keys(NETWORKS).join(", ")}`);
  const rl = process.argv.includes("--yes") ? null : readline.createInterface({ input, output });
  try {
    await deploySecretVault({ rpc: process.env.RPC_URL || net.rpc, chain: net.chain, privateKey: process.env.DEPLOYER_PRIVATE_KEY || (process.argv.includes("--dry-run") ? "0x" + "11".repeat(32) : die("DEPLOYER_PRIVATE_KEY is required")),
      book: process.env.BOOK || net.book, dryRun: process.argv.includes("--dry-run"),
      confirm: async (q) => (rl ? /^y(es)?$/i.test(await rl.question(q + " [y/N] ")) : true) });
  } catch (e) { console.error(`deploy-secret-vault: ${e.message}`); process.exitCode = 1; }
  finally { rl?.close(); }
}
