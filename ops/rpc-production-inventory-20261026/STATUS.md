# Production placement audit, 26 October 2026

This is a read-only inventory, not a deployment or completion claim. The raw report is preserved as received; the corrections below take precedence over its recommendations. Fresh droplet observations were collected at 11:52 UTC. Control VM and Windows observations are older (approximately 03:00 UTC). Identical PIDs do not prove unchanged in-memory code; process continuity alone is insufficient for release identity.

The four DigitalOcean machines still run directory, DNS, gateway/TLS, custody and (on one machine) lease-relay services in addition to WireGuard. This contradicts the user's requirement that they remain minimal WireGuard hosts. Those services must move to supported Enclave host/app paths before the broader goal is complete, with verified replacement and rollback before removal. No current service was stopped.

Administrator controls remain required: the user explicitly clarified that censorship resistance targets external providers, not Enclave platform administrators. Preserve moderation, host bans and contract upgrade administration.

Corrections to the preserved report:

- The report's October 28 historical-coverage deadline is stale. Current planning places the earliest relevant pruning near November 7 at 13:00 UTC, pending exact authenticated origin and actual availability checks. Neither date is a substitute for the live cryptographic coverage gate.
- The active finalized-reader runtime baseline is 64156dcd with the qualified 34a3c0d6 reader closure, composition tree 9dd20e76. Source branch 5f0e0117c stores operational artifacts and is not an interchangeable runtime baseline.
- Bootstrap r14 is undergoing historical-coverage and continuation integration. r15 failed its actual candidate pin check. r5/r16 continuation remains under qualification. No unqualified candidate should be installed.
- The latest paid adapter full run root-paid-r6-full-1282 failed: the new adapter's 15 tests and nine existing suites passed, but package tests passed only two of five. Missing relay build prerequisites and inherited Node test context are being repaired. Expected failure of a deliberately broken control does not make the complete run pass.
- A private owned-node upstream with public fallback is at most a transition. It does not prove complete RPC replacement, accepted proof authority or survival of public RPC loss. Production cutover requires actual synchronization, historical coverage, qualified recent/finalized state, accepted-domain proof serving, mined writes, public-RPC blackout and cold recovery.
- At 12:13 UTC the storage guard was armed, with no alarm: about 555.6 GB free versus a 468.7 GB shutdown threshold. The instantaneous growth rate is not a reliable forecast. Capacity work is needed, but the report does not establish an immediate guard emergency.

Existing writer freshness remains capped at 120 seconds, with the ownership-establishing claim separately required to be finalized and canonical. A finalized-only reader cannot currently satisfy every recent-state consumer. An isolated signed-payload execution candidate is being evaluated; signatures or an unsafe node head alone are not production authority.

No signing request follows from this inventory. Any later request must identify the exact action and verified prerequisite state. All broader custody, independent-host recovery and feature-preservation requirements remain open.
