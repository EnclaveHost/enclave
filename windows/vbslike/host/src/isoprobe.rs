//! isoprobe: what retail HCS does with each isolation configuration, recorded as evidence. Every row
//! is one document, created, started if creation succeeds, watched on its COM-port pipes for a few
//! seconds, then terminated. No host state changes: no registry, no feature, no reboot. A refusal is a
//! result and its HRESULT and result document are kept verbatim.
//!
//!   vbslike-host isoprobe --kernel K --initrd I --out DIR [--igvm PATH] [--vmgs PATH] [--seconds N] [--only NAME]
use crate::hcs::{isolated_document, DomainSpec, IsoSpec, Partition};
use crate::util::{write_json, Opts};
use serde_json::{json, Value};
use std::io::Read;
use std::path::PathBuf;
use std::time::{Duration, Instant};

pub(crate) struct Row {
    name: &'static str,
    why: &'static str,
    isolation: Option<&'static str>,
    no_chipset: bool,
    uefi: bool,
    use_igvm: bool,
    use_vmgs: bool,
    use_empty_vmgs: bool,
    hcl: Option<bool>,
    fw: Option<&'static str>,
    overcommit: bool,
    transient_gs: bool,
    tpm: bool,
}

pub(crate) fn rows() -> Vec<Row> {
    let base = Row { name: "", why: "", isolation: None, no_chipset: false, uefi: false, use_igvm: false, use_vmgs: false, use_empty_vmgs: false, hcl: None, fw: None, overcommit: true, transient_gs: false, tpm: false };
    vec![
        Row { name: "plain-direct", why: "the phase-1 document exactly (no SecuritySettings): the control", ..base },
        Row { name: "normal-direct", why: "phase-1 shape with IsolationType Normal stated explicitly", isolation: Some("Normal"), ..base },
        Row { name: "vbs-uefi-nocommit", why: "VirtualizationBasedSecurity + UEFI, memory not overcommitted (an isolated partition's memory is pinned)", isolation: Some("VirtualizationBasedSecurity"), uefi: true, overcommit: false, ..base },
        Row { name: "vbs-uefi-nocommit-gs", why: "... plus transient in-memory guest state declared", isolation: Some("VirtualizationBasedSecurity"), uefi: true, overcommit: false, transient_gs: true, ..base },
        Row { name: "vbs-uefi-nocommit-gs-tpm", why: "... plus EnableTpm (the paravisor hosts the vTPM)", isolation: Some("VirtualizationBasedSecurity"), uefi: true, overcommit: false, transient_gs: true, tpm: true, ..base },
        Row { name: "gso-uefi-nocommit-gs", why: "GuestStateOnly (TrustedLaunch-like) + UEFI, pinned memory, transient guest state", isolation: Some("GuestStateOnly"), uefi: true, overcommit: false, transient_gs: true, ..base },
        Row { name: "vbs-uefi-overcommit", why: "VirtualizationBasedSecurity + UEFI with AllowOvercommit true (is overcommit what an isolated partition refuses?)", isolation: Some("VirtualizationBasedSecurity"), uefi: true, transient_gs: true, ..base },
        Row { name: "vbs-uefi-hcl", why: "... HclEnabled stated true", isolation: Some("VirtualizationBasedSecurity"), uefi: true, overcommit: false, transient_gs: true, hcl: Some(true), ..base },
        Row { name: "vbs-direct", why: "VirtualizationBasedSecurity + LinuxKernelDirect: does an isolated partition take the host's kernel and initrd?", isolation: Some("VirtualizationBasedSecurity"), overcommit: false, transient_gs: true, ..base },
        Row { name: "vbs-igvmpath", why: "VirtualizationBasedSecurity + IgvmFilePath: a custom IGVM by path (expected to be gated by AllowFirmwareLoadFromFile)", isolation: Some("VirtualizationBasedSecurity"), uefi: true, use_igvm: true, overcommit: false, ..base },
        Row { name: "vbs-emptyvmgs", why: "VirtualizationBasedSecurity + an EMPTY VMGS file the worker may open: the in-box paravisor from its default location, guest state on disk", isolation: Some("VirtualizationBasedSecurity"), uefi: true, use_empty_vmgs: true, overcommit: false, ..base },
        // OUR paravisor AND somewhere to keep guest state. The two were never tried together:
        // `vbs-igvmpath` carried the IGVM with no VMGS and `vbs-emptyvmgs` a VMGS with no IGVM, so
        // while the firmware path was refused outright (0x80070032) the combination had no reason
        // to exist. With AllowFirmwareLoadFromFile set the refusal moved on to the next missing
        // thing - "Microsoft Guest Runtime State" failed to Initialize with 0x80070057, a device
        // the document never declared - which is what makes this the shape to try.
        Row { name: "vbs-igvmpath-emptyvmgs", why: "VirtualizationBasedSecurity + IgvmFilePath + an EMPTY VMGS: our own paravisor image, with the guest runtime state device the isolated partition demands", isolation: Some("VirtualizationBasedSecurity"), uefi: true, use_igvm: true, use_empty_vmgs: true, overcommit: false, ..base },
        Row { name: "vbs-igvmpath-emptyvmgs-tpm", why: "... plus EnableTpm, since the paravisor is what would host the vTPM", isolation: Some("VirtualizationBasedSecurity"), uefi: true, use_igvm: true, use_empty_vmgs: true, overcommit: false, tpm: true, ..base },
        Row { name: "gso-igvmpath-emptyvmgs", why: "GuestStateOnly + IgvmFilePath + an EMPTY VMGS: the same shape one isolation class down, to tell a firmware-loading problem from a VBS-isolation one", isolation: Some("GuestStateOnly"), uefi: true, use_igvm: true, use_empty_vmgs: true, overcommit: false, ..base },
        // THE CHIPSET, which every row above got wrong for this image. The file is named
        // openhcl-x64-test-linux-DIRECT: the paravisor expects the host to hand VTL0 a kernel and
        // initrd through LinuxKernelDirect and supplies the VTL2 environment itself. Asking for a
        // Uefi chipset instead makes the worker look for a UEFI firmware element this IGVM does
        // not carry, which is a good candidate for the "Element not found" at start.
        Row { name: "vbs-igvmpath-direct-emptyvmgs", why: "VirtualizationBasedSecurity + LinuxKernelDirect + IgvmFilePath + an EMPTY VMGS: the paravisor's own boot shape rather than a UEFI chipset", isolation: Some("VirtualizationBasedSecurity"), uefi: false, use_igvm: true, use_empty_vmgs: true, overcommit: false, ..base },
        Row { name: "vbs-igvmpath-direct-emptyvmgs-hcl", why: "... plus HclEnabled stated true", isolation: Some("VirtualizationBasedSecurity"), uefi: false, use_igvm: true, use_empty_vmgs: true, overcommit: false, hcl: Some(true), ..base },
        Row { name: "vbs-igvmpath-direct-gs", why: "... with TRANSIENT in-memory guest state instead of a VMGS file, in case the file is what is not found", isolation: Some("VirtualizationBasedSecurity"), uefi: false, use_igvm: true, overcommit: false, transient_gs: true, ..base },
        Row { name: "vbs-igvmpath-emptyvmgs-fwparams", why: "the UEFI shape plus FirmwareFile.Parameters, to vary the other axis", isolation: Some("VirtualizationBasedSecurity"), uefi: true, use_igvm: true, use_empty_vmgs: true, overcommit: false, fw: Some("OPENHCL_BOOT_LOG=com3"), ..base },
        // IT STARTS. `FirmwareFile.Parameters` was the missing element: without a FirmwareFile
        // block the worker has no firmware element to attach the IGVM to and start returns
        // 0x80070490, and with one the isolated partition runs our own paravisor image in 961 ms.
        // What it did NOT do is say anything - the document models COM1 and COM2 only (more makes
        // it invalid, 0x8037010d), so a boot log addressed to com3 went nowhere. These rows move
        // it onto a port that exists, which is what turns "it started" into "it is our image".
        Row { name: "vbs-igvm-boot-com2", why: "the shape that starts, with the paravisor's boot log on COM2 where this document actually has a port", isolation: Some("VirtualizationBasedSecurity"), uefi: true, use_igvm: true, use_empty_vmgs: true, overcommit: false, fw: Some("OPENHCL_BOOT_LOG=com2"), ..base },
        Row { name: "vbs-igvm-boot-com1", why: "... and on COM1, in case the paravisor numbers its ports from the guest's side", isolation: Some("VirtualizationBasedSecurity"), uefi: true, use_igvm: true, use_empty_vmgs: true, overcommit: false, fw: Some("OPENHCL_BOOT_LOG=com1"), ..base },
        // NO CHIPSET. Every start so far ends the same way: HcsStartComputeSystem returns
        // success and then vmwp.exe faults 0xc0000005 inside vmchipset.dll at offset 0x6e31c -
        // eleven times, one fault bucket, the in-box paravisor included. So the partition never
        // actually runs, and the module that crashes is the one describing a chipset this
        // partition should not need: an isolated partition's firmware comes from its IGVM.
        Row { name: "vbs-igvm-nochipset", why: "VirtualizationBasedSecurity + IgvmFilePath + empty VMGS and NO Chipset node at all: the IGVM is the firmware, and vmchipset.dll is what faults", isolation: Some("VirtualizationBasedSecurity"), no_chipset: true, use_igvm: true, use_empty_vmgs: true, overcommit: false, ..base },
        Row { name: "vbs-nochipset-emptyvmgs", why: "the same without our IGVM: does the in-box paravisor survive a start with no chipset described?", isolation: Some("VirtualizationBasedSecurity"), no_chipset: true, use_empty_vmgs: true, overcommit: false, ..base },
        Row { name: "vbs-emptyvmgs-tpm", why: "... plus EnableTpm", isolation: Some("VirtualizationBasedSecurity"), uefi: true, use_empty_vmgs: true, overcommit: false, tpm: true, ..base },
        Row { name: "gso-emptyvmgs", why: "GuestStateOnly + the empty VMGS", isolation: Some("GuestStateOnly"), uefi: true, use_empty_vmgs: true, overcommit: false, ..base },
        Row { name: "vbs-vmgs", why: "VirtualizationBasedSecurity + a VMGS carrying an IGVM in file id 8: 'Loading IGVM file from VMGS file'", isolation: Some("VirtualizationBasedSecurity"), uefi: true, use_vmgs: true, overcommit: false, ..base },
        Row { name: "gso-vmgs", why: "GuestStateOnly + the same VMGS", isolation: Some("GuestStateOnly"), uefi: true, use_vmgs: true, overcommit: false, ..base },
        Row { name: "vbs-uefi-fwparams", why: "VirtualizationBasedSecurity + FirmwareFile.Parameters (the paravisor command line, OPENHCL_BOOT_LOG=com3)", isolation: Some("VirtualizationBasedSecurity"), uefi: true, overcommit: false, transient_gs: true, fw: Some("OPENHCL_BOOT_LOG=com3"), ..base },
        Row { name: "snp-emulation", why: "SecureNestedPagingEmulation: what the emulated confidential mode says on a Ryzen", isolation: Some("SecureNestedPagingEmulation"), uefi: true, overcommit: false, transient_gs: true, ..base },
    ]
}

