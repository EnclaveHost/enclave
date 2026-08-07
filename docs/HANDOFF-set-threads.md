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

All of it is in `wasm/wasmtime-set-threads.patch.wip` (2112 lines, 22 files)
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
2. **Not in the Dockerfile chain**, and after the 2026-08-07 review that is a
   deliberate call rather than a placeholder — see below. The review found
   real UB; it is fixed, but a change that needed five critical fixes on its
   first serious read should soak, and nothing is waiting on it (no guest can
   reach SET until the toolchain exists, item 1).
3. Cross-instance spawn, mutable shared globals and genuinely shared tables
   are refused, not implemented. Cranelift rejects `global.atomic.*` /
   `table.atomic.*` upstream anyway, so no compilable guest can express them.
4. Platform capability plumbing (`set` beside `coopThreads`: compile-probe →
   byte-marker → publish stamp → claim gate → per-tenant flag → fleet-AND) is
   designed but not wired.

## The review happened (2026-08-07). Findings and what changed.

Steven's call: there is no second reviewer and there will not be one, so
review it and merge. I did the review the only way that is not a rubber stamp
— four independent adversarial readers with fresh context, each told to refute
rather than approve, plus a hostile-guest probe I wrote and ran.

**It found real UB that I missed, and the merge is therefore NOT done.** Three
of the four reviewers independently identified the same hole, which is the
strongest signal in the batch.

### Critical, now fixed

1. **A worker could re-enter the PRIMARY store — the exact race this design
   exists to prevent.** Cranelift lowers `memory.grow` and
   `memory.atomic.wait*`/`notify` on an **imported** memory by calling the
   builtin with the *defining* instance's vmctx. So a worker doing the futex
   wait that every SET mutex uses would land in
   `Instance::enter_host_from_wasm` holding the primary's vmctx and
   materialize `&mut dyn VMStore` on it from the wrong thread. My guard was
   only on the **component** entry point; the **core** one was unguarded.
   This is the most common SET code path, not an exotic shape.
   Fixed twice over: the guard now also lives in
   `Instance::enter_host_from_wasm` (so it fails closed regardless of which
   module shapes the spawn guards enumerate), and spawn refuses imported
   memories and tags. Probe: `tools/parallelism-probe/set-imported-memory.wat`.
2. **The guard itself committed the violation it reports.** It did
   `ptr.as_ref()` to read the store-context pointer, forming a
   `&ComponentInstance` over the primary's allocation on the worker thread —
   while the owning thread may hold `&mut` to it. Both store-context slots sit
   at shape-independent constant offsets, so it now reads them with pure
   pointer arithmetic and never forms the reference.
3. **The thread cap was per-store, and `wasmtime serve` builds a fresh store
   per HTTP request** (wasip2 reuse count 1, up to 1000 concurrent). That made
   the real ceiling 1000x the intended one. The cap is now process-global.
4. **Non-shared globals were being snapshotted into workers.** Under SET an
   unshared global is per-*thread* state — canonically `__stack_pointer`. A
   worker inheriting the spawner's value starts on the spawner's C shadow
   stack and both push into the same region of shared memory: silent
   in-sandbox corruption, no trap. Now skipped, so a worker gets initial
   values and the guest's thread-start code installs its own.
5. **Unbounded thread creation** (found by my own hostile probe before the
   reviewers reported): 200 spawn calls produced 234 OS threads with no
   refusal. The platform sets only `cpu.weight`/`cpu.max` — no `pids.max` —
   and threads are a node-wide kernel resource, so this degraded every tenant
   on the box. Now capped.

### Also fixed

- The imported-function check was a **deny-list**; inverted to an allow-list
  (only component trampolines). A host-function context slipping through would
  have been a type confusion of the store's `T`, not merely a race.
- **Any guest trap on a worker called `process::exit(1)`** — a one-instruction
  self-DoS, and it contradicted this file's own claim that a worker "dies
  alone". Workers now die alone for real.
- `record_unwind_on_this_thread` failed **open**; it now returns whether it
  recorded, and the caller aborts rather than returning a sentinel for an
  unwind that was never recorded (which would unwind destructively and then
  panic).
- Worker stacks are sized from `max_wasm_stack` instead of taking Rust's 2 MiB
  default, so raising that config can't put the limit below the real stack.

### The open issues from that review are now closed too

Steven's call after reading the above was "patch all the open issues and get
it over the finish line safely." Done:

- **Workers are epoch-interruptible again.** They used to run with
  `set_epoch_deadline(u64::MAX/2)`, and since `Store::drop` joins workers
  unconditionally, one guest thread looping forever wedged teardown
  permanently — under `wasmtime serve` that burns a tokio worker per request,
  so a handful of requests stop the tenant serving, with the embedder's
  epoch-based `--wasm timeout` unable to intervene. Workers now take a finite
  deadline (`ENCLAVE_SET_EPOCH_TICKS`, default 600) and
  `epoch_deadline_trap()`. Fuel is left at the store default rather than being
  handed `u64::MAX`, because silently exempting workers would defeat exactly
  the metering an embedder configured. Residual: an embedder that uses neither
  epochs nor fuel still relies on process supervision.
- **The join moved ahead of `T`'s destruction.** `Drop for Store<T>` now joins
  workers before `run_manual_drop_routines()` and before `T` is dropped;
  `StoreOpaque::drop` still joins (draining makes it a no-op) for stores torn
  down by other paths. The invariant and the code now agree.
- **Memories are swapped BEFORE the startup function runs**, via a new
  `Instance::new_started_with` hook. `needs_startup()` is true for passive
  element/data segments and complex global initializers — precisely what
  `wasm-ld --shared-memory` emits — so startup is compiled wasm that used to
  run against a throwaway memory. That cost a full memory allocation per spawn
  (reserved to the declared maximum) and let initializers read globals before
  they were seeded. Both gone.
- **Worker table growth is bounded.** A worker's `Store` has no
  `ResourceLimiter` (the primary's lives in its embedder data `T`, unreachable
  from the runtime layer), so `table.grow` escaped `-W max-table-elements`.
  Spawn now refuses modules with a table that has no declared maximum, which
  bounds a worker to a static property the primary already validated.
  Residual, stated plainly: that declared maximum, not the embedder's dynamic
  cap, is the worker's bound.
- **`ENCLAVE_AVAILABLE_PARALLELISM` is now set by `wasm_manager.py`**
  (`_available_parallelism_for`, tests in
  `test/wasm-available-parallelism.test.mjs`), derived from the purchased
  `cpuShare` and clamped to `NODE_VCPUS`, rounding up with a floor of 1. This
  was the last prerequisite: without it the engine falls back to the node's
  core count, so both the guest-visible `thread.available_parallelism` answer
  and the SET worker-thread ceiling would be sized from hardware the tenant
  does not own. Inert on today's fleet — nothing reads the variable until the
  patch enters the Dockerfile chain — which is exactly why it is safe to land
  ahead of it.
- Minor: the refusal path no longer amplifies logs (an unbounded guest refusal
  loop used to emit an unbounded `log::warn!` stream — now rate-limited with
  the stderr copy), and the raw 16-byte global copy is backed by a
  `const` assertion instead of an assumption.

### Still true, and deliberately not "fixed"

- A worker that traps dies alone, so siblings waiting on its futex may
  deadlock. That is the guest's bug to handle and is strictly better than
  killing a runtime that serves other in-flight requests.
- The join is unbounded by design: a worker holds raw pointers into the
  store's instances, so proceeding to deallocate would be a use-after-free.
  The epoch deadline above is what keeps that from being unrecoverable.

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
