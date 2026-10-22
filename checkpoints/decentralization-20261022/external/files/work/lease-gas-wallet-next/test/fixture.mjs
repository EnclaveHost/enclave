// A local Base-shaped chain for the setup stages. Real parts: anvil (chain id 8453), the frozen compiled
// EnclaveLeaseGasReserve / EnclaveLeaseExecutor from work/app-lease-gas/forge/out, the real admin address
// 0x0b2d…E61 acting through anvil impersonation (no key exists), root's request.mjs shape and root's verifyReserve.
// Stand-ins (stated, not hidden): the production ledger/registry ADDRESSES carry small placeholder runtimes, pinned by
// their own hashes in the fixture trust (the production hashes are asserted separately against root's read.mjs); the
// address book at its production address answers owner() with a fixed address; anvil has no OP-stack predeploy, so the
// GasPriceOracle address answers getL1Fee with a constant.
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { createPublicClient, http as viemHttp, encodeDeployData, encodeFunctionData, getContractAddress, keccak256, toHex } from "../../enclave/node_modules/viem/_esm/index.js";
import { PRODUCTION } from "../trust.mjs";
import { verifiedArtifacts } from "../artifacts.mjs";

export const L1_FEE = 12_345_678_901n;
export const LIMITS = { maxGasPriceCeiling: "1000000000", overheadClaimGas: 65000, overheadRenewGas: 55000, overheadReleaseGas: 36000, minClaimInterval: 60, l1Bps: 10000 };
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const ret32 = (h) => "0x7f" + h.slice(2).padStart(64, "0") + "60005260206000f3";           // PUSH32 v; MSTORE; RETURN 32 bytes
export const returning = (addressOrWord) => ret32(addressOrWord);

export async function startChain({ chainId = 8453 } = {}) {
  const port = await freePort();
  const proc = spawn("anvil", ["--port", String(port), "--chain-id", String(chainId), "--silent", "--base-fee", "5000000"], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  const rpc = async (method, params = []) => {
    const j = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
    if (j.error) throw Object.assign(new Error(j.error.message), { rpcError: j.error });
    return j.result;
  };
  for (let i = 0; i < 100; i++) { try { await rpc("eth_chainId"); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  // a second provider HOST for the same chain: a forwarder reached as "localhost" (root requires two hostnames)
  const fwd = http.createServer(async (req, res) => {
    let b = ""; for await (const c of req) b += c;
    try { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: b }); res.writeHead(200, { "content-type": "application/json" }); res.end(await r.text()); }
    catch { res.writeHead(502); res.end(); }
  });
  await new Promise((r) => fwd.listen(0, "127.0.0.1", r));
  const second = `http://localhost:${fwd.address().port}`;
  const client = (u) => createPublicClient({ transport: viemHttp(u, { timeout: 15000, retryCount: 0 }) });
  return { url, second, rpc, clients: [client(url), client(second)], client,
    stop: () => { proc.kill("SIGKILL"); fwd.closeAllConnections(); fwd.close(); } };
}

/** The chain prepared like Base before step 1: admin funded and impersonated, stand-ins at the production addresses. */
export async function baseLike(chain) {
  const { rpc } = chain, admin = PRODUCTION.admin;
  await rpc("anvil_impersonateAccount", [admin]);
  await rpc("anvil_setBalance", [admin, toHex(10n ** 18n)]);
  await rpc("anvil_setCode", [PRODUCTION.ledger, "0x600160005260206000f3"]);       // stand-in ledger runtime
  await rpc("anvil_setCode", [PRODUCTION.registry, "0x600260005260206000f3"]);     // stand-in registry runtime
  await rpc("anvil_setCode", [PRODUCTION.book, returning(admin)]);                 // owner() -> the admin
  await rpc("anvil_setCode", [PRODUCTION.oracle, ret32(toHex(L1_FEE))]);           // getL1Fee(bytes) -> constant
  const pc = chain.clients[0];
  const codeHash = async (a) => keccak256(await pc.getCode({ address: a }));
  // anvil answers eth_maxPriorityFeePerGas with 1 gwei (Base: ~0.001 gwei), so 2*base+tip always exceeds the production
  // 1 gwei cap here: the fixture cap is 3 gwei (stated); the cap check itself is exercised with a 10 gwei base fee.
  const trust = { ...PRODUCTION, codeHashes: { ledger: await codeHash(PRODUCTION.ledger), registry: await codeHash(PRODUCTION.registry) }, rpcs: [chain.url, chain.second],
    caps: { ...PRODUCTION.caps, maxFeePerGas: 3_000_000_000n } };
  return { trust, artifacts: verifiedArtifacts({ trust: PRODUCTION }) };
}

/** As the admin's wallet would: send exactly these parameters. -> hash */
export async function walletSend(chain, tx, { mine = 3 } = {}) {
  const h = await chain.rpc("eth_sendTransaction", [tx]);
  if (mine) await chain.rpc("anvil_mine", [toHex(mine)]);
  return h;
}

/** Step 1 exactly as root's request.mjs shapes it (transaction, predictedAddress, expectedRuntimeHash, binding). */
export async function reserveStep(chain, { trust, artifacts }) {
  const a = artifacts.EnclaveLeaseGasReserve, pc = chain.clients[0];
  const data = encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args: [trust.ledger, trust.registry, trust.oracle, { ...LIMITS, maxGasPriceCeiling: BigInt(LIMITS.maxGasPriceCeiling) }] });
  const nonce = await pc.getTransactionCount({ address: trust.admin });
  const runtime = await chain.rpc("eth_call", [{ from: trust.admin, data }, "latest"]);
  const request = { format: "enclave-lease-reserve-creation/v1", status: "fixture",
    transaction: { from: trust.admin, chainId: "0x2105", type: "0x2", nonce: toHex(nonce), data, value: "0x0", gas: toHex(4_000_000), maxFeePerGas: toHex(100_000_000), maxPriorityFeePerGas: toHex(1_000_000) },
    expectedRuntimeHash: keccak256(runtime), predictedAddress: getContractAddress({ from: trust.admin, nonce: BigInt(nonce) }),
    binding: { owner: trust.admin, ledger: trust.ledger, registry: trust.registry, oracle: trust.oracle, limits: LIMITS } };
  return request;
}
export const asAdmin = (chain, to, abi, functionName, args = [], extra = {}) =>
  walletSend(chain, { from: PRODUCTION.admin, to, data: encodeFunctionData({ abi, functionName, args }), ...extra });
