# 1789: composite-mdbx-validation-stage/r4 = frozen r3 + the T1 test correction (FROZEN, NOT RUN, NOT PASS)

**Scope:**
- **What I executed:** `sha256sum`; `diff` of r3 against r2; reading the r3 runtime, tests 8–12 and jobs; copying r3 to a NEW r4; text edits to the r4 tests, jobs and README only; `ast` parse; `bash -n`; `cmp`; freezing.
- **Not done:** tests, mounts, probes, production I/O, process inspection, or anything touching the live preservation batch. **r3 and r2 are untouched** (r3 SUMS `f216ec36…` and r2 SUMS `681c88f1…` re-verify OK). There was no STOP of the driver.

## Frozen r4: `composite-mdbx-validation-stage/r4/`
**`SHA256SUMS` sha256 `23e4a558ab5f6723114edc240412bcc9b6cdfec38641cb1cca6d3db8a159099e`** (7 entries, all `-r--r--r--`, verified OK).

| file | sha256 | change vs r3 |
|---|---|---|
| `composite_session.py` | `407aa7e98fe18f913112b9f49369416e98524ff28f4e44cde788958f314fdbf6` | **none (byte-identical, `cmp` OK)**; its docstring still says r3 |
| `tests/test_composite_session.py` | `7478ededf6830be7812c730b4d0724f1b2915c8ae2240b204debaa75e5aa65c6` | header r4; **test 9: one assertion relaxed (T1)**; all 12 tests kept |
| `jobs/common.sh` | `09c08dec54be6bac433437dfaa07f94100c5b91e4f069bc7ad0a6d1a9f6ac861` | `S=…/r4`, header |
| `jobs/tests.sh` | `28cd208c2dbb3d9ec0cd108cfc4d8da8537dcf0bc52b10600dc36ff8f0b88f90` | r4 paths, `cmv-r4-tests`, receipt format `…/r4` (still exactly 12 tests) |
| `jobs/root-composite-validate.sh` | `908b55e35238ba8df942b5355bde43b6d059b765d9a4337a20e203c45906f302` | text r4; **still refuses unconditionally (production DISABLED)** |
| `jobs/stop-session.sh` | `ba1568db3778640ad0289fceea55582aab9c52a585b1fd060efaa3001ede050d` | none |
| `README.md` | `f7ad97b4533d2ad51aa1ce65f69449e63a8fe4b600dce05a8d8cfe76b3c0dbb3` | r4 section prepended |

