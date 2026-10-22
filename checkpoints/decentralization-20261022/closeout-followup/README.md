# Closeout work checkpoint

This recovery package supplements `closeout-drafts`; `MANIFEST.json` records exact source hashes and references unchanged earlier copies. This is a source archive, not a release or deployment approval.

Current evidence as of 2026-10-22:

- The bounded storage controller passed integration and recovery checks. PostgreSQL process reaping was hardened with `--init`. The live indexer migrated through schema 27 to 28, followed by two passing postchecks 611 seconds apart with no restarts or warnings. It remains a single metadata authority.
- A fresh encrypted cold-recovery snapshot was exported and verified locally. Private backups, application seeds and credentials are deliberately excluded from Git.
- The measured control image from candidate commit `6f2c7da466dc26e5f7aac88c574a6b807e1a03df` was built twice with identical artifacts and measurements. Input and import closure checks passed. It has not been hardware-booted or activated. Later candidate documentation corrects activation requirements without changing image inputs.
- Native control discovery work is preserved in `files/native-control-discovery`. The withdrawn draft has a reproduced identity-substitution defect. The final patch fails closed for control names until an authenticated endpoint identity source exists. **Do not deploy it as a completed replacement:** it would make native API/MCP resolution unavailable. The result report, root review, patches and adversarial test document the remaining work.

Distributed service activation, independent ingress, provider-loss testing, storage replication and full feature parity remain incomplete. Enclave administrative governance remains required. Historical status statements in earlier receipts describe their capture times; they do not override the newer evidence.

Excluded: credentials, private runtime configuration, production backups, raw agent transcripts, dependency caches and generated images/binaries. Future source changes require subsequent commits.
