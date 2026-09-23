# Shielded-27B -> pVM/TPU lane: transfer inventory

What the Shielded-27B throughput session (REPORT sections 14-18, through 18.46) learned, and what each item means for
THIS lane: Gemma 4 E2B in the Pixel 10 pVM, masked matmuls on the Tensor G5 TPU through the app-side worker, ARM64.
Maintained alongside TPU.md; every "running" claim names the artifact it was checked in.

## The phone artifact this inventory is against

| piece | revision / hash (sha256 prefix) | how checked |
|---|---|---|
| llama.cpp | `ddd4ec1428a6201e18975ea52b07c71e0f9aef26`, clean in both `out/ggml-arm64-work` and `out/ggml-arm64-repack-work`; `build-ggml-arm64.sh` fetches + checks out the pin, no patch step | `git status`/`rev-parse` in both trees |
| installed before this work | `anchor-punmask2.apk` (b74653630f36c716...) | `pm path` + on-device sha256 |
| candidate built here | `anchor-smp1.apk` 672c2b44ffd0561a..., built 2026-09-23 07:07:49 | on-device sha256 per run (`lane-conditions.sh` column 4) |
| libggml-tpu.so | a72c6fe2c2c23443 -> **b8d32cda90203f18** (the only library that changed) | unzip + sha256 |
| liblocalengine.so | 672ab20e39bdc119 (unchanged, rebuilt byte-identical) | |
| libanchortpu.so (worker) | 08ea34128c485d95 = `applibs-spin2`, stripped at packaging (same ELF build ID be2f8d85...) | `readelf -n` |
| libllama / libanchor / libggml-cpu-repack | 735baad12488645e / 9f9048db9cacced6 / 8adcb8333403d55f | |
| libggml-shielded.so | fd8cefde43c46439, bundled but NOT used by the TPU lane | |
| lane bundle | `lanes-h4ds.etpu` b9a24410c23b639f..., graphs `g5-h4ds` (int8, digit split, modular pads) | `BUNDLE_SHA256` in every RUNS.tsv |

## Inventory

Status key: **RUNNING** = in the phone artifact and exercised by the measured runs; **PRESENT-EQUIVALENT** = the lane
already does the same thing its own way; **PORTED** = new in the candidate; **N/A** = the thing it optimises does not
exist in this graph or platform; **REJECTED** = measured or reasoned not to transfer; **OPEN** = not settled.

