# base-reanchor-recovery-stage: R-A re-anchor recovery after a crash or reboot (PREPARED; NOT run; source-only; NOT enabled)

## Scope
The consumed one-shot launch (launcher r3: 95 PASS + guest canary PASS) cannot restart, by design:
- the wrapper refuses `consumed`;
- `rearm` requires the stopped DB unchanged at N;
- M10 requires the head to be exactly N.

The same-running-process finality prototype does not change that. This stage prepares the conservative R-A path of
`base-finality-proof-stage/restart-review/DESIGN.md` §2: a **NEW launch on the same downloaded datadir**, proven again from
an A1-authenticated anchor by the full existing pipeline.

**HOLD flags stay False:**
- `LAUNCH_PRODUCER_REVIEWED` (wrapper);
- `FINALITY_PROOF_REVIEWED` (producer);
- the new pending interface `A1_CAPTURE_VERIFIER = None` (harness).

Nothing here is installed, live or enabled.

**What changes and what doesn't.** Only NEW copies are changed: `harness/a2a4.py`, `wrapper/chain_service.py` and
`producer/base_launch.py`. Their diffs against the reviewed bases are `harness-recovery.patch`, `wrapper-recovery.patch` and
`producer-recovery.patch`; the bases themselves are in `base/`. The original stages and 50cf's a1-capture-binding work are
untouched.

**First bootstrap is unchanged:**
- no `reanchor` config means the harness behaves byte-for-byte as before (the static N bound and the single source pin);
- a launch without a `predecessor` behaves as in r3 while the archive is empty;
- the r3 suite (27) runs unchanged over these copies.

## R-A procedure (root, Base unit stopped; each step refuses on any deviation)
| # | Step | Code |
|---|---|---|
| A0 | `rollback <dir> <reason>` (terminal), then `retire <dir>`: an atomic rename to `/etc/enclave-rpc/base-bootstrap-archive/<launchSha256>` | producer `rollback`, `retire` (NEW) |
| A1 | A fresh A1 for the re-anchor. **(a) The same anchor N:** a fresh reviewed original-game recheck of the SOURCE-pinned initial receipt (no new trust input). **(b) A newer N'':** a capture-bound initial receipt for N'', plus a recheck. **(b) is HOLD** until a reviewed `A1_CAPTURE_VERIFIER` (from a1-capture-binding-stage) is installed by a source change. | harness `initial_pin` (NEW), `gate_a1` |
| A2–A4 | A NEW harness workdir; config `reanchor {predecessorN[, a1Capture, a1CaptureSha256]}`; then A2 header authentication, A3 offline unwind of everything above N, A4 full merkle rebuild validated against header N | harness steps, unchanged |
| A5 | Bytecode scan at N, then release | unchanged |
| A6 | `produce <cfg> <new-dir> <predecessor-sha>`. The launch record gains `predecessor {launchSha256, rolledBackEntrySha256, anchor}`; root pins the new `launchSha256` | producer `_predecessor` (NEW) |
| A7 | `arm`: lineage plus the stopped DB unchanged at N | producer `arm` (+ lineage) |
| A8 | Unit start. The handshake verifies the lineage BEFORE consuming, then consumes and execs `--bootstrap.anchor N:hash` | wrapper `launch_lineage` (NEW) |

## Derived bounds (never widened; gate_download not bypassed)
- **Lower bound:** `N ≥ reanchor.predecessorN ≥ STATE_FLOOR` (52,500,000). The changesets for unwinding are held from the
  floor; gate_static still enforces `[prune.segments] before ≤ STATE_FLOOR`.
- **Upper bound:**
  - every stage checkpoint (headers, bodies, execution, finish) of the STOPPED DB must be ≥ N, checked in `step_plan`;
  - header N must be present and must authenticate (A2);
  - N must equal the A1-authenticated anchor exactly (`gate_a1`).

  There is no static ceiling, so `SNAPSHOT_HEAD` is no longer a ceiling for a re-anchor.
- **gate_download is unchanged.** The receipt still proves this datadir's origin: the pinned download at 53,048,526, with the
  same dev/ino. The DB's CURRENT state is proven only by A4 at N.

## Lineage and monotonicity (wrapper `launch_lineage`, checked by produce, arm and the handshake)
- **Predecessor:** every predecessor must be the archived record named by its sha, and terminally `rolled-back` at exactly
  the named journal entry.
- **Anchors never move backward.** An equal height is allowed only for the identical anchor (N and hash).
- **Every archived launch must be in the chain.** An orphan or a fork refuses. A predecessor-less (first-bootstrap) launch
  refuses once the archive is non-empty.
- **Integrity:** the archive and every predecessor directory must be root-owned with no symlinks, and every journal must
  pass its hash-chain verification.

