# Compact encoded weights: production candidate

This opt-in runtime replaces the resident int8 mask-weight matrices with exact
private bit-packed frames. It preserves the original-weight reclamation loader,
GPU encoding, uniform masks, one-use pad ring and Freivalds verification. It is
not the NVMe streaming prototype, and it does not replace SHA-256 with GMAC.

Registration first authenticates and encodes the source, removes calibrated
outlier columns, applies each card's column slice and constructs the private
verification vectors. Packing then validates every encoded weight's bound and
round-trips every byte. Only after the trusted reader/refill adapter is installed
may the borrowed raw vector be released. On failure the model load is refused
and that vector stays alive until link teardown.

The immutable store provides bounded private reads for GPU upload/reconnect and
exact CPU fallback. Local pad generation still obtains fresh `r` from the same
mask bank. Batches of 32–64 use three radix-256 integer GEMMs; smaller batches
use the existing vector-CRT kernel after lossless decoding. The integer bound is
`K <= 65536`, `|W| <= 119`, so each byte-plane accumulator fits signed int32;
combining the planes uses int64 and the unchanged modulus. No mask or seed is
sent to the untrusted GPU. Errors clear the whole group's output and permanently
latch the link closed before the pad ring can publish anything.

Each refill worker reuses bounded private scratch instead of allocating and
zeroing multi-MiB buffers for every matrix. Active bytes are overwritten before
use; mask planes and products are wiped when the worker exits. Legacy CRT
planes are prepared only when a raw-weight node needs them.

The oneDNN call is single-threaded within each existing refill worker. Its
OpenMP setting is restored afterwards; the application CPU worker configuration
is not globally changed. The oneDNN library and all dependencies are part of
the measured runtime. Stock oneDNN 3.11.3 publishes RWX JIT pages and is refused.
`build-shielded-onednn.py` pins upstream commit
`74d04752d9eaefff6a9ff62466c4d20b155e5bca` and changes its x86 JIT publication to
`readyRE()`: writable during generation, read/execute afterwards. The compact
release builder executes an exact integer GEMM in its hermetic runtime closure
and scans process mappings before creating the enable marker. No filesystem, syscall or isolation policy is relaxed.

The last backend context explicitly joins split and refill workers before
library teardown, discards unused pad pools and disconnects GPU links. Verified
weight storage, integrity latches and mask-bank counters survive for a later
context. This avoids background GEMM calls racing oneDNN's global destruction;
reconnect cannot reset a verification failure or recycle discarded pads.
The sparse offline v3 dealer remains unsupported for compact nodes because its
independent scratch-budget contract has not been extended.

## Build and test

Use the exact source and ABI-matching engine libraries associated with the base
runtime. The build preserves its llama, shim, Wasmtime and CPU binaries.

```sh
# Source checkout: https://github.com/uxlfoundation/oneDNN, tag v3.11.3.
python3 isolation/m4/build-shielded-onednn.py \
  --source /path/to/pinned/oneDNN --out /path/to/onednn-wx
SHIELDED_COMPACT_TEST_ROOT=/path/to/onednn-wx/install \
  node --test test/shielded-compact-runtime.test.mjs \
  test/shielded-weight-verifier.test.mjs
python3 isolation/m4/build-shielded-compact.py \
  --runtime /path/to/base/template/rt \
  --engine-src /path/to/matching/engine-src \
  --engine-lib /path/to/matching/engine-build/bin \
  --onednn-root /path/to/onednn-wx/install --out /path/to/new-build
```

The builder records file hashes and verifies the dependency closure in a
filesystem containing only the bundled libraries, including the dynamically
loaded backend. It rejects executable stacks. A matching rebuilt measured init
reads `shield-compact-weights.enabled` and enables the mode for the large model;
host app configuration cannot select that marker. Native qualification uses
`SHIELDED_COMPACT_WEIGHTS=1` explicitly. Ordinary builds retain the existing path
and have no oneDNN dependency.

