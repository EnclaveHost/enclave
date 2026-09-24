//! The Host Compute Service: the public, in-box way to create a Hyper-V child partition on a client
//! Windows that has Virtual Machine Platform and nothing else (the WSL2 path). computecore.dll,
//! through windows-sys. Every call is synchronous here: an operation is created, the call issued, and
//! the result waited for, because the control plane wants to know the outcome before it goes on.
//!
//! The partition boundary this gives is the hypervisor's own: a separate address space under the
//! hypervisor's second-level page tables, the same construct VBS uses to keep VTL1 from VTL0. What it
//! does NOT give on this hardware is exclusion of the root partition (no SNP/TDX on a Ryzen), so the
//! host stays trusted. README.md carries that statement; this file only builds partitions.
use crate::util::{hr_text, wide};
use std::ptr::null_mut;
use windows_sys::core::PWSTR;
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::System::HostComputeSystem::*;

pub struct Partition {
    pub id: String,
    handle: HCS_SYSTEM,
}
unsafe impl Send for Partition {}
unsafe impl Sync for Partition {}

#[derive(Debug)]
pub struct HcsError {
    pub step: &'static str,
    pub hr: i32,
    pub detail: String,
}
impl std::fmt::Display for HcsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} failed: {} {}", self.step, hr_text(self.hr), self.detail.trim())
    }
}

fn take_result(doc: PWSTR) -> String {
    if doc.is_null() {
        return String::new();
    }
    unsafe {
        let mut n = 0usize;
        while *doc.add(n) != 0 {
            n += 1;
        }
        let s = String::from_utf16_lossy(std::slice::from_raw_parts(doc, n));
        LocalFree(doc as *mut _);
        s
    }
}

/// Run one HCS call to completion: create the operation, issue, wait, close. `timeout_ms` bounds
/// the wait; a timeout is an error like any other.
fn run(step: &'static str, timeout_ms: u32, f: impl FnOnce(HCS_OPERATION) -> i32) -> Result<String, HcsError> {
    unsafe {
        let op = HcsCreateOperation(std::ptr::null(), None);
        if op.is_null() {
            return Err(HcsError { step, hr: -1, detail: "HcsCreateOperation returned null".into() });
        }
        let hr = f(op);
        if hr < 0 {
            let mut doc: PWSTR = null_mut();
            let _ = HcsGetOperationResult(op, &mut doc);
            let detail = take_result(doc);
            HcsCloseOperation(op);
            return Err(HcsError { step, hr, detail });
        }
        let mut doc: PWSTR = null_mut();
        let hr = HcsWaitForOperationResult(op, timeout_ms, &mut doc);
        let detail = take_result(doc);
        HcsCloseOperation(op);
        if hr < 0 {
            return Err(HcsError { step, hr, detail });
        }
        Ok(detail)
    }
}

/// What this host's HCS reports about itself and about running compute systems. Read-only.
pub fn enumerate(query: &str) -> Result<String, HcsError> {
    let q = wide(query);
    run("HcsEnumerateComputeSystems", 15_000, |op| unsafe { HcsEnumerateComputeSystems(q.as_ptr(), op) })
}

pub fn service_properties(query: &str) -> Result<String, HcsError> {
    unsafe {
        let q = wide(query);
        let mut doc: PWSTR = null_mut();
        let hr = HcsGetServiceProperties(q.as_ptr(), &mut doc);
        let s = take_result(doc);
        if hr < 0 {
            return Err(HcsError { step: "HcsGetServiceProperties", hr, detail: s });
        }
        Ok(s)
    }
}

impl Partition {
    /// Open an EXISTING compute system by id. Used only by `reap`, which opens exactly the ids it was
    /// told to and terminates those; nothing here searches, and an id that does not exist is an error
    /// rather than a no-op.
    pub fn open(id: &str) -> Result<Partition, HcsError> {
        let wid = wide(id);
        let mut handle: HCS_SYSTEM = null_mut();
        let hr = unsafe { HcsOpenComputeSystem(wid.as_ptr(), 0, &mut handle) };
        if hr < 0 || handle.is_null() {
            return Err(HcsError { step: "HcsOpenComputeSystem", hr, detail: id.to_string() });
        }
        Ok(Partition { id: id.to_string(), handle })
    }

    /// Create the partition from a schema-2.1 document. The compute system exists after this but is
    /// not running; nothing inside it has executed.
    pub fn create(id: &str, document: &str) -> Result<Partition, HcsError> {
        let wid = wide(id);
        let wdoc = wide(document);
        let mut handle: HCS_SYSTEM = null_mut();
        run("HcsCreateComputeSystem", 60_000, |op| unsafe {
            HcsCreateComputeSystem(wid.as_ptr(), wdoc.as_ptr(), op, std::ptr::null(), &mut handle)
        })?;
        if handle.is_null() {
            return Err(HcsError { step: "HcsCreateComputeSystem", hr: -1, detail: "null handle".into() });
        }
        Ok(Partition { id: id.to_string(), handle })
    }

