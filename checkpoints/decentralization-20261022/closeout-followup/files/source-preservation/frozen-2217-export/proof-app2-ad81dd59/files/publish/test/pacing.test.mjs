// The paced READ transport alone, with a fake clock (virtual time; no real sleeps) and a fake single-attempt rpc.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pacedTransport, checkPacing, retryAfterMs, PACING, Refusal } from "../lib/publish.mjs";

const A = "https://a.example/rpc", B = "https://b.example/rpc";
// discrete-event fake clock: sleepUntil registers a timer; drive() lets microtasks settle, then fires the earliest timer
// (advancing virtual time to it), until the awaited promise settles. Wall-clock time is never waited on.
function fakeClock(t0 = 1_000_000) {
  const c = { t: t0, timers: [], now: () => c.t, sleepUntil: (at) => new Promise((r) => c.timers.push({ at, r })) };
  return c;
}
async function drive(c, p) {
  let done = false, val, err;
  p.then((v) => { done = true; val = v; }, (e) => { done = true; err = e; });
  for (let spins = 0; !done; spins++) {
    await new Promise((r) => setImmediate(r));
    if (done) break;
    assert.ok(c.timers.length && spins < 10_000, "stuck: nothing pending in virtual time");
    c.timers.sort((a, b) => a.at - b.at);
    const x = c.timers.shift();
    c.t = Math.max(c.t, x.at); x.r();
  }
  if (err) throw err;
  return val;
}
// a fake rpc: script(url, method, attemptNo) -> value, or throws; records the virtual start time of every attempt
function fakeRpc(clock, script) {
  const log = [];
  const rpc = async (url, method) => {
    const k = `${url} ${method}`, n = log.filter((l) => l.k === k).length;
    log.push({ k, url, method, at: clock.now() });
    return script(url, method, n);
  };
  return { rpc, log };
}
const e429 = (retryAfter = null) => Object.assign(new Error("HTTP 429"), { status: 429, retryAfter });
const code = (c) => (e) => (e instanceof Refusal && e.code === c) || assert.fail(`expected ${c}, got ${e.code ?? e.message}`);

test("429 then success: retried with the short backoff, in virtual time", async () => {
  const clock = fakeClock(), { rpc, log } = fakeRpc(clock, (u, m, n) => { if (n < 2) throw e429(); return "0x1"; });
  const t = pacedTransport({ rpc, clock });
  assert.equal(await drive(clock, t.send(A, "eth_maxPriorityFeePerGas", [])), "0x1");
  assert.equal(t.stats.requests, 3); assert.equal(t.stats.retries429, 2);
  assert.deepEqual(log.map((l) => l.at - 1_000_000), [0, 500, 1500], "backoff 500 then 1000 ms (pacing 250 ms is shorter)");
  assert.ok(clock.t - 1_000_000 < 5_000, "no real time involved");
});

test("Retry-After is honoured when within the cap (delta seconds and HTTP date)", async () => {
  const clock = fakeClock(Date.parse("2026-10-23T22:00:00Z"));
  const { rpc, log } = fakeRpc(clock, (u, m, n) => { if (n === 0) throw e429("2"); if (n === 1) throw e429(new Date(clock.now() + 3_000).toUTCString()); return "ok"; });
  const t = pacedTransport({ rpc, clock });
  assert.equal(await drive(clock, t.send(A, "eth_chainId", [])), "ok");
  assert.deepEqual(log.map((l) => l.at - log[0].at), [0, 2_000, 5_000]);
  assert.equal(retryAfterMs("7", 0), 7_000); assert.equal(retryAfterMs("", 0), null); assert.equal(retryAfterMs("soon", 0), null);
});

test("Retry-After beyond the cap is not waited out: refused at once", async () => {
  const clock = fakeClock(), { rpc, log } = fakeRpc(clock, () => { throw e429("60"); });
  await assert.rejects(drive(clock, pacedTransport({ rpc, clock }).send(A, "eth_call", [])), code("rpc_rate_limited"));
  assert.equal(log.length, 1); assert.equal(clock.t, 1_000_000, "no wait at all");
});

