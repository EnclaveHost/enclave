# Review 1631: JBD2 checksum semantics, r1 inventory review, and a NEW bounded offline verifier (source only; NOT a recovery proof)

**Stage:** `journal-recovery-verifier-stage/r1/`, **SHA256SUMS sha256 `1a7bcc31444776ddb4cf54b3fb2eca0c8d8f61b2e6b467b98f86752022cee46a`**. Files are 0444:

| file | sha256 |
|---|---|
| `jbd2_verify.py` | `d3cfa34e…` |
| `tests/test_jbd2_verify.py` (9 tests) | `7fc11e00…` |
| `tests/real-journal-8-superblock-1024.hex` | `dad7f3d6…` |
| `jobs/tests.sh` | `15076b7f…` |
| `jobs/root-verify.sh` | `aa9dc27c…` |
| `targets/base-db-dir-1626.json` | `5f3a13a0…` |
| `README.md` | `42ac71cb…` |

**Untouched:** r1 (`journal-recovery-stage/r1`, `342ca525…`, verified), the original image and USB. No peer messages.

**What I ran:**
- `ast.parse` and `bash -n`;
- **network:** only the four upstream source files below plus upstream `jbd2.h`, fetched by HTTPS from raw.githubusercontent.com;
- **two reads of block 0 only** (4 KiB, then 1 KiB) of the copy `logs/base-journal-copy-1626/journal-8.bin` (sha256 `d95d81fc…`), to check the superblock checksum and save it as a vector. **No scan** of the copy.

## Primary sources (pinned in the module and in `upstream/`; fetched 2026-10-26T20:19:15Z from `torvalds/linux` master)
| file | sha256 |
|---|---|
| `fs/jbd2/recovery.c` | `ccb2b057…cd45` |
| `fs/jbd2/commit.c` | `f3915db6…b5f5` |
| `fs/jbd2/journal.c` | `6579ac57…f31b` |
| `fs/jbd2/revoke.c` | `60a0287b…1ae2` |
| `include/linux/jbd2.h` | `f9970176…f3f2` |

The local `/usr/src/linux/include/linux/jbd2.h` (`e52d5215…`) has the same on-disk structs; it differs only in in-memory structs.

**Exact semantics (with source):**
- **`jbd2_chksum`** (`jbd2.h`) = `crc32c(crc, data, len)`: raw Castagnoli, reflected, **no** pre/post inversion.
- **Seed:** `j_csum_seed = jbd2_chksum(~0, sb->s_uuid, 16)` (`journal.c`).
- **Superblock:** `s_checksum = crc32c(~0, sizeof(journal_superblock_t) = 1024 bytes, with s_checksum zeroed)` (`journal.c jbd2_superblock_csum`).
- **Descriptor and revoke:** `t_checksum` (last 4 bytes) = `crc32c(seed, block with the tail zeroed)` (`recovery.c jbd2_descriptor_block_csum_verify`, also used for REVOKE).
- **Commit:**
  - `h_chksum[0]` (@0x10) = `crc32c(seed, block with h_chksum[0] zeroed)`;
  - or the **partial** form: `sizeof(struct commit_header)` = 64 bytes copied into a zeroed block (`recovery.c *_commit_block_csum_verify[_partial]`);
  - `h_commit_sec` is a be64 @0x30 and `h_commit_nsec` a be32 @0x38.
- **Tag (v3):**
  - **The checksum:** `crc32c(crc32c(seed, be32(sequence)), logged block)` over the **escaped** bytes as written. `commit.c` sums `wbuf` (the escaped copy) and `recovery.c` verifies before un-escaping. Replay then restores the magic if `ESCAPE`.
  - **Layout:** `tag_bytes` = 16 (tag3). Flags are read as the **low 16 bits** (be16 at +6). A 16-byte UUID follows unless `SAME_UUID`. Parsing stops at `LAST_TAG` or when `off + 16 > blocksize − 4` (`count_tags`). `blocknr = be32 | be32_high << 32` (64bit).
- **Revoke:**
  - `r_count` = bytes used including the 16-byte header, ≤ blocksize − 4; be64 records (`scan_revoke_records`);
  - a block is revoked for tags of sequence ≤ the revoke's sequence (`revoke.c jbd2_journal_test_revoke`: not revoked only when `tid_gt(tag_seq, revoke_seq)`).
- **Kernel recovery acceptance:** it walks from `s_start`/`s_sequence` forward. A bad commit checksum with a commit time earlier than the previous commit is treated as stale and the scan ends. **A clean journal (`s_start` = 0) is never replayed**, so every surviving transaction in this copy is old and checkpointed. Recovery semantics alone cannot "accept" any of them.

