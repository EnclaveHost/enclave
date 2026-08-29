# SNP / TDX on Windows 10/11 Home and Pro: the answer

Research conclusion, 2026-08-28. Supersedes the "Which Windows, exactly" matrix in
[ARCHITECTURE.md](ARCHITECTURE.md), which was written before any of the evidence
below was in hand. Read this one first.

The question was: can a seller run a hardware-attested SEV-SNP or TDX guest on
Windows **without Windows Server**? The answer is yes on Windows 11 (Pro *and*
Home, 24H2 or later), no on Windows 10, and the mechanism is the one Microsoft
itself uses in the OpenVMM project's own CI on bare-metal Windows hosts.

## The answer

| OS | SNP / TDX guest? | how | status |
|---|---|---|---|
| **Windows 11 Pro / Enterprise / Education, 24H2+ (26100.1586+)** | **yes** | in-box Hyper-V; flip `EnableHardwareIsolation`; load our IGVM through the WMI `FirmwareFile` property | the same path Microsoft's CI runs on bare-metal Windows SNP/TDX hosts; "development support", not production support |
| **Windows 11 Home, 24H2+** | **yes, same binaries** | stage the in-box Hyper-V packages with DISM, then identical to Pro; or drive HCS directly with only Virtual Machine Platform | the hypervisor, `vmwp.exe` and `winhvr.sys` are the same files as Pro; what Home lacks is only the management layer, and it is staged on disk |
| **Windows 10, any edition** | **no** | -- | `vmwp.exe` 19041 has no IGVM / SNP loader at all; out of support since 2025-10-14. The equivalent is the free in-place upgrade to Windows 11 |
| Windows Server 2025 | yes | same as Pro | no longer *required* for anything |

Hardware is unchanged by any of this: EPYC 7003 (Milan) or newer for SNP, Xeon
4th gen (Sapphire Rapids) or newer for TDX. No Ryzen, Threadripper, Core or
Core Ultra part implements either, and AMD is explicit that SEV "is not
available on 4004 and 4005 series AMD EPYC Server CPUs or AMD Ryzen CPUs" --
so the AM5-socket EPYCs a gamer could drop into their board do **not** qualify
either. A "gaming rig" seller still needs server silicon; what they no longer
need is a server *operating system*.

## What this corrects in ARCHITECTURE.md

Four things there were wrong or unproven and are now settled:

1. **`Set-OpenHCLFirmware` is not a Windows cmdlet.** It is a function in
   OpenVMM's `petri/src/vm/hyperv/hyperv.psm1`, imported by hand
   (`Import-Module ...\hyperv.psm1`). The guide's snippet hides that. What it
   does is two WMI writes on `Msvm_VirtualSystemSettingData`:

   ```powershell
   $vssd.GuestFeatureSet = 0x00000201   # "Enable OpenHCL by feature"
   $vssd.FirmwareFile    = $IgvmFile    # "Set the OpenHCL image file path"
   ```

   plus `FirmwareParameters` (UTF-8 bytes) for the OpenHCL command line. The
   probe was checking `Get-Command Set-OpenHCLFirmware`, which fails on every
   host that has not imported the module. Fixed in the probe.

2. **Custom IGVM + SNP/TDX isolation DOES compose.** ARCHITECTURE.md's open
   question (a) was whether the custom-IGVM procedure, documented only for
   `OpenHCL` and `TrustedLaunch`, also works with `SNP`/`TDX`. Petri's own VM
   builder answers it in code (`petri/src/vm/hyperv/powershell.rs`):

   ```rust
   guest_state_isolation_type: match firmware.isolation() {
       Some(IsolationType::Vbs) => Some(HyperVGuestStateIsolationType::Vbs),   // 1
       Some(IsolationType::Snp) => Some(HyperVGuestStateIsolationType::Snp),   // 2
       Some(IsolationType::Tdx) => Some(HyperVGuestStateIsolationType::Tdx),   // 3
       None if properties.is_openhcl => Some(HyperVGuestStateIsolationType::OpenHCL), // 16
   ```

   and `mod.rs` passes `firmware_file: igvm_file` (the `x64-cvm` OpenHCL IGVM,
   unsigned, loaded via `AllowFirmwareLoadFromFile`) into the same
   `New-CustomVM`. The tests `hyperv_openhcl_uefi_x64[snp]` and
   `hyperv_openhcl_uefi_x64[tdx]` in `vmm_tests/.../multiarch/tpm.rs` run this
   on CI runners labelled `self-hosted, Windows, X64, SNP, Baremetal` and
   `self-hosted, Windows, X64, TDX, GNR, Baremetal`. Not Azure, not Azure Local:
   Windows machines with the Hyper-V role.

