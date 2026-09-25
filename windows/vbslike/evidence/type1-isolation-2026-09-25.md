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

---

# THE TYPE-1 FAILURE IS NAMED

From the debug image's kmsg on a live type-1 partition, verbatim:

    [0.126263] underhill_core::worker: ERROR worker_new{ name="UnderhillWorker" action="new"}:
      failed to start VM error=failed to initialize memory:
      cannot safely support VTL 1 without using the alias map
    [120.126490] [U] thread 'worker-UnderhillWorker' (45) panicked at
      vm/devices/get/guest_emulation_transport/src/client.rs:562:25

**The failure is in MEMORY INITIALIZATION, at 126 ms**, and the panic is exactly 120 s later —
confirming the 120-second wait-to-be-terminated timer, with the triple fault as its epilogue. It is
NOT `validate_isolated_configuration`, and not the VMGS: memory initialization is the VBS-specific
step where VTL0 RAM is accepted host-private, and it is where this stops.

The requirement named is the **VTL alias map**, which this host is not providing for the partition.
That is a concrete, host-side prerequisite rather than an unexplained refusal, and it is the first
statement of what type 1 actually needs here.

Supporting lines from the same run, all on the isolated partition:

    Hyper-V: Isolation Config: Group A 0x0, Group B 0x1
    Command line: ... OPENHCL_CONFIDENTIAL=1 OPENHCL_CONFIDENTIAL_DEBUG=1 ...
    diag_server: INFO control starting control_address=VmAddress(Address { cid: ffffffff, port: 1 })
    inspect build_info: scm_branch "main", scm_revision a7b0bd4a653ba1c9192497a9d3669b14e7f3bc58
    inspect control_state: "starting"          (type 16 answers "started")

## The confound, stated because it is not yet excluded

This came from the DEBUG image, built from openvmm a7b0bd4 with a 6.18.37.5 VTL2 kernel, while the
stock `cfd40ce2` runs release 2511 with 6.12.52. **The debug flag is not the only difference.** A
CONTROL image — same a7b0bd4 components, no `--confidential-debug` — is being built to establish
whether stock fails the same way. Until that runs, this is the named cause of the DEBUG image's
failure and the strongest available hypothesis for the stock one, not a proven identity.

What is independent of the confound: `control_state` reads `"starting"` and the `vm` node is absent
on BOTH the stock and the debug type-1 runs, while type 16 reads `"started"` with a full `vm` tree.
Both images stop before the VM worker finishes starting.

## Also measured: OpenHCL formatted the guest state

The per-run store copy went in as an empty store (`4f051697…`, 4 MiB of zeros plus a VHD footer) and
came out as `21419cd8…` with **`GUESTRTS` at offset 0** — the v3 header, byte-identical to the one
seen earlier. So the VM worker opened the store and formatted it. No PROVISIONING_MARKER was written
(`openhcl` appears nowhere in the file), which is consistent with stopping in memory initialization
before that marker is written; absence alone proves nothing, but it fits.

---

# A TYPE-1 VBS PARTITION BOOTS AND SERVES — two changes, both named

The blocker was two things, not one:

1. **`Set-VMSecurity -VirtualizationBasedSecurityOptOut $true`.** The error was "cannot safely
   support VTL 1 without using the alias map": OpenHCL was being asked to support Guest VSM
   (VTL1 *inside* the guest) and this host does not give it the alias map it needs to do that
   safely. Our Linux guest has no secure kernel and never uses VTL1, so declining Guest VSM removes
   the requirement. **This is not weakening the property under test** — Guest VSM is VTL1 inside the
   guest; the host exclusion in question is the PARTITION's isolation, a different mechanism,
   untouched. The raw CIM property is ReadOnly on this build; `Set-VMSecurity` is the path.
2. **An a7b0bd4-built CVM image.** Stock `cfd40ce2` (release 2511) still reads `control_state
   "starting"` and never boots WITH the opt-out applied. So the opt-out alone is not sufficient and
   the 2511-versus-a7b0bd4 difference is real, exactly as the control image was built to decide.

## Measured on the CONTROL image (a7b0bd4, no --confidential-debug, does NOT trust the host)

    firmware openhcl-cvm-a7b0bd4-CONTROL-32d464cc.bin, GuestStateIsolationType 1, medium ca245eae
    inspect control_state (66 ms): "started"
    MON snp=0 vcpus=1 memMiB=1828 boot_ms=325
    MON hv hyperv=true max_leaf=0x4000000c priv_high=0x6a8030 isolation_priv=true config_a=0x0 config_b=0x1
    MON boundary tier=t0-hv vmpl=n/a vmpl_floor=n/a vmpl0=n/a host_excluded=no hv_isolation=vbs paravisor=no
    MON ready control_port=9000 snp=false transport=hv_sock
    WMISERVE load: agreed, appSha256 9c3d10f1...; relay up; APP ANSWERED 13 raw bytes sha256 03ba204e...

