# Paravisor-mediated attestation on nucbox-k11: requirements, tests and candidate path

Status: DRAFT (enclave-d1, 2026-09-25). Contract and trust-boundary review: enclave-5d. Exact build
and pins: enclave-53. Nothing here is implemented, run or verified yet. `host_excluded` stays `no`.

## Why this exists

On a type-1 (VBS) partition with the pinned a7b0bd4 paravisor, a VTL0 `HvCallVbsVmCallReport`
returned `HV_STATUS_OPERATION_FAILED` on the non-debug control image. On the debug image, kmsg plus
the source order strongly support that VTL2 obtained a VBS report for OpenHCL's own key release.
That is inference: no report bytes were captured and no signer was identified
(`../evidence/type1-isolation-2026-09-25.md`). E2 is NOT complete.

The route visible today runs through the paravisor. This milestone gets a report to a verifier
through that route, on the NON-DEBUG platform, with the binding properties below tested.

## Trust assumptions, explicit

The target is exclusion of the ordinary Windows host OS (the root partition's VTL0) under a trusted
lower layer. Trusted and NOT tested here: the hypervisor, the root partition's VTL1 (the secure
kernel that signs VBS reports, if it is the signer), the platform firmware and boot chain, the CPU,
and physical access. The paravisor image is trusted only as far as its measurement is checked.

## What the prototype must provide

Each is a property the verifier CHECKS, not one the box states.

| # | property | meaning |
|---|---|---|
| P1 | supported path | The report comes through a supported export path, or through an interface we implement in our own pinned paravisor. No protection bypass. No customer memory. |
| P2 | signer and root | The report's signing key and the root it chains to are identified, and the signature is verified by code that does not trust the host. |
| P3 | freshness | The verifier's nonce is inside the signed report. |
| P4 | app and runtime identity | The measured app (AppID) and runtime (RuntimeID) are inside the signed report. |
| P5 | key custody | The guest-held TLS public key is inside the signed report, AND the request that put it there provably came from the guest that holds the private key. A host-supplied key hash is arbitrary host data, not custody. |
| P6 | guest-to-paravisor association | The paravisor accepts report data only from the VTL0 guest it hosts, and the report says which measured VTL0 that was. |
| P7 | same-boot binding | The report and the measured-boot material it is checked against come from the same host boot. |
| P8 | debug rejection | A report from a debug paravisor (or any debug policy) is distinguishable and rejected. |

If the supported API cannot provide one of these, the design records WHICH property is missing and
why, and works the legitimate prerequisite. It never substitutes a boot or configuration flag.

## The tests, each with the forgery it must refuse

A test passes only if the verifier REFUSES the bad case. A verifier that accepts everything passes
none of them.

| test | the bad case the verifier must refuse |
|---|---|
| T1 signature | one flipped bit anywhere in the signed body; a report signed by any other key |
| T2 nonce | a report over a different nonce; a report with no nonce |
| T3 substitution | a valid report whose AppID, RuntimeID or TLS key was replaced by another value |
| T4 replay | a valid report from an earlier session presented again with a new nonce |
| T5 cross-VM | a valid report from a second canary VM presented as the first one's |
| T6 debug | a valid report from the debug paravisor image |
| T7 key custody | a report over a TLS key whose private half the guest never held |
| T8 control | the non-debug control image produces an acceptable report; otherwise T1-T7 test nothing |

## Candidate path: the vTPM guest-attestation interface (source-read, NOT run)

From the pinned openvmm a7b0bd4 tree. Citations were checked by enclave-d1 against that tree and
are pending enclave-5d's review. SAYS means the code states it; INFER is reasoning. Nothing here
has been executed on the box.

**The interface exists and is guest-initiated (SAYS).**
1. The guest creates NV index `0x01400002` (`TPM_NV_INDEX_GUEST_ATTESTATION_INPUT`,
   `vm/devices/tpm/tpm_protocol/src/lib.rs:43-45`) under owner, and writes 64 bytes to it.
2. The guest issues `NV_Read` of `0x01400001` (`TPM_NV_INDEX_ATTESTATION_REPORT`, `:39-41`) at
   offset 0. The vTPM refreshes the report BEFORE executing that read
   (`vm/devices/tpm/tpm_device/src/lib.rs:1644-1648`).
3. The refresh reads the 64 bytes (`:1138-1153`, all zeros if the index is absent) and asks VTL2
   for a VBS report through `HvCallVbsVmCallReport` (`openhcl/tee_call/src/lib.rs:375-391`).
