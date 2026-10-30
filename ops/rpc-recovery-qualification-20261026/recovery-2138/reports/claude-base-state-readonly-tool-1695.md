# 1695: base-state-readonly-stage, an offline read-only Base/reth 7134be3 state-integrity helper (SOURCE ONLY; nothing built or run)

**Stages:**

| stage | SHA256SUMS sha256 | status |
|---|---|---|
| `base-state-readonly-stage/r2/` | **`34dbf6e0899bd63180cb1eedbc8538bc44e2a4ff4760cd572543ff3320f82067`** | **the one to build** |
| `base-state-readonly-stage/r1/` | `0fa213194eb2b42c270436e3c951140e7eb952f2ab95ddfad47099f4c6d2b7f1` | frozen, superseded |

**Why r2 exists:** my review found that r1's `alloy-consensus = "*"` is ambiguous. Base's lock contains both 1.8.3 and 2.4.1, and reth 7134be3 requires `^2.3.0` (`Cargo.toml:452`). A 1.x pick would break the `Header` type. r2 pins `alloy-primitives =1.6.1`, `alloy-consensus =2.4.1`, `serde_json =1.0.151` and `eyre =0.6.12`, all versions from Base's lock. r2 = r1 + those four pins + r2 labels (diff checked).

**What I did:** read source (the pinned reth checkout and the cached Base workspace), wrote files, ran `bash -n`. **Not compiled, no tests, no live access, no USB, no mounts, no reads of the candidate DB.** The original read-only recovery candidate is untouched.

**r2 files:**

| file | sha256 |
|---|---|
| `Cargo.toml` | `e5f7f6f1…` |
| `src/main.rs` | `5ba0a60f…` (180 lines) |
| `jobs/build.sh` | `537e6d43…` |
| `jobs/fixtures.sh` | `c38842bf…` |
| `README.md` | `bf9471c0…` |

## Exact dependency graph (verified, not guessed)
- **Production:** Base v1.5.1 `Cargo.lock` (cached `derivation-client-stage/combined-r1/build/deps-43698236e9186750/base/Cargo.lock`, sha **`f122da76…`**) pins every reth crate to `git+https://github.com/base/reth?tag=base-v2.5.2.8#7134be3b51cf9d9504f988bff3266a23085f0bd9`.
- **All crates the helper uses are in that lock** (2.5.2): reth-db, reth-db-api, reth-trie, reth-trie-db, reth-provider, reth-storage-api, reth-stages-types, reth-ethereum-primitives.
- **Cached sources:**
  - `…/deps-43698236e9186750/cargo/{registry,git}`, with git checkout `reth-babcd6134566c621`;
  - the same tree is at `~/.cargo/git/checkouts/reth-babcd6134566c621/7134be3`, which I read.
- **The base binary that exposes this code:** `9c44836d…` (per 1678). Root's 1693 log confirms `base reth db {repair-trie,settings,stage-checkpoints,…}`.

