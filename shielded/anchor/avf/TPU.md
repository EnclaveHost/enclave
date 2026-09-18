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
This is statistical hiding with ratio k (default 8), not a modular one-time pad: the TPU's FC saturates instead of wrapping.

## Pieces

| piece | where | notes |
|---|---|---|
| calibration | `tpu/calibrate.py` | fp32 checkpoint on real chats: per-input-channel q99.9 and max of \|x\|, max \|W x\|, keyed by GGUF tensor names |
| artifacts | `tpu/make_graphs.py` | from the **f16 GGUF**: `L<n>.tflite` (signatures qkv/o/gu/down, 5 rows, int16 in/out, authored as flatbuffers) + `lanes.etpu` (the VM's bundle: the SAME int8 bytes, scales, lanes). Then AOT-compile each layer for the Tensor G5 |
| VM backend | `payload/ggml-tpu.cpp`, `ggml-tpu.h` | masks, exchanges, unmasks, pad bank, stats; also the exact reference worker |
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
threads (about 9 positions per second), minted before READY. Boot: bundle into the VM 49 s once (1.76 GB), model load 50 s.

## The four levers, measured (2026-09-18, same phone)

| lever | what was done | result |
|---|---|---|
| 4. cost of one TPU invocation | micro-benchmark inside the worker (`TpuWorker.nativeBench`): every signature of two blocks, back to back and with 3 ms idle gaps | **0.9 ms fixed + about 0.13 ms per MB of int8 weights**: qkv 1.5, o 1.8, gate+up 3.4 (6.3 in the double-wide blocks), down 2.7-4.2 ms. Idle gaps add about 0.5 ms. It is weight streaming, not dispatch overhead: 0.37-0.45 s per step however the step is cut |
| 1. fewer exchanges (fold the norm scalars, 4 -> 2 per block) | evaluated against lever 4's cost model, NOT built | a merged exchange needs fused product matrices (W_gate diag W_o: +25 MB per block, +50 MB in the wide ones; W_q' diag W_down: +16-25 MB). At 0.13 ms/MB that is +3 to +6.5 ms of streaming to save one exchange worth about 3 ms: break-even at best on this TPU |
| 3. unmask cost | the correction for entries beyond their lane walks a COLUMN of a row-major int8 matrix. A column cache did nothing (the overflowing channels are not a hot few: 7,490 distinct columns for 11,665 entries) and would have grown without bound; software prefetch is what is in the code | about 0.2 ms per overflowing entry remains (a TLB miss per element under two-stage translation): 1.6 ms per exchange at 7 entries (one row), 6.8 ms at 33 (five rows). The real fixes are a column-major copy of the weights (+1.76 GB) or fewer overflows (more calibration text, a wider margin) |
| 2. more tokens per step | Google's `gemma-4-E2B-it-assistant` drafter (154 MB f16 GGUF, llama.cpp's own speculative helper, `--es draft`), 4 proposals = the 5 rows the graphs already take; the drafter is unauthenticated on purpose (the target verifies every proposal) | works, text coherent, 1.64-1.84 tokens per step on the phone (2.3-2.8 on a workstation with the Q8_0 target). **But a 5-row step costs 1.96 s against 0.83 s for one row**: rows are free on the TPU and nowhere else (5x the bytes on the link, 5x the rows to mask and unmask, 5x the overflow entries). Net 0.80 tok/s against 1.09 |

**Pads are the other half of the cost.** Minting `W r` is the same integer MACs as the matmul it protects: 0.11-0.17 s per
token position on six threads, 2.9 MB each (int16). Banked before READY they are free at decode time and cost memory
(230 positions = 0.67 GB; a 320-position int32 bank got the VM OOM-killed). Minted during decode (`refill=N`) they keep
the bank full, and four busy minters slowed the link from 4.3 to 7.7 ms per exchange, because busy vCPUs starve the vsock
path on this phone. Five rows per step consume five positions per step.

**Where that leaves it.** Best measured Shielded-TPU decode: **1.1-1.2 tok/s**. With every remaining inefficiency removed
(unmask and mask to ~0.1 ms) the floor is the TPU's own 0.38 s per token plus 0.15 s of vsock: under 2 tok/s. The same VM
decodes the same model on its own CPU at 12-15 tok/s with no pads at all (LOCAL.md), so on this phone the split costs
about 10x and buys nothing: the desktop case for Shielded is a worker that is far faster than the enclave's CPU and pads
that are dealt rather than minted at decode time, and neither holds for a 2B model on a Tensor G5. The lane is still the
right tool where rows amortize: prefill (128 rows per exchange), if long prompts ever need it.
