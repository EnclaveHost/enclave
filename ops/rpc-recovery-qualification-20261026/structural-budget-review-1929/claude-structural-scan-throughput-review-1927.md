# 1927: structural scan throughput / observability review (SOURCE ONLY; the running scan 1926 is untouched)

**What I did not do:** access any process (no `/proc` reads by me), use the network, build, test, queue, read chain/parts/image data, mount, act on a VM or USB, or commit. **No interruption, restart or mutation of the current run is proposed.**

**What I read:**
- the pinned libmdbx 0.13.x amalgamation and tool used by the validator: `mdbx-recovery-validator-stage/r1/runs/run-20261026T205843Z-2342321/build/{mdbx.c, mdbx_chk.c}`;
- the r4 wrapper `src/mdbx_check.py`;
- previously reviewed composite r6/r10 lifecycle knowledge.

**The observed figures are root's** (as given); I interpret them only as stated below.

## 1. What `mdbx_chk -v` actually does, in order (source)
**The open** (`mdbx_chk.c:3378, 3924`): `MDBX_RDONLY | MDBX_EXCLUSIVE | MDBX_VALIDATION`. There is no `MDBX_NORDAHEAD` and no option changes the scan scope. The wrapper (`mdbx_check.py:105`) passes only `-v` (and optionally `-0/-1/-2`). It does not pass `-d`, `-s`, `-i` or `-w`, so nothing is skipped (keep it so).

**The stages** (`mdbx_env_chk`, `mdbx.c:15561…15549`), sequentially, in ONE read transaction:
1. **meta:** peek at the 3 meta pages.
2. **B-tree traversal** (`MDBX_chk_tree`, `chk_tree` → `walk_pages(txn, chk_pgvisitor, …)`, `mdbx.c:14700-14724`): a full walk of every tree (GC, main, each table, nested dup-trees), visiting **every reachable page** (branch, leaf, large/overflow headers) to account page usage.
3. **GC processing** (`MDBX_chk_gc`, `chk_db(FREE_DBI, chk_handle_gc)`, `:15424-15427`): a cursor pass over the freelist records. This is skipped only if the tree walk found problems.
4. **Page allocation / space accounting** (`MDBX_chk_space`, `:15447`): computed from the counters gathered above.
5. **Main DB key/value pass** (`MDBX_chk_maindb`, `chk_db(MAIN_DBI, chk_handle_kv)`, `:15524-15527`): a cursor over every record of the main table.
6. **All tables** (`MDBX_chk_tables`, `chk_db(MAIN_DBI, nullptr)` → per table `chk_db(…, chk_handle_kv)`, `:15536-15539`, `:15063-15066`): a cursor over **every record of every table**.
7. **conclude.**

**So every reachable leaf/branch page is touched at least twice:** in the step 2 tree walk and again in the step 5/6 cursor passes. GC pages are touched in steps 2 and 3. Whether large-value pages beyond their first page are read in each pass depends on what the visitors dereference. **I did not establish that** (no full trace of `chk_pgvisitor` and `chk_handle_kv`), so "≥ 2 passes over all used bytes" is **not** claimed. "≥ 2 traversals of the tree structure" is.

## 2. Why each read is small and synchronous (source + root's figures)
**libmdbx disables readahead for this DB:**
- `readahead = !(flags & MDBX_NORDAHEAD) && mdbx_is_readahead_reasonable(used_bytes, 0) == MDBX_RESULT_TRUE` (`mdbx.c:20381-20382`).
- `mdbx_is_readahead_reasonable` (`:11157-11178`) returns FALSE when the used volume is ≥ total RAM pages, or ≥ available RAM pages.
- With `mdbx.dat` = 1,138,166,333,440 B, that is FALSE on this host. **Inference:** the used volume is close to the file size; it was not measured.
- `dxb_set_readahead(…, enable=false, …)` (`:20671` → `:20103…20199`) then applies **`madvise(MADV_RANDOM)`** over the used region.

**What that means for the reads:**
- **The page faults are single pages.** Under `MADV_RANDOM`, each mmap page fault reads only the faulting page, with no fault-around or readahead. On the FUSE file each fault is one synchronous FUSE READ.
- **`mdbx_chk` is single-threaded,** so throughput ≈ page size ÷ per-request latency. That matches root's figures:
  - **~7 % CPU, and the validator waits in `request_wait_answer`:** it is blocked on the FUSE round trip, not computing;
  - **nbdfuse wchar ≈ 78.96 GB over ≈ 19.2 M calls ≈ 4.1 KB per call:** about one 4 KiB page plus a header per reply;
  - **memory PSI ≈ 0** (8.47 s total) and io.pressure ≈ 7 %: neither memory reclaim nor the block devices are saturated.

  **The bottleneck is per-request FUSE→NBD→qemu-nbd→part-file latency at 4 KiB granularity.**
