# Shielded 27B wrap-up: integration inventory (2026-09-23)

Branch `perf/shielded-27b-wrapup` (worktree
`/home/steven/Projects/enclave-shield-27b-wrapup`), one commit on top of
`f46e6639`. Checked against `origin/main` at `fcb980c0` (16 commits ahead of the
branch's base, site/brand/pVM only): `git merge-tree --write-tree origin/main HEAD`
is clean, no file is touched on both sides, and the branch uses no retired brand
term. Full record: `REPORT.md` 18.50-18.54.

## 1. Production optimizations of this campaign that are ALREADY on main

Official llama.cpp build (`.github/workflows/llamacpp-toolchain.yml`, applied in
this order after `LLAMA_COMMIT`): `llamacpp-graph-slot.patch`,
`-cuda-graph-ptr-update`, `-sync-instr`, `-rs-pin-cells`, `-topk-rows`,
`-parallel-copy`, `-parallel-rows` (single-row GET_ROWS/concat spread over the
threads, decode +12%), `-rs-inplace` (recurrent state updated where it lives,
plain decode +10%, speculative 16.2 -> 19.5 tok/s).

Shielded backend and worker (`wasm/ggml-shielded/`, `shielded/worker-cuda/`):
worker graph cache default 1024 (`captured-graphs.h`), column split
(`SHIELDED_SPLIT_COLS`), Freivalds RHS overlapped with the wire
(`SHIELDED_OVERLAP_VERIFY`, after the defect fix), the reply written into the
registered shm ring, the class-B reservation fix (`claim_reservation`),
value-free fault post-mortems with plaintext diagnostics compile-time gated
(`SHIELDED_ALLOW_FAULT_DIAG_PLAINTEXT`), the glibc-only affinity guard
(`sh_thread_create`), and opt-in placement (`SHIELDED_CPU_*`, off by default).
Each was verified present on `origin/main` for this inventory.

## 2. What this branch adds: benchmark, test and evidence only

| path | kind |
|---|---|
| `wasm/ggml-shielded/bench-spec.cpp`, `bench-batch.cpp` | benchmark fix: register-max greedy argmax (identical picks; -2.2 ms per round measured within-run). The engine already selects with a one-branch top-k scan, so this corrects the measurement, not the engine. |
| `wasm/llamacpp-conv-inplace/official-toolchain-check.sh` | test tool: the workflow's tree + a candidate under GCC 11.4 / AVX2 |
| `wasm/llamacpp-graph-slot.patch` | **correctness fix** (section 5): the small-batch slot's reservation now matches the memory context (two added lines of the patch become eleven, plus a header note). Reaches production only through a manual `llamacpp-toolchain` dispatch and a `WASMTIME_IMAGE` repin, never by merging. |
| `wasm/llamacpp-conv-inplace/conv-graph-test.cpp` | `CONV_TEST_KV_UNIFIED=1` (unified KV, as the engine's server contexts use); comment corrected |
| `wasm/llamacpp-conv-inplace/graph-slot-check.sh`, `official-graph-slot-check.sh`, `harness-check.sh` | test tools: the scenario x KV matrix against `LLAMA_GRAPH_SLOT_ALT=0`, its production-toolchain gate, and `run_graph`'s optional scenario argument (messages now name the switch) |
| `shielded/proposals/` | an UNAPPLIED deploy.yml exclusion for benchmark/harness paths, with a simulation (section 4) |
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
   non-image `wasm/` paths: `shielded/proposals/` has one, simulated against
   deploy.yml's own detect block. It would exempt 8 of the 11 but not the three
   `wasm/*.patch` records, so this merge would still cut one release. For the record: seven earlier pushes to main from
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
