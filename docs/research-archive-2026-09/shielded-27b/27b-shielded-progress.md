# 27B Shielded measurements

Updated 2026-09-09 08:03 UTC. **The target of 20 tokens/s with verification and fresh-pad replenishment has not been met.** A complete 27B run now fits within the ten-minute test-cycle limit. Its decoding rates remain below the earlier best.

| Measurement | Tokens/s | Scope |
|---|---:|---|
| Direct CUDA, U1 alone | 27.60 | Actual 128-token generation; no Shielded or MTP |
| Best retained Shielded result | 0.92 steady / 0.66 overall | 16 tokens, MTP3; initial pad stock available |
| Four-block sampler, trial 1 | 0.7434 steady / 0.7596 overall | 16 tokens, live dealer, v23 |
| Four-block sampler, trial 2 | 0.7631 steady / 0.6595 overall | Same prompt state; candidate enabled |
| Latest MTP5 + streamed ACK, trial 1 | 0.7616 steady / 0.7517 overall | 16 tokens, live dealer, v18, cached pad transfer |
| Latest MTP5 + streamed ACK, trial 2 | 0.7834 steady / 0.7652 overall | Same session and prompt state, fresh pad consumption |
| Preceding MTP5, trial 1 | 0.7483 steady / 0.6793 overall | v17, ACK readback, otherwise same decode settings |
| Preceding MTP5, trial 2 | 0.7521 steady / 0.7557 overall | Same session and prompt state, fresh pad consumption |
| Preceding MTP3, trial 1 | 0.4765 steady / 0.5253 overall | Same recipe with draft cap 3 |
| Preceding MTP3, trial 2 | 0.6782 steady / 0.6493 overall | Same recipe with draft cap 3 |
| Earlier native-bridge run | 0.3525 steady / 0.4026 overall | 16 tokens, MTP3, ICMP stimulus, live dealer; incomplete stderr |

All use the same 27B Q8 model with different test conditions. These are not controlled measurements of one change's overhead. Context was 1,024; vision and long-context performance were not tested.

The preceding MTP3 run, `b27-prefetch-1`, **passed** its complete capture, model/APK identity, repeated output, counter and cleanup checks. The entire cycle took **526.96 seconds (8 minutes 47 seconds)**. Model loading took 24.6 seconds; first prefill, including registration and worker setup, took 416.053 seconds. Each trial generated 16 tokens; decoding took 30.458 and 24.643 seconds respectively. The steady windows cover 13 tokens each. The result does not establish sustained pad production capacity.

**Actual GPU execution was confirmed:** the owned worker was pinned to the first V100 (`GPU-1397d8cd-27ae-e1a6-a7ed-e485e7ca002c`), device memory reached **25,863 MiB**, and each trial recorded **2,751 offloaded nodes / 574.308 GMAC**, zero local fallback, zero verification failures and zero missed pads. The second V100 peaked at 351 MiB and did not run the model. Device memory is sampled across the whole test; it is corroborated by worker identity and offload counters, not treated as proof by itself. The worker recorded 3,802 total exchanges and 1.055 seconds in its GEMM handling across prefill, prompt observation and both decoding trials. That timing includes setup/locking/synchronization and is not a decode-only GPU utilization percentage.

Source reads stayed at 409 / 27,649,474,560 bytes from the end of prefill through both trials: retaining the small SSM tensors eliminated additional authenticated source reads during decoding. This confirms the intended behavior, but the combined recipe did not beat the previous 0.92 steady tok/s result. A new 771 MiB pad shipment was accepted during trial 2, so delivery contention remains part of these live-replenishment measurements. MTP3-to-5 was compared with the same live dealer recipe, as described below.

The newer `b27-mtp5-live-1` run **passed in 533.59 seconds**, including cleanup. Its only planned decode-setting change was draft cap 3 to 5. Both 16-token outputs have the same text hash as both MTP3 outputs. Five verification rounds replaced six; each trial used 6,764 pad cells versus 5,413 at MTP3, so fewer exchanges came with about 25% more pad demand. Each trial recorded 2,441 offloaded nodes / 720.956 GMAC, zero local fallback, zero verification failures and zero pad misses. The first V100 peaked at **25,851 MiB**; the second was idle.

