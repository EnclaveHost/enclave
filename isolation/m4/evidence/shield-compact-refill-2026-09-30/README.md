# Reduced-memory mask generation: positive component results

2026-09-30 UTC (2026-09-29 America/Phoenix). Research prototype; production
unchanged. Model, hardware and library identities are in `identities.json`.

Changing the CPU pad calculation to exact radix-256 integer GEMM provides
enough compute savings to pay for lossless decompression or authenticated NVMe
reads. This improves on the earlier streamed prototype, whose original CPU
kernel was not fast enough to absorb the I/O/authentication overhead.

## Private lossless storage

Six matched repetitions, batch 64, one compute thread, exact real GGUF matrix
encodings. All output elements matched the resident production kernel.

| Matrix | Encoded weight RAM saved | Resident time | Packed candidate time | Time reduction | Total CPU reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| FFN gate | 9.31% | 59.13 ms | 50.49 ms | 14.62% | 14.69% |
| FFN down | 9.67% | 56.89 ms | 48.87 ms | 14.09% | 14.11% |
| Output | 11.78% | 811.39 ms | 695.66 ms | 14.26% | 14.26% |

RAM percentages include packed buffers and their container metadata, but not
decoder/GEMM scratch or the rest of the application. These are three
representative matrices, not a measurement of the entire 24.3 GiB allocation.

The complete **262-site calibration inventory** subsequently round-tripped
every source-encoded byte: **17.268 GiB → 15.626 GiB**, saving **1.642 GiB
(9.509%)**. See `calibrated-inventory.jsonl` and `inventory-summary.json`.
This is the unique calibrated source-matrix set, not the exact live 24.3 GiB
registration/allocation set; it excludes live partitioning, duplicate storage
and calibrated outlier removal. Performance was measured on the representative
matrices above, not on every matrix in that inventory. A further output-matrix
probe freed the raw encoding while keeping only the packed representation;
both subsequent products matched exactly (705.9 and 709.9 ms). The RSS change
is recorded in `bits-release-memory.json`; startup temporarily holds both
representations, so this is a steady-state reduction, not a startup-peak fix.

**Counterexample:** at batch 16, the same candidate increased elapsed time by
23.56%, 17.45%, and 30.58% respectively. The smaller-batch data is retained in
`bits-*16.jsonl`. It must not be enabled unconditionally.

## Discarding the matrix: retain SHA-256 authentication

Batch 256, six matched repetitions, direct NVMe reads, 8 MiB chunk target,
one compute thread and at most one reader/hash thread. Median results:

| Matrix | Resident time | Streamed candidate | Time reduction | Total CPU reduction |
| --- | ---: | ---: | ---: | ---: |
| FFN gate | 247.78 ms | 177.16 ms | 28.50% | 5.74% |
| FFN down | 228.38 ms | 172.81 ms | 24.33% | **−1.84%** |
| Output | 3425.52 ms | 2498.01 ms | 27.08% | 3.90% |

The negative CPU reduction means a small regression. Down-matrix chunk
boundaries reread authentication blocks: 99,614,720 bytes for an 89,128,960-byte
matrix. A larger bounded, block-aligned chunk is evaluated separately below.
All three matrices had exact full-output equality and actual disk reads at
least as large as the matrix. Results are not page-cache-only timings.

The released-output probe freed **1,271,398,400 bytes (1.184 GiB)** before two
further SHA-authenticated products. Both matched every reference element.
Immediate RSS fell from **1,790,420 KiB to 539,156 KiB**, including allocator
trimming. Candidate times were 2.566 and 2.431 seconds. Retained reference and
output arrays account for much of the remaining process memory; this is not
the complete application's memory budget.

Boundary experiments on FFN down:

* Raising the chunk target to 32 MiB removed repeated disk reads but regressed
  total CPU by 3.03%; elapsed-time savings fell to 15.74%. Rejected.
* A per-product private 1 MiB boundary cache at the original 8 MiB target
  removed repeated reads without larger chunks. Six-pair medians were
  240.18 ms resident versus 174.73 ms streamed (27.25% less elapsed time),
  with 3.11% less CPU. **Individual paired CPU results still varied in sign**;
  this is not a robust claim of reduced CPU for every workload. The candidate
  used approximately 231 ms CPU, similar to the uncached run, while resident
  CPU varied. More copying offsets part of the saved authentication cost.

The boundary cache is private and starts empty for each product. It never
allows changed host bytes into a verified block. New-block tampering and
cross-product reuse tests pass under sanitizers (`boundary-tests.txt`).

## Other candidates

AES-256 GMAC with the same integer kernel reduced wall time by 23.97–29.11%
and total CPU by 17.71–26.16% at batch 256, with exact outputs. Its released
matrix test also passed. These results are retained in `gmac-*` files, but
GMAC is a **new cache authentication design**, not an identical replacement
for the SHA-256 trust contract. It needs separate cryptographic lifecycle and
query-bound review. No publisher/model admission was changed.

Earlier rejected experiments included LZ4 (little or no space saving), Zstd
(about 21% saving but expensive decode), normalized palettes (about 27% saving
but expensive lookup/decode), custom SIMD outer products and alternative
register tiles. The selected private codec is simple lossless bit-packing.

## Validation and remaining qualification

* 448 compact matrix/codec cases checked against exact int64 results; raw
  candidate kernels checked for tails, output strides, and the maximum admitted
  integer accumulation bound. Bit packing checked byte-for-byte and rejects
  truncated data.
* 384 streamed oracle cases cover four readers, prefetch on/off, strides,
  batches through 512, and damaged/truncated storage. Injected failures clear
  complete outputs; GMAC wrong-key and swapped-block tags are rejected.
* AddressSanitizer and UndefinedBehaviorSanitizer runs cover both suites,
  including the linked oneDNN path. See `sanitized-tests.txt`.
* Tests run on the EPYC host with existing workloads active, at reduced
  scheduling priority. Six-pair exploratory medians are not confidence bounds.
* Model parsing, initial encoding/admission, mask PRG, pad queue/spooling,
  GPU/network execution, full MTP graph, guest overhead and eight-session
  concurrency are outside these timing intervals. No inference tok/s or
  production-wide RAM-reclamation result is established.
* Production currently caps refill batches at 64. The streamed result needs a
  bounded producer/consumer design for batch 256, including pad memory,
  latency, restart recovery, uniqueness and secure consumption.
* oneDNN and OpenSSL need pinning/measurement and review in the actual isolated
  guest. oneDNN JIT/threading compatibility must not require weaker protections.

The result supports continuing with a SHA-authenticated streamed producer and
exact integer GEMM. It does **not** authorize deleting the production weight
copy before full-model and security-boundary qualification.

[Algorithm and reproduction](../../../../shielded/bench/COMPACT-REFILL.md).
