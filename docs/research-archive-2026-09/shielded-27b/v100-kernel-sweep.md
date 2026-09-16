# V100 integer-kernel sweep

The exploratory sweep found a promising warp-grouping change for batches of8–16 rows. It passed all36 before/after arithmetic checks. The current default remains faster at4 rows. No serving change has been made. The subsequent [balanced confirmation](/home/steven/Documents/Codex/2026-09-07/i-w/outputs/v100-kernel-confirmation.md) passed all84 matched pairs.

Measured on U2, the Tesla V100-PCIE-32GB, with80 SMs checked after CUDA context creation. These are actual27B group dimensions with synthetic field-valued inputs and public weights. Each of the three residue planes differs, and every output byte is checked against an independent int64 reference.

| Group | Rows | Current G8 (µs) | Candidate G4 (µs) | G4 interval reduction |
|---|---:|---:|---:|---:|
| FFN gate/up | 4 | 242.38 | 281.77 | -16.25% |
| FFN gate/up | 8 | 433.94 | 420.93 | +3.00% |
| FFN gate/up | 16 | 826.47 | 724.51 | +12.34% |
| FFN down | 4 | 120.12 | 128.82 | -7.24% |
| FFN down | 8 | 188.62 | 172.65 | +8.47% |
| FFN down | 16 | 370.59 | 348.43 | +5.98% |
| Output head | 4 | 1508.76 | 1833.98 | -21.56% |
| Output head | 8 | 2781.76 | 2555.39 | +8.14% |
| Output head | 16 | 5837.07 | 4910.01 | +15.88% |

Both columns retain WR=4. Negative reduction means slower. The two WR=2 alternatives were slower than the current default across these cases.

These are CUDA-event stream intervals around repeated, chunked launches, including host enqueue gaps. They exclude input upload, worker protocol, phone transport, pad generation and protected verification. They are neither pure kernel timings nor model tok/s. Candidate order was fixed, so these differences are provisional. The run used a private MPS pipe; existing service contexts remained resident, and this is not a claim of exclusive GPU access or a matched serving-MPS condition.

The MR=8/G8 compiled function reports255 registers and24 bytes of local memory, versus255 registers and0 local bytes for G4. The occupancy API reports a potential limit of one block per SM for every tested candidate; it does not measure achieved occupancy. These facts do not, by themselves, establish the cause of the timing difference.

The full run passed9 invocations/36 candidates and the host capture passed with146 readings per card. Intentional attribution holds and CPU reference work are inside the37.6-second capture, so whole-run GPU utilization is not compute utilization. All owned test processes exited.

[Detailed evidence](v100-kernel-sweep-evidence.json)