## What the helper does, and the official code it reuses
| step | official code (reth 7134be3) |
|---|---|
| refuse if `--db/mdbx.dat` (regular file), the `--static-files` dir, or (v2) `--rocksdb/CURRENT` is missing; also refuses relative paths, unknown args, an existing `--out`. **Never initializes anything** (unlike `common.rs:146-158`, which creates an empty RocksDB for RO commands) | — |
| open MDBX read-only | `reth_db::open_db_read_only` → `DatabaseEnvKind::RO => Mode::ReadOnly` (`db/src/implementation/mdbx/mod.rs:408`); `DatabaseArguments::new(ClientVersion::default())` (`:132`; `ClientVersion` re-exported in `db-api/src/models/mod.rs:26`) |
| one long RO tx | `tx.disable_long_read_transaction_safety()` (`db-api/src/transaction.rs:48`), as in `repair_trie.rs` `verify_only` (`:110-124`) |
| storage settings | `tables::Metadata["storage_settings"]` JSON → `StorageSettings{storage_v2}` (`storage-api/src/metadata.rs:9`, `db-api/src/models/metadata.rs:16-56`). Absent = legacy, as reth treats it, and recorded |
| trie adapter | same rule as `reth_trie_db::with_adapter!` (`trie/db/src/lib.rs:42-55`): v2 → `PackedKeyAdapter`, else `LegacyKeyAdapter` |
| checkpoints | walks all of `tables::StageCheckpoints` (`Key = StageId`, Display at `stages/types/src/id.rs:138`); `Finish` must exist; **coherent** = `MerkleExecute == AccountHashing == StorageHashing == Execution == Finish` (the `verify_checkpoints` intent of `repair_trie.rs:175+`, plus Execution) |
| tip header | `StaticFileProviderBuilder::read_only(sf).build::<EthPrimitives>()` (`static_file/manager.rs:149,222`; RO takes no lock file, `:309`) → `header_by_number(Finish)`. The header type is `alloy_consensus::Header` = `BasePrimitives::BlockHeader` (Base `crates/common/consensus/src/reth_compat.rs:521-526`). No transaction or receipt is decoded. A missing header refuses |
| state root | exactly repair_trie's `DbStateRoot`: `StateRoot::<DatabaseTrieCursorFactory<&TX, A>, DatabaseHashedCursorFactory<&TX>>::from_tx(tx).root()` (`repair_trie.rs:356-368`; trait `DatabaseStateRoot`, `trie/db/src/state.rs:22-24,155`). Compared with **the same Finish header's** `state_root` |
| plain → hashed (`--plain-hashed`) | see below |

**Plain → hashed, full, no samples (`--plain-hashed`):**
- **Accounts:** for every `PlainAccountState (addr, acct)`, `HashedAccounts.seek_exact(keccak256(addr))` must equal `acct`.
- **Storage:** for every `PlainStorageState (addr, {slot, value})`, `HashedStorages.seek_by_key_subkey(keccak256(addr), keccak256(slot))` must have exactly that key and an equal value. Zero-valued plain slots count as a failure.
- **Counts:** `entries(HashedAccounts) == plain accounts` and `entries(HashedStorages) == plain slots`.
- **Why that covers both directions:** with every plain entry present at its distinct keccak key, equal counts mean the hashed tables have no extra entries. This assumes only keccak injectivity.
- **v2 layouts:** **NOT_APPLICABLE**, never PASS. At 7134be3, `write_state_changes` skips plain state when `use_hashed_state()` (= `storage_v2`, `metadata.rs:85-87`; `provider.rs:2774`). The plain entry counts are still recorded.

**Output:** one NEW 0600 JSON, created only at the end. It contains:
- settings, the adapter, whether RocksDB CURRENT is present (`rocksdbOpened:false`), all checkpoints and coherence;
- the tip `number`, `hash` and `stateRoot`;
- the computed root and the match;
- the plain/hashed counts and mismatches (first 64);
- the fixed statements `acceptance: NOT A CHAIN ACCEPTANCE…` and `historyIntegrity: INCOMPLETE…`.

**Exit codes:**

| rc | meaning |
|---|---|
| 0 | all requested checks pass |
| 4 | a mismatch: root, checkpoints, or plain/hashed FAIL |
| 3 | refused |
| 1 | any reth/MDBX error (eyre) |

## Root jobs (shared queue; in order; each needs the previous one reviewed)
1. **Build (offline, bounded):**
   ```
   bash jobs/q-exit-status.sh bsro-r2-build 4096 unshare -Urn bash base-state-readonly-stage/r2/jobs/build.sh
   ```
   - **Pins:** stage SUMS and the Base lock sha `f122da76…`.
   - **Sources:** a fresh `CARGO_HOME` under `/tmp/bsro-r2-build-…`, whose `registry`/`git` are **symlinks** into the cached store. **A before/after manifest of the cached store must be identical,** otherwise rc 9. The existing cache and target are never written by design; the manifest check proves it.
   - **Build:** a fresh target dir; `--offline -j 4`; 7200 s timeout.
   - **Lock check:** the seeded Base lock is copied in. The **resolved lock must contain no package absent from the Base lock** (name, version, source, checksum), and the only reth source must be the 7134be3 tag.
   - **Output:** the binary is copied 0555 to `runs/build-…`, with its sha printed. The `/tmp` scratch is left for root to remove after review.
   - **Unknowns:** memory and time are not measured; 4096 MiB is my estimate for 4 jobs. If a needed crate is not extracted in the cache, `--offline` fails closed.
