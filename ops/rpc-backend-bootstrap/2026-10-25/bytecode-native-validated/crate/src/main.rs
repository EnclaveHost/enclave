//! base-bytecode-check <datadir>: prints ONE JSON receipt line (base-bytecode-check/v1); exit 0 only if ok.
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let datadir = PathBuf::from(args.next().ok_or("usage: base-bytecode-check <datadir>")?);
    if args.next().is_some() {
        return Err("usage: base-bytecode-check <datadir>".into());
    }
    let r = base_bytecode_check::scan(&datadir.join("db"))?;
    println!("{}", r.json());
    std::process::exit(if r.ok() { 0 } else { 1 });
}
