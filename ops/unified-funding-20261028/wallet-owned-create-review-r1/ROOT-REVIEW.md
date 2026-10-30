# Wallet-owned creation: root source review

Root independently read the verified deployed ledger create, transferDeployment and fundFor bodies, plus legacy vault execute, library create, _create and _requireHeldEnv. They agree with the peer review: create assigns msg.sender; the existing vault funds itself after creation. A client patch cannot change immutable execution.

A new executor could atomically create an empty record, transfer the unchanged ID to its fixed verified controlling wallet, and attribute funding to that wallet. This is an unimplemented candidate, not a transaction simulation or deployment. It does not solve existing funded DNS/KVM escrow or owner-keyed gas reserve migration.

Preserve existing signature/replay/session action, app and deployment scope, liveness/expiry/attestation, one spending budget and fee accounting. Wallet delegation to a new executor is not implied by an old grant. Environment and exact-content policy must agree across executor, relay, host and secrets; retaining or deleting held metadata alone is insufficient. Global Enclave approval must not become an independent owner's policy authority.

The peer is authorized to PREPARE ONLY concrete source-author inputs, with no product edits, launch, tests, builds or financial/live effects. Root must inspect those inputs and independently verify account/resources before any author. Current a62 Release and cab8 Promote remain human signature handoffs; no ownership change is observed.
