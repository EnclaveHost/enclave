# Bounded M2 observation for the node-only activation (RESULT; source only, root decides)

## 0. Answer

1. **The 610 s floor is not needed for safety.** S (`lease.startNodeSec`) only bounds how long the run WATCHES for M2.
   - When the bound expires, the run ends `*_NOT_SERVING_CHECK` with `rollbackBy`: never success, never an automatic
     stop or rollback.
   - A read that completes after the deadline is never evaluated. This is tested at the right layer, below.
   - The candidate lowers the floor to 60 s (two 30-s ticks) and promises no success duration.
2. **7ac1 had a real budget gap, now fixed here.** Its lease gate did not reserve the post-checks (POST_WORST 120 s)
   after M2, so a run could end up to 120 s after `rollbackBy`. An apply's forward minimum now includes POST.
   - Workaround if root keeps 7ac1: set `forwardMinSec` = its minimum + 120. 7ac1 accepts a larger value.
3. **Unsafe? No. Practical? Decided only by the live leases.** The bounded observation cuts the need from 1620 to 1130
   (890 at every floor). The gate compares that with the MINIMUM remaining lease over ALL running apps at the pins and
   again in BeforeStop.
   - Whether and how often that holds depends on the actual (clustered) lease phases.
   - The earlier random-phase estimate is withdrawn (§3).

## 1. Candidate

| file | sha256 |
|---|---|
| `helper/node-pair-observe.ps1` (776 lines) | **`f7a775988e31ca1090420241ecc597f137314c5d5126db4393bf8da720c3c5c2`** |
| `helper/provenance.json` | `521b7bfa…` |
| `tools/observe-template.ps1` | `4ba70558…` |
| `tools/observe-test.py` | `c39c9f7d…` |
| `tools/pair-mock.ps1` (7ac1's + `late-ready`; `sweep-midpass` readiness at 60 s) | `7360f38d…` |
| `tools/compose.py` | `74501be6…` |
| `tools/provenance-test.ps1` | `0e9b253b…` |
| `jobs/mutants-r1.py` | `41d4e0d0…` |

**Provenance (AST):** 37 functions are verbatim df2e58f2, and **all 21 others are byte-identical to 7ac1d873**. There
are 0 modified and 0 new functions. The diff to 7ac1 is 32 lines, top-level only:
- `$MIN_START_NODE = 610` → `$MIN_OBSERVE = 60`;
- the apply's `fmin` gains `+ $POST_WORST`;
- a `budget` object in the pins journal (formula, terms, `need`, "S … its expiry is NOT success");
- the not-serving final text ("bounded observation …; NOT success, NOT a failure verdict");
- header comments.

**Frozen and untouched:** 7ac1 `7ac1d873…`, runner `a1c950f2…`, 656d `656d642a…`, the 2afa/829a candidates.

**Runner compatibility:** the params schema is unchanged. Root re-stages with this helper's sha.

## 2. Evidence (queue 512, offline netns)

- **`logs/suite-r1.log`.** Compose, then AST lint (one known collision: script `$Run` vs function-local `$run` in
  RunningSetDiff, harmless, as in 656d/7ac1), then provenance, then **30/30** in 204 s, peak 361 MiB.
  - That is 7ac1's whole suite, re-pointed and re-budgeted, plus 5 new tests:
    - the S floor of 60 is accepted, and the pins journal `need` 1070;
    - the budget journal formula and terms (`need` 1130);
    - **M1 only at the exact budget (lease 1130):** `DONE_NOT_SERVING_CHECK` with "bounded observation … NOT
      success". The run's last line (post included) is at or before `rollbackBy` = end − 120 − 415. Exactly one stop
      and one start, no kill, the new pair kept;
    - **a read completing after the deadline never counts:** rows turn ready at 50 s, but that read completes at ~74 s
      against a ~62-s bound. The evidence stays `ok: false` / `status pending`, which proves the FIRST layer (the
      deadline after the read) and not only the bracketing ownership read;
    - **a rollback with S 60** reports `ROLLED_BACK_NOT_SERVING_CHECK` on the old pair.
  - The inherited cases still pass: early serving mid-pass; not-ready, other-pass, lease-mismatch and other-runner
    rows; within-margin; no M1 (`NOT_READY`, one start); a lost listener after M1 (`NOT_READY`); the stopped-node CAS;
    partial swap with proven undo; unknown swap/undo/task outcomes with no start and no retry; kill only the verified
    PID; a reused PID; VM and task post-checks; the exact running set before the stop; a lease shrinking at
    BeforeStop; the 1130/1129/1800 budget boundary; every parameter refusal, including `forwardMinSec 475` (7ac1's
    minimum without POST, now refused); updater refusals; rollback at 475/474; R ≠ 0 refused; a partial return; lock
    and params sha.
- **`logs/mutants-r1.log`: 5/5 killed** (each parses):
  - B1: the 610 floor restored;
  - B2: POST dropped from the gate;
  - B3: the after-read deadline check removed;
  - B4: bound expiry reported as DONE;
  - B5: deadline expiry treated as serving.

**Not proven:** native timings (process-up U, the per-app row time with serving-first 817389ec), Task Scheduler/CIM
behaviour, and the live lease phases.

## 3. Budget formula and feasibility

- **Apply:** `L_min ≥ (135 + 100 + U + S + 120) + R + M`, with `R ≥ P + 135 + 100 + U` and R ≠ 0.
- **Rollback:** `L_min ≥ 135 + 100 + U + M` (R = 0; acceptance at M1, M2 observed for S).
- `L_min` = min over ALL running apps of (`leaseUntil` − now), at the pins and again in BeforeStop.

| U | S | P | M | apply needs |
|---|---|---|---|---|
| 120 | 180 | 60 | 120 | 1190 |
| 120 | 120 | 60 | 120 | **1130** |
| 120 | 60 | 60 | 120 | 1070 (the floor test's case) |
| 60 | 60 | 60 | 120 | 950 |
| 60 | 60 | 60 | 60 | 890 (every floor) |
| 7ac1 with S 610 (post counted) | | | | 1620 |

**Correction (2026-10-23).** An earlier version listed U 60 / S 60 / P 60 / M 120 as 1070. The formula gives
475 + 355 + 120 = **950**; 1070 is U **120** / S 60. That earlier version also gave random-phase "share of time"
estimates. They are withdrawn: root reports the live leases are clustered, not independently phased, so no phase model
applies. Feasibility is decided only by the live leases.

**Exact check:** from a fresh identify, compute `min(leaseUntil) − now` against `need` (journaled in the pins). The
helper refuses with nothing stopped when it does not fit.

## 4. What remains for root (decisions, not implemented)

- **The binding constraint is the min-over-all-leases invariant with the rollback reserve.** Even S = 0 would need 830 at
  the floors.
- **The reserve cannot save the earliest lease anyway (observation for root's review).** After a rollback, the old host
  (9634cb40, no keeper) renews only inside its pass. A restart-sized reserve brings the old process up (M1), but it does
  not renew an app whose window has already opened.
- **Options for root:**
  - wait for a rare aligned window (the helper refuses safely otherwise);
  - or explicitly redefine the invariant per app: an app whose renewal window falls inside the window relies on the new
    node's keeper after its M2 row, or lapses under the existing enforcement.

  The second is a policy change for root and the human. It was not made here, and no lease is extended or ignored.
- **U and the per-app row time are unmeasured.** Root can read them from `node.log` and host-state polling read-only.
