# Finality r6.2 follow-up fixes (base-finality-proof-stage/r6-followup-fixes): PREPARED, UNRUN

**Stage:** `SHA256SUMS` sha256 `3ad56bb1611284fe4a9ebe93fde18dae5b60828f7a74500ab6682d845e74ca7d`, 13 files, 5 narrow patches.
- **Untouched:** r6, r6-test-fixes, base-forward-sync-stage (under 6d24 review) and r7.
- **What Claude did:** static checks only (Python `ast.parse`, `bash -n`).
- **Not done:** no tests, builds, queue jobs, live operations, installs or commits.
- **Flags:** every review flag is False, and the production reth allowlist is empty (the job checks both).

## Root evidence addressed (`r6-test-fixes/logs/run-20261026T055855Z-986876/integration.txt`: 16 ran, 14 pass)

| Root result | Cause | Fix |
|---|---|---|
| ERROR `test_capture_hold_and_unreviewed_tool_write_nothing` | `finality_state.node_fd` called `R.accepted_nodes()` **after** opening the node fd. The harness's `R.Refused` (`a1_capture_pending`) escaped unconverted, and the fd stayed open. | `integration/finality_state-node-acceptance-normalized.patch` (8 lines): the reviewed node set is read **first**, so nothing is open yet, and a harness refusal becomes `FS.Refused` with the **exact** code. The existing test asserts `a1_capture_pending`, no ledger and no finality files. |
| FAIL `test_rollback_after_bootstrapped_is_terminal_and_rearm_never_allowed` | For a rolled-back **first-bootstrap** launch, the stronger r6 global-floor guard in `launch_handshake` fires before the rolled-back assertion. The product is correct. | `integration/integration-rollback-and-adoption.patch`: the test now asserts the **exact** guard message (`^watermark: an accepted authenticated-finality floor exists: a first-bootstrap launch never starts`). It then proves rolled-back terminal **independently**: the journal's last state is `rolled-back`, and the real wrapper `journal_append` refuses every transition out of it (8 events). The `rolled_back` refusal of `qualify` is kept. |

## The previously left-out items (both concrete, both implemented, each with its own test)

1. **Reth child environment inheritance** (`integration/harness-clean-reth-env.patch`, 5 lines).
   - **Before:** the harness `Base.run` passed root's whole environment minus `BASE_CHAIN` to every `base reth` child.
   - **Now:** the child gets `{PATH=/usr/bin:/bin, LANG=C.UTF-8, HOME=<workdir>/cmd}` plus the source constant `RETH_ENV_PASS = ()`, which is empty in production.
   - **Test fixtures only:** r7's fake reth reads `FAKE_STATE`, `FAKE_LOG` and similar from its environment, so the ported recovery suite sets exactly those names (`integration/r7-ported-fake-env-allowlist.patch`, 1 line).
   - **Isolated test:** `test_reth_child_environment_is_clean` drives the real `Base.run` with `LD_PRELOAD`, `RUST_LOG`, `BASE_CHAIN` and `NODE_OPTIONS` set. The child sees only `PATH`, `LANG` and `HOME`.
2. **Append-crash stranding** (`integration/producer-durable-adoption-on-r6.1.patch`, on top of the r6.1 bound-binary producer).
   - **Before:** adopting a record interrupted between the watermark append and the journal append required `current()`, i.e. the **same live node process**. A restart left only a rollback.
   - **Now:** `_dangling_proof` adopts **from durable state only**, and only when all of these hold:
     - the store's last entry is an unnamed `finality-proof`;
     - everything before it is exactly this launch's recorded proofs;
     - the finality journal holds exactly one `qualified` entry with that sha and the same N and block;
     - there is no terminal entry.
   - **Why this is sound:** that entry was written right after a current qualification was re-verified, so it is a chain fact.
   - **Refused:** any other dangling entry (`watermark`; root resolves it).
   - **Real-tool test:** `test_interrupted_record_is_adopted_after_a_node_restart`: a crash after the watermark append, then a node restart, then adoption with `finalitySeq` 1. An extra dangling entry naming no qualified entry is refused.
3. **Unrecorded qualifications:** **no change, and why.** A `qualified` entry not yet `record-finality`d is not anchored in the launch journal, so truncating it only drops it from `prior`. No acceptance depends on it: the floor, restarts and re-anchors use only recorded proofs, which r6 anchors (`finality_journal_rolled_back`). Anchoring every qualification would need a new launch-journal state, which I judged out of scope.

## Byte pins (consistent; the job checks them)

| File | sha256 | Pins |
|---|---|---|
| `harness/a2a4.py` | `854c5d38…` | – |
| `src/finality_state.py` | `b2ed0aaa…` | `HARNESS_SHA256` = harness `854c5d38` |
| `producer/base_launch.py` | `f6861e47…` | `RECOVERY_A2A4_SHA256` = harness `854c5d38`; `FINALITY_STATE_SHA256` = tool `b2ed0aaa` |

**Pin consequences outside this stage, not changed here:**
- `base-forward-sync-stage/src/forward_sync.py` still pins the r6 harness `710c3483`. It needs the new pin after 6d24's review; I haven't changed that route.
- The r6 install manifest is stale for all three files; root re-freezes before any install.
- The producer is built on the r6.1 bound-binary patch, which is still under independent review.

## Root regression job (UNRUN)

```
ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r6-followup-fixes
python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1024 --log $ST/logs/root-finality-r62-tests.guard -- unshare -rn bash $ST/jobs/root-finality-r62-tests.sh > $ST/logs/root-finality-r62-tests.out 2>&1; echo $? > $ST/logs/root-finality-r62-tests.rc
```

**What it runs (exactly):**
1. **Integration, 4 named cases** in a private r6.2 copy:
   - root's 2 failed cases;
   - the new adoption-after-restart case;
   - `test_interrupted_record_is_adopted_never_a_trap`, because the adoption path changed.
2. **The 2 isolated r6.2 tests**, in a private r7 copy.
3. **reanchor-recovery 24,** because the clean reth environment touches every harness `base reth` call those tests drive. This was not requested, but it is required for that change.

**Not re-run** (already passing per root): tool 34 and the other 13 integration cases.
- They use the changed `node_fd`, which is only a reorder plus conversion, and the new harness pin.
- Sampler 92 and recovery-existing 34 are unaffected.

**Gates:**
- r6, r6-test-fixes, forward-sync stage and r7 pinned and verified;
- every file equals its base plus its patch;
- pin consistency;
- flags False and `RETH_ENV_PASS = ()`.

## Live help (root's `logs/base-live-help-0603/help.txt`)

All 24 flags `forward_sync.py` passes appear in the captured help (grep check: none absent), so no flag uncertainty remains for that route. Root also reports systemd 255, so the route's `OnSuccess=` is supported. I made no route change while 6d24's review is pending.

## Remaining gaps (exact)

- **Everything here is UNRUN.**
- **Forward-sync pin:** the forward-sync route's harness pin needs updating to `854c5d38` after its review.
- **Unrecorded qualifications:** they remain unanchored, by design (see item 3).
- **Before any install:** the r6.1 binding review, a r6.2 re-freeze, and the install manifest refresh are pending.
