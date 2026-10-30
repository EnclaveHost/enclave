# 1855: inputs for running the read-only Base state helper on the recovered DB and for establishing canonical Base state (SOURCE/EVIDENCE INVENTORY ONLY)

**This is an inventory, not a production qualification.** It was written from saved text and source I had already read, after I hit the turn limit; it is incomplete where marked.

**What I did not do:**
- no implementation, tests, builds, mounts, queue jobs, network, installs or commits;
- no reads of the original image or of any part;
- no secret values.

**Not proof of canonical state:** a state-root match against the header from the **same** DB / static files proves self-consistency only. It does **not** prove canonical Base state.

## 1. Inputs and their evidence status
Status labels:
- **ACTUAL** = saved evidence exists;
- **SOURCE** = prepared source only;
- **UNKNOWN** = not established.

| input | status | evidence (path, sha where known) |
|---|---|---|
| Recovered `mdbx.dat` | ACTUAL (copy and verify in progress; not complete) | See the notes below the table. |
| Helper binary | **SOURCE only: the canonical Rust is UNCOMPILED** (HANDOFF 07:06) | `base-state-readonly-stage/r10` SUMS `0034b392…`; `src/main.rs` `597a499a…` (= r7). The actual r8 tests covered the guard and namespace wrappers only, never the Rust. |
| **Storage layout v2** | ACTUAL for the *snapshot*, UNKNOWN for the recovered DB | See the notes below the table. |
| **`static_files/`, header at Finish** | ACTUAL presence only, as of 2026-10-26 15:19–15:21 UTC: `static_files/` 136.1 GB remains (`logs/claude-retention-state-redownload.md` §1; `logs/recovery-report-correction-1428.out`) | See the notes below the table. |
| **Finish block value and checkpoint coherence** | UNKNOWN | See the notes below the table. |
| **`rocksdb/` (v2)** | **UNKNOWN; possible blocker** | See the notes below the table. |
| `reth.toml` | ACTUAL presence (`data/reth.toml` remains, per 1426/1428; root: `retention-backup/` holds only `reth.toml` + hash, per HANDOFF) | Contents not read by me. It is needed as the `--config` copy for any `base reth db …` use (1678 §1a). |
| `db/database.version` | Deleted with the DB (root note `logs/retention-state-redownload-root-note.txt`: `db/{database.version,lock,mdbx.dat,mdbx.lck}` ALL ABSENT at 15:22) | The manifest pins it: 1 byte, blake3 `813e9b72…`. The helper does not need it. Whether the `base reth db` CLI needs it on the RO view: **UNKNOWN**. |
| `messagePasserStorageRoot` | **SOURCE, resolved** | See the notes below the table. |
| **L1 anchor** | ACTUAL A1 receipt, but **at N = 52866960, NOT the snapshot/Finish block** | See the notes below the table. |
| Derivation of Finish from L1 | **UNKNOWN / not inventoried** | `derivation-client-stage` and `l1-proof-window-stage` exist, but I did not read them in this task. **Incomplete here.** |

**Recovered `mdbx.dat`:**
- 265 parts × 4 GiB = 1,138,166,333,440 B, which equals the deleted `mdbx.dat` size (`logs/claude-deleted-state-journal-review.md`).
- HANDOFF 07:06: 137 parts / 548 GiB independently verified.
- **No reference hash can authenticate it.** The manifest blake3 `8de35ff5…` is for the pre-finalize file, and finalize then opened the DB RW and wrote checkpoints (`logs/claude-retention-state-redownload.md` §1.2). Only structural and state checks can validate it.

**Storage layout v2:** `logs/download-next-batch-0528/manifest-structure.txt` gives `storage_version 2`, block **53048526**, chain 8453, reth `2.5.2-dev (7134be3)`. The helper reads `Metadata.storage_settings` itself (`main.rs:166-170`).

**`static_files/`, what is missing:**
- No per-file listing or hash of the headers segment holding Finish (or N) is saved.
- The first run selected Headers = All, 107 archives (`logs/download-next-batch-0528/guest-components-journal-flags.txt`).
- A later retention run (1394) downloaded more history archives into the same datadir, so file-level integrity vs the manifest is **UNKNOWN**.
- Manifest pin: 1792886410, sha `1f0c4e6c…` (`a2a4.py:41`).
- The helper refuses without the dir or the tip header (`main.rs:160,188-189`).

**Finish block value and checkpoint coherence:**
- **Inference only:** Finish = 53048526.
- **Known source risk (1695):** coherence (`Execution == MerkleExecute == AccountHashing == StorageHashing == Finish`, `main.rs:183-184`) may false-fail on v2.

**`rocksdb/` (v2), why it may block:**
- `rocksdb_indices` (597 GB) was **not selected** in the first run (`guest-components-journal-flags.txt` lists no RocksDB component).
- Source reading (`logs/claude-retention-floor-result.md` §2): the downloader then reset the history and lookup stages.
- No saved evidence shows whether `data/rocksdb/` or its `CURRENT` exists.
- **The helper refuses on v2 without `rocksdb/CURRENT`** (`main.rs:171-172`); it never opens RocksDB.

