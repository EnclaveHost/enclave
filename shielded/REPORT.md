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
