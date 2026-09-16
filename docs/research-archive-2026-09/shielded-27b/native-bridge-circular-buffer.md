# Native bridge circular-buffer experiment

A circular buffer reduced the bridge thread’s CPU cost under controlled receiver backpressure. It did not materially reduce transfer wall time. This is a desktop socketpair measurement, not a Pixel or model-throughput result.

| Receiver pause per MiB | Linear CPU | Circular CPU | CPU reduction | Circular wins | Linear / circular wall |
|---|---:|---:|---:|---:|---:|
| 0 ms | 9.668 ms | 8.837 ms | 8.6% | 4/6 | 64.227 / 64.058 ms |
| 1 ms | 22.990 ms | 10.431 ms | 54.6% | 6/6 | 88.592 / 88.391 ms |
| 20 ms | 31.741 ms | 12.633 ms | 60.2% | 6/6 | 525.993 / 525.974 ms |

Each condition contains six matched pairs, three in each order, using fresh processes. Each process transfers 24 MiB forward and 12 MiB backward through 8 KiB socket buffers and verifies every byte. Timing covers only the bridge call; CPU time is CLOCK_THREAD_CPUTIME_ID. The first case’s signal storm is disabled during timing. Source and binary hashes stayed unchanged. All 36 processes completed and were reaped; elapsed time was 24.414 s.

At 1 ms and 20 ms receiver pauses, the linear buffer moved a median 1.34 GB and 1.47 GB internally to deliver 36 MiB. The circular variant performed zero compactions. With no receiver pause, the smaller CPU difference won only four of six pairs and is weaker evidence. Desktop scheduling remains uncontrolled.

Correctness checks covered 1 MiB, 4096-byte and 4099-byte capacities under ASan/UBSan, bidirectional exact streams, partial I/O, backpressure, half-close ordering, cancellation, no-progress deadlines, repeated read/send interruptions, dead sinks and descriptor/flag restoration. The change was published in commit `89667679` after independent review. It remains inside the existing opt-in native bridge and was not deployed to the phone at publication.

The earlier 21:11:30 comparison overlapped a compiler and was rejected entirely for performance. These results use only the unchanged repeat at 21:15:49 after an explicit source-only handoff.

[Raw measurements and source/binary hashes](native-bridge-circular-buffer-evidence.json)
