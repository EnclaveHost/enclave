# 1829: composite-mdbx-validation-stage/r9 = r8 + narrow fixes for root 1828 and review 1827 (FROZEN, PREPARED ONLY: NOT run, NOT PASS, inactive)

**Scope:**
- **What I executed:** reading root 1828 (`82a252b2…`), review 1827 (`64984f3c…`), the r8 sources, r6 `session_guard.py` and r6 `main`; writing the NEW r9; `ast`; `bash -n`; `sha256sum`.
- **Not done:** tests, queue jobs, production, mounts, scope changes, builds, network, installs or commits. **r1–r8 re-verify unchanged.**
- **Actual r8 evidence (root):** 10/10 PASS at `r8/runs/tests-20261027T043205Z-2760587`, 0.754 s, 54 MiB peak, on the 256 MiB small lane.
- **Note:** review 1827's title "NO r8 tests have run" was written before root's run and is stale.

## Frozen r9: `composite-mdbx-validation-stage/r9/SHA256SUMS` = **`9337f1359ec43cff2bc718e7d6262677548e32fa08ab6a00e7b6a37e1ea36185`** (7 entries, read-only)
| file | sha256 | change vs r8 |
|---|---|---|
| `memory_gate.py` (606 lines) | `1103a509ca1657f93f0b1623f55a2220f4e70a56fe2c89982e86f5fd40bbc4d1` | A1 tick wrapper; `stop`, `guard`, `evidence` subcommands; r6 `session_guard` pin; format labels r9 |
| `tests/test_memory_gate.py` (15 tests) | `1555b67a5d4773d2509cf25e1f73725f9365f7767b5a9e7939ee8fb02ef58756` | r8's 10 kept (only the `session()` helper gained optional args), plus tests 11–15 |
| `jobs/root-composite-validate.sh` | `91b82154e8618291e087ea7c0b2bfe3c6a7798d6ca1da9c948ad742ff91f56af` | r9 paths; memory guard; bounded job files; final status; receipt r9 |
| `jobs/final-status.sh` (new) | `a665d03a04d4e2f913a117bbe17da0b5e355362da2dfe4e4937555e40533269c` | the final job exit decision |
| `jobs/stop-session.sh` (new) | `129f31d2846bb2385478922175258763f24af92963db6e2129037e0095f137df` | `memory_gate.py stop` |
| `jobs/tests.sh` | `262fafdcb39c51aa7c413e24c1e8e5bbdcd332db67e7b2f5a7a233be299d5878` | r9; the 256 lane in the header (as root ran); exactly `Ran 15 tests`; same strict gate |
| `README.md` | `750ea4aa785257526476bbd363b7c1a91f13dba9d291768b3cceccb9088c928b` | r9 section + commands |

**Unchanged policy and pins:**
- the gate (all 265 committed + verified CONFIRMED + the production view; the r6/r7/r4 exact-byte qualifications);
- 4096 MiB lane / MemoryHigh 3712 MiB (whole scope, set last and verified);
- the 16 GiB floor and the soft stops (3840 MiB tree RSS, 16896 MiB available);
- the full remaining recovery reservation + 40 GiB floors + 8 GiB native + the 208 MiB output budget;
- r6 lifecycle unchanged;
- OOM → never CLEAN/PROBLEMS.

**New pin:** r6 `jobs/session_guard.py` `f64c6115…`.

## Root 1828 #1: an r9 stop helper (`jobs/stop-session.sh` → `memory_gate.py stop SESSION`)
**`stop_session(session)`** works like this:
1. `SESSION` must be a real absolute directory.
2. It reads `SESSION/session.pid`, which r6 writes with `pid`/`startTime`, and checks that both are integers (not bool) and pid > 1.
3. It runs **`pidfd_open(pid)`**.
4. It checks the `/proc` start time == the recorded one and the owner == us.
5. **`runtime_identity`:** the exact argv must be `/usr/bin/python3 -I -B <r9 memory_gate.py> runtime --tree-root-pid N -- … --run-dir SESSION … --expect-kind production …` with no `--fixture-exec`/`--fixture-unmount-exe` and exactly one `--run-dir`.
6. It re-checks the start time.
7. **`signal.pidfd_send_signal(fd, SIGTERM)`.**

**Never** the r6 helper, a PID number, a process group or the queue. The runtime then cancels in r6 order.

