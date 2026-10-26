# Deleted Base `mdbx.dat`: what 1546 actually searched, and a bounded read-only next step via the stale JBD2 journal (1615). Source-only assessment; NOTHING read from USB

## Audit: did recovery 1546 search the journal's content? **No.**
**Evidence read:**
- `jobs/root-base-journal-metadata-1546.py` (sha256 `f9376c45…`);
- `logs/base-journal-metadata-1546/*`;
- `logs/root-base-journal-metadata-1546.{out,rc}` (rc 0).

**What it ran** (`:32`): exactly three `debugfs -R` commands on the read-only `nbdfuse -r` / `qemu-nbd -r` mapping (`record.json`: `readonly: true`, `discard: ignore`, `diskUnchanged: true`):

| command | what it shows | result |
|---|---|---|
| `logdump -S` | the journal **superblock** only | JBD2, 64bit, `csum_v3` (crc32c), revoke; **1024 MiB = 262,144 blocks**; sequence `0x4507` = 17671; **start 0** (clean: no transaction pending replay) |
| `stat <8>` | the journal inode | 1,073,741,824 B; 8 contiguous extents of 32,768 blocks at fs blocks **378,044,416–378,306,559** (ETB 378,044,415); crtime 2026-10-25 04:05 |
| `ls -d -l /data/db` | live + deleted entries of the directory block | inode **1949710** holds only `.` and `..`, **no deleted entry**, so the `mdbx.dat` name/inode is not recoverable from the live directory block |

**No transaction, descriptor block, journaled block copy or old entry was dumped:** no `-a`, `-O`, `-b` or `-c`.
- **The correct statement:** the journal's *metadata* was read; its *contents* were not searched.
- **The `mdbx.dat` inode number is still unknown.**

## What the journal can and cannot give (local debugfs 1.47.4 man page, current logs, prior review `claude-deleted-state-journal-review.md`)
**debugfs tools (local man page, `logdump [-acsOS] [-b block] [-n num_trans] [-i filespec] [-f journal_file]`):**
- `-O` displays **old (checkpointed)** journal entries;
- `-b` gives all journal records referring to one fs block, and `-c` prints their data;
- `-f` reads a regular **file** containing journal data, i.e. a copy;
- `imap` gives the inode-table block of an inode.

**Not verified:** how `-O` walks a journal whose start is 0 (clean) after possibly several mounts. JBD2 restarts writing at the journal's first block on every mount, so the newest session's transactions overwrite the oldest **physical** positions, not the oldest sequences. An independent parser of the copy is therefore needed to inventory what actually survives.

**Facts relevant to plausibility** (from 1502/1546 logs and the prior review; not re-derived here):
- `mdbx.dat` was **1,138,166,333,440 B** (1.14 TB). Its extent tree has depth ≥ 1, so the in-inode root holds only index entries, and the full map is in leaf blocks.
- About 35 GB of other data was written after the deletion. ext4 may reuse freed blocks; whether it did is unknown.
- `mdbx_chk`, `extundelete` and `ext4magic` are not installed, and installs are not allowed. MDBX has no per-page data checksums, so validating a recovered DB is a weaker, root-decided standard (prior review Q2).

**What a journal copy plus a parse can plausibly yield:**
- **(a) The inode number:** older journaled copies of `/data/db`'s directory block, from before the unlink, with the `mdbx.dat` → inode entry. They exist only if a transaction touching that block survives in the log.
- **(b) The pre-deletion inode:** older copies of the inode-table block (via `imap`), with `i_size` = 1.14 TB, `links ≥ 1`, `dtime 0` and the extent **root/index** entries. The prior review notes that the block was journaled at finalize (≈14:51) and at deletion (≈16:00). Whether those images survive later sessions is unknown.
- **(c) Leaf extent blocks:** these were modified only when extents were appended during the original download. Their journaled images are therefore old and the **least** likely to survive.
  - The prior review's reading is that freed leaf blocks are *forgotten* + revoked, so their **home locations** may still hold pre-deletion extents unless reused.
  - I did not verify that against kernel source (not available locally). In particular, a truncate that restarts its journal handle may already have committed a zeroed leaf.
  - **This is decidable read-only:** with `metadata_csum`, each extent block carries a crc32c tail bound to the inode number and generation, so a home-location leaf can be **checked** as belonging to `mdbx.dat` and unmodified.

