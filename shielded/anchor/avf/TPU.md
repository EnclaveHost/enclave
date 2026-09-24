# Shielded-TPU decode: the phone's TPU as the untrusted worker

> **Status 2026-09-23: CLOSED. Research record, not a product tier.** Exposing TPU acceleration requires at least
> **15 tok/s** end to end with the pVM as root of trust, secrets inside, masking and verification intact, and the
> required model and task quality. The best this lane measured is **2.4-2.6 tok/s** (smp1/combo4: the masked drafter
> lane, Gemma 4 E2B, 24/24 on the contract set with the drafter), about a sixth of the threshold. Its per-exchange
> floors bound the int8 lane near 6.8 tok/s even with free arithmetic, and the TPU cannot be attached to the VM on stock
> phones (no AVF API passes a device to an app's pVM). The campaign was stopped cleanly on 2026-09-23 with its last
> batches recorded (results/df1, df1b, dp1 partial, tpu-campaign-end-20260923). Do not resume TPU optimisation without
> a new explicit direction. The phone's product path is the CPU-only **pVM CPU** tier (PVM-CPU.md): the model runs on the
> protected VM's own vCPUs and no activation leaves the VM, so none of the masking below is part of it.

Enclave Shielded on a desktop keeps the prompt, the context and the output inside the CVM and lets an untrusted GPU do the
big matmuls on masked rows. This is the same split on a phone: the **protected VM** is the trusted half, the **Tensor TPU**
(which cannot be attached to the VM and belongs to Android) is the worker. The weights are public. What must never reach
the host is the prompt, the KV cache, activations and the output, and none of them do.

## The split

Inside the VM, unchanged llama.cpp (mode local, LOCAL.md): tokenizer, embeddings, per-layer embeddings, norms, RoPE,
attention over the KV cache, GELU, the vocabulary projection, sampling. `payload/ggml-tpu.cpp` is a ggml backend that claims
the projection matmuls of a decode step and turns each group into ONE exchange: `q,k,v | o | gate,up | down` = 4 per block,
140 per token for Gemma 4 E2B.

```
x' = x / s                          smoothing: public, folded into the public weights
x_in = clip(round(x'/s_in), lane)   per-channel signal lane from public calibration; the rare rest x_out stays in the VM
q  = x_in + r                       r: one-time pad, uniform in +-k*lane_i per channel, kernel CSPRNG        -> the link
yq = sat16(round(M_j * sum_i Wq[j,i] q_i))      int16 x int8 FULLY_CONNECTED on the TPU                      <- the link
y  = s_out*(yq - P) + s_in*sw_j*sum_{i in x_out} Wq[j,i] x_out_i       P = round(M_j * sum Wq r): minted in the VM, never sent
```

Crossing the link: `q` and `yq`. Not `x`, not `r`, not `P`, not which entries were outliers. One pad per row per exchange.

> **The bounded pad above does NOT hide the token, and the default k=8 recipe is broken. Measured 2026-09-18.**
> `r` is uniform on a BOUNDED interval and the sum does not wrap, so every coordinate confines `x_in,i` to
> `[q_i - r_amp_i, q_i + r_amp_i]`, which bites against the public lane about 12.5 % of the time at k=8. The model is
> public and the layer-0 q,k,v input is a function of the TOKEN ID alone (RoPE is applied after the projection), so
> enumerating the 262,144-token vocabulary identifies the token **uniquely in 95 % of trials from ONE exchange**, for
> prompt and output alike. Raising k does not fix it (k=64 is the first value that stops single-exchange identification
> and it leaves the median channel under 8 bits of signal), and a truncated Gaussian pad only defers it: the likelihood
> attack still wins inside one token's 140 exchanges. The fix is the modular mode below, which is what to use.
> Evidence and the attack script: the Codex tree, `tensor-sdk/PROGRESS-nonlinear-masking.md` (E1) and
> `tensor-sdk/shield/nonlinear/e1_dict.py`.

## Modular lanes: what to use instead (`--modular`)

A modular pad needs no headroom at all: `q_i = (x_in,i + r_i) mod m_i`, taken in `[-m_i/2, m_i/2)` with `r_i` uniform on
`Z_{m_i}`, is **uniform and independent of `x_in,i`** — an information-theoretic one-time pad per use, not "hiding with
ratio k". `m_i` is the next power of two above `headroom * (2*sig_q_i + 1)`, per input channel, capped at 32768 so the
batched minter's `r = 256*hi + lo` split keeps `|hi| <= 127`.

The TPU cannot help with the reduction — measured: with the requantize multiplier set to 1 its FC returns the integer
sum **bit-exactly**, and past the int16 rail it **saturates, never wraps**. It does not need to: the wrap
`x_in,i = q_i - r_i + m_i c_i` is known inside the VM, so `m_i c_i` is simply added to the SAME sparse correction list
the out-of-lane entries already use (one column of `Wq` each). The unmask path is unchanged.

Because the pad no longer has to be k times the signal, the output lane shrinks too: on the real bundle, per-channel
power-of-two moduli put `sigma(W r)` at 1.0-1.15x the theoretical optimum against **8.0x** for the shipped k=8 recipe,
so the modular mode is better on BOTH security and resolution. `--mod-headroom H` trades the two costs and **does not
affect security at all** (the pad is uniform on its modulus for every H): wrap density falls as 1/H, the output lane
grows as H. H=8 reproduces the shipped scheme's pad energy exactly while still being perfectly hiding.

Bundles mark themselves modular with `k = -1` and store `log2(m_i)` in the `r_amp` slot, so the format is unchanged and
existing bundles keep the old behaviour. Build one with
`tpu/make_graphs.py <f16.gguf> <lanes.npz> <outdir> --modular [--mod-headroom 4] [--no-graphs]`.

| `tpu-host-test`, same binary, same prompt, exact reference worker | shipped k=8 | modular H=1 |
|---|---|---|
| greedy text | = plain llama.cpp | **= plain llama.cpp** |
| exchanges / bytes per token | 140.0, 1038.5 KB out / 1716.0 KB in | identical |
| saturated replies, pads redrawn | 0, 0 | **0, 0** |
| entries corrected in the VM | 0.116 % | **4.188 %** |
| unmask, ms per exchange (workstation, row-major `Wq`) | 0.07 | **3.43** |

So the price of real hiding is the denser sparse pass, and it is the cost lever 3 already names: a column-major copy of
`Wq` (or a larger `--mod-headroom`). Nothing else changes.

**Measured end to end on the phone (2026-09-18), not a simulation:** the full path (protected VM + the app's LiteRT
worker + 35 AOT-compiled modular graphs) answers correctly - "The capital of France is Paris." - at **0.79 tok/s**
against **1.01 tok/s** for the shipped statistical bundle run back to back on the SAME rebuilt binary and prompt (and
with the phone 2 C warmer for that control, so the 22 % gap is if anything understated). 140.0 exchanges per token
either way; TPU `Run` 3.10 ms per exchange modular against 2.80 ms statistical. The gap is entirely the denser correction pass on a row-major `Wq`. Build the graphs and the bundle from ONE
`make_graphs.py --modular` run so the TPU's int8 weights and the VM's are the same bytes, and **rebuild the payload**
(`build.sh engine-pvm` then `build.sh anchor`) before testing: a pre-modular payload reads `log2(m)` out of the `r_amp`
slot as a pad amplitude and runs with essentially no mask at all.

Modular masking makes this path SECURE, not FAST. It does not change the standing verdict below: the phone's own VM
decodes the whole model on its CPU at 12-15 tok/s with no pads and nothing leaving it, so the split still buys nothing
for decode. Use the modular mode wherever the lane is used at all (prefill, if long prompts ever need it).

## Pieces

| piece | where | notes |
|---|---|---|
| calibration | `tpu/calibrate.py` | fp32 checkpoint on real chats: per-input-channel q99.9 and max of \|x\|, max \|W x\|, keyed by GGUF tensor names |
| artifacts | `tpu/make_graphs.py` | from the **f16 GGUF**: `L<n>.tflite` (signatures qkv/o/gu/down, 5 rows, int16 in/out, authored as flatbuffers) + `lanes.etpu` (the VM's bundle: the SAME int8 bytes, scales, lanes). Then AOT-compile each layer for the Tensor G5 |
| VM backend | `payload/ggml-tpu.cpp`, `ggml-tpu.h` | masks, exchanges, unmasks, batched exact-integer pad minter + bank, stats; also the exact reference worker |
| mint bench | `tpu/test/tpu-mint-bench.cpp` | the minter alone (needs only ggml): exactness check against the scalar reference, then positions per second; builds for the workstation and for the phone |
| engine | `payload/engine_local.cpp` | loads the backend on request, keeps claimed weights in plain host buffers so ggml's scheduler offers their matmuls to it |
| payload | `payload/anchor_payload.c` | `LOCAL ... tpu_bundle_bytes=N bank=N refill=N [draft_bytes=N draft_max=N]`: receives the bundle (vsock 7782, kept in the encrypted store), accepts the worker on 7778 |
| app | `host/app/TpuWorker.java`, `Main.java` | streams the bundle, extracts LiteRT's dispatch library from the APK, runs the worker on the VM's descriptor |
| worker | `tpu/worker/tpu_worker_jni.cc` | LiteRT C++; built in a LiteRT-LM bazel tree (`//tools/anchortpu:libanchortpu.so`), bundled via `ANCHOR_TPU_LIBS=<dir>` with `libLiteRtDispatch_GoogleTensor.so` |
| host test | `tpu/test/tpu-host-test.cpp` | the backend against the reference worker on a workstation: text vs plain llama.cpp |

Run: `am start -n host.enclave.anchor.avf/.Main --es mode local --ei mem 8192 --es model <gguf> --es tpu_graphs <dir of compiled L*.tflite> --es tpu_bundle <lanes.etpu> --ei tpu_bank 64 --es ask '...'`

## Measured

Accuracy of the lane recipe (exact integer simulation inside the fp32 model, 480 tokens): KL 0.005 / top-1 99.6 % at k=8,
against 0.003 for unmasked w8a16; a tensor-wide 8x lane destroys the model (perplexity 1.07 -> 411) because real activations
have crest factors of 100-800, and per-channel pads without the outlier split cost KL 0.13-0.54.

Workstation, reference worker: 140.0 exchanges per token, 0 saturated replies, 0.04 % of entries kept in the VM, 0 pads
re-drawn; greedy text equals plain llama.cpp except one word in 39 tokens. 1.0 MB out and 1.7 MB back per token.

**Pixel 10 Pro XL, first end-to-end run (2026-09-18): correct answers, 1.16 tok/s.** Per exchange, 140 per token:

| where | ms | what |
|---|---|---|
| TPU invocation (worker) | 2.69 | LiteRT `Run` of one compiled signature; 0.10 to write the input, 0.22 to read the outputs |
| vsock, both directions | ~1.1 | link 4.30 in the VM minus 3.2 in the worker; every hop wakes an idle vCPU (LOCAL.md) |
| unmask (VM) | 0.96 | almost all of it the outlier correction: column reads from a row-major int8 matrix (a cache miss per output) |
| mask (VM) | 0.17 | |

= about 5.4 ms x 140 = 0.76 s per token, plus the VM's own attention/norm/head work. Pads: 0.11 s per position on six
threads (about 9 positions per second) with the first, one-at-a-time minter; see the batched minter below. Boot: bundle into the VM 49 s once (1.76 GB), model load 50 s.

## The four levers, measured (2026-09-18, same phone)

| lever | what was done | result |
|---|---|---|
| 4. cost of one TPU invocation | micro-benchmark inside the worker (`TpuWorker.nativeBench`): every signature of two blocks, back to back and with 3 ms idle gaps | **0.9 ms fixed + about 0.13 ms per MB of int8 weights**: qkv 1.5, o 1.8, gate+up 3.4 (6.3 in the double-wide blocks), down 2.7-4.2 ms. Idle gaps add about 0.5 ms. It is weight streaming, not dispatch overhead: 0.37-0.45 s per step however the step is cut |
| 1. fewer exchanges (fold the norm scalars, 4 -> 2 per block) | evaluated against lever 4's cost model, NOT built | a merged exchange needs fused product matrices (W_gate diag W_o: +25 MB per block, +50 MB in the wide ones; W_q' diag W_down: +16-25 MB). At 0.13 ms/MB that is +3 to +6.5 ms of streaming to save one exchange worth about 3 ms: break-even at best on this TPU |
| 3. unmask cost | the correction for entries beyond their lane walks a COLUMN of a row-major int8 matrix. A column cache did nothing (the overflowing channels are not a hot few: 7,490 distinct columns for 11,665 entries) and would have grown without bound; software prefetch is what is in the code | about 0.2 ms per overflowing entry remains (a TLB miss per element under two-stage translation): 1.6 ms per exchange at 7 entries (one row), 6.8 ms at 33 (five rows). The real fixes are a column-major copy of the weights (+1.76 GB) or fewer overflows (more calibration text, a wider margin) |
| 2. more tokens per step | Google's `gemma-4-E2B-it-assistant` drafter (154 MB f16 GGUF, llama.cpp's own speculative helper, `--es draft`), 4 proposals = the 5 rows the graphs already take; the drafter is unauthenticated on purpose (the target verifies every proposal) | works, text coherent, 1.64-1.84 tokens per step on the phone (2.3-2.8 on a workstation with the Q8_0 target). **But a 5-row step costs 1.96 s against 0.83 s for one row**: rows are free on the TPU and nowhere else (5x the bytes on the link, 5x the rows to mask and unmask, 5x the overflow entries). Net 0.80 tok/s against 1.09 |

**Pads, and the batched minter.** A pad is `r` (kernel CSPRNG noise, per-channel amplitude from the public lanes) and
`P = round(M * Wq r)` for every projection: the same integer MACs as the matmul it protects, and it must cancel exactly.
Minted one at a time that is memory-bound (every weight row streamed for ONE dot product): 0.11-0.17 s per position on six
threads. `mint_batch()` in `payload/ggml-tpu.cpp` mints 64 pads of a group at once, which is prefill's arithmetic:

- exact by construction: `r = 256*hi + lo` with `lo = (int8)r`, so `Wq r = 256 * (Wq hi) + (Wq lo)`, two int8 x int8 SDOT
  sums in int32 (bounds checked per group at open: `r_amp <= 32384`, `n_in < 2^17`; otherwise the scalar path). The
  self-check `ggml_backend_tpu_mint_check()` recomputes every P from the pad's own r with the scalar reference:
  0 differing values over all 140 groups, on the workstation and on the phone, also with budgets shrunk to force re-draws;
- tiled like a GEMM, because SDOT outruns the caches: a tile of weight rows stays in L2, four pads' hi and lo chunks in L1
  (untiled 52 positions per second, tiled 79);
- work is dealt to the threads as (group, batch) items, largest first.

| minting, positions per second (one position = one pad for each of the 140 groups) | scalar, one at a time | batched |
|---|---|---|
| phone, native, six big cores (`tpu/test/tpu-mint-bench.cpp`) | 12.7 | **78.8** (one prime core 23.2, one mid core 14.3) |
| protected VM, six vCPUs, into recycled memory | 6-9 | **71-72** (one vCPU 20.6) |
| protected VM, filling a fresh bank before READY | 6-9 | 31-34: first touch of fresh guest pages (LOCAL.md trap 2), 2.9 MB per position |

So decode no longer needs a big bank: **8 positions (23 MB) and ONE background minter (`tpu_refill 1`) kept the bank full
through a 40-token turn with zero inline pads and the link unchanged at 4.3 ms** (four scalar minters had slowed it to
7.7 ms; a 230-position bank cost 0.67 GB). Five rows per step consume five positions per step, which one minter also
covers. The minter runs AFTER the model load, and the bundle is paged in first (`ggml_backend_tpu_warm_bundle`, 2-3 s):
minting before the load left the bundle's pages to be evicted by it, and decode then paid a disk read per touched page
(unmask 1.2 -> 11.8 ms, 0.39 tok/s). `mlock` of the bundle is attempted and refused in the payload's sandbox; the log says so.

What was ruled out as "cheap pads": mixing a small pool of `(b, W b)` pairs (every pad then lies in a low-dimensional
subspace that the host, who sees many masked rows, can estimate and strip), sparse or reused pads (unmasked or correlated
entries), sensor noise for `r` (the sensors belong to the host, and drawing `r` was never the cost), and minting on the
TPU or GPU (they would see `r`). A trusted dealer remains possible (dealt-pad plumbing exists for the split engine).

## Can a mask survive the nonlinear steps? (investigated 2026-09-18)

**RMSNorm: yes, by deferral (verified, not yet built).** An RMSNorm is a positive scalar times the identity (the gain is a public
diagonal), and a scalar commutes with every linear map. So `a -> W_o -> post-attn norm -> +x -> ffn norm -> W_gate, W_up` is ONE
masked call: the TPU computes `o_m = W_o(a + r_a)` and pushes two rows through the same gate/up weights, `g_f*x + r_x` and
`(g_f*g_pa)*o_m`; the VM applies `c = 1/rms(o)` and `s = 1/rms(h)` afterwards, O(n). The same identity merges
`W_down -> ... -> next W_q,k,v` (the 256-wide per-layer-embedding branch stays in the VM). 4 exchanges per block become 2.
Real Gemma 4 E2B weights, float64: max relative error 4e-15 to 6e-15. On the TPU the chained graph (FC, CONCAT rows, 2x FC)
compiles and runs in 4.2-4.4 ms against 5.45 ms as two calls. Projected decode: about 2 tok/s (from 1.16).

**GELU-gating and attention: no, for an evaluator that only does arithmetic.** To map `m = x + p` to `f(x) + r'` without the VM the
TPU must hold `G(m) = f(m - p) + r'`; it can evaluate its own `G` anywhere, and for non-affine `f` the shape of `G` gives `(p, r')`
away (recovered uniquely in 1000/1000 trials from an 8-bit GELU table in a modular domain). Keys derived from the TPU's own
arithmetic are affine in the masked value and cancel under second differences; real row encryption needs a cipher on the TPU
and at least 110 MB of one-time material per token. Products of two masked values need one opening round each. Floor: 2
exchanges per block.

**And the TPU's price for masked work is fixed by the activation width.** Masks need int16 activations; the compiler then stores
weights at 2 bytes (gate+up: 38 MB, 3.65 ms per call) and refuses int4 weights; int8 x int4 (no room for a mask) runs the same
layer in 1.8 ms. Seventy int16 calls are 0.3 s per token before any masking cost. The unprotected 25 tok/s is one whole-graph
call per token, which would need masks to survive GELU-gating and attention. Log and scripts: the Codex tree,
`tensor-sdk/PROGRESS-nonlinear-masking.md`, `tensor-sdk/shield/nonlinear/`.

**The chained exchange, quantized and then withdrawn (2026-09-19).** Built as a simulation with the real int16 arithmetic
(`tensor-sdk/shield/nonlinear/sim_chain.py`): re-masking the intermediate inside the call with a fresh pad, carrying the
previous multiply's VM-side outlier share as a second correction row, integer rescale factors, and 64 heavy channels
multiplied by the VM, it reaches KL 0.0074 (statistical k=8 lanes), and the TPU runs the chained graph exactly (FC, ADD,
MUL, ADD, CONCAT, FC: 99.99 % bit-exact, max one step). It is nevertheless not admissible: the intermediate can only be
masked with a BOUNDED pad, because the mask is added inside the TPU call and this chip saturates rather than wraps, and a
bounded pad is the leak the modular lanes above were introduced to remove (E1: 95 % of tokens read off one exchange). Only
the VM can reduce modulo m, and the VM never sees the intermediate. Calibration keys (`chain.*` in `tpu/calibrate.py`) and
the generator `tpu/make_graphs2.py` ("ETPUB002") are kept as the record; nothing reads them.

**Where that leaves it.** Best measured Shielded-TPU decode: **1.1-1.2 tok/s**. With every remaining inefficiency removed
(unmask and mask to ~0.1 ms) the floor is the TPU's own 0.38 s per token plus 0.15 s of vsock: under 2 tok/s. The same VM
decodes the same model on its own CPU at 12-15 tok/s with no pads at all (LOCAL.md), so on this phone the split costs
about 10x and buys nothing: the desktop case for Shielded is a worker that is far faster than the enclave's CPU, and that
does not hold for a 2B model on a Tensor G5 (pads are no longer the obstacle: the batched minter makes them cheap). The lane is still the
right tool where rows amortize: prefill (128 rows per exchange), if long prompts ever need it.

## What one TPU invocation costs, and what that means for the 15 tok/s bar (2026-09-19)

The run logs could never separate the two halves of the TPU's time, and the earlier estimate came from real
signatures, where three of the SAME size (3.1 MB) measured 0.43, 0.91 and 1.08 ms. Taking the minima gave
0.18 ms + 0.080 ms/MB (bytes dominate, a smaller model scales); taking a least-squares fit gave
0.637 ms + 0.0677 ms/MB (invocations dominate, a smaller model hits a wall). Those point at different
projects, so `a8w4/sweep_dispatch.py` measures it directly: eight FULLY_CONNECTEDs differing only in weight
count, spanning 128x, authored exactly as `make_graphs.py` does and laid out as two "layers" of four
signatures so the worker's own `nativeBench` walks all eight in one run.

| weights, MB | 0.52 | 1.05 | 2.10 | 4.19 | 8.39 | 16.78 | 33.55 | 67.11 |
|---|---|---|---|---|---|---|---|---|
| ms, back to back | 0.37 | 0.84 | 0.98 | 0.81 | 0.91 | 1.86 | 2.77 | 4.58 |
| ms, after 3 ms idle | 0.84 | 1.12 | 1.07 | 0.88 | 1.10 | 1.69 | 2.51 | 4.38 |

**0.637 ms per invocation + 0.0600 ms/MB** (0.829 + 0.0520 after an idle gap), residual under 0.30 ms. The
intercept is the same 0.637 the noisy real-graph fit gave, from independent data: it is real, and it is the
binding constraint. Masked decode needs four exchanges per block and the mask cannot survive GELU-gating or
attention, so the invocation count is 4x the layer count and nothing about a smaller model reduces it.

| model | invocations | MB streamed | TPU alone |
|---|---|---|---|
| E2B int16 (what shipped) | 140 | 3865 | 321 ms/token, **3.1 tok/s** |
| E2B int8 (digit-split) | 140 | 1872 | 202 ms/token, **5.0 tok/s** |
| Llama-3.2-1B class, 16 blocks | 64 | 970 | 99 ms/token, 10.1 tok/s |
| Gemma-3-1B class, 26 blocks | 104 | 700 | 108 ms/token, 9.2 tok/s |
| Gemma-3-270M class, 18 blocks | 72 | 170 | 56 ms/token, **17.8 tok/s** |

15 tok/s is 66.7 ms per token. E2B spends 202 ms of that on the TPU alone, so **no amount of link, mask or
pad work can reach the bar with this model** -- not with the 1.64-1.84 tokens per step the drafter gives
either. A 270M-class model leaves 10.7 ms for everything else at one token per step (0.148 ms per exchange:
out of reach, transport alone is 1.19) and 64 ms at 1.8 tokens per step (0.889 ms per exchange: reachable,
transport 1.19 and unmask 2.88 today but both fall on a model with a quarter of the output width). **The bar
is reachable on this architecture only with a model of about 18 blocks and 170 MB of int8 weights, plus the
drafter.** Off-the-shelf pruned E2Bs do not provide it: `trim/` evaluated a 10-of-35-layer drop (gibberish)
and a 40 %-sparse rebuild (parrots the prompt, PPL 94 against 47), so a shallow model means a healing run.

### The modular 2x2, and digit-split's verdict

Same phone, same prompts, 42-token turn, all four correct:

| pad recipe | activations | headroom | unmask | link | tok/s |
|---|---|---|---|---|---|
| statistical k=8 (**leaks**, E1) | int16 | - | 0.76 | 4.20 | 1.20 |
| modular | int8 digit-split | 1 | 5.64 | 4.83 | 0.63 |
| modular | int16 | 4 | 2.54 | 4.66 | 0.91 |
| modular | int8 digit-split | 4 | 2.88 | 4.28 | 0.91 |

`--mod-headroom 4` is the win: wraps fall from 155 to 40 per exchange (the count is identical for both
activation widths, confirming it is purely the modulus), unmask halves, and digit-split goes 0.63 -> 0.91.

**Digit-split was a dead heat at equal security; since the correction moved off the critical path it is
a 24 % win.** Measured again on 2026-09-20 with the helper vCPU in place: digit-split 1.22 tok/s against
int16's 0.98, link 4.604 against 6.138. Nothing about the two recipes changed -- what changed is that
unmask no longer dominates, so the TPU's own time does, and digit-split halves the compiled graphs
(1872 MB against 3865). Halving the REPLY instead, which is what int16 buys (1716 against 3432 KB per
token), does not pay for doubling the weights the TPU streams. The original reading below stands for the
configuration it was taken in:

**Digit-split is a dead heat at equal security.** It halves the compiled graphs (3865 -> 1872 MB, which is
real for phone storage and load time) and its link is 0.38 ms faster, but the reply carries hi and lo
separately -- 3432 KB per token against 1716 -- and the VM's recombination puts 0.34 ms back into unmask.
The two cancel. Keep it for the bytes, not for the speed. Recombining on the TPU would fix the reply, but
two FCs against one weight tensor emit the weights twice (35.6 -> 71.9 MB on a real layer), which is why the
digits are stacked as rows in the first place.

### Spinning on the reply: measured, and worse

