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
