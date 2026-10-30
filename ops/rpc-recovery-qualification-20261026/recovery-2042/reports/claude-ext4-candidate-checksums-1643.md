# ext4-recovery-checksum-stage/r1: OFFLINE ext4 inode + extent-block checksum qualifier for the deleted `mdbx.dat` candidate (1643). FROZEN 2026-10-26 20:35Z, NOT RUN

**Stage:** `ext4-recovery-checksum-stage/r1/`, **SHA256SUMS sha256 `e0e02acba0b983f703b32154cb5477d2ad88d3ff03b5106bc4cf49ec3144cffc`** (all files 0444)

| file | sha256 |
|---|---|
| `ext4_candidate_checksums.py` (419 lines, stdlib + ctypes) | `662291e5784a37c820f69902ef7b3c2fd6cf96d34822f60ce1df6f96db7da097` |
| `tests/test_ext4_candidate_checksums.py` (7 tests) | `cef1ba448a82108129dcdc00837ca3353d5464cbd77086426b7deab4ba96eba4` |
| `jobs/tests.sh` (fixtures) | `a443df922618c0d017eed1150ba64c78d0798ef989541bb0333972f4e9ab4c6a` |
| `jobs/run-real-copy.sh` (the real copy, after the tests pass) | `7182c2c04388c8cdfc8365263b575babe21abd4c5f06741f90aaf0937bc144dd` |

**Pinned primary references** (fetched 2026-10-26 20:30Z with `curl` from `raw.githubusercontent.com`, tags as named; kept in `refs/`):

| ref | sha256 |
|---|---|
| linux **v6.12** `fs/ext4/inode.c` | `a85d3c8a372212fabef113e9805c0101ec33dc02f7717b2f06bd6bfc40ecc4fa` |
| linux v6.12 `fs/ext4/extents.c` | `ca997b4124cdfd81fe4124187ff00c8c0e325afa4f0b8926b40c17063dc6fd65` |
| linux v6.12 `fs/ext4/ext4.h` | `3a3cdc0439c0c828176bd9f6bc5f25b041f273de29ee0b53c3970716052f114e` |
| linux v6.12 `fs/ext4/ext4_extents.h` | `673cde1c12fe4d3f8cfbc1e879f6fec165cdb50bc8d595b9414ed24c24d3e48c` |
| linux v6.12 `fs/ext4/super.c` | `7e40a398a52482bf47cc0c12e8a4cf22f3fc9b1103841823b8e800a17fd0ef13` |
| e2fsprogs **v1.47.2** `lib/ext2fs/csum.c` (independent second implementation) | `ac0bce4c789ed25f380f11eef9086b9afcbb9b00b77d8fb2552da966f22fe0f1` |

**What I did not do:** no tests, builds, live actions, USB or image access, and no full read of the journal copy.
- **What I did:** read bounded parts of root's 1626 candidate JSONs, `fs-stats.out` (head), `candidate-inode.out`, `candidate-imap.out` and `record.json`.
- **Not touched:** Claude 6d's JBD2-checksum work and every other agent's files.

## The rules implemented (all cited to the pinned refs; both implementations agree)
- **Filesystem seed:** `s_csum_seed = crc32c(~0, s_uuid)` when `metadata_csum_seed` is absent (`super.c:4607-4612`; e2fsprogs `csum.c:33-41`). The caller must assert `--no-csum-seed`; otherwise the checker refuses.
  - **Per-inode seed:** `i_csum_seed = crc32c(crc32c(s_csum_seed, le32 ino), le32 i_generation)` (`inode.c:4774-4779`; `csum.c:638-642`).
- **Inode** (`inode.c:57-108`; `csum.c:621-649`):
  - crc32c over the whole `EXT4_INODE_SIZE` (256) bytes with `i_checksum_lo` (0x7C) zeroed, and `i_checksum_hi` (0x82) zeroed when `128 + i_extra_isize ≥ 0x84`;
  - provided = `lo | hi<<16`, else the low 16 bits are compared.
  - This target has `i_extra_isize` 32, so hi is used. The output reports `checksumHiUsed`.
- **Extent blocks** (non-root; `extents.c:49-73`, `ext4_extents.h:55-105`; `csum.c:477-500`):
  - crc32c(`i_csum_seed`, block[0 : 12 + 12·eh_max]) must equal the le32 **at that offset**, so the tail moves with `eh_max`;
  - the checksum binds the inode number **and generation**, so a block written for another file or generation fails.
- **Header and entry rules** (`__ext4_ext_check` / `ext4_valid_extent_entries`, `extents.c:367-505`):
  - magic 0xF30A, `eh_depth` = the expected depth, `0 < eh_max ≤` the maximum (4 in the inode root, 340 in a 4 KiB block), `entries ≤ eh_max`, `entries > 0` when depth > 0;
  - the first logical block equals the parent index;
  - ascending, non-overlapping;
  - no zero-length or wrapping extent; physical block nonzero and within the filesystem.
  - **Added here:** a child's entries must stay below the next sibling index.
  - Depth is limited to **0, 1 or 2** (the candidate is depth 2); a deeper root is refused.
- **`i_blocks`:** with the `huge_file` feature, `lo | blocks_high<<32` is in 512-byte units unless `EXT4_HUGE_FILE_FL` is set (`inode.c:4612-4632`).
- **crc32c:** `ext4_chksum` returns the raw shash state (`ext4.h:2467-2483`).
  - The checker uses an **independent pure table** (reflected 0x82F63B78).
  - At start it refuses unless the table gives the CRC-32C check value 0xE3069283 and equals the **local libext2fs `ext2fs_crc32c_le`** on 4 vectors.
  - The fixtures are checksummed with libext2fs, not the checker's table.

