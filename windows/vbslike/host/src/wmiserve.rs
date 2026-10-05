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
//!   - OR, with `--igvm-sha256` instead of `--medium-sha256` (the measured Linux-VTL0 IGVM, where
//!     there is NO medium: our kernel, initrd and VTL0 command line are INSIDE the measured firmware),
//!     `guestImageSha256` is the IGVM FILE's sha256 and `platform.partition` says so
//!     ("wmi-openhcl-gen2-igvm-linux"), so a reader can never mistake one kind of identity for the
//!     other. The hardware launch digest is not in this launcher-signed report; it is the file's
//!     measurement, recomputable from these bytes (verify/vbsdigest).
//!   - `kernelSha256` is LEFT EMPTY and omitted. There is no host-supplied kernel here.
//!   - G1 (enclave-5d, isolation/portable-runtime-jit 1e9e99fb): the monitor mints a per-boot nonce
//!     and returns it as `boot` in the load answer. Every stop/destroy carries it, and an answer of
//!     `rebooted: true` is a KNOWN end - every domain of that boot is gone - never an error to retry.
//!   - `platform.partition` is stated by THIS launcher ("wmi-openhcl-gen2" for a medium,
//!     "wmi-openhcl-gen2-igvm-linux" for the IGVM), because the guest cannot know what kind of partition
//!     it is in and the monitor no longer guesses. These names are CANONICAL (enclave-99's contract,
//!     "Launcher statements", main ae6e9147): the manager states the same ones, paired with guestImageKind.
//!   - LIFETIME: `--hold <seconds>` (default 120) serves for that long, and a non-empty stdin line ends it
//!     early (uefi-dev-boot.ps1's bounded canary). `--hold stdin` serves until a non-empty stdin line OR
//!     stdin's EOF: a manager keeps the pipe open for the domain's life, and its exit (or crash) closes
//!     the pipe and so ends the relay with it. Anything else is refused before anything starts.
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
// THE SHARED FORMAT AND TIER (contract.rs, re-exported by report.rs), the names judge-hv, the verifier registry and the
// Go contract use. A local "hyperv-vbs-partition-v1" signed every report on this path until the first serving acceptance
// on nucbox-k11 (run 081904) had the manager's judge refuse it as "report format/tier". The partition KIND travels in
// platform.partition, never in the format name.
use crate::report::{FORMAT, TIER};

struct Serve {
    vm: windows_sys::core::GUID,
    vm_str: String,
    key: LauncherKey,
    /// What the guest booted from: the MEDIUM's sha256 (UEFI path) or the IGVM FILE's (Linux VTL0
    /// inside the measured IGVM). `partition` names which, so the two are never confused.
    image_sha: String,
    partition: &'static str,
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
                partition: self.partition.into(),
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
                // the MEDIUM, hashed by the caller at attach time - or the IGVM file on the
                // measured Linux-VTL0 path, as `platform.partition` states
                guest_image_sha256: self.image_sha.clone(),
                // EMPTY: no host-supplied kernel on this path, so the field is omitted entirely
                kernel_sha256: String::new(),
                vcpus: self.vcpus,
                mem_mib: self.mem_mib,
            },
            domain: DomainId { label: self.label.clone(), app_sha256: hex::encode(app) },
            report_data: hex::encode(rd),
            boundary: format!("tier={TIER} partition={} isolation_type={} host_excluded=no",
                              self.partition, self.isolation_type),
            issued_ms: crate::util::unix_ms(),
        };
        let signed = self.key.sign(&doc);
        serde_json::to_value(&signed).map_err(|e| e.to_string())
    }
}

/// The signing service. The listener is bound to this VM's id, so every connection comes from
/// inside it; a connection claiming another partition is closed without an answer.
/// A stop/destroy for guest domain `id`, carrying the boot its load answer named (G1). Without a boot
/// (a monitor older than 1e9e99fb) the field is omitted: a newer monitor refuses that with
/// `bootRequired`, which is the correct refusal rather than a guess.
fn guest_cmd(cmd: &str, id: u64, boot: Option<&str>) -> Value {
    match boot { Some(b) => json!({"cmd": cmd, "id": id, "boot": b}), None => json!({"cmd": cmd, "id": id}) }
}

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

/// How long wmiserve serves: a bounded number of seconds, or for as long as its parent holds stdin open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hold { Secs(u64), Stdin }

