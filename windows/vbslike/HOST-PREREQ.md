# Host prerequisite for a custom paravisor image: for review, NOT applied

Scope: the NucBox K11 lab only (`C:\Users\claude\vbs-like`). Phase 2 established that the isolated HCS
modes construct and start on this host with no host-wide change, but that naming **our own** firmware
image by path is refused (`0x80070032`, "the request is not supported"). One documented setting closes
that gap. This file is the review artifact for it. Nothing here has been run, and I will not run it
without Steven's explicit instruction.

## The setting

| | |
|---|---|
| Value | `AllowFirmwareLoadFromFile`, REG_DWORD, under `HKLM\Software\Microsoft\Windows NT\CurrentVersion\Virtualization` |
| Current state | **absent** (verified read-only 2026-09-23: `reg query` returns "unable to find the specified registry key or value"; the key itself exists and holds only `CompatibleVmVersion`, `CurrentVmVersion`, `MaximumMacAddress`, `MetricsFlushInterval`, `MinimumImportVmVersion`, `MinimumMacAddress`, `ServicingVersion`, `Version`) |
| Source | Microsoft's OpenVMM guide, `user_guide/openhcl/run/hyperv.md`, "Enable loading from developer file"; the same value appears in OpenVMM's own CI host preparation |
| Effect | the VM worker process may load a guest firmware image named by a VM's configuration, instead of only the in-box one. It applies to VMs created afterwards |
| Scope of effect | host-wide for Hyper-V VM creation, so it is not confined to our lab VMs; that is why it needs review rather than a decision by me |
| Reboot | not called for by the guide; the value is read when a VM is constructed, not at boot |
| Not required | the Hyper-V role, the Windows Hypervisor Platform feature, `EnableHardwareIsolation` (an SNP/TDX-host setting), Secure Boot, BitLocker or boot configuration changes. Phase 2 constructed and started isolated partitions with none of them |

## Command, and its rollback

Elevated PowerShell on the NucBox. Apply:

```powershell
Set-ItemProperty "HKLM:\Software\Microsoft\Windows NT\CurrentVersion\Virtualization" `
  -Name AllowFirmwareLoadFromFile -Value 1 -Type DWORD
```

Roll back (returns the host to today's state exactly, since the value is absent now):

```powershell
Remove-ItemProperty "HKLM:\Software\Microsoft\Windows NT\CurrentVersion\Virtualization" `
  -Name AllowFirmwareLoadFromFile
```

## Affected VMs

Only the lab's own partitions: compute systems this launcher creates, named `vbslike-*` and owned by
`vbslike`, from `C:\Users\claude\vbs-like`. The firmware image would be
`C:\Users\claude\vbs-like\inbox.igvm` (the in-box paravisor extracted for inspection) or our built
`openhcl-x64-test-linux-direct.bin` (sha256 `d240f40c…`, provenance in PHASE2.md). The live node
(`EnclaveWindowsNode`, `C:\Users\claude\vbs\ee` and `vbs\node`) creates no Hyper-V VMs and is not
affected; it stays untouched either way.

## Preflight and acceptance, if it is ever approved

1. Record the value's current absence again, and that the live node's task is Running.
2. Confirm no lab partition exists (`vbslike-host probe` lists none owned by `vbslike`).
3. Apply, then `vbslike-host isoprobe --only vbs-igvmpath` with our image: the create step succeeding
   is the whole acceptance signal; a start and console output would be the next step.
4. Roll back immediately after the probe unless the isolated tier is being taken further that session.
5. Record both the before and after states in `evidence/`.

## What it does not buy

Nothing about this setting makes a partition's memory unreadable by the root partition on this
hardware, and nothing in it changes what the T0-hv reports say. It permits a custom paravisor image to
be loaded; whether that paravisor then excludes the root partition is the separate question Phase 2
exists to answer, and it is unanswered until such an image boots here.
