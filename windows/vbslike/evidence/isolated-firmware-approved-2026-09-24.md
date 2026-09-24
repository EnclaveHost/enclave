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

## Next concrete milestone

Make our paravisor START in an isolated partition. In order of cost:

1. Vary what the host selects and see whether any combination matches mask `0x1`: `HclEnabled`,
   `FirmwareFile.Parameters`, the chipset (UEFI vs direct boot), and the VTL2 memory declaration.
   All are document-side and need one more approved run.
2. If nothing matches, rebuild the IGVM with `igvmfilegen` declaring the platform set this host
   asks for, and compare against the in-box paravisor's own headers as the reference.
3. Only then wire the backend into the node's app path behind an explicitly unverified status.

## What is NOT true yet

No app runs on this backend. The node still serves its five apps on the existing path, whose
isolation contract this box does not meet. Nothing here is verified protection and nothing here is
advertised as eligible tenant capacity.
