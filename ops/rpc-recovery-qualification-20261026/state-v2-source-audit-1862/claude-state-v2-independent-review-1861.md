# 1861: independent source review of the 1858 minimal corrections (base-state-readonly-stage/r10 vs pinned reth 7134be3)

**Scope of MY activity:** source reading only.
- **Inputs:**
  - r10 `src/main.rs` (`597a499a…`), `Cargo.toml` (`42dcdc8f…`), `src/bin/mk_fixture.rs` and `jobs/env.sh`;
  - pinned upstream `~/.cargo/git/checkouts/reth-babcd6134566c621/7134be3` (`git rev-parse` = `7134be3b51cf…`, the only reth source `env.sh:46` admits);
  - `alloy-consensus-2.4.1` (the `=2.4.1` pin, `Cargo.toml:21`).
- **Not done:** builds, tests, queue jobs, mounts, namespace changes, original/parts/backup reads, network, commits or edits.
- **Nothing here is PASS, canonical, or a full-integrity claim.** V2 stays PARTIAL:
  - `full` requires `plain.status == "PASS"` (`main.rs`, `let full = …`);
  - the v2 plain status is only `NOT_RUN` or `NOT_APPLICABLE_V2`;
  - so a v2 run can exit only 3, 4 or 5 (`main.rs:232`).
- **Taken as given, not verified by me:** the saved 376-file inventory with zero RocksDB entries.

## Verdicts per item

| # | 1858 item | verdict |
|---|---|---|
| 1 | StageCheckpoints key is `String`; use `.to_string()` | **CONFIRMED, and it is wider than 1858 says:** the r10 source does not type-check, and `mk_fixture` has the same defect |
| 2 | No RocksDB with zero index checkpoints is an expected snapshot shape | **CONFIRMED with refinements.** The zero index proves nothing about DB health, and an *optional* RocksDB component exists |
| 3 | Finish partial frontier via `reth-stages-types/partial-persistence` | **CONFIRMED necessary; the feature is safe and narrowly scoped.** Refuse on ANY `Some(p)`, an unknown variant, or the unwind marker (**the marker is new, not in 1858**) |
| 4 | Refuse on MerkleExecute progress | **REFINE:** refuse only if present **and non-empty**. Refusing when it is merely present is a false refusal |
| 5 | Report header `parentHash` / `withdrawalsRoot` | **CONFIRMED** as report-only fields; nothing may be claimed from them |
| — | Keep the 5-checkpoint equality | **CONFIRMED necessary but NOT sufficient**; that is why item 3 is required |

## 1. StageCheckpoints key: CONFIRMED (compile defect)

**The key type is `String`:**
- `db-api/src/tables/mod.rs:518-521`: `table StageCheckpoints { type Key = StageId; … }`, where `StageId` is the **db-api alias** `pub type StageId = String;` (`:622-623`), not the `reth_stages_types::StageId` enum (`stages/types/src/id.rs:10`).
- `StageCheckpointProgresses` is the same (`:524-527`).
- `DbTx::get<T: Table>(&self, key: T::Key)` (`db-api/src/transaction.rs:28`) takes exactly `T::Key`, so no conversion happens.
- Upstream always passes `.to_string()`: `provider.rs:2402-2404` and `:2362`, and `config_gen.rs:121`.

**Where r10 gets it wrong:** `main.rs:35` imports the enum, and `main.rs:181` passes `StageId::Finish`. The same defect is at `mk_fixture.rs:194` (`put::<tables::StageCheckpoints>(s, …)`).

**The consequence:** by these signatures, r10 (and r7, which is byte-identical) **cannot type-check** (a mismatched-types error). Any claimed r7–r10 helper build would contradict this, so root should confirm none exists. I did not build.

**Fix (two call sites):**
- `main.rs:181`: `StageId::Finish.to_string()`;
- `mk_fixture.rs:194`: `s.to_string()`.

**Unaffected:** `main.rs:177` (`k.to_string()` on a `String`) and `:183-184` (`s.to_string()` lookups on the map) are already correct.

