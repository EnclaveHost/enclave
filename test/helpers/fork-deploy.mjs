#!/usr/bin/env node
// Deploy the repository's own ledger and pinned session factory onto a LOCAL anvil fork (real USDC), print their addresses as
// JSON, and exit - a separate short-lived process, so the test process that then drives a browser never holds the large
// Foundry artifacts in memory.   node test/helpers/fork-deploy.mjs <rpc-url> <funded-unlocked-address>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, encodeDeployData, getAddress, stringToHex } from "viem";
import { linkBytecode } from "../../site/js/lib/contract-linker.js";
import solc from "solc";

const [rpcUrl, from] = process.argv.slice(2);
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../contracts/foundry/out");
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const chain = { id: 8453, name: "base-fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } };
const pc = createPublicClient({ chain, transport: http(rpcUrl) }), wc = createWalletClient({ chain, account: getAddress(from), transport: http(rpcUrl) });
const art = (file, name) => { const j = JSON.parse(fs.readFileSync(path.join(OUT, file, name + ".json"), "utf8")); return { abi: j.abi, bytecode: j.bytecode.object, linkReferences: j.bytecode.linkReferences || {} }; };
// Poll the local receipt directly. viem's block-number watcher drops a block that arrives while it re-reads the pending
// transaction, and under automine no later block follows, so it waited out its 180 s default on a mined transaction.
const mined = async (hash, what) => {
  for (const until = Date.now() + 120_000; Date.now() < until; await new Promise((r) => setTimeout(r, 250))){
    const rc = await pc.getTransactionReceipt({ hash }).catch((e) => { if (e.name !== "TransactionReceiptNotFoundError") throw e; return null; });
    if (rc){ if (rc.status !== "success") throw new Error(what + " failed"); return rc; }
  }
  const tx = await pc.request({ method: "eth_getTransactionByHash", params: [hash] }).catch((e) => e.message);
  const pool = await pc.request({ method: "txpool_status", params: [] }).catch((e) => e.message);
  throw new Error(what + ": no receipt for " + hash + " after 120 s; head " + await pc.getBlockNumber() + ", in pool " + JSON.stringify(pool)
    + ", transaction block " + JSON.stringify(tx?.blockNumber ?? tx));
};
const deploy = async (a, args = [], libs = {}) => {
  const bytecode = Object.keys(a.linkReferences).length ? linkBytecode(a.bytecode, a.linkReferences, libs) : a.bytecode;
  const h = await wc.sendTransaction({ data: encodeDeployData({ abi: a.abi, bytecode, args }), gas: 12_000_000n });
  const rc = await mined(h, "deploy");
  return rc.contractAddress.toLowerCase();
};
const treasury = "0x00000000000000000000000000000000000e2e01", zero = "0x0000000000000000000000000000000000000000";
// --replace-ledger <old ledger> <registry> <feed>: an administrator's ledger migration on the fork - a new ledger with the
// old one's constructor inputs, every old record imported verbatim (ids included) with its runner rate (importEarn; the
// caller is the new ledger's owner).
//   node test/helpers/fork-deploy.mjs <rpc-url> <funded-unlocked-address> --replace-ledger <old> <registry> <feed>
const replaceAt = process.argv.indexOf("--replace-ledger");
if (replaceAt > 0){
  const [old, registryIn, feedIn] = process.argv.slice(replaceAt + 1, replaceAt + 4).map((a) => getAddress(a));
  const A = art("EnclaveDeployments.sol", "EnclaveDeployments");
  const bwNext = await deploy(art("EnclaveDeployments.sol", "EnclaveLedgerBandwidth"));
  const next = await deploy(A, [USDC, treasury, registryIn, feedIn], { "contracts/EnclaveDeployments.sol:EnclaveLedgerBandwidth": bwNext });
  const n = await pc.readContract({ address: old, abi: A.abi, functionName: "count" });
  const records = n ? await pc.readContract({ address: old, abi: A.abi, functionName: "getPage", args: [0n, n] }) : [];
  if (records.length){
    await mined(await wc.writeContract({ address: next, abi: A.abi, functionName: "importDeployments", args: [records], gas: 12_000_000n }), "import");
    // each record's runner rate too, so a funding on the replacement escrows exactly as on the original
    const rates = [];
    for (const r of records) rates.push((await pc.readContract({ address: old, abi: A.abi, functionName: "earnOf", args: [r.id] }))[0]);
    await mined(await wc.writeContract({ address: next, abi: A.abi, functionName: "importEarn", args: [records.map((r) => r.id), rates], gas: 12_000_000n }), "importEarn");
  }
  process.stdout.write(JSON.stringify({ ledger: next, imported: records.length }) + "\n");
  process.exit(0);
}
// the rig's test-only Chainlink-shaped ETH/USD feed (test/helpers/independent-browser-rig.mjs; never a repository contract), so
// the ledger's fundEth runs on the fork with a fresh answer
const FEED_SOURCE = `// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;
contract TestEthUsdFeed {
  uint8 public decimals = 8; int256 public answer = 2400e8; uint256 public updatedAt; uint80 public roundId = 7; uint80 public answeredInRound = 7;
  constructor() { updatedAt = block.timestamp; }
  function set(int256 a, uint256 u, uint80 r, uint80 ar, uint8 d) external { answer = a; updatedAt = u; roundId = r; answeredInRound = ar; decimals = d; }
  function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) { return (roundId, answer, updatedAt, updatedAt, answeredInRound); }
}`;
const feedOut = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources: { "Feed.sol": { content: FEED_SOURCE } },
  settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } }))).contracts["Feed.sol"].TestEthUsdFeed;
