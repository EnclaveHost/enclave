# VBS enclaves inside an SEV-SNP guest, on a Linux KVM host

The question: can the VBS enclave be the isolation unit on every tier, with SEV-SNP wrapped around it on
hardware that has it, so that the same signed app image runs on a consumer box (VBS alone) and an EPYC box
(VBS inside an SNP confidential VM)?

This page keeps two kinds of result apart and does not let one stand in for the other:

- **Observed**: executed on warden-host on 2026-09-22 with the probes in this directory (`run.sh` reruns them).
- **Source-based**: what kernel, OpenVMM and vendor sources say. Not measured here.

**What was NOT executed:** no Windows guest was booted on this host, under SNP or otherwise. Booting
Windows as an SNP guest, starting VBS inside it, and creating a VBS enclave there are all **untested**.
Nothing below is a measurement of Windows.

Host: AMD EPYC 9115, Linux 7.2.3-arch1-2, QEMU 11.1.1, edk2-ovmf `OVMF.4m.fd`, PSP firmware
`SEV-SNP API:1.58 build:3`, `kvm_amd: SEV-SNP enabled (ASIDs 1 - 99)`.

## Observed

**1. SNP works on this host (positive control, `snpctl.c` as PID 1).**

```
Memory Encryption Features active: AMD SEV SEV-ES SEV-SNP
SEV: Using SNP CPUID table, 40 entries present.
SEV: SNP running at VMPL0.
provider sev_guest
report bytes=1184   version=5 guest_svn=0 vmpl=0
report_data[0:16] c0c1c2c3c4c5c6c7c8c9cacbcccdcecf      <- the nonce written to inblob, echoed back
measurement 5dfdefc0b165fadc8618213c0532534dc1513d8ea528309761cad23a2d6a68fbd448dd6e06a1b92ab15a1f536233275d
```

The same probe in a guest without SNP gets no report (`report bytes=-1`), as it should.

**2. The SNP guest's CPUID advertises SVM.** `CPUID 8000_0001 ECX.SVM = 1` inside the SNP guest (it comes
from the SNP CPUID table QEMU supplies) and inside the plain guest alike. An advertised bit is not a working
feature; see 3.

**3. The guest kernel refuses to be a hypervisor inside the SNP guest (`kvmtest.c` as PID 1).**

| guest | `kvm_amd` load | `/dev/kvm` | VM + vCPU create |
|---|---|---|---|
| SNP | **refused**: `finit_module` -> `EOPNOTSUPP`, kernel log `kvm_amd: KVM is unsupported when running as an SEV guest` | absent | not reached |
| plain KVM | loads: `Nested Virtualization enabled`, `Nested Paging enabled` | present | both succeed |

Limits of observation 3:
- The refusal is the **Linux guest kernel's own policy**. It does not show what the host does when a guest
  actually executes VMRUN; that was not tested.
- The plain-guest run's `KVM_RUN` outcome was not captured in the recorded output, so it is not claimed.

## Source-based (not measured here)

**A. Windows is not enlightened to run as a direct SEV-ES/SNP guest.** Microsoft, on OpenHCL: it was not
possible to fully enlighten Windows guests, and "our plan is not to fully enlighten Windows and continue
supporting Windows guests via a paravisor in Azure"
([mirror of the OpenHCL post](https://thewindowsupdate.com/2024/10/17/openhcl-the-new-open-source-paravisor/)).
AMD's KVM SEV maintainer: "Windows isn't enlightened to run under SEV… I wouldn't expect it to be able to boot"
([AMDSEV#209](https://github.com/AMDESE/AMDSEV/issues/209)). What exactly happens on a boot attempt (hang,
triple fault, bugcheck) is not documented anywhere found, and was not observed here.

**B. KVM does not support nested virtualization inside SEV/SEV-ES/SNP guests.** Mainline
`arch/x86/virt/hw.c`: "KVM doesn't support nested virtualization within an SEV VM… let alone running nested
VMs within SEV-ES+ guests (e.g. emulating VMLOAD, VMSAVE, and VMRUN all require access to guest register
state)" ([L285-287](https://github.com/torvalds/linux/blob/fe2ec83746e501645709761605c2464a44fd2929/arch/x86/virt/hw.c#L285-L287)).
The VMGEXIT handler in `arch/x86/kvm/svm/sev.c` has no VMRUN case and rejects unknown exit codes
([L4692-4696](https://github.com/torvalds/linux/blob/fe2ec83746e501645709761605c2464a44fd2929/arch/x86/kvm/svm/sev.c#L4692-L4696)),
and accepts only GHCB usage code 0, so Hyper-V-style GHCB hypercalls are refused
([L4548-4554](https://github.com/torvalds/linux/blob/fe2ec83746e501645709761605c2464a44fd2929/arch/x86/kvm/svm/sev.c#L4548-L4554)).
Consequence, by inference: Windows' own Hyper-V, which VBS needs, cannot run nested in an SNP guest on KVM.

**C. The paravisor route needs Hyper-V as the host.** OpenVMM: "Currently, OpenHCL cannot be used on Linux
hosts, primarily due to limitations in KVM"
([openvmm_linux](https://openvmm.dev/guide/user_guide/openhcl/run/openvmm_linux.html)). OpenVMM's own KVM SNP
mode is "limited to Linux direct boot… SNP does not support UEFI, VTL2"
([CLI reference](https://openvmm.dev/guide/reference/openvmm/management/cli.html)); `virt_kvm/src/snp.rs`
refuses `highest_vtl != 0`.

**D. COCONUT-SVSM** lists paravisor mode for unenlightened guests and Hyper-V VSM on KVM planes as
**roadmap** ([development plan](https://github.com/coconut-svsm/svsm/blob/main/Documentation/docs/developer/DEVELOPMENT-PLAN.md),
[#291](https://github.com/coconut-svsm/svsm/issues/291)) and needs an out-of-tree kernel and QEMU.

**E. The KVM VSM work does not cover this.** The Hyper-V VSM emulation series (Saenz Julienne) targets
non-confidential guests. The Aug 2026 "VBS/VSM-on-KVM" RFC runs a **Linux** secure kernel on out-of-tree
KVM planes ([thread](https://ratatoskr.run/kvm/2026/08/17370331/t)).

**F. The one VTL-over-VMPL implementation found in code** is OpenHCL's: `virt_mshv_vtl/src/processor/snp/mod.rs`
maps VTL0 to VMPL2 and VTL1 to VMPL1, gated on a host-granted privilege. It runs on Hyper-V. Whether Azure
grants that privilege to Windows guests in production is **unverified**, and no Microsoft document found says
VBS works inside an Azure confidential VM.

## Verdict, and what it rests on

On this stack (stock Linux KVM 7.2, QEMU 11.1), VBS enclaves inside an SNP guest are **unsupported according
to the sources** (A, B and C, each sufficient on its own). The observations are **consistent** with that (3)
but do not demonstrate it: the Windows steps were not run.

## What would test it directly

1. **Windows as an SNP guest here** (tests A). An unattended install of `~/Downloads/Win11_25H2_English_x64_v2.iso`
   under plain KVM as the control, then the same disk under SNP, then `vxhost.exe` / `rawhost.exe` from
   `../enclave/`. About 1-2 h of host load, so it needs a quiet window.
2. **An Azure DCasv5/ECasv5 Windows confidential VM** (tests F, the only place the pieces exist in code):
   `Win32_DeviceGuard` for VBS state, then `IsEnclaveTypeSupported(ENCLAVE_TYPE_VBS)` and a full
   create/load/initialize/report with the same probes.
