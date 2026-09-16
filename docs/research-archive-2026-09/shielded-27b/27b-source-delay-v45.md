# Current measured source delays: 27B Shielded inference

**The socket reads are primarily waiting points.** With the 4 MiB receive window, header/body calls accumulated 20.261 s elapsed and 1.428 s caller CPU across 32 generated tokens. Most read time therefore is not CPU execution of the read loop. Elapsed minus caller CPU includes delivery and scheduling; it does not identify one remote instruction.

Both test orders favored the larger receive window: **0.833 → 0.947 tok/s combined (+13.7%)**. The bridge had 19,269 no-progress send attempts with 256 KiB and zero with 4 MiB. Output, MTP decisions, work and verification checks matched. These runs used the same APK v45 and V100 worker.

Values below are **milliseconds per 16 tokens**, averaged separately for each window across the two orders. The rank uses the 4 MiB elapsed column. Each row identifies a timed block through a representative callsite, not an individually timed instruction. Timings come from APK v45; code links were updated to the corresponding callsites in fd13fc9a after receive instrumentation shifted the line numbers.

| Rank | Source callsite | Timed block | 256 KiB elapsed ms | 4 MiB elapsed ms | 4 MiB caller CPU ms |
|---:|---|---|---:|---:|---:|
| 1 | [shielded-wire.c:481](/home/steven/Projects/enclave/wasm/ggml-shielded/shielded-wire.c:481) | Wait for reply header | 7028.42 | 6466.90 | 263.70 |
| 2 | [shielded-wire.c:499](/home/steven/Projects/enclave/wasm/ggml-shielded/shielded-wire.c:499) | Receive reply body | 4534.82 | 3663.67 | 450.35 |
| 3 | [shielded-wire.c:461](/home/steven/Projects/enclave/wasm/ggml-shielded/shielded-wire.c:461) | Send masked request | 906.77 | 884.19 | 144.47 |
| 4 | [ggml-shielded.cpp:1636](/home/steven/Projects/enclave/wasm/ggml-shielded/ggml-shielded.cpp:1636) | Restore outliers and scale output | 644.65 | 572.70 | Not measured |
| 5 | [shielded-tee.c:1876](/home/steven/Projects/enclave/wasm/ggml-shielded/shielded-tee.c:1876) | Acquire pads and mask input | 634.65 | 549.75 | Not measured |
| 6 | [shielded-tee.c:1943](/home/steven/Projects/enclave/wasm/ggml-shielded/shielded-tee.c:1943) | Unmask and verify output side | 387.05 | 379.50 | Not measured |
| 7 | [ggml-shielded.cpp:1468](/home/steven/Projects/enclave/wasm/ggml-shielded/ggml-shielded.cpp:1468) | Encode activations and separate outliers | 352.15 | 312.60 | Not measured |
| 8 | [shielded-tee.c:1950](/home/steven/Projects/enclave/wasm/ggml-shielded/shielded-tee.c:1950) | Verify input side | 220.45 | 200.40 | Not measured |
| 9 | [shielded-wire.c:493](/home/steven/Projects/enclave/wasm/ggml-shielded/shielded-wire.c:493) | Check response buffer capacity | 5.11 | 12.36 | 8.83 |
| 10 | [shielded-wire.c:469](/home/steven/Projects/enclave/wasm/ggml-shielded/shielded-wire.c:469) | Optional overlap callback boundary | 4.38 | 3.53 | 3.76 |

The optimized path is now named `read_reply()`; it falls back to `read_all()` when the receive-threshold option is off. In these four trials the threshold option was on throughout.

1. **Wait for reply header:** The call waits for the first reply bytes through the full request/response path. This elapsed time is not GPU compute time.
2. **Receive reply body:** The call receives the remaining bytes. It includes VSOCK delivery, wakeup and scheduling delays; its caller CPU clock is much smaller.
3. **Send masked request:** The write can wait for transport space. Header and body already use one vectored write.
4. **Restore outliers and scale output:** The production timer covers the member/row loop, including outlier_add, descale and accounting. It does not separate those callees.
5. **Acquire pads and mask input:** The production timer also covers dealt_wait, take_pads and request packing. Actual pad-wait counters were zero in all four trials.
6. **Unmask and verify output side:** Packed replies are unmasked and their Freivalds left-hand terms computed in one pass.
7. **Encode activations and separate outliers:** The production timer covers checked encoding, scratch capacity and outlier extraction.
8. **Verify input side:** The production counter covers Freivalds input terms, including the overlap callback when selected. Do not add a nested overlap timer twice.
9. **Check response buffer capacity:** This source span includes length parsing and buffer-capacity handling. Its small time does not explain the read waits.
10. **Optional overlap callback boundary:** Mostly a callback boundary here. These tiny separately sampled clocks can have CPU slightly above elapsed time; retain that measurement discrepancy.

Measurement limits:

- Ten instrumented source regions, not an exhaustive per-line profile of the entire program.
- Elapsed block timers include their callees and scheduling. Caller CPU excludes other threads, remote GPU and host-kernel work.
- Concurrent MTP work and nested instrumentation prevent adding these rows into an exclusive decode-time decomposition.
- Only socket spans have a separate caller-thread CPU clock. Production timers must not be labelled CPU time.
- The protected guest has no sampled kernel callstacks in these captures. Exact kernel source-line delay is unavailable.
- Both conditions use receive threshold 131072, original ARM kernels and fresh pads. Each condition averages two 16-token trials, one in each order.
- These are short diagnostic inference measurements, excluding startup. They do not establish sustained production throughput.

Machine-readable measurements and exact source hashes: [27b-source-delay-v45.json](/home/steven/Documents/Codex/2026-09-07/i-w/outputs/27b-source-delay-v45.json).
