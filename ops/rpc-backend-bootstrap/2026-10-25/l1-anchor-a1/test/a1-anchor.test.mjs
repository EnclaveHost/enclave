// node --test test/a1-anchor.test.mjs   (ANCHOR_DEPS_ROOT=<checkout with node_modules>; see deps.mjs)
// Real vector: Helios upstream test data (helios 2af9b418, tests/testdata/rpc/{proof,block}.json): Ethereum mainnet
// block 0x14e8d38, the deposit contract's account proof and storage slot 1. Contract calls are MOCKED (Helios-call answers);
// the mock is the test's stand-in for the verifier, not evidence about Base.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keccak_256 } from "./deps.mjs";
import { headerHash } from "../vendor/anchor-bootstrap.mjs";
import { verifyMptProof, verifyAccount, verifyStorage, checkProofResponse, abi, callData, evaluateA1, runA1, validateConfig, A1Error, fromHex } from "../a1-anchor.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (n) => { const j = JSON.parse(fs.readFileSync(path.join(here, "fixtures", n), "utf8")); return j.result ?? j; };
const PROOF = load("helios-mainnet-proof.json"), BLOCK = load("helios-mainnet-block.json");
const k = (b) => keccak_256(b);
const code = (c) => (e) => e instanceof A1Error && e.code === c;
const clone = (x) => JSON.parse(JSON.stringify(x));
const word = (v) => "0x" + BigInt(v).toString(16).padStart(64, "0");
const addrWord = (a) => "0x" + a.slice(2).padStart(64, "0");

test("real mainnet proof: account and storage verify against the header's stateRoot; header hash recomputes", () => {
  assert.equal(headerHash(BLOCK, k), BLOCK.hash.toLowerCase());
  const a = verifyAccount(BLOCK.stateRoot, PROOF.address, PROOF.accountProof, k);
  assert.equal(a.storageRoot, PROOF.storageHash.toLowerCase());
  assert.equal(a.codeHash, PROOF.codeHash.toLowerCase());
  assert.equal(a.balance, BigInt(PROOF.balance));
  assert.equal(a.nonce, BigInt(PROOF.nonce));
  const sp = PROOF.storageProof[0];
  assert.equal(verifyStorage(a.storageRoot, sp.key, sp.proof, k), BigInt(sp.value));
  const v = checkProofResponse(BLOCK.stateRoot, PROOF, k);
  assert.equal(Object.values(v.storage)[0], BigInt(sp.value));
});

test("proof forgeries are refused", () => {
  const p = clone(PROOF);
  p.accountProof[3] = p.accountProof[3].slice(0, -2) + (p.accountProof[3].endsWith("00") ? "01" : "00");
  assert.throws(() => verifyAccount(BLOCK.stateRoot, PROOF.address, p.accountProof, k), code("proof_hash"));
  assert.throws(() => verifyAccount("0x" + "11".repeat(32), PROOF.address, PROOF.accountProof, k), code("proof_hash"));
  assert.throws(() => verifyAccount(BLOCK.stateRoot, PROOF.address, [...PROOF.accountProof, PROOF.accountProof[0]], k), code("proof_extra"));
  assert.throws(() => verifyAccount(BLOCK.stateRoot, PROOF.address, PROOF.accountProof.slice(0, -1), k), (e) => e instanceof A1Error);
  for (const [f, v] of [["balance", "0x1"], ["nonce", "0x5"], ["codeHash", "0x" + "00".repeat(32)], ["storageHash", "0x" + "22".repeat(32)]]) {
    assert.throws(() => checkProofResponse(BLOCK.stateRoot, { ...clone(PROOF), [f]: v }, k), (e) => e instanceof A1Error, f);
  }
  const s = clone(PROOF); s.storageProof[0].value = "0x1234";
  assert.throws(() => checkProofResponse(BLOCK.stateRoot, s, k), code("proof_json_mismatch"));
  // the same proof cannot vouch for another address: its path diverges (absent) or the proof breaks
  let other;
  try { other = verifyAccount(BLOCK.stateRoot, "0x" + "42".repeat(20), PROOF.accountProof, k); } catch (e) { other = e; }
  assert.ok(other instanceof A1Error || other.absent === true);
});

