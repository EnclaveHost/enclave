# Direct native RPC bootstrap (not activated)

The first deployment may use a single explicitly configured host with an operator coordinating startup. Automatic app-manager bootstrap orchestration, multi-host recovery and full refusal/failure demonstrations remain outstanding. This does not complete decentralized production RPC.

The compiled controller command is:

```
bootstrap-controller.exe bootstrap-staged <manager-config> <manager-config-sha256> <original-attempt-sha256> <bootstrap-config> <bootstrap-config-sha256>
```

The original v2 manager must already hold owned VM definition and completed native start receipts. The bootstrap configuration has the exact fields in `NativeBootstrapContract.ConfigurationKeys`; it pins this controller, the separate SYSTEM bootstrap worker, existing Node/TPM executables, protected host key, fixed JavaScript closure, original expected app identity and EK chain. Configuration and keys stay in the protected target namespace, never Git. Operator key pins do not replace independent storage-owner authorization or attestation.

The controller consumes its original bootstrap subtree before preparation. It schedules independent SYSTEM owner/observer processes, verifies original live lifecycle keepers and current admission, then opens the one-shot work gate. It emits a four-byte big-endian length followed by a UTF-8 JSON `native-rpc-bootstrap-enrollment/1` frame. Only public enrollment material is emitted. The operator transport must return one framed `native-rpc-bootstrap-offer/1` object with the exact enrollment SHA256 and the original owner's signed offer, then close stdin. A second output frame reports acquisition requested only after exact bootstrap process cleanup. All frames are bounded to 131072 bytes. Unknown or interrupted outcomes remain consumed; do not repeat the command.

The original 900-second attempt clock is unchanged. Controller lifetime is at most 30 seconds; bootstrap phase at most 25 seconds and must start with at least 125 seconds left on the original clock. Owner service preparation and delivery must fit that same window. The owner service must use the real guest enrollment to bind its prepared request, certificate, policy and durable writer journal. That operator-side exchange is not yet integrated.

Bootstrap admission retains native floors, prospective commitments and both possible cleanup groups, adds a 512 MiB bootstrap-group allowance, and credits only the exact original running guest's verified 19 GiB allocation at both observation endpoints. This avoids counting already-resident guest memory twice. Current SYSTEM/provider observations and total host fit remain unqualified. Registration, controller and collection overheads require separate accounting.

Acquisition is not RPC readiness. The real SYSTEM launch, TPM/AF_HYPERV exchange, storage-owner settlement, NBD/verity mounts, client resource fit, sync/finality, serving adoption and consumer cutover remain unproven. Independent keepers still enforce the original deadline; this command does not make serving persistent.
