# Attested remote verifier source candidate

This branch preserves reviewed source and synthetic tests. It is not deployed, not a completed RPC replacement and not a production attestation acceptance. No image or generated bundle has been rebuilt. The source changes would require a new measurement. Existing apps and administrator contracts are unchanged.

The client uses the existing SNP verifier, a pinned direct config bound by HOST_DATA, fresh nonce and the attested TLS key. Its label is attested remote execution; it does not claim local Merkle verification, replica quorum or L1 finality. Tests use synthetic AMD certificates, a stand-in proof server and minimal anvil contracts with the relevant call shapes. No real SNP or real MPT acceptance is implied.

Current checks: new suite15/15, existing96/97; service-index schema-4 fails identically at the base. The earlier gsup fixture was corrected against exact reviewed additions and now passes. Full provider bundle import closure and separate-bundle brand sharing were checked. An attestation may continue in the background under per-step bounds after callers abort; one is shared per replica.

Production still requires composition with the newer route-source host-services policy gate, fail-closed mixed settings, a packaged provider end-to-end test preserving administrator ban/unban and SessionVault behavior, actual collateral pre-seeding and expiry/refresh tests, reproducible image/bundles, real SNP validation and infrastructure synchronization. Paid providers currently refuse this read-only authority; preserving their submission feature is still outstanding. No administrator functionality may be removed to close those gaps.

Do not activate this candidate directly. See RESULT.md for exact run evidence and remaining limitations; uncommitted wording describes the worker run before publication.
