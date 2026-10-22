#!/usr/bin/env node
// Deploy the repository's own ledger and pinned session factory onto a LOCAL anvil fork (real USDC), print their addresses as
// JSON, and exit - a separate short-lived process, so the test process that then drives a browser never holds the large
// Foundry artifacts in memory.   node test/helpers/fork-deploy.mjs <rpc-url> <funded-unlocked-address>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, encodeDeployData, getAddress } from "viem";
import { linkBytecode } from "../../site/js/lib/contract-linker.js";
import solc from "solc";

const [rpcUrl, from] = process.argv.slice(2);
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../contracts/foundry/out");
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const chain = { id: 8453, name: "base-fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } };
const pc = createPublicClient({ chain, transport: http(rpcUrl) }), wc = createWalletClient({ chain, account: getAddress(from), transport: http(rpcUrl) });
const art = (file, name) => { const j = JSON.parse(fs.readFileSync(path.join(OUT, file, name + ".json"), "utf8")); return { abi: j.abi, bytecode: j.bytecode.object, linkReferences: j.bytecode.linkReferences || {} }; };
const deploy = async (a, args = [], libs = {}) => {
  const bytecode = Object.keys(a.linkReferences).length ? linkBytecode(a.bytecode, a.linkReferences, libs) : a.bytecode;
  const h = await wc.sendTransaction({ data: encodeDeployData({ abi: a.abi, bytecode, args }), gas: 12_000_000n });
  const rc = await pc.waitForTransactionReceipt({ hash: h }); if (rc.status !== "success") throw new Error("deploy failed");
  return rc.contractAddress.toLowerCase();
};
const treasury = "0x00000000000000000000000000000000000e2e01", zero = "0x0000000000000000000000000000000000000000";
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
const factory = await deploy(art("PinnedSessionVaultFactory.sol", "PinnedSessionVaultFactory"), [USDC, ledger, catalog, router, zero, 1_000_000_000n], { "contracts/SessionVault.sol:SessionVaultLib": svlib });
// the exact sessionOf ABI fragment from the artifact, so the caller can read a session without loading the artifact itself
const sessionOfAbi = JSON.parse(fs.readFileSync(path.join(OUT, "SessionVault.sol", "SessionVault.json"), "utf8")).abi.filter((x) => x.type === "function" && x.name === "sessionOf");
process.stdout.write(JSON.stringify({ registry, ledger, catalog, router, factory, feed, sessionOfAbi }) + "\n");
