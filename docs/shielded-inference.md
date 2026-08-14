# Shielded inference — masked GGML offload to untrusted GPUs

Status: DESIGN (2026-08-14). No code yet. This document is the synthesis of the required
reading (TwinShield arXiv:2507.03278, KV-Shield arXiv:2409.04040, permutation equivariance
arXiv:2304.07735, Slalom arXiv:1806.03287, Amulet arXiv:2512.07495, and the ggml-rpc source)
against this repo's actual plumbing. It exists so that implementation starts from settled
decisions, not from the papers. Where a paper is silent (all of them are silent on
autoregressive decode), the gap is named and our design fills it explicitly.

Goal: one masked-offload engine serving five interfaces — chat (LLM), STT, TTS, image
generation, vision (VLM) — where user inputs, activations, KV cache, and sampling state are
never plaintext outside the SEV-SNP CVM. The GPU and its host are fully untrusted. Weights
are public (open-weight catalog models only); weight secrecy is a non-goal everywhere.

This is the successor to the "Layer 4" caveat in `worker/worker.py` and
`supervisor.js` (freed VRAM is not zeroed; residual-data scrubbing unimplemented): in the
shielded tier that caveat dissolves, because nothing that ever reaches VRAM is plaintext.
Ghost data in VRAM is ciphertext by construction, not by scrubbing.

## What this does and does not provide

Provides, against a malicious host operator with root on the GPU box, full PCIe/DMA
visibility, VRAM read access, and the ability to replace the GPU-side runtime:

- Confidentiality of prompts, input/output audio, input/output images, voice-cloning
  reference audio, activations, KV cache, logits, and sampling state. Every tensor that
  leaves the CVM is protected by an additive one-time pad over a prime field (Slalom
  construction; TwinShield construction for v2 attention offload). No bare permutation is
  ever the sole protection — a permutation of a known matrix is reversible by column
  matching, and our weights are public (see "Why permutation is plumbing, not protection").
- Integrity: every offloaded product is verified (preprocessed Freivalds), and a request
  aborts before any output token/sample/pixel leaves the CVM if a check fails. A cheating
  GPU can deny service; it cannot make us emit a wrong or attacker-influenced result.

Does NOT provide:

- Weight secrecy (non-goal; the constructions require the TEE to know W, and public weights
  are what make `r·W` precomputation possible at all).
- Shape/timing secrecy beyond declared buckets: padded request shapes, context-length
  buckets, audio-duration buckets, image resolution/step buckets, and coarse timing are
  public. The graph topology sent to the worker reveals the model architecture — which is
  public anyway (curated catalog).
- Availability: the GPU host can stall, refuse, or corrupt (we detect and abort — the
  fallback is CPU-in-TEE or another box, not toleration).
- Anything that requires trusting the GPU driver, host kernel, or operator restraint.
  Per the brief, any such design is rejected by definition.

## The one architectural decision

All five interfaces run on GGML-family runtimes (llama.cpp incl. mtmd for chat/vision/TTS,
whisper.cpp for STT, stable-diffusion.cpp for image gen). We therefore build exactly one
component with two halves:

- **TEE side** (inside the CVM, linked into the ELL engine): a GGML backend + graph
  executor that classifies ops, executes everything nonlinear/sensitive on CPU, and
  offloads masked linear ops to the remote worker. The split mechanism is
  `ggml_backend_sched` — it already partitions a graph across a priority-ordered backend
  list, inserts the cross-boundary copies, and supports per-node pinning via
  `ggml_backend_sched_set_tensor_backend`. Backend order: `[shielded-remote (prio 0),
  trusted-CPU (last, as required by sched)]`. The mask/unmask interposer wraps the only two
  commands that ever carry activation bytes: `SET_TENSOR` outbound, `GET_TENSOR` inbound.
- **GPU side** (`shielded/`, new top-level dir): a stateless worker derived from the
  ggml-rpc server, hardened (below). It holds public weights resident, accepts masked
  tensors, runs a fixed vetted op set, returns masked results. It never sees sampling,
  logits-as-plaintext, nonlinear ops on secret data, or any unmasked activation —
  including transiently.

