# Actual synthetic FUSE memory measurement passed

The complete 8 GiB sparse image was scanned through the read-only NBD/FUSE path: 2,097,152 pages, zero nonzero pages, 28.417 seconds. Peak process-tree RSS was 525.719 MiB; cgroup current peaked at 536,997,888 bytes, page tables at 18,059,264 bytes, and walker PTE at 16,488 KiB. All 23,378 high-threshold events occurred without max/OOM events. The 768 MiB queue completed with exit zero and minimum host availability 23,522 MiB. All owned children and mounts were removed; peer processes and mounts were unchanged.

This qualifies only the measured synthetic mechanism. MemoryHigh is a reclaim/throttle threshold, not a ceiling. The whole scope is affected, OOM victim selection and timely soft cancellation are not guaranteed, and real MDBX page tables/pagemap memory and throughput remain unmeasured. No recovered production database was read or declared valid. The 2560 MiB r7 production entry remains inactive; a new memory-aware production implementation must be independently reviewed and tested.

Original USB writes, snapshot download and RPC VM boot remain paused. Canonical state validation, synchronization, historical blobs, finality, proof serving, lease relay and consumer cutover remain outstanding.
