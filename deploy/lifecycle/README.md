# Event-driven deployment lifecycle candidate

This is an isolated implementation candidate, **not an activated release**.
It does not modify the current ledger, address book, Windows host agent, RPC
services, catalog, running deployments or owner/session balances. The integration
and migration work below is required before it can replace the live lease loop.

## Behavior implemented

The new ledger pairs once with `EnclaveDeploymentLifecycle` and a pinned
`EnclaveSelfHostingIdentity`. It allocates the entire affordable runtime instead
of buying 30-minute reservations. Paid topups extend an active funded horizon
in the funding transaction. Verified self-hosting has zero host compute rate;
publisher fees, if configured, remain separate. A factory-verified SessionVault
and its actual owner count as the same self-hosting principal. An arbitrary
contract exposing `owner()` does not qualify.

There are no claim, renew, release, leaseSec, claimable or claimableBy selectors
in this ledger. Legacy schedulers cannot use it. `leaseUntil` is retained in the
record shape for accounting compatibility, but now means the funded horizon;
zero-rate assignments use uint64.max. Historical revision notes in the copied
ledger describe its accounting ancestry, not the lifecycle policy of this
candidate. `deploymentsSchema()` is 17 and `lifecycleSchema()` is 2.

Only meaningful queued/running/stopped transitions incur controller transaction
charges. Exact signed-intent retries are idempotent and do not debit the app
again. A retry transaction could still cost its sender gas, so the relay must
reconcile before submitting. The app's ETH transition reserve pays bounded
reimbursements, including an upper estimate of Base data fees. This is not yet
qualified as exact receipt-cost reimbursement. Configure/deposit/withdraw/resume
and other owner administration remain explicit transactions.

Self-hosted apps still need spendable transition funds. The controller protects
a separate final-stop allowance; the host stops at spendable depletion rather
than waiting until the entire ETH balance is literally zero. Protection only
holds within the owner's configured transaction and gas-price ceilings. A fee
spike beyond those ceilings must halt serving and retain the pending stop until
it can be recorded. It must not silently spend another wallet's funds.

Readiness is required before running is submitted. Failed boots while queued
back off without another queued transaction. Runtime failures queue the app,
fence the old generation and use exponential backoff (5 seconds through 5 minutes,
with local jitter). Five consecutive failures hold for owner resume. A witness
quorum can attest ten minutes of actual continuous health at the next failure
transition to reset the failure count; elapsed wall time alone cannot reset it.

The journal durably records crash counts, generation fences, permit replay
floors and exact pending transaction intents. Corruption or write failure fails
closed. Its current API assumes one owning process; a production adapter must
enforce exclusive ownership of its file.

## Authority and fencing: current rollout blocker

Heartbeats and serving permits stay off chain. The permit design requires an
owner-selected quorum greater than two thirds (normally 3 of 4). Witnesses must
durably fence a generation before voting it out. Permits last at most 20 seconds,
and takeover waits at least 22 seconds for expiry plus clock skew. Restart
backoff can extend that delay. This removes a fixed 30-minute reservation wait;
it is **not a demonstrated end-to-end recovery-time guarantee**.

The prototype currently requires a proof-qualified safe/finalized authority
snapshot whose underlying block is at most 20 seconds old. The coordinated RPC
work measured a finalized state about 1,034 seconds behind wall time. A newly
verified read of that state does not make the block current. Therefore this
prototype will fail closed on that feed and MUST NOT be activated there.

The final design must distinguish:

1. authenticated block timestamp and finality;
2. freshness of verification/observation;
3. quorum knowledge of a durably fenced generation;
4. when an administrator disable, host ban or owner change becomes authoritative.

Changing a timestamp to the time of a successful HTTP response, accepting unsafe
latest state, or removing the bound is not a resolution. A measured protocol
and integration test must establish what revocation/failover latency is actually
supported. Administrator upgrades, moderation and bans remain authoritative;
witnesses cannot override them.

## Integration contract

`network/deployment-lifecycle-runner.mjs` is an adapter-driven state machine.
Its unit tests inject adapters; it is not connected to a production host.

