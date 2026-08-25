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
worker.py                     THE WORKER. Untrusted host, holds the card.
tee.py                        the trusted half: weights, mask bank, refill, Freivalds
model.py                      TEE-side executor: a real transformer, linears offloaded
tokenizer.py                  byte-level BPE, TEE-side (it consumes the prompt)
pack.py                       GGUF -> shielded pack (host-side, offline, public)
calibrate.py                  per-site activation exponent + outlier set (public, offline)
export-calib.py               that .npz -> the flat text the engine backend reads
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
wasm/ggml-shielded/shielded-field.c   the field + THE encoding, in C
wasm/ggml-shielded/shielded-wire.c    the protocol, pipelined into one RTT
wasm/ggml-shielded/shielded-tee.c     pads, refill, Freivalds, the worker link
wasm/ggml-shielded/ggml-shielded.cpp  the ggml backend: claims linear ops, nothing else
wasm/ggml-shielded/shielded-probe.c   the C probe, same four assertions as the JS one
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

python3 export-calib.py model.calib.npz > model.calib   # for the engine backend
make -C ../wasm/ggml-shielded                            # field/wire/tee + the C probe
make -C ../wasm/ggml-shielded ggml                       # + the backend (needs a ggml checkout)
SHIELDED_CALIB=model.calib ../wasm/ggml-shielded/ggml-test
```

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

- **The production worker**: this one is Python driving a Triton kernel, which is
  the same code path the report benchmarked and is fine for a reference and for a
  single box. A fleet worker is the same protocol in C++/CUDA with a digest-pinned
  base image, following `worker/Dockerfile`, registered in `scripts/release.sh` and
  the `deploy.yml` detect case.
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
