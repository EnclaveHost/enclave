# 1734: faster validation of the restored Base MDBX without a full copy? Read-only source and receipt analysis

**What I ran:** nothing. Read-only reading of files, plus `free`/`nproc`.
- **No benchmarks, scans, services, code or tests.**
- **No promise** that full validation can be faster: every number below is either **observed** (cited) or an **estimate** (marked).

## What the probe actually shows (primary evidence)
**`recovery-overlay-stage/r9/runs/diag-20261026T214243Z-2386107/`:**
- **`mdbx-report.json`:** `rc −9`, `timedOut true` after 1800.1 s, `unchangedIdentity true`.
- **`receipt.json`:** session rc 6, `cleanupComplete`, `parentUnchanged`, overlay 3,997,696 B.

**The `mdbx_chk` output tail** (pinned v0.13.12 `f619d43d`):
- `within without-lck mode … lck-error 30`, i.e. EROFS: the read-only path works as designed.
- `open-MADV_DONTNEED 276959557..277872640` and **`readahead OFF 0..276959557`**.
- `Peek the meta-pages... transactions: recent 51691982, latter reader 51691982, lag 0`: **the meta pages were read and are consistent.**
- `Traversal B-Trees by txn#51691982...`: killed during the first traversal; no table finished.

**`logs/recovery-probe-sample-1720.jsonl`** (998.5 s between the first and last samples):
- **`mdbx_chk`** (pid 2386563): **65,961 major faults ≈ 66 page faults/s ≈ 15 ms per 4 KiB page**.
- **The two FUSE daemons** read **345.9 MB** (221,012 reads) and **220.5 MB** (105,910 reads), against about 270 MB faulted. **Read amplification is low:** the time goes to **per-request latency at queue depth 1**, not bandwidth.

**Why readahead is off** (`mdbx-recovery-validator-stage/r1/runs/run-20261026T205843Z-2342321/build/`):
- **The decision at open:** `mdbx.c:20381-20382` sets `readahead = !(flags & MDBX_NORDAHEAD) && mdbx_is_readahead_reasonable(used_bytes, 0)`.
- **The heuristic** (`mdbx.c:11157-11179`) returns FALSE when the used volume is at least total RAM pages (or at least available RAM).
- **Applied with:** `mdbx.c:20183-20184` → `madvise(…, MADV_RANDOM)`.
- **`mdbx_chk.c:3378`** opens with `MDBX_RDONLY | MDBX_EXCLUSIVE | MDBX_VALIDATION`.
- **`mdbx.h` (`MDBX_NORDAHEAD` doc)** gives only a way to force readahead **off**, never on.
- **This host:** `free -g` shows 124 GiB total and **23 GiB available**. The DB (1.13 TB) is ≫ RAM, so readahead is off **by design**.

## HDD/latency limit vs FUSE overhead (inference from the evidence above; unmeasured)
- **The traversal walks the tree:** `mdbx_chk` page-walks B-trees in tree order. With `MADV_RANDOM`, each new page is **one synchronous 4 KiB fault (queue depth 1)** through fuse2fs → nbdfuse → qemu-nbd → qcow2 on ntfs-3g (fuseblk) → USB → HW RAID5 HDD.
- **15 ms per page is in the range of one HDD random access** (seek plus rotational delay for one 7200 rpm disk is roughly 10–13 ms; the model is not recorded here). The three FUSE hops plus qemu are plausibly 0.1–2 ms combined.
- **Inference (not measured):** the floor is **inherent random HDD latency at QD1**. Removing the FUSE layers alone cannot change the order of magnitude.
- **At the observed rate:** 276,959,557 used pages ÷ 66/s ≈ **4.2 × 10⁶ s ≈ 48 days**. Even a 5–10× gain (concurrency, or removing every userspace hop) would still be about 5–10 days.

## Structural vs state proof (what each result would mean)
- **A full `mdbx_chk` clean result is STRUCTURE only:** pages, B-trees and GC. MDBX has no page checksums, so value bytes are unchecked. Per the r4 README a sample can find problems but never clear them.
- **The history is still BLOCKED** (1698/1701): intra-17170 reuse is unexcluded, so even a structurally clean DB could carry overwritten values.
- **A STATE proof is separate and also needs reads:** the tip header and state root checked against our own L1 anchor; the trie or hashed-state tables re-verified (or the state root recomputed); headers and bodies hash-linked. That is the same random-I/O problem on this medium.
- **Already established:** the meta pages are readable at txn 51691982 with lag 0. That is a small positive structural signal, **not** validation.

