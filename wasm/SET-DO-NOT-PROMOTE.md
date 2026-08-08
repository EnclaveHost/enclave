# SET threads: DO NOT add to Dockerfile.wasmtime yet

`wasmtime-set-threads.patch.wip` + `wasmparser-set-relax.patch` are the
shared-everything-threads (⚡) engine changes. The guest toolchain that targets
them (`Dockerfile.wasipsetc-build`, `wasi-libc-set-threads.patch`,
`set-componentize/`) is done and measured. The platform `set` capability
plumbing is wired and tested (`test/wasm-set.test.mjs`).

**The engine patch is deliberately NOT in `Dockerfile.wasmtime`'s chain**, and
the `.wip` suffix (which the patch-check CI glob does not match) enforces that.

## Status 2026-08-08

The two blockers from the 2026-08-07 review are **FIXED**, and the root cause of
the first one turned out to be worse than recorded — see
`docs/wasm-parallelism.md` → "2026-08-08". Summary:

* **Worker threads can now do WASI.** The old "execution view" (one core module
  re-instantiated with stubbed imports) was not merely incomplete, it was
  silently unsound: Cranelift devirtualizes calls to statically-known imports
  into direct calls to the callee's compiled body while loading the callee vmctx
  from the import slot, so a worker ran the PRIMARY's code under a mistyped
  vmctx. A worker is now a full instantiation of the whole component in its own
  `Store`, sharing only linear memory. Proven by
  `tools/parallelism-probe/set-worker-import-foreign.wat`.
* **The canonical ABI no longer borrows a `shared` memory.** `GuestMemory` /
  `GuestMemoryMut` copy through volatile reads and validate the copy. Proven by
  `set-cabi-race.wat` + `cabi_race.rs`, with a negative control showing the
  harness detects the old behaviour.

Verification bar met: worker `printf`/`clock_gettime`/`socket()`, trapping
worker no longer hangs its joiner, 15.6x at 16 threads, soak 8000, 187 + 228
wasmtime tests, 648 enclave tests, TSan clean (with `--cfg rustix_use_libc` —
see the doc), patch regenerated and verified to rebuild a working engine from a
fresh checkout.

## Why it is STILL not promotable

A fresh four-reviewer adversarial pass on the NEW design found **1 CRITICAL and
14 HIGH**. The pattern the previous rounds established held again: each fix's
new surface hid the next bug. These must be fixed and re-reviewed.

### CRITICAL

1. **A guest can abort the host process.** `CliSetWorkerHost::new_host`
   (`src/commands/run.rs`) builds a worker's `Host` with only `wasip1_ctx` and
   `limits` set, but workers instantiate against the PRIMARY's linker, whose
   accessors `unwrap()` `wasi_nn_wit` / `wasi_http` / `wasi_config` /
   `wasi_keyvalue` / `wasi_tls`. A worker calling any of them panics, and
   `worker_main` turns a panic into `std::process::abort()`. Demonstrated with a
   core dump under `-S http` in three guest instructions. Needs BOTH: the worker
   context built the same way the primary's is, AND `worker_main` not converting
   an embedder-side panic (raised before any guest state was touched) into a
   process kill. `serve.rs` escapes only by accident.

### HIGH — engine / worker model

2. **A worker that never returns wedges teardown forever and pins a core, and
   `--wasm timeout` does not stop it.** Two reviewers hit this independently,
   from both directions, and it is the most likely thing to bite in production
   because **an ordinary program reproduces it** — repro
   `tools/parallelism-probe/worker-spin-teardown.c` just detaches a compute
   thread and returns from `main` without joining, which is what any worker
   pool does. `Store::drop` joins unconditionally; the main thread parks in
   `futex_do_wait` while the worker stays in state R burning a core, until
   SIGKILL.

   Neither escape hatch reaches it. The teardown cancel flag is read only by
   the futex parking spot, and a busy loop never parks (a *parked* worker is
   correctly woken — that part of the earlier fix works). The epoch deadline is
   `ENCLAVE_SET_EPOCH_TICKS` **increments** (default 600), but `--wasm timeout`
   bumps the engine epoch exactly **once** — enough for the main thread
   (deadline 1), never for a worker. Confirmed both ways with `-W timeout=2s`:
   default 600 hangs (exit 124); `ENCLAVE_SET_EPOCH_TICKS=1` exits at 2.0s with
   the worker trapping `interrupt`.

   The same hole swallows a worker blocked in a HOST call, which the "workers
   can now do WASI" fix is precisely what enables: measured 12 s of
   guest-controlled host block against a 1 s embedder timeout, with essentially
   zero CPU. Under `serve` a Store is created per request on a tokio worker, so
   each occurrence permanently consumes a tokio worker and a core; the
   process-global cap bounds it at 128 per node — i.e. node-wide DoS from
   ~6 lines of guest wasm, or from an unlucky ordinary program.

   The design's own reasoning already licenses the fix: workers hold no
   primary-store pointers, so the join need not be unconditional. Teardown
   should actively drive interruption (bump the engine epoch until this store's
   workers drain, or arm the deadline so a single embedder bump trips it),
   bound or detach the join, and the docs must say that a *periodic* epoch
   ticker is required — single-shot `--wasm timeout` is not enough.
3. **The worker epoch deadline bounds nothing on either CLI host**, beyond the
   above. With no timeout and no profiling, `epoch_interruption` is never
   enabled at all, so compiled code carries no epoch checks and no ticker
   exists — which is the fleet's configuration (`wasm_manager.py` passes
   neither). `serve` with a timeout gives a 30 s floor per worker regardless of
   the timeout value.
