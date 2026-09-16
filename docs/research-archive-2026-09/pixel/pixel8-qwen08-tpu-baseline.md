**Update: full speculative generation now repeats at12.63tok/s**, with identical reference output. Earlier target-only rates below are a different metric. [Latest measured result](pixel8-tpu-mtp.md).

# Pixel 8 Pro: Qwen3.5 0.8B TPU baseline

**Latest verified prototype: 10.50 generated tok/s across six warmed trials**, versus9.74 for the same-binary120-call control. QKV/gate fusion reduces calls to102 per decoded token, with identical output and unchanged logical arithmetic. The repeated comparison shows a descriptive7.9% gain. A later executor compatibility check peaked at10.93; this is not a sustained-rate estimate. [Latest fusion evidence](pixel8-qkvgate-fusion.md). All results below exclude Shielded, pads and pVM overhead and retain CPU work for unclaimed operators.

The first plain TPU-accelerated full-generation prototype measured **4.20-4.47 generated tokens/s** (combined **4.33 tokens/s**). This is without Enclave Shielded or a protected VM. It uses NNAPI pinned to `google-edgetpu` for 150 projection matmuls per one-token decode. Prefill, nonlinear/attention/state operators, small projections, and the large vocabulary head remain on the CPU. This is not a fully TPU-resident model or a mature optimized TPU ceiling.

| Trial | Generated tokens / decode calls | Decode wall | Generated tok/s | One-token decode calls/s | NNAPI compute wall |
|---|---:|---:|---:|---:|---:|
| 1 | 64 / 63 | 14.328130 s | 4.466738 | 4.396945 | 10.075463 s |
| 2 | 64 / 63 | 15.250543 s | 4.196572 | 4.131000 | 10.889622 s |

Both runs produced identical, coherent token sequences, also matching the first 64 tokens of the earlier CPU control. Each made 9,450 successful NNAPI calls, with no new compilation during timing and zero backend errors. The first token comes from separately timed prefill (1.373659 / 0.950261 s); both rate conventions are shown to avoid counting it as a one-token decode.

The average NNAPI invocation took 1.066 / 1.152 ms. NNAPI compute wall accounted for 70.3% / 71.4% of decode wall; backend totals were 10.501413 / 11.293931 s and contain that compute time, so these durations must not be summed. Those invocation times include driver/API work and do not isolate physical TPU arithmetic.

Cold warmup took 89.265091 s, including 80.721019 s of compilation. Retained FP32 weight constants totalled 1,988,100,096 bytes; this excludes driver/compiler allocations and the other model/CPU state. The whole device cycle including cleanup was 124.346357 s. No benchmark process remained.

The exact existing 833,592,736-byte Q8_0 GGUF was used: SHA256 `c54f8b67069c70085b98440de696b44da8250250ac69a961b41133def876e262`. Q8_0 weights are dequantized once into FP32 NNAPI constants; relaxed FP32 execution is enabled because strict FP32 FC was unsupported. This does not establish full model accuracy or eligibility for Shielded's integer arithmetic. Warmup sampled eight real floating-point dot products per weight; generated-text agreement is a smoke check, not a quality evaluation.

Recipe: plain sky/rain prompt (20 tokens), greedy, MTP off, context 1024, four CPU threads for remaining operations, one model/context with KV state cleared between repetitions, clean pinned llama.cpp `ddd4ec1428a6201e18975ea52b07c71e0f9aef26`, original no-repack CPU buffers. NNAPI compilation explicitly selects only `google-edgetpu`; no NNAPI reference device is requested. Physical driver internals were not independently profiled.

Evidence: [root validation](../work/pixel8-plain-tpu-root-1/first2/root-validation.json), [receipt](../work/pixel8-plain-tpu-root-1/first2/receipt.json), [manifest](../work/pixel8-plain-tpu-root-1/manifest.json), [stdout](../work/pixel8-plain-tpu-root-1/first2/inference.stdout), [stderr](../work/pixel8-plain-tpu-root-1/first2/inference.stderr).

## Burst execution follow-up

