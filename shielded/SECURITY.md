# Shielded inference — security argument

Scope: the masked-offload tier described in [docs/shielded-inference.md](../docs/shielded-inference.md).
Companion artifacts: [`reference/shielded_ref.py`](reference/shielded_ref.py) (executable
oracle), [`protocol.py`](protocol.py) (worker admission rules), and the tests in
`test/shielded-*.test.mjs`. Claims below that are checked by the oracle say so; claims that
rest on a cited construction name it; claims that rest on our own analysis are marked
**[our analysis]** and say what would falsify them.

Status: DESIGN + reference. No engine code has shipped. This document is the argument the
implementation must preserve, not a statement about deployed software.

## 1. Threat model

**Adversary.** The GPU host operator, with root on the box, full PCIe/DMA visibility, the
ability to read VRAM at any time, and the freedom to replace the GPU-side runtime with
anything they like. They may run arbitrarily many requests of their choosing, observe every
byte the worker receives and returns, and lie about results.

**Trusted.** The contents of the AMD SEV-SNP CVM, and nothing else. Specifically NOT: the
GPU, its driver, the host kernel, the hypervisor's good behaviour, or operator restraint.
Any design element that required trusting those is rejected by definition rather than by
measurement.

**Secret.** Prompts and completions; input and output audio; input and output images;
voice-cloning reference audio; all activations; the KV cache; logits; sampling state; the
masks, mask seeds, Freivalds secrets `s` / `s̃`, and the RNS residue channels of any of the
above.

**Public, by design.** Model weights and architecture (open-weight catalog models only —
weight secrecy is an explicit non-goal, and the constructions actively require the TEE to
know `W`). Also public: padded tensor shapes, graph topology, bucketed sequence/audio/image
dimensions, request timing, and the fact that a request occurred.

**Not defended.** Availability (a hostile host can stall or refuse; we detect and abort).
Side channels against SEV-SNP itself. Traffic analysis beyond the declared buckets. Model
extraction via the public API surface.

## 2. What the accelerator sees, and why it learns nothing from it

Every tensor crossing the boundary is `x + r (mod p)` with `r` a fresh uniform draw over the
field, used exactly once. Over `Z_p` that is a one-time pad, so the ciphertext is uniform and
independent of `x` — information-theoretically, reduced to computational only because `r` is
PRG-derived (AES-CTR in production; blake2b-CTR in the oracle).

This is Slalom's construction (arXiv:1806.03287 §3), unchanged. Its preconditions are the
ones we must not break:

1. **One-time use.** Two tensors masked with the same `r` hand the adversary `x₁ − x₂`. For
   successive decode activations, which are highly correlated, that is close to handing over
   the activations. The mask bank therefore issues on a strict monotonic counter and
   **stalls** when dry (`MaskExhausted`); it never wraps. Oracle-checked (`no_mask_reuse`,
   `exhaustion_stalls`).
2. **Exact arithmetic.** One-time pads have no exact group structure over IEEE floats:
   `(x+r)W − rW ≠ xW` once `r` is large, and there is no uniform distribution over the
   floats. All masked arithmetic is integer, in a prime field. This is why the tier is a
   field-GEMM tier and not an fp16 tier.
3. **No magnitude wrap.** A value exceeding `p/2` wraps and decodes to noise *silently*.
   See §5.

Empirical check, not just argument: the oracle records the adversary's full transcript across
a 12-token generation (352 boundary crossings) and tests it against the true secrets.
Uniformity chi-square 54.4 against a 117 threshold; pooled correlation 0.0007 against a
3-sigma null of 0.019; no observed tensor ever equals its secret. Per-tensor correlations are
reported alongside their null bound, because on 64-element tensors the null max is ~0.44 and
an earlier version of this suite nearly recorded that noise as a leak.

## 3. Per-op leakage argument

