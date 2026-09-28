# Eyesoff 20 tok/s investigation, 2026-09-28

Target remains unmet. The same synthetic tool-enabled 3,781-token prompt reached
13.6 tok/s for 128 output tokens and 14.2 tok/s for 384, with 1 ms cached prefill.
Neither had decode-gate waiting. Baseline recovery build cached128 was 12.6 tok/s.
The cold candidate overlapped compilation and is not a controlled speed comparison.

The optional active-KV extent patch excludes only trailing attention-cache rows
owned exclusively by other sequences. Physical indices, shared prefixes, holes,
rollback and 256-row padding remain unchanged. The 0.8B hybrid qualification
branches eight sessions into sixteen, diverges, rewinds and recycles cells.
Complete output logits are bit-identical; the diagnostic confirms tail trimming
actually executed. Build with --active-kv-extent, validate with test-kv-active-extent.py.

The diagnostic backend snapshot is a fixed versioned array of aggregate counters
and times, with no tensor data, prompts or logs. It never waits for a busy graph.
The split reconnect fixture checks short buffers, empty/loaded snapshots and busy
pool rejection, along with both disconnect/retry cases and identical outputs.
An optional Wasmtime patch adds the array as x-enclave-shield-performance only
when the measured runtime enables ENCLAVE_SHIELD_PERF_HEADER=1 AND the request
asks x-enclave-performance: 1. A local real Eyesoff component /ping test confirmed
24 numeric counters, no header without opt-in or with an invalid opt-in, and no
header when the runtime setting is disabled. Local fixture processes were stopped.
Counter times across cards overlap and MUST NOT be summed as request wall time.

Production's normal quiet stdout/stderr policy remains intact. Diagnostics do not
export arbitrary strings or private engine logs. These counters are diagnostic,
not security evidence or a replacement for independent image/AMD attestation.

## CPU diagnosis

The opt-in Shield trace measured a cached 128-token run at 12.7 tok/s (10.074 s),
with 3,781 prompt tokens and 1 ms cached prefill. No decode-gate wait, no missing
pads, no request-path refill and zero local product fallbacks were recorded.
Shield graph time was 4.043 s. Model decode plus drafting was 10.002 s, leaving
approximately 5.96 s outside Shield graph accounting. This motivated CPU operation
timing rather than more mask-generation tuning. Card/link sub-times overlap.

The next diagnostic patch adds opt-in CPU operation and graph timing counters.
It preserves existing barriers and all arithmetic. Each CPU operation includes
its existing barrier; the last operation is recorded after the existing final
barrier. Fused operations are charged to the first op. Quantized MUL_MAT has its
own bucket; max output dimensions contain shape metadata only. Profile on/off
and the original engine produced byte-identical full-logit fixtures (eight
resident sessions, sixteen branches, rewind, divergence, slot recycling).
Counters are atomic but a cross-bucket snapshot is not a transaction; collect
between requests and compare deltas. Diagnostic timing overhead is not treated
as a performance gain. Build with --cpu-profile and enable only via the measured
ENCLAVE_GGML_CPU_PROFILE=1 environment.

The CPU-profile run measured 11.6 tok/s on the cached 3,781-token prompt.
24,783 CPU graphs consumed 6.397 s; recorded operations consumed 3.356 s.
About 3.04 s was outside the recorded CPU operations. Attention matrix products
were 1.667 s and softmax 0.302 s. Shield graphs consumed 4.191 s.
The opt-in small-graph patch tests a one-thread plan for bounded linear F32
islands only; matrix products, recurrent updates and larger work retain their
existing plans. The fixture compares complete outputs byte-for-byte and checks
that larger graphs retain six-thread dispatch. No production speed gain claimed
until measured through the app.

## Persistent native CPU team candidate

Small-graph dispatch reached 15.5 tok/s for cached128, 14.2 for cached384,
and 14.4 on a later cached128 repeat. The first comparison also had a shorter
attention-cache extent (4096 versus 5376 rows), so the total gain is not solely
a dispatch effect. Moving the GPU workers to host CPUs 18/20 reached 14.6 and
was reverted. F32 attention-cache microbenchmarks were slower than F16 and were
not deployed.

