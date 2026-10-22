# Node-wide restart: readiness and critical path (review only; no source changed)

Reviewer: Claude. Date: 2026-10-22. Read-only, from local source. Nothing was run; no helper suite was repeated.

**Sources:**
- installed baseline `host.mjs` `9634cb40` (`root-control-rpc-final-20261022/control-package/files/windows/node/host.mjs`);
- candidate `host.mjs` `3881bd28`. This is the renewal worker's UNCOMMITTED working copy on `ad4a72a` in `adapter-admission-review/candidate`; I did not edit it.

Line numbers are baseline / candidate.

## 0. Verdict

1. **The adapter-only gate is wrong.** A node-wide restart stops renewal and service for EVERY app the process runs. `expectedIds` must be the full set of RUNNING deployments the old process serves (from identify). The lease budget uses the MIN over all of them, and spread renewal phases subtract directly. Recommending only the adapter was not defensible; the earlier RESULT's section 5 note is withdrawn.
2. **Per-app evidence from the new process's current pass is defensible in principle.** It need not wait for global `inFlight=false`: everything that services or renews a given app happens inside that app's own loop step, before its row is published. Post-loop work is domain and certificate work.
   - **It is not defensible on today's row semantics.** A `ready` row does not prove the app was reconciled (caught envelope or resize errors still publish `ready`). In the candidate it does not prove the new process's between-pass renewal keeper will renew the app either.
   - A host.mjs field is needed: the renewal worker's file, root's decision.
3. **It would not by itself make the lease arithmetic fit.** The per-app saving is the post-loop work plus the apps after the last expected one. It is unmeasured and may be small: the pre-loop `scanLedger` and the per-app quorum reads dominate a pass (rpc-budget-review). The 7–8 min figure is the steady-state spacing between passes, not a measured first pass after a restart, and nothing local splits it by phase.
4. **The tested reserves do NOT cover returning from a RUNNING but unready new process.**
   - `recovery-start` reserves resolving the files plus one pass, but not stopping the failed process.
   - `full-return` reserves one forward-sized window. The helper's own `-Mode rollback` would demand a further reserve on top, which a just-failed forward has consumed.
   - So after `NOT_READY`, no helper-driven return can run in the same lease cycle.

## 1. What a pass actually does

**Baseline structure:**
- **Pass start:** `tick()` (2065–2075) resets `#leaseChecks` to `pending` for every tracked id, and the 30 s interval joins a running pass.
- **`#tickOnce` (2088), in order:**
  1. **Global pre-work, always awaited before any per-app step:**
     - release journal, `followBook`, `enforceOff`, `refreshOwners`, registration, `ensureRegistered`, `ensurePriced`;
     - `scanLedger` (2103 / 2287), which pages ALL ledger deployments and may claim and launch new ones;
     - `retireForeignRecovered`.
  2. **Per tracked id, serially (2105–2262):**
     - `readDeployment`; inactive / foreign / expired → stop or reclaim, then `continue`;
     - placement refusal;
     - wallet policy (2130). A refusal gives the app up; an unknown → `#walletHold` (2135) + `continue`. In both cases the row stays `pending`;
     - holds (held, boundary, cap, plan / isolation / reboot): `continue`, or not renewed;
     - renewal, only inside the window (`renewLeadMs` = 285 s here). The baseline renews in the pass (2216–2240); the candidate shares one sender with the keeper (`#renewTurn`/`#renewSend`);
     - envelope edit (2247) and resize (2251), errors CAUGHT;
     - `ensureApp` if not running (adoption after a restart), which itself may `#walletHold` (1397);
     - the row is published (2257–2262 / 2445–2450): `ready` iff renewal did not fail, it is serving and running, not held, not refused, not under a release hold, active, ours, and leased now.
  3. **After the loop (2270– / 2458–):** `refreshDomains` for every app, and app-zone certificate work.
- **Pass end:** `completedAt` is set when all of `#tickOnce` settles. `inFlight` covers ALL of the above.

**What is REQUIRED for "app X is serviced and renewable by the NEW process":**
- X's loop step completed with its row `ready`;
- the host-state row `running`, with `leaseUntil` beyond the margin;
- the new agent owns 9600;
- in the candidate, keeper eligibility (`#leaseSeen` set, 2440). Only then will the new process renew X between passes. Without it, renewal rests on one attempt per ~7-minute pass: the 10-22 failure mode.

**What is NOT required for X:**
- other apps' loop steps;
- post-loop `refreshDomains` and certificate work. These are service quality: custom domains and the app-zone padlock. Certificates are fetched through `ensureCert(dir)`; on-disk reuse across a restart is unverified. They belong in the validation window;
- global pre-work belongs to the same pass and always precedes the loop, so it cannot be skipped anyway.

## 2. Races and false-ready states for a per-app gate

