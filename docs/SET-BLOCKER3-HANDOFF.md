# Handoff: SET round 3 — clear the review, then promote

You are picking up shared-everything-threads (SET, ⚡). **The two blockers from
the previous handoff are FIXED and verified.** A fresh four-reviewer adversarial
pass on the new design then found **1 CRITICAL + 15 HIGH**, so the engine is
still out of the measured TCB. Your job: fix what remains, get a fresh review to
clear, then promote. Do not promote before both — that gate has now caught real
UB three rounds running, including a case where the *previous* round's fix was
silently ineffective.

## Read first

- `wasm/SET-DO-NOT-PROMOTE.md` — the authoritative open-findings list. Start here.
- `docs/wasm-parallelism.md` → the two `2026-08-08` sections (the new design, and
  why the old one was unsound).
- `docs/HANDOFF-set-threads.md` → `UPDATE 2026-08-08` (what a worker is now).
- The design comment atop
  `~/Projects/wasmtime-set/crates/wasmtime/src/runtime/vm/component/set_threads.rs`
  — **but see finding M8: parts of it still describe the OLD design and are
  wrong.** Fixing those comments is itself a task; the next reviewer will reason
  from them.
- `~/Projects/wasmtime-set/crates/wasmtime/src/runtime/component/guest_memory.rs`
  — the copy-safe canonical ABI rationale.

## Build / run

SET engine checkout `~/Projects/wasmtime-set` (wasmtime 49-dev `ac0772970…`, the
9-patch enclave stack + SET in the working tree, vendored `vendor/wasmparser`
fork). `cargo build --release` (~2 min).

Always run with `-W threads,shared-everything-threads,component-model-threading,shared-memory`,
plus `-S cli` for WASI.

Guest toolchain image `enclave-wasipsetc-build:local`; rebuild after any libc
change with `docker build -f wasm/Dockerfile.wasipsetc-build -t enclave-wasipsetc-build:local wasm/`
(~4 min), then `docker run --rm -v "$PWD":/src enclave-wasipsetc-build:local prog.c -o prog.wasm`.

Probes and repros in `tools/parallelism-probe/` (`*.wat` plus `worker-io.c`,
`worker-trap.c`, `worker-connect.c`, `worker-spin-teardown.c`, and the R4 race
rig `set-cabi-race.wat` + `cabi_race.rs`). Caps tests `test/wasm-set.test.mjs`,
`test/wasm-p3.test.mjs`; full suite `npm test`.

## What is already done — do NOT redo

- **Worker execution model.** A worker is a full instantiation of the whole
  component in its own `Store`, sharing only the spawning core instance's linear
  memory (`SetViewPlan` threaded through the component `Instantiator`). Import
  stubbing is abandoned, not repaired: Cranelift devirtualizes calls to
  statically-known imports into direct calls to the callee's compiled body while
  loading the callee vmctx from the import slot, so any substitution scheme runs
  the primary's code under a mistyped vmctx. Proof:
  `tools/parallelism-probe/set-worker-import-foreign.wat`.
- **Copy-safe canonical ABI.** `GuestMemory`/`GuestMemoryMut` copy through
  volatile reads and validate the copy for `shared` memories; unshared memories
  keep the zero-copy borrow.
- **libc per-thread WASI state** (descriptor table, stdio, preopens,
  `global_network`) and the `__enclave_set_thread_died` trap-death hook.
- **CLI worker hosts** in both `run.rs` and `serve.rs`.
- Verified: worker `printf`/`clock_gettime`/`socket()`; trapping worker returns
  `PTHREAD_CANCELED`; 15.6x at 16 threads; soak `run(500,16,2000)`=8000; 187
  wasmtime unit + 228 component-model tests; 648 enclave tests; TSan clean; the
  patch rebuilds a working engine from a fresh checkout.

## What to fix, in priority order

Full detail, with repros, is in `wasm/SET-DO-NOT-PROMOTE.md`. Summary:

1. **CRITICAL — a guest can abort the host process.** Worker stores are built by
   a different code path than the primary's, so a worker's `Host` lacks
   `wasi_http`/`wasi_nn`/`config`/`keyvalue`/`tls` while it instantiates against
   the PRIMARY's linker, whose accessors `unwrap()` them — and `worker_main`
   turns the panic into `process::abort()`. Three guest instructions under
   `-S http`. Needs **both** halves: build the worker context the way the
   primary's is built (`run.rs::new_host` must mirror `populate_with_wasi`), and
   stop converting an embedder-side panic — raised before any guest state was
   touched — into a process kill.
