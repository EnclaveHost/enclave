// A1 evidence gate for A2-A4 (finality-stage/a1-a2-integration, README.md). PREPARED; root review pending.
// Consumer side of two ROOT-PRODUCED evidence files (never re-verifies Helios: it has no light client):
//   checkFreshInitial(bytes)                          an INITIAL `A1-authenticated` receipt (runA1 + a1-read.mjs)
//   checkRecheck(initialBytes, initialSha, recheck)   an `A1-original-game-recheck-passed` receipt (runRecheck +
//                                                    a1-recheck-read.mjs) bound to the EXACT initial receipt bytes
// Reuses, byte-identical and unmodified: ./a1-recheck.mjs (f591f324...) loadInitialReceipt + verdict constants and
// ./a1-anchor.mjs (ec92b70f...) ASR_GAME_CALLS / DEFAULT_MAX_FINALIZED_AGE_SEC / A1Error. Trust model: the labels
// helios-call / mpt-proof are the root runner's RECORD of how a value was obtained; this gate checks that the record is
// complete, exact and consistent with the initial receipt, it does not turn a label into a proof. File ownership,
// sha pins and run provenance are enforced by the caller (a2a4.py gate_a1).
import crypto from "node:crypto";
import { A1Error, ASR_GAME_CALLS, DEFAULT_MAX_FINALIZED_AGE_SEC } from "./a1-anchor.mjs";
import { loadInitialReceipt, INITIAL_VERDICT, RECHECK_VERDICT } from "./a1-recheck.mjs";

const fail = (code, message) => { throw new A1Error(code, message); };
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const ADDR = /^0x[0-9a-f]{40}$/, H32 = /^0x[0-9a-f]{64}$/, DEC = /^[1-9][0-9]*$/, ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?Z$/;
const obj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
const exactKeys = (o, keys, code, what) => {
  if (!obj(o)) fail(code, `${what} is not an object`);
  const got = Object.keys(o).sort(), want = [...keys].sort();
  if (got.join() !== want.join()) fail(code, `${what} keys [${got}] != [${want}]`);
};
const parse = (bytes, code) => {
  if (!(bytes instanceof Uint8Array)) fail("bad_input", "receipt must be the exact file bytes");
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { fail(code, "receipt is not UTF-8 JSON"); }
};
const safeInt = (v, what, code) => { if (!Number.isSafeInteger(v) || v < 0) fail(code, `${what} is not a non-negative safe integer`); return v; };

export const RECHECK_LABEL = "A1 original-game recheck: Helios-light-client-relative; pins compared to initial OBSERVATIONS (not approved versions); not SNP/attested";
export const RECHECK_KEYS = ["verdict", "recheckOf", "game", "N", "outputRoot", "asr", "respectedGameType", "l1", "latestAnchorObservation", "pins", "reads", "label", "at"];
const RECHECK_HELIOS_READS = ["portalAsr", "paused", "respectedGameType", ...Object.keys(ASR_GAME_CALLS), "gameStatus", "gameRootClaim",
                              "gameL2SequenceNumber", "gameType", "gameAnchorStateRegistry", "latestAnchorRoot", "latestAnchorGame"];
// initial receipt: every policy input the frozen gate named, plus identity/eligibility reads runA1 records (extra keys may exist;
// loadInitialReceipt already refuses ANY non-authenticated label)
const INITIAL_HELIOS_READS = ["l1Finalized", "portalAsr", "anchorRoot", "anchorGame", "respectedGameType", "paused", ...Object.keys(ASR_GAME_CALLS),
                              "gameStatus", "gameRootClaim", "gameL2SequenceNumber", "gameType", "gameAnchorStateRegistry"];

