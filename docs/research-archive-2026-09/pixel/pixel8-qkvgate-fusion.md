# Pixel 8 Pro: QKV/gate projection fusion

**Warmed repeated comparison: 10.503562 generated tok/s with 102 calls versus 9.737665 with 120 calls, a descriptive 7.865299% gain.** All twelve output token files match exactly. This remains unshielded Qwen3.5 0.8B hybrid TPU/CPU inference.

The decoder now expands the two same-input projections before the recurrent-state path in each of 18 linear-attention layers. The existing pair fuser then combines them. This changes graph execution order only for single-token batches; prefill keeps its previous order. The option defaults off in the isolated experimental build. No protected VM, APK or production source changed.

Every decoded token still computes 150 logical projections and 497,025,024 offloaded MACs. There are now 48 fused pairs and 102 physical NNAPI calls, down from 120. Retained FP32 constants remain 1,988,100,096 bytes. Exact counter, weight-coverage and output checks passed; no timed compilation or backend errors occurred.

| Warm process order | Calls per decoded token | Three generated tok/s trials | Combined generated tok/s |
|---|---:|---|---:|
| control120 | 120 | 10.389 / 9.964 / 9.667 | 9.997985 |
| warm102 | 102 | 10.768 / 10.429 / 10.289 | 10.491329 |
| warm102repeat | 102 | 10.801 / 10.461 / 10.298 | 10.515822 |
| control120repeat | 120 | 10.152 / 9.619 / 8.800 | 9.490557 |

Each condition has six 64-output trials (63 one-token decode calls per trial). The first output is sampled from separately timed prefill; multiply these generated-token rates by63/64 for one-token decode calls per second. The measurements apply to this prompt and short output length, not a sustained-rate guarantee. The best observed individual trial, including initial cache population, was10.851555 generated tok/s.

All compared runs used populated compilation caches, identical binaries and recipe; the graph-expansion flag and expected call count differed. Test cycles took27.6–30.3seconds.

[Repeated validation](../work/pixel8-plain-tpu-qkvgate-root-1/warm-repeat-validation.json), [initial102-call validation](../work/pixel8-plain-tpu-qkvgate-root-1/first/root-validation.json), [manifest](../work/pixel8-plain-tpu-qkvgate-root-1/manifest.json), [source patch](../work/pixel8-plain-tpu-qkvgate-root-1/qwen35.cpp).
