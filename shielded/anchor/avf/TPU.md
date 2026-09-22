# Shielded-TPU decode: the phone's TPU as the untrusted worker

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
token**. It would also halve the 1757 MB lane bundle, which matters twice over: that bundle is evictable
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
| GPU across the boundary, masked | ~2.67 tok/s | same 140 round trips; a 198 us submit floor against the TPU's 637 us moves almost nothing |
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
