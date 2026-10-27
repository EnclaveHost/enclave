# 1786: independent source-only review of the frozen composite-mdbx-validation-stage/r2 (NOT a PASS; nothing run)

**Scope:** reading only.
- **What I executed:** `sha256sum -c` of the stage; `diff` of r2 against r1; reading the r2 runtime, jobs and tests 7–10; reading `work/claude-test-queue.py` in full; reading the author report 1785; `strings` of the system `libfuse3.so.4` (linked by `/usr/bin/nbdfuse`), with no execution.
- **Not done:** tests, mounts, probes, process inspection, edits, or anything touching the live batch (copy 9..16 completed rc 0; verify running).

| item | sha256 |
|---|---|
| r2 `SHA256SUMS` (all 7 entries verify OK) | **`681c88f1380091a8977a513e350362f07fe122b20fcd701857ffbc1da687a9b2`** |
| `composite_session.py` (500 lines) | **`248bc897ade746520581820d558552d9825dd8c68cf426818aef0cefe4e95186`** |
| `tests/test_composite_session.py` (10 tests) | `11dddf8eeb5457d0d5f4fbd9d56e1d468424fb6d0c39ad332042255f9f1a5661` |
| `jobs/common.sh` / `tests.sh` / `root-composite-validate.sh` / `stop-session.sh` | `fe114c0e…` / `c237ae42…` / `470976c3…` / `ba1568db…` |
| `work/claude-test-queue.py` (read) | `969d9273e53c79abf8604c363daa58b41a462bc4b7f3d03d813980edb771f6f4` |
| author report `logs/claude-composite-fix-1785.md` | `a8c08f67de521fb4e1a3da88f0c4d4dcbfbb63cf75b656322fefb13c319e2ef4` |

## Correction to 1784 A1 (accepted): do NOT stop the healthy driver
**Queue behaviour, verified in `claude-test-queue.py`:**
- every job with `--mib` ≥ 512 takes the **same exclusive main flock** (`claude-test-queue.lock`, `LOCK_EX`; lines 44–59 and 76–88);
- it holds that flock through `child.wait()` of its `systemd-run --scope` (179);
- only 256 MiB jobs release it and run beside it (175–178);
- a large job releases the lock only while it has **no child** (admission yield, 110–128).

**So a 512 MiB `cmv-r2-tests` job and a 1024 MiB preservation batch cannot overlap.** My 1784 advice to STOP the driver was unnecessary and is withdrawn.
- **r2 adds a defensive admission guard:** it refuses on a live `orchestrate.py`/`overlay_session.py`/`composite_session.py` process or a stage mount (`common.sh` 20–24). It never refuses on an idle driver. That is fine.
- **Side effect:** a batch queued behind the test job retries on rc 98 every 30 s, up to 240 tries. The test job is bounded by `timeout 3600`, so this is well within that.

## Verdict
**No safety blocker in the r2 source.** A2, m1 and m2 are implemented as claimed, and production is **disabled** (`root-composite-validate.sh` refuses unconditionally).

**But one probable test-expectation defect (T1) would make the frozen fixture run FAIL** without any safety meaning.

**Recommendation:**
- **(a) Preferred:** an r3 with the two one-line corrections below, then run the fixtures through the 512 main lane, for one clean qualifying receipt.
- **(b) Alternative:** run r2 as frozen. That is safe, but a test 9 FAIL on the `lazy` assertion is likely, and r2 then cannot qualify.

## T1 (probable fixture FAIL; test expectation, not safety): test 9 expects OUR lazy detach, but nbdfuse's libfuse likely detaches lazily itself
**What test 9 asserts:** `r["unmount"]["normal"] != 0` and **`r["unmount"].get("lazy") == 0`** (`test_composite_session.py` 257).

**What the code does:** our lazy `fusermount3 -u -z` runs only if the mount is **still present after `stop_group(nbdfuse)`** (`end_child`).

**The evidence that it won't be present:**
- the linked `libfuse3.so.4` contains `/usr/bin/fusermount3` with the adjacent argv strings `--unmount`, `--quiet`, `--lazy`;
- this matches libfuse's unprivileged `fuse_kern_unmount`, which lazily detaches when the daemon exits;
- so after SIGTERM, nbdfuse will most likely detach the busy mount **itself**, our check finds no mount, and `"lazy"` is **absent**, which fails the assertion.

The author's own limit list (1785, test 9's ordering) assumes the opposite ("libfuse's own unmount fails EBUSY").

**Not verified here:** whether nbdfuse's TERM path reaches `fuse_unmount` at all. The fixture run decides.

