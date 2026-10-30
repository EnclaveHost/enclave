# 1827: independent source review of composite-mdbx-validation-stage/r8 (author report 1825). NO r8 tests have run; nothing is PASS

**Scope:** read-only.
- **What I read:** `memory_gate.py` (474 lines), `tests/test_memory_gate.py` (10 tests), `jobs/tests.sh` and `jobs/root-composite-validate.sh`. I checked them against the pinned r6 lifecycle (`composite_session.py` `407aa7e9…`: `main`, `Session.use`/`held`/`cleanup`, `classify`), r7 `production_gate.py` (`33419b83…`) and the r4 helpers.
- **Not done:** edits, tests, builds, mounts, scope or queue changes, part/original/network access or commits. The recovery driver is untouched and the USB write pause is respected.

| item | sha256 |
|---|---|
| r8 `SHA256SUMS` (5 entries, `sha256sum -c` OK) | `7472d522a6acb4f51f22ebc95197a54bfc568b872c63344cc8ceb519ae809b82` |
| `memory_gate.py` | `f9eb0d08a00eecedf99785d16a869cd9148d0fd5bb382b70df14b0440e1bb90c` |
| `tests/test_memory_gate.py` | `6dd1f5d1f6e05ee45932845cf34b9cd486129a151d5a1d9f6fdd4242171c8a77` |
| `jobs/tests.sh` | `568fc454f6275aafa6a7f34476ad2c7a01042935e39a9ece4ba7aed80dc952ce` |
| `jobs/root-composite-validate.sh` | `b3bf7e0e09296e5c0339db7189b8178a48ead498bd6e9ff5e789c85687a6e8af` |
| `README.md` | `62bf753cc2ab41907f99ca167d48758f303a2bdbb72ed70abb35cd0cf398f111` |

## Verdict
**No blocking correctness, lifecycle, gate or resource defect was found.** Two minor actionable items and the testing limitations are listed below.

Per the instruction, scope 4096 / high 3712 not guaranteeing safety is an accepted, documented limit, not a blocker. Production remains explicit-permission only.

## Checked and sound
**No unsafe CLEAN.**
- `runtime()` patches only its private r6 module instance; r6 `main` resolves `Session` and `classify` as module globals at call time, so the patches take effect, and the unmodified r6 `main` then runs.
- **CLEAN still requires r6's full conjunction:** report rc 0, `structurallyClean`, wrapper rc 0, the whole byte count, no inconclusive flags, post-use OK, complete cleanup.
- **r8 adds three restrictions only:**
  - `held("postUse")` also needs `same("nbdfuse")` (`memory_gate.py:407-413`);
  - any oom/oom_kill/oom_group_kill increase, or unreadable counters, downgrades CLEAN/PROBLEMS to INCONCLUSIVE (`:418-433`; `dirty()` treats missing keys as dirty);
  - a soft stop is `SoftStop(C.Stop)`, which r6 `main` records as `interrupted`, so the run is **CANCELLED, never CLEAN**.
- **Missing validator:** r6 `main` re-hashes the pinned `mdbx_check.py`/`mdbx_chk` before anything starts → REFUSED.
- **OOM victims:**
  - qemu-nbd killed → EIO in mdbx_chk → PROBLEMS, downgraded by the OOM counter;
  - nbdfuse killed → `postUseNbdfuseSame` false → VOID;
  - wrapper or mdbx_chk killed → no report or rc < 0 → INCONCLUSIVE;
  - the runtime itself killed → no session receipt → the job's `structurallyCleanRun` is false.

**Scope binding.**
- **The gate:** exactly one user-manager `run-*.scope`, `memory.max` = 4096 MiB, `memory.high` = `max`, the tree root an ancestor in the same cgroup, and MemAvailable ≥ 20736 MiB.
- **The only mutation comes last:** r4 `set_memory_high` on a private module instance, with `HIGH_MIB` patched there only (the setter reads the global at call time). It checks ControlGroup == our cgroup before; own high, own max and the **parent** after; and that we are still in `cgroup.procs` with `memory.max` unchanged.
- **The runtime:** the same PID after `execv`. It re-checks 4096/3712 and ancestry before r6 starts, refuses fixture kinds and fixture execs, and writes nothing on refusal.

**Independent receipt qualification.**
- **Exact bytes plus strict fields:** the r7 6-test receipt (`:127-132`); the r4 tests, job and fixture receipts (`:135-167`), including no OOM events, high events > 0 and the parent unchanged.
- **The r6 4+12 receipt and stage:** via the **pinned r7 functions** (`check_stage`/`check_receipt`).
- **The r4 stage:** via r7 `check_stage` with the r4 SUMS pin.

**Lifecycle under a soft stop or telemetry failure.**
- **How the tick works:** it hooks only `Probe.exited_nowait(<running validator pid>)`, the condition of r6 `use()`'s 0.5 s loop, while `step == "validator"`. `stop_group` is the real r9 function (internal calls bypass the Probe), and `_phase` is cleared by `done`, by a soft stop, or by r6's next `step()`.
- **Unwinding a SoftStop:** a SoftStop raised there leaves r6 `use()` (closing `validator.out`), and r6 `main`'s `finally` runs the ordered cleanup. That ends the validator group first: the r4 wrapper's own TERM handling kills and reaps mdbx_chk. If the wrapper is KILLed instead, mdbx_chk is adopted by our subreaper and reaped before the unmount. Then come the unmount, nbdfuse and qemu-nbd.
- **Telemetry failures:** three consecutive unreadable ticks raise a soft stop; an unreadable `eventsBefore` makes CLEAN impossible.

