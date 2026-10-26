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
floors, exact pending/mined transaction intents, runtime identities and accepted
Base/L1 anchor floors. Corruption or write failure fails closed. The exclusive
owner adapter uses a kernel file lock on Linux and a named pipe on Windows.
Both release ownership when the process dies. A missing journal refuses normal
startup; explicit initialization is reserved for initial enrollment. These mechanisms do not protect
against a malicious disk rollback or erased journal: a restored host/witness
must recover an authenticated floor before it may sign or serve again.

## Authority and fencing

Heartbeats and serving permits stay off chain. Each owner selects a quorum
greater than two thirds (normally 3 of 4). Witnesses durably fence a generation
before voting it out. Permits last at most 20 seconds; takeover waits at least
22 seconds for expiry plus clock skew. Restart backoff can extend that delay.
This removes a fixed 30-minute reservation wait; it is **not a demonstrated
end-to-end recovery-time guarantee**.

The candidate separates authenticated policy age, recent verification, current
denials and operational generation authority. `maxAnchorAgeSec = 0` is the
on-chain default and retains the strict finality-only path. An idle deployment's
owner can explicitly authorize a 20–3,600 second policy-anchor bound. This is a
maximum proof age, not a renewable on-chain reservation. The bound cannot be
changed while running. No fast-mode policy has been activated for a real app.

With that explicit policy, a chained quorum certificate can authorize a newer
generation while its transaction awaits finality. Every certificate binds the
chain, controller, deployment, anchor hash/height, witness policy/revision,
predecessor, generation, host/operator, exact payable transition intent, expiry,
remaining reserve and funded horizon. It cannot mint budget or extend paid
runtime. The host requires a proof-qualified mined receipt for a pending local
transition before proceeding; it retains that exact intent until finality.
A proved reorganization fences and stops the runtime. Automatic replay after a
reorganization is not implemented and must not silently replace an intent.

A current denial check must be observed within 20 seconds and independently
proof-qualified, with authenticated ancestry to the policy anchor. An unsafe
head may deny service but cannot supply a new owner, witness set, funding grant
or restoration. Denials persist across restart; only authenticated positive
finalized state at or beyond the denial height may restore service. Administrator
upgrades, moderation, bans and owner restrictions retain precedence. Ancestry
alone does not authenticate the latest head.

The old 1,034-second measurement came from the **Ethereum** finalized reader,
not a qualified Base reader. A resolved ASR-game anchor can be days old and is
not suitable as a near-current lifecycle policy source. The new finality bridge
accepts only an in-domain `l1-finalized-derived` anchor and then pins local
proof-executing state reads to its exact Base hash. A fresh HTTP response does
not change the authenticated block timestamp. The bridge persists accepted
Base/L1 floors before publishing a snapshot and rejects rollback after restart.

**The callable derivation provider is now implemented in
[network/derived-reader](../../network/derived-reader/README.md).** Live owned L1
and schedule checks passed; positive Base witness and accepted-image qualification
remain pending with the coordinated RPC work. There is no automatic fallback or
production activation. See [AUTHORITY-ADAPTER.md](AUTHORITY-ADAPTER.md) for the exact boundary.

The contract supports quorum-attested continuous health to reset crash counts.
The fast certificate path currently requires `healthySince = 0`, conservatively
retaining failures until a new authenticated anchor or owner resume establishes
the reset. It cannot infer health from elapsed time.

## Implemented adapters and remaining composition

- `deployment-lifecycle-witness.mjs` and `deployment-witness-http.mjs` implement
  bounded witness endpoints. Requests require operator authorization and local
  authority/readiness verification; clients cannot supply a signing snapshot.
  Successor votes persist before either certificate or transition signatures.
- `deployment-permit-collector.mjs` collects permits and generation certificates
  from configured HTTPS witnesses. It verifies both generation and payable-intent
  signatures and returns contract-ordered approvals. HTTP is available only
  through an explicit loopback fixture option.
- `deployment-permit-gate.mjs` revokes already-open resources on expiry and checks
  wall and monotonic deadlines before new writes or secret release. Replaying a
  permit cannot restart its lifetime. A clock discontinuity closes the gate.
- `deployment-isolation-runtime.mjs` uses the existing Windows/Linux manager HTTP
  contract. It stages under held I/O boundaries, requires independent measured
  readiness, and retires the concrete VM on permit expiry even if reconciliation
  stalls. A verified failed-boot retirement permits a later boot without clearing
  the crash counter. Ambiguous POSTs reconcile against the manager's name-based
  idempotence contract before another spawn; unknown inventory cannot launch.
- `deployment-lifecycle-runner.mjs` handles funded running, failure queueing,
  final-stop reserve depletion and durable transaction reconciliation. A qualified
  current denial retires the local runtime immediately. Recording the resulting
  stopped state from a denial-only source still needs the production relay path.

The modules are implemented; their production composition is not installed.
The host must wire real measured launch/readiness, registry/catalog/admin reads,
generation collection and transaction relay, and ingress/storage/secret services
that enforce the same absolute deadline and generation. Boundary acknowledgments
are a local adapter contract, not proof that an arbitrary remote service enforces
expiry. Never run the old lease loop for the same deployment. Process termination
cannot revoke raw data already copied by a hostile host.

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