4. **Every per-store resource limit is multiplied by the worker count** —
   `max-memory-size` (the RAM-budget gate on this platform), `max-instances`,
   `max-table-elements`, `max-resources` are enforced per worker, up to 129x.
   Fuel diverges both ways: `serve` gives each worker the full budget; `run`
   gives workers zero, so `--wasm fuel=N` + SET is a guaranteed hang (measured).

### HIGH — canonical ABI

5. **Guest-triggerable host panic on an empty `list<f32>`/`list<f64>` over a
   shared memory** — the alignment assert is invalid once the bytes are a
   host-owned `Vec<u8>`. FIXED 2026-08-08 (assert removed; `chunks_exact` is
   bytewise), needs re-review.
6. **The `transcoder_memories` refusal is unreachable dead code.** FACT emits a
   shared adapter memory with `maximum: None`, which is invalid wasm, so any
   fused adapter over a shared memory panics in `adapt.rs`'s
   `.expect("invalid adapter module generated")` — a guest-controlled panic in
   `Component::from_file`, not a `bail!`. Applies to ANY adapter needing memory,
   not just transcoders.
7. **The refusal is also mis-placed**: it runs after the initializer loop, and
   core `start` sections — which can call adapters and can spawn threads
   (demonstrated) — execute inside that loop.

### HIGH — guest libc

8. **The death hook deadlocked when the trap landed in the tail of
   `__pthread_exit`** (`self->tid` is already 0 there while the thread still
   holds the thread-list lock). FIXED 2026-08-08: the tid now comes from
   `start_args`, and the lock is taken without `__tl_lock()`. Needs re-review.
9. **The `DT_EXITED` early return leaked the thread-list lock** — reproduced as a
   whole-process deadlock. FIXED 2026-08-08 (single unlock on every path).
10. **The hook runs with an already-expired epoch deadline**, so on the one path
    that matters most — killing a runaway worker — it traps at its own function
    entry and does nothing. Needs a protected budget; NOT fixed.
11. **`global_network` was a component resource handle in a shared static**, so
    any threaded network app trapped its workers (`unknown handle index`).
    FIXED 2026-08-08 (thread-local). Needs re-review.
12. **Silent cross-thread fd aliasing.** Both threads' tables allocate the
    lowest free index, so a worker's fd 4 and main's fd 4 are different files
    while musl's `FILE` objects stay shared: reproduced writing a worker's
    buffered secret into main's file, with every call returning success. Needs
    cross-thread fd use to FAIL, not alias. NOT fixed.
13. **A worker trapping while holding a FILE lock wedged stdio for every
    thread.** Two layers: the ordinary `printf` path never registers the FILE,
    and the non-coop branch of `__do_orphaned_stdio_locks` stored a value
    `__lockfile` can never CAS from. Second layer FIXED 2026-08-08 (SET now
    takes the cooperative branch); the unregistered-FILE layer is NOT fixed.
14. **`exit()` on a worker does not exit the component, it wedges it** —
    atexit handlers run, `__stdio_exit` poisons every FILE lock, `proc_exit`
    surfaces only as a per-thread trap, and the main thread then hangs. Needs
    engine-side propagation of a worker's `I32Exit`. NOT fixed.

### Also open (MEDIUM/LOW, see the reviews)

Per-thread state leaks ~320 B/thread with no reclamation; the Dockerfile never
asserts the death-hook export exists; `libc.threads_minus_1` double-decrement
(FIXED alongside #8); `SetViewPlan::install` preconditions are `debug_assert`
only and `Component::ptr_eq` does not cover imports; `exit_guest_sync_call` is
skipped on the error path; the death hook does not run for pre-start worker
failures; the `refuse!` diagnostic is silenced process-globally; spawning from a
core instance that defines no shared memory silently gets a PRIVATE memory
instead of a refusal; big-endian double byte-swap on shared list lifts (FIXED);
several stale safety comments in `set_threads.rs` and `store.rs` that describe
the OLD design and would mislead the next reviewer.

### Open question for the platform embedder (not reproducible on the CLI)

A worker's `memory.grow` on the shared memory may escape the embedder's memory
`ResourceLimiter`, bounded only by the module's *static* declared maximum (up to
4 GiB on wasm32) rather than the tenant's purchased slice. This could not be
settled from the CLI because `-W max-memory-size` does not bind shared-memory
growth even for the primary (a probe grew to ~124 MB under a 16 MiB cap). Check
it against `wasm_manager.py`'s real limiter before enabling SET — on this
platform `-W max-memory-size` is the RAM-budget gate.

### What the hostile-guest pass could NOT break (so these are known-good)

No host panic, abort or segfault was achieved on the accepted-module path. The
canonical ABI rejected every malformed pointer/length pair cleanly with peak
host RSS ~3 MB: 4 GiB string and list lengths, `ptr+len` wrap-around, a
`cabi_realloc` returning out of bounds, and a `cabi_realloc` that traps. A
parked worker is woken correctly at teardown; worker stack overflow traps
cleanly and dies alone; the death hook releases a joiner without upsetting the
sync-call bookkeeping; a recursive spawn tree of parked workers held at exactly
the cap with no slot leak; segmented memory init is refused as designed; cross-
thread fd use from a *worker* to a main-thread fd gives `EBADF`; `_exit()` from
a worker is contained; 8000 spawn/join cycles leak no cap slots.

(Note the `EBADF` result and finding 12 above are not in conflict: they are
different directions and different allocation orders. The aliasing case is
reproducible and is the one that matters.)

## Promotion sequence, when it is finally earned

Fix the above, re-run the verification bar, get a fresh adversarial pass that
clears, then: rename `.wip` → `.patch`, add the wasmparser vendor+relax step and
the SET patch to `Dockerfile.wasmtime`, extend `wasmtime-patch-check.yml`, then
the toolchain-dispatch → `WASMTIME_IMAGE` repin measurement event
(Steven-gated). Not before.
