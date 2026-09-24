# Milestone 3 on the Pixel 10: a portable component reaches the verified in-VM model through wasi:nn (2026-09-23 21:07)

Build rt4 (sha256 `586d32ee…`). `cpu/app-nn-run.sh`: `--es mode app --es app_graph gemma-4-e2b-it-q4_0`, the model conformance
component `runtime/conformance/bundles/nn-v1.wasm` (sha256 `c916cfc9…`) from the app's files. The VM staged and verified the
model (whole-file digest against the pin, every tensor hashed before use), the CPU engine loaded it and ran the tier's
self-test on its own path (signed CAPS report), then handed the model to pvm-rt as an ops table; the component, compiled to
Pulley in the VM, reached it only through `wasi:nn@0.2.0-rc-2024-10-28`. `check-app-nn.py results/app-m3` -> **PASS**
(check.txt):

- **parity**: the component ran the same self-test (the same prompt, `<bos>` named in the text because the tokenize verb adds
  none; greedy, first maximum) and its digest `9c4c7f764bf657c708cb19c6493a0be303db49093fd7df1432664cfd3801ce2f` equals the
  engine's own in the same VM, on the same model load -- and the native reference (PVM-CPU.md, parity). 32 prompt tokens,
  64 generated, the text is the expected factorial code;
- **refusals** (an-refusals, 12 of 12): an unknown graph, the component's own weights (`load` from bytes), a second
  execution context while one is live, token ids out of range and negative, a non-I32 and a short tensor, an empty one,
  an input beside "tokens" the server would read differently ("all"), an unknown verb ("caps"), no inputs; and a new
  context once the first is dropped is served.

Speed of the app path: 10.71 tok/s decode (prefill 242 ms for 32 tokens) against the engine's own 14.04 tok/s in the same
run: ~22 ms per token for the 262,144-float logits crossing into the guest and a Pulley argmax over them. The server
contract's `topk` verb (host-side top-k) is the remedy when an app needs the difference. Load: read 37.6 s, hash 2.4 s,
place 2.0 s (60.6 s total). The first check run failed three items on a checker bug (it read the CAPS line as one hex field
where it is `CAPS <report> <signature>`); fixed, the same captures pass.