test("exhausted 429: max429Retries retries, then rpc_rate_limited", async () => {
  const clock = fakeClock(), { rpc, log } = fakeRpc(clock, () => { throw e429(); });
  const t = pacedTransport({ rpc, clock });
  await assert.rejects(drive(clock, t.send(A, "eth_blockNumber", [])), code("rpc_rate_limited"));
  assert.equal(log.length, PACING.max429Retries + 1); assert.equal(t.stats.retries429, PACING.max429Retries);
});

test("non-429 errors fail at once, never retried", async () => {
  for (const err of [Object.assign(new Error("HTTP 503"), { status: 503 }), Object.assign(new Error("HTTP 403"), { status: 403 }),
    Object.assign(new Error("rpc: limit exceeded"), { rpcError: { code: -32005 } }), Object.assign(new Error("aborted"), { name: "TimeoutError" }), new TypeError("fetch failed")]) {
    const clock = fakeClock(), { rpc, log } = fakeRpc(clock, () => { throw err; });
    await assert.rejects(drive(clock, pacedTransport({ rpc, clock }).send(A, "eth_call", [])), (e) => e === err);
    assert.equal(log.length, 1, err.message);
  }
});

test("pacing: per provider at most one start per minIntervalMs; providers independent; concurrent callers queue", async () => {
  const clock = fakeClock(), { rpc, log } = fakeRpc(clock, () => "0x0");
  const t = pacedTransport({ rpc, clock });
  for (let i = 0; i < 3; i++) await drive(clock, Promise.all([t.send(A, "eth_call", []), t.send(B, "eth_call", [])]));
  await drive(clock, Promise.all([t.send(A, "x", []), t.send(A, "y", []), t.send(A, "z", [])]));         // concurrent on one provider
  const starts = (u) => log.filter((l) => l.url === u).map((l) => l.at - 1_000_000);
  assert.deepEqual(starts(A), [0, 250, 500, 750, 1000, 1250]);
  assert.deepEqual(starts(B), [0, 250, 500], "B is paced on its own clock slot, not behind A");
});

test("finite budgets: request count and time; a wait that would cross the deadline is not started", async () => {
  const clock = fakeClock(), { rpc } = fakeRpc(clock, () => "0x0");
  const small = { ...PACING, maxRequests: 3 };
  const t = pacedTransport({ rpc, clock, pacing: small });
  for (let i = 0; i < 3; i++) await drive(clock, t.send(A, "m", []));
  await assert.rejects(drive(clock, t.send(B, "m", [])), code("rpc_budget"));
  const c2 = fakeClock(), r2 = fakeRpc(c2, () => { throw e429("4"); });
  const tight = { ...PACING, timeBudgetMs: 3_000, freshnessMs: 3_000 };
  await assert.rejects(drive(c2, pacedTransport({ rpc: r2.rpc, clock: c2, pacing: tight }).send(A, "m", [])), code("rpc_budget"));
  assert.equal(c2.t, 1_000_000, "the 4 s wait past a 3 s budget never started");
});

test("pacing bounds: the time budget can never exceed the freshness window, and every knob is bounded", () => {
  assert.doesNotThrow(() => checkPacing(PACING));
  assert.throws(() => checkPacing({ ...PACING, timeBudgetMs: 90_000, freshnessMs: 60_000 }), /freshness/);
  assert.throws(() => checkPacing({ ...PACING, max429Retries: 9 }), /bounds/);
  assert.throws(() => checkPacing({ ...PACING, maxRequests: 1000 }), /bounds/);
  assert.throws(() => checkPacing({ ...PACING, retryAfterCapMs: 60_000 }), /bounds/);
  assert.throws(() => checkPacing({ ...PACING, backoffMs: [500] }), /bounds/);
  assert.ok(PACING.maxRequests >= 54 + 2 * PACING.max429Retries, "the fixed 54-read path plus a few retries fits");
});
