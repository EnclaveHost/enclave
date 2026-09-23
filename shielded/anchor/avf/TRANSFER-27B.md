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
| 8 | 6d47fde5 (anchor), REPORT 17.6 | pad-independence invariant: same prompt, fresh pads, the text must not change | yes (the anchor session found it here first) | **RUNNING as a check**, partly OPEN | 25 runs of the reverse_string prompt across 3 builds, with and without the drafter: **one sha256** (14a7bd04...). The step count varies 20-23 because the drafter's depth is timing-adaptive, not because of pads. OPEN: qspec1 vs qspec2 (same settings, builds differing only by the byte-verified parallel unmask) differ on 3 of 24 long answers (rows 07, 08, 23); depth-driven batching and the rare 1-digit TPU rounding are both candidates; a fixed-depth repeat separates them (below) |
| 9 | bfdc30e5, 1b5593d7, d8ed083e (REPORT 14.3, 18.36) | refill unit: mint pads in passes of 16 so one weight pass serves 16 pads | yes in principle | **PRESENT-EQUIVALENT**, not exercised | `mint_batch` already tiles 64 pads per weight pass (`mint_width`); the 27B later found unit 32 neutral-to-worse and 18.36 "null both ways". In every measured run `pads inline 0 refilled 0 bank_min 45`: a 128-position bank never ran dry at <= 256 tokens, so no on-path mint exists to optimise |
| 10 | REPORT 14.2 | pool depth cap (a derived depth of 256 streamed weights against decode, -22 %) | analogue: bank size | **RUNNING** (bank 128, measured) | padbank1/combo runs: bank 128 is filled BEFORE READY and not refilled on path |
| 11 | REPORT 14.2 | draft depth: k = 1 was best on the 27B (each verify row ~60-75 ms of CPU) | the per-row cost here is ~0.5 ms per exchange, different shape; depths 1-3 never measured on this lane | **OPEN -> measured below** | draft sweep |
| 12 | 349d5d0d (REPORT 18.44) | thread placement / pinning | the pVM's vCPUs are scheduled by the host; placement inside the guest does not pin physical cores | **REJECTED** (null on the 27B; no lever here) | |
| 13 | REPORT 18.44 | THP / huge pages (preload shim) | the shim is unsafe | **REJECTED, quarantined** | measured null on this lane earlier (TPU.md) |
| 14 | REPORT 18.45 | frequency / power as the spread's cause | unsupported there; the phone is gated by the cool gate + Awake check | **N/A** | |
| 15 | REPORT 18.1-18.2 | range checks in the SIMD translation unit; mask mod-M | the lane has no field arithmetic: masks are int16 modular per channel, correction is exact int64 | **N/A** | |
| 16 | REPORT 18.36 etc. | FMA contraction makes "bit-identical" a property of the compiler build | yes: `tpu_corr.h`, `tpu_unmask_span.h` are host-tested on x86 only | **RUNNING on device** as a self-check | the on-device self-check replays the serial unmask with the same ARM64 binary and compares bytes: 0 differed on every run so far. Still OPEN: an ARM64 run of the host tests themselves |
| 17 | SHIELDED_YIELD=0 | config for dedicated cards | no card | **N/A** | |
| 18 | REPORT 14.2 | CPU oversubscription: decode threads + background work must fit the cores | yes: 6 vCPUs shared by decode, correction helpers, verification pool | **RUNNING** (tuned here) | combo3/combo4: `verify_threads 4` keeps the rate (2.49-2.54 vs 2.52-2.68 tok/s) at 1459-1524 vs 1926-2124 core-ms per token |

## Also fixed while porting

* `build.sh anchor`'s staleness guard watched only `ggml-tpu.cpp` and `engine_local.cpp`; the correction, unmask and
  sampler bodies now live in headers, and an edit there alone would have shipped the previous library. It now also
  watches `ggml-tpu.h`, `tpu_corr.h`, `tpu_unmask_span.h`, `tpu_sample.h`.
