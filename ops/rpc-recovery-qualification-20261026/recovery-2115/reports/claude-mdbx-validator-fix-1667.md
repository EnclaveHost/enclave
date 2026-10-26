# MDBX validator r2: bounded runner fix (root review blocker). Source only; nothing built, run, mounted or read - 2026-10-26

## Stage: `mdbx-recovery-validator-stage/r2`, FROZEN
**`SHA256SUMS` = `9ed80aaadd21d304937a3cbd05bf761ee63229ff8c960263b2e9f06a9e4a2329`** (files `a-w`).

| file | sha256 | vs r1 |
|---|---|---|
| `src/mdbx_check.py` | `2f2c5c16c6f1a723c47f3ff23c49f06bf20ff1de7991d4f00ca578eb6f2514a1` | new `bounded_run`, `-V` rc, timeout range |
| `tests/test_mdbx_validator.py` (18 tests) | `b8d3ff863eccabbc820c4987ced0e8eb96f89870c4322f237f8500b168d15ad0` | r1's 10 unchanged plus 8 runner regressions |
| `jobs/build-and-test.sh` | `28717402f60c18ff6bb2c0bdc9ef80850171f8ddc164a760ab16ba4140b5c936` | r2 paths, the r1 pin, count 18, tool presence |
| `pins/libmdbx-v0.13.12-f619d43d.sha256` | `be06662eb9b82d52d172d08d70dae63808590991d80d7773f0a45042f5d11cf4` | **= r1** (`cmp`ed by the job) |
| `src/mk_fixture.c` | `26fce65433222ec9b149aa65294a197f937109387430aef25c986166bb097b11` | **= r1** (`cmp`ed by the job) |
| `README.md` | `dfdf39fa784799cd437ce1f96cdb8ba383af43e559e4670ebe0543ee9c9e4a7b` | r2 notes plus the production-gate wording |

**Unchanged:** r1 `f023beac…` (re-verified). The official libmdbx v0.13.12 (`f619d43d`) source pins and the build recipe are unchanged.
- **The binaries:** the job builds them again from the identical pinned source. A previously built binary may be reused only if its sha256 equals a pinned build receipt.

## The blocker and the fix
- **The blocker:** r1's `bounded_run` called a blocking `stdout.read1()`. A child that is silent while stdout stays open, or that has a descendant holding stdout, blocked forever and the timeout never fired.
- **r2's `bounded_run(argv, timeout, cap)`:**
  - **`timeout` must be > 0** (bool refused); `main` also requires `--timeout` 1..604800.
  - **Own process group:** the child runs with `start_new_session=True`.
  - **One absolute deadline** and **non-blocking** reads through `selectors` (0.1 s slices). Nothing blocks.
  - **Exit detection without reaping:** `os.waitid(P_PID, pid, WEXITED|WNOHANG|WNOWAIT)` leaves the child an **unreaped zombie**, so its pid/pgid cannot be reused while we may still signal the group (the same ownership rule as the producer r6 fix).
  - **The group is SIGKILLed on:**
    - the deadline (`timedOut`);
    - output beyond `cap` (`cut`; the default cap is 16 MiB);
    - stdout still held `EOF_GRACE` (2 s) after the child exited (`heldOpen`);
    - and **always** before the final reap. Nothing of ours outlives the run.
  - **After a kill:** at most `KILL_GRACE` (5 s) for EOF. A holder that escaped the group (setsid) is **reported** (`escaped`) and never waited for.
  - **The only reap** is `p.wait(timeout=KILL_GRACE)`; an unkillable leader is reported as `escaped`.
  - **The bound:** total time is ≤ timeout + 2 s + 5 s (+ scheduling).
- **`run_clean(r)`** is true only for rc 0 **and** no timeout, cut, held stdout or escaped holder.
  - **`-V`** must be clean (**rc 0**) **and** contain the exact `v0.13.12-0-gf619d43d`.
  - **The check run:** `structurallyClean = run_clean(r)` **and** an unchanged directory identity. The report carries `timedOut`, `outputTruncated`, `stdoutHeldAfterExit` and `escapedHolder`.

## Regressions (8 new, real child processes, no database; r1's 10 unchanged)
1. **Silent hang** (`sleep 120` behind a 1 s timeout): returns within the bound, `timedOut`, rc < 0, not clean, the process is gone.
2. **Output flood** (an endless 64 KiB writer, cap 64 KiB): `cut`, the text is ≤ cap, it is killed and gone.
3. **A grandchild holding stdout in the group** (the child exits 0, its `sleep` keeps stdout): `heldOpen`, not escaped, not clean, and the grandchild is **killed**.
4. **A holder that escaped the group** (`setsid sleep`): `heldOpen` plus `escaped`, returns within the bound, not clean. The test kills its own escaped process by its printed pid.
5. **A normal child** (`echo hi`): clean, the exact text, reaped.
6. **`-V` with rc 3** but the right describe is refused, and so is a wrong describe with rc 0.
7. **A hanging `-V`** (`VERSION_TIMEOUT` 1 s for the test) is refused within the bound.
8. **`--timeout`** 0 / −5 / 604801 is refused, and `bounded_run` timeout 0 / −1 / 0.0 / `True` raises.

## Wording correction (the r1 report said "a full read-only re-hash or a reviewed sample")
- **Plain-vs-hashed state consistency** must be a **full** read-only check before production, **or** the result must state an explicit "**plain state UNVERIFIED**" limitation.
- **A sample cannot qualify full integrity.** It can only find problems.
- **The same rule for every gate:** partial is reported as partial, never as clean.
- **Superseded:** this supersedes step 5 of `logs/claude-mdbx-validator-1661.md`.

## Exact root job
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh mdbx-validator-r2 2048 unshare -Urnm bash mdbx-recovery-validator-stage/r2/jobs/build-and-test.sh
```
**PASS requires all of:** `## build OK`, `## version OK v0.13.12-0-gf619d43d`, `## test_mdbx_validator PASS (18)`, `## mdbx-validator-r2 rc=0`.
- **Pre-checks:** the job verifies r1 is frozen, the pins and fixture are byte-identical to r1, the dist matches all 33 pins, and that `setsid`/`sleep`/`echo`/`true`/`mount`/`umount` exist.

**Not claimed:** nothing has been built or run.
- **Production:** the production use and its limits (identity uncertainty; no page or meta checksums; not chain verification) are unchanged from 1661.
- **Restrictions kept:** no USB, no mount changes, no writes to the original.
