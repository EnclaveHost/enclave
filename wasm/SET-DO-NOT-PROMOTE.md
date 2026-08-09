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

## Round 7 (2026-08-08): targeted pass over the round-6 delta — 1 CRITICAL + 4 HIGH

Deliberately narrow: only the round-6 fixes. Two of the four libc fixes were
wrong, and both engine HIGHs were about a mechanism that did not do what it
claimed.

* **CRITICAL: making `__wasilibc_populate_preopens` RETURN instead of
  `_Exit` turned a fail-fast into an unbounded HOST leak.**
  `filesystem_preopens_get_directories` mints one host resource handle per
  preopen every call; the failure path dropped none of the tail and left
  `preopens_populated` false, so every later path call re-entered. N-1 host
  table slots per call — invisible to the tenant RAM gate — until wasmtime's
  resource table filled at 1e6 and the guest trapped inside `get_directories`,
  silently, with **exit status 0**. Measured 179 MB of host RSS for 140,000
  failed opens. The failure path now drops what it minted, undoes the partial
  registration (which otherwise re-registered preopen[0] as a duplicate every
  retry, so a thread freeing descriptors never recovered), and is STICKY for
  that thread. `worker-preopen-retry.c`: 200,000 retries, host RSS flat at
  6 MB.
* **HIGH: the spawn rate limiter made a retrying guest 3.6x MORE expensive.**
  A refusal is far cheaper for the guest than a real spawn, so a chain that
  retries spins on the host call instead of exiting: 50.3 CPU-seconds per 2
  wall seconds (22.6 cores) with the limiter ON, against 13.8 (6.2) with it
  OFF. It converted a spawn-and-exit bomb into a spawn-and-spin bomb. The
  limiter now WAITS for a token rather than refusing, bounded and abandoned on
  a stop request: same bomb, 2.97 CPU-seconds against 13.40 unlimited — 4.5x
  better instead of 3.6x worse (`worker-spawn-retry-bomb.c`).
* **HIGH: refusing also broke ordinary programs**, and no rate can avoid that,
  because a tight thread-per-task loop reaches ~14,600 creations/s — faster
  than any limit worth setting. Refusal % was a function of iteration count,
  not of the limit: 67.5% at 20,000 iterations, 94% at 100,000, 18.5% for a
  recycling 64-thread pool. Waiting fixes it by construction: those same shapes
  are now **0 refused**.
* **HIGH: `dup2` on a worker was wrong for the third round running** — first
  refusing every ordinary target, then returning the raw `arg` (success, with a
  descriptor that was EBADF on every later use), then returning a tagged fd a
  caller using its own constant could not use. The contract now: targets a
  thread can legitimately name (0/1/2, or one already in its namespace) behave
  exactly as POSIX says on every thread — which covers
  `dup2(fd, STDOUT_FILENO)`, the real use — and an arbitrary bare target on a
  worker is REFUSED rather than half-served. The round-6 probe asserted the
  buggy contract and has been rewritten.
* Also: a panic between taking a rate token and spawning leaked it permanently
  (**RETRACTED in round 8: the `TokenGuard` this claimed was never written.**
  Two reviewers grepped for it independently and found it in neither the tree
  nor the patch. The refunds are two explicit calls, and no reachable panic
  sits between them, so nothing leaks -- but the record named a mechanism that
  did not exist, which is the exact failure mode this file exists to catch);
  the "accounting limiter (which the platform has)"
  justification is retracted in the code, not just in this file; `GROW_STALLS`
  is documented as believed-unreachable rather than presented as the safety
  argument; and the doubled `#ifdef` in `read.c`/`write.c` is patch residue.

**Verified clean by this round** (evidence, not absence): the `file.c` lock fix
is complete — both functions have exactly one early return on the p2 branch, the
p3 arms have none, and a whole-tree `STRONG_LOCK` sweep found every other site
`defer`-paired. The grow retry survived limit-escape, termination, livelock and
`memory.grow(0)` attacks at up to 128 concurrent growers across five cap values.
Refund accounting is exactly compensating (~199,900 refusals yielded exactly
burst + elapsed x rate). `__WASILIBC_SET_FD_NS_SHIFT` cannot differ between
translation units, and stock p2, p3 and coop-p3 all build.

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

## Round 8 (2026-08-09): did not clear — 2 CRITICAL + 5 HIGH, every one reproduced

Four reviewers over the round-7 delta. Both round-7 CRITICAL-area fixes were
themselves wrong, and the spawn rate limiter has now been withdrawn entirely
rather than fixed a third time.

