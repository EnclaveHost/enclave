# Independent source review: postdelete-bitmap-stage/r2 - 2026-10-26

**What I did and did not do:**
- **Nothing built, tested, mounted or run.** No device, no USB, no changes to any stage file.
- **One bounded read-only check:** 27 × 4 KiB `pread`s of the local journal copy, for leaf-to-map correspondence (§2).

**MDBX:** noted that root's r4 tiny-fixture `ProcessLookupError` fix passes all 20 tests with no warnings (1685), and its runtime is identical to r3. No further MDBX work from me.

## Stage identity (verified)
- **Both stages match their sums:** `r1/SHA256SUMS` and `r2/SHA256SUMS` `sha256sum -c` cleanly.
- **Runtime unchanged:** r2 `postdelete_bitmap.py` = **`fd3c0a9f…dd09a9`** (= r1); `jbd2_verify.py` = `d3cfa34e…` (= r1); `case/base-1626.json` = `f952b1f8…` (= r1). Both jobs `cmp` these against r1.
- **The fixture fix is fixture-only and correct:**
  - `OTHER` = (100, 110) is disjoint from E1 (1000-1100), E3A (32760-32768), E3B (0-2), E2 (5-55) and from the unrelated bit 5000;
  - r1's overlapping (0, 10) is kept as a negative case: BLOCKED, 7 bits never freed, 7 reused at tid 14 (root 1683's numbers).
- **Root 1686:** 13 tests PASS; the receipt `stageSums` = `51c393bf…` = the current `r2/SHA256SUMS`.

## Verdict
1. **Safe to run offline on the local journal copy?** **Yes**, as the job is written and as the queue actually runs it.
   - **Run artifacts are uid 1000:** the `runs/` trees and receipts are owned by `steven`, so the queue does not run the job as real root.
   - **Read-only and bounded:**
     - all inputs are opened `O_NOFOLLOW|O_NONBLOCK`, must be regular files and are hash-pinned;
     - network namespace; no device, mount, replay or repair;
     - the only Python write is one `O_EXCL|O_NOFOLLOW` 0600 `result.json`;
     - limits: ≤ 24 verifier calls (each one pass plus a walk ≤ 4× the log), ≤ 262144 image reads, `ulimit -t 3600`, `timeout 5400`.
   - **Failure modes are all refusals or BLOCKED, never a false verdict:**
     - more than 24 calls, listing overflow, walk budget, the CPU limit or a journal change → refusal (rc 3) or a missing result;
     - an unexplained tail or any gap → BLOCKED.
   - See F6 if anyone runs it as real root.
2. **Any flaw causing a false NO_REUSE or report acceptance?** I found **no path to a false REUSE→NO_REUSE flip inside the stated model.** That model is proven JBD2 history from P onward, with the kernel as the only writer.
   - **F1** is a real gap in what "freed" is shown to mean.
   - **F2** is a missing LIMIT: writers that bypass the journal entirely.
   - Neither makes the verdict an acceptance, and the stage never claims one (`ACCEPTANCE` text plus the verdict name `…_IN_JOURNALED_HISTORY`).
   - **Recommendation:** root may run the check as is. **Treat rc 0 only as "no reuse in proven journal history".** Before anyone relies on it, close F1 (an r3 checker hardening) and confirm the F2/F7 preconditions out of band.

## What I checked against the source
**Map, group pieces and leaf tids:**
- **Map consistency:** `parse_coverage` requires:
  - `sum(picked.entries) == len(extents)`;
  - strictly increasing logical order with no physical overlap;
  - no overlap with block/inode bitmaps or inode tables;
  - and in `check`, `allocatedBytes == (dataBlocks + 28) × 4096` at P.
- **Leaf tids** are assigned by walking `picked[]` in list order.
- **Leaf images vs the map (my read):** I read the 27 picked leaf images at their `journalBlock`s in the local copy and decoded the ext4 extent leaves (magic `0xF30A`, depth 0).
  - **Result:** all 27 leaves have `entries` equal to `picked.entries`, and the decoded `(logical, len, physical, unwritten)` tuples are **identical, in order, to `extents[]`** (0 mismatches).
  - **Order:** `picked[]` is in increasing logical order (0, 10958848, 21929984, …), so leaf-tid assignment is correct.
  - **Limit of this check:** it is a byte correspondence only, not checksum authentication. Root's `selected-jbd2-verification.json` (29/29 matched) covers that, outside this checker.
