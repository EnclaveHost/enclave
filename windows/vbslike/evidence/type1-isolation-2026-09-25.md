# Proving VBS isolation on nucbox-k11: what was measured, 2026-09-25

Host: nucbox-k11, Windows build 26200, AMD. Every run below is its own bounded boot of OUR OWN
canary VM (`enclave-uefi-*`), with `AllowFirmwareLoadFromFile` applied for that run and restored
verified, the VM removed, and the six customer apps checked before and after. No customer app was
started, stopped or reconfigured for any of this, and no shared-node restart was taken for it.

The three experiments establish DIFFERENT things and are recorded separately, as asked.

---

## 1. Isolation configuration — CONCRETE RESULT: type 1 refuses to start with an OpenHCL paravisor

Prerequisites that had to be fixed first, each measured rather than assumed:

| prerequisite | finding |
|---|---|
| guest state | A type-1 VM needs a VMGS. `New-VM -GuestStateIsolationType VBS` makes one (`Virtual Machines\<GUID>.vmgs`, 4,194,816 bytes on disk, GuestFeatureSet 1024, UserSnapshotType 5, TpmEnabled True). petri's `New-CustomVM` makes none, and this host refuses it: VMMS "security settings which do not allow it" at define time, bare Worker 12030 at start. |
| stateless guest state | **UNSUPPORTED ON THIS HOST.** `GuestStateLifetime` is not present on this build's `Msvm_VirtualSystemSettingData`, and neither is `GuestStateEncryptionPolicy`. Not a choice we made. |
| VTL2 address space | Required. Without `Vtl2AddressSpaceConfigurationMode 1` / `Vtl2AddressRangeSize 1024` / `Vtl2MmioAddressRangeSize 512`, OpenHCL comes up with no address space and the VM triple-faults. |
| NIC | `New-VM` adds one; removed explicitly. This guest reaches only its own loopback and the control channel. |
| COM3 (OpenHCL's own log) | **UNSUPPORTED ON THIS HOST.** Gen2 VMs here expose two serial ports; petri's `-Com3` indexes `Msvm_SerialPortSettingData[2]`. An OpenHCL refusal is therefore SILENT for us. |

The matrix. Every row is its own run, all on medium `ca245eae…` hashed at attach:

| firmware | GuestStateIsolationType | GuestFeatureSet | outcome |
|---|---|---|---|
| `openhcl.bin` 48773995 (isolation None) | 16 | 0x201 | **PASSED** — boots, hv_sock, app serves the pinned 13 bytes |
| `openhcl.bin` 48773995 | 1 | 0x201 | **REFUSED TO START** (bare Worker 12030) |
| `openhcl-cvm.bin` cfd40ce2 (VSM_ISOLATION/vbs) | 16 | 0x201 | **REFUSED TO START** |
| `openhcl-cvm.bin` cfd40ce2 | 1 | 0x201 | **REFUSED TO START** |
| `openhcl-cvm.bin` cfd40ce2 | 1 | 0x601 | **REFUSED TO START** |
| `openhcl-cvm.bin` cfd40ce2 | 1 | 0x400 | starts, then Worker 18610 "fatal virtual firmware error … ErrorCode0..4: 0x0" + 18560 triple fault |

### UPDATE, same night: the refusal was MY configuration, not the platform

With Microsoft's own recipe the type-1 VM **STARTS**. petri sets the VTL2 trio only when
`is_openhcl && !is_isolated` (petri/src/vm/hyperv/powershell.rs:548), because `openhcl.bin` carries
a RELOCATABLE_REGION and `openhcl-cvm.bin` has none and needs VTL2 at the FIXED GPA 0x8000000.
Asking a fixed-GPA image to auto-place a 1 GiB VTL2 range is what the bare 12030 was. Removing the
trio, defining the VM in ONE DefineSystem as petri does, and supplying the real VMGS this host
requires gives, read back off the live VM:

    GuestStateIsolationType=1 enabled=True GuestFeatureSet=0x201 Vtl2Mode=0 Vtl2Range=0
    firmware='...\openhcl-cvm.bin'

and the partition starts. **The failure has moved from a refusal BEFORE the partition starts to a
runtime failure AFTER it starts** — Worker 18610 "fatal virtual firmware error ... ErrorCode0..4:
0x0" then 18560 triple fault, ~2 minutes in, with ZERO bytes on COM1. That distinction matters: a
partition that never starts has no diagnostics server, and this one does start.

So the row below reading "type 1 refuses to start" describes MY earlier configuration. Restated:
type 1 with petri's configuration STARTS AND TRIPLE-FAULTS. **No blanket claim that type 1 is
unavailable on this build is supported, and the earlier inference that the two paths are "not
composable" is withdrawn pending OpenHCL's own logs.**

### The diagnostic delta, from the host event channels

Two lines appear on the type-16 runs that BOOTED and are entirely absent on the type-1 run:

    [1540] Gsp server unavailable.
    [1540] GspSeedData not set.

Two other lines are NOISE and must not be read as failures — both appear on the successful runs:
`[1820] Loading IGVM file from default location.` (it says this even when our pinned firmware is in
use, which a previous session misread) and `[2000] Create compute system, result 0xC0370103`.

**The same firmware that boots on type 16 refuses on type 1** (under the configuration in the table),

0x400 is what `New-VM` sets for VBS with the OpenHCL feature OFF; that combination starts because it
is the in-box VBS path with no paravisor, and triple-faults because nothing in VTL2 boots our medium.

Reading, stated no more strongly than the evidence allows: on build 26200 the in-box VBS isolation
type and a custom OpenHCL paravisor appear to be ALTERNATIVES rather than composable. This is NOT a
proof that VBS-like host exclusion is impossible on this box — it is a measurement that the
configuration the source review proposed does not start here.

Type 16 is `IsolationType::None` and can never exclude the host. Nothing on it is verified capacity.

### What type 16 does state about itself, measured on the production medium

```
MON hv hyperv=true max_leaf=0x4000000b priv_high=0x3b8030 isolation_priv=false config_a=0x0 config_b=0x0
MON boundary tier=t0-hv vmpl=n/a vmpl_floor=n/a vmpl0=n/a host_excluded=no hv_isolation=n/a paravisor=n/a
MON ready control_port=9000 snp=false transport=hv_sock
```

Leaf `0x4000000C` is not defined on this host (max leaf `0xb`) and `isolation_priv` is false, so the
tuple reads n/a / n/a. A prediction of none/yes was recorded beforehand and is NOT what was measured.

---

## 2. Guest-private memory — VOID. The reader does not work, and the control is what proved it

`host-read-guest.ps1` walks the partition's `vmwp.exe` committed regions with `ReadProcessMemory`
looking for a marker pushed into the guest that run, plus a CANARY string the guest itself printed.

On the type-16 POSITIVE CONTROL — where the root can map every guest page by construction, so the
reader MUST find it — it found **neither**: 68 MiB scanned across 662 regions (IMAGE 43.7 MiB,
MAPPED 26.4 MiB, PRIVATE 17.8 MiB), largest region 8.4 MiB against a 2 GiB guest.

**Verdict: VOID.** Guest RAM is not in `vmwp`'s enumerable committed regions, so this instrument is
the wrong one. No type-1 comparison was attempted and none would have meant anything. The script
says this itself rather than reporting a miss as a result — a reader that finds nothing because it
can see nothing must never pass as isolation.

---

## 3. VbsReport and same-boot measured-boot material — NOT RUN

Blocked by (1). No type-1 guest has ever produced a console line, so no report could be requested and
no marker could reach guest RAM. Recorded as blocked, NOT as a negative result.

Separately from source review, and NOT measured here: on this host the vTPM is protected by a
host-supplied key, so the vTPM route to key binding would be host-forgeable and only the VTL0 probe
route remains.

---

## The vTPM, stated so no transcript can imply otherwise

A type-1 VM on this host HAS a vTPM: Windows makes one for a VBS VM and the guest-state key protector
lives in it. **Nothing on this path reads its PCRs.** Its presence is not attestation. The launcher
prints this on every type-1 run rather than refusing the vTPM, because refusing it would mean
refusing the only isolation configuration this host offers.

## Trust assumptions, kept explicit

The target is exclusion of the ordinary Windows host OS under a trusted lower layer — not protection
from the physical owner, and not from a compromised hypervisor. Trusted throughout: the hypervisor,
the root partition's VTL1, the firmware and boot chain, and physical access. Memory is not encrypted
on this path; a VBS claim is hypervisor-enforced page protection, not encryption.

## The blocker to work next

`ohcldiag-dev`. OpenHCL's diagnostics server runs unconditionally over vsock and `ohcldiag-dev <VM>
kmsg` reads VTL2's kmsg — the replacement for the COM3 this host does not have. There is no openvmm
source on the box and no built binary. Until then every type-1 refusal is a contentless Worker 12030
and causes are inferred from configuration diffs instead of read from OpenHCL itself.

## Production, recorded as it actually was

Five of six apps healthy throughout; `0xd9798e4c` is wedged on the known ee-host listener fault,
which predates this work, has three prior unexplained occurrences, and is handed to the monitor for
assignment. Every run's own before/after check reported "no app that answered on loopback before this
run stopped answering".
