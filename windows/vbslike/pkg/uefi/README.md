# The guest as a UEFI boot image

Research E8 (`../research/igvm-loading-2026-09-24.md`): on nucbox-k11 (10.0.26200.9457), Microsoft's **standard**
OpenHCL image starts, while a linux-direct one does not, Microsoft's included. So the same guest is delivered as a
standard UEFI payload under the standard image:

- the same WSL kernel, which carries an EFI stub;
- the same isolation/m3 monitor initrd;
- the same command line, runtime identity, app identity and guest-held TLS.

Ownership:

| part | owner |
|---|---|
| the guest's boot requirements | enclave-5d |
| this builder and its packaging | enclave-53 |
| the host and the VM definition | enclave-d1 |

## `build-uefi-image.sh`

It builds a Unified Kernel Image (systemd-stub with `.osrel`, `.cmdline`, `.initrd` and `.linux`) and places it at
`\EFI\BOOT\BOOTX64.EFI` on a FAT32 ESP. The ESP is the only partition of a GPT disk with fixed GUIDs, and the disk is
wrapped in a VHDX for a Gen2 SCSI boot. Microsoft's documentation says Gen2 boots "from a SCSI virtual hard disk
(.VHDX) or virtual DVD (.ISO)".

The pinned identity is `disk.raw`. The VHDX's header GUIDs are random, so its bytes differ between builds. The builder
converts it back and requires the payload to be `disk.raw` byte for byte. `--check` builds twice and requires
`uki.efi`, `esp.img` and `disk.raw` to be identical. The builder needs no root, starts no VM, and writes only its output
directory.

**Tools.** It uses objcopy, sfdisk, mkfs.fat and qemu-img from the host, plus GNU mtools 4.0.49 built locally from
`mtools-4.0.49.tar.gz` (sha256 `10cd1111da87bf2400a380c1639a6cba8bfb937a24f9c51f5f88d393ae5f6f76`). Its GPG signature
was NOT verified, because the signer's key is not in the local keyring.

## Measured 2026-09-25 (`evidence/`)

**The build** (`build-2026-09-25.json`). Inputs:

- the WSL kernel `7fe3edb5…`;
- the monitor initrd `4610d594…` (enclave-5d, aef54ff7);
- systemd 261.2's `linuxx64.efi.stub` `2d9b8073…`;
- the command line `console=ttyS0 rdinit=/init loglevel=3 report_host=9001`.

Two builds gave identical outputs:

| output | sha256 |
|---|---|
| `uki.efi` | `8b531361ec433ef971aeaaeb88d4f0b37813d769b997acda9b0116fa711f72ad` |
| `esp.img` | `ba22ec6b2a14493b2950390c6bce5360d5c4533b4ca5bfc567729a6c67ed2b91` |
| `disk.raw` | `aec1e2017808dc2efc29838064f6fdf0d6fbeafdebd36731a849e5cf58c62009` |

**The boot chain, on KVM with OVMF: DEVELOPMENT EVIDENCE ONLY** (`ovmf-kvm-smoke-2026-09-25.serial.txt`). QEMU q35,
1 vCPU, 1 GiB, the disk read-only, no network:

1. OVMF boots `BOOTX64.EFI`.
2. The EFI stub loads the initrd from `LINUX_EFI_INITRD_MEDIA_GUID`.
3. The kernel starts, and the unchanged monitor prints `MON boundary tier=t0-hv … host_excluded=no` and `MON ready
   control_port=9000 snp=false`, the lines it prints in an HCS partition.

This is NOT Hyper-V and NOT OpenHCL. The monitor's host channel (hv_sock) was not exercised, and nothing was loaded or
served. Whether this disk boots under Microsoft's standard OpenHCL image on the NucBox has not been tried. That run is
enclave-d1's, after enclave-5d's interface split.