- **`group_pieces`:** splits at 32768-block group boundaries, with a per-group mask over only the old file's bits. Bit order matches ext4's little-endian bitmaps (`int.from_bytes(…,"little")`).

**Inode completion derivation (P, S0, C, R):**
- **The model:**
  - P = the last live old-generation image;
  - S0 = the very next slot image, which must be the old generation with links 0;
  - C = the first image with the full freed shape (size 0, i_blocks 0, empty depth-0 extent root, dtime > inode count) **plus** an inode-bitmap image **in the same tid** with the bit clear;
  - R = the first image with a different generation.
- **Cross-checks:** inode crc32c from P onward; inode-bitmap state S0..C set, C..R clear, set at R; P/S0 must equal the prior finding 17169/17170.
- **Matches ext4 eviction:** `ext4_evict_inode` truncates over many handles, then sets `i_dtime` and calls `ext4_free_inode` in one handle.
- **A truncation not finished at C is impossible** given the shape requirement.

**JBD2 window and tail:**
- **Contiguity from P:** every tid from P to the newest proven tid must be proven, with no stray header or failed tid ≥ P, and no unproven or revoke reference ≥ P on any target.
- **Tail rule:**
  - gap 1 is accepted (a `jbd2_journal_flush` leaves `s_sequence = j_transaction_sequence`);
  - gap 2 is accepted only with no header of `s_sequence-1` anywhere and `s_head` = the block after the newest commit. This matches `jbd2_journal_destroy` (`j_tail_sequence = ++j_transaction_sequence`) followed by `jbd2_mark_journal_empty`;
  - anything else is BLOCKED. That includes an extra empty mount/unmount cycle (gap 3) and an older kernel without `s_head` (0) — both safe.
- **Also checked:**
  - a non-clean journal is BLOCKED;
  - a fast-commit journal is refused by the runtime (incompat mask);
  - fast_commit and orphan_file are absent from the real features line;
  - bigalloc and metadata_csum_seed are rejected.

**Ordered bitmap images and temporary reuse:**
- **Per bit, in tid order:**
  - S0..C: a bit seen clear and later set = REUSE;
  - at or after C: any set bit = REUSE;
  - every bit must be seen clear at or before C, otherwise BLOCKED;
  - pre-S0 images at or after the bit's leaf tid must show it set.
- **Why "seen clear" is visible:** JBD2 logs the frozen copy of every dirtied bitmap block per transaction, and `ext4_free_blocks` clears bits in the bitmap buffer inside the handle. In data=ordered mode, freed data blocks go through `ext4_mb_free_metadata` and are not reusable until the free commits, so a cross-transaction reuse always shows an observed clear followed by a set.
- **data=writeback:** the free is not deferred, so reuse can happen within the same transaction. The bit is then never seen clear → BLOCKED (safe), unless it is freed again inside the window, which is the stated intra-transaction limit.

## Findings
**F1 (MEDIUM, scope of "freed"):** "freed" is accepted on observing the bit CLEAR. The checker never requires seeing it SET (owned) first, and the history between the leaf tids and P is not proven complete.
- **The cause:**
  - the window contiguity starts at P = 17169, but the leaf tids go back to **14665**;
  - the pre-deletion "must be SET" check only sees bitmap images in [leaf tid, S0). For most groups (allocated before their leaf was last logged) there is likely **no** such image, so ownership is never observed;
  - a pre-deletion change in an unproven gap between a leaf tid and P (a leaf rewritten, an extent shrunk or freed and reallocated) would not be seen;
  - `picked[].sequence` is taken from the coverage file and not verified by this checker.
