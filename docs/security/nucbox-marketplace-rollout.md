# NucBox marketplace rollout — 2026-09-29

Target: public marketplace hosting through Enclave Shield. Public HTTPS for the
owner's apps is already working; it is not marketplace admission.

Implemented prerequisites:

- `relay/shield-app-policy.mjs` checks the full TPM/IDKS/app report chain, an
  explicitly paired TPM EK/firmware PCR0, an explicitly paired image/runtime,
  and optionally the certificate parser's CSR SPKI hash. No policy is installed
  by default. A successful result names one app/key, not host-wide eligibility.
- The tunnel retains its authenticated host context privately for per-app
  verification. It never accepts a caller-supplied replacement host session and
  does not export the credential in fleet rows or the `info` method.
- The node's bounded `GET /v1/shield/evidence?deployment=<full id>&nonce=<32-byte hex>`
  forwards fresh evidence through the running public partition's actual TLS
  connection. It returns public evidence, not an admission verdict. Private,
  missing and stopped deployments are refused. At most two reads run together.

Still required before promotion:

1. Complete a meaningful host-access qualification for the measured image.
   LiveKD 5.65 against a disposable type-1 VM failed reading partition registers
   with `0xc0350005`; this is not an isolation pass. The ordinary guest control
   powered off, and the old type-16 control image failed to start. Neither is a
   valid positive control. All disposable VMs were removed; production VMs were
   left running. Do not turn these tool failures into security evidence.
2. Wire the policy to independent ledger/catalog app derivation and certificate
   issuance, requiring the CSR key to match the verified guest key before any
   cache hit or ACME order. The current node-side launcher check is insufficient
   against an untrusted host.
3. Wire qualified capacity and per-app routing to that verified policy, then
   enable market claims. Restrict the initial offer to the features the measured
   runtime actually implements. Do not enable plaintext app proxying, private
   deployments, secrets or unsupported configuration as a side effect.
4. Exercise a deployment owned by a different customer, certificate/key
   substitution refusals, reconnect/reboot and evidence expiry; retain the
   existing owner's deployments and verify Metal0 remains reachable.

The owner-only admission decision has not changed. This document supersedes
older notes that said the guest report chain itself had not been implemented;
that chain now verifies on the production CPU and masked-GPU app images.
