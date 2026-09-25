# Booting the NucBox guest under UEFI: requirements and interfaces

On the NucBox's Windows build, Microsoft's standard UEFI boots under OpenHCL. Two linux-direct OpenHCL images, ours and
Microsoft's own release, both failed under the settings tested (worker event 12030; enclave-d1, 7c6bb15d). That is two
images under those settings, not every linux-direct configuration. So the guest gains a UEFI boot, a reversible
implementation detail of how VTL0 is loaded. **The payload does not change.** The initrd, monitor, front, runtime, app path, control and data channels
and report binding are all the same. Only how the kernel and initrd get loaded changes.

Ownership:

| who | what |
|---|---|
| this lane (the guest runtime) | the boot requirements below, `build-uki.sh` (the UKI recipe), and the payload proof |
| enclave-53 | the image builder: deterministic ESP/media, exact hashes, staging |
| enclave-d1 | the VM on the box: generation, firmware, Secure Boot, devices and hv_sock services, the launcher and its signed report |
| enclave-99 | independent review of this document's claims, in particular the unmeasured-input list |

## The artifact: one UKI

`\EFI\BOOT\BOOTX64.EFI` is a Unified Kernel Image, built by `build-uki.sh`. It is systemd's EFI stub with these PE
sections:

| section | content | sha256 (for the box) |
|---|---|---|
| stub | `linuxx64.efi.stub`, systemd 261.2 | `2d9b80732fa76c29be1134cd51536df595b61510874ba646ec5fe12181f5ba18` |
| `.linux` | the WSL kernel 6.6.87.2 (EFI stub present, xloadflags 0x3b), unchanged from the HCS path | `7fe3edb5b5dd2435545f611607b1c80e0cbc0e92b83e0cc0a25c07dc7d5ecddd` |
| `.initrd` | the guest initrd, `build-domain.sh` at aef54ff7, **unchanged** | `4610d5944cc2d67a6510ece964915b6a90b20ecc27a0169d514a2701c9fc9f85` |
| `.cmdline` | `console=ttyS0 rdinit=/init loglevel=3 report_host=9001`, no trailing newline | `c99a16aef605f38db0d6b5ba307665c74658b86b79b3be3f33055f362b394615` |
| `.osrel` | `NAME="enclave NucBox guest"` / `ID=enclave-nucbox-guest` | (fixed text) |

- UKI for the box: `a1fdb5c3e973accc2f04bfecce7fb22cfdcfcf7568244350328ec6436a1a87b1` (40,045,056 B).
- Deterministic: `SOURCE_DATE_EPOCH=0`. Without it objcopy stamps the PE TimeDateStamp from the clock, and the header
  checksum follows it. Two builds three seconds apart are identical.
