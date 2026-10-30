# composite-mdbx-validation-stage/r7: gated production entry for the qualified r6 runtime (1802). FROZEN, NOT RUN, NOT PASS

**Status:** source only.
- **Executed by me:** `ast`, `bash -n` and sha256. I read the r6 receipt and r6 files (metadata/source only).
- **Not done by me:** tests, builds, mounts, live-part or original I/O, production runs, or admin/app/wallet changes.
- **Untouched:** the copy driver.
- **Unchanged (SUMS verified):** r1–r6, including the old failed r5 evidence and the r6 PASS run.

**Production is NOT accepted by anything here.** The database is incomplete: 164 GiB of about 1.14 TB is independently verified.

## Qualification evidence bound (actual, root's)
- **r6 stage:** SUMS `06705b02eab351a718234f22c9a53acdbefe3977122682f8f3f7ac25d5b9914a`.
- **Runtime:** `composite_session.py` `407aa7e98fe18f913112b9f49369416e98524ff28f4e44cde788958f314fdbf6`.
- **Guard:** `f64c6115…`.
- **Tests:** `0e087dea…` (12) and `6a66be0d…` (4).
- **PASS receipt** `composite-mdbx-validation-stage/r6/runs/tests-20261027T020755Z-2617132/receipt.json`, sha256 **`c94c4689538744543bad185889e99f69ab6d5b8c0e0aaf79767dc15b1ad74f72`**:
  - `pass` true;
  - Ran 4 + Ran 12, rc 0;
  - `badMarkers` [];
  - every check true;
  - `peersUnchanged` and `noMountLeft` true.

## Stage `composite-mdbx-validation-stage/r7/`, SHA256SUMS `ec006ff6e7b0095c03c108a4d82d8ca1bdbf7515d6858a3b1886fb51c7198396`
| file | sha256 |
|---|---|
| `production_gate.py` (214 lines, stdlib) | `33419b834d896601a4cfa7d82e18282c51327ce94ecb20aec8ee7fa8ee7152eb` |
| `tests/test_production_gate.py` (6 tests) | `2b463412a442a3e969d7684ebb75183309b0cd913616402ec5e661ac5e15d87b` |
| `jobs/tests.sh` (256 MiB, gate tests only) | `f22a4463…` |
| `jobs/root-composite-validate.sh` (manual production entry) | `b7b6032d…` |
| `README.md` | `3bb10cd6…` |

## The gate (replaces the r1–r6 unconditional "DISABLED")
**`production_gate.py`.** Nothing is mounted or started before ALL of these checks pass; each refusal is rc 3 with only `gate-refused.json` written.
1. **The r6 stage:** the SUMS bytes = `06705b02…`, every listed file re-hashed, and the runtime, guard and both test files at their qualified hashes.
2. **The r6 receipt:** **exact bytes** `c94c4689…`, **plus strict fields**:
   - format r6, `pass`;
   - stage, runtime, guard and test hashes;
   - suites exactly `test_session_guard` (Ran 4) and `test_composite_session` (Ran 12);
   - rc 0, `badMarkers` [], exactly the 5 checks, all true;
   - environment `{noMountLeft: true, peersUnchanged: true}`.
3. **The lane:** this process's cgroup v2 `memory.max` = **2560 MiB** exactly (the queue's main lane), and MemAvailable ≥ 16384 + 2560 + 256 MiB.
4. **The real view:** loaded through the **reused** r6 view importer, via the r6 runtime's own pinned loader:
   - `load_view(view_dir, "production")`, then exactly manifest **`f94807f71c93b1ef639c224dfefb3b6c0f3e7b9289def91fc52b0e79864821a9`**, `logicalSize` **1,138,166,333,440** (sectors = /512), **265** parts and kind production;
   - then `recheck`: the manifest bytes; r3 recorded state with **ALL 265 parts committed AND independently verified in CONFIRMED sessions**; qualified orchestrator bindings; every part's identity and record bytes;
   - fixture, incomplete, stale, replaced or foreign inputs refuse.

**Then:** it writes `gate.json` and makes a NEW `session/` dir, and `execv`s the **unchanged r6 runtime** with `--expect-kind production --validator-timeout H*3600`. The runtime re-checks its own pins and the view (pre-use recheck, check-held, required post-use recheck).

**`jobs/root-composite-validate.sh`:**
- verifies the r7 SUMS;
- sources and runs the **qualified r6 `guards`** (pinned stages, the r5/r6 live-session guard with PID/argv diagnostics, stage-mount refusal);
- requires a passing `cmv-r7-gate-tests` receipt for these SUMS;
- runs the gate in a new run dir, then checks that no mount is left.

**It is not launched by the copy driver.**

## Tests (expected `Ran 6 tests`; tiny; the r6 lifecycle is NOT re-run)
1. **Positive:** the actual r6 stage and receipt pass.
2. **Receipt rejections:** the same fields in different bytes; `pass` false; Ran 11; a `skipped` marker; a false check; rc 1; wrong stage, runtime or test hashes; an extra or missing suite; dirty peers; an r5 format.
3. **Stage rejections:** an exact copy passes (content-based); a different SUMS pin refuses; a modified `session_guard.py` refuses.
4. **View rejections:**
   - the pure record check refuses fixture kind, another manifest, size, sectors, 264 parts or no parts;
   - the **reused r6 importer itself** refuses a fixture view as production.
5. **Lane:** memory.max `max`, 512 or 4096, low MemAvailable, and a missing or ambiguous cgroup are all refused; 2560 above the floor passes.
6. **CLI:** outside the 2560 lane it gives rc 3, writes only `gate-refused.json` and never starts a session. A used run dir is refused.

## Root commands
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
# 1. gate qualification (small lane; may run beside the preservation job: reads only frozen files + its tmp)
bash jobs/q-exit-status.sh cmv-r7-gate-tests 256 bash composite-mdbx-validation-stage/r7/jobs/tests.sh                      # "## PASS (6)"
# 2. ONLY after ALL 265 parts are committed + verified (r3 status) AND the r6 production view exists (view r6 jobs/root-view-import.sh)
#    AND root has coordinated the 2560 MiB main lane, the 16 GiB host floor and the duration window:
bash jobs/q-exit-status.sh cmv-r7-prod 2560 bash composite-mdbx-validation-stage/r7/jobs/root-composite-validate.sh VIEW_DIR MAX_HOURS
# stop that session only:
bash composite-mdbx-validation-stage/r6/jobs/stop-session.sh <run>/session
```

## Explicit limits
- **Fixture proof only:** the gate and the r6 runtime are fixture-proven. **No production run has happened, and no production acceptance is claimed.**
- **Not yet runnable:** the production database is incomplete (164 GiB of about 1.14 TB verified), and the r6 production view does not exist yet. The gate will refuse until both are true.
- **Unmeasured at production scale:** a ~1.13 TB read through QEMU vmdk → NBD → FUSE, mdbx_chk's ~556 MB pagemap and its duration. 2560 MiB is a supported placeholder lane, not a measurement. If the cgroup limit bites, the mdbx_chk run ends INCONCLUSIVE or killed, never CLEAN.
- **CLEAN is structural only (mdbx_chk):** canonical-root, state, trie and chain validation are separate and still required.
- **Unchanged r6 runtime limits:** the 8 KiB mdbx_chk tail in the wrapper report; detection, not prevention, for same-user writes; no RPC or SNP readiness.
- **Paused, as directed:** original USB writes, the download and VM boot.
