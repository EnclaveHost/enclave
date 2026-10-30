// node --test test/a1-gate.test.mjs   (ANCHOR_DEPS_ROOT=<checkout with node_modules>)
// PRODUCER -> CONSUMER: the REAL runRecheck (a1gate/a1-recheck.mjs, byte-identical to a1-original-game f591f324...) over the
// same MOCKED Helios world as the frozen a1-recheck test (deposit contract stands in for portal = ASR = game; REAL upstream
// mainnet proof from the untrusted EL) produces the receipt; a1-gate.mjs must accept exactly that and refuse every rebinding.
// REAL data also: the live initial A1 receipt (live-1958, sha b9a90847...). Not evidence about Base.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { keccak_256 } from "./deps.mjs";
import { headerHash } from "./vendor/anchor-bootstrap.mjs";
import { callData, checkProofResponse, A1Error } from "../a1gate/a1-anchor.mjs";
import { runRecheck, RECHECK_VERDICT } from "../a1gate/a1-recheck.mjs";
import { checkFreshInitial, checkRecheck, gate, RECHECK_KEYS, RECHECK_LABEL } from "../a1gate/a1-gate.mjs";

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
const bytes = (o) => new Uint8Array(Buffer.from(JSON.stringify(o)));
const clone = (o) => JSON.parse(JSON.stringify(o));

test("pinned reuse: a1gate/a1-recheck.mjs and a1-anchor.mjs are byte-identical to the frozen a1-original-game copies", () => {
  const src = path.resolve(here, "../../a1-original-game");
  for (const [f, want] of [["a1-recheck.mjs", "f591f3247fe672f6470685f2be36eb529ceb9280044c03c6a2396174bb0ad9d8"], ["a1-anchor.mjs", "ec92b70f105f88cbfc466e57e4673afcb0fbd104403e425e036f1dba78e6528d"]]) {
    assert.equal(sha256(fs.readFileSync(path.join(here, "../a1gate", f))), want, f);
    if (fs.existsSync(path.join(src, f))) assert.equal(sha256(fs.readFileSync(path.join(src, f))), want, `frozen ${f}`);
  }
});

const LIVE = new Uint8Array(fs.readFileSync(path.join(here, "fixtures", "initial-a1-evidence-1958.json")));
const LIVE_SHA = "b9a90847bb3f779262681cabc35af64d7c3b785c9ad5cd2b99e9700b9725256c";
test("REAL live initial receipt: accepted as fresh-initial input (sha of its exact bytes); a wrong pinned sha refuses as initial of a recheck", () => {
  const s = checkFreshInitial(LIVE);
  assert.deepEqual([s.mode, s.initialSha256, s.N, s.game, s.asr, s.respectedGameType, s.l1.number],
                   ["fresh-initial", LIVE_SHA, "52866960", "0x343b3a99527af07d2cfb2652747b9e37715e21ac", "0x909f6cf47ed12f010a796527f562bfc26c7f4e72", 621, 26271848]);
  assert.equal(Object.keys(s.pins).length, 3);
  assert.throws(() => checkRecheck(LIVE, "0".repeat(64), bytes({})), code("initial_sha"));
});

// ---- the frozen recheck test's mocked world, with a COMPLETE initial receipt (every read the gate requires) ------------
const ADDR = PROOF.address.toLowerCase(), SLOT = "0x" + BigInt(PROOF.storageProof[0].key).toString(16).padStart(64, "0");
const ROOT = "0x" + "aa".repeat(32), N = 12345, GT = 621;
const real = checkProofResponse(BLOCK.stateRoot, PROOF, k);
const INITIAL_READS = ["l1Finalized", "portalAsr", "anchorRoot", "anchorGame", "respectedGameType", "paused", "isGameFinalized", "isGameRespected",
                       "isGameBlacklisted", "isGameRetired", "gameStatus", "gameRootClaim", "gameL2SequenceNumber", "gameType", "gameAnchorStateRegistry"];
