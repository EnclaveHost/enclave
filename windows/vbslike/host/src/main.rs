//! vbslike-host: the Windows backend of the app-domain contract (isolation/contract), on a machine
//! with no TEE. It ports isolation/m3's INVARIANTS onto Hyper-V child partitions, and runs the SAME
//! guest image the Linux path runs (isolation/m3/build-domain.sh) inside each of them:
//!   - one isolated domain per app: one Hyper-V child partition each, created through the Host
//!     Compute Service on Virtual Machine Platform (the same hypervisor and partition boundary VBS
//!     itself is built on);
//!   - the monitor INSIDE the partition (isolation/m3/monitor) hashes the app it is given and names it
//!     in report_data; this launcher hashes what it pushed and refuses to sign anything else;
//!   - the report binds the domain's own key, the verifier's nonce and the app ID, in the contract's
//!     64 bytes; here the launcher signs them (no hardware signer), and says so;
//!   - crossed-domain requests are refused by construction (a request has no field for an app, and
//!     the signing service is bound to one partition's id);
//!   - a partition that dies is retired exactly once and leaves nothing behind; failures fail closed.
//! What it does NOT claim: the host is not excluded on this hardware. README.md states the trust.
mod contract;
mod hcs;
mod hvdial;
mod wmiserve;
mod hvsock;
mod isoprobe;
mod lab;
mod reap;
mod launcher;
mod probe;
mod report;
mod util;

fn usage() -> ! {
    eprintln!(
        "usage:\n  vbslike-host probe [--out FILE]\n  vbslike-host vectors <vectors.json>\n  vbslike-host lab --kernel K --initrd I --out DIR [--mem MiB] [--cpus N] [--tcp-base PORT]\n  vbslike-host isoprobe --kernel K --initrd I --out DIR [--igvm PATH] [--vmgs PATH] [--seconds N] [--only NAME]\n  vbslike-host reap --prefix vbslike-iso-<pid>-   (terminate ONLY the probe partitions of one run)\n  vbslike-host hvdial --vm GUID --port N [--seconds S] [--send LINE]"
    );
    std::process::exit(2)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        usage();
    }
    let opts = util::Opts::parse(&args[2..]);
    let rc = match args[1].as_str() {
        "probe" => probe::run(&opts),
        "vectors" => {
            let path = args.get(2).map(|s| s.as_str()).unwrap_or("vectors.json");
            match contract::run_vectors(path) {
                Ok(f) if f.is_empty() => {
                    println!("VECTORS PASS {path} (abi {})", contract::ABI);
                    0
                }
                Ok(f) => {
                    for x in &f {
                        println!("VECTORS FAIL {x}");
                    }
                    1
                }
                Err(e) => {
                    println!("VECTORS ERROR {e}");
                    2
                }
            }
        }
        "lab" => lab::run(&opts),
        "isoprobe" => isoprobe::run(&opts),
        "reap" => reap::run(&opts),
        "hvdial" => hvdial::run(&opts),
        "wmiserve" => wmiserve::run(&opts),
        _ => usage(),
    };
    std::process::exit(rc);
}
