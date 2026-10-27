# Claude 1848: base-state-readonly-stage/r10, the capture-lifecycle fix for root 1847 (source only; tests PREPARED, NOT RUN; production HOLD)

**Status:** r10 is prepared and frozen but untested, unbuilt and not PASS. The root finding is `logs/root-bsro-r9-findings-1847.md` (sha `12472e51…`).

**What I did not do:**
- I ran no tests, build, queue job, mount, namespace or scope change.
- I did not read any part, original or production state; I used no network, installed nothing and made no commits.
- I did not touch the independent r9 review or its report.

## Frozen stage
- **Stage:** `base-state-readonly-stage/r10/`, with 22 files plus SHA256SUMS. Every file is mode a-w; directories are as in r9.
- **r10 `SHA256SUMS` sha256:** `0034b392709ec2142ab465b4a50a993e47738a99cecd620d17876560218c36df`
- **r9 is preserved:** SUMS `f7470ced1fecc19f9fd62620b96e94693eb3825b84a632120a2d164f2a6159e5`, and `sha256sum -c` is clean after my work.
- **r8 is preserved:** SUMS `49a41e28…`, also clean.

**Changed vs r9 (sha256 of the r10 files):**

| file | sha256 | change |
|---|---|---|
| `jobs/bsro_gate.py` | `e91116aa46f621c0366cbb0bee3c22982363c430f349a5642090b7fec1c20beb` | `run_capture` ownership/lifecycle (below); new `group_alive`; `GUARD_SUITES` test_bsro_gate 14→16; docstring |
| `tests/test_bsro_gate.py` | `d727f4ab1d06b10db1486d1bfeeb21c1902c7ea257afb9a76a56dca7d73d7f46` | tests 7/8/12/13 with mandatory `finally` cleanup; new tests 15, 16; header 16 |
| `jobs/guard-tests.sh` | `acc11d043346c410596d7ae25ef684cb60d02cc45b54bf24f0825c26a3c1bd8e` | expects `test_bsro_gate 16` / "Ran 16 tests" |
| `jobs/ns-tests.sh` | `47b726e4b733b66f1f7a3a91efe940a91fe0b72b0967ab2c9c0051e66b145196` | header usage lane **256 → 512** (exclusive main lane) |
| `README.md` | `7772987da21828061b364491a359feb766acaea4022c9944b7b1a5225565c1e5` | r10 section; commands with r10 paths |

**Label-only changes:** the rest of the jobs files, `env.sh` and `tests/test_ns.py` differ from r9 only in r9→r10 labels:
- the job names `bsro-r10-*`;
- the receipt formats `bsro-guard-test-receipt/r10`, `bsro-ns-test-receipt/r10`, `bsro-build-accounting/r10` and `bsro-build-receipt/r10`;
- the comments.

I verified this with `diff <(sed s/r9/r10/g r9/f) r10/f`. The only other differences are kept history references ("r9 PB1") and the comment "(the build, since r9: /home/steven and /tmp)" in `jobs/ns.sh`.

**Byte-identical to r7** (checked with `cmp`): `src/main.rs`, `src/bin/mk_fixture.rs`, `Cargo.toml`, `jobs/disk_guard.py` (`b42cf8fd…`, = r5), `jobs/mount_identity.py`, `tests/test_disk_guard.py`, `tests/guard_wrapper.py` and `tests/test_mount_identity.py`.

**Unchanged policy:** the guard command, the all-265 gate, the resource policy, the namespace hardening and `ro_tree_ok`.

## The fix (`jobs/bsro_gate.py` `run_capture`)
Root 1847's point, which r10 now implements: **an exited, unreaped leader IS still ownership.**

**What r9 got wrong:** its "unreaped" guard was really `running()` (waitid WNOWAIT returns None). So once the leader had exited, `kill_group`/`term_group` refused to signal the surviving owned group.

**r10, item by item:**
1. **Ownership = `not st["final"]`.** `final` is set only immediately before the single `p.wait()`.
   - The zombie leader keeps the pid/pgid reserved until that reap. No other process can create a group with that id: `setsid` gives pgid = its own (different) pid, and `setpgid` needs an existing group in the same session.
   - So `killpg(p.pid, …)` before `final` can only reach our group. `running()` is used only as an observation (when did the leader exit; is cleanup still needed).
2. **EOF no longer ends the loop.** The loop exits only when `eof AND exited_at is not None AND not group_alive(pgid)`. Every iteration still ticks the lifecycle:
   - `grace` after the leader exited → SIGKILL of the owned group, which r10 allows after exit;
   - `term_wait` after our TERM while the leader is still running → SIGKILL, whether or not EOF was seen;
   - `hard` after the KILL → `abandoned`, never a success.

   Previously, a closed-pipe, TERM-ignoring child made the r9 code leave the loop at EOF and block in `p.wait()` with no deadline.
3. **An fsync failure at EOF** now goes through `sink_failed("fsync", e)`. That records `sinkError` and sends the same ONE ordered TERM as a write failure. The `outer` caller already treats `sinkError` as not verified (unchanged from r9).
4. **Unexpected-error cleanup** (`not done` in `finally`):
   - close the read end, then TERM once;
   - wait (bounded by `term_wait`) while `running() or group_alive(pgid)`;
   - if either still holds, SIGKILL the remaining owned group, also when the leader already exited;
   - then the final reap and re-raise.
