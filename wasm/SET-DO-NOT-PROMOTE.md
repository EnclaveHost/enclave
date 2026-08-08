# SET threads: DO NOT add to Dockerfile.wasmtime yet

`wasmtime-set-threads.patch.wip` + `wasmparser-set-relax.patch` are the
shared-everything-threads (⚡) engine changes. The guest toolchain that targets
them (`Dockerfile.wasipsetc-build`, `wasi-libc-set-threads.patch`,
`set-componentize/`) is done and measured. The platform `set` capability
plumbing is wired and tested (`test/wasm-set.test.mjs`).

**The engine patch is deliberately NOT in `Dockerfile.wasmtime`'s chain**, and
the `.wip` suffix (which the patch-check CI glob does not match) enforces that.

## Status 2026-08-08 (round 3)

The 1 CRITICAL + 15 HIGH from the round-3 adversarial pass are **FIXED**, and
the open question for the platform embedder turned out to be a real hole and is
**closed**. Every fix has a repro that failed before it and passes after; the
repros live in `tools/parallelism-probe/` as ordinary C programs, not
hand-written adversarial WAT.

| finding | fixed by | proven by |
|---|---|---|
| CRITICAL: a guest could abort the host process | one `build_host` for the primary and every worker; a panic on a worker kills only that worker | `tests/all/component_model/set_threads.rs::worker_panic_does_not_abort_the_process` (its failure mode is that the test binary dies) |
| a non-returning worker wedged teardown and pinned a core | `SetThreadGroup` + three stop paths + a bounded join that detaches | `worker-spin-teardown.c`: was exit 124 after SIGKILL, now exits in 0.18s |
| a worker blocked in a HOST call outlived the embedder's timeout | the embedder drops the guest future | `worker-block-teardown.c`: 12s block, teardown in 0.13s |
| the worker epoch deadline bounded nothing | the CLI forces `epoch_interruption` + a 10ms ticker whenever `-W shared-everything-threads` is on; the deadline became a stop-flag POLL, not a budget | `-W timeout=2s` + `worker-spin-teardown.wasm` now exits immediately |
| `--wasm fuel=N` + SET was a guaranteed hang | workers get the configured fuel, as `serve` already did | `-W fuel=... worker-io.wasm` completes |
| `-W max-memory-size` did not bind shared memory **at all** | the limiter is consulted on every shared grow | `worker-mem-grow.c` stops at exactly 16777216 under a 16 MiB cap, on both threads |
| a worker's `exit()` wedged the component | the status rides the group; `SetWorkerHost::exit_status` lets the embedder name its own exit error | `worker-exit.c`: main no longer sails past the exit |
| the fused-adapter refusal was unreachable AND mis-placed | a clean compile-time refusal in `partition_adapter_modules`, covering every adapter that needs memory | the guest-controlled `.expect("invalid adapter module generated")` panic is gone |
| cross-thread fds ALIASED instead of failing | per-thread fd namespaces (`fd = slot << 22 \| index`; main keeps slot 0 so its numbering is unchanged) | `worker-fd-alias.c`: worker gets 4194308, main gets 4, cross-thread write is `EBADF` |
| a worker trapping inside `printf` wedged stdio for everyone | `__lockfile`/`__unlockfile` register on `stdio_locks` under SET | `worker-stdio-orphan{,-internal}.c` |
| the death hook ran with an expired epoch, so it did nothing | a protected epoch budget before the hook | covered by `worker-trap.c` under teardown pressure |
| per-thread libc state leaked ~320 B/thread | `__wasilibc_set_release_thread_state` from `__pthread_exit` | asserted present by the toolchain image build |
| the refusal diagnostic was silenced process-globally | time-rate-limited per refusal site | |
| `SetViewPlan::install` preconditions were `debug_assert` only | real checks, all before anything is written | |
| spawning from an instance with no shared memory silently got a private one | refused | |
| stale comments describing the OLD design | rewritten (module header, `store.rs`, `docs/wasm-parallelism.md`) | |

Dead code removed with the designs that needed it: `snapshot_plain_globals` /
`write_plain_globals` (globals are no longer copied into a worker) and the
`transcoder_memories` plumbing (`environ` field, dfg computation, runtime loop).

### Found while verifying, not by a reviewer: `wasmtime serve` could not run a SET guest at all

`serve` turns the POOLING allocator on by default on any host with the address
space for it, and the pooling allocator cannot allocate a `shared` memory
(`Memory::new_static` has a `todo!()` for it). So every SET component failed to
load under `wasmtime serve` — "memory is shared which is not supported in the
pooling allocator" — which is how this platform runs every HTTP app. `run`
(port-serving apps) was unaffected, which is exactly why three review rounds and
every probe missed it: nothing had ever tried the `serve` path.

Fixed by not defaulting to pooling when `-W shared-everything-threads` is on.
`-O pooling-allocator=y` still wins and then the tenant gets the clean refusal
rather than a surprise. **Honest cost:** a SET tenant under `serve` loses the
pooling allocator's fast per-request instantiation.

