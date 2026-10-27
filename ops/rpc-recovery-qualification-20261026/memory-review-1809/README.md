# Source-only memory proposal; not qualified for production

The attached Claude review identifies mapped-file RSS, MDBX page bookkeeping and page-table accounting as risks for the current 2560 MiB production gate. It proposes a 4096 MiB lane, an owned-scope MemoryHigh setting, telemetry and a reclaim mechanism fixture. Nothing has been implemented, probed or run.

Root review narrows several claims in the proposal:

- The page-table and anonymous-memory estimates are unmeasured. They justify a mechanism test, not a definitive claim that the existing lane must fail at a particular traversal percentage.
- MemoryHigh is a reclaim/throttling threshold, not a hard ceiling. It can be exceeded; it does not make the outer RSS guard unreachable.
- The OOM killer is not guaranteed to kill only mdbx_chk or preserve the lifecycle controller. Cleanup must not assume its chosen victim.
- A soft watchdog has a sampling race with the outer guard and other host allocations. Extra margin reduces risk but cannot guarantee ordered cleanup under every spike.
- Pinned sources and the existing runtime remain unchanged. Do not activate the proposed production configuration on this review alone.

Next work is a bounded synthetic FUSE/mmap mechanism test on non-USB storage through the coordinated shared queue, covering reclaim, page tables, guard metrics, failure and cleanup. Preserve the 16 GiB host floor and full recovery disk reservations. A successful fixture would still not establish production database integrity, canonical state or RPC readiness.
