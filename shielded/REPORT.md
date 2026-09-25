# Shielded inference — measured results

Date: 2026-08-14. Companion to [docs/shielded-inference.md](../docs/shielded-inference.md)
(design) and [SECURITY.md](SECURITY.md) (leakage argument).

**Bottom line up front.** The confidentiality design holds, and as of 2026-08-25 it also
RUNS: a real GGUF model generates real tokens with every linear op masked and executed on
an untrusted GPU, and the output is bit-identical to the same model run entirely in-TEE.
No measured cost kills the tier.

**Revision 2026-08-25 (§10) supersedes this section's "what remains open".** The two items
this report called out as missing -- the absence of any end-to-end run, and the fail-closed
magnitude guard -- are both closed, and closing the second turned up a finding that changes
the design: at real activations the field DOES overflow, driven entirely by a handful of
outlier channels, and the fix is to keep those channels in the TEE.

- **GPU**: with the fused kernel now written (`kernels/fused_field_gemm.py`), an exact field
  GEMM costs **0.90–1.32× fp16** — at decode it is *faster* than the baseline, because it
  reads 1.06 B/weight of q8_0 rather than 2 B/weight of fp16, and after tuning it runs within
  19% of the memory roof at K=14336. Against the fleet's real q4_K baseline decode is ~2.2–2.5×
  by byte ratio, well inside the 5× budget. The unfused path this replaces was 2.7–3.7×, and
  naive recombination alone was 5.3–7.5× and failed.
- **TEE refill** (`u = r·W`, which cannot be offloaded without handing the accelerator the
  pad) sustains **214 tok/s for an 8B model** on 16 EPYC cores using int8/VNNI — against a
  measured GPU baseline of 79 tok/s for the same model. **Refill is not the binding
  constraint**, contrary to this report's earlier revision.
- The earlier "7.1 tok/s, refill is the ceiling" figure was wrong twice over: measured with
  stock fp64 BLAS instead of int8, *and* on a box at load 32 from concurrent builds. Both
  are corrected here. It is a good argument for re-measuring on an idle machine before
  drawing a strategic conclusion.

