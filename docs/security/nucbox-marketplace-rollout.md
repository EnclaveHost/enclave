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


## Restricted marketplace enabled — 2026-09-30 02:02 UTC

At the owner's explicit request, NucBox's existing restricted policy now has
`marketEnabled: true`. The public API reports `ownerOnly:false`,
`eligible:true`, `serving:true`, `tier:enclave-shield`, and the node reports
`claimScope:market` and `claimEnabled:true`. The live host page shows its public
capacity instead of OWNER-ONLY. This is an operational rollout, not a claim that
the complete security qualification is finished.

The missing us-west `fleet.mjs` update was deployed. All three relays now use
SHA-256 `aae0102de3d605d848953303d8179c279160662ff5a415e6414e91273d6d2041`.
The change preserves per-app evidence expiry when the host becomes marketplace
eligible: capacity admission alone never authorizes an app connection. The API
relay restart exercised fresh tunnel attachment and fresh evidence acquisition;
all four existing apps requalified and all four certificate requests passed.
No production guest VM was restarted. CPU demos and Eyesoff remained reachable.
The 64-GiB app pool and separate 12-GiB masked GPU budget are unchanged. Both
GPU fixtures returned HTTP 200 and 16 tokens with their explicit
`graph=qwen2.5-0.5b-q8-gguf` query. A bare `/` asks for an absent graph named
`model` and returns 500; that is not an admission or TLS regression.

Host diagnostic qualification added a working positive control: the debug twin
of the pinned CPU image returned `/proc/version` and exported a 54,906,880-byte
ELF core for its paravisor PID 1. The production image refused both operations
with `unknown service diag.UnderhillDiag` and exported zero core bytes. Both
variants were separate disposable VMs, removed afterwards. The debug core was
hashed and deleted on the host; it is not published. The debug image is not in
the app admission policy. This establishes that the host diagnostic memory-dump
path is disabled in the production image, not that every possible host memory
access is excluded. The earlier LiveKD result remains inconclusive.

The disposable app-readiness probes timed out in both diagnostic fixtures;
they are **not** application-serving passes. Serving and certificate checks use
the four existing production deployments and their fresh, independently verified
app evidence instead. A broader raw host-memory access test, an actual new
non-owner deployment, and a full hardware reboot qualification remain open.
Do not describe these as completed or turn this rollout into an operator-exclusion
claim. The physical operator and hypervisor remain trusted. Existing restrictions
on private deployments, secrets, unsupported configuration and GPU models remain.

Validation: 29 distinct targeted fleet/routing/Shield-verifier tests passed.
The evidence summary is `nucbox-marketplace-20260930.json` beside this document.

Rollback: restore `/etc/nan-relay/shield-policy.json.before-market-20260930` on
Nan and restart `enclave-api-relay.service`. This withdraws marketplace admission;
it does not remove existing app VMs. The us-west routing backup is
`/opt/nan-relay/fleet.before-market-20260930.mjs` (the new routing checks can remain
in place while marketplace admission is disabled).
