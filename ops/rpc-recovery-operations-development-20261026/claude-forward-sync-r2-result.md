# base-forward-sync-stage/r2: finished and frozen (PREPARED; nothing run by Claude)
**Stage:** `base-forward-sync-stage/r2/`. `SHA256SUMS` sha256 **`0626b9e4c03997a5fa81507916052e4fac0af68263b41d96ad23b942101d80ff`**.
**Parent stage:** frozen (its `SHA256SUMS` still verifies). No other stage was touched.

**File pins:**
| File | sha256 |
|---|---|
| `src/forward_sync.py` | `d63ee20d…` |
| `r6-followup/producer/base_launch.py` | `2ddc72aa78b1193e7284c9c112747decbe97ced0fe691d55ebecfd6ce1aaad31` |
| `tests/test_forward_sync.py` (parent's 8, adapted) | `50dc12ee…` |
| `tests/test_forward_sync_r2.py` (new, 6) | `22774e10…` |

## Root's actual results (`root-forward-sync-affected-0605`, run dir `…20261026T060029Z-990236`)
| Suite | Result |
|---|---|
| reanchor-recovery (r6.1 producer) | **24/24 PASS** |
| r3-regression | **27/27 PASS** (per root) |
| forward-sync | **8/8 ERROR**, one cause (fixture) |

**The forward-sync cause:** the stage's fixture stubbed `W.history_from_block` / `W.state_history_from_block` to `None` **module-wide**. The inherited launch path (`test_r3_launcher.py:153` → `chain_service.py:910/964`) then compared `None <= snap`.
- **r2 fix (test-only):** those two stubs are removed. Both `start()` and `forward_sync.run` now use the **real** wrapper functions over the recovery fixture's config. No production gate changed.

## r2 changes
1. **Binary pin** (`bound_config`, producer): `config == launch.bindings.harnessBinarySha256 == HARNESS_BINARY_SHA256`. Both the production constant and the launch binding are enforced. Refusal code: `binary_pin`.
2. **Exact flags** (`capability`): exact `--token` sets per position, from `base --help` (before `rpc`) and `base rpc --help` (after it).
   - Checked against root's real pinned help (`logs/base-live-help-0603/help.txt`, sha in `r2/HELP-PIN.sha256`): all 24 `node_argv` flags exist exactly in position (`--chain` global; the rest `rpc`).
3. **Production rollback re-check:** `production_rolled_back()` is now also called in `run()` and `verify()`.
4. **Retention from our own CL** (`retention()` + `lighthouse_db_info()`, the full `/lighthouse/database/info` from our beacon):
   - It requires `anchor.oldest_block_slot` and `data_info.oldest_data_slot` ≤ the coverage need_from slot (`coverage_activation(...)['blobSlot']`). That is range **availability**. The per-block KZG verdict remains the pinned coverage verdict that `coverage_activation` requires.
   - The one-slot probe, which wrongly refused zero-commitment or missed slots, is removed. No time budget is invented.
5. **Stopped-state check** (`stage_frontier()`):
   - It parses the exact pinned `db stage-checkpoints get` output: `{StageId}: StageCheckpoint { block_number: N, stage_checkpoint: … }`, with the StageId names `Headers`, `Bodies`, `Execution`, `MerkleExecute`, `Finish`.
   - `verify` keeps all five ≥ floor, **adds** `state_below_floor` (Finish `partial_state_trie` ≥ floor), and keeps the floor-header hash and A2–A4 unchanged.
   - `authenticate` requires labels == state == SNAPSHOT_HEAD.

**Pinned-source evidence for item 5** (reth 7134be3 = the manifest's `reth_version` and the coverage-stage's pinned rev):
- `storage/provider/src/providers/database/provider.rs:836-850`: engine persistence `save_blocks` calls `update_pipeline_stages(last_block_number)` and, in Full mode, writes the `Finish` checkpoint with `FinishCheckpoint { partial_state_trie }` when set.
- `provider.rs:2394-2412`: `update_pipeline_stages` upserts **every** `StageId::ALL` row to that block. Live sync therefore advances all five labels together; labels alone do not prove the state frontier.
- `stages/types/src/checkpoints.rs:454-470`: `FinishCheckpoint.partial_state_trie` = "the highest block with a partially persisted state and trie" (`partial-persistence` feature). `provider.rs:2419-2445` keeps that lagging frontier.
- `cli/commands/src/db/stage_checkpoints.rs:47-51`: the no-stage `get` prints `{stage}: {checkpoint:?}`. `stages/types/src/id.rs:151-162`: the Display names above.

## Targeted job
```
python3 -u ../claude-test-queue.py --mib 512 --log base-forward-sync-stage/r2/logs/root-forward-sync-r2-unit.guard -- unshare -rn bash base-forward-sync-stage/r2/jobs/root-forward-sync-r2-unit.sh
```
- **What it checks:** pure-module tests, **exactly 6**:
  - stage-frontier ×3;
  - real-help capability ×1;
  - retention ×1;
  - producer pin ×1 (an **unpatched** negative, plus a fixture-scoped `patch.object(P, 'HARNESS_BINARY_SHA256', stand)`).
- **Pins it verifies:** r2 `SHA256SUMS` and `HELP-PIN.sha256`.
- **The adapted parent 8 (`tests/test_forward_sync.py`)** need root's existing r7-copy job pointed at r2 (`FORWARD_SYNC_SRC=r2/src`) **and** the fixture override below. That is not prepared as a separate job here.

## Integration guidance for 50cf (composing base-finality-proof-stage/r7)
1. **Producer `bound_config`:** take r2's conjunction verbatim (`config == binding == HARNESS_BINARY_SHA256`). Do **not** compose r6.1's binding-only version.
2. **Ported fixture override** (reanchor-recovery, r3-regression, forward-sync): those fixtures use a stand-in base binary. With the conjunction they must bind it for each test's duration with `patch.object(P, 'HARNESS_BINARY_SHA256', self.cfg['baseBinarySha256'])` (fixture setUp). Without it they refuse `binary_pin`; that is correct production behaviour, not a regression to weaken.
   - Keep one unpatched negative test (r2 `ProducerPin`).
3. **Harness label parsing** (r6 `harness/a2a4.py` `head_checkpoints` `:949` / `checkpoint_block` `:617`): this proven defect is unchanged here. It matches `^headers:` / `merkle-execute:` / `Some(StageCheckpoint`, but the pinned binary prints `Headers: StageCheckpoint { … }` / `MerkleExecute:`. On a REAL DB it refuses `unparsed`; the fake reth hides it.
   - If 50cf fixes it in the composed harness, reuse r2 `stage_frontier()`'s format and Finish `partial_state_trie` rule.
4. **Hash pins after composition:**
   - **If the harness changes:** update the producer's `RECOVERY_A2A4_SHA256`, finality_state's `HARNESS_SHA256`, forward_sync's `HARNESS` pin (`/opt/enclave-rpc/a2a4-recovery/a2a4.py`, now `710c3483…`), and the install `MANIFEST.json`.
   - **If the wrapper changes:** update `WRAPPER_SHA256` in finality_state and the producer, and forward_sync's `WRAPPER` pin (`4fc3b970…`).
   - **If the producer changes:** r2's is `2ddc72aa…`. Update finality_state's `FINALITY_STATE_SHA256`, and the install manifest entries.
   - forward_sync executes harness and wrapper from verified bytes, so a stale pin fails closed.

## Limitations / not run
- No r2 test has run.
- Real live-sync stage and state behaviour is established from pinned source only, not from a real DB.
- Retention depends on Lighthouse v8.3.2's `/lighthouse/database/info` fields (`anchor.oldest_block_slot`, `data_info.oldest_data_slot`), as observed live on 2026-10-26.
- The coverage-gate whole-range KZG verdict and its `--max-blocks` deadline (`claude-historical-blob-live-0547.md`) remain separate prerequisites.

**Holds:** custody v2 REFUSED; production unqualified.
