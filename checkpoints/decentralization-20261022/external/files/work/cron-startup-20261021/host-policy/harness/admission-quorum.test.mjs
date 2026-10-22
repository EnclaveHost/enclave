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
      const limited = m.mode === "deny" || (m.mode && m.mode.until && Date.now() < m.mode.until) || (typeof m.mode === "object" && m.mode.n && (() => { const now = Date.now(); m.tokens = m.tokens.filter((t) => now - t < m.mode.windowMs); if (m.tokens.length >= m.mode.n) return true; m.tokens.push(now); return false; })());
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
const rpcs = ["publicnode", "tenderly", "nodies", "drpc", "mainnet"].map(mockRpc);
for (const m of rpcs) { m.srv.listen(0, "127.0.0.1"); await once(m.srv, "listening"); m.url = `http://127.0.0.1:${m.srv.address().port}`; }
test.after(() => { for (const m of rpcs) { m.srv.closeAllConnections?.(); m.srv.close(); } });
const reset = (modes = {}) => { for (const m of rpcs) { m.mode = modes[m.name] ?? "ok"; m.http = 0; m.rpc = 0; m.denied = 0; m.tokens = []; } state.yanked.clear(); };
const total = () => rpcs.reduce((a, m) => a + m.http, 0);
const admission = (opts = {}) => createHostAdmission({ hostId: HOST, ownershipContract: OWNERSHIP, registry: REGISTRY, catalog: CATALOG, rpc: rpcs.map((m) => m.url),
  addressBook: BOOK, policyDirectory: "", policyOrigins: [], ...opts });
const ref = (app, v = 1) => `catalog://${app}/${v}`;
const dep = (i) => "0x" + i.toString(16).padStart(64, "0");
const report = (k, v) => console.log(`# METRIC ${k} ${JSON.stringify(v)}`);

test("an allowed deployment is allowed and a yanked version is refused (platform moderation enforced)", async () => {
  reset(); const a = admission();
  assert.equal(await a.refusal({ deploymentId: dep(1), appRef: ref(APP(1)) }), null);
  state.yanked.add(APP(2).toLowerCase());
  assert.match(String(await a.refusal({ deploymentId: dep(2), appRef: ref(APP(2)) })), /yank|withdrawn|not available|version/i);
});

test("MEASURE request volume of ONE node tick: 8 deployments, 3 admission checks each (scan, sweep, ensureApp), same app", async () => {
  reset(); const a = admission();
  for (let i = 1; i <= 8; i++) for (let k = 0; k < 3; k++) assert.equal(await a.refusal({ deploymentId: dep(i), appRef: ref(APP(7)) }), null);
  report("sameApp24", { http: total(), perCheck: +(total() / 24).toFixed(1) });
});

test("MEASURE request volume of ONE node tick: 8 deployments of 8 different apps, 3 checks each", async () => {
  reset(); const a = admission();
  for (let i = 1; i <= 8; i++) for (let k = 0; k < 3; k++) assert.equal(await a.refusal({ deploymentId: dep(i), appRef: ref(APP(10 + i)) }), null);
  report("distinctApps24", { http: total(), perCheck: +(total() / 24).toFixed(1) });
});

test("MEASURE concurrent checks of one app", async () => {
  reset(); const a = admission();
  await a.refusal({ deploymentId: dep(1), appRef: ref(APP(20)) });   // authority now cached
  const before = total();
  const r = await Promise.all([1, 2, 3, 4, 5].map((i) => a.refusal({ deploymentId: dep(i), appRef: ref(APP(21)) })));
  assert.deepEqual(r, [null, null, null, null, null]);
  report("concurrent5", { http: total() - before });
});

test("MEASURE (SYNTHETIC stress, not measured production limits; only drpc's 429 was observed) under drpc always 429, mainnet 12 req/10 s: one tick of 24 checks over 8 apps", async () => {
  reset({ drpc: "deny", mainnet: { n: 12, windowMs: 10_000 }, tenderly: { n: 40, windowMs: 10_000 }, nodies: { n: 40, windowMs: 10_000 }, publicnode: { n: 60, windowMs: 10_000 } });
  const a = admission(); let unknown = 0; const reasons = new Set();
  for (let i = 1; i <= 8; i++) for (let k = 0; k < 3; k++) {
    try { await a.refusal({ deploymentId: dep(i), appRef: ref(APP(40 + i)) }); } catch (e) { unknown++; reasons.add(e.message.slice(0, 160)); }
  }
  report("limitedTick", { unknown, of: 24, http: total(), denied: rpcs.reduce((x, m) => x + m.denied, 0), reasons: [...reasons].slice(0, 3) });
  // MEASUREMENT (no assertion): how many checks of one modelled tick come back UNKNOWN (each holds a deployment, retires its VM)
});

