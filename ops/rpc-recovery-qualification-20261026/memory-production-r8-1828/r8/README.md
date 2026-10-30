# composite-mdbx-validation-stage/r8: memory-aware PRODUCTION gate + runtime (PREPARED by Claude 1825; NOT run; NOT PASS; NO production permission)
Report: ../../logs/claude-composite-production-memory-1825.md. r1–r7 are unchanged; **the r7 2560 MiB path is not used.**

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
bash jobs/q-exit-status.sh cmv-r8-tests 512 bash composite-mdbx-validation-stage/r8/jobs/tests.sh      # expect "## PASS (10)"
# production ONLY with explicit permission, all prerequisites met, and a coordinated 4096 MiB main-lane window:
bash jobs/q-exit-status.sh cmv-r8-prod 4096 bash composite-mdbx-validation-stage/r8/jobs/root-composite-validate.sh VIEW_DIR MAX_HOURS
```
