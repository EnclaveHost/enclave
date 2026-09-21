// ee-precompile <component.wasm> <out.cwasm>
//
// The enclave interprets; this compiles. Run on the app's way in, beside the CID check, so what
// crosses the enclave gate is bytecode for a target with no machine code at all.
use wasmtime::{Config, Engine, Result};

fn main() -> Result<()> {
    let mut a = std::env::args().skip(1);
    let inp = a.next().expect("usage: ee-precompile <component.wasm> <out.cwasm>");
    let outp = a.next().expect("usage: ee-precompile <component.wasm> <out.cwasm>");
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
    println!("{} -> {} ({} -> {} bytes, pulley64, wasmtime {})",
             inp, outp, bytes.len(), cwasm.len(), env!("CARGO_PKG_VERSION"));
    Ok(())
}
