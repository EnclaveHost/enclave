# shielded/ — masked GGML offload to untrusted GPUs

Design: [docs/shielded-inference.md](../docs/shielded-inference.md).

This tier runs inference on a GPU whose host operator is fully untrusted — root, PCIe/DMA
visibility, VRAM reads, freedom to replace the GPU-side runtime. Prompts, activations, KV
cache, and sampling state never exist in plaintext outside the SEV-SNP CVM. Weights are
public (open-weight catalog models only); weight secrecy is a non-goal.

It is the successor to the "Layer 4" caveat in `worker/worker.py`: there, freed VRAM is not
zeroed and residual-data scrubbing is unimplemented. Here that caveat dissolves, because
nothing reaching VRAM is plaintext. Ghost data is ciphertext by construction, not by
scrubbing.

## What is here now

```
field.py                      the RNS field + THE shared weight encoding (numpy only)
reference/shielded_ref.py     executable oracle for the constructions (numpy, no CUDA)
protocol.py                   worker admission rules: framing, op allowlist, output gating
wire.py                       the socket layer: framing, pipelined exchanges
worker.py                     the REFERENCE worker (Python + Triton). Untrusted host, holds the card.
worker-cuda/worker.cu         THE PRODUCTION WORKER (C++/CUDA): same protocol, same admission
                              rules, one frame per exchange, ~80 us per exchange on loopback
tee.py                        the trusted half: weights, mask bank, refill, Freivalds
model.py                      TEE-side executor: a real transformer, linears offloaded
tokenizer.py                  byte-level BPE, TEE-side (it consumes the prompt)
pack.py                       GGUF -> shielded pack (host-side, offline, public)
calibrate.py                  per-site activation exponent + outlier set (public, offline), qwen2 only
export-calib.py               that .npz -> the flat text the engine backend reads
../wasm/ggml-shielded/shielded-calib.cpp
                              THE CALIBRATOR for the engine backend: any q8_0 GGUF libllama runs,
                              observed through the real graph, weights encoded exactly as the runtime does
e2e.py                        the end-to-end run, and the equivalence test
kernels/fused_field_gemm.py   GPU field-GEMM kernel (fused CRT, in-kernel dequant)
bench/field_gemm_bench.py     GPU field-GEMM kernel ladder (needs a CUDA torch)
bench/refill_bench.py         CPU mask-refill ceiling
SECURITY.md                   per-op leakage argument, per-interface residual leakage
REPORT.md                     measured results and what they mean for the tier
```

The guest half of the metal integration lives outside this directory, because it
ships inside the measured CVM image rather than beside the worker:

```
metal/guest/shielded.mjs        the CVM's client: field, pads, refill, Freivalds
metal/guest/shielded-probe.mjs  one real masked GEMM, asserted four ways, at boot
```

And the engine-side half lives with the engine, because it is linked into it:

```
wasm/ggml-shielded/shielded-field.c   the field + THE encoding, in C (native q8_0 row layout)
wasm/ggml-shielded/shielded-wire.c    the protocol: FIELD_GEMM, one frame each way; TCP or vsock
wasm/ggml-shielded/shielded-tee.c     the pad POOL (background refill threads), Freivalds, the link
wasm/ggml-shielded/shielded-simd.c    the hot loops, built twice (AVX-512 VNNI / generic), self-checked
wasm/ggml-shielded/ggml-shielded.cpp  the ggml backend: groups shared-x matmuls, places by policy
wasm/ggml-shielded/shielded-probe.c   the C probe, same four assertions as the JS one
```

## How it goes fast, and what the numbers are

