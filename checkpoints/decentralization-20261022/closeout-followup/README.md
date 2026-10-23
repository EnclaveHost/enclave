# Closeout work checkpoint

This recovery package supplements `closeout-drafts`; `MANIFEST.json` records exact source hashes and references unchanged earlier copies. This is a source archive, not a release or deployment approval.

Current evidence as of 2026-10-22:

- The bounded storage controller passed integration and recovery checks. PostgreSQL process reaping was hardened with `--init`. The live indexer migrated through schema 27 to 28, followed by two passing postchecks 611 seconds apart with no restarts or warnings. It remains a single metadata authority.
- A fresh encrypted cold-recovery snapshot was exported and verified locally. Private backups, application seeds and credentials are deliberately excluded from Git.
- The measured control image from candidate commit `6f2c7da466dc26e5f7aac88c574a6b807e1a03df` was built twice with identical artifacts and measurements. Input and import closure checks passed. It has not been hardware-booted or activated. Later candidate documentation corrects activation requirements without changing image inputs.
- Native control discovery work is preserved in `files/native-control-discovery`. The withdrawn draft has a reproduced identity-substitution defect. The final patch fails closed for control names until an authenticated endpoint identity source exists. **Do not deploy it as a completed replacement:** it would make native API/MCP resolution unavailable. The result report, root review, patches and adversarial test document the remaining work.

Distributed service activation, independent ingress, provider-loss testing, storage replication and full feature parity remain incomplete. Enclave administrative governance remains required. Historical status statements in earlier receipts describe their capture times; they do not override the newer evidence.

Latest whole-bucket Sia recovery status (2026-10-23): FAILED (OOM kill 02:20:32Z, no final inventory) per `files/outputs/decentralization-audit/storage-whole-recovery-failure-20261023.json`. The earlier RUNNING receipt `storage-whole-recovery-live-20261023.json` is kept unchanged as historical evidence; `MANIFEST.json` `supersessions` records the relation. No completed whole-snapshot recovery has been verified.

Frozen 03:18Z append (2026-10-23): witness failover Enclave bfbd649d + Helios witness-check 1ec2c1a5 (source and offline proof/availability tests only; not production, not RPC independence) and the UNREADY Linux hold candidate b744ba19 (root later found a tryClaim permit-capture window; worker repairing), with root reviews/probes and receipts. See `MANIFEST.json` `appends`. The whole-bucket OOM failure above remains the latest full-restore status.

Frozen 03:31Z append (2026-10-23): S bounded bridge f98786e9 (offline/loopback tests + load fixture; NOT a restore pass), E optional S3 witness cache b71c8261 (not live Sia) and receipt-witness b84c5a11 (diagnostic only), P authenticated-ancestry history ce7c1b73/aca81764 (proof-call test uses a synthetic block identity) and A verifier authority 921d60c2 (whole-operation deadline gap open). See `MANIFEST.json` `appends`. The whole-bucket OOM failure above remains the latest terminal full-restore status.

Frozen 04:10Z append (2026-10-23): A canonical-trie Reth E2E 0c43e4db, B whole-operation verifier deadline 8d110101, C host-services cold start 427780bb (NOT rollout-ready: late-start/close race, DO-mirror-only gate), D Linux wallet hold final f1d0666b (needs a measured image + the decision() bundle; not deployed), E S3 witness ARCHIVE tier 27785278 (not live Sia) and P bounded real-history 7b4dd692 (real proof recording FAILED: no real proof); root's stop-race mock probe and the 04:06-04:07Z EnclaveDNS receipts. See `MANIFEST.json` `appends`. The whole-bucket OOM failure above remains the latest terminal full-restore status.

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

## Admission and connection lifecycle follow-up at 21:51 UTC

The installed wallet-admission writer expires decisions within 90 seconds, while the serial host pass takes several minutes. Live observations show fresh lease/proof/channel but no wallet grant between passes. Candidate ad4a72a adds bounded per-app refresh using fresh deployment identity and wallet decisions; eleven targeted cases and nine mutation checks pass. Existing regressions passed, including the readiness fixture completed separately by root at 512 MiB. It is not deployed.

A second live failure is distinct: three RPCs confirmed the funded adapter lease expired, and node logs report a failed RPC quorum at renewal. The next pass retired it and made a fresh claim. Renewal scheduling/RPC work is active; the adapter has enough reserve and needs no repeated top-up. The other ten apps remain underfunded.

Control-front candidate d9459aae propagates HTTP disconnects in both directions. Seventeen real TLS cases pass; ten fail on the base. Native/config/forwarding regressions pass. Full hosted regression remains pending its 512 MiB rerun. This source is not composed into the measured image or regenerated role bundle yet.

Native issuer work remains a draft with incomplete mutation validation. When its test runner temporarily disables security checks, the checkpoint captures the runner's saved unmutated source, identified explicitly in MANIFEST.json. Raw mutation output, generated private test keys and production secrets are excluded.

## 2026-10-22 22:04 UTC checkpoint

Preserves completed native issuer source2ab and its worker-only bundle9b, composed source2a2 (forwarding ca311 + front d945 + issuer + TLS request lifecycle correction), six passing hosted regression checks, eight passing TLS interruption checks, and unfinished renewal/restart/handoff work. The combined production bundle has NOT been rebuilt or activated. Production handoff collateral wiring and policy checks are under repair. Snapshot copies are recovery material, not a release. See public-validation/native-issuer-integration-progress.json and worker RESULT reports. No production mutation was performed in this continuation.
