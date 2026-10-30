# CPU refill reduction-tree experiment

A is the published vector-CRT optimization. B replaces its sixteen independent horizontal reductions with a permute/add tree; it keeps the matrix arithmetic, CRT, slab size and allocation-failure fallback.

| Shape | Threads | Baseline G-MAC/s | Candidate G-MAC/s | Median wall reduction | Candidate paired wins |
|---|---:|---:|---:|---:|---:|
| ffn_gate_member | 1 | 90.6 | 94.6 | 4.28% | 3/4 |
| ffn_gate_member | 16 | 749.2 | 746.9 | -0.32% | 3/4 |
| ffn_down | 1 | 91.4 | 90.9 | -0.49% | 2/4 |
| ffn_down | 16 | 710.0 | 738.6 | 3.94% | 3/4 |
| ssm_out | 1 | 94.1 | 96.0 | 1.98% | 3/4 |
| ssm_out | 16 | 687.9 | 743.7 | 7.50% | 3/4 |

48 fresh processes completed in 35.306 seconds: ABBA then BAAB for each shape/thread count, batch 16, 32 iterations. Every process passed its sampled scalar checks before and after timing, completed cleanup and was reaped. Input hashes stayed stable. No PRF, encryption, file publication, phone transport or inference is included.

Variability is substantial in some 16-thread runs, and some shapes change direction between the two order blocks. The raw paired records are retained; no outliers were removed.

[Evidence and hashes](cpu-refill-reduce-tree-evidence.json)
