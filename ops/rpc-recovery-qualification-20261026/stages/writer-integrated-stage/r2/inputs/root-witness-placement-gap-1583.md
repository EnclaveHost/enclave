# Witness placement gap identified by root (source review only)

The frozen integrated driver currently restricts its witness URL to loopback. The new producer draft also binds loopback and runs witness_fetch against four loopback backend-node ports. These are different domains in the actual deployment: the reader/native verifier live inside the measured platform-api guest; the full Ethereum/Base nodes live in the separate untrusted RPC VM. Neither local loopback address crosses that boundary.

Existing measured role explicitly binds three private IPv4 backend origins via HOST_DATA: /tmp/w5/metal/guest/platform-api-role.mjs lines~90-115; /tmp/w5/metal/derived-reader-image.json describes this separation. Existing /tmp/w5/network/chain-authority.mjs validates loopback/private IPv4 own-node transports. Native derivation treats witness bytes as untrusted regardless of transport location.

Required before production: choose a concrete supported transport. Prefer reuse existing bound private backend origin validator/config and expose only a bounded witness endpoint across the private guest-host link, with service privately scoped/firewalled and no public name/provider. Alternatively a measured loopback proxy must be explicitly packaged/wired to that same private backend; do not imply loopback alone solves placement. Keep full native proof checks and exact request/response limits; never turn backend HTTP into authority. Do not co-locate a second chain node or add public RPC fallback. No activation currently authorized by passing fixture.

Claude50 and370 should reconcile this once their current source tasks finish. Preserve frozenr1s and use new composition. Actual layout/forwarding must be tested across guest/backend boundary; local fixtures insufficient.
