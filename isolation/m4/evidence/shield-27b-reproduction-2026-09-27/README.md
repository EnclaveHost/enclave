# 27B masked-throughput reproduction, 2026-09-27

The historical 70%+ range is reachable again in a native masked benchmark. This is not a production SNP throughput claim. The 24.51 tok/s historical peak must be tracked separately from that relative-performance target.

## Measurement scope

Qwen3.8-27B UD-Q4_K_XL, the same public 17-token sky prompt, greedy decoding, two V100-class cards (PG500-216 + V100-PCIE), column-split Shield offload, overlapped Freivalds verification, and one-token MTP. The production Wasmtime/SNP release remained unchanged throughout this investigation.

Native runs use the existing bench-spec2 harness. Each reported run passed its own ordinary-versus-MTP output comparison, with zero observer failures, zero reported Freivalds failures, and no local matmul fallback. This does not establish identical long text across different CPU builds: AVX2 and AVX-512 runs can diverge after the common short prefix. The AVX-512 long run ended at EOS after 214 tokens; it must not be mislabeled as a completed 256-token generation.

## Native results

Best short run: **23.32 tok/s**, repeat **22.63**, against the fresh **30.155 tok/s** unmasked reference (77.3% and 75.0%). Four compute threads reached **22.57** short and **21.53** over 214 tokens. Six compute threads fell to **18.94** over 214 tokens with pad shortages. These long-run results are why the short peak is not a production rollout recommendation.

| Configuration label | Output tokens | Plain tok/s | MTP tok/s | Verify ms/round |
|---|---:|---:|---:|---:|
| native-avx512-refill16 | 64 | 16.79 | 17.94 | 90.030 |
| native-avx512 | 64 | 16.74 | 14.78 | 107.189 |
| native-four-threads | 64 | 20.14 | 20.56 | 75.805 |
| native-four-vector-avx512-pinned | 64 | 19.51 | 19.59 | 82.887 |
| native-four-vector-long | 256 | 17.89 | 18.97 | 89.692 |
| native-four-vector-pinned | 64 | 19.00 | 20.04 | 81.080 |
| native-four-vector | 64 | 17.81 | 17.95 | 90.265 |
| native-historical-engine | 64 | 16.66 | 17.13 | 94.079 |
| native-local-team-long | 214 | 20.31 | 21.53 | 75.558 |
| native-local-team | 64 | 20.16 | 22.57 | 71.251 |
| native-local-team6-long | 214 | 20.34 | 18.94 | 82.695 |
| native-local-team6-repeat | 64 | 20.68 | 22.63 | 70.963 |
| native-local-team6 | 64 | 19.77 | 23.32 | 68.601 |
| native-local-team8 | 64 | 17.98 | 19.01 | 82.305 |
| native-old-binaries | 64 | 17.49 | 18.91 | 84.479 |
| native-refill16 | 64 | 15.64 | 16.61 | 96.460 |
| native | 64 | 16.06 | 14.78 | 106.200 |

Fresh unmasked stock llama.cpp reference: **30.15524 tok/s**, three 64-token synthetic decode samples, sample SD 0.05250; same model file and cards, all layers offloaded, equal layer split, eight CPU threads. This repeats the historical comparison method, not a matched-prompt or matched-algorithm experiment: the masked benchmark uses a real prompt and MTP, while stock llama-bench uses its synthetic ordinary-decode workload. Ratios describe those configurations only.

Historical pt-1: 24.51 MTP tok/s, 64 tokens, 36 rounds, 28 accepted drafts, verify 64.743 ms/round. It was a native benchmark and one peak in a wider spread, not an attested production-guest result.

## Isolated guest results

Every listed guest request passed the existing fresh AMD signature/TCB/measurement/runtime/W^X/TLS checks and returned HTTP 200. The fixtures name no deployment in HOST_DATA; these are standalone lab guests, not production admissions. Timed rates count the 63 tokens emitted after the first token from prefill. Each profile produced identical 64-token output across all seven of its requests.

| Profile | vCPUs | Decode threads | Refill threads, total | Plain median | MTP median |
|---|---:|---:|---:|---:|---:|
| refill16 | 16 | 8 | 16 | 9.69 | 9.94 |
| refill24 | 24 | 8 | 16 | 14.07 | 12.22 |
| wb | 24 | 8 | 16 | 14.11 | 12.47 |
| four | 16 | 4 | 16 | 13.58 | 11.68 |
| vector | 16 | 4 | 16 | 14.00 | 13.45 |

`refill16`: AVX2 CPU module, eight decode threads, sixteen refill threads. `refill24`: same thread settings with 24 vCPUs and public-fixture diagnostics. `wb`: lab-only write-back shared-ring driver with the refill24 settings; no compelling improvement. A subsequent boot-only diagnostic showed write-back PAT entries for both 64-MiB rings. `four`: four decode threads, sixteen refill threads, production WC rings. `vector`: four-thread profile plus the opt-in vector CRT refill kernel.

## Findings and limits

- Historical logs report eight refill threads **per card**. The deployed profile has eight **total**, split four per card. Sixteen total removed the early native pad shortages. More refill workers alone did not solve guest throughput.
- `SHIELDED_REFILL_VECTOR_CRT=1` exists in current source but is off by default. It removed pad misses in the unplaced four-thread native runs, including their long run. With fixed CPU placement, the longer four-thread run still missed 14 pads on one card; the six-thread long run missed 20/28 on the two cards. It did not consistently improve total speed in isolation. Exact arithmetic, bounds, selection, and forced-allocation-failure tests passed (three tests covering many cases).
- Co-locating the OpenMP compute team on one L3 domain is the strongest native lead. The six-thread experiment binds compute threads to CPUs 0,2,3,4,5,6; the split helper to CPU 1; other backend threads to 7-15,23-31. The four-thread case reserves fewer compute cores; eight compute cores starved pad refill again. These CPU numbers describe this EPYC only.
- The preload helper is an experimental native benchmark tool. It restores the caller affinity after each OpenMP region so later children do not inherit one CPU. Its self-test verifies thread placement and restoration. An initial version without restoration serialized startup; that attempt was stopped and excluded. No preload helper was installed into production or any attested guest.
- Native AVX-512 alone, a larger guest alone, and the shared-memory mapping experiment did not reproduce the historical peak. One short peak is not evidence for a production default.
- The historical GPU trace used 1380-MHz SM clocks. The current user was denied permission to set those clocks; no clocks were changed. The fresh unmasked reference nevertheless closely matches the old 30.20 result.
- Background desktop and hosted-app work remained active. A stale CUA runtime consuming roughly two cores was reset between the early and later groups. Comparisons across that point are confounded; no formal quiet-host validation is claimed.

## Reproduction and next implementation boundary

All five existing production apps passed fresh attestation and HTTP 200 after the experiment series. Their release stayed unchanged. Temporary benchmark guests and forwarders were stopped; the boot-only mapping diagnostic powered off before starting an app.

Exact native environment settings are preserved in the `*-config.json` files; runtime/backend/calibration hashes are in `input-hashes.json`. The scripts and CPU-locality helper here retain this host's absolute paths intentionally; they are evidence tools, not portable release inputs. Raw native phase logs and attestation request logs remain under `/home/steven/enclave-bench/v100-shield-20260927/reproduce`; `summary.json` records native log digests.

Before any production port, implement topology-aware thread placement in the measured runtime, account for the guest CPU allocation, and benchmark the complete SNP path with unchanged verification. Do not copy a host-specific LD_PRELOAD or experimental PCI driver into the release. Native 70%+ performance must not be advertised as the isolated production service's performance.