| # | 27B source | optimisation / lesson | applies to E2B pVM/TPU? | status | evidence |
|---|---|---|---|---|---|
| 1 | b5bc66bb, 0f3973ea, fba26083 (REPORT 18.42, 18.46) | in-place delta-net conv (CONCAT + SSM_CONV + CPY fused into one op writing the conv state) | **No.** Gemma 4 E2B has no recurrent layers: the GGUF has 23 tensor kinds and no ssm/conv/delta tensor; `src/models/gemma4.cpp` has no ssm_conv, gated_delta_net, build_rs or concat. The drafter (`gemma4-assistant.cpp:118`) has one `ggml_concat(x, inp_h)` joining the token embedding to the target's hidden state: an input join, not a conv state, and not on the TPU path | **N/A** | grep of the pinned llama.cpp tree and the GGUF tensor list (recorded in this session) |
| 2 | REPORT 16.3 | recurrent state aliased + updated in place (no 4x copy per layer per token) | no recurrent state in Gemma | **N/A** | as 1 |
| 3 | fba26083 | fail-closed harnesses: exit status + exact pass line, `set -euo pipefail`, stub self-tests | yes: our runners | **PRESENT-EQUIVALENT**, and extended here | `lane-run2.sh` refuses on any failure (43 cases in `tpu/test/lane-run2-test.sh`); `run-all.sh` fails a suite that calls an undefined command. New: `lane-conditions.sh` column 4 installs an APK and hashes it on the device, a failed install or hash mismatch fails that run unstarted (4 new cases). That test found a real defect: `IFS=$'\t' read` collapses empty fields, so an empty EXTRA moved the APK path into EXTRA (fixed; earlier 3-column files never had a field after an empty one, so no past batch was affected) |
| 4 | fba6ca60 (REPORT 18.35) | fault logs print no activation / product values | yes: TPU_LOG reaches the relayed control channel | **RUNNING** (audited) + guard **PORTED** | all 18 TPU_LOG calls audited: arguments are layer/kind/output index, sizes, timings, bundle metadata, errno, and da/db = |worker - reference| on MASKED operands the worker already holds. `tpu/test/log-values-test.py` allowlists every argument identifier; mutants logging an output, a pad, a value hidden in a ternary, all refused |
| 5 | REPORT 18.35 | plaintext diagnostics only behind a COMPILE-TIME gate | yes | **PRESENT-EQUIVALENT** | the lane has no plaintext diagnostic at all; fault injection is compile-time `kInjectFault`, and the binary prints its own `build config repair=1 verify=1 inject=0` into every run log (checked in every run) |
| 6 | 0cf342ff, 53fbd4e5, 20792334, 645bbaea (REPORT 18.38-18.41) | stratify a sampler by the finest unit it means to cover; check every cell on first visit | **yes, and the lane had the exact defect**: a decode pass is exactly 140 exchanges (35 blocks x 4 kinds) and both samplers keyed on the global exchange counter. The parallel-unmask self-check (`exchanges % 16`) only ever replayed **kind-0** exchanges; the kernel verification (`exchanges % n_out`) only ever recomputed **one residue mod 4** of every projection's outputs (every E2B width is a multiple of 4). It was also public: the worker counts exchanges | **PORTED, RUNNING in anchor-smp1.apk** (`payload/tpu_sample.h`) | per-group visit counters; self-check on the first visit of every (group, rows) cell and every 16th; verified output = (off + v*stride) mod n_out with off/stride drawn by `getrandom` in the VM (stride coprime), so each output is recomputed exactly once per n_out visits in an order the worker cannot know. `tpu/test/sample-cover-test.cpp` on the real 140-group geometry read from the shipped bundle: new sampler 700/700 cells first-visit checked, 4/4 kinds, 100 % of outputs exactly once; the old sampler 1/4 kinds, 25.0 % of outputs ever verified. Still ONE output per projection per exchange: a drift detector with coverage, not a defence against a worker that lies selectively (TPU.md, unchanged) |
| 7 | 74181f43 (REPORT 17.9) | lock-free park/dispatch handshake loses a wakeup without paired seq_cst fences | checked: our helper pool (`g_cj`) uses a mutex + two condition variables with predicate waits and a generation counter, no lock-free park | **N/A** (not the shape) | `ggml-tpu.cpp` corr_post/corr_join/unmask_post: every state change under `g_cj.mu`, waits use predicates |
| 8 | 6d47fde5 (anchor), REPORT 17.6 | pad-independence invariant: same prompt, fresh pads, the text must not change | **not as equality.** The 27B returns exact field values; this lane's worker returns a REQUANTISED product `round(M*W.q)` of the masked row, and the VM subtracts `P = round(M*W.r)`, so every unmasked output carries a rounding error that depends on the pad (TPU.md "Pad dependence is INHERENT", 2026-09-22: ~1 output LSB RMS with zero clips). The lane's criterion is a BOUND plus task quality, already | **REJECTED as an equality check** (inapplicable by construction); the bound is RUNNING | 25 runs of the reverse_string prompt across 3 builds: one sha256 (no near-tie on that prompt; not evidence of independence). The shout prompt (row 23) has 4 texts on disk (d1 = qspec2-d4 = qc7-tpu; d2; qspec1-d4; qc7-cpu), all PASS, differing at near-tie docstring words; the two "d4" runs used different actual depths (the drafter's depth is timing-adaptive: 1:13,2:19 vs 1:3,2:27), and depth changes the rows batched on the CPU path, so depth is one cause and pad rounding the other. My earlier note that this needed a fixed-depth repeat to separate the causes was wrong: both are known and bounded |
| 9 | bfdc30e5, 1b5593d7, d8ed083e (REPORT 14.3, 18.36) | refill unit: mint pads in passes of 16 so one weight pass serves 16 pads | yes in principle | **PRESENT-EQUIVALENT**, not exercised | `mint_batch` already tiles 64 pads per weight pass (`mint_width`); the 27B later found unit 32 neutral-to-worse and 18.36 "null both ways". In every measured run `pads inline 0 refilled 0 bank_min 45`: a 128-position bank never ran dry at <= 256 tokens, so no on-path mint exists to optimise |
| 10 | REPORT 14.2 | pool depth cap (a derived depth of 256 streamed weights against decode, -22 %) | analogue: bank size | **RUNNING** (bank 128, measured) | padbank1/combo runs: bank 128 is filled BEFORE READY and not refilled on path |
| 11 | REPORT 14.2 | draft depth: k = 1 was best on the 27B (each verify row ~60-75 ms of CPU) | the per-row cost here is ~0.5 ms per exchange, a different shape; depths 1-3 never measured on this lane | **OPEN (partial)** | results/pd23 (shout prompt, smp1, verify_threads 4): d1 1.96 tok/s at 1.70 tokens/step (47 steps, 2011 core-ms/token); d2 2.19 at 2.14 (35 steps, 1773). The batch stopped when the host rebooted (08:07); the full ABBA sweep d1-d4 + no-drafter on one APK is queued as results/dp1. Reference on the same prompt at d4: qspec1/qspec2 (older builds) |
| 12 | 349d5d0d (REPORT 18.44) | thread placement / pinning | the pVM's vCPUs are scheduled by the host; placement inside the guest does not pin physical cores | **REJECTED** (null on the 27B; no lever here) | |
| 13 | REPORT 18.44 | THP / huge pages (preload shim) | the shim is unsafe | **REJECTED, quarantined** | measured null on this lane earlier (TPU.md) |
| 14 | REPORT 18.45 | frequency / power as the spread's cause | unsupported there; the phone is gated by the cool gate + Awake check | **N/A** | |
| 15 | REPORT 18.1-18.2 | range checks in the SIMD translation unit; mask mod-M | the lane has no field arithmetic: masks are int16 modular per channel, correction is exact int64 | **N/A** | |
| 16 | REPORT 18.36 etc. | FMA contraction makes "bit-identical" a property of the compiler build | yes: `tpu_corr.h`, `tpu_unmask_span.h`, `tpu_sample.h` were host-tested on x86 only | **RUNNING on device** as a self-check; **ARM64 tests PASS on the phone** | the on-device self-check replays the serial unmask with the same ARM64 binary and compares bytes: 0 differed in every run (smp1: 560 per turn). The three host tests, cross-built with the production toolchain (NDK 27.2 clang 18.0.3, -O3 -march=armv8.2-a+dotprod, default fp-contract, as libggml-tpu), each exit 0 on the Pixel 10 Pro XL: corr-order 31/31 (0 of 200000 cases round differently), unmask-span 10/10, sample-cover all checks + its mutant refused (`tpu/test/arm64-run.sh`, results/arm64t-20260923, each test's own rc recorded) |
| 17 | SHIELDED_YIELD=0 | config for dedicated cards | no card | **N/A** | |
| 18 | REPORT 14.2 | CPU oversubscription: decode threads + background work must fit the cores | yes: 6 vCPUs shared by decode, correction helpers, verification pool | **RUNNING when named at launch; DEFAULT in anchor-smp2.apk** | combo3/combo4/smp1: `verify_threads 4` keeps the rate at about a quarter less CPU per token (1455-1686 vs 1926-2124 core-ms). See "Defaults" below |

## Defaults: what the artifact runs when the launch names only the graphs and bundle

Found while writing this inventory: every lane optimisation measured since 09-22 was switched on by LAUNCH EXTRAS in the
harness's condition files, and the app's own defaults were the old baseline -- no drafter, one correction helper (so the
parallel unmask never ran), a 64-position bank, no decode or verification pool. A launch naming only `tpu_graphs` and
`tpu_bundle` would have run at about 1 tok/s. `anchor-smp2.apk` (edd595fa..., native libraries byte-identical to smp1)
applies the measured profile on the TPU lane to every setting the launch does not name: corr_threads 3, decode_threads 2,
tpu_bank 128, the provisioned drafter `files/draft.gguf` if present (`--es draft none` opts out), and verify_threads 4
when a drafter runs. The CPU-only lane's defaults are unchanged. The run log now says which values were defaulted
(`LOCAL tpu lane: ... | defaulted: ...`). Device check queued as results/df1; the 24-prompt quality set on this default
profile as results/qdef1.

## Running in the phone artifact vs tested vs rejected

| | item |
|---|---|
| **running in anchor-smp1.apk, measured on the phone** | stratified VM-secret samplers (6); value-free fault logs, audited + guarded (4, 5); no plaintext diagnostics, compile-time injection flag (5); on-device serial self-check of the parallel unmask (16); bank 128 before READY (10); ARM64 runs of the host arithmetic tests with the production flags (16, CPU only); verification pool 4 + decode pool 2 + 3 correction helpers + drafter (18), when named at launch |
| **built, not yet run on the phone** (phone off USB 09:13-15:22; TPU runs await approval) | anchor-smp2.apk: the same profile by DEFAULT; full draft-depth sweep (11) |
| **present in its own form, not exercised** | batched pad minting, 64 pads per weight pass (9): no on-path mint occurs at <= 256 tokens |
| **tested and rejected / inapplicable** | delta-net in-place conv and recurrent in-place state (1, 2: no such ops in Gemma 4 E2B); equality pad-independence (8: inapplicable by construction, the bound applies); lost-wakeup fence (7: not our pool's shape); thread placement (12); THP shim (13, quarantined); frequency/power (14); SIMD range checks + mod-M (15: no field arithmetic); SHIELDED_YIELD (17) |

## Also fixed while porting

* `build.sh anchor`'s staleness guard watched only `ggml-tpu.cpp` and `engine_local.cpp`; the correction, unmask and
  sampler bodies now live in headers, and an edit there alone would have shipped the previous library. It now also
  watches `ggml-tpu.h`, `tpu_corr.h`, `tpu_unmask_span.h`, `tpu_sample.h`.
