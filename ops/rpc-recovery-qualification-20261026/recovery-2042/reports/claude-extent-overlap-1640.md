# Extent recovery r1: read-only CURRENT-allocation overlap checker (source only; nothing compiled, run, mounted or read) - 2026-10-26

## Stage: `extent-recovery-stage/r1`, FROZEN
**`SHA256SUMS` = `916a2df15c909dabe7ec73eb987d02e3b47e8b51dd744c0003b686452dadf1c6`** (hashed with `sha256sum`; files `a-w`).

| file | sha256 |
|---|---|
| `src/ext4-extent-overlap.c` | `d43eeef7575670d552dab5030ab777b2ed128f64e54b2806f304b73ae0b93928` |
| `src/overlap.py` | `3fac4a394e95de9e460789121c2968d9374553f0c5da96f3a4dfec87ca69ea27` |
| `tests/test_overlap.py` (10 tests) | `ef51b81eb686c4b7f994f8144bab7205dff11d8b0e6804537fae065488095df7` |
| `jobs/tests.sh` | `224cdef97a440d852bec6253098afce9756d55afaef1f37f5f116c71d31f91fe` |
| `README.md` | `f10ba29b0f42ed6733d53e055ae12d628f0b1b4bb2616bcd557d8a48a36f8886` |

**What I did:**
- read the candidate file's **shape and statistics only**: keys; 9001 extents; physical 34,816..530,198,853; blocks ≤ 32,768; sum 276,959,557; 0 unwritten; `authentication: "unchecked candidates only"`; `recoveryProven: false`;
- read the local headers (`/usr/include/ext2fs/{ext2fs.h,bitops.h,ext2_fs.h}`);
- read the peer `tr004/ext4-used-ranges.c` (37 lines) as reference only.

**What I did not do:** compile, run, touch any device/NBD/USB, read the database, mount, or use the network. No other stage was modified.

## Design (and why it is correct read-only, with no false negatives)
**Opening, read only:**
- `ext2fs_open(dev, EXT2_FLAG_64BITS, 0, 0, unix_io_manager, &fs)`. **No `EXT2_FLAG_RW`**, so libext2fs opens the path read-only; the tool also refuses if `fs->flags & EXT2_FLAG_RW`.
- No write, flush or repair call. Close is `ext2fs_close_free` only; a read-only fs is not flushed.
- `EXT2_FLAG_IGNORE_CSUM_ERRORS` is **not** set: a corrupt group descriptor or bitmap refuses instead of yielding a partial bitmap.

**False-negative guards (all refusals, fail closed):**
- **`needs_recovery`:** an unreplayed journal can hold allocations that the on-disk bitmap does not show.
- **Mounted** (`ext2fs_check_if_mounted`): a live bitmap can change underneath.
- **Bigalloc** (cluster ratio ≠ 1): the bitmap search returns cluster-aligned blocks. r1 rejects it rather than risk misreporting.
- **Path:** a symlink, or anything other than a block device or regular file.

**Search** (exact, bounded):
- `ext2fs_read_block_bitmap` (BLOCK_UNINIT groups are synthesized by libext2fs).
- **Validation:** each extent must be 1..32,768 blocks, with `[physical, physical + blocks − 1]` inside `[s_first_data_block, blocks_count)` and inside the bitmap's `[start, end]`. Overflow-safe arithmetic; an invalid extent is reported as `invalid` and **never** passed to the bitmap.
- **Per extent:** `find_first_set(s, end)` (ENOENT = none), then `find_first_zero(set, end)` (ENOENT = to the end). Each emits one allocated sub-range `overlap <index> <logical+off> <physical> <count> <unwritten>`, and the search continues from the zero. It is guaranteed to progress, and any other errcode refuses.
- **Optional `--crosscheck`:** every block is re-tested with `ext2fs_test_block_bitmap2`, and the count must equal the range search's count per extent, or the tool fails. It is bounded at 2^31 blocks; the candidate's 276,959,557 fits.