The next run using `PLAIN_NNAPI_BURST=1` measured **7.527997 / 6.751712 generated tok/s** (combined **7.118753**). Both 64-token outputs exactly match the original run. Every model handle logged burst mode; each trial again made 9,450 NNAPI calls with zero errors and no timed compilation. The device cycle closed cleanly in 105.670041 s.

NNAPI compute wall was 7.306062 / 8.098594 s inside decode wall 8.501598 / 9.479078 s. CPU prefill also improved to 0.361122 / 0.205056 s, so the entire difference cannot yet be attributed to burst execution. The same-binary ordinary-compute control subsequently measured **8.910344 / 7.214400 generated tok/s** (combined **7.973186**), with identical outputs and clean timing/call guards. Consequently, burst execution has **not demonstrated a speedup**. The initial 4.20-4.47 result was not representative of the later warmer measurements; the reason for this variability is not established. Best observed at this stage: **8.91 generated tok/s** (8.77 one-token decode calls/s), still without Shielded and still a hybrid TPU/CPU prototype.

[Ordinary-compute control](../work/pixel8-plain-tpu-burst-root-1/control0/root-validation.json), [control receipt](../work/pixel8-plain-tpu-burst-root-1/control0/receipt.json).

[Validated burst result](../work/pixel8-plain-tpu-burst-root-1/first/root-validation.json), [full summary](../work/pixel8-plain-tpu-burst-root-1/first/summary.json), [receipt](../work/pixel8-plain-tpu-burst-root-1/first/receipt.json).


## Resident-context comparison and graph audit

A single-process `0110` comparison (ordinary, burst, burst, ordinary) warmed both modes, kept the same compiled weights/context, then produced **9.064063, 7.034236, 5.926253, 4.851748 generated tok/s**. Every 64-token output matched. Combined ordinary 6.320372 versus burst 6.432884 tok/s is only descriptive: substantial within-process slowdown prevents a clear causal speedup claim. The 9.06 peak is not a sustained-rate estimate. Whole device cycle: 126.414837 s, clean process exit.

The after-run thermal-service snapshot reported overall thermal status 0. It does not establish what caused the slowdown, and it was not sampled during each trial. No governor, cooling, priority, or production setting was changed.

The cold-path graph audit covered all 150 distinct weight matrices across 120 NNAPI backend graphs. It found 30 co-resident pairs with the same activation and compatible shapes: 24 FFN gate/up pairs and six attention key/value pairs. Concatenating those pairs could reduce calls from 150 to 120 per decoded token. This is verified grouping eligibility, not an implemented speed gain. The qkv/gate and q/k/v source-level grouping estimates were too broad because CPU graph splits separate some of those operations.

[Resident comparison](../work/pixel8-plain-tpu-abba-root-1/first/root-validation.json), [validated graph audit](../work/pixel8-plain-tpu-abba-root-1/first/fusion-summary.json), [run receipt](../work/pixel8-plain-tpu-abba-root-1/first/receipt.json).

## Projection fusion implemented

The experimental backend now combines the 30 measured same-input pairs into single fully connected calls. Full inference completed three 64-token repetitions at **10.249180, 9.687238, and 8.920970 generated tok/s** (combined **9.587948**). All output token IDs match every prior unfused run. Every decoded token still computes 150 logical projections and 497,025,024 offloaded MACs, now through **120 NNAPI calls**. There were 120 compiled FC models covering all 150 distinct weights, with 30 fused pairs; retained FP32 weight bytes remain unchanged. No timing-phase compilation or backend errors occurred.

The whole device cycle closed in 102.012713 s. The same-binary `PLAIN_NNAPI_FUSE=0` control closed cleanly in 106.442991 s at **9.025121, 8.332457, and 7.523357 generated tok/s** (combined **8.247789**). All six token files match exactly; model, prompt and binary hashes match. The combined difference is **16.248710%**, descriptive of this pair, with within-run slowdown in both modes. The reverse-order replication below did not confirm that initial gain. [Matched comparison and exact token hashes](../work/pixel8-plain-tpu-fused-root-1/fusion-pair-validation.json), [control summary](../work/pixel8-plain-tpu-fused-root-1/control0/summary.json). The fusion option defaults off and exists only in the isolated experimental backend; production Shielded and the protected VM have not changed.

