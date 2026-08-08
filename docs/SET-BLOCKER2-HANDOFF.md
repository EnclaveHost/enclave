# Handoff: SET threads, Blocker 2 — make the engine fleet-ready

You are picking up shared-everything-threads (SET, ⚡) for the Enclave platform.
The **guest toolchain is done and shipped** (`clang -pthread` produces SET
components; measured 15.8x on 16 cores). The **engine is NOT in the fleet TCB**,
and your job is to clear the two review-found blockers that keep it out, then
get it re-reviewed and promoted. Do not promote before both are fixed AND a
fresh adversarial review clears — that gate exists because it has twice caught
real UB that self-review missed.

Read first, in this order:
1. `docs/wasm-parallelism.md` → section "The 2026-08-07 adversarial review" (the
   authoritative write-up of all four findings and the two fixes already landed).
2. `wasm/SET-DO-NOT-PROMOTE.md` (the short blocker list + promotion procedure).
3. `docs/HANDOFF-set-threads.md` (the engine design: per-thread execution views,
   the soundness invariants, stub imports).
4. The design comment at the top of `crates/wasmtime/src/runtime/vm/component/set_threads.rs`.

## Environment / how to build and run

- **SET engine checkout:** `~/Projects/wasmtime-set` — a wasmtime 49-dev tree
  (commit `ac0772970b9ad2cd53866d95db69e26311fe3b75`) with the 8 enclave patches
  + the SET changes applied in the WORKING TREE, plus a vendored wasmparser fork
  at `vendor/wasmparser` (Cargo.toml has `[patch.crates-io] wasmparser = { path
  = "vendor/wasmparser" }`). Build: `cd ~/Projects/wasmtime-set && cargo build
  --release` (~2 min) → `target/release/wasmtime`.
- **The engine patch, as committed in this repo:** `wasm/wasmtime-set-threads.patch.wip`
  (the wasmtime diff, 26 files) + `wasm/wasmparser-set-relax.patch` (the validator
  fork). If you edit the engine, regenerate these before promoting (see below).
- **Run flags (always):** `-W threads,shared-everything-threads,component-model-threading,shared-memory`.
  Add `-S cli` for wasi:cli components.
- **Guest toolchain image:** `docker images | grep wasipsetc` →
  `enclave-wasipsetc-build:local` (rebuild: `docker build -f
  wasm/Dockerfile.wasipsetc-build -t enclave-wasipsetc-build:local wasm/`). Use:
  `docker run --rm -v "$PWD":/src enclave-wasipsetc-build:local app.c -O2 -o app.wasm`
  → a wired SET component.
- **wasm-tools 1.255** (upstream, unpatched — use it to see what upstream
  REJECTS that the fork accepts) — download from the bytecodealliance release if
  not on PATH.
- **SET probes (persist in-repo):** `tools/parallelism-probe/*.wat` —
  `set-spawn-parallel.wat` (the scaling/soak probe: `--invoke 'run(16,900000000)'`
  and `--invoke 'run(500,16,2000)'` for the 8000-cycle soak), `set-nested-spawn.wat`,
  `set-imported-memory.wat`, `set-spawn-indirect.wat`, `set-available-parallelism.wat`.
- **Platform capability tests:** `node --test test/wasm-set.test.mjs` (12) and
  `test/wasm-p3.test.mjs` (lockstep). Keep them green.

Note: the four reviewers' hostile repros lived in a session-scratch dir that is
gone. Reconstruction recipes for the two that matter are below.

## Blocker 1 (CRITICAL) — worker threads trap on their first component/WASI call

**Symptom.** A worker execution view recurses thousands of frames of pure wasm
fine, but its FIRST canon-lowered import call (any WASI — stdout, clock,
sockets) traps `wasm trap: call stack exhausted`. So only PURE-COMPUTE workers
work today; any worker that does I/O fails. This is why the 15.8x benchmark
(arithmetic-only) never saw it.

**Reproduce (~2 min).**
```sh
cat > /tmp/wprint.c <<'EOF'
#include <pthread.h>
#include <stdio.h>
static void *w(void *a){ puts("worker printf\n"); return a; }
int main(void){ pthread_t t; pthread_create(&t,0,w,0); pthread_join(t,0); return 0; }
EOF
docker run --rm -v /tmp:/src enclave-wasipsetc-build:local wprint.c -O2 -o wprint.wasm
~/Projects/wasmtime-set/target/release/wasmtime run \
  -W threads,shared-everything-threads,component-model-threading,shared-memory \
  -S cli /tmp/wprint.wasm
# -> set-thread-1 trapped ... 0: terminal_stdout_get_terminal_stdout
#    Caused by: wasm trap: call stack exhausted
```
Contrast: a worker doing pure recursion (no imports) runs 3000+ frames deep and
returns cleanly, so the wasm stack itself is fine. The trap is specific to the
core→component (canon-lowered import) transition on a worker.

