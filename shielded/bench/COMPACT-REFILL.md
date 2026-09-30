# Compact and streamed mask-generation experiments

Offline prototypes only. They use public model weights and deterministic test
masks, and never connect to the live GPU, applications, or production pad banks.
See the [measured results](../../isolation/m4/evidence/shield-compact-refill-2026-09-30/README.md).

## Algorithms

The required operation is still `u = rW mod M`. Normalize each mask coordinate
to `[0,M)` and split it into three radix-256 bytes. Compute three exact integer
matrix products and combine them as `a0 + 256*a1 + 65536*a2` in int64 before
reducing modulo the original field modulus. This changes only the CPU's local
calculation of the pad. It does not change the mask distribution, expose masks
to the GPU, alter GPU arithmetic, or weaken the existing verification protocol.

With encoded weights in `[-119,119]` and `K <= 65536`, each byte-plane dot
product is bounded by `65536*255*119 = 1,988,689,920`, below `INT32_MAX`.
Larger dimensions require another accumulator strategy; the benchmark refuses
them. oneDNN's integer GEMM uses zero offsets, alpha=1 and beta=0. Exact int64
oracle checks, including the maximum bound, are required; an approximate
float/requantized replacement is not acceptable.

Two storage choices are tested:

* **Private lossless bit-packing:** each 64-weight frame stores its minimum and
  the bit planes of the exact differences. A raw escape covers wide ranges.
  Decode a bounded tile immediately before multiplication. Neither weights nor
  the representation leave private RAM. No additional cryptographic assumption.
* **Authenticated NVMe streaming:** discard the resident matrix and read blocks
  into private buffers, authenticating before multiplication. SHA-256 retains
  the existing private block-digest contract. OpenSSL accelerates hashing;
  double buffering overlaps it with integer GEMM. The final output is usable
  only after every block succeeds; errors clear all output.

`COMPACT_BOUNDARY_CACHE=1` retains a single authenticated 1 MiB block inside
the current product so row/chunk boundaries do not cause repeat disk reads or
hashing. This private cache is destroyed between products; a later product
reauthenticates from disk. It is available only with SHA-256. Negative tests
check that host changes cannot modify the cached private bytes, new blocks
reject tampering, and a fresh product cannot reuse the previous cache.

An experimental `stream-gmac` mode is also retained for comparison. It uses a
fresh private 256-bit AES key per immutable cache, 128-bit GMAC tags, and a
unique 96-bit IV per block. The authenticated data binds total size, offset,
and bytes. This is a **different cache authentication design**, requiring its
own lifetime/query-bound review. It does not replace publisher/model SHA-256
admission. Prefer the SHA-256 candidate when evaluating unchanged security.

## Reproduction

Dependencies: the existing streamed benchmark dependencies, LZ4 and Zstd
development libraries, and optionally oneDNN. The measured oneDNN package was
3.11.3-1, verified with the Arch package signing key and extracted locally;
nothing was installed system-wide. Pin and review any production dependency.

```sh
python3 shielded/bench/build-compact-refill.py /path/on/nvme/probe \
  --onednn-root /path/to/extracted/onednn
COMPACT_DNNL_ROOT=/path/to/extracted/onednn \
  node --test test/shielded-streamed-refill-prototype.test.mjs \
  test/shielded-compact-refill-prototype.test.mjs

OMP_NUM_THREADS=1 OMP_DYNAMIC=FALSE COMPACT_ONEDNN=1 \
  /path/on/nvme/probe/compact /path/model.gguf output.weight 64 6 bits 384
OMP_NUM_THREADS=1 OMP_DYNAMIC=FALSE COMPACT_ONEDNN=1 \
  COMPACT_CACHE_DIR=/path/on/nvme/probe \
  /path/on/nvme/probe/compact /path/model.gguf output.weight 256 6 stream-sha256 384
OMP_NUM_THREADS=1 OMP_DYNAMIC=FALSE COMPACT_ONEDNN=1 COMPACT_RELEASE=1 \
  COMPACT_CACHE_DIR=/path/on/nvme/probe \
  /path/on/nvme/probe/compact /path/model.gguf output.weight 256 2 stream-sha256 384
/path/on/nvme/probe/compact --inventory /path/model.gguf /path/model.calib
```

Use a real NVMe directory, not tmpfs. The two environment variables limiting
OpenMP are required for the reported single-compute-thread comparison.
`COMPACT_STREAM_MIB` controls the chunk target (1–32 MiB, default 8); two
buffers may be allocated. Larger chunks are not necessarily faster.
`COMPACT_RELEASE` frees the encoded matrix after constructing the reference and
reports the immediate RSS change. Reference and output arrays remain resident.
An inventory processes one calibrated source matrix at a time and checks every
decoded byte; it is not a measurement of the live runtime's exact registration
set or outlier removal.

Each paired repetition alternates the order of four measurements: resident
production kernel, resident candidate kernel, compact/streamed production
kernel, compact/streamed candidate kernel. `compact_radix_s` and
`compact_cpu_s` name the final candidate. Streamed `compact_bytes=0` means no
resident encoded matrix, **not zero process RAM**. Direct-I/O counters prove
actual disk reads. Encoding, cache construction and mask PRG are outside timing.

## Required before runtime integration

* Batch 16 currently regresses; do not apply the candidate indiscriminately.
  The resident production refill cap is 64, whereas the streamed winner uses
  256. A bounded queue and safe producer/consumer lifecycle must be implemented
  and measured. Increasing an environment limit alone is insufficient.
* Measure full-model memory, startup peak, first-token latency, sustained MTP
  inference, eight sessions and storage contention in the exact isolated guest.
  Larger output/pad batches consume RAM and may alter latency.
* Pin/measure oneDNN and OpenSSL in the trusted image. Check oneDNN's JIT and
  threading under the existing isolation policy; do not relax protections to
  accommodate it. The host prototype does not establish this compatibility.
* Keep publisher/model admission, authentication metadata, masks and pad
  lifecycle inside the trusted boundary. Publish no partial pad, reuse no mask,
  and send no mask seed to the untrusted GPU.

The palette, LZ4, Zstd, custom outer-product and alternative register-tiling
experiments are retained as rejected comparisons, not selected defaults.
Matrix timings must not be reported as inference tok/s or as proof that all
24.3 GiB can already be removed from production.
