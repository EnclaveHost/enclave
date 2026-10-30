# Lifecycle authority boundary

This is the interface between the lifecycle candidate and the coordinated RPC
implementation. It does not declare an existing RPC deployment qualified.
The callable reader is implemented in `network/derived-reader/`; live positive Base
derivation and accepted-image qualification remain pending. Do not select
`latest`, an unsafe signed head, or an ASR-game anchor as a fallback.

## Local derivation provider

`createLifecycleFinalitySnapshot` in `network/lifecycle-finality-bridge.mjs`
requires a trusted local `readAnchor({ signal })` function. The RPC implementation
owns the light-client, derivation, execution and upgrade-schedule verification.
Untrusted preimage/RPC transport must not choose the accepted chain rules.
The function must return this result only after those checks:

```js
{
  tier: 'l1-finalized-derived',
  base: { number, hash, stateRoot, outputRoot, timestamp },
  l1: { number, hash, timestamp }
}
```

Numbers/timestamps are nonnegative safe integers; timestamps are Unix seconds.
Hashes are lowercase 32-byte hex strings. The Base **number and output root**
must both be authenticated. Header state root/hash must be consistent with that
output. The L1 object identifies the finalized authenticated derivation input.
The word `finalized` from an RPC block tag is not evidence of this process.

The bridge also requires the existing local proof-executing verifier endpoint
and an exclusively owned lifecycle journal. It checks chain 8453 and the exact
Base header before and after the callback, pins all state requests to that block
hash, and durably accepts the Base/L1 floor before publishing the snapshot.
Retained clients close when the callback returns or the deadline expires.
Concurrent snapshots through one bridge are refused. The journal rejects older
or contradictory floors across restart; an erased/rolled-back disk requires
separate authenticated recovery before signing or serving.

The consumer callback returns `value`; the bridge returns that value with
`blockNumber`, `blockHash`, `stateRoot`, millisecond `timestamp`, millisecond
`observedAt`, and evidence containing the original Base/L1 objects and tier.
The bridge's configured maximum anchor age is a hard upper bound. Each app's
explicit owner policy can impose a stricter bound, checked again by witnesses.

## Coherent application state

The chain adapter must use one pinned callback to authenticate:

- The address book and actual deployed code hashes, resolved immutable bindings,
  controller/ledger pairing and schema 2. Build-time runtime template hashes are
  not on-chain code pins. Keep administrator upgrade authority intact.
- Deployment owner and effective authority, including a verified SessionVault
  factory clone identity; assignment generation, revision, host/operator, state,
  change/start times, crash count/hold and last intent.
- Witness addresses and threshold, explicit `maxAnchorAgeSec`, complete budget
  limits and balance, paid-compute horizon and host-rate eligibility.
- Global owner/catalog/admin admission and candidate host-specific registry,
  owner restrictions, ban/admission and measured launch eligibility.

Read every field at that same Base hash. A cached owner, latest budget and older
registry do not form a coherent snapshot. Queued affordability must include the
candidate host; the controller's running-only `funded()` is insufficient.
Amounts are decimal strings or bigint. Normalize uint64.max horizons to a
conservative safe-integer upper bound rather than converting them with lossy
`Number()` precision. Never extend a finite paid horizon during normalization.

## Operational authority and current denials

The `generationAuthority` input to witnesses/runner contains:

```js
{
  anchor: {
    proofVerified: true, tier: 'l1-finalized-derived',
    number, hash, timestamp, observedAt,
    enabled, admitted, hostAdmission: { host, admitted },
    funded, fundedUntil, balanceWei, ownerAuthority, policyHash,
    assignment: {
      deployment, generation, state, host, operator,
      changedAt, startAfter, failures, crashHeld
    }
  },
  head: {
    proofVerified: true, tier, number, hash, timestamp, observedAt,
    anchorHash, ancestryVerified: true, denied
  },
  policy: {
    revision, witnesses, threshold, maxAnchorAgeSec,
    maxTransitionWei, stopReserveWei
  },
  certificates: [ /* exact signed generation envelopes */ ]
}
```

All times here are **seconds**. `policyHash` is calculated by
`certificateWitnessesHash` from the authenticated policy. An optional `denyFloor`
is additional restrictive state; it cannot grant service. For candidate signing,
`readGeneration` additionally returns an anchored, proof-qualified candidate
`{ blockHash, host, operator, eligible, proofVerified }`.