Decode is a chain of ~2 exchanges per layer that cannot be pipelined (each layer's
input is a nonlinear function of the previous layer's output), so the token cost is
`exchanges x cost-per-exchange` plus whatever else sits on that chain. The first
end-to-end engine run measured **612 ms/token**; the same model, same card, now
decodes at **6.5 ms/token (154 tok/s) on the host loopback**, against 7.0 ms/token
for plain llama.cpp on 8 CPU threads. Four changes, in order of size:

1. **Refill left the critical path.** `u = r.W` costs the TEE three residue planes of
   work per offloaded MAC, and it was computed AFTER each reply, scalar: 90% of the
   token. It does not depend on the activation, so `shielded-tee.c` now keeps a pool
   of (r, r.W) pairs per activation group, filled by background threads with an
   AVX-512 VNNI kernel (`vpdpbusd`, u8 residues x s8 weights). Steady-state pool
   misses on the request path: 4 in 4707 exchanges.
2. **One frame per exchange, no interpreter.** The Python worker took five framed
   commands per exchange through torch and a Triton launch: 0.35 ms each. The C++
   worker takes one `FIELD_GEMM` frame, one H2D copy, one dp4a GEMV per node with the
   CRT fused in the epilogue, one D2H copy: ~80 us. Weights live on the card as the
   encoded int8 matrix in GGUF's own row-per-output layout, so nobody transposes.
3. **Shared-activation matmuls are one exchange.** gate/up (and q/k/v) read the
   same x, so they share one pad by rule and now share one round trip by
   construction: 49 exchanges per token instead of 169.
4. **Placement is a policy, not a reflex.** A round trip has a floor cost, so a
   matmul under `SHIELDED_MIN_MACS` (2M) stays on the CPU (Qwen2.5-0.5B's attention
   projections), and a batch wider than `SHIELDED_MAX_M` (8) stays in the enclave:
   prefill in the clear costs one pass over the weights, prefill offloaded costs the
   TEE three. Offload is a decode accelerator; it removes the weight-bandwidth term
   from the latency chain and nothing else.

A second round (REPORT.md section 13) took the same model from 6.3 to 4.6 ms/token on
the host loopback: the worker replays each exchange as one captured CUDA graph into
mapped host memory (the fixed per-exchange GPU cost fell from ~40 us to ~4), the kernel
streams four weight rows per warp so batched rows (m up to 8) no longer collapse its
bandwidth, the TEE uses pool pads in place and verifies in the same pass that unmasks,
an exchange for part of a shared-activation group fetches the whole group's products
so a ggml split boundary costs no extra round trip or pad, and the backend reconnects
after a worker restart instead of falling to the int64 path for the rest of its life.

Inside the CVM the link prefers AF_VSOCK to the host (CID 2, same port) when the
guest has `/dev/vsock`, and falls back to slirp TCP. On metal0's deployed eyesoff.ai
instance that measures **99-105 tok/s decode, 2.2 s to first token**, from 1.7 tok/s
and 28 s before (REPORT.md section 11).

```
make -C shielded/worker-cuda                      # the CUDA worker (clang++ as the CUDA compiler)
shielded/worker-cuda/shielded-worker --port 9500 --vsock-port 9500
SHIELDED_PROFILE=1 wasm/ggml-shielded/shielded-run model.gguf "prompt" 32   # per-phase ms
```

```
python3 field.py                                 # cross-language encoding vectors
python3 reference/shielded_ref.py --verbose      # human-readable oracle dump
python3 protocol.py                              # worker admission selftest
python3 tee.py                                   # trusted-half selftest (no GPU)
python3 worker.py --port 9500                    # the worker (needs CUDA)
python3 bench/field_gemm_bench.py --quick        # GPU ladder (CUDA required)
python3 bench/refill_bench.py --verbose          # CPU refill ceiling
node --test ../test/shielded-*.test.mjs          # assertions we must not regress

make -C ../wasm/ggml-shielded                            # field/wire/tee + the C probe
make -C ../wasm/ggml-shielded ggml                       # + the backend (needs a ggml checkout)
make -C ../wasm/ggml-shielded calib GGML_LIB=... LLAMA_INC=... GGML_INC=...   # the calibrator (needs libllama)
../wasm/ggml-shielded/shielded-calib --lib-dir $LIB model.gguf model.calib      # (or --backend $LIB/libggml-cpu.so)
SHIELDED_CALIB=model.calib ../wasm/ggml-shielded/ggml-test
```

### Which calibrator

`shielded-calib` (C, `wasm/ggml-shielded/`) is the one that produces the files in
`metal/shielded-overlay/calib/`. It has no model of the model: it runs the real engine over
the calibration texts with `llama_context_params.cb_eval` (the hook llama-imatrix uses),
captures the activation of every matmul the backend could claim, encodes each weight with the
backend's own `sh_prepare_weight_rows` (per output column, `-ffp-contract=off`, the same
object file), and chooses `(act_frac, outliers)` exactly as `calibrate.py` does. So it
calibrates whatever libllama can prefill -- qwen2, qwen3, qwen35's hybrid deltanet with its
fused `attn_qkv` and `ssm_*` linears -- and its exponents are for the product the runtime
actually forms, which is why the backend's `SHIELDED_AF_DELTA` now defaults to 0. It also
reports, from the graph rather than from names, which sites share one activation, and a
site that cannot reach the headroom target even at the smallest exponent is LEFT OUT (it
stays in the enclave; `--keep-tight` includes it, and then a wider input than the
calibration text wraps the field there and the request dies). ~7 s for a 0.5B model,
~1 min for a 4B, on 16 threads.

