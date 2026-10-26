# Deleted Base `mdbx.dat`: is recovery faster than the re-download? (independent read-only evidence review)

## Scope
**Inputs read (this review):**
- `logs/claude-deleted-base-recovery.md` (my earlier corrected assessment);
- `logs/base-deleted-metadata-1502/*`;
- `jobs/root-base-deleted-metadata-1502.py`;
- the pinned guest fstab `logs/guest-trust-1492/fstab`;
- the pinned reth 7134be3 sources:
  - `download/archive.rs` (`RunAttempt → cleanup_outputs()`, around line 151);
  - `download/verify.rs:76-80` (`cleanup` → `fs::remove_file`);
  - `db/repair_trie.rs`, `db/mod.rs:183-186`;
- the host's debugfs 1.47.4 man page (documentation only).

**Not done:** I read no image, raw device or journal. I ran no mount, nbd, SSH, package install, test or process control. Every image action below is a recommendation for **root**.

**Labels:** **V** = verified in the files above. **I** = inference. **U** = unproven feasibility (could go either way; only a check decides).

## 1. Verified facts (V)
- **V1 (1502 run):** `debugfs` ran on a read-only `nbdfuse`/`qemu-nbd -r` mapping of `base-origin.qcow2`, with all VM units inactive.
  - `record.json`: `readonly: true`, `diskUnchanged: true`, `unmountRc: 0`.
  - `stats`, `ls -l /` and `lsdel` all returned rc 0; `stats` took 14.4 s.
- **V2 (superblock, `superblock.out`):**
  - **Features:** `has_journal`, `extent`, `64bit`, `flex_bg` (16), `metadata_csum`; journal inode 8; `Journal backup: inode blocks`; state `clean`.
  - **Size:** 4 KiB blocks; block count 976,562,500 (4.0 TB); free 933,762,848. Used is therefore 42,799,652 blocks, about **175.3 GB** including metadata.
  - **History:** lifetime writes 2044 GB; last write `Mon Oct 26 09:00:38 2026`.
  - **Missing:** `debugfs stats` does **not** print the journal superblock, so the **journal size, sequence and start are unknown**.
- **V3 (`lsdel`):** `0 deleted inodes found.`
- **V4 (filesystem root):** `data`, `tmp`, `retention-backup`, `snapshot-complete` and `lost+found` are present.
- **V5 (guest fstab, pin 1492):** the base-holder filesystem (UUID `11c6bbac…`, the same as the superblock) is mounted with `noauto,noatime,errors=remount-ro`. There is **no `discard`**; only the guest root filesystem has `discard`.
- **V6 (reth 7134be3, deletion):** `cleanup_outputs()` → `verify.rs::cleanup` is a plain `fs::remove_file` per declared output. reth does no overwriting, zeroing or punching. The deletion was an ordinary ext4 unlink of `mdbx.dat` (and `lock`, `mdbx.lck`, `database.version`).
- **V7 (reth 7134be3, `db repair-trie`):**
  - `--dry-run` opens the DB `AccessRights::RO` and checks the trie tables against the hashed state (`Verifier`). It does **not** compare any root with the canonical header.
  - The header comparison (`verify_repaired_state_root`, `header_by_number(tip).state_root()`) runs **only** in the RW repair path, and only when inconsistencies were repaired.
- **V8 (host tools):**
  - `debugfs`, `dumpe2fs` and `e2image` 1.47.4 are present.
  - debugfs 1.47.4 documents:
    - `logdump -S` (journal superblock), `-O` (old, checkpointed entries), `-b <block>` (records for one block) and `-c` (dump contents);
    - `ls -d` (deleted directory entries), `imap`, `inode_dump`, `block_dump`, `testb` and `icheck`.
  - `extundelete`, `ext4magic` and `mdbx_chk` are **not** installed, and installs are not allowed.

**From my earlier reviews (sources were re-checked as cited there; not re-measured now):**
- `db/` was emptied at 15:15:39 UTC.
- `mdbx.dat` was 1,138,166,333,440 B.
- The manifest BLAKE3 `8de35ff5…` is for the **pre-finalize** snapshot file.
- reth's finalize (`mod.rs:647-674`) then opened the DB read-write and wrote checkpoints.
- The `state.tar.zst.part` has about 4.3 GB allocated.

## 2. Inferences (I)
- **I1 (time zone):** debugfs printed times in host-local time, which looks like UTC−7.
  - **Evidence:** `data` 07:51 matches the 14:51 UTC finalize, and `retention-backup` 07:58 matches the 14:58 UTC retention start.
  - **So:** the last write at 09:00:38 is about 16:00:38 UTC, matching "VM off since 16:00". The filesystem was written for **about 45 min after the deletion** (15:15:39 → about 16:00).
