# Optimized Shield 27B production rollout — 2026-09-27

The optimized Q4 engine and measured guest profile are installed on metal0.
The production supervisor advertises both the existing 0.5B model and
`qwen3.8-27b-mtp-q4-vl-gguf`. Nan independently predicts/adopts the new image;
CPU apps retain their previous release. This rollout enables the production
runtime and scheduling path; it does not create a paid/on-chain 27B deployment.

## Repeated results from the exact production guest image

Hardware: AMD EPYC 9115 host, 16-vCPU / 50-GiB SNP guest, Tesla PG500-216 and
V100-PCIE-32GB, each with a 31-GiB worker budget and a 50% reservation.
Public Qwen3.8-27B UD-Q4_K_XL GGUF SHA-256
`3f227079003add2511437e5b1e94812e363385225bf6a9b47b0054a72bc8b01e`.
20-token fixed public prompt; greedy decoding; context 512; batch/ubatch 16;
8 decode threads and 8 refill threads; column-split masked GPU operations,
Freivalds checks, 64-row refill/pad pools and overlapped verification enabled.
Masks, corrections and nonlinear operations remain inside the SNP guest.
Shared-memory rings carry masked messages. No diagnostic token logging in the
production image. The fixed public probe uses the normal WASI-NN interface.

| Test | Decode tok/s for each run | Aggregate tok/s |
|---|---|---:|
| 64 output tokens, ordinary masked decode | 10.15, 11.40, 8.55 | 9.89 |
| 64 output tokens, MTP k=1 | 9.43, 12.45, 10.60, 10.04 | 10.52 |
| 128 output tokens, warm ordinary masked decode | 12.04, 11.75, 11.48 | **11.75** |
| 128 output tokens, warm MTP k=1 | 10.85, 11.46, 11.13 | **11.14** |

Aggregate = total timed output tokens / total decode seconds, not an average
of rounded rates. The first token comes from prefill, so 63/127 subsequent tokens
are timed per 64/128-token response. All seven 64-token outputs match exactly;
all six 128-token outputs match exactly, including MTP against ordinary decode.
MTP accepted 29/34 drafts at 64 tokens and 59/68 at 128 tokens. It is available
to apps through the API; these results do not justify forcing it on every app.
Peak in the production-image series was **12.45 tok/s**. A separate diagnostic
image reached 14.23 once; that is not the production-image result.

Cold setup is separate: copying and hashing the public model into private guest
memory took 33.974 s before readiness. The first request's prefill/setup took
92.292 s; first MTP head setup took 47.689 s. Warm 128-token runs had
0.667–1.547 s prefill. Startup has not been optimized away.

The earlier same-host Q6 experiment measured 2.69 tok/s, but used a different
quantization, partial GPU coverage, engine, transport and guest size. It is
not an apples-to-apples optimization ratio. The archived native-process masked
result of 24.51 tok/s (20–24.5 spread; historical unmasked 30.20) has **not** been
reproduced inside this production per-app SNP runtime. No current claim of
70% of unmasked speed follows from this test. Remaining investigation includes
SNP shared-memory handoffs and CPU/helper scheduling; causality is not proved.

## Deployment and provenance

- Implementation: `ffb5b3e8f208bfef29ad1aae6300af2a807e4880`
  on `codex/v100-per-app-shield-20260927`; optimizations `dafade281`, CPU
  headroom `caa47a0c8`, bounded guest idle polling `ffb5b3e8f`.
- Relay: `878cbe9b5f3f435e78b3b406134d2c5ece2a983d`
  on `codex/v100-scheduler-relay-20260927`. Its own supervisor-rule pin and
  toolchain pin match the admitted policy; the divergent trees were not merged.
- Engine fixed commit: `ddd4ec1428a6201e18975ea52b07c71e0f9aef26` plus the
  eight accepted patches in `engine-provenance.json`. Engine, CPU module, shim
  and backend use matching GGML_MAX_NAME=128. No regrow/ntsnap experiments.
