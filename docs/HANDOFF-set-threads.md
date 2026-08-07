# Handoff: make true multi-core shared-everything-threads work

## The requirement

**Get true multi-core shared-everything-threads (SET) working: `thread.spawn-ref` /
`thread.spawn-indirect` must actually spawn threads that run in PARALLEL, in the
SAME instance, sharing memory + tables + globals.** Steven's instruction,
verbatim in intent: *rebuilding wasmtime from the ground up is acceptable if
that is what it takes.* Do not treat "upstream hasn't done it" as a stopping
condition. Partial credit does not count: a SET guest must show real wall-clock
speedup with multiple cores busy, measured.

Success = a guest calling `thread.spawn-*` gets N threads executing
concurrently in one instance, and `user` CPU time scales with N while `real`
stays flat.

## Where the previous session stopped, and exactly why

Everything below is verified — compiler errors, missing APIs, or code read, not
estimates. Do not re-derive it; go straight at the wall.

**The wall: SET spawn needs multiple OS threads inside ONE wasmtime instance,
and wasmtime's execution model forbids it by construction.**

1. Entering guest code requires `&mut Store`. Two threads on one store is
   `error[E0499]` — not a flag, a type-level invariant. **~320 call sites** take
   `&mut StoreOpaque` / `StoreContextMut<'_, T>`:
   `grep -rn "&mut StoreOpaque\|StoreContextMut<" crates/wasmtime/src | wc -l`
2. Per-execution state lives in the shared `VMStoreContext` reachable from
   vmctx — stack limits, last-wasm entry/exit SP+FP, epoch deadline, fuel. Two
   threads through one vmctx corrupt each other's stack tracking. **This is the
   real technical crux: that state must become per-thread while instance state
   (memory/tables/globals) stays shared.**
3. The wasi-threads escape hatch (a `Store` per thread over one *imported*
   `SharedMemory`) does NOT generalise to components: `wasmtime::component::Linker`
   has no `define` for memories (the core `Linker` does, `linker.rs:369`), and a
   component *creates* its memory via an internal initializer, so there is no
   import to override (`component/instance.rs:790`, `InstantiateModule::Static`).

So the paths are: (A) make execution thread-safe — the real fix, and what the
requirement implies; (B) hard-fork wasmtime and restructure the store/instance
split; (C) upstream via bytecodealliance/wasmtime#9466. (A) and (B) are the same
work at different blast radii.

## What is ALREADY BUILT — do not redo it

All in `wasm/wasmtime-set-threads.patch.wip` (583 lines) against wasmtime dev
commit **`ac0772970b9ad2cd53866d95db69e26311fe3b75`** (49.0.0 line). It applies
on top of the 8-patch enclave stack. **Deliberately NOT in the Dockerfile
chain.**

1. **`-W shared-everything-threads` was a silent no-op upstream** — parsed, never
   applied. Wired in `crates/cli-flags/src/lib.rs`'s
   `handle_conditionally_compiled!` table. With it, shared globals and shared
   func types compile.
2. **Shared FUNC types made first-class.** `WasmSubType::{is,as,unwrap}_func`
   treated `shared` as "not a func" (upstream's "acts like `is_unshared_*`"
   block), so every SET trampoline panicked in `unwrap_func`. Also narrowed
   `type_registry.rs` GC-layout assertions and dropped the concrete-heap-type
   assertion in `compile/module_types.rs`. **GC struct/array/cont accessors
   still assert on purpose** — there `shared` really changes allocation and
   barriers.
3. **All three SET intrinsics plumbed through 7 sites**
   (`environ/src/component.rs` libcall decl → `component/translate.rs` →
   `translate/inline.rs` → `component/dfg.rs` → `component/info.rs` →
   `cranelift/src/compiler/component.rs` trampoline →
   `runtime/vm/component/libcalls.rs`). `thread.available_parallelism` fully
   works and answers from the TENANT's slice via `ENCLAVE_AVAILABLE_PARALLELISM`.
   **`thread_spawn` currently returns `-1`** (`libcalls.rs`) — that is the single
   function to make real.
4. **Implemented the `NegativeTwo` host-result arm** in the component trampoline
   (was a `todo!()`). It is the only sentinel that lets a libcall return `-1` to
   the guest instead of trapping — required by the spawn ABI.
5. **Concrete shared func types interned** at the spawn canon, else the
   trampoline's `(ref null $start)` panics "no entry found for key".
6. **wasi-threads host spawn REBUILT and WORKING** in `src/commands/run.rs`
   (~130 lines). Upstream deleted it in `b4b23fe583`. **This achieves real
   parallelism: 11.3×, 12.4 cores busy.** Study it — it is the working
   reference for spawning guest code on OS threads in this codebase.

## Verify the current state in ~5 minutes

