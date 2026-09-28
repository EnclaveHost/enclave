# Masked 27B: 25 tok/s native result and isolated-guest limit

Historical qualification snapshot. The subsequent user-authorized deployment is recorded in
[the production rollout](../shield-pool128-production-2026-09-27/README.md).

The native masked benchmark reached **25.34 and 25.37 tok/s** in two
128-token runs, then **24.97 tok/s** over 384 tokens. The setting was a
128-pad pool, refill unit 32, and cost priority. All three runs matched the
ordinary decoder's output, reported zero observe/verification failures, and
offloaded the intended operations without a local fallback. Neither card
reported a missed pad in the two short runs. In the longer run, card 1
reported 161 missed pads and 803.5 ms of request-path refill time; card 0
reported no misses.

**This is not a 25 tok/s production or isolated-guest result. No experimental
release was activated.** Production remains on
`fef26ae1521fe1350a04acad826e76cb8a0e5e215acf0010671c2d6119dbbda9`.

## Controlled inputs and results

The model is Qwen3.8-27B-UD-Q4_K_XL.gguf, SHA-256
`3f227079003add2511437e5b1e94812e363385225bf6a9b47b0054a72bc8b01e`.
Tests use the same public 17-token sky/related-phenomena prompt, two V100-class
workers, AVX2 CPU engine, six decode threads, sixteen total refill threads,
64-row refill batch, one-token MTP, fresh masks, and verification. Decode
rates exclude loading, prefill, attestation and the first prefill-produced
token: 127 or 383 timed tokens. These are sequential samples on a shared
desktop host, not a throughput SLA or a multi-user load test.

| Native configuration | Ordinary tok/s | MTP tok/s |
| --- | ---: | ---: |
| Current release defaults, 128 tokens | 20.68 | 22.66 |
| Cost priority, 128 tokens | 20.94 | 23.93 |
| Cost priority + pool 128/unit 32, 128 tokens | 20.75 | 25.34 |
| Same, independent repeat | 21.02 | 25.37 |
| Same, 384 tokens | 21.31 | 24.97 |

Native diagnostics use an explicitly development-only SHM backend object.
It was never copied into a guest release. The candidate using the faster
settings changes only measured init; its production backend is unchanged.
`native-results.json`, `native-verification.json`, and the individual config
files retain all valid trials, including slower results. The initial `base`
attempt used a production backend that correctly refused development SHM
paths and fell back locally; it is excluded, not a performance result.

Each guest request verified fresh AMD attestation, TCB, measured runtime and
TLS identity before submitting the public fixture. All completed 128-token
runs matched the baseline token array, and all completed 384-token runs
matched the baseline 384-token array exactly.

| Isolated profile | Guest MiB | Ordinary 128 aggregate | MTP 128 aggregate | MTP 384 aggregate |
| --- | ---: | ---: | ---: | ---: |
| Current production release | 51,584 | 19.30 | 19.94 | 20.96 |
| CPU locality/snapshot candidate + cost priority | 51,584 | 19.14 | 20.36 | 20.89 |
| Pool 128/unit 32 + cost priority | 61,440 | 19.52 | 21.18 | 21.34 |

Aggregates divide total timed tokens by total decode time. The last profile's
two 384-token MTP samples were 22.85 and 20.02 tok/s. The memory allocation
differs intentionally; this is not an otherwise identical comparison. Its
small, variable improvement does not justify changing the production memory
contract. Native and guest GPU benchmarks were never run concurrently.

## Memory failure and rejected approaches

The 128-pad profile first ran with 51,584 MiB. It completed two ordinary
requests (18.75 and 19.20 tok/s), then the app exited with status 137 during
MTP initialization and the guest powered down. The serial log (ANSI escapes and CRLF normalized) is preserved
under `pool128/failed-guest-serial.txt`. The same release completed all tests
at 61,440 MiB. This supports memory exhaustion as the cause, although the
serial log does not include an OOM-killer diagnostic. Do not activate this
profile at the old memory allocation.

An experimental output-projection-only buffer adds about 63.125 MiB across
the two split output groups rather than doubling all groups. It reached
20.93 tok/s with global unit 32, or 23.95 with ordinary groups kept at unit
16 and the output group at unit 32. It did not retain the full gain and is
archived as `output-buffer-experiment.patch`, not applied to production
source. Its scheduling/held-slot and pad-wait tests passed.

MTP k=2, eight refill threads, global unit 32 with the old 64-pad pool, and
host-side ordinary top-k selection also failed to produce a better qualified
result. Do not select configurations solely by their best short sample.

## Recurrent CPU experiment

`wasm/llamacpp-gdn-locality-snapshot.patch` is an experimental patch on the
pinned private engine (`ddd4ec1428a6201e18975ea52b07c71e0f9aef26` plus the
existing production patches). It adds opt-in scalar-row locality and
streaming rollback snapshot stores without changing arithmetic or state
layout. Both switches default off. The patch is **not** enabled in the
production toolchain workflow or active runtime.

Each of four configurations passed 72 equivalence cases, comparing all
448,983,256 bytes of outputs, recurrent state, snapshots, padding and
canaries. The off configuration also matched the original production CPU
module. Alternating microbenchmarks reduced median recurrent-op time from
204.2 to 163.0 microseconds, about 20%, but full-model MTP guest throughput
did not improve. The reusable check is `scripts/test-gdn-locality.py`;
checksums and logs are in `official-equivalence/`.

## Reproduction and operational state

The local work directory is
`/home/steven/enclave-bench/v100-shield-20260927/target25`. The archived native
driver and config files name the exact library paths and CPU placement. Run
the native driver only with the actual GPU rings idle and no isolated AI
guest, using symlink aliases to existing rings; never recreate or truncate
the worker rings. Remove the aliases before starting a guest test.

The public probe source and vendored WIT are under `probe/`. Build with
`cargo component build --release --target wasm32-wasip1`; generated bindings
are intentionally omitted. It accepts up to 384 steps, retaining k=1 as the
default. `lab.py`/`lab60.py` record the two measured memory allocations;
`extra-series.py` checks longer outputs against the ordinary decoder.
Release manifests, init sources, artifact hashes, guest identities and raw
attested response records accompany this report. Large binaries stay in the
local work directory.

Nan reproduced its known-answer measurements and staged predictions for
inactive candidates. These preflights added releases only to each test
process's environment; predictor/domain/certificate admission and the
running relay were not changed. The five production app guests, production
guest manager, control VM, GPU workers and memory contract were preserved.
Temporary guests/managers and native SHM aliases were removed after testing.
Final app health and inventory checks are recorded alongside this report.
