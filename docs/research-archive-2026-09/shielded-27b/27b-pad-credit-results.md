# 27B pad-window experiment

The 8 KiB pad window did not establish a speed improvement. Keep the default window. Both runs completed inference and cleanup within ten minutes. These are measurements from one candidate/control pair, not a replicated estimate of the window’s effect.

| Setting | Trial 1 tok/s | Trial 2 tok/s | Combined tok/s | Combined steady tok/s | Full cycle |
|---|---:|---:|---:|---:|---:|
| Default | 0.727 | 0.644 | 0.683 | 0.705 | 560.58 s |
| 8 KiB | 0.701 | 0.513 | 0.592 | 0.594 | 518.90 s |

Each trial generated 16 tokens. Combined rates are total tokens divided by total decode time. Trial 1 and trial 2 use different inference-reply receive windows (4 MiB and 256 KiB), so they are separate conditions, not repeat samples.

The strict comparison verified identical APK contents, runtime sources, model/calibration, settings, generated text, MTP decisions, and work counters. Each trial completed 2,441 offloaded nodes with zero local nodes, verification failures or pad misses. Neither run waited for pads. The experimental pad listener and accepted connection read back 8,192 bytes; the default connection’s actual window was not measured.

| Pad receipt, first eight 202,278,400-byte shipments | Minimum | Maximum |
|---|---:|---:|
| Default | 5.85 s | 10.73 s |
| 8 KiB | 29.52 s | 45.93 s |

These are complete receiver intervals, including read/write/hash/publish work, rather than network bandwidth measurements. They describe the first eight startup shipments on each run, not bytes attributed to decode by dividing elapsed time.

The previously incomplete profiles are now processed without dropping scheduler rows. The paged analyzer handled 1,058,952 relevant scheduler rows in 13.06 seconds; the vhost analyzer aggregated 249,495 states in 2.45 seconds. Both matched the original analyzers on the control trace after documented metadata/order normalization. The capture’s existing head/tail coverage limits remain; scheduler blocking and wake context do not by themselves identify a blocking cause.

Next: a default-off diagnostic records each card/link/group’s ready pads, in-flight imports, cursors, reserved window and actual resident file intervals. This measures the state needed to evaluate pausing pad traffic during decode. It does not pause delivery or change the trust boundary.

[Full validated comparison](27b-pad-credit-same-apk-comparison.json)
