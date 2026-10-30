# Operator durability r1: root validation

Status: not deployable. Frozen 238-file delivery unchanged. All 18 author tests pass, including established-file loss across reconstruction and exact discharge of a provably unsent attempt. Four sponsored cases use the author's labeled client emulator and do not qualify the shipped bundle. Windows-log cases use TEST exclusion, not actual Windows ownership. Linux cases use real files/flock and one separate child. No live signing, transaction or production action.

The initial baseline was 18 pass / 2 fail / 0 skipped or cancelled. Both added root tests failed before reaching their intended boundary because their gate read diagnostics before the owner opened. That fixture failure is retained. Only the external fixture was corrected to defer diagnostics until an owner exists; product source and assertions were unchanged.

Corrected root boundary suite: 0 pass / 3 fail / 0 skipped or cancelled. Each failure reaches the actual chain.mjs direct sender with an inert wallet/RPC:

1. Deleting the established state file after the sending intent is persisted still permits one write.
2. Deleting its established marker at that same boundary still permits one write.
3. A durable unresolved sponsored authorization for account/chain/nonce70, retained across owner release/reconstruction, does not block a direct write at nonce70.

The first two confirm that operator-effects checks ownership but not the underlying durable-state continuity getter before effects. The third confirms that record-type-specific filtering fails to coordinate direct and sponsored account nonce obligations. The third fixture seeds a schema-valid TEST authorization record through the actual owned store; it does not claim actual client signing or network behavior.

Source review also finds sponsored authorization/signature/POST gates before persistence rather than immediately before their effects. This is not yet an executed shipped-client regression. Windows startup/configuration/exclusion and explicit recovery remain blockers. No private journals were accessed or modified.

Both bounded units completed/MainPID0; owned test directories removed, source pins unchanged. Baseline aggregate211MiB/minavailable32717MiB; corrected suite aggregate196MiB/minavailable32821MiB. 512MiB hard/450RSS/27648floor/oneCPU/noSwap, isolated loopback namespace. Test-only renew entrypoints exercise the legacy serialized sender; they do not authorize periodic renewals in the replacement protocol.

Next: narrowly repair these three reproduced failures and qualify sponsored final boundaries with the actual shipped client. Preserve all original failures, 18 passing cases and r12 consumer/transport fixes. Peer is preparing inputs only; no new author is launched or production deployment authorized by this review.
