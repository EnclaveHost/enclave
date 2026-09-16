# Where `read_all()` spends time

The receive calls are major waiting points. Their elapsed time is not CPU execution time: they include transport, scheduling and the time until a reply is available.

Two short, opposite-order comparisons used the same Qwen3.8 27B Q8 model, Pixel protected VM, V100 worker, prompt state, APK and verified work. Every trial generated 16 tokens and used fresh pads.

| Measurement, total per 32 tokens in each condition | Ordinary receive | Receive threshold enabled |
|---|---:|---:|
| Decode throughput | 0.7944 tok/s | 0.9003 tok/s |
| Decode elapsed | 40.281 s | 35.544 s |
| Reply-header region, elapsed | 13.336 s | 13.704 s |
| Reply-header region, CPU | 0.555 s | 0.519 s |
| Reply-body region, elapsed | 10.097 s | 7.867 s |
| Reply-body region, CPU | 1.469 s | 0.952 s |
| Reply-body voluntary context switches | 42,961 | 5,712 |

The 13.3% combined throughput gain and 86.7% reduction in body context switches support reducing receive wakeups as a useful optimization. Context switches are not packet counts. The body elapsed-time change does not explain the whole decode difference.

The first off→on pair slowed down (0.882→0.794 tok/s); the reversed on→off pair measured 1.040 versus 0.723 tok/s. This spread limits confidence in the size of the sustained benefit. It is not a new overall record or evidence of reaching 20 tok/s. The experiment remains disabled by default.

Both runs passed exact output/work checks with no verification failures, local fallback, missing pads or pad waits. All 13 standard analyses and four additional analyses passed for each run. The first operation-traffic analysis invocation omitted its geometry argument; its original failure log is retained, and the corrected invocation passed. Protected-guest stack sampling remains unavailable; it is not interpreted as zero guest CPU usage.

Full measurements and controller cleanup receipts: [comparison JSON](27b-paired-rcvlowat-comparison.json).
