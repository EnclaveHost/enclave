# Base R-A re-anchor recovery r3 (real A1 capture binding): PREPARED (source-only; tests NOT run; NOT enabled)

**Stage:** the NEW `base-reanchor-recovery-stage/r3/`. `MANIFEST.sha256` =
`ad3f6bdc5e7beb6170b63f65ffb237ff81aba9fa1c2afac12751fe5405e6ac4b`.
- **Not done:** no tests, build, queue, network, SSH, live action or commit.
- **Originals frozen and verified intact:** r1 (`02abf9be…`) and r2 (`458b55ab…`).
- **capture/r2 is consumed read-only.** Its `SHA256SUMS` is `100eb666…`; the job re-verifies it.
- **HOLD flags stay False:** `LAUNCH_PRODUCER_REVIEWED`, `FINALITY_PROOF_REVIEWED`, and the new `A1_CAPTURE_REVIEWED`.
- **Not activated.** No independent fresh capture is claimed: every test capture runs over pinned STUB sources. This is
  source qualification only; the runtime pins are operator-observed, and nothing here is SNP.

## Root's original run (read: `logs/root-reanchor-recovery-0232.out`, pinned)
- **Totals:** 102 tests; `aggregate rc=1`; queue EXIT 1.
- **Passed:** baseline 34, recovery-existing 34, r3-regression 27.
- **Failed:** reanchor 7 ran, 6 passed, and 1 ERROR in `test_bounds_are_derived_never_widened` (`bad_config: a1RecheckSha256 must
  be 64 lowercase hex`).

**Cause:** the fixture's `cfg_with` used `use_recheck` but never `write()`, which is what sets `a1RecheckSha256`. As root
noted, the same defect was carried into r2.

**Fixed in r3:**
- `cfg_with` writes;
- `bad_config` asserts the exact reason string, so no case can pass for a wrong reason;
- the explicit watermark mode lets the positive case reach the actual target bound: `step_plan` plans the unwind to N.

## Integration of the actual capture/r2 interface (per `R2-CHANGES.md` §5)
| file | sha256 | change |
|---|---|---|
| `harness/a2a4.py` | `c15f142c…` | See below. |
| `producer/base_launch.py` | `6b48fc27…` | `RECOVERY_A2A4_SHA256 = c15f142c…`. In capture mode, `_initial_ok` re-verifies the A2-recorded binding via `capture_binding`, admitting nothing, and the launch records `a1Capture.initialCapture`. |
| `wrapper/chain_service.py` | `be6ffa09…` | unchanged from r2 |
| `tests/test_reanchor_recovery.py` | `f6c0a31c…` | 14 tests |
| `tests/capture-stubs/a1-read.mjs`, `a1-recheck-read.mjs` | `92c8a22a…`, `460c444e…` | test read stubs emitting harness-fixture receipts |
| `jobs/root-reanchor-r3-tests.sh` | `64b6e732…` | exact counts |

**The harness changes:**
- **`a1Mode capture-recheck`** (re-anchor only). It is the only path to a newer anchor.
- **`load_capture`:** executes `a1_capture.py` from its exact pinned bytes `2352df7b…`. It is HOLD unless reviewed.
- **`capture_binding`:** at A2, it verifies the initial capture and records it in `a2-authenticated.json`. Later steps take
  the expected initial sha from that record, never from config or a recheck, and verify the recheck with `initial_out` and
  the expected sha. It also applies `finishedAt` freshness.
- **The existing pinned A1 gate and all Python checks** run over the re-read, sha-matched evidence.
- **`admit_captures`:** a durable `O_APPEND` + fsync + directory-fsync ledger, written after all checks pass and before the
  step proceeds.
- **The r2 placeholder verifier is removed.**

**What is preserved:**
- the same-anchor path (source pin only), the watermark rules, lineage and first bootstrap;
- the baseline suites, byte-identical;
- the admin, apps and unit drop-in: there is no wrapper change.

## Tests (NOT run) and exact counts
```
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-reanchor-recovery-stage/r3
python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1024 --log $S/logs/root-reanchor-r3-tests.guard -- unshare -rn bash $S/jobs/root-reanchor-r3-tests.sh
```
**The job first checks:** the r3 manifest, the inputs, the capture/r2 `SHA256SUMS`, that the marker is unset, and that no
real archive or watermark store exists. It puts `TMPDIR` on disk, because each capture copies the 56 MB node binary.

**PASS requires** each suite to have rc 0, a final line of exactly `OK`, the exact `Ran` count, and no skip:

| suite | exact count |
|---|---|
| baseline-existing | 34 |
| recovery-existing | 34 |
| r3-regression | 27 |
| reanchor-recovery | **14** |

The aggregate must be rc 0. Queue exit 98 means the job did not start.

**The 14 tests:**
- **Real-capture tests (3).** These use the REAL capture module and the REAL pinned gate, which is byte-identical in
  capture/r2 and the harness, over the stub sources. There is no substitute verifier or gate.
  1. **A newer anchor N+3000 recovers end to end:** the initial capture plus 4 recheck-captures, 5 ledger admissions, and a
     one-shot exec with `N2:hash`.
  2. **Refusals:**
     - HOLD (the real default);
     - replay of an admitted recheck;
     - another genuine initial than A2 recorded;
     - a recheck of another initial;
     - module bytes that are not the pin;
     - a stale recheck;
     - an untrusted ledger;
     - the initial tampered after A2.

     Each refuses before any unwind. A restored, unused recheck then passes.
  3. **Capture-mode config rules.**
- **Carried (9):** end to end same anchor ×2, lineage ×2, the 6 watermark tests.
- **Also (2):** the bounds test (fixed), and the source-pin-only rule plus the capture-module pin (`A1_CAPTURE_SHA256` ==
  the actual r2 file).

## Limits
- **First-run risks:** the capture paths have never run. Root's 36-test capture/r2 run is still queued, so its own
  first-run risks apply here too: `/proc/self/maps`, fd exec, and recursive verify under `unshare -rn`.
- **Untested assumption:** the stub-emitted fixture receipts are assumed to pass the real gate exactly as the harness
  fixture's receipts do (same gate bytes, same input shape).
- **Strict admission:** a step that fails after admission needs a NEW recheck capture. This is fail-closed, never a replay.
- **Unmeasured:** downtime and rebuild cost.
- **Residuals:**
  - root-level deletion or restore of the ledger, watermark, archive or journal;
  - history below N stays unauthenticated.