fn read_pipe_for(pipe: &str, secs: u64) -> String {
    let deadline = Instant::now() + Duration::from_secs(secs);
    let mut f = None;
    while Instant::now() < deadline {
        match std::fs::OpenOptions::new().read(true).write(true).open(pipe) {
            Ok(h) => {
                f = Some(h);
                break;
            }
            Err(_) => std::thread::sleep(Duration::from_millis(100)),
        }
    }
    let Some(mut f) = f else { return String::from("<pipe never opened>") };
    let mut out = Vec::new();
    let mut buf = [0u8; 4096];
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let stop2 = stop.clone();
    std::thread::spawn(move || {
        while !stop2.load(std::sync::atomic::Ordering::SeqCst) {
            match f.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(b) => out.extend_from_slice(&b),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(_) => break,
        }
    }
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
    String::from_utf8_lossy(&out).into_owned()
}

pub fn run(o: &Opts) -> i32 {
    let out = PathBuf::from(o.get("out").unwrap_or("out"));
    let _ = std::fs::create_dir_all(&out);
    let kernel = o.need("kernel");
    let initrd = o.need("initrd");
    let igvm = o.get("igvm").map(|s| s.to_string());
    let vmgs = o.get("vmgs").map(|s| s.to_string());
    let empty_vmgs = o.get("vmgs-empty").map(|s| s.to_string());
    let secs = o.num("seconds", 20);
    let only = o.get("only").map(|s| s.to_string());
    let mut results = Vec::new();
    for (i, r) in rows().iter().enumerate() {
        // `--only` takes a COMMA-SEPARATED list, not one name. One approved run of the host-wide
        // setting should be able to answer more than one shape: the alternative is applying and
        // restoring it once per row, which is more exposure for less evidence.
        if let Some(n) = &only {
            if !n.split(',').map(str::trim).any(|want| want == r.name) {
                continue;
            }
        }
        if r.use_igvm && igvm.is_none() {
            results.push(json!({"name": r.name, "why": r.why, "skipped": "no --igvm given"}));
            continue;
        }
        if r.use_vmgs && vmgs.is_none() {
            results.push(json!({"name": r.name, "why": r.why, "skipped": "no --vmgs given"}));
            continue;
        }
        if r.use_empty_vmgs && empty_vmgs.is_none() {
            results.push(json!({"name": r.name, "why": r.why, "skipped": "no --vmgs-empty given"}));
            continue;
        }
        let vmgs_for_row = if r.use_vmgs { vmgs.as_deref() } else if r.use_empty_vmgs { empty_vmgs.as_deref() } else { None };
        let pipe = format!(r"\\.\pipe\vbslike-iso-{}-{}-com1", std::process::id(), i);
        let cmdline = "console=ttyS0 rdinit=/init loglevel=3 report_host=9001";
        let base = DomainSpec { kernel: &kernel, initrd: &initrd, cmdline, mem_mib: o.num("mem", 1024), cpus: o.num("cpus", 2), console_pipe: &pipe, hvsock_sddl: crate::launcher::SDDL_ADMIN_SYSTEM };
        let doc = isolated_document(&IsoSpec { base: &base, isolation: r.isolation, igvm_path: if r.use_igvm { igvm.as_deref() } else { None }, hcl_enabled: r.hcl, vmgs_path: vmgs_for_row, no_chipset: r.no_chipset, uefi: r.uefi, firmware_params: r.fw, extra_com_ports: 1, enable_tpm: r.tpm, overcommit: r.overcommit, transient_guest_state: r.transient_gs });
        let _ = std::fs::write(out.join(format!("isoprobe-{}.hcs.json", r.name)), &doc);
        println!("=== {} : {}", r.name, r.why);
        let id = format!("vbslike-iso-{}-{}", std::process::id(), i);
        let t0 = Instant::now();
        let mut row = json!({"name": r.name, "why": r.why, "document": out.join(format!("isoprobe-{}.hcs.json", r.name)).display().to_string()});
        let part = match Partition::create(&id, &doc) {
            Ok(p) => p,
            Err(e) => {
                println!("  create: {e}");
                row["create"] = json!({"ok": false, "error": e.to_string(), "hr": format!("0x{:08x}", e.hr as u32), "detail": e.detail});
                results.push(row);
                continue;
            }
        };
        row["create"] = json!({"ok": true, "ms": t0.elapsed().as_secs_f64() * 1e3});
        let props = part.properties("").unwrap_or_else(|e| format!("error: {e}"));
        row["propertiesBeforeStart"] = serde_json::from_str::<Value>(&props).unwrap_or(json!(props));
        // console readers on all four COM ports, started before the partition runs
        let pipes: Vec<String> = (0..2).map(|k| if k == 0 { pipe.clone() } else { pipe.replace("-com1", &format!("-com{}", k + 1)) }).collect();
        let handles: Vec<_> = pipes.iter().cloned().map(|p| std::thread::spawn(move || read_pipe_for(&p, secs + 2))).collect();
        let t1 = Instant::now();
        match part.start() {
            Ok(_) => {
                println!("  start: ok ({:.0} ms)", t1.elapsed().as_secs_f64() * 1e3);
                row["start"] = json!({"ok": true, "ms": t1.elapsed().as_secs_f64() * 1e3});
                std::thread::sleep(Duration::from_secs(secs));
                let props2 = part.properties("").unwrap_or_else(|e| format!("error: {e}"));
                row["propertiesRunning"] = serde_json::from_str::<Value>(&props2).unwrap_or(json!(props2));
                let stats = part.properties(r#"{"PropertyTypes":["Memory","Statistics"]}"#).unwrap_or_else(|e| format!("error: {e}"));
                row["statistics"] = serde_json::from_str::<Value>(&stats).unwrap_or(json!(stats));
                let exit = part.wait_exit(0).map(|d| json!({"exited": true, "how": d})).unwrap_or_else(|e| json!({"exited": false, "wait": e.to_string()}));
                row["exitBeforeTerminate"] = exit;
                match part.terminate() {
                    Ok(d) => row["terminate"] = json!({"ok": true, "detail": d}),
                    Err(e) => row["terminate"] = json!({"ok": false, "error": e.to_string()}),
                }
                let _ = part.wait_exit(15_000);
            }
            Err(e) => {
                println!("  start: {e}");
                row["start"] = json!({"ok": false, "error": e.to_string(), "hr": format!("0x{:08x}", e.hr as u32), "detail": e.detail});
                let _ = part.terminate();
            }
        }
        let mut consoles = serde_json::Map::new();
        for (k, h) in handles.into_iter().enumerate() {
            let text = h.join().unwrap_or_default();
            let _ = std::fs::write(out.join(format!("isoprobe-{}-com{}.txt", r.name, k + 1)), &text);
            consoles.insert(format!("com{}", k + 1), json!({"bytes": text.len(), "head": text.chars().take(600).collect::<String>()}));
        }
        row["consoles"] = Value::Object(consoles);
        println!("  consoles: {}", (1..=2).map(|k| format!("com{k}={}B", row["consoles"][format!("com{k}")]["bytes"])).collect::<Vec<_>>().join(" "));
        results.push(row);
    }
    let v = json!({"probe": "isoprobe", "kernel": kernel, "initrd": initrd, "igvm": igvm, "vmgs": vmgs, "vmgsEmpty": empty_vmgs, "rows": results});
    write_json(&out.join("isoprobe.json"), &v);
    println!("SUMMARY");
    for r in v["rows"].as_array().unwrap() {
        let c = &r["create"];
        let st = &r["start"];
        let outcome = if r.get("skipped").is_some() { format!("skipped: {}", r["skipped"]) } else if c["ok"] == json!(true) {
            if st["ok"] == json!(true) { format!("create ok, start ok, com1 {}B com2 {}B, exit {}", r["consoles"]["com1"]["bytes"], r["consoles"]["com2"]["bytes"], r["exitBeforeTerminate"]["how"]) } else { format!("create ok, start FAILED {} {}", st["hr"], st["detail"]) }
        } else { format!("create FAILED {} {}", c["hr"], c["detail"]) };
        println!("  {:<24} {}", r["name"].as_str().unwrap_or("?"), outcome);
    }
    0
}


#[cfg(test)]
mod tests {
    use super::*;

    /// Every row the matrix can send is a document HCS can at least parse as JSON, and its name says
    /// what it asks for: an isolated row carries the isolation type it is named after, a plain row
    /// carries none. A row that silently sent the wrong document would make the evidence lie.
    #[test]
    fn every_probe_row_generates_a_parseable_document_that_matches_its_name() {
        let pipe = r"\\.\pipe\t-com1";
        let base = DomainSpec { kernel: "k", initrd: "i", cmdline: "c", mem_mib: 256, cpus: 1, console_pipe: pipe, hvsock_sddl: "D:P" };
        for r in rows() {
            let doc = isolated_document(&IsoSpec { base: &base, isolation: r.isolation, igvm_path: if r.use_igvm { Some("igvm") } else { None }, hcl_enabled: r.hcl, vmgs_path: if r.use_vmgs || r.use_empty_vmgs { Some("vmgs") } else { None }, no_chipset: r.no_chipset, uefi: r.uefi, firmware_params: r.fw, extra_com_ports: 1, enable_tpm: r.tpm, overcommit: r.overcommit, transient_guest_state: r.transient_gs });
            let v: serde_json::Value = serde_json::from_str(&doc).unwrap_or_else(|e| panic!("{}: {e}", r.name));
            let vm = &v["VirtualMachine"];
            match r.isolation {
                Some(t) => assert_eq!(vm["SecuritySettings"]["Isolation"]["IsolationType"], t, "{}", r.name),
                None => assert!(vm.get("SecuritySettings").is_none(), "{}", r.name),
            }
            assert_eq!(vm["Chipset"].get("Uefi").is_some(), r.uefi, "{}", r.name);
            assert_eq!(vm["ComputeTopology"]["Memory"]["AllowOvercommit"], r.overcommit, "{}", r.name);
            assert_eq!(vm.get("GuestState").is_some(), r.use_vmgs || r.use_empty_vmgs || r.transient_gs, "{}", r.name);
        }
        let names: std::collections::HashSet<&str> = rows().iter().map(|r| r.name).collect();
        assert_eq!(names.len(), rows().len(), "row names are unique");
    }
}