test("a quorum failure is still UNKNOWN (thrown, never allow), names the failing providers' reasons, and leaks no URL", async () => {
  reset({ publicnode: "deny", tenderly: "deny", nodies: "deny", drpc: "deny", mainnet: "deny" });
  const a = admission();
  await assert.rejects(a.refusal({ deploymentId: dep(1), appRef: ref(APP(60)) }), (e) => {
    report("failureMessage", e.message.slice(0, 300));
    assert.match(e.message, /chain quorum unavailable|no fresh agreeing chain quorum/);
    assert.match(e.message, /RPC failure/, "the per-RPC reasons are in the message");
    assert.match(e.message, /127\.0\.0\.1:\d+: head (HTTP 429 |code 15 )/, "each reason names the RPC (its label) and the status or JSON-RPC code");
    assert.match(e.message, /rate limit/i, "the provider's own words (rate limit) are kept");
    assert.doesNotMatch(e.message, /127\.0\.0\.1:\d+\/|\?/, "a label only: no path or query (where an RPC key would be)");
    return true;
  });
});

test("a failed read is not cached: the next check after the RPCs recover reads again and is allowed", async () => {
  reset({ publicnode: "deny", tenderly: "deny", nodies: "deny", drpc: "deny", mainnet: "deny" });
  const a = admission();
  await assert.rejects(a.refusal({ deploymentId: dep(1), appRef: ref(APP(61)) }));
  reset();
  assert.equal(await a.refusal({ deploymentId: dep(1), appRef: ref(APP(61)) }), null);
});

test("a cached verdict lives at most cacheMs: a yank is enforced once it passes, and an expired verdict never covers a failing read", async () => {
  reset(); const a = admission({ cacheMs: 1000 });
  assert.equal(await a.refusal({ deploymentId: dep(1), appRef: ref(APP(62)) }), null);
  state.yanked.add(APP(62).toLowerCase());
  await new Promise((r) => setTimeout(r, 1100));
  assert.match(String(await a.refusal({ deploymentId: dep(1), appRef: ref(APP(62)) })), /yank|withdrawn|not available|version/i, "the yank is enforced after cacheMs");
  state.yanked.clear();
  assert.equal(await a.refusal({ deploymentId: dep(2), appRef: ref(APP(63)) }), null);
  await new Promise((r) => setTimeout(r, 1100));
  for (const m of rpcs) m.mode = "deny";
  await assert.rejects(a.refusal({ deploymentId: dep(2), appRef: ref(APP(63)) }), "an expired verdict is never served for a failing read");
});

test("R1 a transient 429 window on every RPC (4 s) is ridden out WITHIN the quorum deadline: allowed, not unknown", async () => {
  reset(); const a = admission();
  const until = Date.now() + 4000; for (const m of rpcs) m.mode = { until };
  const t0 = Date.now();
  const r = await a.refusal({ deploymentId: dep(1), appRef: ref(APP(70)) }).then((v) => ({ v }), (e) => ({ e: e.message }));
  report("transient429", { ms: Date.now() - t0, result: r.e ? "UNKNOWN: " + r.e.slice(0, 120) : r.v });
  assert.ok(!r.e, `a 4 s rate-limit window turned the policy UNKNOWN: ${r.e}`);
  assert.equal(r.v, null);
});

test("R2 a permanently rate-limited RPC (drpc) does not delay two healthy agreeing answers", async () => {
  reset({ drpc: "deny" }); const a = admission();
  const t0 = Date.now();
  assert.equal(await a.refusal({ deploymentId: dep(1), appRef: ref(APP(71)) }), null);
  report("permanent429peer", { ms: Date.now() - t0 });
  assert.ok(Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
});

test("R3 every RPC permanently 429: still UNKNOWN by the deadline (never allow), and nothing is sent after the decision", async () => {
  reset({ publicnode: "deny", tenderly: "deny", nodies: "deny", drpc: "deny", mainnet: "deny" }); const a = admission();
  const t0 = Date.now();
  await assert.rejects(a.refusal({ deploymentId: dep(1), appRef: ref(APP(72)) }), /quorum/);
  const ms = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 300));   // a request issued BEFORE the decision may still be landing
  const after = total();
  await new Promise((r) => setTimeout(r, 5000));
  report("all429", { ms, requests: after, afterDecision: total() - after });
  assert.ok(ms <= 31000, `${ms} ms: past the 30 s deadline`);
  assert.equal(total() - after, 0, "requests were sent after the decision");
});
