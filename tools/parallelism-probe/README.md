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
`docs/wasm-parallelism.md` for why a *component* app still cannot reach it,
and what has to land upstream first.

Re-run this against any new engine before believing a claim about threading
support — the feature flags lie (`-W shared-everything-threads` was a silent
no-op upstream until we wired it).
