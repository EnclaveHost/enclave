# Base R-A re-anchor recovery: PREPARED (source-only; tests NOT run; nothing installed or enabled)

**Stage:** the NEW `base-reanchor-recovery-stage/`. `MANIFEST.sha256` =
`02abf9be02c762a9ac4564500e01d5258b348077b3e486a5d30673e200ee9314`.
- **Not done:** no tests, build, queue, SSH, network, live action or commit.
- **Untouched:** the original harness, launcher r3, the wrapper-integration stage, the finality stages, and 50cf's
  a1-capture-binding work. The last does not exist yet: only its task file is present and its session log is empty. Its
  interface is consumed as **pending**.
- **HOLD flags stay False:** `LAUNCH_PRODUCER_REVIEWED` and `FINALITY_PROOF_REVIEWED`. The new
  `A1_CAPTURE_VERIFIER = None` is also HOLD.

**Inputs read:** DESIGN.md, `logs/claude-finality-restart-review-result.md`, and the launcher r3 result (95 PASS plus the
guest canary). They are pinned in `inputs/consumed-inputs.sha256`.

Also written this session: the previously missing `logs/claude-windows-r4-publication-result.md`.

## New copies (diff vs the reviewed base in `base/`)
| file | sha256 | patch | change |
|---|---|---|---|
| `harness/a2a4.py` | `ae948d47…` | `harness-recovery.patch` | A `reanchor` config (see below), `initial_pin()`, the pending `A1_CAPTURE_VERIFIER`, and the stopped-DB upper bound in `step_plan`. Without `reanchor`: unchanged. |
| `wrapper/chain_service.py` | `a5a9efe3…` | `wrapper-recovery.patch` | `BOOTSTRAP_ARCHIVE`, and `launch_lineage()` called in `launch_handshake` BEFORE anything is consumed |
| `producer/base_launch.py` | `de4afcce…` | `producer-recovery.patch` | See below. |

**The harness `reanchor` config:**
- the derived lower bound `N ≥ predecessorN ≥ STATE_FLOOR`;
- `a1Mode` must be original-game-recheck.

**The producer changes:**
- `RECOVERY_A2A4_SHA256` is used only for `reanchor` configs. First bootstrap keeps `abe223d6…`.
- `_initial_ok` keeps the source pin for first bootstrap. For a re-anchor it uses the harness `initial_pin`.
- `_predecessor` adds a `predecessor` binding to the launch record.
- `arm` checks the lineage.
- `retire` is new: rolled-back → atomic archive rename.

**Unchanged byte copies:** `harness/selection.py`, `wrapper/test_chain_service.py`, and `tests/test_r3_launcher.py`.

## Design decisions (details in README.md)
**Recovery A0–A8:**
- A0: rollback + retire;
- A1: a fresh A1;
- A2 → A3 (unwind) → A4 (full rebuild), in a new workdir;
- bytecodes and release;
- produce with the predecessor, then root pins it;
- arm, then the one-shot start.

**Two A1 cases:**
- **(a) Same anchor N:** a fresh original-game recheck of the source-pinned receipt. This needs **no new trust input** and
  avoids waiting for a newer resolved game. The DB is still fully re-proven (A3 + A4).
- **(b) Newer N'':** HOLD until a reviewed capture-binding verifier is installed. The defined interface:
  - `A1_CAPTURE_VERIFIER(capture_record_bytes, initial_bytes) -> {initialSha256, N, game, outputRoot}`, raising on failure;
  - the record path and its sha come from `reanchor.a1Capture` / `a1CaptureSha256`, read through `_read_trusted`.

**Dynamic N bounds:**
- lower: the predecessor's anchor and the held changeset floor;
- upper: every stage checkpoint of the stopped DB, the header-N authentication, and an exact match with the A1-authenticated
  anchor.

There is no static ceiling, but nothing is widened. `gate_download` is unchanged: it attests the origin of this datadir, and
A4 at N is the only proof of its current state.

**Lineage and monotonicity:**
- each predecessor is the archived record named by its sha, rolled back at exactly the named journal entry;
- anchors are non-decreasing (an equal height only for the identical anchor);
- every archived launch must be in the chain (no fork or orphan);
- a predecessor-less launch refuses once the archive is non-empty;
- checked in produce, arm, and the handshake before anything is consumed.

**Trust tier and rollback:**
- Monotonicity binds the A1-authenticated tier only.
- Requiring N above every height the crashed node served would **deadlock**, because ASR anchors lag the head by the dispute
  window.
- **The accepted, explicit cost:** served labels can regress to N and re-derive. Unsafe, safe and finalized labels were never
  authenticated. This is not a rollback of authenticated state, and not an anchored replay onto an advanced DB.
- **Root decision requested:** whether this tier is the desired one.

**No fast or unanchored resume:** nothing uses labels, inode identity, the old journal, or the prototype's `status()`.
`rearm` still refuses a DB that ran.

**Downtime and cost: unmeasured.** Each recovery is an unwind of (head − N) blocks plus a full merkle rebuild from 0 plus a
full bytecode scan. Base is down throughout.

**Unsupported crashes (fail closed):**
- an interrupted A3 or A4 means a re-download;
- a prototype-tripwire contradiction needs a root decision first.

The rest is listed in the README.

## Root job (prepared, not run)
```
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-reanchor-recovery-stage
python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 256 --log $S/logs/root-reanchor-tests.guard -- unshare -rn bash $S/jobs/root-reanchor-tests.sh
```
The job first checks the manifest, the inputs, that the marker is unset, and that no `/etc/enclave-rpc/base-bootstrap-archive`
exists on the host. For each suite it requires: rc 0, a final line of exactly `OK`, an exact `Ran` count, and no skip.

| suite | target | exact count |
|---|---|---|
| baseline-existing | production wrapper | 34 |
| recovery-existing | wrapper copy | 34 |
| r3-regression | the unchanged r3 suite over these copies (first-bootstrap path) | 27 |
| reanchor-recovery | `tests/test_reanchor_recovery.py` | **7** |

**The 7 new tests:**
1. **A real crash → same-anchor recovery, twice.** Restart, `rearm` and `retire` refuse; the predecessor and
   `predecessorN` refusals fire; exactly one exec per launch; a lineage of 3.
2. **A newer anchor with the real None verifier:** `a1_capture_pending`, with nothing unwound.
3. **A newer anchor with a TEST-ONLY verifier:** the full pipeline execs `N2:hash`. This proves consistency, not binding.
4. **Lineage tamper on the real call path:** orphan, removed rollback entry, edited record, hidden predecessor, symlinked
   archive. All refuse before consuming.
5. **Synthetic lineage rules.**
6. **Derived bounds and `gate_download` enforcement.**
7. **`initial_pin` and the pending interface.**

## Honest limits
- **Not run.** Only syntax and test counts were checked (with `ast`).
- **First runs of these paths.** The end-to-end tests drive the fixture's fake DB through a second harness pipeline on the
  same datadir. The newer-anchor test uses a fixture receipt with only N and root changed, as the harness's own tests do.
  Both are first runs.
- **Test-only isolation.** Test 6 bypasses A1 with a patch so the DB bound can be tested in isolation.
- **The pending interface is real.** Until 50cf's verifier is reviewed and installed by a source change, a newer N'' cannot
  be used. A same-anchor recovery can.
- **Residuals:**
  - history below N stays unauthenticated (there is no ancestor walk);
  - root-level deletion or restore of the archive or journal is undetectable;
  - downtime and rebuild cost are unmeasured.