## Real-data check (block 0 only)
- **Superblock:** magic `c03b3998`, type 4 (v2), blocksize 4096, `maxlen` 262144, `first` 1, **`s_sequence` 17671, `s_start` 0 (clean)**, incompat `0x13` (REVOKE|64BIT|CSUM_V3), compat/ro 0, `checksum_type` 4.
- **UUID:** `11c6bbac-f823-4052-a87a-066eed6ad590`, the filesystem UUID.
- **Checksum:** stored `s_checksum` `0x8a0d7489` equals `crc32c(~0, sb[0:1024] zeroed)`, computed **identically** by the pure table and by libext2fs `ext2fs_crc32c_le` (`/usr/lib/libext2fs.so.2`).
- **Seed:** `0x5b64088c`.
- **What this confirms:** the CRC variant and the zeroing/coverage rule on kernel-written data. It does **not** yet verify any descriptor, tag or commit of this copy; that is root's run.

## Independent review of r1 (`jbd2_inventory.py` `7ef5a9a2…`, unchanged)
**Correct per primary source:**
- the field offsets (superblock, commit times, tag3, revoke `r_count` and be64 records);
- the UUID-after-tag rule;
- the 4-byte tail;
- the log wrap `[s_first, s_maxlen)`.

r1 is more conservative than the kernel in safe ways:
- it refuses unknown flag bits in the full be32, where the kernel ignores the high 16 bits;
- it refuses a first tag with `SAME_UUID`;
- it requires 8-byte alignment of `r_count`.

**Flaws (no authentication; r1 states this):**
1. **"intact" is grouping-based, not structural.** Images are grouped by sequence, and the only "conflict" detected is an image slot now holding a **JBD2 header**.
   - **What it misses:** an image slot overwritten by a **later transaction's plain data block** (no header) is invisible to r1. A transaction can then be labelled `intact` with a stale or foreign image.
   - **The fix in the verifier:** the per-tag checksum binds `(seed, sequence, content)` (test `image_overwritten_by_later_data_is_not_proven`).
2. **Commit placement is not required to follow the transaction's blocks.** A commit of sequence S anywhere counts. The kernel requires the contiguous order descriptor → images → (revoke) → commit.
3. **No superblock checksum check.** The seed and UUID are taken on trust.
4. **The "candidates" are never current state:** r1's `targets.candidates` ordering by sequence does not establish the latest version. Later transactions may be overwritten (see the verifier's `newerOrUnprovenReferenceSequences`).

## New verifier (`jbd2_verify.py`)
**Contract:**
```
python3 -I -B jbd2_verify.py --journal ABS --targets ABS --out ABS(new) [--fixture --crc pure]
  targets = {"blocks": [1..4096 fs blocks], "journalBlocks"?: [<= 4096 log positions]}     exit 0 written | 3 refused
```
1. **Gate:**
   - v2 superblock, 4096 blocksize, `maxlen` = the copy's blocks;
   - only revoke + 64bit + csum_v3 with crc32c;
   - **the superblock checksum must verify**, otherwise refused (nothing can be authenticated).
2. **Header index:** 12 bytes per block, held in compact `array`s.
3. **Unverified references:** every descriptor/revoke that names a target fs block, or maps one of the given `journalBlocks`, with its tail-checksum validity.
4. **Proof:** each commit block of sequence S is walked from up to 4 of S's own descriptor/revoke blocks, farthest first.
   - **The walk must be contiguous:** every block is a JBD2 block of sequence S, each descriptor/revoke tail verifies, each image's tag checksum verifies, and it reaches exactly that commit, whose checksum verifies (full or partial).
   - **Only then** are its target images "proven", with fs block, sequence, commit time, journal position/offset, `escaped`, `contentSha256` of the **restored** content, `partialCommit` and `walkFromEarliestBlock`.
5. **Per target:**
   - `latestProvenUnrevokedSequence`;
   - `revokedByProvenSequence` per image;
   - `newerOrUnprovenReferenceSequences`, plus `newerOrUnprovenComplete`, which is false if an index cap or the read budget was hit;
   - status `PROVEN LOGGED CONTENT (authentic, committed; NOT current-state proof)` or `NO PROVEN UNREVOKED IMAGE`.
   - Top level: `acceptance: NOT A RECOVERY ACCEPTANCE…`.
