# composite-mdbx-validation-stage/r9 = r8 + narrow fixes (PREPARED by Claude 1829; NOT run; NOT PASS; inactive until root's review and all prerequisites)
Report: ../../logs/claude-composite-r9-fix-1829.md (r8 report 1825; root 1828; review 1827). r1–r8 are unchanged; **the r7 2560 MiB path is not used.**
r8's 10 tests actually PASSED on root's 256 MiB small lane (runs/tests-20261027T043205Z-2760587).

**r9 changes:**
1. **`jobs/stop-session.sh` → `memory_gate.py stop SESSION`.** It reads `SESSION/session.pid`, opens a pidfd, checks the start time and owner, then checks the EXACT r9 runtime argv (its own `--run-dir SESSION`, production, no fixture exec). Only then does it send SIGTERM, through that pidfd only. It is never the r6 helper, a group or the queue.
2. **`jobs/final-status.sh`.**
   - A nonzero runtime rc is preserved.
   - Runtime 0 stays 0 ONLY with a well-formed final job receipt (generated with rc 0, the same rc, all final checks true, CLEAN). Otherwise the exit is 10 and `J/FINAL-EVIDENCE-FAILED` is written.
3. **`memory_gate.py guard`.** It refuses while a REAL python `memory_gate.py gate|runtime` process of this user is live, using the pinned r6 `session_guard` parser; text mentions do not count. The r6 guards and queue exclusion are unchanged.
4. **Telemetry (review A1).** ANY failure in the telemetry tick, reading or processing, is a counted error (bounded list); 3 in a row means an ordered soft stop. A SoftStop still propagates.
5. **File bounds (review A2).**
   - The job's own files run under `ulimit -f 1024` (≤ 1 MiB each), within the 16 MiB small-files allowance. The 208 MiB output budget is unchanged.
   - The queue's own `logs/cmv-r9-prod.*` are external.
6. **Tests:** 15 = r8's 10 + stop, final-status shell, guard, injected processing failure, and the real r6 `main` soft-stop cancellation (stubbed view/exposure, `sleep` stand-in; test-only).

---
**r8 README (unchanged in meaning; read r9 for paths/commands):**


## LIMITS (read first)
- **MemoryHigh is not a ceiling.** It is 3712 MiB, a reclaim/throttle threshold, and it applies to the **whole** 4096 MiB queue scope: the node guard, job bash, runtime, qemu-nbd, nbdfuse, wrapper and mdbx_chk can all be throttled, which can delay the outer guard and slow the servers.
- **The memory.max OOM victim is not guaranteed.**
- **The soft stop races the outer guard:** it checks every 0.5 s (tree VmRSS > 3840 MiB, or MemAvailable < 16896 MiB), against the outer guard's 250 ms tree-VmRSS check and other host allocations.
- **Production page tables (~used bytes / 512) and mdbx_chk's pagemap (~2 bytes/page) are ESTIMATES.** The r4 mechanism PASS (8 GiB synthetic: 28.4 s, tree RSS 526 MiB, current 537 MB, page tables 18 MB, 23,378 high events, 0 max/oom) supports the mechanism only.
- **CLEAN is STRUCTURAL ONLY** (the unmodified mdbx_chk via the unmodified r4 wrapper). It is not chain, state, trie, canonical-root or RPC validation, and not a production acceptance.

## What it is (`memory_gate.py`, one file)
**`gate`** (rc 3 on any refusal; writes only `gate.json` or `gate-refused.json` into a NEW empty run dir):
1. **RLIMIT_FSIZE** ≤ 32 MiB (the job's `ulimit -f`).
2. **Qualifications** (exact bytes):
   - r7 SUMS + gate + its actual 6-test PASS receipt;
   - through r7's own `check_stage`/`check_receipt`: the r6 stage and its exact 4+12 qualification receipt;
   - r4 SUMS + `memory_fixture.py` + its actual tests PASS (11), job PASS (MEASURED, peers unchanged, nothing left) and fixture receipt (8 GiB scanned, high events, no OOM event, parent unchanged).
3. **Our cgroup:**
   - exactly one user-manager `run-*.scope` with **memory.max == 4096 MiB** and memory.high == max;
   - the job bash is our ancestor in the same cgroup;
   - MemAvailable ≥ 16 GiB + 4096 + 256 MiB.
4. **Reservations** (the pinned 1773 runner's `part_state` via the pinned r4 helper):
   - root free ≥ remaining + 40 GiB + 8 GiB native + a 208 MiB output budget;
   - /vm free ≥ remaining + 40 GiB;
   - the run dir on the pinned root target filesystem, not USB.
5. **The real production view** through r7's `check_view`: the pinned r6 importer's `load_view(production)` + recheck, i.e. **all 265 parts committed and independently verified in CONFIRMED sessions**, plus the incident manifest, size and part count.
6. **Only then MemoryHigh=3712M** on that scope, via the pinned r4 setter: the binding is checked before; own high/max and the parent are verified after.
7. **`execv` of the runtime.**

**`runtime`:** the **unchanged r6 `main()`** (`composite_session.py 407aa7e9…`: lifecycle, ordered cleanup, post-use recheck, receipt) with:
- **children:** `CHILD_FSIZE` lowered from 64 to 16 MiB;
- **a `Session` subclass that adds:**
  - bounded memory telemetry, ticked by r6's own 0.5 s validator poll: cgroup current/events/stat, tree VmRSS, MemAvailable, and the wrapper's and mdbx_chk's VmRSS/RssFile/RssAnon/VmPTE; at most 2048 samples, one per 120 s; no `smaps_rollup`, and nothing reads the DB;
  - an **ordered soft stop:** a `Stop` raised inside r6's validator loop, which r6 records as CANCELLED, never CLEAN, followed by r6's full ordered cleanup;
  - **post-use:** the bound nbdfuse must also still be the same process, otherwise VOID;
- **a classify wrapper:** any change in `memory.events` oom/oom_kill/oom_group_kill (or unreadable counters) downgrades CLEAN or PROBLEMS to **INCONCLUSIVE**.

## Root commands (never automatic)
```
bash jobs/q-exit-status.sh cmv-r9-tests 256 bash composite-mdbx-validation-stage/r9/jobs/tests.sh      # expect "## PASS (15)"
# production ONLY after root's review, all 265 parts confirmed + the production view, and a coordinated 4096 MiB main-lane window:
bash jobs/q-exit-status.sh cmv-r9-prod 4096 bash composite-mdbx-validation-stage/r9/jobs/root-composite-validate.sh VIEW_DIR MAX_HOURS
# stop: bash composite-mdbx-validation-stage/r9/jobs/stop-session.sh <r9 runs/prod-ID>/session
```
