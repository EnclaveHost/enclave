# Handoff: shared-everything-threads — DONE on the engine side

## Status: the requirement is met, and measured

`thread.spawn-ref` and `thread.spawn-indirect` spawn **real OS threads that
run guest code in parallel inside one component instance, sharing linear
memory**. Not a fallback, not a stub.

Measured on the 32-core workstation, constant TOTAL work (14.4e9 iterations
split N ways) — `tools/parallelism-probe/set-spawn-parallel.wat`:

| threads | 1 | 2 | 4 | 8 | 16 | 32 |
|---|---|---|---|---|---|---|
| real | 13.97s | 6.99s | 3.50s | 1.75s | 0.88s | **0.50s** |
| speedup | 1.0x | 2.0x | 4.0x | 8.0x | 15.8x | **27.9x** |

And the shape that cannot be faked — constant work *per thread*, 900M
iterations each: `real` stays ~0.9s while `user` climbs 0.87s → 31.1s, i.e.
31.2 cores busy at N=32.

Best of three on an idle box (16-physical-core EPYC 9115), from a wasmtime
built out of the patch applied to a **fresh checkout**. Benchmark on a quiet
machine: a pass taken while a compile ran read 21.6x purely from contention.

```sh
W="-W threads,shared-everything-threads,component-model-threading,shared-memory"
time wasmtime run $W --invoke 'run(16, 900000000)' tools/parallelism-probe/set-spawn-parallel.wat
```

Full detail, including what is deliberately NOT shared and why, is in
`docs/wasm-parallelism.md` → "SET spawn is real". Read that before changing
anything here.

## The idea, in one paragraph

The previous session stopped at "entering guest code needs `&mut Store`, so
two threads in one instance is `error[E0499]`". That framing contained the
mistake: it assumed the spawned thread must share the *Store*. It must not.
The `Store` is where **execution** state lives (stack limits, last-wasm
entry/exit SP+FP, epoch deadline, fuel) — precisely the state that must be
per-thread. What must be shared is **instance** state. So each spawned thread
gets its own `Store` holding an *execution view*: a fresh instantiation of the
same module against the same resolved import records, whose defined shared
memories are then re-pointed at the primary's `SharedMemory` (an `Arc` all
instances point into, growth behind a lock — wasmtime's own existing
cross-store sharing mechanism). Memory is physically shared; execution state
is not. `&mut Store` exclusivity is untouched at all ~320 call sites, so the
compiler still proves the invariant.

`unsafe impl Sync for Store` appears nowhere.

## Where the code is

- `crates/wasmtime/src/runtime/vm/component/set_threads.rs` — **new**, the
  whole mechanism plus a long design comment. Start here.
- `crates/wasmtime/src/runtime/vm/component/libcalls.rs` — `thread_spawn_ref`
  / `thread_spawn_indirect` and the `ThreadSpawnResult` sentinel newtype.
- `crates/wasmtime/src/runtime/vm/instance.rs` — the primary-side capture
  helpers (`copy_raw_imports`, `snapshot_plain_globals`,
  `defined_shared_memories_cloned`, `func_index_of_func_ref`) and the
  view-side `replace_defined_memory_with_shared`.
- `crates/wasmtime/src/runtime/vm/component.rs` — the cross-thread entry guard
  in `enter_host_from_wasm`.
- `crates/wasmtime/src/runtime/store.rs` — `set_thread_joins`, joined at the
  top of `StoreOpaque::drop`.

All of it is in `wasm/wasmtime-set-threads.patch.wip` (1650 lines, 21 files)
against wasmtime dev commit `ac0772970b9ad2cd53866d95db69e26311fe3b75`,
applied on top of the 8-patch enclave stack. Verified to apply clean on a
fresh checkout.

## Two invariants — do not break these

1. **Lifetime.** Workers hold raw pointers into the primary store's instances
   (their import records). `StoreOpaque::drop` joins every spawned worker
   BEFORE deallocating. If you add an early-return or reorder that drop, the
   workers get dangling pointers.
