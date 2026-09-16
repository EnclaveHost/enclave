# CPU refill kernel diagnostic

The standalone sixteen-row refill kernel reached median aggregate rates of **487–616 billion logical MACs/s** with sixteen independent lanes on the three measured shapes. Its CPU efficiency was **41–53 billion logical MACs per CPU-second**. These are arithmetic rates, not dealer throughput or model tokens per second.

| Shape | K × N | Batch rows | Lanes | Logical G-MAC/s wall | Logical G-MAC/CPU-s |
| --- | --- | ---: | ---: | ---: | ---: |
| ffn_gate_member | 5120 × 17408 | 1 | 1 | 43.56 | 43.70 |
| ffn_gate_member | 5120 × 17408 | 1 | 16 | 97.55 | 7.05 |
| ffn_gate_member | 5120 × 17408 | 16 | 1 | 55.03 | 55.23 |
| ffn_gate_member | 5120 × 17408 | 16 | 16 | 487.43 | 41.01 |
| ffn_down | 17408 × 5120 | 1 | 1 | 19.91 | 19.99 |
| ffn_down | 17408 × 5120 | 1 | 16 | 96.67 | 7.12 |
| ffn_down | 17408 × 5120 | 16 | 1 | 75.32 | 75.55 |
| ffn_down | 17408 × 5120 | 16 | 16 | 615.94 | 52.89 |
| ssm_out | 6144 × 5120 | 1 | 1 | 53.07 | 53.34 |
| ssm_out | 6144 × 5120 | 1 | 16 | 100.93 | 7.40 |
| ssm_out | 6144 × 5120 | 16 | 1 | 57.53 | 57.83 |
| ssm_out | 6144 × 5120 | 16 | 16 | 521.48 | 42.38 |

Each entry is the median of three fresh processes, each with one warm refill and eight measured refills per lane. A shared start/finish gate measures wall and process CPU time over the same interval; scalar checking and preparation are outside it. Each lane is checked against an independent int64 oracle before and after timing. Outputs are poisoned again after warmup; an injected no-op timed loop fails the test. All 36 cases passed, inputs stayed stable and every child exited. The complete series took 9.933 seconds.

Batching matters: with sixteen lanes, the one-row kernel delivered about 97–101 logical G-MAC/s versus 487–616 for sixteen-row batches on these shapes. The production dealer already batches rows, so this is not a new speedup to claim for it.

The sixteen-lane arithmetic efficiency is of the same order as the earlier whole-dealer result. That makes kernel work a useful optimization target, but this experiment does not determine what fraction of dealer time it occupies: the real dealer mixes group sizes, scheduler assignments and other work.

The full 27B output head exceeds this diagnostic’s per-lane weight cap and was excluded. FFN gate measures one member, with independent same-shape weight copies per lane. The experiment uses public deterministic inputs, includes the kernel’s internal scratch allocation, and excludes PRF generation, encryption, file publication, phone transport and verification. It counts one logical MAC per K×N×batch element; the residue implementation performs three plane MACs for each.

Host: AMD EPYC 9115, 16 physical cores and 32 logical CPUs. No task-specific CPU affinity was imposed. Buffer budgets were calculated and checked before allocation; they are not RSS measurements.
