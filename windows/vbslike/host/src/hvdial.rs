//! hvdial: dial ONE hv_sock port of ONE partition, by VmId, and report what happened.
//!
//! WHY THIS EXISTS. On the UEFI/WMI path the partition is a Hyper-V VM created through WMI, not an
//! HCS compute system the lab owns, so nothing in `lab` can reach it. Proving the control channel
//! needs exactly this: connect to the VM's vsock port from the host and say whether it answered.
//!
//! WHAT A SUCCESS MEANS, AND WHAT IT DOES NOT. A successful connect proves the guest has a WORKING
//! vsock transport and is listening on that port. It proves nothing about the guest's identity, the
//! boundary, or host exclusion: hv_sock has no guest-to-guest path, so the host is the only side
//! that can dial, and being able to dial is a property of the HOST's position, never evidence about
//! the guest's isolation.
use crate::hvsock;
use crate::util::Opts;
use std::io::{Read, Write};
use std::time::Duration;

pub fn run(opts: &Opts) -> i32 {
    let vm = match opts.get("vm").and_then(|s| hvsock::parse_guid(s)) {
        Some(g) => g,
        None => { eprintln!("hvdial: --vm <GUID> is required (the VM's Id, as Get-VM reports it)"); return 2; }
    };
    let port: u32 = match opts.get("port").and_then(|s| s.parse().ok()) {
        Some(p) => p,
        None => { eprintln!("hvdial: --port <N> is required"); return 2; }
    };
    let secs: u64 = opts.get("seconds").and_then(|s| s.parse().ok()).unwrap_or(10);
    let send = opts.get("send");

    let t0 = std::time::Instant::now();
    match hvsock::dial(&vm, port, Duration::from_secs(secs)) {
        Err(e) => {
            // The failure is the finding: report it verbatim rather than a summary.
            println!("{}", serde_json::json!({
                "connected": false,
                "vm": hvsock::guid_string(&vm),
                "port": port,
                "error": e.to_string(),
                "os_error": e.raw_os_error(),
                "ms": t0.elapsed().as_millis() as u64,
            }));
            1
        }
        Ok(mut s) => {
            let ms = t0.elapsed().as_millis() as u64;
            let mut sent = 0usize;
            let mut head = String::new();
            if let Some(line) = send {
                let _ = s.set_write_timeout(Some(Duration::from_secs(5)));
                if let Ok(n) = s.write(format!("{line}\n").as_bytes()) { sent = n; }
                let _ = s.flush();
                let _ = s.set_read_timeout(Some(Duration::from_secs(secs)));
                let mut buf = [0u8; 4096];
                if let Ok(n) = s.read(&mut buf) {
                    head = String::from_utf8_lossy(&buf[..n]).trim().to_string();
                }
            }
            println!("{}", serde_json::json!({
                "connected": true,
                "vm": hvsock::guid_string(&vm),
                "port": port,
                "ms": ms,
                "sent": sent,
                "head": head,
                "note": "a connect proves the guest has a working vsock transport and is listening. \
                         It says NOTHING about the guest's identity, its boundary or host exclusion.",
            }));
            0
        }
    }
}
