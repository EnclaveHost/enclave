// A local chain (anvil, chain 8453) with the LIVE rev-16d EnclaveDeployments bytecode (test/fixtures/ledger-rev16d, the
// compiled authoritative source), the schema-4 registry, a mock USDC, and three JSON-RPC proxies in front of it that can
// behave like real public providers: a range limit, a rate limit, an unserved (archive) history, dropped logs, a lying
// block hash, an outage. Used by test/storage-front-binding.test.mjs (both readers: relay/lease-generation.mjs and the
// guest's isolation/m2/bootstrap/leasegen.go). Only anvil's published dev keys.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http as viemHttp, encodeDeployData, getAddress, keccak256, toBytes, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { linkBytecode } from "../../site/js/lib/contract-linker.js";
import { compileRegistrySchema4, freePort, KEYS } from "./cli-independent-rig.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIX = path.join(REPO, "test/fixtures/ledger-rev16d");
export const chain = { id: 8453, name: "local-base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } };
const art = (n) => { const j = JSON.parse(fs.readFileSync(path.join(FIX, n + ".json"), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object, linkReferences: j.bytecode.linkReferences || {}, runtime: j.deployedBytecode, immutableNames: j.immutableNames }; };
export const LEDGER16D = art("EnclaveDeployments"), BANDWIDTH16D = art("EnclaveLedgerBandwidth");
export { KEYS };
export const KEY_C = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";   // anvil #5

/** The fixture's runtime, linked to the LIVE library and filled with the LIVE immutables -> its keccak (must equal the live code hash). */
export function liveRuntimeHash() {
  const LIB = "3dfee18b44b7ecd389eca78da10b6ad032802215";
  const IMM = { usdc: "833589fcd6edb6e08f4c7c32d4f71b54bda02913", registry: "868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac" };
  let hex = LEDGER16D.runtime.object.replace(/^0x/, "");
  for (const file of Object.values(LEDGER16D.runtime.linkReferences || {}))
    for (const refs of Object.values(file)) for (const r of refs) hex = hex.slice(0, r.start * 2) + LIB + hex.slice((r.start + r.length) * 2);
  // the two immutables, by the names the fixture build recorded (test/fixtures/ledger-rev16d/PROVENANCE.txt)
  for (const [id, refs] of Object.entries(LEDGER16D.runtime.immutableReferences))
    for (const r of refs) hex = hex.slice(0, r.start * 2) + IMM[LEDGER16D.immutableNames[id]].padStart(64, "0") + hex.slice((r.start + r.length) * 2);
  return keccak256("0x" + hex);
}

export async function startLease16dRig({ providers = 3 } = {}) {
  const stops = [];
  const stop = async () => { while (stops.length) { try { await stops.pop()(); } catch {} } };
  try {
    const port = await freePort();
    const anvil = spawn("anvil", ["--port", String(port), "--chain-id", "8453", "--silent", "--base-fee", "0", "--gas-price", "0"], { stdio: "ignore" });
    const kill = () => { try { anvil.kill("SIGKILL"); } catch {} };
    process.once("exit", kill); stops.push(() => { process.removeListener("exit", kill); kill(); });
    const rpc = `http://127.0.0.1:${port}`;
    const pc = createPublicClient({ chain, cacheTime: 0, pollingInterval: 20, transport: viemHttp(rpc) });
    for (let i = 0; i < 100; i++) { try { await pc.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const raw = (method, params = []) => fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
      .then((r) => r.json()).then((j) => { if (j.error) throw new Error(j.error.message); return j.result; });
    const wc = (key) => createWalletClient({ chain, cacheTime: 0, pollingInterval: 20, account: privateKeyToAccount(key), transport: viemHttp(rpc) });
    const dep = wc(KEYS.deployer);
    const write = async (who, address, abi, functionName, args) => {
      const hash = await who.writeContract({ address, abi, functionName, args });
      const rc = await pc.waitForTransactionReceipt({ hash, pollingInterval: 20, timeout: 30_000 });
      if (rc.status !== "success") throw new Error(functionName + " reverted");
      return rc;
    };
    const deploy = async (a, args = [], libs = {}) => {
      const bytecode = Object.keys(a.linkReferences || {}).length ? linkBytecode(a.bytecode, a.linkReferences, libs) : a.bytecode;
      const rc = await pc.waitForTransactionReceipt({ hash: await dep.sendTransaction({ data: encodeDeployData({ abi: a.abi, bytecode, args }) }) });
      if (rc.status !== "success") throw new Error("deploy failed");
      return getAddress(rc.contractAddress);
    };
    const usdcArt = JSON.parse(fs.readFileSync(path.join(REPO, "contracts/foundry/out/SessionMocks.sol/MockUSDC3009.json"), "utf8"));
    const USDC = { abi: usdcArt.abi, bytecode: usdcArt.bytecode.object };
    const REG = compileRegistrySchema4();
    const usdc = await deploy(USDC), registry = await deploy(REG);
    const bw = await deploy(BANDWIDTH16D);
    const libs = {}; for (const [file, names] of Object.entries(LEDGER16D.linkReferences)) for (const n of Object.keys(names)) libs[`${file}:${n}`] = bw;
    const ledger = await deploy(LEDGER16D, [usdc, "0x00000000000000000000000000000000000e2e01", registry, "0x0000000000000000000000000000000000000000"], libs);
    const L = LEDGER16D.abi;
    // hosts on the schema-4 registry: open registration, a price, no proof key (proofs are off: proofRequiredFrom 0)
    const hosts = {};
    for (const [name, key] of [["a", KEYS.operator], ["b", KEYS.other], ["c", KEY_C]]) {
      const endpoint = `https://host-${name}.lease16d.test`;
      await write(wc(key), registry, REG.abi, "register", [endpoint, "independent/host", "0x" + "00".repeat(32), 1000n, 0n, "0x0000000000000000000000000000000000000000"]);
      hosts[name] = { key, endpoint, id: keccak256(toBytes(endpoint)), operator: privateKeyToAccount(key).address.toLowerCase() };
    }
    const owner = wc(KEYS.owner);
    await write(dep, usdc, USDC.abi, "mint", [owner.account.address, parseUnits("1000", 6)]);
    await write(owner, usdc, USDC.abi, "approve", [ledger, parseUnits("1000", 6)]);
    const CREATED = keccak256(toBytes("Created(bytes32,address,string,uint16,uint16,uint256)"));
    async function create({ config = "", fund = "20" } = {}) {
      const rc = await write(owner, ledger, L, "create", [`catalog://0x${"5a".repeat(32)}/3`, 0, 100, 8000, "http:8000", true, config, "0x0000000000000000000000000000000000000000", 0n, 10n ** 12n]);
      const id = rc.logs.find((l) => l.address.toLowerCase() === ledger.toLowerCase() && l.topics[0] === CREATED).topics[1];
      await write(owner, ledger, L, "fund", [id, parseUnits(fund, 6)]);
      return id;
    }
    const CLAIMED = keccak256(toBytes("Claimed(bytes32,bytes32,address,uint64,uint256)"));
    const claim = async (id, h) => { const rc = await write(wc(h.key), ledger, L, "claim", [id, h.id]);
      const l = rc.logs.find((x) => x.topics[0] === CLAIMED); return { block: Number(rc.blockNumber), logIndex: Number(l.logIndex), blockHash: rc.blockHash }; };
    const renew = (id, h) => write(wc(h.key), ledger, L, "renew", [id]);
    const release = (id, h) => write(wc(h.key), ledger, L, "release", [id]);
    const mine = async (n = 1) => { await raw("anvil_mine", ["0x" + n.toString(16)]); };
    const warp = async (sec) => { await raw("evm_increaseTime", [sec]); await mine(1); };
    const row = (id) => pc.readContract({ address: ledger, abi: L, functionName: "get", args: [id] });

    // ---- three providers in front of the chain, each with its own behaviour ----
    const peers = [];
    for (let i = 0; i < providers; i++) {
      // finalizedBehind: "finalized" answers the block that many below the head (Base: ~600 blocks, 20 min)
      // noLogs: refuses every eth_getLogs as base.drpc.org's free plan does (probe-logs.json), a history refusal
      const mode = { rangeLimit: 0, rateLimit: 0, historyBelow: 0, noLogs: false, dropLastLog: false, hideClaimsAfter: 0, lieHash: false, down: false, finalizedBehind: 0, calls: [] };
      const srv = http.createServer(async (req, res) => {
        const chunks = []; for await (const c of req) chunks.push(c);
        const q = JSON.parse(Buffer.concat(chunks).toString()), qs = [q].flat();
        const answer = (j) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(Array.isArray(q) ? j : j[0])); };
        if (mode.down) { res.writeHead(503); return res.end(); }
        const out = [];
        for (const m of qs) {
          mode.calls.push(m.method);
          if (m.method === "eth_getLogs") {
            const f = m.params[0], lo = Number(BigInt(f.fromBlock)), hi = Number(BigInt(f.toBlock));
            if (mode.rateLimit > 0) { mode.rateLimit--; res.writeHead(429); return res.end("Too Many Requests"); }
            if (mode.noLogs) { out.push({ jsonrpc: "2.0", id: m.id, error: { code: 35, message: "ranges over 10000 blocks are not supported on free plan" } }); continue; }
            if (mode.rangeLimit && hi - lo + 1 > mode.rangeLimit) { out.push({ jsonrpc: "2.0", id: m.id, error: { code: -32614, message: `eth_getLogs is limited to a ${mode.rangeLimit} range` } }); continue; }
            if (mode.historyBelow && lo < mode.historyBelow) { out.push({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "Archive requests require a personal token" } }); continue; }
          }
          let fwd = m;
          if (m.method === "eth_getBlockByNumber" && m.params[0] === "finalized" && mode.finalizedBehind) {
            const head = Number(BigInt(await raw("eth_blockNumber")));
            fwd = { ...m, params: ["0x" + Math.max(0, head - mode.finalizedBehind).toString(16), m.params[1]] };
          }
          const j = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fwd) }).then((r) => r.json());
          if (m.method === "eth_getLogs" && Array.isArray(j.result)) {
            if (mode.dropLastLog && j.result.length) j.result = j.result.slice(0, -1);
            if (mode.hideClaimsAfter) j.result = j.result.filter((l) => !(l.topics[0] === CLAIMED && Number(BigInt(l.blockNumber)) > mode.hideClaimsAfter));
          }
          if (mode.lieHash && m.method === "eth_getBlockByNumber" && j.result && j.result.hash) j.result.hash = "0x" + "ab".repeat(32);
          out.push(j);
        }
        answer(out);
      });
      await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
      stops.push(() => new Promise((ok) => { srv.closeAllConnections?.(); srv.close(() => ok()); }));
      peers.push({ url: `http://127.0.0.1:${srv.address().port}`, mode });
    }
    const honest = (finalizedBehind = 0) => { for (const p of peers) Object.assign(p.mode, { rangeLimit: 0, rateLimit: 0, historyBelow: 0, noLogs: false, dropLastLog: false, hideClaimsAfter: 0, lieHash: false, down: false, finalizedBehind, calls: [] }); };
    // anvil's finalized tag: how far it lags the head here (a real Base node lags ~20 min)
    const finalizedLag = async () => { const [l, f] = await Promise.all(["latest", "finalized"].map((t) => raw("eth_getBlockByNumber", [t, false]))); return Number(l.number) - Number(f.number); };
    // a month-long lease needs more than create()'s funding: mint to the owner, approve, fund
    const fundMore = async (id, amount) => {
      await write(dep, usdc, USDC.abi, "mint", [owner.account.address, parseUnits(amount, 6)]);
      await write(owner, usdc, USDC.abi, "approve", [ledger, parseUnits(amount, 6)]);
      await write(owner, ledger, L, "fund", [id, parseUnits(amount, 6)]);
    };
    const setConfig = (id, configCid) => write(owner, ledger, L, "setConfig", [id, configCid]);
    const transfer = (id, to) => write(owner, ledger, L, "transferDeployment", [id, to]);
    const ownerAddress = owner.account.address.toLowerCase();
    return { stop, rpc, raw, pc, wc, write, ledger, registry, usdc, hosts, create, claim, renew, release, mine, warp, row, peers, honest, finalizedLag, L,
             fundMore, setConfig, transfer, ownerAddress };
  } catch (e) { await stop(); throw e; }
}
