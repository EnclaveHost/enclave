// The Windows node's OWN chain module, patched (work/app-lease-gas/shadow-win/windows/node/chain.mjs = main's
// chain.mjs + the design-B hunk), imported for real and configured only by its environment, against a local anvil
// (chain id 8453) with the live rev-16d ledger and schema-4 registry sources, EnclaveLeaseGasReserve,
// EnclaveLeaseExecutor and one open relay. Its claimDeployment / renewDeployment / releaseDeployment - what host.mjs
// calls - run app-funded for an operator key holding ZERO ETH; an app without a reserve is refused in words; the renew
// lead host.mjs asks for (renewLeadMs) narrows to the app's window.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as viem from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import * as B from "../client/lease-executor-client.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "forge/out");
const { linkBytecode } = await import(pathToFileURL(path.resolve(ROOT, "../enclave/site/js/lib/contract-linker.js")).href);
const haveAnvil = (() => { try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const T = { skip: !haveAnvil && "needs anvil", timeout: 240_000 };
const DEPLOYER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const RELAY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
let anvil, rpcUrl, pc, chainDef, relay, chain, addr = {}, A = {};
const opKey = generatePrivateKey(), op = privateKeyToAccount(opKey);
const ownerKey = generatePrivateKey(), owner = privateKeyToAccount(ownerKey);
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const rpc = async (m, p) => { const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) }); const j = await r.json(); if (j.error) throw new Error(JSON.stringify(j.error)); return j.result; };
const art = (file, name) => { const j = JSON.parse(fs.readFileSync(path.join(OUT, file, name + ".json"), "utf8")); return { abi: j.abi, bytecode: j.bytecode.object, links: j.bytecode.linkReferences || {} }; };
const wc = (key) => viem.createWalletClient({ chain: chainDef, account: privateKeyToAccount(key), transport: viem.http(rpcUrl) });
async function send(key, tx) { const h = await wc(key).sendTransaction({ gas: 8_000_000n, ...tx }); const rc = await pc.waitForTransactionReceipt({ hash: h }); if (rc.status !== "success") throw new Error("reverted"); return rc; }
async function deploy(a, args = [], libs = {}) { const bytecode = Object.keys(a.links).length ? linkBytecode(a.bytecode, a.links, libs) : a.bytecode;
  return (await send(DEPLOYER, { data: viem.encodeDeployData({ abi: a.abi, bytecode, args }) })).contractAddress; }
const write = (key, to, abi, fn, args = [], value = 0n) => send(key, { to, data: viem.encodeFunctionData({ abi, functionName: fn, args }), value });
const row = (id) => pc.readContract({ address: addr.ledger, abi: A.ledger.abi, functionName: "get", args: [id] });
async function warpTo(ts) { await rpc("evm_setNextBlockTimestamp", [Number(ts)]); await rpc("evm_mine", []); }
async function create() {
  const args = ["catalog://app/0", 0, 500, 8080, "", true, "", "0x0000000000000000000000000000000000000000", 0n, 1000n];
  const { result } = await pc.simulateContract({ account: owner.address, address: addr.ledger, abi: A.ledger.abi, functionName: "create", args });
  await write(ownerKey, addr.ledger, A.ledger.abi, "create", args);
  return result;
}

