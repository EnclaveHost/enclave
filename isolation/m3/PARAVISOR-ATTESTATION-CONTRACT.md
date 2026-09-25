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
5. **Debug rejection.** The verifier rejects any report whose policy allows debug, and any image outside the pins
   (the probe firmwares are already refused by enclave-53's verifier rule).
6. **Signer and root.** The verifier checks the report signature against a key whose provenance a remote client can
   establish, and names that key and its root. That is established only by verifying real report bytes.
7. **Same boot, non-debug.** Every result comes from one boot of the non-debug control platform. Debug-image results
   are diagnostic only.

## Tests required before any claim

On real report bytes from the non-debug platform:
- the signature verifies under the named key, and the chain reaches the named root;
- a fresh nonce is present, and an old report is rejected (replay);
- a report with a substituted key hash, appId or runtimeId is rejected;
- a report from another VM is rejected (cross-VM);
- a debug-policy report is rejected.

## Open questions (to be answered from cited source, then measured)

- Which existing guest ↔ paravisor path, if any, lets the guest ask for a report over its own data. The candidate
  under trace (enclave-d1) is the vTPM attestation-report NV index (`TPM_NV_INDEX_ATTESTATION_REPORT`).
- What that path places in the report's report data, and in what format the guest reads it back.
- Whether anything in the report binds VTL0's payload, or only the paravisor's image.
- Whether debug is visible in the report.
- Which key signs a VBS report, and what it chains to.

If a property cannot be provided, record the precise missing property and the legitimate prerequisite. Never
substitute a configuration flag or a boot result for it.
