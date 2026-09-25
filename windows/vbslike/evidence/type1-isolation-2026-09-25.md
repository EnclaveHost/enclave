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

---

# Continuation, same night: where the type-1 failure actually is

## The 120 seconds is OpenHCL's start-failure timer, not a hang

Hypervisor-Operational: partition 51 **created 19:52:47**, **deleted 19:54:47**. Exactly 120 s.
OpenHCL reports a start failure to the host and then waits two minutes to be terminated; if it is
not, it panics — which is the 18610 + 18560 pair. So **the real failure happens within seconds of
the start**, and the triple fault is its epilogue rather than its cause.

## The host holds no readable reason

Every `Microsoft-Windows-Hyper-V-*` channel with records, swept unfiltered across 19:52:30–19:55:10.
The complete set of entries is: Worker-Operational `[1820] Loading IGVM file from default location`
(the only one); Worker-Admin 18609/12148/18500 then 18610/18560/18508; VMMS-Admin
18304/19732/13002/18018/18012; Compute-Operational 2014/2009/2000/2008; Hypervisor-Operational
16641/16642. **There is no free-text error and no CompleteStartVtl0 entry anywhere.** OpenHCL's own
reason is therefore unreachable from the host, and `ohcldiag-dev` is the only remaining way to read
it — a blocker, not a detail.

## The empty-store discriminator: REFUSED BY THE HOST, so it decides nothing

A 4,194,816-byte all-zero store (sha `8d81cd22…`) never reached OpenHCL. Hyper-V rejected it at
realize time:

    Failed to create a new virtual machine. '…' failed to realize.
    Failed to access configuration store: The file or directory is corrupted and unreadable. (0x80070570)

So **the host validates the guest-state store itself, before the VM is created**, and "OpenHCL
formats an empty vmgs" is unreachable on this build. Recorded as refused-by-host — NOT as a result
about OpenHCL.

## The donor store looks valid, which shifts the weight

First 16 bytes: `47 55 45 53 54 52 54 53 00 00 03 00 28 ed 2e 6d` = `GUESTRTS` then `00 00 03 00`,
i.e. a v3.0 store. Per source review a v3 store from another VM id is accepted and only logs that the
VM id changed. That moves weight off "the VMGS will not open" and onto
`validate_isolated_configuration` refusing one of the host's settings — **inference, pending logs.**
CRCs and allocated file ids are not yet checked.

## Memory experiment: still VOID, but one reader is now honest and the decoder exists

The saved-state reader works mechanically (Save-VM 520 ms, VM resumed cleanly) and found a
2,147,512,320-byte `.VMRS` — the full 2 GiB guest. Its first verdict was an ARTEFACT: **Save-VM
returns before the saved state is written**, the file read 165,654,528 bytes at that moment, and
searching the truncated file produced a confident VOID. The reader now waits for the size to settle.

A raw byte search may still be the wrong instrument for a `.VMRS`. The documented decoder IS present
on this box: `C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\vmsavedstatedumpprovider.dll`
with `vmsavedstatedump.h` and the `.lib`. That is the path to a reader whose positive control can
actually pass.

**No type-1 memory comparison has been attempted, and none would mean anything until a type-16
control PASSES.**

## Defects found in this harness while doing the above

- **Cleanup failures were written to a console nobody was attached to.** A detached run has no
  console, so `Write-Host "FAILURE: …"` went nowhere: a canary VM was left RUNNING after a
  saved-state read while the log showed the setting restored. Found by listing VMs, not from the
  log. Every verdict now goes through the log.
- Removal now waits for `Off` and retries; a VM was previously announced as removed while
  `Remove-VM` had thrown `InvalidState`.

## This host DOES render OpenHCL's GET events, so the silence on type 1 is evidence

Worker-Admin **18601 "successfully booted an operating system"** appears on both type-16 runs that
booted and served (19:37:12 and 19:39:44). That is OpenHCL's GET BOOT_SUCCESS reaching the host, so
this host renders GET events rather than swallowing them.

OpenHCL reports VMGS open failures to the host as GET events too (VMGS_INIT_FAILED, INVALID_FORMAT,
CORRUPT_FORMAT, ACCESS_FAILED). The type-1 run produced **none of them, and no 18601**. Combined
with the donor store being byte-identical to a fresh `vmgstool create` — a pristine, unencrypted v3
store with no key protector — "the VMGS will not open" is now poorly supported.

`validate_isolated_configuration` emits NO event, which matches the observed silence exactly. It is
the leading candidate. **Still inference, pending OpenHCL's own kmsg** — it is not a finding, and
the configuration-incompatibility hypothesis remains labelled as inference.

## ohcldiag-dev: the tool works, and on type 1 there is nothing to read

Validated on type 16 FIRST, as the tool's positive control, on a partition that booted and served:
**354 kmsg lines**, 1 naming OpenHCL's own kernel (`6.12.52-microsoft-hcl`), 0 naming
`microsoft-standard-WSL2` (which would mean it was reading OUR VTL0 kernel, not VTL2), including:

    [0.084251] underhill_core:  INFO  boot loader times start=0x2239 end=0x848f elapsed=2.5174ms
    [0.084393] diag_server:  INFO  control starting control_address=VmAddress(Address { cid: ffffffff, port: 1 })

