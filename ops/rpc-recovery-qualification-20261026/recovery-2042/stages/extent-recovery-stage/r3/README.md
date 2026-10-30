# extent-recovery-stage/r3 (= r2 + fixture-only fix, root 1647). PREPARED by Claude; nothing compiled or run

C tool and wrapper are byte-identical to r2 (the job `cmp`s them). tests/test_overlap.py: the debugfs oracle is ONE batch `debugfs -f` with one `testb BLOCK` per block, every block answered exactly once (`testb START COUNT` aggregates); the Fixture base is a mixin (no setUpClass on a 0-test class). Same 10 tests, same assertions. Earlier text follows.

# extent-recovery-stage/r2 (= r1 + one -Wformat cast fix, root 1644). PREPARED by Claude; nothing compiled or run

r1 is frozen and unchanged; tests and the wrapper are byte-identical to r1 (the job `cmp`s them). Original r1 text follows.


Report: `logs/claude-extent-overlap-1640.md`.

## `src/ext4-extent-overlap.c` (libext2fs, local headers `/usr/include/ext2fs`)
**Opening (read only, fail closed):**
- `ext2fs_open(dev, EXT2_FLAG_64BITS, …, unix_io_manager)`. There is **no `EXT2_FLAG_RW`**, so the path is opened `O_RDONLY`, and the tool refuses if the flag is somehow set. There is no write, flush or repair call; only `ext2fs_close_free`.
- **Refusals:** a symlink or non-block/non-regular path; a mounted filesystem (`ext2fs_check_if_mounted`); a journal that **needs recovery** (its on-disk bitmap could miss journaled allocations, i.e. false negatives); bigalloc (cluster ratio ≠ 1).
- **Checksum errors are not ignored.**

**Searching:**
- `ext2fs_read_block_bitmap`, then per extent: strict validation (1..32768 blocks, within `[s_first_data_block, blocks_count)` and the bitmap's bounds; otherwise reported as `invalid`, never searched).
- Then it alternates `ext2fs_find_first_set_block_bitmap2` / `…_zero_…` over exactly `[physical, physical + blocks − 1]` and emits every allocated sub-range with its logical offset and the unwritten flag.
- `--crosscheck` re-tests every block with `ext2fs_test_block_bitmap2` and fails on any mismatch.

**Output:**
- stdout is capped at 16 MiB (`--max-output-bytes` ≤ that). Printing stops at the cap, but counting never does. The final `summary` line carries the complete counts and `truncated`.
- **Exit codes:** 0 complete; 3 complete with invalid extents; 1 refused.

## `src/overlap.py`
- **Input:** validates the candidate JSON (exact extent keys, integers, boolean `unwritten`, ≤ 1,000,000 extents, ≤ 64 MiB).
- **Run:** pipes the extents to the tool on stdin, with a timeout, and parses the strictly shaped output.
- **Report:** `extent-overlap-report/r1` (create-exclusive 0600, or stdout), carrying the input sha256, the tool sha256, the counts and the **interpretation**:
  - an overlap disproves an untouched full recovery;
  - it is **not** proof the bytes were overwritten;
  - no overlap is **not** proof the bytes are intact (transient reuse is a separate gate).

## Production use (root, after review; READ-ONLY NBD only)
```
python3 -I -B extent-recovery-stage/r1/src/overlap.py --tool <built ext4-extent-overlap> \
  --candidate logs/base-journal-copy-1626/candidate-extent-coverage.json --device /dev/nbdN --out <new report.json> [--crosscheck]
```
