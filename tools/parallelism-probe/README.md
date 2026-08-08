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
| `set-nested-spawn.wat` | a recursive spawn tree is BOUNDED (live cap + creation-rate limit) and the host survives. Nested spawn is supported, not refused — the older "must trap" description was wrong | `wasmtime run $W --invoke 'run()' set-nested-spawn.wat` → `1` |
| `set-spawn-fallback.wat` | historical: loads-and-runs probe from when spawn could only fail. Its counter now **races by design** (no join) — use `set-spawn-parallel.wat` for anything you intend to measure | |

## The C probes: ordinary programs, through the real toolchain

Build each with the blessed image and run it on the patched engine:

```sh
docker build -f wasm/Dockerfile.wasipsetc-build -t enclave-wasipsetc-build:local wasm/
docker run --rm -v "$PWD":/src enclave-wasipsetc-build:local worker-io.c -O2 -o worker-io.wasm
W="-W threads,shared-everything-threads,component-model-threading,shared-memory"
wasmtime run $W -S cli worker-io.wasm
```

| file | what it proves |
|---|---|
| `pthread-scaling.c` | real `pthread_create` parallelism, the 15.8x measurement |
| `worker-io.c` | a worker does real WASI: `printf`, `fflush`, `clock_gettime` |
| `worker-trap.c` | a trapped worker does not hang its joiner (the death hook) |
| `worker-spin-teardown.c` | **an ordinary program**: detach a compute thread, return from `main`. Used to wedge teardown forever and pin a core; now exits in ~0.2s |
| `worker-block-teardown.c` | a worker asleep 12s in a HOST call does not hold teardown (the third stop path) |
| `worker-exit.c` | `exit()` on a worker ends the component instead of stranding the joiner |
| `worker-file-io.c` | **two** file reads/writes with a second thread alive do not deadlock — the object lock `get_read_stream` takes is released |
| `worker-dir-io-lock.c` | a FAILED stream lookup (`fopen` on a directory) releases that lock too |
| `worker-ns-exhaust.c` | running out of fd namespaces fails that THREAD, instead of ending the component with no diagnostic |
| `worker-dup2.c` | `dup2` on a worker returns a descriptor that is actually usable |
| `worker-fd-alias.c` | a cross-thread fd FAILS with `EBADF` instead of silently aliasing another file |
| `worker-fd-recycle.c` | a DEAD thread's fd does not become a LIVE thread's fd (namespaces are monotonic, not recycled) |
| `worker-spawn-churn.c` | thread CREATION is rate-limited, not just concurrency: spawn-then-exit used to churn 35k threads in 2s past any cap |
| `worker-stdio-orphan.c` | a worker trapping while holding stdout's lock (explicit `flockfile`) does not wedge stdio |
| `worker-stdio-orphan-internal.c` | the same through the INTERNAL `FLOCK` path `printf` takes — the layer musl never registered |
| `worker-mem-grow.c` | `-W max-memory-size` bounds SHARED-memory growth, from a worker thread |

Each file's header comment states the old symptom and the expected new output,
so a regression is visible without reading this table.

Two ways to read `set-spawn-parallel.wat`, and the first is the one that
cannot be faked:

```sh
# constant work PER THREAD: `real` stays ~0.9s while `user` climbs linearly
for n in 1 2 4 8 16 32; do time wasmtime run $W --invoke "run($n, 900000000)" set-spawn-parallel.wat; done

# constant TOTAL work: the speedup a real workload sees (14.0s -> 0.50s)
for n in 1 2 4 8 16 32; do time wasmtime run $W --invoke "run($n, $((14400000000 / n)))" set-spawn-parallel.wat; done
```

Under ThreadSanitizer (`-Zsanitizer=thread` + `-Zbuild-std`, nightly) all
four executable SET probes are clean. **Build TSan with `--cfg rustix_use_libc`**
or the results are noise: fiber stacks are freed through `rustix`'s raw
`munmap`, which TSan cannot intercept, so a recycled stack address is reported
as a race with the thread that died. The discriminator is `run(200, 1, 2000)` —
one worker at a time, no concurrency possible — which still reported 12 races
before the flag and zero after. Verify your TSan build actually reports races
before trusting a clean run — a miscompiled or uninstrumented binary is
silently green. TSan instruments the host runtime, not JIT-compiled guest
code, so it covers instance/store lifetimes and the `SharedMemory` growth
lock, not guest-level accesses.