**The exact test change.** Test 9 previously asserted:
```
self.assertEqual(r["unmount"].get("lazy"), 0)
```
It now asserts:
```
self.assertIn(r["unmount"].get("lazy"), (None, 0), r["unmount"])
```
- **Kept:** `normal != 0`, rc 4 CLEANUP-INCOMPLETE, `ended(r)` (both servers' returncode set, `childrenAlive == []`, `mountLeft == false`, no holder), and no mount.
- **Why:** the system `libfuse3.so.4` (linked by `/usr/bin/nbdfuse`) carries `/usr/bin/fusermount3` with `--unmount --quiet --lazy`. So nbdfuse may detach the busy mount **itself** on SIGTERM, leaving nothing for our fallback.
- **Not verified:** whether nbdfuse's SIGTERM path actually reaches that unmount. The fixture run decides; both outcomes are now accepted, and neither can be CLEAN.

## Root invocation (512 MiB main lane only; do NOT stop the driver)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh cmv-r4-tests 512 bash composite-mdbx-validation-stage/r4/jobs/tests.sh     # expect "## PASS (12)"
```
- **Why there is no overlap with a preservation batch:** the 512 and 1024 jobs share `claude-test-queue.py`'s exclusive main flock through `child.wait()` (1786).
- **The job's guards:** it refuses on a live `orchestrate.py`/`overlay_session.py`/`composite_session.py` process or a stage mount. It runs as the owner, **not** under unshare (FUSE).
- **PASS requires all of:**
  - exactly `Ran 12 tests`, `OK`, empty stdout, no ResourceWarning/skip/FAIL/ERROR/Traceback;
  - peers unchanged;
  - no mount left;
  - the stage unchanged.

  Fixtures are kept on any failure.

## Safety review of root's B1/B2 in the r3 runtime (r4 is identical)
**B1: an unmount error can no longer skip ending that child.**
- `unmount()` now catches `TimeoutExpired` **and any `Exception`** (a missing or non-executable program, `OSError`, fork failure) and records `error: …`.
- `end_child()` runs `stop_group` in a `finally`, whatever the unmount did. If `stop_group` raises, an unreaped child is killpg'd and reaped (`wait(10)`). The returncode is recorded, and `cleanup_ok` becomes false unless the child was reaped and its group is empty.
- A lazy detach (ours) runs only with `cleanup_ok` already false.
- **Test 12** (an absent program, and a non-executable one) and test 8 (a hung program) cover this. This also closes my 1786 R1.

**B2: cleanup acts only on what this session created** (root's finding: a refused session would clean up a previous session's work dir).
- **Run-dir claim:** `owns_run` is set only by this session's `O_EXCL` `session.pid`, created inside `deferred()`.
- **Work-dir claim:** `owns_work` is set only together with this session's `mkdir(work)`. A pre-existing `work` is refused in `prepare`, or makes `mkdir` fail, and in both cases ownership is never set.
- **`main`** runs `cleanup()` **only if `s.owns_work`**, and writes `receipt.json` only in a run dir it owns. Otherwise it writes `receipt-refused-<ns>.json` with `O_EXCL` and leaves everything else as found.
- **Test 11** covers a stale work/socket/log marker left untouched, and a LIVE session A: B is refused, A's mount, socket and process are untouched, and A then completes EXEC-OK with a clean cleanup.
- **Signal windows:**
  - `_on_signal` records, rather than raises, while `defer > 0`, for the run-dir claim, the work-dir claim, `Popen` + child record (and log), and `pidfd_open` + bind record. `deferred()` raises the pending `Stop` when the section ends, so a started child or opened pidfd is always known to cleanup;
  - in `main`'s `finally`, the handlers become `SIG_IGN` and `armed=False`, and a pending signal is reported as CANCELLED;
  - `os.write` of `session.pid` is outside the deferral. A signal there leaves an empty `session.pid` that is still owned: harmless.
- **Owned children:**
  - unchanged r9 `stop_group` (signals only an unreaped leader's group; the reaped branch only reads);
  - subreaper plus adopted-orphan kill and reap;
  - every cleanup step independent (`safe()`).
- **Lazy detach is never CLEAN.**

**Classification:** unchanged from r2.
- **CLEAN** needs mdbx_chk rc 0, structurally clean, wrapper rc 0, an unchanged identity, no timeout/truncation/held/escaped flags, `mdbxDatBytes == view logicalSize`, a passing post-use check-held + recheck, and a complete cleanup.
- **Inconclusive:** anything incomplete is INCONCLUSIVE.
- **Run-dir outputs:** stale outputs are refused before anything is claimed.

## Further findings
**No further source blocker.** Minor, not fixed (by scope):
- **PID-reuse flake:** `ended()` also asserts `/proc/<pid>/fd` is absent after the reap. PID reuse within the test window would be a false FAIL; this is improbable with a large `pid_max`.
- **Kernel-dependent assumption in test 9:** after a detach, the test process's still-open fd is expected to readlink outside `RUN/work` (`d_path` of a detached mount), so `holders()` reports none. If the kernel shows the old path, test 9 would FAIL closed (a test FAIL, not a false CLEAN).
- **Unbounded wait:** `subprocess.run`'s post-kill `wait()` is unbounded only if fusermount3 is unkillable (D state). This is unchanged and improbable.

## Remaining limits
- **Proven only by root's actual 12-test run.** Still unproven until that run:
  - `nbdfuse -o ro` gives ST_RDONLY;
  - libmdbx opens the FUSE file without-lck;
  - the exact cmdline binding;
  - the corrupt-meta fixture gives rc 1–3;
  - libfuse's unmount behaviour (tests 8, 9, 12);
  - the detached-fd readlink.
- **Fixtures are tiny:** production scale is not exercised (1.13 TB view, days of runtime, memory, the 2560 placeholder cap).
- **Output retention:** the r4 checker keeps only the last 8 KiB of mdbx_chk text in its report; truncation is classified INCONCLUSIVE.
- **Detection, not prevention:** parts are same-user writable; a change gives VOID.
- **Production stays DISABLED.** Enabling needs a new reviewed revision after:
  - an actual cmv-r4 PASS;
  - all 265 parts verified in CONFIRMED sessions;
  - an r6 production view;
  - a memory/time window.
- **CLEAN is structural only:** it is not chain, state, trie, canonical-root, RPC or SNP validation, and not a recovery acceptance.
