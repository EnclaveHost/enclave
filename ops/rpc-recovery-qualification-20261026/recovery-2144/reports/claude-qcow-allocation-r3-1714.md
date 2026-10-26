# qcow-allocation-nbd-stage/r3: fixes the client socket path (root 1713). FROZEN 2026-10-26, NOT RUN

**Stage:** `qcow-allocation-nbd-stage/r3/`, **SHA256SUMS `8dc231f279127085fc30b041d6ecba0531bcfa830660635cf38ca719567b2b43`**. r2 `37daf9be…` and r1 `1d079b3d…` are unchanged (re-verified with `sha256sum -c`).

| file | sha256 |
|---|---|
| `alloc_check.py` (352 lines) | `f0f44810dfd21152b21014579c09b45c441941c1311c4cf479d7b40fb2cc2807` |
| `tests/test_alloc_check.py` (5 tests) | `40bc3f542227fbac9e6ab19096941618eb50f747358d2ee7723b32a03d2a9508` |
| `jobs/pins.sh` (= r2 pins; only the comment differs) | `9c6b5ff152e58313d60c53d1f5f9a17eefe183c67b1fa2fc64a51936ca36e90c` |
| `jobs/tests.sh` (expects `Ran 5 tests`) | `1d6af1b9afab3ea3148b7b1d319a1949d83f671044b6bc414a9445c8db4957e4` |
| `jobs/root-real.sh` (= r2 with r3 paths/names; requires `logs/qcow-alloc-r3-tests` rc 0) | `bb687d7866d119bcd8199431df70e6de94bafd98e74d8c26f59b517bed388ad1` |

**What I did:** `ast`, `bash -n` and sha256 only. **What I did not do:** no test, build, server, mount, USB or original read.

## The r2 error (root 1713, positive attribution)
`qemu-nbd` (PID 2378325) started in the deep run dir and bound `/proc/self/cwd/nbd.sock` there. **Then it changed its cwd to `/`.** r2's client path `/proc/<child>/cwd/nbd.sock` therefore resolved to `/nbd.sock`, which does not exist. r2 waited instead of refusing, so the long-path fixture hung before listen. **The design was wrong; the fixture was right to expose it.**

## The r3 fix (`alloc_check.py`)
1. **The client path is `/proc/self/fd/<run_fd>/nbd.sock`.**
   - `run_fd` is the checker's **own** `O_DIRECTORY|O_NOFOLLOW` fd of the run dir. It stays open for the whole check, and the client runs in this process.
   - The path is short regardless of how deep the run dir is.
   - **The server side is unchanged:** it binds `/proc/self/cwd/nbd.sock` with initial cwd = the run dir (the pattern tested in overlay r7). Its later `chdir("/")` no longer matters.
2. **Exact verification before connecting (`Server.socket_path`):**
   - `lstat(nbd.sock, dir_fd=run_fd)` and `lstat(/proc/self/fd/<run_fd>/nbd.sock)` must both be `S_ISSOCK`, have **the same (dev, ino)**, and have uid == our euid.
   - Otherwise the check **refuses immediately**; there is no waiting.
   - The path actually used is recorded in the receipt as `server.client`. `server.bind` records the bind form.
3. **The readiness wait fails fast on the known failure.**
   - While the socket is missing, the loop checks `/proc/<child>/cwd`. The child is unreaped, so its PID cannot be reused, and `Popen` returns only after the exec, so the server's chdir into the run dir has already happened.
   - **If the server left the run dir and still no socket exists there** (re-checked once to close the bind/chdir race), it **refuses at once**: "left its initial cwd without a socket in the run dir".
   - The existing refusals stay: the child exited, a signal or deadline, or 60 s.
   - All r2 lifecycle code is unchanged: blocked signals, the watchdog, the waitid WNOWAIT liveness check, join-then-reap, PDEATHSIG with the parent check, and the complete receipt.

## Tests (5; every r2 assertion kept; additions only)
- **Server identification no longer uses cwd.** The new `children(ppid)` returns processes whose `/proc/<pid>/stat` parent is the checker and whose `comm` is `qemu-nbd`. Tests 4 and 5 use it instead of the cwd-based `holders()`; `holders()` is still asserted empty after every run.
- **Fail fast in the fixture:** `spawn()` fails immediately if the checker exits before its server listens, instead of waiting 30 s.
- **New assertions:**
  - **every receipt with a server:** that server PID is gone (exited or zombie-only) after the check;
  - **test 1:** `server.client` is **exactly** `/proc/self/fd/<digits>/nbd.sock` (never a `/proc/<child>/cwd` path), and `server.bind` starts with `/proc/self/cwd/nbd.sock`.
- **Unchanged:**
  - every run dir is under `d×100/e×60`, and each test asserts its socket path is longer than 108 bytes;
  - the classification, chunking, refusals, SIGTERM and SIGKILL/PDEATHSIG assertions are as in r2.

## Root order (main queue, 512; unprivileged; not in a user namespace)
**First, stop the known-failed r2 fixture (root's own job).** Stop it with a bound, and preserve its logs and `logs/qcow-alloc-r2-tests.*`. Do not delete r2 run dirs; they are evidence.

Then:
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh qcow-alloc-r3-tests 512 bash qcow-allocation-nbd-stage/r3/jobs/tests.sh       # Ran 5 tests, OK, rc=0
bash jobs/q-exit-status.sh qcow-alloc-r3-real  512 bash qcow-allocation-nbd-stage/r3/jobs/root-real.sh   # only after that PASS
```
**The real job's preflight is unchanged:**
- read-only mount;
- manifest `a2843215…` with discard `ignore`;
- candidate map `70180b22…` (9001 extents, 276,959,557 blocks);
- no process names the original;
- pins.

The outputs go under `r3/runs/real-*`.

## Limits
- **The `chdir("/")` comes from root's observation**, not from reading the qemu source. If a qemu-nbd version changed cwd *before* binding, r3 now refuses fast, which is the safe outcome.
- **The fail-fast branch has no dedicated fixture.** It needs a server that leaves its cwd without binding, which cannot be produced without test-only code.
- **Inherited from r2:** no separate deadline-mid-call fixture, and the libnbd C library is not pinned (only `nbd.py`).
- **Allocation status is not content integrity.** Full MDBX structure, trie, plain/hashed state and canonical-root checks still decide; nothing here is an "intact" claim.
