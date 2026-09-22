// ee-precompile <component.wasm> <out.cwasm>
//
// The enclave interprets; this compiles. Run on the app's way in, beside the CID check, so what
// crosses the enclave gate is bytecode for a target with no machine code at all.
use wasmtime::{Config, Engine, Result};

/// The feature bits, mirrored from windows/enclave-rt/src/lib.rs. The RUNTIME owns these values;
/// this binary only has to agree about what each bit means.
const FEAT_MEM64: u32 = 1;
#[allow(dead_code)] const FEAT_SET: u32 = 2;            // needs atomics in Pulley; not built here yet
#[allow(dead_code)] const FEAT_P3: u32 = 4;
#[allow(dead_code)] const FEAT_COOP_THREADS: u32 = 8;
/// What THIS compiler can actually build for. Everything else is refused by name rather than
/// silently dropped: a cwasm missing a feature its runtime expects is the failure mode that has no
/// symptom until an app uses it.
const KNOWN: u32 = FEAT_MEM64;

fn main() -> Result<()> {
    let mut a = std::env::args().skip(1);
    let inp = a.next().expect("usage: ee-precompile <component.wasm> <out.cwasm> [feature-mask]");
    let outp = a.next().expect("usage: ee-precompile <component.wasm> <out.cwasm> [feature-mask]");
    // THE FEATURE MASK IS THE RUNTIME'S, not this binary's opinion.
    //
    // wasmtime records a cwasm's TUNABLES and refuses a mismatch, but NOT its wasm features -
    // measured: bytecode compiled without memory64 loads happily into a runtime that has it. So
    // nothing in the engine stops these two halves drifting apart, and they are separate binaries.
    //
    // The node therefore asks the enclave what it enables (ee_rt_features, out through `appabi`)
    // and passes that here. This side enables exactly that set and REFUSES a bit it cannot
    // implement, so "the compiler was ahead of the interpreter" is an error at build time instead
    // of a wrong answer at run time. No argument = the conservative default below.
    let want: u32 = a.next().map(|s| s.parse().unwrap_or(u32::MAX)).unwrap_or(FEAT_MEM64);
    let mut config = Config::new();
    // pulley64: wasmtime's portable interpreter. The output is bytecode, not code.
    config.target("pulley64")?;
    config.wasm_component_model(true);
    // The tunables the ENCLAVE side can actually honour. A cwasm records them, and the runtime
    // refuses an artifact whose tunables it cannot provide rather than quietly running it wrong:
    // "virtual memory disabled at compile time -- cannot enable CoW" is that refusal, and it is
    // right. There is no virtual memory in VTL1 to map, protect or copy on write, so:
    config.memory_init_cow(false);        // no file-backed image to map a guest's data from
    config.memory_reservation(0);         // no big reservation to grow into: memory is malloc'd
    config.memory_guard_size(0);          // no guard pages; the interpreter bounds-checks instead
    config.memory_reservation_for_growth(0);
    config.signals_based_traps(false);    // no signal handlers in an enclave; traps are checks
    config.epoch_interruption(true);      // the only way to stop a server whose run() never returns
    if want & !KNOWN != 0 {
        eprintln!("this compiler cannot build for feature mask {want} (it knows {KNOWN}); \
                   the enclave runtime is ahead of ee-precompile - rebuild both halves");
        std::process::exit(4);
    }
    config.wasm_memory64(want & FEAT_MEM64 != 0);
    // 64-BIT MEMORIES, and the component-model half of the same thing. An app whose guest needs
    // more than the 4 GiB a 32-bit index can address declares `mem64` in its catalog config, and
    // this is what lets it be compiled at all. Pulley bounds-checks every access in software, so a
    // 64-bit index costs it nothing structural - the interpreter was already doing the check.
    let engine = Engine::new(&config)?;
    let bytes = std::fs::read(&inp)?;
    // A core module is not a component and never will be: say which it is, because the node's
    // refusal reason is what a publisher reads.
    if bytes.len() < 8 || &bytes[0..4] != b"\0asm" {
        eprintln!("{inp}: not a wasm file");
        std::process::exit(2);
    }
    let layer = u16::from_le_bytes([bytes[6], bytes[7]]);
    if layer != 1 {
        eprintln!("{inp}: a core wasm module (layer {layer}), not a component");
        std::process::exit(3);
    }
    let cwasm = engine.precompile_component(&bytes)?;
    std::fs::write(&outp, &cwasm)?;
    println!("{} -> {} ({} -> {} bytes, pulley64, features {}, wasmtime {})",
             inp, outp, bytes.len(), cwasm.len(), want, env!("CARGO_PKG_VERSION"));
    Ok(())
}