On type 1, the same reader on the same run definition minutes later:

    Error: unknown service diag.UnderhillDiag        (0 kmsg lines)

The connect reaches something and the service is not registered, so **VTL2's diagnostics server
never starts**. That places the type-1 failure EARLIER than `diag_server` — earlier than 85 ms on
the type-16 timeline, and so earlier than attestation and earlier than the VMGS handling. If
`diag_server` starts before `validate_isolated_configuration`, it is earlier than that too, which
would put the failure in `openhcl_boot` or the VTL2 kernel, before OpenHCL's Rust userspace.
**Inference from one observation, flagged as such.**

## CORRECTION: the donor VMGS was NOT pristine when I called it pristine

I reported the donor's first bytes as `GUESTRTS 00 00 03 00` and that was used to argue the store
was a valid v3 file. **I read those bytes after several type-1 runs had already used it.** Freshly
minted and never started, `New-VM -GuestStateIsolationType VBS` produces a store with **57 non-zero
bytes in 4,194,816 and no GUESTRTS anywhere** — the whole file was scanned for the magic. Polling a
never-started donor for 60 s never produced the header. So Hyper-V creates an essentially empty
store and the v3 header was written later, by something, during or after a type-1 run.

Related and also measured: the donor's hash changed across a run (`01c2879b…` → `3e9630e1…`), so
**every type-1 boot after the first started from a store a previous run had mutated** and my type-1
runs were not identical to each other. Each run now takes a fresh byte-identical copy of a master
that is never handed to a VM, and the copy's hash is compared before and after.

Note the contrast with the host's own validation: a hand-made ALL-zero file is refused at realize
with 0x80070570, while Hyper-V's 57-non-zero-byte store is accepted. Those 57 bytes carry whatever
minimal structure the host requires.

## A cleanup "failure" that was my own check being wrong

A clean type-1 run reported `FAILURE: guest state left on disk`. The file it named was the donor
supplied as INPUT, which must survive. The check was written for the earlier New-VM path where the
VMGS lived inside the Hyper-V store. It now removes the per-run copy and leaves the master alone.

## CORRECTION: "unknown service" means the diagnostics server IS running, not that it never started

I read `Error: unknown service diag.UnderhillDiag` as "VTL2's diagnostics server never starts" and
placed the failure before it. **That is wrong, and it is backwards.** From source (enclave-5d):

- The string is SERVER-GENERATED. `mesh_rpc` looks the requested service up in its registered map
  and answers `Unimplemented "unknown service <name>"`. A server that is not there gives a CONNECT
  failure, not an RPC reply.
- Registration is POLICY, not liveness: `diag_server` registers `UnderhillDiag` and `OpenhclDiag`
  (kmsg, exec, files) **only when confidential filtering is OFF**. Filtering is on exactly when the
  partition is isolated. Inspect and the profiler are registered always.

So the reply is POSITIVE evidence in three ways: the boot shim saw an isolated partition, the VTL2
kernel came up, and OpenHCL's userspace ran as far as its diagnostics worker. It is the opposite of
what I concluded.

It also does NOT localise the failure the way I said: `run_control` starts the diagnostics server
BEFORE `launch_workers`, so it precedes both the VMGS open and `validate_isolated_configuration`.
The reply therefore rules out neither candidate. What it does rule out is "the failure is
pre-userspace", which was my inference and is now dead.

**Consequence for the toolchain:** kmsg cannot carry the error on a stock isolated image, by design.
Reading it needs a debug image whose STATIC, measured command line sets
`OPENHCL_CONFIDENTIAL_DEBUG=1` — a different measured image that trusts the host, so a debug artifact
only, never a serving candidate, and it must be named on disk so that is unmissable.

## A fresh VMGS is an EMPTY store plus a VHD footer — and that means OpenHCL DID open it

Measured on the freshly minted master, no boot required:

    size 4,194,816; all 57 non-zero bytes lie at 0x400000-0x400053
    length - 512 = 0x400000 (4 MiB exactly)
    the last 512 bytes begin: 63 6f 6e 65 63 74 69 78 = "conectix"

So `New-VM -GuestStateIsolationType VBS` produces **4 MiB of zeros plus a 512-byte fixed-VHD
footer**: an empty store in a valid container. Two things follow.

1. My hand-made all-zero file was refused with 0x80070570 because it had **no VHD footer**, not
   because of anything about VMGS content. The host was validating the container.
2. The `GUESTRTS` v3 header I later found in the donor was therefore written by **OpenHCL's own
   formatter**, which formats an empty store on open. That means the VM worker DID successfully
   open the guest state.

Candidate (a), "the VMGS will not open", is now ruled out **on evidence** rather than on the
mistaken pristine-donor premise I offered earlier. The failure is after the store is opened, which
puts the weight on what follows in the worker's startup — memory initialization (the VBS-specific
step where VTL0 RAM is accepted host-private), the DMA manager, the guest-memory self test, measured
VTL0 info, and `validate_isolated_configuration` — with no reason yet to prefer one.
