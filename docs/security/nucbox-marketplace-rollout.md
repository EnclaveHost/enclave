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

## Restricted marketplace integration

The relay now independently derives the expected app identity from agreeing
ledger/catalog reads and CID-verified component bytes. Certificate issuance
requires fresh app evidence matching the CSR key before either a cache return or
an ACME order. Configured Shield hosts cannot fetch plaintext staged secrets.

`RELAY_SHIELD_MARKET_POLICY` names a local JSON policy with paired platform and
image/runtime pins, explicit host names, CPU/GPU profiles and `marketEnabled`.
False enables verification-only operation; no marketplace claim window is sent.
True permits a five-minute claim window only after an actual running app passes.
The window is bound to the authenticated tunnel connection and must be renewed
by fresh evidence. A reconnect invalidates it. At present a running qualification
app is needed to keep an otherwise empty host qualified; dedicated admission
witness bootstrapping is not implemented.

Public app routing remains TLS-only and per-deployment, even though the host is
counted as eligible capacity. The SNI fleet consumes each app's expiring evidence
entry. It never treats Shield capacity admission as blanket routing authority.
No private apps, plaintext secret delivery, config CIDs, arbitrary model volumes
or undeclared runtime capabilities are admitted. CPU components with no app
configuration and the measured Qwen 0.5B masked-inference profile are supported.
The hypervisor and physical operator remain trusted; this is not SNP/TDX operator
exclusion. The LiveKD failures above remain inconclusive, not security passes.

Live verification-only rollout: both CPU deployments and both masked GPU test
deployments pass independent catalog derivation and the full report/key policy.
Pending catalog versions retain the existing owner/delegated-owner testing
exception; they are not approved for other customers. Rejected/yanked versions
are always refused. A transfer or delegation expiry revokes that exception.
Background evidence attempts are spaced by one minute per app, including
failures, to avoid retry bursts against independent RPC providers.