5. **No signal after the reap, including from the handler race.**
   - The forwarding handlers are installed before the spawn; a signal during the spawn is recorded in `pending` and sent once the spawn finishes.
   - They run on the main thread between bytecodes and call `term_group`/`signal_group`, which check `final`.
   - `final = True` is set before `p.wait()`. A handler that fires during or after the reap therefore never signals.
   - The old handlers are restored only after the reap.

   `group_alive(pgid)` is a small `/proc` scan for live (non-Z) members with that pgrp. It is called only after the leader has exited (or in error cleanup).

No generic framework: the change is confined to `run_capture` plus the 10-line `group_alive`.

## Tests (PREPARED, NOT RUN): `tests/test_bsro_gate.py`, 16 tests
**Cleanup rule.** Every capture test has its leader write `$$` to a pid file (the leader is a session and group leader via `start_new_session`/`setsid`). A `finally` runs `kill_test_group(pidf)`, which SIGKILLs every live process whose pgrp AND session equal that pid. This runs even when an assertion fails; a missing or empty pid file (spawn failure) means there is nothing to clean. Driver subprocesses are killed and reaped in `finally` as well.

- **7:** an owned `sleep 300 &` holder after the leader exited 4 → rc 4, not abandoned, no group members (this is the root 1847 regression). Then a foreign `setsid sleep` → rc 0 and `abandoned`; its pid file is cleaned up.
- **8:** the forwarding driver: the child records its pid, then `exec sleep 300`; a SIGTERM to the driver gives driver rc 0 and child rc −15.
- **12, continuous writer:**
  - owned: a `while :; do echo …; done &` after the leader exited 3 → rc 3, bounded under 30 s, no members;
  - foreign: a setsid writer → abandoned within bounds;
  - both cleaned up in `finally`.
- **13, sink write failure:** `RLIMIT_FSIZE` in the driver gives EFBIG → one TERM → the trap shell's stand-in guard exits 73 → rc 73, no members.
- **15 (new), closed-pipe TERM-ignoring child:**
  - the child sets SIGTERM to SIG_IGN, writes its pid file, closes fds 1 and 2, then sleeps 300;
  - the driver uses `term_wait=1, grace=5, hard=5`;
  - the test sends one SIGTERM to the driver;
  - expect driver rc 0, child rc −9, not abandoned, `sinkError` None, under 30 s, no members.
- **16 (new), fsync failure:**
  - `os.fsync` is replaced *in the driver process only* by a function raising `OSError(EIO)`;
  - the child prints "hi", runs `exec >&- 2>&-; exec sleep 300` (EOF while the leader still runs);
  - expect `sinkError` starting with "fsync", rc −15, not abandoned, under 60 s, no members.

**Commands for root** (small lane first; each needs the stage SUMS to verify, which the jobs check themselves):
```
bash jobs/q-exit-status.sh bsro-r10-guard-tests 256 unshare -Urn  bash base-state-readonly-stage/r10/jobs/guard-tests.sh   # PASS: 10 + 6 + 16
bash jobs/q-exit-status.sh bsro-r10-ns-tests    512 unshare -Urnm bash base-state-readonly-stage/r10/jobs/ns-tests.sh      # PASS: 5
```
The ns-tests use the 512 MiB **exclusive** main lane, so they cannot clone a live recovery or composite session mount; the job also refuses while one exists.

**Strict gate (unchanged):** exact "Ran N", last stderr line "OK", empty stdout, and no ResourceWarning/skipped/FAIL/ERROR/Traceback.

**After a pass, root should also confirm no leftover `sleep 300`/writer processes:**
```
ps -eo pid,pgid,sid,cmd | grep -E 'sleep 300|while :' | grep -v grep
```

The guard-tests add roughly 3–5 s for tests 15 and 16. The memory is two short Python drivers plus a child, well under the 256 MiB lane (r8's similar driver tests passed in that lane).

## Static checks I ran (no execution of stage code)
- `ast.parse` on all `.py` files and `bash -n` on all `.sh` files: OK.
- No `__pycache__`, `runs/` or `*.pyc` in r10. The `r8/jobs/__pycache__` is not mine and is untouched.
- The file set equals r9's.

**Disclosure:**
- **SUMS listed itself.** My first SUMS generation included `SHA256SUMS` itself, because the redirect created the file before `find` ran, and its self-check failed. I regenerated it excluding itself, before reporting and in my own unreported stage, and the final `sha256sum -c` is clean.
- **Failed first patch.** One test-patch attempt failed on an anchor assertion before anything was written.

## Residual risks
- **A D-state leader:** if the leader is stuck in uninterruptible sleep, the final `p.wait()` is unbounded (as in r9). The queue's own timeout and tree kill remain the backstop.
- **Foreign holders:** a holder outside our group (via setsid) is abandoned and never a success, and is left to the queue's tree kill (no subreaper, by design).
- **/proc scan cost:** `group_alive` scans `/proc` every tick (about 50 ms) once the leader has exited. This is negligible for the build, but it is O(processes).
- **Test cleanup and pid reuse:** `kill_test_group` matches pgrp AND sid == the recorded pid. Matching an unrelated process would require pid reuse within seconds by a session leader with the same id. The test runs as the mapped user only.
- **Late signals are dropped:** a SIGTERM/INT/HUP that arrives after `final` is not forwarded, because the child is already being reaped. The caller sees the real rc.
- **The r9 risks still apply.**

## Hold
Production stays on **HOLD**. No build until:
- all 265 parts are committed and independently CONFIRMED;
- the r9 review and an r10 review are done, and their findings are addressed;
- actual r10 guard-tests and ns-tests receipts PASS;
- then the 4096 exclusive main lane, with the 16 GiB host floor, the root 40 GiB plus the 8 GiB native reservation, and the /vm guard as in r8/r9.

USB writes, downloads and VM boot remain PAUSED.
