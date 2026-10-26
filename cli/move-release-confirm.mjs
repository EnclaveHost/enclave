// The owner-move hand-off decision (cli/enclave.mjs cmdMoveIndependent), pure: no network, no chain, no clock of its own.
// ONE release request is sent; whatever it answers, only the owner's own reading of the CURRENT ledger decides whether
// the source's lease is gone. Two different things are kept apart and never merged:
//   * the SOURCE HOST's claim: it answered released:true (its own receipt, as it reports it). Nothing here verifies that
//     receipt; it is reported as the host's claim (sourceReportedReleased), never as a verified release;
//   * the OWNER's observation: the ledger read through moveSnapshot (QuorumChain.snapshot, cli/independent.mjs) shows the
//     source's lease absent. It must be observed on `confirmations` validated snapshots at strictly increasing blocks;
//     a snapshot showing the source's lease again resets the count. That confirms a repeated OBSERVATION only: it is not
//     protection against reorgs and not finality.
// Every snapshot is validated against moveSnapshot's actual shape (below); anything else is a failed read, never an
// absence. A quorum that cannot be read is "unknown", never "still held", and never a reason to send anything again.
//
// confirmSourceLeaseCleared({release, snapshot, source, sleep, now, ...}) -> {outcome, ...}
//   release()   the source host's release (network/management-client.mjs ManagementClient.release): resolves {json}, or
//               throws. ONLY a ManagementError whose outcomeUnknown is exactly false is a definite refusal (the
//               classifier's pre-effect refusals); any other throw is outcome-unknown. Called EXACTLY once.
//   snapshot()  moveSnapshot(id, null); throws when unreadable.
//   source      the runner id (bytes32) that held the lease before the move (m.runner).
// outcomes:
//   cleared            absence observed on `confirmations` validated snapshots; {how, firstBlock, block, runner, d}
//                      how: 'runner-cleared' (runner zeroed) | 'lapsed' (still the source's id, lease ran out) |
//                      'taken' (another runner holds it)
//   refused            a definite refusal, and a validated snapshot shows the source still holds the lease
//   still-held         every validated snapshot until the deadline showed the source's lease
//   clear-unconfirmed  absence was observed, but not on `confirmations` increasing blocks before the deadline, or it was
//                      contradicted by a later snapshot: unknown
//   quorum-unavailable no validated snapshot before the deadline: unknown (also after a definite refusal)
// Every result carries {sourceReport: 'released'|'refused'|'unknown', sourceReportedReleased, reads, failures, malformed}.
export const MOVE_RELEASE = Object.freeze({ answerWaitMs: 90_000, pollMs: 3000, confirmations: 2 });

const BYTES32 = /^0x[0-9a-f]{64}$/;
const ZERO = "0x" + "0".repeat(64);
const MANAGEMENT_ERRORS = new Set(["ManagementError", "ManagementBrowserError"]);

/** moveSnapshot(id, null)'s exact shape -> a normalized observation, or null (fail closed). */
export function validateMoveSnapshot(n) {
  if (!n || typeof n !== "object") return null;
  const block = typeof n.block === "bigint" ? n.block
    : (typeof n.block === "number" && Number.isSafeInteger(n.block)) ? BigInt(n.block) : null;
  if (block === null || block < 0n) return null;
  if (typeof n.runner !== "string" || !BYTES32.test(n.runner)) return null;           // moveSnapshot lowercases it
  if (typeof n.held !== "boolean") return null;
  if (typeof n.blockTime !== "number" || !Number.isSafeInteger(n.blockTime) || n.blockTime < 0) return null;
  const d = n.d;
  if (!d || typeof d !== "object") return null;
  if (typeof d.runner !== "string" || d.runner.toLowerCase() !== n.runner) return null;
  if (typeof d.leaseUntil !== "bigint" || d.leaseUntil < 0n) return null;              // uint64 (viem: bigint)
  if (typeof d.balance6 !== "bigint" || d.balance6 < 0n) return null;                  // uint256, printed by the CLI
  // held is moveSnapshot's own derivation; a value that disagrees with its inputs is not a valid read
  if (n.held !== (n.runner !== ZERO && d.leaseUntil > BigInt(n.blockTime))) return null;
  return { block, runner: n.runner, held: n.held, d };
}

export async function confirmSourceLeaseCleared({ release, snapshot, source, sleep, now, waitMs = MOVE_RELEASE.answerWaitMs,
  pollMs = MOVE_RELEASE.pollMs, confirmations = MOVE_RELEASE.confirmations } = {}) {
  if (typeof release !== "function" || typeof snapshot !== "function" || typeof sleep !== "function" || typeof now !== "function")
    throw new TypeError("release, snapshot, sleep and now are required");
  if (!(Number.isInteger(confirmations) && confirmations >= 1)) throw new TypeError("confirmations must be a positive integer");
  const src = String(source).toLowerCase();
  if (!BYTES32.test(src)) throw new TypeError("source must be a bytes32 runner id");
  let rel = null, relErr = null;
  try { rel = await release(); } catch (e) { relErr = e ?? new Error("release failed"); }
  const definite = !rel && relErr instanceof Error && MANAGEMENT_ERRORS.has(relErr.name) && relErr.outcomeUnknown === false;
  const sourceReportedReleased = !!(rel && rel.json && typeof rel.json === "object" && rel.json.released === true);
  const answer = rel ? { kind: sourceReportedReleased ? "released" : "unknown", txHash: rel.json?.txHash ?? null, code: null, message: "" }
    : { kind: definite ? "refused" : "unknown", txHash: null, code: typeof relErr?.code === "string" ? relErr.code : null,
        message: String(relErr?.message || relErr || "") };
  const tally = () => ({ sourceReport: answer.kind, sourceReportedReleased, answer, reads, failures, malformed });
  let reads = 0, failures = 0, malformed = 0, streak = [], sawClear = false, lastHeldBlock = null;
  for (const until = now() + waitMs; ;) {
    let raw = null, ok = true;
    try { raw = await snapshot(); } catch { ok = false; failures++; }
    const n = ok ? validateMoveSnapshot(raw) : null;
    if (ok && !n) malformed++;
    if (n) {
      reads++;
      if (n.runner === src && n.held) { streak = []; lastHeldBlock = n.block; }
      else if (!streak.length || n.block > streak[streak.length - 1].block) { streak.push(n); sawClear = true; }
      // a read at the same or a lower block than the last absence neither adds nor resets
      if (streak.length >= confirmations) {
        const last = streak[streak.length - 1];
        const how = last.runner === ZERO ? "runner-cleared" : last.runner === src ? "lapsed" : "taken";
        return { outcome: "cleared", how, firstBlock: streak[0].block, block: last.block, runner: last.runner, d: last.d, ...tally() };
      }
      // a definite refusal stops at its first VALIDATED read showing the source's lease (nothing was stopped or signed)
      if (definite && !streak.length) return { outcome: "refused", block: lastHeldBlock, ...tally() };
    }
    if (now() >= until) break;
    await sleep(pollMs);
  }
  if (!reads) return { outcome: "quorum-unavailable", ...tally() };
  if (sawClear) return { outcome: "clear-unconfirmed", block: streak.length ? streak[streak.length - 1].block : null, heldAgainAt: lastHeldBlock, ...tally() };
  return { outcome: "still-held", block: lastHeldBlock, ...tally() };
}
