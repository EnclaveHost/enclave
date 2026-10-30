# Pinned stage-checkpoint parser for the harness (PREPARED, frozen; nothing run by Claude)
**Stage:** `base-finality-proof-stage/pinned-checkpoint-parser/`, `SHA256SUMS` sha256 **`96dd0d602ebe246d118453db7ae1c23aa1ac8849e7d5eae8b468248b362ecb86`**.
- **Untouched:** r7 (50cf composing), r6-followup-fixes (baseline, still verifying) and every earlier stage.
- **Not done:** no tests, builds, queue jobs, live actions or commits.

## The defect (proven)
- **What the harness did:** `checkpoint_block`/`head_checkpoints` in `r6-followup-fixes/harness/a2a4.py` (sha `854c5d38…`) matched lowercase kebab keys (`^headers:`, `^merkle-execute:`) and a `Some(StageCheckpoint …)` wrapper.
- **Why it matched in tests:** that shape exists only in the synthetic fake (`source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage/test/fake_base.py`).
- **Consequence:** the pinned binary prints `Headers: StageCheckpoint { block_number: N, stage_checkpoint: … }` / `MerkleExecute: …`, so on a real DB every DB-touching step would refuse `unparsed`.
- **Second gap:** the harness treated stage labels as persisted state.

## Pinned upstream evidence
- **Checkout:** `/home/steven/.cargo/git/checkouts/reth-babcd6134566c621/7134be3`.
- **Commit:** `git rev-parse HEAD` = **`7134be3b51cf9d9504f988bff3266a23085f0bd9`**. That is base-v1.5.1's Cargo.lock rev, and the snapshot manifest's `reth_version "2.5.2-dev (7134be3)"`.

| File (absolute) | sha256 | Proves |
|---|---|---|
| `…/7134be3/crates/cli/commands/src/db/stage_checkpoints.rs` | `cdc9e4c8a021286e4b7a14783d5ab69f754fe7cb53519c62c849d2a1694167b5` | `get` without a stage: `get_all_checkpoints()`, sorted, then `println!("{stage}: {checkpoint:?}")`. One row per table entry, StageId Display key, unwrapped `StageCheckpoint` Debug. With a stage it prints `Some(...)`; the harness calls without one. |
| `…/7134be3/crates/stages/types/src/id.rs` | `8fb2ed598500bc5fdabc3370c97534ce336e6dc3379dc99a3754ff2c9ba992ff` | `as_str`/Display: `Headers`, `Bodies`, `Execution`, `MerkleExecute`, `Finish`, …; `StageId::ALL` (15); `StaticFile`; `MerkleChangeSets` (removed stage kept for DB compatibility); `Other(&str)` |
| `…/7134be3/crates/stages/types/src/checkpoints.rs` | `b469ebf3cb530a52454818aa9330095d56253f3c5a1ade8be09c3d158c097938` | `StageCheckpoint { block_number, stage_checkpoint: Option<StageUnitCheckpoint> }`; `StageUnitCheckpoint::Finish(FinishCheckpoint)`; `FinishCheckpoint { partial_state_trie: Option<BlockNumber> }` = "the highest block with a partially persisted state and trie" (`partial-persistence` feature) |
| `…/7134be3/crates/storage/provider/src/providers/database/provider.rs` | `2ed688141515286a9314fa0453a7cf46e1933636d208b51b1f5beb90f0931b76` | `save_blocks` (engine/live persistence) calls `update_pipeline_stages(last_block_number)`, which upserts EVERY `StageId::ALL` row to the tip. In Full mode it writes Finish with `FinishCheckpoint { partial_state_trie }` when the state/trie lags. `update_pipeline_stages_after_unwind` keeps a lagging `partial_state_trie` after an unwind. **So labels are the block tip; Finish.partial_state_trie is the persisted state frontier.** |

## The fix (`patches/harness-pinned-checkpoints.patch`, 72 changed lines)
- **Result:** harness sha `854c5d38…` → **`501219fd9ddbce4c3bd0a90e57ed782ebef0de9e357865a51b979dc93e7bd464`**.
- **`parse_checkpoints(text)`:**
  - Every non-empty line must be `^<Name>: StageCheckpoint { block_number: N, stage_checkpoint: None|Some(...) }$`.
  - The name must be a pinned `as_str` StageId (`StageId::ALL` + `StaticFile` + `MerkleChangeSets`); `Other`/unknown names refuse.
  - **Refuses:** a duplicate row, any missing required row (`Headers`, `Bodies`, `Execution`, `MerkleExecute`, `Finish`), or a malformed row (all as `unparsed`).
  - **Finish detail:** must be `None` or exactly `Some(Finish(FinishCheckpoint { partial_state_trie: None|Some(n) }))`.
  - **State frontier:** = `partial_state_trie` if set, else `Finish.block_number`, and never above Finish.
  - **Returns:** the **same canonical keys** as before (`headers`, `bodies`, `execution`, `merkle-execute`, `finish`) plus the state frontier.
