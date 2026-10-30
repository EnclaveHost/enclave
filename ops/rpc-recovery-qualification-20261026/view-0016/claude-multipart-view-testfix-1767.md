# multipart-validation-view-stage/r5: root 1765 test-configuration fix (1767). FROZEN, NOT RUN, NOT PASS

## Root 1765 failure, verified from the actual run
- **The run:** `multipart-validation-view-stage/r4/runs/tests-20261027T001127Z-2509758/`. The receipt's `stageSums` is `52e307fa…` (= the r4 SUMS, which still verify).
- **Results:** the view_descriptor suite passed 5/5. production_import ran 5 with 1 FAIL: `test_2` line 163, `self.refused(fx, "default-production")` → `AssertionError: 0 != 3`.
- **Cause (test configuration, not a runtime bypass):**
  - the helper `Fx.imp(kind="fixture")` **always** passed `--expect-kind fixture`, so the "default-production" case imported a fixture manifest **as fixture**, which correctly succeeded;
  - the CLI default (`argparse` `default="production"` in `production_import.py`) was never exercised;
  - the explicit production cases (`fixture-as-prod`, `prod-pins`) refused as expected in the same run.

## r5 (r4 preserved: SUMS `52e307fa…` re-verified)
**Stage:** `multipart-validation-view-stage/r5/`, **SHA256SUMS `85f503ae4bccbd2d95ab6e7720f36cc141e4dcff897f076d5b7ce4261337a228`**.

**The only behavioural change** is in `tests/test_production_import.py` (`48c7af00…`):
- `Fx.imp(kind=None)` **omits** `--expect-kind`;
- the "default-production" case now uses `kind=None`, so it tests the real CLI default: a fixture manifest with no flag must give rc 3 and no output directory.

Every other test and assertion is unchanged.

| file | sha256 | vs r4 |
|---|---|---|
| `production_import.py` | `c82aea96…` | identical |
| `view_descriptor.py` | `23370c97…` | identical (= r1/r3) |
| `tests/test_view_descriptor.py` | `80f7b7ec…` | identical |
| `refs/qemu-v11.1.2-block-vmdk.c` | `75dd58a2…` | identical |
| `tests/test_production_import.py` | `48c7af00…` | the fix above |
| `jobs/tests.sh` / `jobs/pins.sh` / `jobs/root-view-import.sh` | `c6ec09e1…` / `f8305f55…` / `a15d1f0e…` | paths and names r4 → r5 only |
| `README.md` | `a68c0612…` | r5 note added |

**Review 1766** (`logs/claude-multipart-view-review-1766.md`) did not exist when I checked, so no review findings are incorporated.

**Not done by me:** tests, builds, original or copy processes, or live actions. I ran only `ast`, `bash -n`, `cmp` and sha256.

## Root
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh mvv-r5-tests 256 unshare -Urn bash multipart-validation-view-stage/r5/jobs/tests.sh   # expect "## PASS (5+5)"
```
- **Expected:** view_descriptor `Ran 5 tests` OK, and production_import `Ran 5 tests` OK.
- **The receipt also requires:** empty stdout, no ResourceWarning/skipped/FAIL/ERROR/Traceback, rc 0, and the stage and recovery-multipart r3 SUMS (`fcd8e097…`) unchanged.
- **Production import:** `jobs/root-view-import.sh` remains gated on a passing r5 receipt **and** an r3 status with all 265 parts verified in CONFIRMED sessions. The limits are unchanged from `logs/claude-multipart-view-production-1759.md`.