**Still unproven: an end-to-end `wasmtime serve` of a SET http guest.** The
blessed toolchain image builds `wasi:cli` command components (no C `wasi:http`
binding generator in it), so no SET guest exists today that `serve` can drive.
A SET component now LOADS under `serve` and its instantiation path is exercised;
serving a request is not. Anyone promoting this should build one first.

## Round 4 (2026-08-08): the review did NOT clear — 3 HIGH + a DoS the cap missed

A fresh four-reviewer pass on the round-3 design found more, which is the third
consecutive round to do so. All fixed; the ones that change how to think about
this:

* **The live-thread cap bounds CONCURRENCY, not CREATION.**
  `worker(){ spawn(worker); return; }` keeps the live count at 1-2 forever and
  creates threads at the kernel's maximum rate — measured 35,187 create+exit
  pairs in 2 s burning 2.6 s of CPU, with `ENCLAVE_MAX_SET_THREADS=4` making no
  difference at all. Thread creation is a node-wide cost, so that is a
  noisy-neighbour DoS against every other tenant, i.e. exactly what the cap's
  own comment claimed to prevent. Now rate-limited with a token bucket
  (`ENCLAVE_MAX_SET_SPAWN_RATE`): same guest, same 2 s → 2,112 spawns and
  0.34 s of CPU, with the guest seeing a clean `EAGAIN`
  (`worker-spawn-churn.c`).
* **`build_host` was NOT "the only place a Host is built".** The wasi-threads
  (p1) host this patch also rebuilds constructed one inline with
  `..Default::default()` — the same shape as the round-3 CRITICAL, plus no
  limiter, no fuel, no thread cap, and a deadline of 0 (so `--wasm timeout`
  killed every spawned thread instantly, and its trap handler called
  `process::exit(1)`). Not fleet-reachable (the classifier refuses core
  modules) but shipped in the binary. Now routed through `build_host` with all
  of the above, and its shared memory checked against `-W max-memory-size`.
* **Stop path #3 did not work in the configuration the platform launches.**
  `allow_blocking_current_thread` is on whenever `--wasm timeout` is absent,
  which is always on-fleet, and it makes WASI filesystem calls run inline on
  the fiber — so the guest future never yields and the cancellation arm is
  never polled. The `worker-block-teardown.c` repro blocks on a timer, which is
  async, and so could not see it. Now forced off when SET is on.
* **The guest death hook was an unstoppable, RENEWABLE window.** It runs with
  every stop path disarmed by design; the budget was 1000 ticks (10 s), and the
  hook runs on the worker's store — which has the worker host and the group
  installed — so a hook that spawns a thread that traps gets another hook,
  unboundedly. Now 20 ticks (0.2 s), and `thread.spawn` refuses once the group
  is stopping, which also fixes teardown's live-count wait being defeatable.
* **Recycling fd namespaces re-opened the aliasing hole.** Round 3 tagged fds
  with a slot drawn from a reused bitmap; recycling is deterministic, so the
  next worker inherited a dead thread's tag and its stale fds became valid
  again, naming different objects. Namespaces are now MONOTONIC
  (`worker-fd-recycle.c`).
* **The death hook trusted `__pthread_self()`** with no check that TLS was its
  own — and the round-3 epoch budget is what made that reachable. A worker that
  traps before `wasi_set_thread_start`'s first two instructions runs the whole
  epilogue on the MAIN thread's `struct pthread`: zeroing its `tid` breaks
  `__tl_lock` and every `__lockfile`, and the `threads_minus_1` decrement can
  set `libc.need_locks = -1`, turning every lock in the process into a no-op.
  Now guarded on `__wasilibc_set_is_worker`.
* **The hook called `free()` while holding `__thread_list_lock`** — a deadlock
  precisely when the worker trapped inside the allocator, which is when the
  hook runs. Removed.
