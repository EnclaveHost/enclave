# state-production-validation-stage/r2: the production STATE runner (PREPARED by Claude 1890/1900; NOT run; NOT PASS; FAIL-CLOSED)
Report: `../../logs/claude-state-runtime-wiring-1900.md`.

**r1 is preserved unchanged:** SUMS `47a87af0…`; actual 13/14, where test 13 is a false positive (root 1897).

**r2 = r1 plus review 1896 D1–D5, the capture r3 wiring, root 1897's test fix and root's O1 decision.** No new framework.

## What is unchanged
- `composite_session.py` is byte-identical to r1, i.e. r6 + the single `exec_plan` seam.
- The r10 memory gate routing.
- Acceptance r3 as the only classifier and final judge.
- Every resource constraint: the 4096 lane, the 16 GiB host floor, 40 GiB + 8 GiB native on root, the /vm floor, all 265 CONFIRMED.
- No original writes.

## What changed
- **D1 (view binding):** `--view-dir` must equal the pinned view's dir, in `gate` (before any check or MemoryHigh change) and in `runtime`. The exposed view (`r6 receipt["view"]`) must equal the pinned view in `exec_plan`, before the exec; otherwise REFUSED 3 with no child. `runtime` accepts only the exact gate-built argument shape.
- **D2 (build receipt):** read once, from `<r12>/runs/build-*/receipt.json`. It must pass capture r3's predicate `matching_build_receipts` (verified, finalRc 0, mode build, r12 SUMS, outDir), the helper sha must equal the pin, and it must be the ONLY matching receipt.
- **D3 (structural CLEAN):** `runs/job-<ID>/receipt.json` + `runs/prod-<ID>/session/receipt.json` of the SAME ID (r10 `root-composite-validate.sh` / `finish.sh` layout). Both are judged on their hashed bytes. `MG.evidence` must pass, and both files must be byte-identical afterwards (no substitution). The job predicate is re-checked with the exact r10 check set.
- **D4 (strict test receipts):** format, pass, rc 0 (an int), expected, `ran == [n]` and the exact 5 checks, for:
  - acceptance 46;
  - capture 18;
  - r12 guard 16 + 10 + 6;
  - r12 ns 5;
  - this stage's own 20 (`state_gate.py tests-receipt`, used by the job).
- **D5 (paths):** no symlinked ancestors, and the /vm device 253:1, for `helperDir` and `staticFilesDir`.
- **Capture r3 wiring:**
  - capture r3 SUMS `f5424d11…`, `capture.py` `81ddd643…` and the ACTUAL 18-test receipt `5fa5224c…`, with capture's r12/acceptance pins equal to ours;
  - per kind: `receipt_errors == []`, located under `helperDir` with this build receipt;
  - the pinned acceptance parser re-run over the hashed `capture.txt`;
  - the exact `## outputs <run>/work/out` line;
  - the `work/out` manifest re-hashed and equal to the receipt's, plus the exact evidence set and `binaries.sha256`.
- **O1 (root decision):** a runtime 35 is judged by acceptance alone (35 or 10). Any other runtime code is kept only when every job snapshot check AND the session cleanup are verified; otherwise **4**. Acceptance's code, `cleanupVerified` and the snapshots are recorded in `final.json`.
- **Test 13 (root 1897):** the semantic invocation checks are:
  - the exact `runtime_argv`;
  - `runtime_rest_errors` with positive and negative examples, and `runtime` refusing each negative;
  - `gate` having no fixture option;
  - a shlex parse of the job's executable `state_gate.py` invocations, with no fixture/kind/timeout flag;
  - a regression showing the parser sees an executable flag but ignores one in a comment or message.

  The live memory-fixture guard and its message are kept.

## Fail-closed (intentional)
- **`PRODUCTION_INPUTS = None`:** there is no r12 build, no real 26/6 captures and no structural CLEAN yet.
- **`EXTRACTION = None` + BLOCKED `extractionReceipt`:** compact-header extraction r2 is NOT consumed (X1). r3, with its wrapper job receipt, is not final.

## Commands
```
bash jobs/q-exit-status.sh spv-r2-tests 256 unshare -Urn bash state-production-validation-stage/r2/jobs/tests.sh     # exactly 20 tests
bash jobs/q-exit-status.sh state-prod 4096 bash state-production-validation-stage/r2/jobs/root-state-validate.sh VIEW_DIR MAX_HOURS   # refuses now
```

A 35 is self-consistent PARTIAL v2 state at the DB's own Finish header: NOT canonical, NOT recovery acceptance, NOT reset authority.
