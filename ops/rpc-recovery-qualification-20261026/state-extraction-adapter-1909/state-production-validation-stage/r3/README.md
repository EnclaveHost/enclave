# state-production-validation-stage/r3 = r2 + the compact-header extractor r3 adapter (PREPARED by Claude 1906; NOT run; NOT PASS; FAIL-CLOSED)
Report: ../../logs/claude-state-extraction-adapter-1906.md. Frozen r2 (`e1353cdc…`; its actual 20/20 receipt
`runs/tests-20261027T113056Z-3145879`) and r1 are unchanged. r2's receipt does NOT carry over.

**Unchanged from r2:** every gate, the lifecycle (`composite_session.py` byte-identical), memory/classification (30/34/35/7/8,
dirty → 7), the final decision (35 only via acceptance r3, else 10; O1 wrapper rule), the capture/build/structural wiring, and all
r2 pins.

**r3 adds only the extraction consumer:**
- **Pins:** extractor r3 SUMS `ee657a9d…` and `extract.py` `cf1264cc…`.
- **`EXTRACTOR_UNIT_RAW`:** the ACTUAL raw che-r3-unit outputs (`logs/che-r3-unit.{out,rc,guard}` and the `/tmp/che1881-unit-GnvMSyRq`
  stderr/stdout), sha-pinned and checked by `raw_test_errors`/`read_raw_test`:
  - rc file `0\n`;
  - exactly one `Ran 25 tests`, then `OK`;
  - no ResourceWarning/skipped/Traceback/FAIL/ERROR;
  - stderr's tail immediately before exactly one `## PASS (25)`;
  - `## outputs <its own /tmp dir>`, then the guard line, then `[queue] EXIT 0`.

  The `/tmp` files are ephemeral: if they are cleaned, this REFUSES until a reviewed re-pin.
- **`EXTRACTOR_E2E_RAW = None`:** an EXPLICIT production block (`BLOCKED extractorE2E`). The same function, with `e2e=True` (workspace
  line) and the `<stage>/runs/e2e-<ID>` output dir, accepts the future ACTUAL 8-test PASS.
- **`PRODUCTION_INPUTS`** gains `extractionJob`. **`verify_extraction`:**
  - the inner receipt must be at `<destParent>/compact-header-extraction-<ID>/EXTRACTION-RECEIPT.json`;
  - the outer receipt must be at `<extractor r3>/runs/extract-<ID>/JOB-RECEIPT.json`, with `jobDir ==` its own parent;
  - no symlink ancestor, and /vm 253:1 for the run dir and `files/data/static_files`;
  - both are read ONCE, sha-pinned and unchanged after the check;
  - they are consumed through the PINNED `extract.state_pins(receipt_raw, run_dir, job_raw, stage_sums)`;
  - the returned `staticFilesDir`/`staticFiles`/receipt shas/`stageSums` must EXACTLY equal the inputs.
- **`verify_production_inputs`** ends `verify_extractor_stage(); verify_extraction(); return True`. There is no unconditional dead end:
  with every future input actually present and passing, it returns True.

**Still blocked:** `PRODUCTION_INPUTS = None` (no actual build, captures, structural CLEAN, extraction or production view yet), and the
e2e pin.

**Tests:** 25 (`jobs/tests.sh` requires exactly `Ran 25 tests`).
`bash jobs/q-exit-status.sh spv-r3-tests 256 unshare -Urn bash state-production-validation-stage/r3/jobs/tests.sh`.

**No authority:** a 35 is PARTIAL v2 self-consistency only. It is never canonical, recovery acceptance or reset authority.

---
(r2 README follows)

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