test("ABI decoding is strict", () => {
  assert.equal(abi.address(addrWord("0x" + "ab".repeat(20))), "0x" + "ab".repeat(20));
  assert.throws(() => abi.address("0x01" + "00".repeat(11) + "ab".repeat(20)), code("bad_return"));
  assert.throws(() => abi.bool(word(2)), code("bad_return"));
  assert.throws(() => abi.uint(word(256), 8), code("bad_return"));
  assert.throws(() => abi.bytes32("0x1234"), code("bad_return"));
  assert.equal(abi.rootAndNumber(word(5) + word(7).slice(2)).l2SequenceNumber, 7n);
});

// ---- runA1 against a mocked Helios (verifier) and the real proof from the untrusted EL ----------------------------
const ADDR = PROOF.address.toLowerCase(), SLOT = PROOF.storageProof[0].key, ROOT = "0x" + "aa".repeat(32), N = 12345, GT = 7;
const CFG = { portal: ADDR, asr: ADDR, portalAsrGetter: "anchorStateRegistry()", expectedChainId: 1, proofSlots: [SLOT],
              asrCandidates: [{ address: ADDR, provenance: "test" }, { address: "0x" + "11".repeat(20), provenance: "other note" }] };
function world(over = {}) {
  const ans = {
    "anchorStateRegistry()": addrWord(ADDR), "getAnchorRoot()": word(BigInt(ROOT)) + word(N).slice(2), "anchorGame()": addrWord(ADDR),
    "respectedGameType()": word(GT), "paused()": word(0), "disputeGameFactory()": addrWord("0x" + "dd".repeat(20)),
    "isGameFinalized(address)": word(1), "isGameRespected(address)": word(1), "isGameBlacklisted(address)": word(0),
    "isGameRetired(address)": word(0), "status()": word(2), "rootClaim()": ROOT, "l2SequenceNumber()": word(N), "gameType()": word(GT),
    ...over.calls,
  };
  const bySelector = Object.fromEntries(Object.entries(ans).map(([sig, v]) => [callData(sig, [], k).slice(0, 10), [sig, v]]));
  let finCalls = 0;
  const io = {
    helios: async (m, p) => {
      if (m === "eth_chainId") return over.chainId ?? "0x1";
      if (m === "eth_getBlockByNumber") { finCalls++; return over.noFinal ? null : { number: over.finNumber ?? BLOCK.number, ...(over.finTimestamp ? { timestamp: over.finTimestamp } : {}), hash: over.moveAfterFirst && finCalls > 1 ? "0x" + "77".repeat(32) : BLOCK.hash }; }
      if (m === "eth_call") {
        assert.deepEqual(p[1], over.tagMode ? "finalized" : { blockHash: BLOCK.hash.toLowerCase() });   // ONE block
        const [sig, v] = bySelector[p[0].data.slice(0, 10)];
        if (v instanceof Error) throw v;
        if (sig.endsWith("(address)")) assert.equal(p[0].data.slice(10), ADDR.slice(2).padStart(64, "0"));
        return v;
      }
      throw new Error("unexpected " + m);
    },
    el: async (m, p) => {
      if (m === "eth_getBlockByHash") return over.header ?? BLOCK;
      if (m === "eth_getProof") { assert.deepEqual(p[2], { blockHash: BLOCK.hash.toLowerCase() }); return over.proof ?? PROOF; }
      throw new Error("unexpected " + m);
    },
  };
  return io;
}
const TS = Number(BigInt(BLOCK.timestamp));
const at = (sec) => ({ keccak: k, headerHash, now: () => sec * 1000 });           // deterministic wall clock
const deps = at(TS + 60);

test("runA1: authenticated verdict, source labels, candidates resolved only by the authenticated read", async () => {
  const r = await runA1(CFG, world(), deps);
  assert.equal(r.verdict, "A1-authenticated");
  assert.equal(r.N, String(N));
  assert.equal(r.outputRoot, ROOT);
  assert.equal(r.l1.hash, BLOCK.hash.toLowerCase());
  assert.equal(r.l1.stateRoot, BLOCK.stateRoot.toLowerCase());
  assert.ok(Object.values(r.reads).every((s) => s === "helios-call" || s === "mpt-proof"));
  assert.equal(r.reads[`account:${ADDR}`], "mpt-proof");
  assert.deepEqual(r.asrCandidates.map((c) => c.authenticatedMatch), [true, false]);
  assert.equal(BigInt(r.pins[ADDR].slots["0x" + BigInt(SLOT).toString(16).padStart(64, "0")]), BigInt(PROOF.storageProof[0].value));
});

