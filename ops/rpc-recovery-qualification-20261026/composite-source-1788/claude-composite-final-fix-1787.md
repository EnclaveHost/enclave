# composite-mdbx-validation-stage/r3: root review blockers B1 + B2 (1787). FROZEN, NOT RUN, NOT PASS

**Status:** source only.
- **Executed by me:** `ast`, `bash -n` and sha256.
- **Not done by me:** tests, mounts, production processes or original reads.
- **Untouched:** the copy/verify driver and the queue.
- **Preserved (SUMS re-verified):** r1 `7a9993d6…` and r2 `681c88f1…`. The pins and r9 `stop_group` are unchanged; its already-reaped branch never signals.

## Stage `composite-mdbx-validation-stage/r3/`, SHA256SUMS `f216ec3655b8fdcd704fb2a667b0b0b80ed553b6c5e05a6097429d6faca539db`
| file | sha256 |
|---|---|
| `composite_session.py` (551 lines) | `407aa7e98fe18f913112b9f49369416e98524ff28f4e44cde788958f314fdbf6` |
| `tests/test_composite_session.py` (**12 tests**) | `a6d98405deeabfe6121a6e3967908acf5a0b50eb336b9ac5f114f9d07d850494` |
| `jobs/tests.sh` (expects 12; retains fixtures on any failure) | `deaa23f6…` |
| `jobs/common.sh` | `cf9bb43e…` |
| `jobs/root-composite-validate.sh` (**disabled**) | `06b2f437…` |
| `jobs/stop-session.sh` (= r1/r2) | `ba1568db…` |
| `README.md` | `aa916af6…` |

## B1: an unmount error can no longer skip ending the same child
- **`unmount()`** records `timeout`, or `error: <Type>: <msg>` for **any** ordinary exception: FileNotFoundError, PermissionError, OSError, etc.
- **`end_child()`:**
  - runs the unmount inside `try/except/finally`;
  - in the `finally`, ALWAYS runs r9 `stop_group` on the same child;
  - if that raises, KILLs and reaps the group, but only while `c.returncode is None` (our unreaped leader);
  - records the returncode;
  - then lazily detaches OUR still-present dead mount with the pinned `fusermount3 -u -z`, wrapped as well.
- **Any failure** leaves the cleanup incomplete, giving CLEANUP-INCOMPLETE (rc 4).

## B2: cleanup touches only what this session created
- **`owns_run`:** set only when this session creates `session.pid` with O_EXCL. This happens after the stale-output check that refuses `work`, `receipt*`, `mdbx-report.json`, `validator.out` and `session.pid`.
- **`owns_work`:** set together with `os.mkdir(work)`.
- **`main` runs `cleanup()` only if `owns_work`.** A run dir this session did not claim gets **only** `receipt-refused-<ns>.json`. No `receipt.json` is taken, and the work, socket, mount and children of another session are never touched.
- **The signal window:** a module-level `deferred()` section records SIGTERM/SIGINT/SIGHUP and raises `Stop` when the section ends. It covers:
  - the `session.pid` claim plus `owns_run`;
  - `mkdir(work)` plus `owns_work`;
  - `spawn` (log, Popen, recording the child);
  - `bind_child` (`pidfd_open` plus recording, so cleanup always closes it).

  A signal still pending at cleanup time is reported as CANCELLED.

## Tests: expected `Ran 12 tests`
**Tests 1–10** are r2's. Test 10 now expects the refused receipt name and that no `receipt.json` is created.

11. **Stale and live previous runs:**
    - **(a) A stale `work/` with `db/`, an `nbd.sock` marker and a log:** REFUSED. All three are byte-identical afterwards, and no `receipt.json` is taken.
    - **(b) Session B started on the run dir of a LIVE session A** (exposed, holding the mount): B is REFUSED with only a refused receipt. A's mount and socket remain and A stays alive. A then completes normally (EXEC-OK, cleanup complete, its own `receipt.json`).
12. **An unmount program that cannot start:** a missing file (FileNotFoundError) and a non-executable file (PermissionError) as `--fixture-unmount-exe`. Each gives rc 4 CLEANUP-INCOMPLETE with `unmount.normal = "error: <Type>…"`, **qemu-nbd and nbdfuse both ended and reaped**, nothing alive and no mount.

## Root invocation (512 MiB main lane; exclusive with the 1024 MiB preservation sessions by the queue's single main flock)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh cmv-r3-tests 512 bash composite-mdbx-validation-stage/r3/jobs/tests.sh     # expect "## PASS (12)"
```
- **Run it as:** the owner, not under unshare.
- **Fixture retention:** fixtures are removed only after a PASS with no mount left.
- **Production:** `jobs/root-composite-validate.sh` refuses unconditionally (production stays disabled).

## Limits
- **Fixture assumptions, unproven until the run:**
  - nbdfuse `-o ro` gives ST_RDONLY;
  - libmdbx opens the FUSE file without-lck;
  - exact cmdline binding;
  - corrupt metas give rc 1–3;
  - libfuse unmounts itself on SIGTERM when not busy (tests 8 and 12);
  - nbdfuse exits on SIGTERM despite EBUSY, and the lazy detach then succeeds (test 9).

  A deviation is a test FAIL, never a false CLEAN.
- **The signal-deferral window:** the deferred sections are short system calls. A signal arriving inside one is acted on right after it ends. A SIGKILL is never deferrable, and then only PDEATHSIG ends the servers (unchanged).
- **Unchanged from r2:**
  - the lazy detach still yields CLEANUP-INCOMPLETE;
  - the m3 fail-closed false positives;
  - the 8 KiB mdbx_chk tail in the wrapper report;
  - production scale is not exercised;
  - no chain, state, RPC or SNP validation.
