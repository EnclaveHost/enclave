# postdelete-bitmap-stage/r3: review 1687 hardening (F1/F2/F3/F4/F6) plus root 1698's real single-transaction shape. Source only - 2026-10-26

**Not done by me:** no build, test, mount, USB or live action; nothing was executed except AST/`bash -n` syntax checks.
- **Real data read:** a bounded read of the local journal copy (27 leaf images, already done for 1687) and root's 1698 `result.json`.
- **Real leaf vector:** a 4 KiB real leaf image was copied into the stage as a test vector.
- **r1 and r2 are unchanged and verified:** r1 `f5c89089…`, r2 `51c393bf…`.

## Stage: `postdelete-bitmap-stage/r3`, FROZEN
**`SHA256SUMS` = `5ecd6a6dddbc08821eaf5db65b99a4ab6f7eb64a360aae71b2738a9972413806`** (files `a-w`).

| file | sha256 |
|---|---|
| `postdelete_bitmap.py` (checker r3) | `8c5ac6152f86851450a21b491d4c57cb551f1bfb4cf2b4fd7c0e7a6445e13ab7` |
| `tests/test_postdelete_bitmap.py` (**21 tests**) | `675a586f6bbdf5355c1cded25521877957a32c48a347394ebdf758a2665acae1` |
| `tests/real-leaf-499155437-seq14665.hex` (new real vector) | `ce7f81c60802036e30e1dc6aaf819d7dc41d15bbe20c488c34204d7617d4d808` |
| `jobs/tests.sh` | `c2628f9d7788b01e0fab0d80f57b26bc82625a7f1e27258021ee2bd4bc173aaf` |
| `jobs/root-check.sh` | `96604e613c7cf950d5b6be01b4a62a7da8668cb3a06d94377c9f593afbcc52f6` |
| `README.md` | `ae315fa61a96b93c0393236f9dcd1ef981a62a2e8c90f9b2bfc6b0024a96ae2e` |
| `jbd2_verify.py` | `d3cfa34e…` (= r1 = journal-recovery-verifier r1/r3) |
| `case/base-1626.json` | `f952b1f8…` (= r1) |
| real fs-stats header / real inode slot vectors | unchanged from r1/r2 |

## Important real-data finding from root 1698 (r2's actual check, rc 5)
- **What r2 reported:** P = 17169 (old generation live, inode checksum valid).
- **The next slot image, tid 17170 (commitSec +5 s), already holds a NEW generation `3941633993`:** links 1, size 9,498,957,512, i_blocks 0, no extents. The inode-bitmap image at 17170 has the bit **set**.
- **So the unlink, truncate, inode free and slot reallocation all happened inside the ONE transaction 17170.**
- **Why r2 blocked:** r2 required a separate "old generation unlinked" image at S0, so it blocked with "the image after the last live one is not the old inode unlinked".
- **Not a corruption sign:** the window itself was clean (from 17169 to 17669, contiguous, no gaps/strays/failures, tail = clean unmount `s_sequence-2`).
- **r3 models this explicitly** as `mode: "single-transaction"`: S0 = C = R = 17170.
  - **Why the slot reuse implies the free:** ext4 reallocates a slot only after `ext4_free_inode` cleared its bit, and that runs after the truncate, in the same eviction.
  - **The bitmap rules still apply unchanged:** every old bit must be seen clear at 17170 (otherwise BLOCKED), and any old bit set at 17170 or later is REUSE.
- **What the new file implies:** the new file (likely a recreated `mdbx.dat`) is now allocating space in this filesystem, so **REUSE_OBSERVED is a realistic outcome** of the r3 check.

## F1: the map is bound to the proven extent tree; window from the oldest tree image; ownership counts
- **Tree binding.** The extent root is decoded from the authenticated last-live inode image P; it must be depth 1 or 2 (the real root is depth 2 → index `499155449`).
  - **Index blocks:** they are verified in a **second verifier phase**. This phase shares the ≤ 24-call budget, and its proven transaction set must equal phase 1's, otherwise it refuses.
  - **Every index and leaf block uses its NEWEST proven image before S0.** That image must:
    - be an ext4 extent node of the expected depth;
    - pass the **ext4 extent block checksum** `crc32c(crc32c(crc32c(fs seed, ino), generation), block[0:12+12·eh_max])`, which binds the node to inode 1950053 **generation 3326586236**.
  - **The map must match the tree:**
    - leaf pointers equal `picked[].block` in order;
    - each leaf's image tid and journal block equal `picked[].sequence` / `journalBlock`;
    - decoded extents equal `extents[]` exactly;
    - the tree block count equals `metadataBlocks` (28);
    - tree blocks are distinct and outside the old data.
  - **Any failure → BLOCKED.**
  - **Formula checked on real data:** all 27 real leaves verify with this formula (my bounded read), and the stage test checks the real leaf vector with both CRC implementations and against the NEW generation, where it must fail.
  - **Reuse of root's records:** I did not import root's 1649/1658 records by hash. The checker re-derives the same binding from the frozen runtime's proven images, so no ext4 tree verifier was reimplemented beyond header decode plus checksum.
- **Window.** It starts at the **oldest bound tree image tid**, or at P if that is older. For the real data that is 14665, so contiguity 14665…newest is required.
  - **Unproven references:** they are checked from the same point.
  - **Revokes:** a revoke of the file's own tree blocks is allowed only at or after S0 (the truncate forgets them; real index revoked at 17170/17179/…). Any other revoke blocks.
