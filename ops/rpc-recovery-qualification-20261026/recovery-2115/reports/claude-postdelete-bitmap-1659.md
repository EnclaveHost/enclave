# 1659: postdelete-bitmap-stage/r1, an offline post-deletion block-bitmap reuse checker (SOURCE ONLY; frozen, NOT run)

**Stage:** `postdelete-bitmap-stage/r1/`, **SHA256SUMS sha256 `f5c89089199de733163e87ef1c982b4c529bf89c8eb6f90974b04492e62447c5`** (all files 0444, no bytecode).

**What I did:** `ast.parse`, `bash -n`, a JSON parse, and a count of the test methods (12). That is all. No tests, real run, build, live action or USB. I made no peer changes. Peer stages were read only: `ext4-recovery-checksum-stage/r2/refs`, for the pinned v6.12 ext4 source.

**Byte reads from the local journal copy:** I read two small pieces as my own user, with no root involved:
- 1 KiB of the superblock (s_head);
- one proven 4 KiB image (journal block 118422 = the 1649 proven `a5e2f921…` image of fs block 499122230, tid 17169), from which I kept only the 256-byte slot of inode 1950053 as a test vector.

**No recovery acceptance:** nothing here accepts recovery, and an absence of journal history is never treated as proof of anything.

## Records
- **Root r2 → r3 (root 1654/1655):** my r2 test helper `vmain` called itself. My replace-all also rewrote the `V.main` inside it, so it recursed forever.
  - Root's r3 calls `V.main(args)` once.
  - The r3 receipt is PASS: `Ran 9`, `OK`, stdout empty.
  - The r3 runtime is unchanged: `jbd2_verify.py` `d3cfa34e…` = r1. r3 SUMS is `f12578a6…`.
  - The new stage's test helper `pmain` calls `P.main` once.
- **Root's 1649/1657/1658 findings** are used only as the user stated them and as recorded in the input files.

## Files
| file | sha256 | notes |
|---|---|---|
| `postdelete_bitmap.py` | `fd3c0a9f…` | the checker |
| `jbd2_verify.py` | `d3cfa34e…` | byte-identical to r1 and r3 (`cmp` in both jobs; the sha is checked before the bytes are executed) |
| `case/base-1626.json` | `f952b1f8…` | input pins and prior expectations |
| `tests/test_postdelete_bitmap.py` | `c44fed4e…` | 12 tests |
| `tests/real-inode-1950053-seq17169-slot256.hex` | `a6003b4a…` | real slot; stored ext4 csum `0x72b56bba` |
| `tests/real-fs-stats-header.txt` | `3a6b36e3…` | the first 48 real fs-stats lines |
| `jobs/tests.sh` | `53a49a25…` | |
| `jobs/root-check.sh` | `704fde4e…` | |
| `README.md` | `0bc247e6…` | |

**Case pins:**
- journal `d95d81fc…`
- `fs-stats.out` `ee9e7235…`
- `candidate-extent-coverage.json` `94ceb13f…`
- inode 1950053, old generation 3326586236, metadata blocks 28
- expected: last-live tid 17169, deletion-start tid 17170, inode-table block 499122230 at offset 1024, old size 1138166333440, fs UUID `11c6bbac…`

I derived the slot location from fs-stats: group 15234, inode table 499122224, index 100 gives block +6, offset 1024. The checker refuses any mismatch.

## Root commands (queue 512)
```
bash jobs/q-exit-status.sh pdb-r1-tests 512 unshare -Urn bash postdelete-bitmap-stage/r1/jobs/tests.sh
bash jobs/q-exit-status.sh pdb-r1-check 512 unshare -Urn bash postdelete-bitmap-stage/r1/jobs/root-check.sh
```
**Tests gate:**
- exactly `Ran 12 tests`;
- the last non-empty stderr line is `OK`;
- stdout is empty;
- no ResourceWarning, skipped, FAIL, ERROR or Traceback;
- the stage SUMS, frozen r1/r3 SUMS and runtime `cmp` checks pass;
- `receipt.json` is written. Expect `## PASS (12)`.

**Check:**
- **Precondition:** it refuses without a passing test receipt.
- **Pins:** the inputs are re-pinned. The journal sha is checked before and after the run, and the inputs must be regular files, not symlinks. The tool also opens everything with nofollow (`open_ro`).
- **Bounds:**
  - 5400 s wall and 3600 s CPU (`ulimit -t`);
  - at most 24 verifier calls, each with at most 4096 targets (starting at 2048);
  - at most 262144 image reads;
  - output at most 16 MiB, O_EXCL, mode 0600.
- **rc:** 0 = NO_REUSE_OBSERVED_IN_JOURNALED_HISTORY, 4 = REUSE_OBSERVED, 5 = BLOCKED, 3 = refused, 9 = precondition failed.
- **Memory:** the peak is not measured. If 512 MiB is too small, the run fails closed. Re-queue at 1024, which the queue supports.

## What the checker proves, and how
Every image used is **proven** by the frozen runtime: descriptor, tag and commit checksums, and a contiguous walk. The bytes are re-read and must hash to the verifier's `contentSha256`.

**1. Boundary, from inode versions only.** It walks every proven image of block 499122230, slot at offset 1024, in tid order:
- **P:** the last image of the old generation that is live (links > 0).
- **S0:** the next image. It must be the old generation unlinked.
- **C:** the first image in the completed shape, together with an **inode-bitmap (499122194) image in the same transaction** with bit 100 clear.
  - Completed shape: links 0, size 0, i_blocks 0, extent root with 0 entries and depth 0, and i_dtime greater than the inode count. During orphan processing i_dtime holds an inode number, so a value above the inode count means a real timestamp.
  - Why the same transaction: pinned v6.12 `inode.c:294-309` (`ext4-recovery-checksum-stage/r2/refs/linux-v6.12-fs-ext4-inode.c` `a85d3c8a…`) does `ext4_orphan_del`, sets `i_dtime`, marks the inode dirty, calls `ext4_free_inode` and stops the handle, all in one handle.
