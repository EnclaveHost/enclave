# 1821: composite-memory-fixture-stage/r4, the narrow fix for the ACTUAL cmf-r3-tests failure (FROZEN, NOT RUN, NOT PASS)

**Scope:**
- **What I executed:** read the actual failed run; copied r3's sources into a NEW r4; text edits; `ast` parse; `bash -n`; `cmp`; `diff`; `sha256sum`.
- **Not done:** tests, builds, probes, mounts, scope changes, or reads of the original or any part.
- **Frozen r3 is unchanged:** SUMS `32b71c04badd0b333da69986a488faa99c13e7aad72073524ed43e46ffe65eda`, `sha256sum -c` OK. Its failed actual outputs are preserved in `r3/runs/tests-20261027T032312Z-2697726/` (`receipt.json`, `stderr.txt`, `stdout.txt`, `rc`, `tmp`).

## The actual failure (root's run, read from the receipt and stderr)
- **The run:** `Ran 11 tests`, `FAILED (errors=1)`, rc 1, with markers ResourceWarning/FAIL/ERROR/Traceback. The fixture was `7c1235d0…` (= r2/r3 runtime).
- **The error:** `test_10` raised `KeyError: 'walkerVmRSSKiB'` in `memory_fixture.py` `sample()`, line 377: `pk[f"walker{k}KiB"]` for `k in ("VmRSS", "RssFile", "VmPTE")`.
- **The cause:** the peaks were initialised as `walkerVmRssKiB`/`walkerVmPteKiB`. The bug was mine, from r1, and was never exercised until an actual unit run.
- **The consequence:** because test 10 called `s.cleanup()` only **after** `use()` returned, the exception left the stand-in `sleep` child running and its `exec.log` open. That produced the two ResourceWarnings: "subprocess 2697748 is still running" and "unclosed file … exec.log". The queue guard cleaned up afterwards.

## Frozen r4: `composite-memory-fixture-stage/r4/SHA256SUMS` = **`25245e21772377bcbacd9e27d8eb9d330e1340a3b2b1de9f98177b3603a17789`** (7 entries, read-only)
| file | sha256 | change vs r3 |
|---|---|---|
| `memory_fixture.py` | `f1e04105027af197e3517d734e031872939f5490e2b9cf3100f0c37d8772c274` | **one line** (the peaks keys) + docstring header |
| `tests/test_memory_fixture.py` | `20975a7425fcd25af3cad038f95a31991b3440b2f2f27f112d0c3563c071969e` | test 10 only (+ header); still **11** tests; r3's test 9 `snap()` fix kept |
| `walker.py` | `bb01105dc8de7ba496f4fb67abfd5c73038b07b90d1844786adbc253c72a4113` | none (`cmp` OK) |
| `jobs/common.sh` / `tests.sh` / `run-fixture.sh` | `11883afd…` / `37ba91e9…` / `b7a1122e…` | paths r3 → r4 and job names `cmf-r3-*` → `cmf-r4-*` only. **Gate unchanged:** exactly `Ran 11 tests`, `OK`, empty stdout, no ResourceWarning/skipped/FAIL/ERROR/Traceback, rc 0; warnings are not suppressed |
| `README.md` | `e565deb1…` | r4 section prepended |

## Narrow diff
**Runtime** (`memory_fixture.py`):
```
-            self.peaks = {"treeVmRssMiB": 0.0, "cgCurrent": 0, "walkerVmRssKiB": 0, "walkerRssFileKiB": 0, "walkerVmPteKiB": 0,
+            self.peaks = {"treeVmRssMiB": 0.0, "cgCurrent": 0, "walkerVmRSSKiB": 0, "walkerRssFileKiB": 0, "walkerVmPTEKiB": 0,
```
These are exactly the keys `sample()` updates (`walker{VmRSS,RssFile,VmPTE}KiB`, matching `proc_status()`'s `VmRSSKiB`/`RssFileKiB`/`VmPTEKiB`). No other runtime behaviour changes.

**Test 10:**
```
         try:
             M.SOFT_TREE_RSS_MIB = -1
             s.use()
-        finally:
-            M.SOFT_TREE_RSS_MIB = saved
+        finally:                       # r4: the TEST owns cleanup even if use() raised or an assertion fails
+            M.SOFT_TREE_RSS_MIB = saved
+            s.cleanup()                # r6 cleanup ends + reaps the child and closes its log
         ...
-        s.cleanup()
         ...
+        first = s.samples[0]["walker"]
+        self.assertGreater(first.get("VmRSSKiB", 0), 0, first); self.assertGreater(first.get("VmPTEKiB", 0), 0, first)
+        self.assertGreaterEqual(s.peaks["walkerVmRSSKiB"], first["VmRSSKiB"]); self.assertGreaterEqual(s.peaks["walkerVmPTEKiB"], first["VmPTEKiB"])
+        self.assertGreater(s.peaks["cgCurrent"], 0)
```
**Why these assertions are meaningful, not a mirror of the implementation:**
- **They depend on the live process:** an exec'd `/usr/bin/sleep` really has resident pages and page tables, so the kernel's `VmRSS`/`VmPTE` for the child must be positive in the first full sample. The soft stop trips at that sample (threshold forced to −1), and Popen returns only after a successful exec.
- **They check coverage:** each peak must be at least that observed value, which fails if a peak key is wrong or never updated.
- **They check the cgroup read:** `cgCurrent > 0` proves the job's own cgroup was actually read.

**Cleanup now runs whatever happens:** it is in the `finally`, so no subprocess or fd can leak from this test whether `use()` raises or an assertion fails. r6 `cleanup()` ends the `exec` group (or only reads it if already reaped) and closes the logs.

## Root commands (normal queue only, no holds; the main lane is free after the KVM 1536 packaging job)
```
bash jobs/q-exit-status.sh cmf-r4-tests 512 bash composite-memory-fixture-stage/r4/jobs/tests.sh      # expect "## PASS (11)"
bash jobs/q-exit-status.sh cmf-r4-run 768 bash composite-memory-fixture-stage/r4/jobs/run-fixture.sh  # ONLY after that PASS (the job also checks it)
```
The run job's outcomes are unchanged from r2: MEASURED, or an honest SOFT-STOP / TIMEOUT / REFUSED / CLEANUP-INCOMPLETE. The job's PASS needs MEASURED, peers unchanged, no mount and no process left.

## Remaining limits (unchanged; see r2/1813)
- MemoryHigh is not a ceiling and applies to the whole queue scope (guard and servers too).
- The OOM victim is not guaranteed.
- The soft stop races the outer guard.
- A wrapper KILL at 900 s skips the ordered cleanup (a D-state process has no bound).
- Page tables are measured, not asserted.
- The data is synthetic, not MDBX: no production qualification.

**Still unproven until the actual fixture run:**
- `systemctl set-property` on the queue scope;
- `nbdfuse MOUNTPOINT/FILENAME`;
- FUSE page-cache charging;
- the fault speed within the budget.