    pub fn start(&self) -> Result<String, HcsError> {
        run("HcsStartComputeSystem", 60_000, |op| unsafe { HcsStartComputeSystem(self.handle, op, std::ptr::null()) })
    }

    pub fn terminate(&self) -> Result<String, HcsError> {
        run("HcsTerminateComputeSystem", 30_000, |op| unsafe { HcsTerminateComputeSystem(self.handle, op, std::ptr::null()) })
    }

    pub fn properties(&self, query: &str) -> Result<String, HcsError> {
        let q = wide(query);
        run("HcsGetComputeSystemProperties", 15_000, |op| unsafe { HcsGetComputeSystemProperties(self.handle, op, q.as_ptr()) })
    }

    /// Block until the partition has exited (however it exited). The result document says how.
    pub fn wait_exit(&self, timeout_ms: u32) -> Result<String, HcsError> {
        unsafe {
            let mut doc: PWSTR = null_mut();
            let hr = HcsWaitForComputeSystemExit(self.handle, timeout_ms, &mut doc);
            let s = take_result(doc);
            if hr < 0 {
                return Err(HcsError { step: "HcsWaitForComputeSystemExit", hr, detail: s });
            }
            Ok(s)
        }
    }
}

impl Drop for Partition {
    fn drop(&mut self) {
        unsafe {
            if !self.handle.is_null() {
                HcsCloseComputeSystem(self.handle);
            }
        }
    }
}

/// Every knob a partition document can take. `domain_document` is the phase-1 shape; `isolated_document`
/// adds the isolation settings retail HCS understands (enum strings read out of vmcompute.exe 10.0.26100:
/// Normal, GuestStateOnly, VirtualizationBasedSecurity, SecureNestedPaging, SecureNestedPagingEmulation,
/// TrustDomain, TrustDomainEmulation; IsolationSettings fields IsolationType, DebugHost, DebugPort,
/// LaunchData, IgvmFilePath, HclEnabled; GuestStateFileType FileMode | BlockStorage).
pub struct DomainSpec<'a> {
    pub kernel: &'a str,
    pub initrd: &'a str,
    pub cmdline: &'a str,
    pub mem_mib: u64,
    pub cpus: u64,
    pub console_pipe: &'a str,
    /// SDDL for host processes binding/connecting hv_sock services of THIS partition without a
    /// registry-listed service; defaults to SYSTEM and Administrators.
    pub hvsock_sddl: &'a str,
}

pub fn domain_document(s: &DomainSpec) -> String {
    isolated_document(&IsoSpec { base: s, isolation: None, igvm_path: None, hcl_enabled: None, vmgs_path: None, no_chipset: false, uefi: false, firmware_params: None, extra_com_ports: 0, enable_tpm: false, overcommit: true, transient_guest_state: false })
}

/// The phase-2 document: the same partition, plus what an isolated (paravisor-backed) partition
/// needs. Nothing here changes host state; a refused document is an answer, and `isoprobe` records it.
pub struct IsoSpec<'a> {
    pub base: &'a DomainSpec<'a>,
    pub isolation: Option<&'a str>,     // SecuritySettings.Isolation.IsolationType
    pub igvm_path: Option<&'a str>,     // SecuritySettings.Isolation.IgvmFilePath ("custom location": registry-gated)
    pub hcl_enabled: Option<bool>,      // SecuritySettings.Isolation.HclEnabled
    pub vmgs_path: Option<&'a str>,     // GuestState.GuestStateFilePath (FileMode, transient): an IGVM in file id 8 is "from VMGS file"
    pub no_chipset: bool,               // omit Chipset entirely: the IGVM *is* the firmware, and vmchipset.dll is what faults
    pub uefi: bool,                     // Chipset.Uefi instead of LinuxKernelDirect
    pub firmware_params: Option<&'a str>, // Chipset.FirmwareFile.Parameters (the paravisor command line), base64 of UTF-8
    pub extra_com_ports: u32,           // ComPorts 1..=n on sibling pipes (<pipe>-com2 ...); HCS knows COM1 and COM2 only
    pub enable_tpm: bool,
    pub overcommit: bool,               // ComputeTopology.Memory.AllowOvercommit (an isolated partition's memory is pinned)
    pub transient_guest_state: bool,    // GuestState declared with no file: transient in-memory state
}

