# Measured operations inside the receive path

**96.2% of receive time was inside `poll()`**, waiting for socket readability. `recv()` used 2.4%; the three socket-option operations together used 0.51%.

The table separates header and body use of the same five source calls. These are ten measured operation/phase combinations, not ten different functions. Values average the two 16-token diagnostic trials; call counts cover both trials.

| Rank | Receive phase | Source operation | Elapsed ms / 16 tokens | Guest CPU ms / 16 tokens | Calls / 32 tokens |
|---:|---|---|---:|---:|---:|
| 1 | header | [poll, line 381](/home/steven/Projects/enclave/wasm/ggml-shielded/shielded-wire.c:381) | 7185.44 | 114.52 | 3,148 |
| 2 | body | [poll, line 381](/home/steven/Projects/enclave/wasm/ggml-shielded/shielded-wire.c:381) | 3716.40 | 108.75 | 5,496 |
| 3 | body | [recv, line 387](/home/steven/Projects/enclave/wasm/ggml-shielded/shielded-wire.c:387) | 234.71 | 224.37 | 5,496 |
| 4 | header | [recv, line 387](/home/steven/Projects/enclave/wasm/ggml-shielded/shielded-wire.c:387) | 31.73 | 26.80 | 3,148 |
| 5 | body | [set, line 369](/home/steven/Projects/enclave/wasm/ggml-shielded/shielded-wire.c:369) | 13.79 | 11.65 | 3,937 |
| 6 | header | [restore, line 399](/home/steven/Projects/enclave/wasm/ggml-shielded/shielded-wire.c:399) | 10.55 | 9.50 | 3,148 |
| 7 | header | [get, line 360](/home/steven/Projects/enclave/wasm/ggml-shielded/shielded-wire.c:360) | 9.55 | 9.45 | 3,148 |
| 8 | body | [get, line 360](/home/steven/Projects/enclave/wasm/ggml-shielded/shielded-wire.c:360) | 8.58 | 8.37 | 3,148 |
| 9 | header | [set, line 369](/home/steven/Projects/enclave/wasm/ggml-shielded/shielded-wire.c:369) | 8.17 | 7.72 | 3,148 |
| 10 | body | [restore, line 399](/home/steven/Projects/enclave/wasm/ggml-shielded/shielded-wire.c:399) | 7.46 | 7.31 | 3,148 |

Across both trials, receive spans totalled 22.658 seconds; the poll calls totalled 21.804 seconds elapsed and 0.447 seconds of guest-accounted CPU. The longest individual poll was 368.17 ms.

This identifies the waiting syscall. It does not identify a guest kernel function, distinguish every delivery/wakeup mechanism, or establish that GPU compute caused the wait. Clock reads perturb timing, and guest CPU accounting is not a direct physical-core measurement. Remaining receive time includes loop logic and observer overhead.

The first 16-token trial produced 1.0402 tok/s with the original receive window; the second produced 0.8283 tok/s with 4 MiB. This single diagnostic order is not evidence of a speed improvement or reversal of the earlier balanced window result.

Validation scope: both inferences completed with matching text, workload and MTP decisions. All 6,820 read records join exactly to source/WS spans and complete bridge frame bytes. The original 520.07-second run remains **COMMAND_FAILED** because my validator incorrectly required the timed receive threshold during setup. Postmortem validation confirms 524 setup reads correctly used cap 0 and 6,296 timed reads used 131072; three wrong-mode mutations were rejected. Final live route guards after that failed check did not run. Phone, owned processes and pad bank were cleaned up.

[Measurements, operation counts, longest reads, clock bounds and provenance](/home/steven/Documents/Codex/2026-09-07/i-w/outputs/27b-receive-operations-v46.json).
