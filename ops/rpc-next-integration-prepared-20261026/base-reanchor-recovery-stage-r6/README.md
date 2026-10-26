# base-reanchor-recovery-stage/r4: the A1 admission ledger under a real lock (PREPARED; NOT run; NOT enabled)

r1, r2 and r3 are frozen; r3 was never run. capture/r2 is consumed read-only: root's run passed 36/36
(`logs/a1-capture-r2-root-receipt.out`, pinned). The live attempt 0249 correctly REFUSED (own Helios call timeout 20 s), so
**there is no fresh A1 qualification**. Nothing here captures, qualifies or activates. HOLD flags stay False:
`LAUNCH_PRODUCER_REVIEWED`, `FINALITY_PROOF_REVIEWED`, `A1_CAPTURE_REVIEWED`.

## Root's r3 finding and the r4 fix (`r3-to-r4-a2a4.patch`; only `admit_captures` and its helpers change)
**The r3 defect.** r3 read the ledger, applied `C.admit` to an in-memory set, then appended with ONE unchecked `os.write`,
with no lock. Two accepted steps could both read the old state and both admit the same capture, and a short write or crash
could leave an ambiguous ledger. There is also **no per-workdir lock** in the harness to hide this: different workdirs
never excluded each other.

**r4, all steps under ONE exclusive `flock`** on the stable sibling `<admissionLedger>.lock`. The lock is keyed by the ledger
path, so it serializes every workdir and launch using that ledger.
1. **The ledger directory** must be real, owned by `TRUSTED_UID` (root in production), and not group/other-writable.
2. **The lock file** is opened with `O_NOFOLLOW` (a symlink refuses), created 0600 if absent, and must be a private regular
   file whose fd matches the path. It is acquired with a bounded wait; if it times out: `a1_ledger_busy`, nothing admitted.
3. **The whole ledger is read and verified under the lock.** Every line must be newline-terminated, so an incomplete tail
   from an interrupted append refuses `a1_ledger`: ambiguous, and nothing is admitted until root resolves it. Each record
   must be canonical JSON with exactly `{format, seq, prevSha256, at, keys}`, a contiguous `seq`, a sha256 chain over the
   previous line, and sorted, unique, non-empty, well-formed keys; no key may be admitted twice anywhere in the file.
4. **`C.admit`** applies the replay rule in memory only. It is **not** durable by itself.
5. **One canonical record is appended:** opened `O_APPEND|O_NOFOLLOW` (`O_EXCL` on creation), size checked against the
   bytes just read, an **exact full-write loop** (a write of 0 refuses), then `fsync` (plus a directory fsync on creation).
   The whole ledger is then **re-verified**: the new record must be the last one.
6. **Only then is the lock released and the step proceeds.**

**Crash semantics:**
- a crash before the write leaves nothing, and the capture can still be admitted once later;
- a crash after the fsync leaves the admission durable, and it is never repeated;
- a crash mid-write leaves an incomplete tail, which refuses all admission until root repairs it.

No malicious-root resistance is claimed: root-level truncation of whole records stays undetectable, as for the other
journals.

**Unchanged:** every other gate, the watermark, lineage, the capture integration, HOLD, first bootstrap, the wrapper
(r2 bytes), and the baseline suites.

## Tests (NOT run): `jobs/root-reanchor-r4-tests.sh`, exact counts 34 + 34 + 27 + 19, no skips (queue 1024 MiB, TMPDIR on disk)
**r3's 14 are unchanged** (3 real-capture, 9 carried, bounds and pin), plus **`Ledger` (5)**:
1. **Once-only:** canonical lines and chain; 0600 files; all-or-nothing on a mixed replay.
2. **Six REAL processes race on the SAME capture from six DIFFERENT workdirs.** They start while the parent holds the ledger
   lock. Exactly one is admitted and five are refused `a1_replayed`; the key appears exactly once.
3. **A held lock** refuses `a1_ledger_busy`, with the ledger unchanged.
4. **REAL SIGKILL interruptions in child processes:**
   - mid-write: the incomplete tail refuses all admission;
   - after the fsync: admitted exactly once;
   - before the write, after the in-memory admit: nothing is durable, so the capture is admitted once later.

   The lock is never left held.
5. **Tamper and safety:** a duplicate key across records, a seq gap, a chain break, an extra field, unsorted, empty or bad
   keys, the format, a non-canonical line, non-JSON, a blank line; a writable ledger, a writable lock, a writable directory,
   a symlinked lock, a symlinked ledger. All refuse without writing.
