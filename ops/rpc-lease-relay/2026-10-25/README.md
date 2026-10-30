# Lease relay verifier authority — source acceptance, 2026-10-25

This is a source candidate, not a production activation. Existing live lease relay, administrator controls, keys, balances, contracts and configurations are unchanged. The source template memory cap changed to 224 MiB; no installed unit changed.

Final relevant checks: configuration 5/5; real pinned verifier on synthetic chain E2E 15/15, zero skips; legacy batch 113/114, zero skips. Its one failure was a stale mirror-list test expectation (the base already has an empty production mirror list). After correcting that expectation, the entire affected host-policy file passed 9/9, including real administrator ban/unban and CLI lifecycle. The whole 114-test batch was not rerun. The preserved aggregate return-code file therefore correctly still records legacy=1. Two release builds were byte-identical and host-package rebuild verification passed. No live Base or production SNP acceptance is implied.

The simulation uses the effective gas price at the verified anchor block, not a promise about inclusion-time gas price. Pinned Helios drops EIP-1559 fee fields and EIP-7702 authorizations; the explicit state override is checked by a non-vacuous executor call and differential local-chain tests. A runtime fix is still proposed separately. This authority follows a sequencer-signed unsafe chain, not L1 finality. Submission acknowledgement never counts as inclusion; exact signed bytes persist across restart and a verified receipt is required.

Hosted role verifier fields have configuration tests but no packaged hosted-role verifier run yet. Its outer admission gate must also be migrated before that role can be described as provider-free. Full production consumer migration, historical coverage, actual synchronization and outage/restart validation remain required.

The report is the worker's final review record; its references to uncommitted source describe the time of the run. The source is preserved in this commit. Generated release artifacts are identified by hashes and not committed. Tests and evidence contain only local synthetic-chain fixtures, not production secrets.
