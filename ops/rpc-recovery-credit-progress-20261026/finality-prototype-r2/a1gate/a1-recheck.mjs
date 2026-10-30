// A1 original-game RE-CHECK (finality-stage/a1-original-game, README.md).
// During a long A2-A4 rebuild the ASR's latest anchor may advance. The bootstrap stays bound to the ORIGINAL game G and
// its N/output root from the INITIAL A1 receipt; this module re-proves, at a FRESH Helios-finalized L1 block, that G is
// still eligible with exactly the same root and N, and that the portal/ASR/G code and proxy pins are unchanged.
// It never accepts the latest anchor or its descendants and never changes N.
//
// Reuses the pinned, unmodified A1 primitives (./a1-anchor.mjs sha256 ec92b70f...): validateConfig, callData, abi,
// checkProofResponse (independent MPT verification), EIP-1967 slot constants. keccak / headerHash / sha256 are injected.
import { A1Error, validateConfig, callData, abi, checkProofResponse, ASR_GAME_CALLS, EIP1967_IMPLEMENTATION_SLOT, EIP1967_ADMIN_SLOT, MAX_FUTURE_SKEW_SEC } from "./a1-anchor.mjs";

export const INITIAL_VERDICT = "A1-authenticated";
export const RECHECK_VERDICT = "A1-original-game-recheck-passed";
const fail = (code, message) => { throw new A1Error(code, message); };
const lc = (s) => String(s).toLowerCase();
const ADDR = /^0x[0-9a-f]{40}$/, H32 = /^0x[0-9a-f]{64}$/;
const ZERO = "0x" + "0".repeat(40);
const qty = (h, what) => { if (typeof h !== "string" || !/^0x(0|[1-9a-f][0-9a-f]*)$/i.test(h)) fail("bad_answer", `${what} is not a quantity`); return BigInt(h); };
const safe = (v, what) => { if (v > BigInt(Number.MAX_SAFE_INTEGER)) fail("unsafe_integer", `${what} exceeds MAX_SAFE_INTEGER`); return Number(v); };
const deepFreeze = (o) => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
const word = (k, v) => "0x" + v.toString(16).padStart(64, "0");

/**
 * The INITIAL A1 receipt, bound by the sha256 of its exact bytes. Only verdict "A1-authenticated" from runA1 is accepted:
 * a recheck output (or anything carrying recheckOf) is never initial evidence.
 */