pub fn isolated_document(x: &IsoSpec) -> String {
    let s = x.base;
    let js = crate::util::json_str;
    let chipset = if x.no_chipset {
        // NO CHIPSET AT ALL. Every start of an isolated partition with a guest-state file on this
        // host crashes vmwp.exe inside vmchipset.dll at the same offset, the in-box paravisor
        // included, so the chipset is the code that faults. An isolated partition's firmware comes
        // from the IGVM, which makes "describe a chipset as well" a thing worth not doing.
        String::new()
    } else if x.uefi {
        let fw = match x.firmware_params {
            Some(p) => format!(r#", "FirmwareFile": {{ "Parameters": {} }}"#, js(&base64_of(p))),
            None => String::new(),
        };
        format!(r#""Chipset": {{ "Uefi": {{ "Console": "ComPort1" }}{fw} }},"#)
    } else {
        let fw = match x.firmware_params {
            Some(p) => format!(r#", "FirmwareFile": {{ "Parameters": {} }}"#, js(&base64_of(p))),
            None => String::new(),
        };
        format!(
            r#""Chipset": {{ "LinuxKernelDirect": {{ "KernelFilePath": {}, "InitRdPath": {}, "KernelCmdLine": {} }}{fw} }},"#,
            js(s.kernel), js(s.initrd), js(s.cmdline)
        )
    };
    let mut com = format!(r#""0": {{ "NamedPipe": {} }}"#, js(s.console_pipe));
    // HCS models COM1 and COM2 only; asking for more makes the whole document invalid (measured:
    // 0x8037010d), so the request is clamped rather than passed through.
    for i in 1..=x.extra_com_ports.min(1) {
        let p = s.console_pipe.replace("-com1", &format!("-com{}", i + 1));
        com.push_str(&format!(r#", "{i}": {{ "NamedPipe": {} }}"#, js(&p)));
    }
    let security = match x.isolation {
        Some(t) => {
            let mut inner = format!(r#""IsolationType": {}"#, js(t));
            if let Some(p) = x.igvm_path {
                inner.push_str(&format!(r#", "IgvmFilePath": {}"#, js(p)));
            }
            if let Some(h) = x.hcl_enabled {
                inner.push_str(&format!(r#", "HclEnabled": {h}"#));
            }
            format!(r#", "SecuritySettings": {{ "EnableTpm": {}, "Isolation": {{ {inner} }} }}"#, x.enable_tpm)
        }
        None => String::new(),
    };
    let guest_state = match x.vmgs_path {
        Some(p) => format!(r#", "GuestState": {{ "GuestStateFilePath": {}, "GuestStateFileType": "FileMode", "ForceTransientState": true }}"#, js(p)),
        None if x.transient_guest_state => r#", "GuestState": { "GuestStateFileType": "FileMode", "ForceTransientState": true }"#.to_string(),
        None => String::new(),
    };
    format!(
        r#"{{
  "SchemaVersion": {{ "Major": 2, "Minor": 1 }},
  "Owner": "vbslike",
  "ShouldTerminateOnLastHandleClosed": true,
  "VirtualMachine": {{
    "StopOnReset": true,
    {chipset}
    "ComputeTopology": {{
      "Memory": {{ "SizeInMB": {mem}, "AllowOvercommit": {overcommit} }},
      "Processor": {{ "Count": {cpus} }}
    }},
    "Devices": {{
      "ComPorts": {{ {com} }},
      "HvSocket": {{
        "HvSocketConfig": {{
          "DefaultBindSecurityDescriptor": {sddl},
          "DefaultConnectSecurityDescriptor": {sddl},
          "ServiceTable": {{}}
        }}
      }}
    }}{security}{guest_state}
  }}
}}"#,
        mem = s.mem_mib,
        cpus = s.cpus,
        overcommit = x.overcommit,
        sddl = js(s.hvsock_sddl),
    )
}

fn base64_of(s: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(s.as_bytes())
}


#[cfg(test)]
mod tests {
    use super::*;

    fn base_spec<'a>(pipe: &'a str) -> DomainSpec<'a> {
        DomainSpec { kernel: r"C:\k\kernel", initrd: r"C:\k\mon.cpio.gz", cmdline: "console=ttyS0 report_host=9001", mem_mib: 512, cpus: 1, console_pipe: pipe, hvsock_sddl: "D:P(A;;FA;;;SY)(A;;FA;;;BA)" }
    }

    #[test]
    fn plain_document_is_the_phase1_shape() {
        let s = base_spec(r"\\.\pipe\t-com1");
        let v: serde_json::Value = serde_json::from_str(&domain_document(&s)).expect("valid JSON");
        let vm = &v["VirtualMachine"];
        assert!(vm.get("SecuritySettings").is_none(), "no isolation unless asked");
        assert!(vm.get("GuestState").is_none());
        assert_eq!(vm["Chipset"]["LinuxKernelDirect"]["KernelFilePath"], r"C:\k\kernel");
        assert!(vm["Chipset"].get("Uefi").is_none());
        assert_eq!(vm["Devices"]["ComPorts"].as_object().unwrap().len(), 1);
        assert_eq!(vm["ComputeTopology"]["Memory"]["AllowOvercommit"], true);
        assert_eq!(v["ShouldTerminateOnLastHandleClosed"], true, "a partition must not outlive the launcher");
    }

    #[test]
    fn isolated_document_carries_every_requested_knob() {
        let s = base_spec(r"\\.\pipe\t-com1");
        let doc = isolated_document(&IsoSpec { base: &s, isolation: Some("VirtualizationBasedSecurity"), igvm_path: Some(r"C:\f\ours.bin"), hcl_enabled: Some(true), vmgs_path: Some(r"C:\v\a.vmgs"), no_chipset: false, uefi: true, firmware_params: Some("OPENHCL_BOOT_LOG=com3"), extra_com_ports: 1, enable_tpm: true, overcommit: false, transient_guest_state: false });
        let v: serde_json::Value = serde_json::from_str(&doc).expect("valid JSON");
        let vm = &v["VirtualMachine"];
        assert_eq!(vm["SecuritySettings"]["Isolation"]["IsolationType"], "VirtualizationBasedSecurity");
        assert_eq!(vm["SecuritySettings"]["Isolation"]["IgvmFilePath"], r"C:\f\ours.bin");
        assert_eq!(vm["SecuritySettings"]["Isolation"]["HclEnabled"], true);
        assert_eq!(vm["SecuritySettings"]["EnableTpm"], true);
        assert_eq!(vm["GuestState"]["GuestStateFilePath"], r"C:\v\a.vmgs");
        assert_eq!(vm["GuestState"]["GuestStateFileType"], "FileMode");
        assert_eq!(vm["GuestState"]["ForceTransientState"], true);
        assert!(vm["Chipset"].get("LinuxKernelDirect").is_none());
        assert_eq!(vm["Chipset"]["Uefi"]["Console"], "ComPort1");
        // the paravisor command line travels as base64 of its UTF-8, the way a Go []byte marshals
        assert_eq!(vm["Chipset"]["FirmwareFile"]["Parameters"], "T1BFTkhDTF9CT09UX0xPRz1jb20z");
        assert_eq!(vm["ComputeTopology"]["Memory"]["AllowOvercommit"], false);
        let ports = vm["Devices"]["ComPorts"].as_object().unwrap();
        assert_eq!(ports.len(), 2);
        assert_eq!(ports["1"]["NamedPipe"], r"\\.\pipe\t-com2");
    }

    #[test]
    fn transient_guest_state_without_a_file_is_expressible_and_com_ports_are_clamped() {
        let s = base_spec(r"\\.\pipe\t-com1");
        let doc = isolated_document(&IsoSpec { base: &s, isolation: Some("GuestStateOnly"), igvm_path: None, hcl_enabled: None, vmgs_path: None, no_chipset: false, uefi: true, firmware_params: None, extra_com_ports: 3, enable_tpm: false, overcommit: false, transient_guest_state: true });
        let v: serde_json::Value = serde_json::from_str(&doc).expect("valid JSON");
        let vm = &v["VirtualMachine"];
        assert!(vm["GuestState"].get("GuestStateFilePath").is_none());
        assert_eq!(vm["GuestState"]["ForceTransientState"], true);
        assert!(vm["SecuritySettings"]["Isolation"].get("IgvmFilePath").is_none());
        assert!(vm["SecuritySettings"]["Isolation"].get("HclEnabled").is_none());
        assert_eq!(vm["Devices"]["ComPorts"].as_object().unwrap().len(), 2, "HCS knows COM1 and COM2 only");
    }

    #[test]
    fn hcs_error_reports_step_hresult_and_the_service_detail() {
        let e = HcsError { step: "HcsCreateComputeSystem", hr: 0x80070057u32 as i32, detail: r#"{"Error":-2147024809,"ErrorMessage":"The parameter is incorrect."}"#.into() };
        let text = e.to_string();
        assert!(text.starts_with("HcsCreateComputeSystem failed: 0x80070057"), "{text}");
        assert!(text.contains("The parameter is incorrect."), "the service's own words are kept");
        let e2 = HcsError { step: "HcsStartComputeSystem", hr: 0x80070032u32 as i32, detail: String::new() };
        assert_eq!(e2.to_string(), "HcsStartComputeSystem failed: 0x80070032 ");
    }
}