## 2. No RocksDB with zero index checkpoints: CONFIRMED (refined)

**The upstream evidence:**
- **The reset:** `config_gen.rs:95-127`, `INDEX_STAGE_IDS = ["TransactionLookup","IndexAccountHistory","IndexStorageHistory"]`, "never distributed in snapshots". `reset_index_stage_checkpoints_tx` **puts** `StageCheckpoint::default()` (block 0) for each and deletes their progress rows. The test `:585-640` asserts that the rows exist with value 0.
- **When the reset runs:** `download/mod.rs:665-675` runs it when `should_reset_index_stage_checkpoints` is true. `:1027-1031` makes that true unless `RocksdbIndices` was selected as `All`.
- **Refinement:** RocksDB indices are *not* strictly "never" distributed. `manifest.rs:208-209,725-732` defines an **optional, archive-only** `rocksdb_indices.tar.zst` component. So "no RocksDB" is the shape of a download **without** that component. The rule therefore cannot be "v2 implies RocksDB is absent".

**What a zero index proves:** only that the history indices are absent or not built: either the download reset ran or the stages never ran. It says nothing about MDBX health, static files, receipts or history tables.

**The classified check** (replacing the hard refusal at `main.rs:171-172`; it must move below the checkpoint walk at `:174-179`, because it needs `checkpoints`):

| `--rocksdb` path state | the 3 index checkpoints | action |
|---|---|---|
| `CURRENT` exists | any | as now: `rocksdbCurrentPresent: true`, `rocksdbOpened: false` |
| path absent (`symlink_metadata` NotFound) | all 3 **present** and `== 0` | proceed, recording `rocksdbIndices: "ABSENT"` and `historyIndices: "NOT CHECKED"` |
| path absent | any missing or non-zero | **refuse (3)**: the DB claims indices it does not have |
| path exists but has no `CURRENT` (a non-empty dir, a file, or a symlink) | any | **refuse (3)**: ambiguous or partial copy |

**Never create or fabricate `CURRENT`, and never open RocksDB.** The output's `acceptance` string already says the RocksDB history indices are NOT checked; keep that.

## 3. Finish partial-state frontier: CONFIRMED necessary

### Why the 5-way equality cannot catch a partial state
- **The writer:** `save_blocks` (`provider.rs:600-607`) passes `Some(new_partial_state_trie)` **only when** `new_partial_state_trie < new_db_tip` (`:605-606`).
- **The checkpoints:** `save_blocks_inner` then calls `update_pipeline_stages(last_block_number, false)`.
  - That **upserts every `StageId::ALL` stage**, including Execution, AccountHashing, StorageHashing and MerkleExecute, to `last_block_number` (`provider.rs:2394-2413`).
  - It then writes Finish = `last_block_number` with `FinishCheckpoint { partial_state_trie: Some(p) }` (`:841-849`).
- **The result:** a DB whose hashed state and trie are only at `p` still shows **all five checkpoints equal** to Finish.
- **The unwind path** writes the same shape (`provider.rs:2419-2442`).

The equality stays necessary (`repair_trie.rs` `verify_checkpoints`: hashing == MerkleExecute), but it is not sufficient.

### Does enabling `partial-persistence` on `reth-stages-types` change codecs or unrelated behaviour? No, outside `FinishCheckpoint`
**The feature itself:** `stages/types/Cargo.toml:38`: `partial-persistence = []`. It adds no dependency, so the Base-lock package/source guard (`env.sh:36-47`) is unaffected, and an `--offline` build needs nothing new.

**Every `cfg` site in `reth-stages-types`:**
- `checkpoints.rs:446-453`: the derived `Compact` for `FinishCheckpoint`, used instead of the panicking impl at `:473-485`;
- `:461-468`: the accessor returns the field instead of `None`;
- `:515`: an `arbitrary(skip)` under test-utils only;
- `:728-761`: tests.

