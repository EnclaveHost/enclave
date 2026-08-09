# Handoff: SET (shared-everything-threads), after round 21

*(The filename says round10 and is now historical — `docs/HANDOFF-set-threads.md`
points here by that name, so it stays. This file is kept current; the filename
is not a version.)*

**Read this before touching anything.** `docs/HANDOFF-set-threads.md` is older
and its "DONE on the engine side" framing is stale — the parallelism numbers in
it are still true, the readiness claim is not.

## READ THE PATCHES, NOT THIS FILE, FOR WHAT THE CODE DOES

Round 11's fourth reviewer briefed itself from `wasm/SET-DO-NOT-PROMOTE.md`,
reviewed the image that document implied was current, and discovered SIX HOURS IN
that the committed patch had moved. **The authority is
`wasm/wasi-libc-set-threads.patch` (44 files) and
`wasm/wasmtime-set-threads.patch.wip` (48 files).** Diff them against whatever
image you are about to review, first. This file and the record are narrative;
they lag.

## Where this actually stands

**TWENTY-ONE review passes have run and not one has cleared** under the gate as
written ("a round that finds nothing"). But the shape has changed decisively and
the honest summary is two sentences:

* **The code has been found clean five consecutive rounds** (17-21). Rounds
  14-16 found real code defects; 17-21 found none.
* **Every finding since round 17 has been in the PROSE about the code** — twelve
  of them, all in one comment block, each introduced while "fixing" the last.

Current artifacts: toolchain image `enclave-wasipsetc-build:r14d`, engine tree
`/home/steven/Projects/wasmtime-set` (base `ac0772970`). Keep `:r14c`, `:r14b`,
`:r14a`, `:r13c`, `:r13b`, `:r13a`, `:r12a`, `:r10f`, `:r9c`, `:r8` for A/B —
they are the previous revisions in order and several probes discriminate only
against a specific one.

## Verification status (all re-run at round 21 unless noted)

