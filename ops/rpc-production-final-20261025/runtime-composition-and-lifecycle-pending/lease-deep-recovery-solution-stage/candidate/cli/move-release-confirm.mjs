// The owner-move hand-off decision (cli/enclave.mjs cmdMoveIndependent), pure: no network, no chain, no clock of its own.
// ONE release request is sent; whatever it answers, only the owner's own reading of the CURRENT ledger decides whether
// the source's lease is gone. The host's release receipt is never re-verified here, and nothing here claims it was: a
// release that landed long ago (e.g. more than the canonical verifier's 256-block window before the host could resolve
// it, after a restart or an outage) is reported as "the source no longer holds the lease", never as a verified
// release. That absence is read at the unsafe head, so it must hold on `confirmations` successive snapshots at strictly
// increasing blocks: a snapshot showing the source's lease again (a reorg, or a stale read) resets the count. It is not
// finality. A quorum that cannot be read is "unknown", never "still held", and never a reason to send anything again.
//
// confirmSourceLeaseCleared({release, snapshot, source, sleep, now, ...}) -> {outcome, ...}
//   release()      the source host's release (management-client.mjs): resolves {json} for a host-reported release, or
//                  throws a ManagementError {code, outcomeUnknown}. Called EXACTLY once.
//   snapshot()     the owner's ledger read (moveSnapshot(id, null)): {runner, held, block, d}; throws when unreadable.
//   source         the runner id that held the lease before the move (m.runner).
// outcomes:
//   cleared            the source's lease is absent on `confirmations` snapshots; {block, how, released, receiptVerified}
//                      how: 'released' (runner zeroed) | 'lapsed' (still the source's id, lease ran out) | 'taken'
//                      (another runner holds it). receiptVerified is true ONLY when the host answered released:true.
//   refused            the host refused before any effect (a definite answer) and the source still holds the lease
//   still-held         every readable snapshot until the deadline showed the source's lease
//   clear-unconfirmed  absence was seen, but not on `confirmations` increasing blocks before the deadline (or it was
//                      contradicted afterwards): unknown, not cleared
//   quorum-unavailable no snapshot could be read before the deadline: unknown
export const MOVE_RELEASE = Object.freeze({ answerWaitMs: 90_000, pollMs: 3000, confirmations: 2 });

const ZERO = /^0x0{64}$/;

export async function confirmSourceLeaseCleared({ release, snapshot, source, sleep, now, waitMs = MOVE_RELEASE.answerWaitMs,
  pollMs = MOVE_RELEASE.pollMs, confirmations = MOVE_RELEASE.confirmations } = {}) {
  if (typeof release !== "function" || typeof snapshot !== "function" || typeof sleep !== "function" || typeof now !== "function")
    throw new TypeError("release, snapshot, sleep and now are required");
  if (!(Number.isInteger(confirmations) && confirmations >= 1)) throw new TypeError("confirmations must be a positive integer");
  const src = String(source).toLowerCase();
  let rel = null, relErr = null;
  try { rel = await release(); } catch (e) { relErr = e || new Error("release failed"); }
  // a definite refusal (outcomeUnknown false, a code the host answers before any effect): nothing was stopped or signed
  const definite = !rel && !!relErr && !relErr.outcomeUnknown;
  const answer = rel ? { kind: "released", txHash: rel.json?.txHash ?? null }
    : { kind: definite ? "refused" : "unknown", code: relErr.code ?? null, message: String(relErr.message || "") };
  const receiptVerified = !!(rel && rel.json && rel.json.released === true);
  let reads = 0, failures = 0, streak = [], sawClear = false, lastHeldBlock = null;
  for (const until = now() + waitMs; ;) {
    let n = null;
    try { n = await snapshot(); } catch { failures++; }
    if (n && Number.isSafeInteger(n.block)) {
      reads++;
      const runner = String(n.runner).toLowerCase();
      const sourceHolds = runner === src && !!n.held;
      if (sourceHolds) { streak = []; lastHeldBlock = n.block; }
      else if (!streak.length || n.block > streak[streak.length - 1].block) {
        // only a later block counts; a read at the same or a lower block (a lagging peer) neither adds nor resets
        streak.push({ block: n.block, runner, held: !!n.held, d: n.d });
        sawClear = true;
      }
      if (streak.length >= confirmations) {
        const last = streak[streak.length - 1];
        const how = ZERO.test(last.runner) ? "released" : last.runner === src ? "lapsed" : "taken";
        return { outcome: "cleared", block: last.block, firstBlock: streak[0].block, how, runner: last.runner, d: last.d,
                 answer, receiptVerified, reads, failures };
      }
    } else if (n) failures++;
    // a definite refusal reads the ledger once (the lease may already be gone for another reason), then stops
    if (definite && (reads > 0 || now() >= until)) {
      if (!streak.length) return { outcome: "refused", answer, receiptVerified: false, reads, failures, block: lastHeldBlock };
    }
    if (now() >= until) break;
    await sleep(pollMs);
  }
  if (!reads) return { outcome: "quorum-unavailable", answer, receiptVerified, reads, failures };
  if (sawClear) return { outcome: "clear-unconfirmed", answer, receiptVerified, reads, failures,
                         block: streak.length ? streak[streak.length - 1].block : null, heldAgainAt: lastHeldBlock };
  return { outcome: "still-held", answer, receiptVerified, reads, failures, block: lastHeldBlock };
}
