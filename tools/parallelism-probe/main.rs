// Proof harness: real OS-thread parallelism inside ONE wasm program on
// wasmtime 49, using the mechanism the deleted wasi-threads crate used —
// one shared linear memory, one Store PER THREAD (Store is !Sync; the
// memory is what's shared, not the store).
use anyhow::Result;
use std::sync::Arc;
use std::sync::atomic::{AtomicI32, Ordering};
use wasmtime::*;

fn main() -> Result<()> {
    let nthreads: i32 = std::env::args().nth(1).unwrap_or("4".into()).parse()?;
    let iters: i64 = std::env::args().nth(2).unwrap_or("900000000".into()).parse()?;

    let mut cfg = Config::new();
    cfg.wasm_threads(true);
    cfg.shared_memory(true);
    let engine = Engine::new(&cfg)?;

    // A module that imports its shared memory and exports a worker that
    // burns CPU then atomically records completion in that shared memory.
    let wat = r#"
(module
  (import "env" "memory" (memory 1 1 shared))
  (func (export "work") (param $id i32) (param $iters i64) (result i64)
    (local $i i64) (local $acc i64)
    (block $done
      (loop $l
        (br_if $done (i64.ge_u (local.get $i) (local.get $iters)))
        (local.set $acc (i64.add (local.get $acc)
          (i64.xor (local.get $i) (i64.extend_i32_u (local.get $id)))))
        (local.set $i (i64.add (local.get $i) (i64.const 1)))
        (br $l)))
    ;; atomically bump the shared completion counter at offset 0
    (drop (i32.atomic.rmw.add (i32.const 0) (i32.const 1)))
    (local.get $acc))
)
"#;
    let module = Module::new(&engine, wat)?;

    // ONE shared memory, imported by every per-thread instance.
    let shared = SharedMemory::new(&engine, MemoryType::shared(1, 1))?;

    let mut linker: Linker<()> = Linker::new(&engine);
    linker.define(&mut Store::new(&engine, ()), "env", "memory", shared.clone())?;
    let pre = Arc::new(linker.instantiate_pre(&module)?);

    let counter = Arc::new(AtomicI32::new(0));
    let t0 = std::time::Instant::now();
    let mut handles = Vec::new();
    for id in 0..nthreads {
        let pre = pre.clone();
        let engine = engine.clone();
        let counter = counter.clone();
        handles.push(std::thread::spawn(move || -> Result<i64> {
            // each OS thread: its OWN Store, the SAME shared memory
            let mut store = Store::new(&engine, ());
            let inst = pre.instantiate(&mut store)?;
            let f = inst.get_typed_func::<(i32, i64), i64>(&mut store, "work")?;
            let r = f.call(&mut store, (id, iters))?;
            counter.fetch_add(1, Ordering::SeqCst);
            Ok(r)
        }));
    }
    let mut acc = 0i64;
    for h in handles { acc = acc.wrapping_add(h.join().unwrap()?); }
    let ms = t0.elapsed().as_millis();

    // read the guest-side atomic counter out of the shared memory
    let guest_counter = unsafe { *(shared.data().as_ptr() as *const i32) };
    println!("threads={nthreads} wall={ms}ms acc={acc} host_joins={} guest_atomic_counter={guest_counter}",
             counter.load(Ordering::SeqCst));
    Ok(())
}
