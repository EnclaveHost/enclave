//! enclave/SET: driver for the shared-canonical-ABI race (blocker R4).
//!
//! Pairs with `set-cabi-race.wat`. The guest's cabi memory is `shared` and a
//! SET worker flips the bytes of a string between valid and invalid utf8 while
//! this harness lifts that string through the canonical ABI, over and over.
//!
//! What it checks is deliberately not "did we crash": UB does not have to
//! crash. It checks the property that makes the borrowing ABI unsound —
//! whether the `&str` the host was handed still points at the bytes that were
//! validated:
//!
//! * `Cow::Borrowed` means the host is holding a reference INTO guest memory.
//!   Re-validating those bytes a moment later can fail, and a failure is proof
//!   that safe Rust was holding a `&str` that is not utf8.
//! * `Cow::Owned` means the host validated a private snapshot, which no guest
//!   thread can reach. Re-validation cannot fail.
//!
//! So the expected results are:
//!
//! * copy-safe canonical ABI (this engine): `borrowed = 0`, `invalid = 0`, and
//!   `flips` large enough to show the race really was live.
//! * borrowing canonical ABI (upstream): `borrowed = N` and `invalid > 0`
//!   within a few thousand iterations.
//!
//! Build against the SET engine checkout:
//!
//! ```sh
//! cargo build --release            # in a crate whose wasmtime dep is a path
//!                                  # dep on ~/Projects/wasmtime-set
//! ./cabi_race path/to/set-cabi-race.wat 200000
//! ```
//!
//! Under ThreadSanitizer this is also the R4 race target: TSan reports the
//! host-side race on the borrowing ABI and is silent on the copy-safe one.
//! Verify your TSan build actually reports a known race first — a clean run
//! from an uninstrumented binary is silently green.

use anyhow::{Context, Result};
use std::sync::Arc;
use wasmtime::component::{Component, Linker, SetWorkerHost, SetWorkerRequest, WasmStr};
use wasmtime::{Config, Engine, Store};

struct WorkerHost {
    engine: Engine,
    pre: wasmtime::component::InstancePre<()>,
}

impl SetWorkerHost for WorkerHost {
    fn run_worker(&self, req: SetWorkerRequest) -> Result<()> {
        let mut store = Store::new(&self.engine, ());
        // A tiny current-thread runtime is enough: this harness's guest never
        // calls a host import that pends.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        rt.block_on(req.run_async(&mut store, &self.pre))
    }
}

fn main() -> Result<()> {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "set-cabi-race.wat".into());
    let iters: u32 = std::env::args()
        .nth(2)
        .unwrap_or_else(|| "200000".into())
        .parse()?;

    let mut cfg = Config::new();
    cfg.wasm_component_model(true);
    cfg.wasm_threads(true);
    cfg.shared_memory(true);
    cfg.wasm_shared_everything_threads(true);
    cfg.wasm_component_model_threading(true);
    let engine = Engine::new(&cfg)?;

    let component = Component::from_file(&engine, &path)
        .with_context(|| format!("loading {path}"))?;
    let linker: Linker<()> = Linker::new(&engine);
    let pre = linker.instantiate_pre(&component)?;

    let mut store = Store::new(&engine, ());
    store.set_set_worker_host(Arc::new(WorkerHost {
        engine: engine.clone(),
        pre: pre.clone(),
    }));
    let instance = pre.instantiate(&mut store)?;

    let begin = instance.get_typed_func::<(), (i32,)>(&mut store, "begin")?;
    let stop = instance.get_typed_func::<(), (i32,)>(&mut store, "stop")?;
    let get = instance.get_typed_func::<(), (WasmStr,)>(&mut store, "get")?;

    let (rc,) = begin.call(&mut store, ())?;
    begin.post_return(&mut store)?;
    anyhow::ensure!(rc >= 0, "guest could not spawn the flipper (rc={rc})");

    let mut borrowed = 0u64;
    let mut owned = 0u64;
    let mut invalid = 0u64;
    let mut lift_errors = 0u64;

    for _ in 0..iters {
        let (s,) = get.call(&mut store, ())?;
        match s.to_str(&store) {
            Ok(std::borrow::Cow::Borrowed(text)) => {
                borrowed += 1;
                // The host is holding a reference into guest memory. Give the
                // worker a moment, then look again at the SAME bytes.
                for _ in 0..64 {
                    std::hint::spin_loop();
                }
                if std::str::from_utf8(text.as_bytes()).is_err() {
                    invalid += 1;
                }
            }
            Ok(std::borrow::Cow::Owned(_)) => owned += 1,
            // A lift that rejects a torn sequence is CORRECT behaviour, not a
            // failure: the guest really did hand over invalid utf8 that moment.
            Err(_) => lift_errors += 1,
        }
        get.post_return(&mut store)?;
    }

    let (flips,) = stop.call(&mut store, ())?;
    stop.post_return(&mut store)?;

    println!("iterations   = {iters}");
    println!("guest flips  = {flips}");
    println!("lift borrowed= {borrowed}");
    println!("lift owned   = {owned}");
    println!("lift rejected= {lift_errors}");
    println!("INVALID str held by the host = {invalid}");

    anyhow::ensure!(
        flips > 1000,
        "the flipper barely ran ({flips} flips); the race was not exercised"
    );
    anyhow::ensure!(
        borrowed == 0,
        "canonical ABI handed out {borrowed} borrows into a `shared` memory"
    );
    anyhow::ensure!(
        invalid == 0,
        "host held {invalid} invalid `str`s aliasing guest memory"
    );
    println!("OK: every lift over the shared memory was a private snapshot");
    Ok(())
}