All five frontends inherit confidentiality from this backend; per-interface work is
pre/post-processing placement. Existing catalog guests (llm-chat etc.) keep their wasi-nn
WIT contract unchanged — the shielded tier is a launch-time engine configuration, not an
app-visible API.

Critical fact from the ggml-rpc source read: **ggml-rpc as shipped is whole-graph** — the
server executes the entire cgraph including softmax/norms/rope on its local backend, and
`GRAPH_COMPUTE` will run any op an attacker serializes (see GHSA-j8rj-fmpv-wcxw). It is a
transport template only. The trust split comes from the scheduler in the TEE; the worker's
compute surface must be reduced to an installed, vetted graph (§ worker protocol).

## Numeric foundation: the field is not optional

Additive one-time masking has no exact group structure over floats: `(X+R)·W − R·W ≠ X·W`
in fp arithmetic once R is large, and "uniform" masks don't exist over IEEE floats. Slalom's
load-bearing move — inherited by TwinShield — is fixed-point embedding into a prime field:

- Field **Z_p, p = 2^24 − 3**; values quantized as `round(2^l · x)` with **l = 8**
  fractional bits (biases at 2^2l). p < 2^24 so field elements and their products remain
  exactly representable in fp significands.
- Masks uniform over Z_p ⇒ per-tensor one-time-pad, information-theoretic hiding (PRG-seeded
  in practice ⇒ computational). Mask reuse leaks differences; masks are strictly one-shot.
- Everything offloaded is exact integer arithmetic ⇒ after unmasking, results are
  **bit-deterministic** and equal to a TEE-computed fixed-point reference exactly. The
  equivalence deliverable becomes a hard equality check in the field domain, plus a
  documented tolerance versus the fp16 GPU baseline (quantization-class noise: Slalom
  measured <0.5% accuracy cost; TwinShield +0.21 ppl on LLaMA-7B at these parameters —
  comparable to a GGUF q8 step. Our catalog already serves q4/q8 quants).

GPU kernel plan for field GEMM, in order, each gated by measurement:

1. **v1 correctness: cuBLAS fp64** with K-chunked periodic reduction (53-bit mantissa
   holds 48-bit products; reduce mod p every ~2^10 accumulations — Slalom's Appendix F
   recipe, near-zero custom CUDA). Fine on datacenter parts; slow (1/32–1/64 rate) on
   commodity GeForce.
