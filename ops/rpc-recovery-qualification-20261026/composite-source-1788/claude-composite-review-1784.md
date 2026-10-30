# 1784: independent source-only review of the frozen composite-mdbx-validation-stage/r1 (NOT a PASS; nothing run)

**Scope:** reading only.
- **What I executed:** `sha256sum -c` of the stage; reading `composite_session.py`, the 4 jobs, test names and asserts, the author report 1782, r9's reused helpers (`overlay_session.py` 80–135) and r6 `check-held` (grep).
- **Not done:** tests, builds, mounts, process inspection, live parts, the original, or anything touching the active copy of 9..16.
- **Tests:** root's 7 real tiny-MDBX fixtures have **not** run yet.

| item | sha256 |
|---|---|
| stage `SHA256SUMS` (all 7 entries verify OK) | **`7a9993d6a4629f5ba4a5b9b41add52cb32a8cd74a1f62bf6070b9a723de8bf1c`** |
| `composite_session.py` (453 lines) | **`2b6a474d13a8e5b146fa90db94693a580ac3f78708f3c41083f7e8ce75544fd2`** |
| `tests/test_composite_session.py` (7 tests) | `1d6b4dc373929d7da3783cffcaaf51a2c4e8fdece857b368f84e7fda81fd4c6a` |
| `jobs/common.sh` / `tests.sh` / `root-composite-validate.sh` / `stop-session.sh` | `4f591901…` / `9471bc8c…` / `dff9efe0…` / `ba1568db…` |

## Verdict
**Safe to run the 7 fixtures, but ONLY at a real batch boundary (A1).**
- **The lifecycle design is sound,** and classification is honest: nothing but a confirmed mdbx_chk rc 0 plus a passing post-use check can be CLEAN.
- **A1 is the one activation blocker for the fixture job.**
- **A2 must be fixed before the production run** (it does not block the fixtures).
- The rest is minor.

## A1 (ACTIVATION BLOCKER for the fixture job): no in-code guard against overlapping a preservation batch, and the batch runner cannot see this job
**The gap:**
- `jobs/tests.sh`/`guards` (`common.sh` 12–21) refuse nothing when a preservation session is live (`orchestrate.py`, `overlay_session.py`, an r3/r9 stage mount) or when the 1773 driver is running.
- The 1773 runner's `busy_reasons` only matches `overlay_session.py`/`orchestrate.py` processes and `/recovery-multipart-stage/`/`/recovery-overlay-stage/` mounts. It does **not** see `composite_session.py`, its qemu-nbd/nbdfuse, or mounts under `composite-mdbx-validation-stage/r1/runs`.
- So while the driver runs, the next batch can start inside the up-to-1 h fixture window.

**Consequences (both fail-closed, but they halt production):**
- **(a)** The frozen r3 wrapper's peer snapshot sees this job's qemu-nbd/nbdfuse, which gives wrapper rc 4. The batch stops, and per 1772 P3-3/1778 M3 a stopped batch is **not** resumable by the driver.
- **(b)** This job's `peer_snapshot` (`pgrep -x qemu-nbd|nbdfuse|fuse2fs`, FUSE mounts outside `$S/runs`) sees a session start or end, which gives `peersUnchanged` false and a test FAIL.

**A "boundary" lasts only seconds** while the driver auto-launches the next batch.

**Minimal fix:**
- **Operational (now, no code):**
  - pause the driver first: `OUT/STOP` or `kill -TERM` the driver;
  - wait until no `orchestrate.py`/`overlay_session.py` process and no r3/r9 stage mount exists, and the driver has exited;
  - then queue `cmv-r1-tests`;
  - resume with a new `drive --start N --out NEW` afterwards.
- **In code (a small `guards` addition):** refuse if `pgrep -u $(id -u) -f 'orchestrate.py|overlay_session.py|root-multipart-batches-1773.py drive'` matches, or if mountinfo contains `/recovery-multipart-stage/` or `/recovery-overlay-stage/`.
  - It still cannot stop a batch the driver launches later, so the driver must be stopped or exited.

## A2 (fix before the PRODUCTION run; not a fixture blocker): one cleanup exception skips ending the remaining owned children
**The problem:** `cleanup()` (356–378) is a single straight sequence. Any exception in it aborts all later steps. `main` (420–423) then only records `cleanupError` and returns CLEANUP-INCOMPLETE.