- `chain.read` must authenticate schema, assignment, policy, funds, ownership,
  registry and catalog/admin admission at a coherent authority snapshot. Global
  `enabled` is distinct from host-specific `admitted`. For queued apps, `funded`
  means sufficient transition budget and affordable candidate-host runtime;
  do not use the controller's running-only `funded()` for queued apps.
- `chain.prepare` returns the exact unsigned generation/revision/domain/fee-bound
  intent. `submit` signs only after durable outbox persistence. `resolve` verifies
  the exact receipt or a finalized fence; a transport timeout is not a failed tx.
- `runtime.ensureStaged` may boot but must not authorize serving or data writes.
  `serve` must acquire a validated quorum permit, persist its replay floor and
  schedule expiry independently of the reconciliation loop.
- `runtime.fence` must revoke existing streams, storage writes and access to
  secrets as well as new connections. `stop` must confirm retirement before the
  controller queues a replacement. Process termination alone is insufficient
  protection against a hostile old host with copied data.
- Witness signing must integrate durable fence/anti-equivocation state, verified
  owner policy, authenticated health and bounded resource use. A raw signing
  helper is not a witness service.
- A production host must use one lifecycle implementation per deployment and
  never run the old renewal loop concurrently. Ingress, storage and secret
  release must enforce the same generation. The current code does not install
  these adapters, services or UI status mapping.

Paid proof-of-service accounting is inherited and still needs qualification.
Those settlement checkpoints are distinct from liveness heartbeats. This
candidate does not claim that paid compute has only three lifetime transactions.
Self-hosted zero-rate execution has no compute settlement to charge.

## Migration sequence, not an executable rollout

1. Qualify the authority/fencing protocol and implement the adapters above.
   Exercise partitions, host crashes, owner/admin changes, journal loss,
   duplicate relays, fee spikes and rollback on a non-production deployment.
2. Build the candidate artifacts with the pinned compiler and compare actual
   deployed runtime after resolving constructor immutables. A template hash is
   not an on-chain code pin. Deploy new paired contracts; the old ledger cannot
   be made compatible merely by pointing this controller at it.
3. Inventory every deployment, owner (including vaults), backed/refundable
   balances, earned operator credit, publisher fee, cap, policy and pending
   intent at a verified snapshot. Preserve administrator control and proof
   settlement binding. Prepare exact address-book and owner authorization
   changes for review; no wildcard permissions or hidden wallet funding.
4. Fence and retire each legacy assignment, settle its final eligible service,
   reconcile receipts and refund its unserved tail before importing it. Import
   refuses active legacy runners. Do not count source escrow and destination
   backing twice or strand existing operator earnings.
5. Re-seat actual backing with verified conservation checks, configure owner
   witness and transition-budget policies, verify all imports, seal imports,
   then perform the coordinated address-book/host/client cutover. Old reserve
   permissions must not continue paying renewals. Retain a reviewed rollback
   path that fences the new generation before any old one can resume.

No live addresses or transaction payloads are specified yet: migration receipts,
current balances, factory pins, authority policy and integration release hashes
must first be qualified. Existing sessions do not automatically authorize new
contract deployments, ETH reserve funding, or administrator book updates.

## Build and verification

Use Solidity 0.8.35, viaIR, optimizer runs 1, EVM Prague. The candidate builder
is separate from `scripts/build-contract-artifacts.mjs` and does not overwrite
production browser artifacts. It emits ABI, selectors/events, creation bytecode,
runtime templates, immutable references and source hashes:

```sh
node scripts/build-lifecycle-artifacts.mjs /absolute/path/to/solc-0.8.35
bash scripts/test-deployment-lifecycle.sh
```

Run through the workspace resource queue where required. Forge is test-only;
deployment artifacts come from the isolated standard-JSON compiler build.
Tests include the real SessionVault clone factory, meaningful accounting/state
behavior and EIP-170 size checks. Mock adapter tests demonstrate state-machine
behavior, not production fencing or a working decentralized deployment.