**The `StageUnitCheckpoint` enum** (`:491-519`) has the same variants and the same derive with or without the feature. `reth-codec` is already on via `db-api/Cargo.toml:20`, so the derive applies.

**Other crates' `partial-persistence` features are not enabled.** Cargo features flow from a dependent down to its dependencies, never back up:
- `provider/Cargo.toml:94-97`, `storage-overlay/Cargo.toml:53` and `node-core/Cargo.toml:93` stay off;
- their `cfg` sites are tests (`provider.rs:4114,4667,4889,4955,5006,5055`; `storage-overlay` `mod tests` at `provider.rs:254` and `builder.rs:608`) or CLI args (`engine.rs:332-339`).

**The write side of the codec also becomes enabled,** but the helper is read-only. `mk_fixture` gains the ability to write a frontier fixture.

**Without the feature, r10 already panics** on such a DB: the `StageCheckpoints` cursor walk (`main.rs:174-179`) decodes the Finish value → `from_compact` → `panic!` (`checkpoints.rs:482-484`). That is exit 101 (not 3), before any check.

### Equal, ahead or unknown frontier: refuse all
- **The writers:** they only ever write `Some(p)` with `p < Finish`: `provider.rs:605` (strict `<`) and `:2435` (strict `<`). The other `with_finish_stage_checkpoint` sites are tests (`launch/common.rs` from `:1461`; `storage-overlay` `mod tests`).
- **The node itself:**
  - `p > Finish` is an **error** (`launch/common.rs:1425-1430`);
  - `p < Finish` is a partial state that needs an unwind (`:1433-1440`);
  - `p == Finish` is treated as no partial state.
- **The decision:**
  - `Some(p)` with `p < Finish`: the state is at `p`, not at Finish → **refuse (3)**.
  - `p > Finish`: upstream calls it corrupt → **refuse (3)**.
  - `p == Finish`: no upstream writer produces it. Accepting it would rely on a writer we have not reviewed. **Refuse (3)**; the cost is only a false refusal on a shape never observed.
  - **Unknown:** a Finish row whose `stage_checkpoint` is `Some(<any non-Finish variant>)` → **refuse (3)**. The writers only produce `None` or `Finish(_)` (`provider.rs:842-848`; `stages/finish.rs:23,31` uses `StageCheckpoint::new`).
  - **Proceed only** on `stage_checkpoint == None`, or `Finish(FinishCheckpoint { partial_state_trie: None })`.
- **NEW, not in 1858: the unwind marker.** `launch/common.rs:1444` is the Metadata key `"partial_state_trie_unwind"`. Its comment (`:551-553`) says "Finish is committed before Merkle during unwind, so this marker is authoritative". If `tables::Metadata` has that key (any value) → **refuse (3)**: a partial-trie unwind was interrupted, and Finish may already be lowered while the trie is not. This is one read-only `tx.get::<tables::Metadata>("partial_state_trie_unwind".to_string())`.
- **Robustness:** read the **pub field** `f.partial_state_trie` (`checkpoints.rs:456`), not the accessor `partial_state_trie()`. The accessor silently returns `None` if the feature were ever dropped (`:466-468`). With the field, a missing feature can only panic (fail-closed), never pass silently.
- **Report:** `finishFrontier: "none"` (or the refusal text).

## 4. MerkleExecute progress: REFINE ("non-empty", not "present")
- **Upstream's rule:** `repair_trie.rs:199-205` refuses **only** `progress.is_some_and(|p| !p.is_empty())`.
- **Present and empty is normal:** `migrate_v2.rs:349` explicitly writes `save_stage_checkpoint_progress(StageId::MerkleExecute, vec![])`, so an empty row is "not in progress". Refusing because it is merely present would falsely refuse every v2-migrated DB.
- **Implementation:** `tx.get::<tables::StageCheckpointProgresses>("MerkleExecute".to_string())`. `Some(v) if !v.is_empty()` → **refuse (3)**; record `merkleProgressBytes: len|null`.
- **No refusal on the other stages' progress rows:** upstream does not gate them. Report only, if desired.