| what | result |
|---|---|
| **Full engine integration suite** (`tests/all`, NOT the component_model filter) | **1305 passed, 0 failed, 26 ignored** |
| `component_model` subset | 231/231 |
| C probe corpus on r14d | 21/21 (`worker-exit`'s exit 1 is its documented PASS) |
| Reactor under `wasmtime serve` | `spawned=8 joined=8`; 2000/2000 at 64-way, 0 workers left alive |
| `.wat` corpus | all as documented; `run(8, 3e8)` = 0.31 s real / 2.35 s user |
| Patch integrity, BOTH patches | 48/48 and 44/44, **pre-image AND post-image**, `apply --check` on fresh baselines, reverse-applies clean |
| libc patch vs the image | sha256 byte-identical to the copy baked into `:r14d` |
| SET-OFF guard build | still a hard gate in `Dockerfile.wasipsetc-build`; r14d could not have been produced without it |

**Run the FULL suite, not the 231.** Every round before 21 verified with
`cargo test … component_model`. That is the SET-adjacent subset, and it says
least about the population a promotion actually risks: the patch rewrites the
canonical ABI lift/lower path (`GuestMemory`/`GuestMemoryMut`, every
`cx.get`→`cx.put`, the string transcoders, `as_le_slice`'s `Cow`) for **every
component on the fleet**, shared or not.

## The standing constraints — do not violate these

1. **Do not promote until a round finds nothing.** The engine patch stays
   `.wip`; that suffix keeps it out of `wasmtime-patch-check.yml`'s `wasm/*.patch`
   glob and out of `wasm/Dockerfile.wasmtime`'s chain. Verified intact at round
   21: 9 patches in the workflow, zero SET references in the Dockerfile.
2. **The fleet `WASMTIME_IMAGE` repin is a MEASUREMENT EVENT and is
   Steven-gated.** Do not dispatch the toolchain workflow or repin
   `wasm/Dockerfile.wasm` unprompted. Note Steven repinned it independently on
   2026-08-09 for unrelated mm29/sd-upscaler work — a SET repin would land on top
   of that.
3. Commit and push after any change, but **stage SET files explicitly**. The tree
   carries unrelated in-flight work. Never `git add -A`. Use
   `git -c rebase.autostash=true pull --rebase` (CI pushes digest repins).

## The lesson rounds 15-21 actually taught

One comment block above `join_finished_set_worker`'s `writeln!` was rewritten in
rounds 15, 16, 17, 18, 19 and each rewrite introduced a NEW false claim: denying
the panic; inverting which configuration is exposed (twice); naming the wrong
function; asserting a `catch_unwind` that does not exist. Round 19's version
would have licensed putting a panicking macro back at `reaper::submit`, whose
failure is self-cascading and, under `serve`, completely silent.

Round 20 diagnosed the block itself (111 comment lines on ~10 lines of code) as
the defect generator and compressed it to 54. **That mostly failed** — reviewers
correctly required the `serve` caveat, the provenance paragraph and a real
operational hazard back, and it is now 71. The conclusion worth carrying:

> What made those rounds fail was not length. It was asserting things without
> checking them. Every claim in that block has now been independently measured,
> and that property — not brevity — is what fixed it.

Corollary for whoever reviews next: **prose here is load-bearing**, because this
record has twice traced a shipped code defect to a false comment. Do not treat a
prose finding as cosmetic.

## Give reviewers

* The A/B image ladder above, and an instruction to diff the patch against the
  image before starting.
* A requirement that every claimed fix comes with a probe that demonstrably
  FAILS on the previous image and PASSES on the new one, **and a native `gcc`
  control for anything asserting what "correct" means**. Probes encoding a bug as
  the spec has happened EIGHT times; every one was caught by a native control,
  never by review. (The C probes hardcode `/d`, so a naive native run gives a
  false FAIL — bind-mount it.)
* An explicit mandate to build **reactor** components under `wasmtime serve`,
  not just commands under `run`. That blind spot hid a CRITICAL for eight rounds,
  and `serve` is where a Drop-path panic is SWALLOWED by tokio rather than
  killing the process — silent, and worse.

## Open items

* **The dead-stack detach question** (round 14). Whether round 12's
  `f->buf = 0` with `buf_size == 0` leaves a shared unbuffered stream broken. The
  evidence contradicts itself; both measurements are in
  `worker-stderr-vfprintf-state.c`'s header. The decisive A/B is a libc with ONLY
  the detach hunk reverted — not `r10f`, which differs in many other ways.
* **Round 21's own fixes have not been reviewed.** Thirteenth consecutive round
  ending on that sentence.
* The two design items, unchanged: process-wide 0/1/2 under SET (the door
  enumeration CLOSES — 10 paths, all covered, no 5th unwired door — so the case
  is now purely structural, ~19 coordinated sites vs 1 invariant), and the
  `ftrylockfile` thread-exit flush that an ordinary `flockfile()` silently
  defeats.
* **Fleet cgroup config** — `WASM_CPU_WEIGHT: "100"` pinned in all three
  `enclaves/*/tinfoil-config.yml`, `cpu.max` commented out, no `pids.max`,
  placement fails open. Live behaviour today, independent of SET, Steven's call.

## Recipes

```sh
# build a C probe (output MUST be under /src)
docker run --rm -v "$PWD":/src enclave-wasipsetc-build:r14d probe.c -O2 -o probe.wasm
W="-W threads,shared-everything-threads,component-model-threading,shared-memory"
/home/steven/Projects/wasmtime-set/target/release/wasmtime run $W -S cli --dir d::/d probe.wasm

# native control
sed 's|"/d/|"d/|g' probe.c > n.c && gcc -D_GNU_SOURCE -O2 -pthread -o n n.c

# force the reaper's DETACH path (the log::error!) — needs =1; the worker's
# cancel poll is 5 ms, so anything >= 5 lets it finish first
ENCLAVE_SET_JOIN_TIMEOUT_MS=1 wasmtime run $W -S cli --dir d::/d worker-block-teardown.wasm
```

**Regenerating the patches — this has silently produced a broken patch before.**
* libc: in the wasi-libc tree, `git add -A && git diff --cached > …`.
* engine: the SET patch is a SUBSET of the working tree (9 other enclave patches
  are also applied), so it is generated from a reconstructed 9-patch baseline.
  Use **`git diff HEAD`**, not `git diff` — plain `git diff` silently produced a
  2-file patch instead of 48.
* Verify all three ways every time: entry count (44 / 48), every post-image blob
  hash matching `git hash-object`, and `git apply --check` against a fresh
  baseline. Round 21 found the `.wip` had gone stale (47/48) with nobody
  noticing — the shipped artifact carried an old comment for a whole round.

`worker-preopen-oom.c`'s `HOLE` is a byte offset into dlmalloc's layout and moves
when any libc struct changes. **On r13c+ it bites at HOLE=7..8 ONLY**: 0..6 pass
green while the worker is stdio-dead, 9..16 do not OOM at all. A moved offset
does not fail — it passes.

TSan needs `--cfg rustix_use_libc` or it reports 12 false races. Last run round
13; the deltas since are comment-level plus a `Thread` clone, so it is low
priority but not re-verified. A signal-unsafe call inside a signal report on a
trapping guest is pre-existing upstream and NOT SET-specific — do not
re-litigate it.

## Promotion sequence, when it is finally earned

Get a round that clears, then: `git mv wasm/wasmtime-set-threads.patch.wip
wasm/wasmtime-set-threads.patch`; add the wasmparser 0.254.0 vendor step +
`wasmparser-set-relax.patch` (a PLAIN unified diff against the vendored crate
root, NOT a git-format patch against the wasmtime tree — it cannot simply be
appended to the patch-check loop) + the SET patch after
`wasmtime-nn-arbiter.patch` in `wasm/Dockerfile.wasmtime`; extend
`.github/workflows/wasmtime-patch-check.yml` from 9 to 10 and update its header;
delete `wasm/SET-DO-NOT-PROMOTE.md` and fix its references here and in
`docs/wasm-parallelism.md`. **Then stop** — the fleet repin is a separate,
Steven-gated step.
