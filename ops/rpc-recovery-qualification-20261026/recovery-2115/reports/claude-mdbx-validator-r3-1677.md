# MDBX validator r3: root's fixture sync fix, closed report reads, SIGTERM cancellation, and a job that reuses the official build. Source only; nothing built, run or tested by Claude - 2026-10-26

## Stage: `mdbx-recovery-validator-stage/r3`, FROZEN
**`SHA256SUMS` = `0b86301afa8dbce30ae8c7d647e498811b5649b5a92ec793412596cdcb49737c`** (files `a-w`).

| file | sha256 | vs r2 |
|---|---|---|
| `src/mdbx_check.py` | `f0d27e40c29271b94d2b48b9d4ab70a84de1f946709db4e9361cdfba00bac131` | cancellation (below) |
| `src/mk_fixture.c` | `b7119d1abbdeb232b771ce2346d05c4b39d743094ad122e53596b407c8b31231` | **byte-identical to root's** `mdbx-fixture-repair-stage/r1/mk_fixture.c` (root 1676) |
| `tests/test_mdbx_validator.py` (**20 tests**) | `c8ab9e8d308863bd09a9b77743e0ef47f131e9901dd8eac02480ed002f10ef68` | closed JSON reads, plus 2 cancellation tests |
| `jobs/reuse-and-test.sh` | `0640c6d1d8f2d038b289f71341687169f601a5cc0dc60e53773011470621d6b7` | new: reuses the build, queue 512 |
| `pins/libmdbx-v0.13.12-f619d43d.sha256` | `be06662eb9b82d52d172d08d70dae63808590991d80d7773f0a45042f5d11cf4` | = r1 (the job `cmp`s it) |
| `README.md` | `11b5f706af45e1261b6d7a79cc97e0adc3943e551f52a60acc0452dccfc2b494` | r3 notes; production command fixed |

**r1 and r2 are unchanged and re-verified:** r1 `f023beac…`, r2 `9ed80aaa…`. The job checks both before it runs.

**Checks done here:** an AST parse of both Python files and `bash -n` of the job. Nothing was executed.

## 1. Fixture sync fix (root 1672/1676)
- **The fix:** `mk_fixture.c` is root's narrow fix, byte for byte, and the job pins its sha `b7119d1a…`. Only `mdbx_env_sync_ex(env, true, false)` now accepts `MDBX_SUCCESS` **or** `MDBX_RESULT_TRUE` (-1). The pinned `mdbx.h` lines 2946-2948 allow -1 on success when there is nothing to flush.
- **Everything else stays strict:** every other call still goes through the strict generic `CK`, which accepts only `MDBX_SUCCESS`.
- **Evidence for the fix:** root's run 1676 compiled exactly this file against the pinned object, and r1's 10 tests passed.

## 2. Closed report reads
- `wrap()` now reads the JSON report inside `with open(out) as f:`, which fixes the "unclosed file … report-N.json" warnings root saw in 1676.
- The "unclosed BufferedReader" warnings in 1676 came from r1's `bounded_run`. r2 and r3 always close `p.stdout`.
- The job runs the tests with `-W always::ResourceWarning`. **It fails if any ResourceWarning appears** (`## no ResourceWarning` is a PASS condition).

## 3. Outer cancellation (r2 review: SIGTERM must reach the cleanup in `bounded_run`)
**Before:** under r2, Python's default SIGTERM/SIGHUP handling killed the wrapper without running `finally`. The owned `mdbx_chk` group was orphaned: still running, and under exclusive open on a 1.1 TB read.

**r3:**
- **Signal handlers:** `main` installs a handler for SIGTERM, SIGHUP and SIGINT, and restores the previous handlers on return.
- **Deferral:** the handler raises `Cancelled`, a `BaseException` that is never swallowed by `except Exception`. Inside `signals_deferred()` it only records the signal instead.
  - **What is deferred:** the **whole** `bounded_run` (Popen, the loop and the cleanup) and the report write.
  - **Why:** a signal can never interrupt starting, killing or reaping a child, so there is no gap where a child is created but not owned.
- **Inside `bounded_run`:**
  - the loop checks for a recorded signal at least every 0.1 s (select timeout; PEP 475 retries `select`/`sleep` after the handler runs);
  - when it finds one, it sets `cancelled`, SIGKILLs the owned group (the leader is still unreaped, so its pgid is safe) and keeps the r2 EOF/`KILL_GRACE` bounds;
  - the `finally` kills again and does the single bounded reap.
  - **Only then** does leaving `signals_deferred()` raise `Cancelled`.
- **Outcome:**
  - `main` prints `CANCELLED by signal N …` and returns **128+N** (143 for SIGTERM).
  - No report is started after the signal.
  - A report already being written is completed first, and the exit is still 128+N.
