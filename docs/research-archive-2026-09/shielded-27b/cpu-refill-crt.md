# CPU refill: vectorized CRT candidate

The table shows medians of four fresh processes per variant and condition.
Each process ran batch16,32 timed refills per lane, with one warm refill.
The two four-process blocks were ABBA and BAAB. A is the current2048-slab
implementation; B changes only the epilogue to expose independent CRT
calculations to the compiler.

| Shape | Lanes | A logical G-MAC/s | B logical G-MAC/s | Higher median throughput | B wins, adjacent pairs |
| --- | ---: | ---: | ---: | ---: | ---: |
| ffn_gate_member | 1 | 55.73 | 90.60 | 62.6% | 4/4 |
| ffn_gate_member | 16 | 518.40 | 681.62 | 31.5% | 4/4 |
| ffn_down | 1 | 77.88 | 90.58 | 16.3% | 4/4 |
| ffn_down | 16 | 657.62 | 685.77 | 4.3% | 3/4 |
| ssm_out | 1 | 60.11 | 92.60 | 54.1% | 4/4 |
| ssm_out | 16 | 498.49 | 680.44 | 36.5% | 4/4 |

B places three sets of sixteen horizontal sums into a192-byte automatic
array, then executes the existing CRT function in a separate column loop.
The compiler reports64-byte vectorization of that loop, with a32-byte tail;
A's original epilogue has no corresponding vectorized loop. Both keep the
same weight calculations,2048-byte K slabs, tails and allocation-free OOM
fallback. The source change is confined to AVX512; it does not accelerate
phone ARM kernels.

Both variants passed25 tiny success/fault cases and320 full scalar
normal/forced-allocation-failure shape pairs with ASan/UBSan and the actual
optimized object. The320 pairs include20 extreme residue/weight cases through
K65536. The benchmark rejects a no-op timed loop, checks sampled cells per
lane before and after timing, bounds execution and reaps every child.
All48 measured cases passed with stable inputs in40.867 seconds.

[Structured evidence](/home/steven/Documents/Codex/2026-09-07/i-w/outputs/cpu-refill-crt-evidence.json).
