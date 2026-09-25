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

## Candidate path (pending the source trace)

To be filled from the a7b0bd4 source with file:line citations, then reviewed by enclave-5d.

## Out of scope and still parked

- E3 (host memory read on type 1) stays NOT RUN with no documented instrument. Report testing does
  not replace its missing evidence.
- Stock release 2511 (`cfd40ce2`) is not rebuilt to explain its separate failure.
