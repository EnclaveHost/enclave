# 1719: base-state-readonly-stage/r3, positive and negative tiny reth-7134 fixtures for the compiled helper (SOURCE ONLY; nothing built or run)

**Stage:** `base-state-readonly-stage/r3/`, **SHA256SUMS sha256 `833c759e173e387dd1a8cec0acf9c5c4dec56c117c5f9efe5e682e0776d5eb18`** (files 0444, jobs 0555).
- **Frozen r2:** unchanged (`34dbf6e0…`, re-verified).
- **What I did:** read source, wrote files, ran `bash -n` and an `ast` check of the embedded Python. **Nothing compiled. No tests, no live access, no USB, and no reads of the original.**

## r3 = r2 plus
| file | sha256 | change |
|---|---|---|
| `src/bin/mk_fixture.rs` | `d0169968…` | **new**: writes ONE disposable tiny datadir per case (details below) |
| `src/main.rs` | `39ce7b22…` | (a) exit **5 = PARTIAL** when plain→hashed is `NOT_RUN` or `NOT_APPLICABLE` (v2) with root and checkpoints passing; new `fullStateIntegrity` (true **only** for rc 0). In r2 a v2 `NOT_APPLICABLE` run exited **0**, which could be read as full integrity. (b) a missing or unreadable tip header is a **refusal (3)** whether the provider returns `Ok(None)` or an error; r2 would have exited 1 on an error. Everything else is byte-for-byte r2 (diff checked) |
| `Cargo.toml` | `c4622641…` | adds `reth-primitives-traits =0.6.0`, `reth-static-file-types` and `reth-trie-common` (7134be3 git), all **in the Base lock** (`f122da76…`) |
| `jobs/build.sh` | `38fa795f…` | `--bins`; copies `src/bin/`; outputs both binaries. All r2 guards are unchanged: Base-lock-only resolution, the reth source = 7134be3, the cached crate store must be unmodified, `--offline -j 4`, 7200 s |
| `jobs/positive.sh` | `92b4d4ae…` | **new**: 10 runs over 9 cases on the **compiled** binaries |
| `jobs/fixtures.sh` | `d68a5dfb…` | r2's negative refusals, relabelled |

**What `mk_fixture` writes** (one disposable datadir per case):
- **MDBX:** `reth_db::init_db` with the pinned `tables`: `Metadata.storage_settings` (v1 or v2 JSON), `PlainAccountState`/`PlainStorageState` (v1 only), `HashedAccounts`/`HashedStorages`, and the `Execution`/`AccountHashing`/`StorageHashing`/`MerkleExecute`/`Finish` checkpoints = 2.
- **Static-file headers 0..=2,** written through `StaticFileProviderBuilder::read_write` → `get_writer(0, Headers)` → `append_header`. That is the same path as reth's `insert_genesis_header` (`db-common/src/init.rs:470-505`). Header 2 carries the state root.
- **No `mdbx.lck`:** it is removed, like the real view.
- **v2 only:** a placeholder `rocksdb/CURRENT`. The helper only checks that it exists and never opens RocksDB.
- **`expected.json`.**
- **Never touched:** anything outside the NEW dir it creates (it refuses if the dir exists).

**State:** 3 accounts (one with bytecode hash) and 3 storage slots.

**The expected root is computed independently** of `reth_trie::StateRoot`:
- it uses alloy-trie 0.9.5 `HashBuilder` (`reth_trie_common::root::{state_root_unsorted, storage_root_unsorted}`) over the **hashed tables as written**, via `Account::into_trie_account`;
- the trie tables are left empty, so `StateRoot` derives every node from the hashed tables, as for genesis.

That isolates plain/hashed defects from the root check, and checks the helper's computed root against code that is not the helper's.