**The production CLI has no override:** the script is always this r9 file. A `script=` parameter exists only for the in-process unit test.

**Test 11:**
- **Setup:** an OWNED dummy process carrying exactly the runtime argv shape (its script, also named `memory_gate.py`, only sleeps).
- **Refusals,** each leaving the dummy unsignalled:
  - the real r9 script path (the CLI and the function default);
  - another run dir with the same `session.pid`;
  - a dummy with `--fixture-exec`;
  - a wrong start time;
  - a non-JSON `session.pid`;
  - a bool pid.
- **Then the matching stop:** signalled, and `wait() == -SIGTERM` (reaped by the test). A second stop refuses (gone).

## Root 1828 #2: the job exit never hides failed final evidence (`jobs/final-status.sh`)
**`final-status.sh RUNTIME_RC JOB_RECEIPT_RC JOB_RECEIPT J` decides:**

| condition | job exit |
|---|---|
| runtime rc non-numeric | treated as 10 |
| runtime rc nonzero | **preserved exactly** (2, 3, 4, 5, 7, 8, 124, 137, …) |
| runtime rc 0, evidence rc 0 | 0 |
| runtime rc 0, otherwise | **10 (FINAL EVIDENCE FAILED)** |

**`memory_gate.py evidence RECEIPT RC JRC` returns 0 only when the receipt is all of:**
- bounded and parseable, format `…job-receipt/r9`;
- generated with jrc 0, with runtime rc 0;
- `receipt.rc == rc`, `structurallyCleanRun` true, all six checks true, outcome CLEAN.

**Any evidence failure writes `J/FINAL-EVIDENCE-FAILED`.**

**The production script:**
- runs the receipt generator as a subshell with its own exit (`jrc`); a malformed runtime receipt becomes outcome "MALFORMED runtime receipt";
- then calls `final-status.sh` and **`exit $final`**.

**Test 12 runs the real `bash jobs/final-status.sh`** for: clean; failed checks; missing; truncated; a clean-looking receipt with a failed generator; an rc mismatch; PROBLEMS; runtime 7/5/2 preserved; a non-numeric rc. Each case checks the exit code and the presence or absence of the mark.

## Root 1828 #3: the guard recognises real memory_gate processes (`memory_gate.py guard`)
- **How it works:** it reuses the pinned r6 `session_guard.py` (`script_of`, `info`, `ancestors`), loaded from its exact bytes.
- **What counts as live:** a process of this user (excluding itself and its ancestors) whose real Python script is `memory_gate.py` with the next argument `gate` or `runtime`.
- **What does not count:** text mentions (shells, grep, editors, `python -c`, other subcommands such as `stop`) never refuse.
- **In the production job:** it runs **after** the unchanged r6 `guards` (which still refuse orchestrate/overlay/composite sessions and stage mounts) and **before** any mount or run dir.
- **Test 13:**
  - the argv classifier is checked on real gate/runtime argv against seven text-only shapes;
  - the CLI returns rc 1 naming an owned dummy's pid, and ignores a live single-process text mention (`python3 -c … memory_gate.py runtime`);
  - after the dummy is killed and reaped, rc 0.

## Review 1827 A1: telemetry failures are counted, never a misleading REFUSED
- **The change:** `_tick` now wraps the WHOLE body (`_tick_body`: reads, peaks, per-process sampling, bookkeeping, soft-stop decision).
  - **SoftStop is re-raised unchanged.**
  - Any other exception is a counted failure, with a bounded error list (≤ 20, plus a dropped counter).
  - At validator end the tick only disarms.
  - Otherwise, 3 consecutive failures cause an ordered soft stop ("telemetry failed 3 times in a row").
  - A complete tick resets the run.
- **Test 14:** `cg_sample` is injected to return no `stat` (a processing KeyError). Two ticks are counted, not raised, and the phase stays armed. The third raises `SoftStop` with the reason recorded, then disarms. The first error is a KeyError, and the r6 cleanup completes.

## Review 1827 A2: every job-side file is bounded or explicitly external
**Under `ulimit -f 32768`, ≤ 32 MiB each:** the gate/runtime subshell writes J/stdout, J/stderr, `gate.json` or `gate-refused.json`, `session/receipt.json` and `session.pid`.

**r6 children, ≤ 16 MiB each:** qemu-nbd.log, nbdfuse.log, validator.out, mdbx-report.json.