| finding | severity | what it actually did | fixed by |
|---|---|---|---|
| the waiting spawn limiter parked the tokio worker running the guest's fiber | CRITICAL | `std::thread::sleep` inside the `thread.spawn` libcall, on the fiber, i.e. on a tokio worker under `serve`. Measured 101 of 2207 expected timer wakeups over a 2.2 s window, 2 s of timer lateness — no accepts, no response writes, no timeouts, no ctrl-c — at **0.00 CPU seconds**, so `cpu.weight` charged nothing and no CPU-based watchdog could see it. It also defeated `allow_blocking_current_thread(false)`, which exists in `common.rs` for precisely this reason, and on a store's FIRST spawn the wait was entirely unabandonable (the group is created *after* the token is taken, so the stop check saw `None`) | the limiter is **off by default** and, when an operator enables it, REFUSES rather than waits. `take_spawn_token` can no longer sleep, and says so |
| the preopen failure path re-entered `__wasilibc_populate_preopens` through `close()` | CRITICAL | round 7's cleanup loop ran *before* `preopens_failed = true`, and `preopen_state_close` is `close()`, which opens with `__wasilibc_populate_preopens()`. With a sibling thread alive: deadlock on musl's non-recursive lock — zero CPU, no output, no exit, every thread's filesystem dead, holding a lease forever. Without one: unbounded recursion re-minting the whole preopen list per level and double-freeing each prefix. Reachable by OOM at preopen ≥1, not just by a hostile guest | go sticky and take the table private BEFORE closing anything, so the re-entrant call takes the early-out |
| `dup2` returned a permanently-EBADF descriptor, on the MAIN thread | HIGH | `set_fd_ns > 0` was standing in for "am I a worker" and is not that predicate: a namespace is claimed lazily by `index_to_fd`, which returns 0/1/2 *without* claiming. Before its first descriptor at index ≥3, every thread — main included — fell into the round-6 hole. A strict regression against a stock wasip2 build, in a program with no threads | claim the namespace first; refuse on `__wasilibc_set_is_worker` |
| a worker's `dup2(f, 1)` leaked guest bytes to the operator's log | HIGH | the fd table is per-thread but musl's `stdout` is ONE `FILE` in shared memory: one buffer, one `f->fd == 1`, two threads for which "1" names different descriptors. A worker redirecting into its own sandbox had its bytes delivered by main's exit-time flush through main's fd 1 — the container log. Measured, and exactly inverted from the same source built natively | a worker may not redirect 0/1/2 (EBADF). Round 7 had explicitly blessed this call |
| a tagged spelling of 0/1/2 was honoured | HIGH | `index_to_fd` never emits `(ns<<13)\|1`, but `fd_to_index` masked it back to index 1, giving the standard streams a second name. `dup2(f, 8193)` on a worker silently redirected that thread's stdout; `fcntl(fd, F_DUPFD, 8192)` had its lower bound read as 0 | `fd_to_index` refuses a tagged spelling of an untagged index |
| a failed registration did not always consume the descriptor | HIGH | the cleanup skipped entry `i` because "the registration consumed this descriptor even on failure". True on one of three paths; the other two are the `malloc` failures a tenant reaches under its own `-W max-memory-size` | the two paths now drop it, so the claim holds everywhere |
| `worker-dup2.c` asserted the contract the tree no longer implements | HIGH | the probe required a worker's `dup2(fd, 1)` to succeed — the call that leaks. It also `open()`ed first, so it structurally could not see the finding above it. Fourth round in which this probe encoded a bug as the spec | rewritten with real assertions and an exit code; **verified to fail 4/4 against the round-7 libc and pass against this one** |

Retracted rather than fixed: `TokenGuard` (never existed, see above) and the
round-7 claim that a hostile guest "is put to sleep rather than given a cheap
loop" — false whenever the live cap binds, because the cap refusal refunded the
token. Measured 2.3 million refused spawns per second in that shape. The cap
check now runs before the token is taken.

### Why the rate limiter is gone rather than fixed

Its own doc comment already conceded the decisive point: a legitimate tight
thread-per-task loop and a hostile fork bomb are the same workload, differing by
less than 30%, so no rate separates them. Both implementations then failed in
opposite directions — refusing is *cheaper for the guest than the spawn it
refuses*, so a retrying guest spins (measured this round at 45.1 CPU-seconds per
2 wall seconds against 13.5 with the limiter off, a 3.3x amplification); waiting
moves the cost off the CPU accounting entirely and onto the executor. What
actually bounds this is the cgroup, which charges creation to the tenant that
caused it, and the live cap, which bounds the memory. `ENCLAVE_MAX_SET_SPAWN_RATE`
remains as an operator knob, defaulting to 0, and `worker-spawn-retry-bomb.c`
documents what turning it on costs.

### Verified clean this round, which is evidence rather than absence

* The `.wip` patch is complete and faithful: all 48 post-image blob hashes match
  `git hash-object` of the corresponding tree file. The "missing the entire
  mechanism" failure cannot recur silently.
