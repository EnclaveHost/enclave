# Recurrent CPU locality and snapshot copies

`llamacpp-gdn-locality-snapshot.patch` applies after `llamacpp-rs-inplace.patch`
to the pinned llama.cpp tree. It adds two independent options, both disabled
unless their environment variable is exactly `1`:

- `ENCLAVE_GGML_GDN_ROW_LOCALITY`: for scalar gates, finish scaling, dot(k),
  updating and dot(q) on each state row before visiting the next row. It uses
  the same vector functions and arithmetic order within each row. Per-channel
  gates keep the original path. This works with the production AVX2 engine;
  it is separate from the experimental AVX-512 register-row implementation.
- `ENCLAVE_GGML_GDN_NTSNAP`: copy aligned rollback snapshots with streaming
  stores, followed by a store fence before each thread chunk returns. This
  avoids loading the destination into cache merely to overwrite it. Unaligned
  destinations and unsupported architectures retain `memcpy`.

Neither option changes recurrent-state layout, rollback semantics, model
weights, GPU masking, verification, or the isolation boundary. No additional
floating-point reassociation or reduced precision is introduced.

Run the equivalence check against a build with the patch applied:

```sh
python3 scripts/test-gdn-locality.py --source /path/to/llama.cpp \
  --library-dir /path/to/build/bin --output /tmp/gdn-check
```

The existing recurrent-op fixture checks 72 cases per configuration, covering
scalar/per-channel gates, odd sizes, grouped heads, multiple sequences, signed
zeros, thread counts 1/3/8, both state layouts, and all rollback slots including
padding and untouched older slots. It compares the full 448,983,256-byte dump
for off, row-only, snapshot-only, and both. Logs and checksums are retained;
large temporary dumps are removed. This experimental patch is not applied by
the production toolchain workflow: the kernel gain did not improve the longer
27B MTP guest runs.

Kernel timings alone are not inference throughput. Production enablement must
also qualify the measured runtime with full-model token comparisons and
attestation, including a longer generation than the former 128-token probe.
