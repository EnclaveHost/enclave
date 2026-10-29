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

## Admission bootstrap dependencies confirmed by source review

The existing ownership contract enrolls an initial owner only after the operator has an active registry entry, and acceptance is a separate wallet transaction. Registering first and enrolling emergency authority later leaves a window in which a listed host cannot be independently marked offline. New admission must atomically establish the verified listing, protected offline budget and authenticated owner/witness policy, or consume valid pre-enrollment proofs atomically. A payout recipient is not host ownership authority.

Existing host-capacity records authenticate the reporting operator but expressly label resource quantities as self-reported. The producer and capacity observation loader require registration, and the current CPU/RAM workload requires a paid lease. They do not yet implement qualification of an unregistered, zero-gas candidate. Listing-gas release must bind completed test evidence and fresh attestation; CPU/RAM evidence must not qualify untested GPU capacity. Display and scheduling must consume that same evidence with current commitments deducted.

The [bootstrap source review](../../ops/unified-funding-20261028/host-admission-bootstrap-review-r1/ROOT-REVIEW.md) pins the inspected files and records these gaps. A read-only provisioner balance attempt returned HTTP403 before any balance observation; it establishes neither available sponsorship funds nor authorization to spend. No wallet/key or production configuration changed.

## Host composition review, 2026-10-29

Two independent [composition regressions](../../ops/unified-funding-20261028/lifecycle-host-authority-root-regressions-r1/ROOT-REVIEW.md) are reproduced in a frozen partial host-authority candidate: recovery publishes zero allocated CPU for a Running app, and the operational proof branch erases a current host-local admission denial before the ledger transition decision. Tests use the real runner/verifier with mock authenticated reads and transactions. These are candidate defects, not observed production incidents. Retain resource commitments until confirmed retirement and retain local denials monotonically through proof processing; local fencing alone does not satisfy offline reporting. The candidate is not deployable.

## Host authority review update

The complete r2 author delivery passes its 60 fixture tests. Root fixed the operational-proof branch so verified eligibility cannot erase a current host-local refusal; the added refusal regression and 26 existing runner/generation-proof tests pass. The complete candidate remains unready: its recovered-capacity regression still fails. The [root review](../../ops/unified-funding-20261028/lifecycle-host-authority-review-r2/ROOT-REVIEW.md) records the exact source and production limits. The latest full suite is 62 pass/3 fail/0 skipped after the cold-handoff correction below; the remaining failures are recovered capacity and the two publisher-veto checks.

Two additional goal-alignment tests show that mandatory publisher delisting/yank checks still give a publisher a veto over independently owned deployments of unchanged content. Listing preferences must not be confused with cryptographic content integrity or the deployment owner's authority. Host owners may elect moderation, and deployment owners retain their own controls; merely publishing an app must not grant Enclave control over other wallets' hosts. The next actual chain/runtime composition must remove this residual veto as well as address-book dependencies, while preserving authenticated content and ownership.

## Ledger retirement is an authority boundary

The legacy-derived candidate still has a global administrator retirement power: `retire()` sets `retired`, `lifecycleOperator`/`lifecycleFunded` and `_requireActive` stop eligibility/funding, and `refund` permits arbitrary callers when retired, deactivating the deployment while returning its balance. This is a global shutdown capability even though the money goes back to its owner. Ignoring the flag only in a host adapter does not remove the underlying contract veto.

The new independent ledger must preserve deployment-owner/delegate cancellation, earned-payment backing and refunds without granting a ledger administrator authority over independently owned deployments. A retained retirement marker can be discovery/deprecation metadata only if it cannot block independent operations or authorize a foreign active-record refund. Existing deployed legacy behavior stays unchanged during preparation; migration must explicitly target the reviewed independent semantics. Old tests that expect a global administrator stop are not acceptance criteria for this goal. Peer implementation and actual contract tests remain pending.

## Cold restart must not restore central authority

The root cold-handoff regression reproduces a mutable address-book veto after reopening the actual lifecycle journal. The dispatch now verifies the explicit route's finalized source-ledger proof without requiring the current global book to select that ledger. It retains unresolved release/activity checks before and after asynchronous proof verification. Wrong-ledger proofs still refuse. This fixes the staged dispatch, not the still-dependent r6 adapter or live host recovery. Source, before/after evidence and the exact remaining failures are in the host-authority root review.

## Stable independent contract terms

Retirement is not the only global authority. The [pinned contract review](../../ops/unified-funding-20261028/lifecycle-authority-boundary-audit-r1/ROOT-REVIEW.md) distinguishes mutable claim bonds and unilateral bond slashing, future deployment/resize economics, service-proof policy, ETH funding dependencies and unsealed imports. Independent qualification must cover new-user admission and failover as well as already-running apps. Keep agreed financial, proof and owner controls; removing off-chain checks cannot undo continuing on-chain administrator powers.

Paid-service checkpoints are separate from lifecycle renewals and are not required for zero-rate self-host runs. The current prover still charges recurring settlement transactions for paid work. This is an open cost/independence issue, not evidence that the event-driven goal is already met or a reason to remove service-proof security. Migration must seal privileged imports and verify the actual immutable contract graph.

## Durable host ownership authority

Two [restart regressions](../../ops/unified-funding-20261028/lifecycle-owner-restart-regressions-r1/ROOT-REVIEW.md) confirm that the staged dispatch rejects stale or contradictory host-owner revisions in memory but accepts them after reopening its actual journal. Both fail at the intended restart check after passing positive controls. Persist accepted host/ownership-contract/revision/policy evidence before effects, preserve monotonic refusal across restarts, and keep reconciliation/offline available. The active composition implementation is tasked with this repair; it is not fixed or deployed by these tests.

## Self-hosted Top up presentation

The staged [transaction-gas Top up repair](../../ops/unified-funding-20261028/selfhost-topup-event-budget-review-r2/ROOT-REVIEW.md) removes the rejected renewal-hours estimator. It displays the fixed ETH purchase and maximum USDC debit under the existing finite gas grant. Its 12 focused checks and reconstructed graph build pass. This is not deployed, does not implement background refill, and does not repurpose the existing legacy gas grant for the new lifecycle controller. The positive-rate runtime and restricted-credit paths remain distinct.
