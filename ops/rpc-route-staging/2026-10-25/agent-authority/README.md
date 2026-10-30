# Host policy verifier integration — staged source

This change adds explicit local-verifier authority to the privacy agent's host-service admission gate and its policy carriers. Existing administrator bans, owner rotation and outage refusal remain enforced. It does not activate any production service.

Five new tests pass using a scripted chain and a verifier protocol stand-in; they do not establish Merkle-proof correctness or production readiness. The wider affected suites contain five baseline failures, detailed in AGENT-AUTHORITY-RESULT.md. Bundles were regenerated and 26 artifacts reproduced from two equivalent source trees. The earlier failed build recipe and test failures remain recorded. The public-RPC package is unchanged; service-TLS, policy-mirror and route-DNS package pins are superseded by ARTIFACTS-AGENT-AUTHORITY.sha256.

Only the six source files in source-identity.json are copied here; each is byte-identical to the tested candidate. This commit does not import its unpublished historical ancestry. Runtime binaries and generated host-service packages are not committed. Additional exit-provider admission, agent chain-reader and platform consumer migration work remains before replacing public RPCs.
