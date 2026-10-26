# Base R-A re-anchor recovery r4 (A1 admission ledger under a real lock): PREPARED (source-only; tests NOT run; NOT enabled)

**Stage:** the NEW `base-reanchor-recovery-stage/r4/`. `MANIFEST.sha256` =
`bb70939a1a48abb097bc4b6ad4905fda442e534c2188f08c868c25c530a3b91e`.
- **Not done:** no tests, build, queue, network, SSH, live action or commit.
- **Frozen and verified intact:** r1, r2 and r3 (r3 was never run).
- **capture/r2 is consumed read-only.** Its root run passed 36/36 (`logs/a1-capture-r2-root-receipt.out`, pinned in
  `inputs/`). The live attempt 0249 correctly REFUSED (own Helios call timeout 20 s): **there is no fresh A1 qualification**,
  and none is claimed.
- **HOLD flags stay False:** `LAUNCH_PRODUCER_REVIEWED`, `FINALITY_PROOF_REVIEWED`, `A1_CAPTURE_REVIEWED`.

## The gap root found, and the fix
**The r3 defect.** `admit_captures` read the ledger, applied `C.admit` to an in-memory set, then made ONE unchecked
`O_APPEND` `os.write`, with no lock. Concurrent accepted steps could both read the old state and both admit the same
capture. A short write or a crash could leave an ambiguous ledger. **Checked:** the harness has **no per-workdir lock** at all
(only `journal_guard`), so nothing serialized different workdirs.

**r4** (`r3-to-r4-a2a4.patch`; only `admit_captures` and the new helpers `ledger_line`, `_ledger_paths`, `_ledger_lock` and
`ledger_records` change). Everything happens under ONE exclusive `flock` on the stable sibling `<admissionLedger>.lock`,
keyed by the ledger path, so it covers all workdirs and launches:
1. **The ledger directory** must be real, owned by `TRUSTED_UID`, and not group/other-writable.
2. **The lock file** is opened with `O_NOFOLLOW` (a symlink refuses) and created 0600 if absent; it must be a private regular
   file whose fd matches the path. The wait is bounded; on timeout: `a1_ledger_busy`, nothing admitted.
3. **The whole ledger is read and strictly verified under the lock.** An incomplete (non-newline) tail refuses
   `a1_ledger`: ambiguous, and nothing is admitted until root resolves it. Each record must be canonical JSON with exactly
   `{format, seq, prevSha256, at, keys}`, a contiguous seq, a sha256 chain, and sorted, unique, non-empty, well-formed keys;
   no key may be admitted twice across the file.
4. **`C.admit`** gives the replay rule in memory only. **It is not treated as durable.**
5. **One canonical record is appended:** `O_APPEND|O_NOFOLLOW` (`O_EXCL` on creation), the size checked against the bytes
   read, an **exact full-write loop**, then `fsync` (plus a directory fsync on creation). The whole ledger is then
   re-verified, and the new record must be the last one.
6. **Only then** is the lock released and the step proceeds.

**Preserved:** every other gate, the watermark, lineage, the capture-recheck integration, HOLD, first bootstrap, the
wrapper (r2 bytes), and the baseline suites. The producer changes only `RECOVERY_A2A4_SHA256 = c4089a02…`.

## Tests (NOT run) and exact counts
```
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-reanchor-recovery-stage/r4
python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1024 --log $S/logs/root-reanchor-r4-tests.guard -- unshare -rn bash $S/jobs/root-reanchor-r4-tests.sh
```
The job (`6b6204f2…`) first checks the r4 manifest, the inputs and capture/r2's `SHA256SUMS`; that the marker is unset; and
that no real archive or watermark store exists. `TMPDIR` is on disk.

| suite | exact count |
|---|---|
| baseline-existing | 34 |
| recovery-existing | 34 |
| r3-regression | 27 |
| reanchor-recovery | **19** (r3's 14 unchanged + `Ledger` 5) |

PASS requires each suite to have rc 0, a final line of exactly `OK`, the exact count, and no skip; the aggregate must be rc 0.
Queue exit 98 means the job did not start.

**The 5 `Ledger` tests** use the real capture module's `admit` rule and REAL processes:
1. **Once-only:** the canonical chain; files 0600; a mixed replay is all-or-nothing.
2. **A real race:** six forked processes on the **same capture** from **six different workdirs**, released together from a
   parent-held ledger lock. **Exactly one is admitted**; five are refused `a1_replayed`; the key appears once in the ledger.
3. **A held lock** refuses `a1_ledger_busy`, with the ledger unchanged.
4. **Real SIGKILL interruptions:**
   - mid-write (half the bytes): the incomplete tail refuses all admission, until root's explicit repair;
   - after the fsync: admitted exactly once;
   - after `C.admit` in memory but before the write: nothing is durable, and the capture is admitted once later.

   The lock is never left held.
5. **Tamper and safety refusals,** with nothing written:
   - schema: a duplicate key, a seq gap, a chain break, an extra field, unsorted, empty or bad keys, the format;
   - encoding: non-canonical, non-JSON, a blank line;
   - files: a writable ledger, lock or directory; a symlinked lock or ledger.

## Limits
- **First runs:** none of this has executed. I checked only syntax and test counts (with `ast`). The race test's 0.3 s
  release delay only helps the six children contend for the lock; the exactly-once outcome does not depend on it.
- **Strict failure mode:** a crash mid-write blocks all admission until root repairs the tail. Recovery then needs new
  captures, never a replay.
- **No malicious-root resistance:** root-level deletion of whole records stays undetectable, as for the archive, watermark
  and journals.
- **Unmeasured:** downtime and rebuild cost. There is still **no fresh A1 qualification** and no activation.