- **Ownership counts per group** (two new `perGroup` columns plus totals):
  - **`observedSetToClearBlocks`:** a proven SET image (at or after the leaf tid) followed by the first clear;
  - **`clearWithoutObservedSetBlocks`:** bits only ever seen clear;
  - **the second count is reported with an explicit note and never counted as observed.** Those bits are attributed only by the bound tree, and that is not a blocker.

## F2, F3, F4, F6
- **F2:**
  - **New LIMITS entry:** userspace e2fsprogs (`debugfs -w`, `e2fsck`, `tune2fs`, `resize2fs`), fuse2fs read-write, other kernels or OSes, raw block/image writes and discard/`fstrim`/`fstrim.timer` are all **invisible**.
  - **Also in LIMITS:** the single-transaction intra-transaction limit, and the explicit statement that MDBX, plain-vs-hashed/trie and canonical-root gates remain.
  - **Reported side by side:** the result carries `journal.window.newestCommitSec` and `geometry.lastWriteTime` / `lastMountTime`.
- **F3:** S0 now requires `i_dtime ≤ inode count` (the next orphan ino, or 0), matching the docstring. A timestamp there → BLOCKED (test).
- **F4:** `root-check.sh` accepts only a `receipt/r3` that `pass`es, with `expectedTests` 21 / `ran` ["21"], and whose `stageSums`, `checkerSha256`, `runtimeSha256` and `testsSha256` equal the current files. These are read with nofollow, caller-owned opens.
- **F6:**
  - **Both jobs refuse real root** (`/proc/self/uid_map` outer uid 0) and a stage not owned by the caller.
  - **Inputs and the result are hashed by a Python nofollow, caller-owned open** (no bash `<` redirection on inputs).
  - **The run directory must be NEW** (`mkdir`, not `mkdir -p`).
  - **Frozen r1/r2 postdelete and verifier r1/r3 are checked;** the runtime and case must `cmp`-equal r1.

## Tests: 21 = r2's 13 updated (no assertion weakened) + 8 new
**Fixture changes:**
- The fixture now carries a real-shaped tree: a depth-1 root → leaves 70/71, with csum tails; a depth-2 variant adds index 72.
- Leaf `journalBlock`s come from the fixture journal, and the journal builder gained revoke blocks.

**One existing expectation changed by addition only:** `perGroup` gains two columns (108/0 and 52/0).

**New tests:**
1. `test_real_leaf_extent_checksum_and_decode`: the real kernel-written leaf verifies for the old generation with both CRC implementations, fails for the new generation, and decodes to 337 entries with the first one equal to (0, 2048, 248373248).
2. `Tree.test_tree_bound_ownership_observed_and_window_from_oldest_leaf`: bound depth-1 tree, window from 10, 160 observed / 0 unobserved, the LIMITS text.
3. `Tree.test_depth2_index_tree_binds_through_a_second_verifier_phase`: positive, and an index pointing elsewhere → BLOCKED.
4. `Tree.test_tree_binding_negatives_block`, all BLOCKED and unbound:
   - leaf bytes ≠ map;
   - a checksum with another generation;
   - a newer leaf image before S0;
   - a missing leaf image;
   - a metadataBlocks mismatch.
5. `Tree.test_window_from_the_oldest_leaf_sees_a_gap_before_the_last_live_image`: a gap at 11 < P = 12 is now caught (r2 could not see it).
6. `Tree.test_unobserved_ownership_is_reported_not_invented`: no pre-free SET image → 52 clear-only bits, rc 0 with the note.
7. `Tree.test_single_transaction_deletion_and_slot_reuse`: the real 17170 shape gives rc 0 with S0=C=R. With 2 old bits still set → BLOCKED with reuse 2. The old generation seen again later → BLOCKED.
8. `Tree.test_s0_orphan_dtime_and_tree_block_revokes`: a timestamp dtime at S0 → BLOCKED; a leaf revoke at C is allowed (rc 0); a leaf revoke before S0 → BLOCKED.

## Root jobs (queue 512, as the unprivileged owner, as before)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh pdb-r3-tests 512 unshare -Urn bash postdelete-bitmap-stage/r3/jobs/tests.sh       # PASS = "## PASS (21)", rc 0
bash jobs/q-exit-status.sh pdb-r3-check 512 unshare -Urn bash postdelete-bitmap-stage/r3/jobs/root-check.sh  # needs the bound r3 receipt
```
**Expected cost:** r2's real run needed 5 verifier calls, 2501 image reads and 174 MiB peak. r3 adds 27 leaf targets plus one index phase, so expect about 6-7 calls and well under the 3600 s CPU / 24-call limits.

**Possible real outcomes:**
- **BLOCKED**, for example if any picked leaf is not the newest pre-deletion image, or the 14665…17669 window has a gap.
- **REUSE_OBSERVED**, likely given the new generation that took over the slot.
- **NO_REUSE_OBSERVED_IN_JOURNALED_HISTORY**.

## Not claimed / unverified
- **Unverified until root runs it:** none of this has been executed. The fixture expectations (e.g. `perGroup`, `tree` dicts) and the real outcome are unverified until root runs the jobs. If a fixture assertion is wrong, it fails loudly rather than passing silently.
- **Recovery is still unproven:** the results cover journal history only. Intra-transaction allocate/free, discard, userspace or non-journaled writers and image-layer writes remain unproven.
- **No production acceptance:** full MDBX, plain-vs-hashed/trie and canonical-root gates remain mandatory. Journal absence of reuse alone is NOT recovery acceptance.
