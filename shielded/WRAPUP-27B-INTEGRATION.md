# Shielded 27B wrap-up: integration inventory (2026-09-23)

Branch `perf/shielded-27b-wrapup` (worktree
`/home/steven/Projects/enclave-shield-27b-wrapup`), one commit on top of
`f46e6639`. Checked against `origin/main` at `fcb980c0` (16 commits ahead of the
branch's base, site/brand/pVM only): `git merge-tree --write-tree origin/main HEAD`
is clean, no file is touched on both sides, and the branch uses no retired brand
term. Full record: `REPORT.md` 18.50-18.54.

## 1. Integrated, built, pinned: the state measured on 2026-09-24

The production llama.cpp stack is the tarball `enclave-llamacpp-ddd4ec14-extra-bufts-20260914`
(`ELL_URL` in `wasm/Dockerfile.wasmtime`), built by the llama.cpp Toolchain run
34828607896 at commit 198cb819 on 2026-09-14, inside the enclave-wasmtime image that
`wasm/Dockerfile.wasm` pins as `WASMTIME_IMAGE ...@sha256:13bce266...`. There has been no
toolchain dispatch since. `wasm/Dockerfile.wasm` also rebuilds the dlopened CPU module
itself (its `ggml-cpu-build` stage: LLAMA_COMMIT + `llamacpp-parallel-copy.patch`) and
overwrites the toolchain's copy.

| item | source on main | built into the pinned artifacts | live |
|---|---|---|---|
| toolchain patches graph-slot (original), cuda-graph-ptr-update, sync-instr, rs-pin-cells, topk-rows, parallel-copy | yes | yes (applied by the 198cb819 run; files unchanged since) | yes |
| `llamacpp-parallel-rows.patch` (decode +12% on the shielded 27B, CPU-internal) | yes, since 2026-09-21 | **no** | **no** |
| `llamacpp-rs-inplace.patch` (plain +10%, speculative 16.2 -> 19.5 tok/s; touches ggml.h/ggml.c/ops.cpp/llama) | yes, since 2026-09-21 | **no** | **no** |
| graph-slot multi-sequence reservation fix | **branch only** (b6a8b669) | no | no |
| shielded backend and worker: graph cache 1024 (`captured-graphs.h`), column split, Freivalds overlap after the defect fix, reply into the registered ring, `claim_reservation`, value-free post-mortems with compile-time-gated plaintext diagnostics, the glibc affinity guard, opt-in placement | yes | compiled from source by `metal/build-image.mjs` when a metal box builds its guest at a `-cpu` tag (not verified on a running box) | as far as metal guests are |
| bench argmax, harness scripts, docs, evidence | branch only | not build inputs | n/a |

So two of the campaign's largest measured wins are on main but not in anything
production runs, and the fix on this branch cannot reach production by merging.

## 1a. The release chain that makes the llama.cpp items live (every step owner-gated)

1. Merge this branch (it touches `wasm/*.patch`, so `deploy.yml` cuts a measured
   wasm release with functionally unchanged image inputs; see prerequisite 1).
2. Dispatch `llamacpp-toolchain.yml` with a fresh tag. The tarball then carries the
   graph-slot fix, `parallel-rows` and `rs-inplace`.
3. Validate that tarball before any pin: `official-graph-slot-check.sh`,
   `official-toolchain-check.sh` (with the candidate removed) and the shielded 27B through
   the official build.
4. Point `ELL_URL` in `wasm/Dockerfile.wasmtime` at the new tag; dispatch the Wasmtime
   Toolchain workflow for a new `enclave-wasmtime` digest.
5. In `wasm/Dockerfile.wasm`, repin `WASMTIME_IMAGE` AND make the `ggml-cpu-build` stage
   apply the CPU-relevant patches the new tarball was built with, in toolchain order:
   `parallel-copy`, `parallel-rows`, `rs-inplace`. `rs-inplace` changes the op
   constructor in libggml-base and its kernel in the CPU module together, so the two must
   match: `test/wasm-cpu-module-patches.test.mjs` fails until that edit is made
   deliberately together with the repin; the stage's `ldd -r` check enforces the link ABI.
6. Push: measured release, publish, `update-fleet`, in a release window.

Shorter option for `parallel-rows` alone: it is CPU-internal, so it can go into the
`ggml-cpu-build` stage on the current pin (the guard allows it), one image release, no
toolchain rebuild. Not done here: it changes the measured image and is a release decision.

## 2. What this branch adds: benchmark, test and evidence only

| path | kind |
|---|---|
| `wasm/ggml-shielded/bench-spec.cpp`, `bench-batch.cpp` | benchmark fix: register-max greedy argmax (identical picks; -2.2 ms per round measured within-run). The engine already selects with a one-branch top-k scan, so this corrects the measurement, not the engine. |
| `wasm/llamacpp-conv-inplace/official-toolchain-check.sh` | test tool: the workflow's tree + a candidate under GCC 11.4 / AVX2 |
| `wasm/llamacpp-graph-slot.patch` | **correctness fix** (section 5): the small-batch slot's reservation now matches the memory context (two added lines of the patch become eleven, plus a header note). Reaches production only through a manual `llamacpp-toolchain` dispatch and a `WASMTIME_IMAGE` repin, never by merging. |
| `wasm/llamacpp-conv-inplace/conv-graph-test.cpp` | `CONV_TEST_KV_UNIFIED=1` (unified KV, as the engine's server contexts use); comment corrected |
| `wasm/llamacpp-conv-inplace/graph-slot-check.sh`, `official-graph-slot-check.sh`, `harness-check.sh` | test tools: the scenario x KV matrix against `LLAMA_GRAPH_SLOT_ALT=0`, its production-toolchain gate, and `run_graph`'s optional scenario argument (messages now name the switch) |
| `shielded/proposals/` | the deploy.yml exclusion as first proposed, with a simulation; now a separate draft PR on `deploy/wasm-noninput-exclusion` with tests (section 4) |
| `test/wasm-cpu-module-patches.test.mjs` | guard: the image's CPU-module stage may apply only toolchain patches, in order, that touch only `ggml/src/ggml-cpu/` (catches `rs-inplace` there without the matching repin) |
| `wasm/llamacpp-gdn-ntsnap.patch`, `wasm/llamacpp-gdn-regrow.patch` | records, NOT APPLIED, with their evidence in the headers |
| `wasm/llamacpp-conv-inplace/README.md`, `shielded/REPORT.md`, `shielded/HANDOFF-27B.md`, this file | documentation |
| `shielded/bench-harness/**` | harness scripts and raw run artifacts |

Apart from the graph-slot fix, which lives in a patch the manual toolchain
workflow applies, nothing on the branch changes the official llama.cpp build, the
shielded backend's runtime code, the worker, masking, Freivalds verification or
fail-closed behaviour.

## 3. Not integrated, and why (exclusions stand)

- `llamacpp-gdn-ntsnap.patch` (streaming-store rollback snapshots): bit-identical
  and faster as an op, but the 27B verify round was ~5 ms SLOWER through the
  official build (19.52 / 19.97 on against 21.05 / 21.40 off; third pair invalid).
- `llamacpp-gdn-regrow.patch` (register row): AVX-512 only, ~55% slower on the
  production AVX2 build (compiled out there), and fork-relative.
- `llamacpp-gdn-tokfuse.patch` (token-fused recurrence): slower.
- `llamacpp-conv-inplace.patch`: bit-identical, throughput neutral.
- `llamacpp-sched-prof.patch`: diagnostic instrumentation only.

## 4. Exact prerequisites for a safe merge to main

1. **A merge to main cuts a production release and repoints the fleet.**
   `deploy.yml` maps every changed path under `wasm/` to `wasm=true` (image
   rebuild -> digest repin -> `releasing v0.5.N` -> `tinfoil-release-publish` ->
   `update-fleet`). This branch changes eleven `wasm/` paths, none of which
   `wasm/Dockerfile.wasm` copies. Merge only with the platform owner's approval
   and a release window, or first land a reviewed `deploy.yml` exclusion for
   non-image `wasm/` paths: branch `deploy/wasm-noninput-exclusion` (f6c85c84) is
   that change with positive/negative tests and input guards. It exempts 8 of this
   branch's 11 `wasm/` paths but not its three `wasm/*.patch` files, so this merge
   would still cut one release. For the record: seven earlier pushes to main from
   this campaign, all harness/patch-record/test files under `wasm/`, each cut and
   published such a release on 2026-09-23 (v0.5.832-835, v0.5.837-839, GPU and
   CPU flavours, `update-fleet` succeeded) with no runtime change.
2. `wasmtime-patch-check.yml` will run (it triggers on `wasm/*.patch`); it
   applies only its own named wasmtime patches, so the two llama.cpp patch
   records do not affect it.
3. `test.yml` runs on the merge; the branch changes no code under test. Local:
   `test/shielded-fault-logs.test.mjs` 4/4, `selftest-harness-check.sh` PASS,
   `git diff --check` clean, `git show --check --format= HEAD` silent.
4. The graph-slot fix (a correctness change in the official toolchain's patch set)
   becomes live only when someone dispatches `llamacpp-toolchain.yml` and repins
   `WASMTIME_IMAGE` in `wasm/Dockerfile.wasm`; that step needs its own review and
   its own release window.
5. Nothing on the branch may be read as a production-quality claim (below).

## 5. Acceptance gaps that remain OPEN

- **Freivalds rejections**: both production rejections (sterms-1, b-eq-1) are
  unexplained. Clean soaks (~35 M exchanges) and the 8.4 M-exchange real-model
  campaign found none, which bounds but does not explain them. Verification
  stays fail-closed; nothing here weakens it.
- **No model-matched quality evaluation** of the 27B shielded encoding.
  `text_identical` and equal token hashes compare the shielded path with itself
  and with plain decode on one prompt; they are not a quality measurement.
- **Multi-sequence abort: FIXED on this branch** (was open). With `n_seq_max = 3`
  and the KV cache per-sequence (llama's default), the first 2-8 token
  single-sequence decode aborted: `process_ubatch -> ensure_slot_alt ->
  graph_reserve -> build_layer_attn -> ggml_mul: GGML_ASSERT(ggml_can_repeat(b, a))`
  (`ggml/src/ggml.c:2263`). `ensure_slot_alt` reserved with `n_seqs = 1` against
  `memory->init_full()`, which spans `n_seq_max` KV streams; stock `sched_reserve`
  never does that. It now reserves with the stream count (1 when `kv_unified`,
  else `n_seq_max`), so unified contexts (the engine's server contexts) keep
  exactly today's reservation. Evidence (0.8B qwen35, CPU; logit dumps' sha256 in
  `bench-harness/results-2026-09-23/graph-slot/`):
  - official tree before the fix (host, `GGML_NATIVE=OFF`): `graph-slot-check.sh`
    FAILS exactly one cell, `multi` with the per-sequence cache (slot-on arm rc
    134; backtrace in `unfixed-multi-abort-backtrace.txt`); the unified-cache `multi` and every other cell pass.
  - after the fix, host build and the production toolchain (ubuntu 22.04, GCC
    11.4, `-mavx -mavx2 -mfma -mf16c -mbmi2 -msse4.2`,
    `official-graph-slot-check.sh`): all 8 cells (plain, spec, lifetime, multi x
    per-sequence and unified KV) finish and are byte-identical to
    `LLAMA_GRAPH_SLOT_ALT=0`.
  - the fixed build's dumps equal the unfixed build's in all 7 cells the old code
    completed; in the aborting cell the unfixed partial dump (21,852,160 bytes) is
    an exact prefix of the fixed one (45,690,880).
  Masking, verification and fail-closed behaviour are untouched: the change is in
  the host-side llama.cpp scheduler's buffer reservation.

## 6. Follow-ups

- The multi-sequence fix is done (section 5); making it live is prerequisite 4.
- What stays OPEN needs scheduled hardware, not a quick fix: the Freivalds
  rejections (a reproducer with production activations and CPU interleaving) and a
  model-matched quality evaluation of the 27B shielded encoding.

## 7. Left intact outside the repo (not shipped)

- `~/q4-calib-work/llama-src`: the development fork (at LLAMA_COMMIT), with
  uncommitted experimental changes (fused rows, conv in place, register row,
  ntsnap default ON, scheduler and row-bucket profilers).
- `~/enclave-bench/`: harness working copy, `llama-conv/` (fork build),
  `official-tree/` (the workflow's tree plus ntsnap), `official-nofix-tree/` and
  `official-fix-tree/` (the workflow's tree before and after the graph-slot fix;
  all three are git worktrees of the fork repo), their `*-build/` directories, raw logs.
