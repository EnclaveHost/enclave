# The approved firmware runs, 2026-09-24

> **CORRECTION, recorded after the fact.** An earlier version of this file, and the commit message
> at `f3c3bb7d`, said our paravisor "starts". That was wrong in substance and is withdrawn.
> `HcsStartComputeSystem` returns success and then the VM worker process crashes, so no isolated
> partition has actually run on this host. See "What start ok really means" below.
>
> **Also corrected: which image.** Runs 1-4 used the UPSTREAM test payload
> `openhcl-x64-test-linux-direct.bin` (92,924,756 bytes, sha256 `d240f40c...`), not our monitor
> image. PHASE2.md names our own-guest build, and runs 5 and 6 used it:
> `openhcl-ownguest.bin`, 124,962,164 bytes, sha256
> `2d7353760b89b81b6f47759382bb2e83c325d73ed0825734f30fc4051183dfb3`. The wrapper now prints the
> image path and hash into every run's transcript so this cannot go unrecorded again.

Two bounded runs of `ops/isolated-probe.ps1 -Approve` on nucbox-k11. Steven authorised the
host-wide setting as part of bringing the new isolation backend into the hosting path. The setting
was applied for the length of each probe and restored to ABSENT afterwards, status, value and type
verified; the live node was checked before and after each run and was unchanged; the probe created
and destroyed only its own partitions. Raw evidence beside this file.

## What the setting changed

`AllowFirmwareLoadFromFile` was the wall, and it is not any more.

| run | shape | result |
|---|---|---|
| before (unapproved) | VBS + `IgvmFilePath` | create refused `0x80070032` — not supported |
| 11:35 approved | VBS + `IgvmFilePath`, no guest state | create refused `0x80070057`, attributed to the device **"Microsoft Guest Runtime State"** failing to Initialize |
| 11:38 approved | VBS + `IgvmFilePath` + an empty VMGS | **create ok**; start refused `0x80070490` "Element not found" |
| 11:38 approved | the same, plus `EnableTpm` | create ok; start `0x80070490` |
| 11:38 approved | GuestStateOnly + `IgvmFilePath` + empty VMGS | create ok; start `0x80070490` |
| 11:38 approved | VBS + empty VMGS, **in-box** paravisor (control) | **create ok, start ok** (962 ms), then the worker exits `0xC0000005` with an empty console — an empty guest state has nothing to boot |

Three things follow, and the third is the open one.

1. **An isolated VBS partition starts on this box.** The control proves it: same isolation type,
   same guest-state device, the host's own paravisor, and it starts. The hardware and the host
   support the shape.
2. **The guest-state device is mandatory.** The first approved run failed at Construct because the
   document declared no `GuestState`, which no row had ever combined with a custom IGVM: the IGVM
   rows carried no VMGS and the VMGS rows carried no IGVM, because while the firmware path was
   refused outright the combination had no reason to exist. Added as
   `vbs-igvmpath-emptyvmgs` and two comparisons.
3. **Our own IGVM is accepted at create and refused at start**, identically under VBS, VBS+TPM and
   GuestStateOnly. `0x80070490` is "Element not found", and it is the host that cannot find
   something, not the guest failing to boot — the partition never runs.

## What the image actually declares

Parsed from the file's own headers rather than assumed:

```
magic IGVM, format_version 1, total_file_size 92,924,756
SUPPORTED_PLATFORM x1:  highest_vtl=2  platform_type=1 (VSM_ISOLATION / VBS)  compatibility_mask=0x1
directives: PAGE_DATA and friends (0x301-0x312), PARAMETER_INSERT x1, VP_CONTEXT x1
```

So the image is the right KIND: a VBS-isolation IGVM with VTL2, which is what an OpenHCL paravisor
should be. It declares exactly one platform, at compatibility mask `0x1`. That single mask is the
most likely reading of "Element not found": the worker selects a platform configuration and finds
no header matching it. That is a hypothesis with a cheap next test, not a conclusion.

## IT STARTS (runs 3 and 4, 11:41 and 11:42)

`FirmwareFile.Parameters` was the missing element. Without a `FirmwareFile` block the worker has no
firmware element to attach the IGVM to, and `HcsStartComputeSystem` returns `0x80070490`. With one,
a VBS-isolated partition running **our own paravisor image, loaded by path** creates and starts:

| shape | result |
|---|---|
| VBS + IgvmFilePath + empty VMGS + Uefi + `FirmwareFile.Parameters` | **create ok, start ok, 961 ms** |
| the same with `OPENHCL_BOOT_LOG=com2` | create ok, start ok, 949 ms |
| the same with `OPENHCL_BOOT_LOG=com1` | create ok, start ok, 949 ms |
| VBS + LinuxKernelDirect + IgvmFilePath + empty VMGS | start `0x80070490` — the direct-boot chipset is not the answer; the firmware block is |
| ... + HclEnabled | start `0x80070490` |
| VBS + IgvmFilePath + TRANSIENT guest state (no file) | create `0x80070057` on the guest-state device — a VMGS FILE is required, an in-memory declaration is not |

Three runs, three starts, ~950 ms each. That is the new isolation backend launching on this box for
the first time.

