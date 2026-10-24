# Recipient attestation integration — source-tested, not production-proven

As of October24 09:42UTC, the verifier and transport-pinned HMAC proof are connected to new-committee release/proof commands. The full guarded suite passed173 Node and3 Python tests, with one known rollback TODO. See STATUS.md for scope and remaining production gates. The original source-committee migration path still retains its limited legacy observations. No production recipient quote or canary matrix is claimed.

The historical candidate notes below describe the design before integration. Their statements that tests have not run, pins are absent and the CLI is unwired are superseded by this header. Missing offline collateral must still fail closed. Real SNP testing remains required.

---

# Recipient attestation candidate — not validated or activated

The candidate in driver/recipient-attestation.mjs is not imported by the production-canary CLI. Its new tests have not run because the host memory guard has not admitted them. The last passing full suite (root-full-27.out:165 Node,3 Python,one known rollback TODO) applies to commit656ebbd0fdf9205899b5b068ec090464c4154d7c, before this candidate. Do not report the candidate as tested, active or hardware-proven.

Source inspection found that the actual guestd per-app verifier uses the default expected VMPL0 (isolation/m4/guestd/main.go verifyArgs and isolation/m2/client.mjs), whereas a separate isolation/m4/verify-report.mjs test requires VMPL2. This candidate uses the production per-app expectation, not the other experiment's level. It requires the proof app's pinned measurement/runtime/AppID, signed deployment HOST_DATA, non-debug/non-migration policy, and the established firmware floors.

The public discovery request sends only a fresh nonce to the fixed app attestation path. CA validation is deferred to quote verification for this discovery request: its actual TLS handshake SPKI must match the locally observed recipient transport-key digest and the fresh AMD-rooted quote. The caller must not use the discovered connection for secret application traffic. TLS sessions are not reused; redirects, oversized/non-JSON documents and errors fail without exposing peer payloads. Raw quotes/chip identifiers are not public verifier results.

The existing judge, runtime-binding module and SNP verifier are pinned by exact source hash. Runtime identity is recomputed and compared with the pinned runtime digest before the judge receives the expected runtime. AMD KDS fallback is disabled. Production collateral availability is unverified: missing offline collateral must fail, not silently enable external fetches or lower firmware requirements. The loader's new file pins are not yet added to run pins, so it cannot accidentally activate through the existing CLI.

A wrapper reobserves the recipient before and after attestation to reject VM/transport replacement and stale quotes. Tests are written for identity/policy/firmware refusals, verifier privacy, replacement, and real local self-signed TLS transport. TLS fixtures generate temporary keys on disk, never tracked fixtures. These are not AMD hardware tests. HMAC consumption must also be bound to the attested recipient transport; the existing public HMAC helper alone does not establish that binding.

Next: admit guarded tests and source scans, fix any failures, bind this verifier and transport-pinned consumption into successful-release/recovery evidence, then execute dedicated canaries under the existing launch/authority/resource gates. Failed-boot/outage evidence, real migration/deletion, rollback protection and decentralized multi-operator custody remain unfinished. No signing, production VM or contract change is performed by this candidate.