6. **`journalBlocks`:** for the namescan positions, `provenAs` (the fs block and transaction a **proven** walk assigns to that slot) and `unverifiedMappings` (what any descriptor claims, with its checksum validity).

**Bounds:**
- **Memory:** the header index is ≤ 262,144 × 9 bytes; one 4 KiB block is held at a time; there are no per-tag lists beyond targets; the reference/revoke index is capped at 200,000 entries **as they are added** (flagged when exceeded).
- **Reads:** walk reads are ≤ 4 × the log length (a flagged, typed "budget exhausted").
- **Output:** listed entries (references, images, transactions, failures, journal-block mappings) share a 12 MiB budget checked **at append time**; totals are always counted. The final JSON must be ≤ 16 MiB and is written new, 0600, `O_EXCL|O_NOFOLLOW`.
- **Run it in the 256 MiB lane.**

**CRC:** production refuses to run without libext2fs `ext2fs_crc32c_le`. The library's path and sha256 are recorded. It is self-tested against the check vector (`crc32c(~0,"123456789")` = `0x1CF96D7C`) and against the reference table on probe data.

**Tests (9, prepared, NOT run):**
- **Non-circular:**
  - the check vector plus libext2fs agreement;
  - the **real kernel superblock** vector: checksum `0x8a0d7489` and seed `0x5b64088c` with both implementations.
- **Fixture walks**, built with the reference table, so they test walk logic, not CRC conformance:
  - proven images with escape restore, wrap, the partial commit, a 64-bit block number, the latest sequence and `journalBlocks` mapping;
  - **an image overwritten by later data is not proven** (r1 flaw 1);
  - descriptor, commit or image corruption, a missing commit, and a foreign transaction inside all prove nothing;
  - revoke precedence (≥) and newer unproven references.
- **Refusals:**
  - a superblock checksum mismatch and unsupported features;
  - symlink, FIFO (non-blocking) and relative paths;
  - malformed targets and out-of-log `journalBlocks`;
  - an existing output is never overwritten.
- **Bounds:** the append-time listing budget and an explicit read-budget exhaustion.

## Root commands
1. **Tests** (offline). PASS only with `Ran 9 tests`, OK and no skips:
   ```
   bash jobs/q-exit-status.sh jrv-r1-tests 256 unshare -Urn bash journal-recovery-verifier-stage/r1/jobs/tests.sh
   ```
2. **Actual verification** (read-only). It checks the copy's sha256 `d95d81fc…` before and after, and writes a new `runs/verify-*/result.json`:
   ```
   bash jobs/q-exit-status.sh jrv-r1-verify 256 unshare -Urn bash journal-recovery-verifier-stage/r1/jobs/root-verify.sh
   ```
   - **Default targets:** fs block **499122346** (the current `/data/db` directory block) and journal positions **88134, 109966, 117979, 118419** (the namescan hits with old entries for inode 1950053).
   - **Other targets:** add them with an absolute targets JSON, e.g. the `imap` inode-table block of the candidate inode, or any extent blocks.

## What the result can and cannot mean
- **The namescan hits:** a hit at journal position X shows old directory-entry bytes in that slot. Only `journalBlocks[X].provenAs` shows whether X is an **authentic, committed** image of block 499122346 (or of another fs block), and in which transaction and at what commit time.
- **Proven means "as logged in transaction S"**, which is older than `s_sequence` 17671 (the journal is clean and checkpointed). It is **not** the database's current or final state.
  - Later versions may exist only on disk, or in overwritten transactions; `newerOrUnproven*` lists the ones still visible.
  - **Never treat an old candidate as the current database.** A directory entry for inode 1950053 proves only that the name pointed to that inode at that time.
- **No recovery acceptance** without (a) a proven walk (all checksums plus the commit) **and** (b) a separate decision about which state is wanted. MDBX/extent work is out of scope here.

## Limitations (stated)
- **Fixtures are synthetic** and share the CRC table with the verifier. CRC conformance on real data is shown only for the superblock. Root's actual run is the first real test of the descriptor, tag and commit semantics: a systematic mismatch on **every** real transaction would indicate a semantics error, not "no data".
- **Partial walks:** a walk may start at a later descriptor of the same transaction if earlier blocks of that transaction were overwritten (`walkFromEarliestBlock: false`). Those images are still authentic and committed; the earlier part is unknown.
- **Sequence ordering** is circular `tid` order around `s_sequence`. A 2^32 wrap within one journal is assumed absent.
- **Upstream `master` can change.** The bytes reviewed are pinned by sha256 in `upstream/`.