| Op | Placement | Argument |
|---|---|---|
| QKV / O / FFN up,gate,down / lm_head matmuls | GPU, masked | Slalom OTP; weights public so `u = r·W` is precomputable. Worker sees uniform field elements. Oracle: `recovery_bit_exact`, `gpu_ever_saw_plaintext_input == false`. |
| Conv2d (SDXL UNet) | GPU, masked | Convolution is linear in the input, so the identical OTP applies with `u = Conv(r, W)`. Oracle: `conv_offload_exact`. |
| ViT encoder matmuls | GPU, masked | Same as any linear. Additive masks, never bare permutation (§4). Oracle: `vit_offload_matches_reference`. |
| QK^T, attn·V — **prefill / batched** | GPU, masked | TwinShield OutAttnMult (arXiv:2507.03278 Eqs. 6–8). Both row blocks are individually uniform; secret row/column permutations and secret scalars `a`,`b` hide which block is data. Sound only at large `m` (§4). Oracle: exact at m=64 and m=256; costs 4× the bare FLOPs. |
| QK^T, attn·V — **decode (m=1)** | **TEE, permanently** | No cited construction protects an activation×activation product at m=1, and the natural one is broken (§4). |
| softmax, RMSNorm/LayerNorm, SiLU/GELU | TEE | Nonlinear on secret data. TwinShield's OutSoftMax is not adopted: its GPU leg is inherently real-valued (`e^x` is meaningless in `Z_p`) and the paper never bounds the mask range, so the hiding claim would silently degrade from perfect to statistical. Refused by the worker's op denylist. |
| RoPE | TEE | Consumes token positions; also the reason the permutation-equivariance theorems do not cover decode. |
| Embedding lookup | TEE | A gather keyed by the secret token id. As a matmul it would cost `n_vocab·d` per token. |
| KV cache | TEE RAM | §4 and §6. |
| Sampling, scheduler/noise-schedule math | TEE | Secret state; trivially cheap. |
| VAE decode, vocoders, mel spectrogram, phonemization, text encoders ≤2B | TEE CPU | Small-model rule: CPU-in-TEE is a strictly stronger guarantee than masked offload, so take it whenever the latency budget allows. |

The worker enforces this table structurally rather than by convention: `protocol.py` accepts
only `{FIELD_GEMM, VIEW, RESHAPE, PERMUTE, TRANSPOSE, CONT, CPY}` and names a refusal reason
for each denied op. Plain `MUL_MAT` is refused specifically because it would run on unmasked
data.

## 4. Two constructions we deliberately do not use

### Bare permutation is not protection when weights are public

KV-Shield (arXiv:2409.04040) protects the KV cache by feature-permuting `W_{q,k,v}` and
inverse-permuting attention output. Against public weights this is void: the untrusted side
necessarily holds `W·Π` and `W` is published, so hashing columns recovers `Π` in ~O(d) — no
search, no cryptographic hardness, and the `d!` keyspace is irrelevant. Neither KV-Shield nor
the permutation-equivariance paper (arXiv:2304.07735) analyses this, because both assume
either secret weights or a non-adversarial reader. **[our analysis]**

What we do keep from that literature is correctness bookkeeping: the per-op commutation rules,
and the constraint that multi-head feature permutations must be within-head ⊗ head-swap
(768! → 12!·64!) — which KV-Shield's own single-head formulas violate.

### TwinShield attention offload is broken at decode

**[our analysis, oracle-verified]** At m=1 the packed block is two rows, `u = q + R_q` and
`v = a·R_q`, in secret order. Either way `q = u − c·v` for one unknown scalar `c = a⁻¹`, so
**q is confined to a line in `Z_p^d`**. The paper's accounting (log(d·(2m)!) bits) counts a
brute-force space, but none is needed: real activations are small while `u − c·v` is uniform
for wrong `c`, so enumerating plausible values of one coordinate pins `c` to a few thousand
candidates and a second coordinate filters to a unique answer.

The oracle implements this attack and recovers `q` exactly at **m=1, m=2, and m=4**. m=4
matters because it is a real GQA group size: batching a decode step's query heads against
their shared KV head does not rescue the construction. Measured search space (pairings ×
plausible-scalar candidates): m=1 → 14 bits, m=4 → 24, m=8 → 42, m=16 → 86, m=32 → 191,
m=512 → 4907. At m=32 the attack is run with a real budget and fails.

Consequences, which are load-bearing rather than conservative: attention offload is
**prefill/batched only**, decode attention stays in the TEE permanently, and cross-request
row batching to inflate `m` is rejected because it would make a security parameter depend on
batch occupancy, which the *untrusted host controls*. A security property the adversary can
turn down by starving the queue is not a security property.

