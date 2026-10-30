# Host-registry offline authority is not app emergency settlement

Source audit only, 2026-10-29. No contract/host/production mutation. The schema-3
app accounting tests do not qualify host-registry offline reporting.

## Existing interfaces and the gap

| Component | Existing source behavior | Missing capability |
| --- | --- | --- |
| `EnclaveDeploymentLifecycleEmergency.emergencyOffline` | Owner-enrolled app quorum revokes one app assignment without external calls; records exact run generation/cutoff; settlement later acknowledged by its ledger | Does not write any registry host status, cover other apps, or hold a host-offline reserve |
| `EnclaveRegistry.deregister(bytes32)` | Only the row's operator may set active=false | An independent authenticated reporter cannot mark a crashed operator's host offline |
| `EnclaveRegistry.heartbeat(bytes32)` | Operator may set lastSeen and active=true | No epoch/revision fencing against a separate offline tombstone |
| `EnclaveRegistry.register(...)` | Operator boot/config write can set active=true | No atomic owner-enrollment/capacity/attestation gate for recovery from independently recorded offline |
| `EnclaveHostOwnership` | Active registered operator proposes first owner; that wallet accepts; later owner transfers and policy revisions are wallet-owned | No offline writer, host-state generation, protected reserve, or atomic callback to invalidate a cached reporter quorum on transfer |
| `EnclaveHostPaymaster` | Vouched ERC4337 call restricted to account execute(registry,0,register(...)); once per hardware/operator | Cannot sponsor an independent host-offline call; registration sponsorship is not a durable offline reserve |
| `network/host-liveness.mjs` and registry reconciliation | Off-chain bounded liveness; routine hosts no longer send heartbeat writes; timer does not reactivate an inactive row | Off-chain exclusion alone does not record an authenticated host-offline state on chain |

Read source:
[registry](../../../contracts/EnclaveRegistry.sol),
[ownership](../../../contracts/EnclaveHostOwnership.sol),
[registration paymaster](../../../contracts/EnclaveHostPaymaster.sol),
[off-chain liveness](../../../network/host-liveness.mjs), and
[reconciliation](../../../network/registry-reconcile.mjs).
The coordinator checkout's ownership source is byte-identical to this checkout.
Its registry source differs in provider-name comments, not in these interfaces;
that still means source/deployed-code pins must not be treated as interchangeable.

## Required new protocol surface (proposed, not implemented)

1. A host lifecycle authority bound to a specific registry and accepted ownership
   authority, with per-host epoch/generation, accepted owner/policy revision,
   operator, hardware/descriptor identity, attestation/capacity evidence identity,
   and enrolled reporter quorum. Payout wallet is not owner authority.
2. An authenticated host offline intent binding chain/domain, registry, host,
   generation, current operator, enrolled owner/policy revision, target state,
   observation/evidence digest, deadline, sender/payee and reimbursement cap.
   A quorum can record Offline/Pending without the failed host, a fresh identity
   lookup, admission approval, payment recipient or fee oracle being reachable.
   Exact retries are idempotent; stale/duplicate/domain-mismatched reports fail.
3. A canonical registry acceptance path: either a new registry with a pinned
   lifecycle writer, or a mandatory pinned lifecycle overlay read by every
   consumer. The existing deployed registry has no external-writer setter;
   granting an arbitrary reporter the operator key is not a solution. An overlay
   does NOT change the old registry's active bit or make legacy readers safe.
4. A separately protected host-offline budget and independent sender. Reserve
   this before listing; release listing gas only after passing capacity work and
   fresh valid attestation. A later test failure must not delete the host's last
   ability to record offline. Execution/L1 costs and safe withdrawal restrictions
   need qualification. Lack of reimbursement cannot erase authenticated failure.
5. Recovery as a new fenced host generation, requiring the accepted owner's
   authority, fresh valid attestation and available-capacity evidence. A routine
   heartbeat/register/config write must not override a newer offline record.
   Per-app replacement fencing remains a separate obligation.

Suggested names such as `recordHostOffline`, `reconcileHostOffline`,
`configureHostAuthority`, or `hostLifecycleSchema` are interface requirements,
not existing callable selectors or authorization to deploy them.

## Ownership/bootstrap coupling must be explicit

Current first-owner enrollment requires an active registry row. A policy requiring
accepted ownership *before* that first row is listed therefore needs a reviewed
atomic/pre-enrolled bootstrap path. Do not claim the current three calls solve
that circularity automatically.

An external-call-free offline path cannot infer a new ownership revision from
another contract while that dependency is unavailable. Ownership transfer and
reporter-policy invalidation must update the host lifecycle authority atomically,
or a separately reviewed protocol must define why the enrolled quorum remains
authorized. Current `acceptOwner`/`setPolicy` update their own mapping only. Merely
caching owner/revision and skipping failed reads would let former authority act
against a newer owner. This is a new host interface requirement, not solved by
the app controller's per-app cached witness list.

## Consumers, funding and required evidence

The actual adapter's full recursive graph must pin registry, host lifecycle,
accepted ownership, sponsor/budget writer and code dependencies at one verified
snapshot. Include the host lifecycle's generation in durable local denial floors,
routing/ingress, scheduling, storage and secret permits. Deny locally immediately
on authenticated failure; reconcile the transition to canonical finality without
restoring permission on timeout or restart. Keep heartbeats off chain.

Prefer an eligible online host with paid work for sponsorship. Use the scoped
existing Stripe provisioner fallback only after verified absence of that source,
not after a lookup failure. Reconcile a durable hardware/job identity before any
source pays. Registration vouchers alone do not establish test success or reserve
an independent offline transaction.

Required tests include host-offline reports during registry/identity/payment
failures; cached-owner transfer invalidation; stale epoch/replay refusal; failed
listing never becoming available; retained offline reserve after later failure;
recovery unable to bypass fencing; and independent host versus app status changes.
The current 63 app/accounting tests and 15 linked-code mock tests cover none of
these new host-registry state transitions. No live host readiness is inferred.
