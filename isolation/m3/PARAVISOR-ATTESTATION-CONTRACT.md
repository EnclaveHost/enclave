# Paravisor-mediated attestation on the NucBox: the contract

Dated 2026-09-25.
- **Platform:** the pinned, non-debug openvmm a7b0bd4 paravisor (enclave-53's CONTROL build `32d464cc`), on a
  type-1 (VBS) partition with Guest VSM opted out. That configuration boots and serves (VBS-ISOLATION.md section 4).
- **Owners:** enclave-5d owns this contract, source feasibility and the runtime interface. enclave-d1 owns the
  hardware and cleanup; enclave-53 owns builds and pins.

**Status: DESIGN. Nothing here is established.**
- No report bytes have been captured.
- No signature, signing key or root has been verified.
- The customer chain does not exist yet.
- `host_excluded=no`, and E3 is NOT RUN.

## What is known, at the strength it is known

- A type-1 guest boots and serves on this platform (measured).
- VTL0's `HvCallVbsVmCallReport` returned 0x71, `HV_STATUS_OPERATION_FAILED`. That is not "access denied", and one
  call on one image does not show that VTL0 can never obtain a report.
- VTL2 obtaining a VBS report is strongly supported by inference (the debug image's kmsg plus the source order in
  `secure_key_release.rs:174-185`), on the DEBUG image only. No bytes were seen.
- The VTL2 → VTL0 pairing spans two images (debug 81e163ee, control 32d464cc). It is not a same-image result.

## Requirements the prototype must meet

1. **Key custody.** The TLS key is generated and held inside the guest domain. Only its public key (or its hash)
   leaves it.
2. **Binding.** The report binds, in its signed report data:
   - the verifier's fresh nonce;
   - the hash of that guest-held public key;
   - the measured app identity (appId) and runtime identity (runtimeId), as in the existing ABI/2 binding.
3. **Authenticated association.** The binding request comes from the guest through an interface of our own pinned
   paravisor, or a supported existing one, never from data the host supplies. A report over a host-chosen value is not
   evidence of key custody.
4. **Measured identity.** The report names the measured paravisor image, and the verifier pins it. How VTL0's own
   payload is bound to that identity is an open question (see below) that must be answered before any claim.
5. **Debug rejection.** The verifier accepts ONLY an exact pinned VBS launch digest. It rejects any report whose
   `policy.debug_allowed` is set, and any image outside the pins (the probe firmwares are already refused by
   enclave-53's verifier rule). Two debug switches exist, and only one of them shows up in a flag:
   - `debug_allowed` (`hvdef/src/vbs.rs:93-95`) is the ISOLATION debug switch, the manifest's `enable_debug`;
   - OpenHCL's confidential debug (`OPENHCL_CONFIDENTIAL_DEBUG=1` in the static line, which makes the paravisor trust
     the host) does not set it. igvmfilegen's identity document also says `debug_build=false` for confidential-debug
     images (enclave-53, measured on 726d3cb5 and 81e163ee).

   So neither flag tells a host-trusting image from the candidate. Only the exact digest does, because the static
   line is in measured bytes. The debug twin's digest (0677F3C6…) is listed by name as a rejection.
6. **Signer and root.** The verifier checks the report signature against a key whose provenance a remote client can
   establish, and names that key and its root. That is established only by verifying real report bytes.
7. **Same boot, non-debug.** Every result comes from one boot of the non-debug control platform. Debug-image results
   are diagnostic only.

## Trust root (ruled 2026-09-25, on enclave-d1's trust-root review 3b3e32d9 / 6d4adb19)

**The accepted root is the host's TPM plus the secure kernel's IDKS key, under an ACCEPTED boot state.**
- The verifier replays the host's measured-boot log against a TPM quote and takes IDKS from that log.
- It accepts the boot state only if Secure Boot is ON and test signing is OFF, as Microsoft's documented VBS chain
  requires ("Microsoft-signed components configured in a secure way").
- **Secure Boot off, or TESTSIGNING measured on, is a rejection condition.** On boot 67 both held (PCR 7
  SecureBoot=00; TESTSIGNING=01 in PCRs 12/13), so a conforming verifier had to reject any report from it. Steven
  changed that for boot 68 (below). The node's test-signed enclave engine is retired (Steven's direction); the node
  now starts without it.
- **"IDKS signs the VbsReport" is a HYPOTHESIS** until real report bytes verify under this boot's IDKS. The signature
  field's size (256 bytes) is consistent with RSA-2048 IDKS; that is all.
- A signed TPM quote needs a host attestation key, which is also Steven's decision.

Verified by enclave-d1, read-only on the host: the boot log (sha256 0c23255a) replays to SHA-256 PCRs 0-14; negative
controls are detected; the VSM_IDK and VSM_IDKS RSA-2048 keys are in PCR 12, event 37 (IDKS modulus sha256
3d7304dd…77e75f).

