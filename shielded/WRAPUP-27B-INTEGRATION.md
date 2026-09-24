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
| `wasm/llamacpp-conv-inplace/conv-graph-test.cpp` | comment only: the multi-sequence abort's real cause (section 5) |
| `wasm/llamacpp-gdn-ntsnap.patch`, `wasm/llamacpp-gdn-regrow.patch` | records, NOT APPLIED, with their evidence in the headers |
| `wasm/llamacpp-conv-inplace/README.md`, `shielded/REPORT.md`, `shielded/HANDOFF-27B.md`, this file | documentation |
| `shielded/bench-harness/**` | harness scripts and raw run artifacts |

Nothing on the branch changes the official llama.cpp workflow, the shielded
backend's runtime code, the worker, masking, Freivalds verification or
fail-closed behaviour. No toolchain dispatch is needed.

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
   `update-fleet`). This branch changes seven `wasm/` paths, none of which
   `wasm/Dockerfile.wasm` copies. Merge only with the platform owner's approval
   and a release window, or first land a reviewed `deploy.yml` exclusion for
   non-image `wasm/` paths. For the record: seven earlier pushes to main from
   this campaign, all harness/patch-record/test files under `wasm/`, each cut and
   published such a release on 2026-09-23 (v0.5.832-835, v0.5.837-839, GPU and
   CPU flavours, `update-fleet` succeeded) with no runtime change.
2. `wasmtime-patch-check.yml` will run (it triggers on `wasm/*.patch`); it
   applies only its own named wasmtime patches, so the two llama.cpp patch
   records do not affect it.
3. `test.yml` runs on the merge; the branch changes no code under test. Local:
   `test/shielded-fault-logs.test.mjs` 4/4, `selftest-harness-check.sh` PASS,
   `git diff --check` clean, `git show --check --format= HEAD` silent.
4. Nothing on the branch may be read as a production-quality claim (below).

## 5. Acceptance gaps that remain OPEN

- **Freivalds rejections**: both production rejections (sterms-1, b-eq-1) are
  unexplained. Clean soaks (~35 M exchanges) and the 8.4 M-exchange real-model
  campaign found none, which bounds but does not explain them. Verification
  stays fail-closed; nothing here weakens it.
- **No model-matched quality evaluation** of the 27B shielded encoding.
  `text_identical` and equal token hashes compare the shielded path with itself
  and with plain decode on one prompt; they are not a quality measurement.
- **Multi-sequence contexts abort, reproduced on the OFFICIAL tree.** With
  `n_seq_max = 3` on the 0.8B qwen35 (same hybrid architecture), the first 2-8
  token single-sequence decode aborts:
  `process_ubatch -> ensure_slot_alt -> graph_reserve -> build_layer_attn ->
  ggml_mul: GGML_ASSERT(ggml_can_repeat(b, a))` (`ggml/src/ggml.c:2263`).
  `ensure_slot_alt` (from `llamacpp-graph-slot.patch`) reserves with `n_seqs = 1`
  against `memory->init_full()`, a memory context sized for all `n_seq_max`
  sequences; stock `sched_reserve` passes `n_seqs = n_seq_max` (1 when the KV
  cache is unified). With `LLAMA_GRAPH_SLOT_ALT=0` (the slot disabled) the same
  scenario completes (rc 0, 11 steps, 46 rows): the slot's reservation is the
  cause. Whether any production context runs a hybrid model with
  `n_seq_max > 1` is UNVERIFIED.

## 6. Bounded correctness follow-up (CPU only; needs no V100, no SNP host, no reboot)

The multi-sequence abort. Reproduce on the official tree (LLAMA_COMMIT + the
workflow's patches, host build with `GGML_NATIVE=OFF`):

    CONV_TEST_CPU_BACKEND=<official build>/bin/libggml-cpu.so \
      conv-graph-test Qwen3.5-0.8B-Q8_0.gguf out.bin multi

(`wasm/llamacpp-conv-inplace/conv-graph-test.cpp`; aborts with rc 134 in seconds.)
With `LLAMA_GRAPH_SLOT_ALT=0` it completes (measured, above). Remaining: make
`ensure_slot_alt` reserve consistently with the memory context it is handed (or
skip the slot when `n_seq_max > 1`); validate with the `multi`, `spec` and `lifetime` scenarios,
their logits compared with `LLAMA_GRAPH_SLOT_ALT=0`, and `official-toolchain-check.sh`.
The graph-slot patch is in the official build, so any fix goes through the
toolchain workflow and its own validation, not straight to production.

## 7. Left intact outside the repo (not shipped)

- `~/q4-calib-work/llama-src`: the development fork (at LLAMA_COMMIT), with
  uncommitted experimental changes (fused rows, conv in place, register row,
  ntsnap default ON, scheduler and row-bucket profilers).
- `~/enclave-bench/`: harness working copy, `llama-conv/` (fork build),
  `official-tree/` (a git worktree of the fork repo holding the workflow's tree
  plus ntsnap), `official-build/`, raw logs.