The file's first line carries a format version, and the backend reads it: `# shielded-calib 2`
is this tool's output (exponents against the per-column encoding, applied as written);
`# shielded-calib 1` is `export-calib.py`'s (exponents against the per-tensor encoding), to
which the backend applies the historical -5 itself. Either file works; only the correction
differs, and it is no longer something an operator has to remember to set.

`calibrate.py` + `export-calib.py` are the reference-stack path: they calibrate a `pack.py`
pack for `model.py`/`e2e.py`, and their numbers are against `tee.py`'s per-TENSOR weight
encoding. Use them for the Python oracle only; a file they produce is 1-6 bits too generous
per site for the engine backend, which is what the format-1 correction above pays for.

## Running it end to end

```
python3 pack.py model.gguf /path/pack.npz        # once, offline, on the host
python3 calibrate.py /path/pack.npz --verbose    # once, offline, on the host
python3 worker.py --port 9500                    # on the box with the card
python3 e2e.py /path/pack.npz --port 9500        # the enclave side
```

`e2e.py` runs each prompt twice -- once with the GPU attached, once with the
offload replaced by a local integer matmul -- and requires the two token streams to
be **identical**. Slalom recovery is exact in Z_M, so anything short of bit-equality
is a bug, and a tolerance would hide precisely the bugs the test exists to catch.

Measured on an RTX 3070 with Qwen2.5-0.5B-Instruct: 501 MiB of public weights
resident on the card, 169 offload nodes, 48.7 GMAC offloaded across 6402 round
trips, **0 verification failures**, and output identical to the in-TEE reference on
every prompt. Peak |y| reached 2.1e6 against M/2 = 7.2e6.

## What is coming (and where it plugs in)

- **The production worker** exists (`worker-cuda/`); what it still lacks is a
  digest-pinned fleet image, following `worker/Dockerfile`, registered in
  `scripts/release.sh` and the `deploy.yml` detect case. `worker.py` stays as the
  reference and the test fixture; both speak protocol 1.2 (1.1 plus FIELD_GEMM24,
  the same exchange with 3-byte reply values -- every product is below 2^24 -- which
  the TEE takes when the worker's HELLO offers minor >= 2; SHIELDED_REPLY32=1 keeps int32).
- **The TEE-side executor for the real engine** does NOT land here -- it lives in
  `wasm/ggml-shielded/`, because that is where the ggml graph lives. `model.py` is
  its specification and its equivalence reference: it is a working implementation
  of the same op placement, and the C backend has to reproduce its output bit for
  bit. That backend now EXISTS and is verified against a live worker; what it has
  not yet done is drive a whole model through the ELL engine.

The worker is deliberately outside the measurement and runs no TEE. The operator can
replace it wholesale; its honesty is enforced by Freivalds verification, not by
attestation. That is the design, not a gap.

## The rules most likely to be broken by accident

1. **Masks are one-time.** Bank exhaustion must stall the request, never wrap. A
   wraparound is not a slowdown -- it is pad reuse across two activations, which
   hands the adversary their difference.
2. **KV-producing matmuls verify strictly, before insertion.** A corrupted
   activation costs one token; a corrupted cache entry poisons every future token
   that attends to it.
3. **Verification must be done over the INTEGERS, not mod M.** A product that
   exceeds M/2 wraps and is still congruent to x*W mod M, so the oracle's mod-M
   Freivalds accepts it and the value decodes to garbage with no error signal. The
   check in `tee.py` uses an unrelated prime for exactly this reason and catches a
   lying worker and a field wrap in the same two dot products.
4. **The activation exponent is a public model constant, never per-request.**
   Adapting it to the activation in hand would buy field headroom by leaking
   activation magnitude. `calibrate.py` fixes it offline from public text; the
   runtime never touches it.

All four are asserted in the test suite.
