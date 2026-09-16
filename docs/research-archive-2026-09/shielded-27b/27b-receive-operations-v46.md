# Measured operations inside the receive path

**95.15% of receive elapsed time was inside `poll()`** in the completed validation run. `recv()` accounted for 3.45%. This identifies the waiting syscall; the cause of delayed readiness remains under investigation.

These are ten operation/phase combinations using five source calls. Elapsed and guest CPU values average two 16-token trials; counts cover all 32 tokens.

| Rank | Phase | Operation (shielded-wire.c line) | Elapsed ms / 16 tokens | Guest CPU ms / 16 tokens | Calls / 32 tokens |
|---:|---|---|---:|---:|---:|
| 1 | header | poll (381) | 7235.58 | 192.03 | 3,148 |
| 2 | body | poll (381) | 3991.77 | 162.76 | 5,518 |
| 3 | body | recv (387) | 369.94 | 355.12 | 5,518 |
| 4 | header | recv (387) | 37.01 | 34.83 | 3,148 |
| 5 | body | set (369) | 14.52 | 9.56 | 3,922 |
| 6 | header | restore (399) | 10.81 | 9.47 | 3,148 |
| 7 | header | get (360) | 10.70 | 10.62 | 3,148 |
| 8 | header | set (369) | 8.23 | 8.10 | 3,148 |
| 9 | body | get (360) | 7.13 | 7.02 | 3,148 |
| 10 | body | restore (399) | 7.09 | 7.00 | 3,148 |

Across both trials: 23.599 seconds in receive spans, 22.455 seconds in poll calls, and 0.710 seconds of guest-accounted poll CPU. The longest single poll lasted 699.84 ms. Guest CPU accounting is not physical-core measurement, and instrumentation adds overhead.

Trial 1 (4 MiB receive window): **0.9569 tok/s**. Trial 2 (256 KiB): **0.7833 tok/s**. Both generated the same expected 16 tokens with matching work and MTP decisions. A single order does not establish a window speedup.

Validation: route b27-recv-detail-2 completed in 542.06 seconds including cleanup. All 6,820 receive records passed the corrected setup/timed-mode checks and exact joins. All 13 standard analyses plus receive, TCP, fault, traffic and pad-delivery analyses passed. The phone stopped, owned processes exited, and the pad bank cleared. An incomplete owned shipment was quarantined and never reused.

The earlier failed-run postmortem remains separately preserved: [report](/home/steven/Documents/Codex/2026-09-07/i-w/outputs/27b-receive-operations-v46-first-postmortem.md). Its original failure has not been relabelled as a passing live run.

[Detailed measurements and provenance](/home/steven/Documents/Codex/2026-09-07/i-w/outputs/27b-receive-operations-v46.json).
