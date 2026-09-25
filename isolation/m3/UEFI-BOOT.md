# Booting the NucBox guest under UEFI: requirements and interfaces

On the NucBox's Windows build, Microsoft's standard UEFI boots under OpenHCL. Two linux-direct OpenHCL images, ours and
Microsoft's own release, both failed under the settings tested (worker event 12030; enclave-d1, 7c6bb15d). That is two
images under those settings, not every linux-direct configuration. So the guest gains a UEFI boot, a reversible
implementation detail of how VTL0 is loaded. **The payload's behaviour does not change**: the monitor, front, runtime,
app path, control and data channels and report binding. Only how the kernel and initrd are loaded changes, plus two guest
guards for the UEFI path (below).

Ownership:

| who | what |
|---|---|
| this lane (the guest runtime) | the boot requirements below, `build-uki.sh` (the UKI recipe), the guest's guards, and the payload proof |
| enclave-53 | the image builder: deterministic ESP/media, exact hashes, staging |
| enclave-d1 | the VM on the box: generation, firmware, Secure Boot, devices and hv_sock services, the launcher and its signed report |
| enclave-99 | independent review (its review of the first version: windows/vbslike/review/UEFI-BOOT-REVIEW.md) |

## The artifact: one UKI

`\EFI\BOOT\BOOTX64.EFI` is a Unified Kernel Image, built by `build-uki.sh`. It is systemd's EFI stub with these PE
sections:

| section | content | sha256 (for the box) |
|---|---|---|
| stub | `linuxx64.efi.stub`, systemd 261.2 | `2d9b80732fa76c29be1134cd51536df595b61510874ba646ec5fe12181f5ba18` |
| `.linux` | the WSL kernel 6.6.87.2, unchanged from the HCS path | `7fe3edb5b5dd2435545f611607b1c80e0cbc0e92b83e0cc0a25c07dc7d5ecddd` |
| `.initrd` | the guest initrd, `build-domain.sh` (guards, the named transport, and the hypervisor-stated `hv_isolation=`/`paravisor=`) | `0d14db231b1485bfde352d9043437d27459278361153802e0fa42314732e67e1` |
| `.cmdline` | `console=ttyS0 rdinit=/init loglevel=3 report_host=9001`, no trailing newline | `c99a16aef605f38db0d6b5ba307665c74658b86b79b3be3f33055f362b394615` |
| `.osrel` | `NAME="enclave NucBox guest"` / `ID=enclave-nucbox-guest` | `b6bca85d3e1933b36e542863b088667a56c8575de37f5e739d699d262d92d184` |
| tool | GNU objcopy (Binutils) 2.47, `SOURCE_DATE_EPOCH=0` | (an input to the bytes) |

- UKI for the box: `7af57aabbe5d8b5533892734a6cb8947085bad13dfdd89b918e2436cccd66f4a` (40,044,032 B), over initrd
  0d14db23 (24,037,136 B).
  - It adds the stated isolation fields (HV-GUEST.md, VBS-ISOLATION.md) and dominit's `/probe.ko` hook, which does
    nothing on a production medium.
  - It supersedes 20a0e18e (initrd a1ff9864: the named transport), 75ae6bcc (5bc06259: the guards, a ready line naming
    no transport; the first to boot on the box) and a1fdb5c3 (4610d594, from before the guards).
  - A PROBE UKI for the VBS report experiment, `f6ebbc0e...` over probe initrd `574ce802...`, is NOT a production
    medium (VBS-ISOLATION.md section 1).
- Deterministic on one toolchain. objcopy stamps the PE TimeDateStamp from the clock unless `SOURCE_DATE_EPOCH` is set,
  and the header checksum follows it. enclave-53's independent assembly reproduced the previous UKI byte for byte.
- Why a UKI: the firmware starts `BOOTX64.EFI` with no command line and no initrd, and the UKI carries both. **With
  Secure Boot OFF it does not stop the host from changing either.** A boot entry's LoadOptions replace `.cmdline`,
  SMBIOS type 11 can extend it, and files beside the UKI on the ESP become an extra initrd (items 8-10 below). What
  the guest can detect, it refuses (the guards).

## The guest's guards on the UEFI path (dominit.c)

systemd-stub always leaves `/.extra/os-release`, the UKI's own `.osrel`. That is how the guest recognises a stub boot.
On a stub boot the guest refuses to start (it powers off with `MON ERROR refusing to start: ...` on the console) when:
- the kernel command line is not exactly the pinned one. This catches LoadOptions and SMBIOS
  `io.systemd.stub.kernel-cmdline-extra`;
- anything besides `os-release` is under `/.extra`. This catches credentials and system/config extensions the stub
  unpacked from beside the UKI.

