# Generated-artifact manifests: baseline staleness vs composition-induced (static; git objects only)

Owner = the component head(s) whose manifest blob the candidate carries. `baseline` = stale inputs at that owner head; `candidate` = stale inputs in c4de37a3.

| manifest | owner | baseline stale | candidate stale | composition-induced (stale only in candidate) | r5 action |
|---|---|---|---|---|---|
| `metal/guest/lease-gas-conduit.bundle.mjs.manifest.json` | seam | 0 | 2 | client/lease-executor-client.mjs, network/rpc-identity.mjs | regenerate |
| `metal/guest/mcp-server.bundle.mjs.manifest.json` | verifier | 2 | 10 | custody/v2/quorum.mjs, network/platform-host-policy-config.mjs, network/verified-chain.mjs, relay/lease-generation.mjs, relay/mcp.js, relay/secrets-release.mjs, windows/node/host-identity.mjs, windows/node/session-api-auth.mjs | regenerate |
| `metal/guest/platform-api.bundle.mjs.manifest.json` | verifier | 3 | 20 | custody/v2/quorum.mjs, metal/guest/lease-gas-conduit.bundle.mjs, metal/guest/measured-control.mjs, metal/guest/platform-api-role.mjs, network/platform-host-policy-config.mjs, network/policy-carriers.mjs, network/service-index.mjs, network/verified-chain.mjs, relay/api-relay.js, relay/custody-state.mjs, relay/fleet.mjs, relay/host-sponsor.mjs, relay/lease-generation.mjs, relay/mcp.js, relay/secrets-release.mjs, relay/sessions.mjs, relay/store.js | regenerate |
| `network/attested-guest-verify.bundle.mjs.manifest.json` | route | 3 | 2 | - | check vs image exports (image-commit inputs) |
| `network/host-services/packages/bootstrap-replica.package.json` | consumers,leaseRelay,verifier,seam | 0 | 0 | - | regenerate |
| `network/host-services/packages/credit-vault-submitter.package.json` | consumers,leaseRelay,verifier,seam | 3 | 3 | - | regenerate |
| `network/host-services/packages/directory-replica.package.json` | consumers,leaseRelay,verifier,seam | 3 | 3 | - | regenerate |
| `network/host-services/packages/policy-mirror.package.json` | consumers,leaseRelay,verifier,seam | 7 | 7 | - | regenerate |
| `network/host-services/packages/route-dns.package.json` | consumers,leaseRelay,verifier,seam | 2 | 2 | - | regenerate |
| `relay/vendor/enclave-verifier-node.MANIFEST.json` | consumers,leaseRelay,verifier,route,seam | 0 | 0 | - | copiedFrom equality |
| `site/vendor/aa.MANIFEST.json` | consumers,leaseRelay,verifier,route,seam | 0 | 0 | - | check-only |
| `site/vendor/credit-vault.MANIFEST.json` | consumers,leaseRelay,verifier,route,seam | 0 | 0 | - | check-only |
| `site/vendor/custody.MANIFEST.json` | consumers,leaseRelay,verifier,seam | 0 | 0 | - | check-only |
| `site/vendor/host-capacity.MANIFEST.json` | consumers,leaseRelay,verifier,route,seam | 0 | 0 | - | check-only |
| `site/vendor/host-policy.MANIFEST.json` | consumers,leaseRelay,verifier,route,seam | 0 | 0 | - | check-only |
| `site/vendor/management.MANIFEST.json` | consumers,seam | 0 | 0 | - | check-only |
| `test/fixtures/attested-guest-image.bundle.mjs.manifest.json` | route | 2 | 2 | - | check vs image exports (image-commit inputs) |
| `windows/node/lease-gas-runtime.bundle.mjs.manifest.json` | seam | 0 | 4 | client/lease-executor-client.mjs, network/rpc-identity.mjs, network/service-index.mjs, network/verified-chain.mjs | regenerate (r4 omitted it) |