Falsifiable by: a construction whose hiding at m=1 does not reduce to a low-dimensional
candidate family. We are not permitted to invent one (no custom cryptography beyond the cited
constructions), and doing so inside a TCB would be reckless regardless.

## 5. Integrity

**Mechanism.** Slalom's preprocessed Freivalds (Lemma 3.1): the TEE keeps secret `s` and
`s̃ = W·s` per weight matrix and checks `y·s == x·s̃` — O(|x|+|y|) multiplications, optimal even
at batch 1, where naive Freivalds would cost as much as recomputing. Soundness ~2⁻⁴⁰ per check
(|S| ≈ 2²⁰, k=2). `s` is secret: a worker that learned it could forge `y'` with `y'·s == y·s`.
Reuse of `s` across layers/steps decays soundness only linearly (union bound), so resample
periodically rather than per-op. Oracle: 64/64 single-element lies caught, no false positives.

**`s` must come from a CSPRNG, and this is a live footgun rather than a formality.** Both
halves once defaulted to a reproducible generator -- `np.random.default_rng(1234)` in
`tee.py`, `Math.random` in `metal/guest/shielded.mjs` -- which is the same thing as publishing
`s`, because the worker is assumed to have read this repository. Given `s`, forging is not
even hard: two check repetitions are two linear constraints, so solving `d·s == 0 (mod P2)`
over any THREE outputs yields a `d` with `y + d` accepted and decoded as garbage. The soundness
bound above describes a worker that must guess; it says nothing about one that can read.
Both defaults now seed from the OS CSPRNG, and `test/shielded-tee.test.mjs` fails if either
becomes reproducible again -- including the case where a caller merely forgets the argument.

**Policy.** Every offloaded product for a token is verified before that token is sampled or
streamed. There is no stream-now-verify-later window. On failure the request aborts, the
event is logged as a worker-integrity incident, and the box is quarantined from the tier.

**The cache rule.** **[our analysis]** A corrupted activation costs one token; a corrupted KV
entry poisons every future token that attends to it. K and V arrive from an *offloaded*
matmul and then persist for the session, so KV-producing matmuls are verified **strictly, per
step, before insertion**, with no deferral — even where other matmuls could amortise their
checks. No source paper states this because none of them has a cache. Oracle: a worker
tampering only with the key projection is caught with nothing inserted.

**Silent-wrap guard.** A field value exceeding `M/2` wraps and decodes to noise with no error
signal, which would corrupt output indistinguishably from a numerics bug. Measured: the
accumulator requirement is flat at ~18.7 bits from d=64 to d=14336 (1/√d init is
variance-preserving, so width is *not* the risk); overflow appears near 10⁴× outlier
channels while 10³× still fits. Known LLM massive-activation channels run 10²–10³×, so the
margin is roughly one bit.

**2026-08-25: the margin was not there.** On a real forward pass (Qwen2.5-0.5B, REPORT.md
§10.2) `ffn_down` reaches **1.81× M/2 and wraps** at the design's fixed `l = 8`, and the
model goes on producing fluent English while doing it. Two changes follow, both implemented:

- **Detection is exact and free.** The Freivalds check is run over the integers, modulo a
  prime unrelated to `M`, instead of mod `M`. A wrapped `ŷ` differs from the true product by
  `c·M`, so the identity `ŷ·s == x·(W·s)` fails mod `P2` with probability ≥ 1 − 1/|S| per
  repetition. The same two dot products now catch a lying worker *and* a field wrap, and the
  construction strictly subsumes the mod-`M` version. A mod-`M` check cannot catch a wrap at
  all — the wrapped value is congruent — which is why the previous formulation of this
  paragraph asked for a separate guard.
- **Prevention is outlier splitting, and it moves work INTO the enclave.** The overflow is
  driven by a handful of channels (`ffn_down`: median channel 1.5, max 443). The TEE keeps the
  top-k channels and computes their contribution in plain int64 where nothing can wrap;
  `k = 4` takes that site from 1.81× to 0.12×, at 0.08% of its multiplies.

**Leakage consequence: none, and strictly negative.** The outlier channel *indices* and the
per-site activation exponent are static properties of the public weights, calibrated offline
on public text (`shielded/calibrate.py`) and shipped like a GGUF imatrix — identical for every
prompt and every user, so they carry no information about anyone's input. The *values* in
those channels are never offloaded at all, so the accelerator sees strictly less than before.