- **These are syscall bytes, not unique DB bytes.** The same page can be served several times (two traversals; and evictions — `memory.events high` 391,872 shows sustained reclaim at the 3712 MiB high mark, so pages re-faulted after eviction are counted again). nbdfuse `rchar` (1.54 GB ≈ request headers) is not data progress either.

## 3. Progress without consuming pipe bytes: what exists, and what does not
**Stage lines exist but cannot be seen now.**
- `mdbx_chk` prints a line at each stage begin: "Traversal B-Trees by txn#…", "Processing GC…", "Page allocation:", "Processing @MAIN…", "Processing table(s)…". It calls `fflush(nullptr)` at line ends (`mdbx_chk.c:3411-3420`).
- **But the r4 wrapper keeps them in memory** (`bounded_run`, `mdbx_check.py:118-180`) and writes the report only at the end. **No existing file shows the current stage.** Reading the pipe would consume its bytes and is excluded.

**Rate counters exist, but no percentage.**
- `/proc/<nbdfuse>/io` (as root used) and `/proc/<mdbx_chk>/stat` `majflt` are monotonic: they count FUSE page-ins of the checker, refaults included.
- They give a **rate**, never a **fraction**:
  - **(a)** the denominator (used pages = `geo.next` of the meta) is not recorded anywhere I can cite, and must not be read now: a second opener means extra FUSE reads, and the env is held EXCLUSIVE;
  - **(b)** there are ≥ 2 traversals plus refaults;
  - **(c)** the stage is unknown.
- The libmdbx `pgops` counters live in the lock region. With `MDBX_EXCLUSIVE` that region is private to the process, so it cannot be read from outside.

**Conclusion:** no meaningful progress percentage or ETA can be derived from existing read-only sources for the running scan.

## 4. Is the 8 h cap sufficient? Unknowable, and why
**Unknown inputs:**
- the used-page count;
- how many bytes each pass actually dereferences (large values);
- the refault rate under the 3712 MiB high mark;
- whether the per-request latency stays constant across stages and across the root/`/vm` part files;
- the stage the scan is in now.

**Only a structural observation is safe** (not an ETA): at the observed served-bytes rate, the bytes servable in 8 h are of the same order as the file size, while the checker traverses the tree at least twice. **8 h may therefore well be insufficient.** A timeout is classified by the r6/r10 lifecycle as **INCONCLUSIVE (7)**, never PASS and never a structural failure. Choosing a longer cap is root's decision; nothing here measures that any cap suffices.

## 5. Narrow recommendations (future runs only; none changes the current run or weakens checks)
1. **Observability (recommended; a future wrapper revision, not done here):**
   - have the wrapper append each chunk it reads to its bounded output file (same 1 MiB-class cap, same truncation semantics) as it arrives, instead of only at the end;
   - the stage-begin lines `mdbx_chk` already flushes then become readable from the file without touching the pipe;
   - **no new framework, no option change.**
2. **Record the denominator up front (future, optional):**
   - before a run, record the meta's used-page count (`geo.next`) from the copy's verified metadata or an earlier read-only report;
   - with the stage lines, that gives a coarse "stage N of 7".
   - **Even then it is not an ETA** (two traversals, refaults).
3. **Readahead: no safe existing knob is warranted by source.**
   - libmdbx forces `MADV_RANDOM` for a DB larger than RAM, and the only flag (`MDBX_NORDAHEAD`) disables readahead further.
   - Enabling readahead would need a modified `mdbx_chk`/libmdbx. **Not recommended:** it changes the pinned, qualified binary.
   - The FUSE bdi `read_ahead_kb` and the part devices' `read_ahead_kb` do not apply to `MADV_RANDOM` faults, and help only sequential patterns that are not established here. Do not change them without a measured, separately reviewed test.
4. **Memory lane (evidence is weak; root decision):**
   - the high-event count shows constant reclaim at 3712 MiB, but memory PSI ≈ 0 says reclaim is not the stall source;
   - a larger lane could reduce re-reads of hot branch pages between the two traversals, but **source and figures do not show that it would materially help**;
   - any change is a new reviewed composite revision with the 16 GiB host floor kept.
5. **Lower per-request latency is the only lever the evidence points at** (the FUSE→NBD hop at 4 KiB). Any alternative exposure path (e.g. a kernel block device instead of FUSE) is outside the qualified lifecycle and would need its own full qualification. **This is not recommended now.**

## Not claimed
- No ETA, no percentage, no claim that 8 h suffices or fails.
- No reading of the running process's state beyond root's figures.
- The scan's outcome remains whatever the qualified r10 lifecycle reports (CLEAN 0 / PROBLEMS 2 / INCONCLUSIVE 7 …). **CLEAN is structural only.**
