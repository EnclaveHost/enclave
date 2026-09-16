# CPU refill slab comparison

**Keep the existing 2,048-element slab.** The exploratory sweep found no alternative that consistently improved all three measured shapes. The 1,024-element candidate improved the gate member slightly but did not establish a gain across the other shapes. The down-projection result varied substantially between repeats, so small differences are inconclusive.

| Shape | Slab | First logical G-MAC/s | Second logical G-MAC/s |
| --- | ---: | ---: | ---: |
| ffn_gate_member | 512 | 454.24 | 466.99 |
| ffn_gate_member | 1024 | 490.79 | 487.57 |
| ffn_gate_member | 2048 | 463.59 | 475.77 |
| ffn_gate_member | 4096 | 467.99 | 487.83 |
| ffn_gate_member | 8192 | 467.42 | 397.72 |
| ffn_down | 512 | 513.82 | 484.60 |
| ffn_down | 1024 | 652.10 | 648.50 |
| ffn_down | 2048 | 839.90 | 590.13 |
| ffn_down | 4096 | 486.59 | 695.75 |
| ffn_down | 8192 | 605.18 | 574.41 |
| ssm_out | 512 | 405.58 | 428.54 |
| ssm_out | 1024 | 492.63 | 429.47 |
| ssm_out | 2048 | 503.45 | 510.21 |
| ssm_out | 4096 | 410.53 | 508.18 |
| ssm_out | 8192 | 403.00 | 414.31 |

The five candidates ran in forward order and then reverse order, each in a fresh process with identical deterministic public inputs. Each process used batch16, sixteen independent lanes and eight timed refill calls per lane. All 30 cases passed their pre/post sampled scalar checks and cleanup gates; source and binary identities stayed stable. The complete sweep took14.508seconds. Each candidate had also passed25 small success/fault tests and300ASan/UBSan normal/forced-allocation-failure shape pairs around all slab boundaries.

These are CPU arithmetic rates. They exclude PRF generation, encryption, file publication, the actual mixed dealer schedule and the full27B output head; they are not model token rates. No production change was made from this sweep.