## Ranked options
| rank | option | evidence and expected effect | memory / storage | user / sudo dependency |
|---|---|---|---|---|
| **1** | **Free space, sequential copy to the T710 NVMe, then the official `mdbx_chk` and state checks there** | The only path whose random-read cost moves off the HDD. A sequential pass is **bandwidth-bound**; the USB RAID5 sequential rate through this chain is **unmeasured** (an estimate of tens to hundreds of MB/s gives hours, not weeks). On NVMe, QD1 4 KiB reads are well under 1 ms (estimate), so a full `mdbx_chk` becomes hours (**unmeasured**). | Needs **≥ 1,160 GB free on `/vm`** (1723). Today ≈ 59 GiB. With **`.pixel10` (998 GiB ≈ 1,072 GB) plus the cold reclaim (327.9 GB)** that is about 1,463 GB, which fits. `.pixel10` alone is about 1,135 GB, which does **not** fit with margin. Anon RAM is small; the copy uses only the page cache. | **The user's SDK (`.pixel10`) decision (pending), plus the local-sudo r10 writer-check for the cold reclaim** (1595/r4). No new authority is invented. |
| 2 | **Bounded measurements first** (root, read-only, short, under the queue) | They decide everything else: (a) the **sequential** read rate of one large mapped extent through the existing view or nbd; (b) **QD1 vs QD8** random 4 KiB latency directly on the base qcow2 (e.g. `qemu-io -r` aio reads), to separate HDD from FUSE; (c) **if** a compressed copy is considered, a sampled compression ratio. | MBs to a few GB read; nothing written except a small log. | **None** beyond root's existing read-only authorization (USB **reads** are allowed; writes stay paused). |
| 3 | **Sequential direct extraction from the qcow2 by the proven map** (9001 extents, root 1658/1706; libnbd as in 1705), written to the NVMe at logical offsets | It skips fuse2fs and ext4: each extent becomes one large sequential read in physical order. **A copy method, so the space requirement is the same as option 1.** | Same as 1; anon RAM about 100 MB. | Same as 1. It also needs a **small new reviewed tool** (not built). |
| 4 | **Compressed copy** (zstd qcow2 on `/vm`, random-accessible by qemu-nbd) | **Unknown ratio, not assumed.** It needs about **19×** to fit in 59 GiB today, or about **2.9×** to fit in the ≈ 392 GB available after the cold reclaim. Hash-heavy data likely compresses poorly (speculation), so it is decided only by measurement 2c. | Depends on the ratio; decompression costs CPU per 64 KiB cluster. | Cold reclaim (local sudo) if more than 59 GiB is needed. |
| 5 | **Kernel read-only path** (`qemu-nbd --connect /dev/nbdX` + `mount -o ro,noload` of the overlay) | It removes 2 of the 3 FUSE hops (ntfs-3g remains: the peer's mount). It **does not change** QD1 HDD latency, so the gain is likely small (unmeasured). The kernel ext4 driver would also mount a deliberately inconsistent overlay read-only. | Same 64 MiB overlay. | **sudo** (nbd module, connect, mount). The peer's ntfs-3g mount is untouched. **Low value.** |
| 6 | **Concurrency / prefetch** (a parallel tree-order prefetcher) or **forcing readahead** | RAID5 might serve a few parallel random reads (perhaps 2–4×, unmeasured). Readahead helps only if tree-adjacent pages are physically adjacent (unknown; GC page reuse fragments). Forcing it on means **patching libmdbx** (no flag exists: `mdbx.h` `MDBX_NORDAHEAD`), so the result would no longer come from the pinned official build. | About 7 GiB usable page cache above the 16 GiB floor. | A new tool or a patched validator. **Not recommended.** |
| 7 | **A sequential custom structural checker** (one physical-order pass: page headers, parent/child reachability) | It could cover structure in about one sequential pass (hours, unmeasured), but it is a **new, unofficial MDBX checker**, weaker than libmdbx's own `mdbx_chk` until independently qualified. | about 1.1–2.2 GB anon (one u32 parent plus a type byte per page × 277.9 M pages), within a 4096 lane. | A new framework (**out of scope**). |
| 8 | **Sampled checks** (random pages or accounts against the state root) | Can **find** problems only, never clear them (r4 README). Useful as an early tripwire, not a validation. | Small. | None. |

## Bottom line
- **No defensible full validation (structure or state) on this USB/HDD path finishes in days:** the observed rate is about 66 pages/s, about 48 days.
- **The only realistic fast route is a sequential copy to NVMe (options 1/3).** It is blocked on **space**, which depends on **the user's `.pixel10` answer plus the local-sudo cold reclaim**.
- **Next step:** root's short read-only measurements (option 2) can confirm the HDD-vs-FUSE attribution and the sequential rate before anything is decided.
- **Unchanged:** the original stays read-only; USB writes, download and VM boot stay paused; the 16 GiB floor and admin rights are kept.
