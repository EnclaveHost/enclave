# 1864: base-state-readonly-stage/r11, the v2 state-scope corrections (SOURCE ONLY; UNCOMPILED; tests PREPARED, NOT RUN; production HOLD)

**Status:** r11 implements the 1858 audit as refined by the independent review 1861, plus root's fixture note 1863.

**What I did not do:**
- no compile, test, build, queue job, mount, namespace change, network, install, data/original/part read, host change or commit;
- I did not touch the queued r10 ns-tests job.

**No claim here:**
- **No compiled Rust build of r7–r11 exists.** The r8 PASS qualified only the wrappers. r7–r10 `main.rs`/`mk_fixture.rs` could not type-check (1861 §1).
- Nothing here is PASS, health, full integrity or canonical state.

## Frozen stage
- **r11 SHA256SUMS sha256:** `base-state-readonly-stage/r11/` → **`246ff06b4df2869596af7f8fdbc784af349bfe88c071e5660ae982048cfa1ced`**
- **Contents:** 22 files, all a-w. SUMS excludes itself. Created from the verified r10 source; no runs, builds, target or `__pycache__`.
- **Preserved:** r10 SUMS `0034b392…` and r9 `f7470ced…` still verify clean.

**Files that changed in substance:**

| file | sha256 | change |
|---|---|---|
| `src/main.rs` | `5a6fa214e913ffe23048257c2feb73548526e72afd56e6736b05eef89ae52d66` | the helper (below) |
| `src/bin/mk_fixture.rs` | `0ff71a1854b0231d50ce6b3e0abd4d49efba35af55492fa7ce5149dda23cb173` | the key fix + 12 cases + `tipParentHash` in `expected.json` |
| `Cargo.toml` | `0a62e36bf1d870b2e02f0261918b66bf503b27b5ac51998e871027c0792e7661` | ONLY `reth-stages-types` gains `features = ["partial-persistence"]` (+1 comment line) |
| `jobs/positive.sh` | `24b8c3e95783be0e7d7f9ab3c3261228e2d3a9f6c9e28836e4af80e3b2d67c42` | the typo fix + 12 runs + reason/report checks |
| `README.md` | `ab7ac133e1179d59504d98aa3e60ef070c29a5e1983624de8d046ce12a47ad1e` | the r11 section; commands → r11 |

**Label-only changes** (checked by `diff` after normalising r10→r11):
- `jobs/bsro_gate.py` (`42cf6b47…`), `build.sh`, `build-inner.sh`, `build-outer.sh`, `env.sh`, `fixtures.sh`, `guard-tests.sh`, `ns-tests.sh`, `ns.sh` and `preflight.sh`;
- `tests/test_bsro_gate.py` (`488b01b0…`) and `tests/test_ns.py`.

What those labels are:
- the stage path `base-state-readonly-stage/r11`;
- the job names `bsro-r11-*`;
- the receipt formats `bsro-{guard-test,ns-test}-receipt/r11` and `bsro-build-{accounting,receipt}/r11`.

**Kept as they were:** the composite-stage `r10MemoryGate` pin and the r10 history comments.

**Byte-identical to r10:** `jobs/disk_guard.py`, `jobs/mount_identity.py`, `tests/test_disk_guard.py`, `tests/guard_wrapper.py` and `tests/test_mount_identity.py`.

**Unchanged storage, build, gate, resource and capture behaviour:**
- the all-265 completion gate;
- the 16 GiB host floor, the 40 GiB disk floors, the 8 GiB native root reservation and the /vm guard;
- the 4096 exclusive main lane;
- capture ownership.

## Exact helper changes (`src/main.rs`), checked against cached reth 7134be3
1. **String keys (both, 1861 §1):**
   - `main.rs`: `tx.get::<tables::StageCheckpoints>(StageId::Finish.to_string())`;
   - `mk_fixture.rs`: `put::<tables::StageCheckpoints>(s.to_string(), …)`.

   The db-api key is `pub type StageId = String` (`db-api/src/tables/mod.rs:518-527,623`), and `DbTx::get(key: T::Key)` (`db-api/src/transaction.rs:28`).
