# Decentralized lifecycle, admission and gas funding

Status at 2026-10-29: implementation and migration in progress. This is the highest-priority feature toward completely decentralizing Enclave's architecture for censorship resistance. It is not a separate funding project, and passing a component test does not demonstrate an independent deployed network.

## Required behavior

- On-chain lifecycle updates are event-driven queued/running/stopped transitions, not periodic lease renewals or on-chain heartbeats. Health, serving permits and capacity refreshes are off-chain. Necessary status and settlement transactions still require gas.
- Automatic replenishment converts only explicitly authorized USDC, under the applicable contract/session budget and scope. Self-host Top up supports transaction gas without promising fixed runtime hours. Existing grants targeting the legacy reserve do not authorize a new lifecycle contract.
- Online admission may be refused. Authenticated offline reporting, including an independent reporter for an unavailable host, must not depend on online admission or the failed host signing. Keep a protected offline reserve and reconcile uncertain sends. Local traffic withdrawal is not a ledger offline update. Finite ETH cannot guarantee inclusion through arbitrary fees or chain outages.
- A joining host completes a capacity test and presents valid fresh attestation before listing gas is released or it is listed online. Sponsorship can be reserved before testing; initial failures stay unlisted. A later failure of an admitted host uses the protected offline allocation.
- Prefer an available paid-work sponsor. Only when no eligible online paid-work sponsor exists may the specifically authorized existing Stripe provisioner fund admission. Preserve customer-order liabilities, headroom, caps, hardware/test identity, replay protection and a single coordinated financial submitter. Do not turn restricted credits into arbitrary host cashout.
- Verified capacity drives Live enclaves and scheduling; subtract allocations, pending reservations and headroom. CPU/RAM test evidence does not prove GPU capacity or exclusive ownership of physical resources.
- A wallet may control the hosts it owns. Enclave-operated control, identity, catalog, artifact/indexer, DNS and custody systems must not remain mandatory authorities for independent hosts. Preserve authentication, attestation, integrity, isolation and legitimate owner controls while removing those dependencies.

## Current evidence and limits

The production USDC-to-gas path has two confirmed recovery payments (d979 and EyesOff); those payments must never be repeated. This does not prove the event-driven migration or automatic replenishment complete. The live legacy protocol remains in use until a properly fenced per-app migration.

The lifecycle candidate is on codex/deployment-lifecycle-20261026, reviewed baseline ecf364c0a81b9176163d254dcfc9685572bde0cd: ledger schema17/lifecycle schema2. It is not the current deployed contract set. Prior root r6 chain adapter qualification contains 66 offline checks; no present production Base-authority claim follows from them.

The [host-routing review](../../ops/unified-funding-20261028/lifecycle-host-routing-review-r1/ROOT-REVIEW.md) contains 29 author checks and two independently reproduced/fixed dispatch regressions, all 31 passing after repair. It is staged and not deployable: global veto/catalog dependencies, post-migration old-book dependence, emergency ledger reporting, capacity admission and real host composition remain unresolved. Its mock authority/funding results are not deployment evidence.

## Completion evidence still required

Before this feature can count as activated, verify the exact deployed contracts and recursive bindings, independently authenticated chain reads, fenced migration and conservation of balances/earnings/reserves, real host/runtime/ingress/custody composition, restricted refill and emergency offline submissions, and normal recovery of the remaining target apps. Test process restarts, lost responses, fee/settlement failures, ownership changes and unavailable hosts without duplicate sends or unauthorized vetoes.

The overarching goal also requires demonstrated cold recovery, new-user deployment, storage endpoint failure and continued independent hosting under Enclave refusal. Extra Enclave-operated replicas or moving services elsewhere do not satisfy it.

Update architecture, protocol, API/SDK, operator, deployment/migration/rollback, billing/capacity and UI documentation as each implementation lands. Every operational claim must distinguish source-only, fixture-tested and actually deployed behavior. Existing production runbooks must not be rewritten to imply this candidate is already live.
