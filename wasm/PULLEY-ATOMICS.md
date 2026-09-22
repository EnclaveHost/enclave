# Atomics in Pulley: shared-everything threads where there is nothing to JIT into

`wasm/pulley-atomics.patch` adds the WebAssembly threads proposal's atomic instructions to
wasmtime's **Pulley** interpreter and to Cranelift's Pulley backend.

**The proposal is still REFUSED for a Pulley target, deliberately, and the atomics are not the
reason.** See "The soundness correction" below before enabling anything.

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

## The soundness correction

**An earlier version of this document, and of the commit that introduced it, claimed that Pulley's
use of raw pointers made racing non-atomic accesses safe. That was wrong.**

Rust's data-race rules apply to raw pointers exactly as they do to references.
`read_unaligned`/`write_unaligned` on a shared memory are ordinary non-atomic accesses, and a wasm
guest is *allowed* to race a non-atomic store against an atomic load — permitted by the wasm memory
model, undefined behaviour under Rust's. Mixed-width overlapping atomics are a second case in the
same family. The authority is
[the atomic memory model](https://doc.rust-lang.org/core/sync/atomic/#memory-model-for-atomic-accesses).

Upstream's one-line comment was therefore correct as written, and arguing past it on the strength of
`*mut T` was reading it too narrowly.

So: making the atomics atomic was **necessary and not sufficient**. What remains before the gate can
honestly come off is that every ORDINARY access to a shared memory must stop being a plain read or
write too:

  - aligned ordinary loads/stores → relaxed atomics; **done**, see below;
  - unaligned ones → byte-wise relaxed atomics (each byte is aligned); **done**;
  - **partially overlapping accesses of DIFFERENT WIDTHS** — not done, and the hard one;
  - the bulk operations (`memory.copy`, `memory.fill`, `memory.init`) over a shared memory, and
    host accesses to guest memory generally;
  - growth and lifetime — `SharedMemory` must not move a base another thread holds.

### The one that does not have an obvious fix: mixed-width overlap

Making every access atomic removes the non-atomic race and **does not remove this**:

    thread A:  i32.load    at p      ->  AtomicU32::load  at p
    thread B:  i32.store8  at p + 1  ->  AtomicU8::store  at p + 1

Both atomic, both aligned *for their own width*, overlapping, different sizes. Rust's model defines
atomic accesses only between operations of the **same size at the same address**; a partially
overlapping differently-sized pair is not covered. WebAssembly explicitly permits it. The same
applies between two genuine guest atomic ops of different widths, so it is not a consequence of the
ordinary-access work — it was there already.

Alignment does not help (both accesses are aligned).

**This section described the state before `wasm/wasmtime-shared-memory-soundness.patch`. Read
"The mixed-size hole, and what closes it" below for what is actually implemented now.** What it got
wrong is recorded there rather than deleted, because the wrong turn is instructive: byte-wise
atomics everywhere were dismissed on the grounds that a wasm atomic op must be INDIVISIBLE and four
one-byte accesses are not. True — of byte-wise atomics *without* a lock. With a stripe lock for the
atomic instructions they are indivisible with respect to each other after all.

Miri has since been installed and run, on the box. It reports the design described above as
undefined: *"Race condition detected between (1) 4-byte atomic load on thread `unnamed-21` and
(2) 1-byte atomic store on thread `unnamed-22`"*. The reasoning was right and the confirmation
agrees with it.

The gate stays on and the VBS box keeps advertising `set: false` — now for the reasons in
"Still open" below, not for this one.

### Ordinary accesses: done, and what it cost

The first item is implemented. **Every ordinary wasm load and store in Pulley funnels through two
functions** — the addressing modes only implement `addr`, and `load_ne`/`store_ne` are shared
defaults — so `race_read`/`race_write` replace `read_unaligned`/`write_unaligned` for all of them.
Relaxed atomics: no ordering is imposed (an ordinary wasm access promises none) and tearing stays
permitted (the spec allows it); what changes is only that the access stops being a data race.
Aligned widths are one instruction; unaligned falls back to per-byte in a `#[cold]` tail, because
every wasm producer aligns what it can.

Measured on 50M load+store pairs through the interpreter, same machine, same binary otherwise:

| | |
|---|---|
| plain `read_unaligned`/`write_unaligned` (the unsound version) | 521 ms |
| relaxed atomics, **alignment test removed** (attribution only, unsound) | **491 ms** |
| relaxed atomics, first attempt (result via a `MaybeUninit` slot) | 736 ms |
| relaxed atomics, early returns + cold unaligned tail | **623 ms** |

The second row is the finding: **the atomic access itself costs nothing** — it is marginally faster
than the plain one. The whole apparent 41% tax was the alignment branch forcing the value through a
stack slot instead of a register, and restructuring recovered half of it. The remaining ~20% is
branch layout on a benchmark that is *only* loads and stores; a workload with any arithmetic between
accesses pays less.

The way to stop paying it at all is to specialise: a memory that is not `shared` cannot be raced, so
its accesses can stay plain. The interpreter cannot tell them apart, but the COMPILER can, so this
wants distinct opcodes for shared-memory accesses rather than a run-time test. Not done.

**That cost is now larger, and the reason is in the next section.** The bulk operations took the
specialised route already: `memory.copy`/`memory.fill` have shared variants chosen at compile time,
so a private memory still memmoves.

## The mixed-size hole, and what closes it

`wasm/wasmtime-shared-memory-soundness.patch`.

Width-sized relaxed atomics for aligned ordinary accesses were not enough, and this is the second
thing this document got wrong. Rust forbids **mixed-size atomic accesses to overlapping locations**,
and a wasm guest reaches that shape trivially: `i32.load` at an address and `i32.load8_u` at the
same address are an `AtomicU32` and an `AtomicU8` over one byte. Nothing makes that program invalid
in wasm, so nothing may make it undefined here.

One byte is the only width at which two accesses to the same address can never disagree about their
size. So:

| | before | now |
|---|---|---|
| ordinary load/store | width-sized relaxed atomic when aligned, byte-wise when not | **always byte-wise relaxed** |
| wasm atomic load/store/RMW/CAS | `AtomicUN`, lock-free | **striped lock** over byte-wise accesses |
| `memory.copy` / `memory.fill` | `memmove` / `memset` (upstream FIXME #4203) | **byte-wise relaxed**, via compile-time-selected builtins |
| small constant `memory.copy` | expanded inline as ordinary loads/stores | inline path **skipped** for a shared memory |

The atomic instructions could not stay lock-free once ordinary accesses went byte-wise: an
`AtomicU32` RMW beside a byte-wise store to the same word is the very mismatch being removed. So
`Shared<T>` gives them mutual exclusion instead, striped by 8-byte block of the host address - a
wasm atomic is aligned (the frontend traps otherwise) and at most 8 bytes, so it never spans two
blocks, and two overlapping atomics always hash to the same stripe. It keeps `AtomicUN`'s method
names and `Ordering` arguments, so all 36 instruction bodies are unchanged.

What is deliberately NOT locked: an ordinary access racing an atomic one. That race is a race in
the wasm memory model too, and the ordinary side may read a torn value. Locking it would be slower
and wrong.

**Growth needed no change.** A defined shared memory's base is pre-reserved and never moves, and
its length is read through the out-of-line `VMMemoryDefinition` so concurrent growth stays visible;
that length load is an ordinary load, so it is now byte-wise like everything else.

### Evidence

Six tests in `pulley/src/interp.rs` exercise the mechanism directly rather than through bytecode:
the property is a memory-model property and the discriminating input is a racing thread.

    cargo test  -p pulley-interpreter --features std,interp --lib shared_memory     6/6 pass
    cargo miri test  (same filter)                                                  6/6 pass, nothing reported

Neither result means anything without the pair that fails:

| mutation | result |
|---|---|
| the guard removed from `Shared::rmw` | the contention test returns **39201 of 160000** |
| the width-sized fast path restored for aligned 4-byte accesses | Miri: **"Undefined Behavior: Race condition detected between (1) 4-byte atomic load on thread `unnamed-21` and (2) 1-byte atomic store on thread `unnamed-22`"** |
| the wait precondition restored to a wide `AtomicU32::load` | Miri: **"Undefined Behavior: Race condition detected between (1) multiple differently-sized atomic loads ... and (2) 1-byte atomic store"** |

The wait path has its own Miri run, on the PRODUCTION `ParkingSpot`, because the interpreter's six
tests did not reach it and said nothing about it:

    cargo miri test -p wasmtime --features ...,pulley,threads --lib parking_spot
    3 passed, 12 ignored (the upstream parking_lot tests carry cfg_attr(miri, ignore))

On Windows this needs `CARGO_TARGET_DIR` shortened: with the default path cargo-miri fails with
"cargo uses an argfile to invoke rustc, which is not supported by cargo-miri", which looks like a
build error and is a path-length limit.

The second is this change's whole reason, reported by a tool instead of argued for in a comment.
`tools/parallelism-probe/mixed-width` is the standalone reproducer for the same shape and has been
corrected: it used to say byte-wise atomics could not work, which was true only of byte-wise
atomics *without* a lock for the atomic instructions.

### Still open before the refusal may move

- **Host access.** Three paths fixed, one class audited, NOT a clean bill of health: what follows
  is what was looked at, and "no other caller was found" is not the same as "no other caller
  exists". `Memory::data`/`data_mut` guarded a shared memory with a
  `debug_assert`, which is not there in a release build; they now assert for real, so a host path
  that has not been converted breaks instead of racing. The canonical ABI's copy helpers used
  `read_volatile`/`write_volatile`, which is the common mistake: volatile constrains the COMPILER
  and does nothing for the MEMORY MODEL, so a volatile read racing a guest write is still a data
  race. They are per-byte relaxed atomics now. `as_slice_mut_unshared`/`into_unshared_slice` already
  refused a shared memory, and the enclave's own host code (`windows/enclave-rt`) touches only host
  buffers - checked, not assumed.

  **And one this missed, found by review after the interpreter's tests were green.**
  `memory.atomic.wait32/64` built an `AtomicU32`/`AtomicU64` over the guest word to check its
  expected value - a wide atomic over bytes Pulley writes one at a time, which is the same
  mixed-size overlap on the path hardest to test. The check now goes through the interpreter's own
  accessor, taking the same stripe lock the guest's atomics take, and still runs inside the parking
  table's lock so check-and-enqueue stays atomic. `tests::wait_precondition_races_guest_writes`
  races a real `ParkingSpot::wait32` against byte stores and wide RMWs through those accessors.

  The lesson generalises and is worth stating plainly: the six `Shared` tests in the interpreter
  cover the interpreter. They said nothing about wasmtime's own uses of guest memory, and reading
  them as "shared access is done" is exactly the mistake that left this path wide.
- **`no_std`.** Mostly done; one piece left. `wasmtime --no-default-features --features
  runtime,component-model,pulley,threads` went from **35 errors to 3**, and all three are
  `set_threads.rs` - `thread.spawn` and its join handles, 1981 lines built on
  `std::thread::Builder` and `JoinHandle`. The enclave already has `EE_OP_SPAWN`; what it does not
  have is join, which wants the same park/unpark permits this stage added. That is the next stage.

  What landed: `runtime/vm/nostd_threads.rs`, which takes FOUR hooks from the embedder - park,
  unpark, a thread token, a monotonic clock - and builds the rest in `core` + `alloc`. The enclave
  side of those four is `ee_park`/`ee_unpark`/`ee_park_token`/`ee_now_us`, and the new `EE_OP_PARK`
  / `EE_OP_UNPARK` call-outs behind them (one binary semaphore per token on the host, so a permit
  released before its park is remembered instead of lost).

  `parking_spot.rs` and `shared_memory.rs` were NOT rewritten - they are upstream files with
  upstream churn. They say `use ...nostd_threads::shim as std;` and their existing `use std::...`
  lines resolve to a std-shaped view of the enclave's primitives.

  The table this replaced, kept because it is still the right map of the problem:

  | needs | has | wants |
  |---|---|---|
  | `SharedMemory` | `std::sync::RwLock` | a spin `RwLock` - no OS to block on |
  | `ParkingSpot` | `std::sync::Mutex`, `BTreeMap` | spin mutex, `alloc::collections::BTreeMap` |
  | `memory.atomic.wait` | `std::thread::park`/`unpark` | **a call OUT to the host**: VTL1 has no scheduler, and enclave threads are host threads that called in |
  | timeouts | `std::time::Instant` | `ee_app_now_ms`, which the enclave already has |
  | `thread.spawn` | `std::thread::spawn` | **a call OUT to the host** to create a thread that calls back in |

  Two of those five are new ABI calls (`ee-rt.h`, `ee-app.cpp`, `ee-host.c`), which is where this
  stage starts. Spinning instead of parking is not an option for `atomic.wait`: a guest may wait
  indefinitely, and a spinning enclave thread holds a core and the host's patience.
- **Tested behaviour** for wait/notify, spawn, and thread lifetime - not merely compiled. The
  wait PRECONDITION now has a racing test (below); spawn and teardown do not.
- **The cost**, unmeasured since the change. The numbers below are the width-sized version's and
  are stale in the direction that matters: byte-wise accesses and lock-based atomics are both
  slower than what was measured. Treat every figure under "Measured" as an upper bound on
  performance, not a current reading.

## What the atomics themselves are, and how far they are checked

The atomic ops use `AtomicNN::from_ptr` on the pointer `AddressingMode::addr` already produces,
which is what the proposal describes for the atomic accesses themselves.

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
here through `i32.atomic.load`, with `memory.atomic.wait32`/`notify` handing off between them.

**The second proves less than it looks like it does**, and this is worth stating because I claimed
otherwise: `set-spawn-stress` returns the COMPLETION counter — 160 atomic adds, one per worker per
round — not the 5000 contended adds each worker performs. Those are never checked. A peer session
made the general form of this point the same evening, about a lost-wakeup race their own 3000-trial
stress regression passed cleanly: a contended stress probe samples whatever thread alignments the
scheduler happens to produce, and those are not the adversarial ones.

So the discriminating test is `tools/parallelism-probe/atomic-litmus.wat`: N workers, released
together by a barrier, each adding 1 to ONE address `iters` times, returning the final value. Every
single add is checked, because the sum IS the result.

    atomic-litmus  run(8,50000)  =  400000 of 400000   (exact, three runs)

and with the 32-bit atomic add deliberately replaced by a load-modify-store, rebuilt and re-run:

    atomic-litmus  run(8,50000)  =  110618 / 113368 / 112699

It fails on the defect and passes on the fix, which is the only thing that makes a green run mean
anything. Note what this does NOT establish: it exercises the common alignments, not adversarial
interleavings, and it says nothing about ordinary non-atomic accesses racing atomic ones — which is
the soundness gap above.

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
