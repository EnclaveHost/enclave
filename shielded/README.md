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
reference/shielded_ref.py     executable oracle for the constructions (numpy, no CUDA)
protocol.py                   worker admission rules: framing, op allowlist, output gating
bench/field_gemm_bench.py     GPU field-GEMM kernel ladder (needs a CUDA torch)
bench/refill_bench.py         CPU mask-refill ceiling -- the tier's binding constraint
SECURITY.md                   per-op leakage argument, per-interface residual leakage
REPORT.md                     measured results and what they mean for the tier
```

Nothing here ships or runs on the fleet. The oracle and protocol modules are correctness and
security artifacts: they execute the claims the design rests on so they can be re-run rather
than re-read, and they are the reference the engine will be validated against.

```
python3 reference/shielded_ref.py --verbose      # human-readable oracle dump
python3 protocol.py                              # worker admission selftest
python3 bench/field_gemm_bench.py --quick        # GPU ladder (CUDA required)
python3 bench/refill_bench.py --verbose          # CPU refill ceiling
node --test ../test/shielded-*.test.mjs          # assertions we must not regress
```

## What is coming (and where it plugs in)

- **The worker** lands here: a stateless CUDA process derived from the ggml-rpc server,
  hardened per the design's protocol table (GRAPH_COMPUTE becomes an allowlisted
  GRAPH_INSTALL, GET_TENSOR restricted to declared outputs, no on-disk cache). Dockerfile
  with a digest-pinned CUDA base, following `worker/Dockerfile`. Registered in
  `scripts/release.sh` and the `deploy.yml` detect case when it first ships.
- **The TEE-side executor** does NOT land here — it belongs in the wasmtime patch stack
  (`wasm/`) and the ELL shim, because that is where the ggml graph lives.

The worker is deliberately outside the measurement and runs no TEE. The operator can replace
it wholesale; its honesty is enforced by Freivalds verification, not by attestation. That is
the design, not a gap.

## The two rules most likely to be broken by accident

1. **Masks are one-time.** Bank exhaustion must stall the request, never wrap. A wraparound
   is not a slowdown — it is pad reuse across two activations, which hands the adversary
   their difference.
2. **KV-producing matmuls verify strictly, before insertion.** A corrupted activation costs
   one token; a corrupted cache entry poisons every future token that attends to it.

Both are asserted in the test suite.
