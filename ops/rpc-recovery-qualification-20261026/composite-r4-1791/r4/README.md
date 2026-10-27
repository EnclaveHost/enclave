# composite-mdbx-validation-stage/r4: r3 + review 1786 T1 test correction (PREPARED by Claude 1789; NOT run)
Report: ../../logs/claude-composite-qualification-1789.md. r3 (SUMS `f216ec36…`) is preserved unchanged and was never run.

**Runtime: byte-identical to r3** (`composite_session.py` `407aa7e9…`). Its docstring still says r3; that is intentional, because no runtime byte changed.

**The only test change (T1, test 9):** the real busy-mount case still requires all of:
- a failed normal unmount;
- CLEANUP-INCOMPLETE (rc 4);
- both servers ended and reaped;
- `childrenAlive == []`, `mountLeft == false`, no holder, and no mount.

Our lazy fallback may now be **absent or rc 0**. nbdfuse's libfuse (`libfuse3.so.4` carries `fusermount3 --unmount --quiet --lazy`) may detach the busy mount itself on SIGTERM, which leaves nothing for our fallback.

**Unchanged:**
- all 12 tests;
- the guards;
- the 512 MiB main lane;
- production DISABLED.

**Tests:** `bash jobs/q-exit-status.sh cmv-r4-tests 512 bash composite-mdbx-validation-stage/r4/jobs/tests.sh` → `## PASS (12)`.
- Run as the owner, not under unshare.
- The queue's exclusive main flock prevents any overlap with a 1024 MiB preservation batch, so the driver is not stopped.

---
**r3 README (unchanged below):**

# composite-mdbx-validation-stage/r3: r2 + root review blockers B1/B2 (PREPARED by Claude 1787; NOT run)
Report: ../../logs/claude-composite-final-fix-1787.md. r2 (SUMS `681c88f1…`) is preserved.

**B1, unmount errors.** `unmount()` records ANY ordinary exception (a missing or non-executable program, OSError, …). `end_child()` ends and reaps the SAME child in a `finally`, whatever the unmount did.

**B2, ownership.** Cleanup acts ONLY on a work dir this session created.
- **Run-dir claim:** `owns_run` comes from an O_EXCL `session.pid`.
- **Work-dir claim:** `owns_work` is set together with the mkdir.
- **Signal deferral** covers both claims, plus Popen + recording and pidfd + recording. A signal is recorded and raised when the section ends, so a started child or opened pidfd is always known.
- **Unclaimed run dirs:** a run dir this session did not claim gets only `receipt-refused-<ns>.json` and is otherwise left exactly as found.

**r9 `stop_group` is unchanged:** a reaped leader is never signalled.

**Tests:** 12 (r2's 10, plus 11: a stale work/socket marker and a LIVE previous session left untouched, which then completes normally; plus 12: missing and non-executable unmount programs still end and reap both children → CLEANUP-INCOMPLETE).
- **Queue:** 512 MiB main lane.
- **Production:** DISABLED.

---
# (r2 README)
# composite-mdbx-validation-stage/r2: r1 + review 1784 fixes (A2, m1, m2) + job hardening (PREPARED by Claude 1785; NOT run)
Report: ../../logs/claude-composite-fix-1785.md. r1 (SUMS `7a9993d6…`) is preserved.

**A2, independent cleanup steps.** Every step is independent: the exec group, adopted orphans, then nbdfuse (unmount, then ALWAYS end its group), then qemu-nbd (ALWAYS ended), pidfds, logs, the socket, holders, mounts, alive children.
- **A failed or timed-out unmount** is recorded and makes the run CLEANUP-INCOMPLETE. After the server is ended, OUR dead mount is lazily detached with the pinned `fusermount3 -u -z`.
- **Errors never skip later steps.**

**m1:** a run dir holding any previous output is refused.

**m2:** CLEAN requires the report's `mdbxDatBytes` == the view's logical size.

**Tests:** 10 (r1's 7, with test 7 extended, plus an injected unmount timeout, a real busy-mount EBUSY failure, and stale-output refusal).
- **Queue:** 512 MiB; jobs of 512 MiB or more share the queue's single exclusive main flock.
- **Admission:** refuses only an ACTUAL live recovery/composite session process or stage mount, never an idle driver.
- **Retention:** fixtures are kept after any failure.

**Production:** DISABLED (`jobs/root-composite-validate.sh` refuses).

---
# (r1 README)
# composite-mdbx-validation-stage/r1: read-only MDBX diagnostic of the composite multipart view (PREPARED by Claude 1782; NOT run)
Report: ../../logs/claude-composite-validation-lifecycle-1782.md. **Status:** source only; root runs the fixture tests at a batch boundary.

**What it runs:** `composite_session.py` exposes a multipart-validation-view **r6** records view, and the pinned **unchanged** validator wrapper (`mdbx-recovery-validator-stage/r4 mdbx_check.py`) runs the pinned official `mdbx_chk` (libmdbx v0.13.12) on it, read-only.
- **Exposure:** the pinned `qemu-nbd --read-only` + `nbdfuse -r -C 1 -o ro` serve the view as `<work>/db/mdbx.dat` on an ST_RDONLY FUSE mount.
- **No ext4:** the view's bytes are `mdbx.dat`.
- **Reused by pinned bytes:** the r9 process helpers and control flow, and the r6 `load_view`/`recheck`/`check-held`.

**Lifecycle guarantees:**
- **Kind:** default **production**; fixtures are explicit, and `--fixture-exec` is fixture-only.
- **Before use:** the view is rechecked.
- **QEMU binding:** the QEMU child is bound by pidfd, start time, exact cmdline and the pinned exe inode.
- **check-held** (all bound fds `O_RDONLY`) runs before the mount and again before the validator.
- **After use:** a **required** check-held + recheck; if it fails, the outcome is **VOID**.
- **Cleanup:** bounded and owned. The validator group and any escaped descendants end first, then the unmount, then nbdfuse and qemu-nbd. No mount and no holder may remain.
- **Records:** the receipt is ALWAYS written. `validator.out`, `mdbx-report.json` and the child logs are retained.

**Outcomes (rc):**

| outcome | rc |
|---|---|
| CLEAN | 0 |
| PROBLEMS | 2 |
| REFUSED | 3 |
| CLEANUP-INCOMPLETE | 4 |
| CANCELLED | 5 |
| EXEC-FAILED (fixture only) | 6 |
| INCONCLUSIVE (including any timeout) | 7 |
| VOID | 8 |

**What CLEAN does not mean:** chain, state, trie, canonical-root, RPC or SNP validation.

**Root:**
- **Tests:** `bash jobs/q-exit-status.sh cmv-r1-tests 512 bash composite-mdbx-validation-stage/r1/jobs/tests.sh` → `## PASS (7)` (owner, not under unshare, FUSE).
- **Production (gated):** `jobs/root-composite-validate.sh VIEW_DIR [TIMEOUT]`.
- **Stop:** `jobs/stop-session.sh RUN_DIR` signals only the recorded session PID.
