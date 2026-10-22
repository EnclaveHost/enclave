// Offline tests of serial-fetch.mjs: per-origin serialization around the reviewed boundedFetch, with the real QuorumChain
// over real viem clients and fake JSON-RPC answers (no network).
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url)), PKG = path.resolve(HERE, ".."), W = path.resolve(PKG, "../..");
const { serializeFetch, serialPeers } = await import(path.join(PKG, "serial-fetch.mjs"));
const { boundedFetch } = await import(path.join(W, "wallet-handoff-bridge/tree/network/authority-profile.mjs"));
const { QuorumChain } = await import(path.join(W, "wallet-handoff-bridge/tree/cli/independent.mjs"));
const vreq = createRequire(path.join(W, "wallet-handoff-bridge/tree/cli/independent.mjs"));
const { createPublicClient, http: viemHttp } = await import(vreq.resolve("viem"));
const { base } = await import(vreq.resolve("viem/chains"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("one request at a time, in arrival order; results go to their own callers", async () => {
  let active = 0, max = 0; const order = [];
  const f = serializeFetch(async (url) => { active++; max = Math.max(max, active); order.push(url); await sleep(15 - Number(url)); active--; return `r${url}`; });
  const out = await Promise.all(["1", "2", "3", "4", "5"].map((u) => f(u)));
  assert.deepEqual(out, ["r1", "r2", "r3", "r4", "r5"]); assert.deepEqual(order, ["1", "2", "3", "4", "5"]);
  assert.equal(max, 1); assert.equal(f.stats().maxActive, 1); assert.equal(f.stats().active, 0);
});

test("a rejected request rejects only its caller and releases the next; a request aborted while queued is never sent", async () => {
  const sent = [];
  const f = serializeFetch(async (url) => { sent.push(url); await sleep(5); if (url === "bad") throw new Error("HTTP 429"); return url; });
  const ac = new AbortController();
  const p = [f("a"), f("bad"), f("c", { signal: ac.signal }), f("d")];
  ac.abort(new Error("caller timed out"));
  const r = await Promise.allSettled(p);
  assert.equal(r[0].value, "a"); assert.match(r[1].reason.message, /429/); assert.match(r[2].reason.message, /caller timed out/); assert.equal(r[3].value, "d");
  assert.deepEqual(sent, ["a", "bad", "d"], "the aborted one was never started");
});

test("the reviewed boundedFetch bounds are retained underneath: byte cap, redirect:'error', its own deadline; no viem retries", async () => {
  const seen = [];
  const inner = async (url, init) => { seen.push(init); return new Response("x".repeat(64), { status: 200, headers: { "content-type": "application/json" } }); };
  const f = serializeFetch(boundedFetch({ maxBytes: 16, timeoutMs: 1000, fetch: inner }));
  await assert.rejects(f("https://rpc.example", { method: "POST", body: "{}" }), /too large/);
  assert.equal(seen[0].redirect, "error"); assert.ok(seen[0].signal instanceof AbortSignal, "boundedFetch's own deadline signal");
  // through a viem client with retryCount 0: an HTTP 429 is ONE request, never retried
  let calls = 0;
  const [peer] = serialPeers({ rpcs: ["https://rpc-a.example"], createPublicClient, viemHttp, chain: base, boundedFetch, timeoutMs: 2000,
    inner: async () => { calls++; return new Response("rate limited", { status: 429 }); } });
  await assert.rejects(peer.client.getBlockNumber({ cacheTime: 0 }));
  assert.equal(calls, 1, "no retry");
});

/** fake JSON-RPC per peer: head, a fresh block, a balance (the snapshot's value); records concurrency */
function rpc({ head = 1000n, balance = 5n, hash = "0x" + "aa".repeat(32), fail = false } = {}) {
  const st = { active: 0, max: 0, n: 0 };
  const inner = async (url, init) => {
    st.active++; st.n++; st.max = Math.max(st.max, st.active);
    try {
      await sleep(3);
      if (fail) return new Response("rate limited", { status: 429 });
      const q = JSON.parse(init.body), one = (r) => {
        const res = { eth_chainId: "0x2105", eth_blockNumber: "0x" + head.toString(16), eth_getBalance: "0x" + balance.toString(16),
          eth_getBlockByNumber: { number: r.params?.[0], hash, parentHash: "0x" + "00".repeat(32), timestamp: "0x" + Math.floor(Date.now() / 1000).toString(16),
            transactions: [], gasLimit: "0x1", gasUsed: "0x0", baseFeePerGas: "0x1", logsBloom: "0x" + "00".repeat(256), miner: "0x" + "00".repeat(20),
            nonce: "0x0000000000000000", sha3Uncles: "0x" + "00".repeat(32), stateRoot: "0x" + "00".repeat(32), receiptsRoot: "0x" + "00".repeat(32),
            transactionsRoot: "0x" + "00".repeat(32), extraData: "0x", size: "0x1", uncles: [], mixHash: "0x" + "00".repeat(32), difficulty: "0x0", totalDifficulty: "0x0" } }[r.method];
        return { jsonrpc: "2.0", id: r.id, result: res };
      };
      return new Response(JSON.stringify(Array.isArray(q) ? q.map(one) : one(q)), { status: 200, headers: { "content-type": "application/json" } });
    } finally { st.active--; }
  };
  return { inner, st };
}
const chainOf = (fakes) => new QuorumChain({ chainId: 8453, quorum: 2, confirmations: 2, maxBlockAgeMs: 120000,
  clients: fakes.map((f, i) => serialPeers({ rpcs: [`https://rpc${i}.example`], createPublicClient, viemHttp, chain: base, boundedFetch, timeoutMs: 3000, inner: f.inner })[0]) });
const read = (c, blockNumber) => Promise.all([c.getBalance({ address: "0x0b2d009c0c9Af05b12100D77F3c815fea822eE61", blockNumber }),
  c.getBalance({ address: "0x0b2d009c0c9Af05b12100D77F3c815fea822eE61", blockNumber }), c.getBalance({ address: "0x0b2d009c0c9Af05b12100D77F3c815fea822eE61", blockNumber })]);

test("QuorumChain over serialized peers: each peer max 1 in flight; 2 of 3 agree (one rate-limited) -> the agreed value at one block", async () => {
  const f = [rpc({ balance: 7n }), rpc({ balance: 7n }), rpc({ fail: true })];
  const s = await chainOf(f).snapshot(read);
  assert.deepEqual(s.value, [7n, 7n, 7n]); assert.equal(s.agreeing, 2); assert.equal(s.blockNumber, 998n);
  for (const x of f.slice(0, 2)) { assert.equal(x.st.max, 1, "one request at a time per peer"); assert.ok(x.st.n >= 5); }
  assert.ok(s.failures.some((m) => /rpc2\.example/.test(m)), "the rate-limited peer is reported, not counted");
});

test("quorum disagreement is unchanged: no two peers agree -> QuorumError; serialization never manufactures agreement", async () => {
  await assert.rejects(chainOf([rpc({ balance: 1n }), rpc({ balance: 2n }), rpc({ balance: 3n })]).snapshot(read), /no 2 RPCs agreed/);
  await assert.rejects(chainOf([rpc({ balance: 1n }), rpc({ fail: true }), rpc({ fail: true })]).snapshot(read), /quorum unavailable|no 2 RPCs agreed/);
});