const refusals = [
  ["asr_mismatch", { calls: { "anchorStateRegistry()": addrWord("0x" + "11".repeat(20)) } }],
  ["asr_paused", { calls: { "paused()": word(1) } }],
  ["game_not_finalized", { calls: { "isGameFinalized(address)": word(0) } }],
  ["game_not_respected", { calls: { "isGameRespected(address)": word(0) } }],
  ["game_blacklisted", { calls: { "isGameBlacklisted(address)": word(1) } }],
  ["game_retired", { calls: { "isGameRetired(address)": word(1) } }],
  ["game_not_defender_wins", { calls: { "status()": word(1) } }],
  ["root_mismatch", { calls: { "rootClaim()": "0x" + "bb".repeat(32) } }],
  ["number_mismatch", { calls: { "l2SequenceNumber()": word(N + 1) } }],
  ["game_asr_mismatch", { calls: { "anchorStateRegistry()": addrWord(ADDR) } }, { portalAsrGetter: "portalAsr()" }],
  ["game_type_mismatch", { calls: { "gameType()": word(GT + 1) } }],
  ["helios_call_failed", { calls: { "status()": new Error("execution reverted") } }],
  ["bad_return", { calls: { "paused()": word(2) } }],
  ["no_finality", { noFinal: true }],
  ["wrong_chain", { chainId: "0x2105" }],
  ["header_mismatch", { header: { ...BLOCK, stateRoot: "0x" + "11".repeat(32) } }],
  ["proof_slots", { proof: { ...clone(PROOF), storageProof: [] } }],
  ["proof_json_mismatch", { proof: { ...clone(PROOF), balance: "0x1" } }],
];
for (const [c, over, cfgOver] of refusals) {
  test(`runA1 refuses: ${c}`, async () => {
    let cfg = CFG, w = over;
    if (c === "game_asr_mismatch") {
      // the portal (read through a different getter) names ADDR, but the GAME names another registry
      const calls = { "portalAsr()": addrWord(ADDR), "anchorStateRegistry()": addrWord("0x" + "33".repeat(20)) };
      cfg = { ...CFG, ...cfgOver }; w = { calls };
    }
    await assert.rejects(runA1(cfg, world(w), deps), code(c));
  });
}

test("policy refuses plain-rpc or missing sources; config must be explicit", () => {
  const good = Object.fromEntries(["portalAsr", "paused"].map((n) => [n, { source: "helios-call", value: n === "paused" ? false : ADDR }]));
  assert.throws(() => evaluateA1(validateConfig(CFG), { ...good, portalAsr: { source: "plain-rpc", value: ADDR } }), code("unauthenticated"));
  assert.throws(() => evaluateA1(validateConfig(CFG), { portalAsr: { source: "helios-call", value: ADDR } }), code("unauthenticated"));
  assert.throws(() => validateConfig({ ...CFG, asr: "0x909f6cf4" }), code("bad_config"));            // prefix-only note: refused
  assert.throws(() => validateConfig({ ...CFG, portalAsrGetter: undefined }), code("bad_config"));
  assert.throws(() => validateConfig({ ...CFG, expectedChainId: 8453 }), code("bad_config"));
  assert.equal(verifyMptProof(BLOCK.stateRoot, k(fromHex(PROOF.address, 20)), PROOF.accountProof, k).length > 0, true);
});

test("pinBy finalized-tag: accepted only if the finalized hash is unchanged after all reads", async () => {
  const r = await runA1({ ...CFG, pinBy: "finalized-tag" }, world({ tagMode: true }), deps);
  assert.equal(r.verdict, "A1-authenticated");
  await assert.rejects(runA1({ ...CFG, pinBy: "finalized-tag" }, world({ tagMode: true, moveAfterFirst: true }), deps), code("finality_moved"));
  assert.throws(() => validateConfig({ ...CFG, pinBy: "latest" }), code("bad_config"));
});

test("a1-read: loopback-only URLs and a real JSON-RPC round trip to a local mock", async () => {
  const { loopbackUrl, rpc } = await import("../a1-read.mjs");
  for (const bad of ["https://127.0.0.1:8545", "http://localhost:8545", "http://10.0.0.1:8545", "http://127.0.0.1", "http://u:p@127.0.0.1:1/", "http://127.0.0.1:1/?k=v"])
    assert.throws(() => loopbackUrl(bad, "x"), code("bad_config"), bad);
  const http = await import("node:http");
  const srv = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { const q = JSON.parse(b);
    res.end(JSON.stringify(q.method === "bad" ? { jsonrpc: "2.0", id: q.id + 1, result: 1 } : { jsonrpc: "2.0", id: q.id, result: "0x1" })); }); });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  try {
    const call = rpc(loopbackUrl(`http://127.0.0.1:${srv.address().port}`, "x"));
    assert.equal(await call("eth_chainId", []), "0x1");
    await assert.rejects(call("bad", []), /envelope/);
  } finally { srv.close(); }
});

