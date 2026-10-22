# Decentralization work preservation checkpoint — 2026-10-22

This branch preserves development work requested by the repository owner. It is not a production release and does not establish that decentralization is complete.

## Scope and authority

- Resist external infrastructure-provider outages and censorship while retaining Enclave administrators' contract ownership, catalog moderation, host bans, upgrades, and abuse enforcement.
- Keep DigitalOcean machines as minimal WireGuard transport; move hosted services to Enclave hosts/apps.
- Preserve compute privacy and existing features. Additional third-party operators have not yet been supplied.
- Keep historical attribution and terminology corrections already present in the public repository.

## Layout

The repository source tree captures the primary development working copy. Supplemental source packages preserve independent app changes, storage candidates, recovery/test tooling, and unfinished compositions. Their manifests identify source origins and exclusions. A preserved candidate does not imply it is integrated, deployed, or approved for deployment.

Private keys, wallet/session state, access tokens, production configuration containing credentials, production database backups, raw agent transcripts, dependency caches, and large generated artifacts are excluded from the public checkpoint. Existing private recovery backups remain local; this public branch is a source-code backup, not a backup of production data.

## Validation already performed

- Fresh production metadata backup: 20-phase isolated restore, v26→v27→v28 migration, rollback, and restart-durability rehearsal passed. Production subsequently migrated to v27 with verified backup and content digests; v28 remains pending. The final bounded controller passed eight migration stages and nine recovery checks. See `closeout-followup/STATUS-20261022.json` for the latest checkpoint status.
- Storage SDK repeat: three supported groups, 20 checks passed. A historical unsupported C2-client/v27 pairing remains a recorded failure; it is not a passing compatibility claim.
- Windows bootstrap process-control harness: 22 local checks and 10 earlier native component checks passed. Full PowerShell 5 harness refused under existing Restricted execution policy; it was not run successfully.
- Storage controller: real PostgreSQL integration exposed a restore-timeout bug that could restart all database sessions. The corrected controller passed five diagnostic cases, eight migration stages and nine recovery checks, with cleanup confirmed. See `storage-controller-fix/VERIFICATION.json`. The final execution bounds passed validation; PostgreSQL init hardening and the v27 production migration were applied. The v28 and replica rollouts remain outstanding.
- Site/adapter local proofs and reproducible site-host builds passed recorded checks. Public decentralized holding and rollout remain incomplete.

No full regression suite is being claimed for this aggregate preservation snapshot. Relevant existing receipts are referenced by preserved manifests; the branch must be reviewed before production rollout.

## Outstanding known issues

- Six expired app leases could not afford claims/renewals at the latest fleet check. Cron also has an independent startup failure.
- Initial app reserves were 0.0001 ETH each. Successful reserve charges reconciled exactly: 828 renewals, 16 claims, one release; 0.001086377281345685 ETH total at block 52944484. No reserve withdrawals were found. Whole-history data came from one RPC; the latest 70 events and end-block hash matched another RPC independently. Failed relay transactions and unrelated wallet gas are outside this accounting.
- The owner-side lease cost model now distinguishes self-hosted free leases from paid leases. The CLI uses the reserve renewal window for a conservative estimate and can accept a measured lead. Unit, real-ledger and CLI checks passed (26 total), and both regenerated runtime bundles passed 23 consumer checks. This source correction is integrated here; installed hosts and the measured control image have not been updated by it.
- Adapter has approximately 0.0009701774 ETH remaining after its separate 0.001 ETH top-up. Do not replay that completed funding transaction.
- A proposed ten-app reserve top-up totaling 0.01 ETH is only prepared code. No user approval, wallet request, signature, or broadcast has occurred for that batch.
- Storage replication rollout, measured control image composition, public site custody/publication, provider-independent ingress, and outage/feature-parity verification remain incomplete.

## Working-state caution

Source recovery recipes may retain original workspace-relative paths or content hashes. Follow each package's reconstruction instructions and regenerate artifacts from pinned inputs. Do not run migration, funding, deployment, or key-management commands merely because they are present in this archive.