A blocking read pays a cold vCPU wake (360 us guest + 160-200 us host against 21-27 us hot, LOCAL.md trap 4),
which is most of the 1.19 ms of the link that is neither the TPU nor the copies. Collecting the reply with a
bounded `MSG_DONTWAIT` spin instead made it worse: link 4.284 -> 7.180 ms and 0.91 -> 0.70 tok/s, with
3.937 ms of the 4000 us window spun and then a blocking read anyway. The worker's own clock says it answered
in 3.19 ms, so the window should have caught the reply: the spin DELAYS delivery rather than missing it. The
guest's vCPUs and the app's TPU worker are threads on the same six big cores, and a spinning vCPU at decode
uclamp starves the path carrying the reply. There is no spare core on this phone -- which is the reason the
work was pushed off the CPU to begin with. Kept behind `ANCHOR_TPU_SPIN_US`, default 0.

### The whole-exchange floor, and what it rules out

The TPU-alone table above is not the binding number. Measured on the H=4 digit-split run with the
boosted worker, the parts of one exchange that do NOT depend on the model are:

| | ms | how it was obtained |
|---|---|---|
| TPU invocation | 0.637 | the sweep's intercept |
| guest/host wake, both ways | 1.555 | link 4.281 minus the worker's own 2.726 |
| worker recv + input-write + send | 0.346 | the worker's own counters |
| **fixed, per exchange** | **2.538** | |

Four exchanges per block are forced (the mask does not survive GELU-gating or attention), so
`blocks x 4 x 2.538 ms` is a floor no model can go under. At 66.7 ms per token that is **6.6 blocks at
one token per step, or 11.8 with the drafter at 1.8 tokens per step.** Adding the measured mask and
unmask (2.82 ms at H=4 on E2B; call it 0.6 on a model with a quarter of the output width) gives:

| | exchanges | projected | with the drafter |
|---|---|---|---|
| Gemma 4 E2B, 35 blocks | 140 | 1.81 tok/s (0.93 measured) | 3.26 |
| Gemma-3-1B class, 26 blocks | 104 | 2.71 | 4.89 |
| Gemma-3-270M class, 18 blocks | 72 | 4.31 | 7.76 |
| ~150M, 12 blocks | 48 | 6.46 | 11.63 |

**So 15 tok/s is not reachable on this architecture for any model worth running.** The cost is not the
TPU and not the weights; it is 1.555 ms of scheduling per round trip, 61 % of the fixed cost, paid
140 times a token. Both ways of attacking it are now measured and closed: spinning to skip the wake
makes it worse (there is no spare core), and boosting the worker speeds the worker up without moving
the link at all, because the residual is the guest's half.

The same protected VM decodes the same model on its own six vCPUs at **13.3-14.2 tok/s** (LOCAL.md),
which is 14x the masked TPU path, with the weights, KV cache, activations and sampling equally inside
the pVM. The TPU only wins if it can be given the whole graph -- one invocation per token, no masking,
no round trips, which is what Google's own NPU lane does at 25.2 tok/s -- and that needs the TPU
INSIDE the pVM (device assignment), not a masked worker outside it.

### And it does not spare the phone's CPU either (2026-09-19)

The reason for pushing the matmuls off the CPU was that a host's phone must not be made slow, hot and
flat. So measure that directly, in core-milliseconds per token rather than wall clock
(`a8w4/cpu_cost.sh`: utime+stime of the app, its virtmgr and its crosvm, sampled across one decode
turn, summed only over pids present in both samples):

| | tok/s | core-ms per token | cores busy |
|---|---|---|---|
| CPU only, in the pVM | 13.08 | **332** | 4.3 |
| Shielded-TPU, H=4, digit-split | 0.67 | **6641** | 4.5 |

**The masked path costs 20x more CPU per token, and keeps the same number of cores busy while doing
it.** It does not move work off the CPU at all: it keeps 4.5 cores occupied and takes twenty times
longer to produce each token. At the best decode of the day (0.93 tok/s) it would still be about
4800 core-ms, 15x. The arithmetic is not mysterious - minting a pad is the SAME integer MACs as the
matmul it protects, the unmask walks a column of a row-major int8 matrix for every wrapped entry, and
the VM still does all the attention, norms and sampling itself. The TPU takes the GEMMs and the CPU
takes everything the mask costs, which is more.

So on this phone the masked TPU path is worse than the pVM's own CPU on every axis that was supposed
to justify it: 14-20x slower, 15-20x more CPU energy per token, and a weaker boundary (the host sees
masked activations; on the CPU path it sees nothing). It remains the right tool for PREFILL, where
one invocation amortises over 128 rows, and it stays in the tree behind its flags.

## Filling the link window with the work that was waiting on it (2026-09-20)

The engine's own masking work had two optimisations worth testing here. One transfers and one does not.

**`eb45aa4e`, "Fill the ring's spin window with the work that was waiting on it", transfers, and it is
worth 26 %.** That commit's observation is that a decode round is serialised on one thread -- mask,
publish, spin for the reply, unmask, next -- and that the socket path had always handed that thread the
Freivalds RHS while the request was in flight, because the RHS depends only on the REQUEST. This round
has the same shape and was doing the thing it fixes: publish, idle 4.3 ms, then spend 2.9 ms unmasking.
The expensive half of that unmask is the out-of-lane correction, and it is a pure function of the
request (`outl[]` is built while masking; the walk reads only `Wq`, `sw`, `s_in`). It ran after the reply
purely by construction order. Moved between the write and the read:

| | mask | link | unmask | per exchange | tok/s |
|---|---|---|---|---|---|
| before | 0.033 | 4.284 | 2.884 | 7.20 | 0.93 |
| correction in the window, inline | 0.026 | 5.632 (corr 1.671, wait 3.887) | 0.028 | 5.69 | 1.17 |
| + pads in the window, bank 8 | 0.028 | 6.297 (corr 1.770, mint 0.809, wait 3.617) | 0.030 | 6.36 | 1.05 |
| correction on a HELPER vCPU | 0.233 | 4.604 (corr 0.056, wait 4.429) | 0.181 | 5.02 | **1.22** |
| helper pool of 2, one row | 0.178 | 5.528 (corr 0.068, wait 5.347) | 0.126 | 5.83 | 1.08 |

**Placement matters as much as the hoist.** Run inline the correction occupies the core the app's TPU
worker wants, and the reply that arrived 4.28 ms after publish arrives at 5.56. Moved to a single
persistent helper -- the decode thread goes straight to sleep on the socket, the correction runs on one
of the five otherwise-idle vCPUs -- the reply comes back to 4.49 ms and the worker's own counters
improve from the other side: tpu-run 2.026 -> 1.815, recv 0.134 -> 0.079, output-read 0.404 -> 0.317.
A pool of two is WORSE at one row (1.08): there are only one to three items to split and this phone
charges for every extra runnable thread. The pool exists for speculative rows, where the correction
scales with them.

Unmask collapses to 0.028 ms: nothing is left in it but the pad subtraction. **1.22 tok/s is the fastest
masked decode measured on this phone by any recipe, and it is the SECURE one** -- the leaky statistical k=8 lane
that modular pads replaced was 1.20. Text is identical to baseline on both turns.

It is not free: the reply now arrives 5.56 ms after publish instead of 4.28, because the correction
occupies a core the worker wants -- the same contention that made the reply spin worse. It trades 1.3 ms
of worker delay for 2.9 ms of serial work, so it wins, but the window cannot be filled indefinitely.

**Pads in the window.** 3.6-3.9 ms of window remains after the correction, and a pad depends on nothing
at all, so decode can mint its own instead of keeping a large pre-minted bank or a background thread
(four scalar minters once took the link from 4.3 to 7.7 ms). With `ggml_backend_tpu_window_mint` the
bank holds at **8 positions with zero inline mints over a 43-token turn** (`bank_min 10`), which frees
about 200 MB in the VM, at 1.05 against 1.17 tok/s. Total mint work per token is fixed by consumption,
so this is a placement choice, not a saving: the window is simply the cheapest place to put it. Use the
large bank for short turns and the window for sustained generation.

**LPN-structured pads (`shielded/lpn`) do NOT transfer.** The construction is sound and its REPORT.md
names this case as one where it pays -- "a TEE that cannot batch pads at all (a per-token dealer mint, a
phone anchor filling one pad at a time), where the 2-3.6x byte figure is real". That premise is out of
date: the batched minter (2026-09-18) took this phone from 12.7 to 78.8 positions per second, and one
position is exactly one token's worth of pads. Decode at 0.93 tok/s spends **4.5 % of ONE vCPU** on
minting, 0.7 % of the path's measured CPU; at the 15 tok/s target it would be 73 % of one vCPU. Applying
LPN's best batched factor (1.2x) removes 8 core-ms of 6641 per token; even the unbatched 3.6x removes 35.
The phone is in the same regime the report finds the CVM tier to be in -- the uniform path's bytes fall
as 1/B and the gather's do not -- and it arrived there by batching, exactly as the report predicts.

## The ceiling does not belong to the accelerator (2026-09-21)

With the correction off the critical path the exchange decomposes cleanly, and the largest term is no
longer anything the TPU does. On the 1-row helper run: link 4.604 ms, of which 0.056 is posting the
correction and 2.366 is the worker's own measured time. The remaining **2.18 ms is the pVM-to-host
round trip itself** -- two thread wakes and two SWIOTLB bounce copies, which a protected VM requires.

At 140 exchanges per token that is **305 ms of link per token, a 3.3 tok/s ceiling with a FREE
accelerator and zero VM work.** 15 tok/s would need 0.476 ms per round trip, 4.6x better than measured.

Substituting a different accelerator does not move it. The new Vulkan worker (`shielded/worker-vulkan`)
measures a per-submit floor of **198 us on an integrated GPU** against this TPU's 637 us per invocation
-- 3.4x better, and a phone GPU is the same kind of part, sharing LPDDR with the CPU:

| worker | per-invocation floor | exchange | 35 blocks |
|---|---|---|---|
| Pixel TPU, LiteRT | 0.637 ms | 3.12 ms | 2.29 tok/s |
| iGPU-class, Vulkan | 0.198 ms | 2.68 ms | 2.67 tok/s |
| a perfect, instant accelerator | 0 | 2.48 ms | **2.88 tok/s** |

So the masked architecture caps near 3 tok/s on a 35-block model whatever computes the GEMMs, because
the cost is the 140 round trips, not the silicon. Three ways out, and all three are now closed or
external:

1. **Fewer round trips.** Blocked by what a mask survives: RMSNorm deferral is verified, GELU-gating and
   attention are not, so four exchanges per block is irreducible. Merging needs the intermediate masked
   INSIDE the call, and this chip saturates rather than wraps, so only a bounded pad is possible -- the
   leak modular lanes were introduced to remove.
2. **A faster link.** It is SWIOTLB bounce traffic between a protected VM and the host; 43 MB/s at 24 KB
   is what a protected VM's transport does here. Spinning to skip the wake measured WORSE (there is no
   spare core), and boosting the worker moved the worker without moving the link.
3. **The accelerator INSIDE the pVM** -- one whole-graph invocation, no masking, no link. Google's own
   NPU lane does 25.2 tok/s on this exact model and phone, so the hardware reaches the bar comfortably.

Route 3 needs an EL2 reset handler, and this is now verified against the QPR2 kernel source, not just
6.6: `ack-a16-6.12/arch/arm64/kvm/hyp/nvhe/device/device.c` has `/* Reset is mandatory. */ if
(!dev->reset_handler) return -ENODEV;` with no default, and `pkvm_device_register_reset` is exposed only
through `modules.c`'s EL2 module ops table. EL2 modules load from `kvm-arm.protected_modules=` in the
boot image. **So the QPR2 kernel gate opening does not open this path on a locked phone** -- it still
needs a Google-signed EL2 reset handler for the TPU, which exists for no Tensor, including Pixel 11. We
have built one (`pkvm_tpu_da.ko`); it cannot be loaded without unlocking, and unlocking turns
`verifiedbootstate` yellow, which is the signal a tenant checks.

### What the link is, measured rather than assumed (2026-09-21)

Two payload sizes through the real path separate its two terms. Subtracting the worker's own measured
time from the link at one row (32 KB) and at five rows (159 KB):

**transport = 0.74 ms of latency + 0.045 ms/KB (22 MB/s).** At one row the bytes are 66 % of it.

That says the reply size is the lever, and two attempts to pull it failed for instructive reasons:

- **int16 instead of digit-split** halves the reply (1716 against 3432 KB/token) and measured WORSE,
  0.98 against 1.22 tok/s, because it doubles the weights the TPU streams (3865 against 1872 MB). The
  same at five rows, where the byte saving is five times larger: 1.20 against 1.18, inside the noise.
- **A wider vsock credit window.** 22 MB/s at a 0.74 ms round trip is what a 16 KB window would give
  (16 KB / 0.74 ms = 21.6 MB/s), which looked like flow control rather than a copy cost. It is not:
  the window was already **262144 bytes**, and raising it to 1 MB changed nothing (`SO_VM_SOCKETS_
  BUFFER_SIZE`, reported on the turn line). At 256 KB and 0.74 ms the window would allow 354 MB/s, so
  the 22 MB/s is real per-byte work -- the SWIOTLB bounce copies and cache maintenance a protected VM
  requires. The setsockopt is kept because it costs nothing and the reported numbers are the evidence.

Also measured: **1.4-2.3 read() calls per exchange**, so the reply is not arriving in many small chunks
and the cost is not a syscall storm.

**The floor this sets.** Give the accelerator, the mask, the unmask and every other VM cost away for
free, and send the smallest payload an int16 single row can be (~16 KB): 0.74 + 0.72 = 1.46 ms per
exchange, 205 ms per token, **4.9 tok/s.** That is the ceiling for masked decode on a 35-block model
over this link, and it is 3.3x short of the bar before anything actually computes anything.

## Speculation depth, found by REPORT 16.6's decomposition (2026-09-21)

The engine's 27B work split a token into a per-PASS cost `W` (the weight stream and the exchange
launches, paid once however many rows are in flight) and a per-TOKEN cost `C`, and used it to show why
speculation had stopped paying there. The same split applies here, and it found a configuration that had
never been tried: **every measurement so far was at one row or five, and the optimum is at two.**

Fitting the phone's own numbers (1 row 1.22 tok/s; 5 rows 1.18 at 2.00 tokens/step):

| | W, per pass | C, per row |
|---|---|---|
| digit-split | 601 ms | 219 ms |
| int16 | 859 ms | 162 ms |

`C` here is the link's byte term, not CPU as on the 27B: an extra row costs an extra masked row out and
an extra reply back, at the 22 MB/s the bounce path runs at. That is also exactly why int16 trades the
way it does -- lower `C`, much higher `W` -- and the crossover is at **4.5 rows**, which is why int16
lost at one row (0.98 against 1.22) and drew at five (1.20 against 1.18).

With acceptance folded in (`E = sum p^i`, p about 0.55 measured), the round is `(W + kC) / E`:

| rows | drafts | predicted | measured | link, ms |
|---|---|---|---|---|
| 1 | 0 | 1.22 | **1.22** | 4.60 |
| 2 | 1 | 1.46 | **1.42** | 5.83 |
| 3 | 2 | 1.42 | 1.05 | 9.14 |
| 5 | 4 | 1.18 | **1.18** | 10.66 |

The model is a good guide at the ends and over-predicts the middle: it has `C` linear, and the link
says otherwise -- 1.23 ms for the second row, then 3.31 ms for the third. So two rows is the optimum by
measurement, not by the fit, and the fit's value was in pointing at the gap between the two depths that
had been tried rather than in its own numbers.

**1.42 tok/s at two rows is the fastest masked decode measured on this phone**, 16 % over one row and
well clear of the leaky k=8 lane's 1.20. The reason deep speculation loses is the same one REPORT 16.8
gives for the 27B (`k=1/2/3 -> 17.67/14.83/15.41`): a drafted row costs a full `C` whether it is accepted
or not, and accepting one saves only `W`. Here `C` is 36 % of a one-row token, so the third row onward
is paying a growing price for a falling acceptance probability.

### The configuration that stands (2026-09-21)

```
GRAPHS=tpu/g5-h4ds BUNDLE=tpu/lanes-h4ds.etpu BANK=64 \
EXTRA="--es draft $F/draft.gguf --ei draft_max 1 --ei tpu_refill 9"
```

modular lanes at `--mod-headroom 4`, a8w8 digit-split, the out-of-lane correction on ONE helper vCPU,
two rows (one draft), and pads minted inside the link window so the bank holds without a thread.

| | tok/s |
|---|---|
| 2026-09-19, best secure | 0.93 |
| + correction into the window, on a helper vCPU | 1.22 |
| + two rows instead of one or five | 1.42 |
| + pads in the window (bank holds at 64, zero inline) | **1.47-1.50** |

**+58 % in two sessions, and 1.47 is the fastest masked decode measured on this phone by any recipe** --
the statistical k=8 lane that leaked 95 % of tokens from one exchange managed 1.20. Text identical to
the unmasked baseline throughout.

Window minting turns out to HELP at two rows rather than cost 10 % as it did at one: two rows eat two
positions a step, so without it the bank drains and `mask` climbs from 0.221 to 0.419 ms on inline
mints. With it, `bank_min` sits at 64 with zero inline mints across a 96-token turn.

### What the 27B's numbers say about where this sits

