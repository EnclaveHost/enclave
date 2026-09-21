# Captured exchange graphs

The worker caches a CUDA graph for each `(packing mode, row count, ordered
node list)`. A graph includes the masked input upload and field kernels. It
contains pointers into the connection's staging buffers, so growing any of
those buffers still invalidates the complete cache.

`SHIELDED_GRAPH_CACHE_ENTRIES` controls the per-connection entry limit. The
default is **1024** (it was 256 before 2026-09-21; see below). An explicitly
configured value must be a canonical decimal integer from 1 through 4096;
invalid values refuse startup before CUDA initialization. The environment takes
precedence over `worker.conf`, as for other worker settings. A limit change
requires a new worker process.

The full 27B target pass has 257 grouped exchanges, with additional MTP groups
and row-count variants. A cache smaller than one recurring pass can continually
discard graphs before reusing them. A 2048-entry experiment can hold five row
variants of 262 distinct group keys (1310 entries), provided that staging stays
stable. This arithmetic does not prove the actual workload's hit rate or speed.

## Measured on the 27B, 2026-09-21: why the default moved to 1024

The arithmetic above turned out to be the whole story, and the old 256 sat just
below what the model needs. Counted from the worker's own end-of-connection
line on Qwen3.8-27B-UD-Q4_K_XL:

| run | distinct keys (high water) |
|---|---|
| plain decode, one card per layer | 137 |
| plain decode, columns split over both cards | 274 |
| speculative round (same pass at m=1 and m=2), split | 514 |

Because the policy is clear-at-capacity rather than evict-one, a pass that does
not fit never reuses anything at all. The split run at the old default logged
**24 hits against 17733 misses and 68 capacity flushes**, re-capturing a graph
on nearly every exchange; the same run at 2048 logged 16963 hits against 770
misses and no flushes. That is worth about 70-100 us per exchange, and it was
large enough to hide the column split's entire benefit -- the split measured as
a regression until the cache was raised.

Note the speculative figure exceeds 256 even WITHOUT the column split (~257 per
card), so the old default was marginal for this model in its normal placement
too. 1024 covers both with room for another row variant.

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