**So, can a 1 GiB journal copy to cryptroot plus parsing make recovery plausible?**
- **Partly, and only as a first gate.** It can establish (a) and probably (b), at a cost of 1 GiB read and written once.
- **A complete extent map for 1.14 TB will almost certainly not come from the journal alone.** It would come from checksum-valid home-location leaf blocks found through the recovered index, if they were neither zeroed nor reused.
- **Recovery becomes *plausible* only if all four hold:**
  1. a pre-deletion inode image exists;
  2. every index/leaf block named by it is checksum-valid for that inode (from home or journal);
  3. the reconstructed extents cover exactly `[0, i_size)`;
  4. no mapped data block is in use now or was allocated in any post-deletion journaled bitmap image.
- **None of these is known today.** I make no claim either way.

## Bounded read-only plan (for root; reuses the 1546 harness unchanged in mechanism)
Same pinned harness as 1546: all VM units inactive (assert), `nbdfuse -r` + `qemu-nbd -r -f qcow2`, `discard ignore`, before/after `stat` (`diskUnchanged`), `prlimit --fsize`, `timeout`, and `debugfs` opened read-only (no `-w`). **Nothing is written to the USB image.** Outputs go to a private 0700 dir on cryptroot `/`.

**J1. Copy the journal and inventory it** (one job; about 1 GiB read):
- **Copy:** `debugfs -R "dump <8> $OUT/journal-8.bin"` (`--fsize` raised to 1 GiB + 1 MiB for this command only). Check the dumped size is 1,073,741,824, then record its sha256.
- **Inventory**, with a NEW small offline parser: pinned, standard library only, unprivileged, run on the copy. It reads the copy only; it never touches the image and has no repair or write path. For every 4 KiB block it decodes the JBD2 header (magic `0xC03B3998`; type 1 descriptor / 2 commit / 5 revoke; sequence):
  - descriptor tags in `csum_v3` + 64bit form (16-byte tags; UUID after the first tag unless `SAME_UUID`; escape flag; `LAST_TAG`);
  - commit time (`h_commit_sec`);
  - revoke lists.
- **Output:** per transaction: sequence, journal position, commit time, tagged fs blocks. Also per fs block: every surviving image (sequence, time, position).
- **Bound:** 262,144 blocks, with a fixed output cap.
- **Tests:** unprivileged synthetic fixtures (hand-built descriptor/commit/revoke blocks, an escaped block, a wrapped log) before any use on the copy.

**J2. Targets (tiny reads; no data blocks):**
- `stat <1949710>` / `blocks <1949710>`, giving the directory block(s). Their journal images (from the J1 inventory) are decoded for live **and** gap dirents, giving the `mdbx.dat` inode X.
- `imap <X>`, giving the inode-table block; its images are decoded at offset X, keeping the newest image with `links ≥ 1`, `dtime 0`, `i_size` = 1,138,166,333,440 and extent magic `0xF30A`.
- For each index entry: `block_dump` of the **home** block, plus any journal images, with a crc32c check against the inode number and generation. Recurse to the leaves. Report the coverage of `[0, i_size)` and every gap.
- `testb` over every mapped extent (the current bitmap), plus every post-deletion bitmap image in the journal for those groups (catches "allocated then freed again").

**Stop rules (honest outcomes):**
- **No inode image:** report "journal cannot identify/locate it"; done (the re-download remains the path).
- **Coverage < 100% or any checksum failure:** "not recoverable from metadata"; done.
- **Any mapped block in use now or allocated after the deletion:** "overwritten"; done.
- **Only if every gate passes:** propose, as a separate review, a read-only extraction of exactly those extents to a NEW ≥ 1.14 TB file on cryptroot.
  - Reading 1.14 TB from USB takes hours at an unmeasured rate.
  - Then root decides on the weaker MDBX acceptance standard.

**Not in this plan:** a raw full-volume scan, carving, forensic tools, installs, any write or repair to the image, `fsck`, mounting read-write, `discard`, or reading data blocks before the gates pass.

## Effort and value (stated, not measured)
- **J1 + J2:** about 1 GiB from USB plus KBs of metadata; a new small parser (≈150-200 lines) with its own tests. They decide the question cheaply.
- **The "faster than re-download" question** stays open until J2 passes. Extraction plus validation is hours at minimum, and the result is weaker-trusted than a pinned-manifest re-download.

**Nothing was run for this report:** no image, journal or USB access.