Combined over the two trials, MTP5 achieved **0.7154 overall / 0.7502 steady tok/s**, versus MTP3's **0.5808 overall / 0.5598 steady**. That is an observed increase of approximately **23% overall / 34% steady** for this pair of short runs. Live delivery timing varies, so this is not a precise isolated effect size or sustained throughput proof. The earlier 0.92 steady result remains unbeaten. Disabling CPU threadpool polling was then tested and rejected: its one completed trial fell to **0.3315 overall / 0.3357 steady tok/s**, with identical text and zero recorded verification failures or pad misses. The second trial did not finish before the work deadline. The run remains **FAIL/incomplete**, with partial capture retained; total cycle 542.14 seconds and cleanup completed. Polling is restored to 50. Moving pad HTTP and relay control onto USB networking then completed successfully in 537.42 seconds, but regressed to **0.5696 / 0.6296 steady** and **0.5783 / 0.5874 overall tok/s**. Both trials preserved identical text, 2,441 offloaded nodes and zero local fallback, verification failures or pad misses. The first V100 peaked at 25,851 MiB. That transport change is rejected; ADB relay forwarding is retained. The app-only direct-streaming experiment `b27-mtp5-direct-1` then hit its 540-second work deadline; the entire cycle, including clean teardown, took **542.19 seconds**. Both initial fresh shipments were accepted directly, but **no trial completed, so no tok/s result exists**. Its first verification round alone took 13.65 seconds. The first V100 reached **25,855 MiB**. Direct streaming is disabled for the next comparison. The v18 source commit `87fb47b3` remains local and unpushed; its native libraries and model assets are byte-for-byte identical to v17. The subsequent `b27-mtp5-ack-1` run **passed in 517.03 seconds**, using the previous cached-file pad path with `SHIELDED_PAD_ACK_STREAM=1` to avoid a full guest readback for each new shipment acknowledgment. Its two trials measured **0.7517/0.7652 overall** and **0.7616/0.7834 steady tok/s**. Both matched the baseline output hash, with 2,441 offloaded nodes, zero local fallback, verification failures or missed pads, and 6,764 pad cells each. The first V100 peaked at 25,851 MiB; the second remained idle. Combined rates were 0.7584 overall / 0.7724 steady: approximately 6% / 3% above the preceding MTP5 pair. This small difference is not a precise isolated effect because delivery timing varied: the next shipment was accepted between trial 1's result and trial 2's first round. The option is tentatively retained. **The historical 0.92 steady best remains unbeaten.** The confidence-threshold comparison (`p_min=0.30`) then completed in **503.36 seconds** but regressed to **0.7231/0.6868 steady** and **0.7370/0.6736 overall tok/s**. It added a sixth round, kept 20 total drafted tokens, reduced accepted drafts from 10 to 9, raised FIELD exchanges from 1,574 to 1,842, and raised pad cells from 6,764 to 7,027 per trial. Output stayed identical and verification/pad-miss counters remained zero. The threshold is rejected; the retained recipe uses `p_min=0.00`. A no-model protected-VM comparison subsequently passed in 20.35 seconds: existing mask generation achieved 22.0–24.0 million elements/s on one VM thread, versus 75.9–89.7 million elements/s for warm-file authenticated cell import. This is a kernel cost comparison, not a new model tok/s result. A four-block sampler candidate is being checked for exact output equivalence before paired phone timing.

The earlier `b27-native-crt-ping-3` run produced the expected text and zero verification failures, but its overall receipt remains **FAIL** because stderr export lost chunks 126–211. It took 39.743 seconds for 16 tokens, with 13 in the 36.881-second steady window; prefill took 1,503.606 seconds. The first V100 reached 27,723 MiB and averaged 0.78% sampled GPU utilization during decoding (4% maximum); the second was idle. Most observed time was between exchanges, including transport and phone processing/scheduling. This is not an isolated CPU measurement.

All new local test cycles include preparation and cleanup within a five-minute default or ten-minute maximum.

## Preparation now works in bounded steps

All 409 public encoded 27B artifacts—26,023,034,880 bytes—passed independent row comparison and the production catalog readers on the host. Construction took 350.09 seconds; reader verification took 53.24 seconds.

The v14 phone probe completed in **118.51 seconds**, including installation, setup, capture validation and cleanup. It reused the retained 27B model without copying it again, authenticated its catalog/header, and freshly received **13 artifacts / 796,917,760 bytes** during a 60-second feed. The other 396 remain to be transferred. An unfinished fourteenth file was removed at the deadline; the receiver joined before recording the final state. The 13 completed files remain available for the next run.

Timing of the 13 completed receptions:

| Phase | Seconds | Share of measured body time |
|---|---:|---:|
| Encrypted-store writes | 36.263 | 61.15% |
| Reads, including sender wait | 13.884 | 23.41% |
| File sync | 6.622 | 11.17% |
| Hashing | 2.330 | 3.93% |
| Publication | 0.149 | 0.25% |

These are wall-clock phases, not CPU utilization. Completed-file body throughput was 13.44 MB/s. They identify writes and synchronization as the next preparation targets; they do not measure decoding.

