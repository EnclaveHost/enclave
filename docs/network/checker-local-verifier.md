# Local verifier reads for the public directory and network checker

These source changes add an explicit alternative to the existing RPC configuration. They are not deployed by adding configuration to an older release.

For a public directory, remove `rpc` entirely and set `chainAuthority: "verifier"` with `chainVerifier: "http://127.0.0.1:PORT/"`. Keep the existing address book, authority pins, checkers and state directory. Naming both `rpc` and the verifier refuses startup.

For `scripts/network/wg-qualify.mjs`, replace `--rpc URL` with `--chain-authority verifier --chain-verifier http://127.0.0.1:PORT/`. Other flags remain unchanged. This mode refuses `--rpc` and `--independent`, checks the Base chain ID and head freshness before contract reads, and uses only the local verifier. Failure does not select a public fallback. Existing quorum and legacy single-RPC modes retain their behavior.

The local verifier authenticates reads against its sequencer-signed head chain. This is the **unsafe tier**, without L1 finality or SNP attestation. Its description explicitly reports `attested: false`. A loopback address alone does not authenticate remote infrastructure. Every host needs an appropriate local verifier; the regional production hosts do not yet have one. Administrator and contract authority pins are unchanged.

Before deployment, stage compatible releases (including a regenerated directory-replica bundle where applicable), pass the backend's production readiness gates, save the exact prior config and release, then canary each consumer. On failure restore its prior config and release together; restoring public RPC is a rollback, not completed RPC replacement.

Validation: the focused directory/checker tests and existing public-directory, lease-reader-verifier and chain-authority suites passed 45/45 with no skips in an isolated network namespace. Fixtures simulate verifier responses; this is not production proof or real-chain finality validation.
