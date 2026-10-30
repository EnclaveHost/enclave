# 1750: independent read-only review of recovery-multipart-stage/r2 (source only; NOT a PASS certificate)

**What I reviewed**

| file | sha256 | note |
|---|---|---|
| `multipart.py` | `45d39419e2c3c17874866ac73c6564b510efdcbb01dbabe3cbb8aa6cb18e71a0` (16:40) | first snapshot, read in full |
| `multipart.py` | **`a88324f65878a9668b918bab1232477c11267160351786488deb13779eb24669`** (16:44) | = the frozen core; diffed against the first snapshot, `status()` changes only (lines 1145–1171) |
| `orchestrate.py` | `fbb78d45…` (16:41) | first snapshot, read in full |
| `orchestrate.py` | **`550b23d32bbaba6cc65586223abc0eb5bb77c17fbf57a51703ad88ffd7aafd02`** (16:42) | = the frozen orchestrate; diffed, the `record_session` run-dir fd is now closed |

- **Frozen stage:** root reports SUMS `f8a75a7e3caa008c74e6d1fb5616bd51330423b45211976fad429fded1ac5674`. **I did not verify that SUMS file**; I verified the two file hashes above.
- **Tests and jobs:** I snapshotted `tests/` and `jobs/` (16:48) but **did not read them**. Skips, `ResourceWarning` gates and `TEST_TMP` use are therefore unaudited.
- **Cross-checked:** the r9 `overlay_session.py` (pin `65d45ab7…`, which matches r9 SUMS `17b5528f…`), for the exec, its environment, the run dir and the receipt fields.
- **Not done:** any run, test, edit, or I/O on the original.

## Prior 1747 defects: status in the code (fixed in source; proof is root's unit and E2E runs)

| 1747 | status | where (core `a88324f6`) |
|---|---|---|
| **P1** sparse checkpoint | **fixed in code** | Before every checkpoint: `if st_size < pos: ftruncate(pos)`, then `fsync`, then the checkpoint (967–969). On resume, the prefix hash reads holes as zeros, which matches `h`; then `ftruncate(committed)` (943). A part ending in a hole is also extended at the end (974). |
| **P2** source binding | **designed; enforcing code present** | **multipart:** production copy and verify are refused unless they come through orchestrate (`fixture_source`). In session mode, `serve` refuses `--source`, requires an exact `RECOVERY_TARGET` and `ST_RDONLY`, and sends the identity plus `mnt_id`. **orchestrate `Provenance`:** the peer's ppid must be our session child; its cmdline must equal the exec argv and its environment must equal r9's exact three variables (r9:429 ✓); its start time is read twice; it is pinned by pidfd; the hello identity and `mntId` must match our own `lstat`; the mountinfo entry must be `fuse*`, `ro`, with source `…/work/view/nbd`. All of this is re-checked at every checkpoint. |
| **P3** stale `status` | **fixed** | Commit and verify records carry `destIdentity` (including `nlink`). `status` compares them with the current `lstat`, so the part goes to `stale`. A record or verify record from another manifest is `invalid`, and either of those blocks `verificationCompleteRecorded`. A PASS needs `measuredAtNs > committedAtNs` and a CONFIRMED session. The output is labelled `freshlyMeasured:false`, i.e. historical evidence. |
| **P4** idle timeout | **fixed** | The pre-pass runs before `open_src` (1012–1015); `serve` uses `settimeout(None)`. Only the copier's per-reply 600 s timeout remains. |
| **P5** links and socket | **fixed** | `nlink==1` is checked in `part_stat`, `check_committed`, `verify` and `status`. `drop_own_partial` removes only the same (dev, ino). `SocketSource` init and accept remove our socket on any `BaseException`. |
| **P6** capacity | **unchanged (not a code defect)** | The `PROD` assignment is still root 0–119, so admission needs about 520 GiB free on `/`, and it will refuse until that space exists. |
| **P7** link→record gap | **fixed** | `commit()` is one `critical()`: link, unlink, record, checkpoint removal. The nesting is correct (an inner `critical` does not re-raise; the outer raises the deferred signal). |

**r9 interplay, confirmed by reading:**
- the exec is a direct `Popen` child of the session, so the ppid check is valid;
- the run dir must be an existing 0700 directory without `work/` (orchestrate creates it this way);
- the receipt keys orchestrate reads all exist: `exec.{cmd,rc,timedOut,groupLeftovers,escapedKilled}`, `children.exec.pid`, `checks.*.ok`, `leftoverProcesses`, `overlayDeleted`, `parentUnchanged`, `cleanupComplete`, `rc`.