Earlier small-model phone tests confirmed durable model-cache tags and orderly cancellation/resume. Their warm preparation completed in 31.87 seconds. Combining small Android writes into larger writes did **not** improve transfer speed: 18.308 seconds baseline versus 19.234 seconds coalesced, one run per setting. That option remains off. [Transfer comparison](artifact-transfer-comparison.json).

## Current speed work

The v15 required-public-cache mode authenticates and encodes source weights and prepares private verification data, then releases temporary encoded rows. A warm public worker-cache lookup avoids phone-to-worker weight upload; a cache miss refuses execution. It also removes temporary encoded-weight writes on the phone. Focused real-backend and real-worker checks passed; these are not tok/s measurements.

The first full 27B attempt with this mode (`b27-cache-resident-1`) hit its work deadline before completing preparation. The entire cycle took 542.01 seconds, the phone was stopped, and all owned host children were reaped. All 409 public host-cache entries had been loaded, but no decode result was produced. The second attempt (`b27-cache-resident-2`) overlapped host-cache loading with phone startup, but also hit the preparation deadline. Its entire cycle took 543.17 seconds, with the phone stopped and all owned children reaped. Neither attempt reached decoding.

During the second attempt, the worker was attached to the first V100 but used only 282 MiB of VRAM at 0% GPU utilization. The 26 GB public cache is in host RAM. The phone had not installed the GPU graph or started decoding. This distinction explains why recent preparation attempts do not show a large VRAM rise.

The latest successful run keeps 96 small SSM tensors resident; unchanged source-read counters confirm no further source reads during either decode trial. The optional four-reader experiment regressed: the same resident-model loading phase took 66.5 seconds versus 25.2 seconds in the preceding serial run. It was stopped after 288.15 seconds including cleanup, without decoding. That option remains off. The landed source-prefetch change reads one tensor ahead while the current tensor is authenticated, encoded and checked. It passed focused backend tests and independent review, and the combined v17 recipe completed both decoding trials within the test limit. There is no completed serial-registration baseline under otherwise identical conditions, so an isolated prefetch speedup is not claimed. Receiver buffering and general preparation feature work remain paused.

A [masked-correction proposal](masked-correction-proposal.md) explores moving large pad corrections directly from the trusted dealer to the worker while the phone expands confidential output-mask seeds. It is a design for independent review, with no production implementation or performance claim. Dealer matrix multiplication remains necessary.

For the latest MTP5 16-token execution mix, replies plus minimum replacement pad bytes project to **888.34 MB/s incoming at 20 tokens/s** (the older MTP3 mix projected 709.39 MB/s). The currently negotiated USB link is 5,000 Mbit/s, at most 625 MB/s even before encoding/framing overhead. Thus 20 tok/s with this exact traffic mix and both replies and pad replenishment on this USB link is excluded by bandwidth alone. A different execution mix, fewer transferred bytes, or a separate pad path changes that conclusion. These are conditional calculations, not measured sustained rates. Pad generation remains on the trusted workstation CPU in this development setup; no protected phone-GPU path has been demonstrated.

The separate 0.8B model passed an 84.71-second cycle with three 128-token trials: 17.17–18.31 tok/s overall and 19.97–20.57 steady, with zero verification failures, pad misses or local fallback. This small-model configuration offloaded FFN gate/up matrices; the 27B configuration offloads 409 matrices across more of the model. These results do not establish 27B speed or sustained dealer capacity.

## Four-block sampler: kernel gain, no inference gain demonstrated

The opt-in AArch64 sampler preserves the existing stream and passed 608 exact comparisons on the phone. In a 29.13-second phone probe it generated 68.4–68.9 million elements/s, 2.85–2.87 times faster than the bracketing baselines.

The full `b27-r4-2` run passed in **499.86 seconds**, including cleanup. Both 16-token trials matched the baseline text, with 2,441 offloaded nodes, zero local fallback, verification failures or missed pads, and 6,764 pad cells each. The first V100 reached **25,875 MiB**. The new sampler activation was confirmed in the exported stderr. Combined decoding rates were **0.7060 overall / 0.7531 steady tok/s**, compared with **0.7584 / 0.7724** for the prior retained recipe. Separate short runs have variable refill overlap, so the difference does not prove the sampler caused a regression; it establishes **no end-to-end gain in this test**. The option stays off in the retained recipe. The historical 0.92 steady record remains unbeaten.

Socket exchanges consumed 14.47 and 16.54 seconds of the 21.06 and 24.26-second decoding windows. Response bodies averaged about 52–53 MB/s. The next experiment targets the transfer path.