REPORT 16.7 prices the same masking design on a server: **1.72x** against the same hardware running the
same weights in the clear (17.67 against 30.36 tok/s). Here it is **17.7x** (1.47 against the unmasked
NPU lane's 25.2 on this exact model and phone). The design is not ten times worse on a phone; the
DIFFERENCE is that the server's worker shares memory with the enclave through an shm ring, and every
exchange here crosses a protected-VM boundary at 0.74 ms + 22 MB/s. That one boundary is the whole gap.

The handoff's fourth lever -- batch rows across USERS rather than drafts, since `W` is per-pass -- does
not rescue it either. Every row is then accepted, so `k` tokens cost `W + kC`, which saturates at
`1/C` = 4.6 tok/s aggregate however many users, and `C` grows superlinearly in practice (link 4.60 /
5.83 / 9.14 / 10.66 ms at 1 / 2 / 3 / 5 rows). That lands on the same 4.9 tok/s the link floor gave
independently, and each user would be getting 0.6 tok/s at five rows.

### What model shape WOULD clear 15 tok/s here

Calibrated against the measured k=2 exchange rather than assumed: 2.28 ms fixed (invocation 0.637 +
link latency 0.74 + worker copies + mask/unmask), the exchange path's own 14.4 MB/s (the bundle
stream's 38 MB/s is one long sequential transfer, not this), 0.060 ms per streamed MB, 1.55 tokens per
step at two rows. The fit gives E2B 1.76 against 1.47 measured, so it is ~20 % optimistic:

| model | int8 MB | ms/token | tok/s |
|---|---|---|---|
| Gemma 4 E2B (today) | 2349 | 568 | **1.76** (1.47 measured) |
| Gemma-3-1B class, 26 blocks | 759 | 329 | 3.04 |
| Gemma-3-270M class, 18 blocks | 100 | 148 | 6.75 |
| 12 blocks, d=640 | 67 | 99 | 10.12 |
| 10 blocks, d=576 | 40 | 78 | 12.84 |
| **8 blocks, d=512** | **26** | **61** | **16.48** |

So the bar is cleared at about **8 blocks and 25M parameters**, and an optimistic fit at that. A
270M-class model -- already small enough that quality is the binding question rather than speed --
reaches 6.75. **There is no model worth running that reaches 15 tok/s through a masked link on this
phone**, and that conclusion is now three independent measurements deep: the per-exchange floor, the
link's latency/bandwidth split, and this shape sweep.

The reply cannot be shrunk to change it either. The `lo` digit only needs 8 bits (it contributes 1/256
of the product, so 15 bits total needs A at 16 and B at 8) -- a real 25 % saving on the reply. But a
tensor carries one type, so hi and lo at different widths needs two FULLY_CONNECTEDs, and that emits
the weights twice: 36.4 -> 71.9 MB on a real layer, which costs far more streaming than the 25 % buys.
The stacked-row digit-split already sits at the optimum the compiler allows.

## Rebuilding the worker without bazel (2026-09-21)

There is no bazel on this workstation any more, which had silently blocked every worker-side change.
It is not needed: bazel leaves its link command on disk and all 1804 inputs survive, so the one
translation unit can be recompiled and the link replayed with the NDK clang the tree already carries.

```
E=<...>/pixel10-runtime-build-1/bazel-root/<hash>/execroot/litert_lm
CXX=$E/external/androidndk/toolchains/llvm/prebuilt/linux-x86_64/bin/clang++
cp tpu/worker/tpu_worker_jni.cc $E/tools/anchortpu/
cd $E && $CXX --target=aarch64-linux-android31 -O2 -fPIC -std=c++17 \
  -c tools/anchortpu/tpu_worker_jni.cc -o $S/new.o \
  -I. -Iexternal/litert -Iexternal/com_google_absl \
  -Ibazel-out/arm64-v8a-opt/bin -Ibazel-out/arm64-v8a-opt/bin/external/litert
sed -e 's|^bazel-out/.*/libanchortpu.so$|'$S'/libanchortpu.so|' \
    -e 's|^bazel-out/.*/tpu_worker_jni.o$|'$S'/new.o|' \
    bazel-out/arm64-v8a-opt/bin/tools/anchortpu/libanchortpu.so-2.params > $S/link.params
$CXX @$S/link.params           # then cp into ANCHOR_TPU_LIBS and rebuild the APK
```

The include roots come out of the depfile bazel left beside the object
(`_objs/libanchortpu.so/tpu_worker_jni.d`). The bazel output tree is read-only, so point the params at
a new object rather than overwriting the old one -- overwriting fails and the link then silently
produces the OLD worker, which is how the first attempt here wasted a run.

### Sending straight out of the tensor buffers: measured, and worse

The engine's `9c7e0e7c` removes a memcpy by letting the GEMM epilogue write into the shm ring instead
of staging and copying (`spec median 17.60 -> 17.98` on the 27B). The analogue here is to `Lock` each
output buffer for read and `writev` the reply directly out of them, skipping the staging copy into
`tx`. It does exactly what it says and still loses:

| | output-read | send | tok/s |
|---|---|---|---|
| stage into `tx`, one write | 0.317 | 0.125 | **1.51** |
| Lock + writev, no staging | **0.061** | **1.148** | 1.26 |

The copy does not disappear, it MOVES -- and gets more expensive. The counters say the path was taken
every time (`direct 4200 staged 0`), so this is its cost rather than a silent fallback. It wins on a
server because the products are already in pinned host memory; here `Lock` returns device-coherent
memory and the kernel's socket path then reads it uncached, which is slower than LiteRT's own `Read`
into cached heap. Kept behind `kDirectSend`, default false.

## The right speculation depth depends on the WORKLOAD (2026-09-21)

The two-row optimum above was measured on prose. Running the same sweep on code prompts says the
optimum is not a constant: draft acceptance is, and the depth follows it.

| workload | acceptance at k=2 | k=2 | k=5 | best |
|---|---|---|---|---|
| prose ("who is Bill Gates", ctx 91) | 55 % | **1.47** (1.55 tok/step) | 1.18 (2.00) | k=2 |
| code (merge two sorted lists, ctx 135) | 80 % | 1.41 (1.80) | **1.70** (3.55) | k=5, +21 % |
| code (a stack class, ctx 273) | 83 % | 1.15 (1.83) | **1.37** (3.06) | k=5, +19 % |

Same prompts, same turn positions, so the comparison is not confounded by context length -- which
matters here, because context costs a lot: the SAME prompt at the same depth falls 1.70 -> 1.37 (k=5)
and 1.41 -> 1.15 (k=2) going from ctx 135 to 273, as the VM's own attention grows with it.

**1.70 tok/s on code is the fastest masked decode measured on this phone.** The mechanism is the one
REPORT 16.8 gives for the 27B: a drafted row costs a full `C` whether accepted or not and accepting
saves only `W`, so the depth that pays scales with how often a draft lands. Code is more predictable
than prose (80-83 % against 55 %), which buys three more rows. Per-draft acceptance still falls with
depth on code -- 80 % at k=2, 67 % at k=5 -- but not fast enough to cancel the extra rows.

So the shipped default should pick depth per workload rather than fix it: `--ei draft_max 1` for prose,
`--ei draft_max 4` for code. An engine that watched its own accepted/drafted ratio could do this by
itself; the counters it needs are already on the turn line.

## Audit: the int16 rail counter, and what it was hiding (2026-09-22)

`saturated` counted reply values on the rail and the reply path then USED them. This chip saturates
rather than wraps, so a railed reply is a CORRUPTED product, not a large one -- but a value can also
legitimately round to exactly the rail, and only exact arithmetic separates the two. Raised in review;
the counter had been non-zero for every modular run and nobody had established which it was.

**It is separable in place, and the answer is that none were legitimate.** The VM holds the masked row
it sent, the public weights and the requantise multiplier, so on a rail hit it recomputes that element
in int64 with `llround((double)acc * M[j] * mscale)` -- the reference worker's own expression,
associated the same way, under the same bundle and model:

| run | rail hits | genuine clips | max excess | worst error into y |
|---|---|---|---|---|
| audit, turn 1 | 188 | **188 (100 %)** | 38250 | 373.5 LSB |
| audit, turn 2 | 198 | **198 (100 %)** | 39700 | 387.7 LSB |
| repaired, turn 1 | 182 | 182 | 33726 | 329.4 |
| repaired, turn 2 | 208 | 208 | 23274 | 227.3 |

Every one exceeded the rail, by up to more than the whole int16 range, each carrying up to ~388 output
LSBs into `y`. **The cause is systematic, not a tail event**, and the per-digit counter proves it:
`hi 0, lo 188` -- every clip on the `lo` digit, none on `hi`, exactly as `DIGIT_OUT_DIV = 128/1.25`
predicts (1.25x headroom for `lo`, 2.5x for `hi`). A 2.2x-rail excess would be ~11 sigma if statistical.

**Fix:** use the exact value, already in hand at detection. It is the out-of-lane correction's remedy
applied to the output side rather than the input side -- public weights and the VM's own masked row,
nothing crosses the link, the lane contract and the modular one-time pad are untouched. One dot product
per hit at under one hit per token; throughput unchanged.

### What validates the backend, and what cannot

**The kernel comparison is the one that counts, and it needs no CPU path.** One element per projection
per exchange is recomputed with the reference's expression under the SAME bundle, weights and
quantisation, and compared with what the backend returned:

| run | compared | disagreements | worst | RMS |
|---|---|---|---|---|
| 1 | 59040 | 2 | **1 LSB** | 0.006 |
| 2 | 58220 | 3 | **1 LSB** | 0.007 |

So the backend's requantisation is faithful to within a single LSB on 5 elements in 117k, consistent
with tie-breaking between its internal requantise and double-precision `llround`. Clipping was the only
defect.

**The rail convention had to be measured where every rail is seen.** A sampled histogram returned
0/0/0, which is not evidence -- a few hundred rails in ~190M elements will never appear in a 59k
sample. Counted at the detection site instead: **-32768 x98, -32767 x0, +32767 x90**, summing to the
188 clips. Two consequences: the original narrow test (`== -32768`) was catching every real hardware
rail after all, and **the reference worker was clamping one LSB short of the silicon** (`-32767`), so
anything validated against it was off by an LSB at the negative rail. The reference is corrected.

**What an unmasked CPU run can and cannot show.** It is a different quantisation path, so it can show
substantive agreement and never bit-exactness. The first attempt was also not a controlled comparison:
`local-run.sh` ignores `MAXNEW`, so it generated 512 tokens a turn and turn 2 began from a different
history (ctx 538/1078 against 135/273); only turn 1 survives, and only as a PREFIX comparison, which is
valid because greedy decoding is prefix-deterministic. Its rate is not a thermal baseline either (the
log ends capped at 1785000). Controlled output comparisons use one turn, equal token limits, a fresh
context, `WIDTH=4000` so nothing truncates at 260, and the repair behind `kRepairClips` so the two arms
differ in nothing else.

### Undefined behaviour in the digit split, found by the same review

`q = 256*hi + lo` was written THREE times -- the send path, the minter's pad split, and the audit
recompute -- with three different expressions, two shifting negative values. A left shift of a negative
is undefined in C++17 (defined only from C++20) and `build.sh` compiles this file as C++17; a right
shift of a negative is implementation-defined. `w=1, q=-256, high=false` trips "left shift of negative
value -1" under UBSan. The three sites must agree BIT-EXACTLY or the pad the VM subtracts and the digits
the TPU multiplies describe different numbers.

One helper now, using a modular mask and an exact division, no shifts of negatives.
`tpu/test/digit-split-test.cpp` checks it over the whole int16 range under
`-fsanitize=undefined -fno-sanitize-recover=all`: **65536 values, 0 failures**, and it asserts agreement
with BOTH old expressions on this compiler, so the change is behaviour-preserving where the old code was
defined and only removes the cases where it was not.

### Acceptance: the pad-independence invariant

The right test is not an external oracle -- it is an invariant of the scheme itself. **The one-time pad
is redrawn every run and cancels exactly under correct arithmetic, so the decoded output must be
INDEPENDENT of the pad.** That independence is what makes the exchange hiding while still producing the
right answer, and a clamped product has lost the information needed to subtract the pad back out.

Same binary, same prompt, greedy, `draft_max 1` (so depth is fixed and the adaptive schedule cannot
vary), fresh context, `WIDTH=4000`:

| | run 1 clips | run 2 clips | output |
|---|---|---|---|
| clips USED AS-IS (`kRepairClips=false`) | 158 | 174 | **diverged at char 246 of 458** |
| clips REPAIRED | 158 | 166 | **byte-identical, 458/458** |

The repaired runs draw different pads -- the clip counts differ -- and still produce the same bytes.
The unrepaired runs differ from each other. So the defect made the decode a function of the secret pad,
and the repair restores independence. The repaired hash also equals what unrepaired run 1 happened to
produce, with unrepaired run 2 diverging from it, so the repaired output is the stable one.

This supersedes the earlier before/after text comparison, which was CONFOUNDED: adaptive depth varies
with timing, and with clipping present the corruption depends on which rows are sent, so the unrepaired
arm was nondeterministic and the difference was not attributable to the repair. Withdrawn.

Also note `saturated 175, CLIPPED 174` in one run: a rail hit whose exact value was legitimately on the
rail, correctly detected and correctly NOT repaired. The discriminator works in both directions.

### Bounding the repair against an untrusted worker

Raised by the peer tier, whose field GEMM REFUSES an out-of-range reply as a protocol violation rather
than clamping (`sh_reply32_balanced`, with the int64 accumulate wrapping in Z_M). Refusal is wrong here
-- a clamp is EXPECTED on this path because the margin is self-inflicted -- but the framing exposed a
hole: the worker is untrusted and can rail replies deliberately, and the repair obediently recomputes
each one locally. At the natural rate (<1 per token) that is free; at 100 % it drags the whole matmul
back into the VM and defeats the offload. Not a confidentiality or correctness break -- the VM computes
the right answer from public weights either way -- but a denial-of-service lever given away for nothing.

Bounded now: repair the rare case, and an exchange that rails more than an eighth of its outputs (three
orders of magnitude above the natural rate) says so, and aborts after 8 consecutive. Same precedent as
`mint_batch`'s 8-bad-draws abort.

**And the sampled kernel verification is now OFF by default.** The same peer measured a reply-validation
pass at 3.50 ms per pass, about 7 % of a token, on the assumption it was free. The rail test itself IS
free here -- a predicate on values the unmask loop has already loaded, no second pass to fuse -- but the
verification recomputes elements on the critical path and had never been timed. It is a validation tool,
enabled for audits.

### Re-baselined on the repaired path (2026-09-22)

Shipping configuration -- repair on, sampled verification OFF, flood bound in, adaptive depth, window
minting, H=4 digit-split:

| turn | workload | ctx | tok/s | clips |
|---|---|---|---|---|
| 1 | code | 135 | **1.74** | 181, all repaired |
| 2 | prose | 204 | 0.80 | 103, all repaired |

**1.74 tok/s is the first valid quality-bearing number on this path.** It equals the pre-audit figure,
which is the useful part: the repair costs nothing, so correctness was restored for free and everything
earlier was simply wrong rather than a speed/accuracy trade. The withdrawn 1.70-2.07 figures stay
withdrawn on principle -- they were produced while accepted products were corrupted and the decode
depended on the secret pad -- but the path is worth the same when it is correct.

What the audit does NOT change: the architectural ceiling. The link is 0.74 ms of latency plus 22 MB/s,
four exchanges per block are forced by what a mask survives, and `blocks x 4 x 2.538 ms` still puts 15
tok/s at about 8 blocks and 25M parameters. Clipping was a correctness defect, not the reason this path
is far from the bar.

### Pad dependence is INHERENT, so the criterion is a bound and not equality (2026-09-22)

The audit asked whether the output is pad-independent. It is not, and cannot be. Measured with
`a8w4/pad_dependence.py`: one fixed activation, real weights from the shipped bundle, two independently
drawn pads, and **zero clips** in either run --

| group | out-of-lane A/B | clips | max \|yA - yB\| | rms |
|---|---|---|---|---|
| blk.00 qkv | 57/52 | 0/0 | 3.106 | **1.097** |
| blk.00 | 60/70 | 0/0 | 3.063 | **1.077** |
| blk.00 | 55/67 | 0/0 | 2.577 | **1.016** |

About **one output LSB RMS**, with no clipping involved. The reason is structural: the backend returns
a QUANTISED product of the MASKED row, `v = round(M * W.q)` with `q = (x + r) mod m`. The pad cancels
in the real arithmetic -- `M*W.q - P` is exactly `M*W.x` -- but the ROUNDING in `v` was committed
against a value that depended on `r`, and subtracting an exact `P` cannot undo it. Digit-split
amplifies it, because the `hi` digit's rounding is multiplied by 256 on recombination.

**So "two runs must produce identical bytes" was the wrong criterion.** It is unachievable in
principle, and two runs that did match were luck at a near-tie. The right criterion is a BOUND:

| source | magnitude | verdict |
|---|---|---|
| inherent quantisation of the masked product | **~1 LSB rms, ~3 LSB max** | the floor; irreducible |
| float cancellation in the digit reconstruction | 0.0011 LSB max over 60M elements | negligible; fixed anyway, it was free |
| float accumulation of the out-of-lane correction | four runs still differed after int64 | not the cause |
| **clipping, before the repair** | **up to 388 LSB** | ~370x the floor: a real defect |

That is what the repair is worth, stated properly: it does not make the path reproducible, it returns
the error from 370x the quantisation floor to the floor. Token flips at near-ties remain possible and
are a property of masked quantised offload, not a bug.

Two hypotheses were eliminated by measurement before this one was confirmed, and both had looked
plausible. Neither "the outputs look similar" nor "two runs matched" identified a cause; only measuring
the magnitude of each candidate did.

## The decode error: what is derived, what is simulated, and what is neither (2026-09-22)

The previous section ended at "the criterion is a BOUND, not equality" without saying what the bound is.
`tpu/test/error_bound.py` now derives it and checks it. The three statements below are deliberately
separated, because they have very different standing and an earlier write-up ran them together.

**Derived, and it holds for every exchange this lane can produce.** In output LSBs, with
`D = DIGIT_OUT_DIV = 102.4`, the whole decode error of a non-clipping exchange is

    err = (256*ea + eb)/D - ep

where `ea`, `eb` are the backend's deviations from the ideal product on the two digits and `ep` is the
rounding in the minted pad. The out-of-lane and wrap terms are exact integers and contribute nothing.
With an ideal round-half backend that gives

    |err| <= (256/2 + 1/2)/102.4 + 1/2 = **1.7548828125 output LSB**

and the 256 is digit-split's price: the `hi` digit's rounding is multiplied by 256 on recombination and
`D` buys back only 102.4 of it. This figure was independently re-derived during the audit and agrees.

**Simulated, on the design rather than on the silicon.** Real weights and real lane widths out of the
shipped bundle, synthetic in-lane activations, one projection each from six groups sampled across the
depth (blocks 0, 6, 9, 17, 26, 30; all four projection kinds), ideal backend, no TPU invoked and no reply
read:

| | max | rms |
|---|---|---|
| simulated error, 14848 elements | **1.737** | **0.778** |
| analytic ideal bound | 1.7549 | -- |
| extra from evaluating the reconstruction in float32 rather than f64 | 1.06e-3 | -- |

The last row is the separate accounting the audit asked for: the production path reconstructs in float,
and that choice costs about a thousandth of an LSB, so it is not a term worth reasoning about further.

**Neither derived nor measured: the 4.26 figure.** Feeding `|delta| <= 1` on both digits through the same
algebra gives 4.2646484375 LSB, and that number appeared earlier as though it were a production worst
case. It is not. It is CONDITIONAL on a premise that has never been established: what was actually
observed is that on two sampled kernels, 5 elements in 117k differed from the reference by exactly one
LSB and none by more. That is consistent with `|delta| <= 1`; it is not a proof of it for unsampled
layers, activations or pads. A real worst case needs an adversarial or exhaustive characterisation of the
backend, which has not been done.

**And none of it is a measurement of the deployed kernel.** Every number in the table comes from NumPy.
A deployed figure would have to come from replies captured off the device and compared against the same
reference, which is a different experiment. The honest summary is: the design's error is bounded at about
1.75 output LSB and sits at about 0.78 rms; whether the silicon stays inside that is supported by a
117k-element sample and nothing stronger.

## The build could package a binary the source did not describe (2026-09-22)

`libggml-tpu.so`, `liblocalengine.so` and `libengine.so` are built ONLY by `./build.sh engine-pvm`. The
`anchor` target packages whatever it finds in `out/engine-pvm/`. So editing `payload/ggml-tpu.cpp` and
running `./build.sh anchor` produced a correctly signed APK containing the PREVIOUS backend, silently.

This is not hypothetical: a quality comparison was started against a binary still carrying
`kInjectFault = 1` from a fault-injection experiment, with the source on disk reading `0`. Nothing in the
build, the install or the filenames showed it. What caught it was the payload's own line

    VSOCK LOCAL tpu: build config repair=1 verify=0 inject=1 corr_threads=1 spin_us=0 (built Sep 22 2026 02:00:17)

which prints the switches AS COMPILED plus `__DATE__`/`__TIME__`. That line exists because an earlier
audit round found logs labelled REPAIRED that had been produced with the repair compiled out; it has now
paid for itself twice, and the lesson generalises past this repo: a measurement harness should make the
binary state its own identity, because every cheaper proxy -- filename, directory, build order, memory --
has now failed at least once here.

Two changes followed. `build.sh anchor` REFUSES when `payload/ggml-tpu.cpp` or `payload/engine_local.cpp`
is newer than the library it is about to package, naming the source and the fix. And
`host/quality-compare.sh` writes the sha256 of each packaged library and the compiled switch values into
a `BUILD` file beside the results, so a result carries its binary's identity rather than sitting next to
it.

A second trap in the same area, for the record: without `ANCHOR_TPU_LIBS` pointing at the prebuilt
`libanchortpu.so` and `libLiteRtDispatch_GoogleTensor.so`, the APK builds, signs and installs happily and
then fails at run time with "TPU worker library not in this APK". The build now documents the full order
in its header: `./build.sh engine-pvm && ANCHOR_TPU_LIBS=<dir> ./build.sh anchor`.

## Corrections to the fault-injection write-up (2026-09-22)

Three claims from the adversarial validation were overstated and are corrected here.

* **Mode 2's rate.** The injector's loop starts at `i = 0`, and the largest reply this lane produces is far
  below its 200000 stride, so mode 2 injects EXACTLY ONE false rail per non-empty exchange -- not the
  "~0.2 per exchange" the comment and the write-up claimed. The experiment's premise survives, because one
  is still below `kRailRefill = 4` and so the budget must never fire; but the stated rate was wrong by 5x.
* **Mode 3's evidence.** Mode 1's refusal message was captured verbatim. Mode 3's saved log shows only the
  SIGABRT, not a reason-specific line, so "mode 3 refused" rests on the exit and not on retained evidence.
  It needs a re-run under the widened `tpu-run.sh` filter before it can be called diagnosed.
* **What coherent output proves.** Mode 2 completing at 1.45 tok/s with readable text, having rejected 3360
  false rails over 3414 recomputations, is evidence the reject path runs and does not wedge. It is not
  evidence of numerical correctness; only a comparison against a reference is that.

## Halving the reply on the TPU: three constructions, one compiler crash (2026-09-22)

The reply is the larger half of the link by a wide margin -- 3432 KB per token against 1039 out -- and all
of that excess is digit-split: the TPU returns `W.hi` and `W.lo` as separate int16 rows and the VM forms
`256*hi + lo` itself. If the TPU did the recombination, the reply would halve, the per-row cost `C` would
halve with it, and the asymptotic ceiling that `C` sets would move from about 4.7 to about 9.4 tok/s.
That is the only lever found so far that moves the CEILING rather than closing distance to it, so it is
worth being exact about why it is unavailable.

**First, a correction.** `a8w4/probe_combine.py` was written to answer this and its result was recorded as
"the compiler accepted it". It did not. The probe checked `os.path.exists(dst)`, and `apply.sh` creates
the destination BEFORE compiling, so an empty file read as success: `comb_slice_add_g5.tflite` and
`comb_split_add_g5.tflite` have been sitting on disk at **zero bytes** since 2026-09-19 while the notes
said otherwise. The check now requires a non-zero size and prints the compiler's own tail.

With that fixed, three different ways of saying "add the first R rows to the last R rows" were tried
against the Tensor G5 AOT compiler, at the real shape (`[10, 2048]` int8 in, int4 weights, `[5, 8192]`
int16 out):

| construction | ops after the FC | result |
|---|---|---|
| none (ship today) | -- | compiles, 8.6 MB |
| split_add | STRIDED_SLICE x2 + ADD | **INTERNAL compiler error, 0 bytes** |
| slice_add | SLICE x2 + ADD | **INTERNAL compiler error, 0 bytes** |
| split_op | SPLIT + ADD | **INTERNAL compiler error, 0 bytes** |

All three fail identically at `apply_plugin.cc:455` with `error type: INTERNAL`, which is a compiler crash
and not a rejection -- the ops are individually compilable (`sh_split`, `sh_reduce_sum`, `op_add_*` all
build), and it is combining them with the FC's int16 output that trips it. So this is a defect to report
upstream rather than a statement about what the silicon can do.

The alternatives do not rescue it either, and both fail for the same structural reason:

* **Two FCs against one weight tensor** lets the TPU add the results, but emits the weights twice
  (35.6 -> 71.9 MB on a real layer). Weight streaming is what `tpu-run` spends its time on (1.948 ms per
  exchange, 273 ms per token), so doubling it costs about +273 ms to save about 78 ms. Strictly worse.
* **Folding the 256 into the weights** -- laying the input out as `[R, 2*n_in]` with `[256*W; W]` stacked
  -- needs a different scale for two blocks of INPUT columns. Quantised FULLY_CONNECTED has per-OUTPUT-
  channel weight scales and nothing per input block, so it cannot be expressed. This, not preference, is
  why the digits are stacked as rows and the VM does the recombination.

So the reply stays doubled, `C` stays at about 1.515 ms per row per exchange, and the ceiling stays where
the row sweep put it.

## End-to-end quality against a baseline, under matched controls (2026-09-22)

The audit's standing requirement was representative end-to-end quality against a baseline before calling
the residual error acceptable. This is that comparison. Six prompts, one run each so neither arm ever
conditions on a history the other did not have, `max_new = 48` passed to BOTH arms, greedy, full
untruncated replies, no drafter in either arm, and both on the same binary whose identity is recorded
beside the results: `libggml-tpu.so` **ba47bd16cfdfe122741ced6cdec0f5bc**, which is the digest of the
library inside the APK the device actually had installed, with `repair=1 verify=0 inject=0` built 02:21:17.

(An earlier draft of this paragraph quoted `5bc42588`. That was the staged library BEFORE the rebuild --
the fault-injection build -- read out of `out/` rather than out of the installed artifact, which is the
same class of mistake the build-staleness section above is about.)

**What the identity evidence actually supports, and what it does not.** A pull taken later establishes
what is installed NOW: `host/build-identity.sh` retrieved the APK
(`6abb8b0b9976...a8d`, 24299027 bytes) and extracted `libggml-tpu.so` at its full length,
`ba47bd16cfdfe122741ced6cdec0f5bc5311d7cde4645733fc7c801f2a194984`. It does NOT retroactively establish
what ran during a comparison hours earlier, because nothing in that pull rules out an install in between.
The per-run evidence is separate and is what carries the weight: every run's log contains the payload's
own `build config repair=1 verify=0 inject=0 ... (built Sep 22 2026 02:21:17)` line, emitted by the
binary that answered that run. Those two together are consistent with one binary throughout, and a
deployment-continuity record -- an install log, or the digest captured at run time rather than after --
is what would close the gap. That is now what `build-identity.sh` is for, run per comparison.

An earlier version of this check recorded `e3b0c44298fc1c149afbf4c8996fb924` as the installed digest.
That is the SHA256 of ZERO BYTES: `unzip` cannot extract a member from a non-seekable stream, its error
was discarded, no exit status was checked, and `sha256sum` hashed the empty result. A manifest that
reports a digest for nothing is worse than one that reports nothing, and the failed manifest is preserved
beside its replacement rather than overwritten.

| # | prompt | result |
|---|---|---|
| 01 | capital of France | **identical** |
| 02 | first ten primes | **identical** |
| 03 | reverse a string in Python | diverges at char 9 |
| 04 | hello in three languages | **identical** |
| 05 | why the sky is blue | diverges at char 79 |
| 06 | three countries in South America | **identical** |

**These replies are TRUNCATED, and that bounds what the table means.** Every run was capped at 48 tokens,
and at that cap prompt 03 stops before it has written any function body, prompt 04 stops after "Hello" and
"Hola" with a bullet left open, and the CPU arm of 05 ends mid-sentence. Byte agreement between two capped
prefixes is evidence that the decode tracks the baseline token for token; it is NOT evidence that either
arm completed the task. The task-scored comparison below is the one that speaks to that, and it reports
the stop reason per run so a capped answer can never be scored as a completed one.

**Four of six replies are byte-identical to the unmasked CPU decode of the same GGUF.** The two that
differ do so at a single early token and then compound, which is what greedy decoding does: 03 splits on
"Here are `several` ways" against "Here are `a few` ways" and 05 on a rephrasing of the same Rayleigh
explanation. Both continuations are coherent, both keep the same structure, and neither is wrong.

**The near-tie explanation is a HYPOTHESIS, not a result.** It is consistent with a 0.78 LSB rms error and
with the fact that both continuations are sensible, but nothing here measured the logit margin at the
position that flipped, so "the top two candidates were close" is not established. Establishing it needs
the top-2 logits and their gap at each divergence, which neither arm currently reports. Until then the
honest statement is that the outputs diverge at one token and both remain coherent.

**What this does and does not establish.** The CPU arm decodes the same GGUF but dequantises to f32: it
is a DIFFERENT quantisation, not a bit-exact oracle. That asymmetry cuts in a useful direction here --
agreement across two different arithmetics is stronger evidence than agreement between two runs of one,
and byte-identical output on 4 of 6 is a much better result than the per-element bound alone would
suggest. It does not cut the other way: a divergence is not by itself evidence that the masked path is
the wrong one. This is also NOT a comparison against Google's NPU lane, which is a different model
package (LiteRT-LM, its own quantisation and tokenizer) that no token-level comparison from here can
reach. And six prompts at 48 tokens is a small sample; it is representative, not exhaustive.

**The rates in the same table are the uncomfortable part.** The TPU arm ran 1.09-1.15 tok/s across all
six. The CPU arm, same phone, same model, same VM, ran **13.40-15.48 tok/s** -- which is to say the
in-VM CPU path already meets the 15 tok/s bar on some prompts while the masked TPU path is 13x slower
than it. The masked path's cost is not the TPU's capability; it is the 140 protected-VM round trips the
security contract forces per token.

Three controls in this comparison had to be repaired before it meant anything, and all three had been
silently wrong: `local-run.sh` never passed `max_new` (so the CPU arm ran 512 tokens against the TPU
arm's 48), `quality-compare.sh` lost its prompt list to `adb` reading stdin (so only the first prompt
ran), and the installed binary was a fault-injection build. An earlier version of this comparison would
have produced a table that looked exactly as convincing and meant nothing.

## Rows are free on this TPU: measured, and it fixes where the ceiling comes from (2026-09-22)

Two runs on the same verified binary, same prompt, same bundle, differing only in whether a drafter was
attached, decompose the per-row cost directly rather than by fitting a sweep:

| per exchange | 1 row (no drafter) | 3.89 rows (drafter, depth 4) | change |
|---|---|---|---|
| worker `tpu-run` | 1.948 ms | 2.203 ms | **+13 %** for 3.9x the rows |
| worker `output-read` | 0.268 ms | 1.096 ms | +309 %, i.e. linear in rows |
| VM `link` | 4.939 ms | 9.984 ms | +102 % |
| VM `mask` + `unmask` | 0.601 ms | 2.199 ms | linear in rows |

**The TPU barely notices extra rows; the reply bytes are the entire marginal cost.** That is what
`make_graphs.py` means by "rows are free on this TPU", now measured on the shipped path rather than
asserted, and it relocates the ceiling: it is not the accelerator, it is what a row costs to carry back
across the protected-VM boundary.

Fitting the two points: `C` = 1.746 ms per row per exchange of link, plus 0.565 ms of VM mask/unmask, so
`C_total` = 2.311 ms. At 140 exchanges per token that is **324 ms per token however many rows are in
flight, which caps this design at about 3.1 tok/s** -- tighter than the 4.7 the earlier row sweep gave,
because that one did not count the VM's own per-row work.

For the 15 tok/s target: 67 ms per token, against a 324 ms per-row floor and a 273 ms TPU-compute term.
Both exceed the whole budget on their own.

### Two attempts to buy some of it back, both refused by the phone

The drafter run showed the pad bank draining (`bank_min 2`, 1120 inline mints at 4.11 rows/exchange), so
the bank looked like free throughput. It is not:

| configuration | tokens/step | link ms | **tok/s** |
|---|---|---|---|
| BANK=64, no refill threads (shipping) | 2.53-2.67 | 9.86-9.98 | **1.30-1.37** |
| BANK=256, refill threads 2 | 3.20 | 17.754 | 1.08 |
| BANK=256, no refill threads | 3.20 | 19.901 | 0.93 |

Both changes did exactly what they were meant to -- the bank stopped draining (`pads inline 0`,
`bank_min` 190-258) and acceptance rose from 2.53 to 3.20 tokens per step -- and both made throughput
WORSE, because `link` roughly doubled. The refill threads are the documented no-spare-core problem, the
same one that made the `MSG_DONTWAIT` spin worse. But BANK=256 with no extra threads is worse still,
which points at memory rather than CPU: minting 256 positions per group took guest memory available from
1689 to 1091 MiB, and the lane bundle is 1757 MiB of evictable page cache in that same VM. Enlarging the
bank evicts the bundle it is there to serve.

So the shipping configuration stays BANK=64 with no refill threads, and "acceptance went up" is again not
the same as "it got faster".

## Task-level quality: 7 of 8, the same as the unmasked baseline (2026-09-22)

The 48-token table earlier in this file compares TRUNCATED replies and is decode agreement, not task
completion. This is the task-scored version: eight prompts, one run each, `max_new = 256` passed to both
arms, greedy, no drafter, full outputs, and **every reply stopped on its own rather than at the cap**, so
these are finished answers. Scoring is `host/quality_checks.py`, which never counts a regex match as
correctness.

| # | task | check | tpu | cpu | decode agreement |
|---|---|---|---|---|---|
| 01 | capital of France | names Paris | PASS | PASS | identical |
| 02 | 17 x 23 | the number 391 | PASS | PASS | identical |
| 03 | first ten primes | all ten, in order | PASS | PASS | char 32 |
| 04 | three South American countries | 3 DISTINCT valid countries | PASS | PASS | identical |
| 05 | `reverse_string` | **the function is interpreted and run against 5 cases** | PASS | PASS | char 46 |
| 06 | a haiku about rain | open-ended | REVIEW | REVIEW | char 62 |
| 07 | why the sky is blue | names Rayleigh | PASS | PASS | char 79 |
| 08 | boiling point of water | the number 100 | PASS | PASS | identical |

**tpu 7/8, cpu 7/8, with the eighth REVIEW on both arms.** Prompt 05 is the sharp one: both arms wrote
`return s[::-1]` inside a docstringed function and differed only in the docstring's wording ("Reverses the
given string" against "Returns the reverse of the input string"), and the restricted interpreter confirmed
the masked path's function actually reverses `abc`, `racecar`, `ab cd`, `x` and the empty string. That is
a task the masked path completed correctly, checked rather than pattern-matched.

The haiku is REVIEW because no automatic check can score a poem, and REVIEW is deliberately not a pass.
For the record, reading them: both are three lines about rain, agreeing for two of them and parting on the
last ("Earth drinks cool, fresh tears" against "Nature breathes anew"). That is a human reading, which is
exactly what REVIEW asks for, and it is not a score.

**Scope, again, because it keeps mattering.** The CPU arm is a different quantisation of the same GGUF,
not a bit-exact oracle. Eight prompts is representative, not exhaustive. And this is still not Google's
NPU lane: token-level comparison with it is impossible because the tokenizers differ, but a TASK-level
comparison on exactly these prompts and checks is possible and is not yet done.

The honest summary is that at the task level the masked path is indistinguishable from the unmasked CPU
decode on this set, while running at 1.09-1.15 tok/s against its 13.40-15.48.

## The evaluator that produced the first version of that table was wrong twice (2026-09-22)

Worth recording because both failures were the same shape as the build-staleness one -- a check with no
way to fail -- and both were found by audit, not by me.

**Regex presence was reported as task correctness.** Driven with synthetic answers, the first evaluator
passed `def reverse_string(s): return s` (which returns the string UNREVERSED), `Brazil` for "name three
countries", and `banana` for a haiku: 3/3 PASS. Scoring now has four verdicts that never collapse into
each other -- SMOKE (a shape is present, never correctness), PASS (a semantic check ran and was
satisfied), REVIEW (open-ended, needs a human), FAIL -- and every prompt stays in the denominator, so a
crashed or capped run is a failure with a reason rather than a row that quietly shrinks the total.

**Then the fix for that was itself unsafe.** Checking code by RUNNING it, in a child with RLIMITs and a
scratch cwd, is not isolation: an audit candidate wrote a sentinel OUTSIDE the scratch directory and still
passed. Worse, the verdict was parsed from the child's stdout while the candidate's code ran BEFORE the
driver printed, so `print('{"ok": true}'); raise SystemExit(0)` passed without ever defining the function
-- `SystemExit` is not an `Exception`, so the guard did not catch it.

That path is closed. `host/safe_py.py` PARSES the candidate and interprets a restricted subset itself: no
`exec`, `eval`, `compile` or `import`, and only the named function and module-level `def`s it calls are
ever evaluated, so code sitting beside a function cannot act at all. The escape has no name to call
because `open` is not in the environment the interpreter provides; the verdict cannot be forged because it
is the value the interpreter computed rather than anything the candidate emitted; and steps, value sizes,
call depth and exponents are bounded, so a `while True` or a `'a' * 10**9` terminates as REVIEW.
`host/test_quality_checks.py` pins 18 known false positives against 7 true positives AND asserts the
sentinel path was never created, so the suite fails if the checker ever executes anything again.

## a8w4: measured, and rejected on the weights (2026-09-22)

The original direction for this work was "a8w4 digit-split", and the shipped path is a8w**8**. That gap
deserved an answer rather than a silence, and the answer is that int4 weights cost far more than they buy.

They would buy something real. The compiled probes at the same shape are `probe_a8w4_g5.tflite` 8.6 MB
against `probe_a8w8_g5.tflite` 17.0 MB -- exactly 2:1 -- and the phone's own dispatch fit is
0.637 ms + 0.0677 ms/MB, so halving the streamed weights is about 0.57 ms per exchange, **80 ms per
token**. (That fit was later superseded by 0.520 ms + 0.0848 ms/MB. The conclusion is unchanged: on the
corrected slope, halving 1872 MB saves 0.568 ms per exchange, 79.5 ms per token -- the same number by a
different route, because the larger slope offsets the smaller per-exchange byte count.) It would also halve the 1757 MB lane bundle, which matters twice over: that bundle is evictable
page cache in a VM with about 1900 MiB available, and the BANK=256 experiment failed precisely because
enlarging the pad bank evicted it.

The weights are the problem. `a8w4/sim_w4_quality.py` on the real tensors:

| weights | mean relative RMS error | against int8 |
|---|---|---|
| int8, one scale per row (shipped) | 1.012e-02 | -- |
| int4, one scale per row | 1.833e-01 | **18.1x** |
| int4, groups of 128 | 1.218e-01 | 12.0x |
| int4, groups of 32 | 1.014e-01 | 10.0x |

**Only the 18.1x row is expressible.** Quantised FULLY_CONNECTED carries per-OUTPUT-channel weight scales
and nothing per group of input columns, so group-wise int4 would have to be built by splitting the input
and summing partial products -- the same construction whose slice/add the G5 compiler crashes on. And even
if it compiled, group-32 is still 10x the int8 error.

Against an output error currently bounded at 1.755 LSB and measured at 0.78 rms, and a task score that
matches the unmasked baseline 7/8, an 18x weight error to gain 10 % of throughput is not a trade worth
making. This also retires a loose end in the earlier record: TPU.md line 176 noted the original a8w4
attempt measured KL 0.080 and blamed int8 ACTIVATIONS. On this evidence the weights are the likelier
culprit, and digit-split removed the activation objection anyway -- it sends int8 rows, which is the case
the compiler accepts int4 weights for.

## Why 15 tok/s is not reachable here, in three independent floors (2026-09-22)

15 tok/s is 67 ms per token. The measured per-token budget at one row is 893 ms, and it decomposes into
terms of which **three each exceed the whole budget on their own**:

| term | ms/token | vs the 67 ms budget |
|---|---|---|
| TPU compute (`tpu-run` x 140) | 273 | **4.1x over** |
| reply bytes across the pVM boundary | 203 | **3.0x over** |
| round-trip latency (0.74 ms x 140) | 104 | **1.6x over** |
| VM ops not offloaded | 139 | 2.1x over |
| VM mask / unmask / correction | 104 | 1.6x over |
| worker I/O | 65 | -- |

No single fix can work, because removing any one term entirely still leaves two others over budget. And
the levers are now measured rather than speculative:

| lever | measured effect | status |
|---|---|---|
| int4 weights (a8w4) | -80 ms | rejected: 18.1x the weight error |
| on-TPU digit recombination | about -100 ms | closed: G5 compiler INTERNAL crash, three constructions |
| deeper pad bank | acceptance 2.53 -> 3.20 tokens/step, throughput 1.37 -> 0.93 | rejected: evicts the bundle |
| background refill threads | link 9.98 -> 17.75 ms | rejected: no spare core |
| more rows (speculation) | TPU cost +13 % for 3.9x rows | already shipped; bytes-bound |
| int16 activations | reply halves, weights double | measured worse (0.98 against 1.22 tok/s) |

Even granting every lever that is not already refuted -- recombination working, and the byte term going to
zero -- the token lands near 500 ms, which is 2.0 tok/s.

**What model shape would clear it.** Fitting the measured terms by block: about 24.2 ms per transformer
block (TPU compute, both crossing terms, worker I/O, and the VM's per-block work) plus about 39 ms that
does not scale with depth (embeddings, the 166810-row lm_head, sampling). Setting that to 67 ms gives

    67 = 24.2 B + 39   ->   B = 1.2 blocks

**One transformer block.** Not a small model: not a model. For comparison the same arithmetic puts the
shipped 35-block E2B at 886 ms, which is the 893 measured.

So the masked TPU path cannot meet the bar at any useful model size, and the reason is not the
accelerator. The two architectures that DO meet it are unchanged: the in-VM CPU decode, measured at
**13.40-15.48 tok/s on this phone today** in the very same runs (the baseline arm of the quality
comparison), and TPU assignment into the pVM, which is a Google platform gate and not a silicon one.

## The search, finished: every accelerator path on this device, checked on the device (2026-09-22)

The brief was to find ANY viable option, so here is the enumeration rather than an argument, each row
established by a command run against the phone today rather than from memory.

| option | verdict | the evidence |
|---|---|---|
| TPU across the pVM boundary, masked | **1.09-1.37 tok/s** | measured; three floors each over the 67 ms budget |
| TPU assigned INTO the pVM | closed | `vm info`: `VFIO-platform is not supported`, `Assignable devices: []` |
| GPU into the pVM | closed | crosvm has ZERO strings for virtio-gpu / gfxstream / virglrenderer; the Microdroid guest kernel has no DRM driver |
| GPU across the boundary, masked | ~2.67 tok/s (**ESTIMATE**) | a projection, not a measurement: it takes a 198 us submit floor measured on a DIFFERENT device (an integrated GPU, not this phone's) and substitutes it for the TPU's measured 637 us in the same 140-round-trip model. No masked decode has been run on this phone's GPU |
| any device via `--devices` | closed | the flag exists, the VFIO backend it needs does not |
| CPU inside the pVM | **13.29 tok/s sustained** | 315 tokens, 459 core-ms/token, 5.6 cores, thermal status 0 throughout |

Platform state at the time of the check: kernel `6.6.118-android15-8`, Android release 17, SDK 37,
security patch 2026-08-05. The gate is the 6.6 kernel: assignment needs 6.12 plus VFIO.

**So on a stock Pixel 10 there is no way to put an accelerator inside the trust boundary, and outside it
the masking protocol costs more CPU than the matmuls it moves.** That second half is the part that
matters most, because the TPU requirement was instrumental -- it existed to keep a host's phone from
being made slow, hot and flat:

| | tok/s | core-ms/token | cores busy | thermal |
|---|---|---|---|---|
| CPU only, in the pVM | 13.29 | **459** | 5.6 | status 0 across a sustained run |
| Shielded-TPU, H=4, digit-split | 0.67-1.37 | **6641** | 4.5 | -- |

The masked TPU path uses about 15-20x more phone CPU per token while keeping the same number of cores
busy. It does not move work off the CPU; it adds work to it, because minting a pad is the same integer
MACs as the matmul it protects and the VM still does every norm, the attention and the sampling. On the
one criterion that motivated requiring the TPU, the TPU path is strictly worse than the alternative it
was meant to replace -- and it also has the weaker boundary, since the host sees masked activations where
on the CPU path it sees nothing at all.

**What would change the answer.** Not a better mask and not a better kernel schedule: the floors are
structural. It takes an accelerator inside the pVM, which means a platform that can assign one --
kernel 6.12 with VFIO, or a device we provision ourselves. Our half of that is already built and proven
on this phone (EL2 reset handler, guest kernel with pvIOMMU); what is missing is a host that will hand
the device over. That path is worth about 20-25 tok/s and satisfies every part of the brief at once,
which no arrangement of a masked outside-the-boundary worker can.

## The exchange is turnaround-bound, not bandwidth-bound (2026-09-22)

A measurement taken while probing concurrency turns out to say something about the link itself. Three
one-directional streams over the SAME protected-VM boundary, into a fresh encrypted store:

| stream | bytes | time | rate |
|---|---|---|---|
| model | 162 MiB | 4601 ms | 34.6 MB/s |
| model (repeat) | 162 MiB | 4678 ms | 34.6 MB/s |
| TPU bundle | 1757 MiB | 42150 ms | 41.7 MB/s |

**A stream gets 34-42 MB/s on ONE connection; the exchange path gets 22 MB/s.** Both cross the same
boundary with the same bounce buffers, so the gap is not bandwidth. What differs is the shape: a stream
pushes one way continuously, while an exchange is request, wait, reply, and cannot begin the next until
the previous completes. About 40 % of the exchange's byte time is that turnaround.

This matters for what striping across parallel connections could buy. It addresses the bandwidth portion
and not the turnaround, so the honest expectation is smaller than a naive "N connections, N times the
bytes".

**And a retraction.** An earlier reading of a concurrent run claimed 74 MB/s aggregate by adding a
drafter's 32.8 MB/s (averaged over 4.95 s) to a bundle's 41.7 MB/s (averaged over 42.15 s). Those averages
cover different windows, so their sum measures nothing: a schedule that serves the drafter first and the
bundle afterwards fits both totals exactly. **Concurrency remains unproven.** Establishing it needs equal-
size streams with synchronised starts compared by total bytes over MAKESPAN, or time-aligned per-stream
counters. The equal-size control was attempted and the run failed before streaming -- the guest refused
storage for a fresh store (`memfd ftruncate errno=13`, encrypted storage and /data all refused) on a
device at 99 % full -- so it is still open.

### What the striping experiment needs, scoped

Not a fresh store, which is what blocked the control. The link-scaling question can be settled inside an
ordinary run by opening extra connections on the existing worker port and comparing one link carrying N
bytes against two links carrying N/2 each, by makespan. That needs a field on the LOCAL line (which is a
strict protocol: `anchor_local.h` parses exactly the listed keys in order, so the parser, `LocalChat.java`
and `Main.java` move in lockstep), an accept loop in `run_local`, and an echo responder on the app side.
Roughly 120 lines across three files. The masked path is untouched by it: the extra links carry benchmark
bytes only, so pads, verification, ordering and lifetimes are unaffected.

Its payoff is bounded by the floors above. Even taking the byte term to zero leaves TPU compute at 273 ms
and latency at 104, so it cannot reach 67 ms; what it can do is move the asymptotic ceiling, which is
worth knowing precisely rather than assuming.

### And the Google task-level comparison, also scoped

Token-level comparison with the Google NPU lane is impossible because the tokenizers differ, but task-level
comparison on the same prompts and the same strict contracts is not, and it is still outstanding. What
blocks it today is a runner: the phone carries the packages (`/data/local/tmp/*.litertlm`, 2.7-4.1 GB) but
the binaries beside them are microbenchmarks -- `bench-android` is a memcpy harness that says so itself --
not a LiteRT-LM inference runner. Standing one up is a separate piece of work from this harness, and until
it exists the only comparable number against that lane is throughput (25.2 against 1.09-1.37 tok/s), not
quality.

## Does the protected-VM boundary scale per connection? Transport says: a little (2026-09-22)

The control the earlier retraction called for, built as `payload/linkbench.h` and run inside an ordinary
session so it needs no fresh encrypted store: the SAME 8 MiB, once over one link and once split evenly
over N, compared by MAKESPAN, in seven ALTERNATING pairs so drift lands on both phases, reported as
medians. A failed phase abandons the comparison rather than being dropped, because there is no way to
resynchronise a stream whose announced bytes were never consumed, and dropping failures would bias the
medians towards the quiet moments.

| links | one link | N links | scaling |
|---|---|---|---|
| 2 | 102 ms (82.4 MB/s) | 94 ms (89.5 MB/s) | 1.09x |
| 3 | 51 ms (165.1 MB/s) | 37 ms (225.4 MB/s) | 1.37x |
| 4 | 89 ms (93.9 MB/s) | 70 ms (120.1 MB/s) | 1.28x |

Earlier runs of the same benchmark gave 1.37x at 2 links and 1.13x at 3.

**So it scales, sub-linearly, somewhere around 1.1-1.4x -- and the honest headline is the variance, not
the factor.** The one-link CONTROL alone ranged from 66 to 165 MB/s across runs, a 2.5x spread on the
thing everything else is measured against, and within a single run the seven samples of one phase spread
41-186 ms. A fixed 8 MiB transfer varying four-fold points at scheduling rather than bandwidth as what
governs this boundary, which is the same finding as the spin experiment and the refill threads: six big
cores, no spare one, and extra connections contend for them.

**What this does NOT say.** It is transport: a one-directional bulk receive with no TPU, no mask and no
turnaround. It says nothing yet about masked decode, and the reported line carries `TRANSPORT ONLY` for
that reason. Measuring decode would mean striping the real reply across links, which touches reply
ordering and so needs the security review the benchmark links were designed to avoid needing.

**What it suggests, as arithmetic rather than measurement.** Subtracting the worker's own measured time
from the VM's `wait` at one row and at 3.89 rows separates the exchange's crossing into
**1.02 ms fixed + bytes at 26.5 MB/s**. Against a single link that reaches 82-165 MB/s in bulk, the
exchange realises a sixth to a third of one connection's capacity, so bandwidth is not what limits it.
Projecting 26.5 -> 36 MB/s (the 1.37x best case) would save about 46 ms per token, roughly 5 %. That is a
projection from a two-point fit and not a result.

Against the 67 ms budget for 15 tok/s it changes nothing: TPU compute alone is 273 ms.

### The benchmark's own failure modes, found by review rather than by running it

Worth recording because a benchmark that cannot fail correctly produces numbers that look exactly like
real ones, and every one of these was caught by reading the code:

| defect | what it would have done |
|---|---|
| benchmark links opened on WORKER_PORT | the app starts both thread sets at once and the real worker loads 35 graphs before dialling, so accept ORDER could have handed a benchmark link to the lane AS the worker. Fixed by a separate port: role is decided by port and cannot race |
| polled for POLLIN only | a peer that hangs up sets POLLHUP, and poll then returns immediately forever with no data and no error: an infinite spin that reads as a hang |
| announced with `write()` | SIGPIPE to a departed peer would kill the payload rather than return an error. Now `send(MSG_NOSIGNAL)` |
| dropped a failed sample and reused the stream | the peer may still be sending bytes announced for the failed phase, so a later sample counts them, and the one-link and N-link samples stop being matched pairs |

`tpu/test/linkbench-test.c` drives the shipped code against a peer that hangs up, one that stays silent,
a dead descriptor, and one that answers partially then stalls. Eight cases, all holding; the hangup case
returns in 0 ms where it used to spin, and the partial-response case abandons at repetition 3 with 3
complete pairs.

## The reply CAN be halved on the TPU: the rejection rested on a wrong measurement (2026-09-22)

Two sections above record on-TPU digit recombination as closed, for two reasons. The first was that every
way of separating the stacked halves crashes the compiler. The second was that the alternative -- two
FULLY_CONNECTEDs against one weight tensor -- "emits the weights twice (35.6 -> 71.9 MB on a real
layer)", which would cost far more weight streaming than the reply saves. **The second reason is wrong,
and with it the conclusion.**

First, the crash is narrower than recorded. Probing one operator at a time after a quantised FC:

| second operator | result |
|---|---|
| none | compiles |
| QUANTIZE (elementwise) | compiles |
| ADD with a constant (elementwise) | compiles |
| MUL by a constant (elementwise) | compiles |
| CONCATENATION (appends, changes shape) | **compiles** |
| RESHAPE | INTERNAL crash |
| TRANSPOSE | INTERNAL crash |
| SLICE / SPLIT / STRIDED_SLICE | INTERNAL crash |
| BATCH_MATMUL | INTERNAL crash |

So the plugin sequences operators perfectly well, and it is not shape changes either -- CONCATENATION
changes shape and compiles. What crashes is selecting, permuting, reducing or contracting. The minimal
reproducer is tiny: a 4x4 int8 weight, one row, FC then two SLICEs and an ADD
(`a8w4/minrepro_slice_add.py`).

Second, and decisively: **two FCs do NOT emit the weights twice.**

| graph (1536x6144 int8 weights, 9.51 MB authored) | compiled |
|---|---|
| one FC, stacked rows (ships today) | 9.67 MB |
| two FCs naming the SAME weight tensor | 9.68 MB |
| **two FCs, two weight TENSORS on one BUFFER, scales differing by 256** | **9.68 MB** |

1.00x. The compiler shares the constant. Confirmed at 1024x1024, 1536x6144 and 6144x1536.

The middle row is a trap worth naming, because it is the obvious construction and it is WRONG: two FCs
sharing one weight tensor compute `W.(hi + lo)`, not `W.(256.hi + lo)`. Quantisation scales divide out of
the ADD -- a tensor's represented value is `int * scale`, so making the scale larger makes the integer
correspondingly smaller and the product is unchanged. The factor of 256 cannot come from scales. It has
to live in the weights, which is why the third row uses two weight TENSORS, holding the same int8 data at
scales differing by 256, pointing at one buffer. That is the construction that both expresses the
arithmetic and costs one copy of the weights.

**What it buys.** The reply carries one int16 row per logical row instead of two: 3432 -> 1716 KB per
token, and total exchange bytes 4471 -> 2755 (-38 %). At the exchange's measured 26.5 MB/s marginal rate
that is about 65 ms per token. It should also be slightly more accurate, because the recombination
happens before quantisation rather than after: the `hi` digit's rounding is no longer multiplied by 256
on the way out, which is the term that dominates the current 1.755 LSB bound.

**What is NOT yet established.** That it computes the right numbers on the silicon. A compiled size is
not a result: these graphs have been built and compiled, never dispatched. The clipping behaviour also
changes and needs checking -- `hi` is now quantised against the full output scale rather than with the
current 102.4 headroom, so it should reach the rail more readily, and the existing repair path has to be
shown to cover it. Until a graph runs on the device and its output is compared against the reference,
this is a compiler result and nothing more.

### What now blocks it: the worker binds exactly one input

The construction needs hi and lo as two input tensors, because every way of separating them inside the
graph crashes the compiler -- including slicing the INPUT, which was worth testing separately since all
the earlier crashes were ops on a FULLY_CONNECTED's output. It crashes too.

Two inputs is a problem only because of who owns the worker. `tpu_worker_jni.cc` is our code, but it is
built in the LiteRT tree rather than here, shipped as a prebuilt `libanchortpu.so`, and it refuses
multi-input signatures outright:

    if (!in || !out || !names || in->size() != 1) { LOGI("L%d %s: buffers", ...); delete w; return 0; }

and then writes the whole received blob into `s.in[0]` alone. So the change is small and specific:
accept `in->size() == 2`, and split the received blob across `in[0]` and `in[1]` at the halfway point,
which is exactly where hi ends and lo begins on the wire today. Roughly ten lines.

The cost is not the ten lines. `libanchortpu.so` is a bazel target against `@litert`, the build tree is
12 GB, and bazel is not installed on this machine. After that the graph builder changes, all 35 blocks
recompile through the AOT compiler (about an hour), the VM-side payload stops recombining and expects one
reply row per logical row, and about 1.8 GB restages to the phone.

**And it is worth being clear about the size of the prize.** Halving the reply is worth about 65 ms per
token against a measured 893, so roughly 1.13 -> 1.21 tok/s, and it moves the per-row asymptote from
about 3.1 to about 4.5 tok/s. It is the first thing found in this campaign that moves a FLOOR rather than
closing distance to one. It does not approach 15 tok/s, because TPU compute alone is 273 ms against a
67 ms budget, and nothing about this touches that.

## The cleanest form of the impossibility, for the record (2026-09-22)

Three floors have been quoted against the 67 ms/token that 15 tok/s requires, and two of them are about
the accelerator. This one is not, and it is the one to keep, because it survives any improvement to the
TPU, the bytes, the masking or the VM.

    exchanges per token   = 4 per block x 35 blocks = 140
    round-trip latency    = 0.74 ms, measured
    latency alone         = 140 x 0.74 = 104 ms per token

**104 ms > 67 ms.** With a free accelerator, zero bytes on the wire and zero work in the VM, the shipped
model cannot reach 15 tok/s through this boundary.

Each input to that is load-bearing and each has been checked rather than assumed:

* **4 exchanges per block** is the security contract, not an implementation. A modular mask survives an
  RMSNorm by deferral, and provably does not survive GELU-gating or attention. Merging `o` into `gu`
  would need the TPU to apply a normalisation scale that depends on the unmasked value it is about to
  produce, which is circular. Merging across attention would need the mask to survive a softmax.
* **0.74 ms** is the guest/host wake, and BOTH attempts to remove it made things worse: spinning on the
  reply took decode from 0.91 to 0.70 tok/s because the vCPUs and the worker share six big cores with no
  spare one, and boosting the worker left the link unchanged at 4.28 ms because the residual is the
  GUEST's wake, not the worker's.
* **35 blocks** is the model. Fewer blocks is a different product, not a faster one.

Turning it around: latency alone allows at most 22 blocks even if everything else were free, and the
measured per-block cost of 24.2 ms allows 1.2. The gap between those two numbers is the whole campaign.

So the answer to "is there a viable option" is: not through a masked worker outside the boundary, at any
model size worth serving. The accelerator has to be INSIDE the pVM, which is a platform gate --
`Assignable devices: []`, `VFIO-platform is not supported`, kernel 6.6.118 — and re-checked on the device
today rather than recalled.

## Correction: the reply is NOT demonstrably halvable, and my probe was not representative (2026-09-22)

The section above claims "the reply CAN be halved on the TPU" on the strength of a probe. Building the
construction into a REAL layer refutes it, and the error in the probe is worth recording because it is
the same shape as the others found tonight.

**What happened.** `tpu/make_graphs.py --digit-combine` now emits the construction: hi and lo as two int8
inputs, two FULLY_CONNECTEDs whose weight tensors share one buffer at scales differing by 256, and an
elementwise ADD. Generated for block 0 of the shipped model it authors at 35.8 MB and then **fails to
compile**, with the same `INTERNAL` error as everything else.

**Why the probe said otherwise.** `probe_shared_weight.py` filled its weights with ZEROS. Identical
zero-filled buffers deduplicate trivially, so "the compiler shares the constant" was partly a statement
about the test data. Re-run with random weights, a structural probe that mirrors the real graph
(`probe_combine_structure.py`) crashes at EVERY size tried, including one projection at 512x512, with or
without signature definitions -- while `probe_shared_weight.py` at the same size still compiles. Two of
my own probes now disagree about the same construction, which means at least one is not representative of
the real graph, and the real graph is the one that matters.

**What survives.** The original reason for rejecting the recombination -- "two FCs emit the weights twice,
35.6 -> 71.9 MB" -- is still wrong. With RANDOM weights at 512x512, a graph with two SEPARATE weight
buffers holding the same data authors at 0.54 MB and compiles to 0.50 MB, the same as the single FC: the
compiler deduplicates by CONTENT. So weight duplication is not what blocks this.

**What does not survive.** That the reply can be halved. It cannot, today, because the construction does
not compile at real scale, and the reason is not yet identified. The simulated accuracy gain (1.000/0.409
max/rms output LSB against 1.254/0.722 for the shipped design) is a property of arithmetic that no
accelerator will run, so it is not a result either.

The `--digit-combine` flag stays in `make_graphs.py`, with this noted, because the bug report needs a
real-layer reproducer and that is now what it is.

## The compiler is not deterministic here, and I never ran the control (2026-09-22)

Both of the last two sections are unsafe, and so is the correction between them. The reason is one I
should have established before the first compile rather than after the twentieth.

**The control fails.** `graphs-h4-ds/L0.tflite` is the shipped, in-production stacked layer. It compiled
successfully on 2026-09-19 -- the output and its log are on disk, ending `Serialized a model of size
36402704 bytes`. Recompiling that same unmodified file today fails with the same `INTERNAL` error as
everything else, three attempts in a row.

**And it degrades within a session.** `cs_1proj.tflite`, a 0.28 MB probe, compiled successfully a few
minutes before it began failing on four consecutive attempts with no input change. So the tool is not
deterministic in this environment, and a single compile attempt is not evidence either way.

Ruled out as causes: disk (13 GB free on /tmp, and pointing TMPDIR at a 1.2 TB filesystem changes
nothing), `noexec` (it is not set), process limits (nproc 510691, nofile 524288), leftover processes
(none), and memory (78 GB available, though 46 GB of swap is in use). The failing run stops before the
`SubProcess::ForkAndExec` that the successful log shows, so it never reaches the worker that earlier
crashes DID reach -- those produced `/tmp/compiler_worker_*` maps and build ids, and today's failures
produce nothing.

**What this costs.** Every compile result tonight is now uninterpretable in one direction or the other:

* The operator table (`QUANTIZE`/`ADD`/`MUL`/`CONCATENATION` compile, `SLICE`/`SPLIT`/`RESHAPE`/
  `TRANSPOSE`/`BATCH_MATMUL` crash) was gathered without a control. The successes are still real -- a
  compile that produced output produced output. The CRASHES are not safe, because the control crashes too.
* The claim that the reply can be halved is unproven.
* **The correction that said it cannot is equally unproven**, because it rested on the real layer failing
  to compile, and the known-good layer fails identically.

So the question is OPEN, not closed in either direction, and it stays that way until the compiler is
working and a known-good file compiles alongside whatever is being tested.

**The rule that follows**, which is the useful part: compile a file that is known to work in the same
session, immediately before drawing any conclusion from a compile that fails. `a8w4/probe_*.py` should
carry that control rather than leaving it to whoever runs them, and until they do, treat their CRASH rows
as unverified.

### Diagnosing it: what the compiler failure is NOT (2026-09-22)

The failure is sharper than "flaky", and worth recording so the next person does not repeat the search.

**It fails in 21 ms on a 624-byte single-FC graph, 0 for 5**, having compiled the same inputs earlier the
same evening. The log gets as far as loading the plugin, partitioning the model and printing
`Compiling model...`, then returns `INTERNAL` with empty debug info. It never creates its `/tmp` working
directory and never extracts the 156 MB worker binary it forks (earlier runs left
`/tmp/compiler_worker_*` and `/tmp/compiler_*/input_model.tflite`; today's leave nothing), so it dies
before doing any work.

Ruled out, each checked rather than assumed:

| candidate | checked |
|---|---|
| memory / over-commit | Committed_AS 156.9 -> 116.1 GB against a 146.4 GB limit, still fails. **This was my first diagnosis and it was wrong** |
| disk | 13 GB free on /tmp; TMPDIR on a 1.2 TB filesystem changes nothing |
| tmpfs inodes | 11 % of 1048576 used; `mkdtemp` in /tmp works |
| `noexec` | /tmp and /vm are both plain `rw`; the bundled RISC-V clang runs and prints its version |
| fds / processes / IPC | 12899 open of no limit, 680 pids of 4194304, 3 shm segments |
| SDK damage from the 09-20 move to /vm | 2323 files, 970 MB, none zero-length, all executable bits intact |
| a beta licence expiry | no licence or token files; no expiry strings in either .so |
| a mid-session system upgrade | no pacman upgrades on 09-21 or 09-22 |

So: environmental, reproducible, and unexplained. The honest label is that the toolchain is down rather
than that the graphs are wrong, and anything depending on a compile is parked until a known-good file
compiles again.

**Two wrong diagnoses on the way to that**, both of the same kind: a plausible correlation asserted as a
cause. The first was that a probe's `-128` weights crashed the compiler (they did, but symmetric weights
compile, and `make_graphs.py` already clips to [-127, 127], so it never applied to the real layer). The
second was over-commit, which I believed firmly enough to tell a colleague their benchmark was starving
my work. It was not. In both cases the check that refuted it was one command.

## The backend deviation, MEASURED on the deployed kernel (2026-09-22)

`tpu/test/error_bound.py` derives the decode error under an IDEAL backend and says so in its own header;
it then quotes a conditional figure for "if the backend deviates by up to one LSB". An audit was right
that this is a simulation and not a measurement of the silicon. The payload has carried the measurement
all along behind `kVerifyKernel`, compiled out. Turned on, it recomputes one element per projection per
exchange with the reference's own expression, under the same bundle, weights and quantisation, and
compares it against what the TPU returned -- on real activations, during real decode.

| run | digit comparisons | paired samples | disagreements | worst per digit | worst in output LSB |
|---|---|---|---|---|---|
| 32-token prose | 2870 | 1435 | 0 | -- | 0.000 |
| 128-token code | 52480 | 26240 | 4 | 1 | **2.500** |
| 128-token prose | 20910 | 10455 | 1 | 1 | 0.010 |
| 128-token code (repeat) | 52480 | 26240 | 2 | 1 | 0.010 |

**About 129k digit comparisons, 7 disagreements, every one at most one digit-scale LSB.** The worst
contribution to a decoded value was 2.500 output LSB, which is one such disagreement landing on the `hi`
digit and being multiplied by 256/102.4 when the VM recombines -- the amplification that digit-split
costs, appearing in a measurement rather than an argument. A disagreement on `lo` is worth a hundredth of
that, which is the 0.010 rows.

**What this is and is not.** It is observed evidence on sampled elements of the deployed kernel: about
one element in 18,000 disagrees, by one LSB. It is NOT a universal bound on backend error -- one element
per projection per exchange is a small sample of the products the lane computes, and nothing here
constrains the elements that were not sampled. What it does do is replace an assumption: the ideal-backend
premise behind the 1.755 LSB figure is supported by measurement, and the conditional 4.26 figure now has
a measured worst case of 2.500 sitting under it rather than nothing at all.

**Two defects in the instrument itself**, both found by audit, both of the family this file keeps
recording:

* The RMS was understated by exactly sqrt(2). `ver_n` counts TWO digit comparisons per sampled output
  while the combined-output error is accumulated ONCE, and the reporter divided the second by the first.
  Every run so far produced all-zero errors, and zero over the wrong divisor is still zero, so no
  measurement that existed could have caught it. The divisor now lives in `tpu_ver_lsb_rms()` where a
  test can reach it, and `tpu/test/verify-rms-test.c` drives it with 2.5, 0.0 and 1.5.
* The paired-sample count is now reported alongside the digit count, because "n=52480" and "26240
  samples" are different quantities and the line previously showed only the first.

### A lead on the compiler failure, tested and refuted (2026-09-22)

`LD_DEBUG=libs` on the failing run names a precondition directly, which is what a colleague predicted the
symptom shape would produce:

    libLiteRtCompilerPlugin_google_tensor.so: symbol lookup error:
    undefined symbol: LiteRtGetCompiledResultHandle (fatal)

That symbol is defined NOWHERE in the SDK except `libLiteRtCompilerPlugin_Qualcomm.so` -- a different
vendor's plugin -- and `apply_plugin_main` exports no `LiteRt*` symbols dynamically at all. It is the same
failure mode as the `sh_par_for` bug fixed in `build.sh` the same evening: a shared object that resolves
fine at link time and dies when the symbol is actually needed.

**It is not the cause.** `LD_PRELOAD`ing the Qualcomm plugin so the symbol resolves changes nothing: the
compile still fails, still produces no output. The loader also reports `LiteRtRegisterGpuAccelerator` as
an identical "(fatal)" lookup failure, and the SUCCESSFUL log from 2026-09-19 shows the GPU accelerator
failing to register in exactly that way -- so these markers are normal noise on this stack, not the
failure.

Recorded because it was a good lead, reached by a method worth reusing, and because asserting it without
the `LD_PRELOAD` test would have been the third wrong diagnosis of the night rather than the first
refuted one. CWD does not matter either (five directories, all fail identically).

## Resolved: stale /tmp state broke the compiler, and the ORIGINAL rejection was right (2026-09-22)

**The compiler failure was stale state, as a colleague predicted.** Six orphaned items from 2026-09-16 --
three `/tmp/compiler_*` working directories and three 156 MB `/tmp/compiler_worker_*` binaries left behind
by crashed runs -- were enough to make every compile fail in 21 ms before creating its own working
directory. Moving them aside restored it immediately:

| | before | after |
|---|---|---|
| 624-byte single-FC probe | 0 bytes | 226560 |
| the probe that failed 5/5 | 0 bytes | 497488 |
| **shipped known-good L0** | 0 bytes | **36402704, byte-identical to the 2026-09-19 output** |

That last row is the control reproducing its own historical result exactly, which is as clean a
confirmation as this gets. The stale files are kept at `~/.cache/stale-compiler-tmp` rather than deleted.
The diagnostic that found it was `LD_DEBUG`, suggested by the same colleague; my own list had covered
resources thoroughly and startup state not at all.

**And with a working compiler, the recombination question answers itself -- against the idea.**

| graph | compiled |
|---|---|
| shipped stacked digit-split L0 | 36,402,704 |
| **the recombining L0 (`--digit-combine`)** | **71,906,880** |

**1.97x. The weights ARE emitted twice**, which is precisely what the original note in
`tpu/make_graphs.py` said -- "35.6 MB authored -> 71.9 MB compiled" -- reproduced here to within the
authoring difference. Doubling the streamed weights adds about 273 ms per token to `tpu-run`, to save
about 65 ms of reply bytes. Strictly worse, by a factor of four.

**So the sequence of claims, in order, and which was right:**

1. The original note: two FCs double the weights, so recombination costs more than it saves. **Correct.**
2. My refutation of it, from `probe_shared_weight.py`: they share the buffer, 1.00x. **Wrong** -- the
   probe used ZERO weights, which deduplicate trivially, and small shapes where fixed overhead swamps the
   difference. With random weights at 512x512 even two SEPARATE buffers compiled to the same size.
3. My retraction of the refutation, from the real layer failing to compile: right conclusion, **wrong
   evidence** -- the compiler was down and the known-good control failed identically.
4. This: the real layer compiles, at 1.97x. Right conclusion, and now for the right reason.

The lesson is the one the whole evening keeps producing: a probe is a model of the thing, and a model
that differs from the artifact in a detail you did not think mattered -- zero weights, a small shape --
answers a different question convincingly. The real layer was always available to build; I built a probe
instead, three times, before building it.

### Re-verified with a control, and the lever is NOT dead -- it is blocked upstream (2026-09-22)

Every operator result had been gathered while the toolchain was down, so all of it was re-run with the
shipped known-good L0 compiling in the same session as an explicit control. The control compiles
(36402704 bytes) and the table reproduces exactly: `QUANTIZE`, `ADD`, `MUL` and `CONCATENATION` compile
after a FULLY_CONNECTED; `RESHAPE`, `TRANSPOSE`, `SLICE`, `SPLIT`, `STRIDED_SLICE` and `BATCH_MATMUL`
crash with `INTERNAL`. The 4x4 minimal reproducer still crashes while its no-combine twin compiles. The
probes now run that control themselves and refuse to report anything if it fails.

**And this corrects what the 1.97x result seemed to settle.** There are TWO ways to recombine, and they
fail for different reasons:

| construction | inputs | weights | status |
|---|---|---|---|
| two FCs, hi and lo as separate inputs | 2 | **emitted twice: 36.4 -> 71.9 MB** | compiles, and is not worth it |
| **one FC over stacked rows, then SLICE the output and ADD** | 1 | **once** | **crashes the compiler** |

The second is the one that matters. One FULLY_CONNECTED means the weights stream once, so it would halve
the reply -- 3432 -> 1716 KB per token, about 65 ms -- at no cost in `tpu-run`, and it needs no change to
the app-side worker either, since the graph keeps a single input. It is blocked by nothing except the
compiler crash, for which there is now a 4x4 reproducer.

So the honest status of this lever is not "closed" but "blocked on an upstream defect we can report". It
is worth about 65 ms per token and moves the per-row asymptote from about 3.1 to about 4.5 tok/s. It does
not approach 15 tok/s -- TPU compute alone is 273 ms against a 67 ms budget, and the 140 round trips cost
104 ms of pure latency before any of it -- but it is the one improvement still available, and it is one
bug fix away rather than an architecture away.

### Why the probe and the artifact disagreed: per-channel scales (2026-09-22)

The probe said two FCs share one copy of the weights; the real layer said they cost two. With a working
compiler and a control in the session, the trigger is now isolated, and it is the last detail I would
have guessed:

| two FCs, one weight buffer, scales differing by 256 | compiled | against the raw weights |
|---|---|---|
| **constant** per-channel scale (`[0.001] * n_out`) | 9.68 MB | 1.00x |
| **varying** per-channel scale (a real distribution) | **19.16 MB** | **2.03x** |

A real model's per-channel weight scales always vary -- they come from the quantiser. With constant
scales the compiler evidently canonicalises the two tensors to one; with varying scales it materialises
two requantised copies. So the probe was answering a question about a model that does not exist, and the
real layer's 1.97x is the true number. It now reproduces in a probe as 2.03x.

**This confirms the original rejection completely.** Two FULLY_CONNECTEDs over separate inputs cost two
copies of the weights for any real model, so that construction is dead. What remains is the single-input
form -- one FC over stacked rows, then SLICE the output and ADD -- which uses ONE weight tensor and so
has no duplication to suffer, and which crashes the compiler. That is the lever, and it is upstream.

Three probes in a row on this question disagreed with the artifact, each for a different reason I had not
thought mattered: zero weights (they deduplicate), `-128` weights (asymmetric int8 crashes the compiler
where the real quantiser clips to +-127), and now constant per-channel scales. The artifact was buildable
every time.

## The Google NPU comparison: the runner builds, the packages do not match it (2026-09-22)

The task-level comparison against Google's own NPU lane has been outstanding since the quality work, and
the blocker was always "no runner". That blocker is gone, and a different one is now in its place.

**The runner builds.** `//runtime/engine:litert_lm_main` and `litert_lm_advanced_main` compile for
arm64 from the LiteRT-LM tree. The earlier failure -- "Unable to find a CC toolchain using toolchain
resolution" -- was simply `ANDROID_NDK_HOME` being unset; the tree has an `android_ndk_env.bzl` whose
entire job is to check for it. Two binaries, 33.5 MB, plus `libGemmaModelConstraintProvider.so` from the
tree's `prebuilt/android_arm64`, run on the phone and print their flags.

**The packages on the device do not match it.** All four `.litertlm` files fail, in two distinct ways:

| package | backend | failure |
|---|---|---|
| `gemma-x`, `gemma-l0`, `gemma-tiny` | npu | `Invalid begin and size` -- node 323/324, a SLICE, fails to invoke |
| `enclave-tensor-npu-1/model` | npu | `Node number 1 (DELEGATE) failed to prepare` / `Failed to allocate tensors` |
| `enclave-tensor-npu-1/model` | cpu | `Input tensor not found` (it is an NPU-only package) |

`prefill_chunk_size` at 128 and 256 changes nothing for the last one. These packages were built against
runtime v35 (see the multi-context note); what built here is whatever this tree is at now, and a decoder
graph whose SLICE bounds no longer line up is what a version skew looks like from the outside.

So the comparison needs a matching pair, which is one of: the v35 runtime sources, a package rebuilt
against this tree (the ODC bucket build, which is not cheap), or a prebuilt runner of the right vintage.
None of those is a phone measurement, and none of them changes throughput -- this is quality evidence.
It stays outstanding, with the blocker now named precisely rather than as "no runner".

## What a TPU invocation actually costs, measured again (2026-09-22)

An audit pointed out that the runtime penalty I attributed to the two-FC recombination was a MODEL --
the 1.97x compiled size is measured, the time it costs was not. So it is measured now.
`a8w4/sweep_dispatch.py` builds eight FULLY_CONNECTEDs differing only in weight count, spanning 128x,
and the worker benches all eight in one run. All seven graphs were AOT-compiled with the shipped
known-good layer compiling as a control in the same session (36402704 bytes).

| signature | compiled weights | min ms/Run | mean |
|---|---|---|---|
| L0.qkv | 0.39 MB | 0.37 | 1.04 |
| L0.o | 0.79 | 0.73 | 1.06 |
| L0.gu | 1.57 | 0.56 | 1.27 |
| L0.down | 3.15 | 0.79 | 1.76 |
| L6.qkv | 6.29 | 0.79 | 1.88 |
| L6.o | 12.58 | 1.68 | 2.57 |
| L6.gu | 25.17 | 3.23 | 3.62 |
| L6.down | 50.33 | 4.51 | 5.32 |

    min  : 0.520 ms fixed + 0.0848 ms/MB   (largest residual 0.58 ms)
    mean : 1.253 ms fixed + 0.0847 ms/MB   (largest residual 0.26 ms)

**The slope is the same to three digits either way**, which is the part worth trusting: a streamed
megabyte costs 0.085 ms whatever the intercept argument is. That settles the question the script's own
header posed -- whether bytes or invocations dominate -- in favour of BYTES at this model's size: the
shipped lane streams about 1872 MB of compiled graphs per token, which is 159 ms, against 140 x 0.52 =
73 ms of fixed invocation cost. Together 232 ms against the 273 ms of `tpu-run` actually measured during
decode, so the fit accounts for 85 % of it.

It also revises the earlier figure. This file has been quoting 0.637 ms + 0.0677 ms/MB; the intercept is
lower and the slope higher than that.

### And it corrects my own claim about the recombination, by a factor of seven

I wrote that doubling the compiled graph "adds about 273 ms per token to `tpu-run`, to save about 65 ms
of reply bytes. Strictly worse, by a factor of four." That assumed `tpu-run` doubles. It does not, because
only part of a Run is bytes:

| | compiled per signature | ms/exchange |
|---|---|---|
| shipped stacked | 9.10 MB | 1.29 |
| two-FC combine | 17.98 MB | 2.04 |
| **difference** | | **0.75 ms/exchange = 105 ms/token** |

Against a reply saving of about 65 ms, the two-FC construction is worse by about **40 ms per token**, not
by 273. The conclusion is unchanged -- it is still a net loss and still should not be built -- but the
margin is small enough that it was never the rout I described, and anyone reading the old number would
have dismissed the construction for the wrong reason. The audit was right to call it a model.

## Attacking the last assumption: a shorter schedule is constructible, and it is WORSE (2026-09-22)

The impossibility argument rests on 140 exchanges per token, which rests on 4 per block, which rests on
the security contract. That was argued rather than measured, and it is the one input I had not attacked.
So: it is wrong, a 3-exchange schedule does exist, and building it would make things worse.

**The construction.** An RMSNorm's scale is a per-token scalar and can be deferred past a matmul, which
this file already records as verified. Writing `x` for the block input, `g` for the norm gain and `c` for
the deferred scale:

    gu = c * [ W_gu.(x*g)  +  (W_gu . diag(g) . W_o) . attn ]

The first term depends only on `x`, which is known at block start, so it rides the qkv exchange. The
second folds `o` into `gu` as ONE precomputed matrix. That is 3 exchanges per block, not 4 -- qkv+gu_x,
then the composed term, then down -- with no mask ever crossing a nonlinearity. Security is unchanged:
every operand is still a masked row and every reply is still a masked product.

**And it costs more than it saves**, using only numbers measured on this phone (0.0848 ms/MB, 0.520 ms
per invocation, 0.74 ms of round-trip latency):

| | params/block | MB/token | weights | invocation | latency | total |
|---|---|---|---|---|---|---|
| 4 exchanges (today) | 34.6M | 1210 | 103 ms | 73 | 104 | **279 ms** |
| 3 exchanges (merged) | 56.6M | 1980 | 168 ms | 55 | 78 | **300 ms** |

The composed `W_gu . diag(g) . W_o` is [12288, 2048] where `W_o` alone was [1536, 2048], so the block's
weights go up 1.64x. Saving 35 round trips buys 18 ms of invocation and 26 ms of latency; the extra
weights cost 65. Net 21 ms worse per token.

**So fewer round trips is the wrong lever, and this is the useful part.** The binding term is weight
streaming, at 0.085 ms per megabyte measured. Every merge that removes an exchange does it by composing
two weight matrices into a bigger one, so every merge moves cost from the cheap term to the expensive
one. The only thing that reduces weight streaming is fewer or smaller weights -- a smaller model -- which
is a different product rather than a faster path to this one.

That closes the last assumption in the argument. 15 tok/s is 67 ms per token; weight streaming alone is
about 103 ms at the shipped model size, and no scheduling change reduces it.

## Correcting my own framing: TPU compute was never the biggest term (2026-09-22)

With 0.0848 ms/MB, 0.520 ms per invocation and 0.74 ms of latency all measured on this phone, the 893 ms
token decomposes as:

| term | ms/token | share |
|---|---|---|
| weight streaming (1872 MB compiled x 0.0848) | 159 | 18 % |
| invocation floor (140 x 0.520) | 73 | 8 % |
| round-trip latency (140 x 0.74) | 104 | 12 % |
| **everything else** | **558** | **62 %** |

I have been calling TPU compute the binding floor all session. It is not. TPU compute is weights plus
invocation, 232 ms, which agrees with the 273 ms of `tpu-run` the worker reports. The larger half of the
token is elsewhere, and breaking it down against the per-exchange counters: reply bytes across the
protected-VM boundary about 208 ms, the VM's own mask/unmask/correction about 104, worker I/O about 65,
and the ops the VM does not offload at all -- attention, norms, sampling, the lm_head -- about 139.

**So the biggest single reducible term is the reply, at about 208 ms**, which is exactly what halving it
would address. That makes the compiler bug the highest-value open item rather than a curiosity: it blocks
the one construction (one FC, SLICE the output, ADD) that halves the reply without adding weights.

### What model size would clear 15 tok/s, on measured constants

Scaling the per-block terms and holding the measured per-exchange costs:

| model | int8 params | compiled MB | weight ms | ceiling |
|---|---|---|---|---|
| Gemma 4 E2B (shipped) | 1210M | 1872 | 159 | 1.12 tok/s |
| Gemma-3-1B class, 26 blocks | 759M | 1174 | 100 | 1.55 |
| Gemma-3-270M class, 18 blocks | 270M | 418 | 35 | 2.42 |
| 125M class, 12 blocks | 125M | 193 | 16 | 3.73 |
| 60M class, 8 blocks | 60M | 93 | 8 | 5.69 |

**Nothing in that table reaches 15**, and the reason is the 558 ms term: it is about 16 ms per block, or
4 ms per exchange, of VM work and transport that does not shrink with the weights. 15 tok/s needs the
whole token in 67 ms, which at 4 ms per exchange allows about 16 exchanges -- four transformer blocks.

That is the honest shape of the answer. It is not "the accelerator is too slow" and it is not "the model
is too big": it is that each masked exchange costs about 4 ms of VM work and boundary crossing before the
TPU does anything, and a useful model needs more than sixteen of them.

## The worker's priority is right, and the VM's slowness is not contention with it (2026-09-22)

The 558 ms "everything else" contains about 90-117 ms per token of VM work OUTSIDE the exchanges, which
is more than the CPU-only path spends computing the WHOLE model (69 ms/token) -- and the TPU path's
share is a strict subset of that work, since the projections have left. Something was taking three to
five times longer than it should, and the obvious suspect was the worker holding `nice -19` against the
VM's boosted vCPUs on six big cores with no spare one.

Measured, by making the worker's priority a flag:

| `--ei tpu_prio` | worker thread priority | decode | link |
|---|---|---|---|
| 99 (default) | -19 | **1.21 tok/s** | 4.402 ms |
| 0 | 0 | 1.09 | 4.947 |
| 10 | 10 | 1.03 | 5.256 |

**The opposite of the hypothesis.** Lowering the worker's priority makes everything worse, monotonically,
and `link` grows with it -- the worker needs the boost it has, and giving the VM's vCPUs a larger share
of the cores does not speed the VM's own work enough to pay for the slower exchanges. So the default is
right, and whatever inflates the VM's non-exchange work is not the worker's scheduling priority.

That leaves the inflation unexplained rather than explained, which is the honest state. Candidates not
yet separated: the guest's own scheduling under a protected VM, page-cache pressure from a 1757 MB
evictable bundle, or the non-offloaded ops genuinely costing more in the VM than the same ops cost inside
a plain CPU decode.

### Partial offload needs a matching BUNDLE, not just a worker (2026-09-22)

`--ei tpu_layers N` loads N compiled blocks into the worker, but the VM decides what to offload from the
BUNDLE, which lists all 35 groups. So a partial worker with a full bundle fails the moment the VM asks
for a block the worker never loaded:

    TPU worker: 4 compiled blocks loaded in 357 ms
    VSOCK tpu: the worker link failed waiting for the reply (blk.4 kind 0)
    LOCAL failed: the VM closed the conversation mid-turn

Measuring the marginal cost of an offloaded layer therefore needs bundles built with `--layers 0-(N-1)`,
which is cheap with `--no-graphs` since the compiled graphs are reused. Worth recording because the flag
looks like it controls the split and does not.

## The offload cost per layer, measured directly (2026-09-22)

Every earlier statement about why this path is slow has been an aggregate -- a 893 ms token divided into
terms, each of which I then argued about. This measures the thing itself: hold everything constant and
vary only HOW MANY transformer blocks are offloaded to the TPU, with a bundle built to match each split
(`--layers 0-(N-1)`, `--no-graphs`, reusing the compiled graphs).

| blocks offloaded | exchanges/token | tok/s | ms/token | fit |
|---|---|---|---|---|
| 1 | 4 | **9.55** | 104.7 | 101.9 |
| 4 | 16 | **6.50** | 153.8 | 171.6 |
| 9 | 36 | **3.54** | 282.5 | 287.8 |
| 18 | 72 | **1.88** | 531.9 | 496.9 |
| 35 (shipped) | 140 | **1.14** | 877.2 | 891.9 |

    ms/token = 78.7 + 23.2 x blocks_offloaded          R^2 = 0.9956

**A block costs 23.2 ms on the TPU and 1.98 ms on the VM's own CPU.** (The CPU path computes all 35 in
69 ms at 14.4 tok/s.) That is a **12x tax per block**, linear, with no threshold and no sweet spot: every
block moved to the accelerator makes the token twelve times more expensive than leaving it where it was.

Three things follow, and they replace several looser arguments earlier in this file.

**There is no partial split worth taking.** The curve is monotone, so the fastest configuration that uses
the TPU at all is one block, at 9.55 tok/s -- and one block of thirty-five is not "the TPU executing the
heavy compute".

**15 tok/s is out of reach even at zero offload.** The intercept is 78.7 ms, or 12.7 tok/s, against the
pure CPU path's 69 ms and 14.4 tok/s: merely having the TPU backend loaded and the worker attached costs
about 10 ms per token before a single block is offloaded. Setting 66.7 ms as the target, the fitted line
reaches it at **-0.5 blocks**.

**And it is not the accelerator.** The TPU's own compute is 23.2 ms only in the sense that the round trip
around it is; the worker's `tpu-run` accounts for about 2 ms of that, and the rest is the mask, the
reply, the boundary crossing and the VM's own work. Twelve times is what it costs to ask a question
across a protected-VM boundary rather than compute the answer locally.

### Correcting the previous section: the intercept is now measured, and the claims are narrowed

Three things in the section above were stated more strongly than the evidence supports. All three are
corrected here, and the first is corrected by measurement rather than by hedging.

**1. The zero-offload point was extrapolated. Now it is measured.** A 16-byte bundle -- `ETPUB002`, a
group count of zero, and padding -- loads the backend, attaches the worker and offloads nothing. The
payload accepts it and reports `exchanges: 0`.

| | tok/s | ms/token |
|---|---|---|
| zero offload, backend loaded, worker attached | 14.00 / 12.83 | 71.4 / 77.9 |
| pure CPU path, same prompt | 13.82 / 13.93 | 71.8 / 72.4 |

The measured zero-offload point is **74.5 ms**, against the **78.7 ms** the old fit extrapolated. And the
"about 10 ms idle-backend tax" I claimed is **wrong**: measured it is 2.5 ms, and the two intervals
overlap (71.4-77.9 against 71.8-72.4), so at this sample size it is not distinguishable from noise. There
may be no idle tax at all. Refitting with the measured point: **77.4 + 23.3 ms/block, R^2 = 0.9963.**

**2. The slope is a NET increment, not the TPU's cost.** It is `T - C`: what it costs to REPLACE a CPU
block with an offloaded one. Separating `T` and `C` needs the per-token work that is neither -- the
embeddings, the lm_head, the sampler -- and that is not measured. Writing it `F`:

| assumed fixed work F | CPU block C | TPU block T | ratio |
|---|---|---|---|
| 0 ms (impossible) | 2.13 ms | 25.1 ms | 11.8x |
| 10 ms | 1.84 | 24.8 | 13.4x |
| 20 ms | 1.56 | 24.5 | 15.7x |
| 30 ms | 1.27 | 24.2 | 19.0x |

So "12x" was a point estimate resting on `F = 0`, which is false. The defensible statement is that the
ratio is **at least 11.8x and larger the more fixed work there is**. Relatedly, `69 / 35 = 1.98 ms` is not
the cost of a CPU block; it is the whole CPU token divided by 35, which includes all of `F`.

**3. R^2 = 0.996 over six points describes THIS implementation.** It does not isolate the protected-
boundary cost from the masking, the digit-split reply, the VM's own arithmetic or this worker's design,
and it is not a law about masked offload in general. Nor does it show 15 tok/s is globally unreachable:
it shows that on this phone, with this model, this masking scheme and this worker, the line reaches
66.7 ms below zero blocks. A different scheme with a cheaper per-exchange cost would have a different
slope, and that is the quantity worth attacking.

**What the sweep does establish**, and this part stands: the relationship is linear and monotone over
0-35 blocks, so there is no partial-offload sweet spot in this implementation; and the whole 877 ms token
at 35 blocks is 74.5 ms of everything-else plus 802.7 ms attributable to having moved 35 blocks across
the boundary.

### The Google baseline: the skew is a `.litertlm` FORMAT version, and it is now pinned

The runner built from the local tree fails on every package with `Invalid begin and size` at a SLICE node,
or `DELEGATE failed to prepare`. The cause is now exact rather than "a version skew".

`.litertlm` carries its format version in the first 16 bytes: the magic `LITERTLM`, then two little-endian
u32s. Reading them off the device:

| package | version |
|---|---|
| `gemma-tiny`, `gemma-x`, `gemma-l0`, `enclave-tensor-npu-1/model` | **1.5** |
| upstream `gemma-4-E2B-it_Google_Tensor_G5.litertlm` (3.11 GB, read by HTTP range request, not downloaded) | **1.5** |
| what the local tree BUILDS | **1.6** |

So every published package is 1.5 and the runtime here is 1.6, which is why downloading another package
would not have helped -- a thing worth checking before spending 3 GB of bandwidth on it.

Ruled out on the way: the dispatch library version. `enclave-tensor-npu-1/` carries `v2.1.5.so`,
`v2.1.6.so` and `v2.2.0.so`, all of them `libLiteRtDispatch_GoogleTensor.so`; all three fail identically.

**The fix is a 1.5-era runtime, and upstream history pins it exactly.** The local tree is a shallow
single-commit checkout, but `google-ai-edge/LiteRT-LM` has 2485 commits, and tracing the constant:

    86413518  LITERTLM_MINOR_VERSION 4 -> 5
    c7adc1bf  (2026-07-15)            5 -> 6      <- the boundary
    b801c479  (2026-09-18)            6 -> 7

`c7adc1bf^` is 4698342e, the last commit at 1.5, and a blobless clone checks it out in seconds. Building
`//runtime/engine:litert_lm_main` from there gives a runner that matches every package on the device and
the one Google publishes for this exact SoC.

Two notes for whoever picks this up. `ANDROID_NDK_HOME` must be set or bazel fails with "Unable to find a
CC toolchain", which is the whole job of the tree's `android_ndk_env.bzl`. And the runner needs
`libGemmaModelConstraintProvider.so` from `prebuilt/android_arm64` beside it.

## The Google NPU baseline RUNS (2026-09-22)

It took three independent version matches, none of which the error messages point at.

**1. The runtime.** Every published `.litertlm` is format **1.5**; the local tree builds **1.6**. A 1.6
runtime loads a 1.5 package and then fails inside the decoder with `Invalid begin and size` at a SLICE
node -- which reads like a graph bug and is a format skew. Upstream history pins it: `c7adc1bf` took the
constant 5 -> 6, so `c7adc1bf^` = **4698342e** is the last 1.5 runtime.

**2. The build.** `ANDROID_NDK_HOME` or bazel cannot resolve a CC toolchain. The `prebuilt/android_arm64`
`.so` files are git-lfs pointers -- 133 bytes each, which the linker reports as `unknown directive:
version` -- and there is no `git-lfs` binary here, so they come from the LFS batch API directly. And
`rules_rust` builds a tool whose linker fails with `collect2: cannot find 'ld'` unless the action gets a
sane PATH via `--action_env`.

**3. The dispatch library.** It is loaded from the MODEL's directory, not `LD_LIBRARY_PATH`. Three
versions ship beside the package and only one works with the 1.5 runtime:

| dispatch | result |
|---|---|
| v2.1.5 | aborts |
| **v2.1.6** | **runs** |
| v2.2.0 | `Unsupported dispatch runtime version` |

With all three matched it generates. On "Write a Python function called reverse_string...":

```python
def reverse_string(s):
  """
  Reverses the input string.
  ...
  """
  return s[::-1]
```

which is, to the docstring, what the masked TPU path produced for the same prompt. Prefill measured at
166 tokens/sec.

`host/google-lane-run.sh` runs the same task-scored prompt file through it and captures each reply and
decode rate, so the comparison uses one prompt set and one set of contracts across all three lanes.

## Three lanes, one prompt set, one set of contracts (2026-09-22)

The parity comparison, finally done properly: the same eight task-scored prompts through the masked TPU
lane, the in-VM CPU lane and Google's own NPU lane, scored by the same semantic checks
(`host/quality_checks.py`), on the same phone in the same session.

| lane | task correctness | decode, median | range |
|---|---|---|---|
| masked TPU, inside the pVM | **6/8**, 2 REVIEW | **1.06 tok/s** | 0.96-1.15 |
| in-VM CPU, inside the pVM | **6/8**, 2 REVIEW | **15.37** | 13.75-15.87 |
| Google NPU (its own runtime, package and tokenizer) | **6/8**, 2 REVIEW | **15.73** | 12.39-18.57 |

**All three lanes score identically**, and the two REVIEWs are the same two prompts in every lane -- the
haiku and the sky explanation, neither of which an automatic check can score. The masked path's answers
agree with the CPU path's byte-for-byte on 4 of 8, differing on the rest at a single early token in the
way greedy decoding does.

**What this establishes.** The masking arithmetic does not damage answers: a lane that quantises to int8
digits, adds a modular one-time pad, ships the row to an untrusted accelerator and reconstructs the
product gets the same tasks right as the same model computed in the clear, and as Google's own lane.

**What it does NOT establish.** Eight prompts with short bare answers is a smoke test, not parity. The
three lanes are not the same model: Google's package carries its own quantisation and tokenizer, the
masked lane is a8w8 digit-split over a Q4_0 GGUF, and the CPU lane is that same GGUF dequantised. So
agreement is evidence that none of them is broken, not that they are equivalent. And these rates are
per-turn on short generations, which includes warm-up: the CPU lane measured **13.29 tok/s sustained**
over 315 tokens earlier in this file, below its 15.37 median here.

### And the number that matters for the brief

The in-VM CPU lane medians **15.37 tok/s** on this set, and Google's NPU lane -- the unmasked reference,
on hardware doing exactly what the brief asks an accelerator to do -- medians **15.73**. They are the
same speed within their spreads.

That reframes the target. The bar was never "the TPU is needed to reach 15 tok/s"; the pVM's own CPU
reaches it on this workload, at matching quality, with a STRONGER boundary (the host sees nothing at all
rather than masked activations). What the TPU path buys is the CPU-sparing property the brief actually
wanted -- and measured, it costs 15x MORE phone CPU per token, not less.

## Where the impossibility actually binds, and where it does NOT (2026-09-22)

An audit note on the previous write-up was right: the fit `ms/token = 77.4 + 23.3 x blocks` is an
**implementation-specific** law. Its intercept is extrapolated rather than a measured zero-offload run with
the backend attached, its slope is the NET increment from replacing CPU blocks with offloaded ones rather
than an isolated TPU cost, and R-squared over three points says nothing about other designs. So this
section rebuilds the argument out of terms that do not belong to our transport, and is explicit about the
one case it does not close.

### The bound that survives a perfect transport

**Corrected within the hour: this section first used 0.637 ms + 0.0677 ms/MB, which this file had already
superseded.** The current dispatch fit, measured with the shipped layer compiling as a control in the same
session, is **0.520 ms fixed + 0.0848 ms/MB**, and on that fit BYTES dominate, not invocations -- so the
"invocation-count bound" I reached for was both wrong in its constant and pointed at the smaller term.
Rebuilt on the right ones:

| term | per token | where it comes from |
|---|---|---|
| invocation fixed | 140 x 0.520 = **72.8 ms** | the dispatch sweep's intercept, min fit (the most favourable reading) |
| compiled graph bytes | 1872 MB x 0.0848 = **158.7 ms** | the lane streams its whole bundle once per token |
| | **231.5 ms/token = 4.32 tok/s** | with a zero-latency transport and free masking |

Neither term is ours. The intercept and the slope are Google's driver on Google's silicon, and the 1872 MB
is what the shipped graphs compile to. Set our entire transport and our entire masking scheme to zero and
the lane is still 4.32 tok/s.

### What a redesigned schedule can still do to that floor, and how far it gets

A schedule cannot make a graph stream faster, but it can change two things, and both are worth stating
because neither is closed by the numbers above.

**Fewer entries per block.** Two linear runs per block instead of four halves only the smaller term:
195.1 ms/token, 5.12 tok/s. Not enough to matter, and it needs a parallel-attention model.

**More committed tokens per pass.** This is the real one. The whole 231.5 ms buys one pass, so speculation
amortises ALL of it over however many tokens a pass commits:

| accepted tokens/step | floor | |
|---|---|---|
| 1.00 | 231.5 ms | 4.32 tok/s |
| 1.55 | 149.4 ms | 6.69 tok/s | measured on this lane |
| 3.20 | 72.4 ms | 13.82 tok/s | best acceptance ever measured here |
| **3.47** | **66.7 ms** | **15.0 tok/s** | what the bar would require |

So the honest statement is not that every redesigned schedule is impossible. It is this: **a schedule
would have to commit 3.47 tokens per pass, beating the best acceptance this lane has ever reached, AND be
given a free transport AND free masking, merely to touch 15 tok/s.** The measured transport is 706 ms per
token and the measured masking 113 ms; the 3.20-token configuration was measured SLOWER end to end (1.37
-> 0.93 tok/s) because enlarging the pad bank evicted the bundle from a VM with 1900 MiB. Three
independent things each have to go to a value never observed, simultaneously.

That is a bound, not a proof of impossibility, and it is the strongest honest form of one I can give.
What would break it is not a cleverer schedule; it is halving the 1872 MB, which is the dominant term. The
one lever that does that -- int4 weights -- is rejected above on accuracy (18.1x the int8 weight error,
because quantised FULLY_CONNECTED carries per-output-channel scales and nothing per input group).

### The other floor: the part that never crosses at all

Fitting the three-point offload sweep on what the exchange counters do NOT account for:

| offloaded blocks | exchanges/token | unaccounted ms/token |
|---|---|---|
| 1 | 4 | 76.4 |
| 9 | 36 | 90.5 |
| 35 | 140 | 123.7 |

    fit: 76.4 ms/token + 0.341 ms/exchange

The per-exchange term settles an open question: the residual GROWS with exchange count, so the ~110 ms
once filed as unexplained VM slowness is **uncounted per-exchange overhead**, about 0.34 ms of it, not the
VM being mysteriously slow. The 76.4 ms/token intercept is NOT explained and I am not going to pretend it
is: the CPU-only lane runs the entire model, LM head and sampling included, in 65 ms/token, so 76 ms of
irreducible non-block work is inconsistent with the same VM's own measurement. It is more likely
offload-path bookkeeping or idle-clock behaviour. Flagged as a lead, not a result.

### The platform gate is a missing API, not a missing kernel -- checked in AOSP today

This is a correction to how the gate has been recorded. It has been written down as a kernel/hardware
limit ("6.6 pKVM can't assign; QPR2 = 6.12 + VFIO"), which implies an OTA would open it. That is wrong.

Checked on this device (mustang, Pixel 10 Pro XL, CP2A.260805.005, kernel 6.6.118-android15) today:

    /vendor/etc/avf/                      does not exist -- the platform declares nothing assignable
    CONFIG_VFIO                           is not set
    /dev/edgetpu-soc, /dev/edgetpu-limited  present, both u:object_r:edgetpu_device:s0

Checked in AOSP source today, on `android17-release` AND on `main`:

    libs/framework-virtualization/.../VirtualMachineConfig.java
      config.devices       = AssignedDevices.devices(EMPTY_STRING_ARRAY);
      customConfig.devices = EMPTY_STRING_ARRAY;

Unconditional, on both branches, with **no setter anywhere in the class**. An app-launched pVM cannot
request a device through the AVF framework API at any Android version currently in the tree, whatever the
kernel underneath does. The only route is a direct AIDL client to virtualizationservice holding
`USE_CUSTOM_VIRTUAL_MACHINE`, which is `signature|development` -- grantable by adb on a developer's phone,
never on a stranger's stock one, which is the stated target. AVF's docs agree: "We don't support client
API yet in Android V", and assignability is declared by the vendor in `/vendor/etc/avf/assignable_devices.xml`.

Android 17 QPR2 Beta does ship kernel **6.12.81** for this exact device (CP41.260814.003.B1), so the kernel
gate is moving. The framework gate is not, and it is the binding one. That reorders the work: no amount of
waiting for an OTA helps a third-party app, and the open question on google-ai-edge/LiteRT#10081 (filed
2026-09-19, assigned, still unanswered) is the critical path rather than a side enquiry.

