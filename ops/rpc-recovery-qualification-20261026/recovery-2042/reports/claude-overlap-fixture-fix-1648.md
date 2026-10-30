# Extent overlap r3: fixture-only fix (root 1647). Source only; nothing compiled, run or read from any device - 2026-10-26

## Stage: `extent-recovery-stage/r3`, FROZEN
**`SHA256SUMS` = `faf4845d0dd6f7748e0a0587fc015118c192111ab398722e3faa3223af0099bf`** (files `a-w`).

| file | sha256 | vs r2 |
|---|---|---|
| `src/ext4-extent-overlap.c` | `1e03854048e215db4389987c90b3123deb81d113634984a433306069345c07c3` | **byte-identical** (no C/runtime change; the job `cmp`s it) |
| `src/overlap.py` | `3fac4a394e95de9e460789121c2968d9374553f0c5da96f3a4dfec87ca69ea27` | **byte-identical** (`cmp`) |
| `tests/test_overlap.py` (10 tests) | `066f30f4284301010017539cbe3e370a7bceaaf03725d196c98861e0065bd08d` | the fixture oracle and the mixin only |
| `jobs/tests.sh` | `e1b5f9be09546b086d0fe9c898c00f3b035ec6c5f9cd8f578cb7d239137dbdcd` | r3 paths; checks the r2 sums and the C/wrapper identity |
| `README.md` | `482e350f0d5e930a8a62e8b38eca93d0cd69e1933ed79df624bc148c10c3125a` | r3 note |

**Unchanged:** r1 `916a2df1…` and r2 `aa194df4…` (re-verified). The real 9001-extent candidate map is untouched; nothing live was done.

## Root 1647: the cause (actual run `r2/runs/run-20261026T203137Z-2317482/test_overlap.txt`)
- **Compile:** PASS.
- **The failure:** `ERROR: setUpClass` for `Fixture`, `Overlap`, `Validation` and `Wrapper` (`AssertionError`). Only `Refusals` ran (1 test, OK).
- **The cause:** my fixture assumed `debugfs -R "testb 0 4096"` prints one `Block N marked in use|not in use` line per block, and asserted at least 4096 lines. Root established that the range form reports an **aggregate**.
  - **Local check (read only):** the installed `debugfs 1.47.4` contains the per-block format strings `Block %llu marked in use` and `Block %llu not in use`, which a single-block `testb BLOCK` prints.
- **Secondary:** `Fixture` was itself a `unittest.TestCase` with 0 tests, so unittest still ran its `setUpClass` (the 4th error).

## r3 fix (no assertion weakened; no C/runtime change; still 10 tests)
**The new oracle, `debugfs_used(img, blocks, tmpdir)`:**
- **One** `debugfs -f <cmdfile> IMG` (read-only, without `-w`), with **one `testb BLOCK` per requested block**.
- **Parse rule:**
  - the batch echo lines (`debugfs: …`) and blank lines are skipped;
  - **every other line must match exactly** `^Block (\d+) (marked in use|not in use)$`;
  - each requested block must be answered **exactly once**: no duplicates, no missing, no extra lines.

  Otherwise it asserts (fails), and returns the set marked in use.
- **Where it is used:**
  - `setUpClass` builds `cls.used` over **all 4096 blocks**;
  - `testb(start, count)` uses it for the partial-extent and free-window tests.
- **Strength:** r2's weaker "at least N lines" check is replaced by this exact one.

**The base class:** `Fixture` is now a plain **mixin**. `Overlap`, `Validation` and `Wrapper` inherit `(Fixture, unittest.TestCase)`, so no class without tests gets a `setUpClass`.

**Unchanged:** every test method and assertion, including the whole-filesystem no-false-negative anchor (the reported set == the debugfs per-block used set == blocksCount − freeBlocks), the `--crosscheck` 0 mismatches, and the image sha256/mtime-unchanged check after every test.

**Cost:** the fixture is 4096 blocks, so the batch is ~4096 `testb` commands in one debugfs process. A partial or free window adds one small batch each.

## Exact root job
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh extent-overlap-r3 512 unshare -Urn bash extent-recovery-stage/r3/jobs/tests.sh
```
**PASS requires all of:** `## compile OK`, `## test_overlap PASS (10)`, no skips, and `## extent-overlap-r3 rc=0`.

**Not claimed:** passing. If this debugfs prints a different single-block line, the oracle fails loudly with the exact unexpected line; it never silently accepts.

**Unchanged real-NBD note:** the fuse2fs read-only mount will likely make the tool refuse (mounted). That is intended, and I unmount nothing.
