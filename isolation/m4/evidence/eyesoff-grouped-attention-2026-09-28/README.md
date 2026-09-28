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

Additional, undeployed experiments: pairing independent AVX2 accumulators in AVX-512 registers preserved output but did not consistently improve two-token attention. Increasing the CPU pool to seven/eight workers gave small component-level gains, but was not selected because it consumes cores used by helpers/background work and has not established an application gain. The production pool remains six workers.

## Production trial

Deployed candidate `f7fae72a` as Eyesoff guest `gde2460f71`. Fresh AMD
attestation and normal public WebPKI passed. The other five original guests
remained running. MTP stays enabled (k=1, p_min=0); both V100s retain SM1380.

Identical full-tool request, 3781 prompt tokens, 384 generated tokens:
before warmed decode 21311/21635 ms (18.0/17.7 tok/s); after 21293/21028 ms
(18.0/18.3). Aggregate 17.883 -> 18.147 tok/s, only
1.48% higher, too small to claim a clear sustained gain from this
short trial. All six generated texts have the same SHA-256. No after-run
tool notices/errors. Cold candidate prefill 247808 ms is separate from its
21941 ms decode. Before the change, the first idle request reused its prompt
in 1 ms but spent 38914460 us drafting/reconnecting (6.4 tok/s overall decode).
The idle reconnect penalty is not fixed by this change. **The 20 tok/s
production goal is not met.**

Larger attention teams improve the isolated kernel but previous whole-model
results (`shielded/REPORT.md`, sections16.8/18.14) show refill starvation when
compute consumes its cores. The twelve-worker profile was not deployed.
A whole-row F16 conversion prototype also showed no consistent two-token
gain and remains undeployed.

Smaller static GEMM tiles with per-worker ownership preserved every tested output but showed mixed results: 4096-row two-token attention 11.505 -> 11.132 ms, 4352-row attention 11.895 -> 13.276 ms. This synchronization prototype was not deployed.

Final repeat, after all competing microbenchmarks stopped: 384-token runs
20948/20967/21060 ms, reported 18.3/18.3/18.2 tok/s, all 1 ms cached
prefill and identical output hashes. This is a modest improvement, not a
20 tok/s result. The qualified grouped-attention release remains deployed;
no other experimental variant was promoted.
