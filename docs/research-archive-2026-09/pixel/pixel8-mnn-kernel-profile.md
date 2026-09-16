# Pixel 8 MNN GPU profile

Qwen3.5-4B W4A16, normal-world OpenCL. Seven decode steps after separately recording the first decode step. Actual OpenCL event start/end timestamps; these are diagnostic device durations, not production throughput. All eight generated token IDs matched the non-profiling run.

The model projections, reported by MNN as `Convolution0`, consume **86.01% of measured GPU kernel time**. The second diagnostic below separates the actual kernel and projection shapes.

| Event label | Total across 7 steps, ms | Events | GPU time share |
|---|---:|---:|---:|
| Convolution0 | 786.222 | 1743 | 86.01% |
| Raster0 | 53.255 | 3647 | 5.83% |
| linear_attn_gated_delta_rule | 23.910 | 168 | 2.62% |
| LayerNorm0 | 12.228 | 735 | 1.34% |
| UnaryOp0 | 8.324 | 1078 | 0.91% |
| BinaryOp0 | 7.155 | 1183 | 0.78% |
| While0 | 5.322 | 567 | 0.58% |
| matmul_qk_div_mask | 3.663 | 56 | 0.40% |
| linear_attn_conv_silu | 3.399 | 168 | 0.37% |
| linear_attn_conv_state_update | 2.605 | 168 | 0.28% |

All 10,304 event durations sum to 914.108 ms, matching the reported block totals exactly. The profiled phase took 1,310.526 ms wall time. The difference includes host work, waits, printing and profiling overhead; it is not attributed solely to dispatch.

The precise non-profiling benchmark remains **7.101 tok/s for 4B**, **14.253 tok/s for 0.8B**, three 64-token trials each.

A separate public capability query found one Mali-G715 r0p0 OpenCL GPU, with `cl_khr_command_buffer` and `cl_khr_command_buffer_mutable_dispatch` advertised. A later public-vector probe passed replay and mutable dispatch using the exact device API revisions; MNN integration remains experimental.

Artifacts: [profile capture](../work/pixel8-mnn-profile-root-1/stdout-first/), [capability query](../work/pixel8-opencl-capability-root-1/query.stdout), [exact generation runs](../work/pixel8-mnn-generation-root-1/).

## Projection shapes verified on the GPU

A second diagnostic added the actual function name and dispatch sizes. Every observed projection uses `gemv_conv_c8_buf` with work-group size `128 × 1` under FAST tuning. The capture completed in 18.255 seconds and again matched all eight reference tokens.

| Input → output channels | Total GPU ms across 7 steps | GPU time share |
|---|---:|---:|
| 2560 → 9216 | 266.687 | 29.73% |
| 9216 → 2560 | 137.219 | 15.30% |
| 2560 → 8192 | 120.451 | 13.43% |
| 2560 → 248320 (vocabulary projection) | 93.496 | 10.42% |
| 4096 → 2560 | 63.523 | 7.08% |
| 2560 → 4096 | 54.890 | 6.12% |

The source fixes this kernel's work-group size at 128 under FAST; NORMAL enables the built-in search over 8, 16, 32, 64, 128 and 256. The subsequent same-binary comparison found no improvement for 4B: FAST 7.0904 versus NORMAL 6.9956 tok/s. Separate caches are necessary because ordinary OpenCL tuning cache keys omit tuning mode. [Detailed capture](../work/pixel8-mnn-profile-root-1/labels-first/).

## Command batching boundaries

An unprofiled build with lifecycle logging completed an eight-token diagnostic in 28.963 seconds, matching the reference prefix. Each decode step executes three OpenCL backend objects. Two resize once and then execute eight times; the third resizes before every execution. Seven steady decode steps therefore contain seven resize events and 21 backend executions. Which object owns the heavy projections is still being mapped; these counts alone neither prove nor rule out reusable command batches. [Lifecycle capture](../work/pixel8-mnn-lifecycle-root-1/first/).

## Cloned projections mapped directly

Creation-time logging omitted decode projections because MNN clones their executions from prefill. A direct projection resize trace closed in 28.277 seconds with all eight reference tokens. It identifies **248 body projections and the one vocabulary projection on two stable decode backends**, each resized once and executed eight times. The third backend resized eight times and had no projection resize calls. All 249 projection resize calls occur at the first decode step, with none during the following seven steps. This supports investigating retained command batches for the heavy work; it does not establish replay correctness or a speed gain. [Direct mapping](../work/pixel8-mnn-opmap-clone-root-1/first/projection-backends.json).
