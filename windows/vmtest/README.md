# Unattended Windows 11 VBS dry run

Boots a Windows 11 guest with no interaction, enables Hyper-V, runs
`probe/Test-EnclaveHost.ps1 -Attempt -IsolationType VBS`, streams the transcript
out the serial port, and powers off.

```sh
./run-vmtest.sh --iso /path/to/Win11_24H2_English_x64.iso
tail -f run/serial.log        # from another shell
```

## What this answers, and what it does not

**Answers:** does `vmms` accept a custom IGVM -- `FirmwareFile` +
`GuestFeatureSet` written through `ModifySystemSettings` -- on a VM created with
an isolation type? That is the same acceptance path SNP uses, so a refusal here
is very likely a refusal there. It also **executes the probe for the first
time**, which is worth as much: the script has never run anywhere.

**Does not answer:**

- **Anything about security.** VBS leaves guest DRAM in plaintext. It is a
  harness, not a configuration. The production requirement is unchanged: EPYC
  Milan+ or Xeon SPR+, `EnableHardwareIsolation=1`, RMP coverage off,
  `SnpStatus=1`.
- **Whether SNP will be accepted.** `vmms` could gate `FirmwareFile` per
  isolation type. VBS passing while SNP refuses is a coherent outcome.

## The nesting caveat, stated up front

This runs Hyper-V inside KVM: L0 is KVM on the host, L1 is Windows, L2 is the
isolated VM. Nested virtualisation is exposed with `-cpu host`, and the script
refuses to start if `kvm_*.nested` is off.

**A pass is meaningful. A failure is ambiguous** -- it may be the nesting rather
than the mechanism. If a bare-metal Windows 11 24H2 machine is available (any
laptop), run the probe there instead and skip this entirely; it is strictly
better evidence for the same cost.

## You have to supply the ISO

The one step that is not automated. Microsoft serves the consumer ISO through a
session-bound API that returns the generic page to datacenter IP ranges, and the
Evaluation Center requires a registration form with personal details. Neither is
something to script on someone's behalf.

Get a **Windows 11 24H2 x64** ISO by either route:

- <https://www.microsoft.com/software-download/windows11> ("Download disk image
  (ISO)") from an ordinary connection, or
- <https://www.microsoft.com/evalcenter/download-windows-11-enterprise> for the
  90-day Enterprise evaluation.

Build 26100 or later is required -- that is the floor for the custom-IGVM path
(`AllowFirmwareLoadFromFile` and `LoadClientHclFirmware` are absent from 23H2's
`vmwp.exe`). Windows 10 will not work: its `vmwp.exe` has no IGVM loader at all.

If the ISO offers editions, the answer file selects **Windows 11 Pro**. Change
`/IMAGE/NAME` in `autounattend.xml` to test another.

## Files

| file | role |
|---|---|
| `autounattend.xml` | unattended install; bypasses the TPM/SecureBoot/RAM gates (no swtpm on this host, and nothing tested needs a TPM), creates a local admin, enables Hyper-V, sets `AllowFirmwareLoadFromFile`, reboots into stage 2 |
| `stage2.ps1` | runs after that reboot: waits for the Hyper-V module, dumps `Get-VMHost`, runs the probe in VBS mode, then again in inspection-only SNP mode for contrast, streams everything to COM1, shuts down |
| `run-vmtest.sh` | builds the answer ISO, creates the disk, boots QEMU headless with UEFI + nested virt, captures serial, prints the transcript |

## Host requirements

Checked by the script: `/dev/kvm`, `qemu-system-x86_64`, `xorriso`, OVMF
firmware, and `kvm_*.nested=1`. No root, no package installs, no swtpm.

Defaults are 8 GB RAM / 4 vCPUs / 64 GB disk -- deliberately modest so it does
not contend with anything else on the box. Override with `--ram`, `--cpus`,
`--disk`.

## If it does not finish

`run/serial.log` has everything from firmware onward. The most common causes are
an ISO older than 26100, an edition name that does not match `/IMAGE/NAME`, or
the install stalling on a prompt the answer file did not cover. To watch it
happen, change `-display none` to `-display gtk` in `run-vmtest.sh`.
