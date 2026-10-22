// Resource bounds of the relay's lease-generation reader (root review, work/storage-front-cold-history-root-review.txt):
//   - a response body is read as a stream and cut at 4 MiB (an endless provider stream never fills memory);
//   - a cancelled read (AbortSignal) reaches the PENDING requests (their sockets close) and sends nothing after it;
//   - rate-limit backoff sleeps are cancelled with it, and a cancelled read saves no coverage;
//   - the tracker is single-flight (ticks never overlap) and each tick is bounded; stop() cancels the running tick.
// Real HTTP servers and the real reader; the chain cases use the rev-16d rig (anvil).
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { createLeaseGenerationReader, boundedText, startTracker, memoryStore } from "../relay/lease-generation.mjs";
import { startLease16dRig } from "./helpers/lease16d-rig.mjs";

const anvil = (() => { try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); return false; } catch { return "needs anvil"; } })();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ID = "0x" + "11".repeat(32), LEDGER = "0x" + "ab".repeat(20);
const servers = [];
async function server(handler) {
  const s = http.createServer(handler); await new Promise((ok) => s.listen(0, "127.0.0.1", ok));
  servers.push(s); return `http://127.0.0.1:${s.address().port}`;
}
after(async () => { for (const s of servers) { s.closeAllConnections?.(); await new Promise((ok) => s.close(ok)); } });

test("a response body is cut at 4 MiB while streaming: an endless provider stream is never buffered", async () => {
  // the helper itself, on an endless in-process stream: refused past the bound, and the stream is cancelled
  let cancelled = false, produced = 0;
  const body = new ReadableStream({ pull(c) { produced += 65536; c.enqueue(new Uint8Array(65536)); }, cancel() { cancelled = true; } });
  await assert.rejects(boundedText(new Response(body)), /reply too large/);
  assert.ok(cancelled, "the stream was cancelled"); assert.ok(produced <= (4 << 20) + 3 * 65536, `read ${produced} bytes`);
  // a declared length over the bound is refused before reading
  await assert.rejects(boundedText(new Response("x", { headers: { "content-length": String(5 << 20) } })), /reply too large/);
  // and through the reader: two providers streaming forever; each connection is closed after ~4 MiB
  const sent = [], closed = [];
  const endless = (i) => server((req, res) => {
    sent[i] = 0; res.writeHead(200, { "content-type": "application/json" });
    const chunk = Buffer.alloc(65536, 0x20);
    const pump = () => { while (!res.destroyed && res.write(chunk)) sent[i] += chunk.length; if (!res.destroyed) res.once("drain", pump); };
    res.on("close", () => { closed[i] = true; }); res.write('{"jsonrpc":"2.0","id":1,"result":"'); pump();
  });
  const R = createLeaseGenerationReader({ rpcs: [await endless(0), await endless(1)], ledger: LEDGER, fromBlock: 0, timeoutMs: 20000 });
  const t0 = Date.now();
  await assert.rejects(R.writerAuthority(ID), (e) => e.code === "quorum_unavailable" && /reply too large/.test(e.message));
  assert.ok(Date.now() - t0 < 10000, "refused while streaming, not at the request timeout");
  await sleep(200);
  assert.deepEqual(closed, [true, true], "both endless connections were closed");
  for (const n of sent) assert.ok(n < 16 << 20, `a provider streamed ${n} bytes before the close`);
});

test("a cancelled read reaches its pending requests and sends nothing after the cancellation", async () => {
  const seen = [], closed = [];
  const hang = (i) => server((req) => { seen.push(i); req.socket.on("close", () => closed.push(i)); });   // never answers
  const R = createLeaseGenerationReader({ rpcs: [await hang(0), await hang(1)], ledger: LEDGER, fromBlock: 0, timeoutMs: 60000 });
  const ac = new AbortController(), t0 = Date.now();
  setTimeout(() => ac.abort(new Error("caller deadline")), 300);
  await assert.rejects(R.writerAuthority(ID, { signal: ac.signal }), (e) => e.code === "aborted" || /abort|deadline/i.test(e.message));
  assert.ok(Date.now() - t0 < 2000, "the cancellation ended the read, not the 60 s request timeout");
  await sleep(300);
  assert.equal(seen.length, 2, "one request per provider was pending"); assert.equal(closed.length, 2, "both pending requests' sockets were closed");
  const n = seen.length; await sleep(1000);
  assert.equal(seen.length, n, "no request after the cancellation");
  // a signal already aborted sends nothing at all
  const before = seen.length; const done = new AbortController(); done.abort();
  await assert.rejects(R.writerAuthority(ID, { signal: done.signal }), (e) => e.code === "aborted");
  await sleep(100); assert.equal(seen.length, before);
});

