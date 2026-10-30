// TEST STUB a1-recheck-read.mjs (re-anchor r3 tests only): an original-game recheck of EXACTLY the initial receipt it is given
// (argv[3]), in runRecheck's output shape (as the harness fixture's make_recheck), stamped NOW.
import fs from "node:fs";
import crypto from "node:crypto";
import { tag } from "./test/deps.mjs";
const initial = fs.readFileSync(process.argv[3]);
const ini = JSON.parse(initial), now = new Date(), addrs = Object.keys(ini.pins);
const READS = ["portalAsr", "paused", "respectedGameType", "isGameFinalized", "isGameRespected", "isGameBlacklisted", "isGameRetired", "gameStatus",
  "gameRootClaim", "gameL2SequenceNumber", "gameType", "gameAnchorStateRegistry", "latestAnchorRoot", "latestAnchorGame"];
const LABEL = "A1 original-game recheck: Helios-light-client-relative; pins compared to initial OBSERVATIONS (not approved versions); not SNP/attested";
void tag;
process.stdout.write(JSON.stringify({
  verdict: "A1-original-game-recheck-passed",
  recheckOf: { sha256: crypto.createHash("sha256").update(initial).digest("hex"), verdict: "A1-authenticated", game: ini.game, N: ini.N,
               outputRoot: ini.outputRoot, asr: ini.asr, l1: { number: ini.l1.number, hash: ini.l1.hash } },
  game: ini.game, N: ini.N, outputRoot: ini.outputRoot, asr: ini.asr, respectedGameType: ini.respectedGameType,
  l1: { number: ini.l1.number + 1000, hash: "0x" + "5a".repeat(32), stateRoot: "0x" + "5b".repeat(32), timestamp: Math.floor(now.getTime() / 1000) - 1000, ageSec: 952 },
  latestAnchorObservation: { game: ini.game, N: ini.N, outputRoot: ini.outputRoot, advanced: false, accepted: false,
                             note: "observation only: the bootstrap stays bound to the original game/N; descendants are never accepted here" },
  pins: Object.fromEntries(addrs.map((a) => [a, { codeHash: ini.pins[a].codeHash, slots: { ...ini.pins[a].slots }, comparison: "unchanged-from-initial-observation" }])),
  reads: { ...Object.fromEntries(READS.map((k) => [k, "helios-call"])), ...Object.fromEntries(addrs.map((a) => [`account:${a}`, "mpt-proof"])) },
  label: LABEL, at: now.toISOString() }));