**Concrete trigger:** `end_child("nbdfuse")` runs `subprocess.run([fusermount3, "-u", …], timeout=30)` (327). A busy or hung FUSE unmount raises `TimeoutExpired` (r9's own `run()` is not used here). Then:
- `stop_group(nbdfuse)` and `end_child("qemu-nbd")` never run: no TERM/KILL, no reap;
- pidfds and logs are not closed;
- the socket is not removed;
- `holders()`/`mountLeft` are not recorded.

**Mitigation that already exists:** both servers carry `PR_SET_PDEATHSIG=SIGTERM` (r9 `limits`), so they get SIGTERM when the session exits. That is mitigation only: it is unverified and unrecorded.

**Minimal fix (no new framework):** make each cleanup step independent. For each of these steps in order, run it inside `try`/`except Exception`, which records the error, sets `cleanup_ok = False`, and continues:
- `end_child("exec")` + `reap_adopted`;
- `end_child("nbdfuse", db)`;
- `end_child("qemu-nbd")`;
- closing pidfds and logs;
- the final mount/adopted checks;
- the socket unlink;
- `holders()`.

**Test:** inject a `fusermount3` failure (e.g. a busy holder inside the mount) and assert that qemu-nbd and nbdfuse are still ended and reaped, with CLEANUP-INCOMPLETE recorded.

## Checked and sound (by reading)
**Owned children:**
- every child is our `Popen` in its own group, with `limits()` (RLIMIT_FSIZE 64 MiB, no core, PDEATHSIG + parent check) and we are a subreaper;
- qemu-nbd and nbdfuse are bound by pidfd + start time + exact cmdline + `/proc/PID/exe` inode == the pinned binary;
- the nbdfuse pid file must equal our child;
- waits use `exited_nowait` (WNOWAIT), so no premature reap.

**Reused r9 `stop_group`:**
- it signals the group only while the leader is unreaped (its zombie keeps the pgid reserved), and reaps last;
- **the already-reaped branch (`c.returncode is not None`) only reads `group_members(pgid)` and never kills.** That branch is reached for the exec in `cleanup` after `use()` reaped it; leftovers then make `cleanup_ok` false, which is honest.
- escaped (setsid / double-fork) descendants become our adopted children and are SIGKILLed and reaped, never reused;
- the validator group is ended before the unmount (r9 F1);
- a child started but not yet recorded at a signal is still caught as adopted.

**Read-only mount binding:**
- qemu-nbd `--read-only --shared=1` with the view's `read-only=on` image-opts;
- `check-held` (r6: every fd of the PID is `O_RDONLY`, and all bound inodes plus the descriptor are held) runs before the mount and again before exec;
- the mount must be **ST_RDONLY**, contain only `mdbx.dat`, have the view's logical size, and refuse `O_WRONLY`;
- the wrapper re-checks its own db identity (`unchangedIdentity`).

**Post-use:**
- `held("postUse")` = the same qemu process (pidfd, start time) + r6 `cmd_check_held`, which runs `recheck` before **and** after the fd scan (manifest, r3 recorded state, identities, record bytes);
- a failure gives **VOID (8)**, which overrides every validator result;
- CLEANUP-INCOMPLETE overrides everything, and CLEAN additionally requires `cleanupComplete`.

**Classification honesty:**
- **CLEAN** needs all of: report rc 0, `structurallyClean` true, wrapper rc 0, `unchangedIdentity` true, no timeout / truncated / held / escaped flag, no exec leftovers, post-use OK and a complete cleanup;
- **PROBLEMS** needs report rc 1–3 with no inconclusive flags;
- a missing report, rc 4/5, any timeout or truncation gives **INCONCLUSIVE**;
- a refusal before exec gives REFUSED;
- **a refusal after exec gives INCONCLUSIVE (never REFUSED)**;
- signals give CANCELLED.

## Minor findings
- **m1: a stale report could be read.** `prepare` refuses an existing `work/` or `receipt.json`, but not a pre-existing `mdbx-report.json`/`validator.out`. A stale report with rc 1–3 could then be read as PROBLEMS, for instance if the wrapper refused because its `--out` existed. The jobs always create a new run dir, so this is unreachable there.
  - **Fix:** also refuse those two names in `prepare`.
- **m2: CLEAN does not check the report covered the whole file.** It does not assert `report.preflight.mdbxDatBytes == view.logicalSize`; test 1 asserts it for the fixture only.
  - **Fix:** add it to the CLEAN condition (it is cheap).
- **m3: false-positive leftovers.** `holders()` flags any process whose cmdline, cwd or fd names `RUN/work`. Root's monitoring must not name that path, or the run becomes CLEANUP-INCOMPLETE (a false positive, but fail-closed).
- **m4: how to stop.** Use `jobs/stop-session.sh` only (it checks pid, start time, script name and `--run-dir`). Signalling the queue makes it SIGKILL the session after 1 s; only PDEATHSIG then ends the servers, and a FUSE mount may be left.

## Actual limits (no new framework requested)
- **Output retention:** `validator.out` keeps the wrapper's own stdout/stderr, bounded by the child's 64 MiB RLIMIT_FSIZE. The r4 wrapper's report keeps only the **last 8 KiB** of `mdbx_chk` text, so the full mdbx_chk output is not retained. Truncation is flagged and classified INCONCLUSIVE, never CLEAN; for a damaged DB, PROBLEMS diagnosis has the tail only.
- **Fixture vs production scale:**
  - the 7 fixtures use a tiny DB, far below the 64 MiB RLIMIT_FSIZE and with trivial runtime;
  - the production path (a ~1.13 TB mmap through QEMU vmdk → NBD → FUSE, a ~556 MB pagemap, days of runtime, the 7-day default timeout) is **not exercised by these tests**;
  - the 2048 MiB production lane is a placeholder for root. The earlier r9 diagnostic run (1720) recorded mdbx_chk running on the real-size view under the same `limits()` until its 1800 s timeout; that is evidence of the open path only, not of this stage.
- **Unproven until the fixtures run** (author's list, confirmed by reading):
  - `nbdfuse -o ro` gives ST_RDONLY;
  - libmdbx opens the FUSE file without-lck;
  - nbdfuse and qemu-nbd do not rewrite argv (exact cmdline binding);
  - zeroed meta pages give rc 1–3.

  Each failure is a visible test FAIL.
- **Detection, not prevention:** parts stay same-user writable; a change during use gives VOID.
- **CLEAN is structural only:** it is not chain, state, trie, canonical-root, RPC or SNP validation, and not a recovery acceptance.
