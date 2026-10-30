# Root 1698 BLOCKED boundary: a coalesced unlink + free + inode reuse in ONE JBD2 transaction. Source-only review and checker proposal (1701)

## Evidence read (small metadata only; no scans)
**`logs/root-postdelete-real-findings-1698.md` and the result** `postdelete-bitmap-stage/r2/runs/check-20261026T211719Z-2363068/result.json` (sha256 `25abe05e…a7`, re-hashed):
- **Verdict:** BLOCKED.
- **The two blockers:** "the image after the last live one is not the old inode unlinked", and the derived tids 17169/None ≠ the prior 17169/17170.
- **The window is complete:** tids 17169..17669 are contiguous, with no gaps, strays or failed transactions; `s_head` 131627 and the clean-unmount tail are accounted for.

**Slot rows** (inode 1950053, table block 499122230 + 1024, all with a valid ext4 inode checksum):

| tid | commit (epoch s) | generation | links | size | iBlocks | tree | dtime |
|---|---|---|---|---|---|---|---|
| 17169 | 1793027739 | **3326586236 (old)** | 1 | 1,138,166,333,440 | 2,215,676,680 | depth 2 | 0 |
| 17170 | 1793027744 | **3941633993 (new)**, ctime **1793027740** | 1 | 9,498,957,512 | 0 | depth 0, 0 entries | 0 |
| 17171… | +5 s each | new | 1 | same | 0 | empty | 0 |

- The inode bit at 17170 is **set** (`inodeBitmapRows [[17170, 1]]`).

**Local r1 inventory** (`logs/base-journal-copy-1626/inventory-r1.json`, transaction records only):

| tid | tags | descriptors | revoke blocks |
|---|---|---|---|
| 17167-17169 | 1 / 1 / 5 | 1 each | 0 |
| **17170** | **8,918** | **36** | **1** |
| 17171-17174 | 6 / 5 / 2 / 5 | 1 each | 0 |

- **17170 is committed and intact.**
- **The size fits one transaction that freed the whole tree:** 8,748 block-bitmap blocks of the covered groups, plus ≈ 137 group-descriptor blocks (8,748 groups ÷ 64 descriptors per 4 KiB block), plus the inode table, inode bitmap, directory and orphan/superblock updates. One revoke block would match the freed extent-tree metadata.
- **This is arithmetic consistency, not proof.** The per-block identity of those 8,918 tags must be checked (below).

## The primary source: is unlink + free + same-ino reuse in ONE commit allowed? **Yes.**
**Pinned references:**
- **New here,** fetched to `postdelete-coalesced-proposal/refs/`:
  - linux **v6.12** `fs/ext4/ialloc.c`, sha256 `117ef02067d775223e47e38117db692f827e6375756766ee8c6a29d48ccc739f`;
  - `fs/jbd2/transaction.c`, `3b34619085fb4d6d5b350fd1fcd0cd3364cafb7873d321d039ff7ca45cde04ff`.
- **Reused:** `ext4-recovery-checksum-stage/r1/refs/linux-v6.12-fs-ext4-inode.c`, `a85d3c8a…`.

**What each part says:**
- **Immediate reuse of the same inode number is permitted on a journaled filesystem.** `find_inode_bit()` sets `check_recently_deleted = EXT4_SB(sb)->s_journal == NULL` (`ialloc.c:720`). The `recently_deleted()` dtime guard (`:674-…`) is applied **only without a journal** (`:730`). This filesystem has `has_journal`, so the just-freed bit (`ext4_find_next_zero_bit`, `:724`) can be handed straight to the next `__ext4_new_inode`.
- **The deletion path is a series of handles:** `ext4_evict_inode` (`inode.c:169`) runs `ext4_truncate` (`:263`), then `ext4_orphan_del` (`:294`), then `ext4_free_inode` (`:308`, which clears the inode bit).
  - A large truncate restarts its handle (`jbd2__journal_restart`, `transaction.c:747-812`), and a restarted handle starts again with `start_this_handle` (`:316`), which joins `journal->j_running_transaction` (`:403`).
  - **A new transaction is forced only** when the commit timer or space/credit limits trigger (`:237`, `:276`, `:676`).
- **So the whole sequence can commit as ONE transaction, with no committed intermediate "unlinked / freed" image:** unlink, the full truncate of the 1.14 TB tree (8,748 bitmaps, ≪ `j_max_transaction_buffers` for a 262,144-block journal), freeing the inode, and the new `creat`/`ftruncate` of a 9.5 GB sparse file reusing ino 1950053, all within one 5 s commit interval.
  - The new inode's ctime (…740) is 1 s after 17169's commit (…739) and 4 s before 17170's commit (…744).
- **Not inspected here:** the fixed `j_max_transaction_buffers` value, and `ext4_free_blocks`/`ext4_forget` revoke behaviour (`mballoc.c`, `ext4_jbd2.c` not fetched). The revoke expectation below is corroboration only.

