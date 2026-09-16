# 27B poll-delay investigation — v48

**The poll delay is not fixed.** This completed run identified a concrete socket-lock stall; it did not establish a throughput improvement.

| Trial | Tokens | Decode time | Decode tok/s | Steady tok/s |
|---|---:|---:|---:|---:|
| 1 | 16 | 19.187 s | 0.834 | 0.864 |
| 2 | 16 | 17.407 s | 0.919 | 0.956 |

The whole cycle finished in **521.690 s**, including **8.539 s** of cleanup. Both trials used the real offloaded 27B path: 2,441 offloaded nodes, no local fallback, 6,764 consumed pad cells, and zero verification failures or missed pads per trial. Text and MTP decisions matched the expected workload.

For trial 1, body call 303 spent 143.087 ms in `poll()`. At least 120.421 ms occurred after the Android app completed its VSOCK send. The Android vhost worker was blocked for **117.956 ms in `lock_sock_nested()`**, with `io_wait=0`, and was explicitly woken by the `vsock-pads` thread. This identifies socket-lock contention in this event.

The matching Android host source holds a socket lock while allocating and copying pad packets. A guest-to-host packet can make the shared vhost worker wait for that lock and consequently delay servicing the reply connection. That call chain is a source-based explanation, not a captured kernel stack. Other long waits have different timing and remain unresolved.

The next candidate is an opt-in **64 KiB pad write cap**, preserving the current default. Smaller 4 KiB/8 KiB caps were already unsuccessful. The new cap may reduce lock hold intervals, but individual allocations can still stall and available credit can split a send into multiple packets. Throughput and full-trial socket-lock wait time must decide whether it helps.

All 409 weights used four preparation jobs, with 1,636 successful thread creations and no inline fallback. These counts do not establish four simultaneously running physical cores.

Validation: all 13 standard analyses, receive-operation analysis, and nine additional analysis jobs completed successfully. The initial scheduler analysis failed because the saved thread snapshot had not been converted to its required identity-only JSON format. Its failure log was retained; actual observed identities were converted without inventing scheduling data; the failed and unexecuted analyses then passed.

The trials use the established 4 MiB then 256 KiB receive-window order. They are short diagnostic trials, not sustained production throughput measurements. Trust and verification requirements are unchanged.

[Machine-readable evidence](27b-poll-delay-v48.json)
