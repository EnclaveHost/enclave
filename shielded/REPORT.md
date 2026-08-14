# Shielded inference — measured results

Date: 2026-08-14. Companion to [docs/shielded-inference.md](../docs/shielded-inference.md)
(design) and [SECURITY.md](SECURITY.md) (leakage argument).

**Bottom line up front.** The confidentiality design holds and is proven in an executable
oracle, and no measured cost currently kills it.

- **GPU**: an exact field GEMM (RNS-3 over byte primes, int8 tensor cores) costs **2.7–3.6×
  fp16 at prefill including fused CRT** — inside the 5× budget. The CRT *must* be fused;
  unfused it alone pushes the total to 5.5–7.3× and fails.
- **TEE refill** (`u = r·W`, which cannot be offloaded without handing the accelerator the
  pad) sustains **214 tok/s for an 8B model** on 16 EPYC cores using int8/VNNI — against a
  measured GPU baseline of 79 tok/s for the same model. **Refill is not the binding
  constraint**, contrary to this report's earlier revision.
- The earlier "7.1 tok/s, refill is the ceiling" figure was wrong twice over: measured with
  stock fp64 BLAS instead of int8, *and* on a box at load 32 from concurrent builds. Both
  are corrected here. It is a good argument for re-measuring on an idle machine before
  drawing a strategic conclusion.