- **`head_checkpoints(c, base)` is unchanged in contract**: it still returns the canonical dict. `checkpoint_block(text, key)` is kept, via the parser. New `head_state(c, base)` returns `(checkpoints, state)`.
- **State honoured where anchor/state checks need it:**
  - `step_plan`: refuses `state_below_anchor` if the state frontier < N, even when every label is ≥ N.
  - The A3 end check (`unwind_incomplete`) and the A4 precondition (`not_unwound`) also require the state frontier == N.
  - Existing label checks are unchanged. `db_identity` still hashes the raw output.

## Fixture emitter (separate patch: `patches/fake_base-pinned-format.patch` → `fixtures/fake_base.py`, sha `73ad09a7…`)
- **Output format:** the synthetic fake now prints the pinned format: Display names, unwrapped `StageCheckpoint`, plus real extra rows (`SenderRecovery`, `AccountHashing`, `StorageHashing`).
- **Partial state:** it prints Finish's `partial_state_trie` when fixture state sets `finishPartial`.
- **Unchanged:** its internal `st['cp']` keys, so existing fixture code keeps working.
- **Explicit negative check kept** in the tests: the old lowercase `headers: Some(StageCheckpoint …)` shape now refuses.

## Tests (`tests/test_pinned_checkpoints.py`, exactly 8)
| # | Case |
|---|---|
| 1 | real table rows → canonical keys + full state; `checkpoint_block` |
| 2 | **lagging Finish** `partial_state_trie: Some(95)` with labels at 120 → state 95 |
| 3 | `FinishCheckpoint` with `None` → state = Finish |
| 4 | missing `MerkleExecute` refuses |
| 5 | duplicate `Headers` refuses |
| 6 | old synthetic lowercase, unknown `Foo` and a malformed row refuse |
| 7 | a non-Finish detail on Finish, or partial above Finish, refuses |
| 8 | `head_state`/`head_checkpoints` read the gated `base.db` output |

## Root job (exact)
```
python3 -u ../claude-test-queue.py --mib 512 --log base-finality-proof-stage/pinned-checkpoint-parser/logs/root-pinned-checkpoints.guard -- unshare -rn bash base-finality-proof-stage/pinned-checkpoint-parser/jobs/root-pinned-checkpoints.sh
```
It verifies the stage `SHA256SUMS`, recovery r7's MANIFEST, and harness == r6-followup-fixes + patch. It then runs the 8 tests (pure module, `selection.py` from r7's harness dir); PASS requires `Ran 8` and OK.

## Composition guidance for 50cf (r7)
1. **Apply** `patches/harness-pinned-checkpoints.patch` to the composed harness. Its hash then changes, so update:
   - finality_state `HARNESS_SHA256` (now `854c5d38…`);
   - the producer's `RECOVERY_A2A4_SHA256` (now `854c5d38…`);
   - forward_sync r2's `HARNESS` pin (`/opt/enclave-rpc/a2a4-recovery/a2a4.py`);
   - the install `MANIFEST.json`.
2. **Overlay** `fixtures/fake_base.py`, or apply its patch, in the private test copy wherever the A2–A4 fixture fake is used. Without it, every fixture DB step refuses `unparsed`, by design.
3. **Fixtures that need state below the labels** set the fake's `finishPartial`.
4. **forward_sync r2:** its own `stage_frontier` has the same semantics. Composition may switch it to the harness `head_state`, or keep both; they must agree.
5. **Earlier results are not evidence for this change.** Root's recovery 24 and regression 27 passed on the earlier synthetic-format fixture and pin variant. forward-sync 8 (r2 startup fixture fix) has not been rerun. With this patch, all three must rerun on the composed r7 with the patched fake.

**Limitation:** the format is established from pinned source, not yet from the real binary on a real DB; the extracted snapshot DB is not available yet. Custody v2 stays REFUSED; production is unqualified.