- **Practical risk: low.** The leaf bytes match the map exactly (above), the `i_blocks` total matches, and root's verifier summary shows 14488 / 14488 commit sequences proven with 0 failed.
- **Still, the code does not prove it.** Hardening for an r3 checker, without weakening anything:
  - (a) require contiguity from **min(leaf tid)** (or the oldest proven tid) up to the newest;
  - (b) add the 27 leaf blocks (plus the index block) as verifier targets. Require a proven image at each `picked.sequence` whose bytes decode to exactly that slice of `extents[]`, and no newer proven image of that leaf before S0;
  - (c) report per group the bits with an observed SET→CLEAR transition, versus bits only seen clear.

**F2 (MEDIUM, missing LIMIT / precondition):** JBD2 only sees **kernel ext4** writes. `fuse2fs` read-write, `debugfs -w`, `e2fsck`, `tune2fs` and `resize2fs` change bitmaps and data **without** journal records. Mounting the image anywhere else than the guest is the same risk.
- **Why it matters here:** `fs-stats` shows "Last write time Mon Oct 26 09:00:38" after "Last mount time Sun Oct 25 10:54:48".
- **Not in LIMITS:** `LIMITS` names discard, raw-device and image-layer writes, but not userspace e2fsprogs/fuse2fs writers.
- **Precondition:** confirm that `s_wtime` matches the guest's final unmount (compare with the newest proven `commitSec`) and that no RW e2fsprogs/fuse2fs session touched `base-origin.qcow2` after the deletion. The verdict name is accurate, but this should be stated next to it.

**F3 (LOW, docstring vs code):** the docstring says S0 checks the orphan `i_dtime` (the next orphan ino ≤ inode count). The code only checks the old generation and links 0.
- **Not a false acceptance:** P/S0 must equal 17169/17170 and C needs the full shape. But the docstring overstates what is checked.

**F4 (LOW, job gate):** `root-check.sh` accepts **any** `runs/tests-*/receipt.json` containing `"pass": true`. That directory is uid-1000 writable, and the receipt's `stageSums`/`checkerSha256` are not compared with the current stage.
- **Today it is correct** (`51c393bf…`). An r3 should bind the receipt to the stage SUMS and the checker sha.

**F5 (INFO, cost):** in a BLOCKED-everywhere case, `absb` loops 32768 times per listed group, up to 3 × 4096 groups (~400 M Python steps; minutes of CPU, inside `ulimit -t`).
- **Rough expected cost:** about 8.6k bitmap targets plus 2 gives about 5 verifier calls to start with, each a full ~1 GiB walk from page cache.
- **Bounded:** splitting is capped at 24 calls, and going over means a refusal, not a wrong verdict.

**F6 (LOW, only if run as REAL root):** bash `sha256sum < "$J"` and `sha256sum "$J" …` follow symlinks **after** the `[ ! -L ]` test (a TOCTOU race in a uid-1000 directory). That is the inactive-`/dev/watchdog` host-reset hazard. `mkdir -p "$O"` also accepts a pre-planted directory.
- **Python also refuses then:** under `unshare -Urn` from real root, steven-owned inputs appear as an overflow uid, so `open_ro` refuses them (rc 3), but the bash hash lines run before that.
- **Keep running it as uid 1000,** as the artifacts show. An r3 should hash with a nofollow Python open and use `mkdir` without `-p`.

**F7 (INFO, outside this check, already partly in LIMITS):**
- **Writes that never touch the bitmap:**
  - an allocate+free inside one transaction;
  - discard/TRIM — check the guest's `discard` mount option and `fstrim.timer`. Its default `OnCalendar=weekly` is Monday 00:00, and 2026-10-26 was a Monday;
  - qcow2/NBD-layer deallocation (check the image allocation map for the extents).
- **Unknown mount mode:** the data mode (ordered vs writeback) is unknown from these inputs.

## Bottom line
- **Running it:** root may run `pdb-r2-check` offline on the local copy as uid 1000. It is read-only and bounded.
- **Reading the result:**
  - rc 0 means only **NO_REUSE_OBSERVED_IN_JOURNALED_HISTORY**: proven history from tid 17169 onward, kernel writes only;
  - it is not ownership-proven per bit (F1), and not proof against non-journaled writers (F2) or against intra-transaction/discard/image-layer writes (F7).
- **Not production acceptance:** this is never a production or recovery acceptance.