```sh
cd <scratch> && git clone https://github.com/bytecodealliance/wasmtime wasmtime-src
cd wasmtime-src && git checkout ac0772970b9ad2cd53866d95db69e26311fe3b75
for p in onnx-gpu-strict vault-fs egress loopback nn-ggml nn-sdcpp nn-onnx-preload nn-arbiter; do
  git apply <repo>/wasm/wasmtime-$p.patch; done
git apply <repo>/wasm/wasmtime-set-threads.patch.wip
cargo build --release -p wasmtime-cli --bin wasmtime

# SET component loads + runs (spawn returns -1, guest falls back): prints 32007
./target/release/wasmtime run -W threads,shared-everything-threads,component-model-threading,shared-memory \
  --invoke 'run()' <repo>/tools/parallelism-probe/set-spawn-fallback.wat

# REAL parallel threads (core modules): user time scales, real stays flat
clang --target=wasm32-wasip1-threads -O2 -pthread \
  -Wl,--import-memory,--shared-memory,--export-memory,--max-memory=67108864 \
  -o par.wasm <repo>/tools/parallelism-probe/pthread-scaling.c
for n in 1 4 16; do time ./target/release/wasmtime run -W threads,shared-memory par.wasm $n; done
```

## Gotchas that cost the last session hours

- **Feature flags lie.** wasmtime 47 advertises `-W component-model-threading`
  in help and cannot parse `thread.new-indirect`. **Always probe by compiling a
  probe module, never by grepping help text.** (`wasm_manager._threads_supported`
  does this.)
- **The wasi-sdk sysroot stubs `pthread_create` → ENOTSUP at runtime.** Build
  wasi-libc from source with `-DENABLE_COOP_THREADS=ON` (see
  `wasm/Dockerfile.wasip3c-build`).
- **wasm-component-ld ≥ 0.5.28 required**; the SDK ships 0.5.27, which fails to
  *encode* coop modules. Replace it in the SDK bin dir — clang invokes it by
  absolute path, so PATH-shadowing does nothing.
- **The CLI configures the engine async.** Calling sync `instantiate`/`call` in a
  spawned thread DEADLOCKS. Use `wasmtime_wasi::runtime::in_tokio(...)` with the
  `_async` variants.
- **The main thread returning must `process::exit`**, or the CLI hangs forever on
  workers parked in a futex (wasi-threads semantics: main ending ends all).
- **No clonable WASI ctx.** `Host` isn't `Clone` (that's why `wasi-common` was
  deleted alongside wasi-threads). Build a FRESH ctx per thread. Consequence:
  threads share linear memory but NOT an fd table.
- **WAT syntax traps:** `thread.available_parallelism` (underscore, not hyphen);
  memory is `(memory 1 1 shared)` (limits THEN shared); table is
  `(table shared 1 1 (ref null (shared func)))` (shared BEFORE limits); inline
  func types dedupe onto an earlier declared type, so declare shared and
  unshared types explicitly or your unshared function silently becomes shared.
- **Check your own benchmark first.** A `pthread_t t[N]` with `N=4` while passing
  8 threads is a stack overflow that looks exactly like an engine hang.

## Non-negotiable constraint on the result

This engine is **measured into a TEE attestation** (SEV-SNP/TDX). A runtime with
latent data races that still attests correctly is the worst failure mode this
product has — it silently breaks the only guarantee the platform sells.

This does not block the work. It shapes it:

- Keep it out of `wasm/Dockerfile.wasmtime`'s patch chain until the concurrency
  design has been reviewed and stress-tested.
- Prove it under `RUSTFLAGS="-Z sanitizer=thread"` and wasmtime's own fuzz
  targets before it goes anywhere near the fleet.
- Prefer restructuring so the compiler enforces the invariants (splitting
  per-thread execution context out of `VMStoreContext`) over `unsafe` casts that
  merely silence `!Sync`. **`unsafe impl Sync for Store` is not a solution**; it
  is the bug.
- Land it behind the existing capability plumbing (compile-probe → byte-marker →
  publish stamp → claim gate → per-tenant flag → fleet-AND), which already exists
  for coop threads and generalises directly — add a `set` capability beside
  `coopThreads`.

## Where things live

- `docs/wasm-parallelism.md` — full evidence, measurements, layer map
- `docs/wasip3-threads.md` — cooperative threads (SHIPPED, live on the fleet)
- `wasm/wasmtime-set-threads.patch.wip` — all engine work described above
- `wasm/wasmtime-*.patch` — the 8-patch enclave stack (apply first, in Dockerfile order)
- `tools/parallelism-probe/` — harness, SET guests, pthread benchmark, README
- `wasm/Dockerfile.wasip3c-build` — coop-threads C toolchain (builds threaded guests today)
- Repo HEAD when written: `f6558223`

Read `docs/wasm-parallelism.md` before writing code. Start by reading the
working `src/commands/run.rs` spawn implementation, then decide between
thread-safe-Store (A) and hard-fork (B) — and say which you chose and why before
you start cutting.
