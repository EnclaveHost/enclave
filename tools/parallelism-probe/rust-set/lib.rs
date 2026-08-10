#![no_std]
//! enclave/SET: Rust running on real OS threads inside a wasip2 component.
//!
//! Threading comes from the SET libc's pthreads (which route to the component
//! model's `thread.spawn-indirect` builtin), reached by FFI. `no_std` because
//! Rust's precompiled wasip2 `std` is built WITHOUT atomics and cannot be
//! linked into a shared-memory module; `core` is rebuilt with atomics via
//! `-Z build-std=core`.
use core::ffi::c_void;
use core::sync::atomic::{AtomicU64, Ordering};

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::sync::atomic::compiler_fence(Ordering::SeqCst);
    loop {}
}

unsafe extern "C" {
    fn pthread_create(t: *mut usize, attr: *const c_void,
                      f: extern "C" fn(*mut c_void) -> *mut c_void,
                      arg: *mut c_void) -> i32;
    fn pthread_join(t: usize, ret: *mut *mut c_void) -> i32;
}

/// Shared across every thread: this is the whole point — one linear memory.
static TOTAL: AtomicU64 = AtomicU64::new(0);

extern "C" fn worker(arg: *mut c_void) -> *mut c_void {
    let n = arg as usize as u64;
    // A DEPENDENT chain (LCG), not a closed-form sum: each step needs the
    // previous, so LLVM cannot fold or vectorise it away. A foldable loop makes
    // a threading benchmark measure the optimiser instead of the threads.
    let mut x: u64 = n.wrapping_mul(0x9E3779B97F4A7C15).wrapping_add(1);
    for _ in 0..200_000_000u64 {
        // `black_box` is REQUIRED, not decoration. LLVM closed-forms an affine
        // recurrence, so without it the whole loop folds to a constant and the
        // benchmark measures the optimiser: 800M iterations "ran" in 0.106s at
        // every thread count, i.e. 1 and 8 threads timed identically.
        x = core::hint::black_box(
            x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407),
        );
    }
    TOTAL.fetch_add(x, Ordering::SeqCst);
    core::ptr::null_mut()
}

/// Spawn `n` real threads, join them, return the shared accumulator.
#[unsafe(no_mangle)]
pub extern "C" fn set_demo_run(n: u32) -> u64 {
    let mut ts = [0usize; 16];
    let n = core::cmp::min(n as usize, 16);
    unsafe {
        for i in 0..n {
            if pthread_create(&mut ts[i], core::ptr::null(), worker,
                              i as *mut c_void) != 0 {
                return u64::MAX;
            }
        }
        for i in 0..n {
            pthread_join(ts[i], core::ptr::null_mut());
        }
    }
    TOTAL.load(Ordering::SeqCst)
}
