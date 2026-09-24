# The approved firmware runs, 2026-09-24

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
