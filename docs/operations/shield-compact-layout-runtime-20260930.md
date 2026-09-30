# Integrated compact-layout runtime, 2026-09-30

**Implemented and staged; not deployed.** Production stays on `4bb9f020`.
The staged release is `5d48542ab5744f4c8e72cf58265844a5e820164dd0fa7610f482f161a4465d2c`.
It has not been qualified for full-model application throughput or eight-session
peak RAM. No model, app version, reservation, runtime admission or service was
changed in production.

## Runtime behavior

The compact provider selects prearranged tiles automatically in the new build.
It retains one encoded representation per tile. Selection requires an exact,
unpadded oneDNN descriptor matching the fast reorder implementation, aligned
geometry, byte-for-byte admission round trips, and at most **1% growth in that
tile's compressed payload**. Tiles that fail geometry/layout/budget eligibility
retain the original compact representation. Corrupt weights or failed arithmetic
are errors, not eligibility fallbacks.

Normal 64-pad refills decompress directly into the integer kernel's layout.
Batches 1–63 use exact-size matmul plans with the same prearranged weights. Each
geometry keeps the 64-pad plan and up to four recently used small-batch plans.
In-flight calls own their plan across cache eviction. A bounded weak lookup
shares equal geometries without retaining matrix stores. Ordinary tiles retain
the existing CRT path below batch 32 and GEMM above it; mixed matrices prepare
both mask representations once per refill. This changes neither uniform mask
generation nor one-use pad handling, GPU verification, or the field modulus.

Private reads invert the blocked layout with SIMD gathers, preserving offsets
and byte order for upload/reconnect and CPU fallback. Discarded original model
pages remain discarded. The implementation does not recreate a retained raw
weight copy. Admission scratch is released after construction.

oneDNN workspace is thread-private, aligned, and capped at 8 MiB per worker.
Masks, products and workspace are wiped at worker exit and before scratch growth
releases an old allocation. OpenMP settings are restored after calls. Shared
plans contain no model weights or mask values. oneDNN's existing internal cache
also consumes metadata; whole-model process RAM still needs measurement. The
1% limit is for encoded payload, not a promise that total application RAM grows
by at most 1%. Existing memory reservations are unchanged.

## Validation

- ASAN/UBSAN: original 76 shape/batch cases, plus all batch sizes 1–64 with
  nonuniform weights/masks, mixed prearranged/ordinary tiles, partial reads,
  stride canaries, invalid-mask output wiping, memory-budget rejection,
  shared-plan concurrency/eviction, and maximum-K accumulation.
- Authentication/lifecycle tests: original source discarded; local minting
  through the reader/refill adapters; quiesce and restart; persistent failure
  behavior. Added a 256-by-64 matrix eligible for the new layout.
- W^X and OpenMP restoration checks pass. Release builder now executes the
  actual copied compact provider against the bundled libraries in a hermetic
  filesystem, in addition to the previous integer-GEMM probe.
- The complete 45-file release manifest verifies. Engine, CPU backend, shim,
  model/calibration, affinity helper and other runtime inputs are preserved.

These checks are not an independent security proof or an end-to-end performance
qualification. No inference benchmark was run on the occupied serving V100s.

## Performance evidence

[Recorded measurements](evidence/shield-compact-layout-runtime-20260930.json)
compare the integrated provider against the current production source, both
compiled with `-O2`, on public model tensors with synthetic masks and independent
CRT result checks. Inputs use half-width rows to match two-card geometry. This
is not a full replay of the production calibration pipeline or SNP scheduling.

In the direct-layout single-worker trial, tested feed-forward refills improved
roughly 5–10%, including batch 1, 16 and 33. The output head was approximately
unchanged because most of its tiles exceed the 1% budget and retain the old
format. Measured store-byte increases were 0.68% (down), 0.23% (gate) and 0.06%
(head); these exclude shared plans and worker scratch. Final concurrent results
were 4.1% less refill wall time for down and 0.8% for gate; raw samples are in
the evidence. Those smaller gains reflect concurrency and measurement noise. None of these percentages is an Eyesoff-AI
tok/s claim.

An earlier integration reversed layout before small refills; it regressed them
substantially and was rejected. Its local staging directory is marked
`NOT_FOR_ROLLOUT.txt`. Use only the final direct-layout release above.

## Artifacts and next qualification

Local directory: `/home/steven/enclave-bench/shield-layout-integrated-20260930`.
The final release is `staged-final/release`, with source/dependency hashes in
`staged-final/provenance.json`. The earlier experimental builder is pinned to
its original source revision so the historical experiment remains reproducible.

Before deployment, compare full-model startup, sustained decode, prefix-prefill
and eight-session RAM inside the isolated guest with the current release. The
current memory savings and security boundaries remain required. Production
activation remains deferred under the owner's instruction.

The final allocation-only adjustment reserves exact scratch sizes before growth
to avoid vector geometric over-allocation. It follows the timed build; warm math
and control flow are unchanged. The final artifact passed repeated sanitizer and
hermetic-provider checks after that adjustment.
