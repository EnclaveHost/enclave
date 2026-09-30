# Compact-weight layout investigation, 2026-09-30

Historical experiment: **not deployed or production-qualified**.
The subsequent [runtime implementation](shield-compact-layout-runtime-20260930.md)
is staged separately. Production
remains compact64 release `4bb9f020`. This change adds a reproducible experiment;
it does not change the runtime provider, app, scheduler, admission or isolation.

## Candidate

Prearrange each public weight tile into oneDNN's selected integer-matmul layout
at admission, then losslessly compress that layout. A refill decompresses into
the layout the kernel consumes, avoiding its repeated weight packing. Admission
round-trips both the packed bytes and original weights. Private reads reverse
the layout; the three radix-256 products and exact int64 field reduction stay
unchanged. The baseline is the tracked compact provider built with the same
`-O3` settings; production was built with `-O2`.

The experiment compares baseline, prearranged compressed weights, and a cached
matmul primitive retaining the original compressed layout. Matmul plans use
explicit worker-private scratch, bounded to 64 MiB per worker and wiped at
worker exit, including tests with several workers sharing one immutable plan.
Generated classes have separate symbol names so the linker cannot accidentally
merge the two experimental implementations.

This prototype deliberately accepts **batch 64 only**. It is not wired into
production. Before runtime integration it needs small-batch/fallback handling,
whole-model memory accounting (including plan/JIT metadata and scratch), startup
and teardown qualification, upload/reconnect tests, and a full isolated-guest
inference comparison. Tiny matrices may acquire substantial layout padding;
there is no justification for enabling this format unconditionally.

## Measurements and limitations

Use [the evidence](evidence/shield-compact-layout-20260930.json) for final
medians, samples, source/binary hashes and preliminary trials. These are CPU
mask-refill timings, **not application tok/s**.

Final run with worker-private scratch (median wall milliseconds):

| Split matrix | Workers | Current | Prearranged | Less refill time |
| --- | ---: | ---: | ---: | ---: |
| Feed-forward down | 8 | 66.871 | 58.916 | 11.9% |
| Feed-forward gate | 8 | 62.084 | 58.724 | 5.4% |
| Output head | 1 | 351.400 | 335.531 | 4.5% |

An earlier concurrent run showed reductions of 9.2% and 7.1% on the two
feed-forward matrices. The direction repeated; the exact percentage varies.
The final head result is single-worker evidence only. Do not combine these
percentages into a projected model throughput result.

Inputs are selected public Qwen3.8-27B GGUF tensors, encoded using the existing
source encoder and deterministic synthetic masks. Every timed result is compared
to the independent existing vector-CRT kernel. Split experiments use the first
half of each row to match two-card dimensions; they do not reproduce the entire
production calibration/outlier-removal pipeline. No production masks, seeds,
private app data or serving GPU workers are accessed.

Variants rotate order on every repetition. Final feed-forward measurements use
eight persistent workers limited to four host CPUs; output-head measurements use
one worker. The first four repetitions are excluded. These do not model the
whole 16-worker production workload or its contention inside SNP. Production
was left running, so unrelated host activity remains a source of noise.

Preliminary split-tensor compressed payload increases were about 0.68% for the
down projection, 0.23% for the gate and 2.39% for the output head. Those estimates
exclude new oneDNN plan/JIT allocations and cannot be extrapolated to app RAM.
The original-layout primitive preserves compressed payload size but provided
smaller/inconsistent gains. No RAM reservation was changed.

Other trials retained as evidence:

- Batches above 64 improved CPU cost per pad, but require ring/scheduler changes;
  increasing the refill unit alone can produce small urgent refills and stalls.
  No larger ring or batch limit was installed.
- Smaller decompression tiles regressed the down projection under concurrency.
- Using GEMM for batches 1–16 mostly regressed the existing CRT path.
- The first three-variant split-layout run had an experimental helper-symbol
  collision. Its files are marked `odr-invalid` and excluded. Corrected runs
  use unique helper symbols. Earlier two-variant binaries were unaffected.

## Reproduce

Use the existing pinned, W^X-patched oneDNN build and matching GGML headers/libs.
Run from this checkout. Substitute local paths; use a directory on local NVMe.

```sh
python3 shielded/bench/build-compact-layout.py /path/to/offline-layout \
  --onednn-root /path/to/onednn-wx/install \
  --ggml-include /path/to/llama.cpp/ggml/include \
  --ggml-lib /path/to/matching/ggml-libs

# Public model, tensor, workers, repetitions, column split (1 or 2).
# Choose CPUs suitable for the machine; this example limits the experiment.
systemd-run --user --collect --wait --pipe \
  -p CPUAffinity=28-31 -p CPUQuota=400% -p Nice=15 \
  -p MemoryMax=7G -p MemorySwapMax=0 -p RuntimeMaxSec=180 \
  env OMP_NUM_THREADS=1 OMP_DYNAMIC=FALSE \
  /path/to/offline-layout/compact-layout /path/to/public-model.gguf \
  blk.0.ffn_down.weight 8 24 2
```

Build in a separate directory with `--sanitize`, then run its `layout-check`
under the same resource limits, with `ASAN_OPTIONS=detect_leaks=1:abort_on_error=1`
and `UBSAN_OPTIONS=halt_on_error=1`. Do not use the sanitizer binary for timing.
The fixture tests 19 shape cases at batch 64, exact int64 oracles, partial reads,
invalid weights/dimensions/masks, failure wiping, independent and shared-plan
workers, W^X mappings and restoration of OpenMP settings. It explicitly rejects
unsupported batch sizes. Passing these is not a security proof or rollout gate.

Raw experiment files remain under
`/home/steven/enclave-bench/shield-batch-tuning-20260930`.
