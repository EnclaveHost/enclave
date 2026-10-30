# Queue capacity review: 6144 MiB candidate (PROPOSAL ONLY; not installed; tests NOT run)

## Candidate

`claude-test-queue.candidate-6144.py`, sha256
`fa0462030ad06c4c283de040cb17cbb2a3d648cc1963f581281b2ceb0b62c4e6`. It is derived from the CURRENT shared
`work/claude-test-queue.py` `969d9273…` (max 4096) with exactly these changes (17 diff lines):

1. **`ROOT` is pinned to `/home/steven/Documents/Codex/2026-10-18/wo/work`** instead of the file's own directory.
   - The lock files (`claude-test-queue.lock`, `claude-test-small-queue.lock`) and the guard
     (`enclave/test/helpers/memory-guard.mjs`, `cdd00af7`, unchanged) are therefore the SHARED ones wherever the copy is
     run from.
   - **A moved copy cannot become a separate queue.**
2. **`MAX_LARGE_MIB = 6144`**. The `--mib` choices keep 4096, 2560 and 1792, and add 6144.
3. **New `--extra-start-mib {0,1024,2048}`** (default 0; large jobs only). It is added to THAT job's own admission
   threshold only. It lowers nothing, and no other job's reservation changes.
4. The START line prints `extraStart`.

**Unchanged:** the floor 16384, headroom 256, whole-cap concurrent accounting, the guard invocation
(`MemoryMax`, `MemorySwapMax=0`, `--max-rss-mib`, `--floor-available-mib 16384`), signal handling and exit propagation.

## Thresholds (MiB available at admission)

| job | candidate | current (969d9273) |
|---|---|---|
| large 6144, small idle | 16384+6144+256 = **22784** | (6144 rejected) |
| large 6144 + extra 2048, small idle | **24832** | n/a |
| large 6144 with a small job holding its lane | **23040**; with extra 2048: **25088** | n/a |
| small joining an occupied large lane | 16384+256+256+6144 = **23040** | 20992 (would UNDER-reserve a 6144 job) |
| any large job yielding to a waiting small job | below 23040 | below 20992 |

**Side effect:** while any large job runs, a small job needs 23040 available. During the M10 build that is effectively
never, so small jobs exit 98 for the duration. All jobs must use the same version: hence install, then wait ≥ 65 s
before launching.

## Tests (`test-queue-6144.py` `50dda2e4…`; PREPARED, NOT RUN)

The tests use isolated clones: a private ROOT, fixture MemAvailable, a 2 s deadline, and an argv-recording `systemd-run`
stub. The real memory guard is exercised only with tiny children.

1. **Static:** the pins, the exact 17-line diff, `ROOT` pinned with no `__file__`, the shared lock names and guard path,
   the floor, and the `start` formula.
2. **Arguments:** 5120 rejected; the current queue rejects 6144 (control); extra with 256 and extra 512 rejected; 4096,
   2560 and 6144 start.
3. **Large 6144 idle:** 22784 starts, child rc 7 propagated, argv `MemoryMax=6144M`, swap 0, guard 6144/16384. 22783
   gives 98 with **no child**.
4. **Extra 2048:** 24832 starts; 24831 gives 98 with no child.
5. **Small lane held:** 23040 and 23039; with extra, 25088 and 25087.
6. **Small joining an occupied lane:** reserves 6144 (23040 and 23039). Control: the current queue reserves 4096.
7. **Mutual exclusion across copies in 3 directories sharing one ROOT:**
   - a second large job gives 98 (lane held, no child);
   - a small job joins with `concurrentLargeReserve=6144`;
   - a second small job gives 98.
8. **SIGTERM:** 143, and the exact child is gone.
9. **The real `memory-guard.mjs`:**
   - a floor above any host gives 99 "< floor";
   - a cap of 1 MiB gives 99 "tree RSS";
   - within limits, the child rc 7 propagates.

## Root commands

**0. Tests, BEFORE install, on the CURRENT queue:**

```sh
Q=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/m10-bootstrap/queue-capacity-review
python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 256 --log $Q/logs/test-6144.guard -- python3 $Q/test-queue-6144.py > $Q/logs/test-6144.out 2>&1; echo $? > $Q/logs/test-6144.rc
```

**1. Install, only after review and when the capacity below is real; atomic, with a backup:**

```sh
W=/home/steven/Documents/Codex/2026-10-18/wo/work
[ "$(sha256sum < $W/claude-test-queue.py | cut -c1-64)" = 969d9273e53c79abf8604c363daa58b41a462bc4b7f3d03d813980edb771f6f4 ]
[ ! -e $W/claude-test-queue.before-6144.py ] && cp -p $W/claude-test-queue.py $W/claude-test-queue.before-6144.py
cp $Q/claude-test-queue.candidate-6144.py $W/claude-test-queue.py.new && mv -f $W/claude-test-queue.py.new $W/claude-test-queue.py
[ "$(sha256sum < $W/claude-test-queue.py | cut -c1-64)" = fa0462030ad06c4c283de040cb17cbb2a3d648cc1963f581281b2ceb0b62c4e6 ]   # then wait >= 65 s
```

**Rollback:** `cp -p $W/claude-test-queue.before-6144.py $W/claude-test-queue.py`, then check `969d9273`.