2. **The feature:** `reth-stages-types` `partial-persistence` (`stages/types/Cargo.toml:38`, `= []`, no dependency). It only enables the `FinishCheckpoint` `Compact` codec (`checkpoints.rs:446-485`). Cargo features do not propagate upward, so the provider, storage-overlay and node-core features stay off.
3. **Refusals (exit 3, through the existing `refuse()`), all BEFORE the header read and the root/cache computation:**
   - **(a)** `tables::Metadata["partial_state_trie_unwind"]` is present, with any value (`node/builder/src/launch/common.rs:1444`).
   - **(b)** The Finish row (`fc`, the whole `StageCheckpoint`):
     - proceed **only** on `stage_checkpoint == None` or `Some(StageUnitCheckpoint::Finish(FinishCheckpoint { partial_state_trie: None }))`;
     - **any** `Some(p)` (lt, eq or gt) → refuse;
     - any other variant → refuse.

     The pub **field** is matched, not the accessor. Types and exports: `stages/types/src/lib.rs:19-23`; `checkpoints.rs:375-380,454-457,491-519`; no `non_exhaustive`.
   - **(c)** `tables::StageCheckpointProgresses[StageId::MerkleExecute.to_string()]` (`Vec<u8>`, `tables/mod.rs:524-527`): refuse **only** when it is present AND non-empty. Empty or absent is fine.
   - **(d)** v2 RocksDB classification:

     | condition | result |
     |---|---|
     | `--rocksdb` is a real directory (`symlink_metadata`) with a regular `CURRENT` | `PRESENT` (not opened) |
     | the path is NotFound AND `TransactionLookup`, `IndexAccountHistory` and `IndexStorageHistory` are all **present** with block 0 | `ABSENT` |
     | the path is NotFound and those checkpoints are not all present and 0 | refuse |
     | the path is unreadable | refuse |
     | anything else at the path (a dir without `CURRENT`, a file, a symlink) | refuse |

     The `StageId` display names match the downloader's literals (`stages/types/src/id.rs:93-98,138-142`; `config_gen.rs` `INDEX_STAGE_IDS`). v1: `NOT_APPLICABLE_V1` (not inspected). RocksDB is never opened or created, and `CURRENT` is never fabricated.
4. **Unchanged:**
   - the checkpoint walk; a decode error or panic stays fail-closed (nothing is caught or suppressed);
   - the 5-way coherence;
   - the static-file tip-header refusal;
   - the hashed-only root == `header(Finish).stateRoot`;
   - the mandatory trie-cache Verifier;
   - the cachedWalk diagnostic;
   - the exit logic. **v2 can only exit 3, 4 or 5 (never 0 / full).**
5. **Output** (format `base-state-readonly/r11`):
   - `rocksdbClassification` and `historyIndexCheckpoints`;
   - `historyIndices` ("NOT CHECKED … zero index checkpoints … are NOT a health signal");
   - `unwindMarkerPresent`, `finishUnitCheckpoint`, `finishFrontier` and `merkleExecuteProgressBytes`;
   - `tipHeader.parentHash` and `tipHeader.withdrawalsRoot` (`alloy-consensus 2.4.1` `Header.parent_hash` / `withdrawals_root: Option<B256>`, per 1861 §5), plus a note that they are not verified and not canonical.

   The `acceptance` "NOT A CHAIN ACCEPTANCE" text is unchanged.

## Fixtures (`mk_fixture.rs`): new synthetic dirs only when root eventually runs them; none created now
The new v2 cases reuse v2-not-applicable's state, with only the named row or path changed:
- `v2-no-rocksdb-index-reset`: the 3 index rows = `StageCheckpoint::default()`, as `config_gen.rs` `reset_index_stage_checkpoints_tx` writes them;
- `v2-no-rocksdb-index-nonzero`: `IndexStorageHistory` = TIP;
- `v2-no-rocksdb-index-one-missing`;
- `v2-rocksdb-no-current`: index reset + a `rocksdb/` dir holding only an empty `LOCK`;
- `v2-frontier-{lt,eq,gt}`: `Some(1 | 2 | 3)` with TIP = 2;
- `v2-finish-none`;
- `v2-finish-unknown-variant`: `Entities{processed:1,total:1}`;
- `v2-merkle-progress-{nonempty,empty}`: `[1,2,3]` / `[]`;
- `v2-unwind-marker`: a JSON value.

