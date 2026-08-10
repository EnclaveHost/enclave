# Rust guests on SET (shared-everything threads)

Real OS threads, one shared linear memory, inside a wasip2 component. Measured
**7.51x at 8 threads** with the recipe in `build.sh`.

## The result

200M-iteration dependent chain **per thread**, so the total work scales with the
thread count and constant wall time is the scaling signature:

| threads | real | user | cores used |
|---|---|---|---|
| 1 | 0.207 s | 0.200 s | 0.97x |
| 2 | 0.207 s | 0.398 s | 1.92x |
| 4 | 0.207 s | 0.775 s | 3.74x |
| 8 | 0.206 s | 1.547 s | **7.51x** |

## Build

```sh
./build.sh                       # IMG=… OUT=… to override
W="-W threads,shared-everything-threads,component-model-threading,shared-memory"
wasmtime run $W -S cli rustset.wasm 8
```

The same binary with the SET flags **off** fails closed:

```
`thread.spawn-indirect` requires the shared-everything-threads proposal
```

which is the check that you are really measuring SET and not accidentally
running a sequential fallback.

## Why it is shaped like this

Rust is compiled to a **staticlib** and handed to the SET `clang` wrapper for
the final link. The wrapper already owns the three things that are easy to get
wrong — `--sysroot=/opt/wasip2-set-sysroot`,
`-Wl,--shared-memory,--max-memory=1073741824,--export-table`, and the
`set-componentize` pass that wires `thread.spawn-indirect` — so reusing it means
the Rust path and the C path cannot drift.

Three constraints are load-bearing. Each one produces a confusing failure if
dropped:

* **`-Z build-std=core`.** The precompiled `core`/`std` for `wasm32-wasip2` are
  built WITHOUT atomics, and objects without them cannot be linked into a
  shared-memory module. Rebuilding `core` with the atomics features is what
  makes the link possible at all.
* **`-C target-feature=+atomics,+bulk-memory,+mutable-globals`.** The same set
  the C wrapper forces. It must be applied to `core` as well, which is why it
  goes in `RUSTFLAGS` rather than on one crate.
* **`no_std`.** Rust's `std` for wasip2 bundles its own wasi-libc, which fights
  the SET sysroot. Threading therefore comes from the SET libc's pthreads via
  `extern "C"` (`pthread_create`/`pthread_join`), not `std::thread`.

## What this does NOT give you

`std::thread` does not work, and this recipe does not make it work. Rust's std
threading for wasm targets `wasm32-wasip1-threads`, which spawns through the
**wasi-threads host import** (`wasi.thread-spawn`) — a different mechanism from
the component model's `thread.spawn-indirect` builtin that SET uses. Making
`std::thread` route to SET means building Rust's std against the SET sysroot,
which is a std-level port, not a flag.

So today a Rust SET guest gets: `core`, shared memory, atomics, and real
threads by FFI. It does not get `std`, `String`/`Vec` (without bringing your own
allocator), or `std::sync`. `core::sync::atomic` works and is how the example
coordinates.

## The benchmarking trap, recorded because it nearly shipped

The first version of this measured an XOR sum, then an LCG chain. **Both were
folded by LLVM** — 800M iterations "ran" in 0.106 s at *every* thread count,
which reads like perfect scaling and is actually the loop not existing. LLVM
closed-forms affine recurrences.

`core::hint::black_box` inside the loop is what makes the work real. Check any
threading benchmark here two ways before believing it:

1. does wall time respond to the iteration count at all?
2. does `user` time scale with the thread count?

A folded loop passes neither, but it passes a naive "8 threads were fast" eye
test — which is the same failure mode as a probe encoding a bug as the spec,
and this corpus has had eight of those.