**`messagePasserStorageRoot`, how it resolves:**
- `base-finality-proof-stage/r13-manifest-final/vendor/anchor-bootstrap.mjs` `90a8afba…` (lines 12-13, 109) takes it as **header.withdrawalsRoot** (Isthmus), and computes OutputRootV0 = keccak(0 ‖ stateRoot ‖ withdrawalsRoot ‖ blockHash).
- With a full state-root match, the DB's message-passer storage is covered through the header.
- **The helper JSON lacks it.** It emits only number/hash/stateRoot (`main.rs:214`). The full header must be read separately, e.g. the `a2a4.py` `read_header` path: `base reth db get static-file headers N` (`harness/a2a4.py` `27ecfb40…`, line 950).

**L1 anchor:**
- Receipt: `outputs/rpc-production-final-20261025/l1-a1-live-1958/a1-evidence.json` sha **`b9a90847…`** (an identical copy is in `source/ops/rpc-backend-bootstrap/2026-10-25/l1-anchor-a1/live-1958/`).
- Contents: verdict `A1-authenticated`; N 52866960; outputRoot `0xa996c517…`; game `0x343b3a99…`; ASR `0x909f6cf4…`; L1 block 26271848.
- HANDOFF: checkpoint `2e8502e6` expires about Nov 1, 19:22 UTC.

## 2. Original-only, non-MDBX items to preserve or validate read-only BEFORE any RAID reset
The original is `/home/steven/Documents/Codex/2026-10-26/my/work/tr004-readonly/enclave-rpc-production/base-origin.qcow2` (USB RAID5). Per HANDOFF:
- the guest ext4 holds `data`, `tmp`, `retention-backup`, `snapshot-complete` and `lost+found` (`logs/base-deleted-metadata-1502/root.out`);
- the L1 and OS images are on T710 `/vm`, not on the USB.

The current preservation is the 265 `mdbx.dat` parts only. Nothing below is known to be preserved:

1. **`data/static_files/` (136.1 GB).** This is the only local source of the Finish header, the header at N = 52866960 and the parentHash chain between them.
   - **Minimum:** the headers segment files covering N and Finish (with their companion files).
   - **Better:** the whole directory.
   - **Fallback (needs network and a decision):** re-fetch the manifest-pinned headers archives (20.46 GB compressed) and check their blake3. That would be a substitute, not preservation.
   - Capacity was **not evaluated** here.
2. **`data/reth.toml` and `retention-backup/` (`reth.toml` + hash).** Small; needed as the config copy.
3. **`data/rocksdb/`, if it exists** (unknown): at least its existence, its listing and `CURRENT`.
4. **The ext4 provenance metadata behind the recovered extent map** (journal, superblock, extent leaf blocks). Root's saved outputs exist:
   - `logs/root-journal-name-scan-1629.out`: 4 **unauthenticated** candidates, inode 1950053;
   - `root-jbd2-actual-all-1649.out`;
   - `root-ext4-actual-1658.out`;
   - `base-deleted-metadata-1502/`.

   **I did not review 1649/1658 in this task.** Root should confirm they are archived and sufficient, because nothing can be re-derived after a reset.
5. **Evidence only, not needed for the state check:**
   - `data/.download-cache/state.tar.zst.part` (about 4.3 GB allocated);
   - the history `.part` files;
   - the `snapshot-complete` marker.

   Root's decision whether to keep them. Secret files (discovery key, JWT): not read and not needed.

## 3. Minimal next read-only check (only AFTER the current preservation finishes; no concurrent original reads)
One bounded, **metadata-only** listing through root's existing read-only path (as in 1502): no file contents, no hashing of large files, no mount changes. It should return:
- `data/`, `data/db/` (expected empty) and `data/rocksdb/` (exists? `CURRENT`?);
- the names and sizes in `data/static_files/`, to identify the headers segment(s) covering 52866960 and 53048526 (names depend on the segment size; do not assume them);
- the sizes of `data/reth.toml` and `retention-backup/`.

**That listing decides:**
- (a) what to copy read-only with hashes;
- (b) whether the v2 `rocksdb/CURRENT` refusal will fire. This is a root decision: a placeholder `CURRENT` would bypass a deliberate guard and needs review, not my call.

## 4. Order of use afterwards (no new framework; reuse the existing paths)
1. After all 265 parts are CONFIRMED and the r10 wrapper is qualified, compile the helper, then run it on the RO view with `--static-files` from the preserved copy.
2. **Its result is self-consistency only** (`main.rs:209`).
3. **Read the full headers at Finish and N read-only** (`base reth db get static-file headers …`, with the `--config` copy and a scratch `--datadir.rocksdb` per 1678 §1b; never let it create anything in the original).
   - Authenticate header N against `b9a90847…` with `authenticateAnchor` (`90a8afba…`).
   - Check the parentHash chain from Finish back to N.
4. **The chain from N proves descent from anchored N, NOT that Finish itself is canonical.** That needs either:
   - an L1 anchor at a block ≥ Finish with headers up to it; or
   - an L1 derivation of Finish.

   Both are **not yet available** (network/fresh A1 is a later, separately authorized step).
5. The `a2a4.py` a3/a4 unwind/rebuild path **mutates the datadir**. It is not usable on parts or the original; only on a writable copy.

## 5. Not covered (incomplete)
- `derivation-client-stage`, `l1-proof-window-stage` and the actual contents of 1649/1658;
- the per-file blake3 entries for the headers in `logs/base-manifest.body`;
- the contents of `reth.toml`;
- the recovery-multipart manifest scope, which was not re-read here; the 265 × 4 GiB = mdbx.dat size equality above is arithmetic only.
