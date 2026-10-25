# M10: opt-in bootstrap-anchor start — engine tested, full native validation pending

Current 2026-10-25 21:55 status: engine **152/152 passed** in two rebuilt native runs. Both runs stopped by memory guard during node test compilation (1818 >1792 MiB, then2566 >2560 MiB); no node/sequencer/SafeDB/CLI/control pass is claimed. Reviewed4096MiB retry is queued under the unchanged16GiB host floor. Both recovery harnesses passed dry source re-derivation and7 refusal checks. This is NOT a combined release binary, independent reproduction, or production activation. Failure history and bounded recovery scripts are retained below; prior preparation-only statements in detailed notes are historical.

`m10-bootstrap-anchor.patch` (sha256 in `.sha256`; `git apply --stat`: **18 files changed, 987 insertions(+), 8 deletions(-)**,
including 3 new files `engine/src/sync/anchor.rs`, `engine/src/test_utils/anchor_blocks.rs`, `service/src/service/anchor_safedb.rs`)
applies on `git archive 5476069f` + M7 `base-l1-verify.patch` (`e9dfb8c6…`).

## What it does
`--bootstrap.anchor <number>:0x<hash>` (validator mode only, NO env binding). **The anchor is NOT proof**: only an external,
config-bound launcher that already performed A1–A4 (proof-verified L1-finalized anchor output root, header N reproducing it,
OFFLINE `reth stage unwind --to-block N`, full state rebuild verified at N; `finality-stage/anchor-bootstrap-review`) may pass it.
1. **Startup precondition** (`BootstrapAnchor::verify_execution_head`, before anything is sent to the EL): EL `latest` must be
   exactly N with the RECOMPUTED hash (`hash_slow`, never the RPC `hash` field); persisted `finalized`/`safe` labels must not be
   above N (reth's offline unwind lowers them, `Pipeline::unwind`). Any mismatch or RPC error ends the engine actor: fail closed.
2. **First reset** (`Engine::reset_to_bootstrap_anchor`): block N must still be canonical with the anchor hash; forkchoice
   unsafe = EL head (>= N), safe = finalized = N; persisted labels are never read. ONE forkchoice update, NO retry loop: an RPC
   error, INVALID, SYNCING or an update the engine did not apply is an error. The anchor is then cleared; later resets use the
   unchanged default path (finalized never moves below N afterwards because it is now N in the EL).
3. **Sequencer mode refuses** an anchor (`EngineError::BootstrapAnchorValidatorOnly`).
4. **Default (no flag): unchanged.** `reset`, `reset_with_checkpoint_reader`, `find_starting_forkchoice_with_checkpoint_reader`
   are byte-identical to 5476069f+M7 (`jobs/selfcheck.sh`, queue 256: PASS).
- **SafeDB (review fix):** the derivation actor's first-reset wipe (`safe_head_reset(default)`, `actor.rs:139-146`, unchanged)
  only LOGS a failure and continues, so an untrusted safe-head DB could survive an anchored start on an I/O error. With an
  anchor, `RollupNode::start_inner` now calls `BootstrapSafeDbWipe::wipe` BEFORE any actor starts: reset to the all-zero head,
  read back the newest entry (must be the L1-0 re-anchor, or the DB disabled/empty); any failure refuses to start.
- **No seed_state downgrade:** the validator handler runs the precondition FIRST and returns its error (the engine actor ends);
  `bootstrap_validator`/`seed_state` is never reached on an anchor error (tested).
- **Persisted labels caveat (reth):** a lowered finalized/safe label is persisted only with the next `save_blocks`; keep the flag
  on until derivation moves past N (a restart before that re-runs the precondition, which then still sees labels <= N after the
  offline unwind).

## Tests prepared (run ONLY by root: `jobs/root-test-m10.sh`, 1792 lane, offline, private target + copied CARGO_HOME)
| crate / filter | new M10 tests (each must appear as `ok`) |
|---|---|
| engine `sync::anchor::tests` | parse; accepts head==N labels<=N/absent; refuses wrong number/hash/RPC-claimed hash; refuses replayed labels > N; RPC error/missing head; anchored forkchoice (6) |
| engine `task_queue::core::tests::bootstrap_anchor` | VALID one FCU head/N/N; INVALID+SYNCING no retry; FCU RPC error no retry; non-canonical N before any FCU (4) |
| node `actors::engine::` | processor: not-unwound EL refused w/o FCU; no-anchor no-op; first reset at N ignores replayed label, clears anchor (3); validator: precondition error ends the actor, no seed_state, no FCU (1) |
| node `actors::sequencer::engine_request_coordinator::` | sequencer refuses an anchor before any engine call (1) |
| node `service::anchor_safedb::` | REAL redb SafeDB: snapshot entry wiped, persists after reopen; failing reset fatal; surviving entry refused, disabled accepted (3) |
| cli `node::tests::bootstrap_anchor_flag` | parses; absent -> None; embedded validator args carry it; malformed values refused; no env binding; embedded-sequencer args have no such flag (3) |

Regression in the same runs: full engine lib; node `actors::engine::`, `actors::sequencer::engine_request_coordinator::`,
`actors::derivation::` (the unchanged derivation-actor SafeDB reset path); cli `node::`.
**Negative controls (rebuilt, `fresh:false`, binary != patched):** `control/disable-anchor-checks.py` disables (a) the two
precondition checks and (b) the SafeDB reset call in the wipe (3 changed lines, asserted). Engine control must fail EXACTLY
`precondition_refuses_replayed_snapshot_labels_above_n` + `precondition_refuses_wrong_number_wrong_hash_and_rpc_claimed_hash`;
node control EXACTLY `a_failing_reset_is_fatal` + `real_redb_wipe_removes_snapshot_entries_persistently`.
Preparation (`mkdir`, `git archive | tar`, `git apply`, `cp`) fails explicitly; an existing `build/` is refused, never deleted.

## Not established
No compile or test run yet (written without compiling: a first root run may need compile fixes; a compile error is INVALID,
never a pass). No game/output-root verification (A1/A2 are the launcher's, in JS); no production build or activation.