- Shield release: `f674c047ad946c351ab8607bca69ea72c94d704f4151c599f67c76f9609e0644`.
- CPU release preserved: `85948b987bcd621d1b47bbaa402ea293720e7cbc77961e4f5dd670b552a72ee0`.
- Control measurement: `b91c184189d33d2a06dfe8f405a27cf2801f9f33c025b5147d2500087bf804b6481cbdd1e47bd2a0cc6d1514e6dae5c0`.
- Benchmark AppID: `48cfe198d269dbbeb853a925e955da287ef2680da409a69adf17a64d9791b043`.
- Benchmark launch measurement: `f75ffd6cb3d0e07b7e35b7d3c4d6ef0b66f7cccbb6572f08b737024fd36fafc8a9eacc2ca8401b725d02ac71a8216000`.
- The test guest was created by the real guest-manager code with the exact
  production template, on separate manager ports/root/prefix. Its nondeployment
  HOST_DATA means it uses self-signed, attestation-bound TLS and no paid lease.
  Catalog prediction was tested independently on nan and locally with identical
  results; both prior CPU known-answer measurements were reproduced on nan.
- Pool: 64 GiB / 24 logical CPUs. Existing five apps reserve 11776 MiB / 500%;
  the 27B profile reserves 51968 MiB / 1600%, including runtime/unit overhead.
  The 16-GiB host memory floor remains enforced. Model floor is 50% GPU per card.

## Validation

Each timed request checked AMD certificate/signature chain, minimum TCB,
measurement, app/runtime identities, W^X, fresh nonce, second nonce, replay
rejection and the TLS key before inference. Every request returned HTTP 200.
Worker counters show both cards performing masked work, over 99.99% of their
benchmark exchanges through the shared rings. The occasional oversized batch
reply uses the bounded socket route. No integrity failures occurred. The normal
owner-yield behavior remained enabled; brief yield events are in the worker logs.

Tests passed: guest manager; bundle contract/catalog; authenticated private model
copy and corruption rejection; private broker; scheduler/claim rules; independent
measurement prediction and secrets-release tests; shared-ring bounds and
verification tests; actual compiled backend worker-config parser; dynamic-link
and non-executable-stack checks. This is rollout and regression validation, not
a complete cryptographic proof or broad workload/performance qualification.

All five existing app guests were adopted without restarting them. IDs,
creation times, image measurements and TLS key hashes stayed unchanged; fresh
public attestation and HTTPS health checks passed after the rollout. Existing
wallet, pricing and ownership were preserved. V100 workers stayed alive across
the control restart. Their startup now recreates the 64-MiB rings after reboot
with private permissions; live ring contents are not truncated/replaced.

Small-model regression and final temporary-guest cleanup are recorded in the
completion note below. Detailed local request logs and build/test output reside
under `/home/steven/enclave-bench/v100-shield-20260927/optimized`.

## Rollback

Private backups are local `optimized/production-backup` and nan
`/root/enclave-27b-backup-20260927`. Drain NEW Shield inference guests before
restoring an older manager that cannot account for this profile. Preserve CPU
app guests and their original release. Restore the matching control image,
manager configuration and relay files together; never run two production
controllers against one guest manager or restart workers under GPU tenants.

## Completion

The 0.5B model also passed fresh attestation and two identical eight-token
responses on the new release. This is a functional compatibility check in a
one-vCPU guest, not a matched small-model performance comparison. An initial
test omitted its graph query parameter and correctly returned graph-not-found;
the corrected requests name `qwen2.5-0.5b-q8-gguf` explicitly.

Both temporary benchmark guests were deleted through the manager, which then
reported zero guests. The temporary manager was stopped. Production guestd,
metal0 and both V100 workers remain active; worker PIDs were preserved through
the control rollout. No benchmark app or lease was left running.
