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
| cross-thread fds ALIASED instead of failing | per-thread fd namespaces (`fd = namespace << 13 \| index`; the main thread keeps namespace 0 so its numbering is unchanged) | `worker-fd-alias.c`: worker gets 8196, main gets 4, cross-thread write is `EBADF` |
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

## Round 5 (2026-08-08): did not clear either — a CRITICAL that four rounds of probes had walked past

The round-5 pass reviewed THE FIXES rather than the design, which is where it
found the worst thing in the whole project so far.

* **CRITICAL: two file or socket I/O operations deadlocked once any second
  thread existed.** `file_get_read_stream` / `tcp_get_read_stream` take the
  object's lock and the CALLER must release it. The p2 shape of `wasi_read_t`
  has nowhere to carry that lock, so an early revision of this patch DELETED
  the release instead of replacing it. Single-threaded it is invisible —
  `__lock()` returns immediately while `libc.need_locks == 0` — and it becomes
  a permanent hold the instant the first `pthread_create` sets that flag. The
  second `read`, `write`, `send` or `poll` on any file or socket then blocks
  forever, as does a worker's own exit (its table `clear()` re-locks). Fixed by
  giving the p2 metadata a `lock` field, publishing it from the producers that
  take one, and releasing it in `read`/`write`/`tcp`/`ppoll`.
  **Every previous probe missed it because `stdio_get_*_stream` takes no lock**
  — so `printf`-only workers were fine, and nothing ever wrote a file twice.
  `worker-file-io.c`.
* **HIGH: the round-4 `SharedMemory::grow` rewrite failed 27–74% of legitimate
  concurrent grows** — my regression. Publishing `current_length` outside the
  write lock broke the retry loop's own termination argument: a loser could not
  see the winner's growth, so retries were burnt with nobody having grown.
  Publishing under the lock again: 16 threads × 200 grows now fails 57 of 3200
  (1.8%), was 854 (27%). The RAM gate still binds exactly.
* **HIGH: the p1 wasi-threads path got round 4's concurrency cap but not its
  creation-rate limiter** — 20,000 OS threads in 0.66 s, i.e. round 4's own
  headline lesson not applied to the path round 4 hardened. Both bounds now
  come from the same process-wide bucket.
* **HIGH: the rate limiter refused 87% of a strictly SEQUENTIAL create-then-join
  loop** on a 1-core tenant — one thread alive at a time, the most ordinary
  shape there is. The floor was 16/s against a shape that reaches ~250/s. Now
  512/s with tokens refunded when a spawn is refused for another reason; the
  fork-bomb is still cut ~9x.
* **HIGH: `--wasm timeout` bounded nothing when the main thread was parked in a
  join** — which is every pthread program. The wall-clock check lived in the
  primary's epoch callback, and a parked thread runs no callbacks: measured 25 s
  and two pinned cores against a 2 s timeout. The ticker thread now enforces the
  deadline; the same case exits at 2.011 s.
* **HIGH: `dup2` on a worker returned the raw target**, so it SUCCEEDED and
  handed back a descriptor that was `EBADF` on every later use, and left the
  slot unreachable — silent success replacing the failure round 4 fixed.
  `worker-dup2.c`.
* **HIGH: an EMFILE inside preopen population double-dropped a resource handle
  and trapped with the process-global preopens lock held**, killing filesystem
  access for every thread. Round 4's new exhaustion paths turned an
  OOM-only defect into a reachable one.
* **MEDIUM: `-W all-proposals=y` enabled SET with every CLI safety mechanism
  off.** The `all` fallback is applied when flags become an engine `Config`, so
  the engine got SET while the option stayed `None` and every
  `== Some(true)` branch — epoch interruption, the ticker, the stop callback,
  `allow_blocking_current_thread` — was skipped. One predicate now decides.
