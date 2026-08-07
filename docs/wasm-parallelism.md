# Multi-core Wasm on the platform: what works, what doesn't, and why

Written 2026-08-07 after building against the engine rather than reading about
it. Every claim below was produced by running something; the commands are
reproducible from `tools/parallelism-probe/`.

Short version, as of the final 2026-08-07 revision: **shared-everything-threads
now really spawn OS threads and really run in parallel from inside a
component. Measured 27.9x on 32 threads (16 physical cores), on the engine we build.**
`thread.spawn-ref` and `thread.spawn-indirect` return live thread ids, guest
`user` CPU time scales linearly with thread count while `real` stays flat, and
the whole thing is reachable from a component — the boundary that carries our
egress rules, the loopback wall and the WASI capability model.

The rest of this file is the history of getting there, kept because it records
which walls are real and which only looked real. Read
"[SET spawn is real](#set-spawn-is-real-2026-08-07-final)" first if you only
want the current state.

## The three threading models, kept distinct

They get conflated constantly, so:

| model | what it gives | status here |
|---|---|---|
| **cooperative threads** (wasip3 🧵) | `pthread`/`std::thread` interleaved on one core — concurrency, thread-shaped code ports | **SHIPPED** 2026-08-07, see docs/wasip3-threads.md |
| **wasi-threads** (p1) | real OS threads, shared linear memory, true parallelism | deleted upstream (b4b23fe583), **REBUILT here** in `src/commands/run.rs`; core modules only |
| **shared-everything-threads** (SET) | true parallelism, reachable from a component | **BUILT AND MEASURED** — 27.9x, see below. Not in the Dockerfile chain yet |

## UPDATE 2026-08-07 (later the same day): three of those layers turned out to
## be buildable, and I built them. The wall is somewhere else.

An earlier revision of this file said SET "cannot be built from here". That was
wrong about layers 2-4 and I have since built them. Corrected status:

- **Layer 2 (CLI wiring) — BUILT.** See below; the flag was a silent no-op.
- **Layer 3 (shared types) — BUILT for functions.** `WasmSubType::{is,as,unwrap}_func`
  treated `shared` as "not a func", so every SET intrinsic panicked in
  `unwrap_func` the moment its trampoline compiled. `shared` on a FUNC type
  changes neither signature, calling convention nor ABI, so those accessors now
  see through it; `type_registry`'s GC-layout assertions were likewise narrowed
  (a shared func has no GC layout). The GC accessors still assert — there
  `shared` really does change allocation and barriers.
- **Layer 4 (intrinsics) — ONE IS WORKING.** `thread.available_parallelism`
  runs end-to-end through all seven plumbing sites (wasmparser → translate →
  inline → dfg → info → cranelift trampoline → runtime libcall):

      $ wasmtime run -W threads,shared-everything-threads,component-model-threading \
          --invoke 'run()' tools/parallelism-probe/set-available-parallelism.wat
      32
      $ ENCLAVE_AVAILABLE_PARALLELISM=8 ...   ->   8

  It answers from the TENANT's slice, not the node's core count — a guest
  sizing a pool from 32 while holding a 0.25 share would just build 32 threads
  to fight over 8 cores' worth of cgroup weight.

  All of this is in `wasm/wasmtime-set-threads.patch.wip`, deliberately NOT in
  the Dockerfile chain.