**Unchanged:** the existing `v2-no-rocksdb` case still writes no index checkpoints, so it still refuses (now for the named reason). The `rocksdb/CURRENT` placeholder in the other v2 fixtures is fixture-only, as in r10.

**Typed API used, checked:**
- `StageCheckpoint::default().with_block_number(n)` (`checkpoints.rs:369,389`);
- `StageUnitCheckpoint::{Finish, Entities}` and `EntitiesCheckpoint{processed,total}` (`:312-317`);
- `put::<tables::Metadata>(String, Vec<u8>)` (`tables/mod.rs:549-552`).

## Prepared tests (NOT RUN; counts only)
**`jobs/positive.sh`:** **26 runs over 25 cases** (r10: 14 runs / 13 cases).
- **Expectations kept:** the existing ones stay. `v1-no-header` → 3 and `v2-no-rocksdb` → 3 now must also name their reason.
- **Typo fix (root 1863):** `v2-not-applicable` now expects `NOT_APPLICABLE_V2`, still with exit 5 and `fullStateIntegrity` false.
- **Exit 5, state-only and never full:** `v2-no-rocksdb-index-reset`, `v2-finish-none` and `v2-merkle-progress-empty`. They are checked for:
  - the classification prefix, the Finish unit and the progress bytes;
  - plain tables empty;
  - `parentHash` equal to the fixture's;
  - `withdrawalsRoot` null;
  - the reset zeros reported.
- **Exit 3, each with its reason substring in the helper stderr:** the nine refusal cases (index nonzero / one missing, RocksDB without `CURRENT`, frontier lt/eq/gt, unknown variant, non-empty progress, unwind marker).
- **Unchanged guards:** read-only bind, tree unchanged, no result file on refusal.

**Other suites, unchanged:**
- `fixtures.sh` (6 negative argument cases);
- guard-tests 10 + 6 + 16;
- ns-tests 5.

**The commands** (README; order and lanes as before):
- `bsro-r11-guard-tests 256 …r11/jobs/guard-tests.sh`;
- `bsro-r11-ns-tests 512 …r11/jobs/ns-tests.sh`;
- only after all 265 parts are CONFIRMED and the reviews are done: `build-outer.sh preflight`/`build` on 4096, then `positive.sh <guard.outDir>` (512) and `fixtures.sh`.

The r11 receipts bind r11's SUMS, so r11 needs its own wrapper receipts. r10's do not carry over.

## Limitations
- **Uncompiled.** Type-checking is by reading signatures only. Points a build may still reject:
  - match ergonomics/`!` coercion in the new `match` arms;
  - `json!` of `Option<usize>`/`Option<String>`;
  - the `matches!` guards over `io::Result<Metadata>`;
  - the parts not re-checked in 1858/1861 (`open_db_read_only` path, `StaticFileProviderBuilder::build`).

  Send the compile log.
- **A real Finish row encoded differently**, or an unknown or future variant index, panics in decode (exit 101, not 3). That is fail-closed. **The gate or root must treat any rc outside {3,4,5} as failure** (1861 Q2). I did not change `bsro_gate`.
- **The zero-index rule** cannot tell "the download reset ran" from "the stages never ran"; both mean history NOT CHECKED. It also does not inspect `PruneCheckpoints` or `SenderRecovery`.
- **The empty MerkleExecute progress fixture** relies on MDBX accepting a zero-length value. Upstream writes `vec![]` (`migrate_v2.rs:349`, per 1861), but this is unrun here.
- **The recovered DB's** `Metadata`, Finish, index checkpoints and progress are **NOT YET READ**. Nothing is inferred about it from source or fixtures.
- **Production stays on HOLD:** no build until all 265 parts are CONFIRMED, the reviews are done, and actual r11 wrapper and compiled-fixture passes exist.
