//! wmiserve: the control plane for ONE partition that this launcher did not create.
//!
//! WHY. On the UEFI path the partition is a Hyper-V VM defined through WMI, so `lab`'s machinery -
//! which owns the HCS compute systems it creates - cannot reach it. Everything the domain needs
//! after `MON ready` is here, against a VM named only by its GUID:
//!
//!   1. the report signing service on hv_sock 9001, which the guest DIALS when something first asks
//!      it for an attestation;
//!   2. `load` on hv_sock 9000, with the bundle bytes, and HASH AGREEMENT on the answer;
//!   3. the relay: host TCP -> hv_sock 40000+id, ciphertext only.
//!
//! WHAT THE REPORT SAYS ON THIS PATH, and why it differs from the HCS one:
//!   - `partition.guestImageSha256` is the sha256 of the MEDIUM the VM was booted from, supplied by
//!     the caller that attached it. Not the UKI's: with Secure Boot off the stub reads addons,
//!     credentials and extensions from the ESP, so two media carrying one UKI can boot different
//!     command lines, and only the medium hash tells them apart.
//!   - `kernelSha256` is LEFT EMPTY and omitted. There is no host-supplied kernel here.
//!   - `platform.partition` is stated by THIS launcher ("wmi-openhcl-gen2"), because the guest
//!     cannot know what kind of partition it is in and the monitor no longer guesses.
//!   - `platform.isolation` and the boundary line carry the partition's ACTUAL
//!     GuestStateIsolationType, which `--isolation-type` supplies and which is refused rather than
//!     defaulted. The old code hardcoded type 16 and printed it verbatim on type-1 runs.
//!   - `hostExcluded` is FALSE ON BOTH TYPES. A type-16 OpenHCL child partition is documented as
//!     "OpenHCL but no isolation"; the root can map its memory. A type-1 (VBS) partition is
//!     CONFIGURED for hypervisor-enforced isolation and its guest even states hv_isolation=vbs, but
//!     no host-side read has been shown to be refused on this host -- the documented instrument for
//!     trying it, Save-VM plus a saved-state decoder, is itself refused on a type-1 VM. A
//!     configuration is not a measurement, so nothing here may be advertised otherwise on either.
use crate::contract;
use crate::hvsock;
use crate::report::{DomainId, LauncherId, LauncherKey, PartitionId, Platform, ReportDoc};
use crate::util::Opts;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const CTRL_PORT: u32 = 9000;
const REPORT_PORT: u32 = 9001;
const MAX_LINE: usize = 1 << 20;
const FORMAT: &str = "hyperv-vbs-partition-v1";
const TIER: &str = "T0-hv";

struct Serve {
    vm: windows_sys::core::GUID,
    vm_str: String,
    key: LauncherKey,
    medium_sha: String,
    /// The partition's GuestStateIsolationType, stated by the launcher that created it. Required:
    /// a boundary statement that does not track the actual partition kind is wrong in whichever
    /// direction it happens to err, so there is no default to guess with.
    isolation_type: u16,
    vcpus: u64,
    mem_mib: u64,
    label: String,
    loaded: Mutex<Vec<[u8; 32]>>,
    closing: AtomicBool,
}

impl Serve {
    /// One command to the monitor on a fresh connection: one JSON line, optional body, one line back.
    fn guest(&self, cmd: &Value, body: Option<&[u8]>, timeout: Duration) -> Result<Value, String> {
        let c = hvsock::dial(&self.vm, CTRL_PORT, Duration::from_secs(5)).map_err(|e| format!("control dial: {e}"))?;
        let _ = c.set_read_timeout(Some(timeout));
        let _ = c.set_write_timeout(Some(timeout));
        let mut w = c.try_clone().map_err(|e| e.to_string())?;
        let mut s = serde_json::to_string(cmd).unwrap();
        s.push('\n');
        w.write_all(s.as_bytes()).map_err(|e| format!("control write: {e}"))?;
        if let Some(b) = body {
            w.write_all(b).map_err(|e| format!("control body: {e}"))?;
        }
        let mut r = BufReader::new(c);
        let mut line = String::new();
        r.read_line(&mut line).map_err(|e| format!("control answer: {e}"))?;
        serde_json::from_str(line.trim()).map_err(|e| format!("control answer not JSON: {e}: {line}"))
    }