Compose a new domain release and verify its manifest before admission. Building
an artifact does not admit it or modify production. Keep the previous release
available for rollback. Do not reduce the app reservation from a matrix-storage
estimate: startup, KV state, pad pools and eight sessions must fit separately.

## Qualification limits

Packing saves roughly 9–12% on the prototype matrices, not the entire encoded
weight copy. The separate disk-backed prototype needs larger refill batches and
safe guest storage integration before it can remove most of that copy.
Small-batch and startup regressions are possible. Exact arithmetic tests alone
do not qualify inference performance; compare real model output, decode time,
startup latency and peak memory against the unchanged runtime. Native GPU
benchmarks are not isolated-guest or Eyesoff-AI throughput measurements.

## 2026-09-30 qualification

Selected: compact store, 384-row chunks, 64-pad refill unit. The measured init
selects unit 64 only when the compact capability marker exists; ordinary
production retains unit 32. Larger 768-row chunks helped the output projection
but slowed the feed-forward matrices and were rejected.

Qwen3.8-27B Q4_K_XL, two V100s, production CPU affinity and 16-CPU quota:

| Profile | All-round decode | Warm decode | Cold first token | Peak memory |
| --- | ---: | ---: | ---: | ---: |
| Raw baseline, unit 32 | 17.72 tok/s | 17.92 tok/s | 126.7 s | 36.14 GiB |
| Compact, unit 32 | 18.23 tok/s | 18.19 tok/s | 158.7 s | 34.06 GiB |
| **Compact, unit 64** | **19.44 tok/s** | **18.61 tok/s** | **156.7 s** | **33.99 GiB** |

Three rounds of 64 tokens per profile, fresh KV each round; warm excludes the
first round. All-round speed is 189 timed tokens divided by total decode time;
warm is 126 tokens divided by the last two rounds' decode time. The harness
observes the MTP head but does not use speculative acceptance. These are native
measurements with production CPU settings, not Eyesoff HTTP or SNP guest rates.
All 192 token IDs match between variants. Every variant exits cleanly after
running under the app syscall filter and checking mappings after each decode.

The selected profile improved warm decode by 3.86% in this short comparison;
the 9.69% overall improvement includes an initial buffered-pad burst. This is
not a statistically established sustained improvement. A previous 10-CPU
comparison measured a 0.71% warm regression for unit 64, so deployment must
retain the tested 16-CPU profile and verify real application performance.
The longer cold start is an accepted tradeoff for this candidate.

818 matrices shrink from 24.236 GiB to 22.012 GiB, saving 2.224 GiB. Peak process
memory falls by 2.144 GiB. This does not eliminate the remaining private copy.
Eight-session capacity has not been requalified; keep its existing reservation.

ASAN/UBSAN arithmetic tests cover 76 shape/batch combinations, concurrent
scratch reuse, byte reads, malformed input and output clearing. Integration
checks cover authenticated registration, split upload/reconnect, source-page
revocation, CPU fallback, offline minting, persistent failure latches and
backend teardown/recreation. The final bundled oneDNN passes exact integer
GEMM and W^X checks; earlier stock-oneDNN builds are explicitly rejected.
These checks preserve the existing security mechanisms, but are not a new
independent security proof.

Candidate release:
`b8aaaea96d8ca39bf3da6c0931e7c81c153aa4b25cc388e0190916d4e3d4056a`.
Its 45-file manifest verifies, and its runtime hashes match the benchmarked
runtime. It is **not admitted or deployed**. Base production remains
`83b38d61b87fd2da5b97e8cdf707e26c8bf14d5efe927a14f27f2ffb842259cc`.
See [qualification evidence](evidence/shield-compact-20260930.json) for timings,
source and runtime hashes. Local artifact and raw logs are under
`/home/steven/enclave-bench/shield-compact-production-20260930/`;
`production-qualified/release` is the candidate, with dependency licenses in
`production-qualified/licenses`.
