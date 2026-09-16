# 27B pad-write cap — first v49 result

**The `poll()` slowdown is not fixed.** The initial cross-version comparison below showed no consistent throughput gain. The completed same-APK control now shows a small possible benefit; see [matched results](27b-pad64-same-apk-comparison.md).

| Build / pad-write cap | Trial 1 tok/s | Trial 2 tok/s | Combined tok/s |
|---|---:|---:|---:|
| v48 / 0 B | 0.834 | 0.919 | 0.874 |
| v49 / 65536 B | 0.954 | 0.790 | 0.865 |

Trial 1 uses a 4 MiB reply receive window; trial 2 uses 256 KiB. Their within-run spread therefore does **not** estimate random noise. These are short diagnostic trials. The table is a descriptive comparison across APK versions; the same-APK uncapped control has completed and is reported separately. Combined rate is total generated tokens divided by summed decode time.

With the cap, steady rates were **1.016 and 0.807 tok/s**. The whole cycle completed in **525.481 s**, including **14.274 s** of cleanup. Both trials produced 16 tokens with the expected text and MTP decisions, 2,441 offloaded nodes, no local fallback, and zero verification failures or missed pads.

| Build | Trial | Observed `lock_sock_nested` wait | Trace head omitted | Uncovered inside observed window |
|---|---:|---:|---:|---:|
| v48 | 1 | 826.714 ms | 220.618 ms | 6.303 ms |
| v48 | 2 | 261.787 ms | 0.000 ms | 0.000 ms |
| v49 | 1 | 550.372 ms | 471.637 ms | 5.721 ms |
| v49 | 2 | 659.580 ms | 0.000 ms | 0.000 ms |

These are vhost scheduling intervals within the app’s benchmark markers, not exact guest decode boundaries. Trial 1 coverage differs, so its totals are not a clean measure of a change. Trial 2 is fully covered in both captures. Unknown blocking reasons remain separate. Other post-send waits still occur, including an approximately 83.6 ms interval with the vhost worker sleeping and no named blocking function.

Implementation: commit `4fa9ce575edcc93a4139448cf19e21e39203a836` adds the opt-in 65,536-byte value to the existing app validators and copy-path tests. The default remains unchanged. The APK changes only its manifest and Java bytecode; all native libraries and assets are preserved from v48. Tests cover exact bytes, partial reads, cancellation, incomplete/oversized shipments, and rejected cap values.

Validation: all 13 standard analyses, receive-operation analysis, and nine additional analyses passed. Two traffic-analysis invocations initially lacked the geometry argument; their failure logs were retained, and only those two were rerun successfully with the pinned geometry. The first uncapped-control attempt failed the forwarder listener-ownership check before inference; it cleaned up in 5.288 s and remains excluded. The unchanged retry passed startup admission.

[Machine-readable results](27b-pad-write-cap-v49.json)
