# Captured exchange graphs

The worker caches a CUDA graph for each `(packing mode, row count, ordered
node list)`. A graph includes the masked input upload and field kernels. It
contains pointers into the connection's staging buffers, so growing any of
those buffers still invalidates the complete cache.

`SHIELDED_GRAPH_CACHE_ENTRIES` controls the per-connection entry limit. The
default is **256**, preserving the existing capacity and clear-at-capacity
policy. An explicitly configured value must be a canonical decimal integer
from 1 through 4096; invalid values refuse startup before CUDA initialization.
The environment takes precedence over `worker.conf`, as for other worker
settings. A larger limit is opt-in and requires a new worker process.

The full 27B target pass has 257 grouped exchanges, with additional MTP groups
and row-count variants. A cache smaller than one recurring pass can continually
discard graphs before reusing them. A 2048-entry experiment can hold five row
variants of 262 distinct group keys (1310 entries), provided that staging stays
stable. This arithmetic does not prove the actual workload's hit rate or speed.

The limit bounds graph entries, not CUDA graph memory in bytes. Memory cost and
capture latency depend on the installed graph and driver; measure them alongside
worker/phone throughput before changing a deployment default. This cache is
local to a connection and does not share activations or execution state across
consumers. Pad identities, wire bytes and verification remain unchanged.

At connection close, the worker reports cache hits, misses, capacity flushes,
staging invalidations, the largest retained entry count and cumulative host
capture/instantiation time. The separate worker GEMM elapsed time includes
locking, allocation, capture, synchronization and optional CPU packing. Neither
number is a GPU kernel timer or a GPU utilization percentage. Close-time totals
also include setup/prefill exchanges; they are not decode-only measurements.

`test/shielded-captured-graphs.test.mjs` exercises the exact cache owner with
fake handles under ASan/UBSan: repeated passes across the capacity boundary,
row-count/node-order separation, staging invalidation, capture failure, null
handles and allocation failures after capture. Every fake handle must be
destroyed exactly once. These fixtures establish cache lifecycle behavior;
real CUDA and model checks are separate.

The explicit opt-in fixture `test/fixtures/shielded-captured-graphs-cuda.py`
starts its own worker on a caller-selected GPU UUID and a loopback scratch
port. On a V100-PCIE-32GB on 2026-09-08, it passed all six combinations of
256/2048 entries and epilogue/kernel/CPU packing: 3168 protocol exchanges and
205920 values matched an independent scalar result. It exercised staging
growth, fused-node ordering, warm reuse, and both 24-bit and 32-bit replies.
The repeated 262-key test produced the expected capacity flushes at 256 and
retained the complete pass at 2048. Its small 32-by-16 matrices establish CUDA
correctness, not the performance of a 27B model.
