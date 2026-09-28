# Eyesoff prompt-cache rollout — 2026-09-28

Deployment `0x9eb4e60063aa079cebed355f96b2d049457ae77bdbcd49086040282e1e4b871c` (`eyesoff-ai:1.0.66`).

## Cause and correction

The prior Shield runtime used an older GGML backend from the benchmark source tree. It freed each sequence after a request and lacked the current repository's prompt declarations, parked-prefix reuse and shared-warmup protocol. The app already sent those declarations. Session-count changes alone did not preserve state.

`build-shielded-wasmtime.py` refreshes the two complete GGML source modules from the tracked `wasmtime-nn-ggml.patch`, then builds the GGML-only Wasmtime runtime with its existing HTTP and isolation patches. The checked recipe reproduced the candidate binary byte-for-byte. The release builder rejects stale runtimes without cache protocol markers.

The large-model startup profile enables six conversation-cache slots and two shared-prefix slots alongside eight active inference slots. These total 16 sequence IDs, matching the existing physical/logical batch limit. A first candidate with eight conversation-cache slots (18 total IDs) failed a local model test on the engine's output-allocation assertion; it was never selected by guestd or launched for Eyesoff and its temporary predictor/admission pin was removed. The small model retains caching disabled.

Cached state stays in the same app's private guest RAM. It survives HTTP requests, not guest restarts. Exact token-prefix matching chooses a reusable state and appended tokens are evaluated from there. No persistent cache, host-memory export, GPU-worker change or ring recreation was added. Runtime identity `cache: none` refers to executable/JIT artifact caching, not inference KV state.

## Release and rollout

Final release `9958ac99a4492bc9cf5d3b598dd6a7e4b04d27c99d7f7526b6ccc7042f4c5724`; expected measurement `d701c9893a20609849b302545cd525baaa3d279dc85fb5e9e72407be60851f91b79f70b4a662eaa7a5fed30a7192d83c`. Local and independent verifier reconstruction agree. Only `template/init` and `template/rt/wasmtime` changed from release `057b2c66`.

All six existing guests passed fresh adoption under the candidate manager configuration. The control VM and both GPU workers retained their PIDs. Only Eyesoff was deliberately restarted. Existing production and rollback admission pins were retained.

## Validation before activation

- Native tests against the actual backend and production engine libraries fed a public 128-token prefix, closed the execution context, reopened it and appended 16 tokens. They compared the entire returned logit vector to an uncached run and independently checked a changed-prefix negative case.
- Qwen2.5 0.5B attention model: 78 ms cached append versus 684 ms uncached, zero maximum logit difference. Changed-prefix comparison also had zero difference.
- Qwen3.5 0.8B recurrent model: 119 ms cached append versus 1067 ms uncached, zero maximum logit difference. Changed-prefix comparison also had zero difference.
- The prefix-claim module's nine behavior tests passed. Existing source-contract checks: 11 passed and seven environment-dependent tests skipped; these are not reported as 18 behavioral tests.
- These small-model timings demonstrate the mechanism, not 27B production performance. Production chat validation is recorded after activation.

The standalone model fixture is `test/fixtures/wasi-nn-cache-smoke.rs`. It can be built as an example in the prepared Wasmtime workspace with the same features as the release; run with the production library loader, CPU backend, `N_BATCH=16`, eight active slots, six park slots and two prefix slots. It uses only public model weights and synthetic token IDs.

## Production result

Guest `gd5b9d105a` passed fresh attestation against the independently reproduced measurement and received a valid ZeroSSL certificate. All five other apps passed fresh attestation and HTTP 200 checks; their original guest IDs were retained.

The 2813-token shared prefix took 206801 ms to prepare, then 1 ms to reuse. A concurrent warmup reported that another request was preparing the shared prefix, waited for that leader and completed successfully.

In the browser's existing Loop-mode conversation, the first full chat returned `Stored.` with a 3846-token prompt and 152970 ms of prefill. The following prompt grew to 3883 tokens and returned the remembered code `amber-421`, with **2176 ms prefill (70.3× faster)**. The /chat SSE completion frames provide those timings. The generated answers took 4306 ms and 7025 ms respectively; this is a prefill improvement, not a 70× decode-throughput claim.

The default warmup does not include the browser's Loop-mode budget/persistence instructions, so its shared prefix differs from the full chat prefix. That longer prefix incurs a one-time first-chat cost, then the conversation cache reuses it. The UI may briefly label a new request as starting at zero because it counts the logical prompt stream; cached tokens now pass through without being recomputed. Guest restarts clear the private cache.
