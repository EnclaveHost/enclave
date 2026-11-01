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
Concurrent snapshots through one bridge are refused, including while a timed-out callback is still running. `snapshot.close()` revokes new and retained reads immediately and returns a promise for actual callback completion. The owned derived-reader factory registers this drain before startup; direct callers must register it with their journal owner before publishing the snapshot. The journal rejects older
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

`network/lifecycle-current-denial.mjs` provides the opt-in current-head reader
for the canonical host-registry profile. Construct
`createLifecycleCurrentDenialReader({pins, verifier, headers, hostPolicy,
journalOwner, now})`, then supply it as `generation.head`. The adapter reads and
copies the certificate chain first and calls `head.read({deployment, anchor,
baseline, certificates})` with the full same-block finalized baseline. The
reader checks that binding; a `{number, hash}` argument alone is insufficient.
The baseline must originate in the caller's qualified finality capability.
JSON fields are not proof of authority.

The reader creates its own private `verified-head` adapter. That adapter reuses
the code, closure, schema and owner-policy checks but always reports
`verified: false`, `proofVerified: false`, and tier `unsafe`. It cannot authorize
preparation or submission. Only the denial reader converts its own successful
proof-executed observation into a denial check. The explicit verifier remains a
trusted local or attested proof-executing capability, never a remote RPC label.

Raw `headers.header(number, {signal, timeoutMs})` responses are authenticated
backwards from the independently verified current head to the exact finalized
anchor, including the head's state root. The complete operation defaults to
15 seconds and at most 2048 headers; stricter caller limits are supported.
The head is checked again before publication. Its original block time and the
operation's original observation time remain subject to 20-second freshness
and two-second future skew. No current state can supply a new owner, witness
policy, content commitment, funding grant or restoration. A current assignment
must match an exact prefix of the verified certificate chain. Current host
authority/status is returned as `head.currentHostAuthority`, bound to that head's
hash and number. Changes, reduced authority or Offline deny; missing or invalid
proofs, ancestry, or policy documents return unknown and refuse publication.
Schema3 retirement remains metadata and does not introduce a global veto.

The reader registers `close` with its journal owner before publication. Close
and timeout revoke reads immediately, but the operation slot and owner lock
remain held until the actual transport/callback work drains. Neither cancellation
nor a timeout is process-death proof. There is no send method or provider retry.

**Integration limit:** the reader is implemented, but direct host admission and
the final Running send guard still apply their original 20-second block-age
rule. The canonical-host operational admission, final-send and permit/witness
boundaries still need to consume and validate the current host evidence alongside
the existing owner-opted certificate window. This module does not enable that
path by itself, choose a production verifier, or admit activation.

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

The runner also preserves an explicit current `snapshot.admitted: false` from
its trusted host adapter when processing generation certificates. An older
positive anchor cannot erase this local owner restriction. It queues this
host's own running assignment after confirmed local retirement, or leaves
queued work available to other hosts. It does not stop an assignment on another
host. A pending transition retains its exact durable intent and must reconcile
before any replacement is prepared. The adapter must supply its current local
restriction again after restart; this runner check is not a durable host-policy
store. A positive outer value cannot repair missing or false authenticated host
admission.

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


Maintained opt-in host composition (2026-11-01):
`network/lifecycle-owned-dispatch.mjs` exports `ownIndependentLifecycleDispatch`.
Inputs are an authenticated adapter with exact reviewed `adapterPins`, host callbacks
bound to that host, runtime adapters, fixed routes, explicit platform wallets,
capacity headroom and a verified legacy-quiescence reader. It returns the attached
`dispatch`, runtime/gate/journal, ownership `close`/`verification`, and adapter
independence gaps. The caller separately activates routes and schedules local
reconciliation only after qualification. `close` waits for the driver's actual
in-flight effects and resource withdrawal; it does not settle an ambiguous intent.
No production host selects this API by default. A claimed snapshot `verified`
flag is an adapter contract, not authentication implemented by this factory.


## Maintained chain adapter integration (2026-11-01)