**The guest itself now reports `hv_isolation=vbs`**, `isolation_priv=true`, and leaf `0x4000000C`
is DEFINED (`max_leaf=0x4000000c`), where type 16 reads `0x4000000b` with `isolation_priv=false` and
`hv_isolation=n/a`. That is the first time the tuple has distinguished the two partition types from
inside the guest.

## What this is NOT

`host_excluded=no`, and that is correct and unchanged. A partition that reports VBS isolation is not
a demonstration that the root cannot read its memory. **E2 (the report chain) and E3 (the memory
experiment) remain NOT RUN**, the memory reader still has no passing positive control, and nothing
here is verified capacity or admissible as attestation. `paravisor=no` also differs from the
source-based prediction of `yes` and is not yet explained.

## A label that is now WRONG and must be fixed

`wmiserve` still prints, on every run: *"type 16 is 'OpenHCL but no isolation', the root can map
this guest's memory..."*. On this path that string is hardcoded and inaccurate — the partition is
type 1. It under-claims here rather than over-claims, but a hardcoded boundary statement that does
not track the actual partition type is exactly the kind of thing that makes a transcript unreliable
in either direction. It needs to state the partition type it was given.

## Save-VM is REFUSED on a type-1 VM, so the saved-state reader is unavailable there

From the first type-1 run that got far enough to try it:

    Save-VM REFUSED: '...' failed to save. Cannot perform the operation ... because the virtual
    machine has security settings which do not allow it.
    VERDICT: REFUSED - nothing was read, so this says NOTHING about whether the memory is readable.
             A refusal to save is not evidence of isolation and must never be reported as any.

This matters structurally, not just for one run. The documented host-side route to a guest's memory
on this platform is Save-VM plus a saved-state decoder, and **that route does not exist for a type-1
VM on this host.** So E3 needs a different instrument for the type-1 side, and the type-16 control
cannot simply be repeated there.

It is worth being explicit about the trap: a refusal to save is the easiest possible thing to
mistake for protection, and it is not. Nothing was read, so nothing was established. The script
says so in its own output rather than relying on a reader to remember.

---

# E2 RAN. The VTL0 report hypercall did NOT return a report

First E2 run: PROBE medium `8d1fea1f…` (vbsreport probe) on the same type-1 definition — a7b0bd4
CONTROL firmware `32d464cc…`, `GuestStateIsolationType 1` read back off the live VM,
`VirtualizationBasedSecurityOptOut=True` read back. Run exited **RUN OK** (0), cleanup clean.

The guest booted and reproduced the type-1 tuple on a third medium:

    MON hv hyperv=true max_leaf=0x4000000c priv_high=0x6a8030 isolation_priv=true config_a=0x0 config_b=0x1
    MON boundary tier=t0-hv ... host_excluded=no hv_isolation=vbs paravisor=no
    MON ready control_port=9000 snp=false transport=hv_sock

The probe's entire output, verbatim (917 console bytes total, one VBSREPORT line, no report body):

    [    0.335899] VBSREPORT status=0x71 (low 16 bits: 0 = success, 2 = invalid hypercall code, 3 = invalid input, 6 = access denied)
    MON PROBE IMAGE: loading /probe.ko (this is not a production medium)
    MON PROBE finished: No such device

**So `HvCallVbsVmCallReport` did not return a report.** `0x71` is none of the three codes the probe
names, and the module finished `ENODEV`. What that status means is for the probe's author to say;
it is recorded here verbatim rather than interpreted.

What this does and does not settle: it is NOT "status 0 + verifies under IDKS", so **the
client-verifiable report chain is not demonstrated**. It is also not cleanly "VTL0 refused"
(status 6/2), so the vTPM-route conclusion does not follow either. E2 has a result and the result is
that this needs another look, not that the chain exists.

The host's TCG log for the SAME host boot is captured beside it:
`tcglog-20260925-042300-0000000067-0000000000.log`, 90,554 bytes, host boot log
`0000000067-0000000000.log`. A VBS report can only be checked against the measured-boot log of the
boot that produced it, so the capture is now part of the run rather than a later step.

