# Grouped F16 attention, 2026-09-28

The 27B model has several query heads per K/V head. The CPU path previously
called the same F16 GEMM separately for each query head. For two to four token
batches, combine adjacent heads sharing K/V into one GEMM. The conversion
already packs their columns contiguously. Output stride/type/ISA guards keep
other layouts on the existing path. Single-token and large prefill paths are
unchanged. Each output keeps the existing eight-lane accumulator and reduction.

Build with `build-shielded-engine.py --grouped-attn` alongside the accepted
active-KV-extent/shared-CPU-pool/small-graph recipe. Setting
`ENCLAVE_GGML_GROUPED_ATTN=0` selects the reference path for qualification.
The production candidate replaces only `template/rt/backends/libggml-cpu.so`
in the accepted `1d2263e6` release. The final CPU artifact comes from a clean
pinned recipe; initial and final artifact measurements are recorded separately.
GPU masks, verification, MTP settings, model, tools, cache capacity and session
limits are unchanged.

## Qualification

Complete KQ/softmax/V output bytes match in all tested cases: 1–4 decode tokens,
4096/4352/8192 KV rows, and 64-token prefill. Three alternating-mode repetitions
on the initial artifact showed two-token attention time falling from
14.186 to 10.903 ms (4096 rows) and 14.903 to 11.161 ms (4352 rows).
The final clean-build artifact repeated all shape checks with identical output.
These component timings do not establish application throughput.

The full hybrid-model fixture keeps eight resident sessions, branches to
sixteen, rewinds speculative tokens and recycles slots. Grouping on/off gives
699,269,120 identical output bytes, SHA-256
`603649f6f9c6ac3bbab78bd0bc01a8455fdd6ca9ea8417608e2f7ad81276ad64`.
Run `test-grouped-attention.py --runtime RT --model GGUF --out NEW_DIR`.


Candidate release: `f7fae72afbddbcb3f8b29782f34ae2ce49410a0a53ad6a6d7bb5a3b988270e43`.
Predicted measurement:
`6cff32476213637c622f031a11fe4a8d46f2d12b923b3160a516f2be4e7e953a9be941edaec810219dd7efce101bd15a`.
Production performance qualification follows separately.