before(async () => {
  if (!haveAnvil) return;
  const port = await freePort();
  rpcUrl = `http://127.0.0.1:${port}`;
  chainDef = viem.defineChain({ id: 8453, name: "local-8453", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  anvil = spawn("anvil", ["--port", String(port), "--chain-id", "8453", "--base-fee", "10000000", "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 100; i++) { try { await rpc("eth_chainId", []); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  pc = viem.createPublicClient({ chain: chainDef, transport: viem.http(rpcUrl) });
  A = { usdc: art("MockUSDC.sol", "MockUSDC"), feed: art("LeaseGas.t.sol", "MockFeed"), registry: art("EnclaveRegistry.sol", "EnclaveRegistry"),
        lib: art("EnclaveDeployments.sol", "EnclaveLedgerBandwidth"), ledger: art("EnclaveDeployments.sol", "EnclaveDeployments"),
        reserve: art("EnclaveLeaseGasReserve.sol", "EnclaveLeaseGasReserve"), executor: art("EnclaveLeaseExecutor.sol", "EnclaveLeaseExecutor") };
  addr.usdc = await deploy(A.usdc); addr.feed = await deploy(A.feed); addr.registry = await deploy(A.registry); addr.lib = await deploy(A.lib);
  addr.ledger = await deploy(A.ledger, [addr.usdc, privateKeyToAccount(generatePrivateKey()).address, addr.registry, addr.feed],
                             { "src/live/EnclaveDeployments.sol:EnclaveLedgerBandwidth": addr.lib });
  addr.reserve = await deploy(A.reserve, [addr.ledger, addr.registry, "0x0000000000000000000000000000000000000000",
    { maxGasPriceCeiling: 10n ** 9n, overheadClaimGas: 29_500, overheadRenewGas: 24_000, overheadReleaseGas: 7_000, minClaimInterval: 60, l1Bps: 0 }]);
  addr.executor = await deploy(A.executor, [addr.reserve]);
  await write(DEPLOYER, addr.reserve, A.reserve.abi, "bindExecutor", [addr.executor]);
  relay = await B.startLeaseRelay({ client: pc, wallet: wc(RELAY) });
  // the box's operator: classic registration with temporary ETH (fixture shortcut), then 0 ETH for good
  await rpc("anvil_setBalance", [op.address, "0xde0b6b3a7640000"]);
  await write(opKey, addr.registry, A.registry.abi, "register", ["https://win-box.test", "EnclaveHost/enclave", `0x${"00".repeat(32)}`, 1000n, 0n,
                                                                  "0x000000000000000000000000000000000000bEEF"]);
  await rpc("anvil_setBalance", [op.address, "0x0"]);
  await rpc("anvil_setBalance", [owner.address, "0xde0b6b3a7640000"]);
  // the Windows chain module, configured exactly as host.mjs's process would be: by environment
  Object.assign(process.env, { BASE_RPCS: rpcUrl, NODE_OPERATOR_KEY: opKey, ENCLAVE_LEASE_GAS_RESERVE: addr.reserve, ENCLAVE_LEASE_GAS_RELAYS: relay.url });
  chain = await import(pathToFileURL(path.join(ROOT, "shadow-win/windows/node/chain.mjs")).href);
  chain.loadOperator();
  chain.addresses.deployments = addr.ledger;
  chain.addresses.registry = addr.registry;
});
after(async () => { await relay?.close(); if (anvil) anvil.kill("SIGKILL"); });

test("Windows chain.mjs: claimDeployment / renewDeployment / releaseDeployment app-funded for a zero-ETH key; refusal in words; renewLeadMs", T, async () => {
  const enc = viem.keccak256(viem.toBytes("https://win-box.test"));
  const id = await create();
  await write(DEPLOYER, addr.usdc, viem.parseAbi(["function mint(address,uint256)"]), "mint", [owner.address, 6_000_000n]);
  await write(ownerKey, addr.usdc, viem.parseAbi(["function approve(address,uint256) returns (bool)"]), "approve", [addr.ledger, 6_000_000n]);
  await write(ownerKey, addr.ledger, A.ledger.abi, "fund", [id, 6_000_000n]);
  // no reserve yet: refused in the reserve's words, nothing sent
  await assert.rejects(chain.claimDeployment(id, enc), (e) => e.code === "Disabled");
  assert.equal(await chain.renewLeadMs(id, 900_000), 900_000, "not app-funded yet: host.mjs's own 15-minute lead");
  await write(ownerKey, addr.reserve, A.reserve.abi, "deposit", [id], 10n ** 16n);
  await write(ownerKey, addr.reserve, A.reserve.abi, "configure", [id, { enabled: true, claimPolicy: 0, sponsorRelease: true, maxClaimsPerEpoch: 4,
    maxPerOpWei: 10n ** 15n, epochCapWei: 5n * 10n ** 15n, epochSec: 3600, renewWindow: 300, minExtension: 600, claimCooldown: 1800, maxGasPrice: 10n ** 8n }]);
  const h1 = await chain.claimDeployment(id, enc);
  assert.match(h1, /^0x[0-9a-f]{64}$/);
  assert.equal((await row(id)).runnerOperator, op.address);
  assert.equal(await chain.renewLeadMs(id, 900_000), 285_000, "app-funded: renew inside the app's 300 s window (minus 15 s)");
  await assert.rejects(chain.renewDeployment(id), (e) => e.code === "NotInRenewWindow");
  await warpTo((await row(id)).leaseUntil - 200n);
  await chain.renewDeployment(id);
  await chain.releaseDeployment(id);
  assert.match((await row(id)).runnerOperator, /^0x0{40}$/i, "released");
  assert.equal(await pc.getBalance({ address: op.address }), 0n, "the box's key never held ETH");
  const paid = await pc.getContractEvents({ address: addr.reserve, abi: A.reserve.abi, eventName: "LeaseGasPaid", fromBlock: 0n });
  assert.deepEqual(paid.map((e) => ["", "claim", "renew", "release"][e.args.kind]), ["claim", "renew", "release"]);
});
