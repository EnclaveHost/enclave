# Atomics in Pulley: shared-everything threads where there is nothing to JIT into

`wasm/pulley-atomics.patch` adds the WebAssembly threads proposal's atomic instructions to
wasmtime's **Pulley** interpreter and to Cranelift's Pulley backend, and lifts the config gate that
refused the proposal for that target.

## Why

An app that uses threads has to be runnable **inside a VBS enclave**, where there is no page the
process may execute — which is the property VBS exists to enforce, and the reason the enclave runs
an interpreter at all (`windows/enclave-rt`). Pulley is the only wasmtime backend that fits there.

Concretely: the platform's own `s3-ipfs-adapter` and `risc-box` both declare `set: true`, and the
VBS box refuses them by name. This is what removes that refusal.

## What it does

37 opcodes appended to `for_each_extended_op!` (appended, so no existing opcode number moves and
every cwasm already compiled stays valid):

| | widths |
|---|---|
| `xatomic_load*_o32` | 8, 16, 32, 64 |
| `xatomic_store*_o32` | 8, 16, 32, 64 |
| `xatomic_rmw*_{add,sub,and,or,xor,xchg}_o32` | 8, 16, 32, 64 |
| `xatomic_cas*_o32` | 8, 16, 32, 64 |
| `xatomic_fence` | |

...their interpreter bodies, and 37 ISLE lowering rules. **Cranelift's `pulley_*` constructors and
its emission are generated from the opcode list** (`cranelift/codegen/meta/src/pulley.rs`), so
adding the opcodes is most of the work.

CLIF also defines `nand`/`umin`/`umax`/`smin`/`smax` for `atomic_rmw`. No wasm guest can emit them,
so they are deliberately left without a rule: a caller that somehow reaches one gets Cranelift's own
"should be implemented in ISLE" rather than a wrong answer.

## Why it is sound, and where the trust sits

Upstream excluded threads on Pulley saying "Rust can't safely implement loads/stores in the face of
shared memory". That is about formal UB, not structure: **Pulley already addresses guest memory
through raw pointers** (`AddressingMode::addr` returns `*mut T`; loads and stores go through
`read_unaligned`/`write_unaligned`), never through a Rust slice or reference. The atomic ops use
`AtomicNN::from_ptr` on that same pointer, which is exactly what the proposal describes. Non-atomic
racing accesses stay as the spec allows — they may read garbage, and they never form a reference.

**Alignment is the caller's guarantee, not checked here.** The wasm frontend emits an explicit
alignment test before every atomic access and traps with `TRAP_HEAP_MISALIGNED`
(`crates/cranelift/src/translate/code_translator.rs`), so a misaligned address cannot reach these
opcodes. That is the same trust every other Pulley memory op already places in its bytecode.

**Endianness.** Loads, stores, bitwise RMW and exchange carry `to_le`/`from_le`, which is free on a
little-endian host. Arithmetic does not commute with a byte swap, so on a big-endian host `add` and
`sub` become a compare-and-swap loop. The lowering rules also carry `little_or_native_endian`, the
same guard every other backend uses, so a big-endian *access* is refused rather than silently
byte-swapped.

## Measured

Against `tools/parallelism-probe`, pulley64 vs native x86_64 with the same engine:

    set-spawn-indirect   run() = 7           pulley 306 us   native 356 us
    set-spawn-stress     run(20,8,5000)=160  pulley 14.8 ms  native 10.4 ms

The first proves a worker really ran on another thread and its `i32.atomic.rmw.add` was observed
here through `i32.atomic.load`, with `memory.atomic.wait32`/`notify` handing off between them. The
second is the one that would catch a broken implementation: 20 rounds x 8 threads x 5000 **contended**
atomic adds, plus a cross-thread `memory.grow`, and the completion counter comes back **exactly**
160. A lost update or a torn read would show up as less.

## Applying it

It sits on top of the SET engine (`wasm/wasmtime-set-threads.patch` + the vendored wasmparser fork),
against the pinned wasmtime commit. Three things must ALL be enabled or you get three different
misleading errors: the `threads` and `component-model-async` cargo features, `shared_memory(true)`,
and the `[patch.crates-io] wasmparser` fork. Without the last one a SET component is refused with
"mismatch in the shared flag for memories", which reads like a bad artifact.

## What this does NOT do

It does not yet put SET inside the enclave. That still needs wasmtime's `SharedMemory` to work
without `std` (it uses `RwLock`, `Instant` and a parking spot), a `memory.atomic.wait` that does not
assume a futex, and `windows/enclave-rt` to move from wasmtime 47 (crates.io) to this tree.

And it is not enough for **risc-box 0.6.54** whatever else lands: that artifact is refused before
codegen on every backend, including native, because it is `mem64` AND `set` — a wasm64 app
`wac plug`ged under a wasm32 proxy, which makes fused adapters over a shared memory. See
`crates/environ/src/component/translate/adapt.rs` in the SET patch for why that is refused
deliberately.
