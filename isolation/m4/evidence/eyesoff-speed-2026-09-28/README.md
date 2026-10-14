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

## Changes and rejected experiment

Parked-cache pressure now reclaims unpinned cached prefixes instead of failing
an otherwise admissible decode. Eight active sessions remain supported.

Explicit CPU fused attention was trialed in e182e690. It passed the corrected
FP32 numerical tests but regressed the same uncontended 3781-token workload
from 10.7 to **6.0 tok/s** (21261 ms for 128 tokens, zero decode-gate wait).
Two earlier runs overlapped a user's chat and are not fair performance
comparisons. e182e690 was rolled back to 9958ac99; explicit fused attention
is removed. The FP32 kernel fix remains for configurations that select it.

The replacement c9fdc728 extends recurrent-state in-place updates to one
active sequence inside a multislotted cache. Previously the fast path required
cache size one, excluding production's eight active plus eight parked slots.
The new guard requires source row == destination head; COW branches, rollback
snapshots and multi-sequence batches keep their copies. The view uses the
actual head offset and graph reuse checks that head and the guard.

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

## Multi-slot recurrent qualification

`test-rs-multislot.py` / `rs-multislot.cpp`: eight resident sessions branch into
sixteen, diverge, alternate nonzero heads, rewind speculative tokens, resume
and recycle slots. All full logits are **bit-identical** to aliasing disabled
(max difference 0). Audit: 168 aliased / 24 copied builds, zero violations.

Cache pressure and append tests also pass with rollback depth one and the
new multi-slot alias on both attention and hybrid models. The complete engine
patch recipe applies to its pinned source; changed files match the incremental
build source exactly. GPU workers, masking and private-state boundaries are
unchanged.

## Automatic attention was not sufficient

The c9fdc728 cold run took 347187 ms prefill and 19837 ms decode (6.5 tok/s);
its cached repeat took 2 ms prefill and 20684 ms decode (6.2 tok/s), both without
decode-gate contention. Removing the explicit ON setting did **not** restore
performance. These are rejected performance results, not an improvement.

The next candidate e95d2d79 explicitly sets attention OFF and batch/ubatch 64,
which Eyesoff reads from host capabilities. Wide-batch logits match physical
batch 16 exactly across the resident/branch/rewind test; both 64-token
cache-pressure tests pass. Public-model fixtures only; no user chat/config
contents are included in these artifacts.

MTP qualification: 43-token prefill, 32 generated tokens, sequence 13 of 16,
batch/ubatch 64, explicit attention OFF. Speculative and plain greedy text
are identical; 13/19 draft proposals accepted; zero observation failures.
Small-model CPU timings are correctness diagnostics, not 27B speed claims.

Rollout note: repeated direct guest-manager DELETEs were counted by the
supervisor as app deaths. The fourth hit released the lease and caused a
five-minute backoff, so the first e95d2d79 instance could not receive secrets.
The scheduler reaped it and reclaimed the deployment at 09:49:55 UTC, with
a fresh lease until 10:19:53 UTC. Use the owner-authorized deployment restart
endpoint for planned future restarts; it resets the crash budget. The five
other guests, control VM and GPU workers remained running.


## Final deployed result

Release **e95d2d79d1c1ca4c005b33c852d8d0810b08064896269ab2e14d8c9c2a4592b6**
is running in Eyesoff, with fresh public TLS and AMD attestation verified.
`final-performance.json` records the actual browser API timing frames for a
3,781-token prompt with the normal tool definitions included.

The original cached sample delivered **10.7 tok/s**. Final cached samples
were **13.3, 12.3 and 13.0 tok/s**, with **1 ms prefill** each. The last two
ran with the browser automation controller stopped. Their similar results
mean no causal controller-related speed improvement is claimed.

An actual appended conversation turn (3,942 prompt tokens, 161 more than
the original) took **7.04 seconds prefill**, demonstrating prefix reuse on
an appended turn rather than only an identical request. Its 98-token
completion used thinking disabled and is not a controlled decode comparison.

Cold first prefill still took **246.38 seconds**, followed by 11.2 tok/s
decode. There is no comparable original cold baseline, so no cold speedup
is claimed. The remaining cold latency is substantial. Earlier native
short-prompt results should not be presented as real tool-enabled chat speed.

The final profile preserves eight active sessions, parked-prefix caching,
masking and isolation. Cache-pressure retries, multi-slot recurrent updates,
and 64-token physical batches passed the qualification above. Control-VM
and GPU-worker process start ticks are unchanged. Temporary benchmark
localStorage data was removed after collecting the results.

Final check at 10:13 UTC: all six guests running and attested; all six public app health endpoints returned HTTP 200 with fresh attestation verification. See `final-*-health.json`.
