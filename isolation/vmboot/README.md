# Whole-VM boot: one app image, a wrapper per platform

A whole-VM app (catalog runtime `sev-snp-vm` today) is one measured VM. This directory is the part of such a VM
that belongs to the platform, so that an app ships **one image** and it boots on every host type:

| Part | Whose | Same on every platform |
| --- | --- | --- |
| `root.img`, `root.verity`, `APP.json`, a model volume | the app's build | yes: one root hash |
| the front inside the root (`front/`, built into the app's root) | platform source | yes: one binary, the report source is chosen at boot |
| kernel, `initrd.img` (`vm-init.c` and every kernel module), the kernel command line's platform half | `build_boot.py` | no: this is the wrapper |
| how disks are presented (virtio serial, or `wrap_iso.py`'s container) | the host's launcher | no |

Status, 2026-11-25: one app image (KVM Box, root hash 268b0332…) booted under both wrappers, with the same kernel:
SEV-SNP on metal0 and an Enclave Shield partition on nucbox-k11-4, each outside any lease. No host launches it by
itself, no verifier accepts the Shield report of a whole VM, and no catalog version uses this.

## The pieces

- **`vm-init.c`**: PID 1 of the initramfs. Loads the modules packed with it, finds the app's disks by label
  (`ROOT_DATA`, `ROOT_HASH`, `MODELS`), opens them through dm-verity with the root hashes on the kernel command
  line, mounts the root read-only under a tmpfs overlay and runs `/vm/start` from it. A label is a virtio serial
  (a dash reads as an underscore, so `rpc/snp/launch.py`'s `ROOT-DATA` is `ROOT_DATA`) or the volume identifier of
  `wrap_iso.py`'s container, whose payload starts at byte 65536. The label is the host's word and only says which
  disk to try; a disk that is not the pinned bytes fails verification.
- **`front/`**: the whole-VM front (the contract of `rpc/snp/front.py`, plus protected-port tunnels from
  `isolation/m2/tunnel`). `source.go` is where reports come from: `sev-snp` (configfs-tsm, the deployment is
  HOST_DATA) or `shield` (the paravisor's report through the guest TPM, `isolation/m3/vtpmclient`; that report has no
  field the host sets per launch, so the deployment is a file the boot wrapper writes once and the front puts it in
  the second half of every report's 64 bytes of data, under the platform's signature). `-report
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
- **`version_config.py`**: the catalog version config of an app image from the `IMAGE.json` of each wrapper: one
  root hash, a launch identity per platform. It refuses two wrappers of different app images.

## One version, a launch identity per platform

A whole-VM catalog version names one root image and, for each platform it may be booted on, what that platform's
report says of a boot of it:

    {"runtime": "sev-snp-vm",
     "image":  {"rootHash": "...", "ovmfSha256": "...", "cmdlineSha256": "..."},
     "snp":    {"measurements": {"8": "<96 hex>"}, "vcpuType": "EPYC-v4"},
     "shield": {"launch": [{"bootDigest": "<64 hex>", "guestSvn": 1}]}}

`snp` is as before (a launch measurement per vCPU count; `image.ovmfSha256` and `image.cmdlineSha256` are the
SEV-SNP wrapper's and stay where the SEV-SNP manager reads them). `shield.launch` lists the boot image's launch
digest (the paravisor's report calls it the measurement; it is igvmfilegen's `vbs_boot_digest`, as for the native
desktop images in service), the guest SVN, and optionally the signer (`identity`) of a signed boot image. A version
lists one platform or both; the runtime name is the whole-VM runtime's historical one on either.

Who reads it:

- `network/snp-vm-app.mjs` `snpVmExpectation` -> `{appSha256, runtimeId, measurements, shield?}`. The runtime
  identity covers every listed identity (`wholeVmRuntimeId`); for a version with SEV-SNP alone it is the value it
  always was.
- `verifySnpVmProof` (unchanged checks) for a `sev-snp-vm-v1` document; `network/shield-vm-app.mjs`
  `verifyShieldVmProof` for a `shield-vm-v1` one: the report must be signed by the VSM identity key of a host boot
  the caller authenticated, carry a listed boot digest at its SVN or above, and bind
  sha256(TLS key || nonce) || deployment id.
- `network/guest-probe.mjs` (the host agent's admission probe): `snpVm` for an SEV-SNP host, `shieldVm` with the
  host's Shield policy and boot session for a Shield host. A whole-VM lease is admitted on its platform's whole-VM
  document and no other.
- `cli/connect.mjs`: `enclave connect <id> --shield --expect-shield DIGEST:SVN` (or the policy file's
  `shieldLaunch`), next to `--expect` for SEV-SNP.

For the KVM Box image built here (`268b0332...`), `version_config.py` gives the 8-vCPU SEV-SNP measurement
`13ec4f0b...` and the Shield launch `0bfa57ea...` at SVN 1, and the agent's reader accepts it. That image predates
the front's deployment binding, so its root hash is not the one a rebuild gives.

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

## Tried (nucbox-k11-4, 2026-11-25 17:10Z)

One disposable partition defined the way the Shield launcher defines one (petri's pinned `New-CustomVM`, VBS
isolation, the Shield wrapper's `image.igvm` as firmware, a copy of the host's guest-state master, TPM on, no
network card, no hard disk), 4 vCPUs and 4 GiB, with `MODELS.iso`, `ROOT_HASH.iso` and `ROOT_DATA.iso` on SCSI DVD
locations 0, 1 and 2, in that order on purpose. Its console, complete:

```
VMINIT start
VMINIT root verified, starting /vm/start
Starting systemd-udevd version 257.13-1~deb13u1
VMSTART: desktop started, MemAvailable: 3490480 kB
vmfront: shield, serving :8443, app name "", root 268b0332cb9e2542f8939ccfdbae986d08c02a94713163a483fc11d0f2afda5d
vmfront: serving vsock port 8443
```

So, on a Shield host: the Ubuntu 6.8.0-147 kernel boots through the paravisor's direct loader; every module in the
wrapper loads, the paravisor TPM driver among them (a module that fails to load ends the boot); vm-init finds the
three discs by label, not position, and both dm-verity devices open; the desktop's services start; and the front
got a report from the guest TPM that carries its key's hash (it serves only after that) and listens on the socket
port. The partition was turned off after two minutes and removed with its files.

What this did not show: nobody connected to the front (the host has no socket service registered for the port), so
no report was read or verified outside the guest; the launch digest was not compared with the built one; no
deployment was named; no Moonlight stream; nothing about how long it stays up.

## One kernel on both platforms

Yes, for booting: the same Ubuntu 6.8.0-147 binary is in both wrappers, compressed for QEMU and as the ELF image
inside it for the paravisor's loader, and it booted the same app image on both.

## Not built, not tried

- The Shield verifier has only been run on synthetic reports (the test fixture's signed envelope). No report of a
  running whole-VM partition has been read from outside the guest, so three things are not shown: that the built
  digest is the one a partition reports, what guest SVN an unsigned boot image reports, and the 64 bytes as the
  paravisor returns them.
- What writes the `shield` source's deployment file (the launcher's side, and `vm-init`).
- How a Shield host's launcher attaches these images: the model volume's container is not made here (20 GB; the
  launcher's own model-volume path may serve it), and the node refuses whole-VM deployments.
- The Shield image's version number (`guestSvn`) and how a host admits its digest: the probe used 1.
- Verifiers not changed: the Enclave RPC gateway's (`rpc/snp/chain-policy.mjs`, `attested-fetch.mjs`: AMD reports
  only, and it ignores a `shield` section), the browser verifier (`verifier/envelope.mjs` knows neither whole-VM
  format), the relay's fresh-attestation endpoint for a Shield host's whole-VM app, and the Windows node, which
  still refuses whole-VM deployments. The SEV-SNP supervisor refuses a version that lists Shield alone with its
  "launch measurements by vCPU count" message.
- No catalog version lists two platforms: nothing is published.
- Enclave RPC still uses its own image and front (`rpc/snp`).

## Tests

`go test ./front` here; `python3 -I test/vmboot/test_vmboot.py`; `node --test test/shield-vm-app.test.mjs test/snp-vm-app.test.mjs`.