[Fused validation](../work/pixel8-plain-tpu-fused-root-1/first/root-validation.json), [receipt](../work/pixel8-plain-tpu-fused-root-1/first/receipt.json), [source and binary manifest](../work/pixel8-plain-tpu-fused-root-1/manifest.json).


## Reverse-order replication

The unchanged binary ran ON/OFF/OFF/ON in four separate processes, three 64-token trials per process. Repeated OFF measured **9.134379 / 8.660564 / 8.021455** (combined **8.581037**); repeated ON measured **8.513226 / 7.842184 / 7.334378** (combined **7.867325**). Both cycles closed cleanly in 104.936801 / 105.587699 seconds. All twelve token files match, binary/prompt hashes match, and every trial passed exact projection/MAC/call coverage with zero errors or timed compilation.

Across both pairs, ON **8.642833** versus OFF **8.411113 generated tok/s** is a descriptive **2.754923%** difference. The original 16% gain is not confirmed by reverse-order replication. Call reduction from 150 to 120 is established; stable throughput improvement remains unresolved. Next diagnostic: per-FC invocation wall and CPU time during measured phases. [All four validated runs](../work/pixel8-plain-tpu-fused-root-1/fusion-repeat-validation.json).


## Detailed invocation profile

A separate instrumented capture completed in 102.319080 s at **10.116770 / 9.207290 / 8.413409 generated tok/s** (combined **9.193619**), with identical output. Per-FC timings reconcile exactly with global counters. Trial 1 consumed **20.607142 process CPU-seconds in 6.326130 wall seconds**, versus **1.698493 main-thread CPU-seconds**. This motivates testing idle worker polling; it does not by itself identify the worker threads or prove the cause of delay. [Full profile and top ten FC costs](pixel8-plain-tpu-profile.md).


## CPU polling experiment

With otherwise identical binaries and settings, poll0 produced **6.342124 / 5.942576 / 5.982465 generated tok/s** (combined **6.083857**). Restoring poll50 produced **10.044808 / 9.634249 / 8.906283** (combined **9.504783**). All six output hashes match, every trial passed the same120calls/150logical projections/MAC guards, and no timed compilation or backend errors occurred. Cycles closed in114.311049 and100.528210 s.

Poll0 lowered aggregate CPU use but increased main-thread CPU time and whole inference wall. It is **not adopted**; the original poll50 remains the recipe. This result rejects the proposed setting, rather than proving a specific scheduler or hardware cause. [Same-binary comparison](../work/pixel8-plain-tpu-poll-root-1/poll-pair-validation.json).


## Compilation caching

A populated cache reduced full test cycles from **105.32 to 29.18 seconds**; NNAPI compile/load dropped from **72.71 to 2.88 seconds**, with all output tokens and cache keys matching. Decode remained approximately10tok/s. This is a startup/test-cycle improvement. [Measured cache result](pixel8-nnapi-cache.md).


## Additional QKV/gate fusion

The graph-expansion change passed repeated warmed comparisons at **10.503562 versus9.737665 generated tok/s**, with identical outputs across all twelve trials, unchanged150logical projections/MACs, and102 rather than120NNAPIcalls per decoded token. [Implementation and full measured comparison](pixel8-qkvgate-fusion.md).


## Shared-weight executor compatibility

The new M1/M2 executor retained the existing single-row full inference behavior at **10.62 generated tok/s** across three trials, with identical outputs and102 unchanged cache keys, no timed compilation or errors. This is not a causal improvement claim over the repeated10.50 result. Its separate public two-row arithmetic probe passed68,992 exact comparisons. A later teacher-forced M2 target test reached 18.43 and 18.12 target rows/s with matching predictions; this excludes drafting and is not a generation result. [Batched executor evidence](pixel8-tpu-batching.md).
