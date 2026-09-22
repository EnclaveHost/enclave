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

| rows | drafts | predicted | measured |
|---|---|---|---|
| 1 | 0 | 1.22 | **1.22** |
| 2 | 1 | 1.46 | **1.42** |
| 5 | 4 | 1.18 | **1.18** |

**1.42 tok/s at two rows is the fastest masked decode measured on this phone**, 16 % over one row and
well clear of the leaky k=8 lane's 1.20. The reason deep speculation loses is the same one REPORT 16.8
gives for the 27B (`k=1/2/3 -> 17.67/14.83/15.41`): a drafted row costs a full `C` whether it is accepted
or not, and accepting one saves only `W`. Here `C` is 36 % of a one-row token, so the fourth and fifth
rows are paying 219 ms each for acceptance probabilities of 0.09 and 0.05.