- **I2 (writes after the deletion):** at most about 35 GB of new data was allocated after the deletion.
  - **Arithmetic:** 175.3 GB used − 136.1 GB `static_files` − about 2.4 GB overhead − about 1 GiB journal, which leaves at most about 35 GB for the 4.3 GB state `.part`, the history `.part`s and the other files.
  - **Unknown:** whether any of it landed in blocks freed from `mdbx.dat`. ext4's allocator reuses freed blocks freely.
- **I3 (`lsdel` = 0 proves nothing for ext4 extent files):**
  - When an extent-mapped inode is truncated or deleted, `i_blocks` is set to 0 and the extent header `eh_entries` to 0, so `lsdel` has nothing to list.
  - That is **expected** and says nothing about the blocks or the journal. (This is ext4 kernel behaviour; it has not been verified on this image.)
- **I4 (no discard after the deletion):** the data is not known to have been discarded or unmapped.
  - There is no `discard` mount option (V5).
  - Ubuntu's weekly `fstrim.timer` fires Monday about 00:00 (+ up to 100 min). Oct 26 is a Monday, so it ran **before** the 15:15 deletion.
  - QEMU's default is `discard=ignore`.
  - **None of this is verified for this VM:** the host VM disk options and the guest timer history were not read.
- **I5 (journal remnants):** ext4 deletion journals the **post-deletion** inode and bitmaps. Pre-deletion copies survive only as **older journal transactions not yet overwritten** in the circular log.
  - **Inode-table block:** the block holding the `mdbx.dat` inode was journaled at finalize (14:51, mtime/size change) and again at deletion. 14:51 → 16:00 is about 70 min of metadata traffic, and a large-filesystem default journal is about 1 GiB (size **unknown**, V2). A pre-deletion copy is **plausible, not shown**.
  - **Leaf blocks:** a 1.14 TB file needs an extent tree of depth ≥ 1, so the in-inode root holds only index entries and the real extent map is in leaf/index blocks.
    - On deletion, freed leaf blocks are dropped from the transaction ("forget" plus a revoke). Their **home-location copies may still hold the pre-deletion extents** unless the blocks were reused.
    - Truncate-to-zero removes index entries right-to-left. The raw index bytes may then remain in `i_block` even though `eh_entries` = 0.
  - Both points are kernel-behaviour inferences, **not verified on this image**.

## 3. Unproven feasibility (U), as answers to the two questions
### Q1: Can ext4 journal or metadata inspection cheaply reconstruct the extent map with available tools?
- **U1: Possibly; this is not shown either way.** With `debugfs` 1.47.4 alone, root can read the following cheaply and read-only:
  - the journal superblock;
  - the deleted directory entry (to get the inode number);
  - the raw inode;
  - every journaled copy of its inode-table block (`logdump -O -b … -c`);
  - the leaf/index blocks the copies point to.

  That reads the journal (likely ≤ about 1 GiB) plus a few KB of blocks. It does **not** scan terabytes.
- **U2: An extent map is not the data.** Even a complete map does not prove the 277,872,640 data blocks are intact.
  - Any block reused after the deletion is overwritten.
  - `testb` shows only the **current** bitmap. A block that was allocated and then freed again in those 45 min would look free but be overwritten.
- **U3: Extraction needs a new tool and a new 1.14 TB destination.**
  - `debugfs` cannot `dump` a file whose extents are zeroed. A small read-only extent-to-file copier would be **new, unbuilt code**.
  - It needs ≥ 1.14 TB free **outside** the image, and it would compete with the ongoing download for USB/host I/O.
  - The copy time is 1.14 TB ÷ an unmeasured USB/qcow2 read rate. For example, 100 MB/s ≈ 3.2 h and 200 MB/s ≈ 1.6 h; these rates are hypothetical.

### Q2: Can the finalized MDBX be validated against the chain rather than stale snapshot hashes?
- **The snapshot hash cannot be used.** The manifest BLAKE3 is for the pre-finalize file, and finalize rewrote pages, so even a perfect recovery **cannot** match it.
- **Coverage of a chain-anchored check would be partial (U4):**
  - **Internal trie consistency:** `reth db repair-trie --dry-run` (RO; V7) checks the trie tables against the hashed state. It **does not** compare the header state root.
  - **Header comparison:** this needs either a small new read-only tool, or the RW repair path run **on a copy** (which compares only if it repaired something).
    - The read-only tool would compute `StateRoot::from_tx(tx).root()` and compare it with `header_by_number(tip).state_root()` from the surviving static files. Those files must themselves be anchored to Base/L1.
  - **Not covered by a state root:**
    - plain state (`PlainAccountState`/`PlainStorageState`, which execution and RPC actually read) versus the hashed state;
    - bytecodes (keccak(code) = key is cheap to check, but needs a tool);
    - history indices, changesets, block indices and checkpoints.
  - **No structural checker:** `mdbx_chk` is not installed, and MDBX has no per-page data checksums.
  - **Cost:** a full Base state-root walk is **unmeasured** and likely hours (I).
