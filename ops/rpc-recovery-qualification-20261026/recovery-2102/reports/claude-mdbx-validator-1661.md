# MDBX read-only validator r1: identification, official mdbx_chk semantics, and the FROZEN stage (source only; nothing compiled, run, mounted or read beyond small local files) - 2026-10-26

**Context:** the stage is `mdbx-recovery-validator-stage/r1`, work in progress. Source commit context is `f3cf3ea3`. The other agents' work (1659 bitmap, 1660 overlay) is untouched. Nothing was copied, no sudo/USB/production action, and no 1 TB read.

## What wrote the deleted DB (evidence, not timestamps)
1. **The Base holder** in the RPC VM is **`base v1.5.1`**.
   - `stage_backend.py`; `fresh-witness-supply/staging/base-v1.5.1-20261023T053947Z/staged.json`: the official GitHub release asset, sha256 `6779c45d…`, sidecar match.
   - The binary is `base`, sha256 **`9c44836d3dd41ae92df3c52fe0df7957dc10b77859d8d80cce6d5fb89d35e53f`**.
   - The L1 EL (reth v2.8.0) is a different node and a different DB.
2. **That production binary itself contains** (bounded `grep -a` of the 150 MB local file, not the DB):
   - the libmdbx build string **`v0.13.12-0-gf619d43d`**;
   - the reth revision **`7134be3`**.
3. **Source match:** `base/base` `Cargo.lock` (the derivation build tree) pins `reth-mdbx-sys`/`reth-libmdbx` 2.5.2 from `git+https://github.com/base/reth?tag=base-v2.5.2.8#7134be3b51cf9d9504f988bff3266a23085f0bd9`.
   - The cargo checkout of exactly that revision vendors the **official amalgamated libmdbx dist**, with `VERSION.json` `{git_describe: v0.13.12-0-gf619d43d, git_commit: f619d43dfbc36cbc9a1832503ce43f2e5223996e, semver 0.13.12}`.
   - The dist includes `mdbx_chk.c` (`MDBX_BUILD_SOURCERY …_v0_13_12_0_gf619d43d`).
   - All 33 dist files are pinned in `pins/libmdbx-v0.13.12-f619d43d.sha256`. The two other cached copies are byte-identical.

**Explicit uncertainty that remains:**
- (a) **Which version wrote the DB.** The binary match proves which libmdbx `base v1.5.1` **contains**. That base v1.5.1 is the version that **wrote the deleted DB** rests on the VM staging/install records, not on the DB's own bytes. If an earlier base build created the file, its libmdbx could differ.
- (b) **The on-disk format matches the family, not the exact build.** Root's meta sample shows magic+version `0x59659DBDEF4C11 | 0x03` (data version 3) at offset 16. That matches the libmdbx **0.13 family's** format, not one exact build.
- (c) **No built `mdbx_chk` exists** on this host. `command -v` is missing, and a whole-disk search found only sources.

## The official `mdbx_chk` (0.13.12), read from its source
- **The default env** is `MDBX_RDONLY | MDBX_EXCLUSIVE | MDBX_VALIDATION`. Only **`-w`** clears read-only; `-t`/`-T` (meta turn) **require** `-w`.
- **Exclusive open busy:** it falls back to cooperative `MDBX_ACCEDE` (still read-only).
- **Lock file on a read-only filesystem:** `lck_setup()` gets EROFS/EACCES, confirms with `osal_check_fs_rdonly` that the filesystem **is** read-only, and continues in **without-lck mode**. No lock file is created or changed.
  - **Precondition:** the DB directory must be a **read-only mount**. On a writable view the lock file would be created or used. The wrapper enforces `ST_RDONLY`.
- **A weak newest meta:** in read-only mode it refuses with `MDBX_WANNA_RECOVERY` ("run in read-write mode"). We do not; that is a finding. `-0/-1/-2` checks a specific meta page read-only (exclusive).
- **Validates** (`mdbx_env_chk`, `MDBX_CHK_DEFAULTS`):
  - meta pages: magic/version, geometry, txnids, steady/weak troika;
  - the GC/free-list table;
  - a **page-by-page traversal of every B-tree** (main plus every named table, nested dupsort trees, large/overflow pages);
  - key/value traversal and order;
  - page accounting: each page used once; double-use, lost/leaked and out-of-bound pages are reported.

  Exit 0 OK, 1 minor, 2 major, 3 MDBX error, 4 system, 5 interrupted.