3. **Windows 10 is out for a reason that is now binary-level, not just EOL.**
   See the evidence section.

4. **Home is not "maybe".** The platform pieces are demonstrably the same
   files, and full VMs are demonstrably created on Home through HCS by shipping
   products. Two routes are laid out below.

## The gate: `EnableHardwareIsolation`

This is the single host setting nobody had found. Microsoft's flowey host-prep
code for the OpenVMM test machines
(`flowey/flowey_lib_hvlite/src/install_vmm_tests_external_deps.rs`) is
explicit:

```rust
const HYPERV_TESTS_REQUIRED_FEATURES: [&str; 3] = [
    "Microsoft-Hyper-V",
    "Microsoft-Hyper-V-Management-PowerShell",
    "Microsoft-Hyper-V-Management-Clients",
];
const VIRT_REG_PATH: &str       = r#"HKLM\Software\Microsoft\Windows NT\CurrentVersion\Virtualization"#;
const HYPERVISOR_REG_PATH: &str = r#"HKLM\System\CurrentControlSet\Control\Hypervisor"#;
...
    .insert("AllowFirmwareLoadFromFile", ("REG_DWORD", "0x1", false));
    if hardware_isolation {
        reg_keys_to_set.entry(HYPERVISOR_REG_PATH)...
            .insert("EnableHardwareIsolation", ("REG_DWORD", "0x1", true));   // true = reboot required
    }
```

That is the whole host-side enablement Microsoft applies before running SNP and
TDX Hyper-V tests: three DISM features, two registry values, one reboot. Note
what is **absent**: no `IsolatedGuestVm` optional feature, no `IGVmAgent`
service, no `AszIgvmAgent` registry keys. Those belong to the Windows Server
vNext *Trusted Launch* preview (builds 29621/29641, July-August 2026) and to
Azure Local's guest-state-protection-key flow. They protect a VMGS with a key
from an Azure Stack agent; they are not what makes SNP work.

