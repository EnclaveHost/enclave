# SET threads: DO NOT add to Dockerfile.wasmtime yet

`wasmtime-set-threads.patch.wip` + `wasmparser-set-relax.patch` are the
shared-everything-threads (⚡) engine changes. The guest toolchain that targets
them (`Dockerfile.wasipsetc-build`, `wasi-libc-set-threads.patch`,
`set-componentize/`) is done and measured (15.8x on 16 cores). The platform
`set` capability plumbing is wired and tested (`test/wasm-set.test.mjs`).

**The engine patch is deliberately NOT in `Dockerfile.wasmtime`'s chain**, and
the `.wip` suffix (which the patch-check CI glob does not match) enforces that.
The 2026-08-07 four-agent adversarial review found two BLOCKERS that must be
fixed AND re-reviewed before this enters the measured TCB. Full write-up:
`docs/wasm-parallelism.md` → "The 2026-08-07 adversarial review".

1. **Worker threads cannot make component/WASI calls (CRITICAL) — and the
   2026-08-08 root cause is WORSE than the reported symptom.** The symptom is
   that a worker's first canon-lowered import call traps `call stack
   exhausted`. The cause is not stacks and not async/fiber context: it is that
   **stubbing a view's imports does not work at all for component core
   modules.** Cranelift devirtualizes a call to a statically-known import
   (`KnownFunc::FuncKey(FuncKey::DefinedWasmFunction(..))` in
   `crates/cranelift/src/func_environ.rs`) into a DIRECT call to the callee's
   compiled body, while still loading the callee vmctx from the import slot.
   So a worker executes the PRIMARY's compiled code with the stub's
   `VMArrayCallHostFuncContext` as its vmctx — wasm running against a vmctx of
   a completely different type. `call stack exhausted` is just what that
   confusion produces when the callee's prologue reads a `stack_limit` that
   isn't one. Proven by `tools/parallelism-probe/set-worker-import-foreign.wat`:
   the worker's stub is installed (import slot magic = `ACHF`) and never runs,
   while the primary's `divide by zero` in the imported function fires on the
   worker thread. Any component whose core module imports a sibling's function
   — i.e. anything `wasm-component-ld` emits — reaches this. Fix = give each
   worker a full component instantiation in its own store, so every
   statically-known direct call lands on code whose vmctx is the worker's own.
   Import stubbing must be abandoned, not repaired.

2. **Shared canonical-ABI memory is a host-TCB data race (HIGH).** The
   validator relaxation accepting a `shared` cabi memory (R4) lets a hostile
   guest race a worker's writes against the host's canon lift/lower → invalid
   Rust `String` / data race in the host. Fix = copy-safe canonical ABI for
   shared memory (copy accessed bytes out via atomic/volatile reads, validate
   the copy), a ~25-site change to the lift/lower machinery. R4 is kept because
   without it the toolchain can do no canonical I/O at all; it is sound for the
   trusted local/benchmark guests, unsound for untrusted fleet tenants.

Already FIXED in the `.wip` (landed + verified, still out-of-chain): the
teardown deadlock on a parked worker, and the segmented-memory-init clobber.

When both blockers are fixed and re-reviewed: rename `.wip` → `.patch`, add the
wasmparser vendor+relax step and the SET patch to `Dockerfile.wasmtime`, extend
`wasmtime-patch-check.yml`, then the normal toolchain-dispatch → WASMTIME_IMAGE
repin measurement event (Steven-gated). Not before.