* `GROW_STALLS` is genuinely unreachable, proven from the lock discipline rather
  than asserted; `delta_pages == 0` returns before the limiter.
* The `file.c` lock fix is complete, INCLUDING the half round 7 did not state:
  `wasi_read_t`/`wasi_write_t` are declared uninitialised, so `if (read.lock)`
  would dereference garbage unless every p2 producer writes the field. All four
  do; all five consumers release.
* Rounds 3-6 fixes all still hold on the rebuilt artifacts: `worker-fd-alias`,
  `worker-fd-recycle`, `worker-file-io`, `worker-dir-io-lock`, both
  `worker-stdio-orphan` probes, `worker-io`, `worker-trap`, `worker-mem-grow`
  (binds at exactly 16777216 from a worker), `worker-preopen-retry` (200,000
  retries), `worker-spin-teardown` 0.18 s, `worker-block-teardown` 0.14 s.
* Every SET safety mechanism is armed in the platform's ACTUAL launch config
  (`serve`/`run`, `-W max-memory-size`, no `--wasm timeout`).

## Round 9 (2026-08-09): did not clear — and three of round 8's own fixes were the bugs

| finding | severity | what it did | status |
|---|---|---|---|
| every HTTP app was broken (`_initialize` traps on the first worker, request hangs forever) | CRITICAL | see the section below | FIXED |
| **the canonical patch did not compile in its DEFAULT configuration** | HIGH | round 8 added `set_fd_ns_claim()` / `__wasilibc_set_is_worker` calls to the `dup2` arm outside any `#ifdef`, with no `#else` definitions. `ENABLE_SET_THREADS` defaults to OFF, so `descriptor_table.c` failed to compile for anyone building the patch normally — under a comment, three lines away, asserting the non-SET build is identical to stock. Nobody had built that arm since round 8 | FIXED, and the image now BUILDS the non-SET configuration as a guard so it cannot recur silently |
| a REFUSED `dup2` permanently burned one of the 2^18 namespace ids | MEDIUM | round 8 claimed the namespace before deciding. Measured: 64 throwaway threads whose only action was a `dup2` returning EBADF consumed 64 ids; the same threads doing nothing consumed 0. Ids are monotonic and never reused, and at the ceiling no thread in the component can create a descriptor again | FIXED — the main thread claims (free, namespace 0), a worker only reads |
| `dup2(1, 1)` on a worker was EBADF | LOW | round 8 put the worker 0/1/2 refusal before the self-dup check, so a POSIX no-op was refused | FIXED — self-dup is decided first |
| **a worker reaches the shared `stdout` through three doors round 8 did not close** | HIGH | **OPEN — see below** |
| a worker's `fflush(NULL)` destroys every other thread's buffered stdio | HIGH | **OPEN — see below** |
| `freopen(path, "w", stdout)` on a worker closes the shared stdout and wedges `F_ERR` for every thread | MEDIUM | **OPEN — see below** |

### The open findings are one finding, and it is a DESIGN problem

Round 8 refused a worker's `dup2(f, 1)` because the fd table is per-thread while
musl's `stdout` is one `FILE` in shared memory. That fix was correct and
useless: `dup2` is one of four doors into the same room.

`table_allocate` hands out the LOWEST free index, and `index_to_fd` returns
0/1/2 BARE. So a worker that calls `close(1)` and then `open`, `dup`, `socket`,
`accept`, `pipe` or `fcntl(F_DUPFD)` simply *receives* bare fd 1, with no check
anywhere. Measured: worker does `close(1); open("/d/x")` → fd 1 →
`printf(secret)` into the shared buffer → main's exit flush delivers it to the
**operator's container log**, while the guest's file stays empty. Byte for byte
the same observable round 8 rated HIGH, reached without `dup2` at all, and
exactly inverted from the same source built natively.

The same mismatch runs the other way: a worker calling `fflush(NULL)` walks the
process-global `__ofl` list and writes each `FILE` through `f->fd` — which on
that thread names something else, or nothing. Measured: main's 19 buffered bytes
are DESTROYED (`F_ERR` set, file 0 bytes, exit status 0, nothing on either
stream). And `freopen` on a worker closes the shared `stdout` on its failure
path, leaving a dead `FILE` on `__ofl` with `F_ERR` stuck for every thread,
while `printf` keeps returning success.

**Per-thread fd namespaces and shared musl `FILE` objects are not compatible,
and no amount of per-call refusal reconciles them.** The two coherent options
are (a) make the standard `FILE`s, and `__ofl`, per-thread under SET, or
(b) tag 0/1/2 for workers as well, which breaks `write(1, ...)` and
`STDOUT_FILENO` on a worker. Neither is a patch to `dup2`, and neither should be
attempted unreviewed at the end of a round — this is the third round in a row
where a narrowly-scoped fix in this area created the next round's finding.