### So, the search

One TPU invocation per token is what Google's own NPU lane does, and it gets 15.7 tok/s on the same phone
with the same prompt set. Masked offload cannot get there because it must enter the accelerator once per
linear run, and the only way to enter once per token is to put the whole graph inside the trust boundary.
That is not a performance problem any longer. It is one missing platform API.

## The two arms were never matched for RATE, and the prefill claim has no support (2026-09-22)

While waiting on the 24-prompt run I checked a claim this file has been carrying since 2026-09-19 --
"It remains the right tool for PREFILL, where one invocation amortises over 128 rows" -- against the
logs already on disk. It does not survive, and neither does the harness that would have tested it.

**What the logs say.** Across the seven rows completed so far, prefill on the masked arm is SLOWER than
on the CPU arm, on every prompt:

| row | prefill tokens | masked TPU tok/s | in-VM CPU tok/s | ratio |
|---|---|---|---|---|
| 01 | 23 | 41.81 | 97.77 | 2.34x |
| 02 | 25 | 42.43 | 107.74 | 2.54x |
| 03 | 25 | 40.58 | 109.38 | 2.70x |
| 04 | 26 | 40.49 | 110.44 | 2.73x |
| 05 | 28 | 51.49 | 115.27 | 2.24x |
| 06 | 28 | 51.44 | 108.90 | 2.12x |
| 07 | 16 | 45.04 | 99.54 | 2.21x |

