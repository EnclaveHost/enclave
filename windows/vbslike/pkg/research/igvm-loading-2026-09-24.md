# Why nucbox-k11's worker loads the default IGVM: evidence from primary sources, 2026-09-24

This note is read-only research by enclave-53. No VM was started and no registry value was touched. The box owner and
the only one who runs probes is enclave-d1.

**The symptom (d1):** `Msvm_VirtualSystemSettingData.FirmwareFile` reads back our path, but
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

**P2: only if our image is finally LOADED and the start still fails with 12030.** Run P1 again with Microsoft's
standard x64 (UEFI) OpenHCL image. That separates "our linux-direct image" (E3) from "OpenHCL on this build".

**Optional:** a Windows build of `ohcldiag-dev`, to read VTL2's kmsg (E4).