    /// The signed report. Only an app half this process actually loaded into THIS VM is signed.
    fn issue(&self, rd: &[u8; 64]) -> Result<Value, String> {
        let mut app = [0u8; 32];
        app.copy_from_slice(&rd[32..]);
        if !self.loaded.lock().unwrap().contains(&app) {
            return Err(format!("report_data names app {} which this launcher did not load into {}",
                               hex::encode(app), self.vm_str));
        }
        let doc = ReportDoc {
            format: FORMAT.into(),
            tier: TIER.into(),
            platform: Platform {
                os: "windows".into(),
                hypervisor: "hyper-v".into(),
                // STATED BY THE LAUNCHER. The guest cannot know its partition kind.
                partition: "wmi-openhcl-gen2".into(),
                isolation: format!("openhcl-type{}", self.isolation_type),
                // FALSE FOR BOTH TYPES, and not negotiable here.
                //
                // Type 16 is "OpenHCL but no isolation" in Microsoft's own source: the root
                // partition can map this guest's memory, by construction.
                //
                // Type 16 is not the only case, though, and this is the part worth being careful
                // about. A type-1 (VBS) partition is CONFIGURED for hypervisor-enforced isolation,
                // and on this host its guest even states hv_isolation=vbs -- but no host-side read
                // has ever been shown to be refused here, because the documented instrument for
                // trying (Save-VM plus a saved-state decoder) is itself refused on a type-1 VM. A
                // configuration is not a measurement. Until a host read is demonstrated to fail
                // where it demonstrably succeeds on a control, this stays false for type 1 too.
                host_excluded: false,
            },
            launcher: LauncherId { key: self.key.public_b64(), started_ms: self.key.started_ms },
            partition: PartitionId {
                vm_id: self.vm_str.clone(),
                // the MEDIUM, hashed by the caller at attach time
                guest_image_sha256: self.medium_sha.clone(),
                // EMPTY: no host-supplied kernel on this path, so the field is omitted entirely
                kernel_sha256: String::new(),
                vcpus: self.vcpus,
                mem_mib: self.mem_mib,
            },
            domain: DomainId { label: self.label.clone(), app_sha256: hex::encode(app) },
            report_data: hex::encode(rd),
            boundary: format!("tier={TIER} partition=wmi-openhcl-gen2 isolation_type={} host_excluded=no",
                              self.isolation_type),
            issued_ms: crate::util::unix_ms(),
        };
        let signed = self.key.sign(&doc);
        serde_json::to_value(&signed).map_err(|e| e.to_string())
    }
}

/// The signing service. The listener is bound to this VM's id, so every connection comes from
/// inside it; a connection claiming another partition is closed without an answer.
fn report_service(s: Arc<Serve>, l: hvsock::Listener) {
    loop {
        if s.closing.load(Ordering::SeqCst) { return; }
        let (mut c, peer) = match l.accept_timeout(500) {
            Ok(Some(x)) => x,
            Ok(None) => continue,
            Err(_) => return,
        };
        if hvsock::guid_string(&peer) != s.vm_str {
            eprintln!("{}", json!({"report": "refused", "why": "connection is not this partition",
                                   "peer": hvsock::guid_string(&peer)}));
            continue;
        }
        let _ = c.set_read_timeout(Some(Duration::from_secs(5)));
        let _ = c.set_write_timeout(Some(Duration::from_secs(5)));
        let mut r = BufReader::new(c.try_clone().unwrap());
        let mut line = String::new();
        let answer = match r.read_line(&mut line).ok().and_then(|_| serde_json::from_str::<Value>(line.trim()).ok()) {
            Some(v) => {
                let abi_ok = v.get("abi").and_then(|x| x.as_str()) == Some(contract::ABI);
                let rd = v.get("reportData").and_then(|x| x.as_str()).and_then(|h| hex::decode(h).ok());
                match (abi_ok, rd) {
                    (false, _) => json!({"error": format!("abi must be {}", contract::ABI)}),
                    (true, Some(rd)) if rd.len() == 64 => {
                        let mut arr = [0u8; 64];
                        arr.copy_from_slice(&rd);
                        match s.issue(&arr) { Ok(rep) => json!({"report": rep}), Err(e) => json!({"error": e}) }
                    }
                    (true, _) => json!({"error": "reportData must be 128 hex characters"}),
                }
            }
            None => json!({"error": "request is not one JSON line"}),
        };
        let mut out = serde_json::to_string(&answer).unwrap();
        out.push('\n');
        let _ = c.write_all(out.as_bytes());
    }
}

