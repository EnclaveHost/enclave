# 1865: independent source review of base-state-readonly-stage/r11 vs r10 and the 1861 plan (author 1864)

**Scope of MY activity:** source reading only.
- **What I read:** the r11 vs r10 diffs of `src/main.rs`, `src/bin/mk_fixture.rs`, `Cargo.toml`, `jobs/positive.sh` and `README.md`, plus the pinned reth 7134be3 signatures they use.
- **Not done:** builds, tests, queue jobs, mounts, network, data reads, edits or commits.
- **Results:** root's wrapper tests (32) are separate; no result is claimed or denied here. **No Rust has been compiled, so nothing here is PASS.**
- **SUMS:** r11 `SHA256SUMS` is `246ff06b4df2…` (`sha256sum -c` OK). I did not re-verify root's statement that the other files differ only in labels.

## Verdict
**No actionable blocker in the changed scope.** The r11 changes match 1861:
- I found no new logic or API defect that would make a valid fixture fail or let an invalid one be accepted;
- v2 still cannot exit 0 (`main.rs:291` with `full` requiring a plain `PASS`, which v2 never produces);
- no canonical claim is added.

Compile risk remains, and it is mostly **old** (see "Old compile uncertainties").

## Rust correctness and API (new code)
**Re-exports:** `reth_stages_types::{FinishCheckpoint, StageUnitCheckpoint, EntitiesCheckpoint, StageCheckpoint}` are all re-exported (`stages/types/src/lib.rs:19-23`).

**Field and method names exist:**
- `StageCheckpoint.stage_checkpoint` is pub (`checkpoints.rs:379`);
- `with_block_number` exists (`:389`);
- `EntitiesCheckpoint { processed, total }` exists (`:312-316`);
- `FinishCheckpoint.partial_state_trie` is a pub field that is not `cfg`'d (`:456`).

**Keys:**
- every `StageCheckpoints`/`StageCheckpointProgresses` access now passes a `String`: `main.rs:199,209` and `mk_fixture.rs:219,230,233-234`;
- the cursor walk (`main.rs:192`) needs no key;
- `Metadata` is keyed by `String`, the same as r10's `storage_settings` read.

**The frontier match (`main.rs:202-208`)** is exhaustive: None / `Finish{None}` / `Finish{Some(p)}` / other.
- The arms are `&'static str` or `refuse(..) -> !`, and `!` coerces.
- `{other:?}` works because `StageUnitCheckpoint` derives `Debug`.
- `stage_checkpoint` is `Copy`, so moving it out of `fc` is fine.
- It matches the **field**, not the accessor, as 1861 required.

**Other new code:**
- `index_cps` collects into `serde_json::Map<String, Value>` (`FromIterator<(String, Value)>`).
- `checkpoints.get(..).and_then(Value::as_u64)` is valid.
- `match &rk_meta` with the `ErrorKind::NotFound` guard, other `Err`, and `Ok(_)` is valid.
- The `if`/`else` that mixes `&str` and `!` type-checks.
- `json!` of `Option<usize>` and `Option<String>` is fine.

**Cargo:** only `reth-stages-types` gains `features = ["partial-persistence"]`. Both binaries are in one package, so `mk_fixture` encodes and the helper decodes `FinishCheckpoint` with the same derived `Compact`.

**Fixture API:** `put::<StageCheckpointProgresses>(…, Vec::new())` relies on MDBX accepting a zero-length value. Upstream production code writes exactly that (`migrate_v2.rs:349`), so I expect it to work; it is unrun.

## Refusal semantics (`main.rs:186-246`)
All refusals happen before the static-file header read and before the root and cache computation. They run in this order:
1. **The unwind marker** (`:187-189`): `Metadata["partial_state_trie_unwind"]` present with any value → 3.
2. **The checkpoint walk.** Without the feature it would panic; with the feature it decodes `Finish(_)`.
3. **The Finish unit checkpoint:** only `None` or `Finish{partial_state_trie: None}` proceed. `Some(p)` for lt, eq or gt → 3; any other variant → 3.
4. **MerkleExecute progress:** `Some(non-empty)` → 3; absent or empty proceed and are reported (`merkleExecuteProgressBytes` is null or 0).
5. **The v2 RocksDB classification:**

| `--rocksdb` path | index checkpoints | result |
|---|---|---|
| a real directory (`symlink_metadata`) with a regular `CURRENT` | any | `PRESENT` (not opened) |
| NotFound | all three present and `== 0` | `ABSENT` |
| NotFound | any missing or non-zero | refuse (3) |
| any other error | any | refuse (3) |
| exists in any other form | any | refuse (3) |

For v1 the classification is `NOT_APPLICABLE_V1`. RocksDB is never opened and `CURRENT` is never created.

**What stays unchanged:** the 5-way `coherent`, the hashed-only root vs the header, the Verifier, and the exit expression.

## Prepared fixture expectations (26 runs over 25 cases): traced, all consistent
**The fixture constants:** `TIP = 2` (`mk_fixture.rs:57`), so the frontier refusal messages contain "frontier 1", "frontier 2" or "frontier 3", matching `WHY`. Every `WHY` substring matches the helper's `refuse` text, which is printed as `REFUSED: …` on stderr and captured (`main.rs:65-67`, `positive.sh:34`).