const INITIAL = { verdict: "A1-authenticated", N: String(N), outputRoot: ROOT, game: ADDR, asr: ADDR, respectedGameType: GT,
  l1: { number: Number(BigInt(BLOCK.number)) - 100, hash: "0x" + "ee".repeat(32), stateRoot: "0x" + "ef".repeat(32), timestamp: TS - 1200, ageSec: 952 },
  pins: { [ADDR]: { codeHash: real.codeHash, storageRoot: real.storageRoot, slots: { [SLOT]: word(real.storage[SLOT]) } } },
  reads: { ...Object.fromEntries(INITIAL_READS.map((r) => [r, "helios-call"])), [`account:${ADDR}`]: "mpt-proof" },
  asrCandidates: [{ address: ADDR, authenticatedMatch: true }], at: new Date((TS - 200) * 1000).toISOString() };
const IB = bytes(INITIAL), ISHA = sha256(IB);
const CFG = { portal: ADDR, asr: ADDR, portalAsrGetter: "anchorStateRegistry()", expectedChainId: 1, pinSlots: [SLOT],
  initialEvidenceSha256: ISHA, originalGame: ADDR, originalN: String(N), originalOutputRoot: ROOT };
function world(over = {}) {
  const ans = {
    "anchorStateRegistry()": addrWord(ADDR), "paused()": word(0), "respectedGameType()": word(GT),
    "isGameFinalized(address)": word(1), "isGameRespected(address)": word(1), "isGameBlacklisted(address)": word(0), "isGameRetired(address)": word(0),
    "status()": word(2), "rootClaim()": ROOT, "l2SequenceNumber()": word(N), "gameType()": word(GT),
    "getAnchorRoot()": word(BigInt(ROOT)) + word(N).slice(2), "anchorGame()": addrWord(ADDR), ...over.calls };
  const bySel = Object.fromEntries(Object.entries(ans).map(([sig, v]) => [callData(sig, [], k).slice(0, 10), v]));
  return {
    helios: async (m, p) => {
      if (m === "eth_chainId") return "0x1";
      if (m === "eth_getBlockByNumber") return { number: BLOCK.number, hash: BLOCK.hash };
      if (m === "eth_call") return bySel[p[0].data.slice(0, 10)];
      throw new Error("unexpected " + m);
    },
    el: async (m) => { if (m === "eth_getBlockByHash") return BLOCK; if (m === "eth_getProof") return PROOF; throw new Error("unexpected " + m); },
  };
}
// what a1-recheck-read.mjs writes: the runRecheck result plus `at`
const produce = async (over) => JSON.parse(JSON.stringify({ ...(await runRecheck(CFG, IB, world(over), deps)), at: new Date((TS + 61) * 1000).toISOString() }));
const ADVANCED = { calls: { "getAnchorRoot()": word(BigInt("0x" + "bb".repeat(32))) + word(N + 9000).slice(2), "anchorGame()": addrWord("0x" + "99".repeat(20)) } };

test("the complete mock initial receipt is valid fresh-initial input; a missing required read refuses", () => {
  assert.equal(checkFreshInitial(IB).initialSha256, ISHA);
  const e = clone(INITIAL); delete e.reads.isGameRespected;
  assert.throws(() => checkFreshInitial(bytes(e)), code("unproven_read"));
  const f = clone(INITIAL); f.reads[`account:${ADDR}`] = "helios-call";
  assert.throws(() => checkFreshInitial(bytes(f)), code("unproven_read"));
});

test("REAL producer output (unchanged world) is accepted: shape, label and read set are exactly what runRecheck writes", async () => {
  const r = await produce();
  assert.equal(r.verdict, RECHECK_VERDICT);
  assert.deepEqual(Object.keys(r).sort(), [...RECHECK_KEYS].sort());
  assert.equal(r.label, RECHECK_LABEL);
  const s = checkRecheck(IB, ISHA, bytes(r));
  assert.deepEqual([s.mode, s.initialSha256, s.N, s.outputRoot, s.game], ["original-game-recheck", ISHA, String(N), ROOT, ADDR]);
  assert.equal(s.latestAnchorObservation.advanced, false);
  assert.equal(s.l1.number, Number(BigInt(BLOCK.number)));
  assert.deepEqual(gate({ mode: "original-game-recheck", initial: Buffer.from(IB).toString("base64"), initialSha256: ISHA, recheck: Buffer.from(bytes(r)).toString("base64") }), s);
});

