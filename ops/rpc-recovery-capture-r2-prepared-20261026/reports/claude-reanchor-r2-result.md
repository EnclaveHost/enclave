# Base R-A re-anchor recovery r2 (authenticated-finality watermark): PREPARED (source-only; tests NOT run; NOT enabled)

**Stage:** the NEW `base-reanchor-recovery-stage/r2/`. `MANIFEST.sha256` =
`458b55abb7992679d89443d7f63e6f6830b2c38a3ce7a0c046509b95ed183fd3`.
- **Not done:** no tests, build, queue, network, SSH, live action or commit.
- **The frozen r1 stage is untouched:** `MANIFEST.sha256` `02abf9be…` still verifies.
- **Root's active run, read only, not waited on:** `logs/root-reanchor-recovery-0232.out`. When read, it showed
  `PASS baseline-existing Ran 34`, `PASS recovery-existing Ran 34`, and the r3 regression in progress with no failure seen
  yet. The r1 reanchor suite had not started. No conclusion is drawn from a partial run.
- **HOLD flags stay False:** `LAUNCH_PRODUCER_REVIEWED`, `FINALITY_PROOF_REVIEWED`, and `A1_CAPTURE_VERIFIER = None`.

## Correction to my r1 report (stale statement)
My r1 report said the a1-capture-binding stage did not exist yet. That is now stale:
- **`a1-capture-binding-stage` exists** (`SHA256SUMS` `0a5c0bd1…`).
- **Root's run `root-a1-capture-0232`:** 25 tests, 24 PASS, 1 fixture ERROR (`source_swap_after_hashing`). Overall rc 1.
- **50cf is active on a NEW `capture/r2`:** the fixture fix, the runtime interpreter/node pin policy, fsync, and the
  initial-receipt recheck binding (task `logs/a1-capture-r2-root-review-task.txt`).
- **The interface is not finalized,** and no r2 report exists. It is consumed here only as a compatible, explicitly
  incomplete boundary. It is not faked.

## Files (r1 → r2 diffs: `r1-to-r2-*.patch`; vs reviewed bases: `harness-vs-reviewed.patch`, `wrapper-vs-r3.patch`, `producer-vs-r3.patch`)
| file | sha256 | r2 change |
|---|---|---|
| `harness/a2a4.py` | `30273760…` | See below. |
| `wrapper/chain_service.py` | `be6ffa09…` | `watermark_entries`, `watermark_append`, `launch_watermark` (start requires the latest entry = this launch's anchor; read-only) |
| `producer/base_launch.py` | `b5b798f7…` | `RECOVERY_A2A4_SHA256` = `30273760…`. Produce binds the watermark head or `{legacy: true}`. `arm` → `_record_watermark`. `record_finality` HOLD. |
| `tests/test_reanchor_recovery.py` | `aaa7cb3d…` | 13 tests (7 adapted r1 + 6 new) |
| `jobs/root-reanchor-r2-tests.sh` | `001a1425…` | exact counts |

**The harness changes:**
- `watermarkStore` (required) and `legacyNoWatermark` (explicit boolean) in `reanchor`;
- `watermark_entries`, `header_hash` and `gate_watermark`, called at A2 (before saving), plan/A3/A4, and release;
- the capture boundary is reshaped to `(capture_dir, initial)`.

**The producer's `arm` → `_record_watermark`:** under the lock and before the journal genesis, the head must be unchanged
since produce; then the launch-anchor entry is appended. This is idempotent after a crash.

**Unchanged byte copies:** `wrapper/test_chain_service.py` and `tests/test_r3_launcher.py`.

## Design (root decision implemented; routine choices made, not asked)
- **R-A is an offline rebuild into authenticated state only.** It never yields qualified finality. Consumers stay
  unavailable until the real readiness and qualification pass, while the unsafe head may rewind.
- **Watermark rules:**
  - **Below:** an anchor below the latest accepted authenticated-finality entry refuses `watermark_below`.
  - **Conflict:** an anchor at its height with another block refuses `watermark_conflict`. So does a stopped DB whose header
    at that height is another block (checked with the pinned anchor module `headerHash`).
  - **Missing:** no entry refuses `watermark_missing` unless `legacyNoWatermark` is explicitly true. Legacy is refused once
    any entry exists.
  - **Future guarantees:** future `finality-proof` entries (a reviewed acceptance; HOLD today) are honoured in the same way.
    Their existence is not discarded on the grounds that earlier node labels were unauthenticated.
- **Binding chain:**
  1. produce binds the head;
  2. arm requires it unchanged, then appends this anchor;
  3. start requires the latest entry to be exactly this launch.

  An acceptance during the downtime therefore refuses at release, arm, or start.
- **First-bootstrap and baseline semantics are preserved.** No predecessor or watermark field means no store access. The
  existing 34 tests (twice) and the r3 suite (27) run unchanged.

## Reviews requested by root
**gate_download on a reused DB.** It is unchanged and runs on every step. It proves the datadir's **origin**: the receipt,
the pinned manifest and selection, the unit Result **now**, an empty marker, and dev/ino. It does not prove current content;
only A4 does. Tested: a replaced directory refuses `receipt_datadir`, and a non-empty marker refuses.

**Open:** after a reboot, a never-re-run oneshot unit may report systemd's default `success`/`0`, which proves nothing. This
is unverified (no systemd run).

**Crash points:**
- **After retire, before produce:** the wrapper exits non-zero with `FileNotFoundError` before any gate. It fails closed,
  but without a clean refusal message; a cleaner refusal is a possible follow-up.
- **After produce, before arm:** `launch lock unavailable`.
- **After the watermark record, before the journal:** `no launch journal`; re-arm is idempotent.
- **During produce:** a `.partial` sibling may remain; it is not auto-cleaned.
- **During A3 or A4:** unsupported (re-download).

## Tests (NOT run): exact counts 34 + 34 + 27 + 13, no skips
```
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-reanchor-recovery-stage/r2
python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 256 --log $S/logs/root-reanchor-r2-tests.guard -- unshare -rn bash $S/jobs/root-reanchor-r2-tests.sh
```
The job first checks the manifest, the inputs, that the marker is unset, and that no real archive or watermark store exists
on the host. For each suite it requires rc 0, `OK` and the exact `Ran` count.

**The 6 new tests:**
1. missing authority and explicit legacy, and legacy refused once an entry exists; `record_finality` HOLD;
2. below, same-height conflict and DB-header conflict, all refused before any mutation; plus a positive DB-matched lower
   height;
3. downtime refusals at release, arm and start;
4. tamper (edit, gap, writable, symlink, regression, truncation), refused by the harness and the wrapper before consuming;
5. crash points and idempotent re-arm;
6. `gate_download` on the reused DB.

The 7 r1 tests are carried with only the explicit watermark config and the directory-shaped capture boundary changed.

## Status: INCOMPLETE integration (explicit)
- **What works in source:** a same-anchor re-anchor, using the source-pinned initial receipt plus a fresh recheck.
- **Still pending:**
  - a **newer** anchor stays HOLD (`a1_capture_pending`) until 50cf's capture/r2 report exists;
  - then an adapter over its `verify()`/`admit()` summary and the initial-to-recheck binding, installed by a reviewed
    source change.
- **Unmeasured:** downtime and rebuild cost.
- **Residuals:**
  - root-level deletion or restore of the archive, journal or watermark;
  - history below N stays unauthenticated.
- **Not run:** none of this has executed. I checked only syntax and test counts (with `ast`). Root's run is the first
  evidence.