- **R:** the first later generation, i.e. slot reuse. User: the current gen is 394….

If there is no such C, the result is **BLOCKED**; it never guesses one. A partial free, which can still look allocated, is therefore never taken as completion.

**Slot binding:** the ext4 inode crc32c (`inode.c:57-108`, seed = crc32c(~0, uuid), then ino, then gen) must verify on every slot row from P. The real tid-17169 slot is the non-circular vector (0x72b56bba). The inode-bitmap bit is cross-checked from S0 to C to R.

**2. Window completeness.**
- Every tid from P to the newest proven tid must be proven.
- No JBD2 header of any tid ≥ P may lie outside the proven set. This is my own 12-byte header scan, cross-checked against the verifier's header count.
- No failed commit may fall in the window.
- No descriptor or revoke reference to a target at a tid ≥ P may lack a proven image.

**About 17670 (s_sequence 17671, newest commit 17669):**
- **What the pinned upstream code does:** `journal.c:2165-2166` (`jbd2_journal_destroy`) does `j_tail_sequence = ++j_transaction_sequence` before `jbd2_mark_journal_empty`, which writes `s_sequence = j_tail_sequence` and `s_head = j_head` (`:1913-1915`). `commit.c` always writes a commit record (`:808`/`:901`); it has no empty-transaction exit. So a clean unmount after 17669 writes s_sequence 17671 and never uses tid 17670.
- **The copy agrees:** `s_head` = 131627 = the block right after 17669's commit (131626). I read that from the superblock myself.
- **What the checker accepts:** "newest = s_sequence − 2" only when there is no header of s_sequence − 1 anywhere AND s_head equals the block after the newest commit. "Newest = s_sequence − 1" is also accepted. Anything else is BLOCKED.
- **Caveat:** the pinned source is upstream master, not necessarily the kernel that wrote this filesystem.

**3. Bitmaps.** The checker verifies the block-bitmap block of **every** group the 9001 extents touch, with no unverified selector.
- **Why not select only post-boundary blocks:** the deletion must journal every covered group's bitmap when it frees it. So the journaled set is the whole set, about 8.6k groups.
- **Instead of selection:** every old data bit must be seen CLEAR in some proven image at or before C, otherwise BLOCKED. That check proves both selection coverage and freeing coverage.
- **Batching:** batches of at most 4096 blocks; an incomplete listing is split in halves; at most 24 calls.
- **Rules for each old data bit, in tid order:**

| when | outcome |
|---|---|
| set at or after C | **REUSE** |
| set after it was seen clear, between S0 and C | **REUSE** (the partial-free window) |
| set between S0 and C, never seen clear before | not reuse: still being freed |
| clear before S0 but at or after its leaf's tid | BLOCKED: freed before the deletion, so the map is stale |

  Each result lists counts, the first reuse tid, block samples and a per-group table.

## Coverage limits and missing gates (not resolved by this stage)
1. **Commit granularity:**
   - An allocate-then-free of a block **within one transaction** leaves no bitmap trace, yet data may have been written.
   - Reuse of a block freed earlier but allocated and freed again inside one later transaction is equally invisible.
2. **Writes that never touch the bitmap are invisible:**
   - online `discard` or **fstrim** after the deletion, which on a qcow2 image can drop the clusters;
   - raw writes or writes at the image layer.

   **Missing gate:** a read-only image-layer check of the DB ranges, such as the qcow2 allocation map or sampled content reads. That check and its authorization are separate.
3. **Overwritten history:** history before the oldest retained tid (3180; tids 3181–3182 are absent from the proven list) cannot be proven absent. The checker only needs tids from P (17169) onward to be complete, and it blocks otherwise.
4. **After 17669:** the state is the current bitmap (root 1657: no overlaps across 276959557 blocks). fs-stats records the last write time as Oct 26 09:00:38 and the state as clean. I did not verify that the image was never mounted since.
5. **Reuse is not proof of overwrite.** Under data=ordered, new allocations are usually written before commit, but unwritten (fallocate) extents are not. **No reuse is not proof of intact bytes.**
6. **Unchecked inputs:**
   - Bitmap locations come from the current descriptors in fs-stats, which are static without a resize.
   - The candidate map is an unauthenticated reconstruction, carried verbatim; leaf tids per extent are assigned from `picked[].entries` in logical order.
   - Group-descriptor bitmap checksums are not cross-checked; the JBD2 tag checksums cover the images.
   - The 28 metadata blocks (index and leaves) are not checked for reuse, because their content is already taken from proven journal images.
7. **Prior findings:** P = 17169 and S0 = 17170 come from earlier work. The checker derives them independently and BLOCKS on a mismatch.

## Remaining (exact)
- **Root step 1:** `pdb-r1-tests` must PASS with 12 tests. A failure means my fixture or code is wrong; send me the output for a new r2. I could not run anything, so the fixtures are unexecuted.
- **Root step 2:** `pdb-r1-check` on the local journal copy. Its verdict is evidence only:
  - **REUSE_OBSERVED:** the listed old blocks were allocated again at a committed tid, so they may be overwritten.
  - **NO_REUSE_OBSERVED_IN_JOURNALED_HISTORY:** still needs gate 2 (discard / image layer) and a content check before anyone says "recoverable".
  - **BLOCKED:** the listed reasons need review.
- **Never:** a candidate-only recovery acceptance, or an acceptance from an absence of history.
