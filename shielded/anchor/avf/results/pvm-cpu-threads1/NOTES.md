# pVM CPU thread sweep, Pixel 10 Pro XL, 2026-09-23 (19:11-20:52)

The protected pvm-cpu build p2 (`anchor-pvm-cpu-p2.apk`, sha256 `2bca7b35…`), Gemma 4 E2B Q4_0, through the fail-closed
driver (tpu/lane-conditions.sh + lane-run2.sh, `GRAPHS=none MAXNEW=512`): four 512-token turns per run (the sustained
prompts in runs/RUNS.tsv), a fresh VM per run, the phone awake, thermal trace every 5 s (thermal.tsv). Each condition twice,
interleaved: t6 (6 threads, the default), d4 / d5 (prefill on 6 threads, decode on its own pool of 4 / 5:
`--ei decode_threads`), t4 (4 threads for everything). `cpu/summarize-baseline.py results/pvm-cpu-threads1 queue.log`.

| run | condition | decode tok/s over the 4 turns | worst turn | core-ms / token | prefill tok/s, turns 1-4 | TTFT ms, turns 1-4 |
|---|---|---|---|---|---|---|
| ts-01 | t6 | 7.56 | 6.14 | 786 | 84 / 56 / 36 / 32 | 445 / 518 / 813 / 960 |
| ts-08 | t6 | 7.46 | 6.07 | 793 | 100 / 56 / 36 / 32 | 332 / 542 / 881 / 996 |
| ts-02 | d4 | 7.65 | 6.45 | 527 | 92 / 52 / 36 / 33 | 394 / 585 / 821 / 932 |
| ts-07 | d4 | 7.33 | 5.86 | 546 | 81 / 44 / 36 / 33 | 434 / 655 / 823 / 915 |
| ts-03 | d5 | 7.41 | 6.21 | 672 | 81 / 42 / 36 / 33 | 424 / 651 / 811 / 913 |
| ts-06 | d5 | 7.58 | 6.19 | 657 | 88 / 56 / 36 / 33 | 480 / 509 / 815 / 908 |
| ts-04 | t4 | 7.58 | 6.24 | 530 | 84 / 40 / 26 / 25 | 423 / 748 / 1141 / 1192 |
| ts-05 | t4 | 7.41 | 6.00 | 539 | 73 / 42 / 26 / 23 | 442 / 724 / 1140 / 1330 |

Thermal over the sweep: status peaked at 1, the big cores at 86 °C, skin 41.5 °C; the frequency caps fell to 1.92 GHz on
cpu7 (from 3.78) and 1.40 GHz on cpu2 (from 3.05).

**Conclusion.** Sustained decode is the same in every condition (7.33-7.65 tok/s; the spread within a condition is as large
as between them): the phone is thermally limited, not thread-limited, so no thread setting reaches the 10 tok/s sustained
target. What the setting changes is the CPU spent: **d4 decodes at the same rate for about 32 % less CPU** (537 vs 790
core-ms per token) and keeps t6's prefill and time to first token. t4 saves the same CPU but slows the later turns' prefill
(23-26 vs 32-36 tok/s) and TTFT (1.1-1.3 s vs 0.8-0.9 s), because prefill loses two threads. So the CPU lane's default
becomes d4 (6 prefill threads, 4 decode threads) where the kernel reports more than 4 big and mid cores. Measured on this
Pixel 10 only.

Logs normalized after capture: trailing spaces stripped (the long HOST method-list lines and the frequency sampler's
space-terminated columns in `*.caps`); nothing else changed, and the summary recomputed from them is byte-identical.
