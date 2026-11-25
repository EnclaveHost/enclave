# Whole-VM boot: one app image, a wrapper per platform

A whole-VM app (catalog runtime `sev-snp-vm` today) is one measured VM. This directory is the part of such a VM
that belongs to the platform, so that an app ships **one image** and it boots on every host type:

| Part | Whose | Same on every platform |
| --- | --- | --- |
| `root.img`, `root.verity`, `APP.json`, a model volume | the app's build | yes: one root hash |
| the front inside the root (`front/`, built into the app's root) | platform source | yes: one binary, the report source is chosen at boot |
| kernel, `initrd.img` (`vm-init.c` and every kernel module), the kernel command line's platform half | `build_boot.py` | no: this is the wrapper |
| how disks are presented (virtio serial, or `wrap_iso.py`'s container) | the host's launcher | no |

Status, 2026-11-25: built and booted for SEV-SNP on metal0, outside any lease. For an Enclave Shield host the
wrapper builds (below) and nothing of it has run on one. No catalog version uses this.

## The pieces

- **`vm-init.c`**: PID 1 of the initramfs. Loads the modules packed with it, finds the app's disks by label
  (`ROOT_DATA`, `ROOT_HASH`, `MODELS`), opens them through dm-verity with the root hashes on the kernel command
  line, mounts the root read-only under a tmpfs overlay and runs `/vm/start` from it. A label is a virtio serial
  (a dash reads as an underscore, so `rpc/snp/launch.py`'s `ROOT-DATA` is `ROOT_DATA`) or the volume identifier of
  `wrap_iso.py`'s container, whose payload starts at byte 65536. The label is the host's word and only says which
  disk to try; a disk that is not the pinned bytes fails verification.
- **`front/`**: the whole-VM front (the contract of `rpc/snp/front.py`, plus protected-port tunnels from
  `isolation/m2/tunnel`). `source.go` is where reports come from: `sev-snp` (configfs-tsm, the deployment is
  HOST_DATA) or `shield` (the paravisor's report through the guest TPM, `isolation/m3/vtpmclient`; the deployment
  is a file the boot wrapper writes, unattested, used only to pick the name a certificate is asked for). `-report
  auto` takes what the boot offers and refuses a boot that offers neither. It serves TCP and, with `-vsock`, an
  AF_VSOCK port (virtio or Hyper-V sockets) for a host that reaches guests without a network.
- **`build_boot.py`**: wraps an app image for one platform. The app's half of the command line (root hash,
  geometry, model volume) is derived from `APP.json` alone and is the same string everywhere. `sev-snp` gives the
  layout `rpc/snp/launch.py` boots. `shield` gives `image.igvm` (the reviewed OpenHCL set, the kernel as an ELF image
  taken out of the distribution's compressed one, the initramfs, the command line), the VBS boot digest
  igvmfilegen states for it, and the app's disks in `wrap_iso.py` containers; it builds the image twice and refuses
  one whose bytes or digest differ.
- **`shield-tpm/`**: the paravisor TPM driver (`isolation/m3/vtpm/enclave_openhcl_tpm.c`) built as a module for a
  distribution kernel, in an Ubuntu 24.04 container with the kernel's own compiler. `tpm.h` there stands in for the
  kernel's private header, which header packages do not ship.
- **`wrap_iso.py`**: the labelled ISO 9660 container Hyper-V's DVD backend needs around a raw image.

## What an app provides

Its root must contain `/vm/start` (run as vm-init's child; when it ends the guest powers off) and no kernel
module. `APP.json` (schema `enclave-vm-app/1`, read strictly by `build_boot.py`) names the root hash and geometry,
the kernel modules the app needs loaded, its protected ports and an optional model volume. KVM Box is the first
(enclave-apps `kvm-box/vm`).

## Tried (metal0, 2026-11-25)

- SEV-SNP, launched with `rpc/snp/launch.py`: the predicted launch measurement was the one in the AMD-signed
  report; `rpc/snp/attested-fetch.mjs` accepted the front; a tunnel reached the app's port.
- Plain KVM with the root and its hash tree as `wrap_iso.py` containers on SCSI DVD drives and the model volume as
  a virtio disk: vm-init found all three by label and the desktop started; the front then refused to serve, having
  no report source, and the guest powered off. With two discs carrying one label and none carrying the other,
  vm-init refused.

- Shield wrapper of the same KVM Box app image, with the same Ubuntu 6.8.0-147 kernel as the SEV-SNP wrapper: it
  builds, twice to the same bytes (58 MB) and the same VBS boot digest. The TPM module built twice to the same
  bytes, and the Ubuntu kernel links it: loaded under plain KVM, its own start answers "no such device", as it
  must off Hyper-V.

## One kernel on both platforms: what is known

The same kernel binary is in both wrappers, compressed for QEMU and as the ELF image inside it for the paravisor's
loader. Under SEV-SNP it boots. Under an ordinary Hyper-V VM on the NucBox the same release boots (a test VM, UEFI,
no paravisor). Whether it boots under the Shield path (VBS isolation, OpenHCL's direct Linux loader, no UEFI and no
ACPI TPM table) is not known until one such partition is started: that is the next step and it touches the NucBox.

## Not built, not tried

- A boot of the Shield wrapper. The `shield` report source against a real paravisor, and what writes its
  deployment file.
- How a Shield host's launcher attaches these images: the model volume's container is not made here (20 GB; the
  launcher's own model-volume path may serve it), and the node refuses whole-VM deployments.
- The Shield image's version number (`guestSvn`) and how a host admits its digest: the probe used 1.
- Verifiers: every whole-VM verifier accepts only `sev-snp-vm-v1`. A version that lists one root hash with a launch
  identity per platform does not exist yet.
- Enclave RPC still uses its own image and front (`rpc/snp`).

## Tests

`go test ./front` here; `python3 -I test/vmboot/test_vmboot.py`.
