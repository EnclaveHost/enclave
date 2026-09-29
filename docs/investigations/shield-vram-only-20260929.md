# Investigation: removing resident CPU model copies without weakening Shield

## Decision

No production change is qualified. There is no demonstrated way in the current local-pad V100 implementation to discard **all** CPU weight storage while preserving both its existing trust assumptions and sustained performance. This is a limitation of the implementation and available evidence, not a claim that all future constructions are impossible.

The strongest immediate candidate is narrower: remove the private original GGUF copies of offloaded tensors while retaining encoded rows for local pad generation and CPU-required weights. It could substantially reduce RAM without changing mask generation, model precision, MTP, eight active sessions, or prompt-cache capacity. End-to-end memory and performance still need qualification.

## What production does

- `isolation/m2/shieldmodel/main.go` copies the 17,559,178,144-byte public NVMe model from `/dev/vda` into a private guest file, then checks the whole-file hash. This prevents a hostile host changing model bytes after verification.
- `wasm/ggml-shielded/ggml-shielded.cpp` registers calibrated weight matrices as encoded int8 rows. Its entry vectors are borrowed by the link for its lifetime.
- `shielded-tee.c::generate` mints fresh masks and computes corrections using those rows on the trusted CPU. It explicitly refuses a missing `nd->w`.
- The GPU computes masked linear products. CPU mask corrections, private state and result verification remain inside the guest.
- Production `dominit.c` does not enable an external pad source or required-public-cache mode.

These are two different weight representations. A model file in private guest RAM and encoded pad-generation rows are not interchangeable accounting entries. No application leak is established by their existence. The host's SNP memory high-water mark is also not a measurement of guest allocator garbage.

## Inventory of the actual production model

Parsed the current Q4 GGUF tensor table read-only, using the calibration file and the backend's `sh_group_key` aliases. These are static candidates, **not a live placement or resident-memory measurement**. Actual selection also checks type, layout, device budget, thresholds and fallbacks.

| Quantity | GiB |
|---|---:|
| Original model file | 16.353 |
| Source tensors whose calibration groups are candidates for offload | 15.667 |
| Remaining source tensors | 0.676 |
| Int8 encoding of those candidate matrices | 24.258 |

505 tensor candidates map to 262 calibration groups. Some source tensors, including embedding lookup weights, still have CPU consumers. Do not stream token-indexed rows from host-controlled storage: that can reveal secret-dependent access patterns even if their contents are authenticated. Keep such weights resident or qualify an oblivious alternative.

Artifact: `/home/steven/enclave-bench/shield-vram-only-20260929/weight-inventory.json`. The alias calculation is in `inventory.py` beside it. Saving 15.667 GiB is an upper-bound candidate estimate, not a production result or a promise that every listed tensor can be evicted.

## Existing paths and their limits

| Approach | Security / operational consequence | Result |
|---|---|---|
| Ask the same untrusted GPU to compute the secret masking correction directly | Reveals the mask or correction to the party holding the masked activation/result. It can remove the intended protection. | Reject. |
| Existing required public worker-cache mode | Requires a dealt-pad link, authenticated model and pad checks. A separate untrusted dealer introduces a non-collusion assumption; moving full weights to another trusted CPU merely relocates RAM. Cache loss currently refuses work. | Not a drop-in solution under the requested guarantees. |
| Authenticate source tensors, discard their original private copies, retain encoded rows | Preserves local pad generation. Small CPU-required tensors remain resident. Reloads must authenticate private bytes before use, including reconnect/fallback. | Best near-term candidate. |
| Stream encoded weights from authenticated NVMe in batches, generate pads inside the same isolation boundary | Avoids a resident full encoded model without adding a dealer trust assumption. Requires bounded private tiles, safe group lifetimes and enough sustained I/O/compute. | Research candidate; no throughput qualification. |
| Precompute pads inside the trusted boundary and store encrypted/authenticated batches on NVMe | Can remove model rows during the online phase; fresh pad indices must never be reused across restart, rollback, exhaustion or retry. Refill still requires trusted computation over authenticated weights. | Plausible design, not an unlimited-performance result. |
| Use confidential GPU hardware | Changes the available hardware and attestation boundary. Current V100s are not this path. | Not a software solution for the current hosts. |

The Slalom paper describes precomputing blinding corrections and storing them encrypted in untrusted memory/disk (Section 3.3). Its benchmarks do not establish current 27B/MTP performance: https://arxiv.org/pdf/1806.03287 . The repository's existing dealer documentation explicitly adds a non-collusion assumption: `docs/shielded-inference.md`, “Dealt pads”.

## Why NVMe batching needs measurement

The candidate matrices require 12,650,496 bytes of packed corrections per complete row. At an **illustrative 25 complete rows/second**, that is about 316 MB/s of correction reads, plus generation writes, authentication, indices and metadata. Reading the 26.05 GB encoded matrices once per 128 rows costs about 5.09 GB/s; once per 1,024 rows costs about 636 MB/s. MTP, prefill, rejected drafts and multiple passes change demand: these are **not** token-rate predictions. Large batches also create large correction inventories, startup latency and I/O contention. Avoid trading permanent weight RAM for equally large permanent pad RAM.

Precomputing only enough pads for a benchmark is not sustained performance parity. Measure replenishment over several full banks. Discarding original source pages must not silently add source reads to the decode/prefill hot path. Ordinary host-backed mmap after a one-time hash is insufficient because later host mutations could be consumed.

## Checks performed

`node --test test/shielded-weight-cache.test.mjs test/shielded-weight-verifier.test.mjs`: 4 tests passed, none skipped. Address/undefined-behavior sanitizers exercised authenticated reads, corruption rejection, partial I/O, full-disk failure, revoked original source, exact fallback, reconnect and retirement after integrity failure. These are focused correctness checks, not a security proof or throughput benchmark.

An additional `source_local_mint` fixture tests authenticated source tensors with the original mappings absent and external-pad mode disabled. It checks exact small/wide fallback, zero source rereads after registration, retained encoded rows, and successful local CPU pad generation. The updated verifier suite passed (1 test, including all existing scenarios and the new scenario), with no skips and ASan/UBSan enabled. This does not remove encoded weights or exercise a full production model/GPU.

## Required acceptance before deployment

1. Bind tensor identity, dimensions, quantization, offsets and hashes to the pinned model; verify private buffers before use. Missing/corrupt blocks, cache eviction and reconnect must never introduce unverified fallback.
2. Demonstrate the source mapping is absent and no offloaded-source reads occur during ordinary decode, MTP, prefill and cached follow-ups. Keep CPU and secret-indexed consumers resident.
3. Compare the unchanged production baseline and candidate with matched prompts/settings, MTP and all eight active sessions, cold startup, warm TTFT, prefill, long decode and repeated cache-expiry cycles. Report latency tails, throughput distribution, pad starvation and steady-state replenishment; no claim of exact equality from one short run.
4. Count the whole host footprint, guest memory, staging buffers and reclaimable/unreclaimable pages—not merely a lower advertised pool or RSS. Verify all apps can restart within 64 GiB, including VM overhead.
5. Preserve GPU-loss/reconnect behavior, integrity failure retirement and pad single-use across crashes. Retain the old release and admission settings until candidate qualification passes.

No production restarts, memory-floor reductions, pad-source changes or GPU changes were performed for this investigation.
