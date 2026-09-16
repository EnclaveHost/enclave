# V100 output-path comparison — 8 September 2026

The existing direct write into mapped host memory was faster than writing into GPU memory and then copying the result to the host in **all 28 tested shapes**. The copy alternative took **7.6–35.1% longer** in these standalone stream intervals. We are keeping the existing output path.

| Representative group | Mapped output, 1 row (ms) | Mapped output, 16 rows (ms) | Device output plus copy, 16 rows (ms) |
|---|---:|---:|---:|
| attn pair | 0.105 | 0.426 | 0.546 |
| triple | 0.092 | 0.379 | 0.477 |
| ffn_gate pair | 0.211 | 0.851 | 1.087 |
| ffn_down | 0.109 | 0.382 | 0.412 |
| ssm_out | 0.044 | 0.167 | 0.196 |
| output head | 1.449 | 5.839 | 7.597 |
| mtp head (eh_proj) | 0.067 | 0.276 | 0.297 |

All 84 variants passed exact output checks before and after timing. Every one of 28 process invocations reported the intended second V100, 80 available SMs and matching process attribution. Each case used 30 timing iterations. The full capture passed with 332 bracketed observations per card and clean process shutdown.

These are public synthetic values with the actual 27B member dimensions, not model inference. CUDA-event intervals include host enqueue gaps and the chunked kernel sequence; they exclude input upload, worker socket traffic and the phone path. They are not pure kernel time or tokens per second. An intentional 2-second hold before each case supported process observation and was outside timing. A live idle worker context remained on the second card. The first card showed small transient activity of unknown origin; none of these diagnostic processes was attributed to it.

This experiment does not establish a full-model lower bound or the phone’s bottleneck. The earlier actual 27B phone result remains 0.92 tok/s steady, 0.66 tok/s across its complete short decode interval.

[Structured evidence](/home/steven/Documents/Codex/2026-09-07/i-w/outputs/v100-diagnostic-evidence.json).