**It starts and says nothing.** Both COM ports capture 0 bytes and the worker exits with the same
`UnexpectedExit` the in-box control shows on an empty guest state. So "start ok" means the host
accepted and ran our image, not that the paravisor booted. The two likely reasons, in order: the
partition is sized at 1024 MB, which is small for a VTL2 paravisor plus a VTL0 guest, and VTL0 has
nothing to boot from an empty VMGS.

## Next concrete milestone

Make our paravisor START in an isolated partition. In order of cost:

1. **Make the paravisor speak.** Raise the partition's memory well above 1024 MB and re-run the
   shape that starts, watching COM2. A boot log is the difference between "the host ran our image"
   and "our paravisor is alive".
2. **Give VTL0 something to boot**, so the partition does more than start and stop: the monitor
   initrd this lab already builds, reached through the paravisor rather than through
   LinuxKernelDirect.
3. **hv_sock from inside**, which is the existing launcher's transport, to prove the guest is
   addressable.
4. **Only then** wire this backend into the node's app path, behind an explicitly unverified
   development status, with a user-owned canary first.

## What is NOT true yet

No app runs on this backend. The node still serves its five apps on the existing path, whose
isolation contract this box does not meet. Nothing here is verified protection and nothing here is
advertised as eligible tenant capacity.


## What `start ok` really means (runs 5 and 6)

Our own-guest image behaves exactly like the upstream one: create ok, start ok, 1094 and 1103 ms at
4096 MB, both COM ports empty. The emptiness is not the guest being quiet.

```
Faulting application name: vmwp.exe,      version 10.0.26100.9278
Faulting module name:      vmchipset.dll, version 10.0.26100.9278
Exception code: 0xc0000005    Fault offset: 0x000000000006e31c
```

Eleven of these in the log, one fault bucket (1868582954261880381), the oldest at 2026-09-23 16:05
alongside the first VMGS experiments. **The in-box paravisor crashes the same way.** So
`HcsStartComputeSystem` returning success means the call was accepted, not that anything ran: the
worker process faults immediately inside Microsoft's own chipset module and dies, which is why the
console is empty and why the exit is `UnexpectedExit` with `0xC0000005`.

Nothing has executed inside an isolated partition on this box.

## The chipset is not optional either

The faulting module describes the chipset, and an isolated partition takes its firmware from its
IGVM, so the obvious move was to send no `Chipset` node. Both shapes are refused at Construct with
`0x8037010d`, "the virtual machine or container JSON document is invalid" - with our IGVM and
without it. A Chipset node is mandatory, so the crashing path cannot be avoided from the document.

## The actual blocker

A reproducible access violation in `vmchipset.dll` on Windows 10.0.26100.9278 when starting any
VBS-isolated partition with a guest-state file, ours or the host's own. It is not our image and it
is not our document shape - both were varied and the crash did not move.

Two ways forward, and the first is not mine to take:

1. **Servicing.** The host is at 10.0.26100.9278. A cumulative update is the obvious candidate for
   a null dereference in a shipped module, and it needs an update and a reboot - both outside what
   this work is permitted to do.
2. **A supported reference.** Create an isolated VM through Hyper-V's own tooling and capture the
   configuration it produces. If Microsoft's own path also crashes, the build is the answer and
   point 1 is the only route. If it starts, the difference is in our document and is findable by
   diffing the two.

Point 2 is the next thing to run and needs no new approval; point 1 needs Steven.


## Settled: it is the host, not us (run 7, no approval needed)

The firmware setting was not involved in this run - rows that use no custom IGVM need it, so the
launcher was called directly, creating and destroying only its own partitions exactly as the
phase-1 lab does.

| shape | create | start | new vmwp crash |
|---|---|---|---|
| VBS + UEFI, no guest state | `0x80070057` | - | - |
| VBS + UEFI + TRANSIENT guest state | `0x80070057` | - | - |
| GuestStateOnly + UEFI + transient guest state | `0x80070057` | - | - |
| VBS + an empty VMGS **file**, in-box paravisor | ok | ok, 1005 ms | **+1** |

Two facts, and together they close the question.

1. **A VMGS file is mandatory.** Nothing isolated constructs without one; a transient in-memory
   declaration is refused at Construct. So every creatable isolated partition on this host has a
   VMGS-backed guest state.
2. **Every isolated partition that starts crashes the worker.** The crash count moved by exactly
   one, for exactly the one row that started, and that row uses Microsoft's own in-box paravisor
   and no custom firmware at all.

So the fault is 1:1 with starting an isolated partition, and there is no configuration on this host
that both creates and survives. It is not our IGVM, not our document, and not the firmware setting:
all three were removed from the experiment and the crash stayed.

## The decision this needs

`vmwp.exe` / `vmchipset.dll` 10.0.26100.9278 faults on every isolated-partition start. The remaining
route is host servicing - a cumulative update and a reboot - which this work is not permitted to do
and which is Steven's call. Until then the Hyper-V per-app isolation backend cannot run on this box,
and the Linux SNP tier (`snp-guest-per-app`) is the one going live.

The backend contract is already agreed with that lane so the Windows side is a drop-in when the host
can run a partition: backend name `hyperv-partition-per-app`, attestation format
`hyperv-vbs-partition-v1` as a sibling branch in the judge, and everything else - derivation,
policy, control plane, TLS splice - identical.
