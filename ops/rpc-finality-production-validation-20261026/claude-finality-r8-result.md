# base-finality-proof-stage/r8: FROZEN, PREPARED, UNRUN (productionActivated=false; full r7 and r8 unqualified)

**Stage:** `SHA256SUMS` sha256 `f9f65f4c017a027fbbd040da2486982e2cd14a8f27a7949ebb88fbfc152ed870`, 62 files.
- **What Claude did:** static checks only: every Python file parses, the job passes `bash -n`, the pin chain is consistent, and `COMPOSITION.tsv` was generated against the origins.
- **Not done:** no tests, builds, queue jobs, installs, live operations or commits.
- **Untouched:** r7, pinned-checkpoint-parser, base-forward-sync-stage/r2, r6 and recovery r7.
- **Not read:** production-capture-closure-stage (da0, active).
- **Flags:** all four review flags are False, `RETH_ENV_PASS = ()`, and production `HARNESS_BINARY_SHA256` = `9c44836d…`.

## Actual root facts used (r7 run 0624, `logs/root-finality-r7-0624.out`, in progress)

**PASS:** tool 34, integration 17, reproof 5, ops-installer 13, **sampler 93**, **reanchor-recovery 25**.

**FAIL:** ops-readiness (27 ran, `OK (skipped=1)`). r3-regression and r62-isolated had no result yet.

**Parser root job** (`logs/root-pinned-checkpoints-0626`): queued, not started, no rc.

## Composition (`COMPOSITION.tsv`: origin and sha per file; the job re-verifies every copy and patch)

| File | r8 sha | Origin and change |
|---|---|---|
| `harness/a2a4.py` | `501219fd` | **byte copy of pinned-checkpoint-parser's harness**: the pinned reth StageId format, Finish `partial_state_trie` state frontier, `state_below_anchor`/`unwind_incomplete`/`not_unwound`. Verified equal to r7 + `harness-pinned-checkpoints.patch`. |
| `src/finality_state.py` | `ecfe11ba` | r7 + `tool-harness-pin` (`HARNESS_SHA256` = `501219fd`) |
| `producer/base_launch.py` | `e01a8694` | r7 + `producer-adopt-pending-and-pins`: keeps the conjunction (config == binding == `HARNESS_BINARY_SHA256`) and durable adoption; adds `adopt_pending`; `permit-restart-auto` adopts first; re-pins harness and tool |
| `src/reproof.py` | `2039c6fd` | r7 + `reproof-adopt-first-and-pins` |
| `recovery/forward_sync.py` | `37f1e34f` | forward-sync r2 `d63ee20d` + `forward-sync-harness-pin` (`HARNESS` = `501219fd`; wrapper `4fc3b970` and selection unchanged). r2's own `stage_frontier` (same semantics as the harness's) is kept. |
| `tests/forward-sync/*`, `units/forward-sync/*`, `HELP-PIN.sha256` | – | byte copies of r2 |
| wrapper `4fc3b970`, readiness, ops installer, other units | – | byte copies of r7 |
| `install/MANIFEST.json` | – | 31 entries, re-hashed, plus `forward_sync.py` and its 2 units |
| `install/config-templates/base-forward-sync.json` | – | new: known facts only, `null` for the rest |

## Fixes

