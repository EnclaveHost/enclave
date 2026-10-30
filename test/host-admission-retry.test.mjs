// Focused tests of the final host-admission quorum fix (rate-limit budget opt-in, gate re-check, head allSettled), against
// the REAL built bundle (ADMISSION_MODULE: createHostAdmission) and the shared source (LEASE_READER: LeaseReader). Five mock
// Base RPCs on loopback; every request's DISPATCH is recorded on the client side (globalThis.fetch, which viem resolves per
// request) and each response's completion on the server side. Nothing leaves loopback; no key.
//   node --test test/host-admission-retry.test.mjs   (or ADMISSION_MODULE=<bundle> LEASE_READER=<lease-reader.mjs> to test other builds)
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { decodeFunctionData, encodeFunctionResult, parseAbi, keccak256, toHex } from "viem";

// defaults: this repository's built Windows bundle and the shared source (override with ADMISSION_MODULE / LEASE_READER)
const { createHostAdmission } = await import(process.env.ADMISSION_MODULE || new URL("../windows/node/host-admission.bundle.mjs", import.meta.url).href);
const { LeaseReader } = await import(process.env.LEASE_READER || new URL("../network/lease-reader.mjs", import.meta.url).href);

// ---- client-side dispatch log ----
const DISPATCH = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  let methods = "?"; try { const q = JSON.parse(init?.body || "{}"); methods = (Array.isArray(q) ? q : [q]).map((x) => x.method).join("+"); } catch {}
  DISPATCH.push({ t: performance.now(), url: String(url), methods });
  return realFetch(url, init);
};
const dispatchedAfter = (t) => DISPATCH.filter((d) => d.t > t);

// ---- chain model ----
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
const state = { yanked: new Set() };
const T0 = Date.now(), B0 = 38_000_000n;
const head = () => B0 + BigInt(Math.floor((Date.now() - T0) / 2000));
const blockOf = (n) => ({ number: toHex(n), hash: keccak256(toHex(n)), parentHash: keccak256(toHex(n - 1n)), timestamp: toHex(Math.floor(T0 / 1000) + Number(n - B0) * 2),
  nonce: "0x0000000000000000", difficulty: "0x0", totalDifficulty: "0x0", gasLimit: "0x1c9c380", gasUsed: "0x0", miner: "0x" + "00".repeat(20), extraData: "0x",
  logsBloom: "0x" + "00".repeat(256), sha3Uncles: keccak256("0x"), stateRoot: keccak256("0x01"), receiptsRoot: keccak256("0x02"), transactionsRoot: keccak256("0x03"),
  size: "0x100", baseFeePerGas: "0x1", transactions: [], uncles: [] });