The hypervisor reads `EnableHardwareIsolation` at boot (hvinternals'
enumeration of `HKLM\SYSTEM\CurrentControlSet\Control\Hypervisor`: "0 = default,
1 = enable, 2 = force -- Enable hardware-isolation CPU features (Intel TDX / AMD
SEV-SNP container mode)"; alongside `EnableSevSnp`, "checked only on
AuthenticAMD"). After the reboot, the management service reports what it got:

```powershell
Get-VMHost | Select-Object GuestIsolationTypes, SnpStatus, TdxStatus
```

Petri relies on exactly these, with this comment: *"While GuestStateIsolationTypes
contains values for SNP and TDX, there are other factors that determine SNP/TDX
support than just hardware compatibility, hence we rely on SnpStatus and
TdxStatus for that information."* `SnpStatus -eq 1` is the host saying yes.
This is a no-side-effect check; the probe now runs it.

The same fact is visible from Azure Local's troubleshooting doc, where a node's
readiness is `HKLM:\SOFTWARE\Microsoft\AszIGVmAgent\ConfidentialVMHardwareCapability = 1`
and a failing node reports `"igvmStatus":"Disabled"` -- i.e. the hardware
capability is a host-level boolean, not a licence.

## Evidence that the platform is edition-agnostic

Collected 2026-08-28 by pulling the shipping binaries from Microsoft's symbol
server (via Winbindex) and reading their strings. Windows 11 24H2 ships **one
cumulative update for every edition**, so at a given LCU these files are
byte-identical on Home, Pro, Enterprise and Server 2025.

**`vmwp.exe` 10.0.26100.9278** (the VM worker process; present wherever
Virtual Machine Platform is enabled, which includes Home, because WSL2 runs in
it):

- the IGVM loader for isolated VMs: `IsolatedVm@HyperVGuestLoader` with
  `SnpVpContext`, `VbsVpContext`, `_IGVM_VHS_SNP_ID_BLOCK`, `_IGVM_VHS_CVM_POLICY`,
  `_IGVM_VHS_VBS_MEASUREMENT`, `IVmSnpServices`
- `Isolation settings are a required parameter for SNP or VBS isolated VMs`
- `Servicing is not supported for SNP, TDX or VBS isolated VMs. VM isolation: %u`
- `Loading IGVM file from VMGS file.` / `Loading IGVM file from default location.`
- `AllowFirmwareLoadFromFile`, `LoadClientHclFirmware`, `LoadHclFirmware`
- `OpenHCL IGVM files are not present by default in this build.` -- the
  default paravisor image (`vmfirmwarecvm.dll` / `vmfirmwarehcl.dll`) is not
  shipped on client, which is precisely why `FirmwareFile` exists: you bring
  your own, which is what we want anyway
- `max_hw_isolated_guests`, `hw_isolation`, `/configuration/settings/isolation`
- **no** `SLGetWindowsInformation*` import and no licensing or edition strings

**`vmwp.exe` 10.0.26100.1742** (24H2 GA): same loader, same strings. This was in
the release build, not added by a later update.

**`vmwp.exe` 10.0.22621.7517** (Windows 11 23H2): has `SnpVpContext`,
`_IGVM_VHS_SNP_ID_BLOCK`, `_IGVM_VHS_SNP_POLICY`, `max_hw_isolated_guests` -- the
SNP loader predates 24H2 -- but **not** `AllowFirmwareLoadFromFile` or
`LoadClientHclFirmware`. Custom-IGVM loading is what 24H2 added, which is why
the OpenVMM guide names 26100.1586 as the floor.

**`vmwp.exe` 10.0.19041.7663** (Windows 10 22H2): **zero** `IGVM` strings. Only
a prototype `hclloader.cpp` (`vmhcl.exe`, `The VM requested isolation [%x] but
HCL is not enabled [%x]`). No SNP contexts, no ID block, no measurement. Windows
10 never had the confidential-VM loader; no update adds it.

**`winhvr.sys` 10.0.26100.8972** (the Windows hypervisor interface driver,
loaded on every edition that runs VBS or WSL2): exports
`WinHvImportIsolatedPages`, `WinHvCompleteIsolatedImport`,
`WinHvIssueSnpPspGuestRequest`, `WinHvIssueNestedSnpPspRequests`. The SNP launch
primitives are in the kernel-mode layer that Home already loads.

**`vmms.exe` 10.0.26100.9278** (the management service; the part Home does not
enable by default): carries `GuestStateIsolationType`, `SecureNestedPaging`,
`HypervisorSnpStatus`, `HypervisorTdxStatus`, `FirmwareFile`, `GuestFeatureSet`,
`FirmwareParameters`, `GuestStateFile`, `GuestStateDataRoot`,
`ExtendedVirtualizationExtensions`, `MaxHwIsolatedGuests`,
`MemoryEncryptionPolicy`. Its **only** licensing check is
`microsoft-windows-virtualization-licensing-EnableHyperVReplica` (the sole
`SLGetWindowsInformationDWORD` consumer). Nothing gates isolation on edition.

**`vmcompute.dll` 10.0.26100.9168** (HCS client library, on Home via VMP): no
isolation strings (the document is parsed in `vmwp.exe`), no licensing strings.

**Windows Hypervisor Platform** (the API QEMU, VirtualBox and OpenVMM use on
Windows): the 951 symbols in `windows-sys`'s `Win32::System::Hypervisor`
(generated from Microsoft's Win32 metadata) contain nothing matching
Isolat|Sev|Snp|Tdx|Cvm|Confidential|Igvm, and OpenVMM's WHP backend says so in
code: `"WHP does not support {0:?} isolation"` for anything but emulated VBS.
That door is shut at the API, not merely in QEMU.

## Windows 11 Home: two routes

The edition gate is *servicing composition*, not a runtime check. Home's
edition manifest does not own the `Microsoft-Hyper-V` feature, so DISM reports
`0x800f080c "Feature name Microsoft-Hyper-V is unknown"` -- while the
`Microsoft-Hyper-V-*.mum` packages sit unstaged in
`%SystemRoot%\servicing\Packages`. No `SLGetWindowsInformation` gate exists in
`vmms`, `vmcompute` or `vmwp` (above).

### Route A -- stage the in-box packages (recommended for the first build)

```bat
dir /b %SystemRoot%\servicing\Packages\*Hyper*.mum > hyper-v.txt
for /f %%i in ('findstr /i . hyper-v.txt 2^>nul') do dism /online /norestart /add-package:"%SystemRoot%\servicing\Packages\%%i"
del hyper-v.txt
dism /online /enable-feature /featurename:Microsoft-Hyper-V -All /LimitAccess /ALL
```

Use the wider `*Hyper*.mum` glob, not `*Hyper-V*.mum`: on 24H2 the narrow
pattern produced a partial stack in which TPM/guest-state VMs would not start.
After this, `vmms.exe` and the PowerShell module are the build's own files --
identical to Pro -- and everything in the Pro recipe applies verbatim,
including `New-VM -GuestStateIsolationType SNP`.

Confirmed working on Home 25H2 by multiple first-hand reports (January-March
2026). Two operational facts the installer must own:

- **Feature updates (23H2 -> 24H2 style) remove it; monthly LCUs do not.** The
  daemon must detect the role vanishing and re-stage it, and the seller must be
  told that a feature update means a re-run, not a broken product.
- **Memory Integrity (Core Isolation) can hide the feature** until toggled off
  and rebooted, in some reports.

Microsoft's position is that the Hyper-V role "can't be installed on Windows 11
Home" and nothing about the recipe is supported. That is the same footing as
the whole OpenHCL-on-client story ("development support" only), so it adds no
*new* category of risk -- but it is a second unsupported layer, and ARCHITECTURE
was right to be wary. The mitigation is the same one already planned: pin the
build, probe on every start, fail closed.

### Route B -- Host Compute Service directly, no Hyper-V role at all

Home users enable **Virtual Machine Platform** (the WSL2 prerequisite;
Microsoft: "a subset of Hyper-V architecture ... available on all Desktop
SKUs"). That installs `vmcompute` and `vmwp.exe`. Shipping products then build
full VMs on Home by submitting a hand-written HCS document to
`computecore.dll`:

- **appsandbox**: "Works on Windows 11 Home or Pro, without Hyper-V ... creates
  and runs VMs through the Windows Host Compute System (HCS) and Host Compute
  Network (HCN) APIs" -- Windows and Linux guests, own disks, GPU-PV.
- **Claude Cowork**: `HcsCreateComputeSystem returned: hr=0x0` on "Windows 11
  Home 10.0.26200", VMP + HypervisorPlatform, no Hyper-V; the only failures in
  the issue tracker were malformed documents, not edition refusals.

And the HCS document already has the isolation knob, exercised in production by
hcsshim for confidential containers:

```json
"SecuritySettings": { "Isolation": {
    "IsolationType": "SecureNestedPaging",
    "LaunchData":    "<base64 32 bytes -> HOST_DATA>",
    "HclEnabled":    false } },
"GuestState": { "GuestStateFilePath": "...\\guest.vmgs", "GuestStateFileType": "FileMode" }
```

This is the route ARCHITECTURE.md already intended to take for the daemon
(hcsshim or P/Invoke to `vmcompute.dll`), so it costs nothing extra to keep.
What it lacks today is a demonstration that `IsolationType: SecureNestedPaging`
is honoured on a *client* `vmcompute` -- the same unknown as Pro, one layer
down. Prefer Route A until Route A has produced an attested guest; then try the
same VMGS through Route B, because Route B is the one that survives feature
updates.

## The recipe, Pro or staged-Home

Firmware first. Lenovo's August 2026 configuration guide for Microsoft CVMs
(LP2484) is the only published BIOS list for Hyper-V, and one line in it is
Hyper-V-specific:

| setting | value |
|---|---|
| SVM Mode | Enabled |
| SMEE | Enabled |
| SEV Control | Enabled |
| SEV-SNP Support | Enabled |
| SEV-ES ASID Space Limit | ASID Count + 1 |
| IOMMU | Enabled |
| **SNP Memory (RMP Table Coverage)** | **Disabled** -- "not applicable to Hyper-V as it allocates and manages its own RMP table instead of platform firmware" |

That last row is the one that will bite anyone who configured the board for
Linux/KVM first (metal0's `host-setup.sh` wants RMP coverage *on*). Same board,
opposite setting.

Then, elevated:

```powershell
# 1. features (Pro; on Home run the DISM staging first)
DISM /Online /NoRestart /Enable-Feature /All /FeatureName:Microsoft-Hyper-V
DISM /Online /NoRestart /Enable-Feature /All /FeatureName:Microsoft-Hyper-V-Management-PowerShell
DISM /Online /NoRestart /Enable-Feature /All /FeatureName:Microsoft-Hyper-V-Management-Clients

# 2. the two values Microsoft's own CI sets
reg add "HKLM\Software\Microsoft\Windows NT\CurrentVersion\Virtualization" /v AllowFirmwareLoadFromFile /t REG_DWORD /d 1 /f
reg add "HKLM\System\CurrentControlSet\Control\Hypervisor" /v EnableHardwareIsolation /t REG_DWORD /d 1 /f
Restart-Computer

# 3. did the hypervisor take it?
Get-VMHost | Select-Object GuestIsolationTypes, SnpStatus, TdxStatus     # want SnpStatus 1 (or TdxStatus 1)

# 4. the VM: isolation type from New-VM, firmware from WMI (what petri's Set-OpenHCLFirmware does)
$vm   = New-VM enclave -Generation 2 -GuestStateIsolationType SNP -MemoryStartupBytes 8GB -NoVHD
$vssd = Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_VirtualSystemSettingData |
        Where-Object ConfigurationID -eq $vm.Id
$vssd.GuestFeatureSet     = 0x201
$vssd.FirmwareFile        = 'C:\enclave\enclave-x64-cvm.bin'      # our IGVM, measurement computed offline
$vssd.FirmwareParameters  = [Text.Encoding]::UTF8.GetBytes('')     # OpenHCL cmdline if any
$vmms = Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_VirtualSystemManagementService
$ser  = [Microsoft.Management.Infrastructure.Serialization.CimSerializer]::Create()
$xml  = [Text.Encoding]::Unicode.GetString($ser.Serialize($vssd, [Microsoft.Management.Infrastructure.Serialization.InstanceSerializationOptions]::None))
$vmms | Invoke-CimMethod -MethodName ModifySystemSettings -Arguments @{ SystemSettings = $xml }
# petri also removes the synthetic mouse, keyboard and display for types 1,2,3
# (Msvm_VirtualSystemManagementService.RemoveResourceSettings); see hyperv.psm1 New-CustomVM
Start-VM $vm
```

(The probe's `Set-ProbeFirmware` is this block as a function; petri's own
`hyperv.psm1` + `utilities.psm1` can be imported instead, which is what the
OpenVMM guide's `Set-OpenHCLFirmware` line assumes.)

`New-VM -GuestStateIsolationType` is the documented cmdlet surface (Learn lists
`TrustedLaunch, VBS, SNP, TDX, Disabled` for the 26100 module); `FirmwareFile`
and `GuestFeatureSet` are the WMI properties petri writes; the numeric types are
`0 TrustedLaunch, 1 VBS, 2 SNP, 3 TDX, 16 OpenHCL` (`4 RME` exists in newer
schemas for Arm CCA; 18/19 are reserved).

Petri also removes the synthetic mouse, keyboard and display for isolated VMs
(`@(1,2,3) -contains $GuestStateIsolationType`) and sets
`Vtl2AddressSpaceConfigurationMode = 1`, `Vtl2AddressRangeSize = 1024`,
`Vtl2MmioAddressRangeSize = 512` when the paravisor needs more room. Copy those
too; they are the difference between "boots" and "management VTL triple-faults
before VTL0 starts", which is a failure mode OpenVMM's own SNP runners have hit
(`MSVM_START_VTL0_REQUEST_ERROR`, PR #3863).

## Our guest image, on this path

Unchanged from ARCHITECTURE.md's pipeline: build `metal/dist` exactly as today,
package it with `cargo xflowey build-igvm x64-cvm --custom-kernel ...` (one
IGVM carrying `snp`, `tdx` and `vbs` guest configs; the release manifest
already sets `secure_avic: enabled` and the SNP policy), compute the
measurement offline with `igvmmeasure`, hand the file to `FirmwareFile`.

Two things still to prove on hardware, in this order:

1. **That the retail 26100 hypervisor honours `EnableHardwareIsolation`.**
   Microsoft's SNP/TDX runners are Windows machines, but their build is not
   published; petri gates a *logging* feature on host build 27653+, which says
   its fleet runs newer-than-retail builds, not that isolation needs them. The
   retail `vmwp.exe`/`winhvr.sys` carry the code. `SnpStatus` after the reboot
   is the answer, and it costs nothing.
2. **Paravisor or not.** Everything Microsoft runs on this path is *OpenHCL as
   the IGVM* (paravisor at VMPL0, our Linux at VMPL2 behind vTOM). The
   `SNP_NO_HCL` / `HclEnabled: false` fully-enlightened shape remains
   demonstrated only by hcsshim's ACI configuration. Since OpenHCL is open
   source and built from a pinned commit, the paravisor-mode measurement is
   still reproducible -- it just includes OpenHCL -- so this is a preference,
   not a blocker, exactly as ARCHITECTURE.md concluded.

## Windows 10, and what to tell a Windows 10 user

Not fixable. The 19041 worker has no IGVM loader, no SNP contexts, no
measurement code; the isolation-type parameter does not exist in the
2016-2022 Hyper-V module; and the OS stopped receiving security updates on
14 October 2025. Shipping a money-handling seller node onto it would be
wrong even if the feature existed.

The equivalent for a Windows 10 machine is the free in-place upgrade to
Windows 11, which keeps files, apps and licence. A seller on EPYC/Xeon silicon
already meets Windows 11's hardware bar (TPM 2.0, UEFI, Secure Boot capable).
The installer should say exactly that, once, and stop.

## What was ruled out, and the filter that ruled it out

Every other door on Windows was checked against the same test as
[PCIE-TEE.md](PCIE-TEE.md): *does it encrypt memory with a key the machine's
owner cannot extract, and attest a measurement of our workload to a third
party?*

| candidate | verdict | why |
|---|---|---|
| QEMU / VirtualBox / VMware / OpenVMM on **WHPX** | no | WHP exposes no isolation capability at all (API enumerated above); OpenVMM refuses in code |
| **Nested** SNP: Linux L1 inside a Hyper-V VM launches the CVM | not today, worth one probe | Hyper-V *can* virtualise SNP into a child partition (virtualised `RMPUPDATE`/`PSMASH` MSRs, ACPI PSP) -- that is how AKS confidential containers work on Azure hosts, with mshv + Cloud Hypervisor as L1. The retail `vmms` carries the per-VM knobs (`ExtendedVirtualizationExtensions`, `MaxHwIsolatedGuests`), so the surface exists on client; whether the retail hypervisor backs it is unobserved. It would let `metal/`'s launcher run unmodified inside a Linux VM, but KVM's nested-SNP-host series is an unmerged 2023 RFC and the mshv L1VH + SNP series is August 2026 and still in review. SNP only; no nested-TDX-host mode exists |
| **VBS enclaves** / VTL1 | no | privilege isolation, DRAM in plaintext; already rejected in PCIE-TEE.md |
| **Linux root partition** on the Microsoft hypervisor (`/dev/mshv`) | no | that is Linux as the host OS with Windows demoted to a guest -- a different product |
| **Intel SGX** on client | no | Intel removed SGX from 11th-gen and later client cores; not a VM in any case |
| **Windows Server** | unnecessary | the code path is in the shared 26100 binaries |

## Probe changes

[probe/Test-EnclaveHost.ps1](probe/Test-EnclaveHost.ps1) now:

- reads `HKLM\System\CurrentControlSet\Control\Hypervisor\EnableHardwareIsolation`
  and says how to set it;
- reads `Get-VMHost` `SnpStatus` / `TdxStatus` / `GuestIsolationTypes` -- the
  no-side-effect readiness answer;
- enumerates the host's advertised isolation types from WMI
  (`Msvm_VirtualSystemSettingData` definitions under
  `Microsoft:Definition\VirtualSystem\GuestStateIsolationType\*`) so the answer
  does not depend on the PowerShell module's enum;
- on Home, lists the staged `*Hyper*.mum` packages so the installer knows Route
  A is available, and checks Virtual Machine Platform for Route B;
- checks the Windows 10 verdict against the binary evidence, not just the
  support date;
- with `-Attempt`, creates the SNP VM and then sets `FirmwareFile` /
  `GuestFeatureSet` through WMI directly (no `Set-OpenHCLFirmware` dependency),
  which is the combination question, asked the way petri asks it.

## Sources

- OpenVMM: `petri/src/vm/hyperv/{powershell.rs,hyperv.psm1,mod.rs}`,
  `petri/src/requirements.rs`,
  `flowey/flowey_lib_hvlite/src/install_vmm_tests_external_deps.rs`,
  `.github/workflows/openvmm-ci.yaml` (jobs `run vmm-tests [x64-windows-amd-snp]`,
  `[x64-windows-intel-tdx]`), `vmm_tests/vmm_tests/tests/tests/multiarch/tpm.rs`,
  `vmm_core/virt_whp/src/lib.rs`, `vm/vmgs/vmgstool/src/main.rs`,
  `Guide/src/user_guide/openhcl/run/hyperv.md`
- hcsshim: `internal/uvm/create_lcow.go`, `internal/hcs/schema2/isolation_settings.go`,
  `internal/tools/uvmboot/{lcow.go,conf_wcow.go}`
- Microsoft Learn: `New-VM` (windowsserver2025-ps); Hyper-V install page ("can't
  be installed on Windows 11 Home"); WSL FAQ ("subset of Hyper-V ... all Desktop
  SKUs"); Azure Local `confidential-vm-overview`, `troubleshoot-confidential-vm`
- Windows Server vNext preview 29621 / 29641 announcements (Trusted Launch)
- Lenovo Press LP2484, "Configuration Guide for Confidential Computing and
  Microsoft CVM" (Aug 2026)
- Linux `Documentation/virt/hyperv/coco.rst`
- hvinternals, "Hyper-V settings and configuration (Windows Server 2025)"
  (May 2026) -- registry enumeration, unofficial
- Winbindex / Microsoft symbol server for the binaries listed above
- jamesstringer90/appsandbox README; anthropics/claude-code issues #32828, #60631
- HimDek gist (DISM Hyper-V on Home) and its 2025-2026 comment thread
