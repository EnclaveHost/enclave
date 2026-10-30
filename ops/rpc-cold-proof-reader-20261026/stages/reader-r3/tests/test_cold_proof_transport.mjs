// Offline tests for the cold-proof-timeout reader change (PREPARED; NOT run by Claude: r3 jobs/root-cold-proof-tests.sh, exactly 13).
// The job assembles PRIVATE copies of the pinned l1-anchor-a1/ and a1-original-game-prepared/ trees (r12-final bundle origins) with
// THIS stage's two readers overlaid, and runs: node --test --test-reporter=tap. env: A1_DIR, RECHECK_DIR (private trees),
// ANCHOR_DEPS_ROOT (pinned deps), CFG (a REAL derived a1-config.json, sha-pinned by the job). Mock JSON-RPC servers bind 127.0.0.1 only.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
const D = process.env.A1_DIR, RD = process.env.RECHECK_DIR;
const R = await import(pathToFileURL(path.join(D, "a1-read.mjs")).href);
const AN = await import(pathToFileURL(path.join(D, "a1-anchor.mjs")).href);
const { keccak_256 } = await import(pathToFileURL(path.join(D, "test/deps.mjs")).href);
const CFG = JSON.parse(fs.readFileSync(process.env.CFG, "utf8"));

// the REAL reader CLIs run as ASYNC children (r3: spawnSync blocked this process's mock-server event loop), bounded, output collected
function runCli(args, env, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] }); let out = "", err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    const k = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`CLI timed out after ${timeoutMs} ms; stderr: ${err.slice(-300)}`)); }, timeoutMs);
    p.on("error", (e) => { clearTimeout(k); reject(e); });
    p.on("close", (code, signal) => { clearTimeout(k); resolve({ code, signal, out, err }); });
  });
}
// behaviour per method: { delay, status, raw, result, error }
async function mock(plan) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      const j = JSON.parse(b); seen.push(j.method); const p = plan[j.method] || {};
      setTimeout(() => {
        if (p.status) { res.writeHead(p.status); res.end("x"); return; }
        const body = p.raw !== undefined ? p.raw(j) : JSON.stringify(p.error ? { jsonrpc: "2.0", id: j.id, error: p.error } : { jsonrpc: "2.0", id: j.id, result: p.result ?? "0x1" });
        res.writeHead(200, { "content-type": "application/json" }); res.end(body);
      }, p.delay || 0);
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${srv.address().port}/`, seen, close: () => { srv.closeAllConnections?.(); srv.close(); } };
}

test("constants: 20 s transport, 60 s proof class (eth_call, eth_getProof only), 200 s budget below capture's 240 s a1_timeout", () => {
  assert.equal(R.TRANSPORT_TIMEOUT_MS, 20000); assert.equal(R.PROOF_TIMEOUT_MS, 60000);
  assert.deepEqual([...R.PROOF_METHODS], ["eth_call", "eth_getProof"]); assert.ok(R.READ_BUDGET_MS < 240000 && R.READ_BUDGET_MS >= 3 * R.PROOF_TIMEOUT_MS);
});

test("rpc(url, {timeoutMs}) keeps explicit short-deadline semantics for EVERY method (proof class defaults to timeoutMs)", async () => {
  const m = await mock({ eth_call: { delay: 300 }, eth_getProof: { delay: 300 } });
  try {
    const io = R.rpc(m.url, { timeoutMs: 100 });
    await assert.rejects(io("eth_call", []), /abort|timeout/i); await assert.rejects(io("eth_getProof", []), /abort|timeout/i);
  } finally { m.close(); }
});

test("proofTimeoutMs applies to proof-bearing methods only; other methods keep timeoutMs", async () => {
  const m = await mock({ eth_call: { delay: 300 }, eth_getProof: { delay: 300 }, eth_blockNumber: { delay: 300 }, eth_getBlockByHash: { delay: 300 } });
  try {
    const io = R.rpc(m.url, { timeoutMs: 100, proofTimeoutMs: 2000 });
    assert.equal(await io("eth_getProof", ["0x0", [], "0x1"]), "0x1"); assert.equal(await io("eth_call", [{}, "0x1"]), "0x1");
    await assert.rejects(io("eth_blockNumber", []), /abort|timeout/i); await assert.rejects(io("eth_getBlockByHash", ["0x0", false]), /abort|timeout/i);
  } finally { m.close(); }
});

test("the read budget caps a proof request and an exhausted budget refuses BEFORE sending", async () => {
  const m = await mock({ eth_getProof: { delay: 600 } });
  try {
    let t = 1_000_000; const now = () => t;
    const io = R.rpc(m.url, { timeoutMs: 100, proofTimeoutMs: 5000, deadline: t + 150, now });
    const t0 = Date.now(); await assert.rejects(io("eth_getProof", []), /abort|timeout/i); assert.ok(Date.now() - t0 < 1500);
    t = 1_000_200; const n = m.seen.length;
    await assert.rejects(io("eth_getProof", []), /budget exhausted/); assert.equal(m.seen.length, n, "no request sent after the budget");
  } finally { m.close(); }
});

test("no retry: a timeout, an HTTP error and a JSON-RPC error each cost exactly ONE request", async () => {
  const m = await mock({ eth_getProof: { delay: 300 }, eth_call: { status: 503 }, eth_chainId: { error: { code: -32000, message: "boom" } } });
  try {
    const io = R.rpc(m.url, { timeoutMs: 100 });
    await assert.rejects(io("eth_getProof", [])); await assert.rejects(io("eth_call", []), /HTTP 503/); await assert.rejects(io("eth_chainId", []), /-32000: boom/);
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(m.seen, ["eth_getProof", "eth_call", "eth_chainId"]);
  } finally { m.close(); }
});

test("envelope and size rules unchanged for the long proof class (wrong id, result+error, non-JSON, oversize)", async () => {
  const big = "0x" + "ab".repeat(4096);
  const plans = [[{ raw: (j) => JSON.stringify({ jsonrpc: "2.0", id: j.id + 1, result: "0x1" }) }, /envelope/],
                 [{ raw: (j) => JSON.stringify({ jsonrpc: "2.0", id: j.id, result: "0x1", error: { code: 1, message: "x" } }) }, /envelope/],
                 [{ raw: () => "{not json" }, /JSON|Unexpected|token/i], [{ result: big }, /too large/]];
  for (const [p, re] of plans) {
    const m = await mock({ eth_getProof: p });
    try { await assert.rejects(R.rpc(m.url, { proofTimeoutMs: 5000, maxBytes: 1024 })("eth_getProof", []), re); } finally { m.close(); }
  }
});

test("malformed proof bodies that pass transport are still refused by the UNCHANGED proof verifier (checkProofResponse)", () => {
  const root = "0x" + "11".repeat(32), k = (b) => keccak_256(b);
  for (const bad of [{}, { accountProof: "x" }, { address: "0x" + "22".repeat(20), accountProof: [], storageProof: [] },
                     { address: "0x" + "22".repeat(20), accountProof: ["0xzz"], storageProof: [] }]) {
    assert.throws(() => AN.checkProofResponse(root, bad, k));
  }
});

test("a1io: loopback-only URLs, production deadlines, one shared budget", async () => {
  assert.throws(() => R.a1io({ heliosUrl: "http://10.0.2.2:18550", elUrl: "http://127.0.0.1:18645" }), /loopback|127\.0\.0\.1/);
  assert.throws(() => R.a1io({ heliosUrl: "https://127.0.0.1:18550", elUrl: "http://127.0.0.1:18645" }));
  assert.throws(() => R.a1io({ heliosUrl: "http://127.0.0.1:18550", elUrl: "http://localhost:18645" }));
  let t = 0; const io = R.a1io({ heliosUrl: "http://127.0.0.1:9", elUrl: "http://127.0.0.1:9" }, { now: () => t, budgetMs: 1000 });
  t = 1001; await assert.rejects(io.el("eth_getProof", []), /budget exhausted/); await assert.rejects(io.helios("eth_chainId", []), /budget exhausted/);
});

test("checkFreshAfterRead: the pinned age rule holds when the read FINISHES (stale-after-read, future, missing timestamp)", () => {
  const max = AN.validateConfig(CFG).maxFinalizedAgeSec, now = 2_000_000_000_000, t = now / 1000;
  assert.equal(R.checkFreshAfterRead({ l1: { timestamp: t - 100 } }, CFG, now), 100);
  assert.equal(R.checkFreshAfterRead({ l1: { timestamp: t - max } }, CFG, now), max);
  assert.throws(() => R.checkFreshAfterRead({ l1: { timestamp: t - max - 1 } }, CFG, now), (e) => e.code === "finalized_stale_after_read");
  assert.throws(() => R.checkFreshAfterRead({ l1: { timestamp: t + 60 } }, CFG, now), (e) => e.code === "finalized_future");
  assert.throws(() => R.checkFreshAfterRead({ l1: {} }, CFG, now), (e) => e.code === "no_l1_timestamp");
  assert.throws(() => R.checkFreshAfterRead({ l1: { timestamp: t - 100 } }, { ...CFG, maxFinalizedAgeSec: 30 }, now), (e) => e.code === "bad_config");
});

test("both REAL reader CLIs (initial and original-game recheck) refuse through a1io against a live mock: wrong_chain, exit 3, one request", async () => {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "cli-")), env = { PATH: "/usr/bin:/bin", ANCHOR_DEPS_ROOT: process.env.ANCHOR_DEPS_ROOT };
  const m = await mock({ eth_chainId: { result: "0x2" } });
  try {
    const cfg = path.join(tmp, "a1-config.json"); fs.writeFileSync(cfg, JSON.stringify({ ...CFG, heliosUrl: m.url, elUrl: m.url }));
    const p = await runCli([path.join(D, "a1-read.mjs"), cfg], env);
    assert.equal(p.code, 3, p.err); const o = JSON.parse(p.out);
    assert.equal(o.verdict, "refused"); assert.equal(o.code, "wrong_chain", p.out); assert.deepEqual(m.seen, ["eth_chainId"]);
  } finally { m.close(); }
  const m2 = await mock({ eth_chainId: { result: "0x2" } });
  try {
    const ini = path.join(RD, "test/fixtures/initial-a1-evidence-1958.json"), rc = path.join(tmp, "recheck-config.json");
    fs.writeFileSync(rc, JSON.stringify({ heliosUrl: m2.url, elUrl: m2.url, expectedChainId: 1, pinBy: "hash",
      portal: "0x49048044d57e1c92a77f79988d21fa8faf74e97e", asr: "0x909f6cf47ed12f010a796527f562bfc26c7f4e72", portalAsrGetter: "anchorStateRegistry()",
      maxFinalizedAgeSec: 1800, initialEvidenceSha256: "b9a90847bb3f779262681cabc35af64d7c3b785c9ad5cd2b99e9700b9725256c",
      originalGame: "0x343b3a99527af07d2cfb2652747b9e37715e21ac", originalN: "52866960",
      originalOutputRoot: "0xa996c517b0e797b56426059d57c93ac8352b21b61e04b2fc66866dd61d056700" }));
    const p = await runCli([path.join(RD, "a1-recheck-read.mjs"), rc, ini], env);
    assert.equal(p.code, 3, p.err); const o = JSON.parse(p.out);
    assert.equal(o.verdict, "refused"); assert.equal(o.code, "wrong_chain", p.out); assert.deepEqual(m2.seen, ["eth_chainId"]);
  } finally { m2.close(); }
  const src = fs.readFileSync(path.join(RD, "a1-recheck-read.mjs"), "utf8");
  assert.match(src, /const io = a1io\(cfg\);/); assert.match(src, /runRecheck\(cfg, initial, io,/); assert.match(src, /finishRead\(io, out, cfg, end\)/);
  assert.doesNotMatch(src, /\brpc\(loopbackUrl/);
  const main = fs.readFileSync(path.join(D, "a1-read.mjs"), "utf8"); assert.match(main, /runA1\(cfg, io,/); assert.match(main, /finishRead\(io, out, cfg, end\)/);
  assert.equal(fs.readFileSync(path.join(RD, "a1-read.mjs"), "utf8"), main);
});

test("r2: the total MONOTONIC budget is enforced AFTER the last request (parse/crypto/evaluate time counts) and before emission", async () => {
  const m = await mock({ eth_getProof: { result: { ok: 1 } } });
  try {
    let t = 500; const io = R.a1io({ heliosUrl: m.url, elUrl: m.url }, { now: () => t, budgetMs: 1000 });
    assert.deepEqual(await io.el("eth_getProof", ["0x0", [], "0x1"]), { ok: 1 });        // the LAST request succeeds inside the budget
    t = 1500; assert.equal(io.checkBudget(), 1000);                                        // exactly at the budget: allowed
    t = 1501;                                                                              // post-request crypto/evaluation crossed it
    assert.throws(() => io.checkBudget(), (e) => e.code === "read_budget_exceeded");
    assert.equal(m.seen.length, 1, "the post-run check sends nothing");
    const wall = 2_000_000_000_000, fresh = { l1: { timestamp: wall / 1000 - 10 } };      // the wall-clock header age is fine ...
    assert.throws(() => R.finishRead(io, fresh, CFG, wall), (e) => e.code === "read_budget_exceeded");   // ... budget still refuses
  } finally { m.close(); }
});

test("r2: finishRead = budget (monotonic) then header age (wall clock); independent clocks; success returns both", () => {
  let t = 0; const io = R.a1io({ heliosUrl: "http://127.0.0.1:9", elUrl: "http://127.0.0.1:9" }, { now: () => t, budgetMs: 1000 });
  const max = AN.validateConfig(CFG).maxFinalizedAgeSec, wall = 2_000_000_000_000, s = wall / 1000;
  t = 400; assert.deepEqual(R.finishRead(io, { l1: { timestamp: s - 7 } }, CFG, wall), { usedMs: 400, ageSec: 7 });
  assert.throws(() => R.finishRead(io, { l1: { timestamp: s - max - 1 } }, CFG, wall), (e) => e.code === "finalized_stale_after_read");
  assert.throws(() => R.finishRead(io, { l1: {} }, CFG, wall), (e) => e.code === "no_l1_timestamp");
  t = 5000; assert.throws(() => R.finishRead(io, { l1: { timestamp: s - 7 } }, CFG, wall), (e) => e.code === "read_budget_exceeded");
  const real = R.a1io({ heliosUrl: "http://127.0.0.1:9", elUrl: "http://127.0.0.1:9" });  // default clock is monotonic performance.now
  assert.ok(real.checkBudget() >= 0 && real.checkBudget() < 1000);
});

test("r3: a FRACTIONAL remaining budget is floored to whole ms (valid AbortSignal), < 1 ms refuses before fetch, the real monotonic clock works", async () => {
  const m = await mock({ eth_getProof: { delay: 400 }, eth_call: { result: "0x2" } });
  try {
    let t = 1000.25; const io = R.rpc(m.url, { timeoutMs: 20000, proofTimeoutMs: 60000, deadline: 1151, now: () => t });
    await assert.rejects(io("eth_getProof", []), (e) => e?.name === "TimeoutError" && !(e instanceof TypeError));   // 150.75 -> 150 ms
    t = 1000.5; assert.equal(await io("eth_call", []), "0x2");                                                      // 150.5 -> 150 ms, fast reply
    const n = m.seen.length; t = 1150.1;                                                                            // 0.9 ms left
    await assert.rejects(io("eth_call", []), /budget exhausted/); assert.equal(m.seen.length, n, "nothing sent with < 1 ms left");
    const real = R.a1io({ heliosUrl: m.url, elUrl: m.url });                                                        // performance.now: fractional
    assert.equal(await real.el("eth_call", []), "0x2"); assert.equal(await real.helios("eth_call", []), "0x2");
    assert.ok(real.checkBudget() < R.READ_BUDGET_MS);
  } finally { m.close(); }
});
