# Host prerequisite for a custom paravisor image: for review, NOT applied

Scope of this file: the NucBox K11 lab. Phase 2 established that the isolated HCS modes construct and
start on this host with no host-wide change, and that naming **our own** firmware image by path is
refused (`0x80070032`, "the request is not supported"). One documented setting lifts that refusal.
This is the review artifact for it. Nothing here has been run; the value is absent on the box as of
2026-09-23 and stays absent until Steven decides otherwise.

## The setting, and what it actually permits

| | |
|---|---|
| Value | `AllowFirmwareLoadFromFile`, REG_DWORD, under `HKLM\Software\Microsoft\Windows NT\CurrentVersion\Virtualization` |
| Current state | **absent** (read-only check 2026-09-23: `reg query` reports the value is not found; the key exists and holds only `CompatibleVmVersion`, `CurrentVmVersion`, `MaximumMacAddress`, `MetricsFlushInterval`, `MinimumImportVmVersion`, `MinimumMacAddress`, `ServicingVersion`, `Version`) |
| Source | Microsoft's OpenVMM guide, `user_guide/openhcl/run/hyperv.md`, "Enable loading from developer file"; the same value appears in OpenVMM's CI host preparation |
| **What it permits** | the VM worker to load a guest firmware image **from a file the VM configuration names, and that image does not have to be signed**. The guide's own words are that it "enables loading unsigned images", and it says to run it as administrator once before starting the VM. It is a relaxation of which firmware the host will accept, not a per-VM capability |
| **Scope** | **host-wide, for every VM created while it is set**, not only this lab's. Any caller able to create a VM on this host, now or later, can point it at firmware of their choosing while the value is 1. The lab's own partitions are the only VMs we would point at a custom image, but that is a statement about our intent, not a limit the setting imposes |
| Reboot | not called for; the value is read when a VM is constructed |
| Not required | the Hyper-V role, the Windows Hypervisor Platform feature, `EnableHardwareIsolation` (an SNP/TDX host setting), Secure Boot, BitLocker or boot changes. Phase 2 constructed and started isolated partitions with none of them |

## Why the exposure is bounded by procedure rather than by the setting

The setting cannot be scoped to one VM, so the bounding is in how long it is set and what else is
running. `ops/isolated-probe.ps1` is the reviewable procedure: it applies the value, runs one probe,
and restores the prior state in a `finally` block that runs on success, on a failed preflight, on a
probe timeout, on an unhandled error and on Ctrl-C; it verifies the restoration by reading the value
back and reports loudly if it did not take. Without `-Approve` it performs the preflight, changes
nothing, and prints what it would have done. That is how it has been run so far: two validation runs on
2026-09-23 (`evidence/host-prereq-preflight-2026-09-23.txt`), one where the preflight passed all six
checks and one where it was given a wrong image hash. Both ended with the setting verified ABSENT, zero
lab partitions and the live node unchanged, and the second proves the restoration path runs when the
preflight fails.

Its preflight refuses to go on unless: the session is elevated; the live node's task is Running and
its processes are present; **no** compute system owned by `vbslike` already exists; the image is
present and its SHA-256 equals the expected value; and the VM worker account can read the image
(measured earlier: without that ACE a start fails `0x80070005`, which would look like a finding about
the setting and would not be one). Afterwards it re-checks the live node and counts any lab partition
left behind.

What the script never does: it creates, modifies or deletes no VM other than the partitions the probe
itself makes and destroys; it does not enumerate or inspect other VMs; it changes no Windows feature,
boot, BitLocker or driver state; it reboots nothing; it does not touch the live node.

## Commands, for review

Apply (what `-Approve` runs, elevated):

```powershell
Set-ItemProperty "HKLM:\Software\Microsoft\Windows NT\CurrentVersion\Virtualization" `
  -Name AllowFirmwareLoadFromFile -Value 1 -Type DWORD
```

Restore (what the `finally` block runs; the value is absent today, so restoring means removing it):

```powershell
Remove-ItemProperty "HKLM:\Software\Microsoft\Windows NT\CurrentVersion\Virtualization" `
  -Name AllowFirmwareLoadFromFile
```

## The image the probe would load

`openhcl-x64-test-linux-direct.bin`, sha256
`d240f40c53eb6fa016caaea9357dafbfea2048f18851a38f928fe25792df2864`, built from
github.com/microsoft/openvmm at commit `a7b0bd4` (provenance in PHASE2.md); one supported platform,
`VSM_ISOLATION`, highest VTL 2. Staged on the box at `C:\Users\claude\vbs-like\` with read access for
the VM worker account. Its VTL0 is still the OpenVMM project's test kernel and initrd; an image whose
VTL0 is our own guest is a separate `igvmfilegen` manifest run and is not built yet.

## What approving it would and would not establish

It would let one partition attempt to boot our paravisor image, and the probe's create step succeeding
is the whole first signal. It would establish nothing about memory exclusion by itself: whether a
paravisor at VTL2 keeps the root partition out of a partition's memory on this hardware is the open
question, and no claim of host exclusion or operator confidentiality is made for this tier until an
image boots here and that property is demonstrated. Today's tier remains `T0-hv`: a lab baseline whose
reports are signed by a launcher running in the root partition, with `hostExcluded: false` in every
record.