## Cases (`jobs/positive.sh`; every expectation must hold exactly)
| run | rc | computed root == independent | header match | coherent | plain | counts / mismatches |
|---|---|---|---|---|---|---|
| `v1-pass` | **0** (FULL) | yes | yes | yes | PASS | 3=3 accounts, 3=3 slots, 0/0 |
| `v1-pass-noplain` (no `--plain-hashed`) | **5** | yes | yes | yes | NOT_RUN | — |
| `v1-plain-modified` (plain slot value 0x43 vs hashed 0x42) | **4** | yes | yes | yes | FAIL | slot mismatches 1, counts equal |
| `v1-hashed-missing` (one hashed slot absent) | **4** | yes | yes | yes | FAIL | slots 3 vs 2, slot mismatches 1 (forward direction) |
| `v1-hashed-extra` (extra hashed account, no plain) | **4** | yes | yes | yes | FAIL | accounts 3 vs 4, mismatches 0 (**reverse direction caught by the exact count**) |
| `v1-wrong-root` (header root byte flipped) | **4** | yes | **no** | yes | PASS | |
| `v1-checkpoint-mismatch` (StorageHashing = 1) | **4** | yes | yes | **no** | PASS | |
| `v2-not-applicable` | **5** | yes (PackedKeyAdapter) | yes | yes | NOT_APPLICABLE, plain entries 0/0 | `fullStateIntegrity` false |
| `v1-no-header` (Finish header 2 absent) | **3** | — | — | — | — | no result file |
| `v2-no-rocksdb` | **3** | — | — | — | — | no result file |

**Checked in every run:**
- `fullStateIntegrity` is true only for rc 0;
- the adapter is Legacy/Packed as appropriate;
- the tip header is the fixture's;
- **the fixture dir was ST_RDONLY** (bind-remounted read-only in a private mount namespace);
- **its tree is byte-identical after the run.**

r2's `fixtures.sh` refusals (empty db, missing static files, relative path, unknown arg, existing `--out`, corrupt `mdbx.dat`) are preserved.

## Root jobs (shared queue; in order)
```
bash jobs/q-exit-status.sh bsro-r3-build    4096 unshare -Urn  bash base-state-readonly-stage/r3/jobs/build.sh
bash jobs/q-exit-status.sh bsro-r3-fixtures  512 unshare -Urn  bash base-state-readonly-stage/r3/jobs/fixtures.sh  <ABS runs/build-…/base-state-readonly>
bash jobs/q-exit-status.sh bsro-r3-positive  512 unshare -Urnm bash base-state-readonly-stage/r3/jobs/positive.sh  <ABS runs/build-…/>
```
- `positive.sh` writes fixtures only under a fresh `/tmp/bsro-r3-pos-*` (unique name, refuses if it exists).
- It unmounts and removes that directory at the end, and copies the expected, result and log files to `runs/positive-*`.
- Expect `## cases=10 failed=0`.

## Explicit unknowns (compile and runtime), to be settled by root's build and run
1. **Never compiled.** The likely first-iteration errors are:
   - module paths: `reth_db::mdbx::DatabaseArguments`, `reth_provider::providers::{StaticFileProviderBuilder, StaticFileWriter}`, `reth_trie_common::root::*`;
   - the `StaticFileProviderRWRefMut` deref for `append_header`;
   - `TrieAccount` type identity between reth-primitives-traits 0.6.0 and alloy-trie 0.9.5 (one version each in the lock);
   - `Header` field defaults;
   - the `StageId` Display used for checkpoint keys.
2. **MDBX read-only open without `mdbx.lck` on an ST_RDONLY mount.** reth's RO mode is `Mode::ReadOnly` (`mdbx/mod.rs:408`). Whether libmdbx opens lck-less there was **not verified**. `mdbx_chk` (r4) works there, but it opens exclusive. **This fixture is exactly what will reveal it**, and it bears directly on the real read-only view.
3. **Duplicate puts:** `tx.put` on the DupSort tables is assumed to add duplicates (distinct subkeys). If not, the counts in `expected.json` versus the result will expose it.
4. **Root semantics:** the empty-trie `StateRoot` behaviour (full derivation from hashed state) is the genesis behaviour by design; the independent root equality tests it.

## What the fixtures qualify, and what they do not
**Qualified once `positive.sh` passes:**
- the helper computes the **official** reth 7134 root, equal to an independent alloy-trie root;
- it detects a wrong header root and incoherent checkpoints;
- it finds plain→hashed **value** errors, **missing** hashed entries and **extra** hashed entries (both directions);
- it marks v2 PARTIAL, never full;
- it refuses missing stores or headers;
- it leaves read-only inputs untouched.

**Not qualified:**
- **Scale:** tiny state only. Stored trie nodes (non-empty `AccountsTrie`/`StoragesTrie`) are not exercised; the real DB uses them. The real run therefore still needs `repair-trie --dry-run` = `Found 0 inconsistencies`.
- **History:** changesets, receipts, transactions and RocksDB history are not covered.
- **Canonicality:** a matching root is **self-consistency**. Without our own L1 anchor it is never proof that the Finish header is canonical Base.
- **Data contents:** the real candidate's 21:41 PASS is allocation and metadata only, not contents.
