//! base-bytecode-check <datadir>: prints ONE JSON receipt line (base-bytecode-check/v2); exit 0 only if ok.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    let datadir = args.next().ok_or("usage: base-bytecode-check <datadir>")?;
    if args.next().is_some() {
        return Err("usage: base-bytecode-check <datadir>".into());
    }
    let datadir = datadir.into_string().map_err(|_| "datadir is not UTF-8")?;
    let r = base_bytecode_check::scan_datadir(&datadir)?;
    println!("{}", r.json());
    std::process::exit(if r.ok() { 0 } else { 1 });
}
