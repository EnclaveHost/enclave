# V100 measurements — 8 September 2026

The historical 27B phone run used **one** V100-family 32 GB card. Its recorded route selects GPU `1397d8cd…`; the other V100 was not part of that path. There is no retained per-run GPU utilization trace for that historical leg, so the route does not establish how busy the card was.

**Measurement correction:** the two new scratch runs read an adjacent configuration requesting the platform MPS pipe and a 50% active-thread ceiling. The serving worker requests 100%. All four scratch worker startup logs reported **40 SMs**. Their timings and scaling must not be treated as full-capacity or serving-condition performance. Their exact arithmetic checks and graph-cache counts remain valid. A subsequent 80-SM output-path comparison is described below.

The actual 27B Q8 phone result remains **0.92 tokens/s steady**, or **0.66 tokens/s across the complete decode interval**. That was a short 16-token, context-1024 test. It does not establish long-context performance, and the 20 tokens/s goal has not been reached for 27B.

New isolated diagnostics used the second V100 (`042eb279…`) and monitored both cards. They registered 409 nodes in 262 fused groups with the actual 27B dimensions, using public synthetic values. Both profiled and uninstrumented runs passed, including 960 exact arithmetic checks per cache setting. This is a worker test, not model inference, pad refill, or the phone transport path.

Recorded uninstrumented median host time per fused worker exchange on loopback, **subject to the MPS configuration caveat above**:

| Rows per exchange | Cache capacity 256 | Cache capacity 2048 |
|---:|---:|---:|
| 1 | 0.147 ms | 0.145 ms |
| 4 | 0.256 ms | 0.239 ms |
| 8 | 0.478 ms | 0.449 ms |
| 16 | 0.897 ms | 0.876 ms |

The profiled and uninstrumented medians differed by at most 0.005 ms in this one matched pair. This does not establish a precise instrumentation overhead. At cache capacity 256, both runs recorded 12,588 misses and 48 capacity flushes; at 2048 they recorded 11,526 hits, 1,062 misses and no capacity flushes. The larger cache is an opt-in change; these results do not establish a phone speedup.

During the profiled run’s 16-row timed blocks, the second card reported roughly 82–83% GPU utilization; the first card reported 0% in those blocks. There were only ten readings per card in each block, and the one-row blocks had just two. These are driver-reported sample averages, not measured kernel occupancy or exact fractions of execution time. Whole-command utilization includes lengthy weight upload and setup, so it should not be used as compute utilization.

The phone engine currently adopts one worker connection. Existing multi-link placement executes consecutive groups synchronously and has link-specific pad domains. The new experiment instead splits public weight columns across two GPUs behind one worker connection: both cards write their disjoint columns into one reply, preserving the existing pad domain and verification. No two-card phone result has been demonstrated.

[Structured diagnostic evidence](/home/steven/Documents/Codex/2026-09-07/i-w/outputs/v100-diagnostic-evidence.json) records binary/geometry/CSV/result hashes and the per-block observations.

MPS thread percentages constrain available execution resources; they do not reserve a fixed GPU share or imply proportional runtime. The effective limit can be queried from the CUDA context. [NVIDIA MPS documentation](https://docs.nvidia.com/deploy/mps/when-to-use-mps.html).

A later small preflight reported the correct second V100 UUID and **80 SMs**, with all three output variants passing arithmetic checks. Its overall status was **FAIL** because its short lifetime produced no matching process-attribution sample and insufficient GPU-window coverage. No performance conclusion is drawn from it. A second live platform worker also holds an idle context on that card; the scratch run does not have exclusive ownership of the physical GPU.

The repeated preflight **passed** after adding a 2-second observation hold outside the timed work. It confirmed the exact second V100 UUID, 80 SMs, matching process attribution, all arithmetic checks, and clean completion, with nine bracketed GPU observations per card. It covers one fused group at one row width with five timing iterations; it validates the measurement setup and does not establish 27B inference performance. The subsequent larger output-path comparison also passed.

The larger output-path diagnostic passed all 28 shapes and 84 variants with 80 SMs verified per process. It supports keeping the existing mapped output path. See the [scoped result table](/home/steven/Documents/Codex/2026-09-07/i-w/outputs/v100-output-path-comparison.md); this is separate from the older 40-SM full-worker tests and from actual phone inference.


The full262-group synthetic exchange comparison has now passed on a checked80SM U2 context. The cache2048 condition eliminated capacity flushes; see [the full-exchange report](/home/steven/Documents/Codex/2026-09-07/i-w/outputs/v100-full-exchange-80sm.md). This remains a host-only diagnostic, not another phone27B inference result.

The balanced full-worker A/B/B/A comparison found **7.54% less host exchange time at eight rows and 9.33% at sixteen rows** with the MR8 G4 planner candidate. One-row and four-row controls moved by less than 1%. The reviewed implementation is published as an opt-in setting, default off; no live worker was restarted to enable it. See the [MR8 complete-worker report](/home/steven/Documents/Codex/2026-09-07/i-w/outputs/v100-full-exchange-mr8-g4.md). These worker reductions have not yet been measured through the protected phone route.

A hardware identity check established that the pair is asymmetric: U2 (`042eb279…`, Tesla V100-PCIE-32GB) has **80 SMs**, while U1 (`1397d8cd…`, Tesla PG500-216) has **72 SMs**. NVML's physical CUDA-core counts (5120 and 4608) agree with fresh CUDA contexts and both live-worker startup logs. The original 27B phone test used U1. The first two-card diagnostic was stopped because its gate incorrectly expected 80 SMs on both cards; that failed run is retained. The corrected driver pins the exact name and SM count per UUID. This hardware difference alone does not establish a speed ratio.