**E3 stays NOT RUN, deliberately and permanently on the current instrument question.** `Save-VM` is
refused on a type-1 VM, and looking for an undocumented way into an isolated VM's memory would be
attacking the protection under test rather than measuring it. That is out of scope for this lane.
The memmarker module stays parked as the type-16 control should a documented reader ever appear.
**The claim a customer could check therefore rests on E2.**

## What the debug kmsg supports about E2, stated at its actual strength

**Correction (2026-09-25, after the monitor's review).** This section was first headed "the
discriminator resolves E2: VTL2 GETS a VBS report; only VTL0 is turned away". That overstated it.
E2 is NOT complete and the customer report chain is NOT established. The evidence below is kept
verbatim; what it supports is now stated separately from what it does not.

`0x71` is `HV_STATUS_OPERATION_FAILED`. It is not the access-denied status (6), and it is not
"invalid hypercall" (2) or "invalid input" (3). That is all it says. It does not show that access
was permitted, and one call with one input on one image does not show that VTL0 can never obtain a
report on this host.

The debug image's kmsg, from the opt-out run that BOOTED, shows OpenHCL's own VTL2 key-release path
during a type-1 boot. Verbatim:

    [0.126504] underhill_attestation: Reading security profile tee_type=Some(Vbs) secure_boot=false
               tpm_enabled=true tpm_persisted=true hardware_sealing_supported=false
    [0.150645] secure_key_release: attempt to get VMGS key-encryption key
    [0.153124] secure_key_release: ERROR VMGS key-encryption key request failed due to error
               error=failed to parse the IgvmAttest KEY_RELEASE response: error in parsing response
               header: the size of the attestation response 0 is too small to parse
    [0.153173] underhill_attestation: ERROR Failed to retrieve key-encryption key error=<same>
    [0.153616] GSP response request_data_length_in_vmgs=0x0 no_rpc_server=true requires_rpc_server=false
    [0.153813] No VMGS encryption used.

enclave-5d read the source order at openvmm a7b0bd4: `request_vmgs_encryption_keys` obtains the VBS
report FIRST and returns early if that fails (`secure_key_release.rs:174-182`), and only then sends
IGVM_ATTEST (`:185`). The logged failure is in parsing a zero-length KEY_RELEASE response, which is
after the send.

| claim | status |
|---|---|
| VTL2 obtained a VBS report during this boot | **Strongly supported, by inference**: the kmsg plus the source order. Not observed directly. |
| on which image | the **DEBUG** image `81e163ee` (`OPENHCL_CONFIDENTIAL_DEBUG=1`, trusts the host). NOT shown on the non-debug control `32d464cc`. |
| report bytes | **NOT captured.** None were in our hands. |
| report signature, signing key, root of trust | **NOT identified and NOT verified.** Whether it chains to an IDKS in the host TCG log is untested. |
| what that report binds | OpenHCL's own key-release claims (its transfer key), sent to the host. Not our nonce, app, runtime or TLS key. |
| VTL0 `HvCallVbsVmCallReport` on the CONTROL image | returned `0x71` with no body, for one call with one input. |
| "VTL0 can never get a report here" | **NOT shown.** |
| E2 | **NOT complete.** |
| customer-verifiable report chain | **NOT established.** |

**The pairing caveat (enclave-5d).** The VTL2 inference comes from the debug image and the VTL0
`0x71` from the control image. Both are a7b0bd4 code, but they are two images and two boots.

What this changes is where to work next, not what is proven. The route we can see today to a report
runs through the paravisor, so the next milestone is a paravisor-mediated report on the NON-DEBUG
a7b0bd4 platform, through an interface implemented in our own pinned paravisor, with its signer
identified and its binding properties tested. See `../design/paravisor-attestation.md`.

Two further facts from the same log, recorded because they bear on any such design: there is no host
attestation agent (`no_rpc_server=true`), so key release cannot complete as configured; and the
vTPM allocates an NV index for an attestation report (`nv_index="1400001" size=0xb54`). Neither is a
claim about what is achievable, only about what this boot did.

Unchanged: `host_excluded=no`, E2 NOT complete, E3 NOT RUN with no instrument (and report testing
does not replace its missing evidence), no isolation proof, nothing here is verified capacity.

# Tooling canary, 05:03:38 UTC: the corrected cleanup code and the rebuilt launcher on hardware

**What this is:** a test of the TOOLS, not of isolation or attestation. It is one run of
`uefi-dev-boot.ps1` at `29ea63e5` (the closed review items: watchdog on the run's pid, run lock
before self-heal, held input handles, checked icacls, drained COM1) with `vbslike-host.exe`
`da16c20f` built from `daa61749`. Log: `uefi-dev-boot-20260925-050338.log`.

Configuration: type 1, CONTROL firmware `32d464cc`, production medium `ca245eae`, VBS opt-out,
1 vCPU, 2 GiB, hello-world served on relay port 19500. No host memory read: that work is parked.
The box was handed off to enclave-5d and enclave-53 before the run.

Verbatim from the run:

    05:04:04 medium verified: ...guest-production-uki7af57aab.iso (134594560 bytes) sha256 ca245eae... - held open, write and delete denied, until the VM is gone
    05:04:04 firmware verified: ...openhcl-cvm-a7b0bd4-CONTROL-32d464cc.bin (21732876 bytes) sha256 32d464cc... - held open, write and delete denied, until the VM is gone
    05:04:04 watchdog armed: it acts when pid 8328 ends without cleaning up, or after 1350s if this run hangs
    05:04:06 read access granted to the VM's own SID on the medium and the firmware (icacls exit 0 for both)
    05:04:12   CONSOLE: MON boundary tier=t0-hv vmpl=n/a vmpl_floor=n/a vmpl0=n/a host_excluded=no hv_isolation=vbs paravisor=no
    05:04:14   WMISERVE: {"isolationType":1,"note":"serving. This is a DEV path on a type-1 (VBS) partition: the hypervisor is CONFIGURED to keep VTL0 RAM host-private, which is a configuration and not a measurement. No host-side read has been shown to be refused here. Nothing here is host-excluded or verified capacity.","step":"ready"}
    05:04:16 APP OK: the app served EXACTLY the pinned bytes through the guest's own TLS
    05:04:16   ADMIN [18615] 'enclave-uefi-20260925-050338' VM guest state encryption key not released.
    05:04:17 removed enclave-uefi-20260925-050338
    05:04:17 SETTING RESTORED to Absent (verified)
    05:04:17 hv_sock service 00002329-facb-11e6-bd58-64006a7986d3 removed (verified)
    05:04:33 no app that answered on loopback before this run stopped answering
    05:04:33 RUN OK

Checked on the box afterwards (05:05 UTC):
- no VM, no sentinel, no watchdog-fired mark, no watchdog process, run lock free;
- `AllowFirmwareLoadFromFile` absent, the hv_sock report key absent;
- no ohcldiag-dev or vbslike-host process left.

The watchdog saw its run's process end after a clean finish and did nothing, as designed. Holding
the medium and firmware open with read-only sharing did not stop the VM from starting.

What the run shows, and nothing more:
- The corrected cleanup code works on a clean type-1 run.
- The rebuilt launcher states the partition it was given (`isolationType 1`), and its note says
  configuration, not measurement.
- The kill path (the watchdog acting after a killed run) was NOT exercised here.

What it does NOT show: host exclusion, attestation, or anything about E2 or E3.

Housekeeping: two per-run guest-state copies from the 04:03 and 04:12 runs were still in
`vbs-like\`. Those runs' cleanup had refused their own VMs (the ownership-marker collision fixed at
`c9c8cdcc`), and the VMs were removed by hand at the time; their copies were not. Both files were
moved, hash-verified, to `vbs-evidence\gueststate-20260925-040317.vmgs` (`8306e228...`) and
`gueststate-20260925-041231.vmgs` (`b4d3bb3d...`).

## Correction (2026-09-25 ~07:00Z): every JSON sent to the guest through hvdial lost its quotes

Windows PowerShell 5.1 strips embedded double quotes from an argument passed to a native program. Measured on
nucbox-k11 with node as the receiver:
- `'{"cmd":"destroy","id":1}'` arrives as `{cmd:destroy,id:1}`;
- escaped `\"`, it arrives intact.

Consequences:
- Every "state exchange" line in this record reads `{"error":"bad request: invalid character 'c' ..."}` because the
  monitor received broken JSON. "PROTOCOL OK" there meant only that the monitor ANSWERED, and the answer was a
  parse error.
- The host-read marker push (`{"cmd":"echo","marker":...}`) was sent the same way, so the marker was very likely
  never placed in guest memory on those runs.
- The type-16 reader-control verdict does NOT depend on the marker: it was VOID because the reader found neither
  the marker NOR the canary, a string the guest itself had printed. So the conclusion stands (that reader cannot
  see guest memory). But the marker half of that run was not a valid test, and it is recorded as such.
- The memory experiment stays parked; this changes nothing about it.

Fixed in `uefi-dev-boot.ps1`: every `--send` escapes quotes (`-replace '"','\"'`). This matters for the new
`-G1Check`, whose three destroys must reach the monitor as real JSON.