What remains open is not a wall but two kernel-engineering requirements (fused CRT, and
in-kernel dequantisation so field weights don't inflate VRAM 5×) plus the absence of any
end-to-end run.

Nothing here has shipped. No engine code exists; these are measurements of primitives and
proofs of constructions.

## 1. Test hardware

| | |
|---|---|
| GPU | NVIDIA RTX 3070, 8 GB, sm_86, driver 610.57.04 — a commodity consumer card, which is the tier's stated target |
| CPU | AMD EPYC 9115, 16 physical cores / 32 threads, AVX-512 incl. `avx512_vnni` and `avx512_bf16` |
| Notable | CPU reports `sev sev_es sev_snp`, so this box is representative of a real CVM host |
| Software | PyTorch 2.11+cu130, numpy 2.5.1, Python 3.14.6. **No CUDA toolkit** (driver only), so kernels were driven through torch rather than written in CUDA |

Every GPU rung below was verified **bit-exact against an int64 reference before being
timed**. An unverified rung is reported as a failure, never as a speed.

### Measurement methodology, and a contention caveat

Rates are medians of per-iteration timings after warmup, not the mean of a short burst.
This matters more than it sounds: the same CPU int8 GEMM measured 954, 1800, and 2756
G-MAC/s across attempts, and since that number decides whether an 8B model is servable, the
timing method had to become the boring reliable one.

Most of that spread was **CPU contention**: the first CPU pass ran while two sibling agents
compiled llama.cpp and whisper.cpp at load average 32 on a 16-core box — contending for
exactly the resource the refill benchmark measures. **All CPU figures in §3 were re-taken on
an idle machine** (load 4.3 falling to 1.7). GPU figures were re-taken alongside and moved
<2%, confirming the GPU was never contended; only the CPU numbers were affected, and they
moved by ~3×.

The STT harness in §6 independently hit the same collision and solved it more rigorously,
rejecting any sample taken with >2.0 foreign cores busy (120 clean samples of 121 attempted).
Both that harness and the chat harness independently found a **reproducible ~10× decode
collapse at `-t == nproc`** on entirely different workloads, which cross-validates it as a
real SMT-oversubscription property of this box rather than noise.

## 2. GPU: exact field GEMM (`bench/field_gemm_bench.py`)

### The kernel plan changed

The design originally called for splitting a 24-bit prime into 8-bit limbs, which needs
N² cross-product GEMMs. Measurement says use **RNS over byte-sized primes** instead: each
residue fits in one int8 limb, so a field GEMM is N GEMMs, not N².

| rung (GEMM only) | M=512 K=4096 N=4096 | M=512 K=4096 N=14336 | M=2048 K=4096 N=4096 |
|---|---|---|---|
| fp16 (baseline) | 0.59 ms | 1.46 ms | 1.75 ms |
| RNS-3 int8 TC | 2.50× | 3.41× | 3.23× |
| RNS-4 int8 TC | 3.34× | 4.55× | 4.31× |
| limb-int8 (old plan) | 23.1× | 30.9× | 29.1× |
| fp64-RNS | ~320× | ~450× | ~420× |

### Recombination is not free, and fusing it is a hard requirement

An RNS field GEMM is N GEMMs **plus a CRT pass over the M×N output**. Timing only the GEMMs
understates the tier by enough to flip the verdict:

| total (GEMM + CRT) | 512×4096×4096 | 512×4096×14336 | 2048×4096×4096 |
|---|---|---|---|
| **RNS-3, fused CRT** | **2.69×** | **3.66×** | **3.47×** |
| RNS-3, naive CRT | 5.27× | 7.26× | 7.51× |

Naive CRT (≈10 separate elementwise kernels, each a full int64 memory round trip) costs
*more than the GEMMs themselves* and puts the tier through the 5× kill line. Fusing the chain
into one kernel — demonstrated here with `torch.compile`, 10–18× faster — brings it back to
~0.13–0.44 ms, a few percent of the GEMM. **The fused CRT epilogue is therefore an
implementation requirement of the same rank as the masking itself**, not an optimisation to
defer. A real worker fuses it into the GEMM epilogue rather than calling a compiler.

RNS-3 gives 23.8 bits of dynamic range, RNS-4 gives 31.6. Since the accumulator was
measured to need ~18.7 bits nominal and ~22.8 under 10³× outlier channels, **RNS-3 is the
design point and RNS-4 the outlier-safe fallback.**

### Two constraints the measurement imposed

- **int8 tensor cores refuse M ≤ 16.** `torch._int_mm` requires M > 16, so batch-1 decode
  cannot use the fast path at all. A bespoke small-M kernel is a Phase 1 requirement.
- **fp16 cannot hold the accumulator.** It saturates at 65504 and represents integers
  exactly only to 2048, so it overflows before the modular step — this is not a tuning
  issue, it is a correctness wall. fp64-RNS with byte primes is exact with no chunking
  (products ≤ 15625, K=14336 accumulation ~2.2e8, far inside 2⁵³). fp32 would need 5-bit
  primes and 5–6 channels.

### Decode is a bandwidth problem, not a FLOP problem

At M=1 the cost is bytes per weight. Measured read bandwidth 388–412 GB/s (87–92% of the
card's 448 GB/s spec, so credible).

| weight format | bytes/weight | vs fp16 | vs q4_K |
|---|---|---|---|
| fp16 | 2 | 1.0× | 4× |
| q4_K (what the fleet serves) | ~0.5 | 0.25× | 1.0× |
| RNS-3 int8 | 3 | 1.5× | **6×** |
| RNS-4 int8 | 4 | 2.0× | 8× |

**The honest decode denominator is q4_K, not fp16**, and 6× sits at the kill line rather
than inside it. Batching amortises the weight read, which is exactly why the kill criterion
is stated at batch ≥ 4.

## 3. CPU: the mask refill rate (`bench/refill_bench.py`)

`u = r·W` is not offloadable: a GPU computing it would learn the pad `r` and could strip the
mask. Masking `r` itself needs a mask for the mask, forever. So the CVM performs one MAC per
GPU MAC, times the number of RNS channels, and sustained throughput is

```
max_tok_per_s = cpu_MAC_per_s / (linear_MACs_per_token × n_primes)
```

Measured on an **idle** box, 16 physical cores, with exactness verified per path:

| path | rate | exact for RNS? |
|---|---|---|
| **torch int8 (`_int_mm`, FBGEMM/oneDNN, AVX-512 VNNI)** | **4830 G-MAC/s** | **yes, byte primes, K=4096 and 14336** |
| torch bf16 | 2419 G-MAC/s | **NO** — probe says inexact, unusable |
| torch fp32 | 663 G-MAC/s | yes for ≤5-bit primes at K=4096 only |
| torch fp64 | 254 G-MAC/s | yes, byte primes, any K |
| numpy fp64 | 2.3 G-MAC/s | yes (numpy's BLAS is unthreaded here) |

Resulting ceilings at RNS-3, and the comparison that matters — the measured **unprotected GPU
decode rate** for the same model from §6:

| model | refill ceiling (int8) | stock fp64 | GPU baseline decode | headroom |
|---|---|---|---|---|
| Qwen2.5-1.5B | 1463 tok/s | 76.8 | 193.6 tok/s | 7.6× |
| Llama-3-8B | **214.5 tok/s** | 11.3 | **79.3 tok/s** | **2.7×** |
| Qwen3-32B-class | 50.3 tok/s | 2.6 | (not measured) | — |

**Refill is therefore NOT the binding constraint** — it has 2.7× headroom over the baseline
decode rate it has to keep up with. Per-physical-core: 13.4 tok/s/core at 8B, so even a
much smaller CVM slice suffices, and a 64-core fleet box has ample margin.

This reverses this report's previous revision, which said refill capped 8B at 7.1 tok/s and
was the tier's highest-priority problem. That figure was wrong twice: measured with stock
fp64 BLAS rather than int8/VNNI (a ~19× error), and taken while two sibling agents compiled
llama.cpp and whisper.cpp at load 32 on the same 16 cores (a further ~3×). Both are fixed.
The lesson is recorded rather than quietly patched: **verify exactness before trusting a
rate, and measure CPU on an idle box before drawing a strategic conclusion.**

## 4. Constructions: proven, not asserted (`reference/shielded_ref.py`)

23 assertions across `test/shielded-reference.test.mjs` and `test/shielded-protocol.test.mjs`.

- **Slalom masking recovers bit-exactly**, and the adversary transcript never contains a
  plaintext input.
- **Leakage assertions on the real transcript** of a 12-token generation (352 boundary
  crossings): uniformity chi-square 54.4 vs a 117 threshold; pooled correlation 0.0007 vs a
  3σ null of 0.019. Per-tensor correlations are reported against their null bound because on
  64-element tensors the null max is ~0.44 — an earlier version of this suite nearly recorded
  that noise as a leak.
- **Preprocessed Freivalds catches single-element lies 64/64** with no false positives, at
  40 bits of soundness per check, in O(|x|+|y|) even at batch 1.
- **KV poisoning is caught before insertion.** A worker tampering only with the key
  projection aborts the request with nothing cached.
- **Mask bank** never reuses an index and stalls when dry.
- **TwinShield prefill offload is exact** at m=64 and m=256, at 4× the bare FLOPs.
- **Conv masking exact** (SDXL UNet path); **ViT block matches its in-TEE reference exactly**.
- **Field parameters hold at production width** — flat ~18.7 bits from d=64 to d=14336,
  because 1/√d init is variance-preserving. Width was expected to be the risk and is not;
  outlier magnitude is, overflowing near 10⁴× channels.
- **RNS is exact at d=4096** with 48 bits of range.

### The decisive negative result

TwinShield's attention offload is **recovered by attack at m=1, m=2, and m=4**. At decode the
query lies on a line in `Z_p^d`, and plausibility-filtering one coordinate pins the unknown
scalar. m=4 is a real GQA group size, so batching a step's query heads does not rescue it.
Search space: m=1 → 14 bits, m=4 → 24, m=16 → 86, m=32 → 191 (attack run and fails),
m=512 → 4907.

**Decode attention therefore stays in the TEE permanently.** This is not a v1 simplification.

## 5. Worker admission rules (`protocol.py`)

Stock ggml-rpc is a remote execution service; the shielded worker keeps its allocation plane
and replaces its compute plane. `GRAPH_COMPUTE` becomes install-once `GRAPH_INSTALL` behind
an allowlist of `{FIELD_GEMM, VIEW, RESHAPE, PERMUTE, TRANSPOSE, CONT, CPY}`; `GET_TENSOR` is
restricted to declared graph outputs rather than any region of any live buffer;
`SET_TENSOR_HASH`, `COPY_TENSOR`, `MEMSET_TENSOR` and `BUFFER_CLEAR` are deleted and named so
they cannot drift back. Plain `MUL_MAT` is refused specifically because it would run on
unmasked data. Every malformed frame is fatal — this component fails **closed**, unlike the
rest of the wasmtime patch stack.

This is not a confidentiality boundary. Confidentiality comes from the masks; these rules
stop the worker being a general-purpose execution and exfiltration primitive on the GPU host.

## 6. Engine baselines (unprotected llama.cpp, same box)

llama.cpp `885c5bbe`, built from source for CPU and — since no Linux CUDA prebuilt exists —
for CUDA 13.3 via a pip-wheel nvcc. Models: Meta-Llama-3.1-8B-Instruct (32L, d=4096, 32 heads
/ 8 KV heads, GQA 4:1, n_ff 14336) and Qwen2.5-1.5B-Instruct (28L, d=1536, GQA 6:1).
Best CPU thread count is **24**, not 32; at `-t == nproc` decode collapses ~10× reproducibly.

| config | pp512 | tg128 @d0 | tg128 @d8192 |
|---|---|---|---|
| CPU, 8B Q8_0 | 98.0 | 13.8 | 10.4 |
| CPU, 8B Q4_K_M | 144.7 | 22.1 | 14.7 |
| CPU, 1.5B Q8_0 | 493.8 | 61.2 | 42.9 |
| **GPU, 8B Q4_K_M (full offload)** | **3268** | **79.3** | **65.5** |
| **GPU, 1.5B Q8_0 (full offload)** | **11431** | **193.6** | **173.3** |

Batching (parallel sequences, total throughput): CPU 8B goes 43 → 78 → 92 t/s at B=1/4/16;
GPU 8B Q4_K_M goes 352 → 887 → 1907. Prefill throughput is flat in batch on both.

8B Q8_0 on GPU is **partial offload only** (20 of 33 layers; 7.95 GiB of weights against
6991 MiB free VRAM) and is not quoted as a baseline.

### STT: the small-model rule holds decisively

whisper.cpp `592feef0`, CPU only, large-v3 quantized locally to q8_0 (no upstream q8 build
exists), real continuous speech (JFK inaugural, 11 / 60 / 300 s clips), 5 beams + best-of-5.
RTF excludes model load. Every sample guard-validated against background load.

| config | RTF (60 s clip) | verdict vs RTF ≤ 0.5 |
|---|---|---|
| large-v3 q8_0, t=16, single stream | **0.168** | **PASS**, 3.0× margin |
| large-v3 q8_0, **3 concurrent** streams | 0.418 worst | **PASS** |
| large-v3 q8_0, 4 concurrent | 0.546 worst | FAIL |
| large-v3 f16, t=16, single | 0.346 | PASS |
| large-v3 f16, 2 concurrent | 0.630 worst | FAIL |

**STT never needs the GPU.** large-v3 at q8_0 clears the realtime budget by 3× on one stream
and sustains **3 concurrent streams** per 16-core CVM (aggregate ~7.2 audio-s/s) — so the
entire masked-offload path can be skipped for speech-to-text, and its accelerator-side
leakage surface is *nothing at all*, not merely bucketed. Configuration implied: q8_0 (2× the
throughput of f16 at equivalent transcript quality here), `-t 16` per stream, cap 3 streams,
~2.7 GiB RSS each.

Two caveats carried from that measurement: it is bare metal, so SEV-SNP memory-encryption
overhead is not included; and the N=3 pass has only a 16% margin, which co-tenant noise can
erase. TTS is expected to follow the same path (Pocket TTS ~0.25B is far smaller than
whisper large-v3's 1.55B) but is not yet measured.

### Two corrections these baselines force

**1. q8_0 KV is slower than f16 everywhere measured — it is a memory win, not a speed win.**
The design doc called q8 KV "load-bearing, not an optimisation" for making TEE-resident
attention affordable. Measured: CPU 8B at d8192 drops 10.48 → 6.72 t/s (**−36%**), CPU 1.5B
at d8192 drops 42.6 → 23.4 (**−45%**), GPU only −3 to −4%. It buys a 47% KV memory reduction
(1024 → 544 MiB at 8k for the 8B) *at a throughput cost*, and the cost lands hardest on
exactly the CPU path where our KV cache lives. Corrected in the design doc: q8 KV is a
capacity lever to spend deliberately, not a free win.

**2. Field-form weights do not fit, and the fix is to not store them.** [our analysis]
RNS-3 at 3 B/param means 8B ≈ 24 GB of weights — against 8 GB of VRAM on this card, and
5.3× the 4.58 GiB that q4_K needs. Storing field-form weights would restrict this card to
~1.5–2B models and inflate VRAM fleet-wide.

It is avoidable. Weights are **public**, so the worker can keep them in their native q4_K/q8
GGUF form and derive the field residues **in-kernel** (dequantise → fixed point → reduce mod
each prime) inside the same fused epilogue the CRT already requires. Weight bandwidth and
VRAM then equal the baseline, and only the activation side — kilobytes against gigabytes at
decode — carries RNS overhead. That collapses the 6×-vs-q4_K decode penalty in §2 toward
~1×, and it is the single highest-leverage kernel decision available.

The requirement it imposes is determinism: the TEE computes `u = r·W` and the GPU computes
`(x+r)·W`, so both must derive **bit-identical** field elements from the same GGUF bytes. A
shared, versioned dequantise-and-encode routine, not two implementations that agree by
inspection.

## 7. Kill criteria: current standing

| criterion | standing |
|---|---|
| Chat/vision >5× at batch ≥4 | **Not killed, not cleared.** GPU leg is 2.7–3.6× at prefill including fused CRT — but only if the CRT is fused; naive recombination alone reaches 5.3–7.5× and fails outright. Refill has 2.7× headroom and is not binding. Batch-1 decode is 6× vs q4_K unless weights stay GGUF-resident with in-kernel conversion (§6), which should collapse it toward 1×. Needs an end-to-end run to close. |
| Image gen >3× per image at batch ≥4 | **Untested.** The DiT denoiser is a transformer reusing the measured path and steps batch well, so the prefill-shaped 2.7–3.6× is the relevant figure — but sd.cpp integration has not started. |
| STT/TTS fail realtime on both paths | **CLEARED for STT.** whisper large-v3 q8_0 runs CPU-in-TEE at RTF 0.168 single-stream and passes at 3 concurrent streams, so STT skips the GPU entirely. TTS unmeasured but strictly smaller. |
| Requires trusting GPU driver / host kernel / operator | **Cleared by construction.** Nothing in the design does. |

No kill criterion has fired. The two that remain genuinely open (chat/vision, image gen) are
open for want of an end-to-end implementation, not because a measured cost exceeds budget.

## 8. What is not measured, and would change conclusions

1. **No end-to-end shielded run.** Every overhead figure is a primitive measurement or
   arithmetic on primitives. Transport, mask staging, and verification are modelled, not
   observed.
2. **No stock ggml-rpc remote-GPU baseline**, so transport cost is not isolated.
3. **In-kernel dequantisation is analysis, not measurement.** The claim that decode overhead
   collapses from 6× to ~1× by keeping weights in GGUF form rests on a bandwidth argument,
   not a kernel. It is the single largest unverified claim in this report.
4. **No fleet hardware.** The 3070 is representative of the target *class*; datacenter parts
   have very different fp64 and int8 ratios. The EPYC has 16 cores against a fleet CVM's
   likely 64–128.
5. **No real model, no accuracy measurement.** Fixed-point l=8 is expected to cost a GGUF-q8-
   class step (Slalom <0.5%, TwinShield +0.21 ppl); unverified here.
6. **Concurrency is unexercised.** The mask bank's one-time invariant is asserted
   single-threaded; the real allocator is concurrent, and a double-issue race is a total break.
7. **Everything is bare metal.** No measurement here ran inside an actual SEV-SNP guest, so
   memory-encryption overhead is absent from every CPU figure — including the refill headroom
   and the STT concurrency ceiling, which passes at N=3 with only 16% margin.

## 9. Recommended next steps, in order

1. **Write the VNNI int8 GEMM for the TEE side and measure it.** Single highest-value item;
   it decides whether 8B is servable.
2. **Fuse the CRT into the GEMM epilogue.** Measured as the difference between 2.7× and
   5.5×, i.e. between passing and failing the kill criterion.
3. **Write the small-M CUDA kernel** (int8 tensor cores refuse M ≤ 16) so decode has a fast
   path, and re-measure decode against a q4_K baseline.
4. **Build the sched-pinned executor** against llama.cpp with the oracle as its equivalence
   reference, and get a first end-to-end shielded token.
5. **Land the per-tensor magnitude guard, failing closed**, before any real model runs — a
   silent field wrap corrupts output with no error signal.
6. Only then: sd.cpp DiT, the mm30 engine bump for TTS, and fleet integration.
