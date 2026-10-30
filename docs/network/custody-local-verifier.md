# Custody chain source: prepared v1 verifier option

The v1 custodian daemon can explicitly select the host-local verifier with `CUSTODY_CHAIN_SOURCE=verifier` and `CUSTODY_CHAIN_VERIFIER=http://127.0.0.1:PORT/`. Remove `CUSTODY_RPCS` and `CUSTODY_MIN_AGREE` completely; blank values are also rejected. Set `CUSTODY_TX_BACKEND` only to the reviewed own transaction backend when writes are required. Without it, submissions refuse. Legacy quorum configuration remains the default.

This mode changes chain authority from an RPC quorum to one local verifier authenticating the sequencer-signed unsafe chain. It does not provide L1 finality or SNP attestation. Existing administrator revocation, confirmations, freshness and v1 high-water checks are preserved. v1's number-based multi-call reads remain an inherited limitation. This source option is not a production rollout.

**Custody v2 deliberately refuses verifier clients.** Its canonical block-hash requirement is not enforced by the currently pinned verifier. Translating a hash into a block number with checks before and after the read is unsafe across an A–B–A reorganization and is not implemented. The v2 daemon, measured configuration, host and public RPC default remain unchanged. Activation needs canonical hash-pinned native verification, validated runtime behavior and a measured release first.

The candidate passed 11 new tests and all 101 regression tests; the same 101 tests passed on the pristine baseline. There were no skipped tests. These are isolated tests with simulated verifier responses, not production proof or hardware validation. An earlier rejected translation design and harness failures are retained in rollout evidence.

Before eventual v1 activation, validate the own backend, deploy the compatible daemon, save exact prior configuration and release, and canary secret access, revocation, restart and outage refusal. Roll back by restoring both prior configuration and release. Never add a public fallback beside verifier mode. No existing deployment or custody policy is migrated automatically by this change.