**Bounded output:**
- stdout is capped at **16 MiB** (`--max-output-bytes` 64..16 MiB). Printing stops at the cap; **counting never stops**.
- The final `summary` line carries `extents, invalid, inputBlocks, overlapExtents, overlapRanges, overlapBlocks, overlapUnwrittenBlocks, printedLines, truncated, crosscheck*`.
- **Input:** ≤ 1,000,000 lines of ≤ 256 bytes, strict decimal.

**Wrapper `overlap.py`:**
- validates the candidate (exact extent keys, integers, boolean `unwritten`, ≤ 64 MiB);
- pipes the extents to the tool and requires the summary to account for **every** extent;
- writes `extent-overlap-report/r1` create-exclusive (0600), carrying the candidate sha256, its verbatim `authentication`, the tool sha256, the header (`blockSize, blocksCount, freeBlocks, state, errors`), the summary, `complete` (not truncated), the ranges and the **interpretation**.

## Interpretation (in every report)
- **An overlap** = blocks the **current** bitmap marks allocated. One such block **disproves an untouched full recovery** from this extent map as-is.
- **It is not proof of overwritten bytes:** that needs reading and comparing the actual bytes. r1 does not read data.
- **No overlap is not proof of intact bytes:** transient reuse after the deletion (bitmap history) is a separate gate.
- **The map itself** is an unauthenticated reconstruction.
- **Not covered by r1:** the tail (`filesize` tail 3,739,987,968 B / the `gaps` entry) and CRC verification.

## Tests (10, unprivileged; tiny ext4 IMAGE FILES via `mke2fs` + `debugfs -w` on the file only; the image is then 0444)
Every test asserts the image's sha256 **and** mtime are unchanged afterwards.
1. **A file's real allocated run** (`debugfs blocks`) is reported **exactly**, with `--crosscheck` 0 mismatches.
2. **A partial extent:** the run plus the following blocks. Exactly the run plus whatever `debugfs testb` independently marks in use is reported; the unwritten flag is carried.
3. **A debugfs-verified free window** reports 0 overlap.
4. **No-false-negative anchor:** a whole-filesystem extent gives overlapBlocks = blocksCount − freeBlocks, and the reported set equals **debugfs `testb`'s independent used set**, with crosscheck 0 mismatches.
5. **Invalid extents are reported, never searched:** beyond the end, 0 blocks, 32,769, at `blocks_count`, 2^63. rc is 3, and the one valid extent is still counted.
6. **Malformed input is refused (rc 1, no summary):** 4 or 6 fields, a negative number, `unwritten` 2, non-decimal, unterminated, a > 256-byte line. Also refused: a symlink device, a directory, and `--max-output-bytes` above 16 MiB.
7. **The output cap:** 75 one-block overlaps with a 400-byte cap gives `truncated=1`, and the counts still equal the uncapped run.
8. **A journal with `needs_recovery`** (set via `debugfs feature`) is **refused** (no stale bitmap).
9. **Wrapper end to end:** the report carries the counts, the exact range, the `authentication`, the interpretation and `complete`, and it never overwrites `--out`.
10. **Wrapper refusals** before the tool runs: bool-as-int, negative, an extra key, a missing `unwritten`, `unwritten: 0`, an empty list.

## Exact root job (offline fixture tests; compile with the local libext2fs)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh extent-overlap-r1 512 unshare -Urn bash extent-recovery-stage/r1/jobs/tests.sh
```
**PASS requires all of:**
- `## compile OK` (`gcc -O2 -Wall -Wextra -Werror`, `-lext2fs -lcom_err`; the binary sha256 is printed and kept);
- `## test_overlap PASS (10)`, no skips;
- `## extent-overlap-r1 rc=0`.

**Then, only after review, on the read-only NBD** (see `README.md`):
```
python3 -I -B extent-recovery-stage/r1/src/overlap.py --tool <built binary> \
  --candidate logs/base-journal-copy-1626/candidate-extent-coverage.json --device /dev/nbdN --out <new report.json> --crosscheck
```
Expect `complete: true` (276,959,557 input blocks; in the worst case about 9001 ranges, far below the cap).

**Not claimed / limits:**
- The checker has never been compiled or run.
- The fixture is cluster-ratio-1 ext4 with 4 KiB blocks.
- Bigalloc and journals needing recovery are refused, not handled.
- The bitmap is a snapshot of the read-only view.
