**Update: full speculative generation now repeats at12.63tok/s**, with identical reference output. Earlier target-only rates below are a different metric. [Latest measured result](pixel8-tpu-mtp.md).

# Pixel 8 Pro batched TPU execution

The fixed-row NNAPI executor now supports M=1 and M=2 handles sharing one immutable host weight allocation. This remains a plain, unshielded prototype; no protected VM, pads or model-level speculative decoding is involved.

The independent device probe passed **68,992 exact output comparisons** across two public shapes (K32/N128 and K1024/N6144), 14 physical calls and changing distinct rows. Checks covered original-buffer mutation, early release of the caller weight reference, continued M2 execution after destroying M1, invalid M3 refusal, legacy M1 API refusal for M2, and NaN rejection in row1 without a compute call. Whole cycle: **4.61 seconds**, clean exit. [Validation](../work/pixel8-plain-tpu-batched-fc-root-1/first/root-validation.json).

For K1024/N6144, warmed M2 calls took 1.20–1.40 ms, versus 1.30–1.37 ms for the two warmed M1 calls. The first calls were slower. These are a few public-matrix invocations, **not model tokens/s or a sustained speed estimate**. Host ownership is shared; driver-side allocation size is unknown.

The new executor then ran the existing M1 model backend unchanged, at **10.9291 / 10.5578 / 10.3866 generated tokens/s**, combined **10.6197**. All three 64-token outputs matched prior output exactly; 102 cache tokens and all runtime binaries except the NNAPI plugin matched the accepted baseline. Each decoded token still uses 102 physical FCs for 150 logical projections and 497,025,024 MACs. No timed compilation or errors; retained host FP32 constants remain 1,988,100,096 bytes. Whole cycle **28.31 seconds**. This is a compatibility/speed regression check, not evidence of an additional causal improvement. [Validation](../work/pixel8-plain-tpu-batched-m1-root-1/first/root-validation.json).

Each inference rate counts 64 outputs over 63 single-token decode calls; prefill is timed separately. Prefill and unclaimed operators still use CPU. The prior repeated matched fusion comparison remains **10.50 versus 9.74 generated tokens/s**. The subsequent target-only M2 result is recorded below; full speculative generation remains unmeasured.

Source review found and root corrected multiple generator guards before compilation; the accepted executor and probe both passed strict NDK compilation. The separate opt-in M2 GGML backend passed independent source review after root fixed its M1 profile total count. It compiled under strict NDK flags and then passed a default-off M1 full-inference regression at **10.8077 / 10.4550 / 10.4968 generated tok/s**, combined **10.5842**, with identical output,102 cache keys, exact coverage and no errors or timed compilation. Both full-run and per-FC validators passed; cycle28.35s. [Backend regression](../work/pixel8-plain-tpu-m2-backend-root-1/first/root-validation.json). The corrected persistent-weight public graph probe subsequently passed all four modes, 6,912 exact outputs and 16 physical invocations in 2.57 seconds; profiles reconcile, including M2-first initialization.


## Batched graph validation

The revised public GGML graph test passed all four modes in **2.57 seconds**: fused M1-first, unfused M1-first, fused M2-first and M2-disabled support checks. **6,912 outputs matched the exact reference**, with16 physical invocations. Both row counts reused the same weight tensors and storage; counted host FP32 weights stayed at49,152bytes. Repeated shapes compiled nothing. Profile totals reconcile with every call, including zero M1 entries after an M2-first run. This validates the graph adapter and its row slicing; it does not measure full-model M2 inference. [Root validation](../work/pixel8-plain-tpu-m2-backend-root-1/graphs1/root-validation.json).

Next independent source tasks: a k1 speculative inference harness reusing the existing MTP helper and recurrent rollback, plus a target-only two-row probe against known-good token IDs. The latter reports teacher-forced target rows/s, which must not be presented as autoregressive generation tokens/s.

## Full target-only two-row result

The full Qwen3.5 0.8B target processed 62 known input rows at **18.43 target rows/s**, then **18.12 target rows/s** on a warmed repeat. Each run matched all 62 tested next-token predictions plus the initial prediction. Both retained 102 physical M2 models; every batch had 150 logical projections, 102 NNAPI calls and 994,050,048 MACs, with zero errors or compilation in the measured window. Full test cycles were 37.42 and 11.49 seconds.

**These are teacher-forced target rates, not generation tok/s.** Drafting, acceptance and observation are absent. The repeated generation baseline remains about 10.5 tok/s, without Shielded or pVM overhead.

Two earlier runs retaining both M1 and M2 compilations failed during warmup with NNAPI `DEAD_OBJECT`. The captured vendor driver crash reported a Scudo heap error. The cause is not established; these failures do not prove memory exhaustion. M2-only full-target runs succeeded. The next default-off candidate uses one physical M2 compilation for either logical row count, with a public zero dummy row for M1 and explicit counters for the additional arithmetic. A separate capability probe tests whether dynamic batch dimensions can avoid that dummy row.

[First target validation](../work/pixel8-plain-tpu-m2-only-root-1/first/root-validation.json), [warmed repeat](../work/pixel8-plain-tpu-m2-only-root-1/warm1/root-validation.json).

The dynamic-batch capability probe was declined by the pinned `google-edgetpu` driver: the support query succeeded with `supported=0`. No compilation or execution followed. This rules out the specific proposed unknown-leading-dimension FC model on this driver. [Probe receipt](../work/pixel8-plain-tpu-dynamic-probe-root-1/first/receipt.json).
