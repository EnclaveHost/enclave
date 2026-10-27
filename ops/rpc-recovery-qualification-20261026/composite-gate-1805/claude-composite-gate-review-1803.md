# 1803: independent source-only review of the frozen composite-mdbx-validation-stage/r7 production gate (NOT a production acceptance)

**Scope:** reading and hashing only.
- **What I read:** `production_gate.py`, the r7 jobs and test names, the author report 1802, the r6 stage/receipt/guards, the r6 importer record shape, `claude-test-queue.py` (from 1786), and `enclave/test/helpers/memory-guard.mjs`.
- **Not done:** tests, builds, mounts, live part reads, production actions, or anything touching the healthy preservation driver (copy 41..48).

## Hashes verified
| item | sha256 | result |
|---|---|---|
| r7 `SHA256SUMS` | **`ec006ff6e7b0095c03c108a4d82d8ca1bdbf7515d6858a3b1886fb51c7198396`** | all 5 entries OK |
| r7 `production_gate.py` (214 lines) | `33419b834d896601a4cfa7d82e18282c51327ce94ecb20aec8ee7fa8ee7152eb` | = the receipt's `gateSha256` |
| r7 `tests/test_production_gate.py` (6 tests) | `2b463412a442a3e969d7684ebb75183309b0cd913616402ec5e661ac5e15d87b` | = the receipt's `testsSha256` |
| r7 gate-test receipt `runs/gate-tests-20261027T021511Z-2624653/receipt.json` | `24d3a989…` | pass, `Ran 6`, `OK`, rc 0, `stageSums` = r7 SUMS; `logs/cmv-r7-gate-tests.rc` = 0 |
| r6 `SHA256SUMS` | `06705b02eab351a718234f22c9a53acdbefe3977122682f8f3f7ac25d5b9914a` | = `R6_SUMS`; all 9 entries OK |
| r6 runtime `composite_session.py` | `407aa7e98fe18f913112b9f49369416e98524ff28f4e44cde788958f314fdbf6` | = r4 (the r3 runtime, unchanged) |
| r6 `jobs/session_guard.py` / `tests/test_session_guard.py` / `tests/test_composite_session.py` | `f64c6115…` / `6a66be0d…` / `0e087dea…` | = `R6_FILES` |
| r6 qualification receipt `runs/tests-20261027T020755Z-2617132/receipt.json` | **`c94c4689538744543bad185889e99f69ab6d5b8c0e0aaf79767dc15b1ad74f72`** | = `R6_RECEIPT_SHA` |
| r6 importer `multipart-validation-view-stage/r6/production_import.py` (pinned by the r6 runtime) | `4d48f74ea0360db6b264fcef97750a5c83e3ba5f8ef47260864b93e940b1b2dc` | matches; view stage SUMS `18bab7be…` |

**The r6 receipt content matches `check_receipt_fields` exactly:**
- format `composite-mdbx-validation-test-receipt/r6`, `pass` true;
- `stageSums`/`sessionSha256`/`guardSha256` as pinned;
- `environment` = `{noMountLeft: true, peersUnchanged: true}`;
- suites exactly `test_session_guard` (`ran ["4"]`, rc 0, no bad markers, 5 checks all true, tests sha `6a66be0d…`) and `test_composite_session` (`ran ["12"]`, …, `0e087dea…`).

