# 1747: independent read-only review of recovery-multipart-stage/r1/multipart.py. Prioritized defects (no invented pass)

**Snapshot: the author was STILL CHANGING files during this review.**
- **What I read:** `multipart.py` sha256 `7eb10126…` (16:25:33, 1062 lines).
- **During the read:** at 16:26:21 the file became **`c5604922…`** (52,910 B, −4 bytes), and `tests/test_multipart.py` (23,570 B) appeared at 16:27:37. `jobs/` is empty; no README.
- **Re-checked against `c5604922…`:** every finding below was re-checked by line grep and **still applies** (cited line numbers are from the current file). Re-review the final frozen hash.
- **Not done by me:** runs, tests, edits, or reads of the original.

## Bottom line
**Do NOT use this pipeline's `copyComplete`/`verificationComplete` as a basis for any RAID reset yet.**
- **Correctness bug:** **P1** (a sparse checkpoint makes resume refuse).
- **Binding gap:** **P2** (the socket source is not bound to the reviewed r9 view; same uid only).
- **Stale-verification gap:** **P3** (status trusts old verify records).
- **Orchestration:** **no tested orchestration** with an r9 session exists.

## P1 (CONFIRMED by source; root's suspicion is right): a checkpoint after a map hole makes resume refuse a valid checkpoint
- **Where:** `copy_part`, holes are skipped (`continue`, line 804) and the file is only extended at the end (`os.ftruncate(tfd, p["length"])`, line 815). A checkpoint written right after a hole records `committedBytes = pos` while the temp's `st_size` is still the end of the last **data** write.
- **What happens on resume:** `st.st_size < committed` → fail "shorter than its checkpoint" (line 781). Even without that check, `hash_fd(tfd, committed)` stops at EOF, so `got != committed` gives a prefix mismatch. The result is a valid, resumable state refused (rc 4; files kept, so safe but stuck).
- **The current fixture hits it** (tests not run):
  - parts of 64 KiB, checkpoints every 16 KiB, a map hole at bytes 40960–49152 of part 0, so the checkpoint at **49152** lands right after it;
  - `test_resume_after_budget_stop_inside_a_part` stops at 24576 (data), so **it misses the case**;
  - the SIGTERM test may or may not hit it.
- **Fix (one line):** before each checkpoint's `fsync`, extend the temp sparsely to `pos`: `if os.fstat(tfd).st_size < pos: os.ftruncate(tfd, pos)`. Then `st_size == committedBytes`, and the prefix hash reads zeros for holes, matching `h`, which hashed the zero source bytes. A resume `ftruncate(tfd, committed)` keeps working.
- **Test:** `--max-bytes 49152` (a stop exactly after the hole), then resume, then require rc 0, an identical reassembly, `st_size == committedBytes` in the checkpoint state, and a sparse hole (`SEEK_HOLE` at 40960 where the filesystem supports it).
  - Also stop at 40960 (the hole start) and at a part ending in a hole.

## P2 (BLOCKER for production): the socket source is not bound to the exact reviewed view
**What the copier accepts:** `SocketSource` (lines 579–611) accepts **any** peer with the same uid that sends `proto` + `size`.
- **The hello's `st` [dev, ino, size, mtime] is ignored.**
- **`serve` accepts `--source` as a fallback** for `RECOVERY_TARGET` (line 985).
- **`serve` never checks** that the target is on an `ST_RDONLY` mount.

**What could be served:** any same-size file could be copied and "verified". For example:
- another or older overlay session;
- a stale mount;
- a hand-made file;
- a session built from a **different plan or parent**.

`check_original` binds only the original qcow2's stat, not the bytes served.

