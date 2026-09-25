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

Both assemblies use the SAME toolchain (GNU objcopy 2.47, on warden-host). Their agreement therefore shows that the spec
is read identically. It is NOT evidence that the build is deterministic across toolchains (enclave-99's review). The UKI's
bytes depend on:

- the four inputs;
- the `.osrel` text;
- the objcopy version;
- `SOURCE_DATE_EPOCH=0`.

## The boot medium is the ISO, and its hash is the identity

enclave-d1 chose a read-only DVD ISO: the guest cannot write it, as a fact of the device rather than a convention.
`disk.vhdx` is kept as a pinned FALLBACK.

enclave-99 (UEFI-BOOT-REVIEW.md) recommends that the launcher sign the hash of the MEDIUM it attaches, not the UKI's.
With Secure Boot off, the pinned systemd-stub also honours an invocation command line (which replaces `.cmdline`), an
SMBIOS type-11 `io.systemd.stub.kernel-cmdline-extra`, and ESP side-files: `*.addon.efi`, credentials, sysext and
confext, `\loader\addons`. These can extend the command line or add an initrd. Only a medium hash proves that the ESP
holds exactly one file.

`guest.iso` is reproducible, so its hash is directly that identity, with no convert-back step. The UKI and its
composition sit beside it.

The El Torito layout is MEASURED (OVMF on KVM):

- `efiboot.img` (= `esp.img`) is inside the ISO 9660 volume, and the El Torito EFI no-emulation entry points at it.
  This boots.
- The ESP appended as a GPT partition OUTSIDE the volume fails with `Not Found` at the CD-ROM. The catalog's sector
  count is 0 for an image over 32 MiB, and EDK2 then takes the rest of the ISO volume from the image's LBA.

**Kernel facts** (enclave-99, from the pinned WSL kernel's embedded config): `CONFIG_EFI_STUB=y`,
`CONFIG_HYPERV_VSOCKETS=y`, `CONFIG_CMDLINE_BOOL` not set.

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
| `disk.raw` | `04898f098ab9e464ee5be9771926812a6f8236940403492019a7538aa6efe4a7`: the fallback VHDX's payload |
| `guest.iso` | `b218a3290cfbc0932e3d406e17b8bc0fd2b5b83591fb99216b5c4c2a03d04cf0`: THE BOOT MEDIUM |

`uki.efi` is the hash enclave-5d predicted from `build-uki.sh`. Both assemblies produce it, and two builds of all four
outputs were identical.

**The boot chain, on KVM with OVMF: DEVELOPMENT EVIDENCE ONLY.** Two runs, both reaching the same point:

- `ovmf-kvm-iso-smoke-2026-09-25.serial.txt`: the ISO on a read-only SCSI CD-ROM. OVMF starts `Boot0002 "UEFI QEMU QEMU
  CD-ROM"`.
- `ovmf-kvm-smoke-2026-09-25.serial.txt`: `disk.raw` on read-only virtio.

Both ran on QEMU q35, 1 vCPU, 1 GiB, with no network:

1. OVMF boots `BOOTX64.EFI`.
2. The EFI stub loads the initrd from `LINUX_EFI_INITRD_MEDIA_GUID`.
3. The kernel starts, and the unchanged monitor prints `MON boundary tier=t0-hv … host_excluded=no` and `MON ready
   control_port=9000 snp=false`.

This is NOT Hyper-V and NOT OpenHCL. The monitor's host channel (hv_sock) was not exercised, and nothing was loaded or
served. Whether this disk boots under Microsoft's standard OpenHCL image on the NucBox has not been tried. That run is
enclave-d1's.

## Not yet measured under UEFI on the NucBox (the list enclave-99 reviews)

1. Microsoft's standard `openhcl.bin`, sha256 `48773995cfa2222ca7bb40020a807dcb8ce155a244b0987ba55334caafe49075` (a
   named input: release/1.7.2511 run 33556260031), with THIS medium attached. It has only been started with no medium.
2. OpenHCL's VTL0 UEFI (Project Mu) booting the El Torito image from a Gen2 SCSI DVD (or the fallback VHDX).
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
9. Hyper-V accepting the ISO as a Gen2 DVD boot device, and the fallback qemu-img VHDX.
10. The VM's vTPM: present or absent. It must be stated in the VM configuration; it is not yet stated.