**Boot 68 (Steven, rebooted 05:32:35Z with Secure Boot ON).** Measured read-only by enclave-d1:
- SecureBoot=01 in PCR 7, TESTSIGNING=00 in every section, all debug flags 00, VSM launched, HVCI on;
- the log (8ee177c4…) replays to PCRs 0-14, and the negative controls are detected;
- new IDKS modulus sha256 402f2281…01a9.

The two rejection conditions are **not present on boot 68**. That is not a pass of anything else. Evidence from boot 67
and earlier is void for same-boot purposes.
- Service impact: the test-signed enclave engine no longer loads, so the old VBS-enclave service and its apps are
  down.
- Under Secure Boot our unsigned control IGVM loads and serves on type 1 with `AllowFirmwareLoadFromFile` set
  (enclave-d1 canary 054323), and without it the load is refused (054616, Worker 5142).

From the TPM feasibility work (enclave-d1 878a3074): the host-side chain EK → quote → log → IDKS verifies on real
bytes for a VBS **enclave** report. IDKS signing a VM report stays a hypothesis.

## Measured VTL0 (source; one candidate built and booted, no report)

- igvmfilegen can place our kernel, initrd and VTL0 command line inside the IGVM as measured (`Exclusive`) pages
  (`vm/loader/src/linux.rs:478, 531, 592`; `paravisor.rs:944-951`). The VBS digest hashes the full content of
  measured pages (igvm `measurement/vbs.rs:140-162`). For our VBS candidate, enclave-53's build-time mutations show
  that the kernel, initrd and VTL0 line each move the digest, and d1's canary shows the candidate boots as type 1
  (below). No report has shown that digest yet.
- With no confidential-debug flag in the static command line, the whole VTL0 command line is fixed by measured bytes.
  The paravisor's runtime append comes from its own measured command line, and the host's is ignored
  (enclave-d1; `underhill_core/src/loader/mod.rs:159-185`, `openhcl_boot/src/main.rs:671-672`).
- NOT covered: the host-derived memory layout, ACPI and device tree given to VTL0 (`loader/mod.rs:186-197`), and
  the app. The app is loaded at run time, so its identity is the measured monitor's statement, which must itself be
  carried in the report data.

### Review of enclave-53's candidate 5562e71d (2026-09-25; build-only, not booted)

The candidate is `vbs-linux-candidate.bin`, VBS launch digest 246DEE1B…89F0. Its VTL0 is our kernel 363b3553,
initrd 0d14db23 and the line `console=ttyS0 rdinit=/init loglevel=3 report_host=9001`. The rulings below are from
source at a7b0bd4. They are not a boot result.

1. **`OPENHCL_FORCE_LOAD_VTL0_IMAGE=linux` in the measured static line: required, and nothing else belongs there.**
   - The load kind is picked in exactly two ways: this variable, or else the host's DPS (PCAT if
     `firmware_mode_is_pcat`, UEFI otherwise) (`underhill_core/src/worker.rs:2078-2091`).
   - The candidate carries no UEFI or PCAT image. Without the variable, the host picks a load path that has nothing
     to load.
   - With the variable in measured bytes, the host's DPS cannot send the paravisor to a different VTL0 image.
   - Nothing else is needed. Microsoft's direct-release manifest adds `OPENHCL_BOOT_LOG=com3` and
     `OPENHCL_IGVM_VTL2_GPA_POOL_CONFIG=debug`, and the candidate must carry neither, nor any
     `OPENHCL_CONFIDENTIAL_DEBUG`.
2. **`static_command_line`: set it to true for the candidate.** This changes the digest, and a not-yet-booted
   candidate is the cheapest place to change it.
   - The policy's only consumer is `openhcl_boot/src/host_params/dt/mod.rs:1026-1040`.
   - With `APPEND_CHOSEN`, the host's line is dropped only when `can_trust_host` is false.
     `can_trust_host = isolation_type == None || static confidential debug` (`openhcl_boot/src/main.rs:671-672`).
   - On VBS, `isolation_type` is a RUNTIME read of the partition's isolation privilege (CPUID 0x40000003), not a
     measured value (`openhcl_boot/src/arch/x86_64/vsm.rs:9-19`).
   - `STATIC` makes the paravisor's kernel command line exactly the measured bytes on every launch, whatever that read
     returns.
   - It makes no difference on a type-1 launch, because the host's line is dropped there already.
   - The same read still gates trust in the host's alias map (`dt/mod.rs:1158`) and COM3 logging (`main.rs:264`). So
     the hypervisor's report of the partition privilege is in the trusted base. That is the trusted lower layer
     Steven's bar assumes anyway.
   - The debug twin can keep the same manifest plus `--confidential-debug`. It then only loses host-appended
     arguments.
