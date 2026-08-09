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
| `worker-ns-exhaust.c` | running out of fd namespaces fails that THREAD, instead of ending the component with no diagnostic. Also the second reproduction of the round-9 borrowed-`free()` CRITICAL: it went from a 500s hang with an out-of-bounds trap to 26s and `SURVIVED: ran=262500 failed_open=357` |
| `worker-dup2.c` | the whole `dup2`/`dup3` target contract, asserted rather than printed: wrong in four different ways across four rounds, so this one exits non-zero |
| `worker-fd-alias.c` | a cross-thread fd FAILS with `EBADF` instead of silently aliasing another file |
| `worker-fd-recycle.c` | a DEAD thread's fd does not become a LIVE thread's fd (namespaces are monotonic, not recycled) |
| `worker-spawn-churn.c` | thread CREATION is not bounded by the concurrency cap: spawn-then-exit churns ~35k threads in 2s past any `ENCLAVE_MAX_SET_THREADS`. The rate limiter that answered this is now OFF by default — set `ENCLAVE_MAX_SET_SPAWN_RATE=4096` to see it stop the chain |
| `worker-spawn-retry-bomb.c` | what the rate limiter COSTS when an operator turns it on: a guest that retries a refusal spins, 45.1 CPU-seconds per 2 wall seconds against 13.5 with it off |
| `worker-preopen-retry.c` | a thread that cannot build its preopen table fails alone, without leaking a host resource handle per retry. **Cannot reach the bug it names** — it fails at preopen index 0, so the cleanup loop never runs and it passes identically against the libc it claims to regression-test. Kept for the retry/leak half; `worker-preopen-oom.c` is what actually covers the failure path |
| `worker-preopen-oom.c` | (`HOLE=0` fails on EVERY build — total OOM hits `cabi_realloc`'s `abort()`, a wasip2 bindings property, not a regression) the probe that DOES reach it: an allocation failure at preopen index >= 1 with a live sibling. Two different defects hide at two different `HOLE` sizes — the round-7 re-entrancy deadlock at 8, and the round-9 `free()` of a borrowed pointer at 9..11. Sweep the hole; it is a byte offset into dlmalloc's layout and moves when any libc struct changes |
| `worker-stdio-leak.c` | a worker cannot acquire a standard descriptor (`close(1); open()` used to hand back bare fd 1, and main's exit flush delivered the guest's bytes to the OPERATOR's log) — and still has a working stderr, which the first attempt at the fix silently took away |
| `worker-file-owner.c` | a `FILE` may only be RESOLVED by the thread whose namespace its `fd` names, while everything that does not resolve it stays native-identical. Covers `fflush(NULL)`, explicit `fflush`, buffered and over-buffer cross-thread `fwrite`, and the thread-exit flush |
| `worker-stdio-freopen.c` | a failed `freopen` on a worker does not wedge the shared stdout for every other thread (its failure path is `fclose(stdout)`) |
| `worker-std-redirect.c` | the MAIN thread (= the request handler under `serve`) redirecting fd 1 does not send a worker's `printf` to the operator's log — the door round 10's worker-only rule left open — AND the non-owning thread's line-buffered write is BUFFERED rather than discarded |
| `worker-fclose-owner.c` | `fclose` on another thread's FILE is refused, not performed: performing it destroys the owner's buffered bytes and frees the FILE underneath it, which trapped the component (on one build from inside a HOST call) |
| `worker-stdio-orphan.c` | a worker trapping while holding stdout's lock (explicit `flockfile`) does not wedge stdio |
| `worker-stdio-orphan-internal.c` | the same through the INTERNAL `FLOCK` path `printf` takes — the layer musl never registered |
| `worker-mem-grow.c` | `-W max-memory-size` bounds SHARED-memory growth, from a worker thread. Now ASSERTS it: pass the cap in via `--env MAX_MEMORY_SIZE=<same value>`. It used to `return 0` whatever it measured, so it would have reported success on the very build whose bug it exists to catch |
| `worker-xerr-owner.c` | **rounds 11-13 changed the read-refusal flag three times and shipped no probe; this is it.** A refusal on the WRONG thread must not poison the stream for its OWNER, must not silence it, and must not spin. Asserts only native-true properties, so the same source is the control. Discriminates five ways: native PASS, r13c PASS, r13b FAIL x3 (F_EOF era — owner's own `fgets` returns NULL with data still there), r13a FAIL x2 (F_ERR era, BOTH stream kinds), r12a/r10f FAIL (flagless refusal spins). Two arms are load-bearing: the F_EOF arm must NOT `clearerr` first, and the sibling's read on the claimed stream must be SHORT, or NATIVE ends at EOF and the probe encodes a bug as the spec |
| `worker-wide-poison.c` | the WIDE analog of the same bug, on the WRITE side: `__fputwc_unlocked` turned a refused non-owner write into `F_ERR` on the SHARED FILE. `fputwc.c` is not touched by the patch at all, which is why the F_XERR sweep missed it. native PASS / r12a, r13a, r13c FAIL / r14a+ PASS |
| `wide-read-poison.c` | and the wide READ side, which round 14's fix left behind. A non-owner can consume the first bytes of a multibyte character straight out of the SHARED buffer — no descriptor needed — and arrive at `fgetwc`'s `!first` branch, which wrote `F_ERR`. Use a file of split 3-byte characters. native PASS / r13c, r14a FAIL / r14b PASS |
| `robust-cycle.c` | the death hook and `__pthread_exit` BOTH walk `robust_list` following guest-writable `_m_next` pointers while `__thread_list_lock` is held; a forged self-cycle wedges every sibling's `pthread_create`/`pthread_join`. Two arms, `--env MODE=trap` and `MODE=exit` — round 14 bounded only the trap twin, so r14a hangs the `exit` arm. r14b passes both. Note musl links every non-`NORMAL` mutex into `robust_list`, so a plain `PTHREAD_MUTEX_RECURSIVE` populates it: not exotic |
| `worker-stderr-vfprintf-state.c` | **UNRESOLVED, committed so round 16+ starts from evidence rather than a claim.** Whether round 12's dead-stack detach (`f->buf = 0` with `buf_size == 0`) leaves a shared unbuffered stream broken. Its author reported loss on r10f/r12a/r13c alike; as committed it measures the OPPOSITE (PRESENT on r14a/r13c, LOST only on r10f). Read the header before trusting either. Do NOT change musl's buffer handling on it without a run that reproduces |

Each file's header comment states the old symptom and the expected new output,
so a regression is visible without reading this table.

**Exit codes are pass/fail only, not a code.** WASIp2's `wasi:cli/exit` carries a
`result`, not a number, so every non-zero guest exit arrives at the host as `1`
(verified: a guest returning 3 shows up as exit 1). The specific code is in the
probe's stderr line. Do not write a harness that switches on the number.

**Prove a fix against the previous image, always.** A probe encoding a bug as the
spec has now happened six times in this directory — most recently in the first
draft of `worker-file-owner.c`, which asserted that a cross-thread `fwrite` must
write zero bytes. It must not: `fwrite` copies into the FILE's shared buffer and
only resolves `f->fd` when that buffer drains, so a small cross-thread write
followed by the owner's flush is correct, and native does exactly that. Build the
same source with gcc and run it before deciding what "correct" means.
`enclave-wasipsetc-build:r8` (round-7 libc) and `:r9c` (round-9 libc) are kept
for these A/Bs.

**Two more instances since**, both caught by a native control rather than by
review: `worker-file-owner.c`'s first draft asserted a cross-thread `fwrite`
must write zero bytes (it must not — `fwrite` buffers, and only draining needs
an fd), and `worker-fclose-owner.c`'s first draft used the FILE after a foreign
`fclose`, which made the NATIVE arm abort with "double free or corruption". In
both cases the probe was wrong, not the libc. Build the same source with gcc
before deciding what correct means — every time.

## `set-http-handler.c`: the shape the platform actually runs

Every probe above is a **command** component under `wasmtime run`. The platform
runs HTTP apps as **reactor** components under `wasmtime serve`, and until round
9 nothing had ever been one — which is how eight adversarial rounds missed that
`_initialize` traps on the first spawned thread and hangs the request forever.

This one exports `wasi:http/incoming-handler` AND spawns. It needs bindings
generated once (the toolchain image has no C `wasi:http` bindgen):

```sh
cp -r <wasmtime>/crates/wasi-http/wit ./wit
sed -i '/import wasi:clocks\/timezone/d' wit/deps/cli.wit   # unresolved dep in that tree
wit-bindgen c --world wasi:http/proxy ./wit --out-dir gen

docker run --rm -v "$PWD":/src enclave-wasipsetc-build:local \
    set-http-handler.c gen/proxy.c gen/proxy_component_type.o \
    -mexec-model=reactor -O2 -o set-http.wasm

wasmtime serve $W -S cli -W max-memory-size=268435456 --addr 127.0.0.1:8080 set-http.wasm
curl http://127.0.0.1:8080/        # -> "spawned=8 joined=8"
```

`-S cli` is required: the SET libc imports `wasi:cli/exit`, which the bare proxy
world does not provide. A hang with `hyper::Error(IncompleteMessage)` and a
`_initialize` trap in the log is the round-9 bug; `spawned=8 joined=8` is the fix.

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
