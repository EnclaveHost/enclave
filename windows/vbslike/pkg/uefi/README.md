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

## The UKI follows enclave-5d's spec, reproduced two ways

The spec is `isolation/m3/UEFI-BOOT.md` at acfdddac:

- sections in the order `.osrel`, `.cmdline`, `.linux`, `.initrd`, with a fixed `.osrel`;
- `SOURCE_DATE_EPOCH=0` for objcopy, which pins the PE TimeDateStamp;
- exactly one file on the ESP.

This builder assembles the UKI independently. With `--uki-recipe`, it also runs 5d's own `build-uki.sh` (pinned by
commit) and refuses unless the two are byte-identical.

## Measured 2026-09-25 (`evidence/`)

**The build** (`build-2026-09-25.json`). Inputs:

- the WSL kernel `7fe3edb5…`;
- the monitor initrd `4610d594…` (enclave-5d, aef54ff7);
- systemd 261.2's `linuxx64.efi.stub` `2d9b8073…`;
- the command line `console=ttyS0 rdinit=/init loglevel=3 report_host=9001` (sha256 `c99a16ae…`).

| output | sha256 |
|---|---|
| `uki.efi` | `a1fdb5c3e973accc2f04bfecce7fb22cfdcfcf7568244350328ec6436a1a87b1`, 40,045,056 B |
| `esp.img` | `9bea1b683845083383c2e08c94c5a5550d5e64d71fb20ac9ae3dee756ac9945e` |
| `disk.raw` | `04898f098ab9e464ee5be9771926812a6f8236940403492019a7538aa6efe4a7` |

`uki.efi` is the hash enclave-5d predicted from `build-uki.sh`. Both assemblies produce it, and two builds of all three
outputs were identical.

**The boot chain, on KVM with OVMF: DEVELOPMENT EVIDENCE ONLY** (`ovmf-kvm-smoke-2026-09-25.serial.txt`, this
`disk.raw`). QEMU q35, 1 vCPU, 1 GiB, the disk read-only, no network:

1. OVMF boots `BOOTX64.EFI`.
2. The EFI stub loads the initrd from `LINUX_EFI_INITRD_MEDIA_GUID`.
3. The kernel starts, and the unchanged monitor prints `MON boundary tier=t0-hv … host_excluded=no` and `MON ready
   control_port=9000 snp=false`.

This is NOT Hyper-V and NOT OpenHCL. The monitor's host channel (hv_sock) was not exercised, and nothing was loaded or
served. Whether this disk boots under Microsoft's standard OpenHCL image on the NucBox has not been tried. That run is
enclave-d1's.

## Not yet measured under UEFI on the NucBox (the list enclave-99 reviews)

1. Microsoft's standard `openhcl.bin` (`48773995…`) with THIS disk attached. It has only been started with no disk.
2. OpenHCL's VTL0 UEFI finding `\EFI\BOOT\BOOTX64.EFI` on this GPT/FAT32 ESP, from a SCSI VHDX (or a DVD ISO).
3. The unsigned UKI with Secure Boot off (the VM definition turns it off), and systemd 261.2's stub under Hyper-V's
   UEFI.
4. The WSL kernel booting through its EFI stub in VTL0 under OpenHCL. Until now it booted only by LinuxKernelDirect
   under HCS.
5. VMBus and hv_sock through OpenHCL's relay to VTL0. These are the monitor's only channel: control 9000, signing 9001,
   and the domain's port.
6. What loads a bundle into such a VM, and relays to it: `vbslike-host lab` creates HCS partitions only, and the
   datapath route is not wired to a WMI VM.
7. The COM1 console through OpenHCL, the only way to see `MON` lines on the box.
8. The launcher's `partition.guestImageSha256` on this path. 5d proposes the UKI's sha256, with its composition
   published beside it; the launcher reports the initrd's today.
9. Hyper-V accepting this VHDX (qemu-img, dynamic).
