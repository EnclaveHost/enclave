# Multi-core Wasm on the platform: what works, what doesn't, and why

Written 2026-08-07 after building against the engine rather than reading about
it. Every claim below was produced by running something; the commands are
reproducible from `tools/parallelism-probe/`.

Short version: **real multi-core parallelism works on our engine today
(measured 7.8x on 8 threads), but not through a path a component app can use
yet.** Shared-everything-threads (SET), the proposal that would make it
reachable from a component, is not implemented in wasmtime — and the previous
mechanism that did work (wasi-threads) was deleted upstream. This file records
the exact frontier so the next person does not re-derive it.

## The three threading models, kept distinct

They get conflated constantly, so:

| model | what it gives | status here |
|---|---|---|
| **cooperative threads** (wasip3 🧵) | `pthread`/`std::thread` interleaved on one core — concurrency, thread-shaped code ports | **SHIPPED** 2026-08-07, see docs/wasip3-threads.md |
| **wasi-threads** (p1) | real OS threads, shared linear memory, true parallelism | **DELETED from wasmtime** (commit b4b23fe583, "Remove wasi-threads and wasi-common" #13558) |
| **shared-everything-threads** (SET) | true parallelism, reachable from a component | **not implemented** — see the layer map |

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

### The actual wall: `thread.spawn-*` needs a thread-safe Store

"Shared everything" means a spawned thread runs in the **same instance** —
same memory, same tables, same globals. In wasmtime, entering guest code
requires `&mut Store`, so it is exclusive *by construction*. This is not a
feature flag; the borrow checker rejects it outright:

    error[E0499]: cannot borrow `store` as mutable more than once at a time

And the escape hatch that made wasi-threads work — separate `Store`s sharing
one *imported* memory — is unavailable to components: a component instantiates
its own memory internally, and while it can import a core *module*, it cannot
import a memory *instance* from outside (tested). Two component instances are
therefore two memories, which is the opposite of shared-everything.

So the remaining work is not "one more layer". It is making wasmtime's
execution model thread-safe — store bookkeeping, fuel, epoch interruption,
trap handling, stack limits and GC roots all become concurrent — which is the
core rearchitecture upstream has not started. That is the honest boundary, and
it is now demonstrated by a compile error rather than asserted.

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

## What DOES work: measured 7.8x, and how

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

## What to do when SET becomes real

The trigger to watch is layer 4/5, not the feature flag: SET is usable the day
(a) wasmtime stops bailing on `thread.spawn-*` and (b) wasi-libc grows a SET
thread model. Concretely:

1. Re-run `tools/parallelism-probe` and the SET construct probes against the
   new engine.
2. Apply `wasmtime-set-cli-flag.patch.notinchain` (or drop it if upstream took
   the fix) and move it into the Dockerfile chain.
3. The platform plumbing is already designed and shipped for coop threads and
   generalises directly: compile-probe → byte-marker sniff → publish stamp →
   claim gate → per-tenant engine flag → fleet-AND. Add a `set` capability
   beside `coopThreads` rather than inventing a new shape.
4. Revisit the hard cap: real parallelism is the case where an operator may
   genuinely want `cpu.max`, not just the weight.

Do not attempt a private fork of SET semantics before the spec settles. The
value of this platform is that the thing being attested is reviewable.
