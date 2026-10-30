# A2/A4 bytecode gate bound to the actual receipt-v2 release (PREPARED; unit run 2330 FAILED 1 on a test fixture, repaired; re-run pending)

## Status

| Item | State |
|---|---|
| Base | A copy of the frozen `a2-bytecode-integration` (`SHA256SUMS` `87cad724…`, verified intact; `frozen-inputs.sha256`). That stage passed root's 40 + 2 + 1 Python + 8 Node tests and all 33 inherited controls (`a2-bytecode-bound-receipt-prepared`, unit 2232 / mutants 2237). |
| Native checker v2 | **Actual:** 23/23 native tests + 17 exact controls (`root-bytecode-v2-recovery-2259`). Release `b55e6b78c6ac8e0a672f69e238135eca7466d1081479cd0868204cee9a1654d7` (`root-bytecode-v2-release-2303`; 1,276,048 bytes, fresh=false, opt 3). Ubuntu ABI launch/refusal smoke rc 0 (`root-bytecode-v2-abi-2318`). |
| Source pin | `BYTECODE_CHECKER_V2_SHA256 = 'b55e6b78…'`: the reviewed pin of exactly that binary. **Pinning alone closes nothing.** |
| Real DB scan | **None has occurred.** The gap closes only for a DB whose real read-only scan at N (after A2→A3→A4, units stopped, no openers) produced a bound v2 receipt from exactly this binary. |
| This stage | **PREPARED, UNTESTED.** Only parse checks and a static mutant preflight were done (47/47 anchors exactly once; every mapped test exists, 42 tests). Nothing was executed, queued, built, SSH'd, run live or committed. |
| Digests | The v2 receipt digests are **framed keccak-256** (not sha256). See `NATIVE-V2-PROPOSAL.md` (status header added; the superseded sha256 rows are struck through). |

## Root unit run 2330: FAILED 1 (kept); fixture repair

- **Result** (`logs/root-a2-v2-bound-unit-2330.{out,rc,guard}`, rc 1; stage `logs/run/` kept unchanged): 41/42 passed. The receipt-writer (2), pinned-manifest (1) and Node (8) suites passed.
- **Failure:** `BytecodeGate.test_a_valid_pinned_receipt_releases_only_after_every_real_prerequisite`.
  - After testing `a1_stale`, it set `self.a1 = fresh_a1()`, which is a **new** initial receipt with a different sha.
  - So the final `release` correctly refused with **`a1_binding`** (release must name the same initial receipt as A2).
  - This was a **test-fixture defect**; the product gate is right and **untouched** (`a2a4.py` still `abe223d6…`).
- **Fix (test only):** the test snapshots the exact bound A1 object before making it stale, and restores that same object afterwards (same bytes, same sha). The test count stays 42, and no assertion was removed or relaxed.
- **Run logs:** `run-tests.sh` takes `A2_TEST_RUN` (default `run`; only `run` or `run-<name>` with `[A-Za-z0-9_.-]`, and no `..`). It still refuses an existing directory, so `logs/run` from 2330 stays untouched. Root uses `A2_TEST_RUN=run-r2`.
- **Mutants:** not run yet; they need a passing unit run first.

## Changes vs the frozen stage (exact; see `diff-vs-a2-bytecode-integration.diff`)

1. **`a2a4.py`:** only the `BYTECODE_CHECKER_V2_SHA256` comment and value change (`None` → `'b55e6b78…'`). Every other line is byte-identical, including:
   - all gates: A1/A2/A3/A4, static (units stopped, no openers), download-134 receipt, binary pin, prune, capability, v2 layout;
   - the journal and order checks;
   - the read-only checker invocation;
   - the receipt checks and the release binding.
2. **`test/test_a2a4.py`:**
   - `BytecodeGate.setUp`/`tearDown` restore the **real source pin**; the frozen fixture reset it to `None` (audit S2).
   - The gap-stays-open test now covers the real pin vs. this fake checker, a config/source mismatch, and `None`.
   - **New `BytecodeGate.test_a_valid_pinned_receipt_releases_only_after_every_real_prerequisite`:** the full ordering is shown below.
   - **New `ReleaseEvidence.test_source_pin_is_the_actually_released_and_abi_smoked_binary`:** the pin equals root's release manifest (v2 format, sha, size 1276048, fresh=false, opt 3, tested by 2259 23/23 + 17) and the ABI receipt (pinned sha line, PASS, `rc=0`, single `[queue] EXIT 0`). The fixtures are sha-pinned byte copies of root's evidence. The pin is not the v1 release.
