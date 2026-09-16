## Full-model update

Plain Qwen3.5 0.8B generation through the TPU driver now averages **10.50 generated tok/s**, versus **9.74** for its matched control across repeated warmed trials. QKV/gate fusion reduces 120 calls to 102 per decoded token while preserving all 150 logical projections and identical output. Peak observed is 10.85. These are unshielded hybrid TPU/CPU results; prefill and other unclaimed operators remain on CPU. [Latest fusion evidence](pixel8-qkvgate-fusion.md), [complete baseline history](pixel8-qwen08-tpu-baseline.md).

# Pixel 8 Pro TPU capability check

The connected Pixel 8 Pro can be investigated now. The Pixel 10 restriction belongs to the newer Tensor SDK; it does not rule out older NNAPI access on this phone.

## Observed on this device

- Pixel 8 Pro, Android 16 / API 36; normal ADB shell UID 2000.
- Public NNAPI enumerates `google-edgetpu`, accelerator type 4, driver version 2.0, feature level 1000008. `nnapi-reference` is a separate CPU device.
- Three strict FP32 `FULLY_CONNECTED` support queries returned **unsupported**: `(M,K,N)=(2,32,8)`, `(1,1024,128)`, and `(1,1024,6144)`.
- The final shape matches the existing Qwen 3.5 0.8B `blk.0.attn_qkv.weight` dimensions. The test used public synthetic integer weights, not model inference.
- No compilation or accelerator execution occurred in those three trials. No throughput or arithmetic mismatch can be inferred from support-query rejection.

The probe targets exactly `google-edgetpu` using `ANeuralNetworksCompilation_createForDevices`, with no CPU device in the list. NNAPI documents that this disables its CPU fallback. It explicitly disables relaxed FP32 computation. [NNAPI device assignment and fallback](https://developer.android.com/ndk/guides/neuralnetworks)

The source compiled successfully with the installed NDK, `-Wall -Wextra -Werror`, and a static C++ runtime. The initial push, enumeration and tiny query took 1.990 seconds total; the two larger-shape queries took 0.759 seconds total. These are test-controller durations, not TPU compute times.

[Strict-probe result and hashes](/home/steven/Documents/Codex/2026-09-07/i-w/work/pixel8-nnapi-fc-root-1/result.json), [source](/home/steven/Documents/Codex/2026-09-07/i-w/work/pixel8-nnapi-fc-root-1/nnapi_probe.cpp), [enumeration receipt](/home/steven/Documents/Codex/2026-09-07/i-w/work/pixel8-nnapi-enumerate-1/receipt.json).

## Execution results

The TPU route works through the public NNAPI driver. Quantized and relaxed-FP32 diagnostics compiled and executed successfully with only `google-edgetpu` selected. Strict FP32 was rejected at both diagnostic sizes; relaxed mode is therefore an experimental candidate rather than an API promise of FP32 arithmetic.

A separate file adapter then ran eight existing arithmetic cases and two dense random matrices matching Qwen's K=1024, N=6144 projection, at M=1 and M=5. **All ten cases matched the independent integer oracle exactly**: 37028 checked values, zero mismatches. Coverage includes negative residues, cancellation, sparse values, adjacent large integer results, and the q251/q241 edge ranges. Each case executed three times; the final output was compared, with the output buffer poisoned with NaNs before every execution. The entire device cycle took **8.016 seconds**.

| Dense public matrix | Compilation | First compute | Later compute |
|---|---:|---:|---:|
| K1024, N6144, M1 | 1097.553 ms | 9.876 ms | 1.235 / 1.332 ms |
| K1024, N6144, M5 | 850.196 ms | 6.160 ms | 1.610 / 1.752 ms |

Compute wall time wraps the NNAPI compute call. It excludes file loading, float conversion, model construction, compilation, output writing and independent host comparison. These are dense synthetic public weights with the selected model's dimensions, not its actual weights or a complete inference. Earlier repeated-column synthetic results are retained in the raw artifacts but are not used as the dense timing result.

[Ten-case summary](/home/steven/Documents/Codex/2026-09-07/i-w/work/pixel8-nnapi-vectors-root-1/summary.json), [device receipt and command provenance](/home/steven/Documents/Codex/2026-09-07/i-w/work/pixel8-nnapi-vectors-root-1/device-receipt.json), [independent comparisons](/home/steven/Documents/Codex/2026-09-07/i-w/work/pixel8-nnapi-vectors-root-1/comparisons.json).

The route is selected through the TPU driver with NNAPI fallback disabled. Direct hardware-counter inspection was denied to the shell; no privileges were raised. Driver-reported internal timing is retained but not used for the speed figures above. Exact agreement on these inputs does not prove accuracy for all inputs under relaxed mode; existing Shielded verification remains required.

## Next implementation

Connect one existing Shielded group through a bounded Android NNAPI worker and the pVM bridge, preserving the existing masking, modular reduction, CRT, response framing and verification. Measure the complete exchange before proceeding to protected Qwen 3.5 0.8B inference. Larger K needs exact partial-product recombination. No full protected inference or tok/s result is available yet.

The installed Anchor APK, pVM, phone lock, GPU workers and production defaults remain unchanged.
