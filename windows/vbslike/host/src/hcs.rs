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

/// The document for one app domain: a Linux kernel direct-booted with our initramfs, one hv_sock
/// device, a serial console on a named pipe, no disks, no network adapter, no GPU, no shared folders.
/// `ShouldTerminateOnLastHandleClosed` means the domain cannot outlive the monitor: if this process
/// dies, every domain it created is torn down by the service (fail closed).
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
    format!(
        r#"{{
  "SchemaVersion": {{ "Major": 2, "Minor": 1 }},
  "Owner": "vbslike",
  "ShouldTerminateOnLastHandleClosed": true,
  "VirtualMachine": {{
    "StopOnReset": true,
    "Chipset": {{
      "LinuxKernelDirect": {{
        "KernelFilePath": {kernel},
        "InitRdPath": {initrd},
        "KernelCmdLine": {cmdline}
      }}
    }},
    "ComputeTopology": {{
      "Memory": {{ "SizeInMB": {mem}, "AllowOvercommit": true }},
      "Processor": {{ "Count": {cpus} }}
    }},
    "Devices": {{
      "ComPorts": {{ "0": {{ "NamedPipe": {pipe} }} }},
      "HvSocket": {{
        "HvSocketConfig": {{
          "DefaultBindSecurityDescriptor": {sddl},
          "DefaultConnectSecurityDescriptor": {sddl},
          "ServiceTable": {{}}
        }}
      }}
    }}
  }}
}}"#,
        kernel = crate::util::json_str(s.kernel),
        initrd = crate::util::json_str(s.initrd),
        cmdline = crate::util::json_str(s.cmdline),
        mem = s.mem_mib,
        cpus = s.cpus,
        pipe = crate::util::json_str(s.console_pipe),
        sddl = crate::util::json_str(s.hvsock_sddl),
    )
}
