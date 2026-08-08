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

### Verification bar met

* 1305 wasmtime integration tests + 200 unit tests, 0 failures.
* 12/12 `test/wasm-set.test.mjs`.
* Soak `run(500,16,2000)` = 8000, no leaked cap slots.
* Scaling, constant total work (14.4e9 iterations): 13.99s → 0.900s at 16
  threads (**15.5x**) and 0.589s at 32 (**23.7x**).
* **TSan (with `--cfg rustix_use_libc` — see the doc): zero data races** across
  every WAT probe and every C probe. The only reports are `signal-unsafe call
  inside of a signal` (wasmtime's SIGILL handler allocating a backtrace), and
  they reproduce on a plain shared-memory component that traps with **no SET
  involvement at all** (`-W threads,shared-memory`, no spawn) — so they are
  upstream, not ours. Re-run any report against that baseline before believing
  it.
* The patch was regenerated against a freshly reconstructed 9-patch baseline at
  `ac0772970`, applies clean to a fresh checkout, and the engine built from it
  passes the probes.

### Honest residuals, stated rather than hidden

* **Per-store limits are per-WORKER.** `max-instances`, `max-table-elements`,
  `max-resources` and `--wasm fuel` are enforced on each worker's own store, so
  a group may use up to `1 + max_live_threads()` times the configured amount.
  Linear MEMORY is the exception and the one that matters here: the shared
  memory is bound once, by `-W max-memory-size`, from whichever thread grows it.
* **Epoch instrumentation costs throughput at full SMT**: ~0% at 1 thread, ~2%
  at 16, ~17% at 32. 15.8x/27.9x became 15.5x/23.7x. That is the price of a
  worker that can be stopped, and the older numbers came from an engine where
  it could not be.
* **A worker's exit STATUS is capped by wasip2.** `wasi:cli/exit` carries
  success/failure, not a code, so `exit(7)` on a worker ends the component with
  a failure rather than 7.
* **A trapped thread's descriptor table is leaked** (only its fd-namespace slot
  is reclaimed): dropping a resource handle is a component call, and a thread
  that has just trapped should not be making more. Bounded by the thread cap.
* **fds 0/1/2 are per-thread by construction** and deliberately untagged, so
  they are the same streams on every thread. A thread that closes fd 1 and
  opens a file gets a per-thread fd 1; a cross-thread use of it would not be
  caught. This is the one hole the namespace scheme leaves, and it is the price
  of `write(1, ...)` working on a worker.
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
