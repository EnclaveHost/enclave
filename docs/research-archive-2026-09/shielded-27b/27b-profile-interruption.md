The first full profiling attempt stopped before decoding after **7m10s**. The Enclave auto-updater installed `v0.5.769-cpu` and restarted the managed workers, triggering the test’s process-identity guard. The phone and all test processes were stopped. A second attempt is running with the replacement worker identities verified; the GPU binary hash is unchanged.

The interrupted attempt has **no tok/s result and no completed CPU instruction profile**. It did capture two 809,039,872-byte pad ingestions:

| Stage | Shipment 1 | Shipment 2 |
|---|---:|---:|
| Total wall time | 30.796s | 32.019s |
| Receiver thread CPU time (overlaps wall stages) | 17.733s | 18.525s |
| Socket read wall time | 14.403s | 14.107s |
| Storage write wall time | 13.642s | 14.590s |
| Streaming SHA wall time | 1.539s | 1.798s |
| fsync wall time | 1.179s | 1.473s |
| Judge/publish wall time | 0.025s | 0.045s |

These occurred during setup. They do not establish which work limits decoding. The complete run is intended to correlate guest source spans, CPU instruction samples, the native bridge, host forwarding, the GPU worker, and fresh pad delivery.
