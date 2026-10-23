# Production custody v2 read-only reconciliation, 2026-10-23

The October 14 bootstrap remains live and unchanged. Its deployment record has been reconciled with live contracts, service files and a fresh AMD quote. A corrected candidate has now passed an isolated SNP startup/storage-outage/restart test. Secret lifecycle tests and production activation are still outstanding.

At 18:10 UTC, two Base RPC state providers agreed on block52994819 and the original vault's deployed code hash. The address-book entries secretVaultV2, secretVault, and hostOwnership were all zero. The previously inventoried committee remains epoch1 with one machine and threshold1. The known policy remains policyRev2/secretRev2, unpaused. These are known-ID reads, not an exhaustive current consumer inventory. At18:47 UTC, an additional event scan from block52849852 to a fresh agreed block found no new events on the original vault. Discovery uses one archive provider, so it is not independently exhaustive. Fresh quorum state reads also found the metal0 host active with no accepted or pending owner in the configured ownership registry; owner enrollment remains required for the corrected image.

At 18:15 UTC, a fresh random-nonce SNP evidence request passed AMD chain/signature, measured image, debug-disabled, VMPL, and identity/key binding checks. The full measurement is c8663742359ae1895dee9c8c18e801c524fc7e9e028663e9eca9cb73ac7aa0831bd6610cfc6bd7c22c50e1ad27da396b. It matches the on-chain machine measurement hash2530eda0 and the October14 release manifest. This is quote verification, not a secret lifecycle test.

At 18:16 UTC, the local production enclave-custodian-v2 user service was active. QEMU PID3817658 and service PID3817646 still used the original custodian-v2-9d43e63e8 directory, started October14. The kernel/initrd hashes matched that directory's manifest. No sealed state, credentials, or private configuration were read by the runtime probe.

The running committee is one Enclave-operated seat, not decentralized custody. Current defects and rollout prerequisites are separately recorded in the source audit. The corrected image has not been activated. Address-book activation will require the administrator's signing authority. Exact unsigned enrollment and book transactions are now prepared and simulated; none has been sent.

Public evidence JSON and read-only probe sources are preserved here. The raw hardware quote/collateral is excluded from source control to avoid unnecessarily publishing the raw chip identifier. Its digest and verifier verdict are retained. No canary secret values are present in this directory.

## Rollout preparation at 19:54 UTC

The original production service, committee and policy remain unchanged. Fresh two-provider simulations prepared operator `proposeOwner(hostId, admin)` followed by administrator `acceptOwner(hostId)` on the existing ownership contract `0xbbd885d3e9bc33609387bb9710e91c1905fe6ee7`. The accepted and pending owner were both zero. This enrolls the existing Enclave wallet; it does not change the vault, committee, catalog controls or address-book ownership. The older alternate `0xf5e9…` ownership address is not the production authority.

Operator proposal preparation stopped before signing or submission: both providers reported 376132087579 wei, below the estimated maximum 660247000000 wei for 94321 gas at 7000000 wei/gas. Later inspection found the operator has an EIP-7702 lease delegation that rejects ordinary ETH transfers; the ordinary funding plan must not be used. No transaction or wallet prompt has been sent. This is one-time owner enrollment, separate from app lease funding.

The address-book `secretVaultV2` update to the original vault was simulated successfully from the administrator and rejected from an unauthorized address. The unsigned plan includes a discovery rollback to zero. It must remain inactive until dedicated hardware lifecycle tests and dashboard integration pass. Removing discovery cannot undo policies or encrypted bundles already stored.

The host launcher now selects the original vault's address-book authority mode rather than calling getters absent from that deployed contract. A read-only live test of this exact reader passed against two providers, verified code and immutable bindings, and correctly found metal0 active with no accepted owner.

Two independent builds of source c95dcd3a produced the same corrected image. On production SNP hardware, a disposable quote-only guest passed fresh nonce, exact measurement, AMD signature/TCB, VMPL0 and debug-off checks at 19:31 UTC, without altering existing QEMU processes. This image is superseded for rollout by additional source fix a5eae96c: storage read failures now refuse startup rather than generating a new identity, the launcher uses the reviewed authority mode, and direct ingress includes owner-read routes. Eight focused HTTP/TLS tests passed; a deliberately unsafe catch-and-reset mutation failed. The additional source and test corrections were subsequently built twice at ab589bf8 and verified on hardware, as recorded below.