- **Layer 4 (intrinsics) — ALL THREE NOW IMPLEMENTED.** `thread.spawn-ref`,
  `thread.spawn-indirect` and `thread.available_parallelism` are real
  trampolines now; previously the two spawn intrinsics `bail!`-ed at
  TRANSLATION time, which meant a SET component could not even be loaded.
  A complete SET guest — shared memory, shared func types, a concrete
  `(ref null $start)`, guest atomics, `thread.spawn-ref` — now loads and runs
  (`tools/parallelism-probe/set-spawn-fallback.wat`):

      $ wasmtime run -W threads,shared-everything-threads,component-model-threading,shared-memory \
          --invoke 'run()' set-spawn-fallback.wat
      32007          # 32 cores * 1000 + 7 units of work completed
      $ ENCLAVE_AVAILABLE_PARALLELISM=4 ...
      4007

  Spawn returns the ABI's documented failure (-1), the guest takes its
  sequential fallback, and the work still happens through shared-memory
  atomics. That is the honest answer on this engine and it is a very
  different situation from "the component is rejected": SET guests are
  loadable, runnable and forward-compatible — the day the engine can really
  spawn, the same binaries get parallelism with no rebuild.

  Getting there also needed two more fixes worth naming: concrete references
  to shared func types had to be interned (otherwise the trampoline's
  `(ref null $start)` panicked with "no entry found for key") and the
  `NegativeTwo` host-result arm had to be implemented in the component
  trampoline — it was a `todo!()`, and it is the only sentinel that lets a
  libcall hand `-1` back to the guest instead of trapping on it.

### What looked like the wall: `thread.spawn-*` needs a thread-safe Store

"Shared everything" means a spawned thread runs in the **same instance** —
same memory, same tables, same globals. In wasmtime, entering guest code
requires `&mut Store`, so it is exclusive *by construction*. This is not a
feature flag; the borrow checker rejects it outright:

    error[E0499]: cannot borrow `store` as mutable more than once at a time

The conclusion drawn at the time was that the remaining work meant making
wasmtime's execution model thread-safe — store bookkeeping, fuel, epoch
interruption, trap handling, stack limits and GC roots all concurrent — the
rearchitecture upstream has not started.

**That conclusion was wrong, and the mistake is worth naming**: it treated
"the spawned thread must share the Store" as part of the requirement. It is
not. The requirement is that the thread shares *instance state* — memory,
tables, globals. The `Store` is where *execution* state lives (stack limits,
last-wasm entry/exit SP+FP, epoch deadline, fuel), and execution state is
exactly the thing each thread must NOT share. Sharing the store is not the
goal; it is the bug the compile error was already warning about.

That reframing is what unlocked the next section.

## SET spawn is real (2026-08-07, final)

`thread.spawn-ref` and `thread.spawn-indirect` now spawn actual OS threads
that run actual guest code in parallel, from inside a component. Measured on
the 32-core workstation, `tools/parallelism-probe/set-spawn-parallel.wat`:

**Constant work PER THREAD** — the shape that cannot be faked. Each thread
runs 900M LCG iterations; `real` stays flat while `user` climbs linearly,
which is only possible if the threads are on different cores:

| threads | real | user | cores busy |
|---|---|---|---|
| 1  | 0.878s | 0.867s | 1.0 |
| 2  | 0.878s | 1.747s | 2.0 |
| 4  | 0.879s | 3.495s | 4.0 |
| 8  | 0.879s | 6.975s | 7.9 |
| 16 | 0.884s | 14.020s | 15.9 |
| 32 | 0.997s | 31.121s | **31.2** |

**Constant TOTAL work** — 14.4 billion iterations split N ways, i.e. the
speedup a real workload sees:

| threads | real | speedup |
|---|---|---|
| 1  | 13.966s | 1.0x |
| 2  | 6.988s  | 2.0x |
| 4  | 3.498s  | 4.0x |
| 8  | 1.752s  | 8.0x |
| 16 | 0.884s  | 15.8x |
| 32 | 0.501s  | **27.9x** |

Best of three runs each, on an otherwise idle box, using a wasmtime built from
`wasm/wasmtime-set-threads.patch.wip` applied to a **fresh checkout** — not the
working tree it was developed in. Measure on a quiet machine: an earlier pass
taken while a compile was running read 21.6x at n=32 purely from CPU
contention.

