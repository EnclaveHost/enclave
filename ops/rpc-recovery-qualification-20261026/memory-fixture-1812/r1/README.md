# composite-memory-fixture-stage/r1: bounded SYNTHETIC memory mechanism fixture (PREPARED by Claude 1810; NOT run; NOT PASS)
Report: ../../logs/claude-composite-memory-fixture-1810.md. Plan: ../../logs/claude-composite-memory-plan-1806.md; root caveats:
source/ops/rpc-recovery-qualification-20261026/memory-review-1809/README.md.

## LIMITS (read first)
- **MemoryHigh is a reclaim/throttle threshold, NOT a ceiling.** It can be exceeded.
- **The memory.max (768) OOM victim is NOT guaranteed** to be the walker; cleanup never assumes the victim.
- **The controller's 0.25 s soft stop races the outer guard's 250 ms tree-VmRSS check** and other host allocations. Its margin (stop at 640 MiB vs. the guard's 768; MemAvailable 16 GiB + 512 MiB) reduces, but does not remove, the risk of the guard's all-at-once TERM, then KILL after 2 s.
- **Page-table growth is MEASURED, not asserted.**
- **The data is synthetic** (a zero-filled sparse 8 GiB raw image), not MDBX. **No production, MDBX, canonical-state or RPC claim follows.**

## What it does (one run, at most about 15 min, the 768 MiB main lane)
1. **Claims the run dir** (O_EXCL `session.pid`).
2. **Pins:**
   - the qualified r6 runtime (`407aa7e9…`), whose Session, signal deferral and ordered cleanup are reused, together with the r9 helpers it pins;
   - the r3 core (`3159890b…`), for the non-USB check and the full remaining root reservation;
   - the production manifest (`f94807f7…`; read only for the reservation arithmetic);
   - `walker.py`, `systemctl`, `python3`, `qemu-nbd`, `nbdfuse`, `fusermount3`.
3. **Binds:**
   - **lane:** exactly one user-manager transient `run-*.scope` with `memory.max` = 768 MiB;
   - **unit and cgroup:** systemd's ControlGroup of the unit = our cgroup;
   - **tree:** the tree root (job bash) is our ancestor, in the same cgroup.
4. **Sets `MemoryHigh=512M` on THAT scope only** (`systemctl --user set-property --runtime`). It verifies own high = 512 MiB, max unchanged, and the **parent cgroup unchanged**. Any failure refuses.
5. **Scratch** is on the pinned root target filesystem (253:0, its UUID, not USB). Free space must be ≥ every uncommitted root part + 40 GiB floor + 8 GiB root reservation + 64 + 16 MiB. MemAvailable must be ≥ 16 GiB + 768 + 256 MiB.
6. **Exposure:** an 8 GiB **sparse** image (≤ 64 MiB allocated, checked before and after). qemu-nbd runs `--read-only`, holding the image O_RDONLY (checked through fdinfo), behind `nbdfuse -r -C 1 -o ro`. Both are our bound foreground children (the r6 pattern): ST_RDONLY, exact size, O_WRONLY refused.
7. **The walker** (a private pinned copy) mmaps the file read-only with MADV_RANDOM and touches ONE byte of EVERY 4 KiB page; it never reads the file into RAM.
   - **Every 0.25 s:** peaks.
   - **Every 2 s:** a bounded sample (≤ 460) of cgroup current/high/max/events/stat (pagetables, file_mapped, …), the walker's VmRSS/RssFile/RssAnon/VmPTE/Pss, the guard metric (tree VmRSS), and MemAvailable.
8. **r6 ordered cleanup:** the walker group and adopted orphans, then the unmount of OUR mount, then nbdfuse, then qemu-nbd, then holders and mounts. The image is removed only after a complete cleanup (same inode); otherwise everything is kept.

**Outcomes:**

| outcome | rc | meaning |
|---|---|---|
| MEASURED | 0 | walker rc 0, all 8 GiB scanned, 0 nonzero pages, at least 1 `memory.events high`, cleanup complete |
| REFUSED | 3 | |
| CLEANUP-INCOMPLETE | 4 | |
| CANCELLED | 5 | |
| SOFT-STOP | 6 | |
| FAILED / TIMEOUT / INCONCLUSIVE | 7 | |

## Root commands (shared queue MAIN lane only; never stop the recovery driver)
```
bash jobs/q-exit-status.sh cmf-r1-tests 512 bash composite-memory-fixture-stage/r1/jobs/tests.sh       # expect "## PASS (7)"
bash jobs/q-exit-status.sh cmf-r1-run 768 bash composite-memory-fixture-stage/r1/jobs/run-fixture.sh   # expect "## PASS (fixture MEASURED)"
```
**The run job also requires:**
- the latest passing cmf-r1-tests receipt for these SUMS;
- the qualified r6 guards: no live orchestrate/overlay/composite session, and no recovery/overlay/composite stage mount;
- no memory-fixture mount;
- peers identical before and after, and no mount left.

`timeout -s TERM 1200` is a TERM-only backstop to the controller's own 900 s budget.
