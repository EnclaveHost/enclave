# Compact encoded weights: memory-priority runtime

**Production status (2026-09-30): compact unit 64 deployed and verified.**
The owner explicitly prioritizes memory over the measured loss of approximately
one token per second. Corrected release `4bb9f020` is active on Eyesoff-AI;
raw-weight release `83b38d61` remains the rollback. Both compact profiles passed
functional checks. Their earlier performance-based rejections below describe
the previous no-performance-loss requirement, which this decision supersedes.

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

Initial benchmark artifact (subsequently withdrawn after its production trial):
`b8aaaea96d8ca39bf3da6c0931e7c81c153aa4b25cc388e0190916d4e3d4056a`.
Its 45-file manifest verified, and its runtime hashes matched the benchmarked
runtime. See the rollout correction below; this artifact must not be deployed.
See [qualification evidence](evidence/shield-compact-20260930.json) for timings,
source and runtime hashes. Local artifact and raw logs are under
`/home/steven/enclave-bench/shield-compact-production-20260930/`;
`production-qualified/release` is the candidate, with dependency licenses in
`production-qualified/licenses`.


## Production first-use regression and correction

The first b8aaaea9 rollout passed attestation and startup but failed chat decode.
It was rolled back to 83b38d61. A regression fixture reproduced a concrete gap:
a later graph can discover another weight after prefill has opened the GPU
links. Compact adapter installation correctly requires a closed link, but the
registration caller had not closed it. Admission failed and latched the backend
closed; native target decoding with MTP observation had missed this path.

Compact registration now quiesces the old link before adding the new weight.
It joins refill workers, discards unused pads, closes the connection and retains
mask counters and integrity latches. The existing dirty-plan path reuploads the
complete registry. No verification guard was removed. A test using two real CPU
protocol workers fails before this correction and passes after it, including
late weight registration, reconnect and identical verified output. The existing
source authentication/lifecycle suite also passes under ASAN/UBSAN.

Corrected candidate: `4bb9f020d0d3c0760c60f7e3a28e32e4429139c82023785d5415f83bcb054170`.
The b8aaaea9 artifact is withdrawn. The correction changes registration only;
production inference qualification is recorded in the comparisons below.


## Production MTP comparison and refill-unit follow-up

Corrected unit-64 release 4bb9f020 completed real MTP chat with 49 of 79 draft
suggestions accepted for the same 128-token test output. After startup warmup
completed, three cached-prompt samples measured 13.9, 13.9 and 14.1 tok/s
(9,223, 9,237 and 9,105 ms decode), below the 14.7 tok/s baseline. GPU clocks
remained 1380 MHz, memory clocks 1107/877 MHz, and the guest used the normal
16-core placement. The rollout was rejected for decode regression despite
saving approximately 2 GiB of guest resident memory. Baseline 83b38d61 was
selected again; unrelated app guests were preserved.

The next candidate retains the compact backend and late-registration fix but
uses refill unit 32, which passed the earlier native comparison. This setting
is compiled into measured init and cannot be selected by the host or app
configuration. Candidate 79eb055a74f4b2c440ceaa3fa7c80862a0842d663a78bd5aefddefa79be16347
was subsequently independently predicted and qualified as recorded below.


## Unit-32 production result

The unit-32 candidate 79eb055a passed independent image prediction, fresh SNP
attestation, unchanged W^X checks after real inference, and public TLS on both
app and custom domains. It generated the same answer in three warm tests, but
measured 13.9, 13.7 and 13.8 tok/s (13.816 aggregate). A fresh baseline check
measured 14.8, 14.8 and 14.6 tok/s (14.737 aggregate). The selected samples had
zero speculative-gate wait and cached prefill; startup and browser warmup were
completed first. One earlier contended baseline sample was excluded explicitly.
The candidate regressed 6.25%, so it was rejected and baseline 83b38d61 selected
again. Under the then-current no-regression requirement, neither candidate was selected. Native target
benchmarks did not predict this real speculative application workload.

See [unit-32 production evidence](evidence/shield-compact-production32-20260930.json)
and [unit-64 production evidence](evidence/shield-compact-production64-20260930.json).
Those trial directories originally received NOT-FOR-PRODUCTION.txt markers
because of the performance requirement. The memory-priority rollout supersedes
that disposition for corrected unit-64 release 4bb9f020 only. The original b8aaaea9
artifact remains withdrawn for its functional defect. Do not report the native
19.44 tok/s result as a deployed Eyesoff rate.

## Memory-priority production selection

The owner explicitly accepted the approximately 0.8 tok/s production decode
loss in return for roughly 2 GiB lower resident guest memory. Unit 64 is selected:
it measured slightly faster than compact unit 32 with comparable memory savings.
The deployed artifact is the already-tested corrected release built from commit
`057221e88`, not a new unqualified backend. Source init selection again matches
its measured 64-pad profile. The unchanged 74,496 MiB app reservation retains
startup and concurrency headroom; the 16 GiB host memory floor is preserved.

Fresh release admission, independent image prediction, SNP attestation, public
TLS, real MTP chat and post-inference memory checks are required for this rollout.
No isolation, mask, verification or W^X policy changes are part of the selection.


### Final rollout verification

At 2026-09-30 08:14 UTC, guest `gda1386696` served corrected release `4bb9f020`.
Fresh independent prediction matched the measured image. Fresh nonce-bound SNP
attestation and W^X checks passed after real MTP inference on both the canonical
app domain and `eyesoff.ai`; both domains passed normal public TLS verification.
The other five app guests retained their identities and remained running.

Three sequential warm 128-token requests measured 14.2, 14.3 and 13.8 tok/s
(14.075 aggregate), versus the earlier 14.737 baseline. MTP accepted 49 of 79
suggestions in each run, outputs matched, prefill used its cache, and speculative
gate wait was zero. First-token times were 915, 1,014 and 803 ms. These are short
single-session checks, not sustained-load or eight-session qualification.

Guest MemoryCurrent fell from 58,443,456,512 to 56,446,390,272 bytes: **1.86 GiB
less resident guest RAM** (54.43 to 52.57 GiB). Exact encoded-matrix savings
remain 2.224 GiB; other guest allocations explain why whole-guest savings differ.
The remaining private encoded-weight copy still exists. Existing reservations
and security policies are unchanged. The user accepted this memory/speed tradeoff,
and the compact release remains selected in production.

See [final rollout evidence](evidence/shield-compact-memory-priority-20260930.json).

## Follow-up layout experiment

The [offline layout investigation](shield-compact-layout-20260930.md) tests
avoiding repeated GEMM weight packing while retaining compressed private
weights. It is not part of the deployed provider or a qualified release.

The [runtime integration](shield-compact-layout-runtime-20260930.md) is now
implemented and staged, including all refill sizes and bounded payload growth.
It remains undeployed pending full-model qualification.