### Round 9, found while closing the `serve` residual: EVERY HTTP app was broken

**CRITICAL, and eight rounds walked past it because no probe was ever the right
shape.** wasi-libc's reactor entry point guards `_initialize` with a run-once
flag and `__builtin_trap()`s on a second call. Under SET every spawned thread
gets its own whole-component instantiation, so `_initialize` runs once per
THREAD — while that flag lives in SHARED linear memory. The main instance sets
it; the first worker's instantiation loses the CAS and traps.

The observable failure is worse than a trap: main is blocked in `pthread_join`
on a thread that will never arrive, so **the HTTP request never completes.**
`wasmtime serve` holds the connection open forever (measured: no response at 20
s, `hyper::Error(IncompleteMessage)`), the platform passes no `--wasm timeout`,
and the tenant's store and tokio task are held for the life of the process.

Reactors are how this platform runs every HTTP app. Every probe in
`tools/parallelism-probe/` is a COMMAND component under `wasmtime run`, where a
worker enters through `wasi_set_thread_start` and never re-runs `_start` — which
is exactly why eight rounds of adversarial review, and every measurement in this
file, missed it.

Fixed by dropping the run-once ASSERTION under SET while keeping the run-once
BEHAVIOUR: constructors run on whichever instantiation gets there first, every
later one returns. A per-thread guard was tried first and does not work —
`_initialize` runs during instantiation, before `__wasi_thread_start_C` sets up
that thread's TLS, so a `_Thread_local` read there does not yet name per-thread
storage. What is lost is the diagnostic for an embedder that calls `_initialize`
twice on ONE instance; under SET that is indistinguishable from the legal case.

`tools/parallelism-probe/set-http-handler.c` is the artifact that had never
existed: a component that exports `wasi:http/incoming-handler` and spawns.

### The `serve` residual is now CLOSED

`wasmtime serve` now demonstrably serves real HTTP with the full tenant SET flag
set: `p2_api_proxy.component.wasm` returns 200, and 600 requests at 32-way
concurrency all succeed, identical to the same binary with SET off. So pooling
being disabled, the 10 ms epoch ticker and `allow_blocking_current_thread(false)`
cost an ordinary HTTP guest nothing measurable. An HTTP guest that also SPAWNS now works too, once the
`_initialize` bug above was fixed: 8 threads spawned and joined per request,
HTTP 200 in 2.3 ms, and **200/200 requests at 16-way concurrency**. The bindings
have to be generated with host `wit-bindgen` (the blessed toolchain image has no
C `wasi:http` bindgen); `-S cli` is required because the SET libc imports
`wasi:cli/exit`, which the bare proxy world does not provide.

### Known, and deliberately NOT fixed this round

A worker's buffered `FILE` that is never `fclose`d is silently discarded at exit
(`fopen` on a worker, `fprintf`, return, main exits → zero bytes written, status
0). POSIX would flush it at exit. The fix is a thread-exit flush of the FILEs in
`__ofl` belonging to this thread, and it was NOT attempted here on purpose: it
is a new cross-layer teardown mechanism taking two locks, in the area that has
produced a teardown deadlock in two separate rounds, and adding it unreviewed at
round 8 is exactly the pattern that has generated a new CRITICAL every round.
A guest avoids it with `fclose`. It should be designed and reviewed, not slipped in.

## Why it is still not promotable

**EIGHT rounds have now been run and not one has cleared.**

Round 7 was deliberately narrow — only the round-6 delta — and still found a
CRITICAL and four HIGHs. Round 8 was narrower still, over only the round-7
delta, and found **two CRITICALs and five HIGHs**, every one reproduced on
shipping artifacts. Both of round 7's headline fixes were themselves defective:
the preopen fix deadlocked the component, and the spawn limiter it introduced
stalled the entire HTTP server at zero CPU cost.

Eight rounds, eight sets of real defects, and the majority of the recent ones
have been the PREVIOUS round's fix. Two areas have now been wrong four rounds
running: the `dup2` contract, and thread-creation limiting — the latter has been
withdrawn rather than fixed again. That is the single most important fact for
whoever decides this. The only evidence that would change the answer is a round
that finds nothing, and no round yet has.

## Promotion sequence, when it is finally earned

Get a fresh four-reviewer adversarial pass that clears, then: rename `.wip` →
`.patch`, add the wasmparser vendor+relax step and the SET patch to
`Dockerfile.wasmtime`, extend `wasmtime-patch-check.yml`, then the
toolchain-dispatch → `WASMTIME_IMAGE` repin measurement event (Steven-gated).
Not before.
