//! What this host exposes, measured rather than assumed. Each line is a public API called with its
//! documented arguments and the exact HRESULT recorded, so the boundary between "available without
//! changing the machine" and "needs a feature or a registry value" is evidence, not inference.
use crate::util::{hr_text, write_json, Opts};
use serde_json::json;
use std::path::Path;
use windows_sys::Win32::System::Hypervisor::*;

fn whp() -> serde_json::Value {
    unsafe {
        let mut present: u32 = 0;
        let mut written: u32 = 0;
        let hr = WHvGetCapability(WHvCapabilityCodeHypervisorPresent, &mut present as *mut _ as *mut _, 4, &mut written);
        let mut features: u64 = 0;
        let hr_f = WHvGetCapability(WHvCapabilityCodeFeatures, &mut features as *mut _ as *mut _, 8, &mut written);
        let mut part: WHV_PARTITION_HANDLE = 0;
        let hr_p = WHvCreatePartition(&mut part);
        if hr_p >= 0 && part != 0 {
            WHvDeletePartition(part);
        }
        json!({
            "WHvGetCapability(HypervisorPresent)": { "hr": hr_text(hr), "present": present },
            "WHvGetCapability(Features)": { "hr": hr_text(hr_f), "features": format!("0x{features:x}") },
            "WHvCreatePartition": { "hr": hr_text(hr_p), "ok": hr_p >= 0 },
            "note": "Windows Hypervisor Platform is a separate optional feature; a refusal here is the feature being off, not the hypervisor being absent"
        })
    }
}

fn hcs() -> serde_json::Value {
    let props = crate::hcs::service_properties(r#"{"PropertyTypes":["Basic"]}"#);
    let enumq = crate::hcs::enumerate(r#"{}"#);
    json!({
        "HcsGetServiceProperties": match &props { Ok(s) => json!({"ok": true, "result": serde_json::from_str::<serde_json::Value>(s).unwrap_or(json!(s))}), Err(e) => json!({"ok": false, "error": e.to_string()}) },
        "HcsEnumerateComputeSystems": match &enumq { Ok(s) => json!({"ok": true, "result": serde_json::from_str::<serde_json::Value>(s).unwrap_or(json!(s))}), Err(e) => json!({"ok": false, "error": e.to_string()}) },
    })
}

pub fn run(o: &Opts) -> i32 {
    crate::hvsock::wsa_init();
    let v = json!({
        "probe": "vbslike-host probe",
        "whp": whp(),
        "hcs": hcs(),
    });
    println!("{}", serde_json::to_string_pretty(&v).unwrap());
    if let Some(p) = o.get("out") {
        write_json(Path::new(p), &v);
    }
    0
}
