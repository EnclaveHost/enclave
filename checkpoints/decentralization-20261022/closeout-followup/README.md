# Closeout work checkpoint

This recovery package supplements `closeout-drafts`; `MANIFEST.json` records exact source hashes and references unchanged earlier copies. This is a source archive, not a release or deployment approval.

Current evidence as of 2026-10-22:

- The bounded storage controller passed integration and recovery checks. PostgreSQL process reaping was hardened with `--init`. The live indexer migrated through schema 27 to 28, followed by two passing postchecks 611 seconds apart with no restarts or warnings. It remains a single metadata authority.
- A fresh encrypted cold-recovery snapshot was exported and verified locally. Private backups, application seeds and credentials are deliberately excluded from Git.
- The measured control image from candidate commit `6f2c7da466dc26e5f7aac88c574a6b807e1a03df` was built twice with identical artifacts and measurements. Input and import closure checks passed. It has not been hardware-booted or activated. Later candidate documentation corrects activation requirements without changing image inputs.
- Native control discovery work is preserved in `files/native-control-discovery`. The withdrawn draft has a reproduced identity-substitution defect. The final patch fails closed for control names until an authenticated endpoint identity source exists. **Do not deploy it as a completed replacement:** it would make native API/MCP resolution unavailable. The result report, root review, patches and adversarial test document the remaining work.

Distributed service activation, independent ingress, provider-loss testing, storage replication and full feature parity remain incomplete. Enclave administrative governance remains required. Historical status statements in earlier receipts describe their capture times; they do not override the newer evidence.

Excluded: credentials, private runtime configuration, production backups, raw agent transcripts, dependency caches and generated images/binaries. Future source changes require subsequent commits.

## Work in progress captured at 20:35 UTC

`native-control-attested`, `direct-hardware-canary`, and `storage-client-interop` contain active implementation drafts. Their root review notes identify unresolved security, acceptance and cleanup issues. These files are recovery snapshots only; no completed test or production readiness claim applies to them. The hardware canary has not run. The older measured image remains pinned to its original source and does not contain the new native TLS changes.

`storage-public-read` records a public Base snapshot (block 52955698), preserved catalog metadata for a future version, and host admission preflight observations. The first preflight was unreadable; the second admitted the host under the existing unanchored-policy compatibility rule. This does not establish an activated moderation policy or readiness to deploy storage replicas.

## Additional recovery snapshot at 20:48 UTC

The canary recipe, frozen input pins, unit-test source and result report are now preserved. Its reported launcher and cleanup unit checks pass (4 Node checks and 18 Python checks); the actual hardware canary has not run. Native attested-control code and real-TLS tests remain active drafts. The storage compatibility integration is still in progress; its packed-object fixture has not demonstrated compaction, so full backward compatibility is not established. These distinctions are part of the checkpoint, not deferred deployment approval.

## Verified progress at 20:59 UTC

The bare direct-control hardware canary ran once on real SNP hardware and passed the exact image measurement, HOST_DATA/config, TLS-key, supervisor-key and runtime checks. Its unique cgroup was observed and proved empty; private test files were removed; protected production guest and user-service identities were unchanged. Public attestation and terminal evidence are preserved in files/public-validation/hardware-canary-20261022. It was deliberately unregistered, and does not prove API/MCP or new native TLS readiness.

Storage integration i6 passed all 42 checks, including actual legacy packed objects, ranged reads, multipart continuation, restart durability and old-client write refusal after CAS enrollment. It used real client binaries and indexd/RHP4/PostgreSQL with a synthetic Sia chain and a lease17 fixture. A focused existing-lease16 check is underway; a new contract version is not a migration prerequisite. See files/public-validation/storage-interop-i6.json.

The chip-admission review found the existing custody mapping, sha256 of the raw 64-byte SNP chip identifier. Native-control source is being updated to enforce bans per authenticated chip instead of blanket refusal. Native CA issuance/recovery placement remains under investigation. Ongoing implementation drafts are not deployed or complete.

## Source and compatibility follow-up at 21:08 UTC

Native endpoint binding and per-chip policy enforcement are committed as 8e77ff1eca24be3c02e281dc9f431af597165adf on candidate/decentralized-control-20261022. The source report lists the focused tests and regenerated platform API bundle. It has not been built into a new measured image or deployed.

The existing-ledger16 real-WASM integration l1 completed with 32 passing checks and one failed string-format assertion: differently padded hex values represented the same integer. Retained runtime evidence passed numeric re-evaluation; the corrected bounded assertion and malformed/wrong-generation negatives were tested separately. Original exit 1 remains recorded. This demonstrates the existing lease16 protocol in the isolated runtime; it is not a live claim or first production CAS enrollment.

Issuer placement/recovery now has a source-grounded plan using the existing measured platform API group's replicated admin credentials. Implementation is active in an isolated checkout. A separately identified standby forwarding TLS-pin defect is being fixed before composition. Neither workstream is deployed.

## Recovery snapshot at 21:24 UTC

The forwarding fix is preserved as candidate commit ca3118202359da8ce84f5b917fcc5ed85b2c6730 and in the native-control-attested package. Its report records six forwarding tests, five killed security/lifecycle mutants, and six hosted-platform tests passing. It is not deployed or included in the earlier hardware canary.

The native-issuer-implementation package is an active, uncommitted worker snapshot based on 8e77ff1e. It preserves certificate issuance and replicated recovery work, review notes, and test drafts. The source may be incomplete and must be composed with the separate forwarding fix before validation or deployment. The native-storage-names report describes remaining name authority and bootstrap requirements.

Public diagnostics at 21:13–21:19 UTC show the native site returning 502, ten leases expired with insufficient claim reserves (three RPC providers agreeing), and a separate adapter TLS/admission failure despite its funded lease and renewed certificate. These are observations, not fixes. No funding request was signed or broadcast by this checkpoint.