2. **v1.5: 12-bit limb split into fp32 GEMMs** (4 GEMMs, exact in fp32 with chunked
   reduction; plain fp32, never TF32 — TF32's 10-bit mantissa is inexact).
3. **v2 throughput: 8-bit limb decomposition on int8 tensor cores** (9 limb GEMMs into
   int32 accumulators, recombine+reduce in the epilogue; cutlass has the kernels). On
   RTX-class parts int8 TC throughput makes the ~9× limb inflation land near ~4–5×
   effective vs fp16 — inside the kill budget, but this is the number Phase 1 must measure,
   not assume.

Weights are converted once at worker start: GGUF → dequant → fixed-point field
representation (per-limb planes for the kernel in use). This inflates weight VRAM vs q4/q8;
budget ~4 bytes/param (fp64 path) down to ~3 (limb paths). Public weights, so resident
plaintext-field form is fine.

## Constructions (cited only, no homebrew)

### Linear offload: Slalom additive OTP

Per offloaded linear op `y = x·W` (matmul, conv-as-im2col, embeddings-as-matmul where ever
actually used):

- Offline: sample `r` from AES-CTR PRG; precompute unblinding factor `u = r·W`
  (for convs: `u = Conv(r, W)`). Store `(seed-index, u)` AES-GCM-encrypted in untrusted
  DRAM/disk (Slalom's trick — the bank does not consume CVM RAM).
- Online: send `x + r mod p`; GPU returns `(x+r)·W`; TEE computes `y = (x+r)·W − u`.
  TEE online cost is O(|x|+|y|) additions. One-shot masks, strictly.

**The precompute economics are the honest core of this design.** `u = r·W` costs the same
MACs as the offloaded product itself, so at 100% duty cycle sustained throughput is capped
by TEE mask-refill rate, not by the GPU. Three things rescue this:

1. Mask generation is a *batched, offline* GEMM (`R_bank · W` for thousands of future
   masks in one streaming pass) — an order of magnitude more MAC-efficient on CPU than
   latency-bound single-token decode, and embarrassingly parallel across idle CVM cores.
2. Banks convert off-peak CPU into peak GPU throughput (store GBs of `u` encrypted on the
   untrusted side).
3. Back-of-envelope for one EPYC-class CVM slice sustaining ~1 T-MAC/s of int GEMM:
   ~7 G-MAC of linear work per 7B-model token ⇒ ~140 masked tokens/s of continuous refill —
   roughly 10× what CPU-only *inference* of the same model achieves (which is latency-bound
   and pays attention+nonlinears at request time). So: masked offload ≈ GPU latency at
   ~10× CPU-only sustained throughput, NOT GPU-native throughput. Phase 1 measures this
   refill rate; the capacity model and the bank-sizing policy go in the final report.

Mask banking is per-(model, layer, shape-bucket), and decode masks for step t+1 are staged
during the GPU compute of step t so mask handling never sits on the token critical path.

### Integrity: preprocessed Freivalds, per token, before anything streams

Naive Freivalds (`y·s =? x·(W·s)`) is useless at batch 1: computing `W·s` costs the same as
the matvec being checked. Slalom's preprocessed variant fixes exactly this: TEE keeps a
secret `s̃ = W·s` per weight matrix (computed once, reusable), and the online check is
`y·s =? x·s̃` — **O(|x|+|y|) multiplications per check even at batch 1**. Soundness with
Slalom's parameters (`s` entries from |S| ≈ 2^20, k=2 repetitions) is ~2^-40 per check; one
secret `s` is reusable across layers/steps/requests with only linear (union-bound) soundness
decay — resample periodically. Checks run on recovered plaintext in the field domain, so
they are exact equalities, no tolerance games.

Policy: verify every offloaded product for a token before that token is sampled/streamed.
Verification is cheap enough to be synchronous per token; there is no
"stream now, verify later" window. Any failure aborts the request (fail closed), logs a
worker-integrity incident, and quarantines the box from the shielded tier.

TwinShield's U-Verify (embedded hash row, ~33% cheaper than naive Freivalds) is noted but
not adopted for v1: preprocessed Freivalds is simpler, batch-1-optimal, and doesn't couple
verification to the masking layout.

### v2 attention offload: TwinShield, with a decode-shaped caveat we found

TwinShield's OutAttnMult offloads `Q·K^T` (both operands secret) by stacking masked blocks
`[Q+R_Q ; a·R_Q]` (secret row perm λ1) against `[K^T+R_K | b·R_K]` (secret col perm λ2);
one 2m×2p GPU matmul (4× FLOPs of the m×p product) returns four blocks from which the TEE
recovers `Q·K^T` with cheap block algebra. OutSoftMax offloads only the exponentials
(`x−r` out, `e^(x−r)` back, rescale by precomputed `e^r`, normalize in TEE). Softmax·V
reuses the OutAttnMult shape.

Our analysis (to be adversarially reviewed before v2 lands — this is TCB work): the
construction's hiding degrades with row count. The GPU sees `a·R_Q` rows raw, so Q is
confined to a (candidate-rows × 2^24-scalar) family rather than an OTP-uniform set; the
paper's own security accounting is `log(d·(2m)!)` bits, which at **decode (m=1) collapses
to ~25 bits**. Additionally, real activations have strong priors, so small candidate
families are dangerous. Consequences baked into the plan:

- v2 offloads attention for **prefill and batched contexts only** (m large: prefill QK^T
  at 1k–8k rows is also exactly where CPU attention hurts most).
- **Decode attention stays in the TEE permanently.** At batch 1 this costs
  ~2·n_layer·n_ctx·d MACs/token on CPU (with flash-attn CPU path + q8 KV) and is the main
  reason the chat kill-criterion is measured at batch ≥ 4.
- Cross-request row batching to inflate m for decode is noted as a possible v3, not
  designed here.
- TwinShield's OutSoftMax has an unresolved numeric hole (real-valued `e^x` vs field
  masks; overflow of `e^(x−r)` for unbounded r) — any adoption must bound mask ranges and
  therefore downgrade the hiding claim from perfect to statistical, documented as such in
  SECURITY.md, or stay TEE-side. Softmax remains in-TEE until that analysis is written.

Per the brief: TwinShield construction only for activation-activation products, no
homebrew variants. The caveats above restrict *where* we use it, they do not modify it.

### Why permutation is plumbing, not protection

KV-Shield protects the KV cache by feature-permuting `W_{q,k,v}` columns (`W·Π`) inside a
TrustZone TEE and inverse-permuting attention output. Against public weights this is void:
the untrusted side holds `W·Π` and public `W`; columns of a trained weight matrix are
pairwise distinct, so hashing columns recovers Π completely in ~O(d) — no search. The
permutation-equivariance paper (2304.07735) supplies what *is* useful: per-op commutation
rules (softmax/elementwise/norms commute freely; linear layers need conjugated weights;
multi-head restricts feature perms to within-head ⊗ head-swap, 768! → 12!·64!), which is
precisely the bookkeeping the masked executor needs to push transforms through a ggml
graph, plus the head-blocked permutation constraint KV-Shield itself missed. We build the
KV-Shield-style permuted pipeline once, as Phase 1 plumbing validation (tensor reordering,
inverse-perm bookkeeping, correctness harness: bit-exact when the permuted axis is not a
contraction axis, ulp-tolerance when it is) — then never rely on it for security.

Also inherited from that read: RoPE consumes token positions inside every layer (token
permutation needs permuted position ids), causal masks must be conjugated, and none of the
published theorems cover incremental KV decode. The correctness harness covers these cases
explicitly.

## Op placement (v1)

| Op class | Where | Why |
|---|---|---|
| QKV / O / FFN up,gate,down / lm_head matmuls | GPU, masked | Slalom OTP + Freivalds; bulk of FLOPs |
| Conv1d/conv2d (UNet, whisper front convs if offloaded) | GPU, masked (Phase 4/5) | Slalom conv masking, `u = Conv(r,W)` |
| Embedding lookup | TEE | it's a gather keyed by the secret token id; as-matmul would cost n_vocab·d |
| QK^T, attn·V | TEE (v1); GPU masked for prefill (v2, TwinShield) | activation×activation; see decode caveat |
| softmax, RMSNorm/LayerNorm, SiLU/GELU, RoPE, residual adds | TEE | nonlinear / cheap / position-secret |
| Sampling, scheduler math, noise schedules | TEE | secret state, trivially cheap |
| KV cache | TEE RAM (plaintext inside CVM) | v1; grows per token; q8 KV to bound footprint |
| Logits | GPU produces masked, TEE unmasks | lm_head is just another masked matmul; sampling never leaves |
| VAE decode, vocoders, text encoders ≤2B, mel spectrograms, phonemization, image pre/post | TEE CPU | small-model rule: CPU-in-TEE is strictly stronger; take it whenever the budget allows |

Small-model rule concretized (≤ ~2B params q8 defaults to full CPU-in-TEE):

- Whisper large-v3 encoder+decoder: 1.55B → **CPU-in-TEE first**; ship CPU-only if RTF
  ≤ 0.5 at target concurrency and skip GPU offload for STT entirely (expected outcome).
- TTS (both candidates, below): well under the line → CPU-in-TEE.
- SD VAE (~50–100M), CLIP-L/G (~0.1–0.7B): CPU-in-TEE.
- T5-xxl (4.7B, Flux/SD3 text encoder) is the one pre/post component over the line:
  masked-offload it, or serve SD3-medium's no-T5 degraded mode where acceptable. Decide
  per catalog model in Phase 3.

## The decode loop (the part no paper wrote down)

Per token, v1, with installed per-segment graphs on the worker:

1. TEE: embed token (lookup), RMSNorm.
2. Per layer: mask x → `SET_TENSOR` + doorbell (fire-and-forget) → blocking `GET_TENSOR`
   of masked {Q,K,V} (one fused round trip — QKV share the input upload); TEE: unmask,
   verify, RoPE, append KV, attention core, norm; masked round trip for O-proj; TEE:
   residual, norm; masked round trip for up+gate (shared input); TEE: activation; masked
   round trip for down; TEE: residual. **4 blocking round trips per layer.**
3. lm_head masked round trip; TEE: unmask, verify all checks for this token, sample,
   stream.

Budget at 7B/32 layers: ~128 blocking RTs/token; at 50–150µs CVM↔host loopback RTT that is
a 6–19ms/token transport floor plus ~5–10MB/token of masked activation traffic (fits
loopback/virtio comfortably). Ceiling ≈ 40–100 tok/s before GPU compute — against the
kill criterion (≤5× vs baseline at batch ≥4) this is tight but credible, and batching
amortizes RTs across concurrent requests. Amulet's two-RT-per-request discipline is the
bar we hold prefill and image-gen to; decode is structurally per-token and the brief
accepts that. Every RT rides a pre-installed graph (`GRAPH_RECOMPUTE`-style doorbell, no
topology resend) — which requires the TEE-side op classifier to be **deterministic across
steps**, because `ggml_backend_sched` reallocates (and would force full graph resends) if
per-node backend assignment wobbles between steps.

Prefill: one masked round trip per linear op over the whole m×d prompt matrix (m = padded
bucket length) — Freivalds batching makes verification ~1 mult/element; this is the
friendly regime, as is diffusion (per-step batched denoiser, seconds-tolerant users).

## Worker protocol (hardened ggml-rpc derivative)

Transport: TCP loopback CVM↔host (repo has no vsock anywhere; house pattern is TCP +
derived-token auth). Framing follows the nn-arbiter lesson: compact, byte-pinned frames
with raw-bytes tests (`wasm_manager.py:1917` — wire format is not style). Auth: bearer
derived HMAC-style from `SECRET` per the `X-Vmmgr-Token` pattern — this gates GPU
consumption; it is *not* a security boundary for confidentiality (masks are). Nothing
secret crosses the link by design, so no TLS in v1; revisit if the worker ever moves off-
box.

Command surface vs stock ggml-rpc (proto 5.0.0):

| Command | Fate | Note |
|---|---|---|
| HELLO | keep | version + capability pinning (op count static_assert stays) |
| ALLOC_BUFFER / FREE_BUFFER / GET_ALIGNMENT / GET_MAX_SIZE / BUFFER_GET_BASE / GET_DEVICE_MEMORY / DEVICE_COUNT | keep | allocation plane |
| SET_TENSOR | keep | the only inbound data path: field-form weights at load; masked activations at run |
| GET_TENSOR | restrict | readable only from declared output tensors of installed graphs; stock allows arbitrary region reads of any live buffer |
| GRAPH_COMPUTE | replace | becomes GRAPH_INSTALL: graph accepted only if every node's op ∈ allowlist {field-GEMM custom op, view/reshape/permute-meta, cpy} — the stock command is an arbitrary-op execution primitive |
| GRAPH_RECOMPUTE | keep | the per-step doorbell; the only compute trigger after install |
| SET_TENSOR_HASH + cache_dir | delete | persists request bytes to disk; nothing may persist |
| COPY_TENSOR / MEMSET_TENSOR / BUFFER_CLEAR | delete | server-side mutation primitives we don't need |
| buffer=0/data≠0 deserialize path | fatal | keep the create_node guard; any unvalidated buffer reference kills the connection |

Statelessness: per-request worker state is masked activations in VRAM only; weights (public,
field form) are the only long-lived residents. Crash/restart of the worker loses nothing
secret and the TEE simply re-verifies on reconnect (weights re-uploaded or digest-checked).

The worker is not part of the measurement and runs no TEE — it can be replaced wholesale by
the operator, which is exactly the point: its honesty is enforced by Freivalds, not by
attestation. On fleet boxes it must coexist with existing tenants: it takes an MPS slice
and (when co-resident with the wasi-nn arbiter) an arbiter-client turn per compute quantum,
same discipline as `worker/worker.py` children. v1 runs it single-tenant on a dedicated
commodity box.

## Repo integration

- `shielded/` (new top-level): the worker. Dockerfile with digest-pinned CUDA base (TCB
  comment per `worker/Dockerfile`), README, systemd units for the off-fleet/self-hosted
  mode (precedent: `metal/`). Registered in `scripts/release.sh` (CONTEXT/ORDER) and the
  `deploy.yml` detect case, container block in flavor configs when it ships to fleet boxes.
- TEE-side executor: patch stack work in `wasm/` — a new `wasmtime-nn-ggml-shield.patch`
  (or an extension of the ELL shim in `wasm/llama-shim/`), added to `Dockerfile.wasmtime`'s
  ordered apply AND `.github/workflows/wasmtime-patch-check.yml`. Unlike every other patch
  in that stack, this one **fails closed** (a masking/verification fault must never fall
  back to plaintext offload or silent CPU divergence) — that inversion gets stated loudly
  in the patch header.
- Engine changes ride the ELL cascade: `llamacpp-toolchain.yml` → new `mm30+` tarball
  (never reuse a tag) → `ELL_URL/ELL_SHA256` repin in `Dockerfile.wasmtime` →
  `toolchain.yml` → `WASMTIME_IMAGE` repin in `Dockerfile.wasm`. Each repin is a
  measurement event. Dev loop before any repin: local llama.cpp/sd.cpp builds (the
  `wasm/sd-shim` symlink precedent).
- whisper.cpp is not in the tree today; it enters via `llamacpp-toolchain.yml` as a third
  pinned clone (it shares ggml), with a thin shim if the Rust FFI needs one.
- Orchestration: attach-a-shielded-worker rides the existing `/vms` contract as optional
  fields on `POST /vms` (supervisor `launchSpecFrom` → wasm-manager record), not a new
  endpoint. New fleet flavor `enclaves/gpu-shielded/` for boxes where the GPU is NOT
  passed through into the CVM (the existing gpu flavor's passthrough topology is the
  opposite trust shape).
- Tests: `test/shielded-*.test.mjs`, pure functions + `*_SELFTEST` seams; wire-format
  assertions on raw bytes; the field-GEMM and mask/unmask cores get exhaustive
  small-dimension exact tests against a reference big-int implementation.
- Docs: this file is the design; `SECURITY.md` (final deliverable) carries the per-op
  leakage arguments and per-interface residual-leakage sections.

## Per-interface notes

**Chat.** GGUF models, streaming decode as above. Output equivalence: bit-exact in field
domain vs TEE reference; documented tolerance vs fp16 baseline. KV q8 in TEE RAM; context
buckets {1k, 2k, 4k, 8k} padded.

**STT.** Log-mel in TEE (trivial). Whisper large-v3 CPU-in-TEE feasibility FIRST (1.55B —
small-model rule); expected to pass RTF ≤ 0.5 on an EPYC slice, in which case STT never
touches the GPU and its leakage surface is just padded duration buckets (bucket sizes to be
fixed in Phase 3's report; strawman: 15s steps to 60s, then 60s steps).

**TTS.** Pick: **Pocket TTS (kyutai) via llama.cpp's native mtmd path**, with
**Qwen3-TTS-12Hz-1.7B as the quality/multilingual fallback** — same code path. Evaluation
(2026-08): llama.cpp's old OuteTTS demo is gone; TTS is now a first-class mtmd audio-out
capability (Qwen3-TTS merged 2026-05, Pocket TTS 2026-08-07 with the SEANet
transposed-conv→GEMM optimization that halves CPU decode cost — exactly our constraint).
bark.cpp is dormant (last push 2024-11); TTS.cpp (mmwillet) has the best model coverage but
requires a forked ggml patch stack and has no Linux/CUDA story — disqualified for a pinned
fleet engine. Pocket TTS is ~0.2–0.25B total (acoustic + Mimi/SEANet decoder) and
Qwen3-TTS is 1.7B + ~0.4B code2wav — both under the small-model rule ⇒ **TTS is
CPU-in-TEE by default**, streaming, TTFA target <1s measured in Phase 5. Voice-cloning
reference audio is secret input, same handling as prompts (it only ever exists in-TEE).
Note: the current ELL pin (llama.cpp ddd4ec14, mm29) predates Pocket TTS — TTS integration
requires an engine bump, i.e. a measurement event; schedule it with the Phase-4 mm30 repin,
not before.

**Image generation.** DiT first (SD3/Flux class): the denoiser is a transformer and reuses
the masking path unchanged; per-step masked offload, steps batch well, users tolerate
seconds — friendliest interface to RT overhead, held to the two-RT-per-step discipline.
UNet (SDXL) second via conv masking (Slalom lineage; Amulet's conv coverage is
weight-hiding, wrong direction — bar only). Text encoders per small-model rule (T5-xxl
exception above). Noise schedule + final sampling in TEE; VAE decode in TEE. Leakage:
resolution buckets {512, 768, 1024}, step-count buckets {≤4 (turbo), 20, 28, 50}.

**Vision.** Preprocess (resize/patchify/normalize) in TEE; ViT encoder via the masked
backend (additive masks — permutation equivariance covers ViT correctness, but public
weights forbid bare permutation as protection); projector is a linear offload; decoder
shares chat. The input image and everything derived from it is secret.

## Phases

0. **Baselines** (denominators for every overhead number): each interface on (a) local
   unmasked GPU, (b) stock ggml-rpc remote GPU — isolates transport cost, (c) CPU-in-TEE.
   Batch 1/4/16 where applicable; 1k and 8k context for chat.
1. **Masked backend v1**: field GEMM kernels (cuBLAS fp64 first), Slalom masking + banked
   precompute + preprocessed Freivalds, hardened worker, sched-pinned executor driving
   llama.cpp chat end-to-end with equivalence checks. Plus the KV-Shield-style permuted
   pipeline as plumbing validation (then retired as a security mechanism).
2. **Extend to whisper.cpp and sd.cpp (DiT)**; deliver the CPU-in-TEE feasibility report
   for STT and TTS under the small-model rule.
3. **TwinShield v2**: prefill/batched attention + (contingent on the numeric analysis)
   softmax offload for chat and vision. Gated on an adversarial security review of the
   decode-degradation analysis above.
4. **TTS integration (mm30 engine bump) and the SDXL conv path.**
5. **Final report**: overhead multiplier per interface per bucket, TEE CPU/memory
   footprint, mask-bank capacity model, SECURITY.md with per-op leakage arguments and
   per-interface residual leakage (shapes, buckets, timing).

Kill criteria (from the brief, unchanged): chat/vision >5× at batch ≥4 after optimization;
image gen >3× per-image wall clock at batch ≥4; STT/TTS failing realtime on both CPU-in-TEE
and masked-GPU paths; any design requiring GPU-driver/host-kernel/operator trust is dead on
arrival. On any kill: stop and write up why, with measurements.

## Open risks, ranked

1. **Field-GEMM throughput on commodity GPUs** — the whole tier's economics. int8-limb
   kernels are the load-bearing bet; Phase 1 measures before more is built on it.
2. **Mask-bank refill as the sustained-throughput ceiling** — the capacity model above is
   arithmetic, not measurement; if real refill lands ≪ estimate, the tier is a
   latency/burst product, and pricing must say so.
3. **TwinShield v2 security at small m** and OutSoftMax numerics — adversarial review
   gate; worst case, v2 stays prefill-only and softmax stays in-TEE forever (survivable:
   v1 already meets the confidentiality bar, v2 is a performance upgrade).
4. **CPU attention at 8k context** in decode (v1) — may dominate token latency; flash-attn
   CPU + q8 KV mitigations first, v2 prefill offload helps TTFT, but long-context decode
   throughput is the number to watch against the kill line.
5. **T5-xxl** breaks the tidy "encoders in TEE" story for Flux-class models.
