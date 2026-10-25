// node --test test/a1-recheck.test.mjs   (ANCHOR_DEPS_ROOT=<checkout with node_modules>)
// REAL data: the live initial A1 receipt (l1-anchor-a1/live-1958/a1-evidence.json, sha b9a90847...) and the Helios
// upstream mainnet account/storage proof (block 0x14e8d38). MOCKED: every Helios eth_call answer (the test's stand-in
// for the verifier; the deposit contract address stands in for portal = ASR = game). Not evidence about Base.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { keccak_256 } from "./deps.mjs";
import { headerHash } from "../vendor/anchor-bootstrap.mjs";
import { callData, checkProofResponse, A1Error } from "../a1-anchor.mjs";
import { loadInitialReceipt, validateRecheckConfig, runRecheck, RECHECK_VERDICT } from "../a1-recheck.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const k = (b) => keccak_256(b);
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const code = (c) => (e) => e instanceof A1Error && e.code === c;
const load = (n) => { const j = JSON.parse(fs.readFileSync(path.join(here, "fixtures", n), "utf8")); return j.result ?? j; };
const PROOF = load("helios-mainnet-proof.json"), BLOCK = load("helios-mainnet-block.json");
const word = (v) => "0x" + BigInt(v).toString(16).padStart(64, "0");
const addrWord = (a) => "0x" + a.slice(2).padStart(64, "0");
const TS = Number(BigInt(BLOCK.timestamp));
const deps = { keccak: k, headerHash, sha256, now: () => (TS + 60) * 1000 };

const PUBLISHED = path.resolve(here, "../../../source/ops/rpc-backend-bootstrap/2026-10-25/l1-anchor-a1");
test("pinned reuse: a1-anchor.mjs / a1-read.mjs / vendor are byte-identical to the read-only published A1 package", () => {
  for (const [mine, theirs, want] of [["../a1-anchor.mjs", "a1-anchor.mjs", "ec92b70f105f88cbfc466e57e4673afcb0fbd104403e425e036f1dba78e6528d"],
                                      ["../a1-read.mjs", "a1-read.mjs", "a501a3ec56ebd56e6bf1fc43c0c3725da57d013addac5f1efb13a99e598e0ab8"],
                                      ["../vendor/anchor-bootstrap.mjs", "vendor/anchor-bootstrap.mjs", "90a8afba31e7c7029a0fa860f97153cd40665f1d1b2ae87bb0a56fd98c25e8f8"]]) {
    const a = fs.readFileSync(path.join(here, mine));
    assert.equal(sha256(a), want, mine);
    if (fs.existsSync(path.join(PUBLISHED, theirs))) assert.equal(sha256(fs.readFileSync(path.join(PUBLISHED, theirs))), want, theirs);
  }
});

const LIVE = new Uint8Array(fs.readFileSync(path.join(here, "fixtures", "initial-a1-evidence-1958.json")));
const LIVE_SHA = "b9a90847bb3f779262681cabc35af64d7c3b785c9ad5cd2b99e9700b9725256c";
const LIVE_CFG = { heliosUrl: "http://127.0.0.1:28550", elUrl: "http://127.0.0.1:28645", expectedChainId: 1, pinBy: "hash",
  portal: "0x49048044d57e1c92a77f79988d21fa8faf74e97e", asr: "0x909f6cf47ed12f010a796527f562bfc26c7f4e72", portalAsrGetter: "anchorStateRegistry()",
  maxFinalizedAgeSec: 1800, initialEvidenceSha256: LIVE_SHA, originalGame: "0x343b3a99527af07d2cfb2652747b9e37715e21ac", originalN: "52866960",
  originalOutputRoot: "0xa996c517b0e797b56426059d57c93ac8352b21b61e04b2fc66866dd61d056700" };