And the amortisation argument does not describe what the lane actually does: the payload's own counter
reports `exchanges=140 (140.0/token)` for a turn with 23-28 prefill tokens and ONE decode token. If
prefill were being offloaded as its own batched pass the count would be 280. It is 140. Whatever those
prompts cost, they are not costing TPU exchanges.

**But the comparison is confounded, and the confound is mine.** The two arms are not matched:

* `local-run.sh` waits for `Thermal Status: 0` AND the big cores at their full 3052000 kHz before it
  measures anything. `tpu-run.sh` has no thermal gate at all -- zero occurrences. In
  `quality-compare.sh` the TPU arm runs FIRST and the CPU arm second, so the CPU arm is guaranteed a
  cool, uncapped phone while the masked arm runs on whatever state the previous row left behind. That
  is a systematic bias in the CPU arm's favour on every rate this harness has ever produced.
* The VMs are different sizes. `tpu-run.sh` passes `--ei mem 8192`; `local-run.sh` passes no `mem`, so
  `mode local` defaults it to 7168 MiB (Main.java). A gigabyte of page cache, uncontrolled. This one
  favours the masked arm, so the two biases do not cancel and neither is bounded.
  (`threads` is 6 on both, by the same default, so that at least is matched.)

**So what stands and what does not.** Narrowly: each row's task verdict is a property of the reply
that was actually produced and recorded, and those verdicts do not depend on clocks or page cache,
because decoding is greedy and neither moves an argmax. That is the claim, and it is the only one --
NOT a blanket "every parity result stands". What is not established by these runs is anything that
compares the arms by RATE. Those comparisons are confounded, should not be quoted, and that includes
the 2.1-2.7x prefill gap above, which is precisely the direction the unmatched gate would produce on
its own. A rate measured under unmatched conditions is descriptive of those conditions; it is not a
controlled comparison, however large the apparent gap.

