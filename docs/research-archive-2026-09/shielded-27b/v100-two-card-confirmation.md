The balanced two-card experiment passed all correctness, identity, capture and cleanup gates. Two-card execution was faster in all 168 matched pairs across seven matrix classes and batches of 1, 4, 8 and 16 rows. Median host round reductions range from 9% to 51%. These are matrix-group measurements, not generated tokens per second.

The comparison uses the physical asymmetric pair: U2 is a Tesla V100-PCIE-32GB with 80 SMs; U1 is a Tesla PG500-216 with 72 SMs. A runs on U2 alone; B divides each output into equal, 32-column-aligned halves across both cards. The historical 27B phone run used U1 alone, so this is not a direct comparison with that run.

Each shape used six alternating pairs (three A then B, three B then A), three warm rounds before each measurement, and 30 timed iterations. Inputs, buffers and full scalar references were shared within each invocation. Replies were re-poisoned after warm-up and fully checked after timing; the separate no-op probe proved that the check detects skipped writes. All 336 measured records passed.

Times below include H2D transfers, host dispatch and completion. CUDA stream intervals also include enqueue and other-device gaps; per-card busy time remains unknown. The kernel is fixed WR4/G8; this experiment does not combine the separately published MR8/G4 option.

| Matrix class | Rows | One card (µs) | Two cards (µs) | Reduction | Matched wins |
|---|---:|---:|---:|---:|---:|
| attn pair | 1 | 112.8 | 65.8 | 41.7% | 6/6 |
| attn pair | 4 | 140.0 | 92.7 | 33.8% | 6/6 |
| attn pair | 8 | 249.5 | 149.9 | 39.9% | 6/6 |
| attn pair | 16 | 486.7 | 296.9 | 39.0% | 6/6 |
| triple | 1 | 100.1 | 61.0 | 39.1% | 6/6 |
| triple | 4 | 126.1 | 86.2 | 31.6% | 6/6 |
| triple | 8 | 217.5 | 141.2 | 35.1% | 6/6 |
| triple | 16 | 428.4 | 278.9 | 34.9% | 6/6 |
| ffn_gate pair | 1 | 218.9 | 120.0 | 45.2% | 6/6 |
| ffn_gate pair | 4 | 255.2 | 145.2 | 43.1% | 6/6 |
| ffn_gate pair | 8 | 493.9 | 261.6 | 47.0% | 6/6 |
| ffn_gate pair | 16 | 938.9 | 521.2 | 44.5% | 6/6 |
| ffn_down | 1 | 132.1 | 82.2 | 37.8% | 6/6 |
| ffn_down | 4 | 167.3 | 131.0 | 21.7% | 6/6 |
| ffn_down | 8 | 276.2 | 250.8 | 9.2% | 6/6 |
| ffn_down | 16 | 579.7 | 477.8 | 17.6% | 6/6 |
| ssm_out | 1 | 52.9 | 35.7 | 32.6% | 6/6 |
| ssm_out | 4 | 74.7 | 65.6 | 12.2% | 6/6 |
| ssm_out | 8 | 121.2 | 97.1 | 19.9% | 6/6 |
| ssm_out | 16 | 242.2 | 196.1 | 19.0% | 6/6 |
| output head | 1 | 1455.0 | 737.6 | 49.3% | 6/6 |
| output head | 4 | 1529.3 | 787.5 | 48.5% | 6/6 |
| output head | 8 | 3154.2 | 1539.1 | 51.2% | 6/6 |
| output head | 16 | 6180.6 | 3171.3 | 48.7% | 6/6 |
| mtp head (eh_proj) | 1 | 84.3 | 49.4 | 41.4% | 6/6 |
| mtp head (eh_proj) | 4 | 104.8 | 85.9 | 18.1% | 6/6 |
| mtp head (eh_proj) | 8 | 180.3 | 145.6 | 19.2% | 6/6 |
| mtp head (eh_proj) | 16 | 371.3 | 293.3 | 21.0% | 6/6 |

All three stages passed; the full stage took 114.39 seconds with 444 telemetry samples per card. Whole-command GPU utilization includes CPU reference generation, holds, setup and gaps: it must not be interpreted as steady kernel utilization. Every owned invocation process was gone after completion, and source/binary/geometry hashes matched before and after.

The run used isolated CUDA contexts through a private MPS pipe directory without a daemon. Live workers remained resident. No production dispatcher, graph lifetime, transport path or phone configuration was changed. A production implementation still needs equivalent correctness and failure handling through the complete worker and phone path.

Binary SHA-256: `5a5f48ce9beadcf357ac4a022b9838582e1580003bce34a2a7bc48abc68f609b`.

[Machine-readable evidence](v100-two-card-confirmation-evidence.json) contains the complete pair records, captured telemetry summaries and stage identities.