test("REAL live initial A1 receipt binds: sha, game, N, root, ASR, EIP-1967 pins (production config validates)", () => {
  const init = loadInitialReceipt(LIVE, LIVE_SHA, sha256);
  assert.equal(init.game, LIVE_CFG.originalGame);
  assert.equal(init.N, 52866960n);
  assert.equal(init.outputRoot, LIVE_CFG.originalOutputRoot);
  assert.equal(init.asr, LIVE_CFG.asr);
  assert.equal(init.respectedGameType, 621);
  assert.equal(init.l1.number, 26271848);
  const cfg = validateRecheckConfig(LIVE_CFG, init);
  assert.equal(cfg.pinSlots.length, 2);
  assert.throws(() => validateRecheckConfig({ ...LIVE_CFG, originalN: "52866961" }, init), code("binding_mismatch"));
  assert.throws(() => validateRecheckConfig({ ...LIVE_CFG, originalGame: "0x" + "11".repeat(20) }, init), code("binding_mismatch"));
  assert.throws(() => validateRecheckConfig({ ...LIVE_CFG, originalOutputRoot: "0x" + "22".repeat(32) }, init), code("binding_mismatch"));
  assert.throws(() => validateRecheckConfig({ ...LIVE_CFG, asr: "0xdb9091e48b1c42992a1213e6916184f9ebdbfedf" }, init), code("binding_mismatch"));
  assert.throws(() => validateRecheckConfig({ ...LIVE_CFG, pinSlots: [LIVE_CFG.asr.padEnd(66, "0")] }, init), code("bad_initial"));   // subset/other slots
});

test("initial receipt refusals: wrong sha, recheck substituted as initial, non-authenticated labels, tampered bytes", () => {
  assert.throws(() => loadInitialReceipt(LIVE, "0".repeat(64), sha256), code("initial_sha"));
  const t = new Uint8Array(LIVE); t[t.length - 3] ^= 1;
  assert.throws(() => loadInitialReceipt(t, LIVE_SHA, sha256), code("initial_sha"));
  const e = JSON.parse(Buffer.from(LIVE).toString());
  const asBytes = (o) => new Uint8Array(Buffer.from(JSON.stringify(o)));
  for (const bad of [{ ...e, verdict: RECHECK_VERDICT }, { ...e, recheckOf: { sha256: LIVE_SHA } }]) {
    const b = asBytes(bad); assert.throws(() => loadInitialReceipt(b, sha256(b), sha256), code("not_initial_a1"));
  }
  const plain = asBytes({ ...e, reads: { ...e.reads, portalAsr: "plain-rpc" } });
  assert.throws(() => loadInitialReceipt(plain, sha256(plain), sha256), code("bad_initial"));
  const nomatch = asBytes({ ...e, asrCandidates: e.asrCandidates.map((c) => ({ ...c, authenticatedMatch: false })) });
  assert.throws(() => loadInitialReceipt(nomatch, sha256(nomatch), sha256), code("bad_initial"));
});

// ---- recheck against MOCKED Helios + the REAL proof from the untrusted EL ------------------------------------------
const ADDR = PROOF.address.toLowerCase(), SLOT = "0x" + BigInt(PROOF.storageProof[0].key).toString(16).padStart(64, "0");
const ROOT = "0x" + "aa".repeat(32), N = 12345, GT = 621;
const real = checkProofResponse(BLOCK.stateRoot, PROOF, k);
const INITIAL = { verdict: "A1-authenticated", N: String(N), outputRoot: ROOT, game: ADDR, asr: ADDR, respectedGameType: GT,
  l1: { number: Number(BigInt(BLOCK.number)) - 100, hash: "0x" + "ee".repeat(32) },          // an OLDER initial block (test construction)
  pins: { [ADDR]: { codeHash: real.codeHash, storageRoot: real.storageRoot, slots: { [SLOT]: word(real.storage[SLOT]) } } },
  reads: { portalAsr: "helios-call", [`account:${ADDR}`]: "mpt-proof" }, asrCandidates: [{ address: ADDR, authenticatedMatch: true }] };
const iBytes = (o = INITIAL) => new Uint8Array(Buffer.from(JSON.stringify(o)));
const CFG = (o = INITIAL) => ({ portal: ADDR, asr: ADDR, portalAsrGetter: "anchorStateRegistry()", expectedChainId: 1, pinSlots: [SLOT],
  initialEvidenceSha256: sha256(iBytes(o)), originalGame: ADDR, originalN: String(N), originalOutputRoot: ROOT });

