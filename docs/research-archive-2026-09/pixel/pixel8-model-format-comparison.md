# Pixel 8 model/format comparison

Qwen3.5-4B Q4_K_M is the preferred model; alternatives are allowed when speed/quality is better. INT4 weight storage and actual arithmetic precision are recorded separately. The llama.cpp runs below are unshielded normal-world Mali GPU offload. MNN placement is separately diagnosed. None is protected inference or a TPU speed result.

| Model | Format | Generation result | Validation |
|---|---|---|---|
| Qwen3.5-4B | Q4_K_M | Warm-up only: 3.04 tok/s; trial failed | FAIL |
| SmolLM2-360M Instruct | Q4_0 | 17.44 tok/s pooled across 3 × 64 tokens | PASS |
| Qwen2.5-0.5B Instruct | Q4_K_M | 8.62 tok/s pooled across 3 × 64 tokens | PASS |

The 4B model generated a coherent warm-up response, then non-finite logits at the next prefill after clearing state. No completed trial exists. Both traditional models completed every trial with token IDs identical to warm-up. The tiny model response was fluent but weak (its first backup step was simply to log in); these truncated samples are not a rigorous quality evaluation.

The runtime reports Mali-G715, fp16 support, integer dot support, and KHR cooperative matrices. Q4 GGUF storage alone does not establish native INT4 arithmetic. All layers were offloaded, with remaining CPU buffers and unsupported operations reported rather than hidden.

Timing includes greedy sampling and autoregressive decode after prefill; load, prefill and the warm pass are excluded from pooled generation. Context 512, batch 128, threads 4, threadpool polling 0, MTP disabled, flash attention requested auto. Each device cycle completed in under 40 seconds.

Artifacts: [benchmark directory](../work/pixel8-gpu-generation-root-1/), per-run receipt, token/text files, stderr and root validation JSON. Source model downloads are revision pinned and SHA-256 checked, as are staged runtime/model files.

## MNN 3.6.1, first Qwen3.5-4B result

The published taobao-mnn conversion stores 4-bit weights with 16-bit activations (W4A16). This is not a native INT4 arithmetic or TPU claim. Root compiled the upstream demo against the official same-release Android libraries and requested OpenCL, low precision/memory, fast kernel tuning, greedy generation and no thinking. Text-only metadata disables vision/deepstack autoload because the actual graph has no such input; hybrid attention and mRoPE remain intact.

First run completed in 33.096 seconds and produced 64 coherent tokens. Upstream reports 6.51 tok/s for decode alone; including its separately reported sampling time gives approximately **6.21 tok/s**. Prefill took 10.14 s, decode 9.84 s and sampling 0.47 s. Those durations are rounded upstream to two decimal places. This is one prompt, not a repeated steady-state result; GPU tensor placement is pending a separate diagnostic. Actual text and provenance: [first MNN capture](../work/pixel8-mnn-root-1/first4b/).

The precise harness then completed warm-up plus three 64-token trials for both models. It uses a monotonic wall clock around generation after prefill, includes sampling/detokenization/bookkeeping and upstream's unused final forward, and saves actual token IDs. Every trial matched its warm-up exactly.

| MNN model | Trial rates, tok/s | Pooled generation, tok/s | Whole cycle |
|---|---|---|---|
| Qwen3.5-4B W4A16 | 7.162 / 7.060 / 7.083 | **7.101** | 56.405 s |
| Qwen3.5-0.8B W4A16 | 15.309 / 12.764 / 14.965 | **14.253** | 26.808 s |

Root count/hash/timing checks and the independent offline validators passed. The 4B placement diagnostic separately completed 12,024 paired callbacks; returned tensors for Convolution, Attention and LinearAttention all belong to OpenCL. This establishes tensor residency, not every operation's executing backend. Profiling will capture actual OpenCL kernel events. These results remain below the 20 tok/s target. Captures: [4B](../work/pixel8-mnn-generation-root-1/fourb-first/) and [0.8B](../work/pixel8-mnn-generation-root-1/small-first/).

