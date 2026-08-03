# specbench - the speculation measurement harness (mm7-mm23 campaign)

The scripts that produced every number in docs/speculative-decoding-handoff.md,
persisted so future engine/pin bumps can be gated against the shipped wins.

## The discipline (violate any of these and the numbers lie)

1. **Never conclude from one fleet sample.** Identical configs range 55-70
   tok/s; run >= 3 and report the spread. Effects < ~4 tok/s are noise.
2. **Plain-decode guard first on shared boxes.** Daytime kryptos windows are
   contended; a plain leg that swings below ~60 invalidates the window.
3. **Golden gate before perf.** Temperature-0 transcripts: plain must be
   byte-identical across engine builds (fgold-plain-legacy vs the archived
   mm14 transcript); speculative configs legitimately differ from plain on
   the FLEET (topk sparse rows) but must match plain byte-for-byte LOCALLY
   (full rows).
4. **Verify pins with asserting scripts, never bare sed** (a silent no-op
   once nearly mislabeled a whole engine build).
5. **Space pushes to main >= 3 min** (two releases close together wedge the
   Tinfoil updater; recovery = fleet-op stop->start).
6. **Suspend the bench when done** - it bills by the hour.
7. **Local CPU golden runs prove correctness, never fleet perf** (CVM vCPUs
   run llama's CPU path 10-1000x slower; GPU exec hides differently).

## Scripts

- `ab-serve.sh` - one local serve+probe leg. Env: BIN (wasmtime), LIB
  (shim/lib farm), CFGKIND (plain|lookup4|mtp4|mtp4think|mtpplain), PORT,
  PROMPT, TAG, RS (nnRsSeq depth, empty=off), NGL (99 gpu / 0 cpu), NCTX,
  WASM (llm_chat.wasm path). Emits TAG/sha/len + draft stats; transcripts
  land next to the script. Byte-compare shas across engines/configs.
- `fleet-bench.sh golden|multi` - the bench-deployment harness (resume ->
  config legs -> parsed done-frames -> suspend). CFGS env overrides the
  config list for `multi`. Uses the throwaway wallet key
  (~/.config/enclave/key) and the bench deployment ID inside the script -
  update both when the bench changes.
- `cfg-*.json` - the measured configs. `nnRsSeq` is the per-deployment
  snapshot-depth knob (rewind-commit speculation); k=4/depth-4 is the
  measured lookup sweet spot, both k directions closed.

## Interpreting done-frames

`tok_per_s`, `draft_tokens`/`draft_accepted`, `verb_us` (per-verb splits:
feed_all#decode = verify cost; #gbuild/#galloc ~0.3 ms = llama graph reuse
holding), `sync_ms`/`sync_calls` (mm20), `gperf_ms` {build alloc input mem
comp out out_get} (mm21/22 - out_get ~= the driver-forced synchronous D2H
= the GPU exec wait; see the handoff's final token-cost model).

## Dependencies

- `session.mjs` mints an owner SIWE bearer from ~/.config/enclave/key
  (throwaway wallet). Needs `viem` resolvable from its directory
  (`npm i viem` in tools/specbench, or run it from a dir that has it).
  Bearers expire ~1h; fleet-bench re-mints per leg.
- Local legs need: a wasmtime built from the patched tree (see
  wasm/Dockerfile.wasmtime for the patch order), a lib farm (llama libs +
  the shim, SONAME links included), local GGUFs under
  ~/Projects/enclave-models, and for CUDA builds on Arch the clang-CUDA
  CMake flags recorded in the handoff (clang++ + --cuda-path).