export function loadInitialReceipt(bytes, expectedSha256, sha256) {
  if (!(bytes instanceof Uint8Array)) fail("bad_input", "initial receipt must be the exact file bytes");
  const sha = lc(sha256(bytes));
  if (!H32.test(lc("0x" + sha)) || sha !== lc(expectedSha256).replace(/^0x/, "")) fail("initial_sha", `initial receipt sha256 ${sha} != configured ${expectedSha256}`);
  let e;
  try { e = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { fail("bad_initial", "initial receipt is not UTF-8 JSON"); }
  if (e.verdict !== INITIAL_VERDICT || "recheckOf" in e) fail("not_initial_a1", `initial receipt verdict ${e.verdict}: only an initial ${INITIAL_VERDICT} receipt is accepted (a recheck is never initial evidence)`);
  if (!/^[1-9][0-9]*$/.test(String(e.N)) || !H32.test(lc(e.outputRoot)) || !ADDR.test(lc(e.game)) || !ADDR.test(lc(e.asr)) || !Number.isInteger(e.respectedGameType))
    fail("bad_initial", "initial receipt lacks N/outputRoot/game/asr/respectedGameType");
  if (!e.l1 || !Number.isSafeInteger(e.l1.number) || !H32.test(lc(e.l1.hash))) fail("bad_initial", "initial receipt lacks its L1 block");
  const reads = e.reads || {};
  if (!Object.keys(reads).length || Object.values(reads).some((s) => s !== "helios-call" && s !== "mpt-proof")) fail("bad_initial", "initial receipt carries a non-authenticated read label");
  if (!(e.asrCandidates || []).some((c) => lc(c.address) === lc(e.asr) && c.authenticatedMatch === true)) fail("bad_initial", "initial receipt does not record the authenticated ASR match");
  return deepFreeze({ sha256: sha, game: lc(e.game), N: BigInt(e.N), outputRoot: lc(e.outputRoot), asr: lc(e.asr), respectedGameType: e.respectedGameType,
                      l1: { number: e.l1.number, hash: lc(e.l1.hash) }, pins: e.pins || {} });
}

export function validateRecheckConfig(cfg0, init) {
  const cfg = validateConfig(cfg0);                                   // pinned A1 rules (addresses, getter, chain, pinBy, age)
  const g = lc(cfg0.originalGame), N = String(cfg0.originalN), root = lc(cfg0.originalOutputRoot);
  if (!ADDR.test(g) || !/^[1-9][0-9]*$/.test(N) || !H32.test(root)) fail("bad_config", "originalGame / originalN / originalOutputRoot must be explicit");
  if (g !== init.game || BigInt(N) !== init.N || root !== init.outputRoot || cfg.asr !== init.asr)
    fail("binding_mismatch", "configured original game/N/root/asr differ from the initial A1 receipt");
  // every slot OBSERVED in the initial receipt is re-proved and compared: pinSlots (default the two EIP-1967 slots) must
  // equal each address's initial slot set exactly (no subset, no superset)
  const pinSlots = (cfg0.pinSlots ?? [EIP1967_IMPLEMENTATION_SLOT, EIP1967_ADMIN_SLOT]).map((x) => "0x" + BigInt(x).toString(16).padStart(64, "0"));
  for (const a of [cfg.portal, cfg.asr, g]) {
    const p = init.pins[a];
    const keys = p && p.slots ? Object.keys(p.slots).map(lc).sort() : [];
    if (!p || !H32.test(lc(p.codeHash)) || keys.length !== pinSlots.length || keys.join() !== [...pinSlots].sort().join())
      fail("bad_initial", `initial receipt pins for ${a} do not match the compared slot set exactly`);
  }
  return { ...cfg, originalGame: g, pinSlots };
}

/** Re-prove original game G at a FRESH Helios-finalized block. io.helios / io.el: (method, params) => result. */
export async function runRecheck(cfg0, initialBytes, io, { keccak, headerHash, sha256, now = () => Date.now() }) {
  const init = loadInitialReceipt(initialBytes, cfg0.initialEvidenceSha256, sha256);
  const cfg = validateRecheckConfig(cfg0, init);
  const G = cfg.originalGame;
  if (BigInt(await io.helios("eth_chainId", [])) !== 1n) fail("wrong_chain", "Helios is not on chain 1");
  const fin = await io.helios("eth_getBlockByNumber", ["finalized", false]);
  if (!fin || !H32.test(lc(fin.hash))) fail("no_finality", "Helios has no finalized block");
  const at = { blockHash: lc(fin.hash) };
  const hdr = await io.el("eth_getBlockByHash", [at.blockHash, false]);
  if (!hdr || headerHash(hdr, keccak) !== at.blockHash) fail("header_mismatch", "EL header does not hash to the Helios-finalized hash");
  const number = safe(qty(hdr.number, "header.number"), "header.number"), ts = safe(qty(hdr.timestamp, "header.timestamp"), "header.timestamp");
  if (safe(qty(fin.number, "finalized.number"), "finalized.number") !== number) fail("finalized_number_mismatch", "Helios finalized number != header number");
  if (fin.timestamp !== undefined && Number(qty(fin.timestamp, "finalized.timestamp")) !== ts) fail("finalized_timestamp_mismatch", "Helios finalized timestamp != header timestamp");
  if (number <= init.l1.number || at.blockHash === init.l1.hash) fail("not_fresh", `recheck block ${number} is not newer than the initial A1 block ${init.l1.number}`);
  const t = Math.floor(now() / 1000);
  if (ts > t + MAX_FUTURE_SKEW_SEC) fail("finalized_future", `finalized header is ${ts - t} s in the future`);
  if (t - ts > cfg.maxFinalizedAgeSec) fail("finalized_stale", `finalized header is ${t - ts} s old (max ${cfg.maxFinalizedAgeSec})`);
  const stateRoot = lc(hdr.stateRoot);
  const callAt = cfg.pinBy === "finalized-tag" ? "finalized" : at;
  const call = async (to, sig, args = []) => {
    try { return await io.helios("eth_call", [{ to, data: callData(sig, args, keccak) }, callAt]); }
    catch (e) { fail("helios_call_failed", `${sig} on ${to}: ${String(e?.message || e).slice(0, 160)}`); }
  };
  const reads = {};
  const h = async (name, to, sig, kind, args) => { const ret = await call(to, sig, args); const v = kind === "uint8" ? Number(abi.uint(ret, 8)) : kind === "uint32" ? Number(abi.uint(ret, 32)) : abi[kind](ret); reads[name] = "helios-call"; return v; };
  // identity
  const portalAsr = lc(await h("portalAsr", cfg.portal, cfg.portalAsrGetter, "address"));
  if (portalAsr !== init.asr) fail("asr_changed", `portal now names ASR ${portalAsr}, the initial A1 bound ${init.asr}`);
  if (await h("paused", cfg.asr, "paused()", "bool")) fail("asr_paused", "AnchorStateRegistry is paused");
  const respectedGameType = await h("respectedGameType", cfg.asr, "respectedGameType()", "uint32");
  if (respectedGameType !== init.respectedGameType) fail("respected_type_changed", `respected game type ${respectedGameType} != initial ${init.respectedGameType}: refuse pending operator review`);
  // the ORIGINAL game's eligibility at this block
  const flags = {};
  for (const [name, sig] of Object.entries(ASR_GAME_CALLS)) flags[name] = await h(name, cfg.asr, sig, "bool", [G]);
  if (!flags.isGameRespected) fail("game_not_respected", "original game is no longer respected");
  if (!flags.isGameFinalized) fail("game_not_finalized", "original game is not finalized");
  if (flags.isGameBlacklisted) fail("game_blacklisted", "original game is blacklisted");
  if (flags.isGameRetired) fail("game_retired", "original game is retired");
  if (await h("gameStatus", G, "status()", "uint8") !== 2) fail("game_not_defender_wins", "original game status != DEFENDER_WINS");
  if (lc(await h("gameRootClaim", G, "rootClaim()", "bytes32")) !== init.outputRoot) fail("root_changed", "original game rootClaim differs from the initial A1 root");
  if (await h("gameL2SequenceNumber", G, "l2SequenceNumber()", "uint") !== init.N) fail("number_changed", "original game l2SequenceNumber differs from the initial A1 N");
  if (await h("gameType", G, "gameType()", "uint32") !== init.respectedGameType) fail("game_type_changed", "original game type differs from the initial respected type");
  if (lc(await h("gameAnchorStateRegistry", G, "anchorStateRegistry()", "address")) !== init.asr) fail("game_asr_changed", "original game names a different ASR");
  // the latest anchor: OBSERVATION ONLY (never accepted, never moves N)
  const latest = abi.rootAndNumber(await call(cfg.asr, "getAnchorRoot()")); reads.latestAnchorRoot = "helios-call";
  const latestGame = lc(await h("latestAnchorGame", cfg.asr, "anchorGame()", "address"));
  if (latest.l2SequenceNumber < init.N) fail("anchor_regressed", `ASR anchor N ${latest.l2SequenceNumber} is below the initial N ${init.N}`);
  if (latestGame === G && (lc(latest.root) !== init.outputRoot || latest.l2SequenceNumber !== init.N)) fail("anchor_inconsistent", "ASR names the original game with a different root/N");
  // code / proxy pins: independently verified proofs at THIS block, compared with the initial observations
  const pins = {};
  const slots = cfg.pinSlots;
  for (const a of [...new Set([cfg.portal, cfg.asr, G])]) {
    const pr = await io.el("eth_getProof", [a, slots, at]);
    if (lc(pr?.address) !== a) fail("proof_address", `eth_getProof answered for ${pr?.address}, asked ${a}`);
    const got = (pr.storageProof || []).map((sp) => "0x" + BigInt(sp.key).toString(16).padStart(64, "0"));
    if (got.length !== slots.length || got.some((x, i) => x !== slots[i])) fail("proof_slots", `eth_getProof for ${a} did not prove exactly the pinned slots`);
    const v = checkProofResponse(stateRoot, pr, keccak);
    reads[`account:${a}`] = "mpt-proof";
    const was = init.pins[a];
    const now1967 = Object.fromEntries(slots.map((s) => [s, word(s, v.storage[s])]));
    if (v.codeHash !== lc(was.codeHash)) fail("code_or_proxy_changed", `${a} codeHash changed since the initial A1: refuse pending operator review`);
    for (const s of slots) if (now1967[s] !== lc(was.slots[s])) fail("code_or_proxy_changed", `${a} EIP-1967 slot ${s.slice(0, 10)} changed since the initial A1: refuse pending operator review`);
    pins[a] = { codeHash: v.codeHash, slots: now1967, comparison: "unchanged-from-initial-observation" };
  }
  if (cfg.pinBy === "finalized-tag") {
    const after = await io.helios("eth_getBlockByNumber", ["finalized", false]);
    if (lc(after?.hash) !== at.blockHash) fail("finality_moved", "Helios finalized block changed during the recheck; rerun");
  }
  return deepFreeze({
    verdict: RECHECK_VERDICT,
    recheckOf: { sha256: init.sha256, verdict: INITIAL_VERDICT, game: init.game, N: init.N.toString(), outputRoot: init.outputRoot, asr: init.asr, l1: init.l1 },
    game: G, N: init.N.toString(), outputRoot: init.outputRoot, asr: init.asr, respectedGameType,
    l1: { number, hash: at.blockHash, stateRoot, timestamp: ts, ageSec: t - ts },
    latestAnchorObservation: { game: latestGame, N: latest.l2SequenceNumber.toString(), outputRoot: lc(latest.root), advanced: latestGame !== G, accepted: false,
                               note: "observation only: the bootstrap stays bound to the original game/N; descendants are never accepted here" },
    pins, reads,
    label: "A1 original-game recheck: Helios-light-client-relative; pins compared to initial OBSERVATIONS (not approved versions); not SNP/attested",
  });
}