* Also: `SharedMemory::grow` broke the `ResourceLimiter` contract (approved a
  grow, never reported the failure — which drains an ACCOUNTING limiter, and
  the platform's RAM ledger is one) and its ceiling re-check turned any
  concurrent grow into a spurious guest-visible OOM including `memory.grow(0)`;
  `setup_epoch_handler` skipped the SET callback entirely under `serve
  --wasm timeout`, `run --profile=guest` and the debugger; fuel was not
  restored before the death hook, putting the exact hang back for a
  fuel-exhausted worker; the epoch ticker failed OPEN if its thread could not
  be created (under thread pressure — which a SET tenant creates); `dup2(fd, 9)`
  failed on every worker; `select(FD_SETSIZE, ...)` silently dropped every
  worker fd; `chdir`'s statics were shared and unlocked; the thread-id counter
  latched the whole process into permanent spawn failure after 2^31 spawns; a
  trapping-worker loop produced 3.8 MB of stderr; and `I32Exit(-1)` round-tripped
  to "no exit".

**Corrected claims** (each was in the code, a probe, or this file): nested spawn
does NOT trap — it is supported, and the cross-thread guard is bypassed by
construction on that path; the guard catches a worker reaching the PRIMARY's
store through an imported memory's futex instead. `set-nested-spawn.wat` and
its README row said the opposite and now describe what they actually
demonstrate: that a recursive spawn tree is bounded.

### Verification bar met

* 1305 wasmtime integration tests + 200 unit tests, 0 failures.
* 12/12 `test/wasm-set.test.mjs`.
* Soak `run(500,16,2000)` = 8000, no leaked cap slots.
* Scaling, constant total work (14.4e9 iterations): 13.98s → 0.941s at 16
  threads (**14.9x**) and 0.562s at 32 (**24.9x**).
* **R4 race harness**: 13.6M guest flips against 200k canonical-ABI lifts —
  0 borrows into shared memory, 0 invalid `str`s. (The negative control, on a
  deliberately-reverted borrowing ABI, reports both.)
* **TSan (with `--cfg rustix_use_libc` — see the doc): ZERO data races** across
  every WAT probe and every C probe, including the new fd-recycle and
  spawn-churn ones. The only reports are `signal-unsafe call inside of a signal`
  (wasmtime's SIGILL handler allocating a backtrace), and they reproduce on a
  plain shared-memory component that traps with **no SET involvement at all**
  (`-W threads,shared-memory`, no spawn) — so they are upstream, not ours.
  Re-run any report against that baseline before believing it.
* The patch was regenerated against a freshly reconstructed 9-patch baseline at
  `ac0772970`, applies clean to a fresh checkout, and the engine built from it
  passes every probe (including the spawn-churn bound and the RAM gate).

### Honest residuals, stated rather than hidden

* **Per-store limits are per-WORKER.** `max-instances`, `max-table-elements`,
  `max-resources` and `--wasm fuel` are enforced on each worker's own store, so
  a group may use up to `1 + max_live_threads()` times the configured amount.
  Linear MEMORY is the exception and the one that matters here: the shared
  memory is bound once, by `-W max-memory-size`, from whichever thread grows it.
* **Epoch instrumentation costs throughput**: ~0% at 1 thread, a few percent at
  16, ~12% at 32 where SMT siblings compete for issue slots. 15.8x/27.9x became
  14.9x/24.9x. That is the price of a worker that can be stopped, and the older
  numbers came from an engine where it could not be.
* **A worker's exit STATUS is capped by wasip2.** `wasi:cli/exit` carries
  success/failure, not a code, so `exit(7)` on a worker ends the component with
  a failure rather than 7.
* **A trapped thread's descriptor table is leaked** (only its fd-namespace slot
  is reclaimed): dropping a resource handle is a component call, and a thread
  that has just trapped should not be making more. Bounded by the thread cap.
* **fds 0/1/2 are per-thread by construction** and deliberately untagged, so
  they are the same streams on every thread. A thread that closes fd 1 and
  opens a file gets a per-thread fd 1; a cross-thread use of it would not be
  caught. That is the price of `write(1, ...)` working on a worker. Namespaces
  are monotonic, so 2^18 thread creations per component instance exhausts them;
  after that a thread can still use 0/1/2 and gets `EMFILE` for anything else.
* **A worker that traps holding a libc-internal lock wedges its siblings.**
  The death hook recovers the locks that have an owner field (thread list,
  FILE, robust mutexes). `__lock()` — dlmalloc's, `__ofl`, preopens, cwd — is
  ownerless, so a worker that traps inside `malloc` leaves it held and every
  sibling's allocator spins. In-sandbox, self-inflicted, and it ends at store
  teardown (the engine's stop paths still reach those threads). "A worker dies
  alone, siblings continue" is a statement about the HOST, not a promise to the
  guest.
* **A worker inside a SYNCHRONOUS host call is stoppable by nothing.** Stop
  path #3 drops the guest future, which requires the call to yield. Async WASI
  yields (and SET now forces `allow_blocking_current_thread` off so filesystem
  calls do too), but a bindgen-sync host function — `wasi-nn`'s `compute`, the
  platform's flagship workload — does not. Teardown detaches such a worker after
  the timeout rather than blocking, which is the bounded outcome, but the call
  itself runs to completion.
* **Per-worker HOST state is multiplied and unbilled.** Each worker gets its own
  `Store`, `WasiCtx`, resource table, preopen set and vault handles. None of it
  is linear memory, so `-W max-memory-size` — the only guest-RAM cap the
  platform applies, and the only thing its RAM ledger charges — does not see any
  of it.
* An embedder that enables SET without `Config::epoch_interruption` and a
  PERIODIC ticker cannot stop a spinning worker. `thread.spawn` says so on
  stderr; the wasmtime CLI configures both automatically.

## Why it is still not promotable

**The fresh adversarial pass has not been run against this design yet.** Three
rounds have now been run and every single one found real UB — including a round
where the previous round's fix was silently ineffective. A clean round is the
gate, not a formality.

## Promotion sequence, when it is finally earned

Get a fresh four-reviewer adversarial pass that clears, then: rename `.wip` →
`.patch`, add the wasmparser vendor+relax step and the SET patch to
`Dockerfile.wasmtime`, extend `wasmtime-patch-check.yml`, then the
toolchain-dispatch → `WASMTIME_IMAGE` repin measurement event (Steven-gated).
Not before.