function initialSummary(init, e) {
  for (const k of INITIAL_HELIOS_READS) if (e.reads[k] !== "helios-call") fail("unproven_read", `initial read ${k} is ${e.reads[k]}, not helios-call`);
  const addrs = Object.keys(init.pins);
  if (!addrs.includes(init.asr) || !addrs.includes(init.game)) fail("bad_initial", "initial pins lack the ASR or the game");
  for (const a of addrs) {
    const p = init.pins[a];
    if (!ADDR.test(a) || !obj(p) || !H32.test(String(p.codeHash)) || !obj(p.slots) || !Object.keys(p.slots).length) fail("bad_initial", `initial pin ${a} lacks codeHash/slots`);
    for (const [s, v] of Object.entries(p.slots)) if (!H32.test(s) || !H32.test(String(v))) fail("bad_initial", `initial pin ${a} slot ${s} is not 32-byte hex`);
    if (e.reads[`account:${a}`] !== "mpt-proof") fail("unproven_read", `initial pin ${a} is not mpt-proof`);
  }
  const l1 = e.l1;
  safeInt(l1.timestamp, "initial l1.timestamp", "bad_initial"); safeInt(l1.ageSec, "initial l1.ageSec", "bad_initial");
  return { l1: { number: init.l1.number, hash: init.l1.hash, timestamp: l1.timestamp, ageSec: l1.ageSec },
           pins: Object.fromEntries(addrs.map((a) => [a, { codeHash: init.pins[a].codeHash, slots: init.pins[a].slots }])) };
}

/** Fresh INITIAL A1 receipt (the frozen A2 path). Its sha is of the exact bytes; a recheck is never accepted here. */
export function checkFreshInitial(bytes) {
  const sha = sha256(bytes);
  const init = loadInitialReceipt(bytes, sha, sha256);                       // reviewed: verdict, no recheckOf, labels, ASR match
  const e = parse(bytes, "bad_initial");
  if (typeof e.at !== "string" || !ISO.test(e.at)) fail("bad_initial", "initial receipt lacks its ISO `at`");
  const s = initialSummary(init, e);
  return { mode: "fresh-initial", initialSha256: sha, game: init.game, N: init.N.toString(), outputRoot: init.outputRoot, asr: init.asr,
           respectedGameType: init.respectedGameType, l1: s.l1, at: e.at, pins: s.pins };
}

