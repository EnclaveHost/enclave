# Phase 2 record: the HCS VirtualizationBasedSecurity mode (2026-09-23)

Phase 1 (README.md) stands. Phase 2 prepared the documented isolated mode of the same service, with an
OpenHCL paravisor image built from source, and probed which configurations the retail client accepts.
No host-wide change was made: no registry value, feature, boot, BitLocker or driver change, no reboot.

## Artifacts

| artifact | provenance | sha256 |
|---|---|---|
| openhcl-x64-test-linux-direct.bin (92,924,756 bytes) | github.com/microsoft/openvmm commit a7b0bd4, `cargo xflowey build-igvm x64-test-linux-direct --release`, warden-host | d240f40c53eb6fa016caaea9357dafbfea2048f18851a38f928fe25792df2864 |
| vmgstool, igvmfilegen | `cargo build -p vmgstool --release`, `cargo build -p igvmfilegen --release`, same tree | tooling, not shipped |

The IGVM declares one platform (VSM_ISOLATION, highest VTL 2). Its VTL0 is the project test kernel and
initrd; an image whose VTL0 is our kernel and mon.cpio.gz is an igvmfilegen manifest run with a custom
resources file (LinuxKernel, LinuxInitrd). Not done in this pass.

## Probe

`vbslike-host isoprobe` (host/src/isoprobe.rs) submits one HCS document per row and records the
HRESULT, the result document and the Hyper-V Compute and Worker event lines. Evidence:
evidence/isoprobe-2026-09-23.json and evidence/isoprobe-events-2026-09-23.txt. Unit tests
(host/src/hcs.rs, host/src/isoprobe.rs) pin the document generation and the error reporting; the
contract vectors still pass (`test-win.cmd`).

Summary of the rows: the phase-1 plain partition starts and stops as before; isolated rows need a
guest-state file and pinned memory to be constructed; with those, the service starts the partition
with the in-box paravisor from its default location, and the worker process for that partition then
exited on its own within the observation window (not investigated further); naming our own firmware
image by path is reported as not supported on the current host configuration. The details, per row,
are in the evidence files.

## Prerequisite for launching our own paravisor image

Microsoft documents the host setting for loading a developer firmware image in the OpenVMM guide
(user_guide/openhcl/run/hyperv.md, "Enable loading from developer file"). HOST-PREREQ.md records it as
documentation only, with the rollback. It was not applied.

## Tests for the isolated tier (designed, not runnable until the prerequisite is met)

The lab.mjs checks apply unchanged, because the guest image, the bundle and the domain ABI are the same;
the launcher gains an isolation option and must refuse to load an app into a partition whose reported
isolation type is not the one requested (fail closed). Crash independence and lifecycle checks are the
phase-1 ones. Evidence about the boundary itself would come from the paravisor reports and the service
properties of the partition, recorded next to the phase-1 documents.

## Cross-platform conformance (2026-09-23)

`isolation/conformance/` takes ONE bundle set and ONE guest image and compares what each backend did:
Linux SNP domain (T1) against a NucBox partition (T0-hv), image `44abb52b…` on both, bundles
`603bb7a7…` and `bba82d56…`. **27 of 27 must-match fields agree**: app IDs, `report_data[32:64]`, the
ABI/2 runtime identity, the binding, the app's answers, the refusals (wrong app, altered bundle,
restated runtime version, unauthenticated cache, ABI/1 downgrade) and the lifecycle guarantees. The
differences are stated rather than smoothed: T1 `attested` against T0-hv `monitor-signed`, a launch
measurement against a launcher key and an image hash, and which layer refuses an altered bundle (the
in-guest monitor on Linux, the launcher's contract mirror before a partition exists on Windows).
Timings carry their contention and are never compared. Evidence: `evidence/linux-record-2026-09-23.json`,
`evidence/windows-record-2026-09-23.json`, `evidence/conformance-2026-09-23.json`.

## Runtime direction (2026-09-23)

The artifact stays the portable component and is compiled inside each partition by the guest image's
runtime; `isolation/contract/RUNTIME.md` is the normative text and the launcher mirrors its runtime
identity and ABI/2 binding (`host/src/contract.rs`, `vbslike-host vectors`). The Pulley interpreter of
the earlier VBS-enclave work is not on this path.
