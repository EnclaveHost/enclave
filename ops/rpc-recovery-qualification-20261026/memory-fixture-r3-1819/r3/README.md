# r3: test file handles corrected; runtime unchanged

Root applied review 1817 B1 with context-managed file reads. The runtime and walker are byte-identical to r2. No tests have run. Main-lane admission waits for the native qualification window.

# composite-memory-fixture-stage/r3: bounded SYNTHETIC memory mechanism fixture (PREPARED by Claude 1810/1813; NOT run; NOT PASS)
r2 = r1 (`d888cfef…`, preserved, never run) + review 1811 F1–F4/F6 + root's unowned-refusal fix. Report:
../../logs/claude-composite-memory-fixture-fix-1813.md. Inputs: the 1806 plan, root 1809, review 1811.

## LIMITS (read first)
- **MemoryHigh is a reclaim/throttle threshold, NOT a ceiling.** It can be exceeded.
- **MemoryHigh covers the WHOLE transient queue scope (F3/F5):**
  - the scope holds the queue's node memory-guard, the job bash, the controller, qemu-nbd, nbdfuse and the walker, plus the page cache and page tables charged to them;
  - above 512 MiB, **all** of them can be throttled. That can delay the OUTER guard's own sampling and kill, and slow the servers the walker waits on (priority inversion, possibly TIMEOUT);
  - **a MEASURED result describes whole-scope throttling, not walker-only reclaim.**
- **The memory.max (768) OOM victim is NOT guaranteed** to be the walker.
- **A soft stop is realistic (F5):** the soft stop (tree VmRSS > 640 MiB, or MemAvailable < 16 GiB + 512 MiB) samples every 0.25 s and **races** the outer guard's 250 ms check and other host allocations.
  - The 512 MiB target applies to the scope's charged total, not to the walker alone.
  - Tree VmRSS still differs from that total: it counts shared pages once per process and pages charged to other cgroups, and excludes unmapped cache and page tables.
  - There is no ceiling. **SOFT-STOP (rc 6) is a realistic, honest outcome; MEASURED is not the expected default.**
- **Wrapper KILL (F1):** if the controller is stuck at 900 s, the KILL skips the ordered cleanup. The servers end by PDEATHSIG only, a dead FUSE mount or a D-state process may remain, and the job records CLEANUP-INCOMPLETE. **No absolute bound exists for a D-state process.**
- **Page-table growth is MEASURED, not asserted.** The data is synthetic (a zero-filled sparse 8 GiB raw image), not MDBX. **No production, MDBX, canonical-state or RPC claim follows.**

## Time (F1)
**Nominal:** the controller budget is 660 s. The walker gets 660 s − elapsed − a 150 s cleanup reserve; the controller hard-stops the walk at its limit + 10 s.

**The wrapper** (`jobs/run-fixture.sh`) is `timeout -s TERM -k 120 780`:
- **TERM at 780 s:** the controller's ordered cancel, or ignored if it is already cleaning up;
- **KILL at 900 s:** the owned controller only.

**True job worst case:** about 900 s plus a few seconds of post-steps, except for D-state processes. The queue's guard SIGKILL-sweeps the remaining descendants when the job exits; then the main-lane flock is released.

## Disk (F2)
The scratch run dir is on the pinned root target filesystem (253:0, its UUID, not USB). **Free space must be ≥ the sum of:**
- **remaining:** every root part that is not r3-validated committed (the pinned **1773 runner's `part_state`**: valid record, current identity, nlink 1, confirmed binding or a confirmed fresh PASS), counted in full;
- the 40 GiB manifest floor;
- **the 8 GiB native-build reservation, untouched;**
- **the fixture write bound: 64 MiB image cap + 3 × 4 MiB child logs (RLIMIT_FSIZE lowered from 64 to 4 MiB) + 16 MiB metadata = 92 MiB.**

The image is an 8 GiB sparse file, ≤ 64 MiB allocated before and after, removed only after a complete cleanup (same inode). Nothing touches `/vm`, USB, any part or the original.

## Unchanged from r1 (reuse, no new framework)
- **Reused code:** the qualified r6 runtime's `Session` (`407aa7e9…`): ownership, signal deferral, spawn/bind, and the **ordered cleanup** (walker group, then adopted, then fusermount3 of OUR mount, then nbdfuse, then qemu-nbd, then holders/mounts), together with the r9 helpers it pins.
- **Exact scope binding before MemoryHigh is set on that scope only:** one user-manager `run-*.scope`, `memory.max` 768 MiB, the tree root an ancestor in the same cgroup, and systemd's ControlGroup = our cgroup. Afterwards it verifies own high = 512 MiB, max unchanged, and the parent unchanged; any failure refuses.
- **Setup guards:** the qualified r6 guards (live sessions, stage mounts), our stage mounts, and a passing unit-test receipt for these SUMS.
- **Exposure:** qemu-nbd `--read-only` holds the image O_RDONLY, behind `nbdfuse -r -C 1 -o ro`.
- **The walker** touches one byte of every 4 KiB page (MADV_RANDOM, read-only mapping).

**r2 differences:**
- **F6:** Pss (`smaps_rollup`) is no longer sampled.
- **F4:** `drive()` is the single cancellation/cleanup/outcome/receipt path.
- **Root:** a refusal in a run dir this controller did not claim writes **nothing** there (stdout only).

## Outcomes
| outcome | rc | meaning |
|---|---|---|
| MEASURED | 0 | walker rc 0, all 8 GiB scanned, 0 nonzero pages, at least 1 new `memory.events high`, cleanup complete |
| REFUSED | 3 | |
| CLEANUP-INCOMPLETE | 4 | |
| CANCELLED | 5 | |
| SOFT-STOP | 6 | |
| FAILED / TIMEOUT / INCONCLUSIVE | 7 | |

The job adds controller-killed / wrapper-TERM states, and any mounts or processes left.

## Root commands (shared queue MAIN lane only; only after the KVM jobs release it; never stop the recovery driver)
```
bash jobs/q-exit-status.sh cmf-r3-tests 512 bash composite-memory-fixture-stage/r3/jobs/tests.sh       # expect "## PASS (11)"
bash jobs/q-exit-status.sh cmf-r3-run 768 bash composite-memory-fixture-stage/r3/jobs/run-fixture.sh   # MEASURED or an honest SOFT-STOP
```