The two kernel requirements this report previously listed as blocking — fused CRT and
in-kernel dequantisation — are now implemented and measured. What remains open is a q4_K
unpack (to beat the fleet's real baseline and fit 8B on an 8 GB card) and, above all, the
absence of any end-to-end run: every number here is a primitive or arithmetic over
primitives.

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
into one kernel brings it back to a few percent of the GEMM. **The fused CRT epilogue is an
implementation requirement of the same rank as the masking itself**, not an optimisation to
defer.

### The fused kernel, written and measured (`kernels/fused_field_gemm.py`)

The report previously recommended fusing the CRT *and* dequantising weights in-kernel, and
called the latter its largest unverified claim. Both are now implemented in one Triton
kernel and verified exact end-to-end (mask → in-kernel dequantise → RNS accumulate → fused
CRT → TEE unmask reproduces the plaintext product bit-for-bit at every shape below).

| shape | fp16 | fused | **vs fp16** | vs roof |
|---|---|---|---|---|
| M=1, K=4096, N=4096 (decode) | 0.107 ms | 0.075 ms | **0.70×** | 1.63× |
| M=1, K=14336, N=4096 (decode) | 0.304 ms | 0.192 ms | **0.63×** | **1.19×** |
| M=16, K=4096, N=4096 | 0.114 ms | 0.076 ms | **0.66×** | 1.65× |
| M=32, K=4096, N=4096 | 0.094 ms | 0.085 ms | **0.91×** | 1.86× |
| M=64, K=4096, N=4096 | 0.095 ms | 0.116 ms | 1.22× | 2.52× |
| M=128, K=4096, N=4096 | 0.206 ms | 0.195 ms | **0.95×** | — |
| M=512, K=4096, N=4096 (prefill) | 0.518 ms | 0.539 ms | **1.04×** | — |
| M=512, K=4096, N=14336 (prefill) | 1.478 ms | 1.744 ms | **1.18×** | — |
| M=2048, K=4096, N=4096 | 1.760 ms | 2.327 ms | **1.32×** | — |

The "vs roof" column is bandwidth-bound only and is meaningless once the shape is
compute-bound, which is why it stops at M=64. At K=14336 decode runs within **19% of the
memory roof**. Against the fleet's q4_K baseline the decode rows scale to roughly **2.2–2.5×**
by byte ratio (0.57 vs 1.0625 B/weight) — an estimate, not a measurement.

Against fp16 the exact field GEMM now costs **0.63–1.32×** across every shape measured — at
decode it is 30–37% *faster* than the baseline, because it reads 1.0625 B/weight of q8_0
rather than 2 B/weight of fp16. Compare the unfused path this replaces: 2.7–3.7× at prefill,
with weights materialised at 3 B/weight.

Three things made the difference, in order of size:

1. **The weight needs no RNS decomposition at all.** Only the masked activation is a large
   field element; the fixed-point weight is tiny (measured max |w_fixed| = 13–68 against a
   119 byte-range limit), so `w mod qᵢ == w` for every prime. One dequantisation feeds all
   three channels and six integer modulos per weight disappear. The first version of this
   kernel kept them and was ALU-bound at 3.9–8.5× — worse than not fusing at all.
2. **Tensor cores win even at M=1.** Routing decode through the padded `tl.dot` kernel with
   `BLOCK_M=16` — computing 16 rows and discarding 15 — measures 0.90× fp16, against 3.7–4.9×
   for a hand-rolled reduction. Decode is bandwidth-bound, so the wasted MACs are free.
3. **Weights never materialise in field form.** 8B needs 8.53 GB in q8_0 rather than 24.09 GB
   as RNS-3 planes.

### The 4-bit weight path

Decode is bandwidth-bound, so bytes per weight is the design variable. Adding a q4_0 path
(0.5625 B/weight against q8_0's 1.0625, in a split-half nibble packing so one byte tile
feeds two k-tiles) **takes an 8B model to 4.52 GB — under the 8 GB line of a commodity
card**, which q8_0 at 8.53 GB does not clear. Masked round-trip verified exact.

Three dequantisation strategies were tried and **all three tie within 3%** on an idle card:
subtract-then-convert, an FMA-folded bias, and a pure-integer int16 scale. The ALU is not the
bottleneck; the byte count is. Two of those variants initially appeared to differ, but they
returned byte-identical timings across every shape — the signature of GPU contention from
overlapping sweeps, not of the kernels. Same error as the CPU contention in §1, caught the
same way: a number that is too neat.

q4 is not a free win. It costs more at prefill (M=512) than q8 does, because the extra
nibble-unpack ALU bites once the shape is compute-bound rather than bandwidth-bound. Since
only one weight format can be resident, the choice is workload-dependent, with a crossover at
roughly **generated_tokens > prompt_tokens / 17**: q4 for generation-heavy serving (chat needs
only >30 generated tokens at a 512-token prompt), q8 for prefill-heavy work (an 8k-prompt
summarizer needs >483 generated tokens before q4 pays off). That is a per-endpoint catalog
decision, not a single global default.

### Two modelled terms replaced with measurements

The end-to-end estimate in §7 previously guessed at both non-GPU terms. Measured:

- **Transport: 1.54 ms/token**, against a modelled 6.4–19.2 ms. TCP loopback RTT is 7.2 us
  for a ping and 10–16 us carrying real masked-activation payloads, so ~4 exchanges/layer
  over 32 layers costs 1.54 ms. Transport is no longer a material term.
- **CPU read bandwidth: 101 GB/s** at 8 threads, against a modelled 60. (16 threads is
  *worse*, at 93.5 — the same hyperthreading cliff both engine baselines hit independently.)
  That cuts 8k TEE attention from 8.95 ms to ~5.4 ms.

Together these move batch-1 decode from the earlier 2.6–4.1x estimate to roughly **2.0–2.3x**,
and the GPU leg is now the only large term left.

### Chasing the remaining bandwidth

The first version left bandwidth efficiency at 0.40–0.59, implying ~2× on the table. Two
candidate limiters, both measured rather than argued:

**Scale traffic — the real one.** The kernel loaded the fp16 scale as a full
`(BLOCK_K, BLOCK_N)` tile, issuing a read per weight for a value shared by 32 weights: up to
2 extra bytes per weight against an intended 0.0625. The measured 0.096 ms sat between the
0.046 ms ideal roof and the 0.130 ms scale-gather roof, which is exactly what partial L2
rescue looks like. Loading a `(BLOCK_K/32, BLOCK_N)` tile and broadcasting it in registers
fixed it.

**Occupancy / split-K — not the limiter.** At M=1 the grid is only 32 programs against 46
SMs, which looks like the obvious problem. A split-K variant was built and measured (partial
int32 accumulators via order-independent atomic add, CRT demoted to a second pass over the
M×N output, which at M=1 is 4096 elements). It came out **slower**: 0.79× against 0.70× at
K=4096, and a wash at K=14336. The atomics and the extra launch cost more than the added
parallelism buys. Recorded as a dead end so it does not get rebuilt.

**A routing regression, found by widening the sweep.** The first block table jumped from
`BLOCK_M=16` straight to 64, so at M=32 the kernel computed two rows of padding for every
real one and measured 1.75×. Padding is nearly free at M=1, where the card is bandwidth-bound
and the wasted MACs cost nothing; it is expensive as soon as there is real work to displace.
`BLOCK_M` now tracks M.

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

1. ~~**No end-to-end shielded run.**~~ **CLOSED 2026-08-25, see §10.** Transport, mask
   staging, refill and verification are now observed rather than modelled. What is still
   modelled is the PRODUCTION cost: the end-to-end implementation is Python/numpy driving
   the same Triton kernel, so its wall-clock is an upper bound with a large interpreter
   term, not an engine measurement.
2. **No stock ggml-rpc remote-GPU baseline**, so transport cost is not isolated.
3. **The q4_K comparison is still an estimate.** The kernel reads q8_0 and the q4_K column is
   scaled by the byte ratio. Against fp16 the numbers are measured; against the fleet's
   actual baseline they are not.
4. **No fleet hardware.** The 3070 is representative of the target *class*; datacenter parts
   have very different fp64 and int8 ratios. The EPYC has 16 cores against a fleet CVM's
   likely 64–128.
5. ~~**No real model, no accuracy measurement.**~~ **PARTLY CLOSED, see §10.** A real model
   runs, and the shielded and in-TEE paths agree exactly. Accuracy against the unquantised
   model is still unmeasured: §10 establishes that the shielded path costs NOTHING beyond
   the fixed-point encoding it shares with the in-TEE reference, not that the encoding is
   free. Fixed-point l=8 turned out NOT to be usable as a global constant -- see §10.2.
6. **Concurrency is unexercised.** The mask bank's one-time invariant is asserted
   single-threaded; the real allocator is concurrent, and a double-issue race is a total break.
   `tee.MaskBank` now takes a lock around issuance and asserts monotonicity, which is
   necessary but not a substitute for a concurrent test.
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
7. Only then: sd.cpp DiT, the mm30 engine bump for TTS, and fleet integration.

---

# 10. The end-to-end run (revision 2026-08-25)

Everything above §9 is a primitive measurement or arithmetic over primitives. This section
is the tier actually running: `shielded/worker.py` holding an RTX 3070 on an untrusted host,
`shielded/model.py` inside the enclave, a real GGUF model, real tokens.

**Headline.** Qwen2.5-0.5B-Instruct, 24 layers, 169 linear tensors, 501 MiB of public
weights resident on the card. Three prompts, greedy decode. **Every generated token is
identical to the same model run entirely in-TEE**, across 6402 round trips and 48.7 GMAC of
offloaded work, with **0 verification failures**. Peak |y| reached 2.1e6 against M/2 = 7.2e6.

Equivalence is the test, and it is not the same as plausibility. A masking bug that perturbs
activations slightly still produces fluent text; a wrapped field product produces confident
nonsense that reads like a small model having a bad day. Slalom recovery is exact in Z_M, so
the claim is bit-equality and the harness asserts bit-equality.

## 10.1 What it cost, and what that number is worth

Per generated token, measured, 371.8 offload exchanges per token across ~6400 round trips:

| term | ms/token | what it is |
|---|---|---|
| mask staging | 30.2 | pad issuance (SHAKE-256) + residue split |
| transport + GPU | 91.6 | the whole exchange: 3 SET_TENSOR + doorbell + GET_TENSOR |
| refill `u = r*W` | 94.2 | the term that cannot be offloaded |
| verification | 15.6 | preprocessed Freivalds, both failure modes |

**Do not read these as engine numbers.** This implementation is Python and numpy around the
same Triton kernel §2 benchmarks; the interpreter dominates every row. What the table
establishes is the SHAPE of the budget -- refill and transport are comparable, verification
is under 10%, and masking is not free -- not the magnitude. The magnitudes that matter are
still §2's kernel measurements and §3's refill ceiling.

The one number here that IS a measurement rather than an artifact is the round trip. A
single masked exchange over the host<->guest loopback, pipelined into one write, is **0.44
-0.70 ms warm** (median 0.56). The first exchange against a fresh worker is **327 ms**,
which is Triton compiling the kernel for that shape and has nothing to do with the network;
the probe reports both, because quoting either alone either hides the compile or libels the
transport. §2's modelled transport of 1.54 ms/token over 32 layers survives contact.

## 10.2 The finding that changes the design: outlier channels, not width

REPORT.md's open risk #3 said (p, l) = (2^24-3, 8) "holds at production *width* but has ~1
bit of margin against 10^3x outlier channels". That is exactly what happened, and it is worse
than 1 bit. Measured on a real forward pass, at the design's fixed l = 8:

| site | rms &#124;x&#124; | max &#124;x&#124; | peak &#124;y&#124; vs M/2 |
|---|---|---|---|
| attn_q | 1.45 | 89.3 | 0.38x |
| attn_output | 0.32 | 9.6 | 0.10x |
| ffn_gate | 1.34 | 382.5 | 0.54x |
| **ffn_down** | **0.39** | **443.5** | **1.81x — WRAPS** |
| output | 10.05 | 162.6 | 0.38x |

`ffn_down` overflows Z_M outright. The model still produces fluent English while doing it --
the first end-to-end attempt returned `" ( and ( and and. and. and. 1"` -- which is the
failure mode a magnitude guard exists to catch and a fluency check never will.

The peak is not a width effect. It is **one band of outlier channels**: ffn_down's activation
has a median channel magnitude of 1.5 against a max of 443, a 300x outlier. Removing the top
few channels collapses it:

| channels held back | 0 | 4 | 16 | 64 |
|---|---|---|---|---|
| attn_q | 0.38x | 0.26x | 0.19x | 0.18x |
| attn_output | 0.10x | 0.08x | 0.07x | 0.04x |
| ffn_gate | 0.54x | 0.28x | 0.28x | 0.21x |
| **ffn_down** | **1.81x** | **0.12x** | **0.10x** | **0.09x** |
| output | 0.38x | 0.31x | 0.25x | 0.17x |

**Four channels take ffn_down from 1.81x to 0.12x — a 15x reduction.** So the design gains a
third mechanism alongside the field and the mask: the TEE keeps the outlier channels and
computes their contribution itself, in plain int64 where nothing can wrap, and adds it to the
GPU's partial product. At k=4 and K=4864 that is 0.08% of the site's multiplies moved back
into the enclave.

This costs nothing in confidentiality, and the direction of travel is the safe one:

- The outlier channel **indices** are a static property of the public weights, calibrated
  offline on public text and shipped like a GGUF imatrix. They are identical for every prompt
  and every user, so they carry no information about anyone's input.
- The **values** in those channels never leave the TEE at all -- strictly less is offloaded
  than before, not more.
- The **activation exponent** is chosen the same way, per site, offline, from public text.
  It is deliberately NOT adapted per request: an exponent computed from the activation in
  hand would be a public parameter derived from secret data, i.e. a real magnitude leak, and
  the extra headroom is not worth buying with one.

Calibration also revealed that the design's single l = 8 was leaving precision unspent
elsewhere. With outliers held back, the chosen per-site exponents run from **7 to 14**, with
>=4x field headroom everywhere -- so most sites get more activation resolution than l = 8,
not less, and `attn_output` gets 64x more.

## 10.3 The guard has to be exact, and it can be free

The a-priori guard tried first was Cauchy-Schwarz: |y_j| <= ||x||_2 ||w_j||_2, with column
norms precomputed. It is sound and it is useless -- it assumes perfect alignment, so it
rejected an ordinary random-weight GEMM whose true peak sat 30x below the limit.

The construction that works is Freivalds over the integers. The TEE's recovered y_hat is
congruent to the true product mod M by construction, so any discrepancy is y_hat - y = c*M
for an integer vector c, nonzero exactly where the product wrapped. Checking the Freivalds
identity modulo an unrelated prime P2 makes that term visible:

```
y_hat*s - x*(W*s)  ==  (c*s)*M   (mod P2)
```

which vanishes only if c*s == 0 mod P2, i.e. with probability <= 1/|S| per repetition. So the
same two dot products that catch a lying worker also catch a field wrap, at the same cost,
and the check strictly subsumes the mod-M version in `reference/shielded_ref.py`. The
selftest asserts both halves, including that the wrapped value is genuinely indistinguishable
mod M -- otherwise the test would be vacuous.

## 10.4 Determinism across three implementations

The design's determinism requirement -- the TEE's `u = r*W` and the GPU's `(x+r)*W` must
derive bit-identical field elements from the same q8_0 bytes -- now has three implementations
to hold together: the Triton kernel, `shielded/field.py`, and `metal/guest/shielded.mjs` in
float32 via `Math.fround`. It is tested rather than inspected: 512 vectors including fp16
subnormals and near-limit scales, and the JS encoder reproduces every one.

The shared arithmetic was moved into `shielded/field.py`, numpy-only, for a reason worth
recording: the TEE runs in a CPU-only CVM, and the kernel module imports torch and triton at
module scope. Importing the GPU half to obtain a rounding rule would have put CUDA in the
enclave's dependency set to serve code that must never touch a GPU.

**A note on fp16 subnormals.** Per-tensor exponents scale the q8_0 block scales by a power of
two, and on real tensors that pushes some blocks into fp16 subnormals. The first
implementation rejected that outright and refused every tensor in the model. It was guarding
the wrong thing: the bits lost are below the fixed-point quantum (those weights encode to
zero anyway), and both sides read the same fp16 array through the same routine regardless. The
check is now on what matters -- that the encoded weight still represents the true weight to
within its own quantum.

## 10.5 Inside a real CVM, against a real untrusted host

The tier's threat model is a GPU whose host operator is hostile. `metal/` is where that
becomes concrete: the card stays on the host, outside the enclave and outside the launch
measurement, and the guest reaches the worker at `10.0.2.2:<port>` over the same slirp path
the egress helper already uses.

Run on a SEV-SNP guest launched by `metal/enclave-metal.mjs`, from inside the CVM:

```
[gsup] shielded GPU OK: NVIDIA GeForce RTX 3070 at 10.0.2.2:9500 — exact=true
       verified=true lie_rejected=true denylist=true corr=-0.053 chi2=74.8
       rt=0.563ms warm (327ms cold, kernel compile)
```

Four assertions, made against the bytes that actually crossed the boundary rather than
argued: the unmasked product is exact; Freivalds accepts the honest result and rejects a
single-element lie; the worker refuses a denylisted op **on the wire**; and the transcript is
uncorrelated with the secret (|corr| 0.053 against a 3-sigma null of 0.133) and uniform over
Z_M (chi2 74.8 against a 103.4 threshold).

The worker's address arrives over fw_cfg, which the launch measurement does not cover, and
that is correct rather than sloppy. A host that redirects it to a worker it wrote gains
nothing: the pad never crosses and Freivalds rejects any product that is not the real one.
The worst it can do is refuse to answer, and availability is the one thing this design
explicitly does not promise. **The GPU's address is ordinary configuration, not a trust
anchor -- which is precisely why the GPU can sit outside the enclave at all.**

## 10.6 Kill criteria, restated

| criterion | standing after §10 |
|---|---|
| Chat/vision >5x at batch >=4 | **Still not killed, still not cleared.** The tier now runs end to end and is exact, so the remaining question is purely the production engine's constant factor. The Python reference cannot answer it. |
| Image gen >3x per image at batch >=4 | **Untested.** Unchanged. |
| STT/TTS fail realtime on both paths | **CLEARED for STT** (§6). Unchanged. |
| Requires trusting GPU driver / host kernel / operator | **Cleared, now by demonstration rather than by construction.** A CVM drove a GPU on an untrusted host through a hostile-by-assumption worker and got an exactly verifiable answer. |

## 10.7 What is still open

1. **The production engine.** ~~`model.py` is a specification and an equivalence reference, not
   an engine.~~ **BUILT 2026-08-25**, in `wasm/ggml-shielded/`: a `ggml_backend_i` that claims
   q8_0 matmuls it has calibration for and lets `ggml_backend_sched` route everything else to
   the CPU backend inside the enclave. Verified against a live worker on the 3070 -- a
   matmul -> SiLU -> matmul graph places both matmuls on the shielded backend and the SiLU on
   the CPU, with 0 verification failures, and the offloaded result is bit-identical to the
   same graph computed locally.

   What is NOT yet done, and is the honest remainder of this item: it has not been linked into
   the ELL engine build or run against a whole model, so "a real GGUF generates tokens through
   the ggml backend" is still owed -- `e2e.py` does that through the Python executor, not
   through this. Accuracy against ggml's own f32 matmul is ~1.5% peak relative on a random
   q8_0 tensor, dominated by the weight fixed-point quantum at `f_w = 10` rather than by the
   masking, which is exact.
2. **Accuracy against the unquantised model.** ~~Unmeasured.~~ **MEASURED 2026-08-25, and the
   encoding is NOT free -- this is now the tier's largest open problem.** Qwen2.5-0.5B (q8_0),
   same model, same prompt, greedy:

   | path | completion of "The capital of France is" |
   |---|---|
   | ggml CPU | ` Paris. It is the largest city in Europe and the second` |
   | shielded, offloaded to the 3070 | ` the capital of the country. The capital of a number is` |
   | shielded, no worker (local int64) | ` the capital of the country. The capital of a number is` |

   The second and third are CHARACTER-IDENTICAL, which is the load-bearing part: **the masked
   offload contributes exactly zero error** (2197 nodes, 7.8 GMAC, 0 verification failures).
   All of the loss is the fixed-point encoding, and it is enough to lose the answer.

   The mechanism is `f_w`, and it is structural rather than a tuning miss. `encode_weight_fixed`
   applies ONE exponent per tensor, chosen so the largest weight still fits the ±119 byte lane
   -- and that lane is what buys the kernel its speed, since `|w| <= min(q)/2` is exactly why
   the weight needs no RNS decomposition. But q8_0's whole structure is a scale PER 32-WEIGHT
   BLOCK, and folding a single global exponent over it discards that: a block whose scale is
   small has every weight rounded to zero. Across the model's 169 tensors, **13.5% of all
   nonzero weights encode to zero**, reaching 39-41% on `blk.0.attn_q` and `blk.0.attn_k`
   (f_w = 5, peak |w_fixed| = 71-91 against the 119 limit -- the exponent is not conservative,
   the tensor's weight dynamic range simply does not fit one byte lane).

   Note what this does NOT invalidate: `e2e.py`'s bit-identical result stands, because it
   compares the shielded GPU path against a shielded LOCAL path -- both encoded. Neither was
   ever compared against the real model, which is why this went unnoticed.

   **FIXED, and the fix reveals what the field budget actually costs.** A per-COLUMN exponent
   takes the wipeout from 13.5% to **0.7%**, and it costs nothing structurally: each output
   column is its own accumulation, so it can carry its own exponent without the sum ever mixing
   two, `|w_fixed| <= 119` still holds per element (residue identity and fused kernel intact),
   and the worker never learns about it -- it multiplies the same arrays and only the TEE's
   final descale changes. A per-BLOCK exponent, which would match q8_0 exactly, does NOT work:
   blocks run along K, so one accumulation would have to sum terms at different exponents.

   But it is not free, and the wrap detector said so immediately. With a per-tensor exponent
   most columns held tiny `w_fixed` and tiny products; per column, EVERY column uses the full
   byte lane, so the products grow and the field overflows at the calibrated activation
   exponent. The ~23.8 bits are a shared budget and both exponents spend from it. Measured on
   Qwen2.5-0.5B, the activation exponent has to give back **5 bits** for the products to fit --
   and at that point the shielded path reproduces ggml's CPU output:

   | prompt | ggml CPU | shielded, per-column, on the 3070 |
   |---|---|---|
   | "The capital of France is" | ` Paris. It is the largest city in Europe and the second largest in` | identical |
   | "The three primary colours are" | ` red, green, and blue. If you mix these three colors,` | identical for 11 tokens, then ` colors in` |
   | "Water boils at a temperature of" | ` 100 degrees Celsius. If the temperature of a substance is` | identical for 10 tokens, then ` a certain liquid` |

   2535 offloaded nodes, 0 verification failures. Tail divergence after ~10 tokens is the
   expected consequence of a fixed-point path: tiny logit differences eventually flip a greedy
   argmax. The facts survive, which the per-tensor encoding could not manage.

   The 5 bits were a measured constant (`SHIELDED_AF_DELTA`), not a calibrated one, until
   `shielded-calib` (C, engine-observed, weights encoded with the backend's own per-column
   routine) replaced the calibration files. Per site the per-tensor exponents were 1-6 bits too
   generous (median 2); the blanket -5 was sized for the worst site, so the median site now
   keeps 3 more bits than it did, and the default is 0. `model.py` and `e2e.py` still use the
   per-tensor encoding and `calibrate.py`.
3. **Calibration coverage.** Exponents and outlier sets come from 203 tokens of public text.
   That is enough to find systematic outlier bands and not enough to bound the tail. The
   runtime detector is what makes this a margin rather than a hope, but a prompt that
   overflows anyway aborts, and abort frequency on real traffic is unmeasured.
4. **Concurrency**, still (§8.6).
5. **A larger model.** 0.5B at K<=4864 exercises the field comfortably. The report's own
   ~18.7-bit accumulator estimate was flat in width, so the risk at 8B is outlier magnitude
   rather than K, and that is now instrumented -- but not measured.

---

# 11. Making it fast (revision 2026-08-26)

Section 10 established that the engine backend is exact. It was also, measured on the
host loopback with the whole model, **612 ms per decoded token** -- 1.6 tok/s against
144 tok/s for plain llama.cpp on 8 threads of the same CPU. Profiling the first token
(`SHIELDED_PROFILE`) rather than reasoning about it gave, per exchange: refill 4.0 ms,
wire 0.35 ms, everything else microseconds. 169 exchanges per token.

## 11.1 What changed

| term | before | after | how |
|---|---|---|---|
| refill `u = r.W` | 4.0 ms/exchange, on the critical path, scalar | off the path; ~0 | pad pool per activation group, background threads, AVX-512 VNNI `vpdpbusd` |
| wire + worker | 0.35 ms (5 frames, Python/torch/Triton) | ~0.08 ms (1 frame, C++/CUDA, dp4a + fused CRT) | `worker-cuda/`, `FIELD_GEMM` |
| exchanges/token | 169 | 49 | gate+up share one exchange; attention projections (0.1-0.8 MMAC) stay on the CPU |
| prefill | offloaded, refill 3x the work | in the enclave, in the clear | `SHIELDED_MAX_M` |
| encode/mask/unmask/verify | scalar `%` | vectorised, generic twin checked at load | `shielded-simd.c` |

## 11.2 Measured, host loopback, RTX 3070 + EPYC 9115, Qwen2.5-0.5B q8_0

| | ms/token | tok/s |
|---|---|---|
| shielded, before | 612 | 1.6 |
| **shielded, after** | **6.5** | **154** |
| plain llama.cpp CPU, 8 threads | 7.0 | 144 |
| shielded, generic (non-AVX-512) kernels | 25.3 | 39 |

Same completion text in every row that generates it; 0 verification failures across
7012 offloaded nodes in the long run (96 tokens at 140 tok/s with a 36-token prompt
prefilled on the CPU). The shielded path is now faster than the in-enclave CPU because
the GPU removes the weight-bandwidth term: the CPU reads 500 MB of weights per token,
the enclave now reads none.

Per-token budget after the change, from the profile: wire 3.9 ms (49 x 80 us), mask
0.9, verify 0.5, unmask/encode/descale 0.5, everything else is the CPU half of the
graph (attention, norms, the small projections). The remaining term is the round trip.

## 11.3 The transport, again

Section 2 modelled transport at 1.54 ms/token from a 7 us loopback ping and 4
exchanges per layer over 32 layers. On the host that is now roughly what it is. Inside
the CVM the path is slirp, whose warm exchange the boot probe measures at ~0.5 ms, and
at 49 exchanges that alone is 25 ms/token -- so the guest now opens AF_VSOCK to the
host (CID 2, same port) whenever it has `/dev/vsock`, with slirp TCP as the fallback.
The worker listens on both.

## 11.4 Inside the CVM, on the deployed app

metal0, SEV-SNP guest, 16 vCPUs, the eyesoff.ai deployment at 85% of the shielded
card, the tenant's engine on llama.cpp's default 4 threads, measured from outside
through the relay with a streaming chat completion (`scratchpad/tps.py`: tokens
between the first and last content chunk over the time between them):

| | decode tok/s | time to first token |
|---|---|---|
| before (Python worker, slirp, refill on the path) | 1.7 | 28 s |
| **after (CUDA worker, vsock, pool)** | **99 and 105** on two prompts | **2.2 s** |

The host's vsock table shows the guest's single established connection to CID 2
port 9500 and nothing on TCP 9500; the worker holds 736 MiB (the encoded weights and
scratch); GPU utilisation during a request reads 1-3%, because a decode step is a
chain of round trips and the card is idle between them. QEMU accepted
`vhost-vsock-pci` under `confidential-guest-support` without any special flag, and
the guest's boot probe (still over slirp, by design: it measures the fallback) came
back at 0.22 ms warm against the CUDA worker, from 0.56 ms against the Python one.

Two things are still on the table if the number needs to move again: the tenant's
engine runs the CPU half of the graph on 4 threads (an engine-side knob, not a
backend one), and prefill is in the clear on those same 4 threads, which is most of
the 2.2 s. Neither is a shielded-path cost.

---

# 12. What shielding costs (revision 2026-08-26)

Section 11 made the tier fast. This measures what it still costs, against the same
card running the same model unmasked -- the comparison the tier has never had,
because until now there was no engine to run both through.

## 12.1 Method

One engine (the ELL build's own libllama/libggml 0.18), one model
(Qwen2.5-0.5B-Instruct q8_0), one card (RTX 3070), one prompt, medians of three
runs on an idle box (load 0.18). Only the BACKEND MODULE changes between rows, so
the difference is the backend and nothing else. Every row produced the same
completion text, which is the check that a fast row is not a broken one.

A false start worth recording: the first "unmasked GPU" row measured 167 tok/s,
suspiciously equal to the CPU row. It was CPU -- `libggml-cuda.so` had failed to
load for want of `libcudart.so.12` and the run silently fell back. A baseline
that matches the thing it is supposed to beat is a bug, not a result. Checking
the device list rather than the number is what caught it.

## 12.2 The numbers

| backend | decode tok/s | ms/token | vs unmasked |
|---|---|---|---|
| unmasked GPU (CUDA, full offload) | 381.2 | 2.62 | 1.00x |
| CPU in the enclave, 8 threads | 166.2 | 6.02 | 2.30x |
| **shielded (masked offload)** | **159.5** | **6.27** | **2.39x** |
| shielded with no worker (int64 fallback) | 6.2 | 162.50 | 62x |

**Shielding costs 2.4x against the same card unmasked.** That is the number the
kill criterion cares about, and it is inside the 5x line at batch 1 -- where the
criterion is stated at batch >= 4, and batching amortises the term that dominates.

## 12.3 Where the 2.4x goes, and it is not the cryptography

Per shielded token (measured, `SHIELDED_PROFILE`, 6.77 ms):

| term | ms/token | share |
|---|---|---|
| **transport / round trips** | **3.79** | **56%** |
| CPU half of the graph (attention, norms, small projections) | 1.24 | 18% |
| mask (pad issue + residue split) | 0.54 | 8% |
| verify (Freivalds) | 0.43 | 6% |
| refill landing on the request path | 0.31 | 5% |
| encode / descale / unmask | 0.45 | 7% |

Everything cryptographic -- masking, verification, unmasking, the field encoding
-- totals **1.42 ms/token, 21%**. The round trips alone are 3.79 ms, which is
MORE than an entire unmasked token (2.62 ms). So the tier's overhead is a
STRUCTURAL property of splitting a sequential graph across a boundary, not a
price paid for the one-time pads. Halving the exchange count would buy more than
making the cryptography free.

## 12.4 The finding that decides where this tier is worth deploying

At 8 threads the shielded path (159.5) is slightly SLOWER than simply running the
model on the enclave's own CPU (166.2). On this box, at this model size, the card
does not pay for itself.

It reverses as the CPU gets scarcer, which is the situation a real tenant is in --
a tenant buys a FRACTION of a node, not all of it:

| CPU threads | CPU tok/s | shielded tok/s | shielded wins? |
|---|---|---|---|
| 4 (llama.cpp's in-CVM default) | 135.2 | **140.6** | yes |
| 8 | 167.7 | 152.8 | no |
| 16 | 164.1 | 142.8 | no |

The shielded path moves the matmuls off the CPU, so it is far less thread-hungry:
it loses only 8% going from 8 threads to 4, where the CPU path loses 19%.

The other axis is model size, and it is NOT measured here because only one model
has calibration. The reasoning is one-directional and worth stating as a
prediction rather than a result: CPU decode is bandwidth-bound over the weights,
so it falls roughly linearly with model size (this report's own 8B q8_0 CPU
baseline is 13.8 tok/s, against 0.5B's ~166), while the shielded path's dominant
term -- ~49 round trips per token -- is FIXED and its GPU term grows with the
card's bandwidth rather than the CPU's. If that holds, the crossover is well below
8B and the tier's value is concentrated in models too big for a CVM's CPU. **The
next measurement worth taking is a calibrated larger q8_0 model**; until then, the
honest claim is that shielding is a wash at 0.5B and unproven above it.

## 12.5 In the CVM, end to end

The deployed eyesoff.ai instance on metal0 (85% of the shielded card, over vsock,
through the relay, measured from outside) decodes at **99-136 tok/s**. That is the
same order as the host-loopback figure above and lands between the 4- and 8-thread
rows, which is what a tenant holding 20% of a 16-vCPU node should see.

Not measured: the same app deployed WITHOUT shielding on the same box. That needs
a second funded lease, and would close the last cell of this table.

---

# 13. Round two: the round trip, the kernel, and the model-size axis (revision 2026-08-26, evening)

Section 12 ended with two claims: that the tier's overhead was the round trip and not the
cryptography, and that its value would be in models too big for a CVM's CPU -- the second
stated as a prediction, because only one model had a calibration. This section acts on the
first and measures the second. Same box, same engine (ELL libllama/libggml 0.18), same
harness as section 12 (one process, backend modules by path, only the backend differs
between rows), every row a median of three on an idle box, every row's completion text
checked against its siblings.

## 13.1 Where the round trip actually went

Section 12's 76 us per exchange was measured as "wire". Timed from the worker's side it
splits differently: the socket is ~9-15 us of it and the worker's GPU path is ~60 us, of
which the kernel itself -- the two gate/up products -- is 21 us. The other ~40 us was the
DMA latency of an H2D copy, two dependent kernel launches, a D2H copy and the stream
synchronisation around them, per exchange, 49 times per token: 1.9 ms of a 6.3 ms token
spent waiting for the card to start and stop doing 21 us of work. The kernel, meanwhile,
was fine at m=1 (400-465 GB/s of weight bandwidth against the card's 448) and broken at
m>=4 (91 GB/s at m=8), because every block re-staged all 3*m*K bytes of the activation
into shared memory, which at m=8 is several times the weight bytes it then reads.

## 13.2 What changed

| term | before | after | how |
|---|---|---|---|
| worker GPU path per exchange, beyond the kernel | ~40 us | ~4 us | the frame is read straight into pinned memory; upload + one fused multi-node kernel + output written by the kernel into MAPPED host memory are captured once per (m, node list) as a CUDA graph and replayed with one launch; the reply is one writev from where the products landed |
| kernel at m=4 / m=8 (0.5B gate\|up) | 180 / 91 GB/s | 299 / 215 GB/s | four weight rows per warp share every activation load; the activation is read through L1 rather than staged per block; one launch covers up to 8 nodes; 4B shapes reach 330-410 GB/s at every m |
| TEE per exchange | pads memcpy'd out of the ring; malloc'd reply; per-node std::vectors; unmask then two verify passes | pads used in place (ring with held/reserved regions); link-owned reply buffer; scratch kept across calls; unmask fused with the Freivalds lhs pass | `shielded-tee.c`, `shielded-wire.c`, `shielded-simd.c` |
| pool warm-up | first token generated 49 pads on the request path | `sh_link_start` waits (bounded) for one pad per group | |
| refill threads | fixed 2 | derived from the registered MACs (0.5B: 2; 4B: 10-11) | `derive_threads` |
| outlier term | int64 scalar (0.6 ms/token once lm_head held back 32 channels) | exact double accumulate, vectorised | `outlier_add` |
| calibration | `calibrate.py`, qwen2 only, per-tensor exponents, `SHIELDED_AF_DELTA=-5` | `shielded-calib` (C, `cb_eval`), any q8_0 GGUF libllama runs, per-column exponents, delta 0, format version 2 | 13.4 |
| shared-activation group split by ggml_backend_sched | one round trip and one pad per visible member | the first member's exchange fetches the whole group; the later split is served from a cache keyed on the exact activation | 13.5 |
| worker restart | the tenant fell to the int64 path for the rest of its life | link down, retry with 1-60 s backoff, in-enclave compute meanwhile | |

## 13.3 Measured: Qwen2.5-0.5B q8_0, host loopback, medians of three

| backend | threads | decode tok/s | ms/token | vs unmasked |
|---|---|---|---|---|
| unmasked GPU (CUDA, full offload) | 8 | 422.7 | 2.37 | 1.00x |
| CPU in the enclave | 8 | 172.2 | 5.81 | 2.45x |
| shielded, section 12 build (same run) | 8 | 172.1 | 5.81 | 2.45x |
| **shielded, this revision** | 8 | **216.2** | **4.63** | **1.95x** |
| CPU in the enclave | 4 | 135.7 | 7.37 | |
| shielded, this revision | 4 | 215.1 | 4.65 | |
| CPU in the enclave | 16 | 166.3 | 6.01 | |
| shielded, this revision | 16 | 191.7 | 5.22 | |

Same completion text across the three runs of every row; the shielded rows at 4, 8 and 16
threads produce the same text as each other; 0 verification failures; 3139 exchanges and
4676 offloaded nodes per 64-token run, unchanged. (The "before" row differs textually from
the "after" rows because the exponents changed -- 13.4 -- and both match their own int64
in-enclave computation character for character, which is the exactness check.)

Shielding now costs **1.95x against the same card unmasked**, from 2.45x, and the
shielded path beats the enclave's own CPU at every thread count instead of tying it --
by 26% at 8 threads and by 59% at the 4 threads an in-CVM tenant actually gets. The
shielded row barely moves between 4 and 8 threads (215 vs 216): the matmuls are off the
CPU, so what the threads are left with is attention and norms.

Per token after (from `SHIELDED_PROFILE`, 4.63 ms):

| term | ms/token | before (section 12) |
|---|---|---|
| wire (49 round trips, 46 us each) | 2.24 | 3.79 |
| CPU half of the graph | ~1.5 | 1.24 |
| post (outlier term + descale) | 0.55 | 0.17 (0 outliers on lm_head then) |
| unmask + Freivalds lhs / rhs | 0.31 | 0.97 (unmask + verify) |
| mask (pad take + residue split) | 0.13 | 0.54 |
| encode | 0.02 | 0.20 |
| refill on the request path | 0 | 0.31 |

The exchange floor by shape (`xtimer`, TCP loopback, us per exchange, old worker + old TEE
objects on the left, new on the right):

| shape | before us/exchange | after us/exchange |
|---|---|---|
| 0.5B-gate|up (K=896, N=4864, 2 nodes, m=1) | 66.5 | 46.8 |
| 0.5B-down (K=4864, N=896, 1 node, m=1) | 37.6 | 29.8 |
| 0.5B-lm_head (K=896, N=151936, 1 node, m=1) | 773.5 | 495.5 |
| 0.5B-gate|up-m4 (K=896, N=4864, 2 nodes, m=4) | 147.9 | 89.5 |
| 0.5B-gate|up-m8 (K=896, N=4864, 2 nodes, m=8) | 259.4 | 149.3 |
| tiny (K=256, N=256, 1 node, m=1) | 26.4 | 17.3 |
| 4B-gate|up (K=2560, N=9728, 2 nodes, m=1) | 190.2 | 166.6 |
| 4B-down (K=9728, N=2560, 1 node, m=1) | 115.5 | 104.6 |

## 13.4 Calibration for any model, and the 5 bits back

`shielded-calib` (`wasm/ggml-shielded/shielded-calib.cpp`) replaces `calibrate.py` for the
engine backend. It sets `llama_context_params.cb_eval` -- the hook llama-imatrix uses --
prefills the same four calibration texts through the real engine on the CPU backend,
captures the activation of every matmul the backend could claim, encodes every weight with
the backend's own `sh_prepare_weight_rows` (per output column, the same object file), and
chooses `(act_frac, outliers)` by `calibrate.py`'s rule. Two consequences:

- It calibrates whatever libllama can prefill. Three files ship now: Qwen2.5-0.5B (97
  sites), Qwen3-4B-Instruct (144 sites) and Qwen3.5-0.8B-MTP, a hybrid deltanet
  architecture with fused `attn_qkv` and `ssm_*` linears (97 sites). Each regenerates
  byte-for-byte (determinism was checked by an independent build).
- Its exponents are for the product the runtime forms, so `SHIELDED_AF_DELTA` defaults to
  0. Against the per-column encoding the old per-tensor exponents were 1-6 bits too
  generous per site (median 2); the blanket -5 had been sized for the worst site, so the
  median site now keeps 3 more bits. The file carries a format version and the backend
  applies the historical -5 to a version-1 file itself.

A site that cannot reach the 4x headroom target even at the smallest exponent is left
out and stays in the enclave (Qwen3-4B's last-layer `ffn_down`, 3.61x): a wider input than
the calibration text would otherwise wrap the field there and abort the request.

The calibrator also reports, from the graph rather than from names, which sites share one
activation. That is how it found that qwen35's deltanet layers feed `attn_qkv`,
`attn_gate`, `ssm_alpha` and `ssm_beta` from one norm output while the backend was
exchanging two of them as two groups -- one plaintext under two pads, and 18 exchanges per
token more than needed. `sh_group_key` folds them now, in both places.

## 13.5 The model-size axis, measured

Qwen3-4B-Instruct q8_0 (36 layers, 4.0 GB of int8 weights on the card):

| backend | threads | decode tok/s | ms/token | runs |
|---|---|---|---|---|
| unmasked GPU (CUDA, full offload) | 8 | 84.6 | 11.81 | n=3, 1 text |
| CPU in the enclave | 16 | 25.6 | 38.98 | n=3, 1 text |
| CPU in the enclave | 8 | 25.4 | 39.41 | n=2, 1 text |
| **shielded** | 16 | 43.1 | 23.22 | n=3, 1 text |
| shielded | 8 | 45.8 | 21.82 | n=2, 1 text |

Qwen3.5-0.8B-MTP q8_0 (hybrid deltanet):

| backend | threads | decode tok/s | ms/token | runs |
|---|---|---|---|---|
| unmasked GPU (CUDA, full offload) | 8 | 277.6 | 3.60 | n=3, 1 text |
| CPU in the enclave | 8 | 87.5 | 11.43 | n=3, 1 text |
| **shielded** | 8 | 97.2 | 10.29 | n=3, 1 text |

The prediction held, with numbers. At 4B the enclave's CPU decodes at 25 tok/s and the
shielded path at 45.8 tok/s (8 threads; 16 threads is slower at 43.1, the engine's threads and the 11 refill threads contending for 16 cores): the card pays for itself 1.8x over, and sits
1.8x behind the same card unmasked -- about where the 0.5B sits (1.95x), not
worse, because a 4B token is 4 GB of weight bandwidth that both paths pay and 145 round
trips that only one does. Per 4B token: 144 exchanges (104 us each, 14.9 ms), 72 members served from the completion cache, mask 0.75 ms, unmask+Freivalds 1.80 ms, outlier term + descale 1.42 ms, encode 0.16 ms, refill on the path 0.00 ms; the rest is the CPU half of the graph.

Two things the 4B needed that the 0.5B never exercised. Its q/k/v projections are big
enough to offload, and `ggml_backend_sched` puts a CPU op (Qwen3's q_norm) between them,
so the backend saw the group one member at a time: 181 exchanges per token where 145 were
due, and a pad per member for one activation. An exchange for a partial group now asks
the worker for every member's product and keeps the invisible ones in a cache keyed on the
exact field-encoded activation; the later split is served from it when its activation is
byte-identical (which it is, since it is the same tensor), and re-exchanged if not. 4643
exchanges for 32 tokens, from 5795; texts identical. Nothing new crosses the wire: the
extra products are functions of the same masked planes and the public weights, verified
like every other. And refill: 4B needs ~48 core-ms of `u = r.W` per token against the
0.5B's 5.4, which is why the thread count is now derived from the registered weights
(11 threads here) rather than fixed at 2.

The first request of a 4B tenant pays ~3 s to ship 4 GB of public weights to the worker
and warm the pool; that is once per process, not per request.

## 13.6 Batch width and speculative decoding

The two ways to amortise the round trip, measured with `bench-batch` and `bench-spec`
(`make -C wasm/ggml-shielded bench`):

Batch width -- one `llama_decode` of m rows per step, the cost of a verify pass of m-1
drafts or of m concurrent users (0.5B, ms per step, tok/s-equivalent = m / step):

| m | CPU ms (tok/s-eq) | unmasked CUDA ms (tok/s-eq) | shielded ms (tok/s-eq) |
|---|---|---|---|
| 1 | 5.68 (176) | 2.21 (452) | 4.92 (203) |
| 2 | 9.97 (201) | 2.53 (789) | 7.48 (268) |
| 3 | 13.59 (221) | 2.67 (1122) | 9.41 (319) |
| 4 | 11.50 (348) | 2.79 (1434) | 11.30 (354) |
| 6 | 14.32 (419) | 3.23 (1859) | 16.18 (371) |
| 8 | 15.82 (506) | 3.75 (2134) | 19.13 (418) |

With the kernel fixed the shielded step grows sub-linearly in m (3.9x at
m=8), so eight concurrent users of one 0.5B tenant would see 418 tok/s in
aggregate -- the throughput argument the kill criterion is stated in terms of. Pool depth
must scale with m (`SHIELDED_POOL_DEPTH >= 4m`; these rows used 64 and 8 refill threads).

Speculative decoding -- real self-drafting through the engine's own MTP verbs on
Qwen3.5-0.8B-MTP (draft k, verify k+1 rows in one pass, greedy accept, rewind), 64 tokens,
P_MIN=0, text asserted identical to plain greedy decode:

| backend | k | tokens/round | acceptance | draft ms | verify ms | spec tok/s | plain tok/s (bench-run) | speedup | text |
|---|---|---|---|---|---|---|---|---|---|
| cpu | 1 | 1.70 | 70% | 3.6 | 17.0 | 76.4 | 87.5 | 0.87x | identical |
| cuda | 1 | 1.70 | 70% | 1.5 | 4.2 | 231.2 | 277.6 | 0.83x | identical |
| shielded | 1 | 1.75 | 75% | 2.0 | 13.8 | 99.4 | 97.2 | 1.02x | identical |
| cpu | 2 | 1.97 | 48% | 6.7 | 23.5 | 60.6 | 87.5 | 0.69x | identical |
| cuda | 2 | 1.97 | 48% | 2.7 | 4.6 | 206.5 | 277.6 | 0.74x | DIFFERS |
| shielded | 2 | 1.97 | 48% | 3.6 | 17.8 | 83.1 | 97.2 | 0.85x | identical |
| cpu | 4 | 2.17 | 29% | 12.7 | 28.6 | 49.5 | 87.5 | 0.57x | identical |
| cuda | 4 | 2.17 | 29% | 5.2 | 5.3 | 166.2 | 277.6 | 0.60x | DIFFERS |
| shielded | 4 | 2.25 | 31% | 6.5 | 23.0 | 69.8 | 97.2 | 0.72x | identical |

It is not the lever the handoff hoped for, and the reason is not the shielded path: the
MTP head's acceptance is 75% at k=1 and falls from there, so a round yields
~1.8 tokens for a verify pass that costs ~1.5 plain steps plus a draft, and every backend
lands near break-even at k=1 and below it beyond. (The `plain` column of `bench-spec` runs
the ell server path at its default thread count; compare its speculative rows against
`bench-run`'s plain figure for the same backend, which is what the speedup column does.)
Batching wins; speculation waits for a draft head that is accepted more often.

## 13.7 What it took to keep it honest

Three reviewers were pointed at the diff with instructions to refute it, and a red-team
re-ran every transcript attack of SECURITY.md section 7b against the new stack (section
7c there). The invariants held -- 63,338 masked plane-rows with no pad reused, including
depth-1 rings under 8 refill threads and m=8 batches; every corruption aborted; the
known-pad positions carry no structure -- and the reviews found what reviews are for:

- A weight registered after the pool started changed the refill threads' row stride
  under them (an ASan-confirmed heap overflow that no measured run had hit, because every
  weight of these models shows up in the first graph). The pool now stops and drops its
  rings before any group changes.
- A worker that answers a `FIELD_GEMM` with an oversize or wrong-length frame was being
  classified as "this node's shape" rather than as a misbehaving peer, so a tenant would
  keep shipping a pad per group per token to a worker whose replies it could not use, and
  never reconnect (787 wasted exchanges in the reviewer's fake-worker run). Worker-originated
  errors now take the link down.
- Five hand-written frames killed the worker process outright (a 2^64-1 allocation,
  a 2^62-wide install, reads of a weights buffer after install, two million nested
  brackets). It refuses them now; a crash was never a refusal, and the launcher's 2-second
  restart had been covering for it.
- The Freivalds rhs accumulator's documented bound was wrong (it needs |x| < 2^24, which a
  legal activation satisfies; chunks are 32 now, good to 2^26).

## 13.8 What deploying it costs, and a mistake worth recording

The launcher on a metal box runs the worker straight from `shielded/worker-cuda/
shielded-worker`, so `make` there IS a deploy -- and linking over the live binary rewrote
the pages the running worker was executing. It died mid-exchange, the launcher restarted
it on the new build within two seconds, and the CVM's tenant -- running the section-12
backend, which had no reconnect -- spent the next 25 minutes on the int64 path at 6 tok/s
until the service was restarted (one app-hostname certificate issuance, the box's seventh
that day). The Makefile now links to a temporary name and renames it into place, so a
running worker keeps its inode; and the backend in this revision reconnects, so the same
event would cost a tenant a few seconds. The guest half of that fix reaches the fleet only
through a release and `metal/update.mjs`, which builds from the tag.

Measured from outside after that restart, with the new worker under the old guest backend:
100.8 tok/s decode on the live app (one sample), from 99-105 before.

The release carrying this revision (v0.5.509) was then deployed to metal0 through
`metal/update.mjs` -- the image build compiles the backend from source, the box came back
healthy, the tenant re-attached to the shielded card over vsock -- and measured from
outside on three prompts (96 tokens each, host idle): **88.6, 91.8 and 95.9 tok/s**. That
is BELOW the old backend's in-CVM figure, while on the host loopback this revision is 26%
faster. It is recorded as measured and not explained: the tenant's engine runs the CPU
half on 4 SNP vCPUs, where the new calibration's 32 held-back lm_head channels and the
fused verify cost more than on the host's 8 idle cores, and the vsock exchange may not
shrink the way the loopback one did; the in-guest `SHIELDED_PROFILE` that would settle it
is not reachable from outside. Until it is, the honest in-CVM claim is "within noise of
before", not "faster".

That deploy also produced an outage of its own: nothing persists in the initramfs-only
guest, so every restart re-issues the app hostname's certificate, this was the box's
eighth restart of the day, and it was the one that ran into Let's Encrypt's five-per-week
limit for the name while ZeroSSL was timing out. The running app served no certificate
for 19 minutes -- ten of them the supervisor's own per-name backoff after both CAs were
usable again. The retry policy is changed in the same push (a CA-level failure retries
the moment the cooling CA is back, on a precise timer); the count-your-restarts rule is in
the memory notes, and a persistent, sealed certificate cache across restarts is the real
fix and is not built.

## 13.9 Open

- **In the CVM.** The deployed number (13.8) did not follow the host loopback: 89-96
  tok/s against ~100 before. An in-guest profile is the missing measurement; the
  candidates are the outlier term and fused verify on SNP-throttled vCPUs, and vsock.
- **The remaining 46 us.** ~9-15 us is the socket, ~24 us the fused kernel at K=896, the
  rest launch and sync. Short K at m>=4 (0.5B shapes) still runs at ~215 GB/s against 400+
  for the 4B shapes: a different block shape for short K is the next kernel lever.
- **lm_head is 30% of the bytes and 15% of the token** at 0.5B (136 MB per token, one
  exchange, 32 outlier channels held back). A vocabulary-pruned or int4 lm_head is the
  obvious target if the token has to get shorter at this size.
- **Refill at 8B+.** ~100 core-ms per token; a 16-vCPU CVM can spend half its cores on it
  and still fit, but the policy that decides which cores belongs to the supervisor, not
  the backend.
- **Two contexts, one link.** The backend assumes one caller (graph_compute holds
  `sh_state::mu`, so it is serialised, not concurrent); an engine that ever ran two
  contexts' graphs on two threads would queue on that mutex.

## 13.10 Follow-up the same evening: vsock, spinning, and a cost-aware calibrator

The in-CVM shortfall of 13.8 needed a term that the host loopback does not have. The host
has a vsock LOOPBACK (the launcher's own probes reach the worker as CID 1), so the
section-12 backend and this one were run over it, at the tenant's 4 threads, against the
same worker:

| backend | TCP loopback | vsock loopback | wire term per 64 tokens (vsock) |
|---|---|---|---|
| section 12 | 179.9 tok/s | 165.1 | 204.1 ms |
| this revision | 190.5 | 171.9 | 204.9 ms |

Over vsock the two wire terms are IDENTICAL, though over TCP this revision's is 50 ms
shorter: the worker-side savings are hidden under the transport. And the loopback is the
cheap case -- 5-10 us per exchange over TCP (`xtimer`: tiny op 26 vs 20 us) -- while the
guest's vhost-vsock path, from 13.8's numbers, costs on the order of 100 us per exchange:
each blocking read there is a vCPU halt, an interrupt injected into an SEV-SNP guest, and
the VM exits around it. That is the term, and it is not one the worker or the kernel can
touch.

The obvious answer, a bounded busy-poll before the blocking read (`SHIELDED_SPIN_US`,
and `SHIELDED_WORKER_SPIN_US` on the host side), was built and measured on what is
measurable here: a wash over TCP (-2 us) and a LOSS over vsock loopback (+10 to +24 us,
the spinner starving the loopback transport's kernel worker on its own CPU). It ships OFF
by default, as an in-guest experiment for the next deploy, not as a claim.

What did move: the one new cost that survives any transport is the outlier term, and
the calibrator's rule for it was cost-blind -- on lm_head, 32 held-back channels bought
exactly one bit of exponent (peak 16.0M -> 14.1M at the reference exponent) for 4.9M
TEE-side MACs per token. `shielded-calib` now bounds outliers at K/64 per site
(`--max-k-div`; a site that cannot reach the headroom target within the budget gets the
whole candidate list back, so wrap safety still outranks TEE time). On the 0.5B that
takes the held-back channels from 432 to 208 across the model, lm_head to none, and
eight small sites lose one bit; on the 0.8B-MTP 376 -> 248; the 4B is unchanged (its
K is wide enough that the budget never binds).

| calibration | decode tok/s (0.5B, 8 threads, same run) |
|---|---|
| unbounded outliers (13.3's) | 189.7 |
| **K/64 budget** | **208.0** |

Same completion text as the unbounded file and as the int64 in-enclave computation, 0
verification failures. The 0.8B-MTP does not move (98.6 vs 98.4): the channels its budget
removed were not on a wide site. This is a TEE-side saving, so it should carry into the CVM in
full, unlike the worker's; the in-guest profile that would confirm it is still the
missing measurement, and it needs the tenant's log channel, not another restart.

## 13.11 Start-up, batching defaults, and where the 2.2 s TTFT really goes

Three things found while looking for the in-CVM term, none of them the in-CVM term.

**Context creation was the backend's.** The engine's `sched_reserve` -- run once per
context, which the wasm host creates once per model -- took 2 ms on the CPU backend and
**3.6 s with the shielded backend on the 0.5B, 32 s on the 4B**. All of it was weight
registration, which `ggml_backend_sched` triggers through `supports_op` once the data is
loaded: the row encoder re-derived every block's scale per element through
`sh_encode_weight_fixed` (8 ns per weight), the Freivalds `W^T s` was a strided scalar
int64 loop, and both ran serially per weight. The encoder now forms each block's `d256`
once and encodes its 32 quants in the reference's exact float op order (bit-identical,
checked against the element-by-element form kept as `sh_prepare_weight_rows_ref`), rows
are spread over threads, and `fv_prepare` accumulates per rep in a contiguous double row
(exact below 2^53) on threads too:

| | section 13.3 | now |
|---|---|---|
| 0.5B context creation | 3.37 s | 0.30 s |
| 4B context creation | 29.4 s | 2.1 s |

Same completion text, 0 verification failures. This is a tenant's launch-to-ready time,
so it is worth more than its absence from every tok/s table suggests.

**Batched decode needed no knobs.** The pool depth now defaults to four times the widest
batch the graph may present (32 for the default `SHIELDED_MAX_M`) and the refill thread
count is derived for half that width, so a multi-user step at m=8 runs with 19 of 16,075
pads generated on the request path (0.1%) where the fixed depth of 16 starved it; the
0.5B step at m=8 is 16.4 ms, 489 tok/s in aggregate, and at m=1 nothing changes (idle
threads cost nothing).

**The live app's 2.2 s time-to-first-token is not inference.** A ~400-token prompt adds
0.6 s to it (prefill runs at ~650 tok/s in the clear on the tenant's 4 vCPUs) and a
1-token request with a 2-word prompt still takes 2.2 s; a plain `GET /v1/models` through
the app hostname takes 2.0-2.3 s, of which the TLS handshake alone is 1.3-1.7 s, and a
second request does not reuse the connection. That is the relay-to-enclave path
re-handshaking per request, in front of ~0.3-0.5 s of engine work, and it belongs to the
relay and the in-enclave TLS bridge, not to this backend. It is also the single largest
latency a user of the tier sees.

**A profile line the guest can emit.** Under `SHIELDED_PROFILE` the backend now prints its
per-term totals every 4096 exchanges as well as on the stats call the engine never makes;
the tenant's stderr reaches the owner through `/v1/deployments/:id/logs`, which is the
channel the in-CVM question of 13.8 needs -- set in the tenant's environment for one
deploy, read back, done, without another certificate.

## 13.12 Where the batched regime is bound, and speculation closed

The kill criterion is stated at batch >= 4, so the m=8 step deserves its own breakdown
(`bench-batch`, 0.5B, 8 threads, `SHIELDED_PROFILE`, per step):

| term | m=1 | m=8 | ratio |
|---|---|---|---|
| step | 4.8 ms | 20.5 ms | 4.3x |
| backend graph_compute | 6.4 | 11.2 | 1.7x |
|   of which wire (49 exchanges) | 3.0 | 5.4 | 1.8x |
|   of which mask / unmask+lhs / rhs / post | 0.13 / 0.20 / 0.10 / 0.15 | 0.53 / 1.00 / 0.31 / 0.89 | 4-6x |
|   of which int64 result traffic and copies (the rest) | ~0.3 | ~2.8 | |
| CPU half of the graph (step minus backend) | ~1.2 | ~9.3 | 8x |
| card time (worker's own timer) | 2.3 | 3.6 | 1.5x |

The card and the round trips amortise well (1.5-1.8x for 8 rows); what does not is the
enclave's CPU half, which scales linearly with m because it is per-row work: the
attention, the norms, and above all the projections the placement policy keeps on the
CPU. `SHIELDED_MIN_MACS` is applied to the WEIGHT's size, so Qwen2.5-0.5B's q/k/v/o
(1.8 M MACs per row per layer) stay in the enclave at every m, and at m=8 that is
350 M MACs per step through ggml-cpu -- several milliseconds -- with no offload
involved. Claiming them at m >= 4 would trade that for +48 round trips and their refill,
which at this size is close to a wash; on a 4B they are offloaded anyway. So the batched
regime is bound by the enclave's CPU, and the tenant's CPU share is what sets its
throughput ceiling, not the card: 489 tok/s in aggregate at m=8 on 8 host threads,
against 2134 unmasked -- 4.4x, inside the 5x line, and it will be worse on 4 SNP vCPUs.
The backend's own next lever there is small and known: carry the product as int32 rather
than int64 through unmask, the outlier term and descale (every value is below 2^24),
which halves the ~2.8 ms of result traffic at m=8, and spread that work over rows.

Speculation is closed for this tier at this model size. A `P_MIN` sweep on the
0.8B-MTP (k=2, shielded, 64 tokens), plain decode at 97-99 tok/s:

| P_MIN | tokens/round | acceptance | spec tok/s |
|---|---|---|---|
| 0 | 1.97 | 48% | 76.8 |
| 0.5 | 1.70 | 81% | 78.2 |
| 0.7 | 1.43 | 91% | 75.8 |
| 0.85 | 1.26 | 100% | 71.9 |

Confidence gating buys acceptance and loses tokens per round in equal measure; every
setting loses to plain decode. The draft head itself is the limit, not the verify pass.

The TLS finding of 13.11, split: a handshake to a NONEXISTENT app-zone label -- the
relay alone -- takes 0.8-0.9 s, and to the live app 1.6-1.7 s, with a 41 ms ping to the
relay. Both legs are ~0.8 s where a handshake over that RTT should be ~0.15; each is
somebody's per-connection setup, and neither is this backend's.

## 13.13 The in-guest profile, finally

Everything above (13.10-13.12) plus the wasm-manager change that sets `SHIELDED_PROFILE`
for a shielded tenant and echoes the backend's profile lines to the guest console was
deployed to metal0 as v0.5.513 (forced through `metal/update.mjs`; the app hostname's
certificate took 14 minutes, of which 10 were ZeroSSL's cool-off after a first-call
timeout while egress was still coming up -- Let's Encrypt is at its weekly limit for the
name until 2026-08-27 13:04 UTC -- and the two-minute cool-off with a second chance is in
the next release). Measured from outside on three prompts: **97.7, 87.9 and 103.2 tok/s**,
i.e. the same band as before, and now the guest says why. From the tenant's own
counters, between exchanges 8192 and 12288 (83.6 tokens of the 0.5B, 4 vCPUs, vsock):

| term | in the CVM (ms/token) | host loopback, 13.3 (ms/token) |
|---|---|---|
| **wire, 49 round trips** | **7.47 (152 us each)** | 2.24 (46 us each) |
| CPU half of the graph | ~1.9 | ~1.5 |
| unmask + Freivalds lhs / rhs | 0.26 / 0.12 | 0.20 / 0.10 |
| post (outlier term + descale) | 0.20 | 0.20 |
| mask | 0.14 | 0.13 |
| encode | 0.02 | 0.02 |
| refill on the request path | 0 | 0 |
| token | ~10.3 | 4.63 |

**Seventy-three percent of a deployed token is the vhost-vsock round trip**: 152 us per
exchange where the host loopback pays 46 and the socket itself is ~10. The worker's GPU
path is inside that 152 (it shrank by ~25 us in 13.2, which is why the deployed number
did not fall when the host's rose), the TEE's crypto is 0.7 ms and every TEE-side
saving of 13.10 landed in full (post 0.55 -> 0.20 ms) -- and none of it matters against
7.5 ms of transport. In the CVM the tier is transport-bound, full stop.

So the levers for the deployed number are, in order: a transport that does not pay a
VM exit and an interrupt per direction per exchange (a shared-memory ring polled by
both sides -- the pages carry ciphertext, so sharing them with the host costs nothing
the design does not already give away -- which is launcher, QEMU and attestation-review
work, not backend work); failing that, a bounded busy-poll in the guest
(`SHIELDED_SPIN_US`, built, unmeasured in the guest, negative on the host's loopback);
and fewer exchanges per token, which at 49 for this model is already the minimum the
graph allows. The batched regime (13.12) amortises the 152 us over m rows and is where
the deployed tier's throughput is.

## 13.14 A card that is not ours: reservation, fallback, and the transport tracks

The evening's live app told a story the host never could. A game started on the
production 3070 (6.3 GB, ~95% of the time-slices) and the deployed 0.5B fell from ~95 to
**15 tok/s** -- six times SLOWER than the enclave's own CPU -- because every one of the
49 exchanges waited a full slice (~1 ms) behind it: 152 -> 1240 us. A consumer card has
no partition to reserve, no MPS for a graphics client, no MIG; what the driver exposes
is the time-slice policy (`compute-policy --set-timeslice`, root; now a oneshot unit in
`metal/host-setup.sh`). So the protection is in our code, on both axes:

- **Memory is reserved, not capped.** The worker's `--vram-gb` bounded what tenants could
  allocate while the worker took device memory lazily; a later neighbour got it first
  and the tenant's next allocation failed. Every device allocation now comes from the
  stream-ordered allocator's pool with its release threshold pinned, and start-up
  claims the whole budget once: a 1 GiB worker holds 1.2 GiB at idle; one asking for
  20 GiB exits 75 naming what is free, the launcher retries, the guest withdraws the
  card, the tenant runs in the enclave until the budget is there. The production worker
  now holds its 6.5 GiB at start.
- **Compute falls back.** The backend tracks each group's exchange latency against the
  best it has seen AND against the exchange's idle expectation from its weight bytes (a
  card contended from the first token has no best); when four in five recent exchanges
  are slow it computes the claimed matmuls in the enclave through ggml's CPU backend
  (`ggml_backend_sched` keeps its split plan across tokens, so declining ops is not
  enough; the backend has to compute them itself), keeping one probe group per token on
  the card to notice recovery. Measured on the host under a synthetic hog (a game
  stand-in): **10.3 tok/s without the fallback, 57.6 with it**, quiet runs untouched
  (4.85 ms/token, text identical). The same CPU path replaces the int64 fallback on
  every other failure (a dead link now decodes at 92.6 tok/s while it reconnects, from
  6.2). The fleet sees it too: the worker re-measures its throughput on HELLO and the
  guest's 30-second tick flags the card `contended` below half its best.

The transport tracks, all built, measured where the host can measure:

| | result |
|---|---|
| worker-side busy-poll (`SHIELDED_WORKER_SPIN_US`, `worker.conf`) | A/B/A on the live app: 109 / 116 / 121 us per exchange on/off/on -- a wash; shipped off |
| guest-side busy-poll + `cpuidle-haltpoll` | plumbed from `metal/config.json` (`shieldedWorker.tenantEnv`, filtered to `SHIELDED_*` at every hop; `guest.haltpoll`, module forced under KVM, parameters via a validated fw_cfg string, no cmdline change); needs the CVM to boot the new image; unmeasured until then |
| int24 replies (protocol 1.2, `FIELD_GEMM24`) | 25% fewer reply bytes per token, lossless; a wash on loopback (47.1 vs 48.0 us gate\|up; 476 vs 481 lm_head); text identical; awaits the guest |
| **shared-memory ring** (`SHM_ATTACH`, `SHIELDED_SHM`) | **viable under SEV-SNP**: a throwaway SNP guest mapping an `ivshmem` BAR did a gate\|up-sized handoff in **0.97 us** (write-back decrypted mapping) or 7.35 us (plain sysfs `resource2_wc`), against 152 on vsock; host-to-host against a GPU worker it removes the socket's share (tiny 15.5 -> 9.7 us; GPU-bound shapes unchanged). Prototype behind flags on both sides plus a launcher option, default off; the CVM image still needs the guest mapping and the manager's env. |

The ring is the deployed tier's next 2x; everything else on this list is a few percent.

### 13.14.1 v0.5.515 in the guest: int24 negotiated, fallback dormant, 112 us per exchange

The merged release (int24 replies, the shm-ring code inert, contention fallback armed,
the worker holding its 6.5 GiB budget) reached the app once ZeroSSL's ACME came back at
07:25 UTC 2026-08-27 (the hostname was dark for two hours: ZeroSSL's endpoint was
returning 502s/hanging and Let's Encrypt had the name at its weekly duplicate limit).
Measured from outside on the same three prompts: **104.8, 106.2 and 114.3 tok/s**
(v0.5.513: 87.9-103.2). The tenant's own counters, exchanges 8192 -> 12288 (83.6 tokens):

| term | v0.5.515 (ms/token) | v0.5.513 (ms/token) |
|---|---|---|
| **wire, 49 round trips** | **5.50 (112 us each)** | 7.47 (152 us each) |
| link total (mask + wire + unmask + rhs) | 6.23 | 7.99 |
| graph_compute (link + CPU half) | 6.54 | ~9.9 |
| pads missed / contention events | 0 / 0 | 0 / - |

The 40 us per exchange came from the reply side: `FIELD_GEMM24` was negotiated by the
guest (25% fewer reply bytes per exchange -- a wash on the host's loopback in 13.14,
not in the CVM, where every byte crosses vhost-vsock), plus the worker no longer
competing with a game for the card. The transport is still 84% of the link and the shm
ring remains the next 2x; the fallback never tripped (`contended=0 events=0`), so the
detector's absolute expectation is calibrated correctly for the idle card.
### 13.14.2 Reservation follows placement

The start-up hold in 13.14 fixed the game and broke the fleet's arithmetic. The worker
took its whole 6.5 GiB budget from the driver at start, and every free figure the box
publishes came from that same driver: with ONE tenant on an otherwise idle card the box
advertised **0.43 of 6.5 GB free**, because the hold hid itself from `cudaMemGetInfo`,
from nvidia-smi and from `/availability`, and the supervisor's own ledger (which knew the
card was 85% unsold) lost to the lower of the two. The operator's rule for the key is
the right one: `vramGb` is the part of the card dedicated to Enclave, the fleet sees a
card of that size, and it is 100% free until apps reserve shares.

So the reservation moved from the worker's start to the tenant's placement, protocol
1.3. The worker holds nothing for its budget at start-up (it only refuses to start on a
card smaller than the budget). A tenant reserves its share in the HELLO (`u32 major` +
`u64 reserve_bytes`; the old 4-byte HELLO reserves nothing and is what the guest's probe
and refresh send); the worker claims exactly that from the driver under its budget and
refuses the HELLO when the sum of reservations would exceed the budget or the card
cannot give it -- a refused HELLO is a dead link, and the backend already computes in
the enclave and reconnects with backoff, so the tenant runs until the memory is there.
At disconnect the reservation goes back to the driver, visibly. The guest side sends
the same number the supervisor sized the share from (`rec.shielded.vramGb`, exported to
the tenant as `SHIELDED_RESERVE_BYTES`), so what the fleet sold, what the engine may
allocate and what the worker holds are one figure. The HELLO reply carries
`vram_reserve` (this connection) and `vram_reserved` (all live tenants); the box
advertises `min(budget - vram_reserved, driver free)` and a new `vramReservedGb` beside
it -- the card as sold, capped by the card as the untrusted host can still give it,
which is the same cap that catches the game.

Deployed 2026-08-27 08:17 UTC by swapping the worker binary alone (the launcher
respawns it; the tenant reconnects on its backoff): the worker went from holding
6814 MiB to 154 MiB idle and 606 MiB once the 0.5B tenant re-registered; the
fleet's row went from `vramFreeGb 0.43` to `6.5` on the shielded block and
`gpuShareFree 0.538` on availability -- the one tenant's 46% share booked, the
rest free. The guest half (the reservation in HELLO, `vram_reserved_gb` in the
verdict) rides the next CVM restart.

The guest half went live at 08:44 UTC (v0.5.518-cpu). The first HELLO with a
reservation (2.3 GiB for the 0.5B tenant's share) was **refused** -- a game held
6.6 GB of the card at the time ("cannot reserve 2469606195: the card has
276103168 free") -- and the tenant ran in the enclave until the game closed;
its next request reconnected and the worker then held **2524 MiB** for the two
placed tenants, at 75-93 tok/s from outside. The same restart carried the
platform certificate service: both app names on the box were issued through
it (ZeroSSL under the platform account, keys minted in the CVM) at 08:58 UTC,
after ZeroSSL's own slowness cost a cool-off round.

## 14. The 27B on the host loopback: every lever, measured (2026-09-20)

Setup: Qwen3.8-27B UD-Q4_K_XL, the two V100s as workers over TCP loopback (one
link each; 10.5 and 11.1 GB of int8 field encoding on the cards), the production
engine drop (`enclave-llamacpp-linux-x64-gpu`, ddd4ec14) driven by `bench-spec`
with a warm-up so the link is open before anything is timed,
`ENCLAVE_GGML_EXTRA_BUFTS=0`, the q4 vl calibration (262 sites), EPYC 9115, 8
engine threads unless stated, 64 generated tokens per phase, one prompt. Plain =
greedy decode; spec = MTP self-drafting with k drafts per round and greedy accept,
the text asserted identical to plain. Decode was identical across all runs (one
text), so any difference between rows is cost, not content. The box carried
other work during two stretches (a game at ~4.6 cores, then another session's
calibration at 1-3.6 cores, then a fair-share test whose own worker took card 1
alongside mine); every run records the load it saw, the interleaved pairs were
re-run once the box was quiet, and two runs that lost a card link (a 30 GB
reservation refused while the other worker held part of card 1, and one CUDA
context loss on card 2 with a shared MPS server) are excluded rather than
averaged in.

### 14.1 What a token is made of

| term | per plain token | how measured |
|---|---|---|
| whole token | 133-137 ms (7.3-7.5 tok/s) | bench-spec, clean runs |
| exchanges | 125 (m = 1), 0.19-0.25 ms each on TCP loopback | profile |
| of which card time | ~20 ms | worker's own timer, ~0.13 ms per exchange |
| wire wait beyond the card | ~35 ms | profile `wire` minus card |
| mask, unmask + Freivalds, outlier term + descale, encode | ~20 ms | profile |
| everything else: the CPU backend and the scheduler | ~60 ms | remainder |
| CPU actually busy | ~1.3 cores | per-thread sampling |

The "everything else" is not compute. `GGML_SCHED_DEBUG` shows the decode graph is
**534 splits with 1550 CPU-side ops per token** (321 MUL, 209 RMS_NORM, 194
GET_ROWS, 176 ADD, 170 small MUL_MATs, 96 SILU, 64 SIGMOID, 64 SWIGLU, 48 each of
CONCAT, SSM_CONV, SOFTPLUS and GATED_DELTA_NET), each dispatched to an 8-thread
OpenMP team; the process runs at 1.3 cores while doing it. The token is a chain of
waits, on the wire and on barriers, which is why the levers that move it are the
ones that remove waits or rows, and why more threads make it slower.

For scale, the same engine with no card: 3.36 tok/s on 8 threads, 4.91 on 16
(prefill 9.6 tok/s on 8). Shielded is 2.2x the enclave's own CPU at 8 threads. The
unmasked CUDA baseline could not be run here (the drop's `libggml-cuda.so` needs a
cuBLAS the box does not have); the research archive's direct 27B Q8 on one V100 is
27.6 tok/s.

### 14.2 The levers, one at a time

Plain / speculative tok/s, k = 1 unless stated, clean runs (queue 2 and the
re-runs after the game stopped). Baseline = `SHIELDED_MAX_M=64` with the pool
capped at 32.

| lever | plain | spec | verdict |
|---|---|---|---|
| baseline | 7.31-7.53 | 7.90-8.42 | |
| pool depth 256 (what `MAX_M=64` derived before the cap) | 5.67 | 7.37 | **-22%: the refill never idles. Fixed (cap).** |
| draft k = 1 / 2 / 3 / 4 / 5 / 7 | - | 8.4 / 7.7 / 7.2 / 5.6 / 5.4 / 4.6 | **k = 1 is +12%**; every extra verify row costs ~60-75 ms |
| 16 threads | 5.51-5.79 | 6.33-6.81 | worse: 16 + 8 refill on 16 cores |
| 4 threads | 6.94 | 7.51 | worse on an unconstrained box |
| 2 threads | 6.07 | 6.32 | worse |
| refill threads 2 / 4 / 8 / 16 | 5.55 / 7.57 / 7.31 / 7.21 | 5.52 / 8.28 / 8.42 / 8.20 | 2 starves (on-path refill); 4 is enough |
| `SHIELDED_OVERLAP_VERIFY=1` | 7.03-7.36 | 7.76-7.94 | neutral |
| `SHIELDED_SPIN_US` 300 / 2000 | 7.31 / 6.95-7.33 | 8.28 / 8.22-8.37 | +0-6% on spec, not repeatable |
| `GOMP_SPINCOUNT` 0 / 1000000 | 6.64 / 7.07-7.40 | 7.98 / 8.12-8.45 | 0 costs 9%; 1M neutral to +7% |
| `SHIELDED_FUSE_LOCAL=1` | 4.12-6.59 | 7.07-7.17 | neutral to worse |
| row pool (per-row work on 4 threads, scratch build) | 6.5-6.8 | 7.1-7.5, verify/round unchanged | no gain: the per-row cost is not in those loops |
| 8 cores, 8 compute + 8 refill threads | 1.97-2.14 | 2.05 | oversubscribed: the spinning threads starve the chain |
| 8 cores, 4 + 4 | 5.74-6.70 | 6.49-7.49 | **3.4x over 8 + 8** |

Three things in that table matter for production. The pool-depth rule was a bug:
`nnShieldedMaxM: 64` (needed for prefill on the card) made the derived pool 256
pads per group, ~10 GB of pads on the 27B, and the refill threads streamed the
weights continuously against the decode. Drafting pays at k = 1 only, because a
verify row costs a fixed ~60-75 ms of CPU-side work and acceptance drops with
depth. And the CVM's thread count: the engine defaults to every vCPU and the
refill takes half of them on top, which is the 8 + 8 row; the manager now defaults
a shielded tenant's decode threads to what the refill leaves.

### 14.3 Prefill on the card is refill-bound, and a wide refill batch fixes it

492-token prompt, prefill timed with the link open and the graphs captured:

| prefill (8 threads) | 492 tokens | decode after it, plain / spec k=1 |
|---|---|---|
| in the enclave (`MAX_M=8`) | 51.5 s (9.6 tok/s) | 7.4 / - |
| on the card, refill batch 4 (the default) | 114.3 s | 7.2 / 8.3 |
| on the card, refill batch 16, pool 64 | 40.5 s | 8.6 / 8.8 |
| on the card, refill batch 64, pool 64, old refill rule | 23.5-25.2 s (20 tok/s) | **4.0-4.1** / 6.5-6.6 |
| on the card, refill batch 64, pool 64, refill-unit rule | 27.1-30.9 s | **8.1** / 9.4 |

The 16-thread prefill variants ran under another session's load and are not
reported. Decode with the 64-row batch and the refill-unit rule is also faster
than the default on a short prompt, 8.55 / 10.04 against 7.3-7.5 / 8.4-8.6,
because the refill now streams the weights once per 8 pads instead of once
per 4 (old rule with the same batch: 3.96 / 5.38).

Why it was slower than the CPU: every prefill ROW takes its own one-time pad per
group, and the refill mints 4 pads per pass over the weights, so 492 rows are
~120 weight passes per card (266 s of on-path refill in the profile, 174k pads
missed). The CPU prefill streams the weights once per 64 rows. The refill kernel
already takes up to 64 rows per pass (`refill_rows_blocked`), so
`SHIELDED_REFILL_BATCH=64` cuts the pad cost 16x and on-card prefill becomes 2.2x
faster than CPU prefill. But the same batch size wrecked decode afterwards: the
pool logic called a group "low" whenever fewer than a batch was ready, so with a
64-batch every group was always low and each token's single missing pad was
minted alone, one weight pass per pad, on all the refill threads at once. The
first fix tried here (top up only when a whole batch is missing) starved prefill
instead: each 64-row chunk found the pool short and minted the shortfall on the
request thread, 81 s against 25 s. The rule that keeps both is a refill UNIT of
min(batch, 8): a group with fewer than 8 pads coming is refilled at once, one
missing at least 8 is topped up with whatever is missing, and B <= 8 is exactly
the old behaviour. That is the second code change.

### 14.4 The rows question

The per-row cost that caps drafting (~60-75 ms per extra verify row) is neither the
shielded backend's per-row loops (the row pool parallelised mask, unmask +
Freivalds, outlier term and descale over 4 threads and the verify round did not
move) nor the card (the worker's card time per exchange barely changes with m). The
CPU-only engine shows the same ~65 ms per extra row, where it is the
compute-bound q4_K matmul; on the shielded path the matmuls are on the card, so
what remains per row is the CPU backend's own per-token ops (the recurrent
gated-delta-net update is sequential per token) and the per-split dispatch. That
is an engine-side cost, upstream of this backend.

### 14.5 Applied, recommended, and not applied

Two runs were lost to the environment and are excluded: one verification failure
on card 0 and one CUDA context loss on card 1 ("unspecified launch failure") while
another session's worker shared card 1 through the same MPS server; neither
recurred in the 20 runs after that worker's reservation was accommodated, and
decode was byte-identical across every completed run.

Applied in this repo (measured here, tests green):

1. `shielded-tee.c`: the derived pool depth is capped at 32 (never below the
   widest exchange); `SHIELDED_POOL_DEPTH` still overrides. +29% decode with
   `MAX_M=64`, and 10 GB less pad RAM on the 27B.
2. `shielded-tee.c`: the refill unit is min(batch, 8) pads. A group is low
   below that and topped up above it, so a 64-row refill batch serves prefill
   (27-31 s against 51.5 s on the CPU) without turning decode into single-pad
   weight passes (8.1 tok/s after the prefill against 4.0). Batches of 8 or
   less behave exactly as before. Three k = 3 and two k = 1 runs on the final
   build: 7.3-7.5 plain, 7.9-8.0 spec, text identical, no verification failure.
3. `wasm_manager.py`: a shielded tenant with no `nnThreads` gets decode threads =
   vCPUs minus refill threads (at least 2), prefill threads = all vCPUs.

Recommended deployment config for the 27B (all existing keys):
`draft_tokens: 2` with `nnRsSeq: 2` (k = 1 drafting, +12%); `nnShieldedRefillThreads: 4`;
`nnShieldedMaxM: 64`, `nnShieldedRefillBatch: 64`, `nnShieldedPoolDepth: 64` and the
app's `prefill_chunk: 64`, which together give prefill on the card at 2x the CPU and
decode at 8.5 / 10.0 tok/s on the loopback, once the refill-unit build is deployed
(with today's build the same keys halve decode); `nnOmpSpinCount` left at its default. `SHIELDED_SPIN_US=2000` through
`tenantEnv` is worth one A/B in the CVM, where the wire is 0.45 ms per exchange
against 0.2 here; it was not repeatable on the loopback.

Not applied, with the measurement that closed each:

- Freivalds overlap on the ring path: the socket-path knob is neutral here (the
  RHS is ~2 ms per token); the ring gate stays as it is.
- int32 instead of int64 through unmask, outlier term and descale: those terms
  are ~6 ms per token in total; the ceiling is ~3%.
- Column-parallel weights across the two cards: card time is ~20 ms of 137; the
  ceiling is ~10% for a placement and verification redesign.
- Local residual/norm islands (`SHIELDED_FUSE_LOCAL`): neutral to worse.
- The row pool: no gain, discarded.
- LPN-structured pads (`shielded/lpn/REPORT.md`): refill is off the critical path
  and 4 threads suffice; pad generation is not what this tier is waiting on.
- Dealt pads: not deployable from here (the relay routes are Steven's manual
  step). The prefill result is their strongest argument: minted pads make
  on-card prefill cost a weight pass per 64 rows even with the wide batch, and
  dealt pads would make it cost nothing.

### 14.6 The wall was the repack, and the target is met (2026-09-21)

Every number in 14.1-14.5 was taken through an engine drop that predates the
`ENCLAVE_GGML_EXTRA_BUFTS` read (the fix shipped in v0.5.779; the local drop in
`q4-calib-work/enclave-llamacpp-linux-x64-gpu` has no reference to the symbol,
`q4-calib-work/ell-new/...` has). Under that drop the q4_K and iq4_nl tensors of the
UD mix are repacked at load, refused at the claim gate, and computed in the
enclave: the per-op profile of the CPU backend (an instrumented `ggml-cpu` built
from the engine's own commit, `ENCLAVE_OP_PROFILE=1`) put **170 MUL_MATs per
token on the CPU at 286 us each, 49 ms of the 137 ms token**, and the scheduler
dump showed them scattered by layer exactly where the file's q4_K tensors are (24
of 48 `attn_qkv`, 15 `ffn_gate`, 7 `ffn_up`, 7 `ffn_down`, 6 `attn_q`).

On the drop that honours the switch, 401 weights register on the cards (from
~320), zero repack lines, and:

| configuration (fixed drop, refill batch 64, pool 64, MAX_M 64) | plain tok/s | spec tok/s |
|---|---|---|
| refill unit 8, k = 1 | 10.15-10.18 (98 ms) | **12.7-13.4** |
| refill unit 8, k = 2 | 10.35 | 11.5 |
| refill unit 8, k = 3 | 10.1-10.2 | 11.1-11.3 |
| refill unit 16, k = 3 | 10.32 | 12.2 |
| refill unit 8, k = 4 | 9.7 | 9.2 |

The remaining CPU-backend time is ~32 ms per token of recurrent-state traffic
(GET_ROWS 11 ms at 57 us per 3 MB state row, CPY 6, GATED_DELTA_NET 6, CONCAT 4),
all bandwidth-bound; the wire is ~55 ms (125 exchanges, ~0.17 ms of card each);
the backend's own mask/unmask/verify ~15 ms. A verify row now costs ~28 ms, which
is why k = 1 wins.

Two more refill results on the old drop, kept because they transfer: the refill
unit (min(batch, unit) pads per top-up) at 16 beats 8 by 8% on both plain and
spec (9.2 / 11.0 against 8.4 / 10.0 at k = 3) and 32 gains nothing more while
pads start to miss; 16 is now the engine default (`SHIELDED_REFILL_UNIT`
overrides; batches of 4 are untouched). The shared-memory ring transport, run on
the loopback through a scratch build that accepts a `/dev/shm` path, equals TCP
here (8.5-8.8 against 8.55 plain): the loopback socket was never the cost, and
production already uses the ring. Rewind depth 0-4 costs nothing at m = 1.

The same configuration with the repo build (refill unit 16 default), three
baselines and the last knobs, all on the fixed drop:

| run | plain tok/s | spec k = 1 |
|---|---|---|
| baseline x3 | 10.41-10.68 (94-96 ms) | 12.2-12.8 |
| `SHIELDED_SPIN_US=2000` (engine) | 10.47 | 13.0 |
| `SHIELDED_WORKER_SPIN_US=2000` (worker) x2 | 10.1-10.7 | 12.0-12.1 |
| refill threads 4 | 8.79 | 10.1 |
| 492-token prompt, prefill on the cards | 26.9 s prefill, then 10.5 | 12.0 |

Neither spin knob moves it; four refill threads cannot keep a 64-row batch
fed and lose 17%; prefill of 492 tokens on the cards takes 26.9 s with every
site there (51.5 s in the enclave) and decode is intact after it. Decode
threads 4 / 6 / 8 / 12 on the fixed drop are within noise of each other on the
runs the box was quiet for (10.0-10.9 plain, 12.5-12.9 spec; the ones that
coincided with another session's job sit 10-25% lower), so 8 stays.

Where the token goes now, from the worker's own phase profile (a `-DSH_XPROF`
build, ring transport, 8834 exchanges on card 1): stream sync 146 us per
exchange, graph launch 18, host packing 6, cache lookup 2.4, staging and lock
under 1 -- 173 us against the 196-201 us the engine measures as wire on the
ring, so the wire IS the device time and the V100s are near their HBM floor
(~18 ms of a ~94 ms token). TCP adds ~0.15 ms per exchange on the busier card.
The CPU backend's ~32 ms is recurrent-state traffic (bandwidth-bound) and 267
OpenMP regions of tiny ops; the shielded backend's own mask, unmask, verify and
descale ~15 ms; scheduler and dispatch the rest.

Two more levers were built and measured against this state and lost. Computing
the 414 tiny elementwise and norm ops per token inside the shielded backend on
the request thread (a private single-thread CPU backend, one-node graphs, so
178 of the 267 CPU splits and their OpenMP regions disappear) gives identical
text and 8.67 against 10.44 tok/s: each op costs ~8.7 us through a one-node
graph, more than the region it replaces. Discarded. And the shared-memory ring
against TCP on the loopback: 8.5-8.8 against 8.55 plain earlier, 9.06 against
8.65 on the fixed drop under load; the worker's phases show the ring saving
~0.15 ms per exchange only on the busier card. Production already has it.

What is left is inside the engine, not this backend: the ~27 ms per token of
recurrent-state traffic (a 3 MB state row per delta-net layer loaded, copied
and stored through GET_ROWS / CPY / GATED_DELTA_NET, bandwidth-bound at ~100
GB/s), and the OpenMP region per CPU split. Both are llama.cpp graph-structure
questions (in-place state updates, or a single-thread path for graphs whose
every node has n_tasks = 1) for the toolchain cut, and are the next 20-30%.

What this says for production: the 27B at 4 tok/s in the CVM had the repack
(fixed since v0.5.779, never re-measured), the 16 + 8 thread oversubscription
(14.5), a 4-pad refill batch and no drafting. With the three engine changes in
this section and 14.5, the fixed drop, `nnShieldedRefillBatch: 64`,
`nnShieldedPoolDepth: 64`, `nnShieldedMaxM: 64` and `draft_tokens: 2` /
`nnRsSeq: 2`, the same model decodes at 10.2 plain and 12.7-13.4 tok/s with
drafting on this box's loopback. The CVM's vhost-vsock exchange (152 us against
46 here) is the term that will not transfer one to one.

## 15. Toward 20 tok/s on the 27B (2026-09-21)

Section 14 left the token at 87 ms with the wire, the CPU half and the
shielded backend's own arithmetic in roughly a 37 / 33 / 13 ms split. This
section attacks all three. Same rig and harness as section 14, with the ring
transport (`/dev/shm` ring files on the host, the transport the CVM uses) and
the engine drop that honours `ENCLAVE_GGML_EXTRA_BUFTS`.

### 15.1 One thread was copying the recurrent state

An instrumented `ggml-cpu` built from the engine's own commit
(`ENCLAVE_OP_PROFILE=1`, per-op totals and the worst instance's shape) put
**11.3 ms of every 87 ms token in `GET_ROWS`** across 197 calls, and named the
shape: `[786432, 1, 1, 1]`, 3 MB, gathered as ONE row. ggml partitions
`get_rows` over the gathered rows, so a gather of one row runs on thread zero
while the other seven wait at the barrier. That is the hybrid model's
recurrent state, read several times per delta-net layer.

Splitting a long row across threads when there are fewer rows than threads
(`ops.cpp`, `ggml_compute_forward_get_rows_f32`, 20 lines) takes the same copy
from 57.2 us to 23.2 us and the whole CPU-side graph from 2184 ms to 1516 ms
over the run:

| build | plain tok/s | spec k=1 | GET_ROWS in the profile |
|---|---|---|---|
| stock kernel | 11.27-11.55 (87-89 ms) | 12.53 | 765 ms, 57.2 us mean |
| long rows split across threads | 12.26-12.53 (80-82 ms) | **14.20** | 310 ms, 23.2 us mean |

`CONCAT` has the same shape of bug (distributed over `ne2`, which is 1 at
decode, and copied element by element): 273 ms over the run, worst instance
`conv_input [20, 10240]`. Both are ordinary llama.cpp patches, in the same
family as the repo's existing `llamacpp-parallel-copy.patch`.

### 15.2 Both cards on every exchange: built, and it does not pay

A token walks the layers in order, so a layer-sharded placement uses ONE card
at a time: the other V100 is idle for half the token. The repo's own kernel
experiment (`docs/research-archive-2026-09/shielded-27b/v100-two-card-confirmation.md`)
measured 35-49% off each exchange at one row by splitting every output into
32-column-aligned halves across both cards, and nobody had built it.

It is built now (a scratch backend, `SHIELDED_SPLIT_COLS=1`): every card
registers a contiguous slice of every weight's output columns, each draws its
OWN pad for the same activation, checks its own slice with its own Freivalds
vectors, and writes its own columns straight into the full-width product row
through a new strided entry point (`sh_link_gemm_stride`). The cards run
concurrently, one worker thread per non-primary card, and each does its own
unmask, verification and descale, so the backend's per-row work parallelises
for free. Text is identical to the unsplit run and no product fails
verification.

Decode only, 64 tokens, same build and same CPU module:

| | plain tok/s | ms/token | exchanges/token | wire per exchange |
|---|---|---|---|---|
| layer-sharded (one card per exchange) | 12.65 | 79.1 | 241 | 149 us |
| column split (both cards per exchange) | 12.04 | 83.1 | 241 per card | 131 us |

The mechanism works -- the wall wire time per token falls from 36 ms to about
32 ms, and the engine-side terms (mask, unmask, Freivalds, descale) overlap
instead of summing. What does not hold is the premise: **halving a node's
columns takes only 12% off its exchange, not 50%.** At one row the card is not
purely bandwidth-bound; a 2560-column GEMV does not fill a V100 any better
than a 5120-column one, so the saving is far smaller than the archive's
full-pass benchmark suggested. What is left over -- a second dispatch and join
per exchange, and waiting for the slower of two unequal cards -- costs more
than the 4 ms it saves.

Kept as a measured negative with the code in the session's scratch tree. It
would pay if the card ever became bandwidth-bound at one row, which is exactly
what a 4-bit weight lane would do (section 15.3).

### 15.3 Where the token stands, and what 20 tok/s would take

Decode only, 64 tokens, the configuration of 15.1 (both kernel fixes, ring
transport, refill batch 64, pool 64, unit 16, `MAX_M` 64, 8 threads):

| term | ms/token | what it is |
|---|---|---|
| wire | 36.0 | 241 exchanges at 149 us; about 24 ms of weight streaming, 12 ms of fixed per-exchange cost |
| CPU graph | 22.0 | the enclave's half: 6.4 gated-delta-net, 5.2 state gather, 2.6 copies, 1.2 concat, the rest spread over ~1500 small nodes |
| link, beyond the wire | 6.3 | mask, unmask, Freivalds, pad take, framing |
| post + encode | 3.1 | outlier term, per-column descale, activation encode |
| scheduler and the rest | ~7 | remainder |

The weight streaming is the floor and it is set by ONE number: the cards hold
the int8 field encoding, 1 byte per weight, so a 27B q4 file becomes 21.6 GB
on the cards and every token reads all of it. Two V100s at 900 GB/s read that
in 24 ms when they alternate by layer, 12 ms if they ever read concurrently at
full efficiency -- which 15.2 shows they do not at one row.

So the two things that would move this materially are both below the backend:

1. **A 4-bit weight lane on the card.** 0.5625 bytes per weight against the
   present 1.0625 takes the streaming from 24 ms to 13 ms. The model file is
   already q4_K, so almost nothing is lost relative to the source. The kernel
   research exists (section 2, "The 4-bit weight path", verified exact in the
   Triton prototype) but nothing is implemented in the production worker, the
   field encoder or the AVX-512 refill; it is a wire-format change with a
   security-critical arithmetic path, not a tuning knob.
2. **Kernel occupancy at narrow N**, which is what 15.2 ran into: with a 4-bit
   lane the card becomes bandwidth-bound at one row, and the column split
   (already built and correct) would then deliver the halving it promises.

Together those are worth roughly 24 ms -> 12 ms of streaming and would put the
token near 60 ms, i.e. about 17 tok/s plain and 19-20 with drafting. Nothing
else measured in sections 14 and 15 is worth more than a few percent.

### 15.4 Settled

Six consecutive runs of the final configuration -- repo backend (refill unit
16), both kernel fixes, ring transport, `nnShieldedRefillBatch` 64,
`nnShieldedPoolDepth` 64, `nnShieldedMaxM` 64, 8 decode threads, 64 generated
tokens, text identical every time:

| drafting | plain tok/s | speculative tok/s | tokens/round |
|---|---|---|---|
| k = 1 | 12.85 (78 ms) | **14.05** (13.88-14.13) | 1.83 |
| k = 2 | 12.81 | 12.96 (12.95-13.14) | 2.29 |

The last two knobs, measured after that table: `nnShieldedMaxM` must stay at
64 -- at 8 the speculative verify exceeds the row limit, falls back to the CPU
backend's f32 path, and collapses to 3.1 tok/s with text that no longer
matches -- and a refill unit of 32 is neutral against 16.

Against where this started: 4 tok/s in production, 7.3 plain / 8.4 speculative
at the top of section 15 on this box. The 20 tok/s target is not reached and
is not reachable here without the 4-bit weight lane of 15.3; everything above
that line has been measured and either shipped or recorded as a negative.

### 15.5 The 4-bit lane does not survive contact with the model

15.3 named a narrower weight lane as the only remaining term worth more than
a few percent, on the strength of section 2's kernel research ("the 4-bit
weight path", q4_0 at 0.5625 B/weight, "masked round-trip verified exact").
Before writing a CUDA kernel, an encoder and an AVX-512 refill for it,
`shielded/lane/lane_error.py` prices what the model loses. Real tensors of the
deployed 27B, dequantized exactly as the tier's encoder sees them, relative
error of `W.x` against the f32 product of the same weights:

| lane | bytes/weight | relative error |
|---|---|---|
| int8, one exponent per output column (today) | 1.0625 | 1.3-1.4% |
| int6, integer scale per 32-block | 0.8125 | 1.8-2.3% |
| int5, integer scale per 32-block | 0.6875 | 4.4-4.8% |
| int4, integer scale per 32-block | 0.5625 | **9.8-10.3%** |
| int6, power-of-two scale per 32-block | 0.7812 | 3.1-3.6% |
| int4, power-of-two scale per 32-block | 0.5312 | 14.5-15.3% |

Two things this settles. The block scale does NOT have to be a power of two
for the field arithmetic to stay exact -- an integer multiplier per block
keeps the whole product integral (`y = sum_b m_b * block_dot_b`, descaled once
per column) and is worth a bit and a half at every width, so any future lane
should use one. And even then **a 4-bit lane costs seven times the present
encoding error**, which is not a tuning decision; it is a different model.
"Round-trip verified exact" in section 2 was a statement about the masking
algebra, which is exact for any encoding however coarse; it was never a
measurement of the encoding's error, and this is.

The usable end of that table is int6 with an integer block scale: 24% fewer
bytes for 1.6x the error, which would take the streaming term from 24 ms to
18 ms and the token from 78 ms to about 72 -- roughly 15 tok/s with drafting.
Worth having, not worth calling 20.

### 15.6 What 20 tok/s on this model actually needs

Adding up everything measured in 14 and 15: the enclave's own CPU half is
22 ms and the fixed per-exchange cost about 12 ms, neither of which any lane
or placement change touches. That is a 34 ms floor before a single weight
byte moves, i.e. **29 tok/s is the ceiling on this box even with infinitely
fast cards**, and the streaming term is what stands between 14 and that.

Two V100s read 21.6 GB of int8 field weights in 24 ms, alternating by layer.
Reaching 20 tok/s (50 ms) needs that term under 16 ms, which means either
cards with roughly three times the aggregate bandwidth (H100-class), or four
or more V100s with a column split that scales -- and 15.2 shows the split
only scales once the card is bandwidth-bound at one row, which is exactly
what more bandwidth per column would make it. **It is a hardware question,
not a software one.** On this pair of V100s, 14 tok/s with drafting is the
honest number, and the 27B's decode is now within about 10% of what this
hardware can do.

## 16. 20 tok/s on the 27B: what 15.6 got wrong (2026-09-21)

Section 15.6 closed with "it is a hardware question, not a software one" and
put the honest number at 14 tok/s with drafting. That conclusion was wrong,
and it was wrong for a reason worth writing down: **both of its two load-
bearing measurements were measuring a bug, not the machine.**

### 16.1 The column split was never slow; the worker's graph cache was

15.2 built "both cards on every exchange" and measured it as a regression, so
the split was recorded as not paying. Re-running `kbench` on the 27B's own
shapes said that could not be right: at one row the field kernel scales almost
perfectly in both dimensions (gate|up 208.5 -> 107.5 us at half the columns,
-> 107.6 us at half the depth; lm_head 1460 -> 733 us), at 820-880 GB/s on a
card whose HBM2 peak is 900. The card IS bandwidth-bound at m=1, so halving
the columns per card has to halve the streaming term.

The gap was the worker's CUDA graph cache. It is keyed by `(m, ordered node
list)` and its overflow policy is **clear-at-capacity, not evict-one**, so a
recurring pass that does not fit never reuses anything at all. The 27B needs
274 distinct keys for one split decode pass and 514 for a speculative round
(the same pass at m=1 and again at m=2); the default was 256. The worker's own
end-of-connection line, split run, old default:

    graph cache: limit=256 high_water=256 hits=24 misses=17733 capacity_flushes=68

and the same run at 2048:

    graph cache: limit=2048 high_water=514 hits=16963 misses=770 capacity_flushes=0

Re-capturing a graph on essentially every exchange cost roughly 70-100 us per
exchange, which is the whole of what the split was supposed to save. Note the
speculative figure is over 256 even in the ordinary alternating placement
(~257 per card), so the old default was marginal for this model anyway. The
default is now **1024** (`shielded/worker-cuda/captured-graphs.h`), documented
in `GRAPH-CACHE.md`.

With the cache large enough, the column split pays exactly what the kernel
said it would:

| placement | plain decode |
|---|---|
| one card per layer (cards alternate, each idle half the time) | 13.40 / 13.12 tok/s |
| columns split over both cards, every exchange on both | 15.20 / 14.94 tok/s |

### 16.2 Threads are not the lever: the enclave's CPU half is bandwidth-bound

Before touching the CPU work, the obvious knob, measured on the split build
(32 cores on the box, 8 refill threads alongside):

| decode threads | 6 | 8 | 12 | 16 | 24 |
|---|---|---|---|---|---|
| plain tok/s | -- | **15.20** | 14.62 | 11.56 | 6.43 |

More threads make it dramatically worse. That is the signature of a memory-
bound kernel with a per-node barrier, and it is what pointed at the copies.

### 16.3 The recurrent state was being copied four times per layer per token

`ENCLAVE_OP_PROFILE=1` on the 27B, per decode token: `GET_ROWS` 4.5 ms, `CPY`
5.5 ms, `GATED_DELTA_NET` 5.8 ms. The first two are the same 3 MiB tensor. A
delta-net layer moves its state like this:

1. `build_rs` emits `ggml_get_rows(state, s_copy)` to pick the live cell -- a
   permutation of ONE element, i.e. a 3 MiB copy that permutes nothing;
2. the op stages each head's 64 KiB block into its own scratch;
3. the op writes the new state into its packed output tensor;
4. the graph copies that back into the recurrent cache.

Three of those four are avoidable. When the gather is provably the identity --
one sequence, a one-cell cache, head 0, and no rollback plane pending --
`build_rs` now returns a **view** of the cache, and a new op
`ggml_gated_delta_net_inplace` runs the recurrence **where the state already
lives**, leaving snapshot slot 0 correct by construction and writing the older
slots at the cache's own stride. Its result carries the attention scores
alone, so step 4 disappears with it. Both are patch
`wasm/llamacpp-rs-inplace.patch`, both have kill switches
(`ENCLAVE_GGML_RS_ALIAS=0`, `ENCLAVE_GGML_GDN_INPLACE=0`).

### 16.4 The alias SHAPES the graph, which is a correctness trap

A graph built while the gather was the identity reads snapshot plane 0
directly. It must therefore never be replayed for a ubatch whose gather would
have picked a rollback plane -- `s_copy()` returns `idx * size + src0`, and
after a rejected speculative token `idx` is 1. So the decision is stored on
the input (`rs_identity`) and re-checked in `can_reuse`.

That is where this nearly shipped wrong. `llm_graph_input_rs::can_reuse` is
NOT the reuse path this model takes: the hybrid inputs duplicate the same four
rs checks inline in three other classes, and adding the check to only the
first one left the graph being replayed across a rewind. The symptom was mild
and easy to wave away -- the run still produced fluent text, acceptance drifted
0.83 -> 0.73, and only `text_identical` caught it. `ENCLAVE_RS_DEBUG=1` now
audits at runtime that every graph built with the alias really did face an
identity gather, and it is what found this:

    [rs] alias=1 n_rs=1 head=0 rs_z=-1 s_copy=[ 1] (alias 44 / copy 0 / VIOLATIONS 11)

The check is in all four reuse paths now. **A plain-decode A/B cannot catch
this class of bug**, because plain decode never rewinds; the 48 greedy token
ids were byte-identical with and without the change while the speculative path
was quietly diverging.

### 16.5 Measured, on the same box 15.6 called finished

All figures are the 27B on two V100s over the host loopback, 64 tokens,
8 decode threads, `WARM=1`, A/B within one build via the kill switches.

| build | plain decode | speculative (k=1) |
|---|---|---|
| 15.4's settled state (cards alternate by layer) | 12.85 | 14.05 |
| + graph cache large enough, still alternating | 13.40 / 13.12 | 15.47 / 14.62 |
| + column split over both cards | 15.20 / 14.94 | 15.35 / 15.50 |
| + recurrent state aliased and updated in place | **17.11 / 16.39** | **17.67 / 16.30** |

Correctness, not just speed: with the alias on and off, the 48 greedy token
ids of a plain decode are **identical**, and `text_identical` (speculative
output against the plain reference) holds at 64 tokens.

### 16.6 Where the token goes now: a per-PASS term and a per-TOKEN term

A speculative verify pass puts two tokens through one weight stream, which
splits the token into its two halves for free. With `W` the per-PASS cost
(everything paid once however many tokens are in flight -- the weight stream,
the exchange launches, the state copies) and `C` the per-TOKEN cost:

| build | plain = W + C | verify = W + 2C | W | C |
|---|---|---|---|---|
| before the state change | 64.8 ms | 99.8 ms | 29.8 ms | 35.0 ms |
| after | 58.4 ms | 93.4 ms | **23.4 ms** | **35.0 ms** |

This is worth reading carefully, because it says something the tok/s numbers
do not. The state work is per-PASS, so aliasing it away came out of `W`, not
`C` -- 6.4 ms, which is the whole of the improvement. And `C` did not move at
all: **35 ms of every token is per-token CPU work inside the enclave**, and it
is now the larger half by a wide margin.

`W` is close to what the cards should cost: 21.6 GB of int8 field weights over
two V100s at ~850 GB/s is 12.7 ms of streaming, plus ~241 exchanges at ~44 us
of launch and sync. So the GPU half is nearly spent, and **15.6's conclusion
is inverted twice over** -- the column split DID scale once the graph cache
stopped thrashing, and what stands between this box and 20 tok/s is now CPU
work in the enclave, not card bandwidth. More cards, a 6-bit lane, or an H100
each buy a share of 23.4 ms and none of 35 ms.

It also explains why speculation has stopped paying. A drafted token costs a
full `C` whether it is accepted or not, and accepting one saves only `W`. At
acceptance 0.83 the round is `W + 1.83C + draft` for 1.83 tokens, i.e. 50.9 ms
per token against plain's 58.4 -- a 13% gain, and measured 17.67 against 17.11.
k=2 makes it worse, exactly as that arithmetic predicts (2.29 tokens per round
but a 148 ms round: **14.83 tok/s**). Speculation on this engine is capped by
`C`, not by the draft head's accuracy.

### 16.7 The unmasked baseline: what the shielding costs

Asked for, and the right control. Same model file, same box, same prompt,
stock llama.cpp built for sm_70 (`~/gvs5h`, commit eafe15a), `llama-bench
-n 64`:

| configuration | tok/s |
|---|---|
| stock llama.cpp, one V100, all layers on the card, **no masking** | **30.36** |
| stock llama.cpp, both V100s, no masking (llama.cpp's layer split) | 30.20 |
| shielded: masked, Freivalds-verified, both V100s, column split | **17.67** |
| no card at all, 8 CPU threads | 3.83 |

**Shielding costs 1.72x** against the same hardware running the same weights
in the clear, and it buys weight and activation confidentiality against the
host plus integrity of every product. 20 tok/s is 66% of the unmasked number.

Two things in that table are worth keeping. The second row is the same finding
as 16.1 arriving from the other direction: llama.cpp's own two-GPU placement
splits by LAYER, layers are sequential, so the second card is idle half the
time and buys nothing (30.20 against 30.36 -- a rounding error, and if
anything slightly worse). That is exactly the idleness the column split
removes, and it is why the shielded engine gets a real gain from a second card
where stock llama.cpp gets none.

The other is that the comparison is not like-for-like on bytes: the plain
model is q4_K at 16.34 GiB, while the shielded lane stores int8 and streams
about 21.6 GB. A third of the streaming term is the wider lane, before a
single masking operation is counted -- which is what 15.5 priced and rejected
at 4 bits, and what an int6 lane with an integer block scale would partly
recover.

### 16.8 What did NOT move it, with numbers

Every one of these was tried against the same build on the same afternoon, so
they are comparable to each other and to the 17.1-18.0 tok/s the build was
sitting at. None is worth keeping, and several are worth remembering.

| lever | result (plain / spec k=1, tok/s) |
|---|---|
| decode threads 6 / **8** / 10 / 12 / 16 / 24 | 17.07 / **17.11** / 16.19 / 14.62 / 11.56 / 6.43 |
| speculation depth k = **1** / 2 / 3 | **17.67** / 14.83 / 15.41 |
| `GOMP_SPINCOUNT=infinite` + `OMP_WAIT_POLICY=ACTIVE` | 16.41 / 17.37 against 16.83 / 18.00 |
| `GOMP_SPINCOUNT=1000` (park the decode threads early) | 15.26 / 15.11 against 16.37 / 16.74 |
| `OMP_PROC_BIND=close` + `OMP_PLACES=cores` | **2.19 / 2.12** |
| `SHIELDED_REFILL_THREADS=2` (give refill's cores to decode) | **5.26 / 5.37** |
| delta-net inner loop fused, 4 sweeps -> 1 | 17.22 / 17.70 against 16.98 / 17.78 |
| mask+encode split over 4 helper threads | **abandoned at 16 min, 226% CPU** |
| workers off the MPS daemon (no server, no 50% SM cap) | 16.56 / 17.43 against 16.37 / 16.74 |
| Freivalds RHS moved into the ring's spin window | **verification fails** |

Five of these say something.

**The box is exactly saturated.** 16 physical cores, 8 decode threads and 8
pad-refill threads. Pinning threads to cores collapses it by 8x, and taking
six cores off refill collapses it by 3x -- that run logged
`refill-on-path=24467 ms` and `missed=12451`, i.e. the pad pool ran dry and
every miss was generated on the request path. The refill threads are not
spare capacity; they are what keeps the pads ahead of the decode.

**The OpenMP wait policy is already at its optimum, from both sides.** Making
the decode threads spin harder is worse, and making them park sooner is worse
still -- a graph of ~3365 nodes at batch 1 pays the wake-up on every node.

**The delta-net kernel was not call-bound.** Each of the four sweeps over the
S_v x S_v state touches only row j, so they fuse into one pass, and the fused
form is bit-identical (48 greedy tokens, same ids) -- and 1% faster. The state
block is 64 KiB per head and already L2-resident, so the sweeps were never
paying for memory, and `ggml_vec_*` on 128 floats is not paying for the call.

**The elementwise field passes will not parallelise on this box.** Masking the
activation into three byte planes and encoding it to field integers are pure
maps over a range, on the one thread a decode round is serialized on, so they
look like free parallelism. They are not: only the big tensors clear a useful
chunk size, so the helpers go idle between dispatches and park, and then every
dispatch pays a futex wake -- 241 exchanges a pass, twice over for the split.
The run was still going after 16 minutes at 226% CPU. This is the same wall as
the refill result: there are no spare cores here, and a thread that sleeps
between exchanges costs more to wake than the work it is handed.

**MPS is not the per-exchange floor.** The workers join an MPS daemon capped
to 50% of each card's SMs, which looked like a candidate for the ~44 us of
launch-and-sync each exchange pays. Taking them off it entirely changes
nothing measurable. The floor is cudaGraphLaunch plus the synchronize, and
241 exchanges x 44 us = 10.6 ms per pass is simply what this design costs.

**The Freivalds overlap is broken, and its gate was hiding that.** `sh_link_gemm`
excluded the overlap whenever a shm ring was attached, which looked like a
leftover: the ring publishes the request before it spins and takes a work
callback for exactly this, and the RHS depends only on the trusted input, so
it is ~3.6 ms per pass of dead time. Enabling it makes verification fail on
the first pass ("the worker lied or the field wrapped"), with AND without the
column split. So the ring+overlap path has never worked, the gate is what has
been hiding it, and the comment now says so.

### 16.9 A third card does not pay, and a warning about the measurements

The RTX 3070 in this box runs the worker (sm_86, 2153 G-MAC/s on the masked
path against ~2500 for a V100), so a three-card column split is buildable:
shares proportional to bandwidth, 45/45/10, the 3070 holding ~2.2 GB of
slices. It is CORRECT -- verification passes and the text is identical -- and
it does not pay. Alternating with the two-card build on an idle box:

| cards | plain tok/s | speculative k=1 tok/s |
|---|---|---|
| **2 (both V100s)** | 17.20 / 16.77 / 16.91 | **18.71 / 19.95 / 17.60** |
| 3 (+ the desktop's 3070) | 17.88 / 16.88 | 17.36 / 18.41 |

The reason is 16.8's last paragraph: about 10.6 ms of each pass is per-exchange
launch and synchronize, and an exchange is not done until the SLOWEST card
answers. A third card cuts the streaming term by ~2.4 ms and adds a third link
to wait on, and on this hardware those cancel. More cards only pay while the
streaming term still dominates the launch term, which on two V100s it no
longer does.

**A warning about every number in this section.** Partway through, two
benchmark processes were running at once -- a queue chained off an earlier
one that had already been restarted by hand -- and the load average sat at
12 on a 16-core box. That stretch produced a 19.64 tok/s three-card figure and
a 13.1 tok/s two-card figure in the same hour, neither of them real. Every
comparison quoted here was re-taken with a single benchmark on an idle box and
a process-tree kill (`kill-tree.sh`) that stops a queue AND its runner without
touching another. The spread that remains is still about +-1.2 tok/s run to
run, which is why the tables give every rep rather than a mean.

### 16.10 Where it landed, and what 20 tok/s would still take

Nine clean two-card reps of the shipped configuration (column split, recurrent
state aliased and updated in place, graph cache 2048, 8 decode threads, k=1),
one benchmark at a time on an idle box, every run output-verified:

| | min | median | max |
|---|---|---|---|
| plain decode | 15.78 | **16.77** | 17.20 |
| speculative k=1 | 16.33 | **17.60** | **19.95** |

Against 12.85 / 14.05 at the start of the day, that is +31% plain and +25%
speculative at the median. The best single run touches 20; the median does
not, and the run-to-run spread is 3.6 tok/s on the speculative number, so
**the honest figure is 17.6 tok/s with a 19.95 peak, not 20.**

For context, 16.7's unmasked baseline on the same two cards is 30.36 tok/s, so
the shielding now costs 1.72x at the median where it cost 2.16x this morning.

What is left, priced from the `W + C` decomposition in 16.6 (per-pass 23.4 ms,
per-token 35.0 ms):

- **A narrower weight lane.** 15.5 priced int6 with an integer scale per
  32-block at 0.8125 bytes/weight against the present 1.0625, for 1.6x the
  encoding error. That is 24% off the 12.7 ms streaming term: about -3 ms,
  or +5%. It means a new packed format in `sh_prepare_weight_rows`, the CUDA
  kernel's weight load, the AVX-512 refill and the local fallback -- invasive
  changes to the code that carries the confidentiality guarantee.
- **The worker's reply copy.** Every reply is `memcpy`d from pinned staging
  into the shm ring (`service_ring`). At ~14 MB of replies per pass that is
  ~1.2 ms, about +2%. Registering the ring with `cudaHostRegister` and letting
  the graph's D2H land in it directly would remove it.

Together those are about +7%, which puts the MEDIAN at 20 and leaves the
distribution straddling it. Everything cheaper has been tried and is in 16.8.
**On this pair of V100s, 20 tok/s is the edge of what the design reaches, not
a comfortable operating point** -- and unlike 15.6, that is now a statement
about a measured 23.4 ms/pass GPU term and a 35 ms/token CPU term, not about
card bandwidth.

### 16.11 The narrow lane is dead on this card, and 15.5 asked the wrong half

16.10 named an int6 weight lane as the last lever worth more than a few
percent, on 15.5's pricing. Building it turned up two things, and the second
one closes the question.

**First: the 2.07-2.33% figure in 15.5's table is not implementable in this
field.** That row is "int6 with an INTEGER scale per 32-block", and its
multiplier is a 16-bit integer, so the reconstructed weight can be ~550x the
int8 lane's. `SH_WEIGHT_BYTE_LIMIT` is 119 because that is *exactly*
min(prime)/2: at or below it a weight IS its own balanced residue in all three
RNS lanes and needs no decomposition on either side, which shielded-field.h
records as "the single largest reason the fused kernel is fast". Raising the
weight magnitude has to be paid for in the ACTIVATION's calibrated exponent,
because the field only recovers `|W.x| < M/2` with M ~ 2^23.8. 15.5 measured
the weight error of a scheme whose activation cost it did not price. The
field-compatible form -- the one whose reconstruction stays inside +-119 --
measures **2.87-3.08%** on real 27B tensors against 1.32-1.41% for int8
(`shielded/lane/lane_error.py`, rows "int6 DIRECT" and "int6 REQUANT"; the
latter, re-quantising the BYTES rather than the floats, double-rounds to
3.4-3.7% and is the wrong way to do it).

**Second, and decisive: the card cannot collect the bytes.** 15.5 priced the
lane by encoding error alone. `shielded/lane/i6_kernel_bench.cu` measures what
the kernel pays to read it -- same shapes, same three planes, same
accumulation, m=1:

| shape | K | N | int8 | int6 | int8 GB/s | int6 GB/s |
|---|---|---|---|---|---|---|
| 27B gate|up | 5120 | 17408 | 163.2 us | 529.2 us | 546 | 137 |
| 27B down | 17408 | 5120 | 124.3 us | 474.1 us | 717 | 153 |
| 27B qkv | 5120 | 10240 | 100.7 us | 315.0 us | 521 | 135 |
| 27B lm_head | 5120 | 248320 | 2143.8 us | 6737.6 us | 593 | 153 |

**3.2x slower**, and that is the OPTIMISED unpack: the +32 bias folded into one
per-block correction so no value is sign-adjusted individually, and each group
of four values extracted from a single 24-bit window in the shape the compiler
folds into LOP3. The naive form managed 83-94 GB/s. One byte per weight is
what dp4a wants; 32 weights in 24 bytes has to be taken apart first, and on
sm_70 that turns a comfortably memory-bound kernel into an ALU-bound one --
the same failure shielded-field.h records for the v1 fused kernel, where
"keeping the modulos made v1 ALU-bound and WORSE than not fusing at all".

So the 19% of bytes the lane saves cannot be collected here at ANY encoding
quality, and the error question never arises. **This is a property of sm_70's
ratio of integer throughput to bandwidth, not of the scheme** -- re-run the
benchmark before assuming it holds on a card where bandwidth is the harder
constraint. With it, the software levers for this model on this hardware are
finished: 17.98 tok/s median with the ring write, 19.95 peak, against an
unmasked 30.36.

## 17. The 27B at 19 tok/s: two real fixes, three wrong guesses, and why C did not move (2026-09-22)

Section 16 left the 27B at 17.98 tok/s median with the software levers called
finished, and a handoff asking for 25. This session did not get there. It got
to **19.01 spec / 18.12 plain median**, it fixed two real defects on the way,
and -- more useful than either -- it replaced the subtraction that was standing
in for a cost model with measured parts. What follows includes the wrong turns,
because two of them were wrong for reasons that will recur.

### 17.1 The column split was in a scratchpad, not the repo

16.1 measured the column split and 16.5 tabulated it, but it was never
committed: it lived in a session scratch directory under /tmp that would have
gone with the next clean-up. Porting it was the first job and it is now
`SHIELDED_SPLIT_COLS=1` in the tree (90d7a2ce). The scratch build also carried
a relaxation letting the ring live under `/dev/shm`, which a bench box needs
and production must not accept; that second prefix is behind
`SHIELDED_ALLOW_DEV_SHM_RINGS` and only a bench build defines it.

### 17.2 The Freivalds overlap: a defect, not a tuning decision

The handoff listed "fix the Freivalds overlap" as worth ~6% and recorded that
it "fails verification with AND without the split, so the gate excluding it is
load-bearing and the path has never worked."

The gate was hiding a bug. `sh_pipe_ring_exchange_work` refuses a frame BEFORE
it publishes when the frame will not fit its slots -- the 27B's prefill
`lm_head` reply is 17 x 248320 x 4 = 16.9 MB against a 6 MiB slot -- and the
work callback then never runs. The caller set `rhs_done` from `overlap` alone,
so the socket fallback was told the RHS had already been computed when it had
not, and the unmask compared its LHS against an uninitialised `fv_rhs`. A
verification failure against an entirely honest worker, on the first pass.

Asking the work item whether it ran, instead of assuming, removes the gate:

    W (per pass)   23.4 ms  ->  18.2 ms

`test/fixtures/shielded-overlap-verify.c::ring_refusal_case` covers it, and
fails when the defect is reintroduced. The existing ring cases could not reach
it: ring_mode 1 answers on the ring and ring_mode 2 publishes then times out,
so in both the callback DID run. The uncovered path was "refuses before
publishing", which is where the bug lived.

### 17.3 Three hypotheses about the 19.5 ms, all wrong

`t_link` minus the phase counters was 19.48 ms/pass. In order:

1. **The scalar outlier loop.** `sh_split_post_slice` hand-rolled
   `y[j] += xv * w[j]` where the whole-tensor path calls a blocked,
   double-accumulating kernel that its own comment measures as ~4x cheaper.
   The traffic argument looked decisive -- until the calibration was read.
   **180 of 262 sites have ZERO outliers**, mean 3.83, not the 16 extrapolated
   from one site. Measured post: 2.46 ms/pass. The kernel change is
   bit-identical (test/shielded-outlier-stride.test.mjs) and stays because it
   is the right kernel, but it is not a measured win.
2. **The refill threads are spare capacity.** A live thread sample showed the
   16 refill threads ~13% busy while 8 others sat at 97.5%, and
   `derive_threads` says in a comment that idle threads "cost nothing".
   `SHIELDED_REFILL_THREADS=8` produced **279 missed pads and 992 ms of
   on-path minting**; with field helpers as well, 592 missed and 1780 ms. They
   are provisioned for BURST, not average, and 13% average utilisation says
   nothing about that.
3. **The join is the split worker's condvar round trip.** 241 exchanges at the
   ~28 us that cost measures would be 6.7 ms, most of the join.
   `SHIELDED_SPLIT_SPIN_US=60000` moved join 5.49 -> 4.98 and spec 19.01 ->
   17.48. Across six runs join ranged **2.47 to 5.63** while gemm+post+join
   held at 45.8-48.4: the join is jitter between two threads, and the total is
   what is stable. There was no structure to find.

### 17.4 What a pass actually costs (measured, not subtracted)

    gemm  ~40 ms/pass   the primary card's own exchange
      wire         21.0   spin for the worker's reply
      mask          5.1   activation -> three byte planes
      rhs           4.4   Freivalds RHS, now inside the spin window
      check         3.5   balanced-range scan over EVERY reply value
      unmask+lhs    3.2
      pads          0.1
    post   ~3 ms/pass   TEE-side outlier term + descale
    join   2.5-5.6      waiting for the other card (noise)

`check` is the finding: a second full traversal of megabytes that the unmask is
about to read anyway. It is a security check and it stays -- an out-of-range
reply breaks the field arithmetic downstream -- but it does not have to be its
own pass. ~7% of a token, and fusing it preserves the check exactly.

### 17.5 W moved, C did not, and C is the whole gap

    plain = W + C    W 18.2   C 35.0
    round = W + 2C + draft, 1.83 tokens

Everything this session bought came out of W. **C has not moved from 35.0 ms
since section 16 measured it**, and 25 tok/s needs C ~= 24.7. More cards, a
narrower lane and a faster card all buy a share of W and none of C; so, it
turns out, do thread counts, spin windows and helper pools.

### 17.6 The pad-independence invariant

Every run draws FRESH pads for the same prompt, so if the pad cancels exactly
the output cannot depend on it. Hashing the generated text across **25 runs and
every configuration tested** -- split on, overlap on and off, field widths 2
and 4, halved refill, 60 ms spin window, scalar and SIMD outlier, and the
pre-change build -- gives **one sha256**. This is strictly stronger than the
bench's `text_identical`, which compares the speculative output against the
plain reference within a single run and therefore holds the pad fixed: a
pad-dependent path is invisible to it. (Owed to the anchor session, which found
a clamp on its own path that made decode a function of the secret pad.)

### 17.7 Dead ends measured here, so they are not re-measured

| lever | result |
|---|---|
| `SHIELDED_REFILL_THREADS=8` (from 16) | 279 missed pads, 992 ms on-path minting |
| the same + `FIELD_THREADS=2` | 592 missed, 1780 ms, plain 13.44 |
| `SHIELDED_FIELD_THREADS=2` | plain 16.78 vs 18.01 base -- harmful on a quiet box |
| `SHIELDED_FIELD_THREADS=4` | plain 11.49 -- 2 card threads x 3 helpers oversubscribes |
| `SHIELDED_SPLIT_SPIN_US=60000` | spec 17.48 vs 19.01 |
| scalar -> blocked SIMD outlier term | bit-identical, no measured gain (post is 2.46 ms) |

### 17.8 What is actually left

1. **Fuse the balanced-range scan into the unmask.** 3.5 ms/pass, measured,
   preserves the check, touches no security property. Time the worker's own
   counters as well as the pass removed: the anchor session found that moving
   work off a decode thread cost more on the other side than it saved.
2. **Batching (m > 1).** Still untouched. W is per-PASS, so the 21.6 GB weight
   stream amortises across users; every number here is single-stream latency.
3. **One pad shared by both cards**, instead of one each. Halves the mask and
   halves pad demand -- which is what forces 16 refill threads. A colluding
   host would see ONE masked copy where it now sees two (and can difference
   them), so the direction looks favourable, but this changes the masking
   construction and belongs to a SECURITY.md review, not a performance patch.

### 17.9 Concurrency defect in the helper pool

`sh_par_for`'s park/dispatch handshake could lose a wakeup: the dispatcher
stores `gen` then loads `parked` while the worker stores `parked` then loads
`gen`, and release/acquire on two different atomics permits both loads to
return the pre-store value -- nobody signals, and on the untimed wait that was,
the owner spins forever. Found by review, not by the stress test: a 3000
-dispatch boundary regression against helpers forced to park on their first
miss does NOT catch it, because the window is nanoseconds wide. A litmus test
that aligns the two threads on a barrier shows the bad outcome on ~14% of
500,000 trials unfenced and 0 in 2,000,000 fenced. Fixed with paired seq_cst
fences behind one macro that both halves and the litmus share, so deleting the
fence fails the test (74181f43).

## 18. Three arithmetic changes, and a divergence that was never the arithmetic (2026-09-22)

Section 17 closed at 19.01 spec with C stuck at 35 ms and named the reply range
check as the best-evidenced lever. This section spends that lever and two more
like it, measures what they were actually worth, and then spends most of its
length on a correctness question that turned out to matter more.

### 18.1 Two range checks were paying for the wrong translation unit

shielded-tee.c is compiled once, at baseline ISA. shielded-simd.c is compiled
twice, with the arch flags -- that is what the table is for. Two security
checks were written to vectorise (unsigned range reduction so INT32_MIN/MAX
cannot overflow, an OR reduction rather than an early exit, no data-dependent
branch) and were sitting in the wrong file:

| check | scans per pass | before | after |
|---|---|---|---|
| `sh_reply32_balanced`, every int32 reply value | ~8 MB | 3.50 ms | 0.22 ms |
| `sh_values_within`, the activation bound | ~9.9 MB | ~3.2 ms | ~1.1 ms |

Neither guarantee moved. Both are the same predicate on the same values, and
both stay SEPARATE passes that complete before any kernel runs. In particular
the reply check was NOT fused into the unmask, though the unmask reads the same
bytes and fusing would have removed the traversal outright: the unmask is the
first thing that writes the caller's output, and the contract asserted in
shielded-overlap-verify.c is that an out-of-range reply leaves that output
untouched. Checking while unmasking would commit part of it before finding a
bad value later in the buffer. 0.22 ms is not worth that.

The local fallback also rescanned the same activation once per node of a group
(every node in a group reads the SAME x); it advances a `checked` offset now,
so each element is examined once and the order in which PROTO and VERIFY are
reported is unchanged -- which matters, because VERIFY retires the link.

### 18.2 A reduction that could never have changed anything

`mask_planes` reduced x+r modulo M before reducing modulo each Q. M = Q0*Q1*Q2,
so ((x+r) mod M) mod Q == (x+r) mod Q, and the three planes ARE those residues.
The mod-M step cost an int64->double convert, a multiply, an int64
multiply-subtract and two corrections per element, and could not affect the
output. The tuned NEON path had dropped it years of reasoning ago; nothing in
that reasoning was ARM-specific.

These planes CROSS to the untrusted worker, so the standard is not "tests
pass". The kernel's contract bounds x+r to about 1.5e8 values, which is
exhaustible, and test/shielded-mask-planes.test.mjs exhausts it: **148,675,078
values, old formula against new, per plane**, then both tables' real kernels
against the old formula over random and boundary (x, r).

Codegen says it worked -- 979 instructions and 64 vpmullq/vcvtqq2pd/vmulpd
became 745 and zero. The clock says it barely mattered: **-0.34 ms/pass**. The
kernel is dominated by the lane-crossing permutes that narrow int64 x to int32
and pack int32 to int8, not by arithmetic. x_field is int64 across the whole
link API even though the contract is |x| < 2^26; that, not the modular
reduction, is what mask_planes costs.

### 18.3 What the three were worth

Medians, n=3-4, gated on a quiet box, one diverged run excluded (see 18.5):

| | plain | spec |
|---|---|---|
| before | 17.58 | 18.96 |
| after | **18.76** | **19.72** |

Counter attribution: check -2.37, activation bound -2.1, mask -0.34 ms/pass.
C falls 35.0 -> ~31.5. It is the first time in this campaign that C moved.

### 18.4 C, finally accounted for

The op profile this campaign kept deferring, differenced over token count so
the ~30 s weight-registration prefill cancels (192-token minus 64-token):

    CPU graph, decode only: 12.45 ms/token
      GATED_DELTA_NET  4.105  33%
      CPY              1.295  10%    165 calls/token, worst = the SSM conv state
      CONCAT           1.079   9%     76 calls/token, conv_input [20,10240] 800 KB
      RMS_NORM         0.938
      UNARY            0.904
      FLASH_ATTN_EXT   0.881
      MUL_MAT          0.853
      SSM_CONV         0.582

So C ~= 31.5 = 12.45 (graph) + ~19 (exchange path), and nothing is unexplained
any more. Note MUL_MAT: in the undifferenced 64-token run it reads 1114 ms and
looks like a mass of un-offloaded matmuls. It is prefill. Differencing is the
whole reason that reading did not become a fourth wrong hypothesis.

**The best remaining lever is CPY + CONCAT = 2.37 ms/token**: the SSM conv
state concatenated with the new token and copied back, per layer per token.
That is structurally what 16.3 fixed for the delta-net RECURRENT state, where
it was worth 6.4 ms. The conv state never got the same treatment.

### 18.5 The divergence: pre-existing, and not the arithmetic

3 of 39 runs produced speculative output that differed from the plain
reference, with verify_fail=0 throughout. It reproduces on the PRE-change build
(rs-before-1, acceptance 0.939), so it is not these changes -- which is what
bit-identity already implied and this demonstrates.

It is also not the rs-alias graph-reuse trap of 16.4: that audit reports
VIOLATIONS 0. Hypothesis, measured, discarded.

The anchor session proposed the test that settled it: if this is fallback
rounding it must be pad-independent at equal fallback counts. Grouping all 39
runs by locally-computed node count:

    local=111: 1 run, 1 text   <- diverged        local=127: 2 runs, 1 text
    local=124: 1 run, 1 text                      local=128: 5 runs, 1 text
    local=125: 7 runs, 1 text                     local=130: 16 runs, 1 text
    local=126: 5 runs, 1 text                     local=131: 1 run, 1 text  <- diverged
    OVERALL: 2 distinct texts across 39 runs, with FRESH PADS every run.

Every group is internally consistent. That is CORRELATION, and the causal
reading has to be scoped accordingly. What it supports: across these 39 runs,
with fresh pads each time, output never varied within a fallback count, and
both diverged runs produced the SAME divergent text despite different pads,
different builds and different counts -- consistent with one near-tied token at
position 1 flipping and greedy decoding being deterministic after it. What it
does NOT establish: that fallback placement is the ONLY source of
nondeterminism, or that arbitrary pads cancel in general. 39 runs over eight
distinct counts is a small sample against either claim, and the two diverged
runs are a sample of two.

ggml-shielded.cpp gives a MECHANISM that would produce this pattern -- the
fallback "rounds like the CPU backend (fp32 accumulate) rather than like the
field" -- but a mechanism that fits is not a mechanism that is demonstrated.
Settling it needs a controlled intervention: hold decode until every card is
live (or make the exact fallback correct under a split), then show divergence
is gone across repeated runs with fresh workers on the same workload. Until
that runs, treat this as the leading hypothesis, not the cause.

Root cause is a startup race. Line 2005 sends a group to the fp32 CPU path when
`!live`, and the link is not live until the ~13.9 s weight upload finishes, so
the count depends on timing. Those nodes land in prefill.

### 18.5a Three explanations, measured and discarded, then the cause

The hypothesis in 18.5 was tested by intervening on it, and it was WRONG. So
were two others. In order:

1. **The rs-alias graph-reuse trap (16.4).** ENCLAVE_RS_DEBUG audits the alias
   assumption on every graph: VIOLATIONS 0.
2. **A startup race on `!live`.** SHIELDED_WAIT_LIVE_MS was added to hold a
   group until its card's link is live rather than sending it to the CPU
   backend. It moved the locally-computed count 130 -> 128, i.e. nothing. The
   `!live` branch is not what sends those nodes local.
3. **The contention detector.** A grep for "contended" in a run's log returned
   28 hits, which looked like confirmation; they were the profile line printing
   its own `contended=0`. Across all 49 runs the detector never fired once:
   `contended=0 events=0`, every run, clean and diverged alike.

The cause is in the startup sequence, visible identically in every run:

    worker live ... with 401 weights                      <- context 1
    worker unavailable (HELLO (with reservation):
      reservation 20000000000 exceeds the budget:
      20000000000 reserved of 32212254720)                <- context 2 collides
    worker live ... with 409 weights                      <- after retry

The bench opens TWO contexts, target and drafter. Each asks the worker to
reserve 20 GB against a 32 GB budget, so the second collides EVERY run, and
during the retry window some groups are computed on the fp32 CPU backend
instead of in the field. How many depends on retry timing, which is the
111-131 spread, and that path rounds differently -- near a tie, a token flips.

Device bytes are 14.12 GB per card, so a reservation that both fits the weights
and leaves room for a second context should remove the collision. The window is
narrow, because reserve_cap is 0.90 x reservation: 0.9R >= 14.12 GB needs
R >= 15.7, and two contexts in the 32.21 GB budget needs R <= 16.1.

15 GB was tried first and was WRONG, instructively: cap 13.5 GB did not fit the
weights, nearly everything fell back to the CPU, throughput collapsed to 0.60
tok/s -- and the output DIVERGED. Heavy local fallback producing divergence is
itself support for the rounding mechanism, arrived at by mis-specifying a test.

At 16.0 GB (cap 14.40 GB, 2 x 16.0 = 32.0 <= 32.21) the prediction lands
exactly:

There are TWO refusal classes, and only the first is the two-context collision:

  A. budget collision   "reservation 20000000000 exceeds the budget:
                         20000000000 reserved of 32212254720"
  B. free-memory refusal "cannot reserve 16000000000: the card has 17666080768
                         free (the pool holds 31977373696 against 16000000000
                         reserved)"

B is a physical/accounting refusal while a previous run's allocation is still
being released. It is NOT what the 16 GB change addresses, and it still occurs.

| reservation | A per run | B per run | local nodes | diverged |
|---|---|---|---|---|
| 20 GB (this harness all session) | 1 | 0 | 124-131, VARIES | 0/5 |
| 16 GB | 0 | 1 in 6 runs | 0 in five runs, 1 in one | 0/6 |

The residual ties to evidence rather than being left unexplained: rw-fit-3 is
the ONLY run with a class-B refusal and the ONLY run with local=1. The other
five have neither. So class A accounts for ~128 fallback nodes and class B for
the remaining one.

PERFORMANCE MEDIANS ARE n=5, NOT n=6. summarize.py excludes rw-fit-5, whose
run recorded an intruder. The n=6 figure above is the correctness observation
(0 of 6 diverged); the medians below rest on five samples each:

| reservation | plain (n=5) | spec (n=5) |
|---|---|---|
| 20 GB | 18.07 | 20.76 |
| 16 GB | 18.66 | 20.64 |

Both differences sit inside the run-to-run spread, so the smaller reservation
is a free correctness improvement and should be the harness default.

What 0 of 6 does NOT establish: that the divergence is gone, or that the run is
deterministic. Against a ~8% base rate six runs is weak, class B still fires,
and a residual fp32 node remains available to flip a near-tie. All twelve runs
across both configurations produced the same text, which is consistent with the
fp32 path usually agreeing and only occasionally differing -- the same fact
that made the original rate ~8% rather than constant. Determinism would need a
much larger sample with class B eliminated as well.

That is the cause: two contexts,
each asking for 20 GB of a 32 GB budget, colliding on every single run, with
the groups computed during the retry window taking a path that rounds in fp32
where the offloaded path is exact in the field.

Note what this says about the rest of this report: EVERY measurement in this
campaign ran with that fallback active, because the harness has always asked
for 20 GB. The performance numbers are unaffected in their comparisons (both
arms of every A/B carried it) but the divergence was never a property of the
masking, the arithmetic or the split.

**SHIELDED_LOCAL_EXACT=1 does not help here.** It exists for exactly this -- it keeps the
int64 field path so the fallback's output IS the worker's -- and it is
INCOMPATIBLE WITH THE COLUMN SPLIT. It works by skipping the safe whole-tensor
CPU path, and under a split a link holds only a column slice, so it computes a
partial product and Freivalds refuses:

    split verify: blk.1.ffn_down.weight: verification FAILED
    split probe: card 0 node 8 cols 0..2560   local rc=-10
    split probe: card 1 node 8 cols 2560..5120 local rc=-10

Reproduced twice on fresh workers with a clean default run immediately before
each. Low severity -- diagnostic knob, default off, fails closed -- but the
combination is broken, and the split's own fallback comment already explains
why: "this card's own nodes are only a SLICE of each weight". Fixing the
divergence means making that fallback produce field values under a split, or
not decoding until every card is live.

### 18.6 What 25 tok/s would take from here

    round = W + 2C + draft, 1.83 tokens/round
    now:  W 20.7  C 31.5  draft 5.7  -> 19.7 tok/s
    25 tok/s needs a 73.2 ms round -> C = 23.4, i.e. -8.1 ms

Every lever IDENTIFIED SO FAR, spent perfectly: the conv state (-2.37) and the
delta-net kernel (bf16 state, maybe -2, and a quality risk) come to ~4.4 ms,
landing near 22.7. No single remaining item on the measured list is of the
required size, and W is GPU streaming that more cards do not help (16.6) and a
narrower lane cannot buy (15.5).

That is a statement about the levers this campaign has found, NOT a proof that
none of the required size exists. The cost model is now complete in the sense
that every millisecond is attributed, but attribution is not a bound: 12.45 ms
of CPU graph and ~19 ms of exchange path are each made of parts that have not
all been examined for structural change, and the same was true of C itself
until this session. Two examples of shape rather than tuning: x_field is int64
across the whole link API though its contract is |x| < 2^26, which is what
makes mask_planes permute-bound; and the conv state fix is the same shape as
16.3, which was worth 6.4 ms when it was found. Batching across requests is
per-PASS and untouched, but it changes the workload rather than this metric.

### 18.7 The join is real, and GOMP_SPINCOUNT is still the wrong lever

`join` -- the primary card waiting for the other card's worker -- has a median
of ~4.2 ms/pass while the two cards differ by only ~4% in wire time (~0.9
ms/pass). Most of that gap is scheduling: the split worker competes with eight
OMP decode threads that SPIN while the main thread is inside the exchange and
has nothing for them to do. Section 16 lists GOMP_SPINCOUNT as a dead end, but
that was measured before the column split existed, so the thread whose
starvation this hypothesis names had not been created yet. Re-measured, at a
16 GB reservation, three runs per arm:

| GOMP_SPINCOUNT | plain | spec | join | gemm | wire |
|---|---|---|---|---|---|
| default | 18.58 | **20.80** | 4.15 | 33.98 | 22.32 |
| 1000 | 17.26 | 17.63 | **3.87** | 33.75 | 20.81 |
| 30000 | 18.73 | 19.97 | 4.13 | 35.00 | 22.99 |

The hypothesis is PARTLY right and the remedy is still wrong. Parking the
decode threads does relieve the split worker: join falls 4.15 -> 3.87 and wire
22.32 -> 20.81, so the exchange path genuinely gets faster. Throughput falls
15% anyway, because those same threads run the CPU graph -- 12.45 ms/token of
it -- and now pay a futex wake per op. What the exchange recovers, the graph
loses several times over.

So section 16's entry stands, for a reason it did not give, and the ~4.2 ms of
join is not recoverable by making the decode threads sleep. Recovering it would
mean giving the split worker its own core rather than taking one away from the
graph -- placement, not spin policy -- which is a code change and untested.

### 18.8 The second refusal class cannot be sized away

18.5a fixed class A (two contexts colliding on a 32.21 GB budget) by dropping
the reservation from 20 GB. Class B -- "cannot reserve N: the card has M free
(the pool holds P against N reserved)" -- survived, and I spent four attempts
predicting a reservation that would eliminate it. All four were wrong, for the
same reason each time: I read P once and treated it as a fixed card resource to
compute under. It is not.

| reservation R | pool P | P / 2R |
|---|---|---|
| 16.0 GB | 31.977 GB | 0.9993 |
| 15.9 GB | 31.776 GB | 0.9993 |
| 15.5 GB | 30.971 GB | 0.9991 |
| 15.0 GB | 29.998 GB | 0.9999 |

RETRACTED. I read P as "the sum of granted reservations" and built a story
about a THIRD request arriving while a previous run's two were still held --
a release race. worker.cu contradicts it, and I should have read the source
before theorising from log text.

`hello` checks g_reserved + want against the 32.212 GB budget BEFORE calling
claim_reservation, so a third 15.5 GB reservation would be refused as class A,
not class B. My explanation was not merely unproven, it was impossible.

What claim_reservation actually does:

    const long long target = g_reserved + R + g_floating;
    g_reserved += R;                          // added BEFORE the loop
    for (int i = 0; i < 16 && ok; i++) {
        const long long have = pool_reserved_now();
        if (have >= target) break;
        cudaMallocAsync(&p, target - have, 0); holds.push_back(p);
    }
    ...
    if (ok && *held < target) ok = false;      // "the pool let the holds go"
    if (!ok) { g_reserved -= R; pool_trim(); } // rollback, and hello prints
                                               // g_reserved AFTER this

So "the pool holds 31.977 against 16.0 reserved" is a failed SECOND claim with
g_reserved printed post-rollback: one link held 16 GB, this claim asked for
16 GB more, target was 32 GB, and the pool stopped 22,626,304 bytes short.

CONFIRMED BY TRACE, and then fixed. The hypothesis was that the loop fails
when the remaining delta is smaller than the pool's 32 MiB allocation
granularity. The first support for it was arithmetic that needed no
instrumentation: every pool figure at a refusal is an EXACT chunk multiple,
and every target lands a fraction of a chunk above it.

| held | chunks | target | chunks | shortfall | < 32 MiB |
|---|---|---|---|---|---|
| 31,977,373,696 | 953.0000 | 32,000,000,000 | 953.6743 | 22,626,304 | yes |
| 31,776,047,104 | 947.0000 | 31,800,000,000 | 947.7139 | 23,952,896 | yes |
| 30,970,740,736 | 923.0000 | 31,000,000,000 | 923.8720 | 29,259,264 | yes |
| 29,997,662,208 | 894.0000 | 30,000,000,000 | 894.0697 | 2,337,792 | yes |

I then instrumented claim_reservation behind `SHIELDED_CLAIM_TRACE=1` (off by
default) and reproduced it on the first run of the same configuration that had
fired in 2 of 10. The failing claim, card 1, verbatim:

    [claim] hello peer=127.0.0.1:59442 want=15500000000 reserved=15500000000 floating=0 reservers=1
    [claim] iter=0 gap=15497852416 have=15502147584 -> 28219277312 grew=12717129728 status=cudaSuccess
    [claim] iter=1 gap=2780722688  have=28219277312 -> 30769414144 grew=2550136832  status=cudaSuccess
    [claim] iter=2 gap=230585856   have=30769414144 -> 30937186304 grew=167772160   status=cudaSuccess
    [claim] iter=3 gap=62813696    have=30937186304 -> 30970740736 grew=33554432    status=cudaSuccess
    [claim] iter=4 gap=29259264    have=30970740736 -> 30970740736 grew=0           status=cudaSuccess
    ... iterations 5 through 15, identical ...
    [claim] FAIL R=15500000000 reserved_before=15500000000 target=31000000000
            held=30970740736 short=29259264 iters=16 holds=16
            pool_used=11615177728 driver_free=2666528768 floating=0

Three things are settled by those lines. `reservers=1` at the HELLO: it is the
SECOND claim, two tenants and not three, so the retraction above was right and
there is no release race to look for. `status=cudaSuccess` with `grew=0`,
twelve times: the allocations SUCCEED, they just come out of the pool's free
space, so ReservedMemCurrent never moves and the next iteration computes the
same gap. And `driver_free=2666528768`: the card had 2.67 GB the pool declined
to take.

The per-iteration arithmetic shows why it converges there. Growth is the
request minus whatever free space the pool could reuse, so the gap shrinks to
the reusable free space each time -- 15.50 GB, 2.78 GB, 230 MB, 62.8 MB, 29.3
MB -- and then sits at the fixed point where the free space exactly covers it.
That free space is not spare: it is the FIRST tenant's reserved-but-unallocated
room, which is why the failure is intermittent and why no reservation size
removes it.

The same trace also shows the fix. At iter=0 a 15.50 GB request grew the pool
by 12.72 GB, reusing the 2.78 GB that was free -- one allocation draws on free
space and on new chunks together. So asking for the gap PLUS the pool's free
figure gives a request the pool cannot cover from what it holds, and costs the
driver only the gap:

    const long long gap    = target - have;
    const long long freein = pool_free_now();          // Reserved - Used
    long long want_now = gap + (freein > 0 ? freein : 0);
    last = cudaMallocAsync(&p, (size_t)want_now, 0);
    if (last != cudaSuccess && want_now != gap) {       // too large: ask for the gap
        cudaGetLastError(); want_now = gap;
        last = cudaMallocAsync(&p, (size_t)want_now, 0);
    }

The fallback makes it strictly a superset of the old behaviour: anything that
succeeded before still succeeds. Nothing about admission changes -- the budget
check in `hello`, the post-condition `held < target`, and the rollback are all
untouched. It makes a claim that should have succeeded succeed; it does not
relax what is enforced.

Same configuration after the fix, card 0:

    [claim] iter=0 gap=15497852416 asked=18331003392 free=2833150976 have=15502147584 -> 30970740736 grew=15468593152
    [claim] iter=1 gap=29259264    asked=76021760    free=46762496   have=30970740736 -> 31071404032 grew=100663296
    [claim] OK R=15500000000 target=31000000000 held=31071404032 short=-71404032 iters=2 holds=2

It reaches 30,970,740,736 -- the exact figure that was the dead end -- and
clears it on the next iteration instead of spinning twelve times. The 71 MB of
overshoot is returned by pool_trim when the link closes.

Ten runs on that configuration, against the ten that produced the failure:

| | before (du-*) | after (cf-*) |
|---|---|---|
| runs with a class-B refusal | 2 of 10 | **0 of 10** |
| claims | -- | 40, all OK |
| iterations per claim | up to 16, then refused | 38 at one, 2 at two |
| iterations that failed to grow the pool | 12 in the traced failure | **0** |
| locally-computed nodes | 0, 1 or 3 -- VARIES | **0 -- constant** |
| output identical to the unshielded reference | 10 of 10 | 10 of 10 |
| reservers held at close | -- | 20 at one, 20 at zero: no leak |

The fallback count going CONSTANT is the part worth noticing. Across 17 earlier
runs a class-B refusal always left one to three matmuls computed in fp32 and
its absence left none; with the refusal gone, ten consecutive runs computed
nothing locally. That removes the last known source of run-to-run nondeterminism
on this path. It does not prove the path is deterministic -- ten runs against a
base rate that was ~8% when 128 nodes were involved would show nothing either
way at zero nodes -- but the mechanism that produced the variation is closed.

What these ten runs do NOT establish is that the fix is performance-neutral.
The spec median is 19.12 tok/s (n=9) against 20.16 for the ten before it, and
that comparison is worthless: mean foreign load was 1.11 during the new set
against 0.36 during the old, and across all 17 clean runs foreign load and
throughput correlate at r = -0.36 (median 19.47 under 1.0, 18.98 at or above).
The contention was mine -- I ran profile differencing and thread sampling on
the box during my own measurement window, which is the third time this session
that my own work has contaminated a run. The claim happens once per link at
HELLO, outside the decode loop, so a steady-state regression is implausible;
implausible is not measured, and this set does not measure it.

Across 17 runs at 16.0, 15.9 and 15.5 GB the correspondence is exact in
DIRECTION, though not in count -- an earlier draft of this section said
local=1 and that was too precise:

| | runs | locally-computed nodes |
|---|---|---|
| class B fired | 4 | 1, 1, 1, **3** |
| class B did not | 13 | **0**, every one |

So a class-B refusal leaves between one and three matmuls computed in fp32
instead of the field, and its absence leaves exactly none. No exceptions in 17
runs. The MECHANISM is not in doubt -- those nodes round differently and can
flip a near-tied token -- only how many nodes a given refusal costs.

What this means for the divergence: class A was the bulk of it (124-131 nodes
per run, every run) and is gone. Class B leaves exactly one node, rarely. No
divergence has been observed since class A was removed, but that is 13 runs
against a base rate that was ~8% when 128 nodes were involved and should be far
lower at one -- so the absence is expected either way and is NOT evidence the
path is now deterministic.

### 18.9 Pinning to physical cores halves it, and the join is not the imbalance

Two claims from the profile needed testing. The column-split `join` is a WAIT,
it is 4.8-20.3% of spec-decode graph time across 14 runs (median 10.0), and it
correlates with the card-to-card work imbalance |card1/card0 - 1| at r = +0.73.
The imbalance is not a property of either card -- the ratio lands both sides of
1.0 -- so it looked like per-run scheduling jitter. This box is 16 physical
cores with 2 threads each, one socket, one NUMA node, and the bench runs 8
threads plus 8 refill threads plus a split worker with an unrestricted affinity
mask, so two halves of a split landing on SMT siblings is the right shape.

CPUs 0-15 are one logical CPU per physical core. Four alternating pairs,
`taskset -c 0-15` against unrestricted:

| | unrestricted | pinned to physical cores |
|---|---|---|
| spec tok/s | 18.62, 19.33, 20.08, 20.36 | 10.49, 10.52, 10.59, 10.64 |
| clean median | 19.49 (n=2) | 10.59 (n=3) |
| graph_compute | ~1753 ms | 2285 ms |
| split join | 10.0% median (n=14) | **33.1%** (31.5-34.5) |
| card1/card0 | 0.90-1.32x (n=14) | **0.96x (0.95-0.96)** |

Pinning costs 46% of throughput. The arms do not overlap at all -- every
unpinned run beats every pinned run by 8 tok/s -- so although the clean
unpinned arm is n=2 and below the threshold I hold myself to, the direction is
not in question. SMT is paying here, not costing, even though mask, unmask and
the Freivalds rhs are all AVX-512; halving the logical CPUs available to ~17
threads halves the work done.

The mechanism result is the interesting one, and it goes against me. Pinning
DID collapse the card ratio, from a 0.90-1.32 spread to 0.95-0.96 across three
runs, which confirms the spread is scheduling and not a property of a card. And
the join got WORSE, from 10% to 33%. So the join is not primarily paying for
card-to-card work imbalance: with the cards balanced to within 4%, it is at its
highest share of the run.

The r = +0.73 across the unpinned runs stands as an observation and my reading
of it does not. The likelier account now is that the join waits on whichever
half cannot get a CPU, which is a different quantity from which half was given
more work -- starving the box inflates the wait while leaving the work balanced.
That predicts the join should shrink with MORE parallelism, not less, and that
is the experiment, not another pinning variant.

What this retires: `taskset`, and `SHIELDED_SPLIT_WEIGHTS` with it. A static
column rebalance was already the wrong instrument for a quantity that changes
sign between runs; now it is aimed at a quantity that is not the cost either.

### 18.10 Two of five assertions were not assertions

enclave-6e built a deliberately-broken version of their own adversarial thread
test and found two of five assertions still passing on it. An inert assertion
reads exactly like a live one -- the reason it is inert is invisible from its
own text -- so only a mutant distinguishes them. Five against the parwork
regression, in an isolated copy rather than the shared checkout:

| mutant | result |
|---|---|
| the parked flag is never published | caught (abort, width 2, spins 0) |
| helpers are never joined at teardown | caught |
| a parked helper is never signalled | caught |
| the seq_cst fence removed from SH_PAR_PUBLISH | caught, by the LITMUS |
| `sh_par_width()` returns 1 unconditionally | **passed -- inert** |

The width was printed and never checked. Every other check in that fixture is
width-agnostic by construction, so a pool that ignored SHIELDED_FIELD_THREADS
entirely passed the whole file at all six settings it sweeps. The pthread_once
initialization the audit asked for had no test behind it. It is asserted now,
against the same clamp `sh_par_width_init` applies, plus a second call that
must agree with the first, since "once" is the property; the mutant is caught
at the first width that differs.

Two corrections inside this exercise, both mine:

The FIRST mutant harness had the defect it was built to find. Its runner
returned 99 on a build failure and the caller's `if/else` routed that to the
success branch, so the control printed "passed (as it must)" for six builds
that never compiled. The rewrite distinguishes caught, inert and build-failed,
and requires the control to PRODUCE its output line rather than merely exit
zero.

And I first recorded the fence mutant as inert. I had built the litmus without
`-DSH_LITMUS_FENCED`, which is the arm that carries the assertion. Built
correctly, the clean tree gives both-stale=0 of 500000 and the fence-removed
tree gives 68978. The fence is covered; my invocation was not.

What this still does not establish: that the handshake is correct. The litmus
can demonstrate a race and cannot prove its absence, and miri -- which would --
does not take C. The fix rests on the fence argument, 2M clean trials, and now
live assertions. That is three things, and none of them is a proof.

### 18.11 A fourth build location, and a pre-existing failure in a path I use

`shielded-tee.c` calls `sh_par_for` unconditionally, so every unit that
compiles it must also compile `shielded-parwork.c`. I put it in the Makefile;
the audit caught `metal/build-image.mjs`; enclave-6e caught
`windows/enclave-engine/build.cmd`. Rather than assume three was the count I
looked for a fourth and found it: `shielded/anchor/avf/build.sh` compiles
tee.o at three sites and links it into `shielded-probe`, `simd-check` and
`libggml-shielded.so` with no parwork object. That build will fail to link.
Reported to the session working in that file with the exact sites rather than
edited underneath them.

Separately, `test/shielded-refill-priority.test.mjs` fails -- a `choose`
assertion, not a link error. It reproduces identically at 09379a88, which
predates every change in this session, so it is pre-existing and not mine. It
is in a path these measurements use (`refill_priority=deficit` appears in every
profile line), so it is recorded rather than chased; the runs show
`pads missed=0 waited=0`, so refill kept up regardless and the throughput
figures do not depend on the chooser being right.

### 18.12 Correction: those percentages are of the shielded backend, not the token

Every share in 18.8 through 18.11 is divided by `graph_compute`, and I wrote
them up as "share of spec-decode graph time", which reads as the whole model
graph. It is not. `s.t_graph` is accumulated from `tg0` at the top of the
SHIELDED backend's `graph_compute` callback (ggml-shielded.cpp:1820 to 2255),
and the scheduler hands each backend only its own subgraph. GATED_DELTA_NET,
FLASH_ATTN_EXT, the norms, CPY and CONCAT all run in the CPU backend's
callback, which this counter never sees.

So "link is 93% of graph_compute" says only that when the shielded backend
runs, it is almost entirely the link. It says nothing about C, and it does not
contradict C being the wall -- the two numbers are about different halves and I
briefly read them as if they were about the same one.

Converting to the token, at 1753 ms of shielded-backend time over 64 spec
tokens (27.4 ms/token) against 48.14 ms/token measured end to end:

| | of shielded backend | of the token |
|---|---|---|
| split join | 10.0% median | 5.7% |
| rhs | 7.2% | 4.1% |
| mask | 6.4% | 3.6% |
| unmask+lhs | 5.3% | 3.0% |
| reply range check | 0.5% | **0.3%** |

The conclusions do not change and one of them gets stronger. The check fusion
was already dead at 0.5%; at 0.3% of a token it is not worth the ordering
argument it would need. Pinning was measured end to end in tok/s and is
unaffected. The join is still the largest addressable shielded-side item after
wire and gemm, but it is 2.7 ms of a 48 ms token, not a fifth of it -- and
since 25 tok/s needs 8.1 ms out of that token, the join cannot get there even
if it went to zero.

The habit that produced this: I quoted a percentage without naming its
denominator, then reasoned about the percentage. Shares need their denominator
attached every time they are written down, not just where they are computed.

### 18.13 The CPU decode path, measured, and two more broken denominators

The shielded counter cannot see C, so C was measured directly: two
`ENCLAVE_OP_PROFILE=1` pairs at N=64 and N=192, differenced, both paying the
same one-time prefill. Graph counts are identical between reps (34530 graphs /
152070 nodes at 64, 99738 / 439470 at 192), so the subtraction is clean.

**C = 12.29 ms/token** (11.57 per forward pass), 11.92 and 12.66 across the
two reps:

| op | ms/token | share of C |
|---|---|---|
| GATED_DELTA_NET | 4.154 | 34.1% |
| CPY | 1.312 | 10.8% |
| CONCAT | 1.186 | 9.7% |
| MUL_MAT | 0.926 | 7.6% |
| FLASH_ATTN_EXT | 0.924 | 7.6% |
| RMS_NORM | 0.818 | 6.7% |
| UNARY | 0.798 | 6.6% |
| SSM_CONV | 0.586 | 4.8% |
| GLU, GET_ROWS, ADD, L2_NORM, MUL, ROPE, rest | 1.15 | 9.4% |

I wrote the prediction down before running it -- GATED_DELTA_NET still largest
at 30-35%, C still 12-13 ms/token -- and both held, so nothing moved underneath
the earlier figure.

**Two instruments were wrong, both in the divisor.**

`opdiff.py` divided by (192-64)=128 and called the result ms/token, while the
delta it divides spans BOTH the plain and the speculative path: 256 extra
tokens over 272 extra forward passes. Its own TOTAL line said "summed over the
plain AND spec paths" -- the qualifier sat one line from the number it
qualified. Every per-op figure it printed was 2x high. `opdelta.py` replaces
it, derives every divisor from the run's own JSON, prints both units, and
refuses on fewer than two pairs. This was caught only because enclave-c6
described an RMS understated by exactly sqrt(2) from a sample counter that
counted twice per output; an instrument's output cannot validate the
instrument.

And 18.12 corrected the denominator of the shielded shares but not far enough.
`t_link` is a SUM over the concurrent card threads; `t_graph` is WALL time for
the enclosing callback. In one of these two reps the link delta (8250 ms)
EXCEEDS the shielded backend delta (7419 ms), which is impossible for a
contained quantity and is the proof that they are not the same kind of number.
So "link is 93% of graph_compute" was comparing a concurrent sum to a wall
clock and means less than it appeared to. The shares WITHIN the link (join,
rhs, mask, check) are still comparable to each other, because they are all
sums; they were never comparable to the wall.

**The token, end to end**, from the same runs (the differential measures the
marginal token between 64 and 192 of context, which is slower than the average
-- 52.6 and 54.5 ms against 48.3-48.8 at N=64):

| | rep 1 | rep 2 |
|---|---|---|
| decode wall | 52.61 | 54.54 ms/token |
| shielded backend (wall) | 28.98 | 35.78 |
| CPU backend ops | 11.92 | 12.66 |
| in neither counter | 11.70 | 6.10 |

The shielded wall figure is the noisy one, 23% apart between reps, and the
"neither" bucket inherits that noise. What is solid is C at ~12.3 and the
shielded side being the majority of the token.

**What this says about 25 tok/s.** 40 ms/token is needed and the marginal token
here is ~53.6. Finding 13.6 ms inside C means removing all of GATED_DELTA_NET,
CPY, CONCAT, MUL_MAT and FLASH_ATTN_EXT together, which is not an optimisation
but a different model. C alone cannot pay for it, exactly as the shielded side
alone could not. That is now measured on both halves rather than argued on one.

### 18.14 Decode threads: 8 is already past the knee, so C is not compute-bound

The bench has always run llama.cpp with THREADS=8 on a box with 16 physical
cores and 32 logical, and nobody had swept it -- the sweeps on record,
SHIELDED_FIELD_THREADS and SHIELDED_REFILL_THREADS, are different pools. After
pinning showed the workload is throughput-bound on logical CPUs, 8 looked low.
The prediction was written before the run and it decides a class of work:

  C scales with threads  -> compute-bound, per-op kernel work can pay
  C flat or worse        -> memory-bound, and every kernel idea that does not
                            reduce BYTES MOVED is dead before it is written

Three alternating matched pairs, op profile on both arms, no intruders in any
of the six:

| threads | spec tok/s | median |
|---|---|---|
| 8 | 19.37, 19.47, 19.92 | **19.47** |
| 16 | 11.18, 8.67, 12.37 | **11.18** |

Doubling the decode threads costs 43%. Both arms held local=0 constant,
identical=True and diverged=0, so this is a throughput result and not a
correctness one. (th08-2's PLAIN pass was transiently slowed to 185 ms/token
while its spec pass was normal at 19.47; the plain median for that arm is
therefore not usable, the spec comparison is three clean matched pairs.)

So 8 threads is at or past the knee. I first wrote this up as "C is
memory-bound", on the dichotomy in the prediction -- scales means compute,
flat-or-worse means memory. That dichotomy was too coarse and the conclusion
was wrong, and the same op profiles distinguish the cases:

| | 8 threads | 16 threads |
|---|---|---|
| graphs / nodes | 34530 / 152070 | identical |
| shielded backend | ~67400 ms | ~69400 ms |
| **op_total (C)** | **1748 ms** | **2935 ms** |
| per node | 11.5 us | 19.3 us |

Memory-bandwidth saturation gives FLAT time as threads rise: the same bytes
move, just from more cores. C nearly DOUBLED, on an identical graph, while the
shielded side did not move. A cost that scales with thread count is
synchronisation, not bandwidth -- ggml parallelises within each op and barriers
at its end, and there are 152070 nodes per run to barrier across.

And the ops are tiny. The delta-net tensors are [128,48,2] -- 48 KB -- so
splitting one across 16 threads is barrier with no work underneath it. The
extra 7.8 us per node at 16 threads is the right order for a 16-way barrier on
this box.

That changes what is retired and what is opened. Kernel arithmetic was never
the thing; but neither is bytes moved, necessarily. The lever shape is FEWER
OPS or fewer barriers per op, and the curve peaks at or below 8 with nobody
having looked to the left of it.

For scale, the biggest tensors in that graph: the delta-net recurrent state is
786432 floats -- 3 MB per layer -- and the worst CPY observed is a 6 MB
`cache_s_l61 (view) (copy of (view))`. CPY at 1.312 ms/token and CONCAT at
1.186 are 20% of C in pure movement. But those are a handful of large ops among
152070 nodes, and the thread result says the many small ones are where the
synchronisation goes.

### 18.15 Both halves are now measured, and neither can pay

| | ms/token (marginal, 64->192 context) |
|---|---|
| decode wall | 53.6 |
| shielded backend (wall) | 29.0-35.8 |
| CPU backend ops (C) | 12.3 |
| in neither counter | 6.1-11.7 |

25 tok/s needs 40 ms. Finding 13.6 ms in the shielded half was already shown
impossible: everything still touchable there (join 2.7, rhs 2.0, mask 1.7,
unmask 1.4, check 0.14) sums under 8 even at zero. Finding it in C needs
delta-net, CPY, CONCAT, MUL_MAT and attention together, and C is memory-bound
so they do not yield to better kernels. Both halves are now measured rather
than one argued.

What the arithmetic does say is that C is almost exactly the gap: 53.6 - 12.3
= 41.3 ms is 24.2 tok/s, and at the N=64 token (48.5 ms) removing C gives 36.2
ms, or 27.6 tok/s. So the target is reachable if C is HIDDEN rather than
removed -- overlapped with the exchange, which is GPU-latency-bound and uses a
different resource entirely.

That is not available today and the reason is structural, not a missing knob.
Within a layer the order is exchange(QKV) -> CPU(rope, attention) ->
exchange(O) -> CPU(norm, residual) -> exchange(gate,up) -> CPU(swiglu) ->
exchange(down), strictly alternating by data dependency, and the ggml scheduler
runs each backend's subgraph in that order. There is no independent CPU work to
run during an exchange within a token, and speculative decoding does not
supply any either: the draft for round N+1 needs the token round N verified.
Overlap would need cross-layer pipelining, which is a scheduler change and
changes the order of computation, and it is the only remaining item of the
required size that does not touch the model, the precision, the workload or
the protections. The unexamined "neither" bucket at 6-12 ms/token is the other
place of that size and is next.

### 18.16 Spec-only C, after four corrections to the instrument

The audit's objection to C=12.29 was right twice over: it was blended across
the plain and speculative paths, and it was per MARGINAL token (64->192), which
is a slower token than the one the target is defined on. Fixing it took four
corrections, three of them to instruments I had written that day.

1. `opdiff.py` divided by 128 where the delta spanned 256 tokens on two paths.
2. The first per-phase window baselined at `dumps[idx+1]`, throwing away a
   whole tick of speculative decode while still dividing by all 64 generated
   tokens -- a truncated numerator over an untruncated denominator. That is
   what produced 10.227 ms/token, which was 23% low.
3. Coverage was never stated. It is now bounded and printed per run.
4. The lazy `getenv` init I added was a data race: every compute thread tested
   and wrote `g_eop_on` and `g_eop_every`. Same value stored by every writer is
   still a race under the C memory model. Moved into a constructor that runs
   once before any worker exists. (The accumulators remain ith==0-only, which
   is safe for one threadpool and not for two; stated in the source rather
   than assumed away.)

Three runs, tick every 200 graphs, coverage >= 98.4% (raw and coverage-scaled
figures now differ by 1.6%, so the bracket is tight):

**C = 13.253 ms/token** (12.784-13.495), work 10.201, thread-0 idle 3.052.

| op | ms/token | work | idle | idle% |
|---|---|---|---|---|
| GATED_DELTA_NET | 5.094 | 4.372 | 0.723 | 14% |
| CPY | 1.697 | 1.144 | 0.553 | 33% |
| CONCAT | 1.039 | 0.609 | 0.432 | 42% |
| RMS_NORM | 0.751 | 0.656 | 0.095 | 13% |
| UNARY | 0.745 | 0.547 | 0.197 | 27% |
| MUL_MAT | 0.743 | 0.554 | 0.189 | 25% |
| SSM_CONV | 0.670 | 0.510 | 0.161 | 24% |
| GET_ROWS | 0.623 | 0.401 | 0.222 | 36% |

The "idle" column is thread 0 waiting at the end of a node. It is NOT a
recoverable saving and must not be subtracted from wall time: the other threads
are working or descheduled during it. It bounds intra-op imbalance and nothing
more. Also note GATED_DELTA_NET takes an extra barrier INSIDE the op, to
publish the chunk counter, and that one lands in the work column rather than
the idle column.

Also measured, and the more structural number: 152070 nodes over 34530 graph
executions is **4.4 nodes per CPU subgraph**. The CPU backend is entered ~193
times per speculative token, because the shielded backend claims the matmuls
and the two alternate all the way down each layer.

**What this does to the budget.** These runs averaged 19.91 tok/s = 50.23
ms/token, so 25 tok/s needs 10.23 ms. C is 13.25. So C is LARGER than the gap,
which reverses what the truncated figure implied: hiding C entirely gives 27.04
tok/s, and hiding about three quarters of it reaches 25.

That is a ceiling, not a plan. The only mechanism that hides C rather than
removing it is overlapping the CPU backend with the exchange, and within a
layer the two alternate by data dependency. It remains the single item of the
right magnitude, and nothing measured since has displaced it.

And a measurement-hygiene note: the profiler dump now carries its own build
stamp (`[opprof/v2 Sep 22 2026 07:38:04]`). Earlier I rebuilt a library, got
rc=0, and the running process still loaded a different copy -- caught only
because the OUTPUT FORMAT was old. The artifact now states its identity, so
"which binary produced this" is verified rather than inferred. The build tree
itself is worth recording as fragile: `bench-spec2` loads `libggml-cpu.so` from
THIS session's scratchpad, whose CMake cache was copied from another session's
and whose link rule still writes into that other tree -- so `make` in the
obvious place silently updates the wrong artifact.

### 18.17 The noise floor, and what it forbids

The first concrete change chosen from the C profile was delta-net chunking.
GATED_DELTA_NET splits nr rows into nth*4 dynamically-scheduled chunks, each
taken with an atomic; at decode nr is about the head count, so 8 threads get
~24 chunks of one or two rows. Handing each thread one chunk cuts that to ~8
atomics (it does NOT remove chunk_set or the barrier inside the op, so any gain
is only the atomics). The same rows are computed either way, so output must be
bit-identical -- and was.

Four clean matched pairs, the fifth dropped entire because one arm recorded an
intruder. Both arms verified from their own artifacts: exit status, refusals,
local fallback, verify_fail, obs_fail, output equality, and the same workload
(k=1, prompt 17, 64/64 generated, 43118 offloaded).

| pair | control | chunked | delta |
|---|---|---|---|
| 2 | 19.27 | 18.62 | -3.4% |
| 3 | 18.84 | 19.06 | +1.2% |
| 4 | 18.97 | 20.29 | +7.0% |
| 5 | 20.43 | 18.57 | -9.1% |

Two of four favour the change, mean -0.24 tok/s. No effect. REVERTED, with the
result recorded at the call site so the next person does not retry it.

**The spread is useful for planning.** Paired SD across these four pairs is
1.35 tok/s on a 19 tok/s baseline. Taking that at face value, and assuming
roughly normal paired differences with n ~ (2*SD/effect)^2 -- about 95%
confidence at ~50% power, which is a rough planning rule and not a proper
power calculation:

| effect | paired runs, order of | bench time |
|---|---|---|
| 2% (0.38 tok/s) | ~50 | 3.3 h |
| 5% (0.95) | ~8 | 0.5 h |
| 10% (1.90) | ~2 | 0.1 h |

SCOPE, because an earlier draft of this section overstated it. An SD from four
pairs has three degrees of freedom and its own confidence interval is wide, so
this is a rough estimate of variability on this box under tonight's conditions,
NOT a fixed hardware noise floor. It does not forbid small improvements, and
failing to detect one does not show it is absent -- the chunking change may be
worth something I cannot see from four pairs. The table is guidance for
choosing what to spend bench time on, not an impossibility bound.

What it does say is that measuring a 2% change individually is expensive here,
so the cheaper route for small candidates is to combine several into one
prototype and test the COMBINATION against a correctness-checked baseline,
rather than demanding each constituent clear significance alone. Larger effects
remain the better place to start, and the gap to 25 is 22%.

The largest single candidate measured this session is hiding C under the
exchange, at 13.25 ms of a 50.23 ms token. That 13.25 is an upper bound on what
overlap could hide and must not be assumed wholly hideable: it counts CPU work
that may have no exchange in flight beside it, and any realised saving has to
be measured, not subtracted. The other items found -- the reply check at 0.3%,
the join at 5.7%, thread counts, pinning, chunking -- are individually small
enough that they are better evaluated combined than one at a time.

### 18.18 Only a quarter of C has an exchange to hide under

Hiding C was the last candidate of the right size, and 13.25 ms/token was
always an upper bound: it assumes every CPU op has an exchange in flight beside
it. That is now measured against the real dependency graph instead of assumed.

`GGML_SCHED_DEBUG=2` dumps the scheduler's splits and every node's sources. A
decode forward pass is 2005 nodes in 642 splits -- 321 shielded, 321 CPU,
strictly alternating -- with 1604 nodes on the CPU. Parsing that gives the DAG,
and a greedy simulation walks it in split order: at each exchange, fill the
window with CPU nodes whose sources are already computed and which have not
been run yet. Nodes are CONSUMED, which the naive per-exchange independence
count misses -- a node hidden under exchange 3 is not available again for 4.

Cost model covers 1604 of 1604 CPU nodes and totals 12.90 ms/token against the
measured 13.25, a 97% agreement that is the check on the whole exercise.

| wire per token | window per exchange | cost hidden | nodes | realised |
|---|---|---|---|---|
| 10 ms | 55 us | 27% | 635/1604 | 3.63 ms |
| 14 ms | 78 us | 28% | 640/1604 | 3.65 ms |
| 18 ms | 100 us | 28% | 640/1604 | 3.65 ms |

**It saturates.** Widening the window from 10 to 18 ms per token moves five more
nodes. The binding constraint is the dependency chain, not the size of the
window -- there simply is not more independent CPU work in a transformer decode
step, because each sub-block consumes the previous one's output.

So overlap is worth **3.65 ms/token, not 13.25**: 50.23 -> 46.58 ms, about
**21.5 tok/s**. And that is optimistic, because the simulation lets a node move
anywhere earlier with no buffer-reuse constraint and charges nothing for the
synchronisation that real overlap would need. The true figure is below it.

Three caveats, since this is the argument that closes the largest candidate.
Per-node costs are op averages rather than per-node truth. The graph is one
decode pass, and the draft pass (37 nodes) is not modelled. And the parse had
two defects I had to find first: source names carry annotations like
`(reshaped)`, and a naive "token before the size" grabbed the annotation and
silently dropped 22.8% of the dependency edges, which inflated independence;
and the dump pads op names to a fixed width, so `GATED_DELTA_NET` arrives as
`GATED_DELT` and the single largest op was excluded from the cost model until
the alias was added. Both were caught by the modelled total disagreeing with
the measured one -- which is the only reason that cross-check was worth
computing.

### 18.19 RETRACTED: the overlap estimate rested on unresolvable dependencies

18.18 is withdrawn. The number (28% of C hideable, 3.65 ms/token, 21.5 tok/s)
should not be used, and in particular it must not be used to conclude that
overlap cannot reach 25.

Three faults, each sufficient on its own.

**The dependency graph was not reconstructed.** `GGML_SCHED_DEBUG` truncates
tensor names to 20 characters, so `blk.0.attn_norm.weight` arrives as
`blk.0.attn_norm.weig`. My lookup missed those and my code treated an
unresolved source as an always-available leaf -- which makes a node look ready
when it is not. 1275 distinct names were unresolved. Truncating both sides to
match raises resolution only to 60.3%, and 128 truncated names are produced by
SEVERAL nodes each (`norm-0` by nodes 1, 41 and 51), because ggml reuses names.
So even the resolved edges are ambiguous. Name-based reconstruction from this
dump cannot work, and the fraction of edges I silently dropped is larger than
the effect I was measuring.

**The cost agreement was circular.** I divided each op's measured total among
its nodes and summed back, which recovers the input by construction. It checked
only that every op had a cost entry -- which is how it caught the truncated
`GATED_DELT` alias -- and validated nothing about per-node costs, dependency
parsing or the schedule. Calling it "the check on the whole exercise" was
wrong; it could not have failed for any reason except missing coverage.

**The units were inconsistent, in the flattering direction.** COST is ms per
GENERATED TOKEN; I used COST/nper as a per-node, per-forward-pass cost while
dividing the exchange window by verify-passes-per-token. Per-node costs were
therefore about 1.78x too small against the window, so more nodes fit than
would really fit, and 28% is an overestimate even before the dependency fault.

And a scope error on top: a greedy fill is a heuristic, not a bound. A
different order or partition could hide more, so even a correct version of this
simulation could not have closed the candidate.

What the exercise does leave standing: the decode pass really is 2005 nodes in
642 strictly alternating splits, 321 shielded and 321 CPU, 1604 nodes on the
CPU. That is a structural count straight off the dump and does not depend on
any of the broken inference.

A sound version needs source INDICES rather than names -- pointer identity
inside ggml, where it is unambiguous -- and consistent per-pass units with the
draft pass accounted separately from verify. That is a small instrument change,
and until it exists there is no measured statement about how much of C is
hideable.

### 18.20 Redone with indices: the overlap candidate is NOT closed

The retracted analysis used truncated, reused tensor names. `ENCLAVE_GRAPH_DUMP`
now prints each node's sources as INDICES by pointer identity inside ggml, where
-1 means genuinely not produced in this graph. No name matching anywhere, no
unresolved edges.

Decode-phase verify pass: 3365 nodes, 642 splits (321 shielded, 321 CPU), 2724
nodes on the CPU. For each CPU node, ready(n) is the largest index among its
in-graph sources and needed(n) the first shielded node reachable from it; n can
overlap exchange E only if E falls entirely inside that interval.

**Upper bound: 82% of modelled CPU cost**, 10.84 of 13.25 ms/token. That would
put the token at 39.39 ms, or 25.38 tok/s.

So the bound does NOT exclude 25, and the retracted 18.18 would have closed a
candidate that is still open. That is the more important correction of the two.

**The bound is loose, and here is exactly how.** Checking one case instead of
trusting the aggregate: node 39 is a GATED_DELTA_NET with ready 38 and first
shielded consumer 48, and the exchange at [43,45) sits inside that gap. But its
actual consumer is node 40 -- a CPU node before that exchange. Deferring 39 into
the window therefore requires deferring 40, 41 and 42 as well, and they must all
fit. Because `needed` tracks only the first SHIELDED consumer, the criterion
permits arrangements that are not individually realisable. It over-permits,
which keeps it a valid upper bound while making it a weak one. All 48 delta-net
nodes are counted hideable on that basis and none of them may be in practice.

What is solid: the structural counts, that no edge is now guessed, and that
nothing measured so far rules 25 in or out by way of overlap.

**What a prototype would need**, stated so the next attempt does not start from
this report's optimism: the ggml scheduler runs one backend subgraph at a time
to completion, so overlap needs the shielded backend to return before its
exchange finishes and the scheduler to run an independent CPU subgraph against
a not-yet-complete dependency. That touches buffer lifetimes -- a deferred
node's inputs must stay live across the window -- and it must not disturb pad
freshness or verification-before-use, since the reply is not trustworthy until
Freivalds passes and no deferred CPU work may consume it beforehand. And with a
paired SD of 1.35 tok/s, a prototype worth less than ~5% could not be
distinguished from noise without hours of pairs, so it is worth building only
for the large version, not a single-region pilot.

### 18.21 Pilot: the idle window is 86-92 us per exchange, measured

Every figure for the overlap budget so far has been a projection off `wire`.
This measures it. `sh_pipe_ring_exchange_work` calls the work callback (the
Freivalds RHS, when SHIELDED_OVERLAP_VERIFY is on) and only then starts its
spin, so the spin is exactly the window STILL idle after existing overlap has
taken its share. Timing it costs one extra clock_gettime per exchange, about
0.25 ms across a 125 s run.

One run, 64 tokens, spec 19.21 tok/s, identical=True, local=0, no refusals:

| | card 0 | card 1 |
|---|---|---|
| exchanges | 9904 | 9904 |
| idle spin after the RHS | 850.2 ms | 912.5 ms |
| per exchange | 85.8 us | 92.1 us |

CORRECTION: the per-token figure first written here (~6.6 ms/token) was wrong
and is withdrawn. The counters live on the PIPE, and the pipe is recreated
between the plain and speculative phases, so they reset mid-run: idle_n tracks
exchanges to 16382 at exchanges=16384, then restarts and ends at 9904 while the
backend's own exchange total reaches 27638. The final 850.2/912.5 ms is one
pipe's lifetime, not the run's, and dividing it by the 128 tokens both phases
generated divides a part by the whole.

What survives is the per-exchange figure, and it survives well because it is
consistent across the two independent pipe lifetimes: 1385.1 ms over 16382
exchanges in the first (84.6 us) against 850.2 ms over 9904 in the second
(85.8 us). So **the idle window is 85-92 us per exchange**, and that is the
measured result.

Converting it to a per-token budget needs decode-only exchange counts bound to
a phase, which these counters do not provide -- they are not bound to prefill,
warmup, pipe lifetime or generated count. Until they are, there is no justified
per-token idle figure, and the ~14 ms projected from wire is not replaced by a
number, only shown to have been a projection.

These are also PER-CARD wall times and the two cards wait CONCURRENTLY, so they
must never be added as if sequential. They include descheduling and clock
overhead, and they omit exchanges that timed out onto the socket entirely.

Instrumentation cost, measured rather than assumed: clock_gettime(CLOCK_MONOTONIC)
is 20.7 ns per call on this box over 2e6 calls, and the change adds exactly one
call per exchange (t0 already existed), so 9904 exchanges cost 0.24 ms.

So the honest statement is: 85-92 us of idle per exchange, measured, and no
defensible per-token total until the counters are phase-bound. That is less
than I claimed and more than I could previously support.

### 18.22 A silent rejection cost forty minutes, and now it names a reason

Rebuilding the shielded backend produced a library that refused every worker
pool: "invalid worker pool; all operations stay on CPU". I suspected, in order,
my own instrumentation, an ABI mismatch between two llama.cpp trees whose
ggml.h differ by 4 KB, uncommitted source, a missing ring file, and committed
changes the shipped .so predated. I built a worktree from before my edits to
bisect it. All wrong.

The cause: `/dev/shm/...` ring paths are accepted only in a build carrying
`SHIELDED_EXTRA_DEFS=-DSHIELDED_ALLOW_DEV_SHM_RINGS`. Production takes the
root-owned `/dev/enclave-shielded-shm/` path and nothing else. That is a
security control working exactly as designed -- the ring is world-writable
under /dev/shm, so a bench box opts in explicitly -- and my rebuild simply
omitted the documented bench flag.

What made it expensive is that the refusal named no reason, and the reason is a
COMPILE-TIME property invisible in the config string being rejected. The eight
rejection sites now each say why, including that one by name with the flag to
set. The control is unchanged; only its diagnosis is.

### 18.23 Overlap pilot: the window works, the early execution does not

Built, opt-in, default off, and reversible: `SHIELDED_OVERLAP_CPU`.

**Mechanism.** `sh_link_set_idle_work` registers a callback on a link. It runs
inside the exchange's existing idle window -- after the request is published,
before the ring spin -- under the same contract the Freivalds RHS already
uses: exactly once per exchange, never touching the pipe, never reading reply
bytes. The backend fills it with local residual/norm islands (the ops
`SHIELDED_FUSE_LOCAL` already claims) selected in graph order.

**Selection, which is where the safety argument lives.** An island is eligible
only if every tensor it reads is already produced -- not just the MUL_MAT it
fuses. Such an island consumes a product that has already been unmasked and
Freivalds-verified, so running it early cannot consume an unverified reply;
that is a property of the selection, not of the timing. It is registered on the
primary card's link only, so with a column split it stays single-threaded
rather than needing a claim protocol between cards.

**Result, by bisect rather than assertion.** Two modes, same selection:

| mode | what the window does | outcome |
|---|---|---|
| 2 | registers, fires, computes NOTHING | rc=0, spec 18.24, identical=True, local=0, verify_fail=0, 3 windows fired |
| 1 | registers, fires, computes the island | fails at warm prefill, graph status -1 |

So the window mechanism is sound and demonstrably fires with real work
selected -- `batch=1 at node 0 m=17`, `window fired, 1 items` -- and what fails
is executing THIS work out of graph order. Mode 2 reaching decode (`m=1`) while
mode 1 dies at prefill isolates it to the execution, not the hook.

**Why it fails is not yet established.** The obvious candidate is ggml's
allocator: it reuses tensor memory assuming nodes run in graph order, so a node
moved earlier can write a range still live for something else. I added a guard
refusing any island whose bytes overlap an output of the in-flight exchange and
it did not help, which rules out that one case and no more -- a third tensor
can be live in the range and the allocator does not expose liveness. The other
open candidate is that `sh_fusion_compute_local` has preconditions tied to its
normal call site that I have not enumerated.

**What the pilot is worth.** It fails CLOSED: the graph aborts, no wrong output
is produced, and with the flag unset the tree behaves exactly as before
(pil-off-1: spec 19.05, identical=True, local=0). It establishes that the
window is real and usable, and it locates the obstacle precisely -- out-of-order
execution under an allocator that assumes order, not dependency analysis, which
was the thing I had been treating as the hard part. Any further attempt needs
allocator cooperation (liveness, or a node pinned to its own buffer), and that
is a ggml change rather than a backend one.

Two mistakes inside the pilot worth recording. The first eligibility check
looked only at the fused MUL_MAT and not at the residual side of the add, and
the graph failed closed on warm prefill -- a pointer edge says what is read, it
does not say it is ready. And the replacement scanned the node array for every
candidate and every tensor it reads: O(n^2) per exchange, tens of billions of
comparisons over a 3799-node graph and 321 exchanges, killing the run before a
single island was scheduled. An eligibility test that costs more than the work
it schedules is not an optimisation.

### 18.24 The pilot's failure was mine, not the allocator's

18.23 named ggml's allocator as the candidate cause and treated the mode-2
bisect as narrowing to it. Both were wrong, and an independent review found the
actual defect.

**`done` means SCHEDULED, not produced.** The gathering loop marks the whole
activation group done before the exchange is issued -- `done[j] = 1` while
collecting siblings, `done[i] = 1` immediately after, both well before
`sh_split_exchange`. My selector read `done` as "produced and verified". So it
offered the hook work that reads a product still on the wire. The pilot's own
log said so and I did not read it that way: `batch=1 at node 0 m=17` is an
island selected against the matmul in flight beside it.

That invalidates the safety claim in 18.23 as stated. The selection did not
establish what I said it established.

**Repaired:** a separate `produced` map, set only after an output exists -- for
the offloaded path only after the exchange returned SH_OK and the post step
reconstructed the result. Reads follow the `view_src` chain, so a reshape of an
in-flight tensor is caught, and there is an independent guard that refuses any
read aliasing a member of the group in flight regardless of bookkeeping.

**With the repair, the run passes**: rc=0, spec 19.57, identical=True,
obs_fail=0, local=0, verify_fail=0. So the mode-1 failure was the readiness
defect, not the allocator. The allocator hypothesis is withdrawn; it was never
tested, and the one guard I did add against it (refusing overlap with this
exchange's outputs) changed nothing because it was aimed at the wrong thing.

**And the repair costs the pilot its work.** Zero islands are now eligible, and
that is structural rather than a tuning threshold: a local island matches
`add(matmul_result, residual) -> rmsnorm -> gamma`, so it is BY CONSTRUCTION
immediately downstream of a matmul. The only exchange it could overlap is the
one producing its own input. The claimable class is exactly the wrong class for
overlap, and no amount of care in the selector changes that.

So the pilot stands as: mechanism built and proven to fire, readiness rule now
correct, default off, and yielding nothing -- because the work the backend is
allowed to claim can never be independent of the exchange in flight. Real
overlap needs a class the shielded backend does not currently own, which is the
CPU-backend nodes the earlier graph analysis counted.

Two corrections to how 18.23 reported itself. The mode-2 bisect established
that executing early triggers the failure; it did not establish the allocator
as the cause, and I wrote it as though it had narrowed further than it did. And
"3 windows fired" was a log capped at three prints, not a callback total --
a count of how often I had allowed myself to be told, quoted as a measurement.

### 18.25 Why zero islands are eligible, with the reason measured

18.24 said the claimable class is "by construction immediately downstream of
the matmul in flight". That was an assertion and it is wrong. Counting the
selector's decisions on a full run:

    overlap selector: pattern=192 taken=0 rejected: in-flight=0 not-ready=192 alias=0

192 islands match the pattern, so the class is not absent. None is rejected as
in-flight -- the guard I wrote for the reason I gave fires zero times. All 192
are rejected because a tensor they read has not been produced.

The real reason is the search direction. The selector scans FORWARD from the
node being exchanged, so every candidate lies ahead in the graph and its
matmul has not been issued yet. And nothing eligible can lie behind: the main
loop is greedy in graph order, so any island whose inputs were complete has
already been computed at the point it was reached. An in-order greedy loop
leaves no ready work behind it, and everything ahead of it is waiting on work
not yet done.

So the outcome -- zero eligible -- is CONSERVATIVE REJECTION with a structural
cause, and the cause is the scheduling discipline rather than the op class.
That distinction matters because it says where to look next: not at a different
claimable op, but at work that is ready and has been DEFERRED, which requires
something that defers.

**Consequence for safety, stated plainly.** Because nothing is ever selected,
the early-compute path is never exercised. The repaired readiness rule is
therefore unvalidated by any run: pfix-1 and psel-1 pass with matching output
and zero fallback, but they pass without ever taking the branch in question.
The pilot stays default off, and it must not be enabled on the strength of
those runs. The focused tests the review asked for -- a positive case with
already-verified disjoint inputs beside an unrelated exchange, and rejection of
grouped producers, reshape aliases and a rejected reply -- cannot be built from
the real graph, because the real graph never presents a positive case. They
would have to construct one synthetically against the predicate, which means
extracting the predicate from the loop it currently lives in. That is not done,
and until it is, "the readiness rule is correct" is a claim about code I have
read, not about code that has run.

Also corrected: meta nodes (RESHAPE, VIEW, PERMUTE, TRANSPOSE) are skipped by
the main loop and never marked produced, so a rule keyed on `produced` treats
them as unready forever. That did not cause this result -- the 192 rejections
are the forward-scan effect -- but it is a second way the rule is conservative
beyond its intent, and it would have to be fixed before any positive case could
pass.

### 18.26 The predicate, extracted and tested, and a correction to the correction

The readiness rule now lives in `wasm/ggml-shielded/shielded-overlap.h` and is
exercised directly by `test/shielded-overlap-ready.test.mjs`. It had to be
extracted because the real graph never presents a positive case, so no full run
could ever take the accept branch: every "passing" run passed without touching
the code in question.

Sixteen checks: a positive case (completed, disjoint sources beside an
unrelated exchange), the current exchange's matmul, a grouped sibling, a
reshape alias at one and two hops, a node not yet produced, a tensor this
subgraph does not own, a rejected reply turning a previously-ready read
unready, and a node appearing among its own reads.

**The tests found a real defect on their first run.** A VIEW node computes
nothing, so the main loop skips it and never marks it produced -- and the rule
asked whether the view had run. Every read reaching a tensor through a reshape
was therefore rejected forever, which would have made a positive case
impossible in the real graph no matter what else was fixed. Producedness is now
asked of the ROOT of the view chain, which is the question that was meant:
do the bytes exist. In-flight is still asked of every link, because a reshape
of a live tensor IS the live tensor.

**And the counters were lying, which means 18.25 was wrong.** They shared one
loop with an early break on `!produced`, and an in-flight matmul is always also
unproduced, so in-flight could never be recorded. `in-flight=0` was an artifact
of the test order. Computed independently on the same workload:

    overlap selector: pattern=192 taken=0 rejected: in-flight=192 not-ready=192

Every candidate visit depends on the live exchange AND has an unproduced read.
So 18.24's original claim -- that a local island is by construction downstream
of the matmul in flight -- was right, and 18.25's "it is really the forward
scan" correction was derived from a broken instrument and is withdrawn. I
corrected a true statement into a false one on the strength of a counter I had
written badly, which is worse than the original error.

(These are candidate VISITS, not distinct islands: a node is visited once per
exchange scan, so 192 is a count of rejections, not of islands in the graph.)

The conclusion stands where 18.24 left it: local islands cannot overlap the
exchange that produces their input, so the class the backend may claim is the
wrong class, and real overlap needs work the backend does not currently own.
The pilot remains default off; with the view rule repaired it still selects
nothing on this workload, and the accept branch remains unexercised outside
the unit test. Runs: psel-2 spec 18.63, identical=True, local=0, verify_fail=0.

### 18.27 Both routes ruled out by measurement, and what the exchange actually is

**Overlap, tight bound.** 18.20's 82% used the first SHIELDED consumer, which
permits deferring a node past its CPU consumers. Recomputed on the same index
dump with the first consumer of ANY kind -- the only bound a real schedule
could respect -- the eligible set is 687 of 2724 CPU nodes and **20% of CPU
cost, 2.58 ms/token**. Against the 11.10 ms that 25 tok/s needs from a 51.10 ms
token, and before any cost for private scratch, commit, or synchronisation. The
eligible set is also mostly VIEW (160) and RESHAPE (143), which compute
nothing. The route cannot reach the target and is closed on evidence, not on
difficulty.

**Exchange count.** 180.6 exchanges per token at 86 us of idle each is 15.53
ms/token per card, and halving it would be 7.76 ms -- the right magnitude. But
the count is already at its structural floor. The offloadable weights per layer
are attn_qkv/attn_gate/ssm_alpha/ssm_beta (one group, one activation),
ssm_out, ffn_gate/ffn_up (one group), ffn_down: four exchanges, and their
inputs are sequentially dependent through the layer -- norm, then the
recurrence, then the post-attention norm, then swiglu. 65 blocks x 4 is the
observed count. Nothing is grouped that could be, so there is no merge to make
without changing what the model computes.

**And the exchange is not what I assumed.** The worker's own accounting is
1069.7 ms of GEMM over 9906 exchanges: **108 us each**. At m=2 a decode
exchange is 357 MFLOP-equivalent, about 6 us of arithmetic on a V100 -- 18x
off. It is not compute at all. One ffn-sized matmul reads 85 MB of int8 weights
to do that work, an arithmetic intensity of 4 ops/byte, and 85 MB at HBM2
bandwidth is 99 us against the 108 measured.

So the shielded exchange streams the weight matrix from VRAM, and at batch 2
there is nothing to amortise it against. Per token the two cards read the whole
27 GB model once: 15.0 ms at nominal bandwidth, 19.4 ms measured. The GPU side
is at a hardware floor that no protocol, grouping or scheduling change moves --
only a smaller model, a wider batch, or more bandwidth, and the first two are
excluded by the workload and the third is not available.

**Where that leaves the budget.** GPU weight streaming ~19 ms/token, C 13.25
ms/token, both measured, serial because overlap is bounded at 2.58 ms. Their
sum is ~32 ms against a measured 51.10 ms token, so roughly 19 ms is in neither
and remains unattributed -- the same bucket 18.13 could not pin down. That gap,
not the two floors, is now the only place a lever of the required size could
still be hiding, and attributing it needs counters bound to phase and pass
rather than another estimate.

### 18.28 Phase-bound attribution, and the denominators that were wrong

The per-pipe idle counters reset between phases, so they could not be divided
by anything. They now accumulate on the LINK, folding each pipe's delta in
after every exchange and treating a value lower than the last as a fresh pipe.
And `SHIELDED_PHASE_TRACE=1` emits one CUMULATIVE record per graph_compute --
card, wall clock, m, graphs, nodes, exchanges, idle, link, graph -- so any
window is the difference of two records and no reset can corrupt it.

Segmenting by wall gaps and by m gives the phases directly: m=17 is prefill,
m=1 plain decode, m=2 a speculative verify pass (k+1 rows).

**PLAIN decode, card 0, 64 tokens, one pass per token:**

| | per pass = per token |
|---|---|
| graphs | 321.0 |
| **exchanges** | **257.0** |
| idle spin | 17.95 ms |
| link (inclusive of idle) | 33.18 ms |
| graph_compute (inclusive of link) | 37.09 ms |
| idle per exchange | 69.8 us |

**Two of my own figures were wrong and are corrected here.** 257 exchanges per
pass, not the 180.6 I quoted -- that number multiplied a per-card split count
by a passes-per-token ratio and belonged to neither denominator. The review's
65 x 4 = 260 is what the measurement shows. And the "roughly 19 ms in neither
counter" was the same kind of error: reconciled properly, on one path with one
denominator, it is 5.61 ms.

**The plain token, inclusive relations stated:**

    token                            55.95 ms   (bench, 1 pass = 1 token)
      shielded graph_compute         37.09      includes link
        link                         33.18      includes idle
          idle spin                  17.95      257 exchanges x 69.8 us
      outside the shielded backend   18.86
        CPU-backend ops (C)          13.25      measured separately, 18.16
        neither backend               5.61      framework, scheduler, sampling

5.61 ms over 642 backend invocations per pass (321 shielded + 321 CPU) is 8.7
us per split, which is a plausible scheduler cost and not an anomaly worth
chasing.

These are CARD 0 figures. Card 1 runs concurrently and its times must not be
added to these.

**What it says about 25 tok/s.** 15.95 ms must come off a 55.95 ms token. The
four components are 17.95 (GPU wait), 15.23 (TEE-side link CPU: mask, unmask,
Freivalds, range check, pads), 13.25 (C) and 5.61 (framework). No single one
covers it. The GPU wait is weight-streaming bound (18.27). C is delta-net
bound (18.18). The framework term is too small. That leaves the TEE-side link
CPU at 15.23 ms/token as the largest item whose internals have not been
attacked since the SIMD work early in this campaign, and it is the next thing
to break down per term rather than in aggregate.

### 18.29 The logger, repaired twice, and an overhead I still cannot price

Two defects in the instrumentation, both found by review, both real.

**The idle fold could not detect a reconnect.** `sh_link_start` replaces the
pipe but the fold kept the stale baseline, and the "a lower value means a new
pipe" heuristic fails whenever the fresh pipe's first sample is HIGHER: old
100ns/1, new 150ns/1, and it credits 50ns/0 instead of 150ns/1. A value cannot
tell you which counter produced it. The baseline is now reset explicitly where
the pipe is replaced, totals retained. Extracted to `shielded-idle.h` with nine
checks covering higher, equal and lower first samples after a reconnect, a
zero-idle reconnect, and an unannounced decrease.

**The buffered trace was a use-after-free on every normal exit.** I registered
`atexit(flush)` from one function-local static initialiser while the buffer was
a function-local static constructed in another. Destructors and exit handlers
run in reverse order of construction, the buffer was constructed second, so it
died before the flush read it. The buffer is now a deliberately leaked
allocation with no destructor, constructed BEFORE the handler is registered;
appends are mutex-guarded rather than assumed single-threaded; and dropped
records are counted and reported so a truncated trace cannot claim a full
window. The test runs the shipped structure to normal exit under ASan, and I
checked it is not inert: the original ordering reproduces
heap-use-after-free in the same harness.

**And the overhead is still unpriced.** Three paired runs against an
uninstrumented arm yield ONE usable pair, +3.0%, which is nothing at a paired
SD of 1.35. One pair fell to rc=2, one to a peer's wasmtime at 99.6% on one arm
and an empty result on the other.

`pairs.py` accepted the rc=2 run. It globbed `q*.log` for rc and intruder
flags, so a queue driven by any other script had no rc visible and the run
passed because nothing contradicted it -- absence of a marker read as evidence,
which is the precise failure that file exists to prevent. It now reads every
log and REJECTS a run that no log records.

So the 5.61 ms residual in 18.28 remains an ESTIMATE and is not used to rule
anything out. Its two terms still come from different runs, and while the trace
no longer does I/O on the measured path, what remains of its cost is unmeasured.
The trace itself is sound where runs completed: 34531 records, 0 dropped -- and
the run that returned rc=2 had a valid result and a complete trace, so that
failure is on the exit path rather than in the measurement.

### 18.30 The TEE-side link term, broken down: 42% of it has no timer

18.28 left the TEE-side link work at 15.23 ms/token as the largest item never
attacked since the SIMD work. Breaking it down needed the phase trace to carry
the link profile's terms, so each one is divided by the same denominator as the
total. Plain decode is one forward pass per generated token, so that path is
used: the speculative path's round yields ~1+acc tokens across two passes and
invites exactly the denominator confusion this exercise exists to avoid.

Two runs, card 0, 64 tokens each, no instrumentation on the CPU backend:

| | ms/token | range |
|---|---|---|
| token (bench) | 55.809 | |
| graph_compute *(incl. link)* | 38.018 | 37.56-38.48 |
| link *(incl. idle)* | 33.567 | 33.09-34.05 |
| idle spin | 17.487 | 17.09-17.88 |
| **TEE-side work** = link - idle | **16.080** | |
| wire - idle (moving bytes) | 0.892 | |
| prologue (input range scan, ensures) | 0.566 | 0.46-0.67 |
| mask | 2.986 | 2.41-3.56 |
| unmask + lhs | 1.916 | 1.68-2.15 |
| Freivalds rhs | 2.847 | 2.32-3.38 |
| reply range check | 0.131 | 0.11-0.15 |
| pads | 0.062 | 0.06-0.06 |
| **accounted** | **9.400** | 58% |
| **untimed** | **6.680** | 42% |

Two things I expected and got wrong. Moving bytes is 0.892 ms, not the missing
chunk -- the ring reply is ~139 KB per exchange and I had it down as a
candidate. And the prologue, which I timed specifically because the input range
scan sweeps m*K int64 per exchange, is 0.566 ms.

So 6.68 ms/token of the TEE-side link path has no timer on it at all: more than
mask, more than the Freivalds rhs, and 42% of the term. Against the 15.8 ms
that 25 tok/s needs off this token it is the largest single attributable
target left, and it is attributable only in the sense that I now know where it
is NOT. What remains untimed inside `sh_link_gemm_stride` is the per-node loop
around the exchange, the descale and outlier work that the backend's t_post
does not cover, and the group/cache bookkeeping.

The instrumentation to find it is in place and costs nothing on the measured
path (records buffered, written at exit). Finishing the attribution is a matter
of placing three or four more timers, not of another estimate.

### 18.31 The untimed 42% found; four levers measured, none of them pays

**Where 18.30's untimed 6.68 ms/token went.** Inside `sh_link_gemm_stride`
the named phases account for 97.6% of its time. The untimed remainder is
OUTSIDE it: the split's card-0 post and the join (card 0 waiting for the
helper), which the link profile never saw. Timed on both sides now
(`sgemm/spost/sjoin` on card 0, `hgemm/hpost` and dispatch-to-start on the
helper). Helper start delay is 0.8-2.0 us per exchange: the handoff is not the
cost. The join is.

**The split rebalance does not pay, again, for the reason 18.9 gave.** In three
traced runs card 1's gemm was 6-17% slower than card 0's, all the same sign, so
`SHIELDED_SPLIT_WEIGHTS` looked worth a second try.

- 53/47 is INVALID, not slow. Card 0 holds 13.89 GB of a 14.73 GB cap at an
  equal split, 6% headroom, and 53/47 needs slightly more. 258 slice refusals,
  `local=210`, and the layer it lost was blk.64 -- the MTP head -- so spec fell
  to 1.9 tok/s. Verification stayed clean (verify_fail=0, identical text); the
  failure was placement, and it was loud in the log. It was NOT loud in the
  run's `.meta`, which counted only two refusal phrases (`refusalA=0
  refusalB=0`). The harness now counts every refusal form, local fallback,
  offloaded=0 and the CPU-only pool, and prints `VALID=NO` for any of them;
  `pairs.py` rejects the same set from the `.err` itself.
- 52/48 fits (local=0, no refusals). Two clean pairs survived (a peer's job
  intruded in pairs 3-4): -0.95 and +0.75 tok/s. Mixed signs, no effect.
- Why: within the EQUAL arm alone the card0/card1 gemm ratio ran 1.00-1.15 and
  the join 443-804 ms. The imbalance changes run to run with the config
  unchanged, so it is scheduling, and a static column share cannot follow it.

**The worker's yield-to-owner detector is not a lever.** On a quiet box it
fired 0-1 times per run, and `SHIELDED_YIELD=0` was not faster.

**The mask kernel is 4x slower in the run than alone.** Decode-only, card 0:
9.0 us per exchange at 8435 elements, 1.07 ns/element. The same function in
isolation (production codegen is identical to the microbench's) is 0.26
ns/element. Measured contributions: a busy SMT sibling 1.75x, the all-core
clock (3.6 vs 4.1 GHz) ~1.14x, pads cold from DRAM 1.2x. Slow calls (>20 us)
are few (75 of 16447 in plain decode), so it is uniformly slow, not a tail.
About 2x is unexplained. Its whole cost is ~2.3 ms/token plain and ~3.6
ms/round spec, so a perfect fix is worth ~2 ms/round: real, not the 25.

**A Freivalds failure I cannot explain.** One run of the phase-trace set
(`sterms-1`, pilot OFF) stopped with `blk.27.attn_q.weight: verification
FAILED` on card 0 during spec prefill and exited rc=2. It failed closed, as
designed. No CUDA error, no ring error, not reproducible in the next runs, and
not a deterministic field wrap (the same prompt passed before and after). The
two earlier failures this campaign were the overlap pilot corrupting its own
input, which Freivalds caught; this one had no pilot. It is open, and it is the
reason every run is checked for `verify_fail` and rc before its number counts.

**What the verify round is made of now** (decode-only, one traced run, 71.8
ms/round): link 44.7 (GPU/ring wait 21.6, join 5.7-6.9, mask 3.6, unmask 3.0,
post 3.1; the Freivalds rhs overlaps the wait), CPU ops + framework ~23.6.
25 tok/s needs ~67.

**Placing the two critical threads: faster verify rounds, no established
throughput gain.** 18.9 retired blanket `taskset` (it starved ~17 threads) and
predicted the join shrinks with MORE room for the critical threads, not less.
So this pins only card 0's link thread (also OpenMP's master) and the split
helper, each to its own core, and keeps every other thread off those cores and
their SMT siblings (`SHIELDED_CPU_MAIN=0 SHIELDED_CPU_HELPER=1
SHIELDED_CPU_REST=2-15,18-31`, opt-in, off by default, placement only).

First build, 4 valid pairs: verify 72.8-75.9 vs 79.2-83.3 ms/round -- faster
in every pair, and that is the term 25 needs -- but the draft doubled and spec
prefill went 29 -> 48 s, and spec throughput came out mixed (+1.06 mean, 3 of
4). The cause was mine: a thread inherits its creator's affinity, so every
helper started by a pinned thread (pad mint workers, Freivalds prepare jobs,
weight prefetch, bank, parwork) ran on that thread's one core. All six spawn
sites now go through `sh_thread_create`, which starts a helper on the rest
mask when placement is on and is `pthread_create` otherwise; the placement
report counts stragglers (any other thread whose mask touches a reserved
core), and it read 0 of 25 in every run.

Second build, 3 valid pairs (a peer's rustc/wasm-tools build contaminated the
third): +1.91, -1.51, +0.93 tok/s. Mixed signs, no effect. Spec prefill is 34
s, still 4.6 s over unpinned; the draft is back (4.0-4.8 ms/round, one 7.0).
With the spawn fix the verify rounds overlap: 72.4-77.6 pinned against
72.6-85.9 unpinned. What placement visibly does is narrow the spread -- valid
pinned runs 20.69-21.41 against 18.79-22.20 unpinned -- without moving the
centre. The unpinned arm's best run (22.20) is the highest of the set, so the
fast case is reachable without placement too; what makes a run fast is still
not identified.

Harness: every run is now judged by one validator (`validate.py`, scratchpad)
that requires `.json`, `.err` and `.meta` and every field it reads, so an
unknown observer, correctness or contamination state is a reject. The
previous `pairs.py` accepted a copied clean run with NO `.meta` (reproduced);
it now delegates to the validator, and the runner prints VALID only from it.

### 18.32 The GPU side, measured decode-only: the kernel is at the floor, the cards differ, and the pinning penalty was pads

18.31 estimated the GPU term from connection totals. This measures it.

**The kernel alone** (`--kbench27`, diagnostic build only: the 27B's decode
exchanges as one card of the column split sees them, Y in mapped host memory
as the ring reply is, clocks warmed first):

| per card, one pass (12.81 GB) | m=1 | m=2 | of peak HBM |
|---|---|---|---|
| card 0, Tesla PG500-216 (HBM 1107 MHz, ~1134 GB/s) | 14.07 ms | 14.77 ms | 80% / 76% |
| card 1, Tesla V100-PCIE (HBM 877 MHz, ~898 GB/s) | 16.50 ms | 17.26 ms | 87% / 83% |

- The planner's G is within 1.5% of the best forced G on every shape. There is
  no block-shape lever. The first bench showed the planner up to 20% slower
  than the same plan forced; that was the clock ramping after an idle gap,
  timed first, and it vanished once the clocks were warmed.
- Rotating the weights over 12 GB (TLB and DRAM-page reach of the real pass)
  and idling the card 130 us between launches (the real gap) together cost 3%.
- Running both cards at once equals running each alone: no shared-link or
  host-side contention between them.
- **The two cards are not the same part.** Card 0's HBM is 26% faster, and on
  every decode pass card 1 is 17% slower. That is the static half of the join.
  An ideal split would be ~54/46, worth ~1.3 ms/pass, and card 0 has 6% memory
  headroom; 18.31's 52/48 was within noise for that reason.
- Both cards are on PCIe 3.0 **x8**. The planes upload fits 6.4 us + 6.7 GB/s.
  An SM pull kernel in place of the copy-engine upload is byte-identical and
  saves only on `down` (-2.8 us card 0, -6.7 card 1): ~0.3 ms/pass. Not taken.

**The worker in the real run** (per-exchange rows from the diagnostic worker,
which now records ring exchanges too; m read from each request's size, so the
rows are decode-only). Card 0, verify (m=2): worker service 102.8 us per
exchange = upload 13.8 + kernel ~68 + launch call 13.8 + the rest; a tight
loop of the same graphs costs ~72 us. Pinning the worker processes to their own
cores did not move their service time (100.5 us), so the worker is not starved.

Per verify round the worker is busy ~28 ms and the TEE side between exchanges
~56 ms (mean gap 204 us). **Two thirds of the round is the TEE side.** That is
the same wall 18.30 found from the other end.

**Why pinning did not pay: it starved the pad refill.** Every pinned run missed
pads (10-12, with 265-442 ms minted on the calling thread); every unpinned run
missed none. The misses fall at the start of spec decode, when prefill has
drained the pools, and one lm_head pad minted on path is 25-37 ms. That is the
draft penalty exactly: the draft's mask window was 80.1 ms pinned against 2.6
unpinned, and the mask window is where an on-path mint is timed. The refill
threads are burst capacity, and pinning left them four fewer logical CPUs
to burst on.

**Waiting for reserved pads does not rescue it.** `SHIELDED_PAD_WAIT_US=30000`
waits for pads a refill thread has already reserved. A/B, 4 valid pairs,
unpinned default against pinned engine + pinned workers + pad wait: pinned
faster in 1 of 4 (-0.26, -1.67, +1.50, -1.01 tok/s). Every pinned arm still
missed 8-14 pads and spent 268-331 ms waiting before minting them anyway;
every unpinned arm missed none. Placement is closed on this box: the code
stays, opt-in and off by default, and the default layout is the best one
measured.

**The handoff is not the loss either.** In the same diagnostic run the TEE's
publish-to-reply is 111.2 us per exchange and the worker's service 102.8: the
ring notice both ways and the reply bytes are ~8 us. Rotating 257 distinct
graph executables (production's count) instead of a few adds 1-3 us. In
production the worker's service is ~86 us against the tight loop's ~72; that
14 us is not located.

**Speculation depth is not a lever** (checked, not re-run): 15.4 and 16.x
measured k=2 below k=1, because each drafted row costs a full CPU pass. Here
verify at m=2 is ~21 ms over plain m=1, so k=2 would be ~2.24 tokens per
~105 ms round.

What is left, each measured and each small: the in-situ worker gap (~3.9
ms/round), the mask kernel's in-situ gap (~2), the card imbalance (~1.3 at
54/46 if memory allowed it), the `down` pull kernel (~0.3). Together ~7.5
ms/round against a ~81 ms round -- ~24 tok/s if all of it were recovered, so
not 25 by themselves.

### 18.33 Where the main thread actually is, the left side of the thread curve, and the ceiling

**Sampled, not estimated.** `eu-stack` on the bench's main thread through a
whole diagnostic run (N=256; the process opts in to tracing with
`PR_SET_PTRACER_ANY` from a preloaded constructor, since yama allows only
ancestors otherwise; ~13 samples/s, so +-4% per bucket at 157 plain-decode
samples). Plain decode, share of the main thread:

| | share |
|---|---|
| shielded link: waiting for the reply (spin; the Freivalds rhs overlaps it) | 35% |
| CPU ops (C), of which ~30% is OpenMP barrier / team-start wait | 28% |
| split join + post | 10% |
| unmask 7%, mask kernel 6%, Freivalds 4.5%, encode 4%, range check 1% | 22% |
| framework (graph build, scheduler, sampling) | **~1%** |

The "framework ~5.6 ms/token" of 18.28 was a residual, and the residual was
wrong: the main thread is almost never in llama.cpp's own code.

**Fewer decode threads do not pay** (16.2's sweep started at 8; 18.14 noted
the left side was never measured). Three rounds, arm order rotated, all nine
runs valid: 6 threads faster in 1 of 3 pairs (mean -0.30 tok/s), 4 threads in
1 of 3 (mean -0.98). 8 stays.

**The ceiling this leaves.** Every lever measured since 18.30, with what a
perfect version would return:

| lever | measured size | status |
|---|---|---|
| in-situ worker gap (service ~86 us vs tight loop ~72) | ~3.9 ms/round | not located |
| mask kernel in-situ gap (1.07 vs 0.26 ns/elem, ~2x unexplained) | ~2 ms/round | not located |
| card imbalance (card 1 17% slower HBM) at an ideal 54/46 | ~1.3 ms/pass | blocked: card 0 has 6% memory headroom while the bench holds two contexts per card |
| SM pull kernel for `down` | ~0.3-0.4 ms/pass | byte-identical, not taken |
| thread placement | 0 (pad refill starves) | closed |
| split rebalance 52/48, decode threads 6/4, pad wait, yield | 0 | closed |
| kernel block shape (G) | <1.5% | closed |
| speculation depth k=2 | negative | closed (15.4) |

Recovering ALL of the open rows takes a ~81 ms round to ~73.5: 1.778 tokens
per round is ~24 tok/s. That is the measured ceiling of everything identified,
and it is below 25 before any of it is built. The remaining large terms are
the GPU kernel (at 76-87% of HBM peak on x8 links), C (synchronisation- and
bandwidth-bound on tiny ops, 18.14) and the TEE link arithmetic that masking
and verification require.

### 18.34 A balanced split that fits, and the Freivalds rejection happens again

**The card balance, at last testable.** 18.31's 53/47 overflowed card 0's
cap. The cap is 95% of the per-link reservation, and the reservation was held
at 15.5 GB because a link restart (the MTP context registering its layer)
briefly holds two reservations per card on the worker: the TEE closes the old
pipe first, but the worker releases the old reservation only after freeing
that connection's weights, and the new HELLO arrives before that. Two
overlapping links must fit the worker's 30 GiB budget, so a reservation up to
~16.1 GB is legal. **Changed memory setup for this test:** card 0's per-link
reservation 16.1 GB (was 15.5), card 1's unchanged at 15.5; both arms of the
A/B use that same setup, so only the split differs. At 54/46 card 0 holds
15.15 of a 15.30 GB cap and the transient overlap reaches 30708 of 30720 MiB
-- valid for a bench, too thin for production.

A/B, equal against 54/46, ABBA, three valid pairs (the fourth lost its equal
arm, below): 54/46 faster in 1 of 3 (-2.02, +1.12, -0.13 tok/s). The balance
did what it was for -- the join fell from 636-1042 ms to 186-478 ms per run --
and card 0's own gemm grew by about as much. Null. The static imbalance is not
a throughput lever either.

**The second verification failure.** `b-eq-1` (equal split, plain decode,
m=1): card 0's reply for the `blk.46.attn_qkv | attn_gate` group failed
Freivalds; card 1's slice of the same group verified. The link retired, the
decode stopped, rc=2, fail-closed exactly as designed. What the two events
share and do not:

| | sterms-1 | b-eq-1 |
|---|---|---|
| card | 0 (PG500-216) | 0 (PG500-216) |
| phase | first spec-prefill pass after a link restart, m=17 | plain decode, m=1, no restart |
| group | blk.27 q/k/v | blk.46 qkv/gate |
| other card's slice | verified | verified |
| worker's view | log overwritten by my own worker restart | no violation, no error; connection closed normally after 8923 exchanges |
| yield detector | unknown | fired on both workers ~2.4 s before the bench exited |

Ruled out, each by evidence rather than argument: a field wrap (the masked
product is exact mod M and does not depend on the pad, so a wrap would be
deterministic in the activations, which are identical across these runs --
it would fail every run, not 2 of ~100); device memory (ECC is on, zero
single- and double-bit errors volatile and aggregate on both cards); reported
PCIe errors (no AER or Xid in the kernel log); a stale ring reply (each pipe's
sequence base comes from the realtime clock and a reply is taken only on an
exact match); the pad pool (slots are released after unmask and check, and
the refill deficit counts held slots); the yield "probe" (timing only, no
kernel). The restart window was my first hypothesis and b-eq-1 had no restart.

**The next one will say what it is.** A failed check now writes a post-mortem
before the link retires: the exact product recomputed in int64 from the TEE's
own weight slice, compared column by column with the unmasked reply --
how many values are wrong, in how many rows and 32-column blocks, over which
columns, how many true values lie outside the field, three samples, and
whether the ring or the socket carried the reply. The patterns separate the
mechanisms: a few blocks is the transfer or the kernel, every column is the
pad, a trailing range is a short or stale reply, and a reply that MATCHES the
local product means the check side (the overlapped RHS) is at fault.
`postmortem-selftest` checks each of those signatures on synthetic data. It
runs only after a rejection and changes no decision.

### 18.35 Audit repair: the fault logs were printing secrets

18.34's post-mortem printed three `got=/want=` samples: unmasked products and
their local recomputation, both functions of the activations, on a path any
worker can trigger by sending one wrong byte, into a host-visible log. That is
an activation leak, and it was mine. The review found three more of the same
class, older, in the column-split probes: the failure-path probe printed the
first two locally recomputed products (`first=45332,-199646` appears in both
rejection logs of 18.34), and the `SHIELDED_SPLIT_PROBE` debug knob printed
`y0=` and the exact peak |y|.

**What a fault line may say, and why.** With exact field arithmetic the
unmasked reply is balanced(W.x + d), where d is the worker's error, so whether
a value differs from balanced(W.x) depends on d alone. Counts, rows, 32-column
blocks and the column range are therefore functions of what the worker sent,
not of the activations, and they stay. Channel metadata (card, node, m, ring
or socket, exchange index) stays. Removed, with no way to turn them back on:
every product and activation value. Behind an explicit development opt-in,
`SHIELDED_FAULT_DIAG_PLAINTEXT=1` (default off; it leaks by design): the two
activation-dependent bits -- how many true products lie outside the field, and
whether a slice's local recompute passes its own check, since that fails only
when the true product wraps.

**Checked, not asserted.** `postmortem-selftest` now proves the property: for
the same worker error, the default line is byte-identical across three
activation sets, including one where every true product leaves the field, and
carries no number larger than a count. Two mutants -- one printing a value, one
leaving the wrap count ungated -- both fail it. `test/shielded-fault-logs`
guards the C++ probe sites textually (no value field in any log format string
outside a marked opt-in block, every opt-in block gated), and it flags all
four leaks in the f3b33031 sources. The rejection itself is unchanged: the link
retires with `SH_ERR_VERIFY` before and regardless of the post-mortem.

One residual, recorded rather than fixed here: a Freivalds rejection caused
by a genuine field wrap is itself activation-dependent (it happens only when
the product leaves the field), so the FACT of a rejection can carry that one
bit. That is a property of the integer check's design, predates this work, and
applies to any fail-closed check of this kind.

### 18.36 Memory bandwidth: the box has little, the refill is not what takes it, and the recurrent kernel is at its floor

**The box.** A plain AVX-512 read stream reaches 49 GB/s on one thread, 79 on
eight, 107 on sixteen and **115 GB/s** on all 32. That is far below what this
CPU's memory controllers support fully populated, which points at few DIMMs
(the population is not readable without root). It makes bandwidth the budget
every CPU-side term shares: the recurrent state, the pad refill's weight
streams, the mask's pad reads.

**The pad refill is not the thief.** Each refill pass streams its group's whole
weight slice, so refill traffic scales as 1/unit: ~30 GB/s at the default unit
of 16. Three rounds, arm order rotated, all nine runs valid:

| refill unit | spec tok/s | vs 16 | pads missed |
|---|---|---|---|
| 16 (default) | 21.77 / 20.99 / 19.71 | | 0 |
| 32 | 15.44 / 15.00 / 15.44 | slower in 3 of 3, mean -5.53 | 82-245 (0.9-1.7 s minted on path) |
| 64 | 20.70 / 17.88 / 19.56 | slower in 3 of 3, mean -1.44 | 0 |

A quarter of the refill traffic (unit 64, no misses) bought nothing, so the
refill's share of the bandwidth is not what bounds the rest. 16 stays.

**The recurrent kernel is at its floor.** `GATED_DELTA_NET` (34% of C, 18.13)
already fuses its four per-token steps into one pass per state row. Its state
is 128x128 fp32 per head, 48 heads, 3 MB per layer; every token reads and
writes all of it, ~288 MB per token over 48 layers, which at the 79 GB/s eight
threads reach is ~3.7 ms against the ~4.2 ms measured. The obvious further
fusion -- running both verify tokens through a row while it is hot -- buys only
L2 traffic, because the token loop already sits inside the per-head loop and a
head's 64 KB state is still in L2 for the second token (~0.15 ms/round). Less
state traffic would need a narrower state type, which is a precision change
and out of bounds.

### 18.37 A soak cannot reproduce the rejections, and what that rules out

`shielded-soak` (new, `make shielded-soak`) drives the production link path
against a live worker for as long as asked: `sh_link_open` -> configure ->
shm ring -> add weights -> start -> `sh_link_gemm` with verification on, the
four per-card exchange shapes of one 27B layer (grouped qkv|gate|a|b,
ssm_out, gate|up, down) cycling like a decode pass at m=1 or 2, fresh
activations and fresh pads from the link's own refill threads, overlap-verify
on as in the bench. One exchange in 256 is also compared value by value with
a local int64 product. A rejection retires the link and the soak reopens and
counts it, with the link's post-mortem classifying it (18.35).

Both cards at once, 45 minutes: **11.7 M exchanges (5.66 M card 0, 6.05 M
card 1), zero rejections, 45,764 exact checks all correct**, every exchange
over the ring with the reply mapped for the device. Production had two
rejections in about 2.8 M card-0 exchanges, so at that rate this should have
seen ~4 on card 0; seeing none is strong evidence that the plain
link/ring/kernel path under steady load is not where the fault is.

What the soak did NOT have, and production did: the worker's yield detector
never fired (0 activations against ~1 per production connection, and one
~2.4 s before b-eq-1's rejection); 8 distinct graphs against 274-514; no
m=17 prefill exchanges or lm_head; no link restarts; no CPU ops contending
between exchanges. The next soak adds GPU contention on the same card to make
the detector fire for real. The first attempt at it died at start when the
per-user /tmp quota filled (another session's 23 GB of scratch, not this
run's); it is being rerun.

### 18.38 Correction to 18.37: the exact checks covered one shape

An independent audit of 8d7e47f1 found that the soak's exact checks all fell
on one shape. The soak chose them with `n_ex % 256 == 0`, counting exchanges
across the A B C D cycle, and 256 is a multiple of 4, so every one of the
45,764 exact checks was a `down` (D) exchange. A, B and C were never compared
value by value. What 18.37 establishes, restated to what was measured:

- **Freivalds covered all four shapes at both m**: 11.7 M exchanges, zero
  rejections. That is the check the engine relies on, and it stands.
- **The exact checks cover `down` only**: 45,764 of them, all correct, at m=1
  and m=2 (m is random per pass, so both occurred).
- **Neither shows the fault is unreachable.** A finite clean soak is evidence
  about the paths it exercised for as long as it ran. At production's apparent
  rate a clean run of this length is unlikely if the soak exercised the faulty
  path, which is what makes it informative, but it proves nothing about the
  conditions it lacked (yield activations, many graphs, m=17, link restarts,
  CPU contention) and bounds the rest only statistically.

The sampling is now stratified: each (shape, m) cell keeps its own counter and
is checked on every Nth exchange of that cell, and the soak prints per-cell
checked/total counts. `shielded-soak --schedule-selftest` runs the soak's own
selection with no worker and fails unless every cell is checked;
`test/shielded-soak-schedule` runs it at the default period and at periods
that are multiples of the cycle (the case that broke the first version), and
checks that a period of 0 fails.

**The yield soak** (run with the old sampling, recorded with that limitation):
card 0 alone, 30 minutes, an intermittent GPU competitor on the same card
(~30 s of kernels, ~30 s idle) so the worker's yield detector fired for real.
**4.19 M exchanges, 67 yield activations (44.5 s spent yielding), zero
rejections**; 16,350 exact checks all correct, all on `down`. Slow replies from
a yielding worker do not by themselves reproduce the fault under soak
conditions. That leaves, of the production-only conditions 18.37 listed: many
distinct graphs, m=17 prefill exchanges and lm_head, link restarts, and CPU
contention between exchanges.

### 18.39 The expanded soak, its actual exact-check scope, and the second aliasing

The full-geometry soak (both cards, 45 minutes): 64 layers of distinct random
weights per card plus the lm_head slice (12.9 GB per card, 257 exchanges per
pass as in production), m=17 prefill passes every 50th pass, and the link
closed and reopened every 5 minutes. **11.4 M exchanges (5.75 M card 0, 5.67 M card
1), 228,000 of them at m=17, 16 link restarts, 25 yield activations, the
worker's graph cache at 771 distinct graphs (production's count), zero
rejections**; 44,583 exact checks all correct, within the scope below.

**What its exact checks covered.** A second audit found that the per-(shape,
m) counters of 18.38 alias again once there are layers: each counter advances
once per layer per pass, and 256 is a multiple of 64, so every exact check of
A, B, C and D landed on layer 63 (zero-based), never on layers 0-62, except
where a failure-induced reopen shifted the phase (none did). Its exact
evidence is therefore: layer 63 of each shape at each m, and the lm_head.
Freivalds covered every instance of every exchange, as before.

**Fixed by stratifying per instance.** Each (instance, m) pair -- one layer's
weight at one row count -- now keeps its own counter, so every layer is
sampled at the same rate whatever the period. The soak prints, per (shape, m),
checked of total and how many of the shape's layers were covered.
`--schedule-selftest` fails unless every (instance, m) pair the configuration
produces is checked: 771 pairs in the full configuration, all covered, 64 of
64 layers for each shape at m=1, 2 and 17. A mutant that reinstates the
per-(shape, m) counter fails it with "1 of 64 layers" and 756 of 771 pairs
unchecked. `test/shielded-soak-schedule` runs the full configuration and
periods of 64, 128, 256 and 512 (multiples of the layer count, the case that
broke this version).

The lesson is the same one twice: a deterministic sampler over a periodic
schedule samples a fixed phase unless it is stratified by the finest unit it
means to cover, and a test that counts only coarse cells cannot see it.

**The arithmetic, exhaustively or at production size.** With the soaks clean,
the kernels whose inputs are random per run -- the pads -- were checked
directly, on the production-built objects:

| kernel | domain | result |
|---|---|---|
| `mask_planes` (AVX-512 and generic) | every w = x + r the link can present: 148,675,075 values | exact |
| `pad_planes` (both) | every pad r in [0, M): 14,457,349 values | exact |
| `refill` u = W.r (default AVX-512, vector-CRT, generic) | K = 5120/6144/17408, N = 32 to 124,160, batches 1-64 incl. the blocked kernel; uniform and edge pads; 309,056 values against int64 | exact |
| Freivalds `fv_dots_x` / `unmask_fv` | accumulation bounds, by reading | fold every 32 terms (< 2^62) / 262,144 terms (< 2^61): no int64 wrap |

And the one structural difference left between the soaks and production:
the soaks ran each card's link in its own process, production runs both in
one process on two threads. The link, wire and SIMD code have no mutable
process-wide state on the exchange path (thread-local parwork pools,
read-only tables, per-link pads, Freivalds vectors and scratch), and the two
threads share `x_field` read-only while both exchanges are in flight.

Both rejections remain open and unexplained. Everything a synthetic test can
reach has been ruled out except a two-links-in-one-process soak and the real
model's activation magnitudes (the soak's |x| <= 3 against real activations
near the 2^26 bound -- though the arithmetic above is exact over that whole
range). Those are the next soaks.

### 18.40 Qualifications to 18.37-18.39, and first-visit exact sampling

An audit of 53fbd4e5/0e79e397 supports the per-instance fix, and asked for
the following to be stated plainly. Each corrects wording in 18.37-18.39.

- **The refill result is a finite test, not a proof.** 309,056 values at
  production sizes (18.39's table) show the kernel exact on those inputs.
  They do not cover every possible pad and weight. Only `mask_planes` and
  `pad_planes` were checked over their entire input domains.
- **Clean soaks do not rule out every synthetic-reachable fault.** They bound
  the rate of faults on the paths they exercised, for as long as they ran.
  18.39's "everything a synthetic test can reach has been ruled out" was
  wrong and is withdrawn.
- **Production differences remain open**, not closed: the real model's
  activation magnitudes and distributions (the soak's |x| <= 3), the
  interleaving of the CPU backend's ops between exchanges, and the timing that
  produces. The exactness of the arithmetic over its whole input range does
  not make those differences irrelevant.
- **Both production rejections remain open and unexplained.**

**The rare cell the per-instance sampler still missed.** In the split soak
(soak4, running) an m=17 pair sees one visit per 50 passes. At the default
period of 256 its first exact sample needs 12,800 passes, so a 45-minute run
gets none: its m=17 exact coverage will be zero, recorded as such when it
ends. The selftest did not catch this because its 20,000 simulated passes
give each m=17 pair 400 visits, enough at 256; at 512 it fails, and an
earlier test of mine ran 512 only without prefill, so it never saw that case.

Fixed by checking every (instance, m) pair on its first visit as well as
periodically, so a rare cell and a short run both have exact evidence. The
selftest now checks the two properties separately, so first-visit sampling
cannot hide an aliased periodic sampler: every pair checked at least once, and
every pair visited at least `every` times checked periodically too. The
full-configuration aliasing mutant fails both (744 of 771 pairs never checked,
756 of 771 past the period with no periodic check); the fixed sampler passes
at 64, 256 and 512, and at 512 reports honestly that only 514 of the 771
pairs are past the period, with the m=17 pairs resting on their first visit.

### 18.41 The split soak: both links in one process, full exact coverage, clean -- and a correction to 18.40

soak4 ran both cards' links in ONE process, card 1's exchange on a spinning
helper thread concurrently with card 0's on the main thread, on the same
activations -- the column split's structure, the last structural difference
between the earlier soaks and production. 64 layers + lm_head per card, m=17
prefill every 50th pass, link restarts every 5 minutes, 45 minutes:

| | card 0 | card 1 |
|---|---|---|
| exchanges (paired, one per card) | 3,709,024 | 3,709,024 |
| of which m=17 | 74,016 | 74,016 |
| rejections | 0 | 0 |
| exact checks, all correct | 14,135 | 14,135 |
| exact coverage | all 64 layers of every shape at m=1, 2 and 17; lm_head at all three | same |
| link restarts / yield activations | 7 / 10 | 7 / 12 |

**Correction.** 18.40 predicted that this run would get no m=17 exact checks
because an m=17 pair needs 12,800 passes before its first periodic sample. The
arithmetic was right and the conclusion wrong: this run reached 256 prefill
visits per instance at 2,407 s, so every m=17 pair was checked (64 per shape on
each card, the lm_head once). My estimate of the pass rate was too low. The
first-visit sampling of 18.40 stays: it is what guarantees coverage for a
shorter run or a rarer cell, which this run happened not to need.

The two production rejections remain open. What separates every soak so far
from production is the real model's activations and the CPU backend's ops
interleaved between exchanges.

### 18.42 An in-place delta-net conv: bit-identical, and no measurable throughput

**What it is.** Each of the 27B's 48 recurrent layers ran, per pass, a CONCAT
(the conv state joined with the new token), an SSM_CONV, and one or two CPYs
writing the state back into the cache (two where a rollback snapshot is kept).
Fresh op profile (two pairs, N=64 -> 192, divisors from the runs' own JSON; the
old `opdelta.py` turned out to ignore its arguments and re-read 18.13's files,
now fixed): C = 12.22 ms/token, CPY 1.278, CONCAT 1.205, SSM_CONV 0.617 --
20% of C, for ~160 KB per op. `ggml_ssm_conv_state` (new op, CPU only)
reads the state where it lies in the cache and writes every snapshot slot
itself, when `build_rs` handed back the live cache (the `rs_identity` condition
the graph-reuse checks already compare); otherwise the old graph is built.
`ENCLAVE_GGML_CONV_INPLACE=0` restores it. It is a NEW op rather than a mode of
SSM_CONV because nine other backends implement SSM_CONV and would have had to
learn to decline it; every backend already declines an op it does not know.
Kept as `wasm/llamacpp-conv-inplace.patch` (applies after rs-inplace), NOT
wired into the toolchain.

**Correctness** (separate from performance, and a property of the build: GCC
16.2.1, `-O3 -mfma -mavx2 -mavx512{f,vl,dq,bw,vbmi,vnni,bf16}`, GNU default
`-ffp-contract=fast`):

- `conv-equiv`: 21 single-call cases, outputs and every state slot bytewise
  identical to the concat graph, including signed zeros and scalar tails.
- `conv-equiv2` (added after an audit): 32 cases over SEQUENCES of calls on one
  simulated cache -- several sequences at a nonzero cache head with the
  snapshot stride past the active state, K > n_t, 24-call rollback/resume runs
  that interleave the fused path with the fallback path, the n_t 64/65
  vector/scalar boundary, widths 2/3/5/16 -- output and the whole cache
  compared after every call. All identical.
- A mutant with a leading multiply instead of FMA-from-+0 in the vector path
  differs in the signed-zero cases only (67-1021 outputs): the harness is
  sensitive to exactly the rounding question, and the reference is a chain
  of FMAs from +0 at 4 taps.
- **What the extended harness caught.** The AVX-512 path, correct at 2-5 taps,
  DIFFERED from the reference at 8 taps and more: GCC compiles the reference
  loop differently at those lengths. A first-use self-check I had added (vector
  against the scalar helper) passed at 16 taps anyway, because the inlined copy
  of the helper inside the check compiled differently from the reference. The
  vector path is now used at d_conv == 4 only (the width every caller uses);
  other widths take the scalar path, which matches at every width tested; the
  helper is `noinline` so the check and the kernel share one compiled copy.
- End to end: identical greedy tokens with the op on and off and against the
  old libraries (md5 0a1570d184a4, all runs).

**Performance.** The conv path fell from ~455 ms to ~151 ms per 64-token run
(the vector kernel; the first scalar versions reached only 351-412 ms, because
the cost was the per-channel scattered work, not barriers or bytes). The A/B,
op on against `ENCLAVE_GGML_CONV_INPLACE=0`, same binaries, 4 valid pairs:
faster in 2 of 4 (+4.39, -2.05, +0.44, -0.11 tok/s). Mixed signs, **no effect
established** -- an expected ~1 ms/token is below this box's run-to-run noise
(18.5-22.9 tok/s within one arm). The wider graph/scheduler integration audit
of the op remains open.

### 18.43 The run-to-run spread: not the GPUs, and yield only on long-lived workers

Identical configurations have ranged 18.5-22.9 tok/s all session, and the
fast runs have ~70 ms verify rounds against ~80-87. Making every run a fast run
would be worth more than any lever measured, so the runner now records per-run
evidence (`run5.sh`, scratch: each worker's log slice, and a 1 Hz sample of both
V100s' SM and memory clocks, power, temperature and throttle reasons).

**Eight identical runs on long-lived workers** (7 valid; one had a peer's clang
build): 17.11-21.73 tok/s. SM clocks were fixed at 1260/1230 MHz in every sample,
temperatures 34-35 C, no throttle reason set: the GPUs are not the spread. What
tracked throughput was the workers' owner-yield detector: 1-4 activations per
run and 130-305 ms spent yielding; on the spec connection the three fastest runs
had card 1 at 0 ms yielded and the slower ones 67-167 ms on one card or the
other. Under the column split either card yielding stalls every exchange that
waits on it.

**A/B, yield on against SHIELDED_YIELD=0, workers restarted per arm (checked
from their startup lines), same binary: null.** 4 valid pairs, yield-off faster
in 1 of 4, mean +0.01 tok/s. After a fresh restart the detector barely fires even
when on (0-2 activations, at most 37 ms yielded), so there was nothing to remove.
The spread persists without it: 19.80-22.33 tok/s, verify 72-81 ms.

So two separate findings. (1) The detector's false activations grow with worker
uptime: the long-lived workers had run through hours of soaks and deliberate GPU
contention, and a floor learned under different conditions makes ordinary turns
look slow. On a dedicated card with no owner that is a pure stall source, and
`SHIELDED_YIELD=0` is the right deployment setting for one; that is a config
recommendation, not a measured throughput gain on a fresh worker. (2) What makes
a run fast is still not identified. Remaining candidates, none tested here: CPU
placement of the OpenMP team relative to the two card threads (CCD and SMT
siblings), and memory placement.

### 18.44 Placement and huge pages: unsupported by the samples, and huge pages are not obtainable here

**Wording, per audit.** What 18.43's decomposition shows is a timing
ASSOCIATION: over 15 valid identical runs every CPU-side term moves with
throughput (outside-the-link CPU ops r=-0.77, unmask -0.73, post -0.61) while
the GPU waits do not (wire -0.12, idle +0.04). That is not an identified root
cause, and low correlations do not rule causes out; they leave them unsupported
by these samples.

**Thread placement** (8 valid runs, 18.91-21.73 tok/s, median 20.55; a passive
2 Hz sample of every thread's CPU and CPU-time from /proc): the main thread's
CCD (r=-0.08) and a hot thread on its SMT sibling (r=-0.14) are unsupported as
explanations in this sample; the hot-thread count (r=-0.61) is as likely an
effect (slower rounds leave the OpenMP team spinning longer) as a cause.
**Memory placement across NUMA nodes cannot vary**: one socket, one node
(`numactl --hardware`: 32 CPUs, 128 GB); the only topology boundary is the two
32 MB L3s, one per CCD.

**Huge pages as the source of the spread: unsupported.** 8 valid runs,
18.85-20.72 tok/s: the process's AnonHugePages was 1.96-2.05 GB in every run
(r=-0.01).

**Huge pages as a mean lever: not obtainable on this box, and costly to try.**
Mid-decode smaps: of ~25 GB of anonymous memory (one 16.4 GB region, an 8.4 GB
heap) about 5% is on huge pages; the model file (17.1 GB) is page cache. The
kernel is `enabled=always, defrag=madvise`; per the kernel's own documentation
(docs.kernel.org, transhuge) a non-madvised fault tries for a huge page without
reclaim or compaction and falls back, and an `MADV_HUGEPAGE` region enters direct
reclaim and compaction -- which raises the chance and can stall the allocation,
and guarantees nothing. System-wide, 61.0 M THP faults had fallen back against
17.4 M allocated.

A preload shim that advised every allocation of >= 64 MB (39.0 GB in 402 calls,
all returning 0) got **2.02-2.10 GB of huge pages against 1.94 unadvised**: every
direct compaction it triggered failed (`compact_stall` +4,213, `compact_fail`
+4,213, `compact_success` +0), and those failures doubled the load (wall 225-227 s
against 115 s). Decode in the two advised runs was 17.00 and 17.88 tok/s against
19.44 in the one plain run -- 1.5 pairs, provisional, not a measurement.

The shim itself is **UNACCEPTED** and quarantined (audit): its calloc bootstrap
could hand static-buffer pointers to libc free/realloc, its bootstrap arithmetic
and alignment were unchecked, and its lazy resolution was racy. The A/B was
stopped after its first 1.5 pairs; no preloaded process remained. Advising
narrowly owned buffers would meet the same failing compaction; on this box the
lever would need an administrative action (compaction or boot-time huge-page
reservation), which this work does not take.

Both production Freivalds rejections and the conv op's graph/scheduler
integration audit remain open.

### 18.45 Frequency and power: unsupported too; the spread's cause is not identified

8 valid identical runs, 18.35-21.44 tok/s, sampling every core's current
frequency, the socket's power (amd_hsmp hwmon) and Tctl at 1 Hz (`run7.sh`,
scratch): mean all-core frequency during decode 2.68-2.82 GHz (r=+0.16 with
throughput), minimum core 2.00-2.09 GHz (r=+0.15), socket power 67-70 W (r=+0.19)
with peaks of 93-102 W against a 125 W cap, Tctl 42.6-43.2 C (r=-0.17). A power
or thermal limit is not supported as the explanation by this sample.

Where that leaves the run-to-run spread: a CPU-side timing association (18.43)
with no identified cause. Unsupported by the samples so far: GPU clocks and
throttling, the owner-yield detector on fresh workers, thread placement (CCD,
SMT sibling), huge-page footprint, and core frequency, power and temperature.
One candidate left that this user cannot measure: physical page placement of
the large 4 KiB-page buffers (L2 set conflicts, DRAM channel spread vary with
which physical pages a run gets). Reading physical frame numbers from
/proc/PID/pagemap needs CAP_SYS_ADMIN.

### 18.46 The in-place conv, in the real graph and under the production toolchain

**Real graph path** (`conv-graph-test`, CPU backend, the 0.8B qwen35 model of
the same architecture): plain decode, the speculative verify/rollback/resume
pattern with `n_rs_seq=1` (rollback via `seq_rm`, so the next ubatch reads a
snapshot and takes the fallback), and cache lifetime (memory clear and context
reuse, full `seq_rm`, re-prefill, alternating ubatch sizes across graph reuse).
71 steps, 141 MB of logits: the new build with the op on, the same build with it
off, and the pre-change libraries are all **byte-identical**. The op really ran:
1,062 fused calls and 216 fallbacks (rollback reads) in the on process, against
1,278 concat-path calls in the off process.

**Multi-sequence is not testable in the real graph on this fork**: creating a
context with `n_seq_max > 1` aborts (`GGML_ASSERT(ggml_can_repeat)` in graph
reservation) with the op on, off, and on the pre-change libraries -- a
pre-existing limitation, recorded, not introduced. The fused op cannot reach
that case (it runs only for one sequence in a one-cell cache); the synthetic
harness covers the multi-sequence arithmetic.

**Production compiler configuration** (validation only, not deployment):
inside `ubuntu:22.04` -- the llamacpp-toolchain runner's OS, stock GCC 11.4.0
and cmake 3.22.1 -- with the workflow's CPU-relevant flags. Those flags compile
the CPU backend for AVX2 + FMA with **no AVX-512** (`-msse4.2 -mf16c -mfma
-mbmi2 -mavx -mavx2`), so production runs the op's scalar path. All three
harnesses there: `conv-equiv` 21/21 identical, `conv-equiv2` 32/32 pass, the
real-graph test byte-identical on/off. The op is therefore validated on both
builds that matter; deploying it would still be a separate, reviewed change to
the toolchain workflow, and its throughput effect is not established (18.42).

### 18.47 The real-model reproduction campaign: no rejection in 8.4 M exchanges, and a divergence the 64-token check hid

**Campaign.** The soaks could not carry the real model's activations (random
weights with real activations would wrap the field legitimately), so the
reproducer is the benchmark itself, scaled: the real 27B, weights, activations
and CPU interleaving, 20 runs at N=512 on a longer prompt, every run keeping its
post-mortem (activation-independent fields only), worker log slices, GPU samples
and trace. Per run, card 0 served 210,846 exchanges (132,869 plain + 77,977
spec) and card 1 the same: **~4.2 M exchanges per card, 8.4 M in all, zero
rejections** (`verify_fail=0`, no "verification FAILED", in all 20). At the
rate the two production events suggest (~1 per 1.4 M card-0 exchanges) about 3
were expected; none has ~5% probability at that rate. Either the true rate is
lower than two events implied, or the trigger is something these runs lacked.
Both production rejections remain open.

**The divergence.** Every run's plain output was identical (one token hash
across all 20), and every run's speculative output diverged from it at exactly
token 320 -- which is why every run exited rc=3 ("text differs"), a result the
bench's usual 64-token check never reaches. The same benchmark with NO shielded
backend (unmasked, CPU only, same prompt, N=512) diverges too, earlier, at token
72 (acceptance 0.829). So "speculative == plain" holds only up to
floating-point batch-shape effects in llama.cpp's own CPU ops (a 2-row verify
batch and a 1-row plain step do not round identically), not because of
anything the shielding does: the shielded products are exact integers and
cannot depend on batch shape. The unmasked plain text also differs from the
shielded plain text from token 72 -- expected, since the shielded tier computes
the matmuls in its own exact integer encoding of the weights rather than in
llama.cpp's quantized float dot products (task quality was measured at parity
in the TPU comparison). The 64-token identity check stays a valid regression
test of the shielded path against itself; it is not evidence of token-level
equivalence at length.

Also closed: the conv graph test's two deferred checks. The positive run passes
the fail-closed checker (fused on == off, 71 steps, 142 rows, 141,045,760
bytes), and a dump to /dev/full is rejected on its write check (rc=4).

### 18.48 An alternative masked exchange, assessed before building: a shared pad across the cards

**The design.** Today the column split masks the activation twice, once per
card with independent pads (card 0 receives x + r0, card 1 x + r1), and each
link draws its own pad and computes its own u = W_c r_c. The alternative masks
once: one pad r per exchange, the SAME ciphertext x + r to both workers, each
card unmasking with its own slice u_c = W_c r from a pad pool the two links share
(one refill computes both slices from the same r).

**Security argument.** The adversary is the host that operates both workers.
Today it sees two ciphertexts of x under independent uniform pads; with a shared
pad it sees one. Each pad still masks exactly one activation vector (the one-time
property is per plaintext, and broadcasting one ciphertext is one use), so the
host's view is a function of a single uniformly masked value and reveals nothing
about x -- no weaker than today, and strictly fewer ciphertexts. Freivalds is
per card with its own secret vectors and is unaffected; a card's wrong reply
still fails its own check before use, and the verification-before-use order does
not change. Pad freshness, the pool's one-use accounting and the fail-closed
paths would all carry over, and would need the same tests as today.

**Why it is not built.** It saves one mask pass per exchange (~5.5 ms/round of
CPU) and half the pad draws, but not latency: today the two masks already run
concurrently on the two card threads, while a shared mask must finish before
EITHER card can publish, so the critical path keeps one full mask either way.
Refill cost is unchanged (two slices per pad), and the refill is not the
constraint anyway (18.36). A CPU-time saving with no latency effect does not
move tok/s here.

**Where the round goes, and the gap.** Verify at m=2 costs ~1.46x a plain m=1
step on this box (~80 vs ~55 ms), so k=1 speculation at 1.778 tokens per round
gives ~1.22x over plain. 25 tok/s from plain ~18 needs ~1.39x, i.e. a verify
round near 71 ms. What grows with each verified row -- the CPU ops outside the
link (~32 ms/round at m=2 against ~18 per plain token) and the per-row link work
-- is the term to attack, and the candidates measured so far each recover a few
percent of it at most.

### 18.49 Corrections to 18.47, an open quality gap, and the op that scales with rows

**Corrections to 18.47 (audit).**
- The unmasked CPU-only run shows that speculative and plain decoding diverge at
  baseline (token 72): batch-shape floating-point effects exist in llama.cpp
  without any shielding. It does NOT show that the masked run's divergence at
  token 320 has no shielding contribution. The shielded products are exact
  integers, but everything downstream of them (descale, the CPU ops, the
  sampler) runs on values that differ from the unmasked run's, and no
  controlled per-op or per-logit comparison between the two paths has been
  made. The causal statement "not because of anything the shielding does" is
  withdrawn; what is established is only that a baseline divergence exists.
- The claim that task quality was "measured at parity in the TPU comparison"
  cited a different model and platform (Gemma 4 E2B on the Pixel lane) and
  cannot validate the Qwen 27B shielded encoding. **No model-matched quality
  evaluation of the 27B's int8 shielded encoding exists in this record**
  (searched: this report, HANDOFF-27B.md, README.md); the handoff itself names
  the encoding's quality risk as needing "an eval, not a norm check". That gap
  is OPEN.
- The 512-token campaign runs (rep-1..20, all rc=3 "text differs") stay invalid
  for any throughput acceptance. Their raw evidence was kept in the scratchpad (lost in the 18.50 reboot; excerpts in `shielded/bench-harness/evidence-excerpts-2026-09-23/`):
  plain-token hash de03ea03 in all 20, first divergence at token 320 in all 20;
  the unmasked run's plain hash 8c5b7e6c, divergence at token 72.

**Which op makes a verify round cost ~1.46x a plain step.** The op profiler now
also splits every op's time by the node's row count (1 = plain step or draft,
2 = verify). Two clean runs (20.39 and 19.35 tok/s, both valid, box confirmed
free by the peer session):

| op | us/call at 1 row | at 2 rows | ratio |
|---|---|---|---|
| GATED_DELTA_NET | 76.4 / 70.4 | 162.4 / 155.6 | **2.13 / 2.21** |
| MUL_MAT (CPU part) | 12.3 / 11.5 | 15.2 / 14.0 | 1.24 / 1.22 |
| SSM_CONV_STATE | 32.4 / 30.5 | 33.8 / 33.3 | 1.04 / 1.09 |
| RMS_NORM | 6.9 / 5.9 | 7.2 / 6.6 | 1.04 / 1.12 |

The recurrent op is the one CPU op whose cost doubles with the verify's second
row; the others are nearly flat. 18.36's argument that a second token's state
sweep would be L2-hot and cheap was wrong: the per-token loop over every state
row, not DRAM traffic, dominates. That makes the recurrent op, not bandwidth,
the target for the verify round.

### 18.50 A token-fused recurrent kernel, and an unclean reboot that took the scratchpad

**The kernel.** 18.49's row-bucketed profile found GATED_DELTA_NET the one op
whose cost doubles with the verify rows (76 us per layer at one row, 162 us at
two; every other op 1.0-1.24x). Its per-token loop sweeps the whole
S_v x S_v state once per token. But row j of the state is updated from row j
and that token's q/k/v/beta/gate alone, so rows are independent across tokens:
visiting each row once and applying tokens 0..n-1 to it in order performs, on
every row, exactly the per-token loop's operations in the same order. The
fused path (`wasm/llamacpp-gdn-tokfuse.patch`, switch
`ENCLAVE_GGML_GDN_TOKFUSE`, default on while under test) covers 2..16 tokens with the scalar
gate (the model's form); the per-channel gate and 1 or 17+ tokens keep the
old path. Each token's output for row j and each rollback snapshot of row j
are written where the per-token loop's whole-state copies put them.

Correctness, before any timing:

- `gdn-equiv` (72 op cases: the model's S_v 128 / 48 value heads over 16 key
  heads, n_tokens 1-17, K 1-4 including K > n_tokens, in-place into a padded
  multi-slot cache and the copy form, several sequences, odd shapes, threads
  1/3/8, signed zeros, the per-channel gate) dumps every output and the whole
  state buffer: byte-identical with the switch on and off. A planted one-ulp
  mutant in the fused loop changes exactly the 52 fused cases and no other.
- The real graph (0.8B, same architecture, spec verify batches of 2 with
  rollback and resume): logits byte-identical on and off, and identical to the
  libraries from before the change.
- Production toolchain (ubuntu 22.04, GCC 11.4, AVX2 + FMA only): all conv
  harnesses plus both tokfuse checks passed (the tokfuse checks are removed
  from `prod-toolchain-check.sh` now that the patch is not applied). `run_pair` joins
  `harness-check.sh` with fail-closed stub self-tests (an arm exiting nonzero,
  a one-byte difference, a dump shorter than reported, zero cases).
- Upper bound on the gain, an estimate from the profile: if two rows cost what
  one does, ~86 us x 48 layers = ~4 ms of an ~80 ms verify round, ~5%.

**Throughput: a 4-of-4 result the kernel did not cause.** Eight interleaved
runs after the reboot (order off/on, on/off, off/on, on/off), all valid, the
same workload (43,118 exchanges, local 0, verify_fail 0, text identical), same
binaries throughout (hashes in `results-2026-09-23/tk.ids`):

| pair | off: spec (plain) | on: spec (plain) | verify ms/round off -> on |
|---|---|---|---|
| 1 | 20.80 (18.59) | 21.77 (20.46) | 77.19 -> 73.14 |
| 2 | 20.32 (19.56) | 23.83 (18.76) | 78.76 -> 67.47 |
| 3 | 21.95 (19.31) | 22.71 (21.12) | 72.77 -> 70.98 |
| 4 | 21.89 (18.47) | 23.09 (19.15) | 73.28 -> 69.53 |

On is ahead in every pair (mean 22.85 vs 21.24), and the verify round is 1.8
to 11.3 ms shorter, about the ~4 ms the profile allowed. It is not the kernel.
The plain phase, which never takes the fused path (one row), was also 2.3
ms/token faster in the on arms. The verify/plain ratio split 2-2 (means 1.433
off, 1.398 on). The one pair from before the reboot went the other way (off
20.60, on 19.76). And 4 of 4 is p = 0.06 against a coin. The direct measures
settle it:

- **Op profiler on the 27B** (two more pairs, the 2-row bucket, which is verify
  work only): 149.6 and 154.9 us per call off, 151.7 and 145.6 on. No change.
- **`gdn-bench`** (the op alone at the 27B's verify shape, in place, 2-slot
  cache, interleaved processes): **the fused path is slower**: 2 tokens x 8
  threads 70-73 vs 64-71 us, 1 thread 474 vs 394 (+20%), 4 tokens 138 vs 113
  (+22%).

Why: the state a thread owns (6 heads x 64 KB = 384 KB) stays in L2 between
the two tokens, so the per-token path's second sweep was already cheap; fusing
removed no memory traffic and made the inner loop worse (per-token pointer
arrays, strided output writes). The patch is kept as a record, marked NOT
APPLIED, and the fork is reverted. 23.83 tok/s (tk-on-2) is the highest valid
reading so far, but it is a draw from the spread (18-24), not a milestone:
**no 25**.

**What the numbers do say about the op.** Alone, one token costs 34 us per
call at 8 threads: ~44 ns, ~215 cycles, per state row per thread for four
128-float vector operations (scale, dot, fused multiply-add, dot) that an
AVX-512 core could issue in a few dozen cycles. In the graph the same op costs
71 us, with the state arriving cold (48 layers x 3 MB exceeds the L3). So the
op is neither at a bandwidth floor (18.36) nor bound by its sweeps (this
section): it is bound by per-row overhead. That means four out-of-line vector calls,
each dot ending in a serial horizontal reduction, and the row reloaded between
them. The next candidate is a register-resident row kernel: load the 128-float
row once, keep it in registers through all four steps (and through every token
of the batch), store it once. It would be bit-identical by construction if it
uses ggml's own `GGML_F32_VEC` macros in the same accumulation order as
`ggml_vec_dot_f32` / `ggml_vec_mad_f32` / `ggml_vec_scale_f32` (verified with
`gdn-equiv` before any timing). Estimate, not a measurement: if it reached ~60
cycles per row, the verify round would lose ~4 ms and a plain step ~1 ms.

**The reboot.** The box stopped uncleanly during the first A/B: the journal
ends at 09:01:45 on a routine line with no shutdown sequence, panic or oops,
and the next boot (09:13) found the journal uncleanly closed. The cause is not
identified. Two coincident events have no established link: a peer session's
SEV-SNP launch attempts through an out-of-tree QEMU (each returned a clean
userspace error; the peer has stopped them), and a USB NIC re-lease at
09:01:35 on a VIA hub that has logged intermittent protocol errors (-71) for
three days and survived all the earlier bursts. That hub carries the camera,
audio and a NIC, and is worth reseating whatever the cause.

**What it cost.** `/tmp` is tmpfs, and the session scratchpad held the bench
harness, the builds, the running queue (one valid pair: off 20.60, on 19.76)
and evidence I had been asked to preserve: the b-eq-1 worker log copies, the
sterms-1 run, and the twenty 512-token rep runs with the unmasked CPU-only
run. Those raw files are gone. Recovered:

- The harness, rebuilt on disk (`shielded/bench-harness/`, working copy in
  `~/enclave-bench/`) by replaying the session transcript's writes, with
  `run7.sh` verbatim from two full displays and `bench-spec2.cpp` from the
  archived copy plus its one later edit. `workers-shm2.sh` is rewritten from
  the running workers' recorded command line. The rebuilt stack reproduced the
  pre-reboot plain decode exactly (token hash 0a1570d184a4, as in four earlier
  runs) on the same workload (43,118 exchanges, local 0, verify_fail 0).
  This A/B's raw artifacts are in `shielded/bench-harness/results-2026-09-23/`,
  on disk from the start this time.
- The evidence, as excerpts: every command run on the lost files and the
  output it printed, verbatim from the transcript
  (`shielded/bench-harness/evidence-excerpts-2026-09-23/`). They include both
  rejection lines and the rep hashes; they are not the raw files. The REPORT
  sections that summarised them stand as the record; the 512-token rc=3 runs
  stay invalid for throughput acceptance.

Nothing about the open findings changes: both production Freivalds rejections
(sterms-1, b-eq-1) remain open and unexplained, the conv graph-integration
limits (multi-sequence) stay documented, and the 27B shielded encoding still
has no model-matched quality evaluation.

### 18.51 A register-resident recurrent row: faster op, no throughput established yet

18.50 left the recurrent op bound by per-row overhead: four out-of-line vector
calls per state row per token, each dot ending in a serial reduction, the row
reloaded between them. `wasm/llamacpp-gdn-regrow.patch` (switch
`ENCLAVE_GGML_GDN_REGROW`, default on in the fork, not deployed) loads each
128-float row once, takes it through scale, dot(k), the d*k update and dot(q)
in registers, and stores it once. Each step uses ggml's own `GGML_F32_VEC`
operations in exactly the order of `ggml_vec_scale_f32` / `ggml_vec_dot_f32`
/ `ggml_vec_mad_f32` (S_v = 128 is a multiple of every compiled ISA's step, so
there are no leftovers); other lengths, the per-channel gate, SVE, RISC-V V
and Accelerate keep the calls.

Correctness (AVX-512 build, before any timing): `gdn-equiv`'s 72 cases
byte-identical with the switch on and off, and identical to the dump taken
before the change; a planted one-ulp mutant in the kernel changed exactly the
52 S_v=128 scalar-gate cases and nothing else; the 0.8B real graph
(state_size 128, so the path is live there, as on the 27B) byte-identical on
and off. **Not yet run:** the production-toolchain check (GCC 11.4, AVX2 only,
where a row is 16 registers); `prod-toolchain-check.sh` now includes the
regrow checks plus an informational timing that shows whether the path is live.

Timing, all runs valid (same workload, 43,118 exchanges, local 0, verify_fail
0, text identical); raw artifacts in `shielded/bench-harness/results-2026-09-23/`:

| measure | off | on |
|---|---|---|
| `gdn-bench` alone, 2 tokens x 8 threads (us/call) | 62.8 / 63.6 / 65.8 | 37.2 / 38.1 / 38.9 |
| `gdn-bench` alone, 1 token x 8 threads | 32.7 / 34.5 | 20.0 / 20.5 |
| `gdn-bench` alone, 2 tokens x 1 thread | 395.2 | 193.0 |
| 27B op profile, 1 row (plain step) | 70.6 / 68.6 | 61.9 / 58.8 |
| 27B op profile, 2 rows (verify) | 154.8 / 146.1 | 135.1 / 134.8 |
| 27B op profile, 17+ rows (prefill) | 373.3 / 387.8 | 283.8 / 278.0 |
| 27B op profile, MUL_MAT 2 rows (control) | 13.1 / 12.7 | 13.2 / 13.0 |

The op is 10-13% cheaper in the graph (the control op is flat), worth about
0.7 ms of a verify round and 0.4 ms of a plain step at 48 recurrent layers: an
estimate from per-call deltas, ~1% of the round. Throughput pairs: three
complete, mixed signs (+5.3%, -1.5%, +5.4%): **no throughput effect
established**, as expected for a ~1% effect against the 18-24 tok/s spread.
The fourth pair is dropped: rg-off-4 was SIGKILLed mid-load at 10:42:06
together with every process this session had started (the run, its wrapper
and queue, the samplers and both V100 workers; worker logs stop with no
shutdown line; no OOM, nothing in either journal). A peer session had started
a build at about that time believing the queue had exited; what delivered the
kill was not identified.

**Where the rest of the op's time is.** Alone it costs 38 us at 2 tokens; in
the graph 135 us. The hypothesis is the cold state: 48 layers x 3 MB exceeds
the L3, and a 2-row verify also copies the whole state into the rollback slot,
a second 3 MB written to a cold destination. If a warm state recovered most of
the ~100 us per layer, that would be ~4-5 ms of a verify round, the largest
CPU lever identified; the only hook that runs during an exchange wait
(`sh_link_set_idle_work`) cannot see the recurrent op's state, so any warming
would have to be arranged from the graph side. `gdn-bench` gained a mode for
exactly this (rotating per-layer cold states, optional untimed warm-up before
each timed call), **written but not run**: the machine was released to the
isolation work before it could be. Everything above is a measurement except
the per-round estimates and this hypothesis.

Unchanged: both production Freivalds rejections (sterms-1, b-eq-1) open; the
conv multi-sequence limitation documented; no model-matched quality evaluation
of the 27B shielded encoding. **No 25.**

### 18.52 Where a verify round goes now, the rollback snapshot, and a bench argmax that was 3.5% of the round

Checkpoint from the session after the M3b kernel boot (7.2.0-gbf5bafed3e6d,
NVIDIA 580.178.04; same worker binary 9039023a, same model and calibration).
Raw artifacts in `shielded/bench-harness/results-2026-09-23/`.

**The rollback snapshot is half of the recurrent op.** `gdn-bench` with 48
rotating per-layer states (so the state arrives cold, as in the graph), 2 tokens,
8 threads: 164.9 / 164.3 us per call with the K=2 rollback snapshot, 80.1 / 82.7
without it (K=1), 73.8 / 59.1 for one token (no snapshot copy). The copy writes
3 MB per layer into a slot nothing reads unless the draft is rejected, and with
ordinary stores each destination line is first read for ownership.
`wasm/llamacpp-gdn-ntsnap.patch` (switch `ENCLAVE_GGML_GDN_NTSNAP`, default on
in the fork, not deployed) writes the snapshot with streaming stores and one
fence per thread chunk: the same bytes, so bit-identical by construction, and
checked (gdn-equiv on/off and against the pre-change dump with every slot
dumped; a mutant per streaming branch caught in 4 and 16 cases; the 0.8B real
graph's rollback scenario identical). Cold-state timing, ABBA x3: 120.7-137.9
us on against 151.1-168.0 off (every on run below every off run, ~-18%); the
no-snapshot control (K=1), which the switch cannot affect, varied 54.7-79.5 us
between processes, so process-to-process noise is ~+-15 us and this effect is
outside it. Not yet measured in the 27B graph; worth ~1 ms of a verify round
if it carries over. Separate processes of this microbenchmark differ by up to
~20% (not huge pages: every run had 298 of 299 MB on THP), so single A/B
readings of it are not evidence. Its warm-up mode is confounded (the warm-up
lets the pool threads sleep) and is not evidence either.

**Where a verify round goes** (`ENCLAVE_SCHED_PROF=1`,
`wasm/llamacpp-sched-prof.patch`, instrumentation only, and a per-round phase
line in the bench; run sp-1, medians):

| part of a round | ms |
|---|---|
| shielded splits (321 per pass) | 49.0 |
| CPU splits (321 per pass), op work ~13.6 of it | 14.7 |
| scheduler loop + input copies | 0.2 |
| llama graph build + alloc (graph reused) | ~1.3 |
| MTP draft | ~4.8 |
| the bench's greedy argmax (2 rows x 248,320) | ~2.7 |
| rewind (22% of rounds) | 0.003 |

The phase trace of the same configuration (pt-1) splits the shielded part: card
0's exchanges 33.0 ms and card 1's 36.6 ms per round run concurrently, the join
waits 4.7, wire 21.5, mask 4.2, unmask 2.7, rhs 3.6, check 0.25. One more
finding: **the CPU splits are where runs differ.** The same op work took 14.7
ms per verify round in sp-1 and 21.7 in ph-1 (a slow run): the per-split
dispatch cost went from ~3 us to ~25 us across 321 splits. That is a concrete
place for the run-to-run spread, not yet a cause; the OpenMP wait policy was
already measured optimal twice (sections 16 and 18.7) and is not re-tried.

**The bench's argmax.** It compared `lg[t] > lg[b]`, reloading `lg[b]` through
a data-dependent address: 1.69 ms per two-row round alone, 2.7 ms in the run.
The engine selects with a one-branch host top-k scan (`topk_rows` in
wasmtime-nn-ggml.patch), so this was a harness artifact that under-reported the
engine. The register-max form keeps `m == lg[b]` as an invariant, so every
comparison and every pick are the ones the old form made (and the plain-token
hash stayed 0a1570d184a4 in every run); alone it costs 0.30 ms. One valid pair
so far: 21.24 old against 21.91 new; the second pair was invalidated by a
peer's compile (the validator's intruder check), the third not run. Whatever
its size, it is a harness change and is reported as one.

**pt-1 reached 24.51 tok/s** (valid, identical text), the highest valid
reading so far, with the old argmax and both kernel changes. It is one run in
a 20-24.5 spread, not the milestone: **no verified 25**.

The session then yielded the box to a peer's CPU-heavy isolation build (queue
stopped between runs, workers down). Next, when the box is free: the argmax
pairs to completion, the ntsnap 27B op profile, and baseline runs with
`ENCLAVE_SCHED_PROF=1` to see whether the slow runs are the CPU-split runs.
Unchanged: both Freivalds rejections open; the conv multi-sequence limitation;
no model-matched quality evaluation of the 27B encoding; the production-toolchain
run of the regrow/ntsnap checks not yet executed.

### 18.53 The production toolchain catches a regression; two harness gates were measuring the wrong thing

**Register row: a production regression, now compiled out there.** The
production-toolchain check (ubuntu 22.04, GCC 11.4, `-mavx2 -mfma`, the
workflow's CPU flags) passed every bitwise check for both new kernels (regrow
and ntsnap: gdn-equiv on/off and the real graph on/off). Its informational
timing then showed the register row **~55% slower on AVX2** (116.3 / 113.5 us
against 73.5 / 72.5): at 8 floats per vector a 128-float row is all 16 ymm
registers before one accumulator, and the compiler spills. It now compiles only
at 16 floats per vector (AVX-512); re-run, the AVX2 build shows on and off equal
(71.9 / 79.4 against 74.1 / 73.7, i.e. the calls in both) and ALL CHECKS PASSED,
while the AVX-512 host build keeps it (57-60 against 78-83 us). The host bench
has always been an AVX-512 build and production is AVX2, so any CPU-kernel gain
measured here needs this check before it counts for production.

**The streaming snapshot in the 27B graph:** the 2-row recurrent op 130.4 ->
112.2 us (np-off-1 / np-on-1); the 1-row call, which takes no snapshot, 62.8 /
59.4 and MUL_MAT 12.1 / 12.9 as controls. The second pair's profiles agree
(126.7 off, 107.7 on).

**The argmax, within-run.** Throughput pairs cannot resolve a 2 ms effect
against this spread (four valid pairs: +0.67, +0.27, -0.38, -2.15), but each
run's own artifacts can: the round time outside the draft and verify timers,
where the argmax is, was 3.79-4.23 ms (old) against 1.70-2.02 (new), every
new run below every old one: **-2.2 ms per round**, ~2.7%.

**The spread is not the CPU ops' work.** Across eight op-profiled runs, verify
ranged 67.6-79.9 ms while the CPU op time inside a verify graph stayed at
12.2-15.2 ms with no relation to it. Six identical instrumented runs (vb-1..6,
`ENCLAVE_SCHED_PROF=1` + phase trace, verify 76.2-84.0) put it in both halves:
per ms of verify, the CPU-split wall moves +0.45 (r=0.83) and the shielded-split
wall +0.63 (r=0.88), and inside the shielded part the join (card 0 waiting for
card 1's helper) moves most, 4.3-12.6 ms per round. Card 1's device time is
only ~1.6 ms per round above card 0's (worker logs), so most of the join is
the helper thread being late, as 18.7 found. Between the fastest traced run
(pt-1, verify 64.7) and a typical one (vb-3, 76.2), wire is the same (21.5 /
21.1) and every CPU-bound shielded phase is slower together (mask 4.16 / 4.91,
unmask 2.72 / 3.72, rhs 3.55 / 5.22, mask kernel 2.86 / 4.80): a whole-CPU
slowdown, not an op. Pads were never short (missed 0, waited 0). Cause still
not identified; transparent huge pages were the next candidate (this boot, THP
is obtainable: one run's bench held 25.1 of 28.2 GB anonymous memory on huge
pages) but that batch was stopped, see below.

**Two harness gates were measuring the wrong thing.**
- `ps` reports `pcpu` as a LIFETIME average. The quiet gate and the post-run
  intruder check both used it, so a process busy hours ago reads as busy now
  and a fresh burst reads as idle. The desktop compositor (picom) had averaged
  53% over 4.6 hours and was really at ~88-91% of a core (3 s windows), which
  stalled the huge-page batch at its gate and invalidated its first run. New
  `cpunow.py` measures per-process CPU over a window; `waitquiet2.sh` and
  `run9.sh` (foreign CPU sampled DURING the run in 5 s windows, `.intr`) use it.
- The renamed bench binaries (`bench-spec2.fast`) have a 15-character process
  name `bench-spec2.fas`, so `pgrep -x bench-spec2` (the double-bench guard)
  and the CPU sampler never matched them. The queues were strictly sequential,
  so no two benches overlapped, but the guard was off; variants now live in
  `bin-*/bench-spec2`.

No timed runs are possible while the compositor burns a core; the box is not
quiet. **No 25.**

### 18.54 Wrap-up: the official path, a candidate excluded by it, and what shipped

**Setup of record** (every run below): AMD EPYC 9115 (16 cores / 32 threads,
one NUMA node, 128 GB), two V100-class cards on PCIe 3.0 x8 (card 0 Tesla
PG500-216, HBM 1107 MHz; card 1 Tesla V100-PCIE-32GB, 877 MHz), Linux
7.2.0-gbf5bafed3e6d (the M3b kernel), NVIDIA 580.178.04. Model
Qwen3.8-27B-UD-Q4_K_XL with its shielded calibration
(`metal/shielded-overlay/calib/qwen3.8-27b-mtp-q4-vl-gguf.calib`), MTP
self-drafting k=1, 64 generated tokens, 8 decode threads, column split
(`SHIELDED_SPLIT_COLS=1`), `SHIELDED_OVERLAP_VERIFY=1`, refill batch 64, pool 64,
max m 64, masking and Freivalds verification on throughout, fresh pads per run.
Worker binary 9039023a0be03d66, shielded backend fe206527652eecf5, engine drop
`ell-new` (libenclave_llama), bench `bin-fast/bench-spec2` 163786179d429334
(the register-max argmax). Harness `shielded/bench-harness/` (`run10.sh`,
`validate.py`, `waitquiet3.sh`); raw artifacts in `results-2026-09-23/`.

**The official path.** The llamacpp-toolchain workflow's tree was rebuilt
exactly (LLAMA_COMMIT ddd4ec14 + graph-slot, cuda-graph-ptr-update, sync-instr,
rs-pin-cells, topk-rows, parallel-copy, parallel-rows, rs-inplace, in workflow
order) and compared byte for byte with what a fresh checkout plus those patches
yields. The one candidate that could run on it was the streaming-store snapshot
(the register row compiles out on the workflow's AVX2 build, and its diff is
fork-relative), so `llamacpp-gdn-ntsnap.patch` was rediffed against that tree.

1. `official-toolchain-check.sh` (ubuntu 22.04, GCC 11.4, the workflow's flags
   `-mavx -mavx2 -mfma -mf16c -mbmi2 -msse4.2`): gdn-equiv NTSNAP on/off
   byte-identical (72 cases, every snapshot slot dumped); the 0.8B real graph's
   rollback scenario identical; cold-state op at the 27B verify shape (48
   rotating states, 2 tokens, K=2), ABBA x2: on 138.2 / 140.7 / 138.0 / 129.5
   us against off 134.7 / 164.5 / 189.3 / 174.9; the no-snapshot control (K=1)
   91.2-97.4 both ways. ALL CHECKS PASSED.
2. The shielded 27B through that official build (host-built with the same CPU
   flags, `GGML_NATIVE=OFF`), NTSNAP off vs on, ABBA (`abofficial.sh`):

   | pair | off: spec (verify ms/round) | on: spec (verify ms/round) |
   |---|---|---|
   | 1 | 21.05 (78.25) | 19.52 (84.53) |
   | 2 | 21.40 (77.22) | 19.97 (82.47) |
   | 3 | 19.69 (82.80) | **invalid**: intruder electron:65 (18.62, 87.77; text identical) |

   All six runs: 43,118 exchanges, local 0, verify_fail 0, text identical,
   obs_fail 0, plain-token hash 0a1570d184a4. The plain phase, which takes no
   snapshot, did not move (55.27 / 53.45 off, 50.44 / 54.37 on).

**ntsnap is EXCLUDED.** In both valid pairs the verify round is ~5 ms slower
with it (-1.5 tok/s), and nothing already recorded overrides that. **Correction
to 18.52-18.53:** I reported its op-level gain (the 2-row op 130.4 -> 112.2 us
in the fork's profile) and projected ~1 ms per verify round without checking
the rounds of those same runs; they pointed the other way (np-on-1 / np-on-2
verify 75.95 / 79.90 against np-off-1 / np-off-2 67.62 / 75.71). The op gets
cheaper and the round gets slower; the mechanism is not measured (a plausible
one: the 144 MB of snapshot per round is written to DRAM immediately instead
of lazily, competing with the pad refill and the ops that follow). The patch
stays in the repo marked NOT APPLIED; it is not in the workflow.

**What landed** (branch `perf/shielded-27b-wrapup`):
- `wasm/ggml-shielded/bench-spec.cpp`, `bench-batch.cpp`: the greedy argmax
  keeps its running maximum in a register. Identical picks (invariant
  m == lg[b]; 200 rows incl. ties at the maximum and signed zeros agree), 2.2
  ms less per round measured within-run (18.53). A benchmark fix, not an engine
  change: the engine already selects with a one-branch top-k scan.
- `wasm/llamacpp-conv-inplace/official-toolchain-check.sh`: the official-path
  gate for the next CPU-kernel candidate.
- Records: `llamacpp-gdn-ntsnap.patch` (official-tree diff, NOT APPLIED, with the
  numbers), `llamacpp-gdn-regrow.patch` (NOT APPLIED: AVX-512 only,
  fork-relative), and the README's list of what ships.
- The official llama.cpp build (`.github/workflows/llamacpp-toolchain.yml`) and
  the official shielded backend and worker are UNCHANGED by this wrap-up.

**Best validated results.** Official path (the production CPU flags, no
candidate): 21.05 / 21.40 / 19.69 tok/s, median 21.05, best 21.40. Development
fork (AVX-512 host build with the register row and ntsnap, now known to cost
the round): clean baseline bt-1, bt-3..7 = 21.08 / 22.72 / 21.20 / 21.48 / 21.39
/ 17.51, median 21.30; the best single valid run of the whole campaign 24.51
(pt-1). **No verified 25 tok/s**, sustained or otherwise.

**Rejected or not integrated, and why:** token-fused recurrence (slower); conv
in place (neutral); register row (AVX-512 only, AVX2 regression, fork-relative);
streaming snapshots (round slower on the official path); scheduler
instrumentation `llamacpp-sched-prof.patch` (diagnostic only, off by default,
not for production); k=2 re-test (incomplete: its k=2 arms were invalidated by
peer builds or stopped for this wrap-up; the context runs put k=2's round at
116-122 ms for 2.29 tokens, i.e. still below k=1, consistent with 18.32).

**Harness defects fixed this session:** the quiet gate and intruder check used
ps's lifetime-average CPU (now `cpunow.py` windows, sampled during each run);
renamed bench binaries escaped `pgrep -x` (variants now `bin-*/bench-spec2`);
the desktop compositor (busy while a GPU monitor animates) is recorded per run
and exempt, since it can only slow a run.

**Open:** both production Freivalds rejections (sterms-1, b-eq-1); the conv
multi-sequence limitation; no model-matched quality evaluation of the 27B
shielded encoding; the run-to-run spread (whole-CPU slowdowns within a run, not
huge pages, not the GPUs, not the CPU ops' work) is unexplained.

### 18.55 The multi-sequence abort was the official graph-slot patch; fixed and validated

The "multi-sequence limitation" carried since 18.46 as a property of the development
fork is in the OFFICIAL build. On the llamacpp-toolchain workflow's own tree
(LLAMA_COMMIT + its patches, host build with the workflow's CPU flags), a context
with `n_seq_max = 3` and llama's default per-sequence KV cache aborts on its first
2-8 token single-sequence decode:
`process_ubatch -> ensure_slot_alt -> graph_reserve -> build_layer_attn (qwen35) ->
ggml_mul: GGML_ASSERT(ggml_can_repeat(b, a))`. `ensure_slot_alt`, from
`llamacpp-graph-slot.patch` (mm10's small-batch graph slot), reserved each slot with
`n_seqs = 1` against `memory->init_full()`, which spans `n_seq_max` KV streams unless
the cache is unified; stock `sched_reserve` never pairs a single-sequence reserve with
a multi-stream memory context. `LLAMA_GRAPH_SLOT_ALT=0` made the scenario complete,
which isolated the cause.

**Fix** (in `llamacpp-graph-slot.patch`, two added lines of the patch become
eleven): reserve with the stream count, `kv_unified ? 1 : n_seq_max`
(`graph_reserve` rounds `n_tokens` up). Unified contexts, which is what the engine's
server contexts create (`ell_new_server`, the MTP server: `kv_unified = true`), keep
exactly the old reservation. The reservation only sizes the slot's buffers; the
decode graph is built from the real ubatch, so numerics cannot change.

**Validation** (0.8B qwen35 on the CPU, `graph-slot-check.sh`: plain, spec, lifetime
and multi, each with the per-sequence and the unified KV cache, slot on vs
`LLAMA_GRAPH_SLOT_ALT=0`, byte-identical logits required):

| build | per-sequence KV | unified KV |
|---|---|---|
| official, before | plain / spec / lifetime PASS; **multi aborts** (slot-on arm, rc 134) | all 4 PASS |
| official + fix, host | all 4 PASS | all 4 PASS |
| official + fix, ubuntu 22.04 / GCC 11.4 / AVX2 (`official-graph-slot-check.sh`) | all 4 PASS | all 4 PASS |

The fixed build's dumps equal the unfixed build's in all 7 cells the old code
completed; in the aborting cell the unfixed partial dump (21,852,160 bytes) is an
exact prefix of the fixed one (45,690,880). Every workflow patch after graph-slot
still applies. Dump hashes, summaries and the backtrace:
`bench-harness/results-2026-09-23/graph-slot/`. Masking, Freivalds verification and
fail-closed behaviour are untouched (this is host-side scheduler buffer reservation).
Production exposure before the fix is unverified: the engine's multi-session contexts
are unified, which the old code handled.

**Not live**: the fix reaches production only through a manual `llamacpp-toolchain`
dispatch and a `WASMTIME_IMAGE` repin, each needing its own review and release window.

**Deploy path.** Merging the branch still cuts a release (`deploy.yml`: any `wasm/`
path -> image rebuild, release, `update-fleet`; seven harness/record pushes did so on
2026-09-23). `shielded/proposals/` holds an UNAPPLIED, source-justified exclusion for
benchmark sources and the CPU-kernel harness directory, simulated with deploy.yml's
own detect block: those 8 paths stop triggering, every image input and backend source
still triggers, and the branch's three `wasm/*.patch` records still trigger.

**Checked, nothing to correct:** no shielded-lane document or source cites a VMPL0
refusal as confinement evidence (the isolation lane's 2026-09-23 correction).

**Still open:** both production Freivalds rejections (sterms-1, b-eq-1), unexplained;
no model-matched quality evaluation of the 27B shielded encoding (token equality is
not a quality measurement). No verified 25 tok/s.