`anchor.enabled` and the retained `anchor.admitted` field describe **global**
deployment admission (owner enablement, catalog and administrator policy).
Neither may include a refusal specific to the host requesting the read.
`anchor.hostAdmission` is the separate host-scoped result from the same pinned
snapshot, including registry, placement, host-owner policy and host affordability.
Its `host` must exactly match the host requested by the runner, serving witness
or successor witness. Missing, mismatched or non-boolean admission is unknown,
never permission. A known false host admission queues this host's own running
assignment or leaves an already queued deployment available to other hosts.
It cannot cause a deployment-global stopped transition. Serving and successor
signing both require matching true host admission; a verified global generation
chain alone is insufficient. Outer snapshot booleans do not override these
authenticated fields. Current denial and sticky restoration gates still take
precedence; this separation does not qualify the pending denial-only stop relay.

`head` needs independently authenticated current-head authority AND verified
ancestry to the anchor. An arbitrary header chain ending at a known ancestor is
not sufficient. Current-head observations and block age are bounded to 20
seconds. Denials include owner/assignment/policy changes incompatible with the
anchored authority, insufficient funds, disable, catalog moderation and host
bans. Unknown state refuses service. Unsafe state can deny but cannot grant a
new budget, owner, witness set or restoration. A denial persists until positive
finalized authority at or above its height establishes restoration.

`maxAnchorAgeSec = 0` does not enable this operational mode. Owner opt-in is
required on chain; candidate defaults must never silently change that policy.
The strict path still demands a policy block within 20 seconds and will refuse
sources that cannot provide one. The user's pending preference question is not
an activation authorization.

## Witness and runtime composition

`DeploymentLifecycleWitness` accepts only local `authority.read`,
`authority.readGeneration` and `health.verify` implementations, plus a protected
signer and exclusive durable journal. HTTP requests never provide these sources.
Health binds deployment/host/generation/concrete instance; witness health expiry
uses seconds. A running successor also requires operator authorization and
anchored candidate eligibility. Failure voting requires authenticated ended
state or expired authenticated liveness, not an HTTP timeout by itself.

`createGenerationCollector` verifies both the certificate signature and the
exact contract-transition signature from each configured HTTPS witness and
returns signer-ordered approvals. Persist the exact proposal before collecting:
changing it after a partial quorum can strand anti-equivocation votes. This
collector does not itself persist proposals, broadcast transactions or implement
consensus leader recovery.

The manager runtime adapter requires a verified measured launch plan with
`stagingEnforced`, independent readiness, and boundary `hold`/`allow` adapters.
Runtime readiness and boundary grant expiries use **milliseconds**. Boundary
services must independently enforce the exact absolute expiry and generation
on existing streams, writes and secret release; forwarding a JSON acknowledgment
is insufficient. Gate callbacks also retire the concrete VM on expiry. Do not
run the old lease loop concurrently. Journals must use the kernel ownership
wrapper for the entire service lifetime. Normal startup refuses a missing file;
`initialize: true` is reserved for new enrollment, never automatic crash recovery.

## Transaction and receipt reconciliation

The runner's chain adapter owns `prepare`, `submit`, `resolve`, `finalize`:

1. Prepare an exact EIP-712 intent with chain/controller/deployment/generation/
   revision/target/host/deadline/payee/fee bounds. The runner persists its digest
   and serialized payload before submission. Never silently rewrite a pending
   intent, fee, payee or deadline.
2. Submit with the matching actor authorization and required witness approvals.
   Reconcile uncertain transport results; never treat a timeout as a revert.
3. `resolve` returns the same digest, `verified`, `proofVerified`, authority tier
   and an authenticated outcome. `confirmed` or `finalized-fence` clears an
   outbox only at `finalized`/`l1-finalized-derived`. A `mined` result additionally
   supplies exact transaction hash, block hash and number. Operational use of
   that result requires a matching quorum certificate; its intent stays saved.
4. `finalize` proves that exact receipt finalized, or proves it was reorganized.
   The latter fences/stops and retains the intent; automatic reorg replay and
   expired-intent repair remain unimplemented. Bare JSON receipts are not proof.

Receipt authentication must bind success, transaction sender/payee, target
controller, calldata/intent, chain, emitted generation/state and payment. Verify
contract state at the same qualified branch. A proof of an unrelated receipt or
an unrelated advanced generation cannot settle this intent. Negative-only
retirement must not be used to mint a serving grant; its production stopped-state
relay path is still required.

No live wiring, new contract address, migration transaction or wallet grant is
provided by this document. Those follow provider qualification, end-to-end
boundary testing, paid settlement/fee bounds and conservation-checked migration.
