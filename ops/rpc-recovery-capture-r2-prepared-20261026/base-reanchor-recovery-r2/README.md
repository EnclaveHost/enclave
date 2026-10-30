# base-reanchor-recovery-stage/r2: R-A recovery with a persisted authenticated-finality watermark (PREPARED; NOT run; NOT enabled)

The frozen r1 stage (`../MANIFEST.sha256` `02abf9be…`, root run in progress) is untouched. r2 changes NEW copies only. The
bases are in `base/`. The patches are `r1-to-r2-*.patch`, plus `harness-vs-reviewed.patch`, `wrapper-vs-r3.patch` and
`producer-vs-r3.patch`. The HOLD flags stay False: `LAUNCH_PRODUCER_REVIEWED`, `FINALITY_PROOF_REVIEWED`, and
`A1_CAPTURE_VERIFIER = None`.

## Root design decision implemented
- **R-A is an offline rebuild into authenticated state only.** It never qualifies finality: there is no `bootstrapped`
  state and no finality writer (`record_finality` is HOLD).
- **Consumers stay unavailable** until the real readiness and qualification paths pass. The unsafe head may rewind;
  regressed labels are never exposed as qualified finality.
- **Accepted finalized guarantees are never discarded.** The persisted watermark below is the record of accepted
  authenticated finality. The fact that the pre-existing node labels were never authenticated is not used as permission to
  go below it.

## The authenticated-finality watermark
**Store:** `/etc/enclave-rpc/base-finality-watermark/NNNNNN.json`. Entries are root-owned, hash-chained and appended durably
(fsynced sibling, link, directory fsync, re-verify).

**Entry:** `{format, seq, prevSha256, number, blockHash, kind, ref, at}`. The kind is `launch-anchor` (written by root `arm`)
or `finality-proof` (a future reviewed acceptance, HOLD today).

**Chain rules** (harness `watermark_entries`, wrapper `watermark_entries`; same rules):
- contiguous seq, the hash chain, the exact key set;
- `number` never decreases, and one block per height;
- no symlinks, no group/other write.

**Gates** (harness `gate_watermark`; re-anchor configs only):
- **Where it runs:** A2 (after header N is authenticated, before anything is saved), plan/A3/A4, and **release**.
- **Below:** `N < head.number` → `watermark_below`.
- **Conflict at the same height:** `N == head.number` with another anchor block → `watermark_conflict`.
- **The stopped DB's header at `head.number`** must hash to `head.blockHash` (pinned anchor-module `headerHash`). Otherwise
  `watermark_conflict` (another chain).
- **Missing authority:** a store with no entry refuses `watermark_missing`, unless `reanchor.legacyNoWatermark` is
  explicitly true. Legacy is refused once any entry exists (`watermark_legacy`).

**Binding:**
- `produce` binds the head (or `{legacy: true}`) into the launch record.
- `arm`, under the lock and before the journal genesis:
  - requires the head unchanged since produce; otherwise it refuses `watermark`;
  - then appends this launch's anchor as a `launch-anchor` entry;
  - is idempotent after a crash.
- **Start:** the wrapper starts a re-anchor launch only while the latest entry is exactly this launch's `launch-anchor`. The
  wrapper is read-only on the store, so no unit drop-in change is needed.
- **First bootstrap (r3) is unchanged:** no predecessor and no watermark field means no store access.

## gate_download on the reused DB (actual code reviewed)
`gate_download` is unchanged and runs in every re-anchor step, via `gate_static`. On a DB that has run it still checks:
- the receipt fields (manifest sha, block 53,048,526, unit, datadir path);
- the pinned manifest bytes and the archive selection;
- `systemctl show` Result/ExecMainStatus of the snapshot unit **now**;
- the marker is empty;
- the datadir **dev/ino**.

So it attests the datadir's **origin** (that download into this directory), not its current content. A4 at N is the only
current-state proof. The tests prove that a replaced directory (same bytes, new inode) refuses `receipt_datadir`, and that a
non-empty marker refuses.

**Open for root:** after a reboot, a never-re-run oneshot unit may report systemd's default `Result=success`/`0`. If so, that
check proves nothing. This is not verified here (no systemd run).

## Crash points (each fails closed; tested where marked T)
| crash | effect |
|---|---|
| after rollback, before retire | Terminal journal; the wrapper refuses; retire is repeatable |
| during retire | Atomic rename: the dir is either in place or archived |
| after retire, before produce (T) | No launch dir. The wrapper exits non-zero (`FileNotFoundError` in the lock path) before any gate. It fails closed, but without a clean refusal message |
| during produce | A `.base-bootstrap.partial-<pid>` sibling may remain (not auto-cleaned); the wrapper refuses |
| after produce, before pin or arm (T) | Pin mismatch, or `launch lock unavailable` |
| after the watermark record, before the journal genesis (T) | The wrapper refuses (`no launch journal`). Re-arm is idempotent (no second entry), then the one-shot start |
| a watermark accepted during downtime (T) | `release` refuses `watermark_below`; `arm` refuses `watermark` (changed since produce); a start refuses unless the head is this launch |
| during A3 or A4 | The harness journal marks it interrupted. DB state unknown: re-download (unsupported) |

## A1 capture interface: INCOMPLETE (not faked)
- **50cf's state:**
  - `a1-capture-binding-stage` exists. Root's run had 25 tests: 24 PASS and 1 fixture ERROR.
  - 50cf is preparing `capture/r2`: the fixture fix, runtime pins and fsync, and an initial-receipt-to-recheck binding.
  - The interface is not final, and there is no r2 report yet.
- **The boundary here:** `A1_CAPTURE_VERIFIER(capture_dir, initial_bytes) -> {captureSha256, initialSha256, N, game,
  outputRoot}`. It is shaped after r1's directory-based `verify()` summary. It stays None (HOLD), so a **newer** anchor
  refuses `a1_capture_pending`.
- **What works today:** a same-anchor re-anchor, using the source-pinned initial receipt with a fresh original-game recheck.
- **Integration step:** an adapter, plus the recheck-of-the-new-initial binding. Both are written only after 50cf's r2
  report exists.

## Tests (NOT run): `jobs/root-reanchor-r2-tests.sh`, exact counts 34 + 34 + 27 + 13, no skips
- **Kept, adapted:** r1's 7 tests. The only changes are the explicit watermark config (`reanchor_config`) and the
  directory-shaped capture boundary; the r1 capture-record sha and untrusted-record checks move into the pending verifier.
- **6 new tests:**
  1. missing authority and explicit legacy, and legacy refused once an entry exists; `record_finality` HOLD;
  2. below and conflict refusals (same-height conflict, DB-header conflict) before any mutation, with a positive case at a
     lower DB-matched height;
  3. downtime: refusals at release, arm and start;
  4. watermark tamper (edit, gap, writable, symlink, regression, truncation), refused by the harness AND the wrapper before
     consuming;
  5. crash points (retire→produce, produce→arm, watermark-record→journal) and idempotent re-arm;
  6. `gate_download` on the reused DB.
- **Baseline:** the existing 34 (twice) and the r3 suite (27) run unchanged.