**What is deliberately NOT done:** adapting the activation exponent per request. It would buy
field headroom, and it would make a public parameter a function of secret activation
magnitude — a real leak. The exponent is fixed offline and the runtime never touches it. An
input that overflows anyway aborts the request, which is an availability event and is already
conceded in §1.

RNS over coprime primes (oracle-verified exact) remains the escape hatch for a tensor that
outlier splitting cannot rescue. RNS changes representation, not the OTP argument: masking
independently mod each prime is a perfect pad per channel.

## 6. Residual leakage, per interface

Common to all: request timing and duration, request count, model identity, graph topology
(hence architecture — public anyway), and total offloaded byte volume. The worker also learns
the *sizes* of everything, since shapes are not padded beyond the buckets below.

It also learns which channels of each activation are always zero, because outlier splitting
zeroes the held-back channels before masking. That set is the calibrated outlier set: a public,
static property of the public weights, the same for every request. It reveals nothing about
any input, and the accelerator could have computed it itself from the weights it already holds.

**A request that aborts is visible.** The magnitude detector and the integrity check both fail
closed, and a host watching the socket can tell that a request stopped early. It cannot tell
which of the two fired, and it cannot learn anything about the input beyond "this one was
unusual enough to overflow, or I was caught lying".

| Interface | Residual leakage | Buckets |
|---|---|---|
| Chat | Prompt and completion length, to bucket granularity; number of decode steps (≈ output tokens) is visible as a count of `GRAPH_RECOMPUTE` doorbells. | Context {2k, 8k}. **Output length is NOT hidden** — a padded-decode mode would be needed and is not designed. |
| STT | Audio duration, to bucket granularity. Expected to run entirely CPU-in-TEE (whisper large-v3 is 1.55B, under the small-model rule), in which case the accelerator learns nothing at all. | Duration: 15s steps to 60s, then 60s steps. To be confirmed against the Phase 2 measurement. |
| TTS | Text length and output audio duration, to bucket granularity. Expected CPU-in-TEE (Pocket TTS ~0.25B; Qwen3-TTS 1.7B fallback). Voice-cloning reference audio is secret input and never leaves the CVM. | Duration buckets as STT. |
| Image generation | Resolution and step count. The number of denoiser round trips directly reveals step count. | Resolution {512, 768, 1024}; steps {≤4 turbo, 20, 28, 50}. |
| Vision (VLM) | Image resolution bucket and patch count; whether an image was present at all. Image contents and everything derived from them are secret. | Resolution buckets as image generation. |

## 7. Assumptions a reviewer should attack first

1. **Mask one-time-ness holds under concurrency.** The bank is shared across sessions; a race
   that issued one index twice is a total break. The invariant is asserted in the oracle but
   the real allocator is concurrent and does not exist yet.
2. **The TEE-side op classifier is deterministic across decode steps.** If placement wobbles,
   `ggml_backend_sched` reallocates and resends topology — a correctness and performance bug,
   and a change in what the worker observes.
3. **`s̃` and mask seeds never leave the CVM.** They are the only values whose disclosure
   converts a hostile worker from detectable to undetectable.
4. **The magnitude guard is actually wired in before encode**, not after, and fails closed.
5. **RNS channels are masked independently.** Reusing one pad across residue channels would
   correlate them and break the per-channel OTP argument.
6. **TwinShield prefill is used only where m is genuinely large.** A short prompt is a small
   m. The threshold must be enforced in code, not assumed from typical usage.

## 7b. Red-team, 2026-08-26 (against the production C stack)

Section 2's transcript check is the numpy oracle. This is the same discipline applied to the
code that actually ships -- the C link (`shielded-tee.c`), the CUDA worker
(`shielded/worker-cuda`), and the pad POOL added for throughput -- because the pool was new
code touching the one invariant (one-time use) whose failure is a total break. The worker was
replaced wholesale with an adversary (a throwaway ~150-line Python worker) that returns
correct products so the tenant run proceeds while writing every byte it receives to disk; the
captured transcript is then attacked. Every masked activation was also dumped in plaintext from inside
the backend (env-gated, reverted) so the attacks could be SCORED against ground truth rather
than assumed to fail.