- **Does NOT validate:**
  - **value bytes:** MDBX has **no per-page checksums**, so corrupted value bytes inside a structurally valid page are invisible;
  - reth table semantics (RLP/compact decoding);
  - cross-table consistency;
  - state/trie roots;
  - reth `static_files/` (headers/transactions/receipts live **outside** `mdbx.dat`);
  - chain authenticity.
- **Memory and I/O:**
  - a per-page `int16_t pagemap` of `alloc_pages` entries: about **556 MB** for 1.14 TB at 4 KiB pages;
  - an mmap of the file, with page cache reclaimable;
  - **one full read of the used pages** (no warm-up, no `-u`/`-U`).

## Required before production use (mdbx_chk alone is NOT chain verification)
1. **`database.version` == 2** (reth `DB_VERSION`), checked by the wrapper as reported.
2. **reth `static_files/` presence and headers** (read-only `db static-file-header`, `RoInconsistent`) and their block ranges consistent with MDBX `StageCheckpoints`.
3. **`base db repair-trie --dry-run`** (reth 7134be3: `--dry-run` → `AccessRights::RO`, `verify_only`): the trie tables vs the hashed state.
   - *To confirm:* that the production `base` CLI exposes reth's `db` subcommands. It must run on the same read-only view.
4. **The state root at the DB tip:** the root of `AccountsTrie` == the tip header's `stateRoot`, **and** the tip header hash authenticated independently, via our L1-derived output root (`keccak(0‖stateRoot‖messagePasserStorageRoot‖blockHash)` vs the L1 anchor/dispute game).
5. **Plain-vs-hashed state consistency** (a full read-only re-hash or a reviewed sample). The trie check covers hashed → trie, not plain → hashed.
6. **The transient-reuse/bitmap-history gate (1659)** stays separate. A structurally clean `mdbx_chk` does not clear it.

## Root's meta sample, decoded against the pinned source (`logs/base-journal-copy-1626/page-samples/first-4-pages.bin`, 16 KiB, bounded read)
**Page headers:** pages 0-2 have flags `0x0008` (`P_META`) and pgno 0/1/2. Root's "offset 16" is pgno (4 B) plus the start of the meta.

**Each meta (offset 20):**
- `magic_and_version` = **`0x59659DBDEF4C1103`**. That equals the pinned source's `MDBX_DATA_MAGIC` = `MDBX_MAGIC 0x59659DBDEF4C11 << 8 | MDBX_DATA_VERSION 3` (PNL descending).
- `validator_id` **0**; `extra_pagehdr` 0; `reserve16` 0.
- `pagesize` **4096**.
- txnids **51691980 / 51691981 / 51691982**, all **steady**.
- geometry `now` = **277,872,640 pages** (= the extent map's `expectedBlocks`; × 4096 = 1,138,166,333,440 B) and `next` = **276,959,557** (= the extent map's `endBlock`).

**Meaning:**
- the format is libmdbx **data version 3** (the 0.13 family);
- all three metas are steady, so a read-only exclusive open should not hit `MDBX_WANNA_RECOVERY` (to be shown by the run);
- the meta geometry is consistent with the reconstructed file map.

**No content checksums:**
- `validator_id = 0` means no page checksums;
- in 0.13.12 the steady sign is the **constant `~0`** (`meta_sign_calculate`: `hippeus_hash64` is `#if 0 /* TODO */`), so metas carry **no content checksum** either.

## Stage: `mdbx-recovery-validator-stage/r1`, FROZEN
**`SHA256SUMS` = `f023beac65b409b7a2889dc5823277779bcf786e94e63f70a9aaab2714554282`** (files `a-w`).