test("the tracker is single-flight and bounded; stop() cancels the running tick", async () => {
  let active = 0, maxActive = 0, calls = 0, cancelledReads = 0;
  const reader = { tracked: () => ["8453|l|0xa", "8453|l|0xb", "8453|l|0xc"],
    track: async (id, { signal }) => { calls++; active++; maxActive = Math.max(maxActive, active);
      try { await new Promise((ok, no) => { const t = setTimeout(ok, 150); signal.addEventListener("abort", () => { clearTimeout(t); cancelledReads++; no(signal.reason); }, { once: true }); }); }
      finally { active--; } } };
  const T = startTracker(reader, { intervalMs: 40, tickBudgetMs: 10_000 });
  await sleep(1200);
  assert.equal(maxActive, 1, "never two tracks at once"); assert.ok(T.stats().skipped > 5, `ticks found the previous one running: ${JSON.stringify(T.stats())}`);
  await T.stop();
  assert.ok(cancelledReads >= 1 || !T.stats().running, "the running read was cancelled"); assert.equal(T.stats().running, false);
  const n = calls; await sleep(300); assert.equal(calls, n, "nothing after stop()");
  // a tick's budget cancels its read in progress and the leases after it are not started
  let budgetCalls = 0;
  const slow = { tracked: () => ["8453|l|0xa", "8453|l|0xb", "8453|l|0xc"],
    track: (id, { signal }) => { budgetCalls++; return new Promise((ok, no) => { const t = setTimeout(ok, 5000); signal.addEventListener("abort", () => { clearTimeout(t); no(signal.reason); }, { once: true }); }); } };
  const B = startTracker(slow, { intervalMs: 60_000, tickBudgetMs: 200 });
  const t0 = Date.now(); await B.tick();
  assert.ok(Date.now() - t0 < 1500, "the tick ended at its budget"); assert.equal(budgetCalls, 1, "the leases after the cancelled one were not started");
  await B.stop();
});

test("on the chain: rate-limit backoff is cancelled with the read, nothing is sent after it, and no coverage is saved", { skip: anvil, timeout: 120000 }, async () => {
  const rig = await startLease16dRig();
  try {
    rig.honest(10);
    const id = await rig.create(); await rig.claim(id, rig.hosts.a); await rig.mine(20);
    for (const p of rig.peers) p.mode.rateLimit = 1_000_000;          // every eth_getLogs: HTTP 429 (backoff 0.5, 1, 2, 4 s)
    const sets = []; const base = memoryStore();
    const store = { ...base, set: (k, v) => { sets.push(Date.now()); return base.set(k, v); } };
    const R = createLeaseGenerationReader({ rpcs: rig.peers.map((p) => p.url), ledger: rig.ledger, fromBlock: 0, store });
    const ac = new AbortController(), t0 = Date.now();
    setTimeout(() => ac.abort(new Error("release deadline")), 700);
    await assert.rejects(R.writerAuthority(id, { signal: ac.signal }), (e) => e.code === "aborted");
    const took = Date.now() - t0;
    assert.ok(took < 1500, `the backoff sleep was cancelled (took ${took} ms)`);
    const calls = rig.peers.map((p) => p.mode.calls.length);
    await sleep(2500);
    assert.deepEqual(rig.peers.map((p) => p.mode.calls.length), calls, "no request after the cancellation");
    assert.equal(sets.length, 0, "a cancelled read saved no coverage");
    // a cancellation AFTER a range completed: the read's completed progress is not saved either
    rig.honest(10);
    const id2 = await rig.create(); await rig.claim(id2, rig.hosts.a); await rig.mine(400);   // a backward search of several 50-block steps
    for (const p of rig.peers) p.mode.delayMs = 300;
    const sets2 = [], base2 = memoryStore();
    const R2 = createLeaseGenerationReader({ rpcs: rig.peers.map((p) => p.url), ledger: rig.ledger, fromBlock: 0, windowBlocks: 50,
      store: { ...base2, set: (k, v) => { sets2.push(v); return base2.set(k, v); } } });
    const ac2 = new AbortController(); setTimeout(() => ac2.abort(new Error("release deadline")), 500);   // after the first step, mid-second
    await assert.rejects(R2.writerAuthority(id2, { signal: ac2.signal }), (e) => e.code === "aborted");
    await sleep(800);
    assert.equal(sets2.length, 0, "no coverage saved by a cancelled read");
    // positive control: the same scan cut by its request BUDGET (not cancelled) keeps its finalized progress
    const R3 = createLeaseGenerationReader({ rpcs: rig.peers.map((p) => p.url), ledger: rig.ledger, fromBlock: 0, windowBlocks: 50, maxRequests: 2, store: base2 });
    await assert.rejects(R3.writerAuthority(id2), (e) => e.code === "scanning");
    assert.ok(base2.keys().length === 1, "an uncancelled attempt keeps its progress");
    // and the reader, uncancelled, gives the fact (nothing stale left behind)
    rig.honest(10);
    assert.equal((await R.writerAuthority(id)).fact.deployment, id);
  } finally { await rig.stop(); }
});