pub fn run(o: &Opts) -> i32 {
    let Some(vm) = o.get("vm").and_then(|s| hvsock::parse_guid(s)) else {
        eprintln!("wmiserve: --vm <GUID> is required"); return 2;
    };
    let Some(bundle_path) = o.get("bundle") else {
        eprintln!("wmiserve: --bundle <file> is required"); return 2;
    };
    let medium_sha = o.get("medium-sha256").unwrap_or("").to_string();
    if medium_sha.len() != 64 {
        eprintln!("wmiserve: --medium-sha256 <64 hex> is required: without it the report cannot say what booted");
        return 2;
    }
    let tcp: u16 = o.get("tcp").and_then(|s| s.parse().ok()).unwrap_or(0);
    let label = o.get("label").unwrap_or("canary").to_string();
    // REQUIRED, and refused rather than defaulted: every boundary string below is derived from it.
    let iso: u16 = match o.get("isolation-type").and_then(|s| s.parse().ok()) {
        Some(v) if v == 1 || v == 16 => v,
        _ => {
            eprintln!("wmiserve: --isolation-type <1|16> is required: the report and the boundary \
                       line state the partition kind, and guessing it would state it wrongly");
            return 2;
        }
    };
    let vcpus: u64 = o.get("vcpus").and_then(|s| s.parse().ok()).unwrap_or(1);
    let mem_mib: u64 = o.get("mem").and_then(|s| s.parse().ok()).unwrap_or(2048);

    let app = match std::fs::read(bundle_path) {
        Ok(b) => b,
        Err(e) => { eprintln!("wmiserve: cannot read {bundle_path}: {e}"); return 2; }
    };
    // OUR hash of what we are about to send. The monitor answers with its own; they must agree.
    let our_app_id = contract::app_id(&app);
    let our_app_sha = hex::encode(our_app_id);

    let s = Arc::new(Serve {
        isolation_type: iso,
        vm, vm_str: hvsock::guid_string(&vm), key: LauncherKey::mint(), medium_sha,
        vcpus, mem_mib, label: label.clone(), loaded: Mutex::new(Vec::new()),
        closing: AtomicBool::new(false),
    });
    println!("{}", json!({"step": "launcher", "key": s.key.public_b64(), "vm": s.vm_str}));

    // 1. the signing service FIRST: the guest dials it the moment anything asks for an attestation,
    //    and a dial with nothing listening is an attestation failure rather than a retry.
    match hvsock::Listener::bind(&vm, REPORT_PORT) {
        Ok(l) => {
            let s2 = s.clone();
            std::thread::spawn(move || report_service(s2, l));
            println!("{}", json!({"step": "report-service", "port": REPORT_PORT, "bound": true}));
        }
        Err(e) => {
            println!("{}", json!({"step": "report-service", "bound": false, "error": e.to_string()}));
            return 1;
        }
    }

    // 2. load, and REFUSE on any hash disagreement
    let ans = match s.guest(&json!({"cmd": "load", "label": label, "size": app.len()}), Some(&app), Duration::from_secs(60)) {
        Ok(v) => v,
        Err(e) => { println!("{}", json!({"step": "load", "ok": false, "error": e})); return 1; }
    };
    if let Some(err) = ans.get("error") {
        println!("{}", json!({"step": "load", "ok": false, "error": err}));
        return 1;
    }
    let guest_sha = ans.get("appSha256").and_then(|x| x.as_str()).unwrap_or("").to_lowercase();
    if guest_sha != our_app_sha {
        println!("{}", json!({"step": "load", "ok": false,
            "error": format!("hash disagreement: the guest computed {guest_sha}, we sent {our_app_sha}"),
            "action": "the domain is NOT served"}));
        let _ = s.guest(&json!({"cmd": "destroy", "id": ans.get("id").cloned().unwrap_or(json!(1))}), None, Duration::from_secs(20));
        return 1;
    }
    s.loaded.lock().unwrap().push(our_app_id);
    let gid = ans.get("id").and_then(|x| x.as_u64()).unwrap_or(1);
    let gport = ans.get("port").and_then(|x| x.as_u64()).unwrap_or(40000 + gid) as u32;
    println!("{}", json!({"step": "load", "ok": true, "id": gid, "appSha256": guest_sha,
                          "guestPort": gport, "agreed": true}));

    // 3. the relay: host TCP -> the domain's TLS port. Ciphertext only; this never terminates TLS.
    if tcp > 0 {
        let l = match std::net::TcpListener::bind(("127.0.0.1", tcp)) {
            Ok(l) => l,
            Err(e) => { println!("{}", json!({"step": "relay", "ok": false, "error": e.to_string()})); return 1; }
        };
        println!("{}", json!({"step": "relay", "ok": true, "tcp": tcp, "guestPort": gport}));
        let s3 = s.clone();
        std::thread::spawn(move || {
            for c in l.incoming() {
                let Ok(c) = c else { return };
                if s3.closing.load(Ordering::SeqCst) { return; }
                let vmid = s3.vm;
                std::thread::spawn(move || {
                    if let Ok(up) = hvsock::dial(&vmid, gport, Duration::from_secs(5)) {
                        let (mut a1, mut b1) = (c.try_clone().unwrap(), up.try_clone().unwrap());
                        let t = std::thread::spawn(move || { let _ = std::io::copy(&mut a1, &mut b1); });
                        let (mut a2, mut b2) = (c, up);
                        let _ = std::io::copy(&mut b2, &mut a2);
                        let _ = t.join();
                    }
                });
            }
        });
    }

    // The note states the partition it was actually given. The old text hardcoded type 16 and was
    // printed verbatim on type-1 runs, where it was simply false - it under-claimed rather than
    // over-claimed, but a boundary statement that does not track the partition is unreliable in
    // either direction, and this one is quoted into packages.
    let note = match iso {
        16 => "serving. This is a DEV path: type 16 is 'OpenHCL but no isolation', the root can map this guest's memory, and nothing here is host-excluded or verified capacity.",
        1  => "serving. This is a DEV path on a type-1 (VBS) partition: the hypervisor is CONFIGURED to keep VTL0 RAM host-private, which is a configuration and not a measurement. No host-side read has been shown to be refused here. Nothing here is host-excluded or verified capacity.",
        _  => "serving. This is a DEV path. Nothing here is host-excluded or verified capacity.",
    };
    println!("{}", json!({"step": "ready", "isolationType": iso, "note": note}));
    // STAY ALIVE FOR A BOUNDED TIME, and do not depend on stdin.
    //
    // The first version waited only on a line from stdin, and the caller redirected stdin from an
    // empty file - so read_line hit EOF immediately and this exited before serving anything. A
    // server whose lifetime depends on its caller's stdin having content is a server that stops
    // the moment nobody is typing.
    let hold: u64 = o.get("hold").and_then(|s| s.parse().ok()).unwrap_or(120);
    let deadline = std::time::Instant::now() + Duration::from_secs(hold);
    let stop = Arc::new(AtomicBool::new(false));
    {
        let stop2 = stop.clone();
        std::thread::spawn(move || {
            let mut line = String::new();
            // a line on stdin still ends it early, when there IS one
            if std::io::stdin().read_line(&mut line).is_ok() && !line.trim().is_empty() {
                stop2.store(true, Ordering::SeqCst);
            }
        });
    }
    while std::time::Instant::now() < deadline && !stop.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(200));
    }
    s.closing.store(true, Ordering::SeqCst);
    println!("{}", json!({"step": "closed"}));
    0
}
