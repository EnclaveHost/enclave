# Relay consumer source candidate — 2026-10-25

This branch is reviewed source preparation, not an activated production RPC replacement.

Root review confirmed the existing measured guest fallback in isolation/m2/front/provision.go (relayPathFacts): an absent writer-authority fact makes the guest establish the finalized claim using its measured RPCs before starting the application. The verifier relay refuses to manufacture this fact. Fencing remains, but its public-provider dependency remains too. This blocks full relay activation. No live relay, guest image, custody policy, administrator control or deployed app was changed.

The reviewed test receipts are in logs/. They include 68 affected tests across eight suites, another 24 session tests, and five actual pinned-Helios offline runtime cases. No skips in these receipts. Prior regression runs and baseline failures are detailed in CANDIDATE.md; this is not a claim that the whole repository passes. The real runtime sponsor check validates the authorization override mechanism, not a complete sponsored registration. Counterfactual undeployed wallets are not established by the deployless tests.

The runtime bundle was built for tests, but measured platform-API and MCP images have not been rebuilt. Deployment must rebuild required bundles from the composed source, review measurements, retain the previous image/config, and pass production attestation and outage/restart tests before consumer activation. Revert configuration/image to the previous pair on failed canary; no rollback transaction is required because no contract was changed. A return to public RPCs restores the previous dependency and is not replacement completion.

Do not merge measured-control changes by overwriting the independently developed attested-verifier source. Both bind-time environment validation and verifier-only front behavior must survive composition.