3. **VTL2 memory: keep `memory_page_count` 16384 at `memory_page_base` 32768.**
   - This is Microsoft's cvm-release value for all three CVM platforms.
   - The VTL2 contents are the booted control's own components (the twin reproduces the control's digest).
   - enclave-53's layout map places the paravisor's kernel, shim, initrd and tables at 0x8200000-0x9EAD000, about
     29 MiB of the 64 MiB VTL2 range 0x8000000-0xC000000.
   - Our Linux VTL0 is imported entirely below it, at 0x1000000-0x5CED000, plus the measured config and VTL0
     command-line pages at 0x0-0x2000.
   - Choosing Linux instead of UEFI changes only the measured VTL0 config page inside VTL2.
   - Untested: VTL2's run-time heap with a Linux VTL0. If that fails, it fails at boot, and the debug twin reads it.
   - The VM's memory must cover GPA 0xC000000 plus VTL0's working set.

**Rebuilt per ruling 2 (enclave-53, package v28 840eb861).** The candidate is
now `c567e432…d637`, VBS launch digest A0FDAC0F…A244, deterministic. The only change is `static_command_line=true`;
the VTL0 command line is unchanged. The debug twin is `24e7a1ff…`, digest A650C020…157E, a named rejection. The
pre-review pair 246DEE1B… / 0677F3C6… are superseded rejections. enclave-53's mutation evidence, re-run on every
rebuild:
- the static line plus ` mutation_test=1` gives 4D628242…;
- `static_command_line=false` gives 246DEE1B…, exactly the pre-review candidate, so the policy flag is measured;
- one byte of the kernel, one of the initrd, or a change to the VTL0 line gives 8307B597…, 63463B2C… and 26372500….

**Booted (enclave-d1, canary 061934, evidence 0564ff8d).** c567e432 started as type 1 under Secure Boot, with no
medium, disk or NIC; the IGVM has no UEFI.
- MON ready came at 319 ms, with the boundary line `hv_isolation=vbs host_excluded=no`, and the control channel
  answered on 9000.
- The guest reported memMiB 1833, against 1828 on the UEFI path, in the same VM size. That difference is the
  host-supplied memory map (below), which the digest does not cover.

This shows only that the measured-Linux-VTL0 type-1 path boots. It gives no report, no signer and no chain, and
`host_excluded=no`. Requirements 2, 3 and 6 are untouched.

**Still host-supplied at run time, and so NOT in the digest** (enclave-d1's question (a)):
- the VTL2 device tree and the topology it carries (CPUs, memory map, MMIO; an IGVM parameter area the host fills);
- the ACPI tables and memory map that the paravisor builds for VTL0 from it;
- the DPS, except the load kind, which ruling 1 fixes;
- VMBus offers;
- the vTPM's contents.

The guest's identity is its digest alone. The monitor's boundary tuple must not gain anything from these inputs, and
any of them that matters for safety (memory size, CPU count) is checked by the guest, never taken on trust. None of
this gives the candidate a customer chain: requirements 2, 3 and 6 are untouched, and `host_excluded=no`.

## Tests required before any claim

On real report bytes from the non-debug platform:
- the signature verifies under the named key, and the chain reaches the named root;
- a fresh nonce is present, and an old report is rejected (replay);
- a report with a substituted key hash, appId or runtimeId is rejected;
- a report from another VM is rejected (cross-VM);
- a debug-policy report is rejected.

## Open questions (to be answered from cited source, then measured)

- ANSWERED FROM SOURCE ONLY (a7b0bd4; enclave-99's contract V5 at main a18ec469): the guest's path, and what it binds.
  - It is the vTPM NV path. The guest writes 64 bytes to `TPM_NV_INDEX_GUEST_ATTESTATION_INPUT` (Bind2(SPKI, nonce,
    runtimeId) || AppID for us).
  - A read of `TPM_NV_INDEX_ATTESTATION_REPORT` renews the report, at most once per 2 s. A renewal that is rate-limited
    or fails returns the previous report (tpm_device lib.rs:92, :97, :1141-1152, :1396-1411).
  - report_data = SHA-256(runtime-claims JSON as serialised) || 32 zero bytes. The claims are {keys: the vTPM's AK/EK,
    vm-configuration: host-supplied, user-data: hex of the 64 bytes} (get.rs:339-392; igvm_attest/mod.rs:146-185,
    :357-362).
  - The guest reads back IgvmAttestRequest VERSION_1: the hardware report plus the claims, with their length stated
    twice (emuplat/tpm.rs:54-101; mod.rs:269-332).
  - Stale is only ever a refusal, because the verifier's nonce makes a stale report fail.
  - UNTESTED: whether a type-1 partition serves this path on the box; no report bytes have been seen.
  - The keys and vm-configuration in the claims are statements only (the vTPM state is host-readable here), and nothing
    admits on them.
- Whether anything in the report binds VTL0's payload, or only the paravisor's image.
- Whether debug is visible in the report.
- Which key signs a VBS report, and what it chains to.

If a property cannot be provided, record the precise missing property and the legitimate prerequisite. Never
substitute a configuration flag or a boot result for it.