| case | fixture row/path | helper path | positive.sh expects |
|---|---|---|---|
| v2-no-rocksdb (r7) | no index rows, no rocksdb dir | NotFound, indices missing → 3 | 3 + "history-index checkpoints are not all present and 0" ✓ |
| v2-no-rocksdb-index-reset | 3 rows `default()` (0), no dir | ABSENT → state → 5 | 5, `ABSENT:`, `historyIndexCheckpoints` all 0 ✓ |
| …-index-nonzero / …-one-missing | IndexStorageHistory = 2 / absent | → 3 | same substring ✓ |
| v2-rocksdb-no-current | index reset + `rocksdb/LOCK` only | `Ok(dir)`, no CURRENT → 3 | "not a directory with a regular CURRENT file" ✓ |
| v2-frontier-lt/eq/gt | Finish = 2, `Some(1/2/3)` | → 3 | "partial state-trie frontier 1/2/3" ✓ |
| v2-finish-none | `Finish{None}` + CURRENT placeholder | → 5 | `PRESENT:`, "Finish(partial_state_trie: None)" ✓ |
| v2-finish-unknown-variant | `Entities{1,1}` on Finish | → 3 | "unknown Finish unit checkpoint variant" ✓ |
| v2-merkle-progress-nonempty / -empty | `[1,2,3]` / `[]` | 3 / 5 | "(3 bytes)" / `merkleExecuteProgressBytes` 0 ✓ |
| v2-unwind-marker | Metadata key set | → 3 | "partial_state_trie_unwind marker present" ✓ |
| v2-not-applicable | CURRENT placeholder, no index rows | PRESENT (no index requirement) → 5 | `NOT_APPLICABLE_V2` (root's 1863 fix; r10's `"NOT_APPLICABLE"` would have failed) ✓ |

**For the non-refused runs, the new report assertions are satisfiable:**
- `format` is r11;
- `rocksdbOpened` is false;
- `historyIndices` starts with "NOT CHECKED";
- `finishFrontier` is "none";
- `unwindMarkerPresent` is false;
- `tipHeader.parentHash` is the fixture's `headers[2].parent_hash`;
- `withdrawalsRoot` is null (`Header::default()`);
- the v1 runs report `NOT_APPLICABLE_V1`;
- the v2 runs stay at 5 with `fullStateIntegrity` false;
- the v2 plain tables are empty and the trie entry counts are 0 (non-cached).

**Exit handling (fail-closed):**
- `positive.sh` demands the **exact** rc per label. A panic (101), timeout (124) or any unexpected rc fails the case.
- A refused run must not leave a result file, and must print the reason.
- An unknown label would raise `KeyError`, so Python exits non-zero and the case fails.
- `fixtures.sh` is unchanged: the synthetic refusals return 3 before any new code, and `corrupt-mdbx` is "nz".

## Can anything allow invalid acceptance? No new path found
- **All new checks only add refusals or report-only fields.** No existing check was weakened, and the exit expression is byte-identical.
- **The ABSENT branch** can only lead to exit 5 (v2) with `historyIndices: NOT CHECKED`; it asserts nothing about history or health.

## Minor, non-blocking (optional, a one-line fix each)
- **m1 (`main.rs`, the `Err(NotFound)` arm):** a mistyped `--rocksdb` whose **parent** is missing is also NotFound, so it is classified `ABSENT`. That is not unsafe, because history stays NOT CHECKED, but it can mask a mis-pointed argument. Fix: require `a.rocksdb.parent()` to be an existing directory (e.g. the datadir) before classifying ABSENT.
- **m2:** a `--rocksdb` that is a **symlink** to a real RocksDB dir is refused (`symlink_metadata`). That is a fail-closed false refusal. Production must pass the real path; this should be documented.
- **m3 (`positive.sh:33`):** `[ "$c" = v2-no-rocksdb ] && rk=$d/rocksdb` is a no-op (same value). Cosmetic.
- **m4:** `unwindMarkerPresent: false` is hard-coded. That is correct, because the marker refuses earlier, but it is a constant, not an observation.

## Old compile uncertainties (not introduced by r11)
r7–r10 never type-checked (1861 §1), so **everything unchanged since r7 compiles for the first time in r11**. That includes:
- `open_db_read_only`;
- `cached_walk_root`, `verify_cache`, `hashed_only_root`, `plain_vs_hashed`;
- `StaticFileProviderBuilder::read_only(..).build()`;
- the `HeaderProvider` call;
- in `mk_fixture`: `get_writer`, `sfp.commit()`, `independent_root` and the trie writers.

I spot-checked `append_header(&Header, &BlockHash)` (`static_file/writer.rs:1131`) and `StaticFileProviderBuilder::{read_write, read_only, build}` (`manager.rs:138,149,222`). Both match the calls. The rest was not re-checked here.

**If the compile fails, classify it:** errors in the lines r11 changed are new defects; anything else is a first-compile issue of the r7 code.

## Unresolved questions
1. **The real DB's values are still unread:** its Finish unit checkpoint, unwind marker, index checkpoints and progress row. Its `--rocksdb` path will presumably be absent; the ABSENT branch then needs all three index rows present and 0. If the real snapshot lacks them (no download reset), the helper refuses, and that is correct.
2. **No production helper wrapper exists yet in r11.** When one is written, it must treat only {3,4,5} as classified outcomes for v2, and anything else (101, 124, signals) as failure (1861 Q2).
3. **Behaviour that only the first build and fixture run can show:** whether MDBX stores the empty `StageCheckpointProgresses` value as `Some([])` rather than absent. Either way the helper reports 0 or null; only `positive.sh` asserts 0 (an absent row would give null, so the case would fail closed).
