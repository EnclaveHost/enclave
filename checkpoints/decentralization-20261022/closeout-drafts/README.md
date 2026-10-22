# Closeout source drafts

These files preserve the migration recipe, timeout diagnostic source and evidence, and the authored control-image composition tools/overlays at the manifest's capture time. Development continues; this is not a release or a production activation.

- `restore-timeout-diagnosis`: real PostgreSQL cases verified that killing an orphaned restore process restarted other sessions; the corrected timeout preserved unrelated sessions. The later seven-case run adds bounded backend-drain checks. The independently run eight-stage/nine-check integration receipt is in the adjacent `storage-controller-fix` package.
- `production-migration-closeout`: reviewed operating plan plus a small execution-bounds proposal. The proposal is not yet validated. The broad watchdog draft is explicitly abandoned and must not run.
- `measured-composition`: active source composition. Copied base trees and generated bundles are omitted; composition tools, authored source overlays and inventories are preserved. Canonical Enclave attestation routing includes a proposed strict legacy wire-path alias for deployed verifiers. This is a compatibility implementation detail, not restored product branding or a change to the earlier historical rewrite. It remains a draft until the composition passes review and testing.

No production, wallet, funding, contract ownership, registry binding or policy change was made by this checkpoint. Private backups and credentials remain outside Git.