test("REAL producer output after the latest anchor ADVANCED: accepted, N/root/game stay the initial values, latest is observation only", async () => {
  const s = checkRecheck(IB, ISHA, bytes(await produce(ADVANCED)));
  assert.deepEqual([s.N, s.outputRoot, s.game], [String(N), ROOT, ADDR]);
  assert.deepEqual(s.latestAnchorObservation, { game: "0x" + "99".repeat(20), N: String(N + 9000), outputRoot: "0x" + "bb".repeat(32), advanced: true, accepted: false });
});

test("never interchangeable: a recheck is not initial evidence, an initial is not a recheck, a CLI refusal is not a pass", async () => {
  const r = bytes(await produce());
  assert.throws(() => checkFreshInitial(r), code("not_initial_a1"));
  assert.throws(() => checkRecheck(IB, ISHA, IB), code("not_recheck"));
  assert.throws(() => checkRecheck(IB, ISHA, bytes({ verdict: "refused", code: "game_blacklisted", message: "x" })), code("not_recheck"));
  assert.throws(() => checkRecheck(IB, ISHA, new Uint8Array([0xff, 0xfe])), code("bad_recheck"));
  assert.throws(() => checkRecheck(r, sha256(r), r), code("not_initial_a1"));                // a recheck as the INITIAL of a recheck
});

test("a recheck of ANOTHER initial receipt (same game/N/root, other L1 block) is refused against the pinned one", async () => {
  const other = clone(INITIAL); other.l1.hash = "0x" + "e1".repeat(32);
  const ob = bytes(other), r = await runRecheck({ ...CFG, initialEvidenceSha256: sha256(ob) }, ob, world(), deps);
  assert.throws(() => checkRecheck(IB, ISHA, bytes({ ...clone(r), at: new Date((TS + 61) * 1000).toISOString() })), code("recheck_binding"));
});

test("every rebinding of the REAL producer output refuses with its code (latest N/descendant, pins, labels, freshness, shape)", async () => {
  const base = await produce(ADVANCED);
  const cases = [
    ["recheck_binding", (r) => { r.N = r.latestAnchorObservation.N; }],
    ["recheck_binding", (r) => { r.N = r.recheckOf.N = r.latestAnchorObservation.N; r.outputRoot = r.recheckOf.outputRoot = r.latestAnchorObservation.outputRoot; }],
    ["recheck_binding", (r) => { r.game = r.latestAnchorObservation.game; }],
    ["recheck_binding", (r) => { r.recheckOf.sha256 = "0".repeat(64); }],
    ["recheck_binding", (r) => { r.recheckOf.l1.hash = "0x" + "e1".repeat(32); }],
    ["recheck_binding", (r) => { r.N = Number(r.N); }],
    ["recheck_latest", (r) => { r.latestAnchorObservation.accepted = true; }],
    ["recheck_latest", (r) => { delete r.latestAnchorObservation.accepted; }],
    ["recheck_latest", (r) => { r.latestAnchorObservation.N = String(N - 1); }],
    ["recheck_pins", (r) => { r.pins[ADDR].codeHash = "0x" + "00".repeat(32); }],
    ["recheck_pins", (r) => { r.pins[ADDR].slots[SLOT] = word(1); }],
    ["recheck_pins", (r) => { r.pins["0x" + "12".repeat(20)] = r.pins[ADDR]; }],
    ["unproven_read", (r) => { r.reads.isGameFinalized = "plain-rpc"; }],
    ["unproven_read", (r) => { delete r.reads.latestAnchorGame; }],
    ["not_fresh", (r) => { r.l1.number = INITIAL.l1.number; }],
    ["not_fresh", (r) => { r.l1.hash = INITIAL.l1.hash; }],
    ["finalized_stale", (r) => { r.l1.ageSec = 1801; }],
    ["bad_recheck", (r) => { r.extra = true; }],
    ["bad_recheck", (r) => { r.label = "x"; }],
    ["bad_recheck", (r) => { r.at = "yesterday"; }],
  ];
  for (const [c, mutate] of cases) {
    const r = clone(base); mutate(r);
    assert.throws(() => checkRecheck(IB, ISHA, bytes(r)), code(c), `${c}: ${mutate}`);
  }
  assert.equal(checkRecheck(IB, ISHA, bytes(base)).N, String(N), "the unmutated base still passes");
});