Linear to 16 (the AMD EPYC 9115's physical core count), then 27.9x at 32
logical cores. Getting ~1.8x out of SMT is more than a pure-ALU loop usually
sees, and the reason is the benchmark's inner loop: an LCG carries a
loop-carried multiply dependency, so each thread spends most cycles waiting on
multiply latency and leaves plenty of issue slots for its sibling. A
throughput-bound or memory-bound guest should expect the flatter curve past
16. `thread.spawn-indirect`
through a shared funcref table is verified functionally by
`set-spawn-indirect.wat`.

Reproduce:

```sh
wasmtime run -W threads,shared-everything-threads,component-model-threading,shared-memory \
  --invoke 'run(16, 900000000)' tools/parallelism-probe/set-spawn-parallel.wat
```

### How: per-thread execution views over shared instance state

The design follows from the reframing above. Each spawned thread gets its
**own `Store`** — so `&mut Store` keeps enforcing execution exclusivity at
every one of those ~320 call sites, unchanged, and the compiler goes on
proving the invariant rather than us asserting it. What the thread shares is
the *instance state*:

- The worker instantiates the **same module** against the **same
  already-resolved import records** the primary was instantiated with
  (captured on the spawning thread, where `&mut StoreOpaque` is legally held).
- Its defined shared memories are then **re-pointed at the primary's
  `SharedMemory`**. That is an `Arc<SharedMemoryInner>` whose
  `VMMemoryDefinition` every instance points at directly, with growth behind a
  lock — wasmtime's own existing mechanism for sharing one memory across
  stores. Linear memory is therefore *physically* the same memory, not a copy.
- Plain (numeric/vector) globals are snapshotted from the primary at spawn.
- The start function is invoked through the **view's own funcref**, so every
  instruction the thread executes enters through the view's vmctx and the
  worker store's `VMStoreContext`.

Traps, backtraces, signal handling and epochs all work unmodified, because
"N threads, N stores, one engine" is already-supported wasmtime usage: signal
handlers are process-global, `sigaltstack` is per-thread and lazily installed
on first wasm entry, and the `CallThreadState` chain the handler consults is
per-thread TLS.

The stub that became real is `thread_spawn` in
`crates/wasmtime/src/runtime/vm/component/libcalls.rs` (now split into
`thread_spawn_ref` / `thread_spawn_indirect`, since the two intrinsics carry
genuinely different payloads and the previous single payload-less trampoline
could not tell them apart); the machinery is
`crates/wasmtime/src/runtime/vm/component/set_threads.rs` (new, ~330 lines
with the design comment).

**Cost note:** each spawn instantiates a view, which allocates a fresh shared
memory that is immediately dropped when the primary's is swapped in. Measured
at roughly 200µs per spawn/join cycle on this box (8000 cycles in 1.6s), so
it is a thread-pool-at-startup mechanism, not something to call per work item.

### Sharedness, stated exactly

Not "shared everything" in the full proposal's sense, and the difference is
enforced rather than hoped for:

- **memory: physically shared.** The thing SET guests actually coordinate
  through.
- **tables: per-view**, materialized from the same initializers. Cranelift
  rejects `table.atomic.*` upstream ("not yet implemented"), so no guest this
  engine can compile is *able* to express cross-thread table mutation.
- **globals: snapshot at spawn** — for `shared`, PLAIN (numeric/vector)
  globals only. NON-shared globals are deliberately excluded: under SET an
  unshared global is per-THREAD state, canonically `__stack_pointer`, and
  copying the spawner's value would start a worker on the spawner's C shadow
  stack with both pushing into the same region of shared memory.
  Reference-typed globals are skipped too, their contents being pointers tied
  to the primary instance. `global.atomic.*` equally does not
  compile, and a module with a MUTABLE `shared` global is refused at spawn
  rather than silently diverging.

Worker execution is bounded rather than exempt: workers take a finite epoch
deadline (`ENCLAVE_SET_EPOCH_TICKS`, default 600) and trap on it, so an
epoch-using embedder can interrupt a runaway thread instead of having store
teardown wedge on the unconditional join; fuel is left at the store default so
a fuel-metering embedder is not silently bypassed. Spawn still costs a full
instantiation, but the primary's memories are now swapped in BEFORE the module
startup function runs, so a spawn no longer initializes a throwaway memory it
immediately discards.

Spawn returns the ABI's `-1` ("spawn failed", which guests are required to
handle) with a stderr diagnostic for any module shape whose view would not be
faithful: a non-shared defined memory, an imported table or global, an
imported core-wasm function, a mutable shared global, a guest `start` section,
or GC use. Guests take their sequential fallback. This is the fail-closed
posture the attestation requires: a shape we cannot represent honestly gets
refused, never approximated.