2. **HIGH — a worker that never returns wedges teardown and pins a core**, and
   `--wasm timeout` does not stop it. An *ordinary* program reproduces it
   (`worker-spin-teardown.c`). Root cause is exact: the cancel flag is read only
   by the futex parking spot, and the worker epoch deadline is 600 *increments*
   while `--wasm timeout` bumps the epoch once. Same hole swallows a worker
   blocked in a host call. Under `serve` each occurrence permanently consumes a
   tokio worker and a core.
3. **HIGH — per-store resource limits are multiplied by worker count**
   (`max-memory-size` is the RAM-budget gate on this platform), and fuel
   diverges both ways — `run --wasm fuel=N` + SET is a guaranteed hang.
4. **HIGH — canonical ABI**: the `transcoder_memories` refusal is unreachable
   dead code (FACT panics first on a shared adapter memory), and it is also
   placed after the initializer loop, which runs guest `start` code.
5. **HIGH — libc**: silent cross-thread fd aliasing (writes land in the *wrong
   file*, all calls returning success); worker `exit()` wedges the component;
   the death hook runs with an already-expired epoch deadline so it is a no-op
   exactly when it matters.
6. **Open question for the platform embedder**: does a worker's `memory.grow`
   escape `wasm_manager.py`'s memory limiter? Not reproducible on the CLI.
7. **Stale safety comments** in `set_threads.rs` and `store.rs` that describe the
   old design (including a claim that workers hold raw pointers into the primary
   store — the false premise keeping the unconditional blocking join in place),
   and dead code (`snapshot_plain_globals`/`write_plain_globals` have zero
   callers).

## Verification bar (all required before promotion)

Everything the previous round required, still passing, **plus**: the CRITICAL is
unreachable; `worker-spin-teardown.c` exits cleanly under a normal
`--wasm timeout`; `run --wasm fuel=N` with SET does not hang; per-worker limits
bind at the tenant total, not per worker; cross-thread fd use fails rather than
aliases; and a **fresh 4-agent adversarial review clears**. Re-run: the R4 race
rig with its negative control, the perf bench, the soak, `npm test`, the wasmtime
unit + component-model suites, and TSan.

## Gotchas that cost real time this round

- **TSan lies without `--cfg rustix_use_libc`.** Fiber stacks are freed by
  rustix's raw `munmap`, which TSan cannot intercept, so a recycled stack address
  is reported as a race with the dead thread. Discriminator: 200 workers *one at
  a time* (no concurrency possible) still reported 12 races before the flag, zero
  after. Build TSan with
  `RUSTFLAGS="-Zsanitizer=thread --cfg rustix_use_libc" cargo +nightly build -Zbuild-std --target x86_64-unknown-linux-gnu --release -p wasmtime-cli`.
- **Regenerating the SET patch.** `git diff` in the checkout shows all 9 enclave
  patches too, and untracked new files are invisible to it — the previous `.wip`
  was missing `set_threads.rs` entirely and could not have built. Correct
  procedure: fresh checkout at `ac0772970`, apply the 9 patches from
  `Dockerfile.wasmtime` in order, commit that as a baseline, `rsync` the live
  tree over it (excluding `.git`, `target*`, `vendor`), `git add -A`, then
  `git diff --cached` excluding `crates/wasi-http/src/p2/http_impl.rs` and
  `crates/wasi-nn/src/backend/ggml.rs` — the live checkout is **behind** the
  repo's patches for those two, and including them reverts that work. Verify by
  applying to a fresh 9-patch checkout and building.
- **Feature flags lie**; probe by compiling a probe module.
- `set-nested-spawn.wat` now hits the thread cap rather than trapping — nested
  spawn genuinely works. Its own header comment is stale.
- A `shared` wasm function may only call `shared` functions, which is why the
  real toolchain uses a plain start type and a plain funcref table.

## Promotion (only after the bar AND a clearing review)

Regenerate both patch files, rename `.wip` → `.patch`, add the SET patch +
wasmparser vendor/relax step to `Dockerfile.wasmtime`, extend
`wasmtime-patch-check.yml`, delete `wasm/SET-DO-NOT-PROMOTE.md`. The fleet
cutover (toolchain dispatch → `WASMTIME_IMAGE` repin → fleet-op stop→start) is a
Steven-gated measurement event — do not do it unprompted.
