# Two-GPU column split: exploratory result

Splitting columns across both cards reduced the measured host round by about
45–50% for the FFN gate pair and output head. FFN down improved by 10–37%.
This is one fixed-order experiment on three actual 27B layer dimensions,
using public synthetic field inputs. It is not a model or phone benchmark.
A comparison with balanced execution order and all seven layer classes is next.

| Layer class | Rows | One GPU, µs | Two GPUs, µs | Less host time |
| --- | ---: | ---: | ---: | ---: |
| ffn_gate pair | 1 | 222.3 | 121.6 | 45.3% |
| ffn_gate pair | 8 | 501.4 | 263.5 | 47.4% |
| ffn_gate pair | 16 | 975.6 | 531.3 | 45.5% |
| ffn_down | 1 | 133.0 | 83.6 | 37.2% |
| ffn_down | 8 | 279.1 | 250.3 | 10.3% |
| ffn_down | 16 | 588.7 | 476.2 | 19.1% |
| output head | 1 | 1458.2 | 746.0 | 48.8% |
| output head | 8 | 3155.9 | 1601.3 | 49.3% |
| output head | 16 | 6327.0 | 3181.8 | 49.7% |

Each entry averages 30 host rounds after warmup. A round includes copying
input planes to the device or devices, issuing the kernels and waiting for
completion. The one-card condition always ran first. This order can bias
results; the table is evidence for a confirmation experiment, not promotion.
The baseline uses the 80-SM U2 card; the original 27B phone result used U1.

One process owns two CUDA contexts. Each GPU holds a disjoint, aligned half
of each member's public weight columns and writes its columns directly into
one portable mapped reply. The full output row stride is preserved. This
requires no additional reply copy and keeps the existing single-link pad
and verification domain. It still has two device submissions and waits;
these measurements do not isolate their overhead.

The GPUs are asymmetric: U2 (`042eb279…`, Tesla V100-PCIE-32GB) has 80 SMs and
U1 (`1397d8cd…`, Tesla PG500-216) has 72. Exact name/UUID/SM checks passed in
every context. All nine owned processes were observed on both cards and
exited. Resident live-worker contexts remained present. No live service was
restarted, and the RTX 3070 was excluded from computation.

All 18 variants matched the complete scalar reference before and after
timing, with outputs poisoned again after warmup. The separate deliberate
no-op run was correctly rejected by the output checks. No-op, preflight and
full stages all passed their driver, GPU capture and cleanup checks. Recorded
binary/source/geometry hashes remained identical before and after the series.

The full capture covered 51.139 seconds with 198 observations per card. It
includes preparation, reference calculation, observation holds and cleanup;
its average utilization is not steady compute utilization. Per-device CUDA
events bracket the whole timed loop including enqueue and host-wait gaps.
They do not measure each card's busy time or determine the effect of the
72-versus-80 SM difference.

Pad generation and delivery, phone transport, verification, reply byte counts
and actual model inference are outside this experiment. The verified 27B Q8
phone result remains **0.92 tokens/s steady, 0.66 across the decode interval**.

[Structured evidence](/home/steven/Documents/Codex/2026-09-07/i-w/outputs/v100-two-card-exploration-evidence.json).
