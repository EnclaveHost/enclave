// The HOST WALLET POLICY admission (createHostAdmission) of a given BUNDLE (ADMISSION_MODULE: the deployed
// windows/node/host-admission.bundle.mjs, or a rebuilt one) against five LOCAL mock Base RPCs that count every request and
// can answer like the real public ones do to this site (base.drpc.org: HTTP 429 "Public endpoint rate limit"), or rate-limit
// with a token bucket. Nothing leaves loopback; no key; the bundle's real LeaseReader quorum code runs unchanged.
//   ADMISSION_MODULE=<bundle> node --test admission-quorum.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { decodeFunctionData, encodeFunctionResult, parseAbi, keccak256, toHex } from "viem";

const MOD = await import(process.env.ADMISSION_MODULE);
const { createHostAdmission } = MOD;
const MC3 = "0xca11bde05977b3631167028862be2a173976ca11";
const OWNERSHIP = "0x" + "b1".repeat(20), REGISTRY = "0x" + "b2".repeat(20), CATALOG = "0x" + "b3".repeat(20), BOOK = "0x" + "b4".repeat(20);
const HOST = "0x" + "2f".repeat(32), OWNER = "0x" + "a1".repeat(20);
const APP = (n) => "0x" + n.toString(16).padStart(2, "0").repeat(32);
const mcAbi = parseAbi(["struct Call3 { address target; bool allowFailure; bytes callData; }", "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)"]);
const ownAbi = parseAbi(["function registry() view returns (address)", "function authority(bytes32) view returns (address owner,address pendingOwner,uint64 revision,bytes32 policyHash)"]);
const catAbi = parseAbi([
  "function getApp(bytes32) view returns ((bytes32 appId,address publisher,string slug,string name,string description,uint32 versionCount,uint64 createdAt,uint64 updatedAt,bool active))",
  "function getVersion(bytes32,uint256) view returns ((string cid,string version,uint32 vramMb,uint32 gpuGflops,uint32 memMb,uint32 cpuGflops,uint64 createdAt,bool verified,bool yanked,string ports,uint8 approval,string config))"]);

// ---- the chain state every honest mock serves (the test flips `yanked`) ----
const state = { yanked: new Set() };
const T0 = Date.now(), B0 = 38_000_000n;
const head = () => B0 + BigInt(Math.floor((Date.now() - T0) / 2000));
const blockOf = (n) => ({ number: toHex(n), hash: keccak256(toHex(n)), parentHash: keccak256(toHex(n - 1n)), timestamp: toHex(Math.floor(T0 / 1000) + Number(n - B0) * 2),
  nonce: "0x0000000000000000", difficulty: "0x0", totalDifficulty: "0x0", gasLimit: "0x1c9c380", gasUsed: "0x0", miner: "0x" + "00".repeat(20), extraData: "0x",
  logsBloom: "0x" + "00".repeat(256), sha3Uncles: keccak256("0x"), stateRoot: keccak256("0x01"), receiptsRoot: keccak256("0x02"), transactionsRoot: keccak256("0x03"),
  size: "0x100", baseFeePerGas: "0x1", transactions: [], uncles: [] });
function call(to, data) {
  to = to.toLowerCase();
  if (to === MC3) {
    const { args: [calls] } = decodeFunctionData({ abi: mcAbi, data });
    return encodeFunctionResult({ abi: mcAbi, functionName: "aggregate3", result: calls.map((c) => ({ success: true, returnData: call(c.target, c.callData) })) });
  }
  if (to === OWNERSHIP) {
    const d = decodeFunctionData({ abi: ownAbi, data });
    if (d.functionName === "registry") return encodeFunctionResult({ abi: ownAbi, functionName: "registry", result: REGISTRY });
    return encodeFunctionResult({ abi: ownAbi, functionName: "authority", result: [OWNER, "0x" + "00".repeat(20), 1n, "0x" + "00".repeat(32)] });
  }
  if (to === CATALOG) {
    const d = decodeFunctionData({ abi: catAbi, data });
    const app = d.args[0];
    if (d.functionName === "getApp") return encodeFunctionResult({ abi: catAbi, functionName: "getApp", result: { appId: app, publisher: OWNER, slug: "s", name: "n", description: "d", versionCount: 3, createdAt: 1n, updatedAt: 1n, active: true } });
    return encodeFunctionResult({ abi: catAbi, functionName: "getVersion", result: { cid: "bafy", version: "1", vramMb: 0, gpuGflops: 0, memMb: 64, cpuGflops: 1, createdAt: 1n, verified: true,
      yanked: state.yanked.has(app.toLowerCase()), ports: "", approval: 1, config: "" } });
  }
  throw new Error("unexpected call target " + to);
}
// ---- one mock RPC: mode "ok" | "deny" (HTTP 429 like base.drpc.org) | {bucket: n per windowMs} ----
function mockRpc(name) {
  const m = { name, mode: "ok", http: 0, rpc: 0, denied: 0, tokens: [], srv: null, url: null };
  m.srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      m.http++;
      const limited = (m.mode === "readDeny" && /eth_call|eth_getBlockByNumber/.test(b)) || m.mode === "deny" || (m.mode && m.mode.until && Date.now() < m.mode.until) || (typeof m.mode === "object" && m.mode.n && (() => { const now = Date.now(); m.tokens = m.tokens.filter((t) => now - t < m.mode.windowMs); if (m.tokens.length >= m.mode.n) return true; m.tokens.push(now); return false; })());
      if (limited) { m.denied++; res.writeHead(429, { "content-type": "application/json" }); return res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 15, message: "You reached Public endpoint rate limit, please upgrade to paid plan" } })); }
      const q = JSON.parse(b), one = (r) => {
        m.rpc++;
        try {
          if (r.method === "eth_chainId") return { jsonrpc: "2.0", id: r.id, result: "0x2105" };
          if (r.method === "eth_blockNumber") return { jsonrpc: "2.0", id: r.id, result: toHex(head()) };
          if (r.method === "eth_getBlockByNumber") return { jsonrpc: "2.0", id: r.id, result: blockOf(BigInt(r.params[0])) };
          if (r.method === "eth_call") return { jsonrpc: "2.0", id: r.id, result: call(r.params[0].to, r.params[0].data || r.params[0].input) };
          return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: "method not found " + r.method } };
        } catch (e) { return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: e.message } }; }
      };
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(Array.isArray(q) ? q.map(one) : one(q)));
    });
  });
  return m;
}
const SET = process.env.RPCSET === "5" ? ["publicnode", "tenderly", "nodies", "drpc", "mainnet"] : ["publicnode", "drpc", "mainnet"];
const rpcs = SET.map(mockRpc);
for (const m of rpcs) { m.srv.listen(0, "127.0.0.1"); await once(m.srv, "listening"); m.url = `http://127.0.0.1:${m.srv.address().port}`; }
test.after(() => { for (const m of rpcs) { m.srv.closeAllConnections?.(); m.srv.close(); } });
const reset = (modes = {}) => { for (const m of rpcs) { m.mode = modes[m.name] ?? "ok"; m.http = 0; m.rpc = 0; m.denied = 0; m.tokens = []; } state.yanked.clear(); };
const total = () => rpcs.reduce((a, m) => a + m.http, 0);
