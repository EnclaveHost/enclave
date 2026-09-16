# Pixel 8 Pro: detailed plain TPU inference profile

Qwen3.5 0.8B Q8_0, 64 outputs / 63 one-token decode calls per trial. This is unshielded hybrid TPU/CPU inference. All outputs match the prior control, with zero backend errors or timed compilation. Per-FC counters reconcile exactly with the global NNAPI counters.

| Trial | Generated tok/s | Decode wall (s) | NNAPI call wall (s) | Process CPU (s) | Main-thread CPU (s) |
|---|---:|---:|---:|---:|---:|
| 1 | 10.117 | 6.326130 | 5.154783 | 20.607142 | 1.698493 |
| 2 | 9.207 | 6.951014 | 5.562065 | 22.616958 | 1.942833 |
| 3 | 8.413 | 7.606905 | 6.060959 | 24.967681 | 2.236576 |

NNAPI wall is measured around `ANeuralNetworksExecution_compute` in [plain_fc.cpp](../work/pixel8-plain-tpu-profile-root-1/plain_fc.cpp#L269). It contains API/driver waiting and execution, and does not isolate physical TPU arithmetic. It is already contained in backend/harness wall. Process CPU time sums concurrent threads and must not be added to wall time. The CPU clocks bracket the measured phases; diagnostic dumps occur outside those intervals.

Trial 1 consumed about 3.26 CPU cores in aggregate, while the main thread consumed about 0.27. The source default poll level is 50, allowing 6,553,600 busy-poll rounds between CPU jobs. Aggregate CPU clocks alone cannot assign that consumption to particular worker threads or prove it causes NNAPI delay. A controlled poll=0 experiment is the next test.

## Ten largest FC invocation totals in trial 1

| FC weight(s) | Shape K × N | Calls | Total NNAPI wall (ms) | Contribution per decoded token (ms) |
|---|---:|---:|---:|---:|
| blk.0.attn_qkv.weight | 1024 × 6144 | 63 | 62.918 | 0.9987 |
| blk.2.ffn_gate.weight,blk.2.ffn_up.weight | 1024 × 7168 | 63 | 56.892 | 0.9030 |
| blk.3.ffn_gate.weight,blk.3.ffn_up.weight | 1024 × 7168 | 63 | 56.415 | 0.8955 |
| blk.12.ffn_gate.weight,blk.12.ffn_up.weight | 1024 × 7168 | 63 | 56.248 | 0.8928 |
| blk.16.ffn_gate.weight,blk.16.ffn_up.weight | 1024 × 7168 | 63 | 56.137 | 0.8911 |
| blk.5.ffn_gate.weight,blk.5.ffn_up.weight | 1024 × 7168 | 63 | 56.100 | 0.8905 |
| blk.6.ffn_gate.weight,blk.6.ffn_up.weight | 1024 × 7168 | 63 | 55.810 | 0.8859 |
| blk.14.attn_qkv.weight | 1024 × 6144 | 63 | 55.786 | 0.8855 |
| blk.15.ffn_gate.weight,blk.15.ffn_up.weight | 1024 × 7168 | 63 | 55.749 | 0.8849 |
| blk.4.ffn_gate.weight,blk.4.ffn_up.weight | 1024 × 7168 | 63 | 55.743 | 0.8848 |

A fused entry covers both named projections and cannot be split into two independent timing measurements. All these rows execute the same instrumented NNAPI call site.

## Projection groups in trial 1

| Projection group | FC calls per token | NNAPI wall per decoded token (ms) |
|---|---:|---:|
| ffn_gate+ffn_up | 24 | 21.131 |
| ffn_down | 24 | 15.786 |
| attn_qkv | 18 | 14.946 |
| attn_gate | 18 | 10.205 |
| ssm_out | 18 | 9.723 |
| attn_q | 6 | 4.152 |
| attn_output | 6 | 3.153 |
| attn_v+attn_k | 6 | 2.726 |

[Full per-trial profile](../work/pixel8-plain-tpu-profile-root-1/first/profile-summary.json), [root validation](../work/pixel8-plain-tpu-profile-root-1/first/root-validation.json), [run receipt](../work/pixel8-plain-tpu-profile-root-1/first/receipt.json), [model and binary manifest](../work/pixel8-plain-tpu-profile-root-1/manifest.json).

## Polling follow-up

The same-binary poll0/poll50 comparison completed: **6.08 versus 9.50 generated tok/s**, respectively, with identical output and exact counters. Poll0 reduced CPU use but made inference slower, so retain the original poll50. [Validated comparison and CPU clocks](../work/pixel8-plain-tpu-poll-root-1/poll-pair-validation.json).
