# Production custody v2 read-only reconciliation, 2026-10-23

Current evidence is limited to the existing bootstrap. No new secret, rotation, migration, outage, rollback, or corrected-image activation has been performed by these probes.

At 18:10 UTC, two Base RPC state providers agreed on block52994819 and the original vault's deployed code hash. The address-book entries secretVaultV2, secretVault, and hostOwnership were all zero. The previously inventoried committee remains epoch1 with one machine and threshold1. The known policy remains policyRev2/secretRev2, unpaused. These are known-ID reads, not an exhaustive current consumer inventory. At18:47 UTC, an additional event scan from block52849852 to a fresh agreed block found no new events on the original vault. Discovery uses one archive provider, so it is not independently exhaustive. Fresh quorum state reads also found the metal0 host active with no accepted or pending owner in the configured ownership registry; owner enrollment remains required for the corrected image.

At 18:15 UTC, a fresh random-nonce SNP evidence request passed AMD chain/signature, measured image, debug-disabled, VMPL, and identity/key binding checks. The full measurement is c8663742359ae1895dee9c8c18e801c524fc7e9e028663e9eca9cb73ac7aa0831bd6610cfc6bd7c22c50e1ad27da396b. It matches the on-chain machine measurement hash2530eda0 and the October14 release manifest. This is quote verification, not a secret lifecycle test.

At 18:16 UTC, the local production enclave-custodian-v2 user service was active. QEMU PID3817658 and service PID3817646 still used the original custodian-v2-9d43e63e8 directory, started October14. The kernel/initrd hashes matched that directory's manifest. No sealed state, credentials, or private configuration were read by the runtime probe.

The running committee is one Enclave-operated seat, not decentralized custody. Current defects and rollout prerequisites are separately recorded in the source audit. The corrected image has not been activated. Address-book activation will require the administrator's signing authority; exact transactions are not yet prepared.

Public evidence JSON and read-only probe sources are preserved here. The raw hardware quote/collateral is excluded from source control to avoid unnecessarily publishing the raw chip identifier. Its digest and verifier verdict are retained. No canary secret values are present in this directory.