**Unproven assumption (E2E must show it):** that the fuse2fs mountinfo source string is exactly `RUN/session/work/view/nbd`, the fstype is `fuse*`, and the per-mount options include `ro`. If any of these differ, every production session refuses. That is fail-closed, but it is not yet observed.

## Findings (P1/P2 only)

### P1. A part resumed from a checkpoint written under an earlier, unconfirmed session is recorded as wholly bound to the new session (source-binding / crash-resume)
**How it happens:**
1. Session A copies part k up to a checkpoint (say 2 GiB).
2. Session A, or the orchestrator, is killed (SIGKILL, OOM, power loss, exec deadline). Session A is never CONFIRMED.
3. Session B resumes: `copy_part` 924–943 checks only that the temp prefix equals the checkpoint's own `prefixSha256`. **The prefix is never re-read from B's source**, and the checkpoint stores **no binding or session** (`write_ckpt` 861–863).
4. `commit(... src.binding ...)` (983) records **only session B**.
5. If B is CONFIRMED, `status` counts part k as committed (`commit_ok`), though the first 2 GiB came from unconfirmed session A.

**Impact:**
- `copyComplete` and the commit record's `source` overstate provenance.
- `verificationCompleteRecorded` is still protected, because a fresh verify in a confirmed session re-reads both sides; but the commit record is wrong history.
- This matches root's 1752 direction ("independent fresh source rebinding preserving old history").

**Fix (narrow):**
- Put the binding (`sessionId` / binding sha) into each checkpoint.
- On resume under a different binding, either re-read and compare the prefix from the new source before continuing (a rebinding that is proven, not assumed), or record **all** contributing bindings (`sources:[…]`) and have `status` count the commit only if every one is confirmed.
- Never rewrite the old checkpoint or record history.

**Test:** stop a part mid-way under session A, end A unconfirmed, resume under B. Expect the commit to be unconfirmed (or the prefix re-proven); `copyComplete` must not count it on B's confirmation alone.

### P2-a. Committed parts from a process-killed or unconfirmed session: the frozen code vs root 1752
**What the frozen core does:** `a88324f6` `status()` (1145–1171) now counts a part whose commit binding is unconfirmed **if** a valid PASS exists from a CONFIRMED session. That PASS needs equal `destIdentity`, `recordSha256`, `measuredAtNs > committedAtNs`, and source == destination == the record hash. `verify_run` itself never checks the commit binding. So **by my reading**, a fresh confirmed verify does redeem such parts.

**Discrepancy:** root 1752 observed that they **stay unconfirmed**. I have not reproduced or read 1752. Possible causes are a test against the earlier core (`45d39419` had `continue` at 1146, which skipped the verify loop), or a path I have not identified. **Root should reconcile using 1752's exact core hash.**

**If 1752 used `a88324f6`, the gap is real. Fix:**
- in `status`, a fresh CONFIRMED PASS must supersede the unconfirmed commit binding;
- report the old binding as history (`commitBinding: "unconfirmed"`), never delete it.

**Also, combined with P1:** the redeeming verify is the **only** independent proof for such parts, so it must be required, not optional.

### P2-b. A session that hits the exec deadline poisons all its work; there is no deadline-aware stop
- **How it happens:** r9 caps `--exec-timeout` at 86,400 s. On a timeout the receipt has `timedOut` and rc 6, so `confirm()` gives UNCONFIRMED. The copier gets EOF and fails mid-part.
  - Throughput through the view is unmeasured; at the observed random rate this can be a few parts per session.
- **Cost of a deadline hit:**
  - in copy mode, every part committed in that session needs a later confirmed verify (P2-a) to count;
  - in verify mode, all of that session's verify work is lost.
- `--max-bytes` and `--parts` only help if the operator guesses the throughput.
- **Fix:** orchestrate passes a monotonic deadline of `exec_timeout − margin` (cover the per-part re-hash and commit; e.g. 1 h) into `copy_run`/`verify_run`. At a checkpoint it raises `Cancelled("deadline")`, then Q, a clean `serve` exit 0, and the session is CONFIRMED. A small `--exec-timeout` E2E test proves it.

