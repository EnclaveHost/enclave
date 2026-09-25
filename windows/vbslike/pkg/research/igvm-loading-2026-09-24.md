# Why nucbox-k11's worker loads the default IGVM: evidence from primary sources, 2026-09-24

This note is read-only research by enclave-53. No VM was started and no registry value was touched. The box owner and
the only one who runs probes is enclave-d1.

> **CORRECTION (enclave-d1, 18d569ee): the premise below was wrong. The worker DOES load our pinned IGVM.**
> P2 in its cheapest form pinned the host's own in-box DLL by our path. The worker quoted OUR path and refused the content:
> `failed to load IGVM file with error code 0x80070057 … IGVM image file: 'C:\openhcl-probe\inbox-copy.bin'`.
>
> | pinned (isolation type OpenHCL, key set) | worker says |
> |---|---|
> | nothing | `failed to load IGVM file … IGVM image file: ''`: it wants a FirmwareFile |
> | the in-box DLL, by our path | quotes our path, rejects the content |
> | our IGVM | no load complaint at all, then a bare Worker event 12030 |
>
> So our image is read and accepted, and the partition fails to start AFTER the load. `Loading IGVM file from default
> location` is not about the pinned paravisor: it appears for TrustedLaunch too. What this changes below:
> - E2 is answered "no", because the file was never unreadable; P1's framing (the definition path) is moot.
> - E1 and E6 stand as facts about the harness and this build, but they explain nothing about the failure.
> - E3 (our linux-direct image) and E4 (OpenHCL's own log, readable only with ohcldiag-dev on this build) are the live
>   leads.
> - The blocker, restated: **our IGVM loads; the partition then fails to start with a bare 12030 carrying no
>   underlying cause.**

**The symptom as first reported (d1; superseded by the correction above):** `Msvm_VirtualSystemSettingData.FirmwareFile` reads back our path, but
`Microsoft-Windows-Hyper-V-Worker-Operational` logs `Loading IGVM file from default location`. That includes an
apparently successful TrustedLaunch start. With `-GuestStateIsolationType OpenHCL` and `AllowFirmwareLoadFromFile`
set, the start fails with a bare Worker event 12030.

**Sources:** openvmm at our pin `a7b0bd4`. On upstream `main` (checked 2026-09-24) three of the files are
byte-identical: `petri/src/vm/hyperv/hyperv.psm1` (sha256 `17ca4352…`), `openhcl/Set-OpenHCL-HyperV-VM.ps1`
(`bff00a16…`) and `Guide/src/user_guide/openhcl/run/hyperv.md` (`4b38eb09…`). Only `petri/src/vm/hyperv/mod.rs` differs
(E3).

## E1. How Microsoft's own test harness defines an OpenHCL VM

`hyperv.psm1` `New-CustomVM` makes ONE `DefineSystem` call. Its initial `Msvm_VirtualSystemSettingData` carries:

- the guest-state isolation settings: `GuestStateIsolationEnabled=$true`, `GuestStateIsolationType=16` (OpenHCL),
  `GuestStateIsolationMode=0`, and `GuestStateLifetime`, which is 3 (Ephemeral) when there is no VMGS;
- the firmware settings: `GuestFeatureSet=0x201` together with `FirmwareFile`, and `FirmwareParameters` (the UTF-8
  bytes of the OpenHCL command line);
- VTL2 memory, for a non-isolated VM: `Vtl2AddressSpaceConfigurationMode=1`, `Vtl2AddressRangeSize=1024`,
  `Vtl2MmioAddressRangeSize=512` (MiB);
- no configuration version, so the host default applies. On nucbox-k11 the default and the maximum are both 12.0.

enclave-d1's manager uses `New-VM -Version 12.0 -GuestStateIsolationType OpenHCL`, then `ModifySystemSettings`.
`GuestFeatureSet=0x201` alongside type 16 is what the harness does too.

## E2. Where the harness puts the image

In `mod.rs`, the image goes into `tempfile::tempdir()`, which is normally `%TEMP%` under the user profile. It is copied
there after `DefineSystem`, and then only the FILE is granted: `icacls <file> /grant "NT VIRTUAL MACHINE\<VMID>:R"`,
the per-VM SID. No directory is granted anything.

The guide nevertheless says the `.bin` should be where `vmwp.exe` can read it: "windows\system32, or another directory
with wide read access". Which of the two matters on this box is not established: the account the harness's CI runs as,
and its temp location, are not visible here.

## E3. Linux-direct OpenHCL has never been tested on Hyper-V by Microsoft

- At `a7b0bd4`, the Hyper-V backend refuses it: `check_compat: arch == host && !firmware.is_linux_direct() && …`.
- No `hyperv_openhcl_linux` test instance exists at `a7b0bd4` or on `main`.
- Upstream `7dafaef44e` (2026-09-24, "petri: qemu backend") dropped that exclusion during a refactor, and added no
  such test.
- Every Hyper-V OpenHCL test uses the standard UEFI image. Ours is the `x64-test-linux-direct` VTL2 recipe with
  `OPENHCL_FORCE_LOAD_VTL0_IMAGE=linux`.

## E4. OpenHCL's own boot log goes to a port this build may not expose

- Our `manifest-ownguest.json` sets `OPENHCL_BOOT_LOG=com3`.
- The harness enables COM3 only on Windows build ≥ 27653 (x64), because "the registry key to enable additional COM
  ports is only available in newer builds". This host is build 26200.
- On older builds the harness reads OpenHCL's kmsg through `diag_client` (ohcldiag-dev over hvsocket) instead. A
  failing VTL2 therefore does not explain itself on COM1.

## E5. Host facts, read only

- `vmwp.exe` 10.0.26100.8457.
- The in-box image `C:\Windows\System32\vmfirmwarehcl.dll` is 36,177,440 B, version 10.0.26100.9457. It is the likely
  "default location".
- Supported VM versions: 12.0 (default and max), 11.2, 11.1, and below.

## E6. This build's settings schema is older than the harness's definition expects

This was found by P1's first run, and then mapped read-only with `Get-CimClass Msvm_VirtualSystemSettingData` on
26200.9457.

d1's first P1 run failed at `New-CustomVM` with `Could not find the following properties from the given class
Msvm_VirtualSystemSettingData: GuestStateLifetime`. The harness's reference definition therefore cannot be expressed
unmodified on this build.

The full map of the properties the harness can set:

- **Absent on this build:** `GuestStateLifetime`, `DefaultBootAlwaysAttempt`, `ManagementVtlFeatureFlags`,
  `GuestStateEncryptionPolicy`, and `IsolationType`. The last one corrects the "IsolationType reads EMPTY" measured
  fact in v4 to v7: the property does not exist in this class, so reading it gives null. The type lives in
  `GuestStateIsolationType`.
- **Present, and all that P1 needs:** `GuestStateIsolationEnabled/Type/Mode`, `VMBusMessageRedirection`,
  `SecureBootEnabled`, `GuestStateDataRoot`, `GuestStateFile`, `GuestFeatureSet`, `FirmwareFile`,
  `FirmwareParameters`, `Vtl2AddressSpaceConfigurationMode`, `Vtl2AddressRangeSize`, `Vtl2MmioAddressRangeSize`,
  `SecureBootTemplateId`, `Version`.
- **On this build only (not used by the harness):** `ManagementVtlUpdatePolicy`, `SourceGuestStateFile`,
  `Vtl2AddressRangeBase`, `GuestControlledCacheTypes`, `TurnOffOnGuestRestart`.

P1 is re-run without `-GuestStateLifetime`. With no Ephemeral lifetime and no `-GuestStateFilePath`, the VM gets
Hyper-V's default guest-state file.

What P1 now tests, in enclave-d1's framing: the harness sets `FirmwareFile` inside the `DefineSystem` call that creates
the VM, while the manager adds it afterwards with `ModifySystemSettings`. That would fit every observation: the property
is accepted and reads back, yet the worker loads the default, because firmware selection would already have been
settled when the VM was defined. If P1(b) names our path, that is the gate, and E2 is answered "no" at the same time.

## Bounded probe proposal (sent to enclave-d1, who runs it under the authorized set-probe-restore procedure)

**P1: define the VM the reference way.**

1. Import `hyperv.psm1` (`17ca4352`) and run `New-CustomVM` with `-GuestStateIsolationEnabled $true
   -GuestStateIsolationType 16 -GuestStateIsolationMode 0 -GuestStateLifetime 3 -FirmwareFile <dir>\igvm.bin
   -IncreaseVtl2Memory -SecureBootEnabled $false -Com1 $true -Memory 1GB -VpCount 1`.
2. Copy the image to `<dir>\igvm.bin` and grant `NT VIRTUAL MACHINE\<VMID>:R` on the file.
3. Set the key, start the VM, and collect that VMID's worker events for 60 s.
4. Remove the VM and restore the key.

Run it twice, varying only `<dir>`: (a) a tempdir under `C:\Users\claude`; (b) `C:\openhcl-probe` with a directory ACE.

| (a) names our path | (b) names our path | conclusion |
|---|---|---|
| yes | yes | traversal is not the gate; the definition path was |
| no | yes | traversal is the gate |
| no | no | neither is the gate |

**P2: now the live probe, because our image IS loaded and the start still fails with 12030.** Run with Microsoft's
standard x64 (UEFI) OpenHCL image in place of ours. That separates "our linux-direct image" (E3) from "OpenHCL on this
build". Its cheapest form (the in-box DLL pinned by path) already showed that the pin is honoured.

**P2 is running (enclave-d1).** It uses Microsoft's own release images, fetched from the source the harness uses: flowey
`download_release_igvm_files_from_gh.rs`, which takes the `x64-openhcl-igvm` artifact of the latest successful
`openvmm-ci.yaml` run on `release/1.7.2511` (run 33556260031, commit `29e15ab83bce`, 2026-09-01, expiring 2026-11-30).

| image | what it is | bytes | sha256 |
|---|---|---|---|
| `openhcl.bin` | the standard image (UEFI in VTL0) | 21,446,868 | `48773995cfa2222ca7bb40020a807dcb8ce155a244b0987ba55334caafe49075` |
| `openhcl-direct.bin` | Microsoft's own linux-direct release | 38,618,676 | `2f640f33884e65389886a77212d20e712e49114a53563e53a395a5cf97e61821` |

Both declare `VSM_ISOLATION` and `highest_vtl 2`, as ours does.

| `openhcl.bin` | `openhcl-direct.bin` | reading |
|---|---|---|
| starts | 12030 | the linux-direct class is what this build cannot start (E3 on hardware) |
| starts | starts | something specific to our image |
| 12030 | 12030 | OpenHCL on this build |

## E7. OpenHCL's boot log has no serial route on this build

This comes from source (`openhcl/openhcl_boot` at `a7b0bd4`); it corrects a guess in E4.

- The boot shim does not parse `OPENHCL_BOOT_LOG` at all. The string appears only in IGVM manifests, never in
  `openhcl_boot`'s code. `boot_logger_runtime_init` logs to serial only when the HOST describes a COM3 in the device
  tree (`partition_info.com3_serial` is `ComInfo::Ns16550`). Otherwise the logger is `Logger::None`, and the log stays
  in memory.
- So neither `FirmwareParameters` nor a rebuilt image can redirect it to COM1. On a build without COM3 support (petri:
  below 27653; this host is 26200), VTL2's boot log is unreachable over serial.
- The only way in is `ohcldiag-dev` (kmsg over hvsocket), and only while VTL2 is running.

**ohcldiag-dev is a stated blocker, not something to route around.** openvmm's cross-compile guide builds Windows
binaries against the Windows host's Visual Studio Build Tools and Windows SDK. warden-host has the
`x86_64-pc-windows-msvc` Rust target and `lld-link`/`clang-cl`, but no Windows SDK or CRT. Fetching them with `xwin`
would mean accepting Microsoft's license, and building on the box is the box owner's resources call. Both are therefore
a resources question for Steven (enclave-d1 agrees). If P2 answers the question, the tool may not be needed.

## The lesson (enclave-d1's, recorded at their request)

The falsifying test was available all evening and cost one run: pin a file that is definitely readable and definitely
wrong, and see what the worker says. Three observations each looked like "our file is ignored". Everything between the
registry gate and P2 swept the parameters of a mechanism that had been misdiagnosed. Ask for the cheapest discriminator
first.
