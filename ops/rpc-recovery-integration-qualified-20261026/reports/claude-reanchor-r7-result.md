# Reanchor r7 — result (PREPARED; source only; NOTHING run by Claude)

**Not done:** no tests, builds, queue jobs, network or SSH access, live actions or commits.
**Untouched:** r6 and capture/r4 (frozen; their manifests verify). No bulky outputs or binaries were copied.

## Root's actual r6 run (`logs/root-reanchor-r6-0336.out`; cap 256 MiB, observed peak 215 MiB, rc 1)
| Suite | Tests | Result |
|---|---|---|
| baseline-existing | 34 | PASS |
| recovery-existing | 34 | PASS |
| r3-regression | 27 | PASS |
| reanchor-recovery | 19 | **18 PASS, 1 FAIL** |

- **The failure:** `test_capture_refusals_hold_replay_wrong_initial_tamper_pin_stale_ledger`, line 364. It expected `untrusted_file:` and got `a1_stale: the recheck capture finished 661 s ago (max 600)`.

## Cause: the test fixture, not the runtime
- **The harness refused correctly.** For that step it printed `refused: "untrusted_file: A1 admission ledger …"`.
- **The fixture read back the wrong record.** `run_step` takes `sorted(glob('run-a3-*.json'))[-1]`, the newest file **name**, and `A.main` names records by `now()`.
  - The preceding stale probe ran under `patch.object(R, 'now', +660 s)`, so its record name lies in the future. The following real-time record sorts before it, and the fixture returned the stale record again.
  - 661 s = `a1MaxAgeSec` 600 + 60 + about 1 s elapsed.
- **The clock was not leaking.** `patch.object` restored `R.now`, and `A` is the same module object as `R`.

## Fix: `base-reanchor-recovery-stage/r7` (test-only; `r6-to-r7.patch`, 1 file, 12 changed lines)
- **`run_step`:** returns **exactly the one record its own invocation wrote**. It snapshots the records before the step and requires exactly one new file afterwards, which is stricter than before.
- **Stale probe:** an explicit restore check follows it: `R.now is` the real function and reads real time (within 5 s).
- **Unchanged:**
  - the expected prefixes `a1_stale`, `untrusted_file`, `a1_replayed`, `a1_capture_binding`, `a1_capture`, `a1_capture_pin` and `a1_capture_pending`;
  - the 19 tests, with no skips;
  - all runtime and product files. Their hashes are unchanged: harness `5e2658f7…32da` (pins capture/r4 `db81ea49…9d20`), producer `1da971b3…585a` (pins that harness), and wrapper, `selection.py` and `base/*` identical.
- **Changed test file:** `tests/test_reanchor_recovery.py` is now `2f0ce7f7…83801`.
- **Manifest:** r7 `MANIFEST.sha256` sha256 is `9b558d5bc723a80cd40999741e5ea11b96f357be617a24be1a7e8b929d85c6cb` (27 files). `inputs/consumed-inputs.sha256` has 35 entries and adds the r6 manifest, root's r6 out file and the 4 r6 suite logs.

## Root runner (exact)
```
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-reanchor-recovery-stage/r7
python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 256 --log $S/logs/root-reanchor-r7-tests.guard -- unshare -rn bash $S/jobs/root-reanchor-r7-tests.sh > $S/logs/root-reanchor-r7-tests.out 2>&1; echo $? > $S/logs/root-reanchor-r7-tests.rc
```
- **Runner:** `jobs/root-reanchor-r7-tests.sh`, sha256 `1c29c8b8…aa901`.
- **Executed:** only **reanchor-recovery, 19 tests**, as an ordinary caller with no `-B`.
- **Reused, not repeated:** **95 = 34 + 34 + 27** from root's actual r6 evidence (`root-reanchor-r6-0336.out` PASS rows plus the three suite logs `Ran n … OK`, all pinned by sha256).
- **Why reuse is valid:** the runner first `cmp`-checks every r6 manifest file except the changed test file (and r6's own job/inputs/notes) to be byte-identical in r7, plus the r6/r4 manifests, the harness→capture and producer→harness pins, and the HOLD flags. Any difference exits 2, meaning the r6 evidence cannot be reused.
- **PASS requires:** `Ran 19` with a final `OK`, no skip, rc 0, no `code/__pycache__`, and the stage and capture/r4 unchanged afterwards.
- **Aggregate:** 95 reused plus 19 executed.
- **Queue:** cap 256 MiB, which covers the observed 215 MiB peak.

NOT verified by running; PASS only if root's run passes. Custody v2 stays REFUSED; lease consumers stay on HOLD; `A1_CAPTURE_REVIEWED = False`. No mainnet proof is claimed.