A direct boot (HCS linux-direct, QEMU `-kernel`) makes no UKI claim: its loader supplies the line (OVMF prefixes
`initrd=initrd`), so it is not pinned. On this tier the host can read the guest's memory anyway. These guards are
**fail-closed hygiene against silent drift, not a boundary against the host.**

`test-uefi-guards.sh` exercises them through the same channels, on QEMU + OVMF (NOT Hyper-V), 6/6:
- clean: MON ready;
- SMBIOS type 11 extra: refused on the line;
- a `BOOTX64.EFI.extra.d/x.cred`: refused on `/.extra/credentials`;
- an invocation command line (LoadOptions, channel 8): the UKI at `\EFI\enclave\uki.efi`, started by the edk2 UEFI
  Shell's `startup.nsh` with one extra argument, is refused on the line (enclave-99's method, needing no NVRAM). The
  same with exactly the pinned line reaches MON ready: the guard compares content, not the channel. The Shell is
  built from edk2-stable202608 `ShellPkg` (Shell.efi `412bd287...`); without one the two cases report SKIP, not PASS;
- a direct boot with an extra argument: not pinned, MON ready, as scoped.

## The ESP and the media (for enclave-53)

- The ESP holds exactly one file, `\EFI\BOOT\BOOTX64.EFI` (the UKI). There is no loader, no loader entries, no
  `startup.nsh`, no NVRAM entry, and nothing under `\loader\` or `BOOTX64.EFI.extra.d\`. Removable-media fallback
  boots it.
- Gen2 boots from a SCSI VHDX or a DVD ISO. Either works: the guest never writes to its boot medium.
  - **Chosen (enclave-d1): a read-only El Torito ISO**, deterministic, built by enclave-53.
  - VHDX is the hardware fallback, pinned by 53's raw GPT image (fixed GUIDs, FAT volume id and times) and verified by
    converting back to raw.

## Kernel requirements

Verified by enclave-99 from the pinned kernel's embedded config:
- `CONFIG_EFI_STUB=y`;
- `CONFIG_HYPERV_VSOCKETS=y` (the virtio vsock modules in the initrd fail to load, harmlessly);
- `CONFIG_CMDLINE_BOOL` unset, so the kernel appends nothing itself;
- a serial console on ttyS0;
- initrd via `LINUX_EFI_INITRD_MEDIA_GUID`.

## The VM (for enclave-d1)

- Generation 2, the OpenHCL standard-UEFI configuration that boots on this build, and 1 vCPU.
- Memory at least 1 GiB.
- **Secure Boot OFF.** The UKI is unsigned; signing needs a key in the VM's db, a later step. Until then the firmware
  verifies nothing about the boot medium.
- The medium as the first boot device.
- **No boot entries carrying LoadOptions for it, and no SMBIOS type 11 strings.** The guest refuses both, so either one
  shows up as a failed boot, not a silent change.
- COM1 to a named pipe: `MON ready control_port=9000 snp=false transport=hv_sock` is the boot signal. `MON ERROR
  refusing to start` is a guard; `MON ERROR no vsock transport` means the kernel carries no transport the host can
  use.
- hv_sock services, the same as the HCS path:
  - 9000: the guest listens;
  - 9001: the HOST listens (report signing);
  - 40000+id: the guest listens.
- **No vTPM, deliberately** (enclave-d1): nothing on this path reads PCRs, and a vTPM present but unread would look
  like attestation it isn't. The report states the absence.
- d1 reads back the VM's firmware and boot configuration before starting, and refuses if anything carries load options.
- Host facts (enclave-d1, on the box):
  - Hyper-V creates the COM1 pipe server only when the VM STARTS. A console reader cannot pre-attach: it must
    connect right after start and hold one connection. Earlier runs that showed 0 bytes had attached late.
  - petri's `New-CustomVM` creates no SCSI controller, so add one before `Add-VMDvdDrive`.

## The signed report's image field, per path

`partition.guestImageSha256` means the thing the launcher attached, whole:

| path | `guestImageSha256` | beside it |
|---|---|---|
| HCS linux-direct (dev) | the initrd file vbslike-host passes (launcher.rs) | the kernel file's hash |
| UEFI | the **medium** attached read-only: the ISO's bytes, or disk.raw's sha256 for a VHDX whose payload equals it | the UKI's hash and the composition above |

The medium, not the UKI: two media carrying the same UKI but different side-files would boot different command lines
and initrds under one UKI hash (item 10). The launcher's HCS-only fields (initrd/kernel file hashes) are not filled on
the UEFI path; that's d1's report code.

## What does NOT change: the payload's identity and runtime binding

The monitor, front, domexec, the wasmtime 48.0.1 runtime set and runtime.json are the same code. The initrd's bytes
changed only for:
- the two guards in dominit;
- the monitor's boundary line, which no longer names a partition kind. It used to print a fixed `partition=hcs-child`
  even in a KVM test guest; the guest cannot tell which kind it is in, so the launcher states the kind.

Unchanged:
- `report_data[32:64]` = the AppID;
- `report_data[0:32]` = Bind2 over the handshake key, the nonce and the runtime identity (RuntimeID ccadb38a...);
- the readiness route, the run modes, and the refusals.

A client verifies exactly what it did on the HCS path: the launcher-signed report at tier T0-hv, the verdict
`monitor-signed`. The host is **not** excluded, and nothing here establishes that it is.

## Inputs in the boot chain NOT measured for any client

On the NucBox nothing measures the partition's image for a client. The launcher signs, and it is in the trust boundary.

1. **Microsoft's UEFI firmware**, the one the OpenHCL configuration boots: host-selected.
2. **The OpenHCL image (VTL2)**, by hash, as enclave-53 pins it (openhcl.bin `48773995...`): its identity is not
   attested to a client here.
3. **systemd-stub** `2d9b8073...`: new code in the guest's boot chain.
4. **The UKI layout**, from `build-uki.sh`: recomputable from the table above.
5. **The boot medium** (ESP filesystem and ISO/VHDX container): pinned whole by enclave-53 (esp.img / disk.raw).
6. **The VM configuration**: Secure Boot off, boot order, devices. The host's settings.
7. **The WSL kernel** `7fe3edb5...`: already an input on the HCS path.
8. **LoadOptions**: with Secure Boot off, a boot entry's options REPLACE `.cmdline`. NVRAM is the host's. The guard
   refuses a changed line.
9. **SMBIOS type 11 `io.systemd.stub.kernel-cmdline-extra`**: appended by the stub unless in a confidential VM, which
   T0-hv is not. The guard refuses it (tested).
10. **ESP side-files the stub consumes**:
    - `BOOTX64.EFI.extra.d/*.addon.efi` (.cmdline/.dtb/.ucode), `*.cred`, `*.sysext.raw`, `*.confext.raw`;
    - `\loader\addons`, `\loader\credentials`, `\loader\extensions`.

    Unsigned addons load with Secure Boot off. Credentials and extensions arrive as an extra initrd under `/.extra`,
    which the guard refuses (tested with a credential). An addon's `.cmdline` changes the line, which the guard
    refuses. An addon's `.ucode` or `.dtb` would NOT be seen by the guard. Only pinning the whole medium (item 5)
    covers it, never the UKI hash.
11. **The EFI random seed** (`\loader\random-seed` plus the firmware RNG, into the kernel's seed table): host entropy
    feeds the RNG that mints the handshake key and the nonces. The host is trusted on this tier anyway; stated, not
    solved.
12. **A vTPM: none, by decision** (enclave-d1). The stub would measure into PCRs 9/11/12/13 that nothing reads. If a
    verifier of those PCRs ever exists, adding one is a real capability, not decoration.
13. **The toolchain**: objcopy 2.47 (and the stub's systemd version), inputs to the UKI's bytes.
14. **The report field's source**: the launcher's statement of what it attached (above), which is the host's word.

None of these is covered by anything a client checks today. Hardware host exclusion is NOT established by any of
this and must not be advertised.

## On the NucBox: the first UEFI boot (enclave-d1, 2026-09-25)

enclave-53's v9 ISO booted on Hyper-V: Gen2, isolation type 16, Secure Boot off, no vTPM, one boot entry with no
LoadOptions, 1 vCPU, 2048 MiB, firmware openhcl.bin `48773995...`. The console, verbatim:

```
MON snp=0 vcpus=1 memMiB=1965 boot_ms=309
MON insmod /vsock.ko.zst failed: Operation not supported
MON insmod /vmw_vsock_virtio_transport_common.ko.zst failed: Operation not supported
MON insmod /vmw_vsock_virtio_transport.ko.zst failed: Operation not supported
MON boundary tier=t0-hv vmpl=n/a vmpl_floor=n/a vmpl0=n/a host_excluded=no
MON ready control_port=9000 snp=false
```

The ISO (`4c387086...`) was hashed at attach, with UKI 75ae6bcc and initrd 5bc06259. This is a dev boot: host
exclusion is NOT established, and the guest says so itself.
- The insmod lines are the QEMU lane's virtio modules. This kernel has Hyper-V's transport built in
  (`CONFIG_HYPERV_VSOCKETS=y`), and the same lines appeared on the 09-23 HCS path where hv_sock worked.
- hv_sock 9000 ANSWERS on this path: `vbslike-host hvdial --vm <guid> --port 9000` connected in 1 ms, over three boots
  (enclave-d1). A connect proves a working transport and a listener, nothing about the guest's identity or boundary.
- `MON ready` printed the same whether or not the channel could exist, so from initrd a1ff9864 the ready line names
  the transport, and the guest powers off with `MON ERROR no vsock transport` when there is none.

## Local proof (warden-host, QEMU + OVMF: NOT Hyper-V)

- `BOOT=uefi test-hv-local.sh`: the guests boot from an ESP holding only the UKI (the Arch kernel as `.linux`, initrd
  5bc06259, UKI `1f1fbed6...`). Every phase passes: 15/15, the one-domain mode, and route 13/13. The direct boot also
  passes on the same initrd.
- `test-uefi-guards.sh`: 6/6, as listed above.
- The box's own kernel boots from a UKI under OVMF to `MON ready`. Its hv_sock channel cannot be exercised in QEMU;
  that part is for the box.

## The box acceptance run (hvlab-accept.mjs)

This is one deployment taken through the node's own code, from `ensureApp` to a browser's TLS session that ends
inside the partition. It runs against the manager already running on the box: enclave-d1's `main.mjs`, with its
real launch backend. It creates at most one instance at a time and removes each one it created. It never touches an
instance it did not create: if the manager already holds one for the deployment, it exits 3, `HVLAB-ACCEPT REFUSED`.

- Its node is d1's real `Host` and app zone, with a test endpoint, a temp dir and no operator key.
- It uses its own tunnel hub on loopback (`relay/tunnel.js`), not the production relay. The node agent, the
  production apps and the relay are not involved.

What it checks, in order:

1. `ensureApp` reaches running, and the record says `T0-hv` with the host not excluded.
2. A browser goes through the tunnel hub, the app zone and the data plane into the domain. `judge-hv`
   returns monitor-signed on the browser's own handshake key, and that key equals the key in the manager's record.
   The judge is given the app, the runtime identity, the launcher key and the image. The app answers 200.
3. Refusals:
   - a verifier holding another key, another nonce, or expecting another app;
   - the data plane's admission for another key, image, app or runtime, or for an instance the manager does not
     hold, with the exact record admitted as the control.
4. A forced relaunch (`ensureApp(..., {force: true})`, a config edit's path):
   - a NEW instance with a NEW key, and the old instance gone from the manager;
   - exactly one instance with the deployment's name;
   - the session opened on the old domain has ended;
   - the old route is refused, and so is the new instance under the old key;
   - the browser reconnects on the new verified key, and a client pinned to the old key sees a different one.
5. A node restart (a fresh `Host`, a fresh tunnel): `ensureApp` ADOPTS the same instance and key and does not
   start a second one, and the browser reconnects through it.
6. Cleanup: the node's own `retire` for each instance created, re-read and confirmed gone.

On the box, from the checkout that carries this file (PowerShell):

```
$env:HVACC_NODE_TREE    = "<the node tree: windows/node, windows/vbslike, relay/tunnel.js, isolation/contract, node_modules>"
$env:HVACC_MANAGER      = "http://127.0.0.1:<the manager's port>"
$env:HVACC_DATA         = "127.0.0.1:<ENCLAVE_DATAPLANE_PORT>"
$env:HVACC_LAUNCHER_KEY = "<the launcher's report key, exactly as the report's launcher.key carries it>"
$env:HVACC_JUDGE        = "$env:HVACC_NODE_TREE\windows\vbslike\verify\judge-hv.mjs"
$env:HVACC_RUNTIME      = "<ENCLAVE_RUNTIME_IDENTITY: the booted image's plat/rt/runtime.json>"
$env:HVACC_PYTHON       = "python"
node isolation\m3\hvlab-accept.mjs
```

It passes with 27 PASS lines and a last line of `HVLAB-ACCEPT ALL PASS`. Defaults: hello-world, the representative
record `0x4e62e60d...`, whose derive record is `bff33b95`. Override them with `HVACC_DEPLOYMENT`, `HVACC_APPREF`
and `HVACC_APPPORT`. `HVACC_TIMEOUT_S` (default 300) bounds each wait for running.

Locally, `NODE_TREE=<tree> test-hv-accept.sh <workdir>` (add `BOOT=uefi` for the UKI path) runs the same harness
against `hvlab-manager.mjs`: d1's Manager, `judgeRunning` and the data plane as main.mjs wires them, with plain KVM
guests. That is QEMU/KVM, NOT Hyper-V. A pass there says the node, manager and guest code agree. It says nothing
about a Hyper-V partition's boundary. The local "old session ended" pass comes from the relay closing when the
domain is destroyed, not from `onReclaim`: the data plane counts `closed:reclaimed` 0.