**Either way the runtime stays fail-closed:** the failed normal unmount has already made the run CLEANUP-INCOMPLETE.

**Minimal fix (test only):** accept `r["unmount"].get("lazy") in (None, 0)`, while still requiring `normal != 0`, `mountLeft == False`, CLEANUP-INCOMPLETE, and `ended(r)`.

## A2: verified, with one residual gap (R1)
**Verified in code:**
- `cleanup()` runs every step through `safe()`, in this order: exec, adopted, nbdfuse, qemu-nbd, pidfds, logs, adopted, socket, holders, mounts, `childrenAlive`. An exception is recorded, makes the cleanup incomplete, and never skips later steps;
- in `end_child`, a failed or timed-out normal unmount sets `cleanup_ok = False` and then **always** runs `stop_group`;
- if `stop_group` raises, the child is killpg'd while it is still unreaped, then reaped (`wait(10)`);
- a mount still present after the server ended is lazily detached with the **pinned** binary, on our mount only, and the cleanup remains incomplete;
- **lazy detach can never be CLEAN:** every path reaching it already has `cleanup_ok = False`. An external holder becomes invisible to `holders()` after a detach, but the failed normal unmount already makes the run incomplete;
- `childrenAlive`/`mountLeft`/`leftoverProcesses` default to "bad" if their step raised;
- `subprocess.run(timeout=…)` kills and reaps the fusermount3 it started.

**R1 (small; fix with T1 before production):** `unmount()` catches only `subprocess.TimeoutExpired`.
- **The failure:** an `OSError` from starting fusermount3 (fork `ENOMEM`/`EAGAIN` under the scope's `MemoryMax`, or a missing `--fixture-unmount-exe`, which is checked only with `isabs`) propagates out of `end_child` **before** `stop_group` for that child. That child (nbdfuse) is then never signalled or reaped by us.
  - The run does stay CLEANUP-INCOMPLETE via `childrenAlive`, and PDEATHSIG ends nbdfuse at session exit.
  - This contradicts the r2 claim that a failed unmount never skips ending a child.
- **Fix:** `except (subprocess.TimeoutExpired, OSError)` in `unmount()`, which records it and returns `not mounted`.
- **Residual, not fixable without a new framework:** if fusermount3 is unkillable (D state), `subprocess.run`'s post-kill `wait()` is unbounded. That is improbable for a non-lazy FUSE `umount2`.

## m1 / m2: verified
- **m1:** `prepare` refuses a run dir containing `work`, `receipt*`, `mdbx-report.json`, `validator.out` or `session.pid` before writing anything (test 10 also checks that the stale file is left byte-identical).
- **m2:** CLEAN additionally requires `report.preflight.mdbxDatBytes == view.logicalSize`, otherwise INCONCLUSIVE. Test 7 covers a wrong size, a missing expected value, and an empty preflight. PROBLEMS stays independent of the size, which is acceptable.

## New tests: what they prove and what they don't
- **Test 8 (injected hung unmount, 3 s timeout):** checks `normal == "timeout"`, CLEANUP-INCOMPLETE, both servers reaped, no mount, and that the production kind refuses the injection option.
  - It assumes nbdfuse unmounts on SIGTERM when not busy, which is consistent with the libfuse evidence above.
- **Test 9 (a real external holder):** the test process itself holds `work/db/mdbx.dat` open, so the real normal unmount fails EBUSY.
  - It proves end and reap despite a real unmount failure. The `lazy == 0` assertion is the T1 risk.
  - **Minor flake risk:** `ended()` checks that `/proc/<pid>/fd` is absent after the reap, and PID reuse inside the test window would cause a false FAIL. Prefer `returncode` set plus `childrenAlive == []`.
- **Not exercised by any test:** the R1 `OSError` path, and production scale (a 1.13 TB view, days of runtime, memory). Production remains disabled.

## Qualification recommendation
1. **Preferred:** root freezes an r3 = r2 plus T1 (test 9 accepts `lazy` absent or 0) plus R1 (`unmount()` also catches `OSError`). Re-check SUMS, then run through the **512 main lane only**: `bash jobs/q-exit-status.sh cmv-r3-tests 512 bash composite-mdbx-validation-stage/r3/jobs/tests.sh`.
   - It cannot overlap a 1024 preservation batch, so there is no need to stop the driver.
2. **If r2 is run as frozen:** it is safe. Treat a test 9 failure on `unmount.lazy` alone as T1 (expected), **not** as a qualification. Any other failure is real.
3. **Production stays disabled** until a new reviewed revision is made after an actual fixture PASS, all 265 parts verified in CONFIRMED sessions, an r6 production view, and a memory/time window.
