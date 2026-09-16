The profile now identifies a specific pad-delivery stall and a separate traffic cost in the current 27B design. **Neither is a measured throughput improvement. Twenty tok/s remains unmet.**

In the latest control, the output projection consumed row 127 and then waited for row 128. Its next wire request has a **13.717062-second** preceding gap; the independent pad-wait counter reports **13.7156 seconds**. The request reaches the Android bridge **0.242295 seconds after shipment 128 is acknowledged**. This ties the stall to pad availability, rather than slower V100 calculation.

The shipment contains **809,039,872 bytes**. Android fetch took 7.242 seconds. VM receipt took 27.035 seconds, including 20.665 seconds reading, 4.123 writing, 1.675 hashing, 0.501 syncing and 0.060 judging/publishing. These stages overlap decoding. The receiver currently hides the file until complete receipt, verification and durability checks succeed. Source: `anchor_payload.c` receipt loop at 714 and publication at 744–749; `shielded-tee.c` availability wait at 1276.

A 16-row shipment is **202,278,400 bytes** with the existing format. The running test changes only shipment count from 64 to 16, preserving the same APK, MTP behavior, head pool, transport and authentication. Smaller files also require more publications and syncs, so the result must be measured.

The frame audit shows different consumption rates among model groups:

| Group set | Number of groups | Rows consumed per group, per 16 tokens | Without discarded draft-ahead |
|---|---:|---:|---:|
| Ordinary target projections | 256 | 25 | 25 |
| MTP head projections | 5 | 59 | 35 |
| Shared output projection | 1 | 69 | 45 |

Each shipped index contains all 262 groups, totaling **12,640,864 bytes per index**, plus a 24,576-byte file header. The group with the highest consumption drives new ranges. If this observed MTP pattern repeats, all-group shipment production must keep pace with 69 new indices per 16 tokens. Other groups can retain their unused cells for later; they are not necessarily discarded immediately.

| Conditional traffic calculation | Ahead enabled | Ahead disabled |
|---|---:|---:|
| Consumed correction cells per 16 tokens | 355.383 MB | 332.857 MB |
| Uniform all-group shipment cells per repeated 16 tokens | 872.220 MB | 568.839 MB |
| Replies per 16 tokens | 355.289 MB | 332.764 MB |
| Incoming replies plus uniform shipments at 20 tok/s | 1534.4 MB/s | 1127.0 MB/s |

The observed USB connection is 5 Gb/s, whose raw signaling rate corresponds to at most 625 MB/s before overhead. Smaller complete shipments address publication latency; they do not remove this traffic requirement. Even supplying only consumed correction cells still requires 888.3 MB/s with the original observed pattern. **Reaching 20 tok/s requires changing the data flow or execution mix as well as speeding up transport.** These are conditional capacity calculations, not sustained benchmark results; startup stock and shipment-boundary rounding are excluded.

Reported CPU frequency also varies between trials. In the latest control, the bridge's execution-weighted mean was 1951.5 / 1650.2 MHz; in the no-ahead run it was 1951.6 / 1546.1 MHz. These are scheduler-weighted policy-frequency events, not measured retired cycles or proof of thermal throttling. The analysis covers the owned bridge, pad fetch/stream and vhost threads and leaves any time before the first frequency event unknown. This is another reason not to interpret one average-speed ratio as a repeatable gain.

The accompanying JSON preserves exact frame/counter reconciliation, the stall timestamps, source geometry hashes, and frequency coverage. No partial-file publication, sparse shipment format, or NIC setting change has been implemented.
