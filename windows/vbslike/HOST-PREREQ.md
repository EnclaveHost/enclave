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

The setting cannot be scoped to one VM, so the bounding is in how long it is set. `ops/isolated-probe.ps1`
applies the value, runs one probe, and restores the prior state. `ops/isolated-probe.lib.ps1` holds the
decisions AND the cleanup orchestration as functions over injected values, and
`ops/isolated-probe.tests.ps1` exercises each failure path against mocked inputs: **47 cases, all
passing** on the box, plus `ops/isolated-probe.exit.tests.ps1`, **6 cases**, which invoke the script
itself and check its process exit status: a clean read-only run exits 0, a failed preflight exits
non-zero, and a failing run is shown to have attempted its cleanup and verified the live node before
exiting. They include the orchestration ones (a reap that throws, reports failure or returns
nonsense; a restoration that throws or leaves the wrong state; all three steps failing at once; a
read-only run proving it neither reaps nor writes).

What the preflight establishes, and why each is strict rather than convenient:

| check | why it is written the way it is |
|---|---|
| elevated | otherwise the probe's own partition creation fails for an unrelated reason |
| the setting reads as **Absent, Present or Error**, and Error stops the run | an unreadable value must never be mistaken for an absent one: "restoring" that would delete it |
| the live node's task is Running with its processes present | the run must start from a healthy host and leave it that way |
| the launcher's enumeration **exited 0, parsed, and reported success**, and every entry has a usable Id and Owner | counting owner strings in whatever came back would treat a crashed or malformed probe as "no partitions exist", which is the dangerous direction |
| no compute system owned by `vbslike` exists | the probe starts from nothing of ours |
| the image's SHA-256 equals the expected value | the bytes whose provenance PHASE2.md records, and no others |
| the VM worker account is **allowed to read it, with no Deny covering read** | any ACE is not permission; without effective read a start fails `0x80070005`, which would look like a finding about the setting and would not be one |

Cleanup is ordered so that no step can prevent the next. A review found that with
`$ErrorActionPreference = 'Stop'` a `Write-Error` in the reap step terminated the whole `finally` block
and the registry was never restored, which is the one outcome this script exists to prevent; restoration
now runs in its own nested `finally`, every failure is collected rather than thrown, and all of them are
reported only after restoration and the live-node check have each been attempted. The run's **exit
status** then says what happened: `Write-Error -ErrorAction Continue` leaves the process status at 0, so
a caller checking status would read a failed run as a success. The script's last statement exits
non-zero when anything failed, counting the probe's own outcome -- a non-zero exit, or a timeout that
had to be killed -- as a failure of the run even when the cleanup afterwards was perfect.

Restoration is equally strict. A write in the cleanup block is licensed **only by this run having made
one**: without `-Approve` the script writes nothing at all, and instead verifies the state still matches
what the preflight read, reporting if something else on the host changed it. When it did apply the
value, restoration compares **status, value and registry type**, since a value restored as the wrong
kind is a changed host.

If a probe has to be killed on a timeout, the partition it created could outlive it. The cleanup runs
`vbslike-host reap --prefix vbslike-iso-<pid>-`, which acts only on compute systems whose Owner is
`vbslike` **and** whose Id carries that exact prefix, both checked in the launcher; it refuses a prefix
that does not name one run, and a failure to reap is reported as a failure rather than passed over. No
other virtual machine on the host is enumerated for action, opened or touched.

## What the cleanup does NOT cover

`finally` runs on a normal return, a thrown error, a failed preflight and a probe timeout. It does
**not** run if the PowerShell process is killed (`Stop-Process`, `taskkill`, a crash) or on power loss,
and Ctrl-C during a wait on a native child is not guaranteed either. With `-Approve`, that would leave
the setting applied. The recovery is manual and is the reason this file names the value and its removal
command explicitly: check `Get-ItemProperty ... -Name AllowFirmwareLoadFromFile` and remove it. That is
a residual risk of approving the run, not a case the script handles.

Run so far on the box, all without `-Approve` and all leaving the value ABSENT: the preflight passing
every check, a deliberately wrong image hash, and the reap guards (a prefix that does not name one run
is refused; a valid prefix with nothing to match returns an empty, successful result). Evidence:
`evidence/host-prereq-preflight-2026-09-23.txt`.

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

Two images are staged on the box, both readable by the VM worker account and both hash-verified there.
The probe should use the second: the first carries the OpenVMM project's test kernel in VTL0 and would
say nothing about our guest.

| | sha256 | VTL0 |
|---|---|---|
| `openhcl-x64-test-linux-direct.bin` | `d240f40c…` | the OpenVMM project's test kernel and initrd |
| `openhcl-ownguest.bin` | `2d735376…` | **our own guest**: the isolation/m3 monitor image (`mon.cpio.gz`, `44abb52b…`) on the ELF vmlinux recovered from the box's own WSL kernel (build id `188d2a27…`, version 6.6.87.2-microsoft-standard-WSL2) |

Both come from github.com/microsoft/openvmm at commit `a7b0bd4`; provenance and the build are in
PHASE2.md and `igvm/`. The own-guest image is byte-reproducible across builds. Neither has been
launched, which is what the setting would allow.

## What approving it would and would not establish

It would let one partition attempt to boot our paravisor image, and the probe's create step succeeding
is the whole first signal. It would establish nothing about memory exclusion by itself: whether a
paravisor at VTL2 keeps the root partition out of a partition's memory on this hardware is the open
question, and no claim of host exclusion or operator confidentiality is made for this tier until an
image boots here and that property is demonstrated. Today's tier remains `T0-hv`: a lab baseline whose
reports are signed by a launcher running in the root partition, with `hostExcluded: false` in every
record.