4. It is rate-limited to once per 2 s. A rate-limited read returns the PREVIOUS report with only a
   log warning (`tpm_device/src/lib.rs:1398-1414`). A nonce check (T2) catches that.

**What the report binds (SAYS).** `report_data[0..32]` is SHA-256 of a JSON document and
`[32..64]` is zero (`openhcl/underhill_attestation/src/igvm_attest/mod.rs:173-179`). The JSON is
`{keys: [HCLAkPub, HCLEkPub], vm-configuration, user-data: hex(the guest's 64 bytes)}`
(`openhcl/openhcl_attestation_protocol/src/igvm_attest/get.rs:341-351, 369-388`).
`vm-configuration` is host-supplied and must not be trusted.

**What the guest reads back (SAYS).** A 2900-byte blob containing, in order:
- an `HCLA` header;
- the 0x230-byte `VbsReport`, holding `report_data[64]`, an identity (`measurement`, `signer`,
  `owner_id`, `host_data`, `policy.debug_allowed`, SVN and IDs) and `signature[256]`
  (`vm/hv1/hvdef/src/vbs.rs:13, 33-72, 88-97`);
- request data;
- the JSON.

**Against the properties:**

| # | property | this path | what is missing, precisely |
|---|---|---|---|
| P1 | supported path | yes: an existing guest-facing vTPM interface in our pinned paravisor | nothing, pending a run |
| P2 | signer and root | **unknown** | Nothing in the tree verifies a `VbsReport` signature or names its key. The code calls it "software-attested" (`tpm_device/src/ak_cert.rs:19-25`). Needs real bytes plus the platform's documentation. |
| P3 | freshness | yes, through `user-data` | the 2 s rate limit serves stale reports; the verifier must check the nonce |
| P4 | app and runtime identity | yes, if the guest puts them in its 64 bytes | nothing, pending a run |
| P5 | key custody | only if P6 holds | see P6 |
| P6 | guest-to-paravisor association | **NO** (INFER) | The measurement covers VTL2 and the UEFI image in the IGVM (`vm/loader/src/uefi/mod.rs:439-457`), not the runtime UEFI config or what UEFI boots, which includes our medium. A host can boot the same measured IGVM with its own VTL0 and obtain a genuine report over data it chose. |
| P7 | same-boot binding | capture the host TCG log in the same run (the boot script already does) | the link between the report's signer and that log is unknown until P2 |
| P8 | debug rejection | pin the release measurement AND require `policy.debug_allowed == 0` (INFER) | what sets `debug_allowed` is not in the tree |

**The vTPM's AK carries no trust here (INFER from SAYS).** The AK is re-derived each boot from
the TPM seeds, so it is the same key every boot (`tpm_device/src/lib.rs:663-671`). With "No VMGS
encryption used", the TPM NVRAM, seeds included, is written to the host-held VMGS in plaintext
(`vm/vmgs/vmgs/src/vmgs_impl.rs:690-701`). So AK quotes and PCRs are host-forgeable, and trust can
come only from the `VbsReport` signature.

**Proposed order (pending enclave-5d):**
1. Capture only. A PROBE medium on the non-debug control image creates `0x01400002`, writes a
   verifier-chosen 64-byte value, reads `0x01400001` twice more than 2 s apart, and emits the raw
   bytes over COM1, alongside the same-boot host TCG log. This turns E2 from inference into bytes
   and gives P2 real material. It needs a TPM driver in our VTL0 kernel (asked of enclave-53).
2. The P6 prerequisite, before any binding means anything: our VTL0 code must be inside the
   measurement. The legitimate route to investigate is carrying our kernel, initrd and command
   line inside the measured IGVM instead of on a medium UEFI boots. Whether igvmfilegen supports
   that for VBS is not yet checked.

## Reconciliation with enclave-5d's contract (`isolation/m3/PARAVISOR-ATTESTATION-CONTRACT.md`, dd31cada)

- The contract requires the report to name the measured paravisor image and the verifier to pin
  it, and to reject any image outside the pins. This draft adopts both, under P8 and P6.
- This draft adds a key-custody refusal test (T7) and a positive control (T8), which the
  contract's test list does not have. Sent to enclave-5d rather than edited into its file.

## Out of scope and still parked

- E3 (host memory read on type 1) stays NOT RUN with no documented instrument. Report testing does
  not replace its missing evidence.
- Stock release 2511 (`cfd40ce2`) is not rebuilt to explain its separate failure.