function world(over = {}) {
  const ans = {
    "anchorStateRegistry()": addrWord(ADDR), "paused()": word(0), "respectedGameType()": word(GT),
    "isGameFinalized(address)": word(1), "isGameRespected(address)": word(1), "isGameBlacklisted(address)": word(0), "isGameRetired(address)": word(0),
    "status()": word(2), "rootClaim()": ROOT, "l2SequenceNumber()": word(N), "gameType()": word(GT),
    "getAnchorRoot()": word(BigInt(ROOT)) + word(N).slice(2), "anchorGame()": addrWord(ADDR), ...over.calls };
  const bySel = Object.fromEntries(Object.entries(ans).map(([sig, v]) => [callData(sig, [], k).slice(0, 10), v]));
  let fins = 0;
  return {
    helios: async (m, p) => {
      if (m === "eth_chainId") return "0x1";
      if (m === "eth_getBlockByNumber") { fins++; return { number: over.finNumber ?? BLOCK.number, hash: over.moveAfterFirst && fins > 1 ? "0x" + "77".repeat(32) : BLOCK.hash }; }
      if (m === "eth_call") {
        assert.deepEqual(p[1], over.tagMode ? "finalized" : { blockHash: BLOCK.hash.toLowerCase() });   // ONE fresh block for every read
        const v = bySel[p[0].data.slice(0, 10)];
        if (v instanceof Error) throw v;
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
}

test("recheck passes: original game still eligible, N/root unchanged, pins unchanged; distinct verdict bound to the initial sha", async () => {
  const r = await runRecheck(CFG(), iBytes(), world(), deps);
  assert.equal(r.verdict, RECHECK_VERDICT);
  assert.equal(r.recheckOf.sha256, sha256(iBytes()));
  assert.equal(r.recheckOf.verdict, "A1-authenticated");
  assert.deepEqual([r.game, r.N, r.outputRoot], [ADDR, String(N), ROOT]);
  assert.equal(r.l1.hash, BLOCK.hash.toLowerCase());
  assert.equal(r.latestAnchorObservation.advanced, false);
  assert.equal(r.pins[ADDR].comparison, "unchanged-from-initial-observation");
  assert.ok(Object.values(r.reads).every((s) => s === "helios-call" || s === "mpt-proof"));
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.recheckOf));
});

test("latest anchor ADVANCED: recorded as observation only; N/root stay the original (never accepted)", async () => {
  const later = { "getAnchorRoot()": word(BigInt("0x" + "bb".repeat(32))) + word(N + 9000).slice(2), "anchorGame()": addrWord("0x" + "99".repeat(20)) };
  const r = await runRecheck(CFG(), iBytes(), world({ calls: later }), deps);
  assert.equal(r.latestAnchorObservation.advanced, true);
  assert.equal(r.latestAnchorObservation.accepted, false);
  assert.equal(r.latestAnchorObservation.N, String(N + 9000));
  assert.deepEqual([r.N, r.outputRoot, r.game], [String(N), ROOT, ADDR]);
  assert.equal(r.recheckOf.N, String(N));
});

const tamperedProof = () => { const p = JSON.parse(JSON.stringify(PROOF)); p.accountProof[2] = p.accountProof[2].slice(0, -2) + (p.accountProof[2].endsWith("00") ? "01" : "00"); return p; };
const refusals = [
  ["asr_changed", { calls: { "anchorStateRegistry()": addrWord("0x" + "11".repeat(20)) } }],
  ["asr_paused", { calls: { "paused()": word(1) } }],
  ["respected_type_changed", { calls: { "respectedGameType()": word(GT + 1) } }],
  ["game_not_respected", { calls: { "isGameRespected(address)": word(0) } }],
  ["game_not_finalized", { calls: { "isGameFinalized(address)": word(0) } }],
  ["game_blacklisted", { calls: { "isGameBlacklisted(address)": word(1) } }],
  ["game_retired", { calls: { "isGameRetired(address)": word(1) } }],
  ["game_not_defender_wins", { calls: { "status()": word(1) } }],
  ["root_changed", { calls: { "rootClaim()": "0x" + "cc".repeat(32) } }],
  ["number_changed", { calls: { "l2SequenceNumber()": word(N + 1) } }],
  ["game_type_changed", { calls: { "gameType()": word(GT + 1) } }],
  ["anchor_regressed", { calls: { "getAnchorRoot()": word(BigInt(ROOT)) + word(N - 1).slice(2), "anchorGame()": addrWord("0x" + "98".repeat(20)) } }],
  ["anchor_inconsistent", { calls: { "getAnchorRoot()": word(BigInt("0x" + "dd".repeat(32))) + word(N).slice(2) } }],
  ["helios_call_failed", { calls: { "status()": new Error("execution reverted") } }],
  ["header_mismatch", { header: { ...BLOCK, stateRoot: "0x" + "11".repeat(32) } }],
  ["finalized_number_mismatch", { finNumber: "0x" + (BigInt(BLOCK.number) + 1n).toString(16) }],
  ["proof_hash", { proof: tamperedProof() }],
  ["proof_slots", { proof: { ...PROOF, storageProof: [] } }],
];
for (const [c, over] of refusals) test(`recheck refuses: ${c}`, async () => { await assert.rejects(runRecheck(CFG(), iBytes(), world(over), deps), code(c)); });

test("recheck refuses: game names another ASR (portal getter read separately)", async () => {
  const cfg = { ...CFG(), portalAsrGetter: "portalAsr()" };
  await assert.rejects(runRecheck(cfg, iBytes(), world({ calls: { "portalAsr()": addrWord(ADDR), "anchorStateRegistry()": addrWord("0x" + "33".repeat(20)) } }), deps), code("game_asr_changed"));
});

test("recheck refuses code/proxy pin changes pending operator review (codeHash, slot)", async () => {
  for (const pins of [{ ...INITIAL.pins[ADDR], codeHash: "0x" + "00".repeat(32) }, { ...INITIAL.pins[ADDR], slots: { [SLOT]: word(1) } }]) {
    const init = { ...INITIAL, pins: { [ADDR]: pins } };
    await assert.rejects(runRecheck(CFG(init), iBytes(init), world(), deps), code("code_or_proxy_changed"));
  }
});

test("freshness and pinning: stale / future header, finalized-tag move, mixed block refused", async () => {
  await assert.rejects(runRecheck(CFG(), iBytes(), world(), { ...deps, now: () => (TS + 1801) * 1000 }), code("finalized_stale"));
  await assert.rejects(runRecheck(CFG(), iBytes(), world(), { ...deps, now: () => (TS - 16) * 1000 }), code("finalized_future"));
  await assert.rejects(runRecheck({ ...CFG(), pinBy: "finalized-tag" }, iBytes(), world({ tagMode: true, moveAfterFirst: true }), deps), code("finality_moved"));
  assert.equal((await runRecheck({ ...CFG(), pinBy: "finalized-tag" }, iBytes(), world({ tagMode: true }), deps)).verdict, RECHECK_VERDICT);
  // a mixed-block answer is impossible to slip in: the mock asserts every read is pinned to the one fresh block hash
  const w = world(); const h = w.helios; w.helios = (m, p) => (m === "eth_call" ? h(m, [p[0], { blockHash: "0x" + "12".repeat(32) }]) : h(m, p));
  await assert.rejects(runRecheck(CFG(), iBytes(), w, deps), code("helios_call_failed"));
});

test("recheck refuses not_fresh: initial A1 receipt at the SAME, a NEWER, or the same-hash L1 block (Helios and header numbers agree)", async () => {
  // repaired fixture: the fresh world is honest (Helios finalized number == header number), the INITIAL receipt is moved
  const bn = Number(BigInt(BLOCK.number)), other = "0x" + "ef".repeat(32), fresh = BLOCK.hash.toLowerCase();
  for (const l1 of [{ number: bn, hash: other }, { number: bn + 5, hash: other }, { number: bn, hash: fresh }, { number: bn - 1, hash: fresh }]) {
    const init = { ...INITIAL, l1 };
    await assert.rejects(runRecheck(CFG(init), iBytes(init), world(), deps), code("not_fresh"), JSON.stringify(l1));
  }
  // control: one block older with a different hash is fresh enough
  const ok = { ...INITIAL, l1: { number: bn - 1, hash: other } };
  assert.equal((await runRecheck(CFG(ok), iBytes(ok), world(), deps)).verdict, RECHECK_VERDICT);
});