* **MEDIUM: the fd-namespace counter wrapped fail-OPEN** back onto namespace 0
  (the main thread's) after 2^32 claims. Saturating CAS.
* Also: the death hook could still spawn (chained to depth 64) and is now
  refused outright from inside it; `select`'s relaxation was scoped to tagged
  fds so `select(0, …)` works again; the stdio orphan sweep snapshots `next`
  before releasing a FILE; `unpark_all` recovered from poisoning one frame short
  of a panic-in-drop; the p1 path leaked its live counter on a failed
  `thread::Builder::spawn`; and the funcref ownership check formed a reference
  before checking, which round 4 fixed for the `Instance` and not for the
  funcref.

**Claims corrected**: the death-hook budget bounds compiled code only (a hook
that BLOCKS holds its thread and its cap slot until teardown, and is 1.0 s not
0.2 s under `serve --wasm timeout`); the platform's limiter is a stateless
threshold (`StoreLimits`), not an accounting one, so the "accounting limiter"
justification was wrong even though the contract fix is right; per-thread I/O
was NOT unaffected; and exhaustion did not fail closed.

## Round 6 (2026-08-08): one CRITICAL, from the libc reviewer

Two reviewers over the round-5 fixes. The engine/CLI side came back with **no
CRITICAL**; the libc side found one, and it was the round-5 fix being half a fix.

* **CRITICAL: a failed `get_read_stream`/`get_write_stream` still leaked the
  object lock.** Round 5 gave the wasip2 stream metadata a `lock` field so the
  CALLER could release what the producer took — but `file_get_read_stream` and
  `file_get_write_stream` also `return -1` on their own error path, above where
  the field is set, with the lock held and no handle for the caller to release
  it with. (`tcp_get_read_stream` already unlocked on failure; these two did
  not.) Reached by `fopen("/some/dir","r")` + `fread`: every later
  read/write/poll/lseek/close on that fd blocks forever, as does the thread's
  own exit. `worker-dir-io-lock.c`.
* **HIGH: fd-namespace exhaustion killed the whole component silently.** The
  first thread refused a namespace (2^18 creations per instance) failed
  `__wasilibc_populate_preopens`, which reaches `_Exit(EX_SOFTWARE)` — and
  `_Exit` here is `proc_exit`. Status 1, nothing on either stream, every other
  thread gone. This file claimed it yielded `EMFILE`; it did not. Now a
  per-thread failure: `worker-ns-exhaust.c` runs 262,500 creations, the last
  357 get a failed `open()`, and main prints its summary.
* **HIGH: `-W trap-on-grow-failure=y` turned ordinary concurrent `memory.grow`
  into a guest trap** — my round-5 regression. Reporting the retry to the
  limiter meant an error under that flag, so 11 of 16 workers died on a program
  doing nothing wrong, with a message that said "retrying". The retry loop is
  now PROGRESS-based rather than budget-based: a retry that follows real growth
  costs nothing, so contention never manufactures an allocation failure. All
  three configurations verified — and the ~2% spurious refusal rate the round-5
  code had is now **zero** (32 threads x 200 grows, 6400/6400, with and without
  the flag), while the RAM gate still binds exactly.
* **MEDIUM: the rate-limit floor was sized against a wrong measurement.** The
  real sequential create-then-join rate is ~14,600/s, not the ~250/s the floor
  assumed, so 512/s would refuse ~96% of a tight loop in steady state. Raised to
  4096/s with a ONE-second burst (four seconds made the limit invisible over
  short windows). And the reasoning is corrected rather than patched over: a
  tight thread-per-task loop and a fork bomb are the SAME workload and no rate
  separates them (~14.6k/s vs ~19k/s). The limiter is a backstop against a
  pathological rate; what actually charges a tenant is the cgroup, since thread
  creation is kernel time in its own `cpu.weight` share. Measured: 38,397
  creations and 1.11 CPU-seconds per 2 s unlimited, versus 5,447 and 0.33.
* Also: the patch had stopped compiling for the STOCK `wasm32-wasip2` target
  (the `lock` field only exists where the build has real locks); `dup3` self-dup
  compared raw fd values so a worker escaped the POSIX `EINVAL`; the `select`
  shift constant was hand-copied into another translation unit and is now
  shared through a header; the p1 wasi-threads path took a rate token and never
  refunded it; the deferred-stack-free comment understated the leak; and
  `maybe_spawn` was dead code.

### Verification bar met

* 1305 wasmtime integration tests + 200 unit tests, 0 failures.
* 12/12 `test/wasm-set.test.mjs`.
* Soak `run(500,16,2000)` = 8000, no leaked cap slots.
* Scaling, constant total work (14.4e9 iterations): 13.98s → 0.941s at 16
  threads (**14.9x**) and 0.562s at 32 (**24.9x**).
* Concurrent `memory.grow`, 32 threads x 200: **0** refusals with no limit
  configured (and 0 under `-W trap-on-grow-failure=y`), exactly the cap with one.
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
* **A trapped thread leaks its descriptor table and, if it was DETACHED, its
  stack.** Dropping a resource handle is a component call and `free()` is a
  deadlock, so the death hook does neither. Bounded by thread CREATIONS (which
  are rate-limited), not by the live cap — the same stock-vs-flow distinction
  round 4 turned on. A guest choosing 4 MiB stacks leaks 4 MiB per trapped
  detached thread.
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

**SIX rounds have now been run and not one has cleared.** Round 6 reviewed the round-5 fixes and found a CRITICAL (the round-5 lock fix
was half a fix) plus another regression that fix introduced. The engine/CLI half
of round 6 was CRITICAL-free, which is the first time either half has been.

The round-6 fixes are themselves UNREVIEWED, and they are not small: the file
lock error paths, the preopen exit path, the progress-based grow retry, the rate
floor. The pattern for six rounds has been that each fix's new surface hides the
next defect. The only evidence that would change the answer is a round that
finds nothing.

## Promotion sequence, when it is finally earned

Get a fresh four-reviewer adversarial pass that clears, then: rename `.wip` →
`.patch`, add the wasmparser vendor+relax step and the SET patch to
`Dockerfile.wasmtime`, extend `wasmtime-patch-check.yml`, then the
toolchain-dispatch → `WASMTIME_IMAGE` repin measurement event (Steven-gated).
Not before.
