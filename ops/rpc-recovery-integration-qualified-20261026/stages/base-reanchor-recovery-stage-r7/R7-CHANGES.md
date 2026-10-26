# base-reanchor-recovery-stage/r7 (PREPARED; source only; NOT run by Claude)

**Base:** r6 (FROZEN; `MANIFEST.sha256` verifies) and capture/r4 (FROZEN).
**Root's actual r6 run** (`logs/root-reanchor-r6-0336.out`, cap 256 MiB, peak 215 MiB, rc 1):

| Suite | Tests | Result |
|---|---|---|
| baseline-existing | 34 | PASS |
| recovery-existing | 34 | PASS |
| r3-regression | 27 | PASS |
| reanchor-recovery | 19 | **18 PASS, 1 FAIL** |

The failing test is `test_capture_refusals_hold_replay_wrong_initial_tamper_pin_stale_ledger`. At line 364 it expected `untrusted_file:` and got `a1_stale: … 661 s ago (max 600)`.

## Diagnosis: a fixture defect, not a runtime or clock-propagation defect
- **The harness was right.** Its own printed result for that step was `{"step": "a3", "ok": false, "refused": "untrusted_file: A1 admission ledger …"}` (r6 `reanchor-recovery.out`). It refused correctly.
- **The fixture read the wrong record.** `run_step` returns `sorted(workdir.glob('run-a3-*.json'))[-1]`, the newest file *name*. `A.main` names each record with `now()` (`harness/a2a4.py:1186`).
  - The preceding stale probe ran under `patch.object(R, 'now', utcnow() + a1MaxAgeSec + 60)`, so its record was named about 660 s in the **future**.
  - The next, real-time record sorted before it, and the fixture read the stale probe's record back. 661 s = 600 + 60 + 1 s elapsed.
- **The clock patch was not leaking.** `patch.object` restored `R.now`; `A` is the same module object as `R` (`a2a4_recovery`).

## Fix (test-only; `r6-to-r7.patch`, one file, 12 changed lines)
- **`run_step`:** it snapshots the existing `run-<step>-*.json` files, runs the step, requires **exactly one** new record, and returns that one. This is stricter than before: a missing or extra record now fails.
- **Stale probe:** after the probe, the test asserts `R.now is` the real function and that it reads real time (within 5 s). This is the explicit clock-restore regression check.
- **Unchanged:**
  - every expected refusal prefix (`a1_stale`, `untrusted_file`, `a1_replayed`, `a1_capture*`, `a1_capture_pending`);
  - the 19 tests; nothing is skipped;
  - all product and runtime files, all other suite files, the capture-r4 pin and the producer harness pin. The runner checks each of these byte-for-byte against r6.

## Root runner (`jobs/root-reanchor-r7-tests.sh`)
- **Executed:** only the 19 reanchor tests (ordinary caller, no `-B`).
- **Reused:** the 95 (34 + 34 + 27) come from root's actual r6 evidence. That evidence is pinned by sha256 in `inputs/consumed-inputs.sha256` (root's out file plus the three suite logs), and the runner re-checks it. Reuse is valid only because every file those suites load is byte-identical to r6, which the runner enforces with `cmp`.
- **Queue:** `--mib 256`.

**Holds:** Custody v2 stays REFUSED; lease consumers stay on HOLD; `A1_CAPTURE_REVIEWED = False`. No mainnet proof is claimed.