| attack | breaks the tier if | result |
|---|---|---|
| same prompt run twice, compare exchange-aligned planes | pad is deterministic or reused | 0/591 planes reproduced; mean \|corr\| 0.010 < 0.019 noise floor |
| marginal uniformity of each residue plane | pad is biased | uniform (chi2 247/272/222 vs ~302) |
| pad reuse, pool at depth 1 with 4 refill threads, 1963 exchanges | ring/refill race reissues a pad | 0 repeats in 5889 plane-rows; slow-decode site diff std 101.9 (full noise) |
| ground-truth likelihood: pad from the TRUE x vs from a WRONG x | transcript favours the true input | both uniform (chi2 271 vs 261) -- equal likelihood, i.e. perfect secrecy |
| use the masked value as the estimate of x | masked value tracks x | \|corr\| 0.018 (noise) |
| active worker returns one corrupted element | abort/no-abort becomes a read oracle | Freivalds aborts the request (`llama_decode -3`); learns about `s`, not `x`; output never reaches the worker |
| known-pad-position: outlier channels are zeroed, so at those PUBLIC indices the worker sees `r` in the clear | keystream has cross-position structure | pad autocorrelation ~0.0007 at every lag; R^2 predicting one pad position from another = 0.00000 |

The known-pad-position attack is the one that a marginal-uniformity check does not cover and a
weak-PRNG masking scheme would fail: the operator legitimately observes real pad values (776
of them, at the public outlier indices where `x` is held back to the TEE, confirmed to carry
zero true activation), and still cannot extrapolate the pad by a single position. ChaCha20 is
a CSPRNG; partial keystream does not predict the rest.

No plaintext prompt or response was recovered, and the ground-truth likelihood test shows why
it is not a matter of effort: the transcript is equally consistent with every input of the
same shape.

**Where extraction IS possible, and what that says about where to spend effort.** Given the
pad key, extraction is total: regenerating the ChaCha20 keystream and subtracting recovers
every activation bit-for-bit (147/147 exchanges, verified). So the tier's confidentiality
reduces entirely to one 32-byte value that is generated per link inside the CVM, exists only
as a ChaCha20 input in the engine's address space, dies with the process, and appears nowhere
in the 2.8 MB the worker received -- not the whole key, not any 8-byte fragment. Every real
path to it therefore runs through the ENCLAVE, not the GPU: code placed inside the measured
image, a break of SEV-SNP itself, or a memory-disclosure bug in the engine process. The GPU
operator, which is this tier's stated adversary, has none of them. That is the design working
as intended rather than a caveat -- but it does mean the image's supply chain, not the masking,
is where further hardening pays. The shielded backend is compiled from source during the image
build for exactly this reason (see `metal/README.md`); it used to ship as a committed binary,
which put "whoever built that .so" inside the TCB with no reviewable record. The throughput work (pad pool, one-frame CUDA worker, vsock, shared-x grouping,
decode-only placement) changed WHEN the pad is drawn and HOW FAST it ships, never WHAT crosses.

**The one thing the operator does learn is shape metadata**, which §1's model already treats as
public: the count of generated tokens (each decode step is a fixed burst of `m=1` exchanges),
and -- because a prompt of <= `SHIELDED_MAX_M` (8) tokens has its prefill offloaded at batch
width `m = token count` -- the LENGTH of a short prompt. Content stays masked in every case
(the short-prefill planes are uniform, chi2 228-258). Longer prompts keep prefill in the
enclave, hiding even their length. If short-prompt length must also be hidden, offload decode
only (`m == 1`); prefill offload is not the throughput win and dropping it closes the channel
at no cost. Recorded here rather than silently fixed because it is a placement policy, not a
masking property, and the trade belongs to whoever tunes the tier.

## 8. Provenance

Constructions are used as cited, not adapted: Slalom (additive OTP over `Z_p`, preprocessed
Freivalds, conv masking), TwinShield (OutAttnMult for prefill). RNS/CRT is arithmetic, not
cryptography. No custom cryptography has been introduced, in keeping with the project
constraint; where a cited construction does not cover a case (decode attention), the answer is
placement in the TEE rather than a new scheme.