2. **No re-entry.** A worker must never call back into the primary store.
   `enter_host_from_wasm` compares the component's `VMStoreContext` against
   the one executing on this thread and, on a mismatch, records a trap **on
   the worker's own thread** (via `HostResult::unwind_sentinel`, which exists
   so a trap can be signalled without holding the store — the whole point,
   since touching that store is the race). The worker dies alone with a clear
   message; the host survives.

   The realistic way to hit this is **nested spawn** — a worker spawning
   another thread, which is reasonable guest code. My first version aborted
   the process here and that was wrong: legitimate guest code deserves a trap,
   not a host takedown. Regression test:
   `tools/parallelism-probe/set-nested-spawn.wat`. Abort is retained only for
   libcalls with no unwind sentinel (structurally cannot trap; none should be
   reachable this way) and for a Rust panic on a worker.

Spawn **refuses** (ABI `-1` + stderr diagnostic, guest takes its sequential
fallback) any module shape whose view would not be faithful: non-shared
defined memory, imported table or global, imported core-wasm function,
mutable `shared` global, guest `start` section, GC. Keep that list fail-closed
when you extend it.

## Evidence that exists (re-run it, don't trust it)

- **ThreadSanitizer** (`-Zsanitizer=thread -Zbuild-std`, nightly): all four
  SET probes clean. The TSan toolchain was first verified to *actually report*
  a known race — a clean run from an uninstrumented binary is silently green.
  Scope: TSan sees the host runtime, not JIT guest code.
- **Fuzzing**: `component_api` (2048 execs, 54.8k coverage points, no crashes
  — a smoke test, not a campaign) and `instantiate`. `instantiate` finds a crash
  that reproduces **identically on the SET-free baseline** — a pre-existing
  fuzz-harness unwrap at `crates/fuzzing/src/generators/config.rs:470`. Always
  re-run a fuzz crash against the unpatched baseline before believing it.
- **Soak**: 8000 spawn/join cycles (500 rounds x 16 threads) with contended
  atomics and cross-thread `memory.grow` — all completions accounted for.
- 187 `wasmtime` unit tests, 238 component-model/threads integration tests.
- Regressions: `available_parallelism` still 32 (8 under
  `ENCLAVE_AVAILABLE_PARALLELISM`), plain core modules unaffected.

## What is NOT done

1. **Guest toolchain — the real remaining gap.** wasi-libc has no SET thread
   model, so SET guests are hand-written WAT. `clang -pthread` cannot target
   this. Porting musl's pthreads onto SET primitives is the next project and
   it is large.
2. **Not in the Dockerfile chain.** Stays out of `wasm/Dockerfile.wasmtime`
   until someone who did not write `set_threads.rs` has reviewed the
   concurrency design.
3. Cross-instance spawn, mutable shared globals and genuinely shared tables
   are refused, not implemented. Cranelift rejects `global.atomic.*` /
   `table.atomic.*` upstream anyway, so no compilable guest can express them.
4. Platform capability plumbing (`set` beside `coopThreads`: compile-probe →
   byte-marker → publish stamp → claim gate → per-tenant flag → fleet-AND) is
   designed but not wired.

## Gotchas that still cost time

- **Feature flags lie.** Always probe by compiling a probe module, never by
  grepping help text.
- **WAT syntax:** `thread.available_parallelism` is underscored but
  `thread.spawn-indirect` is hyphenated. Memory is `(memory 1 1 shared)`
  (limits THEN shared); table is `(table shared 1 1 (ref null (shared func)))`
  (shared BEFORE limits, and the element type must be the ABSTRACT
  `(shared func)`, not a concrete `(ref null $t)`).
- **`set-spawn-fallback.wat` races by design now.** It was written when spawn
  could only fail, so it has no join. Use `set-spawn-parallel.wat` to measure.
- Building the fuzz targets needs `git submodule update --init` and (for the
  default features) an OCaml install; `--no-default-features` skips the latter.
