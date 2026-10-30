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