- Why a UKI: the firmware starts `BOOTX64.EFI` with no command line and no initrd. A UKI carries both inside the one
  file it loads, so nothing on the ESP or in NVRAM can add an argument or swap the initrd. The stub hands the initrd to
  the kernel through `LINUX_EFI_INITRD_MEDIA_GUID` (seen with this kernel: "EFI stub: Loaded initrd from
  LINUX_EFI_INITRD_MEDIA_GUID device path").

## The ESP and the media (for enclave-53)

- The ESP holds exactly one file, `\EFI\BOOT\BOOTX64.EFI` (the UKI). There is no loader, no loader entries, no
  `startup.nsh`, and no NVRAM boot entry is needed: removable-media fallback boots it.
- Gen2 boots from a SCSI VHDX or a DVD ISO. Either works for the guest: it never writes to its boot medium (it runs
  from the initrd in RAM).
  - My preference is a read-only El Torito ISO, if d1's VM config boots it: byte-reproducible and immutable.
  - Otherwise use 53's proposal: the pinned identity is the RAW GPT image (fixed GUIDs, FAT volume id and times), with
    the VHDX a container verified by converting back to raw.

## Kernel requirements

All already met by the pinned WSL kernel, as used on the HCS path on 09-23:
- an EFI stub;
- Hyper-V VMBus and hv_sock built in (the virtio vsock modules in the initrd fail to load, harmlessly);
- a serial console on ttyS0 (COM1);
- initrd via the LoadFile2 media GUID.

## The VM (for enclave-d1)

- Generation 2, the OpenHCL standard-UEFI configuration that boots on this build, and 1 vCPU.
- Memory at least 1 GiB (the monitor sees about 945 MiB at 1 GiB).
- **Secure Boot OFF.** The UKI is unsigned. Signing needs a key in the VM's db, a later step. Until then the firmware
  verifies nothing about the UKI: stated, not hidden.
- The boot medium above as the first boot device.
- COM1 to a named pipe (the console: `MON ready control_port=9000` is the boot signal).
- hv_sock services, the same as the HCS path:
  - 9000: the guest listens (control, `load`);
  - 9001: the HOST listens (report signing);
  - 40000+id: the guest listens (the domain's TLS, ciphertext).
- The launcher's signed report states `partition.guestImageSha256`. On this path it is **the UKI's sha256**, the one
  file the firmware loads (a1fdb5c3... for the box). The composition above is published beside it, so a verifier can
  check that the initrd inside is 4610d594. enclave-53's package records the image expectation per path; for this
  path it is the UKI.

## What does NOT change: the payload's identity and runtime binding

Identical bytes: the initrd, and in it the monitor, front, domexec, the wasmtime 48.0.1 runtime set and runtime.json.
So these are unchanged:
- `report_data[32:64]` = the AppID;
- `report_data[0:32]` = Bind2 over the handshake key, the nonce and the runtime identity (RuntimeID ccadb38a...);
- the readiness route, the run modes, and the refusals (HV-GUEST.md).

A client verifies exactly what it did on the HCS path: the launcher-signed report at tier T0-hv, the verdict
`monitor-signed`. The host is **not** excluded, and nothing here establishes that it is.

## New inputs in the boot chain, NOT measured for any client

On the NucBox nothing measures the partition's image for a client. The launcher signs, and it is in the trust
boundary. The UEFI path adds these inputs, each executing or deciding before or around the payload:

1. **Microsoft's UEFI firmware**, the one the OpenHCL configuration boots: Microsoft's, host-selected.
2. **The OpenHCL paravisor (VTL2)**: Microsoft's; its identity is not attested to a client here.
3. **systemd-stub**, `2d9b8073...`: new code in the guest's own boot chain (it loads the kernel and the initrd).
4. **The UKI layout**, from `build-uki.sh`: deterministic and recomputable from the four hashes above.
5. **The boot medium** (ESP filesystem and ISO/VHDX container): enclave-53's builder. Its content is one file.
6. **The VM configuration**: Secure Boot off, boot order, devices. The host's settings.
7. The WSL kernel, `7fe3edb5...`: already an input on the HCS path, unchanged and not measured.

None of these is covered by anything a client checks today. The launcher's signature vouches for them only as far as
the launcher is trusted, and on this tier it can read the guest's memory anyway. Hardware host exclusion is NOT
established by any of this and must not be advertised.

## Local proof (warden-host, QEMU + OVMF: NOT Hyper-V)

- `BOOT=uefi test-hv-local.sh` boots the guests from an ESP holding only the UKI (no `-kernel`/`-initrd`/`-append`).
  With the Arch kernel as `.linux` (UKI `ba0335b0...`, the same initrd and command line) every phase passes:
  - 15/15 with two domains;
  - the one-domain mode;
  - the route phase 13/13.
  The payload behaves identically under a UEFI boot.
- The box's own UKI (`a1fdb5c3...`, the WSL kernel) boots under OVMF: stub -> kernel -> initrd -> dominit -> `MON
  ready control_port=9000`. Its channel cannot be exercised in QEMU. That kernel's vsock transport is Hyper-V's, so
  the host's `load` gets no answer. That part is for the box.