function call(to, data) {
  to = to.toLowerCase();
  if (to === MC3) { const { args: [calls] } = decodeFunctionData({ abi: mcAbi, data });
    return encodeFunctionResult({ abi: mcAbi, functionName: "aggregate3", result: calls.map((c) => ({ success: true, returnData: call(c.target, c.callData) })) }); }
  if (to === OWNERSHIP) { const d = decodeFunctionData({ abi: ownAbi, data });
    return d.functionName === "registry" ? encodeFunctionResult({ abi: ownAbi, functionName: "registry", result: REGISTRY })
      : encodeFunctionResult({ abi: ownAbi, functionName: "authority", result: [OWNER, "0x" + "00".repeat(20), 1n, "0x" + "00".repeat(32)] }); }
  if (to === CATALOG) { const d = decodeFunctionData({ abi: catAbi, data }), app = d.args[0];
    if (d.functionName === "getApp") return encodeFunctionResult({ abi: catAbi, functionName: "getApp", result: { appId: app, publisher: OWNER, slug: "s", name: "n", description: "d", versionCount: 3, createdAt: 1n, updatedAt: 1n, active: true } });
    return encodeFunctionResult({ abi: catAbi, functionName: "getVersion", result: { cid: "bafy", version: "1", vramMb: 0, gpuGflops: 0, memMb: 64, cpuGflops: 1, createdAt: 1n, verified: true,
      yanked: state.yanked.has(app.toLowerCase()), ports: "", approval: 1, config: "" } }); }
  throw new Error("unexpected call target " + to);
}
// ---- one mock RPC. mode: "ok" | "deny" (HTTP 429, drpc's real text) | "e500" (HTTP 500, not a rate limit) | {until} (429 until then)
//      delay: { method: ms } answers that method late (to hold a sibling request in flight) ----
function mockRpc(name) {
  const m = { name, mode: "ok", delay: {}, http: 0, done: [], srv: null, url: null };
  m.srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", async () => {
      m.http++;
      let q; try { q = JSON.parse(b); } catch { q = {}; }
      const methods = (Array.isArray(q) ? q : [q]).map((x) => x.method);
      const wait = Math.max(0, ...methods.map((x) => m.delay[x] || 0)); if (wait) await new Promise((r) => setTimeout(r, wait));
      const end = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); m.done.push({ t: performance.now(), methods: methods.join("+"), code }); };
      const limited = m.mode === "deny" || (typeof m.mode === "object" && Date.now() < m.mode.until && (!m.mode.only || methods.includes(m.mode.only)));
      if (limited) return end(429, { jsonrpc: "2.0", id: 1, error: { code: 15, message: "You reached Public endpoint rate limit, please upgrade to paid plan" } });
      if (m.mode === "e500") return end(500, { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "internal error" } });
      const one = (r) => {
        try {
          if (r.method === "eth_chainId") return { jsonrpc: "2.0", id: r.id, result: "0x2105" };
          if (r.method === "eth_blockNumber") return { jsonrpc: "2.0", id: r.id, result: toHex(head()) };
          if (r.method === "eth_getBlockByNumber") return { jsonrpc: "2.0", id: r.id, result: blockOf(BigInt(r.params[0])) };
          if (r.method === "eth_call") return { jsonrpc: "2.0", id: r.id, result: call(r.params[0].to, r.params[0].data || r.params[0].input) };
          return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: "method not found " + r.method } };
        } catch (e) { return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: e.message } }; }
      };
      end(200, Array.isArray(q) ? q.map(one) : one(q));
    });
  });
  return m;
}
const rpcs = ["publicnode", "tenderly", "nodies", "drpc", "mainnet"].map(mockRpc);
for (const m of rpcs) { m.srv.listen(0, "127.0.0.1"); await once(m.srv, "listening"); m.url = `http://127.0.0.1:${m.srv.address().port}`; }
test.after(() => { for (const m of rpcs) { m.srv.closeAllConnections?.(); m.srv.close(); } });
const reset = (modes = {}) => { for (const m of rpcs) { m.mode = modes[m.name] ?? "ok"; m.delay = {}; m.http = 0; m.done = []; } state.yanked.clear(); DISPATCH.length = 0; };
const byName = (n) => rpcs.find((m) => m.name === n);
const SECRET_PATH = "/v2/SECRETkey0123456789abcdef";   // an RPC URL may carry an API key in its path: it must never be echoed
const admission = (keyed = false) => createHostAdmission({ hostId: HOST, ownershipContract: OWNERSHIP, registry: REGISTRY, catalog: CATALOG, rpc: rpcs.map((m) => m.url + (keyed ? SECRET_PATH : "")),
  addressBook: BOOK, policyDirectory: "", policyOrigins: [] });
const reader = (opts = {}) => new LeaseReader({ rpc: rpcs.map((m) => m.url), addressBook: BOOK, ...opts });
const headRead = (r) => r.agreed(async (c, blockNumber) => ({ n: String(blockNumber) }));
const ref = (app, v = 1) => `catalog://${app}/${v}`;
const dep = (i) => "0x" + i.toString(16).padStart(64, "0");
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const timed = async (p) => { const t0 = performance.now(); try { return { v: await p, ms: performance.now() - t0, at: performance.now() }; } catch (e) { return { e, ms: performance.now() - t0, at: performance.now() }; } };

