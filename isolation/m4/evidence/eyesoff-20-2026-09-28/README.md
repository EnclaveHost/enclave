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