const feed = await deploy({ abi: feedOut.abi, bytecode: "0x" + feedOut.evm.bytecode.object, linkReferences: {} });
const registry = await deploy(art("EnclaveRegistry.sol", "EnclaveRegistry"));
const bw = await deploy(art("EnclaveDeployments.sol", "EnclaveLedgerBandwidth"));
const ledger = await deploy(art("EnclaveDeployments.sol", "EnclaveDeployments"), [USDC, treasury, registry, feed], { "contracts/EnclaveDeployments.sol:EnclaveLedgerBandwidth": bw });
const catalog = await deploy(art("EnclaveAppCatalog.sol", "EnclaveAppCatalog"));
const router = await deploy(art("PaymentRouter.sol", "PaymentRouter"), [USDC, treasury]);
const svlib = await deploy(art("SessionVault.sol", "SessionVaultLib"));
const legacy = process.argv.includes("--legacy-session-factory");
let book = null;
if (legacy){
  const artifact = art("EnclaveAddressBook.sol", "EnclaveAddressBook");
  book = await deploy(artifact);
  const hash = await wc.writeContract({address:book,abi:artifact.abi,functionName:"setMany",
    args:[["registry","deployments","appCatalog"].map(s=>stringToHex(s,{size:32})),[registry,ledger,catalog]]});
  await mined(hash, "book initialization");
}
const factory = await deploy(legacy ? art("SessionVault.sol", "SessionVaultFactory")
  : art("PinnedSessionVaultFactory.sol", "PinnedSessionVaultFactory"),
  legacy ? [USDC,book,router,zero,1_000_000_000n] : [USDC,ledger,catalog,router,zero,1_000_000_000n],
  { "contracts/SessionVault.sol:SessionVaultLib": svlib });
// the exact sessionOf ABI fragment from the artifact, so the caller can read a session without loading the artifact itself
const sessionOfAbi = JSON.parse(fs.readFileSync(path.join(OUT, "SessionVault.sol", "SessionVault.json"), "utf8")).abi.filter((x) => x.type === "function" && x.name === "sessionOf");
process.stdout.write(JSON.stringify({ registry, ledger, catalog, router, factory, feed, book, sessionOfAbi }) + "\n");