| file | sha256 |
|---|---|
| `pins/libmdbx-v0.13.12-f619d43d.sha256` (33 dist files) | `be06662eb9b82d52d172d08d70dae63808590991d80d7773f0a45042f5d11cf4` |
| `src/mdbx_check.py` | `310a4fd55ecee6285973d7cd968d2429b71758af2f6e8aa13b17bde4b6097116` |
| `src/mk_fixture.c` | `26fce65433222ec9b149aa65294a197f937109387430aef25c986166bb097b11` |
| `tests/test_mdbx_validator.py` (10 tests) | `795693e70a874ddf659e5b2b135ab52f93104e374103562d3b954d08ee2c3245` |
| `jobs/build-and-test.sh` | `1a493d18d686f12f0fb3dcd1e5cbff33f5e6071511b0a4e437bfd2cf870e39cf` |
| `README.md` | `7b124611d88c7679c9c464bd961c86f2b746e234e642f09420afb59eb87834f8` |

**Key source pins:**
- `mdbx.c` `dda528e1…`, `mdbx.h` `55130f2c…`, `mdbx_chk.c` `aadb6273…`, `VERSION.json` `f731884c…`, `GNUmakefile` `5f160208…`;
- reth `mdbx-sys/build.rs` `b954278b…` (its defines are reproduced: `MDBX_TXN_CHECKOWNER=0`, `MDBX_USE_FALLOCATE=0`, release `MDBX_DEBUG=0`/`NDEBUG`).

**No fetch was needed.** The dist is local, at the exact `base/reth` revision `7134be3`.

## Fixture tests (10; root, `unshare -Urnm`; every DB exposed through a REAL read-only bind mount)
**The fixture:** `mk_fixture` (the official libmdbx API, the same `mdbx-static.o`, page size 4096) builds 20,000 records in the main table plus a named table, with a steady meta. A reth `database.version` = `2` is added.

**Tests:**
1. `mdbx_chk -V` reports `v0.13.12-0-gf619d43d`.
2. **Pristine** via the wrapper: rc 0, structurally clean, identity unchanged, `databaseVersion` "2", and the argv is exactly `-v DIR`.
3. **Each of `-0/-1/-2`** is checked read-only (never an MDBX/system error), and the **newest** meta (max txnid, decoded) is clean.
4. **All 3 meta pages corrupted:** not clean (raw rc ∉ {0, 5}; wrapper rc 2).
5. **32 B-tree pages after the metas corrupted:** not clean.
6. **Truncated to 16 pages:** not clean.
7. **A writable view is refused before `mdbx_chk` runs** (no report).
8. **Even `mdbx_chk -w` on the read-only mount fails:** the mount is the guard, and the wrapper never passes `-w`.
9. **A wrong binary sha or `--meta 3`** is refused.
10. **A symlinked or empty directory** is refused.

After **every** test, all fixture directories, lock files included, are unchanged (names, inode, size, mtime).

## Exact root job
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh mdbx-validator-r1 2048 unshare -Urnm bash mdbx-recovery-validator-stage/r1/jobs/build-and-test.sh
```
**PASS requires all of:** `## build OK`, `## version OK v0.13.12-0-gf619d43d`, `## test_mdbx_validator PASS (10)`, `## mdbx-validator-r1 rc=0`.
- **Lane:** 2048 MiB, to compile the 1.5 MB amalgamation; the queue's 16 GiB host floor applies.
- **Network:** none; the sources are local and pinned.

**Production run** (root, after review, on the disposable **read-only** view of `db/` only): `src/mdbx_check.py` per `README.md`.
- **Expected memory:** about 0.6 GB of heap.
- **Expected I/O:** one read of the used ~1.13 TB, still faster than a redownload, bounded by the timeout.
- **Reading the result:** rc ≠ 0 means **not** structurally clean, so stop. rc 0 means only "structurally consistent", never "recovered".

**Not claimed:** nothing has been built or run.
- **Explicit uncertainty:** that `base v1.5.1` (libmdbx 0.13.12) is the version that **wrote** this file rests on the deployment records, not the DB's bytes. The bytes prove only data version 3 / the 0.13 family. The validator was not chosen by timestamp.
- **Separate gates still open:** the transient-reuse gate and steps 1-6 above.