2. **Negative fixtures:**
   ```
   bash jobs/q-exit-status.sh bsro-r2-fixtures 512 unshare -Urn bash base-state-readonly-stage/r2/jobs/fixtures.sh <ABS runs/build-…/base-state-readonly>
   ```
   - **Cases:** empty db dir, missing static_files, a relative path and an unknown arg (`--repair`) must each exit 3. An existing `--out` must exit 3 and stay unmodified. A 0-byte `mdbx.dat` must exit non-zero.
   - **Every case:** the fixture tree must be byte-for-byte unchanged (no file created).
   - **Expected flag on `corrupt-mdbx`:** under `unshare -Urn`, user-namespace root bypasses the `a-w` modes. If MDBX creates `mdbx.lck` there, that case shows `unchanged=n` and FAILs. That is a **real finding**, not to be relaxed: the real run must use a read-only mount, as the 1660 view is.
3. **Positive fixtures (plan only, not scripted; the official CLI's `init`/chain flags are not verified):**
   - Root initialises a **disposable scratch** datadir with the official binary, e.g. genesis only via `base reth init` if it exists. On the official binary that is an RW action, on scratch only.
   - Then it runs the helper. Expect `finish = 0`, coherent checkpoints, the root equal to the genesis header `stateRoot`, and plain/hashed PASS (v1) or NOT_APPLICABLE (v2).
   - **Negative on a scratch COPY only:** alter one HashedAccounts value with any RW tool. Expect rc 4 with `accountMismatches ≥ 1`, plus a root mismatch.
4. **Real read-only run (separate authorization):** inputs are the 1660 RO view of `db/`, the **original** `static_files/` read-only, and `rocksdb/` read-only (or refused if missing on v2):
   ```
   base-state-readonly --db <RO>/db --static-files <RO>/static_files --rocksdb <RO>/rocksdb --out <scratch>/state.json --plain-hashed
   ```
   - Run it together with `base reth db repair-trie --dry-run`, requiring `Found 0 inconsistencies` and no `Inconsistency found` line; its rc is 0 even with inconsistencies (1678).
   - Run it in a queue lane that respects the 16 GiB host floor.

## Limitations (candid)
- **Compile correctness is unverified.** The likely failure points:
  - the exact module path `reth_db::mdbx::DatabaseArguments`;
  - `StaticFileProviderBuilder`'s generic `build::<EthPrimitives>()` and the `HeaderProvider` import from `reth_storage_api`;
  - the `cursor.first()/next()` signatures.

  A compile error is the expected first-iteration outcome; send me the log.
- **What the state root covers:** it uses **stored trie nodes**, exactly as repair_trie does. Root equality alone proves the stored root branch is consistent with the header. **Full** trie-vs-hashed coverage additionally needs `repair-trie --dry-run` with 0 inconsistencies. **Both are required.**
- **No canonical-authenticity proof:** the Finish header and its `stateRoot` come from this datadir's own static files. Without our own L1 anchor (G8: output root vs the L1 dispute game, derived from our own L1 data), a matching root is **self-consistency only** and **must not be accepted as canonical Base state.**
- **History integrity INCOMPLETE:** changesets, history indices (RocksDB on v2, **never opened**), receipts, transactions, bytecodes and the trie-update history are not checked.
- **The static-file ↔ MDBX `check_consistency` of `common.rs:214-223` is not run.** Use `base reth db static-file-header` or a RO command's "Inconsistent storage" warning as a fail signal (1678 G3).
- **Possible false fail:** the checkpoint coherence rule could false-fail if a v2 node does not maintain the hashing-stage checkpoints. That fails in the safe direction (rc 4), and the per-stage values are recorded for review.
- **Plain→hashed cost:** a random seek per plain entry over the whole state. Time and memory are not measured; it is bounded only by the root job's timeout and the queue lane.
- **v2 plain state:** not maintained (NOT_APPLICABLE). Plain-state RPC answers on a v2 DB have no plain table to verify.