What that leaves is: the prefill claim was never measured, the only data bearing on it points the other
way, and that data is not clean enough to settle it either. Both statements should come out of this
file rather than one replacing the other. The decode figures are not affected the same way -- they are
corroborated by the per-exchange counters, and no thermal effect spans 1.06 against 15.37 tok/s -- but
the fix is the same: gate `tpu-run.sh` exactly as `local-run.sh` gates, and pass `mem` explicitly and
equally from `quality-compare.sh`. Held until the run in progress finishes, because changing the
runners mid-run would mix two configurations inside one result set.

### The gate I called the control was itself fail-open (2026-09-22)

The fix above was staged rather than applied, and review drove BOTH staged runners against a fake
device -- Thermal Status 3, `scaling_max_freq` 1000 against `cpuinfo_max_freq` 2000, only `sleep`
stubbed. Each completed its 90 checks, printed `cool gate: Thermal Status: 3 cap=1000`, launched
`am start`, produced a reading and exited 0.

So `local-run.sh`'s gate -- the one this file has been treating as the reason the CPU arm's numbers
are trustworthy -- never refused anything. It looped, and then measured whatever it had found. Nor
were the reads checked: a failed transport, an empty string and a non-numeric frequency all compared
unequal, looped, and fell through the same way. **A counted loop is not a validated gate**, and eleven
string-presence checks passed it without noticing, because they asserted that the gate's text existed
rather than that it did anything.

What that costs retrospectively: the CPU arm was PROBABLY cool for the runs on record -- the gate
prints its last reading and those lines say `Thermal Status: 0 cap=3052000` -- but "probably, because
the log happens to say so" is a different claim from "the harness refused to proceed otherwise", and
only the second one makes a rate a controlled measurement.

Now: one `coolgate.sh`, SOURCED by both runners so they cannot drift apart, returning non-zero unless
the phone is verifiably cool and uncapped, with the caller exiting 4. The only way past is `NOCOOL=1`,
which prints that the run is uncontrolled, is recorded in `BUILD`, and is folded into the cache key.
`tpu/test/coolgate-test.sh` drives the real runners against a permanently hot phone, a capped one,
empty and non-numeric sensor reads, a failed thermal read, transient heat that clears, and an explicit
bypass -- asserting on exit status and on whether the run was ever launched. The original gate fails 22
of its 30 checks.

**And the cache key made applying the fix unsafe.** It carried prompt, token budget, graphs, bundle and
library -- not the memory setting, not the thermal policy, and not the runners themselves. Applying the
repair into an existing `OUT` would have found every row present, printed `cached`, and reported logs
produced by the UNMATCHED runners as a matched run: the relabelling defect again, now at the level of
the experiment rather than the row. The key, `BUILD` and the manifest header now carry
`mem/maxnew/nocool` and a digest of `tpu-run.sh`, `local-run.sh` and `coolgate.sh`.
`tpu/test/key-binding-test.sh` checks that changing any of them re-runs instead of serving the old row;
under the old key it fails 8 of 16, serving both arms from cache with an unchanged key.

## The Google lane's sampler was never a confound, and the cap was (2026-09-22)

Two things were blocking a usable three-way comparison. One is now settled by experiment and the
other is now measured rather than argued.

### The sampler: settled, and it was nothing

`litert_lm_main` as Google ships it exposes only `--backend`, `--model_path`, `--input_prompt` and
`--input_prompt_file` -- checked with `--helpfull` on the device. So this lane ran at whatever sampler
was in force while the masked and CPU lanes decoded greedily, and a task difference between them could
have been the sampler rather than the lane. `host/patches/litert-lm-expose-sampler.patch` adds
`--sampler` and `--temperature` at 4698342e and prints what the package asks for.

The first thing it printed corrects something I wrote: **the package declares no sampler at all.**

    model_sampler: none declared by the package

So "the shipped setting" was never "what the model asks for" -- `SessionConfig::CreateDefault` leaves
the type UNSPECIFIED, the package fills in nothing, and whatever happens is the executor's own
fallback. That made the question worth answering rather than assuming, so both arms were run with the
SAME binary (`lm15s`, sha256 f592e1e4...) differing only in the flag:

| Google NPU lane, one binary, one flag | task-correct |
|---|---|
| `--sampler=model` (shipped behaviour) | 21/24 |
| `--sampler=greedy` (forced argmax) | 21/24 |

**Replies byte-identical on 24 of 24 rows.** So for THIS prompt set, at these settings, on this
package, the sampler flag makes no difference to the output and is not a confound in these tables.
That is the whole claim. It is not "the sampler never matters" -- 24 short, mostly single-answer
prompts is a narrow sample, a longer or more open-ended generation has far more opportunity to
diverge, and nothing here measured that. What the patch bought is that the question is now answered
by measurement for the comparisons actually being made, instead of carried as a caveat.

### The cap: the artefact is real and it is worth 3 rows

The three-lane table at `MAXNEW=48` (results/qc6 against results/g-model):

    masked TPU 19/24    in-VM CPU 19/24    Google NPU 21/24