/** Original-game RECHECK receipt, bound to the exact initial bytes whose sha root pinned. N/root/game always the INITIAL values. */
export function checkRecheck(initialBytes, initialSha256, recheckBytes) {
  const init = loadInitialReceipt(initialBytes, initialSha256, sha256);     // reviewed: sha of exact bytes, verdict, labels
  initialSummary(init, parse(initialBytes, "bad_initial"));
  const r = parse(recheckBytes, "bad_recheck");
  if (!obj(r) || r.verdict !== RECHECK_VERDICT) fail("not_recheck", `verdict ${obj(r) ? r.verdict : typeof r}: only ${RECHECK_VERDICT} is accepted here (an initial receipt is not a recheck)`);
  exactKeys(r, RECHECK_KEYS, "bad_recheck", "recheck receipt");
  // binding to the exact initial receipt
  const ro = r.recheckOf;
  exactKeys(ro, ["sha256", "verdict", "game", "N", "outputRoot", "asr", "l1"], "recheck_binding", "recheckOf");
  exactKeys(ro.l1, ["number", "hash"], "recheck_binding", "recheckOf.l1");
  if (ro.sha256 !== init.sha256 || ro.verdict !== INITIAL_VERDICT || ro.game !== init.game || ro.N !== init.N.toString() || ro.outputRoot !== init.outputRoot
      || ro.asr !== init.asr || ro.l1.number !== init.l1.number || ro.l1.hash !== init.l1.hash)
    fail("recheck_binding", "recheckOf does not name exactly the pinned initial receipt (sha/verdict/game/N/root/asr/l1)");
  if (r.game !== init.game || r.N !== init.N.toString() || r.outputRoot !== init.outputRoot || r.asr !== init.asr || r.respectedGameType !== init.respectedGameType)
    fail("recheck_binding", "recheck game/N/outputRoot/asr/respectedGameType differ from the initial receipt (never the latest anchor)");
  if (r.label !== RECHECK_LABEL) fail("bad_recheck", "recheck label differs from the pinned runRecheck label");
  if (typeof r.at !== "string" || !ISO.test(r.at)) fail("bad_recheck", "recheck lacks its ISO `at`");
  // a FRESH finalized block, strictly newer than the initial one
  exactKeys(r.l1, ["number", "hash", "stateRoot", "timestamp", "ageSec"], "bad_recheck", "recheck l1");
  for (const k of ["number", "timestamp", "ageSec"]) safeInt(r.l1[k], `recheck l1.${k}`, "bad_recheck");
  if (!H32.test(r.l1.hash) || !H32.test(r.l1.stateRoot)) fail("bad_recheck", "recheck l1 hash/stateRoot not lowercase 32-byte hex");
  if (r.l1.number <= init.l1.number || r.l1.hash === init.l1.hash) fail("not_fresh", `recheck block ${r.l1.number} is not newer than the initial block ${init.l1.number}`);
  if (r.l1.ageSec > DEFAULT_MAX_FINALIZED_AGE_SEC) fail("finalized_stale", `recheck finalized header was ${r.l1.ageSec} s old (max ${DEFAULT_MAX_FINALIZED_AGE_SEC})`);
  // the latest anchor is an OBSERVATION: never accepted, never regressed, never inconsistent with the original game
  const la = r.latestAnchorObservation;
  exactKeys(la, ["game", "N", "outputRoot", "advanced", "accepted", "note"], "recheck_latest", "latestAnchorObservation");
  if (la.accepted !== false) fail("recheck_latest", "latestAnchorObservation.accepted must be exactly false");
  if (!ADDR.test(la.game) || !DEC.test(la.N) || !H32.test(la.outputRoot) || la.advanced !== (la.game !== init.game)) fail("recheck_latest", "malformed latest-anchor observation");
  if (BigInt(la.N) < init.N) fail("recheck_latest", "latest anchor N is below the initial N");
  if (la.game === init.game && (la.N !== init.N.toString() || la.outputRoot !== init.outputRoot)) fail("recheck_latest", "the ASR names the original game with another root/N");
  // pins: the SAME address set and slot set as the initial OBSERVATIONS, every value unchanged (not approved versions)
  const addrs = Object.keys(init.pins).sort();
  exactKeys(r.pins, addrs, "recheck_pins", "recheck pins");
  for (const a of addrs) {
    const p = r.pins[a], was = init.pins[a];
    exactKeys(p, ["codeHash", "slots", "comparison"], "recheck_pins", `pin ${a}`);
    exactKeys(p.slots, Object.keys(was.slots).map((s) => s.toLowerCase()), "recheck_pins", `pin ${a} slots`);
    if (p.codeHash !== String(was.codeHash).toLowerCase() || p.comparison !== "unchanged-from-initial-observation") fail("recheck_pins", `${a} codeHash differs from the initial observation`);
    for (const [s, v] of Object.entries(was.slots)) if (p.slots[s.toLowerCase()] !== String(v).toLowerCase()) fail("recheck_pins", `${a} slot ${s.slice(0, 10)} differs from the initial observation`);
  }
  // reads: EXACTLY the runRecheck read set, each with its exact trust class
  const want = Object.fromEntries([...RECHECK_HELIOS_READS.map((k) => [k, "helios-call"]), ...addrs.map((a) => [`account:${a}`, "mpt-proof"])]);
  exactKeys(r.reads, Object.keys(want), "unproven_read", "recheck reads");
  for (const [k, v] of Object.entries(want)) if (r.reads[k] !== v) fail("unproven_read", `recheck read ${k} is ${r.reads[k]}, not ${v}`);
  return { mode: "original-game-recheck", initialSha256: init.sha256, game: init.game, N: init.N.toString(), outputRoot: init.outputRoot, asr: init.asr,
           respectedGameType: init.respectedGameType, l1: { number: r.l1.number, hash: r.l1.hash, timestamp: r.l1.timestamp, ageSec: r.l1.ageSec },
           initialL1: { number: init.l1.number, hash: init.l1.hash }, at: r.at,
           pins: Object.fromEntries(addrs.map((a) => [a, { codeHash: r.pins[a].codeHash, slots: r.pins[a].slots }])),
           latestAnchorObservation: { game: la.game, N: la.N, outputRoot: la.outputRoot, advanced: la.advanced, accepted: false } };
}

/** a2a4.py entry: {mode, initial (base64), initialSha256?, recheck (base64)?} -> summary. */
export function gate(i) {
  const b = (s) => new Uint8Array(Buffer.from(String(s), "base64"));
  if (i.mode === "fresh-initial") return checkFreshInitial(b(i.initial));
  if (i.mode === "original-game-recheck") return checkRecheck(b(i.initial), String(i.initialSha256), b(i.recheck));
  fail("bad_input", `unknown gate mode ${i.mode}`);
}
