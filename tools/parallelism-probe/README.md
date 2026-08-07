# parallelism-probe

Reproducible evidence for `docs/wasm-parallelism.md`: does our engine actually
execute wasm on multiple cores, and do guest atomics over shared memory work?

It rebuilds the mechanism the deleted wasi-threads crate used — **one shared
linear memory, one `Store` per OS thread** (a `Store` is not `Sync`, so what
gets shared is the memory, never the store). Each thread instantiates the same
module against the same imported `SharedMemory`, burns CPU, and bumps a guest
atomic counter in that shared memory.

## Run it

Needs a wasmtime checkout to build against (the `Cargo.toml.example` points at
a sibling source tree; adjust the path):

```sh
mkdir -p probe/src && cp main.rs probe/src/main.rs
cp Cargo.toml.example probe/Cargo.toml     # edit the wasmtime path
cd probe && cargo build --release

# same TOTAL work, sequential vs parallel
./target/release/setharness 1 4800000000
./target/release/setharness 8 600000000
```

## What it proved (wasmtime 49, 32-core host, 2026-08-07)

```
1 thread  (sequential): wall=1167ms
8 threads (parallel)  : wall=149ms      -> 7.8x
guest_atomic_counter=8                  -> guest-side shared-memory atomics OK
```

Real multi-core wasm, on the engine we ship. Read
`docs/wasm-parallelism.md` for the full story.

Re-run this against any new engine before believing a claim about threading
support — the feature flags lie (`-W shared-everything-threads` was a silent
no-op upstream until we wired it).

## The SET probes (2026-08-07): components really spawn threads now

`thread.spawn-ref` / `thread.spawn-indirect` spawn real OS threads on our
engine — measured **27.9x on 32 threads** (16-physical-core EPYC 9115).
All five SET `.wat` files here need the patched wasmtime (`wasm/wasmtime-set-threads.patch.wip`, deliberately not in
the Dockerfile chain) and this flag set:

```sh
W="-W threads,shared-everything-threads,component-model-threading,shared-memory"
```

| file | what it proves | run it |
|---|---|---|
| `set-spawn-parallel.wat` | **the benchmark.** N threads, futex join, real speedup | `wasmtime run $W --invoke 'run(16, 900000000)' set-spawn-parallel.wat` |
| `set-spawn-indirect.wat` | `thread.spawn-indirect` through a shared funcref table → `7` | `wasmtime run $W --invoke 'run()' set-spawn-indirect.wat` |
| `set-spawn-stress.wat` | spawn/join churn + contended atomics + cross-thread `memory.grow`; the TSan and soak target | `wasmtime run $W --invoke 'run(500, 16, 20000)' set-spawn-stress.wat` → `8000` |
| `set-available-parallelism.wat` | `thread.available_parallelism` answers the TENANT's slice | `ENCLAVE_AVAILABLE_PARALLELISM=8 wasmtime run $W --invoke 'run()' ...` → `8` |
| `set-nested-spawn.wat` | **negative probe.** A worker calling `thread.spawn-*` again must TRAP that worker (clean wasm backtrace, exit 1), never abort the process and never race | `wasmtime run $W --invoke 'run()' set-nested-spawn.wat` |
| `set-spawn-fallback.wat` | historical: loads-and-runs probe from when spawn could only fail. Its counter now **races by design** (no join) — use `set-spawn-parallel.wat` for anything you intend to measure | |

Two ways to read `set-spawn-parallel.wat`, and the first is the one that
cannot be faked:

```sh
# constant work PER THREAD: `real` stays ~0.9s while `user` climbs linearly
for n in 1 2 4 8 16 32; do time wasmtime run $W --invoke "run($n, 900000000)" set-spawn-parallel.wat; done

# constant TOTAL work: the speedup a real workload sees (14.0s -> 0.50s)
for n in 1 2 4 8 16 32; do time wasmtime run $W --invoke "run($n, $((14400000000 / n)))" set-spawn-parallel.wat; done
```

Under ThreadSanitizer (`-Zsanitizer=thread` + `-Zbuild-std`, nightly) all
four executable SET probes are clean. Verify your TSan build actually reports races
before trusting a clean run — a miscompiled or uninstrumented binary is
silently green. TSan instruments the host runtime, not JIT-compiled guest
code, so it covers instance/store lifetimes and the `SharedMemory` growth
lock, not guest-level accesses.
