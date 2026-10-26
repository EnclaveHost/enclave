# qcow-allocation-nbd-stage/r2: socket-path, signal and lifecycle correction of r1 (1709). FROZEN 2026-10-26 21:33Z, NOT RUN

**Stage:** `qcow-allocation-nbd-stage/r2/`, **SHA256SUMS `37daf9be9b6c2a51af2cd01cfbdb6f08962ca835ab11115fbcb41526ba1b9f44`**. r1 `1d079b3d…` is unchanged (re-verified).

| file | sha256 |
|---|---|
| `alloc_check.py` (333 lines) | `9abcd25125e065f04680301d76a9a344ec86a8cc634357436aafffb8ee30730e` |
| `tests/test_alloc_check.py` (5 tests) | `3c60b7c97689ede46c73ec02e43385b7e73fc6ef3f4ee62b15b39310d3eb9dde` |
| `jobs/pins.sh` (= r1 pins; only the stage path and comment differ) | `6b3bc509d07a150e8b8bf6a2fb9d0d75c12bf6c4782825ff11bee34227610abe` |
| `jobs/tests.sh` (expects `Ran 5 tests`) | `e0efe164af5181cae2dfe9fabedcc6e2e383af6a649f63cf424593ef67047ef8` |
| `jobs/root-real.sh` (= r1 with r2 paths/names; requires `logs/qcow-alloc-r2-tests` rc 0) | `a370794d464a70271d7ba06adba8548ae7f538c840258aa6b56c53b4eed02606` |

**What I did:** `ast` and `bash -n` only. **What I did not do:** no build, test, server, mount, USB or original read.

## Corrections
1. **The socket path (root's finding: the deep `runs/` path exceeds the 108-byte `sun_path`).**
   - **The server:** `qemu-nbd` runs with `cwd` = the private run dir (a `chdir` has no 108-byte limit) and binds **`--socket=/proc/self/cwd/nbd.sock`**, the pattern root tested in overlay r7.
   - **The client:** it connects to **`/proc/<child PID>/cwd/nbd.sock`**. The child is our own, never-reaped-before-`stop()` child, so its PID cannot be reused.
   - **Before connecting it checks:** that path and `nbd.sock` stat'ed **relative to the run-dir fd** (`O_DIRECTORY|O_NOFOLLOW`) are the **same inode**, `S_ISSOCK`, and owned by us. It refuses otherwise. The socket is unlinked through the dir fd.
2. **Signals and lifecycle:**
   - **Blocking:** `SIGTERM`/`SIGINT`/`SIGHUP` are **blocked in `main()` before any thread or child exists**.
   - **The watchdog thread** consumes them with `sigtimedwait` and also enforces `--timeout`. On a signal or the deadline it records `stopReason`, then TERMs and later KILLs **the server's process group**, so a blocking libnbd call returns with an error.
   - **No reused PID is ever signalled:**
     - liveness is checked only with `waitid(P_PID, pid, WEXITED|WNOHANG|WNOWAIT)` under a lock (`exited()`);
     - `Popen.poll()` is never called (asserted at edit time);
     - `stop()` **joins the watchdog first**, then TERM/KILL with waits, then a final group KILL while the leader is still unreaped, then **the only reap**.
     - If the watchdog does not stop or the child cannot be reaped, `cleanupComplete` is false and rc is 4.
   - **The child:** `preexec_fn` **unblocks** those signals (the mask is inherited across exec), sets **`PR_SET_PDEATHSIG = SIGTERM`**, then exits (126) unless `getppid()` is still our PID. That is the **parent-race check**: a parent dying before the `prctl` cannot leave an orphan server.
   - **A signal arriving after the watchdog stopped** is drained with `sigtimedwait(…, 0)` and recorded.
3. **The complete receipt on every outcome.**
   - **One dict:** `main()` owns a single receipt dict that `check()` fills progressively: image identity before, ranges, server pid/socket, totals, calls.
   - **On refusal or error:** `refused` is added; `complete` stays false; `stopReason`, `serverReturncode`, `cleanupProblems`, `imageAfter`/`imageUnchanged` and `cleanupComplete` are always written (O_EXCL 0600).
   - **rc:** 0 complete; 3 refused, errored or signalled; **4 whenever cleanup is incomplete or the image identity changed**.
4. **The meaning of the flags** (stored in every receipt):
   - a HOLE/ZERO byte reads as zero from this image;
   - **the original page may legitimately have been zero, so a flagged byte is not necessarily lost useful content**;
   - it only means that any former **nonzero** data there cannot be recovered from this image;
   - allocated ≠ correct content;
   - **full MDBX + state checks remain required**.

## Tests (5; tiny 4 MiB qcow2 fixture; every run dir is under `…/d×100/e×60/run-*`, and each test asserts the socket path is > 108 bytes)
1. **r1's exact classification**, now over the long path: allocated 256 K (including zero-content data), non-data 192 K with the ZERO flag, range counts 1/1, image sha and identity unchanged, cleanup complete, the socket is the `/proc/self/cwd` form, and the receipt carries the clarified meaning.
2. **Chunking at 64 K:** the exact 4 MiB sum, allocated 256 K, ≥ 64 calls.
3. **Refusals** (beyond the export, overlap, empty range, wrong pin, writable image): rc 3 with a **complete** receipt (`complete` false, `cleanupComplete` true, the image unchanged where it was opened).
4. **SIGTERM mid-run:** a separate checker process makes about 100,000 small calls. After its server listens, it is sent SIGTERM. Asserted: rc 3, `stopReason` "signal 15", the receipt complete, the server process gone, the image sha unchanged, no process using the run dir.
5. **SIGKILL of the checker:** its server (found by `cwd` == run dir) is gone within 10 s by **`PR_SET_PDEATHSIG`**; the image is unchanged.

**After every run:** exactly one receipt, the socket removed, and **no process whose cwd is, or whose cmdline names, the run dir**. Test 5 deliberately leaves the socket file of the SIGKILLed run.

## Root order (main queue, 512; unprivileged; not in a user namespace)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh qcow-alloc-r2-tests 512 bash qcow-allocation-nbd-stage/r2/jobs/tests.sh       # Ran 5 tests, OK, rc=0
bash jobs/q-exit-status.sh qcow-alloc-r2-real  512 bash qcow-allocation-nbd-stage/r2/jobs/root-real.sh   # only after that PASS
```
**The real job's preflight is unchanged from r1:** the read-only mount; manifest `a2843215…` with discard `ignore`; candidate map `70180b22…` (9001 extents, 276,959,557 blocks); **no process names the original**; pins. The outputs go under `r2/runs/real-*`.

## Limits
- **Untested scenarios:** a deadline expiring mid-call is exercised by the same kill path as SIGTERM, but there is no separate fixture for it, and no hanging server can be simulated without test-only code.
- **Not pinned:** the libnbd C library (only `nbd.py`).
- **Not content integrity:** an allocated block may have been rewritten after the deletion. Full MDBX structure, trie, plain/hashed state and canonical-root checks still decide.
