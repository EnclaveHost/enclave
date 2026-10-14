# Authenticated streamed-refill prototype

This is an offline experiment, not a runtime feature. It neither opens a GPU
connection nor reads live application data, mask seeds, or pad banks. None of
these files is included in the production build.

The prototype encodes actual GGUF matrix rows using `sh_prepare_rows_any`, makes
a public disk copy with private SHA-256 block digests, then runs the production
AVX-512 vector-CRT refill kernel on bounded authenticated chunks. The next chunk
is prefetched while the current chunk computes. A failed read/hash/exception
invalidates the entire output, including already computed chunks. Callers must
not publish anything until successful completion. Deterministic masks here are
test fixtures only, never production mask material.

Four readers are available:

* `scalar`: existing `sh_weight_cache` SHA-256 path.
* `openssl`: identical block digest check with CPU-accelerated OpenSSL SHA-256.
* `openssl-direct`: accelerated SHA-256 and aligned `O_DIRECT` reads. Failure to
  open/read directly is fatal; it never silently falls back to cached reads.
* `gmac-direct`: experimental AES-256 GMAC block authentication and direct I/O.
  This changes the cache-authentication design and requires separate review;
  it does not replace SHA-256 model admission. See [COMPACT-REFILL.md](COMPACT-REFILL.md).

The existing project SHA-256 and OpenSSL digests cross-check in the tests. The
OpenSSL dependency is experimental and would need inclusion in any measured
production image. Encrypted pad spooling and a crash-safe producer/consumer
queue are not implemented. This tests the weight-reading and field-product
component, not end-to-end inference or a deployed dealer service.

## Reproduce

Dependencies: Linux x86-64 with AVX-512 VNNI, a C/C++ compiler, Python, OpenSSL
development headers/library, and the project's compatible GGML headers/library.
Use a real NVMe-backed output directory for benchmarks; `/tmp` on this machine
is tmpfs and would give misleading storage results.

```sh
python3 shielded/bench/build-streamed-refill.py /path/on/nvme/streamed-probe
node --test test/shielded-streamed-refill-prototype.test.mjs
python3 shielded/bench/run-streamed-refill.py /path/on/nvme/streamed-probe /path/model.gguf
python3 shielded/bench/run-streamed-refill.py /path/on/nvme/streamed-probe /path/model.gguf --hash openssl-direct --batches 64 256
/path/on/nvme/streamed-probe/bench /path/on/nvme/streamed-probe /path/model.gguf output.weight stream 256 2 openssl-direct
```

The builder accepts `--ggml-src`, `--ggml-lib`, and `--sanitize`. The matrix
runner limits each child to 6 GiB of address space, runs at reduced scheduling
priority, and refuses individual encoded matrices larger than 2 GiB. Its
default four matched pairs alternate resident-first/streamed-first order.
Results go to JSONL. `--resume` skips complete cases after interruption.

The `stream` invocation computes its reference, frees the resident weight
vector, trims allocator caches, reports before/after RSS on stderr, and checks
subsequent streamed products against that reference. It still retains test
reference outputs; RSS is not an estimate of the entire deployed application.

## Scope and safeguards

* Full per-output int64 oracle checks cover small/tail dimensions, output
  strides, batches through 512, and all four reader modes. Large real-model
  outputs are compared element-for-element against resident production-kernel
  results, not merely non-cryptographic checksums.
* Test corruption, truncation after successful earlier chunks, exceptions, and
  sanitizer checks must pass. These establish component behavior, not a proof
  of the whole isolation or masking protocol.
* Disk files are created with `mkstemp`, immediately unlinked, and closed on
  completion. The benchmark writes public encoded weights only. It issues
  `DONTNEED` only for its own file, never global cache drops. Actual disk-read
  counters accompany every timing.
* Model parsing/encoding, initial authentication metadata construction, random
  pad generation, encrypted pad storage, consumption, GPU work, and network
  traffic are outside the timed interval. The encoder uses model values and
  real geometry, but the harness does not reproduce calibrated outlier removal,
  both-card partitioning, MTP scheduling, or the full model graph.
* The benchmark's model file is a local public fixture; this harness is not a
  production model-admission or publisher-catalog verifier. Expected block
  hashes originate in its already constructed reference encoding.
* One compute thread plus at most one read/hash thread is active per streamed
  call. Total process CPU time is measured alongside wall time. Overlapping
  hashing can hide wall latency while still increasing CPU demand.
* Batches above 64 are prototype-only. The current runtime refill setting is
  capped at 64; a deployment needs queue/buffering and recovery work, not merely
  a changed environment variable.

Do not convert matrix timing into inference tokens per second. Qualification
requires the exact measured guest, full model/MTP/pad lifecycle, startup and
first-token latency, sustained inference, eight-session concurrency, total host
RAM including page cache and spool buffers, and storage/CPU contention.