and the whole gap is the token budget. Rows 06, 22 and 23 are the three code tasks; all three are
`status=budget` on the masked and CPU arms -- the model spends the budget on a docstring -- and all
three PASS on Google's lane, whose runner exposes no token-limit flag and therefore cannot be capped
at all. Row 17 is a genuine Google miss, the only one.

So the honest reading of 19/19/21 is not "Google is two better". It is: the two capped lanes agree
with each other exactly, and the comparison against the uncapped lane is not decidable at this budget.

A fresh full-set run is underway at a budget DECLARED before it started: `MAXNEW=256`, against a
longest-ever-observed complete answer of 57 decode tokens on this prompt set -- 4.5x, so a row that
stops at the cap there is a model that would not stop, not an artefact. It is the first run with the
matched harness: both arms gated by the same fail-closed `coolgate.sh`, both VMs at 8192 MiB, and the
settings and runner digest bound into every key. `results/qc6` is kept exactly as produced; it is
superseded for rates, not deleted.


## A shared checkout changed an experiment underneath itself (2026-09-22)

While qc7 was running I edited `host/coolgate.sh` -- the gate BOTH arm runners source at startup. The
run had recorded `runners sha256 2f1266993ec2...` before row 01, and for 2m23s that digest did not
describe the file the row subprocesses were sourcing. The live file is restored and the aggregate
matches again; the window, the rows inside it and the exact diff are written into that run's own
directory, and nothing was re-run or relabelled to tidy it up. One row (02 cpu) started two seconds
before the edit and cannot be shown to have sourced either version; it is recorded as ambiguous
because it is.

A digest captured once cannot prevent this -- it can only reveal it afterwards, and only if someone
checks. So `quality-compare.sh` now FREEZES the harness: the runners are copied into `$OUT/harness`
once, digested THERE, and invoked from there for every row, with `harness=frozen` in the key and the
frozen copy left beside the results. An edit to the checkout cannot reach a run in progress.

Staged rather than applied, because applying it to the live tree while qc7 runs would be the same
mistake a second time.

### And the Google lane's gate was not a gate at all

`google-lane-run.sh` called `cool_gate || die` at line 37 and defined `die()` at line 41. With no
errexit, a failed gate printed `die: command not found` and CARRIED ON. Driven against a COMPLETE fake
device -- one that supplies identity digests, a LITERTLM header, `--sampler` in its help, and a runner
that produces a benchmark block -- a phone at Thermal Status 3 ran the whole batch and recorded
`nocool=0`.

My own earlier probe of this concluded "the gate refuses" from a non-zero exit, and it proved nothing:
that fixture was incomplete, so the script died later at the device-identity step without ever
reaching the gate. `tpu/test/google-gate-test.sh` is the complete fixture, and it asserts what
actually matters -- on a hot, failed or capped device the RUNNER IS NEVER INVOKED and NO usable row is
written -- plus a cool control that does complete. Against the unfixed script it fails 11 of 14.

Two more from the same review. The bridge that let the shared gate see an argv array,
`ADB_SAVE="${ADB[*]}"` then `ADB=("${ADB_SAVE}")`, collapses `adb -s SERIAL` into one executable name
containing a space; the gate now goes through an `_cg_adb` adapter the caller defines. And the gate
ran ONCE before all 24 rows, which establishes nothing about rows 2..24 on a phone that heats up as it
works -- it is now called before every measured row, with `gate=per-row` in the settings and therefore
in every key, so batch-gated results cannot be served as per-row-gated ones.

## The compiled graphs are the weights, not bloat -- so that lever does not exist (2026-09-22)

I said in passing that the lane streams "1872 MB of compiled graphs against a 162 MiB GGUF, an 11x
expansion that int8-vs-4bit only explains about 2x of", and offered the unexplained remainder as the
largest unexplored lever in the whole campaign: if most of those bytes were padding or layout, packing
them better would cut the dominant term without touching accuracy.

**Withdrawn.** I had paired two numbers from different places without establishing they describe the
same thing, and they do not. Measured on the shipped graph set (`gguf-e2b/tpu/graphs-h4-ds`):

| compiled layer size | layers | total |
|---|---|---|
| 35.61 MB | 12 | 427.3 MB |
| 42.72 MB | 3 | 128.1 MB |
| 63.27 MB | 16 | 1012.4 MB |
| 69.59 MB | 4 | 278.4 MB |
| | **35** | **1846.2 MB** |

Four distinct widths, which is the model's own shape. And the arithmetic closes: a Gemma-shaped block
at `d_model` 2048 and `ffn` 8192, counting qkv + o + gate + up + down with the weights emitted once
(which is what stacking the digits as rows buys), is 67.1M parameters -- **67.1 MB at int8, against
69.59 MB measured.** About 4 % overhead for a compiled graph, which is not a lever, it is a format.

So the 159 ms per token of graph streaming is the model, at one byte per weight. It does not come down
by packing, only by narrowing the weights or shrinking the model: int4 is rejected above at 18.1x the
int8 weight error, and a smaller model is a different product. The biggest term in the masked floor is
the one with the least give in it, and the "unexplained 5x" I was pointing at never existed.

The 162 MiB figure belongs to a different artefact in a streaming table and should not have been set
against this at all.

## The comparison, finished: parity holds, and the speed does not (2026-09-22)

`results/qc7`, 24 prompts, both arms gated on a cool uncapped phone, both VMs at 8192 MiB, MAXNEW=256
declared before the run and binding on nothing (the most any row used was 149 decode tokens -- see the correction below), no
drafter in either arm. Against `results/g-greedy`, Google's own NPU lane on the same prompts and the
same contracts.

### Task correctness

| | score |
|---|---|
| masked TPU, inside the pVM | **22/24** |
| in-VM CPU, same GGUF, same pVM | **22/24** |
| Google NPU, outside any pVM | **21/24** |

Every one of the 22 auto-scored contracts passes on all three lanes except row 17 -- "the largest
planet in the solar system" -- which Google's lane alone gets wrong. The remaining two are the `review=`
rows, which need a human on every lane by construction. 18 of 24 masked/CPU pairs are byte-identical.

At `MAXNEW=48` this same set read 19/19/21 and the whole apparent gap was the token budget: three code
rows spent it on a docstring and were scored truncated on the two capped lanes while Google, whose
runner exposes no token limit, completed them. At an adequate budget that artefact is gone and the
masked lane matches the unmasked one exactly.

**So the functional claim is settled: masking the offload costs nothing measurable in task quality on
this set.** That was the open question the whole harness campaign was in service of.

### Decode rate, and it is not close

| | median | range |
|---|---|---|
| masked TPU, inside the pVM | **0.98 tok/s** | 0.77-1.23 |
| in-VM CPU, undrafted | **15.05 tok/s** | 11.75-15.56 |
| Google NPU, outside any pVM | **15.21 tok/s** | 11.85-18.94 |

15.1x between the two in-VM lanes, and the masked path is at **1020 ms per token against the 66.7 ms
that 15 tok/s requires**. This is the first rate comparison from this harness that is a controlled
measurement rather than a description of unmatched conditions, and it lands where the floor analysis
said it would.

### What the three numbers say together

The goal asks for three things at once: a pVM holding every secret, the TPU doing the heavy compute,
and 15 tok/s. Each PAIR is available and the triple is not:

| | pVM root of trust | TPU does the compute | >= 15 tok/s |
|---|---|---|---|
| masked TPU lane | yes | yes | **no** -- 0.98 |
| in-VM CPU lane | yes | **no** | yes -- 15.05 undrafted |
| Google NPU lane | **no** | yes | yes -- 15.21 |

The missing combination is not a tuning problem. Masked offload must enter the accelerator once per
linear run, 140 times a token, and the floor built from Google's own dispatch fit -- 140 x 0.520 ms of
invocation plus 1872 MB x 0.0848 ms/MB of graph streaming -- is 231.5 ms per token before any transport
or masking exists. The graphs are the weights at about 4 % overhead, so that term has no give in it;
int4 halves it and costs 18.1x the weight error. One invocation per token is what Google's lane does,
and it needs the whole graph inside the trust boundary -- which needs an AVF API that does not exist on
`android17-release` or on `main`, where `VirtualMachineConfig` writes an empty assigned-device array
unconditionally with no setter.

## What actually binds first: NPU weight bandwidth, not masking (2026-09-22)

The stop condition is not met and this is the most useful thing I have found about why. It reframes the
gap, and it does it from a bench that has been running inside every measured row all along.

`nativeBench` fires on every worker open, so each `*.tpu.log` in `results/qc7` carries min and mean ms
per Run for both signatures of two layers. Against the known compiled sizes:

| | compiled | min ms (4 signatures) | achieved |
|---|---|---|---|
| L0 | 35.61 MB | 5.54 | 6.43 GB/s |
| L20 | 63.27 MB | 6.69 | 9.46 GB/s |
| L0 (2nd row) | 35.61 MB | 5.74 | 6.20 GB/s |
| L20 (2nd row) | 63.27 MB | 7.99 | 7.92 GB/s |

Best observed **9.5 GB/s**, against the **11.8 GB/s** marginal slope the 128x dispatch sweep measured.
Those agree: the sweep's slope is the marginal cost per megabyte, the bench includes the fixed cost.

**So the NPU streams weights at roughly 6-12 GB/s, and our lane must move 1.84 GB of int8 weights per
token. That is 156-195 ms, a 5.1-6.4 tok/s ceiling, UNMASKED, before a single byte crosses the pVM
boundary and before any pad is drawn.** Masking is not what puts this lane below 15 tok/s. The size of
the active weight set does, and masking is then charged on top.

### The same arithmetic explains Google's lane exactly

Google measured 65.8 ms per token on this phone today. At 11.8 GB/s that is at most 0.78 GB of weight
traffic, and attention, the norms, sampling and the LM head have to happen inside it too -- so their
active set is well under 0.78 GB, under 42 % of ours. And 65.8 ms is almost exactly **one invocation
plus streaming about 0.7 GB**: 0.5 + 59 = 60 ms. Their package is 3.11 GB, so they activate roughly a
fifth of it per token, which is what int4 plus MatFormer plus per-layer embeddings buys.

Per token, against Google:

| | ours | theirs |
|---|---|---|
| weight bytes | 156 ms | ~59 ms |
| invocations | 73 ms (140 entries) | 0.5 ms (one) |
| everything else | ~791 ms | ~0 |

### What this changes about what to attack

The order was wrong. Transport and masking are still the largest single term at ~791 ms, but the two
underneath them are not small, and one of them is a hard floor nothing in this design can reach past:
**even with a free transport, free masking and one entry per block, 1.84 GB of int8 weights cannot be
read in less than 156 ms.** Any plan that ends at 15 tok/s has to cut the active bytes FIRST, to
something near 0.7 GB, and only then do the other two terms matter.

That makes int4 the gate rather than a nice-to-have, and it sharpens what the earlier rejection
actually said. `a8w4` was rejected because int4 with ONE SCALE PER ROW is 18.1x the int8 weight error.
Group-wise int4 is 10x at group 32 and is what production 4-bit models use -- and Google ships a 4-bit
package that scores 21/24 on these same contracts, so group-wise int4 plainly works on this silicon.
What blocks it here is expressibility, not accuracy: quantised FULLY_CONNECTED carries per-output-channel
scales and nothing per group of input columns, and the construction that works around it -- split the
input, sum partial products -- is the one the G5 compiler crashes on. That crash is now the single
highest-value blocked item in this campaign, and it is worth saying plainly that it is a toolchain
limit rather than a property of the accelerator.

## Group-wise int4 works on this TPU -- and does not pay (2026-09-22)

Two records in this file were wrong, and this section corrects both. It also closes the lever I had
just named as the highest-value blocked item, in the opposite direction from the one I expected.

### 1. Group-wise int4 IS expressible, compiles, and computes correctly

This file said group-wise int4 "cannot be expressed" because FULLY_CONNECTED carries per-output-channel
scales only and the workaround -- slice the input, sum partial products -- is what the G5 compiler
crashes on. The crash is real, but it belongs to SLICE: `op_slice_g5.tflite` compiles to 0 bytes on its
own, and so do SPLIT, RESHAPE and REDUCE_SUM. The slice is only needed if the groups arrive as ONE
tensor. Sent as G separate graph inputs, nothing is sliced: G FULLY_CONNECTEDs over disjoint input
column blocks, each with its own per-output-channel scales, then an ADD tree. Per-(output channel,
group) scales is exactly group-wise quantisation, and the weight blocks are disjoint so nothing is
duplicated. Every piece was already known to compile -- `ds_two_copies` and `np2`/`np3` are multi-input
FC+ADD graphs -- it had simply never been assembled this way.

`~/pixel10-platform/a8w4/probe_groupwise.py`, at the real shape `[5, 2048] -> [5, 8192]`, with a
DIFFERENT weight block and scale vector per group so the compiler cannot deduplicate, all compile with
no error: per-row control 8.63 MB, 2/4/16 groups 8.78/8.95/9.93 MB, against int8 17.0 MB.

Then run on the TPU with `gwcheck`, a small runner built on the worker's own LiteRT calls, and compared
against a host reference regenerated from the same seeds. **16 groups of 128: max error 1 LSB, rms 0.01,
on outputs averaging 320 LSB.** The test discriminates: group k's scales were set near (1 + k/2) x base,
so a graph that applied one scale to every group -- silently falling back to per-row -- would be off by
up to 1488 LSB. It is off by 1.

### 2. But it is slow at the group sizes that are accurate, and barely more accurate

Timed on the TPU, 6 interleaved passes x 300 Runs, all 36 on a cool uncapped phone:

| graph | group | median | vs int8 |
|---|---|---|---|
| int8 | -- | 3.47 ms | -- |
| int4 per-row | 2048 | 2.19 ms | 37 % faster |
| int4, 4 groups | 512 | 2.35 ms | 32 % faster |
| int4, 16 groups | 128 | 3.25 ms | **6 % faster** |

Sixteen FCs and fifteen ADDs cost nearly all of what the smaller weights save.

And on accuracy, the second correction. The recorded rejection said int4 per-row is **18.1x** the int8
weight error. That figure gave per-row NO clip search (`clip=1.0`) while giving the grouped variants
the best of five, so it was not a like-for-like comparison. With the same search for every setting,
across 12 real tensors spread over depth:

| | relative RMS weight error | vs int8 |
|---|---|---|
| int8 per-row (shipped) | 1.004e-02 | 1.0x |
| int4 per-row | 1.288e-01 | **12.8x** |
| int4 group 512 | 1.260e-01 | 12.6x |
| int4 group 128 | 1.208e-01 | 12.0x |
| int4 group 32 | 1.010e-01 | 10.1x |

The curve is flat until very small groups. Grouping buys 6 % accuracy at group 128 and costs 31 points
of speed to get it.

### So

**Per-row int4 is the int4 lever worth having**: the fastest option, already compilable, and within
7 % of group-128's accuracy. Group-wise works and is closed on the merits, not on the compiler.

Whether 12.8x the int8 weight error is acceptable is an empirical question about task quality that a
weight-error ratio cannot settle -- Google ships 4-bit weights scoring 21/24 on these contracts, but
theirs are quantisation-aware-trained and these would not be. What it would buy if it were acceptable:
the lane's weight streaming falls from about 156 to about 80 ms per token. With 140 invocations that is
a floor near 153 ms, 6.5 tok/s, before transport or masking -- which still stand at about 791 ms. It is
a real improvement to the smallest of the three terms and it does not bring 15 tok/s within reach.

## The architecture that would work exists on this phone -- for Google (2026-09-22)

Checked on the device, because it is the one topology that escapes every floor above: inference inside a
pVM that ITSELF has the TPU, so the whole graph runs in one invocation per token with nothing masked and
nothing crossing a boundary 140 times.

    /system/etc/init/aisealhostservice.rc
      service aisealhostservice /system/bin/aisealhostservice
      # AiSeal hosts multiple performance sensitive services like AppSearch or AI inference
      interface aidl aiseal_host
      disabled
      on property:sys.boot_completed=1 && property:service.aiseal.enable=1  -> enable

So Google's platform has a service whose stated purpose includes AI inference inside its pVM framework.
On this build it is `disabled`, `service.aiseal.enable` is unset, the property carries its own SELinux
type (`aiseal_prop`) rather than one a shell or app can write, and the interface is `aiseal_host`, a
system AIDL with no third-party entry point. The only pVM actually running is AppSearch's
(`crosvm_isolated_storage_service_vm`). AICore, which serves Gemini Nano on this TPU today, runs as an
ISOLATED PROCESS in the normal world -- `com.google.android.aicore:isolated_service`, with no crosvm --
not inside a pVM.

That completes the picture of the platform side. The capability the goal needs is being built: AiSeal
for inference in a pVM, the Pixel 11 TPU context for a guest to own an accelerator, the android16-6.12
commits loading NPU drivers into Microdroid. Every piece is first-party. A third-party app gets a pVM
with an empty device list and no route to any of it -- on `android17-release`, on `main`, and on the
build installed here.

## The one topology that meets the intent -- and what it gives up (2026-09-22)

Every route above assumes the accelerator is THIS phone's TPU and the only trusted domain is THIS pVM.
Drop the first assumption and a different topology appears, the one Apple uses for Private Cloud
Compute: the phone pVM stays the root of trust, and before it releases any secret it ATTESTS a remote
accelerator that is itself inside a hardware TEE. The model then runs whole, in plaintext, inside that
TEE; tokens stream back over one attested connection. No masking, no 140 crossings per token, and the
phone's CPU does almost nothing.

**Is there a confidential TPU anywhere?** No. Google Cloud's documentation says flatly that TPUs cannot
be attached to Confidential VM instances, and its June 2026 confidential-computing announcement lists
NVIDIA GPUs only -- Hopper generally available in Confidential Space, RTX PRO 6000 Blackwell in preview
on Confidential G4 VMs, and Blackwell serving Apple Private Cloud Compute on Google Cloud. So the remote
accelerator in this topology is a confidential GPU, and that is the first requirement it relaxes.

Against the three requirements, honestly:

| | this topology |
|---|---|
| pVM as root of trust | yes -- it holds the keys and attests the remote before releasing anything |
| heavy compute off the phone CPU | yes -- entirely remote |
| >= 15 tok/s | yes, by a wide margin -- a confidential H100/H200 serves a model this size far faster |
| "the TPU" | **no** -- no confidential TPU exists; it is a confidential GPU |
| "all secrets inside" the pVM | **partly** -- inside attested TEEs throughout, but they leave the phone for a second one |

It also depends on the network, which the on-device designs do not.

The pieces largely exist here already: `RelayAttach` attests the phone pVM to the relay as
`android-avf-pvm/v2` with its own key, and the platform runs models inside confidential GPU TEEs with
in-enclave TLS termination. What is missing is the reverse direction -- the pVM verifying the REMOTE
TEE's attestation and holding a channel that terminates inside it.

This does not satisfy the goal as written; it satisfies what the goal is FOR. Whether trading "the TPU"
for "an attested remote accelerator" is acceptable is not a technical question.

## Where the masked token actually goes, measured from both ends (2026-09-22)

Both sides of every exchange log their own counters -- the VM its mask, link (correction, mint, wait)
and unmask; the worker its recv, input-write, tpu-run, output-read and send. The VM's wait minus the
worker's busy time is the boundary crossing itself, measured rather than inferred. Across the 21 qc7
rows that carry both lines (medians, 140 exchanges per token, 1010 ms token):

| term | per exchange | per token | share |
|---|---|---|---|
| boundary crossing (VM wait - worker busy) | 2.451 ms | 343 ms | 34 % |
| TPU run | 2.092 ms | 293 ms | 29 % |
| VM work outside any exchange | -- | 146 ms | 14 % |
| worker I/O | 0.529 ms | 74 ms | 7 % |
| VM unmask | 0.520 ms | 73 ms | 7 % |
| VM correction + mask + other | 0.584 ms | 82 ms | 8 % |

Two terms disagree with the model, and both have mechanisms:

* **TPU run is 293 ms, not the ~229 the dispatch fit predicts.** The in-run bench already shows why:
  the same Run is 30-50 % slower after a 3 ms idle gap, and the real pattern is always Run, gap, Run.
* **146 ms of VM work outside the exchanges** is more than twice what the ZERO-offload backend took for
  the entire model, every block included (74.5 ms). Removing work from the VM made what was left slower
  than the whole had been.

### The thread-count test: the mechanism is real and it is not a lever

The masked backend is a ggml backend, so every offload boundary is a scheduler split -- about 140 per
token -- and each CPU-side split wakes the thread pool for a sliver of work, then barriers and sleeps.
Swept on one 57-token generation (`results/thread-sweep`, same answer, all gated cool):

| VM threads | ms/token | inside exchanges | outside |
|---|---|---|---|
| 6 | 833 | 712 | 122 |
| 2 | 826 | 750 | 77 |
| 1 | 1099 | 952 | 147 |

Two threads cut the outside term by 37 %, so split overhead is real. But the same threads carry the
mask/unmask work inside the exchanges, which slows by almost as much: the total is flat, and one thread
is worse on both. Recovering the outside term would mean decoupling the two -- a small CPU pool for the
graph splits, a separate one for the pad arithmetic -- and even all 146 ms would take a 1010 ms token to
about 860.

### And the rate that belongs on a long generation

That same 57-token generation runs at **1.20 tok/s**. The qc7 median of 0.98 is pulled down by rows
that answer in one to five tokens, where per-turn fixed costs dominate the per-token rate. Both are
measured; the second is the one that describes sustained generation.

## On-TPU digit recombination: expressible now, and it does not pay (2026-09-22)

This file called TPU-side recombination "the only lever found so far that moves the CEILING" (reply
halves, per-row cost halves, ceiling 4.7 -> 9.4 tok/s) and recorded it as blocked by the G5 compiler's
SLICE crash. The same route that unblocked group-wise int4 unblocks it -- hi and lo as separate graph
inputs, no slicing -- and it is now measured. Probe: `tpu/gwcheck/probe_digitcombine.py`, at the real
shape `[5, 2048] -> [5, 8192]` with the shipped int8 weights.

**Where the 256 lives decides whether the weights are duplicated.** It has to be a real factor, so it
has to sit somewhere, and the G5 compiler emits a separate weight copy per FULLY_CONNECTED whenever the
two FCs differ in ANY quantisation parameter:

| construction | where the 256 goes | compiled |
|---|---|---|
| split (shipped) | -- (VM recombines) | 17.04 MB |
| combine | hi weight scale, two tensors | 33.86 MB |
| combine_in | hi INPUT scale, one weight tensor | 33.86 MB |
| combine_buf | hi weight scale, one shared buffer | 33.86 MB |
| **combine_mul** | a MUL by 256 AFTER two identical FCs | **17.05 MB** |

So the earlier note that "the compiler deduplicates by content" holds only when the FCs are identical;
`combine_mul` gets one stored copy by making them so.

**But one stored copy is not one read.** Timed interleaved, 6 passes x 300 Runs, all 18 cool and
uncapped: split median 3.45 ms, `combine_mul` 4.02 ms -- **16 % slower per Run**, with a far worse best
case (3.32 against 1.56 ms). Executing two FCs costs nearly what a second copy would. Per exchange that
gives back about 0.57 ms against roughly 0.56 ms of reply saved plus a little VM recombination: a net of
perhaps 3 % of the token, inside the noise of these measurements. The 4.7 -> 9.4 projection assumed the
recombination was free on the TPU. It is not.

**What the correctness check did and did not establish.** On the TPU, `combine_mul` matches its own host
reference EXACTLY (0 LSB), and the 256 is honoured: had the MUL been ignored the error would be 27 LSB.
But at the output scale this probe used -- chosen to keep 256*hi inside int16 -- outputs averaged 5 LSB
and the lo digit's contribution rounds to **0 LSB**, so the check cannot tell whether the lo branch runs
at all. That is a scale I chose badly, not a property of the construction: in a properly scaled lane lo
carries up to about 256 LSB. Lo-branch correctness, and the precision cost of recombining into one int16
at full range, are UNVERIFIED -- and since the lever roughly breaks even on speed, not pursued.

## The TPU's idle-gap penalty does not answer to its performance mode (2026-09-22)

A Run after a 3 ms idle gap is slower than back to back, and the real exchange is always Run, gap, Run
-- which is why the TPU term measured 293 ms per token against the ~229 the dispatch fit predicts. The
obvious control is LiteRT's Google Tensor performance mode (`GoogleTensorOptions::SetPerformanceMode`:
ExtremePowerSaver, PowerSaver, Balanced -- the documented default -- HighPerformance, Sustained, Burst).
The worker sets none. `gwcheck` now takes a mode and an inter-Run gap; measured on a REAL compiled layer
(L20 of the shipped set), 3 interleaved passes, all 30 cells cool and uncapped (`results/perfmode`):

| mode | back to back | after a 3 ms gap | gap penalty |
|---|---|---|---|
| runtime default | 1.710 ms | 2.085 ms | +22 % |
| Balanced | 1.819 | 2.070 | +14 % |
| HighPerformance | 1.881 | 2.055 | +9 % |
| Sustained | 1.669 | 2.120 | +27 % |
| Burst | 1.626 | 2.130 | +31 % |

After a gap every mode lands within 2 % of the default. HighPerformance's smaller penalty is only its
slower back-to-back time. So the ~0.35-0.5 ms a Run loses after idling is not controlled by the one API
that sets TPU clocks, and the likelier cause is on the host side -- the dispatching thread and its core
idle through the same gap. Not a lever through this API; closed.


## Two corrections to the qc7 write-up, and what the verify counter means there (2026-09-22)

**The maximum decode length was 149, not 59.** I wrote "the most any row used was 59" into TPU.md and
into `results/qc7/PROVENANCE.txt`. 59 was the maximum over the first rows I checked while the run was
still going; I did not re-check after the long code rows finished. From the archived logs:

| row | arm | decode tokens |
|---|---|---|
| 22 | cpu | **149** |
| 22 | tpu | 127 |
| 23 | tpu, cpu | 80 |
| 06 | cpu | 59 |

The 256-token cap still did not bind, so the conclusion that the budget artefact is gone stands. But the
headroom was about 1.7x, not the 4.5x my wording ("4.5x the longest observed answer") implied: that
ratio described the BUDGET against the answer I had seen before the run, not against what this run
produced. `PROVENANCE.txt` is covered by `results/qc7/MANIFEST.sha256` and has been checked against it
independently, so it is left exactly as produced; the correction sits beside it in `CORRECTIONS.txt`,
which the manifest deliberately does not cover.

**The verify counter is a numerical diagnostic, not an integrity check, and qc7's reading is inside its
established tolerance.** `kVerifyKernel` recomputes one sampled element per projection per exchange on
the CPU, with the reference's own expression, and counts disagreements with what the TPU returned. The
section "The backend deviation, MEASURED on the deployed kernel" established what that looks like on
this kernel: about 129k comparisons, 7 disagreements, every one at most one digit-scale LSB -- the TPU's
rounding differing from the CPU's. qc7's archived TPU logs:

    7 rows with any disagreement, 13 disagreements in 141,450 comparisons, max 1 digit LSB
    worst contribution to a decoded value in any qc7 log: 0.01 output LSB

Same size, same rate within noise (0.009 % against 0.005 %), and every one landed on the `lo` digit,
where a disagreement is worth about a hundredth of an output LSB; one on `hi` would have been worth up
to 2.5. So these are the known arithmetic difference, not a sign of a misbehaving worker.

What the counter does NOT establish, restated because it is easy to read too much into a clean number:
it samples one element per projection per exchange, so it says nothing about the unsampled products of
any exchange; it detects numerical drift, not a worker that is deliberately wrong only where it is not
sampled. The protection against an untrusted worker is the masking and the bounded repair described in
"Bounding the repair against an untrusted worker", not this counter.

**Standing caveats on qc7, unchanged:** the mixed-harness window recorded in
`results/qc7/PROVENANCE-NOTE-mixed-harness.txt` (row 02's CPU arm ambiguous, row 03's TPU arm started
inside it); 24 short prompts is a narrow sample; and a quality result on this set says nothing about the
15 tok/s requirement, which the masked lane misses by more than tenfold.

### The idle-gap penalty is the HOST core, and the fix costs a core (2026-09-22)

If the penalty is not the TPU's clock, it may be the dispatching CPU core idling through the same gap.
`gwcheck` can now fill the gap by SPINNING instead of sleeping -- same wall time, core kept busy. On the
real L20 layer, 5 interleaved passes, all 15 cells cool, every reported gap matching the one requested
(`results/perfmode/spin-vs-sleep.tsv`; a first attempt passed a stray `--` that parsed as a 0 gap and
made all three conditions back to back -- caught by checking the gap the tool reports, and discarded):

| before the next Run | median |
|---|---|
| back to back | 1.934 ms |
| 3 ms gap, sleeping | 2.075 ms |
| 3 ms gap, spinning | **1.669 ms** |

With the core kept busy the Run is 0.41 ms faster than after sleeping. So the penalty is the host core
going idle, not the TPU: up to about 57 ms per token.

The real worker already asks for everything an app can -- nice -19 and an ADPF performance-hint session
naming its thread with the exchange deadline -- and still pays it: qc7's TPU run, 2.09 ms per exchange,
matches the SLEEPING case here, not the spinning one. Whether the cause is frequency ramp-down or
deep-idle exit could be settled with a uclamp floor, which counters the first and not the second; but
`sched_setattr` with a utilisation clamp is refused to an unprivileged process for every value tried,
0 included (EPERM). So the only fix available is to spin, which burns a whole core to recover about 6 %
of a token -- the opposite of the goal's reason for using the TPU, and the VM-side spin in this file
measured WORSE for exactly that reason. Closed.

## Where a token's multiply-accumulates actually happen (2026-09-22)

"35 of 35 blocks on the TPU" counts layers, not work. `tpu/mac_share.py` counts MACs per decoded row from
the two files that decide them: the lane bundle (every projection the TPU is sent) and the GGUF (every
other matmul, and the attention shapes). KV-shared blocks (the last 20) are excluded from K and V, because
their `attn_k`/`attn_v` tensors are in the file but never multiplied.

    projections in the model 1,835,532,288 MACs/row; on the TPU 1,835,532,288 (100.0 %)
    by kind: qkv 146.3M, o 132.1M, gate+up 1038.1M, down 519.0M
    left on the VM: lm_head 402.7M, per-layer embedding in 13.8M, per-block inp_gate+proj 27.5M

| ctx | TPU | VM online | of which attention | TPU share online | VM pads | TPU share counting pads |
|---|---|---|---|---|---|---|
| 128 | 1835.5M | 466.0M | 22.0M | **79.8 %** | 1835.5M | **44.4 %** |
| 512 | 1835.5M | 532.0M | 88.1M | 77.5 % | 1835.5M | 43.7 % |
| 2048 | 1835.5M | 620.1M | 176.2M | 74.7 % | 1835.5M | 42.8 % |
| 4096 | 1835.5M | 737.5M | 293.6M | 71.3 % | 1835.5M | 41.6 % |

Two things this makes explicit that "35 of 35" hid.

* **The biggest thing left on the VM is the lm_head**, 402.7M MACs, a fifth of the online work. It is
  eligible: it is a plain matmul of the final hidden row. Moving it costs a 262,144-wide reply per token
  (1 MB with the digit split), which at this link's measured exchange rate is 40 ms or more -- more than
  the whole CPU token. It stays on the VM until the link is cheaper, and the share is quoted with it there.
* **The pads cost the VM exactly what the TPU does.** A pad's correction is `W.r` for every projection:
  the same 1835.5M integer MACs, per decoded row. They are minted before decode (the bank: 64 positions
  in 2.0-2.8 s on six threads, about 190 core-ms per token-row) or inline when the bank runs dry. Counting
  them, the TPU does 44 % of the arithmetic. That is the honest ceiling of "most compute on the TPU" for
  any design where the trusted side computes its own pad corrections, and it holds whatever the link
  does. Moving the pads off the phone means a trusted dealer (the dealt-pads design, which adds a party to
  the trust boundary); structured pads (LWE/LPN) cut the VM's share but were measured to buy 1.1-1.2x
  here (`shielded/lpn`), and they widen the reply.

## The int4 lane: a stale bundle, then an exact one (2026-09-22)

`make_graphs.py --wbits 4` builds the per-row int4 lane (a clip search per row, INT4 weight tensors packed
low nibble first, the SAME integers kept as int8 in the bundle so the VM cancels with the TPU's matrix).
`tpu/test/wbits_match.py` reads both files independently: 205 projections, 1,835,532,288 weights, 0
integer and 0 scale mismatches. It compiles to 925 MB against int8's 1786.

**The first two phone runs verified 104,724 and 104,693 of 104,960 samples WRONG** (max 9,959 LSB, 1,060
false rails) and decoded 256 tokens of garbage. They were not int4's fault. `gwcheck` now runs any
signature of a compiled layer (`GWCHECK_SIG`) over the full int8 input range (`GWCHECK_FULL=1`, which a
digit-split `lo` row uses), and `gwcheck/gw_ref.py` recomputes every output from the authored integers:
all four signatures of L0 and L20, int8 and int4, agree to 1 LSB. The bundle's and the graph's scales agree
exactly. What differed was the VM's copy of the bundle: it reused its cached file when the size and the
first 8 bytes matched, and the int4 bundle has the int8 one's size and magic. The VM cancelled with int8
while the TPU multiplied by int4. Those runs are kept, attributed, and excluded
(`results/w4/ATTRIBUTION.txt`).

Two defects, both fixed:

* **Bundle identity.** The stream header carries the file's SHA-256; the VM answers "reuse" only after
  re-hashing its stored copy end to end against it (`payload/anchor_public_file.h`), and hashes a new
  stream as it arrives, refusing bytes that are not the announced digest. The digest is the untrusted
  owner's statement of WHICH artifact -- identity, not authentication. `tpu/test/public-file-test.c`
  drives the real receiver: other bytes of the same size and magic restream, altered or truncated streams
  refuse and leave nothing, a copy altered in place is not reused, and a power loss at each step followed
  by either next request never yields a reuse of other bytes. (A first version kept the digest in a
  sidecar; an audit pointed out that its correctness then rested on crash ordering and on an unlink whose
  failure was ignored. Re-hashing removes the dependency; it costs one read of the stored copy per run.)
* **A verifier that counted.** Kernel verification now refuses the turn when a sample disagrees by more
  than 1 digit LSB (the established requantiser rounding); it used to count and decode on.

With the bundle bound, int4 on the phone (`results/w4`, `lane-run2.sh`, all four runs LANE-RUN OK):

| lane | runs | tokens | tok/s | link ms/exchange | verify |
|---|---|---|---|---|---|
| int8 | i8-e, i8-f | 57, 57 (same text) | 1.13, 1.03 | 4.67, 5.16 | 3 and 0 of 23,370, max 1 |
| int4 | w4-e, w4-f | 16, 16 (same text) | 1.21, 1.24 | 4.16, 3.95 | 0 and 0 of 6,560 |

No sampled output disagreed: the kernel verification recomputes ONE element per projection per exchange (6,560 of
the lane's outputs per run), so this is 0 disagreements in a sample, consistent with the TPU multiplying by the
integers the VM cancels with (gwcheck's full-output check of L0 and L20 agrees to 1 LSB), not a proof that every
output was exact. The link is 0.5-1.2 ms per exchange
shorter (about 70-170 ms per token), close to what halving the streamed weights predicted. The answer
changes: on this prompt int4 writes the function without the docstring and without the closing fence.
Whether 12.8x the int8 weight error keeps the task quality is the 24-prompt question
(`tpu/lane-quality.sh` -> `results/qw4`, scored by `tpu/lane-score.py`, which reproduces qc7's 22/24 on
both arms from the archived logs).

### Tooling that failed open, and now does not

* `tpu-run.sh` read results out of logcat, whose 256 KiB ring a warm, charging phone's thermal HAL floods
  in minutes; a whole run's lines were lost. `lane-run2.sh` reads the app's own capture file and exits 0
  only with checked adb calls, the capture's footer and marker, the app's digest of the prompt it RECEIVED
  (apostrophes used to be mangled), the bundle the VM confirmed, every expected record, and a VM that did
  not die first. 32 fake-device cases.
* The worker's link poll was a process global set only for positive values, so it survived into a later
  zero-spin run in the same process; it is per worker handle now and set on every open, zero included.

## What masked decode costs the phone's CPU, and the first lever that cuts it (2026-09-22)

`tpu/cpu-sampler.sh` + `tpu/cpu-window.py` measure the app's whole process tree (the app, its virtmgr, its
`crosvm_anchorlocal`, bound by parentage and start time) over each turn's own decode window, on the clock the
app stamps it with. The first figure (`results/cpuval`): **masked int8 decode keeps at least 5.1 cores busy -- at
least 5,365 core-ms per decoded token at 0.95 tok/s, 97 % of it inside the VM.** "At least": the analyser marked
this window INCOMPLETE, because under that load the sampler's intervals at the window edges stretched to 1.0-1.4 s
(its limit is 1.0 s), so the edges are interpolated over a wider interval than allowed (bound: +-5.4 core-s). The
figure is a lower bound, not a complete total-CPU measurement, and every CPU number in this section carries the
same qualification. The CPU-only engine spends about 330
core-ms per token on the whole model. So the masked lane, with every block projection on the TPU, costs the
phone about sixteen times more CPU per token than not using the TPU at all, and it is why the phone thermal-
capped itself all day (the big cores' cap fell to 1.8-2.2 GHz during masked runs). The VM's pool of six threads
waits for the link at ggml's default hybrid polling, spinning through most of every exchange.

`results/spin2`, one prompt (57 tokens, identical text in every run), ABBA order, every run LANE-RUN OK,
sampled verification at most 3 disagreements, each of 1 digit LSB, in 23,370 sampled comparisons per run (not exact
equality of every output). **Every CPU figure below is INCOMPLETE -- a lower bound**: in each run the samples around
the window edges were 1.0-1.4 s apart, over the analyser's 1.0 s limit. No criterion was relaxed to call them complete.

| condition | tok/s | link ms/exch | unmask | between exch | app cores (>=) | core-ms/token (>=) | prefill tok/s |
|---|---|---|---|---|---|---|---|
| 6 threads (default) | 0.99, 0.99 | 5.32, 5.35 | 0.64 | 0.92 | 5.06, 5.12 | 5,099, 5,184 | 53, 52 |
| **2 threads** | **1.16, 1.07** | 5.25, 5.46 | 0.26-0.31 | 0.50-0.73 | **2.20, 2.21** | **1,902, 2,075** | 22, 20 |
| 6 threads, pool poll 0 | 0.82, 0.85 | 6.35, 6.15 | 0.39-0.45 | 1.69-1.70 | 2.15, 2.19 | 2,639, 2,587 | 51, 50 |
| 2 threads + link poll 4 ms both ends | 0.80, 0.74 | 8.06, 8.42 | 0.20 | 0.55-0.89 | 2.47, 2.41 | 3,091, 3,257 | 22, 19 |

* **Two decode threads: 10-15 % faster and 60 % less CPU.** The VM's own work between and around exchanges
  shrinks (unmask 0.64 -> 0.3 ms, gap 0.92 -> 0.6 ms) because fewer threads spin against the one that is
  working, and the phone stays uncapped. It still costs about 2,000 core-ms per token, six times the CPU engine.
* **Pool poll 0** saves as much CPU but makes the token slower: idle threads sleep, and waking them per graph
  split costs 1 ms per exchange.
* **Polling the link, now with cores to spare, is still worse:** the link itself takes 8.1-8.4 ms instead of
  5.3. The guest spinning on the vsock delays the delivery it is waiting for. Closed, this time with free cores.
* **Two threads cost prefill 2.5x** (it runs on the VM's CPU). The fix is separate pools -- six for prefill,
  two for decode -- which llama.cpp supports; next.

The device-wide column of the batch's own `.cpu` files double-counted guest time (fixed in 3488f186); the
table's figures are from re-running the fixed analyser on the saved samples.

### Complete-window CPU, matched against the CPU-only lane (2026-09-22)

Sampler v3 (`tpu/cpu-sampler.sh`: discovery in a background loop, the discovered pids' stat every 0.25 s) gives
windows the analyser accepts as COMPLETE under unchanged rules (edge samples <= 1.0 s apart, scans <= 3.0 s apart).
`results/cmp1`, one prompt, ABBA order, every run LANE-RUN OK and every CPU window COMPLETE:

| lane | tok/s | cores busy | core-ms per decoded token (edge bound) | sampled verification |
|---|---|---|---|---|
| CPU-only, same model in the same VM | 13.96, 11.77 | 5.77, 5.93 | 413, 504 (+-23 %: the windows are 4-5 s) | -- |
| masked int8, 6 prefill + 2 decode threads | 1.16, 1.01 | 2.23, 2.14 | 1,926, 2,122 (+-1-2 %) | 4, 2 of 23,370 (<= 1 LSB) |
| masked int8, one pool of 6 | 0.96, 0.99 | 5.02, 5.08 | 5,235, 5,141 (+-1 %) | 1, 1 of 23,370 (<= 1 LSB) |

With the separate decode pool (f99f3b3e) the masked lane occupies fewer cores than the CPU lane (2.2 against 5.9),
and still spends **four to five times more CPU per decoded token** (about 2,000 core-ms against 410-500), at a
twelfth of the speed. By arithmetic the TPU does 79.8 % of the online multiply-accumulates (mac_share.py); by
measured CPU the phone does more work per token with the TPU than without it. What the VM's two decode threads spend
their time on is the per-exchange work around 140 exchanges per token -- masking, the out-of-lane correction,
unmasking, the graph splits between exchanges, and waiting at ggml's default hybrid polling -- not arithmetic the
TPU could take. These are CPU measurements of the app's process tree over the decode window; the pads' minting
(before decode, into the bank) is outside that window and is additional.

### Speculation and huge pages on the 2-thread decode pool (2026-09-22)

* **MTP drafter (`results/draft1`):** 2.7-2.85 tokens per step, yet 1.10/1.15 tok/s against 1.04/1.12 without it,
  at 3,134-3,213 core-ms per token against 1,942-2,056 (COMPLETE windows). Each exchange now carries ~4 rows and the
  link grows with them (11.6-12.4 ms); masking grows to 1.9-2.3 ms because the 64-position pad bank ran dry (1,960
  inline mints). Without the inline mints the per-row link still bounds this at about 1.7 tok/s.
* **Guest huge pages (`results/hp1`, `setShouldUseHugepages`):** 1.09/0.96 against 1.01/1.07 tok/s, link and CPU
  unchanged. No effect. (hp-03's CPU is UNMEASURED: its window fell outside the sampled interval.)

**Where that leaves 15 tok/s.** A token has 66.7 ms. The masked lane needs 140 exchanges, each measured at 5.3-5.8
ms end to end, and the TPU's own weight streaming across 140 separate invocations is 150-290 ms per token before
any masking. Rows per exchange are nearly free on the TPU but not on the link or the pads, so speculation buys
nothing net. Every knob measured today (int4, threads, pools, polling, link spinning, drafter, huge pages) moves
the rate by tens of percent at most. The only structure that escapes the per-exchange floor is one invocation per
token, which needs the whole graph inside the trust boundary -- the TPU assigned to the pVM, which the AVF app API
does not offer (see "The platform gate is a missing API").

## Auditing "only TPU assignment can reach 15": what is proven, and what was this implementation (2026-09-22/23)

An audit asked for the necessity claim to be separated into measured constraints and assumptions of the 140-exchange
implementation, and for the weakest untested link to be measured rather than argued.

**Proven (measured on this phone, independent of how the lane is written):** an exchange cannot cross a nonlinearity
with additive masking, so a block needs four round trips (the 3-exchange composition exists and was measured worse);
the TPU invocation floor is ~0.52 ms and the per-MB streaming slope 0.0848 ms; the vsock round-trip floor is ~0.42-0.9
ms (exbench below); a pad costs the VM the MACs of the projection it protects, though it can be prepared ahead.

**Assumptions that turned out to be the implementation:** that each extra token row per exchange costs ~2.2 ms of
"transport", so speculation cannot pay. Measured directly:

* `payload/exbench.h` (results/exbench1) times request/reply round trips over the real VM<->app vsock in the lane's
  exact per-row shape, with no TPU and no mask: **1 row 0.87-0.89 ms median, 16 rows 3.1-6.5 ms -- 0.12-0.37 ms per
  extra row.** The boundary is not what makes rows expensive.
* A drafter run with the worker's own counters kept (results/speccross, results/corrjoin): at ~4 rows the VM's wait
  was 11.2 ms, the worker busy 3.5-3.7 ms, and **4.97 ms of the wait was the VM joining its out-of-lane correction**
  (0.55 ms at one row) -- a column walk through the weights, one cache miss per output per entry, repeated per row.
  Subtracting it, the crossing is 2.6 ms, the bare transport. Changing the VM's thread pools did not move it (refuted).
* Rewritten row-major (`payload/tpu_corr.h`: each weight row read once for every row's entries; the same int64 sums
  and the same association, bit-identical by `tpu/test/corr-order-test.cpp`), results/rowmajor, same prompt and text,
  sampled verification <= 1 LSB, CPU windows COMPLETE:

  | | correction join | link / exchange | tok/s |
  |---|---|---|---|
  | one row, before -> after | 0.55 -> 0.03 ms | 5.5 -> 4.74 ms | 1.10 -> 1.23 |
  | MTP drafter (2.85 tokens/step), before -> after | 4.97 -> 2.15 ms | 11.8 -> 7.2 ms | **1.10 -> 1.94** |

**What remains, as budgets.** 15 tok/s at ~2.85 accepted tokens per step allows ~190 ms per step, ~1.36 ms per
exchange; the drafter lane now spends ~10.5 ms per exchange (pad bank drained: masking 1.26 ms; correction join 2.15;
TPU run ~2.0; output read 0.46; crossing ~2.3; VM work between exchanges 1.17). With every implementation term at its
measured floor the int8 lane would still cost ~3 ms per exchange (~6.8 tok/s at this acceptance; ~8.5 with int4-sized
weights). So the necessity claim is sharper than before but not a proof: reaching 15 through masking needs BOTH the
per-exchange cost near its floor AND roughly five accepted tokens per verification pass -- a better drafter or a tree
of candidates over rows that are, it now turns out, nearly free to carry. Those are the open levers.

### Two different "LSB"s in the verification line, classified over every run (2026-09-23)

The kernel verification line reports two things that must not be merged. `max=` is the largest disagreement between
the TPU and the VM's exact recomputation **in digit units** (per digit, hi or lo); `output LSB ... max` is the same
disagreement **in output units**. A 1-unit disagreement on the `lo` digit is worth 0.0098 output LSB; on the `hi`
digit it is multiplied by 256 on recombination and worth 256/102.4 = **2.5 output LSB**. So "max 1" with "output max
2.500" is a hi-digit disagreement, not a <=1-LSB output error, and earlier summaries in this file that called every
difference "<= 1 LSB" were describing the digit metric only.

`results/verify-classification.tsv` classifies every run on disk (137 valid; the two stale-bundle runs excluded):
2,099,200 sampled digit comparisons, 152 disagreements, **none beyond 1 digit unit**; 63 runs with no disagreement, 52
with lo-digit disagreements only (max 0.0098 output LSB), **22 with at least one hi-digit disagreement (2.5 output
LSB)** -- among them combo2's cc-04 and cc-05, and runs from before this week's changes (thread-sweep t1/t6, i8-e),
so it is not new. qc7's 13 happened all to land on `lo`.

Against the established analysis (`tpu/test/error_bound.py`): an ideal requantiser bounds the unmasked error at 1.756
output LSB; if the backend may deviate by up to one unit per digit, the bound is 4.26 output LSB, and that figure is
CONDITIONAL on |delta| <= 1 holding for every output. A hi-digit 1-unit disagreement is exactly such a |delta| = 1
case, so these samples are inside the conditional bound -- and the only evidence for |delta| <= 1 is still SAMPLED
(one element per projection per exchange), with the turn refused beyond it. Task quality has to be measured on the
configuration in use, not inferred from this.

### Where the masked lane stands after the audit (2026-09-23)

Same model, same masking and verification, every run fail-closed-driven:

| | tok/s (one 57-token prompt) | contract set | CPU (COMPLETE windows) |
|---|---|---|---|
| start of the audit (int8, one row per exchange) | 1.10-1.23 | 24/24 (qc7) | ~2,000 core-ms/token |
| MTP drafter + row-major correction + corr_threads 3 + bank 128 | 2.38-2.55 | 24/24 (results/qspec1) | ~2,000 |
| + parallel unmask on the helpers (fail-closed self-check) | 2.55-2.61 | 24/24 (results/qspec2), self-check 1,848/1,848 | ~2,030 |

A ~4-row exchange now costs ~7 ms: masking 0.29, the worker ~2.5 (TPU run 1.78, output read 0.45), crossing ~2.2 (the bare
transport's median under this load), unmask 0.71, the VM's graph work between exchanges 0.88. None of those is a single
code-level walk like the correction was; what remains is incremental unless a verification pass accepts many more tokens
(~5 per pass would be needed with every term at its floor). 15 tok/s is not met.

## 2026-09-23: what transferred from the Shielded-27B session (TRANSFER-27B.md)

The item-by-item inventory is in `TRANSFER-27B.md`. The outcomes that change this lane:

* **Both samplers were aliased, the 27B's REPORT 18.38 defect.** A decode pass is exactly 140 exchanges. The
  parallel-unmask self-check (`exchanges % 16`) replayed only kind-0 exchanges; the kernel verification
  (`exchanges % n_out`) recomputed only one residue mod 4 of each projection's outputs, at an index the worker could
  predict. `payload/tpu_sample.h` stratifies both per group with first-visit checks and a VM-secret walk
  (`tpu/test/sample-cover-test.cpp`). On the phone (results/smp1, ABBA against the previous APK): 560 self-checks per
  turn instead of 175-184, 0 mismatches, the same text, verification unchanged; cost +2.1 % time and +1.2 % CPU per
  decode step on a 57-token turn (first visits; they amortise). The verification is still one output per projection
  per exchange: a drift detector with coverage, not a defence against a selectively lying worker.
* **The app's defaults were the old baseline.** Every optimisation since 09-22 was switched on by launch extras.
  anchor-smp2.apk defaults the measured profile on the TPU lane (see TRANSFER-27B.md, "Defaults").
* **Inapplicable:** the delta-net in-place conv (Gemma 4 E2B has no recurrent layers), equality pad-independence
  (this lane's requantised worker product makes it pad-dependent by construction, as established above), the
  lost-wakeup fence (our pool is mutex + predicate waits).

### Rejected on arithmetic: fusing exchanges through the RMSNorm scalar (2026-09-23)

Each RMSNorm between two projections is a per-row scalar, so `W_gu * norm(x + postnorm(W_o a))` can be computed as
`(W_gu' x + W_gu'' W_o a / rms(o)) / rms(h)` with every matmul known before the scalars: o-proj + gate/up in ONE
exchange, and down + the next block's qkv in another, 70 exchanges per pass instead of 140. It is exact in the reals
and needs no new masking. It does not pay: the fused matrices (`W_gu W_o`, `W_qkv W_down`) raise the TPU's MACs per row
from 1836 M (matches mac_share.py) to 4384 M, 2.39x, and the TPU run is weight-bound. On the 09-23 split (7.0 ms per
exchange at 4 rows, 1.78 ms of it the TPU run) the pass goes 980 -> 961 ms: 2.65 -> 2.71 tok/s. A prediction from the
real bundle geometry, not a measurement, and not worth one.