**The log/output budget covers the run's files.**
- **The 32 MiB job cap:** `( ulimit -f 32768; exec timeout … python3 … gate … )` caps every file written by the gate and runtime: J/stdout and stderr (written by the subshell), `gate.json`/`gate-refused.json`, `session/receipt.json` and `session.pid`.
- **The 16 MiB child cap:** r6 reads `CHILD_FSIZE` at call time, so 16 MiB caps every r6 child: qemu-nbd.log and nbdfuse.log (spawn), plus `validator.out` and the wrapper's `mdbx-report.json` (the validator Popen with `limits(CHILD_FSIZE)`). `mdbx_chk` writes only to the wrapper's pipe, which is bounded in memory.
- **Telemetry:** ≤ 2048 samples (~1–2 MB).
- **Fail-closed overrun:** CPython ignores SIGXFSZ, so an over-cap write raises `EFBIG`: no receipt, which is not clean. Children get the default SIGXFSZ, so they end and the run is not clean.
- **The total:** the 208 MiB figure is a sound upper bound for these files, and the gate requires it on top of remaining + 40 GiB + 8 GiB.

**Time:** `timeout -s TERM -k 600 (H·3600 + 1800)` sits above r6's validator bound (H·3600 + 600) plus cleanup. A TERM during cleanup is ignored by r6 (armed off, SIG_IGN).

**Test hygiene:**
- every `open()` is in a `with`;
- the subprocesses use `subprocess.run`;
- the stand-in children (`sleep`) are reaped by r6 cleanup in `finally` (tests 7 and 8; test 8's manual pidfd goes into `s.bind`, so cleanup closes it).

  No ResourceWarning source found.

## Actionable (minor, non-blocking)
**A1. An exception outside `_tick`'s guarded block mislabels the run as REFUSED** (`memory_gate.py:376-402`).
- **Where:** only the cgroup/RSS/MemAvailable reads are inside `try`. The peaks, `M4.tree()`/`proc_status` sampling and the sample bookkeeping are not.
- **What happens:** any unexpected exception there propagates out of r6 `use()` as an ordinary Exception. r6 `main` records it as `refused` with `exec_info` still None, giving **REFUSED (rc 3)** although the validator ran. Cleanup still runs in order, and it is never CLEAN, so this is fail-closed but misleading.
- **Fix:** wrap the whole `_tick` body and count any exception as a telemetry failure (soft stop after 3).

**A2. Job-level files outside `ulimit -f`** (`jobs/root-composite-validate.sh:22-30`).
- **Which files:** `peers-before`/`after`, `mounts-left`, `processes-left`, `J/receipt.json`, and the queue's own `logs/cmv-r8-prod.{out,guard}` are written by the job bash or the queue, not under the 32 MiB cap.
- **Practical size:** small (process/mount lists; receipt fields sliced to 4000 chars).
- **Fix:** either name them explicitly as part of the 16 MiB "small files" allowance in the README and report, or move the post-steps under the same `ulimit`. No code change is needed for safety.

## Testing limitations (not defects)
- **No end-to-end soft stop or OOM path through `C.main`.** Test 7 calls the tick and forced soft stop on a stand-in and then cleanup in the test's `finally`. The real chain (SoftStop inside r6 `use()` → r6 `main` interrupted → CANCELLED receipt) and the OOM downgrade inside a real r6 receipt are covered by reasoning and pure tests only. They need FUSE and a real validator, which only a production-shaped run would show.
- **The `same("nbdfuse")` test** uses a `sleep` stand-in bound by a manual pidfd, not a real nbdfuse.
- **The actual memory behaviour at ~1.1 TB is unmeasured.** Page tables, the pagemap, throttling and the OOM victim are estimates; r4's evidence is synthetic at 8 GiB.
- **The r7/r6/r4 PASS receipts** are trusted as pinned bytes plus fields; their underlying runs are not re-run, which is correct for this stage.

## Lane decision for `cmv-r8-tests`
**Safe for the 256 MiB small lane.** The 10 tests:
- use no FUSE, mount, qemu-nbd/nbdfuse, `fusermount3` or real `systemctl` (test 3 uses a fake cgroup tree and runner);
- only read the job's own cgroup files (tests 7, 9, 10) and the frozen r4/r6/r7 files and receipts;
- spawn only `sleep` stand-ins and `python3 memory_gate.py` subprocesses, whose argv matches neither the preservation `busy_reasons` (orchestrate/overlay_session) nor the peer snapshot (qemu-nbd/nbdfuse/fuse2fs);
- write only under their own tmp;
- **never read preservation target dirs:** test 4 is pure, and the gate CLI in test 9 refuses at `memory.max` before `reservation()`.

**Peak memory** is a few Python processes (≈ 100–150 MiB), within 256.

**Two conditions:**
- it must run under the queue (a non-root `run-*.scope` cgroup) for tests 7, 9 and 10, which is true for either lane;
- `jobs/tests.sh`'s header names 512. Running it at 256 is a root invocation choice; the script itself is lane-agnostic.

The production job still requires the **4096 main lane**, an explicit permission, all 265 parts verified, and the r6 production view.