The separate public LiteRT query successfully loads the phone's public library and initializes vendor API 0.14.0 (`sb_pixel`). Its five expected on-device compiler symbols are absent. Inspection of the public Google Tensor SDK Python package found only an installer shim requiring an externally provided SDK archive or URL, with no public compiler URL embedded. This blocks the currently inspected native INT4 compilation route, not all possible TPU support. No installer, account, license acceptance or protected-state change was performed.

## Controlled tuning comparison

The same benchmark binary and SDK runtime compared FAST (work-group size 128 for the hot projection) with NORMAL (searches sizes 8–256). Each mode used a separate cache; model, runtime, prompt, configuration and binary hashes were verified, and all four 64-token passes matched the accepted gold sequence. Root reviewed the independent pair validator and added a binding to the original staging manifest.

| Model | FAST, tok/s | NORMAL, tok/s | Result |
|---|---:|---:|---|
| Qwen3.5-4B | 7.0904 | 6.9956 | No improvement; retain FAST |
| Qwen3.5-0.8B | 13.3274 | 14.1578 | Below original 14.2526; no reliable gain established |

These are pooled generation rates for three 64-token trials after warm-up. Cycles took 35–75 seconds including verification and cleanup. The small-model pair ran NORMAL then FAST and was not replicated in reverse order; variation prevents a causal improvement claim. [Validated tuning captures](../work/pixel8-mnn-tuning-root-1/).

## Current implementation experiments

Actual device profiling identifies `gemv_conv_c8_buf` as the hot projection kernel; projection kernels account for about 86% of GPU event duration. Those diagnostic durations include profiling effects and are not a generation-throughput measure. [Kernel profile](pixel8-mnn-kernel-profile.md).

The device passed a public-vector probe using its exact advertised command-buffer API revisions: command buffer 0.9.5 and mutable dispatch 0.9.3. Replay, changed input, scalar and buffer updates, reduced work size with untouched tail, a 32-command buffer, and serialized replay all matched the oracle. The query and vector cycles closed in 1.798 and 1.991 seconds. This proves functionality for a trivial kernel; it does not predict MNN speed or establish protected execution. [Probe artifacts](../work/pixel8-opencl-command-buffer-root-2/).

The unprofiled MNN source build completed successfully. Root is measuring it before comparing a candidate that removes repeated integer division from the projection kernel. Opus separately reviews that patch, records MNN resize/execution boundaries, and validates benchmark provenance.


## First source-kernel experiment

The unprofiled source build measured **7.3081 tok/s**. A candidate replacing repeated integer division with an exact index recurrence measured **7.0071 tok/s**, so it is not adopted. Both completed warm-up plus three 64-token trials, all equal to the accepted gold sequence. Independent pair validation passed: only libMNN_CL.so changed; every other library, the harness, model, configuration and prompt matched. Cycles closed in 63.171 and 68.004 seconds. No causal gain is claimed from the source build differing slightly from the SDK run. [Source captures and validation](../work/pixel8-mnn-speed-root-1/).

Root corrected the candidate's edit scope and compile guards, checked 404,736 integer index cases, regenerated the embedded kernel and cache hash map, and verified that the resulting binary contains the new kernel. Opus is now preparing a separate compile-time specialization through the private desktop GUI, as requested.

## Compile-time block specialization

A separate candidate turns the hot kernel quantization block divisor into a compile-time constant, behind a default-off switch. The same patched runtime measured **7.0415 tok/s OFF** and **7.0985 ON**, with distinct kernel caches and exactly one matching process admission line per run. Each finished four 64-token passes identical to the accepted gold; whole cycles were 68.021 and 67.639 seconds. The small difference does not establish a repeatable gain. Independent comparison validation passed after root caught and Opus fixed a skipped-check bug; the validator confirms the exact same five libraries and harness, distinct caches, all gold tokens, and matching OFF/ON process admission. [Captures](../work/pixel8-mnn-speed-root-1/).

## Packed weight buffers versus images

The next default-off candidate selected the existing packed-buffer weight path for all 1x1 projections. Its same-library comparison measured **7.0806 tok/s OFF** versus **7.0539 ON**; no improvement was established. All four 64-token passes matched the reference on both sides, and independent provenance/admission comparison passed. Both cycles closed in about 67.5 seconds. This candidate remains unadopted. [Validated artifacts](../work/pixel8-mnn-weight-buffer-root-1/pair-validation.json).