**Where to look / leading hypothesis.** `crates/wasmtime/src/runtime/vm/component/set_threads.rs`
`run_view` builds the view's `Store<()>` with `Store::new(&engine, ())` and runs
the start function with SYNC `func.call(...)`. But `wasmtime run`/`serve`
configure the engine ASYNC. The wasi-threads (p1) rebuild in
`src/commands/run.rs` handles exactly this — it drives the ASYNC entrypoints on
each worker's own tokio context — and SET's `run_view` does NOT. The strong
hypothesis is that the component-import transition needs the async fiber / call
context that a sync call on an async-configured store never sets up, and the
"call stack exhausted" is the fiber/stack-limit check firing on that transition.
Investigate:
- Is `store.engine().config()` async here? If so, `func.call` on it is the
  wrong path; use `call_async` on a fiber (mirror `run.rs`'s wasi-threads code),
  or build the worker store with a sync config.
- The component reentrance / backpressure context (`component-model-async`
  `context.{get,set}` slots, `enter_host_from_wasm` state) — is it initialized
  for the view at spawn? rev4's diagnosis was "the per-worker component-call
  stack limit / reentrance context is evidently not set up correctly at spawn."
- Secondary: the host-call native-stack headroom check vs the worker's
  `max_wasm_stack`-derived limit (`spawn_funcref` sizes the OS-thread stack as
  `max_wasm_stack + 512K`, min 2 MiB). Confirm a host transition has headroom.

**Libc interaction (already partly handled).** The SET libc assumes threads
never trap: `wasi_set_thread_start.s` releases `__thread_list_lock` and
`__pthread_exit` sets `detach_state` only on the NORMAL return path, so a
trapped worker used to hang a joining sibling (or, detached, vanish with its
result). The teardown-cancellation fix already landed turns the teardown HANG
into a clean exit, but the worker's I/O is still LOST. Once the engine lets
workers call imports, re-check: does a worker that legitimately traps
(unreachable/OOB) still leave the thread-list lock held and hang an in-flight
`pthread_join`? If so, either make a worker trap process-fatal, or have the
engine release the lock / set `detach_state = DT_EXITED` + wake on worker trap
(rev4's suggested fix (b)).

**Bar to call it fixed:** the `wprint` repro prints `worker printf` and exits 0;
a worker doing `clock_gettime` / a socket call works; a worker that genuinely
traps does not hang a joining sibling and does not silently succeed.

## Blocker 2 (HIGH) — shared canonical-ABI memory is a host-TCB data race

**Symptom.** To let a threaded component (whose only memory is `shared`) use the
canonical ABI at all, the wasmparser fork relaxed `cabi_memory_at` to accept a
shared memory ("R4"). But the host's canon lift/lower borrows guest memory as
Rust `&[u8]`/`&mut [u8]` and validates-then-copies, so a hostile guest that
races a worker's writes against a main-thread canon lift produces an **invalid
Rust `String`** (violated library invariant = UB) and a genuine host-side data
race. "Base never moves" (true — shared memories are reserved to max) rules out
OOB/UAF but NOT the race on the contents. Upstream refuses shared cabi memory
for exactly this reason.

**Reproduce.** Hand-write a component with `(memory 1 1 shared)`, a PLAIN
`(func (param i32))` thread-start type (accepted by the fork), and an exported
`go()` that: writes a valid ~64-byte string at addr 0, spawns a worker that
overwrites that region in a loop, waits on an atomic flag until the worker is
running, then returns the string (host lifts it through the shared memory). Run
under the SET engine with `-S cli`; ~20 runs yield a mix of `invalid utf-8` host
errors and torn strings containing U+1FFFFF (an impossible scalar — proof the
host produced an invalid `str`). A baseline whose worker writes a DIFFERENT
region is deterministic. (Upstream `wasm-tools validate --features all` rejects
the component at "spawn type must be shared" / "shared flag for memories" — that
difference is the attack surface.)

**Where to look / the fix.** The unsafe borrow is
`crates/wasmtime/src/runtime/component/instance.rs` `options_memory` /
`options_memory_mut` (they `slice::from_raw_parts[_mut](base, current_length)`
over the shared memory), feeding `LiftContext`/`LowerContext` in
`crates/wasmtime/src/runtime/component/func/options.rs` and the ~25 index sites
in `crates/wasmtime/src/runtime/component/func/typed.rs`. Wasmtime's own
doctrine for shared memory (`crates/wasmtime/src/runtime/vm/memory.rs` docs near
`Memory::data`: "Nothing can be borrowed and everything must be eagerly copied
out") is the fix: for a SHARED cabi memory, do NOT form a `&[u8]`/`&mut [u8]`;
copy the accessed bytes out through atomic/volatile reads into host-owned
buffers, validate the COPY (so a torn read at worst errors, never yields an
invalid `str`), and write back via atomic/volatile stores. This is a bounded but
real change to the lift/lower machinery. Keep the non-shared path byte-identical
(the common case), so gate the copy strategy on `memory.is_shared()`.

Do NOT "fix" this by reverting R4 — that makes the toolchain's components unable
to do ANY canonical I/O (even main-thread `printf` won't validate), i.e. it
un-ships Blocker 1's toolchain.

**Bar to call it fixed:** the race repro is deterministic (no invalid `str`, no
UB) across hundreds of runs and under `-Zsanitizer=thread`; the real toolchain
components still work; the non-shared canon path is unchanged.

## The two blockers are one problem

Both point at the same missing piece: a correct component execution model for
shared-memory threads. Solving Blocker 1 (workers can call imports) means
workers ALSO drive canon lift/lower over the shared memory, so Blocker 2's
copy-safe path must cover worker-initiated canon calls too (a worker calling an
import goes through `enter_host_from_wasm` — the cross-thread guard — which
currently traps a worker; that guard's disposition changes once workers can
legitimately call host functions). Design them together.

## Verification bar before promotion (all required)

1. `wprint` + a clock/socket worker repro pass; a trapping worker doesn't hang.
2. The R4 race repro is deterministic; TSan clean on the SET probes.
3. `tools/parallelism-probe/set-spawn-parallel.wat`: still ~15.8x at 16 threads;
   soak `run(500,16,2000)` returns 8000; `set-nested-spawn`, `set-imported-memory`
   still refuse/trap as before.
4. The real toolchain end-to-end: `docker run … enclave-wasipsetc-build:local
   app.c` for a threaded program that does I/O on workers → correct output.
5. `node --test test/wasm-set.test.mjs` and `test/wasm-p3.test.mjs` green.
6. **A fresh multi-agent adversarial review** (4 independent agents, fresh
   context, each told to REFUTE, plus a hostile guest you write) over the
   changed engine surface. This is non-negotiable for TCB entry — it has caught
   real UB both prior times. Re-read `docs/wasm-parallelism.md`'s review section
   for the shape.

## Promotion procedure (only after the bar is met)

1. Regenerate the patch files: overlay the changed `~/Projects/wasmtime-set`
   engine files onto a fresh 8-patch baseline of `ac0772970…` and
   `git diff` → `wasm/wasmtime-set-threads.patch.wip`; regenerate
   `wasm/wasmparser-set-relax.patch` from `vendor/wasmparser` vs the pristine
   0.254.0 crate. Confirm both apply clean to a fresh checkout and the tree
   builds.
2. Rename `wasmtime-set-threads.patch.wip` → `.patch` (so the patch-check glob
   sees it).
3. Add to `wasm/Dockerfile.wasmtime`, AFTER the existing 8 patches: apply the
   SET patch, then vendor wasmparser 0.254.0 (`sha256
   d5769a29f799fbab136aaf65b4fe5384cd7d93fe6fc9ba0dcb6c8382a1f16e27`) into
   `vendor/wasmparser` and apply `wasmparser-set-relax.patch` (the main patch's
   Cargo.toml `[patch.crates-io]` stanza points there).
4. Extend `.github/workflows/wasmtime-patch-check.yml`'s patch list with
   `wasmtime-set-threads` (and, if you keep the vendor step out of the loop,
   verify the check still represents the real build).
5. Delete `wasm/SET-DO-NOT-PROMOTE.md`.
6. The fleet cutover is a MEASUREMENT EVENT and Steven-gated: manual "Wasmtime
   Toolchain" workflow dispatch @ the pinned commit → new image digest → repin
   `WASMTIME_IMAGE` in `wasm/Dockerfile.wasm` → that commit triggers the
   wasm-manager rebuild; `fleet-op.yml` stop→start on the 1-GPU account; re-verify
   the ggml hand-built structs (see memory `enclave-ggml-backend`). Do NOT do
   this step unprompted.

## Already landed (don't redo)

- Teardown deadlock (HIGH): fixed via per-worker cancellation flag in
  `crates/wasmtime/src/runtime/vm/parking_spot.rs` (bounded poll + interrupt
  trap), set at teardown from `store.rs::join_set_threads`, installed by the
  worker in `set_threads.rs::worker_main`. Sound because stubbed workers hold no
  primary-store pointers.
- Active-data clobber (MEDIUM): fixed fail-closed — `spawn_funcref` refuses a
  module whose `memory_initialization.is_segmented()`. wasm-ld output (passive
  segments) is unaffected.
- The `set` platform capability plumbing is wired + tested and inert on the
  current fleet; leave it. It flips live automatically once the WASMTIME_IMAGE
  repin lands a SET-capable engine (the compile-probe starts passing).

Known accepted residual (do not "fix" unless asked): a hand-written guest
`(start)` that scribbles shared memory without a once-flag re-runs per view —
in-sandbox, self-inflicted, same contract wasi-threads imposes.