## Trust tier and rollback analysis (root decision requested)
**Tier.** The anchor is A1-authenticated: the pinned ASR and the respected, finalized, non-blacklisted game, read
Helios-light-client-relative on L1 finalized. This is exactly the first-bootstrap tier. Node labels, the old journal, the
prototype's `status()`, and inode identity are **never** inputs. A fast unanchored resume (R-B) stays rejected.

**Monotonicity applies to the AUTHENTICATED tier only: N ≥ the predecessor anchor.** It does NOT require N above every height
the crashed node served.
- **Why:** finalized ASR anchors lag the served heads by days (the dispute window), so that rule would **deadlock** recovery
  until an unproven, unrecorded height passes.
- **The cost:** after recovery, the node's served `latest`, `safe` and `finalized` labels can **regress** to N and then
  re-derive forward. Blocks above N are discarded by A3 and re-derived from L1.

**Why the regression is acceptable:**
- **Unsafe and safe heights** were never authenticated. Discarding them is equivalent to a reorg the consumers must already
  tolerate.
- **Finalized labels** served by the old process were the node's own derivation, not A1 evidence. The design wrapper notes
  that consumers verify independently ("a forwarded hash is not inclusion").

**What it is not:**
- It is **not** a rollback of authenticated state. The ASR only advances, and N ≥ the predecessor's N.
- It is **not** an anchored replay onto an advanced DB. A3 and A4 re-prove the DB at N, and the new launch is one-shot.

**Same-anchor re-anchor.** Re-anchoring at the same authenticated N with a fresh recheck is allowed. It avoids waiting for a
newer resolved game, and it re-proves the DB in full. A strictly newer anchor requires the pending capture binding.

**Not detected (residual):**
- consumers that cached finalized heights above N will see them again only after re-derivation;
- root-level deletion or restore of the archive/journal (the same as r3);
- history below N stays as unauthenticated as at the first bootstrap (no `authenticateAncestors` step; a follow-up could use
  `anchor-bootstrap.mjs` `authenticateAncestors`).

## Downtime, cost and unsupported crashes
- **Cost:** each recovery is an unwind of (DB head − N) blocks plus a full merkle rebuild from 0 plus a full bytecode scan.
  **Unmeasured:** no real A3, A4 or bytecode run exists yet. Base is down for the whole recovery, and the head − N gap grows
  roughly 43k blocks per day of delay.
- **Unsupported crash scenarios**, each failing closed:
  - **During A3** (an interrupted unwind): the harness journal marks it, and the DB state is unknown. Recovery is a
    re-download.
  - **During A4:** the merkle state is unknown, and the bytecode scan refuses its order. Treat as a re-download.
  - **During `retire`:** the rename is atomic, so the dir is either in place or archived.
  - **Between `produce` and the pin, or before `arm`:** the wrapper refuses (pin mismatch / no lock).
  - **A crash of the recovered node:** another R-A, with the lineage growing (≤ 64).
  - **A contradiction recorded by the prototype tripwire** for the old launch: R-A must not start until root decides
    (DESIGN §3). It is not automated here.

## Tests (NOT run): `jobs/root-reanchor-tests.sh`, exact counts 34 + 34 + 27 + 7
`tests/test_reanchor_recovery.py` covers:
1. **A real end-to-end crash and recovery, twice.**
   - The first launch is consumed and the node runs to N+5000 and writes its DB.
   - Restart, `rearm` and `retire` all refuse.
   - Then A0 → A8, at the same anchor, on a new workdir.
   - The produce refusals are checked: no predecessor, a non-archived predecessor, a wrong `predecessorN`.
   - Exactly one exec per launch.
   - A second crash gives a lineage of 3.
2. **A newer anchor N+3000 with the REAL (None) verifier:** A2 refuses `a1_capture_pending` and nothing is unwound.
3. **A newer anchor with a TEST-ONLY verifier:** the full pipeline execs `--bootstrap.anchor N2:…`. This proves pipeline
   consistency, NOT capture binding. A wrong binding refuses.
4. **Lineage tamper on the real call path:** an orphan archive, the rolled-back entry removed, an edited archived record, a
   hidden predecessor, a symlinked archive. All refuse before consuming, and the restored state execs once.
5. **Lineage rules (synthetic):** backward, same-height-other-hash, first bootstrap with a non-empty archive, a wrong entry
   or anchor, malformed, a consumed predecessor.
6. **Derived bounds:** the first-bootstrap static bound is unchanged; the re-anchor lower bound and the fresh-mode refusal;
   the stopped-DB upper bound (with A1 isolated by a patch, in this unit test only); `gate_download` still enforced.
7. **`initial_pin` rules:** source pin; capture record missing, wrong sha, untrusted; pending HOLD; wrong binding; bytes
   mismatch.