| # | state | effect | mitigation |
|---|---|---|---|
| R1 | Envelope edit or resize throws (caught: 2247/2251; candidate 2425–2431) | the row is still `ready` (`leaseServing` has no `reconciled` term), while the app runs an outdated config or size. In the candidate the keeper is NOT eligible (`reconciled=false` → no `#leaseSeen`), so between-pass renewal is silently off | host.mjs must expose it: `ready` must require `reconciled`, or a separate `keeperEligible` field must be published. The renewal worker's file; root decides |
| R2 | Candidate: `ready` but `#leaseSeen` not set for another reason (served `appRef`/`envelope`/`owner`/`isPublic` ≠ the row: 2436–2439) | the keeper skips the app; renewal waits for a pass | as R1: publish eligibility |
| R3 | Renewal not due in the first pass | `ready` means "the renewal path did not fail", not "renewed". Renewability is only proven when a renewal lands | require `leaseUntil − now` to leave the keeper its ~4 retries (≥ 285 s window) after acceptance, or observe one renewal in the validation window |
| R4 | Wallet unknown or hold (2130–2136; ensureApp 1397) | the row stays `pending` (no false-ready) | none needed |
| R5 | Rows reset when the next pass starts (`tick()` 2069) | a reader mid-pass sees earlier rows of the CURRENT sequence and `pending` for the rest. A gate that mixes sequences could combine an old `ready` with a new pass | accept only when ALL expected rows carry the SAME current `sequence`, with `startedAt` ≥ the new agent's start |
| R6 | Between a row turning `ready` and acceptance: walletRefresh withdraws the allow (candidate), the keeper's renewal fails, the manager reports the VM gone | the row is not re-written until the next pass | at acceptance also require the host-state row `running`, `leaseUntil > now + margin`, `walletHeld` null. Post-checks (VM sets) stay; the validation window samples egress |
| R7 | `ensureApp` respawns instead of adopting | the row is `ready` but the VM changed | the existing post VM-set check (`DONE_CHECK`) catches it |
| R8 | `chainReady` false at the first tick | `#tickOnce` returns at once, so `completedAt` is set with all rows `pending` | not ready (correct); the gate waits for a later sequence |
| R9 | First-pass `scanLedger` claims and launches NEW deployments | delays every row; not a false-ready | measure it |

## 3. Lease feasibility for ALL running apps (per-app view)

- **The real per-app condition** at the stop is `leaseUntil_i ≥ t_stop + STOP + SWAP + T_i + margin + reserve`, where `T_i` is the new process's time to publish app i's row. That row includes renewing app i if it is due.
- **`T_i` has no source bound.** It depends on the pre-loop work, `ensureApp` adoption, the apps before it in `tracked` order and RPC 429s. Only a measured `T_i` with headroom could replace `startNodeSec` per app. Lowering 600 s without that would be the silent loosening root forbids.
- **Phase spread.** Independently renewed zero-rate leases keep their phases spread: on 10-21 the free leases spanned ~872 s. The MIN over all running apps then rarely, or never, reaches the 1655–1850 s that section 3 of RESULT.md requires.

## 4. Return from a running but unready new process

- A return must stop the new process (STOP_AFTER_LEASE ≤ 135 s, plus the rollback run's pins), swap back (≤ 100 s), and start through one pass (`startNodeSec`).
- **`recovery-start` (R = 100 + S) lacks the stop and the pins.** It only covers `RECOVERY_REQUIRED` with the node already STOPPED.
- **`full-return` (R = F = 135 + 100 + S)** matches one return run in size. But `-Mode rollback` re-applies the full gate (`L ≥ F + R + M`), which can never hold right after a forward has consumed ≥ F of the cycle.
- So today, after `NOT_READY`, a return runs only after the NEW process has renewed, or manually. This was reported earlier as "possibly only after the next renewal"; this review states it as a hard limit.
- A "return-now" variant would reserve 0 for itself: if it fails, apps lapse. That is a design decision for root, not implemented.

## 5. Smallest defensible integration (proposal; no change made)

1. **host.mjs** (the renewal worker's file; root's review):
   - publish per-row `reconciled` (the envelope and resize did not throw) and, in the candidate, `keeperEligible` (`#leaseSeen` set for exactly this lease);
   - or make `ready` require both.

   Focused tests:
   - a caught envelope or resize error → not ready, and not eligible;
   - served identity ≠ row → not eligible;
   - eligibility equals the keeper's actual behaviour (renews or not between passes);
   - a wallet hold → `pending`;
   - a renewal failure → `not-ready`.
2. **Helper** (only after 1, and with root's approval): an explicit gate mode `current-pass-rows`; the global-completion mode stays the default. It accepts with `inFlight` true when:
   - `expectedIds` equals EXACTLY identify's running set (refused otherwise);
   - every expected row has the same current `sequence`, `startedAt ≥` the agent's start, `ready`, `reconciled`, `keeperEligible`;
   - each host-state row is `running` with `leaseUntil > now + max(margin, 285 s + retry room)`;
   - 9600 ownership is bracketed as today.

   Focused tests:
   - mid-pass acceptance;
   - one row `pending`;
   - mixed sequences (a pass rollover during the poll);
   - a stale `startedAt`;
   - a row `ready` with `reconciled` or `keeperEligible` false;
   - host-state not running;
   - `expectedIds` ≠ the running set;
   - a renewal-failed row.
3. **No timeout change.** `startNodeSec` stays ≥ 480 measured, 600 recommended, until per-app `T_i` evidence exists.

## 6. New evidence needed (root, read-only live, before deciding)

- **Pass timing on the CURRENT process.** Poll `127.0.0.1:9600/v1/host/state` every ~2 s across ≥ 3 passes. Record per pass `startedAt`, each row's `checkedAt` and `completedAt`. That gives `T_i` and the post-loop share.
- **First pass after a restart.** The same capture across the next actual restart: adoption, `scanLedger` claims.
- **Running set and lease spread.** The full running deployment set and every `leaseUntil` over ≥ 2 h: how often min-remaining across ALL of them reaches each section 3 threshold.
- **The live lease rate.** Zero-rate vs paid, per deployment.
