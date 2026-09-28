# Eyesoff generation latency — 2026-09-28

## Diagnosis

Production Eyesoff, model Qwen3.8-27B Q4 with masked V100 offload, generated a
128-token public fixture in 11940 ms (10.7 tok/s), after 1430 ms of prefill at
3781 prompt tokens. Runtime verb timing accounts for 11914.655 ms: 11134.120 ms
in the target decode, 730.757 ms in MTP drafting. Network and app rendering
are not the cause of that decode rate. The previous 21 tok/s guest benchmark
used a 17-token prompt and was not representative of a full tool-enabled chat.

A separate 1545-token no-tools request failed at 1280 prefilled tokens with
`kv_pool_full` even with no other active chat: parked prefixes could consume
the pool without being reclaimed. Baseline evidence is in baseline.json.

## Changes

Explicit CPU fused attention for the measured 27B profile, a CPU-kernel fix to
honor FP32 accumulation, and bounded eviction of unpinned cache entries on
KV allocation pressure. All attention, caches and accumulators remain private
CPU state. Model weights, masking, verification and both GPU workers are
unchanged. The release changes only init, Wasmtime and the CPU backend module.

## Qualification

Eight distinct 224-token requests repeatedly overflow a 512-token pool.
Cache-backed prefill and next-token logits are compared to uncached runs.
A borrowed 160-token prefix is held while five unrelated requests cause
reclamation, then its next-token logits are checked against an uncached run.
Attention (0.5B) and hybrid (0.8B) models pass, with fused attention both off
and on. Cache-append tests also pass with the new CPU backend.

The initial fused-attention candidate with the unchanged CPU kernel FAILED
the pinned-borrower logit comparison (maximum differences 0.31589127 on the
attention model and 0.27517986 on the hybrid). It was staged as e7b70a4b but
never admitted or selected. Inspection found FP16 accumulation despite the
model's FP32 precision request. The corrected kernel passes without relaxing
the 0.02 maximum-logit-difference bound or argmax equality check.

Source/contract checks: 12 passed, seven environment-dependent checks skipped.
Skipped checks are not counted as runtime validation. Full production results
are recorded after deployment below.