### The two soundness invariants, and how each is held

The worker holds raw pointers into the primary store (import records whose
`vmctx`/`from` fields target the primary's instances). Two things keep that
sound:

1. **Lifetime.** Every spawn registers its `JoinHandle` with the primary
   store, and `StoreOpaque::drop` joins them all *before* deallocating
   anything. A worker parked forever hangs the drop, which is the correct
   failure — process-level lifetime management owns that case.
2. **No re-entry.** A worker must never call back into the primary store.
   Component intrinsics and canon-lowered host imports all funnel through
   `ComponentInstance::enter_host_from_wasm`, which now compares the
   component's `VMStoreContext` pointer against the one this thread is
   currently executing. On a mismatch it records a trap **on the worker's own
   thread** and returns the ABI's unwind sentinel, so the worker unwinds
   through its own store and dies alone with a clear message:

       set-thread-1: error while executing at wasm backtrace:
           0: 0x6d - m!worker
       Caused by:
           a shared-everything-threads worker cannot call back into the
           component that spawned it (nested `thread.spawn-*`, ...)

   This matters because there is one realistic way to hit it: **nested
   spawn**, a worker spawning another thread — perfectly reasonable guest code
   (thread pools do it). The first version of this guard aborted the process,
   which was wrong: legitimate guest code should get a trap, not take the host
   down. Verified by `tools/parallelism-probe/set-nested-spawn.wat`.
   Aborting is retained only for the residual case where the libcall's return
   type has no unwind sentinel (a libcall that structurally cannot trap, none
   of which should be reachable this way), because then there is nothing
   truthful to hand back.

   Making this trap needed one new piece of machinery:
   `HostResult::unwind_sentinel()`, so a caller can signal a trap *without
   holding the store* — which is the whole point, since the guard fires
   exactly when touching that store would be the race.

`unsafe impl Sync for Store` appears nowhere. That was the constraint and it
held: the borrow checker still refuses two threads on one store, and it still
would if this code were wrong.

### Evidence beyond "it went fast"

- **ThreadSanitizer**: `-Zsanitizer=thread` build with `-Zbuild-std`, all
  four SET probes clean (spawn-parallel; spawn-indirect; a stress probe doing
  800 spawn/join cycles with contended atomics plus cross-thread
  `memory.grow`; and nested-spawn, which must trap rather than race). The toolchain was verified to actually report races by
  running a known-racy program through it first — a clean TSan run means
  nothing until you have proved the instrumentation is live.
  **Honest scope**: TSan instruments the *host runtime*, not JIT-compiled
  guest code, so it validates instance creation, store lifetimes and the
  `SharedMemory` growth lock — not guest-level accesses.
- **Soak**: 8000 spawn/join cycles (500 rounds x 16 threads) with a contended
  atomic accumulator and cross-thread `memory.grow`, all completions
  accounted for, no hangs.
- **Test suite**: 187 `wasmtime` unit tests and 238 component-model/threads
  integration tests pass.
- **Fuzzing**: `component_api` (2048 execs, 54.8k coverage points, no crashes)
  and `instantiate`. Modest exec counts — component generation is slow — so
  read this as a smoke test, not a campaign. `instantiate` does find a crash — it reproduces
  **identically on the SET-free baseline**, so it is pre-existing: the fuzz
  harness at `crates/fuzzing/src/generators/config.rs:470` unwraps a
  `to_store()` that legitimately fails when a generated config's GC heap
  exceeds the pooling allocator's memory limit. Worth reporting upstream;
  not ours. (Always re-run a fuzz crash against the unpatched baseline before
  believing it is yours — and note the fuzz targets need
  `git submodule update --init`, plus `--no-default-features` unless you have
  OCaml installed.)
- Regression-checked: `thread.available_parallelism` still answers 32 (and 8
  under `ENCLAVE_AVAILABLE_PARALLELISM=8`), plain core modules unaffected.
- **Adversarial review, 2026-08-07** — four independent readers plus a
  hostile-guest probe. It found real UB (a worker could re-enter the primary
  store through an imported memory's libcall, because the *core*
  `enter_host_from_wasm` was unguarded) and four other critical defects. All
  fixed; see `docs/HANDOFF-set-threads.md` for the list and for what is
  known-and-accepted rather than fixed. The lesson worth keeping: the bug that
  mattered was found by writing a hostile guest and by fresh readers, not by
  re-reading code I had just written.

### Engine changes beyond the spawn path

Getting a valid SET guest to *load* needed four more fixes past what the
earlier session had landed:

- Two further `assert!(!ty.composite_type.shared)` sites in
  `module_types.rs`'s `UnpackedIndex::Module` arm (the earlier session fixed
  the `Id` arm). A shared funcref table's element type reaches both.