// ---- the admission (real bundle): the decision rules ----
test("B1 bounded all-429: UNKNOWN within the 10 s budget (not the 30 s deadline), reasons named, no URL path/key, nothing DISPATCHED after the decision", async () => {
  reset({ publicnode: "deny", tenderly: "deny", nodies: "deny", drpc: "deny", mainnet: "deny" });
  const r = await timed(admission(true).refusal({ deploymentId: dep(1), appRef: ref(APP(1)) }));
  assert.ok(r.e, "an all-429 quorum must never allow");
  assert.match(r.e.message, /quorum/);
  assert.match(r.e.message, /RPC failure/); assert.match(r.e.message, /rate limit|429/i);
  assert.doesNotMatch(r.e.message, /SECRET|\/v2\//, "the RPC URL's path (an API key) leaked into the reason");
  assert.ok(r.ms >= 5000 && r.ms <= 12500, `${Math.round(r.ms)} ms (budget 10 s: retried, then UNKNOWN well before 30 s)`);
  await settle(5000);
  assert.deepEqual(dispatchedAfter(r.at), [], "a request was DISPATCHED after the decision");
});

test("B2 mixed: one healthy RPC + one whose 429 window ends after 2.5 s (others 500/429): ridden out, ALLOWED", async () => {
  reset({ publicnode: "ok", mainnet: { until: Date.now() + 2500 }, tenderly: "e500", nodies: "e500", drpc: "deny" });
  const r = await timed(admission().refusal({ deploymentId: dep(2), appRef: ref(APP(2)) }));
  assert.ok(!r.e, `UNKNOWN: ${r.e?.message}`); assert.equal(r.v, null);
  assert.ok(r.ms >= 2000 && r.ms < 10000, `${Math.round(r.ms)} ms`);
});

test("B3 a permanently rate-limited RPC (drpc) does not delay two healthy agreeing answers", async () => {
  reset({ drpc: "deny" });
  const r = await timed(admission().refusal({ deploymentId: dep(3), appRef: ref(APP(3)) }));
  assert.equal(r.v, null); assert.ok(r.ms < 3000, `${Math.round(r.ms)} ms`);
});

test("B4 moderation is FRESH per call: a yank is refused on the very next check, an un-yank allowed on the next", async () => {
  reset(); const a = admission();
  assert.equal(await a.refusal({ deploymentId: dep(4), appRef: ref(APP(4)) }), null);
  state.yanked.add(APP(4).toLowerCase());
  assert.match(String(await a.refusal({ deploymentId: dep(4), appRef: ref(APP(4)) })), /yank|withdrawn|not available|version/i, "the yank is enforced at once (no cache)");
  state.yanked.clear();
  assert.equal(await a.refusal({ deploymentId: dep(4), appRef: ref(APP(4)) }), null);
});

// ---- LeaseReader (shared source): the opt-in, the default, the deadline ----
test("L1 DEFAULT reader (no option) keeps the original rule: all-429 -> fails fast, at most 3 head attempts per RPC", async () => {
  reset({ publicnode: "deny", tenderly: "deny", nodies: "deny", drpc: "deny", mainnet: "deny" });
  const r = await timed(headRead(reader()));
  assert.ok(r.e); assert.ok(r.ms < 4000, `${Math.round(r.ms)} ms`);
  for (const m of rpcs) assert.ok(m.done.filter((d) => d.methods === "eth_chainId").length <= 3, `${m.name}: ${m.done.length} answers`);
});

test("L2 short deadline: retries never outlive it (deadline 2.5 s, budget 2 s -> capped at deadline - 1 s)", async () => {
  reset({ publicnode: "deny", tenderly: "deny", nodies: "deny", drpc: "deny", mainnet: "deny" });
  const r = await timed(headRead(reader({ deadlineMs: 2500, rateLimitRetryMs: 2000 })));
  assert.ok(r.e); assert.ok(r.ms <= 2600, `${Math.round(r.ms)} ms past a 2.5 s deadline`);
  await settle(2000);
  assert.deepEqual(dispatchedAfter(r.at), [], "a request was DISPATCHED after the decision");
});

test("L3 a non-429 error is NOT retried, even with the budget: each failing RPC is asked once", async () => {
  reset({ publicnode: "e500", tenderly: "e500", nodies: "e500", drpc: "e500", mainnet: "e500" });
  const r = await timed(headRead(reader({ rateLimitRetryMs: 10000 })));
  assert.ok(r.e); assert.ok(r.ms < 2000, `${Math.round(r.ms)} ms`);
  for (const m of rpcs) assert.equal(m.done.filter((d) => d.methods === "eth_chainId").length, 1, `${m.name} was retried`);
});

test("L4 head attempt: a 429 on eth_chainId does not end the attempt while eth_blockNumber is in flight (allSettled)", async () => {
  reset();
  // every RPC: eth_chainId is rate-limited for 6 s; eth_blockNumber answers only after 1.5 s (longer than the first backoff)
  for (const m of rpcs) { m.mode = { until: Date.now() + 6000, only: "eth_chainId" }; m.delay = { eth_blockNumber: 1500 }; }
  const r = await timed(headRead(reader({ rateLimitRetryMs: 4000 })));
  assert.ok(r.e && /quorum/.test(r.e.message), "no head -> unknown");
  for (const m of rpcs) {
    const mine = DISPATCH.filter((d) => d.url.startsWith(m.url)).map((d) => d.t).sort((a, b) => a - b);
    assert.ok(mine.length >= 4, `${m.name}: ${mine.length} dispatches (expected at least one retry)`);
    mine.forEach((t, i) => {
      const earlier = i - (i % 2);                       // requests of EARLIER attempts (dispatched in pairs)
      const answered = m.done.filter((d) => d.t <= t + 1).length;
      assert.ok(answered >= earlier, `${m.name}: dispatch #${i + 1} sent while ${earlier - answered} earlier request(s) were still in flight`);
    });
  }
  await settle(1800);
  assert.deepEqual(dispatchedAfter(r.at), [], "a request was DISPATCHED after the decision");
});

test("L5 option validation: the budget must be a non-negative integer below the deadline", () => {
  for (const bad of [-1, 1.5, 30000, 99999]) assert.throws(() => reader({ rateLimitRetryMs: bad }), /rate-limit retry budget/, String(bad));
  assert.equal(reader({}).rateLimitRetryMs, 0, "default is the original rule");
});
