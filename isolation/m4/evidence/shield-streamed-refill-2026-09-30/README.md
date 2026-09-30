# Streamed encoded-weight prototype: tested, not production-qualified

Follow-up: [compact/radix integer-GEMM experiments](../shield-compact-refill-2026-09-30/README.md)
test a faster CPU multiplication algorithm alongside this reader. The historical
results below use the original production multiplication kernel.

2026-09-30 UTC (2026-09-29 America/Phoenix).

The prototype can discard a resident encoded matrix and compute identical
mask products from authenticated NVMe blocks. It does **not** yet meet the
requirement of unchanged performance. No production service, allocation,
security setting, or release was changed.

## Results

Final variant: CPU-accelerated SHA-256 via OpenSSL, direct disk reads into
private buffers, and double-buffered prefetch. Four matched pairs per case,
alternating resident-first and streamed-first. Both sides use the same
production AVX-512 vector-CRT kernel and exact matrix values.

| Actual 27B matrix, batch 256 | Resident median | Streamed median | Wall overhead | Total CPU overhead |
| --- | ---: | ---: | ---: | ---: |
| FFN gate, 5120 × 17408 | 221.1 ms | 230.2 ms | 4.1% | 31.4% |
| FFN down, 17408 × 5120 | 230.1 ms | 247.1 ms | 7.4% | 30.9% |
| Output, 5120 × 248320 | 3219.7 ms | 3426.3 ms | 6.4% | 31.0% |

The current runtime cannot simply select this batch: its refill setting is
capped at 64. At batch 64 the direct variant was 34.7–66.8% slower and used
94.9–110.9% more CPU time. Buffered accelerated reads at batch 512 approached
resident wall times in some cases but still consumed additional CPU; one
matrix also became less efficient per pad at that batch size. Increasing the
batch is not a free fix.

The initial existing scalar-SHA256 reader took approximately 374 ms versus
61 ms resident on the FFN gate at batch 64. Keeping authentication while using
OpenSSL substantially reduced that bottleneck. Direct I/O helped further but
did not remove the cost of reading, hashing, and copying the weights.

Memory probe on the output matrix:

* Freed **1,271,398,400 encoded bytes (1.184 GiB)**.
* RSS immediately fell from 1,781,880 KiB to 526,584 KiB. This includes allocator
  trimming, so the RSS delta is not purely the weight vector.
* Subsequent streamed products still matched every reference element, with
  **10 MiB of weight buffers**, plus a 1 MiB authentication buffer, small hashes
  and scratch, and the test's retained input/reference/output arrays.
* Steady measured test RSS was 540,556 KiB. This is a component probe, not an
  Eyesoff-AI memory requirement or a measurement of freeing all 24.3 GiB.

Actual `/proc/self/io` disk-read deltas were at least the encoded matrix size
for every final streamed trial. FFN down rereads some boundary blocks because
whole rows and 1 MiB authentication blocks do not align under the chosen
buffer cap; its measured read volume was 99,614,720 bytes versus 89,128,960
encoded bytes. These timings are not simply page-cache hits.

## Validation and limits

* **288 independent int64-oracle cases passed**, covering three reader modes,
  prefetch on/off, tails, strides, and batches 1–512.
* Corrupted/truncated storage and injected exceptions were rejected; already
  computed output was cleared on failure.
* The automated test passed with AddressSanitizer and UndefinedBehaviorSanitizer,
  including leak checks. See `final-sanitized-tests.txt`.
* All 48 buffered accelerated and 24 final direct matched pairs produced exact
  full-output equality. Two additional released-weight trials also matched.
* Public source fixture: Qwen3.8-27B-UD-Q4_K_XL.gguf, matching the model used by
  the preceding reclamation work. `model-sha256.txt` records the rechecked hash.
* Hardware: AMD EPYC 9115, NVMe-backed encrypted filesystem, ordinary Linux
  process at reduced scheduling priority. Other host work remained active;
  the four-pair medians are exploratory measurements, not confidence bounds.
* One compute thread and at most one asynchronous read/hash thread per call.
  The extra CPU cost could hurt inference even if prefetch hides wall time.
* These are matrix mask-generation timings, **not tok/s**. They exclude full
  model/MTP execution, pad generation PRG, encrypted spool/ledger operations,
  guest isolation overhead, GPU/network time, and eight-session contention.
  Startup peak and first-token latency are not qualified.

Recommendation: retain the resident production path. Further work should first
reduce authenticated-read CPU cost and qualify the bounded producer/consumer
queue before an isolated full-model inference experiment. A hybrid retaining
the most expensive matrices is another RAM/performance tradeoff to measure;
this experiment does not prove it either.

Source and reproduction: [STREAMED-REFILL.md](../../../../shielded/bench/STREAMED-REFILL.md).
Raw data and binary/tool identities are alongside this file; `summary.json`
contains the final direct-read aggregate. The earlier buffered and scalar
files are exploratory iterations, not claims about the final executable.
