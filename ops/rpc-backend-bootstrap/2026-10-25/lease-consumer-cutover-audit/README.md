# Lease consumer cutover audit — not activated

Read-only source audit against relay-consumer-source 81ba66853 and the recorded production inventory. No live config changed. The initial downstream trace characterized a deep-receipt refusal as benign; root did not accept this as feature-parity clearance. ROOT-REVIEW.md and the later cutover report preserve that distinction. A landed release can receive HTTP 503 release_unconfirmed rather than success; CLI recovery depends on another read succeeding. Outage/restart and site/mobile behavior still require testing.

The 256-block canonical ancestry gate authenticates membership in a fresh unsafe chain; it does not establish safe or finalized status. No gate is weakened. Custody v2 remains refused. Config templates contain unresolved prerequisites and are not deployment-ready.

Concrete implementation work remains: Windows must pass its host authority into lease-gas loading, and the conduit must support verifier-only configuration without public-RPC defaults. That work is being prepared separately, with tests required before source integration. Production proof-source and relay placement, qualified backend, old-receipt recovery, and live cutover checks remain open.
