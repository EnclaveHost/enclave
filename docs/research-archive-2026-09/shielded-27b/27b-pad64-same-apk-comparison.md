# 27B pad-write cap: matched APK comparison

**The poll delay remains.** The first capped run produced higher throughput in this matched pair, but the repeat did not confirm that gain.

| Trial | Uncapped tok/s | 64 KiB cap tok/s | Observed difference | Uncapped steady tok/s | Capped steady tok/s |
|---|---:|---:|---:|---:|---:|
| 1 | 0.924 | 0.954 | +3.28% | 0.895 | 1.016 |
| 2 | 0.751 | 0.790 | +5.19% | 0.743 | 0.807 |

Both runs used APK v49 and the same settings, model, verified work and MTP output. Trial 1 uses a 4 MiB reply receive window; trial 2 uses 256 KiB. Compare matching positions across runs; the difference between trials is not a noise estimate. These short diagnostic runs do not establish a repeatable causal gain.

In the fully captured second-trial app window, the vhost worker spent **748.329 ms uncapped versus 659.580 ms capped** blocked in `lock_sock_nested`. That is still substantial contention. The first-trial traces omit different portions of their heads and cannot establish full-trial lock savings. Other poll delays also remain.

Overall poll wall time was **10.395 / 12.865 s uncapped** and **9.874 / 11.993 s capped**. A poll includes waiting for data and scheduling; these totals are not time removable by replacing `poll()` itself.

Both cycles finished with phone/process/bank cleanup verified: **531.748 s uncapped**, **525.481 s capped**. Every trial generated 16 tokens with the expected text, 2,441 GPU offloads, 720,956,293,120 MACs, 6,764 pads, zero local fallback, verification failures, or missed pads. All 13 standard analyses, receive-operation checks and nine additional analyses passed for the uncapped control. The earlier failed startup attempt remains excluded.

The cap remains opt-in. Default behavior and trust checks are unchanged.

[Full comparison data](27b-pad64-same-apk-comparison.json)

## Capped repeat

The same APK and recipe repeated at **0.725 / 0.669 tok/s** overall and **0.771 / 0.718 tok/s** steady, with expected work and no verification failures. Its complete cycle took **543.310 s** including cleanup. All 13 standard analyses, receive-operation checks and nine additional analyses passed. The strengthened comparator also verified direct intent settings.

The fully captured second-trial socket-lock total fell to **245.143 ms**, even though total decode became slower. Lock-wait totals alone therefore do not explain throughput. The 64 KiB cap remains an experiment; the default stays unchanged.

[Repeat comparison data](27b-pad64-repeat-comparison.json)
