# journal-recovery-stage/r1: OFFLINE J1 JBD2 journal-copy inventory parser and fixtures (1624). FROZEN 2026-10-26 20:17Z, NOT RUN

**Stage:** `journal-recovery-stage/r1/`, **SHA256SUMS sha256 `342ca52586e22f61a9d63bb1d2e6ec84cb0b6e4f2adde016ba4293862ec3c5a8`** (files 0444)

| file | sha256 |
|---|---|
| `jbd2_inventory.py` (300 lines, stdlib only) | `7ef5a9a29f0bdfe0d40142bcbbbda367ae9ad9645c860902a361de412cbf8b6d` |
| `tests/test_jbd2_inventory.py` (9 tests) | `5ad8ed217ee847b5bd661926002463c757f7e9a6f4397dcbc015bca959914b89` |
| `jobs/tests.sh` | `fea6e9cae0db63733bb3e1eab803834d566cda9cc58ddbf4392a8d7216b7a9ab` |

- **Primary source used:** `/usr/src/linux/include/linux/jbd2.h`, sha256 `e52d521537037fc9fef6668a33f7558a934c75018cfad71eb45cbf7914e9645b`.
- **What I did:** `ast.parse` and sha256 only.
- **What I did not do:** no tests, builds, live actions, network, USB, `/mnt/usb` or RAID-chat mount access, and no image or journal read. I did not use other agents' `/tmp`.
- **One overbroad `find /` for documentation** (`-xdev`, so it could not cross into other mounts, including the RAID chat's read-only mount) was started by me and stopped with TaskStop after its 120 s foreground timeout. It printed nothing.

## Source basis (what was and was not derivable locally)
- **Local primary source is only `include/linux/jbd2.h`.** `/usr/src/linux/fs/jbd2/` holds only `Kconfig`; there is no kernel ext4/JBD2 documentation; e2fsprogs' `kernel-jbd.h` is not installed (`/usr/include/ext2fs` has no JBD2 definitions); and the debugfs 1.47.4 man page documents `logdump [-acsOS] [-b] [-n] [-i] [-f journal_file]` only.
- **From jbd2.h** (used): `journal_header_t`; block types 1-5; `journal_superblock_t` offsets; incompat bits; `struct commit_header` (`h_commit_sec` @0x30, `h_commit_nsec` @0x38); `journal_block_tag3_t` (`blocknr`, `flags`, `blocknr_high`, `checksum`); tag flags (ESCAPE 1, SAME_UUID 2, DELETED 4, LAST_TAG 8); `jbd2_journal_block_tail`; the revoke header with `r_count`.
- **INFERRED, not stated in jbd2.h** (listed in every output's `layoutBasis`):
  - a 16-byte UUID after each tag without SAME_UUID;
  - the 4-byte block tail at the end of descriptor and revoke blocks;
  - each tag owns the next log block (wrapping to `s_first`), and an escaped image had its magic zeroed;
  - be64 revoke records;
  - the log area is `[s_first, s_maxlen)`.
- **NOT DERIVABLE:** the JBD2 checksum algorithm (seed, coverage, field zeroing). **No checksum is verified.**
  - Raw checksum fields are reported only.
  - Every output is labelled **`"authentication": "UNAUTHENTICATED CANDIDATES"`**, and `"acceptance"` always starts with `refused:`.
  - Candidate bytes are never authority. MDBX's acceptance standard is not reduced.

## Parser contract (`jbd2_inventory.py`)
```
python3 -I -B jbd2_inventory.py --journal /ABS/journal-8.bin --out /ABS/inventory.json [--targets /ABS/targets.json] [--fixture]
  targets.json = {"blocks": [<= 100000 non-negative 64-bit fs block numbers]}     exit 0 written | 2 usage | 3 refused (nothing written)
```
**Inputs:**
- **Opening:** absolute path, `O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC`. `fstat` must show a regular file, owner root or the caller, not group/world-writable.
- **Size:** exactly **1,073,741,824 B** (262,144 blocks), unless `--fixture` (2..262,144 whole 4 KiB blocks).
- **Targets:** ≤ 4 MiB of JSON with the exact shape above.

**Format gate:** anything else is **refused** (unsupported):
- superblock v2 with magic `0xC03B3998`;
- blocksize 4096;
- `maxlen` = the file's blocks;
- `1 ≤ first < maxlen`, `start` 0 or in the log;
- compat and ro_compat both 0 (so checksum v1 is refused);
- incompat ⊆ {revoke, 64bit, csum_v3} **with** 64bit + csum_v3 (csum_v2, async_commit and fast_commit are refused);
- checksum type 4 (crc32c).

These match the target journal per 1546's `logdump -S`.

**Scan:** one sequential bounded 4 KiB `pread` per block over the log area.
- **Descriptor:** tags are parsed until LAST_TAG. These make it undecodable, and it maps no images:
  - tags overflowing into the tail;
  - unknown flag bits;
  - a first tag with SAME_UUID;
  - a UUID overlapping the tail.
- **Commit:** sequence, `commitSec`/`commitNsec` and the raw checksum fields.
- **Revoke:** an invalid `r_count` (< 16, > blocksize − 4, or not 16 + 8·k) makes it undecodable.
- **Other block types inside the log:** recorded as `anomalies`.

**Images:**
- each tag's image position (wrapping) and byte offset;
- `escaped`/`deletedFlag` are reported, not interpreted;
- an image position that holds a JBD2 metadata header is marked `imageIsMetadataHeader` (overwritten by a later session).

**Transactions:**
- grouped by sequence: descriptors, tags, revoke blocks, commit blocks and time;
- `committed`;
- `intact` = committed, exactly one commit, and no conflicting image.

**Output (one new file):**
- **Content:** `summary`, `superblock`, `clean` / `staleOnly` (start 0), `targets.candidates[block]` and `targets.revokedBy[block]`, plus `undecodable`, `anomalies` and `transactions`.
- **Each candidate:** `{sequence, imageJournalBlock, imageByteOffset, descriptor, escaped, deletedFlag, imageIsMetadataHeader, committed, commitSec, txIntact, checksum: "unchecked"}`.
- **Bounds:** ≤ **16 MiB** JSON. If larger, the transaction list is halved until it fits, with an explicit `truncated: {listed, total}`. If it still does not fit, it is refused.
- **Writing:** `O_CREAT|O_EXCL|O_NOFOLLOW` 0600; never overwritten.
- **Never done:** it reads no image bytes beyond 4 KiB headers/descriptors, and it has **no** extraction, replay, repair or DB path.

**What it tells root about the stale journal:**
- the sequence range and commit-time range of every surviving transaction;
- whether the pre-deletion images of chosen metadata blocks survive (the `/data/db` directory block, the `mdbx.dat` inode-table block via `imap`, extent index/leaf blocks), with their exact offsets in the copy;
- whether they were later revoked.

**What it cannot tell:** whether any image is authentic.

## Tests (9, synthetic fixtures; prepared, NOT run)
These show that the parser is strict, bounded and consistent with its documented layout. They **cannot** prove that the layout matches a real kernel journal.
1. **Transactions, targets, commit times, revokes:** includes a 64-bit block number via `t_blocknr_high`; the `UNAUTHENTICATED` label and `layoutBasis` are present.
2. **Wrap:** a descriptor at block 6 of 8 maps its images to 7, 1, 2.
3. **ESCAPE and DELETED** flags are reported.
4. **Truncated, stale and uncommitted:**
   - an image position overwritten by another sequence's commit means conflict and not intact;
   - an uncommitted descriptor is reported;
   - a partial-block file is refused;
   - a non-1 GiB file is refused in production mode;
   - **a sparse 1 GiB copy with a valid superblock is accepted** in production mode.
5. **Undecodable:** tags overflowing into the tail, unknown flags, a first tag with SAME_UUID, and revoke `r_count` 5000 and 17 all map nothing.
6. **Bad checksum:** changing the tag, tail and commit checksums changes nothing but raw fields; everything stays `unchecked` / `UNAUTHENTICATED`.
7. **Unsupported formats refused:**
   - blocksize 1024, csum_v2, async_commit, fast_commit, no 64bit;
   - compat checksum v1, superblock v1, bad magic;
   - checksum type 1, `first` 0, `start` outside the log, `maxlen` mismatch.
8. **Safety:**
   - a symlink is refused, and a FIFO is refused without blocking (alarm guard);
   - world-writable files and relative paths are refused;
   - the output is 0600 and never overwritten;
   - a fixture without `--fixture` is refused;
   - malformed targets are refused;
   - nothing else is written.
9. **Output bound:** truncation is explicit; a tiny cap refuses.

**Root (main queue, 512):**
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh journal-recovery-r1-tests 512 unshare -Urn bash journal-recovery-stage/r1/jobs/tests.sh
```
- **PASS** = `## verified SHA256SUMS 342ca525…`, `Ran 9 tests`, `OK`, no skips, `## journal-recovery-r1-tests rc=0`.
- **The run:** offline, in a fresh temp dir, with `-W error::ResourceWarning`. Test 4 writes one sparse 1 GiB temp file (no real data) inside it.

## Before any use on a real copy (not authorized here; root decides after the user's RAID-chat authorization)
1. **Get the copy.** It must come from the **original** filesystem image. A copy of allocated files only (what the RAID chat is doing) would not contain the journal inode's content as a file, and could omit exactly the deleted and freed blocks.
   - One way, which I have not tested: a separately reviewed root job using the 1546 read-only harness, `debugfs -R "dump <8> $OUT/journal-8.bin"`, with an fsize cap of 1 GiB + 1 MiB, then sha256 recorded.
   - The real source path and mount are the RAID chat's, so the route must be agreed with them through the user.
2. **Run the parser** on the copy, offline, unprivileged.
3. **Cross-check with an independent decoder:** debugfs `logdump -O -a -f journal-8.bin` (local tool). Compare the sequences, descriptor positions and tag block numbers. **Any disagreement invalidates the inferred layout.**
4. **Only then** pick targets (the `/data/db` directory block, `imap` of the found inode, its extent blocks) for J2.
   - Every image remains an unauthenticated candidate.
   - Any recovery acceptance needs an independently verified checksum (from real kernel/e2fsprogs source) and the MDBX standard that root sets, which is not reduced by this work.
