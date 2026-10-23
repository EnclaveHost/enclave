// A local design-B world for node tests: anvil (chain id 8453, base fee 0.01 gwei), the LIVE rev-16d ledger and schema-4
// registry sources, EnclaveLeaseGasReserve + EnclaveLeaseExecutor (built from source by test/helpers/lease-gas-forge.mjs),
// MockUSDC and a mock ETH/USD feed.
// Operators are fresh keys registered by a fixture shortcut (temporary ETH for register(), then set back to 0).
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as viem from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { REPO, haveForge, leaseGasForgeOut } from "./lease-gas-forge.mjs";

const { linkBytecode } = await import(pathToFileURL(path.join(REPO, "site/js/lib/contract-linker.js")).href);
/** anvil AND forge (the contracts are built from source): the chain tests skip, saying why, without either */
export const haveAnvil = haveForge && (() => { try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
export const DEPLOYER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const ZERO32 = `0x${"00".repeat(32)}`;
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
export const art = (file, name) => { const j = JSON.parse(fs.readFileSync(path.join(leaseGasForgeOut(), file, name + ".json"), "utf8")); return { abi: j.abi, bytecode: j.bytecode.object, links: j.bytecode.linkReferences || {} }; };

export const LIMITS = { maxGasPriceCeiling: 10n ** 9n, overheadClaimGas: 29_500, overheadRenewGas: 24_000, overheadReleaseGas: 7_000, minClaimInterval: 60, l1Bps: 0 };
export const policy = (p = {}) => ({ enabled: true, claimPolicy: 0, sponsorRelease: true, maxClaimsPerEpoch: 4, maxPerOpWei: 10n ** 15n,
  epochCapWei: 5n * 10n ** 15n, epochSec: 3600, renewWindow: 300, minExtension: 600, claimCooldown: 1800, maxGasPrice: 100_000_000n, ...p });

export async function startWorld({ anvilArgs = [] } = {}) {
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const anvil = spawn("anvil", ["--port", String(port), "--chain-id", "8453", "--base-fee", "10000000", "--silent", ...anvilArgs], { stdio: "ignore" });
  const rpc = async (m, p = []) => { const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) }); const j = await r.json(); if (j.error) throw new Error(`${m}: ${JSON.stringify(j.error)}`); return j.result; };
  try { return await setupWorld({ anvil, rpcUrl, rpc }); }
  catch (e) { anvil.kill("SIGKILL"); throw e; }   // a failed setup must not leave anvil holding this test process
}
async function setupWorld({ anvil, rpcUrl, rpc, fundImpl = null }) {
  for (let i = 0; i < 100; i++) { try { await rpc("eth_chainId"); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  const chain = viem.defineChain({ id: 8453, name: "local-8453", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const pc = viem.createPublicClient({ chain, transport: viem.http(rpcUrl) });
  const wc = (key) => viem.createWalletClient({ chain, account: typeof key === "string" ? privateKeyToAccount(key) : key, transport: viem.http(rpcUrl) });
  const send = async (key, tx) => { const h = await wc(key).sendTransaction({ gas: 8_000_000n, ...tx }); const rc = await pc.waitForTransactionReceipt({ hash: h }); if (rc.status !== "success") throw new Error("reverted: " + (tx.label || "")); return rc; };
  const deploy = async (a, args = [], libs = {}) => { const bytecode = Object.keys(a.links).length ? linkBytecode(a.bytecode, a.links, libs) : a.bytecode;
    return viem.getAddress((await send(DEPLOYER, { data: viem.encodeDeployData({ abi: a.abi, bytecode, args }) })).contractAddress); };
  const write = (key, to, abi, fn, args = [], value = 0n) => send(key, { to, data: viem.encodeFunctionData({ abi, functionName: fn, args }), value, label: fn });
  const A = { usdc: art("MockUSDC.sol", "MockUSDC"), feed: art("MockFeed.sol", "MockFeed"), registry: art("EnclaveRegistry.sol", "EnclaveRegistry"),
    lib: art("EnclaveDeployments.sol", "EnclaveLedgerBandwidth"), ledger: art("EnclaveDeployments.sol", "EnclaveDeployments"),
    reserve: art("EnclaveLeaseGasReserve.sol", "EnclaveLeaseGasReserve"), executor: art("EnclaveLeaseExecutor.sol", "EnclaveLeaseExecutor"),
    spoof: art("SpoofOperator.sol", "SpoofOperator"), reverts: art("SpoofOperator.sol", "AlwaysReverts") };
  const addr = {};
  addr.usdc = await deploy(A.usdc); addr.feed = await deploy(A.feed);
  await write(DEPLOYER, addr.feed, A.feed.abi, "set", [300000000000n, (await pc.getBlock()).timestamp]);
  addr.registry = await deploy(A.registry); addr.lib = await deploy(A.lib);
  addr.ledger = await deploy(A.ledger, [addr.usdc, privateKeyToAccount(generatePrivateKey()).address, addr.registry, addr.feed],
                             { [`${Object.keys(A.ledger.links)[0]}:EnclaveLedgerBandwidth`]: addr.lib });
  const newReserve = async (limits = LIMITS) => {
    const reserve = await deploy(A.reserve, [addr.ledger, addr.registry, "0x0000000000000000000000000000000000000000", limits]);
    const executor = await deploy(A.executor, [reserve]);
    await write(DEPLOYER, reserve, A.reserve.abi, "bindExecutor", [executor]);
    return { reserve, executor, reserveCodeHash: viem.keccak256(await pc.getCode({ address: reserve })), executorCodeHash: viem.keccak256(await pc.getCode({ address: executor })) };
  };
  Object.assign(addr, await newReserve());
  const fund = fundImpl ? (a, wei = 10n ** 18n) => fundImpl({ send, a, wei }) : (a, wei = 10n ** 18n) => rpc("anvil_setBalance", [a, viem.toHex(wei)]);
  /** a zero-ETH host operator registered at `endpoint` (fixture shortcut: temporary ETH for register(), then 0) */
  async function operator(endpoint, { proofKey = "0x000000000000000000000000000000000000bEEF", key = generatePrivateKey() } = {}) {
    const account = privateKeyToAccount(key);
    await fund(account.address);
    await write(key, addr.registry, A.registry.abi, "register", [endpoint, "EnclaveHost/enclave", ZERO32, 1000n, 0n, proofKey]);
    await fund(account.address, 0n);
    return { key, account, address: account.address, enclaveId: viem.keccak256(viem.toBytes(endpoint)) };
  }
  async function owner({ key = generatePrivateKey() } = {}) {
    const account = privateKeyToAccount(key);
    await fund(account.address);
    return { key, account, address: account.address };
  }
  async function create(o, { fund6 = 6_000_000n } = {}) {
    const args = ["catalog://app/0", 0, 500, 8080, "", true, "", "0x0000000000000000000000000000000000000000", 0n, 1000n];
    const { result } = await pc.simulateContract({ account: o.address, address: addr.ledger, abi: A.ledger.abi, functionName: "create", args });
    await write(o.key, addr.ledger, A.ledger.abi, "create", args);
    if (fund6 > 0n) {
      await write(DEPLOYER, addr.usdc, viem.parseAbi(["function mint(address,uint256)"]), "mint", [o.address, fund6]);
      await write(o.key, addr.usdc, viem.parseAbi(["function approve(address,uint256) returns (bool)"]), "approve", [addr.ledger, fund6]);
      await write(o.key, addr.ledger, A.ledger.abi, "fund", [result, fund6]);
    }
    return result;
  }
  async function enable(o, id, { reserve = addr.reserve, deposit = 10n ** 16n, p = {} } = {}) {
    await write(o.key, reserve, A.reserve.abi, "deposit", [id], deposit);
    await write(o.key, reserve, A.reserve.abi, "configure", [id, policy(p)]);
  }
  const row = (id) => pc.readContract({ address: addr.ledger, abi: A.ledger.abi, functionName: "get", args: [id] });
  const reserveOf = (id, who, reserve = addr.reserve) => pc.readContract({ address: reserve, abi: A.reserve.abi, functionName: "reserveOf", args: [id, who] });
  const warpTo = async (ts) => { await rpc("evm_setNextBlockTimestamp", [Number(ts)]); await rpc("evm_mine", []); };
  return { rpcUrl, chain, rpc, pc, wc, send, deploy, write, A, addr, newReserve, fund, operator, owner, create, enable, row, reserveOf, warpTo,
           stop: () => anvil.kill("SIGKILL") };
}

/** The same world on an EXISTING chain (a reth --dev node: no anvil_* or evm_* calls, the anvil dev keys funded at genesis):
 *  funding is a transfer from the deployer up to `wei` (a balance is never lowered, so a "zero-ETH" operator keeps dust);
 *  warpTo is unavailable. The caller owns the chain process (stop() is a no-op here). */
export async function startWorldOn({ rpcUrl }) {
  const rpc = async (m, p = []) => { const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; };
  const fundImpl = async ({ send, a, wei }) => {
    const have = BigInt(await rpc("eth_getBalance", [a, "latest"]));
    if (wei > have) await send(DEPLOYER, { to: a, value: wei - have, gas: 21_000n });
  };
  const w = await setupWorld({ anvil: { kill() {} }, rpcUrl, rpc, fundImpl });
  return { ...w, warpTo: () => { throw new Error("warpTo needs anvil"); }, stop: () => {} };
}