The next opt-in candidate builds the CPU plugin with OpenMP disabled and shares
native worker teams by thread count across CPU backends in the same process.
A mutex serializes use of their graph/scratch metadata, including stored graph
plans. Explicit caller-owned pools retain their existing behavior and ownership.
Each worker checks its measured CPU placement before a graph because the GPU
backend may move idle threads. Inactive workers keep polling across one-thread
islands, then fall back to the existing bounded wait policy when idle.

Build with --shared-cpu-pool; enable ENCLAVE_GGML_SHARED_CPU_POOL=1 and provide
SHIELDED_CPU_COMPUTE. The candidate disables ENCLAVE_GGML_SMALL_GRAPH: cheap
parallel dispatch changes that tradeoff. Its runtime keeps the prior GPU backend
and all other modules unchanged. The complete 699,269,120-byte hybrid-model
logit fixture is identical to the accepted engine through sixteen branches,
divergence, rewind and recycling. Eight concurrent callers reuse five helper
threads; stored/direct graphs agree with a one-thread reference. The fixture
also checks repair after an affinity sweep and external pool lifetime.

These are correctness/qualification results, not a production speed claim.
The 20 tok/s target remains unmet pending actual app measurements.

### Shared CPU pool caller affinity correction

The first production `fb81c249` request timed out before generation. The native
pool left its async caller pinned to CPU 0 after each graph; model-registration
threads created next inherited that one-core mask. Preserve and restore the
caller mask around the CPU island, while helpers retain their compute placement.
The regression fails with the preceding binary and passes with the fix for both
direct and stored graph plans across eight callers. All 699,269,120 reference
logit bytes remain identical. Candidate `e53c01ae` is not yet speed-qualified.

### CPU/GPU caller handoff

`fb81c249` reached cached128 18.9 tok/s and cached384 18.7 tok/s on the
3,781-token prompt. Worker placement on CPUs 18/20 gave 18.6 and was restored.
The caller-affinity correction `e53c01ae` fixed startup but sustained384
regressed to 14.2: CPU graph time was 13.268 s, with roughly 5 s outside CPU
operations. The GPU only placed an async caller once per 256 graphs, so a
caller arriving on the background mask migrated on each CPU island.

Place card 0's active caller on every GPU graph while retaining the full
background sweep every 256 graphs. The real split-worker reconnect fixture
now moves the caller off its designated core between graphs and asserts its
placement is repaired; verified outputs and idle/mid-product recovery pass.
No field arithmetic, masks, pad lifetime or verification rules change.

The wider CPU vector candidate is not deployed: 17/704 top-1 reference rows
changed and maximum absolute logit difference was 0.458. Pair-dot prototypes
showed no clear gain; native small-graph serialization was slower.

## Quiet measured native-worker profile

The per-graph GPU caller-placement correction restored cached128 to 18.5 tok/s
(6.906 s) and cached384 to 17.8 tok/s (21.542 s), with the same 3,781-token
prompt and 1 ms cached prefill. CPU graph time for cached128 was 2.890 s.
The 20 tok/s app target remains unmet; the historical 25 tok/s engine benchmark
used a 17-token prompt and is not an end-to-end Eyesoff result.

`build-shielded-engine.py --shared-cpu-pool` now emits the measured capability
marker `shield-native-cpu-pool.enabled`; rebuilding without that flag removes
an inherited marker. Official init enables the native pool only for the large
model when that marker is present. Existing OpenMP releases keep their profile.
The regular init leaves aggregate diagnostic timers and performance headers
unset. The quiet candidate differs from the verified caller-placement release
only in init and that marker; all inference libraries are identical. Performance
qualification is recorded separately after the production test.

The quiet release `1d2263e6` passed independent image prediction, fresh AMD
attestation and normal public WebPKI validation. Cold128 measured 17.3 tok/s;
cached128 measured 18.2 tok/s. Removing diagnostics did not establish a speed
gain. An identically configured longer request unexpectedly rendered a
2,894-token prompt and took a routing path, so it is not a comparable baseline.
The following 3,781-token cached request measured 15.3 tok/s (1 ms prefill).
Cache occupancy/physical placement after mixed requests is a hypothesis for
that drop, not yet verified. Moving only guest vCPU7 from host CPU7 to CPU24
measured 15.0 and was restored to CPU7. All five other guests, both GPU workers
and the control VM remained running. No scratch attention-kernel prototype
was deployed. The owner's draft-threshold update is still waiting for a wallet
signature; no config change is assumed. The production target remains unmet.
