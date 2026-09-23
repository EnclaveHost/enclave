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
