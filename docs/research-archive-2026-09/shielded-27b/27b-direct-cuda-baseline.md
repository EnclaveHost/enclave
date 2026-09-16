# Direct 27B Q8 CUDA baseline

Measured 2026-09-08–09 UTC with the same `Qwen3.8-27B-Q8_0.gguf` used by Shielded. Its metadata reports `qwen35 27B Q8_0`. Freshly verified model SHA256: `a680f44a06920e5d689774823782006aa3acc8db95750323373b24139b67e348`.

| Configuration | Decode benchmark, 3 x 128 tokens | Actual greedy text, 128 tokens | Prompt benchmark, 512 tokens |
|---|---:|---:|---:|
| PG500-216 32 GB alone, the Shielded worker's card | 27.59 +/- 0.02 tok/s | 27.60 tok/s | 886.87 tok/s |
| V100-PCIE 32 GB alone | 24.05 +/- 0.03 tok/s | 24.06 tok/s | 932.87 tok/s |
| PG500-216 + V100-PCIE, equal layer split | 25.68 +/- 0.03 tok/s | 25.70 tok/s | 910.44 tok/s |

These are ordinary native CUDA runs without Shielded, the phone, the relay, or MTP in their inference path. Benchmark values are means and sample standard deviations; llama-bench excludes tokenization and sampling. Actual text used the prompt "The capital of France is", context 1,024, temperature zero, and 128 generated tokens. Its steady eval rate measures 127 one-token forward passes; the first output comes from prompt evaluation. All three configurations produced identical text.

All three benchmark runs logged 66/66 layers offloaded. The standard 1,288 MiB CPU-mapped embedding buffer remained; GPU model buffers were 25,972 MiB on one card or 12,730 + 13,242 MiB split across two. Actual text runs requested the same offload settings and had independent GPU captures. The V100-only benchmark had 100% median utilization and 27,799 MiB peak total GPU memory. The PG500-only benchmark had 99% median utilization and 27,723 MiB peak; the other card's median was 0%. Both-card captures showed activity on both GPUs. These captures include loading and teardown; their averages are not isolated decode utilization. All six supervised runs exited successfully with valid captures.

The ordinary CUDA path exceeds 20 tok/s on the same PG500 card used by Shielded. The latest successful Shielded/phone result remains 0.92 tok/s steady, or 0.66 tok/s across its whole decode. That older test used 16 generated tokens and MTP with three drafts. These are observed configurations, not a controlled measurement of Shielded overhead; token counts and speculative decoding still differ. The direct results do not demonstrate confidentiality, continuous pad replenishment, vision performance, or a 180,224-token context.

The PG500 controls ran during the phone-only model-staging phase of the new Shielded diagnostic. Both completed before any Shielded FIELD request was observed; separate receipts retain that check. That diagnostic's startup phase therefore included these short host GPU tests. Its later decode exchange window excludes them.

Build: upstream llama.cpp `ddd4ec1428a6201e18975ea52b07c71e0f9aef26`, Clang 22.1.8, CUDA 12.6.85, architecture 70, F16 KV cache, flash attention auto, eight CPU threads, batch/microbatch 512, all GPU layers requested. Only local CMake handling of Clang CUDA flags changed; inference source was unchanged. Compiled kernels were checked for sm_70. The current card topology is PCIe PHB, with no active NVLink reported. Existing workers/MPS services were preserved; benchmark environments excluded inherited experiment and MPS settings.

Detailed measurements, commands, model identity, build settings, and GPU captures are in `27b-direct-cuda-evidence.json` alongside this report.