- `(shared func)` as an ABSTRACT heap type was `wasm_unsupported!`. A funcref
  is a pointer whether or not it is shared, so it now maps to `WasmHeapType::Func`.
  Only FUNC gets this — shared extern and shared GC heap types really do change
  allocation and barriers, and stay unsupported.
- The `shared` bit on globals was parsed and silently dropped; it is now
  carried on `environ::Global` so the spawn guard can see it.
- `has_guest_start` on `environ::Module`, because `startup` conflates a guest
  `(start)` section with wasmtime-synthesized initialization, and the view
  must run the latter while refusing the former.

### One real bug fixed on the way

The earlier session's `NegativeTwo` trampoline arm was paired with a
`Result<u32>` libcall. `u32`'s unwind sentinel is `u64::MAX` (i.e. -1), but
the trampoline tests for -2 — so a host-side trap would have been passed
through to the guest as a *plausible-looking* "spawn failed" while leaving the
recorded unwind pending in TLS. Unreachable while the body was `Ok(-1)` on
every path; live the moment spawn does real work. Fixed with a
`ThreadSpawnResult` newtype whose sentinel is `u64::MAX - 1`, matching the
trampoline.

### What is NOT done

- **Guest toolchain (layer 5) is still missing.** wasi-libc has no SET thread
  model, so today's SET guests are hand-written WAT. The engine is ready; a C
  or Rust program cannot target it yet. That is the next piece of work and it
  is large (porting musl's pthreads onto SET primitives).
- **Not in the Dockerfile patch chain.** `wasm/wasmtime-set-threads.patch.wip`
  stays out of `wasm/Dockerfile.wasmtime` pending review, per the constraint
  on anything entering a measured TCB.
- Cross-instance spawn, mutable shared globals, and shared tables are refused
  rather than implemented. Each needs its own design; none is needed by the
  workloads that motivated this.
- `set-spawn-fallback.wat` now really spawns, so its counter races by design
  (it was written when spawn could only fail). It is kept as a load-and-run
  probe; `set-spawn-parallel.wat` is the one that joins properly.

## The layer map (measured, not assumed)

1. **Spec / validator — EXISTS.** `wasm-tools validate --features
   shared-everything-threads` accepts shared globals, shared composite types,
   and a component carrying shared memory. The encoding is real.

2. **wasmtime CLI wiring — WAS MISSING, now fixed here.** `-W
   shared-everything-threads` was *parsed and then never applied to the engine
   Config*: it is absent from the `handle_conditionally_compiled!` table in
   `crates/cli-flags/src/lib.rs`, and the only caller of the setter was the
   wast test runner. The flag was a silent no-op. Five-line fix in
   `wasm/wasmtime-set-cli-flag.patch.notinchain`. With it applied, shared
   globals and shared function types **compile**.

   That patch is deliberately **NOT in the Dockerfile patch chain.** It
   enables an engine feature that cannot be completed (layer 3), so on the
   fleet it would buy nothing and only widen TCB behaviour. It is kept
   applied-and-tested for the day SET is real, and is worth sending upstream.

3. **Cranelift codegen — MISSING.** 31 SET operators return
   `wasm_unsupported!("shared-everything-threads operators are not yet
   implemented")`. 22 are GC struct/array atomics (irrelevant to pthreads);
   the ones a threaded C program would actually need are the global and table
   atomics (`global.atomic.*`, `table.atomic.*`).

4. **Component spawn intrinsics — MISSING.** `thread.spawn-ref`,
   `thread.spawn-indirect` and `thread.available-parallelism` are parsed by
   wasmparser and then hit `bail!("unsupported intrinsic")` in
   `crates/environ/src/component/translate.rs`. This is the layer that would
   let a *component* start a thread at all.

5. **Guest toolchain — MISSING ENTIRELY.** wasi-libc has exactly one p3
   threading model, `ENABLE_COOP_THREADS` (the cooperative one we shipped).
   There is no SET thread model, so even a perfect engine would have no
   compiler emitting programs that use it. Building one means porting musl's
   pthreads onto SET primitives — the same scale of work the coop-threads
   directory took upstream.

Upstream has not started: the only SET commits in wasmtime's history are
"threads: add feature flags" (#10206, #10569), the tracking issue (#9466) has
no linked PRs, and the entire SET test suite is a single 3-line `.wast` that
asserts an empty module parses.

## WORKING: real parallel pthreads, measured 11.3x (2026-08-07)

Not a harness this time — a real C program using `pthread_create`/`pthread_join`,
compiled by clang, running on our patched wasmtime and using many cores. The
host side of wasi-threads is REBUILT in `src/commands/run.rs` (upstream deleted
it in b4b23fe583). Source: `tools/parallelism-probe/pthread-scaling.c`.

| threads | guest wall | real | user | cores busy |
|---|---|---|---|---|
| 1  | 219ms | 0.239s | 0.256s | 1.1 |
| 2  | 220ms | 0.227s | 0.444s | 2.0 |
| 4  | 219ms | 0.226s | 0.881s | 3.9 |
| 8  | 231ms | 0.238s | 1.781s | 7.5 |
| 16 | 309ms | 0.316s | 3.928s | **12.4** |

16 threads x 900M iterations = 14.4 BILLION iterations in 309ms. Sequential
would be ~3.5s: **11.3x**. `user` climbing to 3.9s while `real` stays ~0.3s is
the part that cannot be faked — those are real cores.

Build the guest with imported+exported shared memory, which the WASI p1 host
also requires so it can reach guest memory:

    clang --target=wasm32-wasip1-threads -O2 -pthread \
      -Wl,--import-memory,--shared-memory,--export-memory,--max-memory=67108864 \
      -o app.wasm app.c
    wasmtime run -W threads,shared-memory app.wasm

Two things upstream's version could not do, solved here:

- **No clonable WASI ctx.** wasi-threads needed `T: Clone`, which is why
  `wasi-common` was deleted in the SAME commit — the modern `wasmtime_wasi` ctx
  is not `Clone`. Cloning was never the actual requirement: each thread just
  needs *a* context, so we build a FRESH one per thread (inheriting stdio, so
  `printf` from a worker still reaches the terminal). Honest consequence:
  threads share LINEAR MEMORY (what pthreads needs) but NOT a file-descriptor
  table. Compute-parallel work is unaffected; opening an fd on one thread and
  reading it on another is not supported.
- **Async engine.** The CLI configures async, so the sync `instantiate`/`call`
  entrypoints deadlock in a spawned thread. Threads drive the async ones on
  their own tokio context, and the main thread returning `process::exit`s (the
  wasi-threads rule that the main thread ending ends them all) — without that
  the CLI blocks forever on workers parked in a futex.

**Scope, stated plainly:** this is core modules (wasip1-threads), not
components. It is real parallelism available today; it costs the component
boundary that carries egress, the loopback wall and the WASI capability model.
That trade is a product decision, not a technical one, and this file exists so
it can be made with numbers instead of guesses.

## The earlier harness: 7.8x, and how



The machinery for real parallelism is still in the engine — only the
wasi-threads *crate* was deleted. `SharedMemory`, `-W threads`, `-W
shared-memory` and guest atomics are all intact. The trick wasi-threads used
sidesteps wasmtime's core constraint (a `Store` is not `Sync`, so two OS
threads can never execute in *one* store):

> **one shared linear memory, one `Store` per OS thread.** The host creates a
> `SharedMemory`, every per-thread instance *imports* it, and each OS thread
> instantiates into its own `Store`. What is shared is the memory, not the
> store.

`tools/parallelism-probe/main.rs` rebuilds exactly that on wasmtime 49.
Identical total work (4.8e9 iterations), same binary, same machine:

```
1 thread  (sequential): wall=1167ms
8 threads (parallel)  : wall=149ms      -> 7.8x
```

and `guest_atomic_counter=8` confirms the guest's own
`i32.atomic.rmw.add` against the shared memory was correct across all eight
OS threads. This is genuine multi-core wasm with working shared-memory
synchronisation, on the engine we ship.

**Why our apps still cannot use it:** the mechanism is core-module shaped. Our
platform requires *components* (the classifier refuses core modules at
publish, and it is the component boundary that carries the whole security
model — egress, the loopback wall, WASI capabilities). A component can carry
shared memory (verified: it validates and compiles), but nothing in the
component model can *start a thread* until layer 4 exists. Bridging that gap
without the SET intrinsics would mean inventing spawn semantics ahead of an
unratified spec, inside a measured TCB — the one place in this system where
guessing is unacceptable.

## What shipped alongside this investigation

**CPU fair-share is now on by default**, proportional to purchased `cpuShare`
(`_cpu_weight_for`, `wasm/wasm_manager.py`; tests in
`test/wasm-cpu-weight.test.mjs`). A tenant holding 0.25 of a node gets
cpu.weight 2500 of 10000, so under contention it gets what it paid for.

This is the prerequisite for every parallelism story, and it is deliberately
the *weight* and not the cap: a weight never throttles anyone (cgroup-v2 only
consults it when CPU is contended, so apps still burst to idle cores), while a
hard cap throttles even an idle node and stays opt-in behind
`WASM_CPU_MAX_PCT`. Turning fair-share on only *after* parallel guests exist
would be closing the door behind the horse. `WASM_CPU_WEIGHT=0` restores the
old unweighted behaviour.

## What to do next (SET is real; the gate is now the toolchain)

The engine half is done and measured. The remaining sequence:

1. **Guest toolchain.** No wasi-libc SET thread model exists, so guests are
   hand-written WAT today. Porting musl's pthreads onto SET primitives is the
   real next project — comparable in scale to upstream's coop-threads
   directory. Until it lands, the audience for SET is hand-written or
   compiler-generated-by-us wasm, not `clang -pthread`.
2. **Review before the Dockerfile chain.** `wasmtime-set-threads.patch.wip`
   stays out of `wasm/Dockerfile.wasmtime` until the concurrency design in
   `set_threads.rs` has been reviewed by someone who did not write it. It is
   entering a measured TCB; the TSan and soak evidence above is necessary,
   not sufficient.
3. **Platform plumbing.** Already designed and shipped for coop threads, and
   it generalises directly: compile-probe → byte-marker sniff → publish stamp
   → claim gate → per-tenant engine flag → fleet-AND. Add a `set` capability
   beside `coopThreads` rather than inventing a new shape. Note the
   compile-probe must use `set-spawn-parallel.wat`, not a help-text grep — the
   feature flags lie.
4. **Revisit the hard cap.** Real parallelism is exactly the case where an
   operator may genuinely want `cpu.max` and not just the weight: one tenant
   spawning `available_parallelism` threads on an idle node is fine, but the
   contended case now has real teeth. `thread.available_parallelism` already
   reports the tenant's purchased slice, which is the first line of defence.
5. **Upstream.** The CLI-flag fix and the shared-func-type accessor fixes are
   independently useful and worth sending to bytecodealliance/wasmtime#9466.
   The execution-view design is worth *proposing* there, but it is ours to
   defend: it deliberately implements less than the full SET proposal (see
   "Sharedness, stated exactly") and trades completeness for provable
   soundness.
