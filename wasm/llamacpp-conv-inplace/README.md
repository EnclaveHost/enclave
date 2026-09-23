# ggml_ssm_conv_state equivalence harnesses

Both compare the fused op against the graph it replaces (concat + ssm_conv +
per-slot copies) bit for bit, on the CPU backend of a llama.cpp tree carrying
`../llamacpp-rs-inplace.patch` and `../llamacpp-conv-inplace.patch`.

- `conv-equiv.cpp`: single calls at the 27B shape (10240 channels, d_conv 4),
  n_t 1/2/3/17/70, K 1/2, 1 and 8 threads, signed-zero inputs, a scalar tail.
- `conv-equiv2.cpp`: sequences of calls on one simulated recurrent cache --
  several sequences at a nonzero cache head with the snapshot stride past the
  active state, K > n_t, rollback/resume interleaving the fused path with the
  fallback (reference) path, the n_t 64/65 vector/scalar boundary, and widths
  d_conv 2/3/5/16. Every call compares the output and the whole cache.

Build against the tree's libraries:

    g++ -O2 -std=c++17 -I$LLAMA/ggml/include -o conv-equiv2 conv-equiv2.cpp \
        -L$BUILD/bin -lggml-cpu -lggml-base -Wl,-rpath,$BUILD/bin

The equivalence is a property of the BUILD (the reference loop's rounding is
the compiler's): it was established with GCC 16.2.1, `-O3 -mfma -mavx2
-mavx512f -mavx512vl -mavx512dq -mavx512bw -mavx512vbmi -mavx512vnni
-mavx512bf16`, GNU-mode default `-ffp-contract=fast`. Rerun both harnesses on
any other compiler or flags before trusting the op there.

- `conv-graph-test.cpp`: the REAL llama graph path (CPU backend, the 0.8B
  qwen35 model): plain decode, the speculative verify/rollback/resume pattern
  with `n_rs_seq=1`, and cache lifetime (clear, full `seq_rm`, re-prefill,
  alternating ubatch sizes). Run once with `ENCLAVE_GGML_CONV_INPLACE=1` and
  once with `=0`; the two logit dumps must be byte-identical. The multi-sequence
  scenario runs only when named: this fork aborts in context creation for
  `n_seq_max > 1` with or without the op (a pre-existing limitation).
- `prod-toolchain-check.sh`: runs inside `ubuntu:22.04` (the toolchain
  runner's OS, stock GCC 11.4 / cmake 3.22), builds the CPU libraries with the
  workflow's CPU-relevant flags, and runs all three harnesses there.

Validated on two builds, both bit-identical: GCC 16.2.1 with AVX-512 (the
vector path), and GCC 11.4 with the production workflow's flags, which are
AVX2 + FMA only, so production compiles the vector path out and runs the
scalar path. Validation is not deployment: the patch is not wired into
`.github/workflows/llamacpp-toolchain.yml`.

**Fail-closed checking.** `harness-check.sh` runs each harness exactly once,
requires its exit status AND its exact pass line, and for the graph test
requires both arms to finish with the same nonzero step/row/byte counts and
byte-identical dumps; `prod-toolchain-check.sh` sources it under
`set -euo pipefail`. `selftest-harness-check.sh` demonstrates that with stub
harnesses (a pass line with exit 1, no pass line, a signal, an arm exiting
nonzero, zero steps, a one-byte difference, differing step counts, and a
script that must stop at the first failed check). `conv-graph-test` rejects an
unknown scenario and an unopenable output path before loading a model, and
checks every write and the final close.

**Scope.** The graph test uses the 0.8B model of the same architecture on the
CPU backend. It is evidence for the op's graph and cache integration, not
acceptance on the full 27B shielded workload.
