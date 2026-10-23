# Independent review: Windows serving-first candidate (read-only, 2026-10-22)

**Reviewed:** `windows-serving-first/candidate` commit `829a881c` on `2afa6733`.
- `windows/node/host.mjs` `817389ec…`; `chain.mjs` `3e9fae03` unchanged.
- The test diff (`windows-node-lease-renewal-keeper.test.mjs` +65) was read only for scope.

No edits, tests or live actions. The sibling's test runs were not repeated.

## Verdict

No correctness blocker. Ownership, admin, wallet and release-fence semantics are preserved. Two small should-fix items
(F1, F3) are recommended before activation, and F2 is a known tradeoff to accept or document.

## What was verified

- **The moved body is byte-identical.** I diffed 2afa's per-tracked loop body against `#reconcileTracked`, normalising
  `continue` to `return` and stripping indentation. The ONLY difference is the deferral
  (`if (deferClaim) return "deferred";`), placed after `#walletRevoke(id)` in the `!ours` branch.
- **Every gate is unchanged per deployment, in the same order:**
  - a fresh row;
  - inactive → stop; a foreign live lease → stop;
  - placement pin → give up;
  - wallet refusal → give up; unknown → hold;
  - the held/owner-not-served/transfer stop;
  - boundary, cap and plan holds;
  - expired → retire;
  - the audit job; platform `serviceRefusal`; `releaseHold`;
  - renewal via `#renewTurn` with the permit and epoch;
  - edit, resize, `ensureApp`;
  - `#leaseSeen` keeper eligibility, then the readiness row.
- **Unchanged as well:**
  - `tick()` single-flight;
  - the release journal and `#giveUpOnce`'s wait for a renewal in flight;
  - the pre-work order (journal, book, `enforceOff`, owners, registration, prices).
- **The deferral keeps 2afa's semantics.** The grant is still revoked at once. The `claimedAt` < 120 s guard still
  returns without deferring. Phase 2 re-reads the row before `consider()`.
- **`scanLedger` skips records whose status is running, provisioning or claiming.** So a deferred re-claim is not
  attempted twice in one pass, except a tracked record in status `failed`. That double attempt (scan plus loop) already
  exists in 2afa: not a regression.
- **`retireForeignRecovered` stays AFTER `scanLedger`, which is correct.** The scan re-tracks live leases this box holds
  but no longer tracks. Retiring before the scan would treat their recovered VMs as foreign.

## Findings

**F1. A deployment stopped in phase 1 and re-claimed by the sweep is not reconciled in that pass.** Should-fix; small.
- Phase 1 retires an expired own lease (`!leaseLive` → `#stopApp`, untracked, status `stopped`).
- `scanLedger` then sees an untracked, claimable row and `consider()`s it in the SAME pass (2afa: next pass).
- Phase 2 skips it, because its condition is `!first.includes(id) || deferred.has(id)` and `first` contains it.
- **Effect:** the app is cold-restarted seconds after its retire (claim gates still apply). Its readiness row stays
  `pending` and keeper eligibility waits a full pass. A fresh 1800 s lease makes this non-urgent.
- **Fix:** select phase 2 by "tracked now and not reconciled through to a row in phase 1" (record the ids phase 1
  completed or stopped), not by membership of `first`. Alternatively, reconcile ids re-added by the sweep even when they
  were in `first`.

**F2. After a MANAGER or host restart only, phase-1 fresh spawns can meet the manager's 503 while foreign recovered VMs
remain.** Tradeoff; document it.
- The manager refuses any RAM allocation while any domain is `recovered || unattributed`
  (`windows/vbslike/manager/server.mjs:527–528`).
- 2afa retired foreign recovered VMs before the tracked loop. The candidate does it after phase 1.
- A refused spawn is a transient hold (provisioning), not a give-up or release, so this delays the spawn by one pass.
- Moving the retire earlier is wrong (see the scan re-tracking above).
- A node-only restart (helper 7ac1 / node-activate) leaves the manager and its VMs non-recovered, so it is **unaffected**.

**F3. An uncaught throw in phase 1 now also blocks the claim sweep.** Should-fix; small.
- In 2afa a throw inside the loop (for example from `ensureApp` → `#isolationReconcile`/manager calls, or
  `#stopApp`/`#retireIsolated`) aborted the rest of the loop, but `scanLedger` had already run.
- In the candidate it aborts `#tickOnce` before `scanLedger`. So one persistently throwing tracked app stops all new
  claims and lease resumptions, on top of starving the apps after it (the latter is pre-existing).
- **Fix:** wrap each `#reconcileTracked` call (both phases) in a per-id `catch` that logs. That is strictly better than
  either version, and it changes no gate.

**No other issues found** in:
- the ordering races with the keeper (`#leaseSeen` delete/republish, `#renewTurn` join, permit epoch);
- ownership/admin gates, release fences, and single-flight;
- readiness: `tick()` still seeds `pending` rows for the pass's tracked set, phase 1 publishes them earlier, and the global
  `completedAt` is unchanged.

## Test scope and limits (not run by me)

- **Sibling-reported:** the base fails 2/14; the candidate passes 14 + 67 + 29 + 9; mutants `no-defer` and `no-phase2`
  are killed (logs in `windows-serving-first/logs/`). I did not verify this independently.
- **Not covered, to add if F1/F3 are fixed:**
  - an expired own lease re-claimed by the sweep in the same pass (F1);
  - a phase-1 reconcile that throws while the sweep still runs (F3);
  - a manager restart with a foreign recovered VM present (F2; expect a one-pass spawn delay, no release).
- **No native Windows run.** The live installed pair is still the old one (2afa not activated).