1. **Ops-readiness skip** (`ops-readiness-pinned-baseline`): `R6` is now the explicit absolute baseline path (the job pins r6's `SHA256SUMS`), and a missing baseline is `self.fail`, never `skipTest`.
2. **Re-proof interruption ordering** (`reproof-adopt-first-and-pins`, `producer-adopt-pending-and-pins`).
   - **Before:** `reproof` called `record_finality` only after a NEW qualification. With an interrupted record pending, that record's `_dangling_proof` adopted the OLD proof, the new entry's launch-journal head no longer matched, and the newer proof was stranded.
   - **Now:**
     1. if the status is current and recorded, do nothing;
     2. else `P.adopt_pending`, the durable adoption half only, with the same `_dangling_proof` rules (exactly one qualified entry matching the unnamed last finality-proof, no terminal; anything else refuses `watermark`);
     3. else, if the status is qualified but unrecorded for this process, `record_finality`;
     4. only then capture and qualify a new proof.
   - `permit-restart-auto` (with the pinned tool) also adopts first, so an interrupted record never blocks an unattended restart.
   - A needed adoption stays HOLD-gated (`hold_finality`). No journal edits, and no terminal or refusal gate is weakened.
3. **Pinned-format fixture** (`recovery-pinned-format-fake`): the recovery suite's shim runs the parser stage's `fixtures/fake_base.py` (sha `73ad09a7…`, pinned by the job; path from `PINNED_FAKE_BASE`). The fixture's `baseBinarySha256` and the duration-scoped `HARNESS_BINARY_SHA256` override follow it. r3-regression keeps the original fake, because it drives the a2-v2 first-bootstrap harness (see gaps).

**New real-tool regressions** (`tests/test_reproof.py`, now 9):

| Test | Shows |
|---|---|
| `r8_interrupted_record_same_process_is_adopted_before_any_capture` | the capture function asserts it is never called; action `adopted`; the gate admits with `recordedAs` |
| `r8_interrupted_record_then_restart_adopts_first_then_records_the_newer_proof` | the exact interrupted record, then a node restart; `bootstrapped` = [NP, NP2, NP2+10], watermark identical, gate on the newest |
| `r8_current_unrecorded_qualification_is_recorded_not_reproved` | – |
| `r8_unknown_dangling_entry_refuses_before_any_capture` | `watermark`, no new capture |

## Root job (UNRUN): `jobs/root-finality-r8-tests.sh` (sha `4a443d07…`)

```
ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r8
python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1024 --log $ST/logs/root-finality-r8-tests.guard -- unshare -rn bash $ST/jobs/root-finality-r8-tests.sh > $ST/logs/root-finality-r8-tests.out 2>&1; echo $? > $ST/logs/root-finality-r8-tests.rc
```

**Setup:**
- **Loopback:** brought up and verified (`127.0.0.1` on `lo`).
- **No recursive copy:** `tar --exclude=./logs`.
- **Every reference fixture pinned:** r7, parser, forward-sync r2, r6 and recovery-r7 manifests; the parser fake `73ad09a7`; the live help (= r2 `HELP-PIN`); `origin_extract`.
- **Checks:** every composition copy and edit; the full pin chain (harness → tool, producer, forward_sync; tool → producer, reproof; producer → reproof; wrapper in all three); flags; the manifest.
- **Pass rule:** `Ran N tests in` from the unittest summary, final `OK` with no `(skipped…)`, and rc 0. Anything else is printed as FAIL.

**Planned affected suites** (provenance: what changed):

| Suite | Count | Why it reruns |
|---|---|---|
| tool | 34 | tool pin |
| integration | 17 | harness and tool pins |
| reproof | 9 | ordering plus 4 regressions |
| ops-readiness | 27 | the skip fix |
| ops-installer | 13 | manifest |
| reanchor-recovery | 25 | new harness parser plus pinned fake |
| r3-regression | 27 | producer |
| r62-isolated | 2 | harness |
| forward-sync | 8 | r2 adapted, never passed; forward_sync pin and producer |
| forward-sync-r2 | 6 | forward_sync and producer |

**Dependencies on identical bytes, not repeated:**
- **sampler 93:** PASS in r7 run 0624; the readiness bytes are identical.
- **parser 8:** PENDING; the harness is identical to the parser stage's, and its receipt `logs/root-pinned-checkpoints-0626` has no rc yet.

While a dependency is pending the job exits **3**, never 0.

## Remaining (actual)

1. **Nothing in r8 has run.** The r7 and r8 qualifications are incomplete (r7's r3 and r62 results are pending; the parser receipt is pending).
2. **The production-capture closure is NOT integrated:** da0's stage is active with no report. Until it lands, the guest (Python 3.12, node 18) does not match the capture module's host-only runtime pins (Python 3.14, node 22), so the live re-proof capture refuses on the guest. `reproof.py` is **not deployable** yet.
3. **The first-bootstrap harness still has the fake-only checkpoint parser:** the a2-v2 stage `a2a4.py` (`A2A4_SOURCE_SHA256 abe223d6`, used by `produce`/`arm` for a first launch). A real first bootstrap would refuse `unparsed`. Only the recovery harness got the pinned parser. A reviewed patch of that harness is needed, and is not done here.
4. **Checkpoint format from source only:** the pinned format is established from pinned source (reth `7134be3`), not yet from the real binary on a real DB.
5. **Missing real artifacts** (`install/MISSING.md`): the node path, coverage evidence, the bound harness config, the consumer list, the forward-sync per-recovery values, and the activation artifact.
6. **No activation, install or live verification.**