Outstanding production evidence: dedicated canary secret creation, migration and post-migration rotation; attestation-gated release; unauthorized access and stale revision rejection; outage and restart recovery with real canary shares/secrets (the startup-only test has passed); rollback experiments; instrumented relay plaintext checks and active-store deletion; and public dashboard activation. A successful quote or source test is not evidence these lifecycle cases passed.

The bootstrap remains one Enclave-operated seat on one chip. Quorum RPC reads still depend on public providers. Sealed state is not backed by a hardware monotonic counter: malicious missing-state responses or replay of an older valid sealed blob remain security limitations. Fresh-image isolation does not create independent operators or failure domains.


## Reconciliation and rollout state at 20:25 UTC

The corrected candidate is source `ab589bf80b669c9671b53573d489b6c6c45779ea`, with two byte-identical independent builds. Its full SNP measurement is `70aadff5455fd65f752c1dcec2d6f1ac4984bebf6c63b284d15fcf47851fb96def231af40c39a3bca6fbf9748f01c429`; manifest SHA-256 is `60bde3e90a9d9984def551c21c8815108272d57d2d37bf2e1eb9f2d209e1ad5b`. This is a candidate, not the October 14 image currently serving the existing committee.

At 20:14–20:16 UTC, the corrected image passed a three-boot, isolated test on the production SNP machine. Fresh startup sealed a canary identity. Seven HTTP 503 state-read responses over 45.9 seconds caused no writes and no HTTP readiness. Restoring state access recovered the same identity and encryption key, confirmed by a new-nonce AMD quote. Existing production QEMU processes remained unchanged; the canary was stopped and its private state removed. Fault refusal is host-observed; fresh/reopen identity binding is attested. No committee or secret was created, released, migrated or rotated by that test.

The address book also has `sessionVaultFactory` unset. The existing factory `0x1f5c887c0cdf491b16ab6c449abafdf9b2ec9c9c`, its implementation and known administrator SessionVault were independently checked against two RPCs. Enabling this shared key changes custody's beneficial-owner interpretation. Real-contract tests show that a policy pinned to a SessionVault while the key is unset can become unusable after activation; claiming it under the new interpretation destroys its bundle. Therefore no SessionVault-owned v2 policy should be created before the consumer review and activation order are resolved. Nine existing apps plus the old canary were sampled in both vaults; only the old EOA-owned canary had a policy. The attempted full historical event scan hit RPC rate limits and was incomplete. Sampling does not establish global safety.

A fresh operator proposal preflight at 20:21 UTC checked the existing delegation, executor code, authority, registry, nonce and exact calldata against two providers. It prepared no signature. The operator balance was 376132087579 wei; the conservatively estimated maximum cost was 1038860696719 wei. Ordinary funding reverts because the delegated lease executor has no payable receive/fallback. A proposed temporary-contract funding helper was rejected by Claude's automatic safety review and was not implemented or retried after that reason became known. The existing delegation and all lease operations are unchanged. No wallet request is ready yet.

The dashboard implementation has source-level browser and real-contract coverage for save, migration, rotation and pause/resume, including address-book rollback and SessionVault ownership semantics. Its final production release is being prepared; it is not yet publicly deployed. Direct ingress for the corrected image is also not live. A temporary allowlisted canary transport is being prepared separately from the permanent host-role route. Neither changes the original custody service.

### Rollback and preservation rules

- Keep the original service, image, sealed state, committee and existing deployments intact during canaries. Canary teardown stops only its own processes and removes only its dedicated private state.
- Before exposing new custody discovery, retain the previous site CID and release directory. A site rollback restores that release with its asset-retention metadata; it does not roll back policies.
- Clearing `secretVaultV2` in the address book is an administrator-signed discovery rollback. The new dashboard rechecks discovery before each action. Existing encrypted bundles and on-chain revisions remain; users of already-created policies still need a reachable compatible custodian.
- Do not clear or toggle `sessionVaultFactory` as a routine rollback after policies exist. Ownership interpretation changes can strand bundles. Resolve affected owners and policies first.
- Do not overwrite newer sealed state with an old blob or launch old software against the new state without a separately tested compatibility/migration path. No hardware monotonic counter currently prevents an older valid sealed blob from being replayed.
- Migrating a dedicated legacy canary must verify the v2 bundle and successful attested release before deleting its relay active-store copy. Deletion cannot retract historical plaintext copies or backups. Rotate real credentials at their issuers after migration; no existing deployment's credentials are being migrated automatically.

