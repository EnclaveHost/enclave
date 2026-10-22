# Follow-up source snapshot

This supplements the earlier preservation checkpoint with the latest lease-cost work and storage package/controller integration work. Files remain under workspace-relative paths in `files/`; the manifest records SHA-256 values and any terminology normalization. These candidates are preserved separately rather than asserted to be integrated or released.

## Verification at capture

- Storage rc3: two identical package builds, 22 package checks, real host-role lifecycle and activation tests passed. A derived lifecycle test also proved exact schema version 28. See the preserved role result and RC3 evidence.
- Controller integration run e370da8a42b29695: eight migration stages and X1/X2 passed; X3 failed because PostgreSQL cancelled promptly instead of retaining the connection assumed by the test. Cleanup was confirmed. This is a recorded failure, not a passing integration result. A revised deterministic failure-injection harness is under development; any revision-2 files here require review and execution.
- Lease-cost correction distinguishes self-hosted renewals from paid renewals. Unit/CLI checks passed in the first combined run, but the new local-ledger checks failed and are being investigated. This is unfinished work; any later worker result is additional evidence, not production validation.

No live migration, funding, contract change, or deployment was performed by this checkpoint. Private backups and signing material stay outside source control. Raw worker conversations and generated build artifacts are excluded.