- **`run_clean`:** it also requires that `cancelled` is false.
- **Known small window:** a signal that arrives while `main` is restoring its handlers, after the cancellation is already handled, falls through to the previous handler. No child exists at that point.

## Tests (20 = r1's 10 + r2's 8 + 2 new; the new ones run the actual wrapper)
`cancel_wrapper` launches the **real wrapper** (`python3 -I -B src/mdbx_check.py`) as a separate process in its own session.
- **The fake `mdbx_chk`:** sha-pinned by the test. It starts an in-group grandchild `sleep 120` that inherits its stdout, writes both pids, then hangs.
- **The test then:** sends the signal and requires all of:
  - the wrapper exits within `BOUND`;
  - rc == 128+sig;
  - `CANCELLED` appears on stderr;
  - **both** the fake chk and the grandchild are gone within 5 s;
  - **no** report file exists.
- **Cleanup:** only on failure, the test kills its own processes by pid.

The two new tests:
19. `Runner.test_sigterm_or_sighup_during_the_version_probe_kills_the_owned_group`: SIGTERM, then SIGHUP, while `-V` hangs.
20. `Validator.test_sigterm_during_the_check_run_kills_the_owned_group_and_writes_no_report`: the fake chk passes `-V` (rc 0, exact describe), and the wrapper passes preflight on the **real read-only bind mount** of the pristine fixture. SIGTERM arrives during the hanging check run. `tearDown` also confirms every fixture directory is unchanged, lock files included.

## Job: reuse, no libmdbx recompilation (`jobs/reuse-and-test.sh`)
- **Freeze checks:** r3 matches its SUMS; r1 and r2 are frozen; r3's pins `cmp` equal to r1's; `mk_fixture.c` sha equals root's 1676 file.
- **Reused build:** root's 1670 build directory `mdbx-recovery-validator-stage/r1/runs/run-20261026T205843Z-2342321/build` must be a real directory (no symlinks) with:
  - `mdbx_chk` sha **`c228b462…7187981`**;
  - `mdbx-static.o` sha **`14446d9c…99bb6f`**;
  - `config-gnumake.h` sha `9767ebe1…` and `@buildflags.tag` sha `caf1a31a…` (they record the flags/compiler: `-DNDEBUG=1 -DMDBX_DEBUG=0 -DMDBX_TXN_CHECKOWNER=0 -DMDBX_USE_FALLOCATE=0`, GCC 16.2.1);
  - its source copy matching all 33 pins, and `VERSION.json` describing v0.13.12-0-gf619d43d.
- **No writes to the reused directory:** `mdbx_chk`, `mdbx-static.o` and `mdbx.h` are **copied** into `runs/<run>/bin` and re-hashed there.
  - **Only `mk_fixture.c` is compiled**, against the copied object, with the same `cc` line root used in 1676.
- **Version:** `mdbx_chk -V` must give rc 0 **and** the exact describe.
- **Tests:** run under `env -i`, `timeout -k 5 900` and `-W always::ResourceWarning`.
- **Post-run checks:** the stage and the reused binary/object are unchanged, and there is no bytecode in the stage.
- **Queue cap 512** (supported). Root's full compile 1670 peaked at 403 MiB and the fixture-only run 1676 at 28 MiB. The unsupported 2048 is not used.

## Exact root job
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh mdbx-validator-r3 512 unshare -Urnm bash mdbx-recovery-validator-stage/r3/jobs/reuse-and-test.sh
```
**PASS requires all of:**
- `## reuse OK (…)`
- `## fixture build OK`
- `## version OK v0.13.12-0-gf619d43d`
- `## test_mdbx_validator PASS (20)`
- `## no ResourceWarning`
- `## mdbx-validator-r3 rc=0`

## Also corrected
- **Wrong production command in r2:** r2's README pointed it at `r1/src/mdbx_check.py`, the wrapper with the blocking reader. r3's README uses `r3/src/mdbx_check.py` with `--chk-sha256 c228b462…`.
- **Stale "r1" labels:** r2 still carried "r1" in its headers and in `FORMAT`. In r3 these are r3 (`mdbx-readonly-check-report/r3`).

## Not claimed
- **Nothing is verified yet:** none of the r2 runner fixes or the r3 cancellation handling is verified until root runs the job above.
- **Unchanged from 1661/1667:** the production limits (identity uncertainty; no page or meta checksums; not chain verification) and the gate wording. Plain-vs-hashed state must be a FULL check or carry an explicit "plain state UNVERIFIED" limitation, and a sample never qualifies.
- **Restrictions kept:** no USB, no mount changes, no writes to the original, no production DB read.