**The job's own files now run in subshells with `ulimit -f 1024`, ≤ 1 MiB each:**
- `peers-before`/`after`, `mounts-left`, `processes-left`;
- J/`receipt.json` (fields sliced, reasons ≤ 8);
- `FINAL-EVIDENCE-FAILED`.

**The total stays within the gate's 208 MiB:** these six files (≤ 6 MiB) fit the 16 MiB small-files allowance. The job prints only the ≤ 1 MiB J receipt and a few status lines, so there is no duplicated session receipt.

**Not bounded by r9:** the shared queue's own `logs/cmv-r9-prod.{out,guard,rc}` (an external limitation; the queue is unchanged).

## Root 1828 / review 1827 limitation: the real r6 `main` soft-stop path (test 15)
- **The setup:** `C.main` is the **unchanged inherited r6 `main`** on a private instance whose `Session` is the r9 `MemorySession`, subclassed in the TEST only to stub `prepare` (claiming the run dir), `expose` (claiming the work dir, no FUSE or qemu) and `held("heldBeforeExec")`.
- **The validator:** r6's own `use()` spawns an owned `/usr/bin/sleep` stand-in through r6's fixture-exec argv. This is possible **only inside this test**; the r9 runtime CLI still refuses any fixture kind or exec (test 10).
- **The forced soft stop** at the first tick raises `SoftStop` inside r6's real validator loop. r6 `main` records it as interrupted and runs its real ordered cleanup.
- **Asserted:**
  - rc 5;
  - `receipt.json`: CANCELLED, cleanup complete, the soft-stop reason, a memory sample present, `childrenAlive == []`, and the exec child's returncode set (the stand-in is gone);
  - the signal handlers are restored.
- **Stated limitation:** no real view, FUSE, qemu-nbd or nbdfuse, and no real wrapper/mdbx_chk. The OOM-downgrade path inside a real receipt still rests on test 6 (pure) plus reasoning.

## Prepared test commands (root runs; normal queue)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh cmv-r9-tests 256 bash composite-mdbx-validation-stage/r9/jobs/tests.sh       # expect "## PASS (15)"
# production: ONLY after root's review, ALL 265 parts committed + verified (CONFIRMED), the r6 production view, a 4096 MiB main-lane window:
bash jobs/q-exit-status.sh cmv-r9-prod 4096 bash composite-mdbx-validation-stage/r9/jobs/root-composite-validate.sh VIEW_DIR MAX_HOURS
# stop that runtime only:  bash composite-mdbx-validation-stage/r9/jobs/stop-session.sh <r9 runs/prod-ID>/session
```

## Risks and notes
1. **Shared lanes:**
   - **Test 13** expects rc 0 from the CLI guard once its dummy is gone. If a real r9 `gate`/`runtime` were live during the tests (the 256 small lane can overlap the 4096 main lane), the test fails closed.
   - **The production guard** refuses if a test dummy (tests 11/13) happens to be alive at production start, also fail-closed. Run the tests outside a production window.
2. **The process-wide subreaper:** test 15 runs r6 `main` in the test process, which makes that process a subreaper for the rest of the suite (harmless: all children are reaped by the tests). r6 `main` restores its signal handlers.
3. **`runtime_identity` requires argv[0] == `/usr/bin/python3` exactly**, which is what the gate's `execv` uses. Any other launch method is refused (fail-closed).
4. **If final-status fails:** if `final-status.sh` itself cannot run Python, evidence ≠ 0. A runtime 0 then becomes 10, and a nonzero runtime is preserved.
5. **Unchanged accepted limits** (r8): MemoryHigh is not a ceiling and throttles the whole scope; the OOM victim is not guaranteed; the 0.5 s soft stop races the outer 250 ms guard; production page tables and the pagemap are estimates (r4 was 8 GiB synthetic); a wrapper KILL skips ordered cleanup; D-state has no bound; CLEAN is structural only; the canonical build is deferred.
6. **Not proven at production scale,** only by the unit tests and r6's fixture lifecycle:
   - real nbdfuse identity loss;
   - a real soft stop with mdbx_chk;
   - the 16 MiB child cap at production size.
7. **r9 is inactive.** Root reviews and runs the tests; production only after all 265 parts are confirmed, the view exists, and the code is reviewed.