3. **`test/fixtures/`:** `v2-release-manifest.json` (`06c88f03…`) and `root-bytecode-v2-abi-2318.out` (`9e1d1b3a…`), copied from root's evidence.
4. **`mutants.sh`:** the 33 inherited mutants are unchanged. It adds **14 exact controls for the new v2 rules**, and the baseline count goes 40 → 42.
5. **Docs:** this README, `SECURITY-AUDIT.md` (written before any change) and the corrected `NATIVE-V2-PROPOSAL.md`.

### Prerequisite ordering in the new test

| Step | Expected result |
|---|---|
| `bytecodes` before A4 | `order` |
| real mocked A2 → A3 → A4, then `release` before any scan | `bytecode_receipt` |
| scan while a unit runs | `service_running`; nothing bound |
| valid scan, then `release` with the **real** pin | `open_gaps` (a scan alone closes nothing) |
| pin the test checker, A1 stale | `a1_stale` |
| download unit failed | `download_unit` |
| only then | `release` rc 0 and `m10-launch.json` |

## New v2 controls (assertion-only; killed only if every mapped test FAILS by assertion, with no errors, skips or timeouts)

| Mutant | Rule removed | Mapped test |
|---|---|---|
| v2-no-entries-check | rows == table entries | BytecodeGate.test_missing_malformed_empty_or_unscanned_results_refuse |
| v2-no-accounts-scanned-check | accounts scanned == entries, code ≤ scanned | same |
| v2-no-accounts-with-code | accountsWithCode > 0 | same |
| v2-no-checkpoint-binding | all 5 checkpoints == N | same |
| v2-no-checker-rc | checker rc must be 0 | same |
| v2-no-datadir-binding | receipt datadir == config | BytecodeGate.test_another_datadir_in_the_receipt_refuses |
| v2-no-journal-order | A4 merkle run is the last mutation | BytecodeGate.test_step_order_and_a_db_mutated_after_a4_or_after_the_scan |
| v2-no-journal-binding | release: journal unchanged since scan | same |
| v2-no-download-receipt-binding | release: download receipt unchanged | BytecodeGate.test_stale_db_download_receipt_or_stored_receipt_refuse_release |
| v2-no-stored-receipt-check | release: stored receipt bytes unchanged | same |
| v2-source-pin-ignored | closure needs config pin == SOURCE pin | BytecodeGate.test_the_gap_stays_open_without_a_v2_receipt_of_the_source_pinned_checker |
| v2-v1-closes | closure needs a v2 receipt | same |
| v2-pin-none | source pin set to None | ReleaseEvidence.test_source_pin_is_the_actually_released_and_abi_smoked_binary |
| v2-pin-other | source pin set to another sha | same |

These are predictions from reading the code; root's run decides. A survivor or an invalid kill exits nonzero and is never a pass.

## Root commands (shared queue unchanged; foreground; each records the queue exit status)

```
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/a2-v2-release-bound
cd $S
python3 -u ../../../claude-test-queue.py --mib 256 --log logs/tests-r2.guard -- unshare -rn env A2_TEST_RUN=run-r2 sh run-tests.sh > logs/tests-r2.out 2>&1; echo $? > logs/tests-r2.rc
# only if tests-r2.rc == 0 and tests-r2.out shows RUN-TESTS rc=0:
python3 -u ../../../claude-test-queue.py --mib 256 --log logs/mutants.guard -- unshare -rn bash mutants.sh > logs/mutants.out 2>&1; echo $? > logs/mutants.rc
```

- **Tests:** accept only `RUN-TESTS rc=0` (Python 42 + 2 + 1, each a bare `OK`; node 8 clean) **and** `tests-r2.rc` 0. The logs go to `logs/run-r2/`.
- **Mutants:** accept only `MUTANTS rc=0` (47/47 killed; baseline 42 + 2 + 1, node 8) **and** `mutants.rc` 0.
- **rc 98** (queue not started) is not a result.

## Still required before production (not done)

1. Root reviews and runs the commands above.
2. The real read-only scan of the stopped datadir at N with **exactly** `b55e6b78`, after the final-134 download receipt and A2→A3→A4 on the real datadir, under root review. Then `release`.
3. The other release gates (A1 recheck freshness, etc.) at that time.
