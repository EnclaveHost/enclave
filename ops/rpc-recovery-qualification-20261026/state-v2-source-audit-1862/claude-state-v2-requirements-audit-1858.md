# 1858: are the v2 RocksDB `CURRENT` guard and the 5-way checkpoint equality real prerequisites for the helper's read-only MDBX state checks? (SOURCE-ONLY AUDIT)

**Scope:**
- **Inputs:** `base-state-readonly-stage/r10/src/main.rs` (`597a499a…`, = r7); `Cargo.toml`; `jobs/env.sh` (cache path).
- **Upstream:** pinned reth **7134be3** at `~/.cargo/git/checkouts/reth-babcd6134566c621/7134be3` (the same tree 1678/1695 read).
- **Context:** reports 1678, 1695 and 1855.

**What this is not:**
- No build, test, mount, namespace, queue, network, install or commit.
- No read of the original or the parts. The recovered DB's `Metadata` and `Finish` are **NOT YET READ**.
- No new stage; frozen stages untouched.
- Nothing here claims full integrity or canonical state.

## 1. The v2 `rocksdb/CURRENT` guard (`main.rs:171-172`): NOT a prerequisite for the state checks; a potential FALSE REFUSAL
**What upstream keeps in RocksDB under v2: history indices only.**
- `crates/storage/db-api/src/models/metadata.rs:17-26` (doc of `storage_v2`): *"History indices in `RocksDB` (accounts, storages, transaction hashes)"*; *"Hashed state tables as canonical state representation"*.
- `metadata.rs:68-92`: `storages_history_in_rocksdb`, `transaction_hash_numbers_in_rocksdb`, `account_history_in_rocksdb` and `any_in_rocksdb` are the only RocksDB routings.
- `metadata.rs:83-87`: `use_hashed_state()` == v2.

**What the helper's checks read, all MDBX or static files:**
- the hashed-only root: `HashedAccounts`/`HashedStorages` through `DatabaseHashedCursorFactory`;
- the trie-cache Verifier: the trie tables through `DatabaseTrieCursorFactory<_, A>`. Under v2, `PackedKeyAdapter` maps to `PackedAccountsTrie`/`PackedStoragesTrie`. These are *"separate 'view' types … that share the same MDBX table name"* (`crates/trie/db/src/trie_cursor.rs:140-158`);
- `StageCheckpoints` and `Metadata` (MDBX);
- the tip header (`StaticFileProviderBuilder::read_only`).

**None of them touches RocksDB, and the helper never opens it** (`main.rs:18`, `:212`).

**The snapshot ships without RocksDB by design:**
- `crates/cli/commands/src/download/config_gen.rs`, `INDEX_STAGE_IDS` = `TransactionLookup`, `IndexAccountHistory`, `IndexStorageHistory`. Its doc: *"Stage IDs for index stages whose output is stored in RocksDB and is never distributed in snapshots."*
- `reset_index_stage_checkpoints_tx` puts `StageCheckpoint::default()` (block 0) for those three, and deletes their progress and prune checkpoints.
- With `rocksdb_indices` not selected (1855 §1), a missing `rocksdb/CURRENT` is the **expected** state of a correct snapshot datadir.