## Strict choice conditions (nothing is accepted blindly)
**Inode versions:**
- Every image of inode-table block 499122230 is read at offset 1024. Other generations are only counted (the inode number was later reused, generation 3941633993).
- **Usable versions must all hold:**
  - checksum valid;
  - transaction committed and intact (r1 inventory);
  - links ≥ 1 and dtime 0;
  - the `EXTENTS` flag set;
  - sequence ≤ `--at-or-before-seq` (17169);
  - size = `--expect-size` (1,138,166,333,440).
- **Chosen** = the newest usable version. Every version is listed with its stored and computed checksums.
- **If any newer image (≤ the bound) fails its checksum,** the result is **not** valid: "the chosen version may not be the latest".

**Each tree block** reached from the chosen root:
- Every image is checked. An image with sequence > the chosen inode's sequence is listed as `afterChosenInode` and never used.
- **Chosen** = the newest image that is checksum-valid, structurally valid, committed and intact, at or before the chosen inode's sequence.
- **Also recorded:** all valid versions and `distinctValidContents`.
- **Not valid if:** a newer image ≤ the bound is invalid or uncommitted (`ambiguous`), or no valid image exists.

**Map:**
- the extents of the chosen leaves, with no cross-leaf overlap;
- `i_blocks` (in fs blocks) must equal mapped blocks + tree blocks;
- `extentsBeyondSize` is only reported (legal in ext4).
- **Holes and `sparseTailBytes` are interpreted ONLY when the whole map is authenticated.** Otherwise: "NOT INTERPRETED".

**Output fields:**
- `metadataChecksumsValid` is true only if all of the above hold;
- **`recoveryProven` is always false**;
- **`dataIntact`: "NOT ASSESSED"** (no data block is read; freed blocks may be reused);
- the JBD2 records' own authenticity is out of scope (6d).

**What a valid result means and does not mean:**
- **It does mean:** those bytes are exactly what ext4 wrote for (fs UUID, ino 1950053, generation 3326586236), and they form a consistent, fully accounted map.
- **It does not mean:**
  - that the chosen leaf versions were the ones current at seq 17169 (a later change could have been overwritten in the log);
  - anything about the data.

## Tests (7, synthetic; prepared, NOT run)
1. **crc32c:** the pure table equals libext2fs on vectors, gives the check value, and the seed matches.
2. **Depth-2 tree:** valid; 3 extents including an unwritten one; data blocks 65 + 3 tree blocks = `i_blocks`; 2 holes; sparse tail; the tail at 4092; `recoveryProven` false.
3. **Choice:**
   - an older valid leaf (seq 3) loses to a newer valid one (seq 6);
   - an image after the inode (seq 20) is ignored and listed;
   - a newer **invalid** image (seq 8) makes it ambiguous and not valid, and holes are not interpreted.
4. **Inode:**
   - a corrupt newer version is listed as invalid and blocks validity;
   - another generation is only counted;
   - with no version ≤ the bound, or a wrong `--expect-size`, no inode is chosen.
5. **Extent rejects:**
   - another generation's checksum, wrong first logical block, overlap, `eh_max` 341, wrong depth, zero length, a physical block out of range, a child beyond its parent range;
   - `eh_max` 100 moves the tail to 1212 and is still valid;
   - a depth-3 root is refused.
6. **Accounting:** `i_blocks` off by one block is not valid; depth-0 and depth-1 trees are valid; an uncommitted image is never chosen.
7. **Safety:** symlink, FIFO (alarm), non-1 GiB production size, a wrong inventory format and a missing `--no-csum-seed` all refuse and write nothing; the output is 0600 and never overwritten.

## Root (main queue, 512)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh ext4-checksum-r1-tests 512 unshare -Urn bash ext4-recovery-checksum-stage/r1/jobs/tests.sh       # Ran 7, OK
bash jobs/q-exit-status.sh ext4-checksum-r1-real  512 unshare -Urn bash ext4-recovery-checksum-stage/r1/jobs/run-real-copy.sh # only after PASS
```
**The real-copy job:**
- **Gates:** it refuses unless the stage SUMS hold, the fixture log shows `rc=0`, and the journal copy's sha256 = `d95d81fc…` (root 1626 `record.json`).
- **Inputs:** `inventory-with-index.json` (inode-table block + index 499155449) and `inventory-leaves.json` (27 leaves).
- **Arguments:** UUID `11c6bbac-f823-4052-a87a-066eed6ad590`, ino 1950053, gen 3326586236, inode 256 B at block 499122230 offset 1024, bound seq **17169**, fs blocks 976,562,500, `huge_file` yes, `--no-csum-seed` (`fs-stats.out` lists no `metadata_csum_seed`), expected size 1,138,166,333,440.
- **Output:** `runs/real-*/ext4-candidate-checksums.json`, plus a short summary. It reads the journal only at the inventory's image offsets (4 KiB each), plus one full sha256 pass.

## Expected honest outcomes and how to read them
- **All valid + accounted:** the candidate map is self-consistent ext4 metadata for that exact file. Still **no** recovery: the data blocks are unread and may be reused (root's 1626 found ~35 GB written later), and nothing proves the data or the MDBX contents. The standard is not reduced.
- **The chosen index (latest ≤ 17169) points to leaves not in the 27-leaf inventory:** "no checksum-valid committed image" for those leaves. Root then re-runs the r1 inventory with those block numbers as targets.
- **A newer invalid image, or an unaccounted `i_blocks`:** not valid. Every version is listed for root's review; the checker never falls back to an older version silently as "the" answer.