**The importer record shape is compatible:** r6 `production_import` writes `kind`, `manifestSha256`, `logicalSize`, `sectors` (= logicalSize // 512) and `parts`. These are exactly what `check_view_record` reads. `load_view(view_dir, kind)` and `recheck(rec)` have the signatures the gate calls.

## Verdict
**The gate is correct as a fail-closed precondition check, and I found no unsafe activation path:**
- **Not launched by any driver:** it starts nothing before every check passes, then execs the **unchanged, fixture-qualified r6 runtime** with `--expect-kind production`.
- **The r6 runtime re-checks its own pins and the view** (`load_view(production)` + `recheck`). Cleanup, lifecycle and outcomes are entirely the r6 runtime's.

**One concrete resource finding (R1) needs root's decision before any launch.** It is not a gate defect.

## Production activation is impossible before the prerequisites (verified)
**The view must be the real production view:** `load_view(…, "production")` through the importer pinned by the r6 runtime and loaded from its exact hashed bytes. The view receipt (`multipart-view-receipt/v2-records`) is only produced by `root-view-import.sh`, which itself requires complete recorded state.

**`recheck` re-requires r3 `status`** (via the importer):
- `copyComplete`, `verificationCompleteRecorded`, and `partsCommitted == partsVerifiedRecorded == 265`;
- `stale`/`unconfirmed`/`invalid`/`failed` empty;
- a production binding counts only via a **CONFIRMED** session record;
- every part's current identity and record bytes equal the receipt's.

**The gate additionally requires:**
- manifest `f94807f7…`;
- `logicalSize` 1,138,166,333,440 and `sectors` = /512;
- exactly 265 parts;
- kind production.

These are checked before (cheap) and after `recheck`. Between the gate and the exec, the r6 runtime repeats `load_view`(production) + `recheck`. r3 `check_production` pins every production manifest to the incident constants, so a swapped view cannot pass.

**Further conditions:**
- a refusal writes only `gate-refused.json` in the new empty run dir and exits 3, with nothing mounted or started (test 6);
- the job additionally requires the latest r7 gate-test receipt to pass for these SUMS, and runs the **qualified r6 `guards`**: pinned stages, `session_guard.py` (a real live session refuses), and no stage mount.

## Lane and floor (verified)
- **Gate check:** `memory.max` of the gate's own cgroup must be exactly 2560 MiB (the `systemd-run --scope -p MemoryMax=2560M` of `claude-test-queue.py`), and MemAvailable ≥ 16384 + 2560 + 256 MiB. Test 5 refuses `max`, 512, 4096, a low MemAvailable, and a missing or ambiguous cgroup.
- **Exclusivity:** the 2560 job holds the queue's exclusive main flock for its whole run. That excludes 1024 MiB preservation jobs; a queued batch would retry rc 98 for about 6 h, then the driver stops. The prerequisite (all 265 parts done) makes the driver idle by then anyway.
- **Recent host MemAvailable** in the queue logs is about 24 GiB, so admission (about 19.2 GiB) is feasible.

## R1 (resource; decide or measure before a multi-day launch): the queue's memory guard counts mdbx_chk's mapped DB pages and will likely kill the tree mid-run
**The cause:**
- `memory-guard.mjs` sums **VmRSS** over the whole process tree. If that sum exceeds `--max-rss-mib` (= the lane, 2560), it SIGTERMs **every descendant at once** and SIGKILLs them **2 s later**.
- libmdbx/mdbx_chk **mmaps** `mdbx.dat` (FUSE, page cache, no `direct_io`). Resident mapped file pages count in VmRSS.
- A full structural walk of a 1.13 TB DB touches far more than 2.5 GiB, and the cgroup `memory.max` (also 2560) only reclaims down to about the limit.
- Shared libraries are counted once per process across the ~5 processes.

**So the tree VmRSS is likely to reach and cross 2560 MiB** (likely, not proven; it depends on reclaim balance).

**Consequences, all fail-closed:**
- there is never a CLEAN and no data risk: parts are opened read-only and the original is not involved;
- **but** the guard's simultaneous TERM bypasses the r6 ordered cleanup (validator, then unmount, then servers), and the 2 s KILL is shorter than r6's own waits (up to 5 s per group, a 30 s unmount);
- so **the r6 receipt may never be written**, and a **dead FUSE mount may remain** under `r7/runs/prod-*`. The r6 stage-mount guard would then refuse every later composite job until root detaches it (`fusermount3 -u -z`, our mount only);
- days of runtime could be lost.

**Evidence and scope:**
- the 1802 limit note says "INCONCLUSIVE or killed", but does not state the guard mechanism or these consequences;
- fixture peaks (r6: `peakTreeRssMiB=108`) cannot show this;
- the real-view RSS growth rate is unmeasured here.

**No-framework options for root:**
1. Accept and measure: a deliberately short first production window (e.g. `--max-hours 1`). Read `[memory-guard] peakTreeRssMiB` in the queue log and the runtime receipt, with the mount-left handling above ready.
2. Choose a lane or guard policy in a **new reviewed revision**. The gate pins exactly 2560, so any change needs r8.

Either is root's decision. Nothing in r7 is wrong as written.

## Minor
- **Unhandled `execv` failure:** if `os.execv` fails (e.g. `ENOMEM`), the gate exits with a traceback (rc 1) after writing `gate.json` and an empty `session/`. Nothing is started; it is harmless.
- **How to stop:** use `r6/jobs/stop-session.sh RUN_DIR/session` (the recorded session PID). Signalling the queue gives the same 1 s or 2 s all-at-once kill as R1.

## Limits
- **Gate only:** the r7 6 PASS proves the gate's acceptance and rejection logic on frozen files and synthetic inputs. **It never ran a production view, part read, mount or mdbx_chk.**
- **Lifecycle evidence is fixture-scale:** the r6 4 + 12 PASS used tiny MDBX fixtures. Production scale (1.13 TB via vmdk → NBD → FUSE, duration, memory) is unmeasured.
- **No production run exists yet:** I make no claim of a production acceptance or of any CLEAN.
- **Output retention:** the r4 checker keeps only the last 8 KiB of mdbx_chk text; truncation is classified INCONCLUSIVE.
- **CLEAN is STRUCTURAL ONLY:** canonical-root, state, trie and chain validation are separate, as are RPC/SNP readiness.
- **Unchanged pauses:** USB writes, download and VM boot remain paused; this review touched none of them.