**Required fixes (production; fixture mode may keep FileSource):**
1. **`serve`:** in production, **refuse `--source`**; use only `RECOVERY_TARGET`. Require `statvfs(target).f_flag & ST_RDONLY` and `basename == "mdbx.dat"`, and send the full identity (st_dev, st_ino, size, mtime_ns, ctime_ns) plus the mount ID (`/proc/self/fdinfo` `mnt_id`) in the hello.
2. **Copier, provenance from the PEER PID** (SO_PEERCRED pid, captured at accept). The peer is alive while the connection is open, so its pid cannot be reused; re-check at close.
   - its `/proc/<pid>/cmdline` must be exactly `python3 -I -B …/multipart.py serve --socket-dir <dir> --expect-size <L>` (no `--source`);
   - its `environ` `RECOVERY_TARGET` must equal `<RUN>/work/mnt/data/db/mdbx.dat`;
   - its **parent chain** must reach the r9 `overlay_session.py`, whose cmdline must carry `--plan-sha256 c4e38213…`, `--parent <pinned original>`, `--require-ro-mount` and `--run-dir <RUN>`, with RUN under the reviewed r9 `runs/`.
3. **Copier, an independent identity check:** `lstat(<RUN>/work/mnt/data/db/mdbx.dat)` (the copier is the same uid, so the FUSE mount is visible) must equal the hello identity. `/proc/self/mountinfo` must show that mount as `fuse.*` sourced from `<RUN>/work/view/nbd`. Re-check the identity at every checkpoint (the existing `check_original` hook).
4. **Recording:** write the bound session (RUN, the session pid's start time, `planSha256`, the request/authorization sha) **into every part record and verify record**. Verify must require the same binding class, i.e. pinned plan and parent, possibly a different session.

## P3: `status` can report stale verification
- **The problem:** `status` (lines 941–970) counts a part as verified if **any** verify record's hashes equal the commit record's. It never re-checks the part file after verification. A later replaced or modified part file of the same size (same name) still shows verified, and `copyComplete` likewise uses only the record plus size.
- **Fix:**
  - put the part file's identity (st_dev, st_ino, size, mtime_ns, ctime_ns, nlink) in the **commit** record and in each **verify** record;
  - `status` counts committed or verified only if the current `lstat` equals them **and** nlink == 1; otherwise it reports `stale`;
  - a RAID-reset gate must additionally require a **fresh** verify run, i.e. a run ID newer than the last copy event and within a stated window.
- **Also:** a FAIL record makes `verificationComplete` false forever (conservative, good). Document how a superseding PASS is recognised: by identity plus a newer run, never by deleting the evidence.

## P4: idle socket timeout during long resume re-hashing (fails at scale)
- **The problem:** `serve` uses `settimeout(600)` (line 994), and the copier sets `settimeout(600)` (line 600). On resume, `copy_part` first **fully re-hashes every committed part** (`check_committed`, 4 GiB each, up to 120 parts) **before** its first `src.read`. With many committed parts, the server idles for more than 600 s and dies, so the copy fails.
- **Fix:** do the committed-part re-hash pre-pass **before** `open_source`, or exempt idle waiting with a keepalive. The session's own exec deadline still bounds `serve`.
- **Test:** a fixture with a small socket timeout plus pre-committed parts.

## P5: crash windows, hardlinks and evidence
- **Crash between `os.link` and `unlink(.partial)`:** both names stay, i.e. a **2-link part file**. Resume "adopts" it (a full 4 GiB source re-read) but leaves the stray `.partial` hardlink, and nothing checks nlink.
  - **Fix:** in the adopt and present paths, if `.partial` exists, require the same (dev, ino) as the part, then unlink it; otherwise fail and keep both.
  - Require `st_nlink == 1` for every part file in `check_committed`, `verify` and `status`.
- **Cancellation inside `SocketSource.__init__`** (a signal during `accept`): the object is never constructed, so `close()` is never called and `mp.sock` remains. The next run refuses ("already has mp.sock"). This is safe, but document the manual step, or unlink in an `__init__` `except BaseException`.
- **Good:** no path deletes part data or records. Checkpoints are removed only after a commit, and `.partial` only after a successful link.

## P6: floors and capacity (correct shape; plan currently infeasible)
- **Correct:** admission reserves the **full remaining length** of unrecorded parts per target (conservative; it ignores sparsity) against the 40 GiB floor. Re-checks happen at every checkpoint (256 MiB), with MemAvailable ≥ 16 GiB.
- **Soft spot:** other writers (peer copies) can still consume up to about 256 MiB plus their own rate between checks. Acceptable; document it.
- **Arithmetic** (1723 numbers, unmeasured now):
  - **root** holds parts 0–119 = **480 GiB**, needing **520 GiB** free with the floor. Root has ≈ 47 GiB, +≈ 305 GiB if the three duplicates are deleted (1745), which is **still short by ≈ 168 GiB**.
  - **`/vm`** holds parts 120–264 ≈ **580 GiB** (+40 GiB floor) against ≈ 59 GiB free.
  - **Admission will (correctly) refuse.** This is not a defect, but the plan needs more space (`.pixel10` and others) before it is runnable.

## P7: signals
- **Good:** `critical()` defers signals during state writes and link/unlink. `Cancelled` is a `BaseException` handled in `main` (rc 5). `finally` closes the source, sending `Q`, and the targets.
- **Gap:** cancellation **between** the link `critical()` block and `commit_record` leaves a linked part without a record. Resume then adopts it via a full source re-read (safe, but costs 4 GiB from the HDD). Wrap the link, the unlink and `commit_record` in **one** `critical()` section.

## Missing integration and provenance gates (none exist yet)
1. **No job launches `serve` inside an r9 session.**
   - **r9's diagnostic job** runs only `diag/run_validator.py`.
   - **The GO path** is for acceptance, and is closed.
   - **What is needed:** a new, reviewed authorization purpose (e.g. `preservation-copy`, `recoveryAccepted: false`), bound like 1707's request (plan, journal, history, **multipart.py sha**), plus a job that **starts the copier first** (listening; queue lane; 16 GiB floor) and then the session with `--exec … multipart.py serve`.
2. **The session's exec deadline is 24 h** (86,400 s). A 1.14 TB read may need several sessions, so resume must re-bind **each new session** (P2). Each session is a new fuse2fs mount and inode, so the hello identity changes by design: bind by plan and parent, not by inode across sessions.
3. **A real end-to-end fixture:** the r9 overlay fixture (`make_mdbx_fixture`), then `serve` under the real `overlay_session` (`RLIMIT_FSIZE`, `PDEATHSIG`, subreaper), then the copier into two tmpfs or loop targets, then verify. Plus negatives: wrong session plan, `--source` given, a non-`ST_RDONLY` target, a mismatched hello identity, a peer killed mid-copy, and SIGTERM to the session versus to the copier.
4. **Verify re-reads the whole 1.14 TB source a second time** through the HDD view (the measured random rate does not apply to sequential reads, but sequential is still unmeasured). Plan time accordingly; there is no ETA claim.

## Policy notes
- **`TEST_TMP`:** the test docstring says fixtures live "under TEST_TMP". The standing harness rule forbids repurposing `TEST_TMP`/`TMPDIR`/`HOME`/`CODEX_HOME`. Use a stage-specific variable (as the overlay stages do).
- **Production constants** (good): pinned targets (root `253:0` / vm `253:1` UUIDs), USB refusal via sysfs `slaves`, and source and targets on different filesystems.

## Targeted tests to add (beyond the author's 18)
| test | covers |
|---|---|
| sparse checkpoint resume (stops at 40960, 49152, and a hole-ending part) | P1 |
| the hello identity, cmdline, environ and parent-chain mismatch matrix; `--source` refused in production; a non-`ST_RDONLY` target refused by `serve` | P2 |
| a part replaced or modified (same size) after a PASS gives `stale`, not verified; an extra hardlink gives refusal | P3, P5 |
| a long re-hash pre-pass with a short socket timeout still completes | P4 |
| a crash after link before unlink(`.partial`) is adopted and the stray removed only on an identical inode | P5 |
| a signal between link and record | P7 |
| r9 session end-to-end and its negatives | integration |
