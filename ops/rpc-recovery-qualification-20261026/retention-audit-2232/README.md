# Retention provenance correction, 2026-10-26 22:32 UTC

The earlier audit cited an obsolete wrapper's 140,000-block distance assertion. The captured deployed Base wrapper instead passes absolute `before` cutoffs for receipts, bodies and transaction lookup. The recorded retention plan starts at block 48,000,000, earlier than the signed reader history floor 52,515,705. That planned policy preserves the required range as the head advances. No live configuration was changed and no speculative wrapper patch was prepared.

## Evidence limits and activation requirements

- The deployed-wrapper evidence is a historical guest capture, not a fresh read from the currently stopped VM. Before activation, identify and hash the exact wrapper and chain.json that will actually run. Do not equate a prior capture, intended configuration or a similarly named candidate with current deployment.
- An existing chain.json or reth.toml may still be recoverable/readable while the VM is off; absence from this audit is not proof that those files no longer exist. The deleted state database and paused download do not themselves prove configuration files are unavailable.
- Configuration and archive file presence are not usable-history proof. Verify actual receipts and transactions cryptographically, through the reader's authenticated scan from its fresh anchor down to the signed history floor, before claiming old leases are supported.
- A future cutoff above the signed history floor would lose availability while the reader fails closed. Add an explicit cutoff-versus-policy check to the selected activation path when that exact lineage and policy are fixed; do not silently change administrator authority or substitute a hard-coded value for proof of the actual signed policy.
- Root is not repeating the runtime-identical integrated build: r5's non-enrollment/build receipts and r6's targeted 19-test enrollment receipt remain separately identified. Own-node, actual transport, historical coverage, safe/finalized readiness and production cutover are still unverified.

The original recovery candidate remains read-only. USB writes, download resumption and production RPC VM boot remain paused. Free NVMe capacity and host memory remain deployment constraints. This audit is source/provenance evidence, not production completion.
