// A reduced reproducer for the reason Pulley still REFUSES the threads proposal.
//
// Not a wasm test and not a benchmark: this is the shape of the remaining unsoundness, small
// enough to reason about and to hand to a UB checker.
//
//   cargo +nightly miri run        (expects: Miri reports a mixed-size atomic access)
//
// THE SITUATION. Pulley now performs every guest memory access with a relaxed atomic of the
// access's own width - `AtomicU32` for an aligned i32, `AtomicU8` per byte when unaligned, and the
// natural width for a genuine wasm atomic op. That removes the non-atomic data race, which was the
// first problem. It does NOT remove this one:
//
//   thread A: i32.load        at p      ->  AtomicU32::load  at p
//   thread B: i32.store8      at p + 1  ->  AtomicU8::store  at p + 1
//
// Both are atomic. They OVERLAP and they are DIFFERENT SIZES. Rust's memory model defines atomic
// accesses only between operations of the same size at the same address; a partially overlapping,
// differently sized pair is not covered, and is therefore not something a sound Rust program may
// do. WebAssembly, meanwhile, explicitly permits it: a guest may byte-store into a word another
// thread is loading, and the spec says what the guest observes, not that the host may fall over.
//
// https://doc.rust-lang.org/core/sync/atomic/#memory-model-for-atomic-accesses
//
// WHY THE OBVIOUS FIXES DO NOT WORK.
//
//   Byte-wise atomics everywhere, on their own. Solves the overlap - every access is then
//   AtomicU8 - but a wasm ATOMIC op must be INDIVISIBLE, and a four-byte access built from four
//   unsynchronised one-byte accesses is not. That trades a host-model violation for a
//   guest-semantics violation, which is worse: the guest can observe it.
//
//   Byte-wise atomics everywhere, PLUS a lock for the atomic instructions. This is what
//   wasm/wasmtime-shared-memory-soundness.patch now does, and it is the reason this file is no
//   longer the last word. Every ordinary access is AtomicU8, so no two accesses to one address
//   ever differ in size; the wasm atomic instructions take a striped lock (by 8-byte block of the
//   host address) and move their bytes under it, so they are indivisible with respect to each
//   other after all. The objection above applied to byte-wise atomics WITHOUT the lock.
//
//   What that still does not reproduce is hardware's behaviour when an atomic races an ORDINARY
//   access, which the lock does not cover: a guest thread doing a plain 4-byte store while another
//   does an atomic load can, here, have some of its bytes seen and not others, where an aligned
//   machine access would be all-or-nothing. That pair is a DATA RACE in wasm's own memory model,
//   which is why it is defensible - wasm resolves a race with an unspecified value rather than
//   undefined behaviour, and an unspecified value is what this produces. It is still a real
//   weakening against hardware, it is the one remaining semantic gap in this approach, and it
//   should be confirmed against the spec text rather than against this comment before the gate
//   moves.
//
//   Alignment. Irrelevant. Both accesses above are perfectly aligned for their own width.
//
//   Widening the narrow access to the wide one. A read-modify-write of the containing word is not
//   equivalent: it writes bytes the guest did not write, which a racing reader can observe.
//
// THE OTHER THING THAT WOULD WORK is stepping outside Rust's typed atomics for guest memory
// entirely - inline assembly with the right constraints, where the compiler treats the access as
// an opaque memory operation and the hardware guarantee (an aligned mov IS atomic on x86-64 and
// aarch64) is the one being relied on. It is the only approach that also reproduces hardware for
// the atomic-versus-ordinary race above. It is target-specific, which cuts against the whole point
// of a portable interpreter, and it is a larger change than anything here.
//
// The gate stays on either way, and no longer for this reason: what holds it now is host access to
// guest memory and the `no_std` port, both listed in wasm/PULLEY-ATOMICS.md.
use std::sync::atomic::{AtomicU32, AtomicU8, Ordering::Relaxed};
use std::thread;

fn main() {
    // One aligned word of "guest memory".
    let mem = Box::leak(Box::new([0u8; 8]));
    let p = mem.as_mut_ptr();
    assert_eq!(p as usize % 4, 0, "the word we race on is aligned for the wide access");

    let wide = p as usize;
    let narrow = unsafe { p.add(1) } as usize;

    let a = thread::spawn(move || {
        let w = wide as *const AtomicU32;
        let mut seen = 0u32;
        for _ in 0..10_000 {
            // A guest i32.load of a SHARED memory, as Pulley performs it.
            seen = seen.wrapping_add(unsafe { (*w).load(Relaxed) });
        }
        seen
    });
    let b = thread::spawn(move || {
        let n = narrow as *const AtomicU8;
        for i in 0..10_000u32 {
            // A guest i32.store8 one byte into the SAME word. Atomic, aligned for ITS width,
            // overlapping the load above, and a different size.
            unsafe { (*n).store(i as u8, Relaxed) };
        }
    });
    let seen = a.join().unwrap();
    b.join().unwrap();
    println!("no crash, and that is the point: {seen}");
    println!("nothing here is observably wrong on this hardware - an aligned mov is atomic and the");
    println!("bytes land. What is wrong is that Rust's model does not define it, so the compiler is");
    println!("entitled to assume it cannot happen. Run this under Miri for the verdict.");
}
