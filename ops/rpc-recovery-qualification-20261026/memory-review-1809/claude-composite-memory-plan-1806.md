# 1806: how to measure and bound production MDBX memory (source-only plan; nothing implemented, run or probed)

**Scope:** reading only.
- **Pinned libmdbx v0.13.12 source** (root's official build copy `mdbx-recovery-validator-stage/r1/runs/run-20261026T205843Z-2342321/build`, listed in the r4 pins): `mdbx_chk.c` sha256 `aadb6273…` and `mdbx.c` `dda528e1…`, both matching `pins/libmdbx-v0.13.12-f619d43d.sha256`.
- **Also read:** r4 `src/mdbx_check.py`; the r6 runtime (= r3/r4 `407aa7e9…`, read in 1784–1789); `work/claude-test-queue.py` (`969d9273…`); `work/enclave/test/helpers/memory-guard.mjs` (`cdd00af7…`).
- **Not done:** tests, builds, mounts, production I/O, edits; no change to the queue, the driver or the original.
- **Disclosure:** I started one broad `find / -xdev -name mdbx_chk.c` to locate the source, then **stopped it** (read-only metadata only) and used the r4 job's recorded `REUSE=` path instead.

## 1. Built-in libmdbx/mdbx_chk options do NOT bound resident memory (source evidence)
**mdbx_chk options:** `getopt` (`mdbx_chk.c` 3754ff) offers only `u U 0 1 2 T V v t q n w c d s i`. There is no memory, geometry or advice option.
- The r4 wrapper passes only `-v` (plus optionally `-0/-1/-2`) (`mdbx_check.py` `argv_for`).
- The env opens `MDBX_RDONLY | MDBX_EXCLUSIVE | MDBX_VALIDATION` (3378).

**Geometry:** read-only cannot change it. The whole DB is mapped (`osal_mmap(… geo_in_bytes.now, geo_in_bytes.upper …)`, `mdbx.c` 20383).

**Read-ahead** (`mdbx.c` 20380–20382, 11157–11180, 20103–20202):
- `mdbx_is_readahead_reasonable()` returns FALSE when the DB is at least the size of RAM, so `dxb_set_readahead(…, false)` applies **`MADV_RANDOM`**.
- That only stops read-ahead amplification. It does not release pages already faulted in.
- `MDBX_NORDAHEAD` cannot be set through mdbx_chk.

**Releasing pages:** libmdbx's only `MADV_DONTNEED`/`MADV_REMOVE` is in the **resize/shrink** path (19932–19954, writable geometry change), never during a read-only traversal. `MADV_DONTDUMP` (20387) affects core dumps only.

**Fixed anonymous memory:** `chk->pagemap = osal_calloc(alloc_pages, sizeof(int16_t))` (14711), i.e. **2 bytes per DB page**. For 1,138,166,333,440 B at a 4 KiB page that is about **556 MB**, filled as the walk proceeds and not reclaimable (swap is 0).

**Conclusion:** the bound must come from the kernel: memcg reclaim of the clean, mapped FUSE page cache.

## 2. What each meter actually counts
**The outer guard** (`memory-guard.mjs` 31–48):
- every **250 ms** it sums `VmRSS` of every descendant of its child (the job bash, then the gate/runtime, qemu-nbd, nbdfuse, the r4 wrapper, mdbx_chk);
- if that sum exceeds `--max-rss-mib` (= the queue `--mib`), it SIGTERMs **all of them at once**, SIGKILLs 2 s later, and exits 99;
- if host `MemAvailable` falls below 16384 MiB, it does the same.

**VmRSS = RssAnon + RssFile + RssShmem:**
- **Mapped file RSS:** mdbx_chk's resident pages of the mmapped `mdbx.dat` count in its RssFile.
- **Duplicated shared RSS:** shared library and file pages count once **per mapping process** (python ×2, qemu-nbd, nbdfuse, bash). VmRSS is not PSS. Expect tens of MB to ~100 MB of double counting; telemetry should log Rss vs Pss.
- **Not in VmRSS:** page tables (`VmPTE`), unmapped page cache (qemu-nbd reading the part files; FUSE cache pages not mapped), and kernel slab.

**cgroup `memory.current`** (the queue scope `MemoryMax=<mib>`, `MemorySwapMax=0`, `claude-test-queue.py` 133–138):
- counts each page **once**, charged to the cgroup of the task that faulted or allocated it;
- includes mapped and unmapped page cache, anon, **page tables** and kernel memory;
- `memory.max` reclaims clean file pages (unmapping mapped ones through rmap), and runs the **cgroup OOM killer** only when unreclaimable memory exceeds it.

**The hidden unreclaimable cost: page tables (kernel behaviour; must be confirmed by telemetry).**
- mdbx_chk walks essentially every used page, and FUSE file mappings use 4 KiB PTEs (no huge pages). So every 2 MiB region gets a PTE page: ≈ **used_bytes / 512 ≈ 2.2 GB of page tables** by the end.
- LRU reclaim clears PTEs but does not free page-table pages before `munmap`.
- These are charged to the memcg (`memory.stat pagetables`) but are **invisible to the guard's VmRSS**.
- **The unreclaimable end-state** for mdbx_chk is therefore ≈ 2.2 GB page tables + 0.56 GB pagemap + about 0.2 GB of other processes ≈ **3.0 GB**.

**Consequences:**
- **The current 2560 MiB lane (r7 gate) cannot complete a full traversal regardless of RSS.** `memory.max` 2560 would cgroup-OOM-kill mdbx_chk at roughly 70–80 % of the walk. Because only mdbx_chk is killed, the r6 runtime would still do its ordered cleanup and report INCONCLUSIVE; days would be wasted.
- **Early in a run** (page tables still small), cgroup reclaim lets mapped file pages fill almost the whole lane. VmRSS sum ≈ memory.current − unmapped − kernel + duplicated RSS can then **exceed the guard limit** (= the same number), giving the uncoordinated guard kill described in 1803 R1.

## 3. Options considered
| option | bounds RSS? | keeps ordered cleanup + queue + 16 GiB floor? | verdict |
|---|---|---|---|
| mdbx_chk/libmdbx flags | no (§1) | – | rejected |
| `fadvise(DONTNEED)`/`process_madvise(MADV_PAGEOUT)` from the runtime | no: DONTNEED skips mapped pages; `process_madvise` needs `CAP_SYS_NICE` | – | rejected |
| watchdog that only cancels | no; it stops the run when it reaches the limit, giving doomed runs | yes | **secondary only** |
| nested child cgroup inside the queue scope | yes | **no:** the cgroup v2 "no internal processes" rule forces moving the queue's own guard and bash into a leaf, in a non-delegated systemd scope | rejected |
| sibling transient scope for the validator (`systemd-run --user --scope -p MemoryHigh/Max` executing in place) | yes | the lifecycle is kept (PID and group preserved), but its memory leaves the queue's lane accounting, so admission must reserve it separately | possible, more moving parts |
| **`MemoryHigh` on our OWN running scope** (`systemctl --user set-property --runtime <our scope> MemoryHigh=…`), in a **larger existing lane** | **yes** (reclaim keeps memory.current ≤ high, so VmRSS ≤ high + duplicated RSS) | **yes:** same cgroup, queue code unchanged, the queue's reservation intact (high < max only lowers our use), r6 lifecycle unchanged | **recommended** |

## 4. Recommended plan (simplest; for a future reviewed r8 of the gate + runtime; NOT implemented)
**1. Lane:** use the queue's existing largest cap **4096 MiB** (`MAX_LARGE_MIB`; the logs show `concurrentLargeReserve=4096MiB`; `--mib 4096` is in the choices). There is no queue change.
- Admission needs MemAvailable ≥ 16384 + 4096 + 256 (+256 if the small lane is held) ≈ 20.7–21.0 GiB; recent logs show about 24 GiB.
- The r8 gate pins `memory.max` = 4096 MiB and that floor.

**2. Bound:** immediately after the gate passes and before the exec, set **`MemoryHigh = 4096 − 384 = 3712 MiB`** on the job's own scope via `systemctl --user set-property --runtime <scope from /proc/self/cgroup> MemoryHigh=3712M`, then re-read `memory.high` and refuse if it is not applied.
- Because `memory.current` ≤ ~high, the guard's VmRSS sum ≤ high + duplicated RSS (≤ ~100 MB) < 4096 with about 280 MB margin. The guard's RSS kill becomes unreachable in normal operation.
- End-state headroom for file cache ≈ 3712 − ~3000 unreclaimable ≈ 0.7 GB. It is enough for a traversal (MADV_RANDOM, single-page faults), with thrashing costing time, not correctness.
- `memory.high` throttles rather than kills. `memory.max` 4096 stays the hard stop. A cgroup OOM kills the largest task (mdbx_chk), and the r6 runtime survives: ordered cleanup, INCONCLUSIVE.

**3. Soft watchdog (secondary; a few lines in the r6 `use()` wait loop, which already polls every 0.5 s):**
- it computes the **guard's own metric** (Σ VmRSS of the job bash and all its descendants) and MemAvailable;
- it requests the session's own ordered cancellation (INCONCLUSIVE, reason `memory soft stop`, cleanup in r9 order) if either:
  - Σ VmRSS > 4096 − 256 MiB; or
  - MemAvailable < 16384 + 512 MiB.

  That is before the 250 ms guard can act. This preserves the 16 GiB floor and the ordered cleanup even if MemoryHigh is not applied or another host process consumes memory.

**4. Telemetry into the receipt** (sampled every ~60 s, appended, bounded), so that **one** production run is informative even if INCONCLUSIVE:
- `memory.current`/`.high`/`.max`;
- `memory.events` (high, max, oom, oom_kill);
- `memory.stat` (`pagetables`, `file_mapped`, `file`, `anon`);
- per-process VmRSS/RssFile/RssAnon/VmPTE and Pss (`smaps_rollup`);
- the Σ VmRSS guard metric and MemAvailable;
- mdbx_chk progress (its `-v` output tail).

## 5. Test strategy (scalable mechanism proof, not many doomed tiny runs)
**A. Mechanism fixture** (512–768 MiB lane, tiny disk use, large virtual size; no MDBX needed):
- **Setup:** an owned qemu-nbd `--read-only` of a **sparse** raw image (e.g. 8–16 GiB), then `nbdfuse -r`, then a python mmap walker touching every 4 KiB page (the same FUSE page-cache path as production).
- **Asserts:**
  - the guard never fires;
  - the peak Σ VmRSS stays below the lane;
  - `memory.events high > 0`;
  - **`memory.stat pagetables` ≈ touched_bytes / 512**, which validates the 2.2 GB production estimate;
  - the run ends with the r6-style ordered cleanup.
- **Scale:** an 8 GiB walk reads zeros (CPU-bound, minutes). It scales the very mechanisms that fail in production (reclaim of mapped FUSE pages, page-table growth, the guard metric), unlike a tiny MDBX fixture.

**B. Watchdog tests:**
- a lowered soft threshold gives ordered CANCELLED/INCONCLUSIVE before the guard;
- MemoryHigh not applied gives a gate refusal.

**C. Keep** r6's 4 + 12 and r7's 6 gate tests unchanged (lifecycle and gate logic).

**D. Production:** one full run in the 4096 lane with the bound plus telemetry. If it ends INCONCLUSIVE, the telemetry says which term (page tables, pagemap, file cache, host) bound it.

## 6. Limits and uncertainties
- **The page-table figure is a kernel-behaviour estimate,** not a measurement. It assumes a 4 KiB DB page and FUSE 4 KiB PTEs, with no page-table reclaim for LRU-reclaimed mappings. Test A measures exactly this before any production run.
  - If it is larger than the 4096 lane allows, a full single-process traversal does not fit any existing queue lane. Then the remaining options are a sibling scope sized outside the lane, or a queue decision; both are root's call.
- **`systemctl --user set-property --runtime`** on the queue's transient scope needs the user bus (`XDG_RUNTIME_DIR`) in the job environment and permission on our own scope. This is unverified here; test A/B proves it or refuses.
- **The guard's 16 GiB floor remains the last resort and stays uncoordinated** (all-at-once TERM, KILL after 2 s). The watchdog's +512 MiB margin is what keeps it unreached.
- **Unmeasured:** production throughput through vmdk → NBD → FUSE, with the parts now on NVMe, not the USB original, so 1720's 66 faults/s does not apply.
- **CLEAN is structural only.** No change to the queue, the copy driver, the original or any frozen stage was made.
