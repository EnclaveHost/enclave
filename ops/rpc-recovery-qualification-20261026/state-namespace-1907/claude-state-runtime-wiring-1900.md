# 1900: state-production-validation-stage/r2 = r1 + review 1896 D1–D5 + capture r3 wiring + root 1897 test fix + O1 (SOURCE ONLY)

## Status
- **Created:** `state-production-validation-stage/r2` only.
- **No execution by me:** no test, queue job, build, network, mount, or data/original/backup/part read. The only checks were static: `ast.parse`, `bash -n`, `sha256sum -c`. No commits.
- **Results:** **no r2 test has run.** Nothing is qualified, and no production input is pinned.
- **Untouched and re-verified clean:**
  - r1 (SUMS `47a87af0…`; root's actual 13/14 stays recorded as a FAIL);
  - capture r3 (`f5424d11…`), acceptance r3 (`1e7eb636…`), r10;
  - extractor r2/r3 (not read for consumption).
- **What the tests use:** only synthetic receipts and trees in tempdirs. They are not a compiled-fixture qualification, not a state result, and claim no canonical/reset authority.

## Files (frozen, a-w)
| file | sha256 |
|---|---|
| `SHA256SUMS` | **`e1353cdc9f3bad35600deb0f487dd1b81a1099b9ff33b584fc52cc847dbc1462`** |
| `state_gate.py` | `02d8215821e0f0f63b1e91937ce6f25b8496dd6f98b9ddb6e80e63d86e67ac28` |
| `composite_session.py` (byte-identical to r1 = r6 + seam; pin unchanged) | `52099d9f70a69d80fb96862a23c6316439a619ca7f2c9f92a88c0b8fe9856e9a` |
| `tests/test_state.py` (**20 tests**) | `0b856a374d3e4cee6b649d2426c60e4d524a79644f34739e4c3779d51289563b` |
| `jobs/tests.sh` (exactly `Ran 20 tests`; format `state-production-test-receipt/r2`) | `5199b742080520506d1c16a0fdbe44993527a8db0a1bed6b0af377bdf1a19ab0` |
| `jobs/root-state-validate.sh` | `69b145cfe631f0f4c7e1f83be499a04facec46b560b7870efe568fea780a4fd4` |
| `jobs/stop-session.sh` | `a121d91b4cf10f2f0e8531614be4429516ce5bb46679dfc37aa14190dc5ecd46` |
| `README.md` | `78c91c41d5d6b444762b64a9edb1103c55221c4ad2505ab65040c1be78dee67d` |

**New pins** (rehashed from the actual files):
- `captureSums` `f5424d11fd3e7ee0251eaa55a177f6a3affa6e4b9b04b5e10c3e2f496b0488c2`;
- `capture` (`capture.py`) `81ddd643f41e91a16b6bda76d60873dda1d79ab066862b47c199958c072cc3e7`;
- `captureTests` = `state-fixture-capture-stage/r3/runs/tests-20261027T110224Z-3118540/receipt.json` `5fa5224c80365ccffb06f1920c393541625941a7554c565ae6c8ece697face0a`. Content: format r3, pass, rc 0, expected 18, ran `["18"]`, 5 checks true, stageSums `f5424d11…`.

All r1 pins are unchanged.

## Changes (all in `state_gate.py`; checked against the code)
**D1 — view binding.** `check_view_binding(inp, view_dir=, exposed=)` is called:
- in `gate` immediately after `require_inputs()`, before every other check and before `set_memory_high`;
- in `runtime` after `require_inputs()`, on `rest[1]`;
- in `StateSession.exec_plan`, on `self.receipt.get("view") or {}` (the r6 `expose` record), BEFORE `state_exec_plan`. A mismatch raises inside `use()` before any Popen → r6 REFUSED 3.

`runtime` also now requires exactly the gate-built rest: `--view-dir V --run-dir R --expect-kind production --validator-timeout N` (`runtime_rest_errors`), built by the single function `runtime_argv`.

**D2 — `verify_build_receipt(inp, CAPM, runs_dir=<r12>/runs)`:**
- the path must be `<r12>/runs/build-*/receipt.json`;
- the bytes are read once, sha-pinned, and parsed from those bytes;
- capture r3 `matching_build_receipts` must hold (verified True, finalRc int 0, mode build, r12 SUMS, `guard.outDir == helperDir`), and `guard.binaries[base-state-readonly].sha256 == helperSha256`;
- **exactly one** matching receipt may exist in `<r12>/runs`.

**D3 — `verify_structural(MG, st, view, runs_dir=<r10>/runs)`.** The layout comes from the actual r10 `root-composite-validate.sh` (`O=$R10/runs/prod-$ID`, `J=$R10/runs/job-$ID`) and `finish.sh` (`job-receipt.py … > "$J/receipt.json"`; the session receipt is `O/session/receipt.json`).
- **Paths and ID:** the job must be `runs/job-<ID>/receipt.json` and the session `runs/prod-<ID>/session/receipt.json`, with `<ID> = \d{8}T\d{6}Z-\d+` and the SAME ID.
- **Hashing:** both files are read once and sha-checked.
- **Around `MG.evidence`:** `MG.evidence(job, 0, 0) == 0` is required, then both files are re-read and must be **byte-identical** (substitution refused).
- **The job, judged on the hashed bytes:** format r10, rc int 0, collectRc int 0, `structurallyCleanRun`, outcome CLEAN, checks set exactly `MG.JOB_CHECKS` and all true.
- **The session, judged on the hashed bytes:** CLEAN, rc int 0, `cleanupComplete` true, view equal to the pin.

**D4 — strict test receipts.** `test_receipt_errors(t, fmt, n | {suite: n}, sums)` requires format, pass, stageSums, and per suite pass, int rc 0, int expected n, `ran == [str(n)]` and exactly the 5 checks, all true.
- **Pinned receipts (`TEST_RECEIPTS`):** acceptance r3 46; capture r3 18; r12 guard `{test_bsro_gate 16, test_disk_guard 10, test_mount_identity 6}`; r12 ns `{test_ns 5}`. These match the actual receipts.
- **The job's own check:** `state_gate.py tests-receipt RECEIPT SUMS` requires `state-production-test-receipt/r2` with 20 tests. It replaces r1's pass + stageSums one-liner.

**D5 — paths.** `no_symlink_ancestors` + `on_vm` (253:1) for `helperDir` and `staticFilesDir`, run first in `verify_production_inputs`.

**Capture r3 wiring (`verify_capture_stage`, `verify_captures`).**
- **The stage:** `verify_sums` of capture r3; its actual 18-test receipt (strict); `capture.py` loaded from the pinned bytes. `CAPM.PINS["r12Sums"]` and `CAPM.ACCEPTANCE` must equal our r12/acceptance pins.
- **Per kind (positive, fixtures):**
  - the receipt bytes must equal the pin;
  - `exp = CAPM.expected_identities(kind, b, buildSha)` with `exp.helperSha256 == helperSha256`;
  - `CAPM.receipt_errors(rec, kind, exp) == []`;
  - **location:** `runDir` = `helperDir/fixture-captures/<kind>-<ID>`, the receipt at `runDir/receipt.json`, `workDir = runDir/work`, `buildOutDir == helperDir`, `buildReceipt == {path, sha}` of the pinned build receipt, the capture at `runDir/capture.txt`; no symlinked ancestors up to `work/out`;
  - **the capture itself:** `capture.txt` sha must equal the receipt's, the pinned acceptance r3 `check_fixture_capture` must give `outputValid`, and `outputs_line_errors` must be empty (exact `<runDir>/work/out`);
  - **the evidence:** `evidence_manifest(work/out)` must equal the receipt manifest (re-hashed), and `evidence_errors` must be empty (exact name set, `binaries.sha256`).
- **Distinct run dirs** for the two kinds.

**Extraction stays BLOCKED.**
- `EXTRACTION = None`. `verify_production_inputs` runs every other prerequisite first: D5, capture stage, D2, helper bytes, captures, D3. Then it **always** refuses `BLOCKED extractionReceipt`.
- A pinned `EXTRACTION` with no consumer also refuses.
- Extractor r2 is not consumed, and no r3 API is guessed.

**O1 — root decision (`final`, `cleanup_verified`, `wrapper_code`).**
- **Runtime 35:** acceptance r3 alone decides (35 only with complete evidence, else 10).
- **Any other runtime code** (incl. 0 → acceptance 10, 3/5/7/8/30/34/124/137, unknown): it is kept **only** if every job snapshot check (`snapshotsOk`, `peersUnchanged`, `noMountLeft`, `noProcessLeft`) is true AND either:
  - no session was started (`O/session` absent or empty: a gate or runtime refusal), or
  - the session receipt has `cleanupComplete is True`.

  Otherwise the result is **4**.
- **Unknown cleanup** (exceptions, a missing receipt after a start) is never verified.
- **`final.json` (format r2) records** `acceptanceFinal`, `cleanupVerified`, the snapshots and `final`. Acceptance r3 and r10 are unchanged.

**Root 1897 — test 13 is now semantic.** It checks:
- the exact `runtime_argv`; `MG.runtime_identity` accepts it and refuses `--fixture-exec` / `--fixture-unmount-exe`;
- `runtime_rest_errors` returns `[]` for the exact rest, and 7 negatives (fixture exec, unmount, kind fixture, an extra `--exec-timeout`, truncated, reordered, a non-digit timeout) are refused by both `runtime_rest_errors` and `runtime` (3);
- `gate` with `--fixture-exec` → argparse `SystemExit`;
- the `gate` AST holds exactly one `os.execv(PY3, argv2)`, with `argv2 = runtime_argv(…)`;
- a shlex parse (comments stripped, continuations joined) of every executable `state_gate.py` invocation in the job: exactly `final`/`gate`/`guard`/`tests-receipt`; the gate flags are exactly `--view-dir --run-dir --max-hours --tree-root-pid`; no fixture/kind/timeout flag;
- **the parser regression:** an executable `--fixture-exec` is detected; one in a comment, or the guard's message, is not;
- **the guard line and its message are asserted present.**

## Tests (20; `tests/test_state.py`)
**1–12:** as r1, except **4**, which now checks the extraction stays BLOCKED after every other prerequisite, with an AST order check and stubs.

**13–20:**
13. The semantic invocation checks above.
14. Every pin equals the actual bytes; every `TEST_RECEIPTS` actual receipt passes the strict check; capture r3's cross-pins are ours.
15. Strict test receipts: 12 single-field mutations of the actual capture receipt (bool rc, string expected, duplicate ran, …), r12 suite mutations, and the `tests-receipt` CLI (ok / 14-count / wrong SUMS).
16. D1: pure cases; `gate` with a wrong view → only `gate-refused.json`, no scope; `runtime` refuses; `StateSession.exec_plan` refuses a missing or different exposed view before `state_exec_plan`.
17. D2: good; 6 predicate mutations; a wrong sha; a path outside runs; a second matching receipt.
18. D3: good; a different ID; a wrong name; a wrong sha; **substitution around `MG.evidence`** ("changed around"); a hashed job missing a check (our predicate); 4 session mutations.
19. Capture wiring: a complete synthetic pair passes through the real `CAPM` and the pinned parser. 7 isolated mutations refuse: receipt pin, `buildOutDir`, the `runDir` kind, `identitiesAfter`, pass, the `buildReceipt` sha, `helperSha256`. A changed `capture.txt` refuses.
20. Evidence tampered after capture → "manifest re-hash differs"; an outputs line `/vm/other/out` (accepted by the parser) → refused; the `wrapper_code` table (10 rows); `cleanup_verified` (no or empty session, receipt states, each snapshot key); `final(O, J, "34", "0")` with no status files → **4**, with `acceptanceFinal` 34 recorded.

## Exact commands (root)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh spv-r2-tests 256 unshare -Urn bash state-production-validation-stage/r2/jobs/tests.sh     # expect "Ran 20 tests", OK, receipt pass
# production (REFUSES now, rc 3 at gate: PRODUCTION_INPUTS None / extraction BLOCKED):
bash jobs/q-exit-status.sh state-prod 4096 bash state-production-validation-stage/r2/jobs/root-state-validate.sh VIEW_DIR MAX_HOURS
```

## Remaining blocks (intentional; no invented pins)
1. **`PRODUCTION_INPUTS = None`.** Each of these needs root's ACTUAL evidence before a reviewed revision fills the literal:
   - the r12 build (verified receipt);
   - the real positive 26 / fixtures 6 capture r3 receipts;
   - the structural cmv-r10 production CLEAN (job + session of one ID);
   - the production view record;
   - all 265 CONFIRMED.
2. **Extraction BLOCKED:** `EXTRACTION = None`. When compact-header-extraction r3 (task 1899) is final and actually tested, the minimal adapter pins its SUMS, `extract.py` and test receipts (strict D4 form). It then requires its inner receipt plus the completed wrapper job receipt (rc 0, bound to the inner sha/path, peers/stage valid) via r3's own API, and `staticFiles`/`staticFilesDir` equal to its pins exactly. Only then is the BLOCKED refusal removed.
3. **`spv-r2-tests` actual 20/20.**
4. **D6** (helper-specific memory peaks) is deferred, as diagnostic only. O2/O3 (soft-stop RssFile, timeout budget) remain to be measured on the structural run.

**Limits:**
- **Unverified at the API level:** the capture wiring is exercised only against synthetic receipts built to capture r3's schema. Real capture receipts may expose a field I did not anticipate; it would fail closed.
- `cleanup_verified` treats an empty `O/session` as "not started". Such a dir exists only after gate's `mkdir`, followed by a runtime refusal before r6 `main`.