### Signing authority still required

The existing operator must first propose the Enclave admin as metal0's owner, then the admin wallet must accept. Operator gas funding remains unresolved without disturbing its lease delegation. After hardware lifecycle tests and consumer review pass, separate admin signatures activate `secretVaultV2` and, if safe, `sessionVaultFactory`. Owners sign their own policy changes/migrations. No admin controls are removed and no existing smart contract is modified by these proposed calls.


## Consumer and ingress follow-up at 20:42 UTC

A subsequent two-provider state inventory enumerated **all 98 deployment IDs in the current ledger** at block 52,999,031. Both vaults have exactly one policy in this inventory, the existing EOA-owned canary. None would be stranded by factory activation at that block. Four deployments owned by the known administrator SessionVault have no policy in either vault; activation changes their first authorized custody writer to the admin wallet. This closes the current-state coverage gap; historical event discovery remains partial and is not represented as complete. Recheck the full inventory immediately before signing because state can change.

At 20:35 UTC, the live relay already had `SESSIONS_FACTORY` pinned to the same original factory. Its bundled source hash was unchanged from the earlier inspection. Therefore setting that address-book key does not enable a different factory in this relay. Other unpinned owner-signature readers gain the intended wallet-owner authorization, while explicitly pinned readers retain their pins. Factory activation remains a separate admin-signed step, not part of the website release.

The canary ingress forwarder passes real HTTP tests against exact public routes and more than 250 malformed/private-path attempts. Root review found and fixed a client-disconnect cancellation race. Its example Caddy snippet also passed adaptation/provisioning validation with the installed control-VM binary at 20:39 UTC; the first attempt failed only because the test wrapper used invalid one-line Caddy syntax. No production Caddy file, listener, tunnel or service was changed. This is preparatory evidence, not a live ingress or secret-release test.

At 20:41 UTC, metal0's public `/availability` reported `snp-guest-per-app` and claiming enabled; its production image manifest declares the same isolation backend. Its `/v1/health` answered `ok`. This establishes an advertised recipient path to investigate, not a fresh attestation or proof that its measured supervisor can authorize this v2 vault. Those checks and a dedicated recipient canary remain required.

The site package preserves the currently served logo-hotfix release and its cached assets. The publisher's current public status is HTTP-only, sequence zero, with an empty local value; that alone does not prove the network IPNS record is absent. Publication is gated on reconciling its key, latest valid signed record and current site CID without rolling its sequence backward.

### 20:59 UTC follow-up: deployed ABI and recipient regression

Both public providers confirm the original address book runtime `e4f570…ac152` supports `owner()` but has no `pendingOwner()` getter. The current repository's two-step-owner ABI cannot be assumed for this deployed instance. The factory wallet preflight stopped before serving a page or asking for a signature; its adapter is being corrected against the exact deployed code hash.

The exact production image inventory in `../custody-recipient-provenance-20261023/RESULT.md` found that the `deabf8f90` overlay dropped the measured v1/v2 custody constants present in the October 14 `295650320` lineage. A fresh relay observation confirms the running supervisor was admitted as measurement `ed918e4b…d2ac2`; this is an admission observation, not an independent fresh quote verification. The local guestd health endpoint requires authentication (401); this does not establish a guestd outage. No release canary has yet been attempted through this misconfigured recipient. A minimal source restoration is being prepared, without changing existing guests.

Publisher metadata shows its current partition console file is empty. The independent publisher assessment (`../custody-publisher-assessment-20261023/RESULT.md`) verifies the public IPNS record's signatures, sequence 1026 and expiry October 30. Local publisher sequence zero does not mean the public record is gone. Do not publish a new site until recovery of the existing sequence is established.