## 5. Header fields: CONFIRMED, report-only
- **The fields:** `alloy-consensus-2.4.1/src/block/header.rs:30` is `parent_hash: B256`, and `:96` is `withdrawals_root: Option<B256>`.
- **The output:** add `tipHeader.parentHash` and `tipHeader.withdrawalsRoot` (a string or `null`).
- **No claim follows.** Parent linkage and the withdrawals root are **not verified**; the Finish header remains not proven canonical (keep the `acceptance` text).

## Minimal safe implementation plan (a new stage revision; r10 stays frozen)
1. **`Cargo.toml`:** `reth-stages-types = { git…, tag = "base-v2.5.2.8", features = ["partial-persistence"] }`. No other dependency or feature changes.
2. **`main.rs:181`:** use `StageId::Finish.to_string()`, and keep the whole `StageCheckpoint` (`fc`), not just `.block_number`. **`mk_fixture.rs:194`:** `s.to_string()`.
3. **After the walk (`:179`), with every refusal exiting 3 through the existing `refuse()` (`main.rs:50-52`):**
   - the RocksDB classification table (§2);
   - the unwind-marker refusal;
   - the `fc.stage_checkpoint` frontier match (§3);
   - the non-empty MerkleExecute progress refusal (§4).
4. **Keep unchanged:**
   - `coherent` (the 5-way equality);
   - `root_ok = from_hashed == header.state_root` with the header at Finish;
   - the Verifier `cache_ok`;
   - the `cached_consistent` diagnostic;
   - exit-code logic, so v2 can only return 3, 4 or 5 (PARTIAL).
5. **Output:** add `rocksdbIndices`, `historyIndices: "NOT CHECKED"`, `finishFrontier`, `merkleProgressBytes`, `tipHeader.parentHash` and `tipHeader.withdrawalsRoot`. Bump `format`.
6. **Fixtures (minimum):**
   - **split `v2-no-rocksdb`:** with the three index checkpoints written as 0 → the state result (expected 5); with one missing or non-zero → 3;
   - `finish-frontier-lt` → 3, `finish-frontier-eq` → 3 and `finish-frontier-gt` → 3 (written via `with_finish_stage_checkpoint`, which works now that the feature is on);
   - `merkle-progress-nonempty` → 3, `merkle-progress-empty` → not refused;
   - `unwind-marker` → 3;
   - `rocksdb-dir-without-CURRENT` → 3.

   `mk_fixture` currently writes no index checkpoints (`:192-195`) and skips RocksDB only for `v2-no-rocksdb` (`:223-226`).

**Not proposed:** opening RocksDB, fabricating `CURRENT`, any history, receipt or canonical check, or touching r10.

## Unresolved questions (stopped searching here)
1. **Has any r7–r10 helper build actually compiled?** By the signatures above it cannot have. If root holds a successful build of this source, something in §1 is wrong and must be re-checked.
2. **Encoding of a real Finish row:** whether the real snapshot's Finish row carries `Finish(_)`, and whether its producing binary's `FinishCheckpoint` encoding matches 7134be3's derived `Compact`, are unknown until it is read. A mismatched or unknown variant (or a future variant index) panics in decode (exit 101), not 3. Still fail-closed, but **the gate must treat any rc outside {3,4,5} as failure.** I did not re-check `bsro_gate`'s rc mapping for 101. Wrapping the walk in `catch_unwind` → `refuse` would be an optional nicety.
3. **The remaining gaps in the zero-index rule:** `PruneCheckpoints` deletion (`config_gen.rs:129-131`) and `SenderRecovery` are not part of it, which is intentional. The rule still cannot tell "the download reset ran" from "the stages never ran"; both mean the history is NOT CHECKED, and neither is a health signal.
4. **A cross-check left out:** on Base (OP Isthmus), `withdrawalsRoot` is the L2ToL1MessagePasser storage root and could be cross-checked against the hashed storage trie. That would be a new check, so it is out of scope here.
