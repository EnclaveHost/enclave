# Latest 27B receive-delay measurements

**The poll delay is not fixed.** The completed v47 run measured **0.7988 and 0.7942 tok/s**. Across both 16-token trials, `poll()` occupied 24.066 seconds (95.69% of the 25.149-second receive spans). `recv()` occupied 0.662 seconds.

The longest measured poll was **1024.72 ms**, with 0.050 ms of guest-accounted CPU. At least **163.45 ms** remained after Android completed the VSOCK reply send. This interval has complete trace coverage.

During that residual interval, nearly all VM vCPUs slept. The VSOCK host worker spent 162.958 ms blocked while the pad writer spent 161.984 ms running; sampled pad-writer stacks show memory compaction during socket allocation. The scheduler explicitly records that pad writer waking the blocked VSOCK worker. The blocked function was not recorded, so this does not establish its exact wait routine or explain every other stall. Concurrent durations must not be added.

The following ten entries are phase/operation combinations, using five source calls. Elapsed and CPU columns average two 16-token trials; counts cover all 32 tokens.

| Phase | Operation (wire source line) | Elapsed ms / 16 tokens | Guest CPU ms / 16 tokens | Calls / 32 tokens |
|---|---|---:|---:|---:|
| header | poll (381) | 8116.51 | 159.46 | 3,148 |
| body | poll (381) | 3916.43 | 189.60 | 5,616 |
| body | recv (387) | 303.40 | 283.54 | 5,616 |
| header | recv (387) | 27.76 | 24.57 | 3,148 |
| header | restore (399) | 21.64 | 19.76 | 3,148 |
| header | get (360) | 15.15 | 12.45 | 3,148 |
| body | set (369) | 12.13 | 8.18 | 3,952 |
| header | set (369) | 10.48 | 9.69 | 3,148 |
| body | get (360) | 7.39 | 7.26 | 3,148 |
| body | restore (399) | 7.36 | 7.24 | 3,148 |

Preparation improved in a descriptive comparison against v46: pad-check time fell from 80.264 to 34.055 seconds, while total registration fell from 384.084 to 372.844 seconds. Other stages grew. This is one run per build, not an isolated or replicated thread-limit effect, and not a decode speed gain.

The full cycle completed in 535.054 seconds including cleanup. The phone stopped, owned processes exited and the bank cleared. All 6,820 receive records and the standard, receive, TCP, fault, traffic, pad-delivery and poll-stall analyses passed. Wire source was verified byte-identical to v46 and bound to the measured v47 APK and its source revision.

[Measurements and provenance](/home/steven/Documents/Codex/2026-09-07/i-w/outputs/27b-receive-operations-v47.json).
