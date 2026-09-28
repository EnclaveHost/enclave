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
