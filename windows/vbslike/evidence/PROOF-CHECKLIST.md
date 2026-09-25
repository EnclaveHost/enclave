# Isolation proof checklist: nucbox-k11, type-1 (VBS) partition, pinned non-debug a7b0bd4 paravisor

Owner: enclave-d1. Contract and trust-boundary review: enclave-5d (`isolation/m3/PARAVISOR-ATTESTATION-CONTRACT.md`).
Build and pins: enclave-53. Last updated 2026-09-25 ~05:25 UTC.

The target is exclusion of the ordinary Windows host OS (the root partition's VTL0) under a trusted lower layer:
TPM, platform firmware and boot chain, hypervisor, and the root's secure kernel (VTL1). Physical access is out of
scope.

Every line is exactly one of:
- **VERIFIED**: observed on this host, with a reproducible artifact;
- **SOURCE**: argued from pinned source or vendor documentation, not observed;
- **UNTESTED**: assumed or open;
- **BLOCKED**: cannot proceed, with the reason.

A successful app response, a type-1 boot, or a refused Save-VM is none of these for host exclusion.

**Current verdict: host exclusion NOT established. `host_excluded=no`. Admission unchanged.**

## O1. What enforces exclusion of the ordinary host OS

- VERIFIED: the partition is configured as type 1 (VBS). The read-back shows `GuestStateIsolationType=1`, and the
  guest's CPUID states `isolation_priv=true` and `hv_isolation=vbs` (`type1-isolation-2026-09-25.md`, canary 050338).
- SOURCE: enforcement is the hypervisor's, not the CPU's memory encryption. OpenHCL classes VBS as not
  hardware-isolated (`vmm_core/virt/src/generic.rs:149-151`) and its attestation as "software-attested"
  (`vm/devices/tpm/tpm_device/src/ak_cert.rs:19-25`).
- UNTESTED: that the root's VTL0 cannot read or write this partition's memory. The only documented host
  instrument, Save-VM, is refused on type 1, and the vmwp reader failed its type-16 positive control.
- BLOCKED (parked by direction): the host-memory experiment (E3). Report testing does not replace it.

## O2. Which guest, runtime and app bytes the measurement covers

- SOURCE: the VBS launch digest hashes the full content of every measured page, records unmeasured pages by
  number only, skips shared pages, and measures VP registers last (`igvm` b7e717d `igvm/src/measurement/vbs.rs:140-162, 257-280`).
- SOURCE, today's production path (UEFI in the IGVM, our DVD medium booted by UEFI): the paravisor, its static
  command line and the UEFI image are measured. **Our medium is NOT** (`vm/loader/src/uefi/mod.rs:439-457`;
  `underhill_core/src/loader/mod.rs:442-747` writes host-derived UEFI config at runtime).
- SOURCE, the proposed construction (Linux VTL0 inside the IGVM):
  - igvmfilegen accepts a `linux` VTL0 image in an OpenHCL IGVM (`vm/loader/igvmfilegen/src/main.rs:1453-1545`).
  - The kernel, initrd and VTL0 command line are imported as measured pages (`vm/loader/src/linux.rs:478,531,592`;
    `vm/loader/src/paravisor.rs:913-965`).
  - At runtime the paravisor appends `OPENHCL_CMDLINE_APPEND` to that command line
    (`underhill_core/src/loader/mod.rs:159-185`). That variable, and `OPENHCL_FORCE_LOAD_VTL0_IMAGE`, come from the
    paravisor's own environment (`options.rs:462-467`), which derives from its kernel command line
    (`underhill_init/src/options.rs:21-75`).
  - On a non-debug isolated image, the boot shim uses only the measured static command line and ignores the host's
    (`openhcl_boot/src/main.rs:671-672`; `host_params/dt/mod.rs:1027-1039`).
  - So the whole VTL0 command line is fixed by measured bytes, provided the static command line contains no
    confidential-debug flag.
- SOURCE: not covered in either construction:
  - host-derived runtime configuration handed to VTL0 (memory layout, ACPI and device tree:
    `underhill_core/src/loader/mod.rs:186-197`, the `LoadLinuxParams` passed to `load_linux`);
  - the app. Apps are loaded at runtime over the control port, so their identity (AppID) reaches a verifier only
    as a statement made by measured code, through report_data.
- UNTESTED: nobody has built a VBS IGVM with a Linux VTL0 image. The type-16 linux-direct boots of 09-24/25 failed
  (12030) under different placement settings, which is no evidence either way.
- Runtime: the wasm runtime binary lives in our initrd, so it is covered once the initrd is measured (SOURCE, same
  citations). RuntimeID is bound in report_data by measured code, as on the SNP path.

## O3. Report signer and trust root

- VERIFIED (`trust-root-2026-09-25.md`):
  - the host's current boot log replays to its TPM's PCRs 0-14, with both negative controls detected;
  - the secure kernel logged VSM_IDK and VSM_IDKS RSA-2048 public keys in PCR 12.
- SOURCE (Microsoft, for enclave reports only): trust runs TPM, then hypervisor and secure kernel health, then the
  IDKs in the measured boot log.
- VERIFIED GAP: Secure Boot is OFF and test signing is ON in this host's measured boot. The production enclave
  engine is test-signed, so this is how the node currently runs. A verifier holding to Microsoft's requirements
  should reject this boot state.
- UNTESTED: that IDKS signs the VbsReport the paravisor obtains. The report's 256-byte signature field fits
  RSA-2048, which is consistency only.
- UNTESTED: a TPM quote signed by an attestation key that chains to the TPM's endorsement certificate. Needs a
  host-security decision (see Next).
- UNTESTED: that host-controlled code, under test signing, cannot reach IDKS.
- RULED (enclave-5d, contract `aebd6bd7`):
  - The trust root is "host TPM plus IDKS under an ACCEPTED boot state". Secure Boot off, or test signing
    measured on, is a REJECTION condition. On this host both hold today, so a conforming verifier must reject
    any report from it.
  - "IDKS signs the VbsReport" stays a HYPOTHESIS until real report bytes verify under the same boot's IDKS.

## O4. Fresh verifier nonce and guest-held TLS key, authenticated to the measured instance

- SOURCE: the vTPM interface puts 64 guest-chosen bytes into the report through `report_data = sha256(runtime-claims
  JSON)` (`design/paravisor-attestation.md`, reviewed by enclave-5d).
- SOURCE GAP: today's medium is unmeasured, so a host can boot the same measured paravisor with its own VTL0 and
  obtain a genuine report over data it chose. A host-supplied key hash would attest host-controlled data. The
  prerequisite is O2's measured Linux VTL0.
- SOURCE GAP: the vTPM's seeds and AK are in plaintext in the host-held VMGS, so AK quotes carry no trust
  (`vmgs_impl.rs:690-701`, `tpm_device/src/lib.rs:663-671`).
- BLOCKED (parked): capturing report bytes through the vTPM interface. enclave-5d's probe stopped at a provider
  safety block and is not rerouted.

## O5. Refusal tests on real evidence

| test | status |
|---|---|
| host log: altered key bytes / altered digest | VERIFIED detected (`tcglog.py replay`, NEGATIVE 1 and 2) |
| debug paravisor rejected (pinned release measurement + `debug_allowed == 0`) | UNTESTED: needs report bytes |
| substituted measurement rejected | UNTESTED: needs report bytes |
| replayed report rejected (nonce in user-data) | UNTESTED: needs report bytes |
| wrong key binding rejected | UNTESTED: needs report bytes and O2 |
| cross-VM report rejected | UNTESTED: needs report bytes from two VMs |
| positive control: a correct report accepted | UNTESTED: needs report bytes |

## Next, and who decides

1. **Steven:** the host's trust-root boot state. Secure Boot and test signing are excluded from this lane, and the
   production enclave engine depends on test signing.
2. **Steven:** whether a TPM quote may be taken with a host attestation key. It is read-only on PCRs but creates or
   uses a TPM key.
3. **enclave-5d and enclave-53:** a VBS IGVM with our kernel, initrd and command line as a measured Linux VTL0 (build
   only; a boot needs the usual handoff).
4. **Parked:** report-byte capture and E3.
