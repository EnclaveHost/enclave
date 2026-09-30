# Removing the resident encoded-weight copy

Research: 2026-09-29. No runtime or production configuration changed.

Follow-up: the offline prototype and real-model matrix tests are complete.
See [the measured results](../../isolation/m4/evidence/shield-streamed-refill-2026-09-30/README.md).
It released a 1.184 GiB matrix correctly, but the final batch-256 direct-read
variant still added 4–7% wall time and about 31% CPU time. It is not qualified
for production under the unchanged-performance requirement.

## Conclusion

The roughly 24.3 GiB encoded int8 allocation is active masking state, not an
unused upload buffer. There is an existing route to removing it from the
inference process: consume precomputed masks and retain only compact checks,
outlier weights, and authenticated readers. That does not by itself remove the
allocation from the host: today's CPU dealer still keeps its own encoded weights.

The strongest candidate for reducing **total host RAM without changing the
cryptographic construction** is a bounded, authenticated, NVMe-backed CPU mask
generator inside the existing trusted boundary. It should compute many fresh
masks per weight read, using asynchronous prefetch and bounded encrypted pad
storage. This requires implementation and measurement. No evidence yet establishes
unchanged first-token latency, sustained decoding, startup, or eight-session
performance for that design.

## What the implementation actually needs

* `wasm/ggml-shielded/ggml-shielded.cpp`, `sh_state::entry::w`, owns encoded
  weights borrowed by the link. Registration prepares verification vectors and
  preserves outlier columns separately.
* `wasm/ggml-shielded/shielded-tee.c`, `generate()`, reads `nd->w` to compute
  fresh `u = r W` in local refill threads. Removing that pointer breaks masking.
* `sh_link_set_weight_reader()` already replaces that pointer, but requires a
  dealt link, result verification, prepared pad checks, no pipeline, and no
  running refill threads. Local minting explicitly rejects a missing pointer.
* Registration already frees `entry::w` after successfully installing an
  authenticated reader. In dealt mode, reads support GPU reupload/reconnect and
  exact CPU fallback, rather than ordinary pad generation.
* `shielded-weight-cache.h` authenticates 1 MiB blocks in private read buffers
  before use. At 24.3 GiB, its 64-byte-per-block hash storage is approximately
  1.52 MiB (plus per-tensor rounding), not another model-sized allocation.
  Verification vectors, outlier data, CPU tensors, KV caches, and pad buffers
  remain additional private allocations.
* `SHIELDED_PUBLIC_WEIGHT_CACHE_ONLY` discards the recoverable local source and
  deliberately fails when a worker cache is missing. It is not a suitable way
  to preserve current recovery behavior.

The deployed original-source reclamation work explicitly leaves these encoded
weights intact; see [the deployment record](shield-original-weight-reclamation.md).

## Candidate comparison

| Approach | RAM result | Assessment |
| --- | --- | --- |
| Existing dealt consumer plus resident CPU dealer | Removes consumer copy; retains dealer copy | Useful sharing across multiple consumers, not a full host-memory solution for one consumer |
| Trusted CPU generator with authenticated streamed weight blocks | Removes full resident encoding; keeps bounded blocks and pad buffers | Best first prototype under the current trust assumptions; I/O and latency remain unqualified |
| Generate a finite bank, then release all weights | Lower inference RAM until bank runs out | Cannot support indefinite warm service without a refill plan |
| Ordinary GPU generates the same request's masks | Could remove CPU weight copy | Reject: the GPU/host can combine the mask with the masked input |
| Separate non-confidential GPU under the same operator | Moves mask computation | Reject as a security-equivalent change: operator can combine both devices' transcripts |
| Attested confidential GPU for mask generation | Potentially removes CPU encoding | Different hardware/trust deployment, not established for the current V100 workers |
| Lossless compression with fused decoding | Partial reduction, amount unknown | Worth a secondary experiment; must reconstruct exact encoded bytes and preserve kernel speed |
| Re-quantization or structured/LPN masks | Changes numerics or security assumptions | Does not meet this task's unchanged-security/performance requirement on current evidence |

The repository already contains an LPN investigation in `shielded/lpn/REPORT.md`.
It recommends against integration into the current CVM tier: the advantage over
batched VNNI refill was limited, extra layouts/state were needed, and the ring
hardness assumption was unreviewed. Exact toy outputs do not establish privacy.

## Why streaming must be batched