test("finalized freshness: bounded age, future skew, Helios/header agreement (deterministic clock)", async () => {
  const ok = async (sec, cfg = CFG) => assert.equal((await runA1(cfg, world(), at(sec))).verdict, "A1-authenticated");
  await ok(TS + 1800);                                                   // exactly the default max age
  await ok(TS - 15);                                                     // exactly the allowed future skew
  await assert.rejects(runA1(CFG, world(), at(TS + 1801)), code("finalized_stale"));
  await assert.rejects(runA1(CFG, world(), at(TS - 16)), code("finalized_future"));
  await ok(TS + 3600, { ...CFG, maxFinalizedAgeSec: 3600 });
  await assert.rejects(runA1({ ...CFG, maxFinalizedAgeSec: 120 }, world(), at(TS + 121)), code("finalized_stale"));
  const r = await runA1(CFG, world(), at(TS + 42));
  assert.equal(r.l1.ageSec, 42);
  await assert.rejects(runA1(CFG, world({ finNumber: "0x" + (BigInt(BLOCK.number) + 1n).toString(16) }), deps), code("finalized_number_mismatch"));
  await assert.rejects(runA1(CFG, world({ finTimestamp: "0x" + (BigInt(BLOCK.timestamp) + 1n).toString(16) }), deps), code("finalized_timestamp_mismatch"));
  for (const bad of [0, 59, 7201, 1800.5, "1800"]) assert.throws(() => validateConfig({ ...CFG, maxFinalizedAgeSec: bad }), code("bad_config"), String(bad));
  assert.equal(validateConfig(CFG).maxFinalizedAgeSec, 1800);
});

test("a1-read rpc: byte cap enforced while streaming, declared oversize, HTTP 500, redirect, timeout (real loopback)", async () => {
  const { rpc } = await import("../a1-read.mjs");
  const http = await import("node:http");
  let streamedBytes = 0;
  const srv = http.createServer((req, res) => {
    const path = req.url;
    if (path === "/big") {                                              // no content-length: chunked, ~9 MiB if not stopped
      res.writeHead(200, { "content-type": "application/json" });
      let sent = 0; const chunk = Buffer.alloc(64 * 1024, 0x20);
      const pump = () => { while (sent < 9 << 20) { sent += chunk.length; streamedBytes = sent; if (!res.write(chunk)) return res.once("drain", pump); } res.end(); };
      res.on("close", () => {}); pump(); return;
    }
    if (path === "/declared") { res.writeHead(200, { "content-length": String(9 << 20) }); res.end(); return; }
    if (path === "/500") { res.writeHead(500); res.end('{"jsonrpc":"2.0","id":1,"result":"0x1"}'); return; }
    if (path === "/redirect") { res.writeHead(302, { location: "http://127.0.0.1:1/" }); res.end(); return; }
    if (path === "/hang") return;                                       // never answers
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { const q = JSON.parse(b); res.end(JSON.stringify({ jsonrpc: "2.0", id: q.id, result: "0x1" })); });
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal(await rpc(base + "/ok", { maxBytes: 1024 })("eth_chainId", []), "0x1");
    await assert.rejects(rpc(base + "/big", { maxBytes: 1 << 20 })("x", []), /reply too large$/);
    assert.ok(streamedBytes < 9 << 20, `client must stop the stream early (server wrote ${streamedBytes})`);
    await assert.rejects(rpc(base + "/declared", { maxBytes: 1 << 20 })("x", []), /reply too large \(declared\)/);
    await assert.rejects(rpc(base + "/500")("x", []), /HTTP 500/);
    await assert.rejects(rpc(base + "/redirect")("x", []), (e) => e instanceof Error && !/^0x/.test(String(e.message)));
    await assert.rejects(rpc(base + "/hang", { timeoutMs: 300 })("x", []), (e) => /timeout|abort/i.test(String(e.name) + String(e.message)));
  } finally { srv.closeAllConnections?.(); srv.close(); }
});