/// `--hold`: absent is 120 s; `stdin` is the parent's lifetime; otherwise whole seconds, 1..=86400. Anything else is
/// REFUSED (0 used to close the relay the moment it was ready; a typo used to become 120 s).
pub fn parse_hold(v: Option<&str>) -> Result<Hold, String> {
    match v {
        None => Ok(Hold::Secs(120)),
        Some("stdin") => Ok(Hold::Stdin),
        Some(s) => match s.parse::<u64>() {
            Ok(n) if (1..=86_400).contains(&n) => Ok(Hold::Secs(n)),
            _ => Err(format!("--hold must be whole seconds 1..86400 or `stdin`, not {s:?}")),
        },
    }
}

#[cfg(test)]
mod hold_tests {
    use super::*;
    #[test]
    fn hold_values() {
        assert_eq!(parse_hold(None), Ok(Hold::Secs(120)));
        assert_eq!(parse_hold(Some("90")), Ok(Hold::Secs(90)));
        assert_eq!(parse_hold(Some("stdin")), Ok(Hold::Stdin));
        for bad in ["0", "-1", "", "forever", "STDIN", "90s", "86401", " 90"] {
            assert!(parse_hold(Some(bad)).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn a_cert_name_is_exactly_8_lowercase_hex_in_the_app_zone() {
        assert!(cert_name_ok("4e62e60d.app.enclave.host"));
        for bad in ["", "1", "4E62E60D.app.enclave.host", "4e62e60.app.enclave.host", "4e62e60d0.app.enclave.host",
                    "4e62e60g.app.enclave.host", "4e62e60d.app.enclave.host.", "4e62e60d.app.test", "x.4e62e60d.app.enclave.host",
                    "4e62e60d.app.enclave.hostx", " 4e62e60d.app.enclave.host"] {
            assert!(!cert_name_ok(bad), "{bad:?} must be refused");
        }
    }
}

/// M4: the ONE name a domain may be certified for, `<8 lowercase hex>.app.enclave.host` (the first 8 hex of its deployment
/// id). Stated to the monitor on `load` as "name", which the monitor re-checks (certNameOK) and writes to /cert.name; only
/// a named domain serves the front's CSR and certificate endpoints. The host's word (T0-hv); the relay's certificate
/// gate binds the name to the deployment.
pub fn cert_name_ok(n: &str) -> bool {
    match n.strip_suffix(".app.enclave.host") {
        Some(h) => h.len() == 8 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        None => false,
    }
}

pub fn run(o: &Opts) -> i32 {
    let Some(vm) = o.get("vm").and_then(|s| hvsock::parse_guid(s)) else {
        eprintln!("wmiserve: --vm <GUID> is required"); return 2;
    };
    let Some(bundle_path) = o.get("bundle") else {
        eprintln!("wmiserve: --bundle <file> is required"); return 2;
    };
    // EXACTLY ONE identity: the medium the VM booted from, or the IGVM that carries the guest.
    let hex64 = |v: &str| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit());
    let (image_sha, partition) = match (o.get("medium-sha256"), o.get("igvm-sha256")) {
        (Some(m), None) if hex64(m) => (m.to_lowercase(), "wmi-openhcl-gen2"),
        (None, Some(i)) if hex64(i) => (i.to_lowercase(), "wmi-openhcl-gen2-igvm-linux"),
        _ => {
            eprintln!("wmiserve: exactly one of --medium-sha256 <64 hex> (UEFI medium) or --igvm-sha256 <64 hex> \
                       (Linux VTL0 inside the measured IGVM) is required: without it the report cannot say what booted");
            return 2;
        }
    };
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
    // PARSED HERE, before anything is loaded: a mistyped hold used to become 120 s silently, AFTER the app was served.
    let hold = match parse_hold(o.get("hold")) {
        Ok(h) => h,
        Err(e) => { eprintln!("wmiserve: {e}"); return 2; }
    };
    // M4: parsed HERE too, and REFUSED rather than dropped: a domain loaded without the name it was asked to carry would
    // serve no certificate endpoints, silently.
    let cert_name: Option<String> = match o.get("cert-name") {
        None => None,
        Some(n) if cert_name_ok(n) => Some(n.to_string()),
        Some(n) => {
            eprintln!("wmiserve: --cert-name must be <8 lowercase hex>.app.enclave.host, not {:?}", n.chars().take(80).collect::<String>());
            return 2;
        }
    };

    let app = match std::fs::read(bundle_path) {
        Ok(b) => b,
        Err(e) => { eprintln!("wmiserve: cannot read {bundle_path}: {e}"); return 2; }
    };
    // OUR hash of what we are about to send. The monitor answers with its own; they must agree.
    let our_app_id = contract::app_id(&app);
    let our_app_sha = hex::encode(our_app_id);

    let s = Arc::new(Serve {
        isolation_type: iso,
        vm, vm_str: hvsock::guid_string(&vm), key: LauncherKey::mint(), image_sha, partition,
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
    let mut load = json!({"cmd": "load", "label": label, "size": app.len()});
    if let Some(n) = &cert_name { load["name"] = json!(n); }
    let ans = match s.guest(&load, Some(&app), Duration::from_secs(60)) {
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
        // Destroy exactly the domain the guest named, under the boot it named. The old code defaulted a
        // missing id to 1 (63's L4), which could reclaim a different domain.
        match ans.get("id").and_then(|x| x.as_u64()) {
            Some(id) => {
                let r = s.guest(&guest_cmd("destroy", id, ans.get("boot").and_then(|x| x.as_str())), None, Duration::from_secs(20));
                println!("{}", json!({"step": "load-reclaim", "answer": r.unwrap_or_else(|e| json!({"error": e}))}));
            }
            None => println!("{}", json!({"step": "load-reclaim", "error": "the load answer named no domain id, so nothing was destroyed rather than guessing one"})),
        }
        return 1;
    }
    // M4: the monitor answers with the domain it recorded, whose "name" must be exactly the one sent (absent when none
    // was). A monitor that dropped or changed it is refused here, and the domain it named is destroyed as above.
    let guest_name = ans.get("name").and_then(|x| x.as_str()).map(|s| s.to_string());
    if guest_name != cert_name {
        println!("{}", json!({"step": "load", "ok": false,
            "error": format!("the monitor recorded the name {guest_name:?}, not the {cert_name:?} sent"),
            "action": "the domain is NOT served"}));
        if let Some(id) = ans.get("id").and_then(|x| x.as_u64()) {
            let r = s.guest(&guest_cmd("destroy", id, ans.get("boot").and_then(|x| x.as_str())), None, Duration::from_secs(20));
            println!("{}", json!({"step": "load-reclaim", "answer": r.unwrap_or_else(|e| json!({"error": e}))}));
        }
        return 1;
    }
    // NO DEFAULTS (63's L4): a load answer without the domain's id or port is refused, never filled in.
    let (Some(gid), Some(gport)) = (ans.get("id").and_then(|x| x.as_u64()), ans.get("port").and_then(|x| x.as_u64())) else {
        println!("{}", json!({"step": "load", "ok": false, "error": "the load answer did not name the domain's id and port", "answer": ans}));
        return 1;
    };
    let gport = gport as u32;
    // G1: the boot this domain belongs to. Absent only from a monitor older than 1e9e99fb.
    let gboot = ans.get("boot").and_then(|x| x.as_str()).map(|s| s.to_string());
    s.loaded.lock().unwrap().push(our_app_id);
    println!("{}", json!({"step": "load", "ok": true, "id": gid, "appSha256": guest_sha,
                          "guestPort": gport, "boot": gboot, "agreed": true, "certName": guest_name}));

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
    let deadline = match hold { Hold::Secs(n) => Some(std::time::Instant::now() + Duration::from_secs(n)), Hold::Stdin => None };
    let stop = Arc::new(AtomicBool::new(false));
    {
        let stop2 = stop.clone();
        let eof_ends = hold == Hold::Stdin;
        std::thread::spawn(move || {
            let mut line = String::new();
            loop {
                line.clear();
                match std::io::stdin().read_line(&mut line) {
                    // a non-empty line ends it early, in either mode
                    Ok(n) if n > 0 && !line.trim().is_empty() => { stop2.store(true, Ordering::SeqCst); return; }
                    Ok(n) if n > 0 => continue,
                    // EOF or a broken pipe: under `--hold stdin` the parent is gone, so the relay goes too.
                    // Under a timed hold it means only that nobody will type (an empty redirected file).
                    _ => { if eof_ends { stop2.store(true, Ordering::SeqCst); } return; }
                }
            }
        });
    }
    while deadline.map_or(true, |d| std::time::Instant::now() < d) && !stop.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(200));
    }
    s.closing.store(true, Ordering::SeqCst);
    println!("{}", json!({"step": "closed"}));
    0
}