An ideal full encoded-weight pass per batch has a storage bandwidth floor of
`24.3 GiB × full-model pad rows consumed per second / batch size`.
This excludes hashing, partial reads, pad writes/reads, other storage users,
and scheduling inefficiency. A pad row is not an accepted output token: prefill,
speculation, rejected drafts, and concurrency affect consumption by group.

Illustrative arithmetic, not measurements of this deployment:

| Full-model pad rows/s | Batch 64 | Batch 256 | Batch 512 |
| ---: | ---: | ---: | ---: |
| 20 | 7.59 GiB/s | 1.90 GiB/s | 0.95 GiB/s |
| 40 | 15.19 GiB/s | 3.80 GiB/s | 1.90 GiB/s |

The existing local refill batch is capped at 64; the shipment CPU mint worker
uses batches of 16. Raising a setting alone therefore does not implement this
design. Larger batches also increase buffering and replenishment latency.

Historical 27B Q8 dealer evidence reports approximately 12.64 MB of encrypted
shipment data per full-model row (809,039,872 bytes per 64-row shipment).
At 20 rows/s, that is about 253 MB/s and 911 GB per hour if all shipments are
retained. This is a sizing reference from a different run, not a measurement of
the deployed Q4/MTP/split layout. Prune consumed pads and size from its actual
authenticated manifest. Do not build an unbounded disk or RAM cache.

## Prototype shape and invariants

1. Authenticate the exact model/calibration/encoding and construct private
   block digests during registration. Use the current encoding byte-for-byte.
2. Store public encoded weights on real NVMe-backed storage, not tmpfs. Read
   whole output-row blocks into bounded private buffers, verify them, and feed
   the existing exact SIMD refill arithmetic with the correct output stride.
   Reuse each verified block across a sufficiently large batch; overlap the
   next read without retaining a whole-model resident cache.
3. Keep random seeds, masks, unblinding values, and verification secrets inside
   the existing isolation boundary. If pads spill outside, use authenticated
   encryption and retain the existing identity and single-use rules. Do not
   introduce an external trusted party merely to lower the app's reported RAM.
4. Preserve model/member/split/MTP identities, group ordinals, and exact modular
   arithmetic. Never reuse masks after crashes, reconnects, failed requests,
   cloning, or concurrent consumption. Fresh epochs or durable reservations must
   prevent replay; an empty queue must never fall back to unmasked execution.
5. Read weights in a public model-defined schedule. Do not replace dense reads
   with secret-dependent NVMe accesses. Authenticate before computing; host
   mappings or filename/mtime checks are not substitutes.
6. Retain authenticated recovery sources for GPU reconnect and CPU fallback.
   Account for guest RAM, host page cache, producer buffers, and encrypted spool
   together. Reducing guest RSS alone is not proof of host-memory savings.

The existing persistent dealer's metadata checks assume trusted immutable
storage. They do not make that dealer safe against hostile storage; a streamed
implementation must add the authenticated reader to the actual mint path.

## Evidence collected and remaining qualification

Ran the existing cache tests locally on this checkout:

* Passed: authenticated private reads, partial I/O, tampering, and cleanup.
* Passed: source release, exact local fallback, and authenticated GPU reconnect.
* Passed: disk-full failure during registration aborts before upload/pad binding.
* `test/shielded-required-cache.test.mjs` could not compile: its fixture calls
  `sh_prepare_rows_threaded` with the old signature, omitting `ggml_type`.
  This is a test-maintenance defect, not a demonstrated runtime exploit. It
  remains unresolved; the full combined test command exited unsuccessfully.

These tests exercise existing dealt/cache machinery, not a streamed local
generator. Before production, compare exact pad outputs against the resident
baseline, then test tampered blocks, wrong model/split identity, partial writes,
replay, exhaustion, reconnect, and crash recovery. Benchmark the actual deployed
model on the actual storage, preserving MTP and all checks. Measure cold startup,
warm time-to-first-token, prefill, sustained decode, p95 stalls, eight-session
load, and total host memory under storage contention. A short prefilled-bank run
does not demonstrate sustainable throughput.

## External research

[Slalom, Tramèr and Boneh](https://arxiv.org/html/1806.03287), sections 3.2–3.3,
supports compact preprocessed verification and precomputed one-use blinding
values, with encrypted unblinding values stored outside the TEE. It explains why
weight-free online execution is possible and why private preprocessing still
has to be supplied. It does not prove this repository's protocol or predict its
27B/MTP performance.

Direct storage-to-GPU upload can remove CPU staging buffers but cannot replace
the trusted `r W` operation identified above. The current problem is ongoing
mask production, not just initial model upload.
