# Pixel 8 Pro NNAPI compilation cache

The full Qwen3.5 0.8B test cycle fell from **105.32 to 29.18 seconds** when a fresh process reused the populated cache. Compilation/load time fell from **72.71 to 2.88 seconds**. This speeds up experiments and model startup; it is not a decode-throughput gain.

| Measurement | Empty-cache launch | Populated-cache launch |
|---|---:|---:|
| Whole cycle including collection | 105.315687 s | 29.183262 s |
| NNAPI compile or load | 72.705046 s | 2.877357 s |
| Full-weight cache-key hashing | 2.313773 s | 1.359701 s |
| Combined generated tok/s | 9.801439 | 9.970374 |
| Stored cache | 1,381,968 KiB | 1,381,968 KiB |

Both processes requested caching for all 120 FC models, with API return code zero, identical sets of 120 content-derived keys, identical binary/prompt hashes, and identical output token files across all six 64-token trials. All projection/MAC/call guards passed, with zero backend errors or compilation during timed decode. The runtime exposes no cache-hit counter; none is inferred.

Keys hash the full actual FP32 weights and bias, model structure/precision and pinned driver identity. Hashing costs are reported separately. Caching defaults off. The test uses a private directory owned by the Android shell under the existing experimental directory; it introduces no Shielded, pVM or protected-compute claim. Production code, the APK, protected VM and phone lock are unchanged.

[Validated pair](../work/pixel8-plain-tpu-cache-root-1/cache-pair-summary.json), [cold root validation](../work/pixel8-plain-tpu-cache-root-1/first/root-validation.json), [warm root validation](../work/pixel8-plain-tpu-cache-root-1/warm1/root-validation.json), [source/model manifest](../work/pixel8-plain-tpu-cache-root-1/manifest.json).
