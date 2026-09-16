# Full-worker MR8 kernel comparison

The G=4 candidate reduced the full 262-group host exchange pass by **7.54% at eight rows** and **9.33% at sixteen rows**, averaged over an A/B/B/A sequence of four fresh workers. Both adjacent run orders improved. This is a host worker result; it does not establish a new 27B phone token rate.

| Rows | A first (ms) | B first (ms) | B second (ms) | A second (ms) | Mean time reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 40.456 | 40.265 | 40.460 | 40.996 | 0.89% |
| 4 | 55.496 | 55.031 | 55.536 | 56.109 | 0.93% |
| 8 | 92.144 | 86.988 | 84.452 | 93.280 | 7.54% |
| 16 | 179.462 | 162.879 | 161.905 | 178.724 | 9.33% |

A uses the existing kernel planner. B changes only MR=8 to start at G=4; sixteen rows use two MR=8 launches. The one- and four-row code is unchanged, providing controls. MR=5/6/7 have no measured policy improvement.

Each worker used 409 nodes in 262 real 27B groups, synthetic public values, cache capacity 2048, two warm passes and ten timed passes at each row count. Timings cover complete host loopback exchanges. The four workers form one balanced block: the ten passes within each worker are repeated observations, not ten independent deployments.

All four workers passed 960 selected scalar output checks, 12,588 exchange counts and every one of seven phase-count checks. Every worker was attributed to GPU-042eb279-e6e6-9866-5823-015b8d26946a and reported 80 SMs through independent startup checks. Source and binary hashes remained stable, all owned workers were reaped, and the two-card capture passed with 819 observations per card over 210.609 seconds.

U2 reached 100% reported utilization; the whole-command mean was 15.21%, including weight registration, preparation and cleanup. It is not a steady compute utilization estimate. U1 retained its own contexts, reached 7% briefly and did not execute any owned benchmark worker. Neither GPU was reserved exclusively.

The separate order-balanced kernel confirmation checked every output byte with distinct residue planes and found G=4 faster in all 84 matched pairs. The complete-worker result supports an opt-in setting, which was published as commit `2e363e93` with the production default off. Actual protected-phone inference must still validate its usefulness.

The published setting is `SHIELDED_WORKER_MR8_G4=1`. Six subsequent functional runs passed with default/off/on across rows1,4,5,6,7,8,9,16 (2,112 selected scalar cells,72 exchanges). No live worker was restarted to enable it.