**Verdict:**
- **Justified refusal** only for *history* reads (the guard's own reason: "history indices would read empty"). This helper performs none.
- For the hashed-root, trie-cache, checkpoint and header scope, the guard is a **potential false refusal** (rc 3). The empty-RocksDB hazard in 1678 §1b (`common.rs:146-158` creates an empty DB) applies to the `base reth db …` CLI, not to this helper.
- **Do not fabricate `CURRENT`.**

## 2. The checkpoint equality `Execution == MerkleExecute == AccountHashing == StorageHashing == Finish` (`main.rs:183-184`): JUSTIFIED, not a v2 false failure
**v2 hashing stages still advance their checkpoints:**
- `crates/stages/stages/src/stages/hashing_account.rs:166-170` and `hashing_storage.rs:96-100`: when `use_hashed_state()`, they return `ExecOutput::done(checkpoint.with_block_number(target))`. They are no-ops that **reach the target**.

**Engine persistence moves every stage:**
- `provider.rs` `update_pipeline_stages` upserts **every** `StageId::ALL` entry to the persisted block (`crates/stages/types/src/id.rs:46-62`; that list includes Execution, AccountHashing, StorageHashing, MerkleExecute and Finish).

**Upstream's own precondition:**
- `crates/cli/commands/src/db/repair_trie.rs:175-205`, `verify_checkpoints`, requires `AccountHashing == MerkleExecute`, `StorageHashing == MerkleExecute`, **and no in-progress `MerkleExecute` checkpoint progress**.

**Verdict:**
- The equality is the right precondition for "the hashed state and trie represent block Finish". The root is compared with `header(Finish)` (`main.rs:188`, `:198`). I **withdraw** the 1695 worry that v2 might false-fail it.
- **Missing upstream check:** the helper does not require `StageCheckpointProgresses[MerkleExecute]` to be empty (`repair_trie.rs` ≈`:197-202`).
- **Excluded, correctly:** the three index stages (0 after the snapshot reset), which are history-only.

## 3. NEW: the `Finish` partial-persistence frontier, which can cause a misreported FAIL or a decode abort
**What a partial frontier means:**
- `crates/storage/provider/src/providers/database/save_blocks.rs:8-30`: `Finish.partial_state_trie` *"tracks the hashed-state/trie frontier, which may lag behind"* the Finish block.
- While a masking suffix exists, *"the hashed-state/trie tables are not a complete snapshot at `db_tip`"*. Updates overwritten by the suffix are also omitted, so they are **not** an exact snapshot at the frontier block either.

**How it is written:**
- `provider.rs:842-848` writes `StageCheckpoint::new(tip).with_finish_stage_checkpoint(FinishCheckpoint{partial_state_trie: Some(p)})` only when `p < tip` (`:605-606`).

**Decoding it:**
- `crates/stages/types/src/checkpoints.rs:454-484`: without the cargo feature `partial-persistence`, `FinishCheckpoint` `to_compact`/`from_compact` **panic**, and `partial_state_trie()` returns `None`.
- The feature is off by default (`stages/types/Cargo.toml:37-38`; `provider/Cargo.toml:94-97`).
- The helper's `Cargo.toml` does not enable it.
- A bounded grep of the cached Base workspace's `Cargo.toml` files found no `partial-persistence`. So the production binary probably cannot write such a checkpoint; this is **inference**.
- The snapshot was produced elsewhere (`reth_version 2.5.2-dev (7134be3)`; features unknown).

**Consequences:**
- **If the recovered `Finish` carries a unit checkpoint:** reading `StageCheckpoints` aborts the helper with a panic (fail-closed, but undiagnosed).
- **If decoded with `p < Finish`:** a root mismatch would be reported as FAIL (rc 4), when the correct verdict is **refusal: the DB alone is not a complete state snapshot**.
- **Status: UNKNOWN until the recovered `Finish` is read.**

## 4. Compile/API mismatches visible (no build)
- **`main.rs:181` will not type-check.** It calls `tx.get::<tables::StageCheckpoints>(StageId::Finish)`, but the table key is `tables::StageId = String` (`crates/storage/db-api/src/tables/mod.rs:518-521`, `:623`). Upstream writes `stage_id.to_string()` (`config_gen.rs`). The fix is `StageId::Finish.to_string()`.
- **APIs that match:**
  - `Verifier::new(&T, H) -> Result<_, DatabaseError>` (`crates/trie/trie/src/verify.rs:314-330`);
  - `DatabaseTrieCursorFactory<T, A: TrieKeyAdapter>::new(tx)` (`trie/db/src/trie_cursor.rs:160-172`);
  - `TrieTableAdapter: TrieKeyAdapter`, exported with `LegacyKeyAdapter`/`PackedKeyAdapter` (`trie/db/src/lib.rs:22-24`);
  - `NoopTrieCursorFactory` exists (`trie/trie/src/trie_cursor/noop.rs:9`; the public module path is **not verified**);
  - `with_adapter!` uses v2 → `PackedKeyAdapter` (`trie/db/src/lib.rs:42-55`), which matches `main.rs:192,197`.
- **Not re-checked here:** everything else, including `open_db_read_only`/`DatabaseArguments` paths and `StaticFileProviderBuilder::build`. **Only an actual offline build decides.**

## 5. Proposed minimal read-only scope and conditions (SOURCE PLAN ONLY; a future reviewed revision, not now)
1. **Key fix:** `StageId::Finish.to_string()` (§4).
2. **Replace the blanket v2 `CURRENT` refusal with a classified check.** If v2 and `CURRENT` is absent:
   - continue **only if** `TransactionLookup`, `IndexAccountHistory` and `IndexStorageHistory` are each present and == 0 (the snapshot reset, `config_gen.rs`);
   - report `historyIndices: "ABSENT (snapshot without rocksdb_indices) - NOT CHECKED"`;
   - otherwise refuse (indices were built but are missing: a justified refusal).

   No `CURRENT` is ever created, and RocksDB is never opened.
3. **Finish frontier:**
   - decode the `Finish` row so that a unit checkpoint is readable (enabling `reth-stages-types/partial-persistence` for decode only is one option; it needs review as a feature deviation from production);
   - refuse (rc 3, "partial persistence: not a complete state snapshot") if `partial_state_trie = Some(p)` and `p < Finish`;
   - record the raw values.
4. **Add the upstream precondition:** `StageCheckpointProgresses[MerkleExecute]` absent or empty, else refuse (a pipeline still in progress).
5. **Keep:**
   - the 5-way equality;
   - the hashed-only root == `header(Finish).stateRoot`;
   - the Verifier with 0 inconsistencies;
   - cachedWalk as diagnostic only;
   - **v2 never exits 0** (plain `NOT_APPLICABLE` → max rc 5 PARTIAL);
   - the acceptance text "NOT A CHAIN ACCEPTANCE".
6. **Reporting only:** add `tipHeader.withdrawalsRoot` and `parentHash` (the message-passer root and the anchor chain inputs per 1855). The helper still never claims canonical state.
7. **Fixture impact:** the existing `v2-no-rocksdb` fixture expects rc 3 (1719). Under item 2 it needs a split: index checkpoints 0 → proceeds to PARTIAL; index checkpoints > 0 → rc 3.

## 6. Unknowns
- The recovered DB's `storage_settings`, its `Finish` value, whether `Finish` has a unit checkpoint, the five checkpoint values and the `MerkleExecute` progress. All are **not yet read**; they come from the first helper or RO `db stage-checkpoints` run after the data gates.
- The snapshot producer's cargo features.
- Remaining compile issues (needs a build).
- Whether `base reth db stage-checkpoints` (production binary, no feature) would also panic on a `Finish` unit checkpoint. **Inference:** the same decode path, so yes.
