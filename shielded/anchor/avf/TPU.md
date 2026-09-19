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

**Where that leaves it.** Best measured Shielded-TPU decode: **1.1-1.2 tok/s**. With every remaining inefficiency removed
(unmask and mask to ~0.1 ms) the floor is the TPU's own 0.38 s per token plus 0.15 s of vsock: under 2 tok/s. The same VM
decodes the same model on its own CPU at 12-15 tok/s with no pads at all (LOCAL.md), so on this phone the split costs
about 10x and buys nothing: the desktop case for Shielded is a worker that is far faster than the enclave's CPU, and that
does not hold for a 2B model on a Tensor G5 (pads are no longer the obstacle: the batched minter makes them cheap). The lane is still the
right tool where rows amortize: prefill (128 rows per exchange), if long prompts ever need it.