### P2-c. Exceptions in orchestrate's finalization escape `main`
**The problem:** in `main`'s `finally` (339–355), exceptions from these calls are uncaught:
- `end_session` raises `subprocess.TimeoutExpired`: `p.wait(timeout=120)` after the KILL loop if the session is stuck in D state on FUSE or USB;
- `confirm` raises Refuse or OSError from `read_small` on the receipt;
- `record_session` raises Fail (`already exists`), OSError (ENOSPC/EIO), or Refuse from `open_dir`.

**What happens when one fires:**
- no JSON output;
- the exit code is Python's 1, not the documented 0/3/4/5;
- `prov.close()` and the status are skipped;
- if it fails mid-loop, some targets get the session record and others do not, and `session-confirmation.json` is missing.

**Consequence for the next run:** the binding exists only in memory, so the session can never be confirmed afterwards (the P2-a/P1 path).

**Fix:**
- wrap each finalization step, mapping any exception to rc 4 plus a reason, and always print the result;
- write the accepted binding to `RUN/binding.json` right after accept (before any part is committed with it), so an idempotent later `confirm --run-dir RUN` can check the receipt and write session records after a killed orchestrator.

**Test:** inject a failure into `record_session` and a stuck session; expect rc 4 and the JSON still printed.

### P2-d. Claim precision: the copier code that runs is not proven to be the bytes bound in the request
- **The claim vs the code:** the orchestrate docstring says "only the copies are executed (no swap between check and exec)". That holds for the `serve` exec and `overlay_session.py` (private copies). But orchestrate **imports** `multipart` from the stage dir at module load (line 31), and only **later** hashes that file (`mp_sha`, line 200) and itself (`orch_sha`, `realpath(__file__)`).
- **What runs:** the copier, the record writer and `status` are therefore the imported bytes, which are not proven equal to `multipartSha256` in the request.
- **Why it matters:** this is not a malicious-actor issue. The author was editing these files during this review: the files changed twice within about 6 minutes.
- **Fix:** either load the copier module from the hashed bytes (`compile` + `exec` of the exact bytes read, as the seqprobe r2 reuse of `mdbx_check` does), or require the stage to be frozen and read-only and verify its SUMS before import. Otherwise narrow the docstring claim.

## Audited with no P1/P2 finding (limits stated)
**Validators:** key sets are exact; hex, `RUN_ID` and `_int` (not bool) are used for sizes and times. Remaining looseness:
- `==` comparisons accept `true`/`1.0` for an int index or offset in records, checkpoints and verify records;
- the session record's keys are not exact.

These are reachable only by hand-written files, not by a crash, because every write is `O_EXCL` tmp + `fsync` + link/replace + directory `fsync`. Not P1/P2.

**Truncation:**
- an oversized JSON is refused (`read_json_in` pre-checks the size);
- a truncated hello, request or header line fails its parse or fullmatch;
- a short data read fails.

**Crash windows (by reading):**
- checkpoint 0 is written before the `O_EXCL` temp;
- a link-without-unlink is handled by `drop_own_partial`;
- a link-without-record goes to the adopt path, which does a full source re-read;
- a record-without-checkpoint-removal leaves a stale checkpoint file that is never used (harmless).

**Floors:**
- admission reserves the full length of every unrecorded part for the whole target (conservative; ignores sparsity);
- every checkpoint re-checks the actual target majmin, plus UUID and non-USB in production, plus MemAvailable;
- verify checks the memory floor at the start and at each checkpoint.

**Resource leaks:** none that matter. The process exits on every path. Minor leaks:
- `copy_part` `tfd` if `hash_fd`/`ftruncate` raises OSError (934–943);
- the `open_src` `log` file object if `Popen` raises (`ResourceWarning` under tests).

**r9 leftover scan:** the cleanup flags **any** process whose cwd, fd or cmdline names `RUN/session/work`. Monitoring commands that name that path will make a session UNCONFIRMED. Root's checks during a run should avoid naming it.

## Remaining limitations of this review
- Tests and jobs were not read, so skips, the `ResourceWarning` gate, `TEST_TMP` policy and fixture coverage of P1/P2 above are unaudited. Root's unit 26 and E2E 6 runs are the evidence, not this review.
- The mountinfo source/fstype/`ro` assumption is unproven until the E2E passes.
- Capacity (1747 P6) still makes production admission refuse on `/` as planned.
- **This is an inspected-source review with findings, NOT a PASS certificate.** The final frozen review should re-read SUMS `f8a75a7e…`, tests and jobs, and 1752.
