// Diagnose root's fork-deploy --legacy-session-factory receipt timeout: the passkey test's exact anvil flags, root's exact
// fixture steps (copied from tree/test/helpers/fork-deploy.mjs), a log line per transaction, and on a stuck receipt the
// transaction, pool and block state. Local anvil fork only (read-only upstream).
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { createPublicClient, createWalletClient, http, encodeDeployData, getAddress, stringToHex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import solc from "solc";
const TREE = "/home/steven/Documents/Codex/2026-10-18/wo/work/browser-platform-book/tree";
const { linkBytecode } = await import(TREE + "/site/js/lib/contract-linker.js");
const OUT = TREE + "/contracts/foundry/out";
const free = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const port = await free(), rpcUrl = "http://127.0.0.1:" + port;
const anvil = spawn("anvil", ["--port", String(port), "--fork-url", "https://mainnet.base.org", "--fork-block-number", "52836800", "--optimism", "--silent", "--base-fee", "0",
  "--prune-history", "4", "--transaction-block-keeper", "16"], { stdio: "ignore" });
const t0 = Date.now(), log = (m) => console.log(Math.round((Date.now() - t0) / 1000) + "s " + m);
const rpc = async (method, params) => { const r = await (await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json(); if (r.error) throw new Error(method + ": " + r.error.message); return r.result; };
try {
  for (let i = 0; i < 160; i++){ try { await rpc("eth_chainId", []); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  const payer = process.env.PAYER ? { address: getAddress(process.env.PAYER) } : privateKeyToAccount(generatePrivateKey());
  await rpc("anvil_setBalance", [payer.address, "0x56bc75e2d63100000"]); await rpc("anvil_impersonateAccount", [payer.address]);
  const chain = { id: 8453, name: "base-fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } };
  const pc = createPublicClient({ chain, transport: http(rpcUrl) }), wc = createWalletClient({ chain, account: getAddress(payer.address), transport: http(rpcUrl) });
  const blk = await pc.getBlock(); log("fork head " + blk.number + " gasLimit " + blk.gasLimit + " baseFee " + blk.baseFeePerGas);
  const wait = async (hash, what) => {
    try { const rc = await pc.waitForTransactionReceipt({ hash, timeout: 45000 }); log(what + ": status " + rc.status + " gasUsed " + rc.gasUsed + " block " + rc.blockNumber); return rc; }
    catch (e){
      log(what + ": NO RECEIPT after 45s (" + e.name + ")");
      log("  tx " + JSON.stringify(await rpc("eth_getTransactionByHash", [hash]))?.slice(0, 400));
      log("  head " + Number(await rpc("eth_blockNumber", [])) + " pool " + JSON.stringify(await rpc("txpool_status", []).catch((x) => x.message)));
      const c = await rpc("txpool_content", []).catch((x) => ({ error: x.message }));
      log("  pool content " + JSON.stringify(c).slice(0, 600));
      throw e;
    }
  };
  const art = (file, name) => { const j = JSON.parse(fs.readFileSync(path.join(OUT, file, name + ".json"), "utf8")); return { abi: j.abi, bytecode: j.bytecode.object, linkReferences: j.bytecode.linkReferences || {} }; };
  const deploy = async (what, a, args = [], libs = {}) => {
    const bytecode = Object.keys(a.linkReferences).length ? linkBytecode(a.bytecode, a.linkReferences, libs) : a.bytecode;
    log(what + ": sending (initcode " + (bytecode.length - 2) / 2 + " bytes)");
    const h = await wc.sendTransaction({ data: encodeDeployData({ abi: a.abi, bytecode, args }), gas: 12_000_000n });
    log(what + ": hash " + h);
    const rc = await wait(h, what); if (rc.status !== "success") throw new Error(what + " deploy reverted");
    return rc.contractAddress.toLowerCase();
  };
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", treasury = "0x00000000000000000000000000000000000e2e01", zero = "0x0000000000000000000000000000000000000000";
  const FEED_SOURCE = fs.readFileSync(TREE + "/test/helpers/fork-deploy.mjs", "utf8").match(/const FEED_SOURCE = `([^`]*)`/)[1];
  const feedOut = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources: { "Feed.sol": { content: FEED_SOURCE } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } }))).contracts["Feed.sol"].TestEthUsdFeed;
  log("feed compiled");
  const feed = await deploy("feed", { abi: feedOut.abi, bytecode: "0x" + feedOut.evm.bytecode.object, linkReferences: {} });
  const registry = await deploy("registry", art("EnclaveRegistry.sol", "EnclaveRegistry"));
  const bw = await deploy("bandwidth", art("EnclaveDeployments.sol", "EnclaveLedgerBandwidth"));
  const ledger = await deploy("ledger", art("EnclaveDeployments.sol", "EnclaveDeployments"), [USDC, treasury, registry, feed], { "contracts/EnclaveDeployments.sol:EnclaveLedgerBandwidth": bw });
  const catalog = await deploy("catalog", art("EnclaveAppCatalog.sol", "EnclaveAppCatalog"));
  const router = await deploy("router", art("PaymentRouter.sol", "PaymentRouter"), [USDC, treasury]);
  const svlib = await deploy("svlib", art("SessionVault.sol", "SessionVaultLib"));
  const bookArt = art("EnclaveAddressBook.sol", "EnclaveAddressBook");
  const book = await deploy("book", bookArt);
  log("book setMany: sending via writeContract (gas estimated by viem)");
  const h = await wc.writeContract({ address: book, abi: bookArt.abi, functionName: "setMany",
    args: [["registry", "deployments", "appCatalog"].map((s) => stringToHex(s, { size: 32 })), [registry, ledger, catalog]] });
  log("book setMany: hash " + h);
  await wait(h, "book setMany");
  const factory = await deploy("legacy SessionVaultFactory", art("SessionVault.sol", "SessionVaultFactory"), [USDC, book, router, zero, 1_000_000_000n],
    { "contracts/SessionVault.sol:SessionVaultLib": svlib });
  log("done: factory " + factory);
} catch (e){ log("FAILED: " + (e.shortMessage || e.message)); process.exitCode = 1; }
finally { anvil.kill("SIGTERM"); }