- **Trust conclusion:** a recovered DB would rest on a **new, weaker acceptance standard** than the pinned manifest BLAKE3. It is root's decision whether that is acceptable. It must **not** be trusted because "it was ours before the deletion".

## 4. Cost comparison (I)
- **Re-download:** 761 − 89 = **672 GB remain**. At the earlier samples of about 16–19 MB/s (the current rate is not measured by me) that is about 10–12 h.
  - Then extraction and **BLAKE3 against the pinned manifest**, which is a strong and complete check.
  - It needs no new code and its trust is unchanged. It must continue **regardless**, as the fallback.
- **Recovery best case** (every U above resolves favourably):
  - minutes for the check below;
  - plus overlap analysis;
  - plus new copier code;
  - plus a 1.14 TB copy (hours, unmeasured);
  - plus partial validation, which also needs new code (hours, unmeasured).
- **Comparison:** this plausibly takes **similar** time to the download's remainder, at **lower trust**. The download's lead grows every hour. A faster path is **not demonstrated**. Only a positive first check would justify spending more effort.

## 5. Recommendation: one bounded, read-only check (root-run; VM stays off; the download continues untouched)
**Gate (no image access):** confirm the base disk's QEMU/libvirt `discard`/`detect-zeroes` settings from the host VM definition.
- If `discard=unmap` **and** there is any evidence that the guest issued discards after 15:15 UTC, stop: the freed clusters may read as zeros.

**C1:** use the **same harness as 1502**:
- the same pinned inspector, all-VM-units-inactive asserts, `nbdfuse -r` + `qemu-nbd -r`, and before/after `stat` with `diskUnchanged`;
- each command with `timeout 300` and an output cap of about 64 MB.

Commands, all `debugfs -R` against the read-only mapping:
1. `logdump -S`: journal size, sequence and start. The journal is expected to be clean after unmount.
2. `ls -d -l /data/db`: the deleted entry `mdbx.dat` and its inode number N, if the directory-entry remnant survives.
3. `imap <N>` then `inode_dump <N>`: the inode-table block B, and the raw `i_block` (extent magic `0xF30A`, `eh_depth`, `eh_entries`, any leftover index entries).
4. `logdump -O -b <B> -c`: every journaled copy of block B. Look for a pre-15:15 copy with `eh_entries > 0` and depth ≥ 1.

**C1 cost and risks:**
- **Cost:** about 1 to a few minutes. It reads the journal (≤ about 1 GiB, assumed) plus about 64 KB.
- **Risk:** the same as 1502, which was proven `diskUnchanged`. The main risk is USB I/O contention with the download, if they share the device (root knows).
- **Output:** a few MB of logs, written outside the image.

**C1 decision rule:**
- **Stop (no justified faster path; continue the download only)** if any of the following holds:
  - there is no deleted entry or inode number;
  - there is no pre-deletion inode copy and no raw index remnants;
  - the journal is too small or was overwritten.
- **Only if** an index-level map is recovered: a second bounded check, C2.
  - `block_dump` the referenced index/leaf blocks (each ≤ 4 KiB; expect `0xF30A` with extents summing to 277,872,640 blocks).
  - `testb` the extent ranges against the current bitmap.
  - Optionally, host-side `qemu-img map` of only those ranges, to check that the qcow2 clusters are still allocated.
  - Root then decides whether a recovery copy plus partial chain validation is worth building. Even a clean C2 does not prove data integrity (U2).

## 6. What I am NOT claiming
- I am not claiming that recovery is impossible.
- I am not claiming that the journal was cycled.
- I am not claiming that a recovered file would be valid.

What the evidence does support:
1. **Verified:** the pre-finalize manifest hash cannot validate a recovered finalized file.
2. **Verified:** pinned reth has no existing read-only command that compares the full state root with the header.
3. **Inference from ext4 behaviour (I3), not verified on this image:** `lsdel` = 0 is uninformative for ext4 extent files.

Everything else needs C1/C2 or measurement.
