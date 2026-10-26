# a1-capture-binding-stage/r3 (PREPARED; source only; NOT run; NOT enabled)

`README.md` and `R2-CHANGES.md` here are r1's and r2's texts, copied unchanged. Where they differ, this file supersedes them.

**Frozen and untouched:**
- r2 (`SHA256SUMS` `100eb666…`) and r1;
- root's live outputs `outputs/rpc-production-final-20261025/a1-capture-live-0252` (only read: sizes and safe summaries);
- the accepted-runtime pins (node `7af789e5…`, python `375532f8…`, libpython `0a5be42f…`);
- the record format `enclave-a1-capture/v2`, so r3 can verify the real r2 capture in place.

## Root's live retry (`a1-capture-live-0252/root-result.json`)

- **What happened:** `captureOk: true`, and A1 exited 0. Then verification refused: `capture.json exceeds 1048576 bytes`.
- **Not achieved:** fresh A1 qualification was **NOT** achieved.
- **Out of scope:** no recheck or consumer step ran on that capture.

## Cause (traced in the real capture)

- `capture.json` is **4,125,348 bytes**: it binds **11,880 files**, of which **11,866 are dependency files** (the pinned
  `@noble/hashes` + `viem` closure). Each entry (sha256, size, role, source path) takes 167–442 bytes of JSON.
- r2's capture wrote the record **unbounded**, while r2's verifier read it with the generic 1 MiB input cap. The two sides
  were inconsistent.
- Other reads used either that generic cap or the 512 MiB `CAP_BIN`.

## Fix: explicit limits, identical at capture and verify; nothing unlimited

| Limit | Value | Observed |
|---|---|---|
| `MAX_FILES` | 16,384 | 11,880 |
| `MAX_REL` / `MAX_SOURCE` / `MAX_ENTRY` | 192 / 384 / 768 chars or bytes | 113 / 188 / 442 |
| `CAP_CAPTURE` | 65,536 + MAX_FILES × MAX_ENTRY = 12,648,448 B | 4,125,348 |
| `CAP_RESULT` | 256 KiB | 1,589 |
| `CAP_EVIDENCE` (evidence, initial receipt) | 1 MiB | 3,950 / recheck 3,765 |
| `CAP_LOG` (a1.stderr, helios.out) | 16 MiB | 0 / 1,161 |
| `CAP_DEP_FILE` | 4 MiB | 881,554 |
| `CAP_LOCK` | 2 MiB | 99,531 |
| `CAP_NODE` | 128 MiB, also enforced in the fd-hashing exec | 56,530,480 |
| `CAP_RUNTIME` (python executable, libpython) | 64 MiB | 14,424 / 6,344,456 |
| every other bound role (`CAP_FILE`) | 1 MiB | all ≤ 10,238 |

**What the limits do:**
- **One table check:** `check_files()` (count, role, per-role size, path, source and entry length) runs **at capture, before
  anything executes**, and **at verify**. Capture also refuses a `capture.json` above `CAP_CAPTURE`.
- **Oversized output never verifies:** if child output exceeds its cap, the capture is published with the error. An oversized
  `result.json` is reduced, with an error.
- **Bounded reads:** every read stops at its bound plus one byte.
- **Not changed:** the pins, runtime policy, file, process, receipt, authentication, freshness and `recheck-capture`
  consumer-binding gates are unchanged.

## Tests: exactly 45 (r2's 36 unchanged + 9 in `Limits`)

1. Every limit covers the observed real values and stays narrow (each primary cap < 8× observed).
2. The exact read boundary at `CAP_CAPTURE` and one byte above.
3. A **generated** production-size table (11,880 entries with the observed lengths; more than 1 MiB of JSON, nothing
   committed) passes. Too many files, a path too long, a source too long, an unknown role, or an oversized dep or module all
   refuse.
4. **End to end at production scale:** a generated 12,000-file dependency package captures and verifies. Its `capture.json`
   is above 1 MiB, which r2 would have refused.
5. Oversized child evidence never verifies.
6. Verify refuses an oversized `capture.json`.
7. Verify refuses a re-bound record whose table breaks the limits.
8. Capture refuses a table that verify could not read, before anything executes.
9. **The real live record**, read only: 4,125,348 B and 11,880 files. It fits r3's limits, and r2's generic cap refuses it.

## Root command

```
ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/a1-capture-binding-stage/r3
python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1024 --log $ST/logs/root-capture-tests.guard -- unshare -rn bash $ST/jobs/root-capture-tests.sh > $ST/logs/root-capture-tests.out 2>&1; echo $? > $ST/logs/root-capture-tests.rc
```

A pass requires exactly `Ran 45 tests` + `OK`, no skips, rc 0, and `## capture rc=0`. The runner passes `A1_LIVE_CAPTURE`
(the real initial capture, read only).

**After a pass,** root can re-run `verify` of the existing live capture with r3, in place, without a new capture. That is a
separate root step, and it is not claimed here.