Opt-in network/deployment-chain-adapter.mjs now composes the maintained finality snapshot interface, schema3 linked bytecode and canonical host-registry profiles, wallet policy, receipt verifier and current transition intent format. Five staged Claude-authored modules and two ABI documents matched operator repaired and later shared-allocation repaired261 before integration. Existing maintained schema2 artifacts, schema3 bundle and registry artifact/source matched their exact reviewed hashes; no recompilation or contract deployment. ABI snapshots live under deploy/lifecycle/abi. Root helpers load the existing maintained artifact paths, avoiding duplicated compiler outputs.

Root integration fixes the milliseconds/seconds interface mismatch: maintained lifecycle-finality-bridge supplies millisecond callback headers, converted only for internal contract calculations. The returned block identity/timestamp must equal the one callback; absent/multiple/mismatched callbacks refuse. Pins are copied/frozen. Final Running send rejects expired original host observations (20s, existing2s future skew), changed accepted owner/policy, Offline and moved assignment. This is separate from the already completed Windows4s aggregate guard. Persisted charges cannot exceed reviewed maxChargeWei; signing cannot finish after the intent deadline and then broadcast. Assignment and emergency uint64 counters outside exact JavaScript integer range refuse.

R1 24501f1be4564523be763c1d8e388548 terminal1/Main0:122PASS/8FAIL. Test digest provider incorrectly passed ABI bigint fields to Number-only application helper. R2 8d301d480a88408c9f15a5aa31fa0285 terminal1/Main0:128PASS/2FAIL; synthetic Transitioned log omitted three ABI fields. Both failures retained. R3 12542d84cfdc49f5933d5a21847d5a4d terminal0/Main0:130PASS/native5PASS; final review found unsafe Number counter conversion. R4 71889259acfe4a4a97ae58010dc45c9d terminal0/Main0:131PASS/0fail/skip/cancel,10.91972036s/77pins unchanged/native5PASS Node22.23.3. Twelve new checks plus119 existing (115 previous regressions and4 finality-bridge cases). Tests use real reviewed runtime templates/linking, ephemeral EIP712 signatures, signed raw transactions and reconstructed transaction/receipt/header hashes. Contract state/finality sources are inert doubles, not EVM or Base execution. Proof tampering remains unknown; missing response is propagated and resolution never resubmits. Native5 covers only Linux journal ownership/death. Private loopback namespace, read-only source/deps,512MiB/noSwap/CPU1/RSS450/floor27648+pending+640 and original30s suite bounds retained.

No production host/default/authority/signer/relay/route/VM/export/payment changed. Injected authority remains a trusted local capability; method shape/JSON labels do not authenticate it. Production must supply qualified derivation/proof execution plus owned signing/nonce/outbox/fee and transport bounds. This adapter does not fund gas, implement protected Offline reporter submission, establish attested physical capacity, fence legacy per-app writers, or prove independent hosting. Actual contract integration with maintained owner/runtime and qualified activation remains unfinished. Full goal unachieved; RPC remains offline, original consumed provider operation unsettled. No new production startup/define/cut or reservation release.


## Actual local EVM integration (2026-11-01)

The maintained adapter and owned runtime now pass eight tests against the reviewed schema3 and host-registry contracts executing on isolated Anvil. They cover prebroadcast Offline/policy/proof refusal, receipt resolution after a lost reply and owned journal reopen, zero-ETH operator/owner enrollment with a test sponsor, owner stop after qualification expiry, and serving-permit withdrawal on registry Offline. The combined runtime bypasses foreign platform refusal while preserving accepted-owner authority. Production modules are unchanged; prior131 pure checks remain qualified.

Finality, capacity/attestation, legacy quiescence and actual manager/ingress/storage/secrets enforcement remain test doubles. This is not production Base authentication or real independent hosting. No live route, funds, VM or provider operation changed. The original RPC start remains unsettled and RPC is offline. See [exact results and limitations](../../ops/unified-funding-20261028/lifecycle-evm-main-preserve-r1/ROOT-RESULT.md), including the preserved initial fixture-format failure.

Current-reader qualification: final R3 `94d2f5ce93f146928bee5ceaa988814d` passed45 checks (7 new and38 regressions),22.883s,86 source pins unchanged. Earlier fixture assertion/memory-limit failure and its corrected bounded execution are preserved in [the exact result](../../ops/unified-funding-20261028/lifecycle-current-denial-preserve-r1/ROOT-RESULT.md). No production activation or freshness/resource-limit relaxation.