**Conclusion:** the 1698 observation is a **valid ext4/JBD2 behaviour**. The r2 boundary model (which requires an explicit unlinked/freed row) is too narrow for it. That is not evidence of corruption, and **the missing intermediate row must not be assumed "overwritten"**: the window is proven contiguous, so it genuinely never committed.

## Proposed coalesced-completion rule (for root 37's r3; I did not edit its stage)
**Inputs:** only the r2 verified data path: `jbd2_verify.py` `d3cfa34e…`, the verified transaction set (`0e51976c…`), the local journal copy `d95d81fc…`, the candidate map and fs-stats as in r2.

**Accept the model "coalesced at T" only if ALL of the following hold:**
1. **The last live image P:** the last old-generation image with links ≥ 1 (17169). Its checksum is valid; size and allocation equal the candidate map + 28 metadata blocks (as r2).
2. **The next transaction:** **T = P + 1** (the window is contiguous from P; no unproven tid in between), and the slot image in T is a **different generation**, checksum-valid, links ≥ 1, and **no** old-generation image appears at or after T. If T ≠ P + 1, or an old-generation image appears after T, **BLOCK**.
3. **The inode bit at T is 1** (reused), and it is consistent at every later tid until any further change, as in r2.
4. **Completion of the free, in T itself.** Every one of the **8,748 covered groups**, plus the groups of the **28 tree blocks**, must have a **committed, verified block-bitmap image in transaction T**. The bitmap block location comes from fs-stats group descriptors.
   - **Clear in T:** **every old-extent bit and every tree-block bit is CLEAR** in that image.
   - **Missing group:** a covered group with no image in T means the deletion could not have completed in T for that group → **BLOCK** ("completion not provable"), never "assumed clean".
   - **Old bit still set:** an old bit SET in a T image → **BLOCK** (not freed, or re-allocated within T). The checker reports which extents and how many blocks.
5. **Corroboration (reported, not a pass condition until the source is read):** whether T's revoke block lists the 28 freed tree blocks (P1 `revokedBy`), and whether T's group-descriptor images show free counts that grew accordingly.
6. **After T (cross-commit reuse; r2's existing per-tid logic):** for every later verified bitmap image of a covered group (≤ the newest proven tid 17669), the old bits stay CLEAR. Any SET → **BLOCK** with the tid and extent.
   - **The final state** is the current on-disk bitmap (root 1657: all free; checked separately).
7. **Output:** `model: "coalesced"`, `lastLiveTid` P, `deletionCompletionTid` = `slotReuseTid` = T, the per-group T-image tids, and **`deletionStartTid: null` with reason "coalesced: no intermediate row committed"**. **No fabricated intermediate row.**

**Classic model:** the explicit unlinked → freed → reused sequence stays as in r2; both models are reported by name.

## Fixtures (synthetic journals built with the r2 fixture machinery; the r3 owner adds them)
**Positive:**
- **PC1 coalesced:** P live, T new generation with the bit set, all covered groups imaged in T with the old bits clear, later images clear → `model coalesced`, no blocker.
- **PC2 classic:** the unchanged r2 explicit sequence still passes.
- **PC3 coalesced with a group imaged again later** (another file allocating elsewhere in that group), the old bits still clear → passes.

**Negative (each must BLOCK):**
- **NC1** a covered group has no bitmap image in T;
- **NC2** an old bit SET in a T image (intra-T reallocation);
- **NC3** T ≠ P + 1, or a gap / unproven tid between them;
- **NC4** an old bit SET in a later image (cross-commit reuse);
- **NC5** the T slot image's inode checksum is invalid;
- **NC6** the old generation reappears after T;
- **NC7** the inode bit is clear at T while the new generation is live;
- **NC8** a tree-block bit is set in T;
- **NC9** the T commit block is missing or uncommitted (intact false).

## Feasibility from local data (no new reads by me)
- **The images exist:** they lie in transaction 17170's 8,918 tagged images inside the local 1 GiB journal copy. Checking them needs the bitmap block numbers of the 8,748 covered groups (fs-stats) as **targets**, plus verified reads of those images. That is the same mechanism r2 already uses; r2 read only 2,501 images because it blocked first.
- **Cost:** about 8,748 × 4 KiB ≈ 34 MiB of image reads in T, plus every later image of the same blocks (bounded by the window). That is small.
- **No new root job is prepared here** because root 37's r3 owns the checker; a parallel implementation would diverge. If root wants a separate probe, it is r2's `run_batches` with targets = those bitmap blocks and tids {17170..17669}, offline, 512 MiB.

## Limitations (unchanged by this rule)
- **Inside a transaction:** an allocate + free inside T or any later single transaction leaves no bitmap trace. A coalesced T makes this **worse**: 8,918 blocks changed in one commit, and other files may have allocated and freed old blocks within T. **Only full MDBX structure, trie, plain/hashed state and canonical root validation (1661/1667/1678) can show the data intact.**
- **Below the bitmap:** discard/TRIM and image-layer (qcow2) writes are invisible to bitmaps.
- **Authenticity:** JBD2/ext4 checksums prove those committed bytes, not data authenticity.

**Not claimed:** intact data, recoverability, or a pass. This only removes a false blocker if the rule above holds on the actual images.
