# 1778: final source re-review of jobs/root-multipart-batches-1773.py (NOT a PASS; nothing run)

**Scope:** reading only.
- **What I executed:** `sha256sum`; private copies in `/tmp/claude-batch-final-1778/`; a `diff` against the 1764 copy I reviewed in 1772; reading the runner's batch and driver code, the test names and fixtures, and the author's report 1773.
- **Not done:** edits, tests, live processes, parts, or the r3 preserver.
- **Tests:** root's queued job `rmp-batches-1773-tests-1777` (14 tests) had just started; **I assert no PASS**.

| file | sha256 |
|---|---|
| `jobs/root-multipart-batches-1773.py` (r--r--r--, 17:22:33) | **`5c33f6e24d0b880d47521c08a001c6b8d11af18cfcc044c411ef09a889ad410a`** (= the requested hash) |
| `jobs/test_root_multipart_batches_1773.py` | `81267f2bb72fc41622907f2eb9af4423b07c7848390e188fdb1caf178bdc5cb2` |
| `jobs/root-multipart-batches-1773-tests.sh` (gate: exactly `Ran 14 tests`, `OK`, empty stdout, no ResourceWarning/skip/FAIL/ERROR/Traceback) | `938ed9562be5a925a72093ac5ae04044d0cc97748d045fb5a82eb5ad3e7d0c28` |
| `logs/claude-batch-stop-fix-1773.md` (author report) | `308fe8017e81600161471ae7c8f7c6d17b0ba3338c0ceac7c3ad2268f5c5cd38` |

## Verdict
**No activation blocker found in the source.**
- **1772 B1 is fixed in code:** the stop intent is durable, and a stop that arrives while the batch is still queued can no longer start production.
- **1772 B2 is fixed in code:** the inventory now treats wrong-target and unknown names as foreign.
- **1772 P3-1 and P3-2 are fixed.**
- **Activation still depends on:**
  - root's 14-test PASS;
  - the verify of parts 1..8 being complete and clean;
  - the caller using a **new** `--out` and `--runner-sha256 5c33f6e2…`.

The author report 1773 matches the code as I read it.

## B1: the stop intent is durable, including the race while queued (verified by line)
**Driver** (`on_signal` 510–514):
- it handles a signal once (a nested signal returns, so the flock is never re-entered);
- it then `write_stop` → `OUT/STOP` (O_EXCL) under `flock(OUT/stop.lock)`;
- the loop launches no queue job once `state["stop"]` or `STOP` is set (519);
- while the queue child runs, `forward_to_batch` is **retried every second** until the batch has registered (`active.json` pid + start time, pidfd-pinned own descendant) (526–531).

**Batch** (`cmd_batch` 394–465): the batch checks for `STOP` at four points, so STOP before launch = no production; STOP after launch = a forwarded cancel.

| check | where | effect |
|---|---|---|
| 1 | right after the run-lock and runner-sha check, **before** the handler, `active.json`, pins or admission (403) | rc 5, nothing registered |
| 2 | before admission (420) | rc 5 |
| 3 (final) | `guarded_launch` (430): own flag + `STOP` checked **under the same flock** as the wrapper `Popen` | a STOP recorded first means `Popen` never runs; the flock fd is `O_CLOEXEC`, so the wrapper never inherits it |
| 4 | the wait loop re-reads `STOP` every 0.5 s (438) | retries the pidfd forward to its own `orchestrate.py` (realpath match) until it lands or the wrapper exits |

- **The handler is installed before `active.json` exists** (406–409).
- **The flock is not even needed for safety:** check 4 catches any STOP written after check 3. The flock only makes check 3 exact.

**Test:** test 13 is a real owned delayed queue. FAKE sleeps 3 s and then execs the batch; SIGTERM goes to the driver during the delay. Required: rc 5, `STOP` present, no `admission-*` and no `active.json`, and "stopped before admission" logged. Tests 11, 12 and 14 cover the ordering, the forward retries, and the pins with STOP.

## B2: strict inventory (verified)
- `inventory(dfd, d, target)` (96–110) marks a `part-NNNN.*` name as foreign if its index is not in the manifest **or** its manifest target is another dir.
- `PART_RE` now requires a run ID in `verify-`/`resume-` names.
- Both `admit` (188) and `post_check` (232) use it.
- **Test:** test 10 refuses a wrong-target `.json`, an unknown index, a wrong-target `.partial` and a garbage verify name at admission, plus a post-check refusal (rc 4).

## Remaining findings (minimal; none blocks activation)
- **M1: a driver that dies writes no STOP.** If the driver dies by SIGKILL, **SIGHUP** (only TERM/INT are handled, e.g. a closed terminal) or an exception inside `write_stop` (e.g. the out dir unwritable), no STOP is written, and an already queued or running batch completes.
  - **Practical remedy, no code:** because every batch check is `lexists(OUT/STOP)`, root can create `OUT/STOP` by hand at any time. A queued batch then exits 5 before admission, and a running one forwards the cancel to orchestrate within about 0.5 s.
  - **Recommendation:** run the driver detached from the terminal (e.g. `setsid`/`nohup`), and document `touch OUT/STOP` as the fallback stop.
- **M2: a stop does not end the queue retry loop.** After a STOP, the driver still waits for the queued `q-exit-status.sh` child. That child can retry `rc 98` for up to about 2 h before the batch runs and exits 5. No production happens; just expect the wait.
- **M3: stop is not pause** (documented by the author). A stopped running batch leaves committed parts plus possibly one `.partial`/`.ckpt`, and the runner cannot resume it; root acts through the frozen wrapper.
- **M4: the test-only `--queue-cmd` flag is present in the production CLI.** If used, the batch would run outside the shared queue lane. The core's 16 GiB host floor still applies. Root never passes it.
- **Cosmetic:** the test module docstring still says "9 tests"; the gate requires 14.

## `--start 9` (the caller's plan) as I read it
- Batch 9–16 copy admission requires:
  - parts 0..8 committed **and** verified (a valid PASS in a CONFIRMED session, measured after the commit, identity unchanged), with no `.partial`/`.ckpt` left;
  - no FAIL or invalid verify record. Any earlier FAIL blocks permanently and fail-closed; inspect if admission refuses.
- It also requires:
  - no files for parts ≥ 9;
  - no live r9/orchestrate process and no stage mount;
  - free capacity per target of the full not-committed logical bytes + 40 GiB, plus 8 GiB on root. Both targets are checked every batch.
- **So it refuses until the verify of 1..8 has ended clean,** which is the intended order.

## What is and is not tested (no overclaim)
**The 14 fixtures cover:**
- admission and post-check logic on tiny synthetic dirs;
- STOP ordering and flock;
- the forward to owned sleeper processes;
- a fake delayed queue around the real batch command, which stops before admission.

**They do NOT run:**
- the real `q-exit-status.sh`/`claude-test-queue.py`;
- the frozen `root-preservation.sh`;
- `orchestrate.py`, an r9 session, or a production part;
- a stop forwarded into a **running** wrapper and orchestrate (cancel at a safe point, session cleanup, wrapper rc 5);
- an entire multi-batch production drive.

**Those paths are verified by source reading only.** The first production batch (and, if used, its first stop) is the real evidence.
