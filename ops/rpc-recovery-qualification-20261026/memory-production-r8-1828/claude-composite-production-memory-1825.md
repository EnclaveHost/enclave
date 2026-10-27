# 1825: composite-mdbx-validation-stage/r8, a memory-aware production gate + runtime (FROZEN, PREPARED ONLY: NOT run, NOT PASS, NO production permission)

**Scope:**
- **What I executed:** reading bounded metadata and source (the r4 actual receipts, r7 gate, r6 runtime, r4 fixture helpers, 1773 runner, the r4 wrapper's output paths); writing the NEW r8; `ast`; `bash -n`; `sha256sum`.
- **Not done:** tests, queue jobs, production runs, mounts, scope changes, builds, network, installs or commits. No access to the original or any part bytes; no change to the driver, the queue, reservations, any frozen stage or the source repo.
- **Integrity re-checked:** composite r1–r7 and memory-fixture r4 all re-verify against their SUMS.

## The evidence it builds on (root's ACTUAL r4 run; read, pinned by exact bytes)
| receipt | sha256 | key facts |
|---|---|---|
| r4 tests | `559ed6d5b80ef83631a01193650eef316d5d00f3abc677eb2eaf910939c8048a` | pass, `Ran 11`, stage `25245e21…`, fixture `f1e04105…` |
| r4 job | `c24bc095716c9b8cfb44e60d28d0420a3c82579c86821df0fb9af3cb61521b3c` | pass, MEASURED, rc 0, peers unchanged, no mount or process left |
| r4 fixture | `f7b11bb1ac9ef5cc5621d6ba0f17e8775bc5619b5f82678495aaef81fe2e500a` | 8 GiB in 28.417 s, 0 nonzero; tree RSS 525.7 MiB; current 536,997,888 B; page tables 18,059,264 B; walker PTE 16,488 KiB; high events 0 → 23,378; max/oom/oom_kill 0; parent `memory.high` unchanged |

**This supports the reclaim mechanism at 8 GiB on this kernel only.** It does not establish production integrity or memory safety.

## Frozen r8: `composite-mdbx-validation-stage/r8/SHA256SUMS` = **`7472d522a6acb4f51f22ebc95197a54bfc568b872c63344cc8ceb519ae809b82`** (5 entries, read-only)
| file | sha256 |
|---|---|
| `memory_gate.py` (gate + runtime) | `f9eb0d08a00eecedf99785d16a869cd9148d0fd5bb382b70df14b0440e1bb90c` |
| `tests/test_memory_gate.py` (10 tests) | `6dd1f5d1f6e05ee45932845cf34b9cd486129a151d5a1d9f6fdd4242171c8a77` |
| `jobs/tests.sh` (gate: exactly `Ran 10 tests`, `OK`, empty stdout, no ResourceWarning/skip/FAIL/ERROR/Traceback) | `568fc454f6275aafa6a7f34476ad2c7a01042935e39a9ece4ba7aed80dc952ce` |
| `jobs/root-composite-validate.sh` (manual production) | `b3bf7e0e09296e5c0339db7189b8178a48ead498bd6e9ff5e789c85687a6e8af` |
| `README.md` (LIMITS first) | `62bf753cc2ab41907f99ca167d48758f303a2bdbb72ed70abb35cd0cf398f111` |

**Pins inside `memory_gate.py`:**

| pinned item | sha256 |
|---|---|
| r7 `production_gate.py` | `33419b83…` |
| r7 SUMS | `ec006ff6…` |
| r7 actual gate-test receipt | `24d3a989…` |
| r6 runtime | `407aa7e9…` (via r7: r6 SUMS `06705b02…` and the exact 4+12 receipt `c94c4689…`) |
| r4 `memory_fixture.py` | `f1e04105…` |
| r4 SUMS | `25245e21…` |
| the three r4 receipts | above |
| production manifest | `f94807f7…` |

**Through the pinned helpers:** the 1773 runner (`5c33f6e2…`), which re-verifies frozen r3, and r3 core (`3159890b…`).

## Exact changes, as composition (no r1–r7 / r4 byte changes, no duplicated lifecycle)
**`gate`** (new; reuses r7's functions and r4's helpers on a PRIVATE module instance):
1. **Run dir:** it must be an existing, EMPTY, 0700, real absolute directory; otherwise it refuses and writes nothing.
2. **`fsize_ok`:** RLIMIT_FSIZE ≤ 32 MiB (the job's `ulimit -f 32768`).
3. **`check_qualifications`:**
   - `R7.check_stage(R7D, r7 SUMS, {production_gate.py})` plus the r7 gate-test receipt fields (pass, `Ran 6`, all checks, stage + gate shas);
   - `R7.check_stage()` and `R7.check_receipt()` (r6 stage and the exact 4+12 receipt);
   - `R7.check_stage(R4D, r4 SUMS, {memory_fixture.py})` plus strict field checks of the three r4 receipts.
4. **`bind_scope`:**
   - via r4 `scope_of`: exactly one user-manager `run-*.scope`;
   - **memory.max == 4096 MiB exactly**, `memory.high == max`;
   - MemAvailable ≥ 16384 + 4096 + 256 MiB;
   - the tree root (job bash) is our ancestor in the same cgroup.
5. **`reservation`** (pinned runner `part_state` via r4 `root_remaining`):
   - root free ≥ remaining + 40 GiB floor + **8 GiB native** + **208 MiB output budget**;
   - /vm free ≥ remaining + 40 GiB;
   - the run dir on the pinned root target filesystem (majmin, UUID, not USB).
6. **The view:** `R7.check_view(view)` = the pinned r6 importer's `load_view(production)` + `recheck`: **all 265 committed + independently verified in CONFIRMED sessions**, bindings, identities, record bytes, the incident manifest, size and 265 parts.
7. **The only mutation, last:** r4 `set_memory_high` with `LANE_MIB=4096`, `HIGH_MIB=3712` (private instance).
   - **Before:** ControlGroup == our cgroup, `memory.high` was max.
   - **After:** own high 3712 MiB, own max unchanged, **parent unchanged**, systemd agrees.
   - **Then:** we are still in the scope and memory.max is still 4096.
8. **Output:** writes `gate.json`, creates `session/` (0700), and **execs** `memory_gate.py runtime --tree-root-pid N -- --view-dir V --run-dir session --expect-kind production --validator-timeout H*3600`.

**`runtime`** (new; the r6 lifecycle is unchanged):
- **Refuses before r6 starts** (writing nothing) unless all of:
  - production kind only, with no `--fixture-exec`/`--fixture-unmount-exe`;
  - RLIMIT_FSIZE ≤ 32 MiB;
  - our scope is the gate-bound one (memory.max 4096 MiB **and** memory.high 3712 MiB);
  - the tree root is an ancestor in the same cgroup.
- **Then it patches its private r6 module instance only:**
  - `C.CHILD_FSIZE = 16 MiB`;
  - `C.Session = MemorySession`;
  - `C.classify = memory_classify(C.classify)`;
- **and returns `C.main(rest)`.** That is r6's own `main`: pins, view `load_view`/recheck, owned exposure, check-held, the validator, post-use recheck, ordered cleanup, classification and receipt.
- **`MemorySession(C.Session)`:**
  - **Hook:** `self.R9` becomes a thin `Probe`. Only `exited_nowait(<the running validator pid>)` during the `"validator"` step, which is r6's own 0.5 s poll, is also the telemetry and soft-stop tick. Every other call passes through, including `stop_group` internals, other pids and the cleanup phase.
  - **Telemetry,** bounded at ≤ 2048 samples, one per 120 s plus each validator end:
    - cgroup current/high/max/events/stat (`pagetables`, `file_mapped`, `anon`, …);
    - the outer guard's tree VmRSS and MemAvailable;
    - per process (wrapper, mdbx_chk) VmRSS/RssFile/RssAnon/VmPTE;
    - peaks every tick, `eventsBefore` at session start.

    It does not read `smaps_rollup` and never reads DB bytes.
  - **Soft stop:** tree VmRSS > 3840 MiB, MemAvailable < 16896 MiB, or 3 consecutive unreadable telemetry samples raise **`SoftStop(C.Stop)`**. r6 `main` records it as interrupted, so the run is **CANCELLED (rc 5), never CLEAN**. r6's ordered cleanup then ends the validator group first (the wrapper kills and reaps mdbx_chk), then the unmount, nbdfuse and qemu-nbd. Only our own groups are signalled; there is no queue kill.
  - **Post-use:** `held("postUse")` additionally requires `same("nbdfuse")`, i.e. the bound FUSE server is still alive and the same process. Otherwise VOID.
- **`memory_classify`:** after r6's classification, if any of `memory.events` oom/oom_kill/oom_group_kill increased since session start, or the counters are unreadable, then **CLEAN or PROBLEMS become INCONCLUSIVE (rc 7)**. VOID, INCONCLUSIVE and CLEANUP-INCOMPLETE are untouched. `max` events are recorded but do not downgrade: reclaim does not change read data.
- **Unchanged from r6:** timeouts are INCONCLUSIVE; a part change during use is VOID; a cleanup failure is CLEANUP-INCOMPLETE.

**Jobs:**
- **`jobs/tests.sh`:** the 512 main lane, a strict gate, the receipt retained.
- **`jobs/root-composite-validate.sh`:** **manual only**, the **4096 main lane**. It requires:
  - r8 SUMS;
  - the qualified r6 `guards` (pinned stages, live-session refusal, stage mounts);
  - no memory-fixture mount;
  - a passing r8 test receipt for these SUMS.

  It runs `( ulimit -f 32768; exec timeout -s TERM -k 600 (H*3600+1800) python3 … gate … --tree-root-pid $$ )`, takes peer snapshots before and after, records mounts and processes left (diagnostic only), and writes a job receipt (`structurallyCleanRun` only for CLEAN with nothing left).

## Output budget (root margin is only ~0.86 GB beyond all reservations)
**Every file is size-limited:**
- the job/gate/runtime process tree: RLIMIT_FSIZE 32 MiB;
- r6 children: 16 MiB.

**Worst case** = 4 × 32 MiB (job stdout, job stderr, `gate.json`, runtime `receipt.json`) + 4 × 16 MiB (qemu-nbd.log, nbdfuse.log, validator.out, mdbx-report.json) + 16 MiB small files = **208 MiB**. The gate requires it **on top of** every remaining recovery byte, the 40 GiB floor and the 8 GiB native reservation.

**Realistic size is far smaller:** the wrapper writes its report (with an 8 KiB tail) to `--out`; telemetry ≤ ~2 MB.

## Tests (10; `jobs/tests.sh`; no mount, scope change, MDBX or view)
1. **Qualifications:** the ACTUAL pinned qualifications pass through `check_qualifications` (r7, r6 4+12 via r7, r4 stage and receipts). Mutated receipts all refuse: SOFT-STOP, controller killed, a short scan, an OOM kill, no high event, `Ran 10`, an r7 non-pass. A one-byte-different copy refuses as "not the exact pinned receipt".
2. **Lane:** only 4096 MiB with `high == max` and MemAvailable ≥ 20736 MiB. 2560 (r7), max, 768, a pre-set high and 20735 MiB all refuse.
3. **Setter:** the r4 setter on a FAKE cgroup sets **3712M** on the bound scope only (own max 4096, parent max). A scope mismatch never calls `set-property`.
4. **Reservations:** exact boundaries for root (remaining + 40 GiB + 8 GiB + 208 MiB) and /vm.
5. **Soft-stop thresholds:** 3840 / 3841 MiB, 16896 / 16895 MiB.
6. **OOM-aware classification:**
   - `dirty()` ignores `high`/`max` but flags oom counters and unreadable or missing ones;
   - CLEAN or PROBLEMS with an OOM event, or with unreadable counters, become INCONCLUSIVE;
   - CLEAN without one stays CLEAN; VOID and INCONCLUSIVE are unchanged.
7. **Telemetry and soft stop** on the real r6 Session subclass with an owned `sleep` stand-in validator:
   - no tick before the `"validator"` step;
   - the first tick records a full sample whose stand-in has real VmRSS > 0 and VmPTE > 0, plus cgroup current and tree RSS > 0;
   - a forced threshold raises `SoftStop`, an instance of `C.Stop`, and records the reason, then disarms;
   - **the test owns r6 cleanup in a `finally`:** the child is reaped and cleanup completes.
8. **Post-use nbdfuse identity:** absent gives False; a bound live stand-in gives True; after SIGKILL gives False; cleanup reaps it.
9. **Gate CLI:**
   - with RLIMIT_FSIZE 64 MiB it refuses "RLIMIT_FSIZE";
   - at 32 MiB in the 512 test lane it refuses on `memory.max`;
   - both write ONLY `gate-refused.json`, with no `scope`/`session`, so **MemoryHigh is never set**;
   - a used run dir is refused with nothing written.
10. **Runtime CLI:** it refuses before r6 when not in the bound scope, for a fixture kind, with `--fixture-exec`, or without `--`, writing nothing into the run dir.

**Coverage that stays elsewhere** (the r8 gate requires the actual receipts):
- **r6's 4+12 lifecycle fixtures** (real MDBX/FUSE);
- **r7's 6 gate tests;**
- **r4's real mechanism run.**

## Root commands (normal queue; root reviews independently first)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh cmv-r8-tests 512 bash composite-mdbx-validation-stage/r8/jobs/tests.sh       # expect "## PASS (10)"
# PRODUCTION: only with explicit permission, after ALL 265 parts committed + verified (CONFIRMED) and an r6 production view exist,
# in a coordinated 4096 MiB main-lane window (MemAvailable >= ~21 GiB at admission). Never automatic:
bash jobs/q-exit-status.sh cmv-r8-prod 4096 bash composite-mdbx-validation-stage/r8/jobs/root-composite-validate.sh VIEW_DIR MAX_HOURS
# stop early (that session only): bash composite-mdbx-validation-stage/r6/jobs/stop-session.sh <r8 runs/prod-ID>/session
```

## Unverified risks (honest list)
1. **Production memory is estimated, not measured.** Page tables ≈ used/512 ≈ 2.2 GB, plus the pagemap ≈ 0.56 GB, plus the servers and runtime, leaves only about 0.5–0.7 GB of file cache under the 3712 MiB high.
   - Expect heavy whole-scope throttling, which is slow (TIMEOUT means INCONCLUSIVE).
   - If unreclaimable memory exceeds 4096 MiB, a **cgroup OOM kill** follows, and its **victim is not guaranteed**:
     - if mdbx_chk is killed: INCONCLUSIVE through the oom-dirty downgrade;
     - if a server is killed: VOID through post-use;
     - if the runtime or the guard is killed: **no runtime receipt**, and the job receipt records it.
2. **The race:** the soft stop polls every 0.5 s; the outer guard checks every 250 ms. A fast spike or another host allocation can still trigger the guard's all-at-once TERM, then KILL after 2 s, bypassing the ordered cleanup.
3. **MemoryHigh throttles the whole scope,** the outer guard and servers included.
4. **The 3712M `set-property` on a 4096 scope** is the same mechanism r4 proved at 512 on 768, but this setting is itself unrun.
5. **The child file cap is now 16 MiB, not the qualified 64 MiB.** Exceeding it means SIGXFSZ, then INCONCLUSIVE or VOID, never CLEAN. This is unqualified at production scale.
6. **New code paths exercised only in unit tests,** not against real nbdfuse/qemu-nbd/mdbx_chk: the post-use nbdfuse identity check and the soft-stop path inside r6's real validator loop.
7. **The wrapper KILL** (MAX_HOURS·3600 + 1800 + 600 s) hits only the owned runtime; a dead mount or D-state process may remain and is recorded. There is no absolute D-state bound.
8. **Not counted against the host:** page tables and the pagemap count against the cgroup but not against the guard's VmRSS. The 16 GiB host floor relies on the queue's admission plus the soft stop at 16 GiB + 512 MiB.
9. **CLEAN remains structural only** (`mdbx_chk`); canonical, state, trie, chain, RPC and SNP validation stay separate. The canonical build is deferred until preservation completes.
