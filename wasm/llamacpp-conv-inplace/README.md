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
  scenario runs only when named: it aborts on the fork AND on the official
  llamacpp-toolchain tree, with or without the op, because `ensure_slot_alt`
  (`llamacpp-graph-slot.patch`) reserves a 2-8 token single-sequence slot with
  `n_seqs = 1` against a memory context sized for `n_seq_max`;
  `LLAMA_GRAPH_SLOT_ALT=0` makes it complete (`shielded/WRAPUP-27B-INTEGRATION.md`).
- `prod-toolchain-check.sh`: runs inside `ubuntu:22.04` (the toolchain
  runner's OS, stock GCC 11.4 / cmake 3.22), builds the CPU libraries with the
  workflow's CPU-relevant flags, and runs all three harnesses there, plus the
  register-row and streaming-snapshot GATED_DELTA_NET checks below. Executed
  2026-09-23 with both kernels: ALL CHECKS PASSED (GCC 11.4, `-mavx2 -mfma`).

**Token-fused GATED_DELTA_NET: measured negative, not applied**
(`../llamacpp-gdn-tokfuse.patch`, REPORT 18.50). `gdn-equiv.cpp` is its
bitwise harness: 72 op cases (the model's S_v=128 / 48 value heads over 16 key
heads, n_tokens 1-17, K 1-4 including K > n_tokens, in place into a padded
multi-slot cache and the copy form, several sequences, odd shapes, threads
1/3/8, signed zeros, the per-channel gate), every output and the whole state
buffer dumped; run once per `ENCLAVE_GGML_GDN_TOKFUSE` value with `run_pair`
in `harness-check.sh`, the dumps were byte-identical, and a planted one-ulp
mutant changed exactly the 52 fused cases. `gdn-bench.cpp` times the op at the
27B's verify shape; it showed the fused path slower (+20% at 1 thread, +22% at
4 tokens), and the 27B's op profile showed no change, so the patch is kept as
a record only. The tokfuse switch only exists on a tree with that patch.

**Register-row GATED_DELTA_NET** (`../llamacpp-gdn-regrow.patch`, switch
`ENCLAVE_GGML_GDN_REGROW`; REPORT 18.51, 18.53; NOT APPLIED to the official
build, see its header: AVX-512 only and fork-relative). For the scalar gate and
S_v = 128, each state row is loaded once, taken through scale, dot(k), the d*k
update and dot(q) in registers with ggml's own `GGML_F32_VEC` operations in
the vector routines' exact order, and stored once. Evidence on the AVX-512
build: `gdn-equiv` byte-identical with the switch on and off AND identical to
the dump from before the change; a planted one-ulp mutant in the kernel
changed exactly the 52 S_v=128 scalar-gate cases and no other; the 0.8B real
graph (state_size 128, so the path is live) byte-identical on and off.
`gdn-bench` alone at the 27B's shape: ~40% faster at 8 threads for 1 and 2
tokens, ~2x at 1 thread, on AVX-512. **On the production AVX2 build it was ~55%
slower** (116 against 73 us: a row is all 16 ymm registers and spills), so the
kernel now compiles only at 16 floats per vector; on AVX2 the calls run, and
the toolchain check's timing line shows on and off equal. `gdn-bench [N_TOKENS] [THREADS] [ITERS] [K] [NSTATES]`
with NSTATES > 1 rotates per-layer states so they arrive cold, and
`GDN_BENCH_WARM=1` warms each before its (timed) call; that mode is
confounded (the warm-up lets the pool threads sleep and the timed call pays the
wake-up) and is not evidence either way.

**What ships (2026-09-23 wrap-up): none of these kernels.** The official build
is `.github/workflows/llamacpp-toolchain.yml` (LLAMA_COMMIT + its patches, AVX2,
`GGML_NATIVE=OFF`), and every kernel validated here was held against it:
- conv in place (`../llamacpp-conv-inplace.patch`): bit-identical, throughput
  neutral (REPORT 18.42, 18.46): not applied.
- token-fused recurrence (`../llamacpp-gdn-tokfuse.patch`): bit-identical, slower: not applied.
- register row (`../llamacpp-gdn-regrow.patch`): bit-identical, op 10-13% cheaper
  on AVX-512, ~55% slower on AVX2 and compiled out there; fork-relative: not applied.
- streaming-store snapshots (`../llamacpp-gdn-ntsnap.patch`, now diffed against the
  official tree): passed `official-toolchain-check.sh` (bitwise and real graph, GCC
  11.4, AVX2), then EXCLUDED because the 27B verify round got ~5 ms slower through
  the official build (REPORT 18.54).
`official-toolchain-check.sh` is the gate for the next candidate: it rebuilds the
workflow's tree plus the candidate under the workflow's compiler and flags.
`prod-toolchain-check.sh` checks the development FORK under the same compiler.

**Graph-slot multi-sequence check** (`graph-slot-check.sh`, `official-graph-slot-check.sh`;
REPORT 18.55, `shielded/WRAPUP-27B-INTEGRATION.md`). `graph-slot-check.sh BIN MODEL
OUTDIR` runs every `conv-graph-test` scenario (plain, spec, lifetime, multi) with the
KV cache per-sequence and unified (`CONV_TEST_KV_UNIFIED=1`), each with the
small-batch graph slot on and with `LLAMA_GRAPH_SLOT_ALT=0`, through `run_graph`'s
optional scenario argument; every cell must finish with byte-identical logits.
`official-graph-slot-check.sh` runs it on the workflow's tree under GCC 11.4 / AVX2.
Before the reservation fix in `../llamacpp-graph-slot.patch` exactly one cell failed
(multi, per-sequence cache: the slot-on arm aborted); after it all eight pass.

**Streaming-store rollback snapshots** (`../llamacpp-gdn-ntsnap.patch`, switch
`ENCLAVE_GGML_GDN_NTSNAP`; REPORT 18.52-18.54; NOT APPLIED, see above). Evidence on the AVX-512
build: `gdn-equiv` byte-identical on and off and identical to the pre-change
dump (every snapshot slot is in the dump); a mutant in the 512-bit branch
changed 4 cases and one in the 256-bit branch 16, so both streaming paths and
the memcpy fallback are exercised; the 0.8B real graph, whose spec scenario
rolls back and reads the snapshots, byte-identical on and off and identical to
the logits from before either kernel change. Cold-state `gdn-bench` (48 rotating
states, 2 tokens, K = 2), ABBA x3: 120.7-137.9 us on against 151.1-168.0 off.

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
nonzero, zero steps, a one-byte difference, differing step counts, the same for `run_pair`
(an arm exiting nonzero, a one-byte difference, a dump shorter than reported,
zero cases), and a
script that must stop at the first failed check). `conv-graph-test` rejects an
unknown scenario and an unopenable output path before loading a model, and
checks every write and the final close.

**Scope.** The graph test uses the 0.8B model of the same architecture on the
CPU backend. It is evidence for the op's graph and cache integration, not
acceptance on the full 27B shielded workload.
