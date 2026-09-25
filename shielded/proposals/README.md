# Proposal: stop benchmark and test-harness files under `wasm/` from cutting releases

**Status: PROPOSED, NOT APPLIED.** It now lives as its own reviewable change on branch
`deploy/wasm-noninput-exclusion` (f6c85c84, draft PR) with
`test/deploy-wasm-noninput.test.mjs`: positive and negative checks through deploy.yml's
own detect block, and guards that fail if any Dockerfile, the metal build or a workflow
starts reading an excluded path. `.github/workflows/deploy.yml` on this branch and on
main is untouched.

## The problem

`deploy.yml`'s detect step maps every changed path under `wasm/` (any depth) to
`wasm=true`: sidecar image rebuild -> digest repin -> `releasing v0.5.N` ->
`tinfoil-release-publish` -> `update-fleet`. On 2026-09-23 seven pushes to main
that changed only benchmark sources, CPU-kernel test harnesses and patch records
under `wasm/` each cut and published such a release (v0.5.832-835, 837-839, GPU
and CPU flavours, `update-fleet` succeeded), with no runtime change.

## What the source says is not an image input

- `enclave-wasm-manager` is built by `scripts/release.sh` with context `wasm/` and
  `wasm/Dockerfile.wasm`. The only files it copies out of that context are
  `llamacpp-parallel-copy.patch`, `apps/nn-demo.wasm`, `wasm_manager.py` and
  `ipfs_fetch.py`; everything else comes from pinned images or is fetched by
  commit. Docker puts only COPY/ADD sources into an image.
- `metal/build-image.mjs` compiles a fixed list of sources from `wasm/ggml-shielded`
  and globs only its `*.h`. `bench-spec.cpp` and `bench-batch.cpp` are explicit,
  non-default Makefile targets (`all` does not build them).
- Nothing outside documentation references `wasm/llamacpp-conv-inplace/`.

## The proposal

`deploy-yml-wasm-noninput-exclusion.patch`: two case arms before `wasm/*)`, so
`wasm/llamacpp-conv-inplace/*` and `wasm/ggml-shielded/bench-{spec,batch}.cpp` no
longer set `wasm=true`. Deliberately NOT excluded: any `wasm/*.patch` (some are
toolchain inputs, and one is copied into the image), the shielded backend's
sources, the shim, the Dockerfile. `git apply --check` passes against deploy.yml
at origin/main 56e086ba.

## Evidence

`simulate-deploy-detect.sh DEPLOY_YML PATH...` runs deploy.yml's own `case` block,
extracted verbatim, over paths. Current vs proposed:

- benchmark/harness paths (8, e.g. `wasm/ggml-shielded/bench-spec.cpp`,
  `wasm/llamacpp-conv-inplace/graph-slot-check.sh`): `wasm=true` -> `wasm=false`;
- the three llama.cpp patch records on this branch: `wasm=true` in both;
- must-trigger inputs (`wasm_manager.py`, `ipfs_fetch.py`,
  `llamacpp-parallel-copy.patch`, `Dockerfile.wasm`, `apps/nn-demo.wasm`,
  `ggml-shielded.cpp`, `shielded-tee.c`, `ggml-shielded/Makefile`,
  `llama-shim/enclave_llama.c`): `wasm=true` in both.

So even with this applied, merging `perf/shielded-27b-wrapup` still triggers a
release, because it changes three `wasm/*.patch` files.
