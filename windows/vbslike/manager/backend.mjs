/* ============================================================
   The launch interface, and the Hyper-V backend behind it.

   Everything above this file - the /vms contract, derivation, AppID, policy, the refusals - is
   finished and testable without a partition ever starting. This file is the seam where that stops
   being true, and it is deliberately the ONLY place that knows a partition is not achievable yet.

   WHY IT CANNOT START ONE, as of 2026-09-24, established rather than assumed:

     Microsoft's own supported way to give a VM a custom IGVM is WMI, not HCS. Their script
     openhcl/Set-OpenHCL-HyperV-VM.ps1 uses namespace root\virtualization\v2: it reads the VM's
     Msvm_VirtualSystemSettingData, sets GuestFeatureSet = 0x00000201 and FirmwareFile = <path>,
     and applies it through Msvm_VirtualSystemManagementService.ModifySystemSettings. It also
     requires a VM object of version >= 12.0 from the Hyper-V PowerShell module.

     This host has none of that. Every Hyper-V optional feature is Disabled, only
     VirtualMachinePlatform is Enabled, the vmms service is not installed, Get-VM does not exist and
     root\virtualization\v2 answers "Invalid namespace". HCS is present (vmcompute) and accepts
     SecuritySettings.Isolation.IgvmFilePath, and the worker then logs "Loading IGVM file from
     default location" for every partition. Acceptance is not indifference: an invented key in the
     same object is refused as an invalid document, so this schema RECOGNISES IgvmFilePath and the
     worker does not act on it here. Our image has never been loaded.

   So `start` fails closed with that reason rather than pretending. Nothing here fabricates an
   attestation, and a domain that never ran carries none.
   ============================================================ */

export const BACKEND = "hyperv-partition-per-app";

/** What this backend can honour. Every one of these is false, and the claim gate reads them. */
export const SUPPORTS = Object.freeze({
  gpu: false, secrets: false, egress: false, config: false, ports: false, configCid: false,
});

export const PREREQUISITES = Object.freeze({
  supportedPath: "WMI root\\virtualization\\v2: Msvm_VirtualSystemSettingData.FirmwareFile + GuestFeatureSet=0x201, applied via Msvm_VirtualSystemManagementService.ModifySystemSettings (microsoft/openvmm openhcl/Set-OpenHCL-HyperV-VM.ps1)",
  needs: ["Microsoft-Hyper-V-Hypervisor", "Microsoft-Hyper-V-Services", "Microsoft-Hyper-V-Management-PowerShell"],
  presentHere: ["VirtualMachinePlatform"],
  absentHere: ["vmms service", "root\\virtualization\\v2", "Get-VM"],
  note: "enabling those features is a host change requiring a reboot and is not this component's to make",
});

export class HyperVPartitionBackend {
  constructor({ launch = null } = {}) {
    // `launch` is injected so a test can drive the lifecycle without a host; production passes none
    // and therefore cannot start a domain at all, which is the honest state of this backend today.
    this.launch = launch;
  }
  get backend() { return BACKEND; }
  get supports() { return SUPPORTS; }
  /**
   * Start a domain for an already-derived mapping. Resolves to { pid, endpoint } when a partition
   * really runs; throws otherwise. It never returns a partial success.
   */
  async start(mapping) {
    if (!this.launch) {
      const e = new Error(
        "this host cannot load a custom IGVM: the supported path is WMI (Msvm_VirtualSystemSettingData.FirmwareFile), "
        + "which needs the Hyper-V role; this box runs HCS on VirtualMachinePlatform alone, where "
        + "SecuritySettings.Isolation.IgvmFilePath is a recognised field the worker does not act on (it logs "
        + "\"Loading IGVM file from default location\"). No partition has run our image.");
      e.code = "backend_cannot_start";
      e.prerequisites = PREREQUISITES;
      throw e;
    }
    return await this.launch(mapping);
  }
  async stop(handle) { if (this.launch && handle && handle.stop) await handle.stop(); }
}
