# Shield affinity deployed — September 27, 2026

The native experiment's CPU placement optimization is now part of metal0's
measured per-app SNP inference runtime and host launcher. The deployment keeps
the previous AVX2 math module: an AVX-512 candidate produced one differing MTP
response and was not admitted to production.

## Changes deployed

- Six compute threads pinned to guest CPUs 0,2,3,4,5,6; split helper on CPU 1;
  background/refill threads on 7-15. Sixteen refill workers total, vector CRT,
  masking, correction and Freivalds verification remain enabled.
- A measured `libshielded-omp-affinity.so` wraps OpenMP region callbacks,
  re-applies compute placement after backend sweeps, and restores the caller's
  original affinity so later children do not inherit a single CPU. Invalid
  lists or failed compute placement stop execution.
- The host launcher pauses 27B QEMU guests before boot, queries vCPU thread IDs
  through a private QMP socket, and assigns the critical vCPUs to seven distinct
  physical cores sharing one L3. Refill vCPUs use other cores first, then their
  SMT siblings. It verifies each applied affinity before resuming. An invalid
  topology or mapping stops the guest before app startup. Host topology and
  affinity are performance controls, not a security claim or exclusive cores.
- Actual metal0 mapping was vCPU 0..15 to host CPU 0..15; all sixteen live
  thread affinities were observed and matched the plan. `placement-observed.json`
  contains the evidence. Guest remains 16 vCPUs / 50 GiB, pool 24 CPUs / 64 GiB.
- CPU-only and 0.5B launches do not take the QMP placement branch. The 0.5B
  profile does not load the OpenMP helper and retains its prior thread counts.

Source: `42371379c7da63241cf5482ccfce30327a780f19`, with launcher initialization
fix `160ef357ed19` (full hash in rollout-plan.json), pushed on
`codex/v100-per-app-shield-20260927`. Production source snapshot
`/home/steven/enclave-prod/iso-160ef357`; guestd executable remains ffb5b3e8,
whose unchanged launcher dispatches the new run-domain.sh.

Production Shield release:
`f61fed6187c32316fcbc41d3364139a66d06a98e181efacad58cc3127b477b46`.
Compared with preceding c427ef63, only `template/init` changed and
`template/rt/libshielded-omp-affinity.so` was added. CPU math, Shield backend,
model, kernel, firmware, brokers, and other runtime binaries are unchanged.
CPU-only app release remains 85948b98. The control image and V100 workers were
not restarted.

## Exact deployed image benchmarks

Same public Q4 27B model, 17-token sky prompt, two V100-class cards, 512 context,
16 batch/ubatch, and a temporary app created through the real guest manager.
Rates exclude prefill and time the tokens after the first prefill-produced token.
Every successful request passed fresh AMD chain/TCB, pinned image/AppID/runtime,
W^X, TLS-key binding, second nonce and replay rejection, then returned HTTP 200.
All successful outputs match ordinary/MTP output at the same requested length.
The canary names no deployment in HOST_DATA and uses attestation-bound TLS;
this does not claim a new owner-signed on-chain AI app was deployed.

| Output length | Mode | Per-run tok/s | Aggregate tok/s |
|---|---|---|---:|
| 128 | ordinary | 18.70, 16.73 | 17.66 |
| 128 | MTP k=1 | 16.31, 15.27, 16.65 | 16.05 |
| 128 repeat | ordinary | 16.29 | 16.29 |
| 128 repeat | MTP k=1 | 17.15 | 17.15 |
| 64 | ordinary | 16.38 | 16.38 |
| 64 | MTP k=1 | 18.94, 16.41, 14.60 | 16.46 |

The two repeat checks requested 256 but the public probe clamps steps to 128;
they are not 256-token or sustained-throughput evidence. The matching previous
128-token four-thread/vector profile measured 13.97 ordinary / 13.47 MTP.
Host desktop and five production apps remained active, so the difference is
observed improvement, not a controlled guarantee. Native 23.32 tok/s remains a
native benchmark; the production-image peak in this series is 18.94 tok/s.
No claim of 23.32 production throughput is made.

Cold setup remains substantial: private copy/hash before readiness, then
78.851 s initial ordinary prefill/setup and 40.222 s first MTP setup/prefill.
Warm prefill was 0.485–1.141 s across these runs. MTP is optional for apps and
was not forced on by the deployment.

## Candidate excluded

The initial affinity + AVX-512 candidate (release fce37c00) measured ordinary
18.25/18.77 and MTP17.87/15.39/17.07 at 128 tokens. Its first MTP output differed
at zero-based token 74, while its other four outputs matched. This observation
does not identify the underlying numerical/state cause. The candidate was
never admitted to production. The subsequent affinity + existing AVX2 candidate
passed repeated ordinary/MTP comparisons and matches the previous production
profile's output. Both result sets are preserved; failed checks were not removed
from the account of the work.

## Rollout verification

The real compiled helper tests passed placement, arithmetic output, recovery
from a simulated backend affinity sweep, caller-mask restoration, child affinity
inheritance, malformed/duplicate/unavailable CPU-list refusal. Seven topology
planner tests cover SMT exclusion, restricted cpusets and insufficient topology.
Guest-manager launcher/pool/inference regression tests and exact refill/OOM/SIMD
bounds tests passed. The actual SNP canary proves the helper executes with the
existing unprivileged runtime and seccomp rules.

Nan independently reproduced two existing known answers and the new catalog
27B image's expected measurement. The new release was appended to predictor,
domain and certificate admission; prior releases remain. Relay code and its
pinned assembly toolchain were unchanged. Relay restart caused expected-image
warming 503 responses; verification retried within a bounded interval and never
bypassed attestation. All five production apps were adopted with unchanged IDs,
creation times, launch measurements and TLS keys; fresh public checks are in
production-health.json. The small-model compatibility check and lab cleanup are
recorded separately. No wallet transaction was needed.

## Rollback

Private local backup: `rollout-affinity/production-backup/80-shield-inference.conf`
under `/home/steven/enclave-bench/v100-shield-20260927`. Nan environment backup:
`/root/enclave-affinity-backup-20260927/api-relay.env`. Drain any new inference
guests on this release before restoring the prior manager drop-in/source. Keep
CPU app guests and GPU workers running, then verify adoption and public health.
Full raw build/request evidence remains in the local rollout-affinity directory.
