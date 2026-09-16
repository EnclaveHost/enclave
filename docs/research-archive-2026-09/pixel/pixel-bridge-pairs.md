# Pixel bridge comparison, 8 September 2026

All twelve 64 KiB bridge runs passed exact content/byte checks and detect-only network coverage. Native had lower p50 in five of six paired comparisons. The median paired p50 change was **−6.18%**; median per-run p50 was **10.300 ms Java / 9.554 ms native**. Pair 5 went the other way and is retained below. Variation is wider than the typical improvement, so this is a modest, provisional preference for the native bridge.

| Pair | Order (A=Java, B=native) | Java p50 ms | Native p50 ms | Native p50 change |
|---|---|---:|---:|---:|
| 1 | AB | 10.698 | 10.186 | -4.8% |
| 2 | BA | 10.839 | 9.645 | -11.0% |
| 3 | AB | 9.894 | 9.463 | -4.4% |
| 4 | BA | 10.095 | 9.331 | -7.6% |
| 5 | AB | 7.139 | 10.322 | +44.6% |
| 6 | BA | 10.505 | 9.162 | -12.8% |

Each run used 200 timed round trips after warm-up (210 data frames total), 13,763,408 bytes in each direction including control/header bytes, and the same version 6 APK on Pixel 8 Pro. Orders alternated AB/BA. No unrelated CPU/GPU benchmark ran during this comparison. All watchdog wait statuses were zero; all owned collectors/servers were stopped and reaped. The existing phone VM storage, workers and stopped dealer were preserved.

This measures the guest-vsock/app-bridge/USB-NCM/host-echo path. It is **not model inference throughput**, GPU kernel time, or a 27B token-rate result. It compares Java with the current native circular-buffer implementation, not native before/after the circular-buffer patch. Larger frames and the real model still require separate validation.

Measured interval: 22:03:50–22:07:18 UTC. APK SHA-256: `f9ce673bdc71c66e30bb74b036425907c3306866429513329c71e41b1ca49729`. Source records: `bb-pairs64k-2/legs.jsonl`, SHA-256 `4bce2e32b5bd11c85fd5b375f5dfbf7688123bc42a76a2c82bb218806d78ee87`. The earlier `bb-pairs64k-1` failed in the launcher before the native leg; it contains no complete pair and is excluded.

Code-path caveat: the app starts its CPU burners only in engine mode. Passing BURN=5 did not activate them for bridgebench. These measured latencies are not lower bounds for the boosted engine route.
