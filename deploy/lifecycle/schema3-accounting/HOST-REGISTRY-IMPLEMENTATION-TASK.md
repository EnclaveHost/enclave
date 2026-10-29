# Source-only task: atomic qualified host registry lifecycle

Do not launch this task until the coordinator releases the schema-3 adapter work
and reviews the proposal. No deploy, signing, wallet, production-host, compiler or
test run is authorized by this document. It is a proposed next implementation
scope, not another implemented feature.

## Chosen architecture

Build a NEW pinned `EnclaveHostLifecycleRegistry` whose single storage authority
owns registry rows, accepted owner/policy revision, host generations, reporter
quorums, and protected host-offline budgets. This avoids an overlay that pretends
the legacy active bit changed, and makes owner transfer/reporter invalidation
atomic. Leave deployed `EnclaveRegistry` and `EnclaveHostOwnership` untouched.

Preserve the existing `get/getPage` entry tuple for consumers, including pricing,
proof key and payout metadata, but advertise a new exact registry feature revision
and `hostLifecycleSchema() == 1`. Derive returned `active` from this contract's
canonical lifecycle state. Do not reuse schema4 or rely on `>=`. Preserve genuine
operator configuration/pricing and accepted-owner policy/transfer rights.
There is no global owner/admin ability to ban or deactivate a foreign-owned host.

Fresh profile pins must bind this registry and all dependencies recursively.
The legacy register/heartbeat selectors must either be absent or explicitly
refuse unqualified activation; neither can overwrite an offline tombstone.
Configuration writes may update metadata but cannot set lifecycle state Online.

## Storage sketch (review and size before fixing an ABI)

- Existing registry row data and existence/index/prefix identity as applicable.
- `authority[hostId]`: accepted owner, proposed next owner, monotonically increasing
  revision, owner-selected local policy hash. Preserve an explicit authority getter.
- `hostState[hostId]`: generation, Online/Offline status, changedAt, hardware and
  descriptor digests, accepted qualification digest/expiry, latest offline digest.
- `reporterPolicy[hostId]`: revision-bound sorted enrolled EOA keys and strict
  quorum threshold. Configuration updates atomically increment authority revision.
- `hostBudget[hostId]`: deposited balance, protected maximum offline liability,
  per-transition cap/gas policy, sponsor reservation identity and outstanding
  reimbursements. Money provenance is separate from host payoutWallet.
- Used enrollment/recovery intents and durable hardware/job sponsorship identity;
  per-payee pull credits and a bounded pending fee-settlement record if needed.

Store the operator/owner/reporter revision used for offline validation in this
same authority. No offline path may call a separate ownership contract to discover
whether its cached reporter keys are stale.

## Concrete proposed ABI groups

**Enrollment and recovery**

`registerQualifiedHost(Enrollment intent, ReporterPolicy reporters,
QualificationReceipt receipt, bytes operatorConsent, bytes ownerConsent,
bytes[] qualificationApprovals)`

`recoverQualifiedHost(Recovery intent, QualificationReceipt receipt,
bytes operatorConsent, bytes ownerConsent, bytes[] qualificationApprovals)`

`Enrollment` binds chain/domain, endpoint/hostId, operator, owner, hardwareId,
descriptor digest, attestation digest, qualified resource digest, qualification
policy hash/revision, reporter-policy hash, sponsor-reservation identity,
initial protected offline amount, nonce and deadline. Recovery additionally binds
the exact preceding generation/offline state and installs a strictly newer epoch.

Acceptance installs owner+revision+reporters+budget+row+Online state atomically.
Failure leaves no public active row. A sponsor or independent submitter may
send the qualified enrollment transaction using the bound operator/owner consent;
the candidate/operator wallet may have ZERO ETH and is never required to pay gas
first. The sender funds inclusion from its own recoverable budget or the exact
reserved sponsor mechanism. No general transfer to a host payout wallet is a
bootstrap prerequisite. Any host gas release/refund follows successful verification
of this exact qualification/intent and stays within the payer's signed cap.
Normal enrollment may perform authenticated
attestation/consent/funding verification; only offline recording is forbidden from
depending on external calls. Support genuine contract-wallet owner consent on
normal paths without making emergency reporting depend on ERC1271 availability.

**Atomic authority updates**

`proposeHostOwner(hostId, nextOwner)` by accepted owner;
`acceptHostOwner(hostId, ReporterPolicy nextReporters, bytes32 nextPolicyHash)`
by the proposed owner (or an exact authorized signature path).

`setHostPolicy(hostId, ReporterPolicy nextReporters, bytes32 nextPolicyHash)`
by accepted owner. Every accepted transfer/policy change increments revision and
replaces/invalidate reporter membership in the same transaction. Old signatures
must fail immediately. An empty reporter list may not silently remove the last
valid offline path while Online. Operator rotation likewise requires accepted
owner consent and a fresh bound recovery/attestation path.

**Independent offline write**

`recordHostOffline(HostOffline intent, bytes[] reporterApprovals) returns(bool)`

The intent binds exact registry/domain/chain, hostId, current generation,
operator, authority revision, target Offline, evidence digest, deadline, payee
and maximum charge. Validate exclusively from local stored state and signatures.
No registry/ownership/identity/token/oracle/recipient call and no current admission
approval. Record Offline and fence generation before reimbursement accounting.
Reimbursement accounting must be zero-balance safe: clamp charges and reserved
fee liabilities to actually available funds, use bounded checked arithmetic, and
retain the valid offline transition even when reimbursement is zero. Use
saturating/min-bounded fee calculations; if a fee component is unpriceable or its
arithmetic cannot be safely represented, its optional reimbursement is zero or
explicitly pending within an already reserved finite cap, never a reverting
post-authentication calculation. Validate configuration bounds when enrolling.
Authentication and consensus limits are distinct: an out-of-gas transaction or
failed signature is not a successfully recorded offline transition. No payee
transfer occurs here. Merely putting the state writes before a potentially
reverting payment calculation is NOT sufficient: a later EVM revert would undo
them. Invalid authority/intents still fail authentication before any state change.
Exact retries return without changing state or charging again. Wrong epoch,
old owner revision, duplicate signers, wrong domain and replay are refused.

Because this is the actual registry, this call changes the canonical row's active
result immediately; it is not just a future promise to call legacy deregister.
Any deferred payment settlement is separate from the already recorded offline
state. Recovery cannot revive the old epoch through heartbeat/register/config.
`deactivateHost(HostOffline intent) returns(bool)` is the concrete graceful
shutdown selector. Authorize `msg.sender` against the locally stored current
operator OR accepted owner, then use the same intent checks and internal canonical
`_recordOffline` transition as the reporter-quorum path. No external owner lookup
or ERC1271 call occurs here; a contract-wallet owner can call through its own
normal execution path. This preserves genuine owner/operator shutdown without
requiring a reporter quorum or leaving another unfenced active-bit writer.
Both paths share exact retry/digest handling, fencing and zero-safe reimbursement.

**Budget and sponsor ports**

`reserveBootstrap(SponsorReservation, payerAuthorization)` reserves bounded gas
budget without making the host available. `fundHostOffline(hostId)` may add funds
without changing authority. Offline withdrawal/settlement rules protect pending
liabilities and the last transition; payout declarations confer no withdrawal
right. A foreign sponsor may not reclaim protected live-host funds on demand.
Recovery must not reset outstanding pull credits or consume their reserved backing.
Fenced retirement/withdrawal requires canonical Offline, the current epoch fenced,
no outstanding transition/fee liability, and preservation/payment of already owed
reimbursements before releasing only the unencumbered balance to its entitled
payer. Never silently clear debts or grant the payout wallet arbitrary withdrawal
rights. A later qualified recovery funds its own required protected reserve.

`claimHostReimbursement(to)` is pull payment. Specify the fee policy honestly:
execution reimbursement may be measured/bounded; Base L1 fees need an explicitly
reserved cap and a separately qualified receipt/fee mechanism. Do not label an
unpriced/unreserved residual as fully funded. Oracle/recipient failures cannot
undo Offline. Do not promise protection against unbounded future fee spikes. Distinguish a
finite funded inclusion budget from unconditional chain availability: independent
submitters need recoverable gas funds without the failed host key, durable pending
intents/nonces, and canonical receipt reconciliation. Chain/RPC unavailability or
fees above the funded bound leave a durable pending report and local serving
fenced; neither condition authorizes a false claim that the on-chain transition
has landed. Reporter quorum availability is an explicit operational assumption;
loss of enough enrolled reporter keys can prevent quorum submission. Direct
accepted-owner/operator shutdown remains available to those parties when reachable.
Neither a valid signature nor a funded budget guarantees network/chain inclusion.

## Qualification authority and listing-gas release

Qualification must be independently verified under the PAYER'S explicitly
accepted independent attestation/test policy, also bound by owner consent. A
caller `passed` boolean, raw host telemetry, arbitrary signer roster supplied by
the host, or merely different EOA addresses is not independent verification.
Use authenticated policy identity/version, approved verifier groups and exact
hardware/test/attestation/resource binding. Trust mode must remain explicit;
this is not Sybil-proof consensus. No mutable platform verifier may become a
universal veto over otherwise independent foreign-owned hosts.

Candidate tests run before registration in isolation. Keep existing active-fleet
receipt validation intact; add a separate pre-listing verifier. Test success and
fresh attestation are both required BEFORE listing gas can be released. The
atomic enrollment intent must consume that exact qualification and sponsor
reservation. If a previously listed host later fails qualification, retain its
protected offline budget while reporting failure.

Choose sponsor eligibility through the agreed policy: paid-work online host
first; scoped existing Stripe fallback only on verified absence. Read failures
are not absence. Hardware/job identity, intent nonce and canonical receipts must
prevent duplicate grants across retries/restarts or provider fallback.

## Shared capacity and consumer wiring

Add `VerifiedAvailableCapacity` as the common scheduler/UI projection: verified
resource totals less committed allocations, pending assignments and headroom,
optionally reduced by separately fresh bound spare evidence. CPU, RAM, GPU and
per-device VRAM evidence stay distinct. Stale/failed qualification removes that
resource's availability. Do not substitute raw cpuShareFree/gpuShareFree values.
The qualification digest/expiry recorded at listing is historical evidence of
that acceptance, not a new periodically renewed on-chain lease. Fresh ongoing
capacity/attestation/heartbeats are verified off chain; expiry fences local
availability, and actual failure/recovery transitions update chain. Do not create
mandatory periodic chain writes merely to refresh qualification timestamps.

Actual source split to bridge: `availability/observation.mjs` only validates
receipts after active-row resolution; `site/components/fleet-list/fleet-list.js`
reads host availability shares. Existing active-fleet receipts are not a
pre-listing qualification service or an integrated verified UI projection.

All serving, storage, secrets, ingress and discovery consumers need the new exact
registry/profile/generation semantics. Maintain durable revocation floors across
restart. Host heartbeat/capacity updates stay off chain; state transitions alone
write chain. App emergencyOffline/cutoff settlement remains separate.

## Required author output and later bounded validation

Produce source, ABI/storage/authority diagram, threat/failure assumptions,
consumer integration inventory and tests. Flag size/link requirements without
running a compiler until separately coordinated. Preserve original contracts.
Tests must show atomic listing failure, owner/policy change invalidating old
quorum, no external calls on offline write, canonical active=false, replay/epoch
fencing, protected budget during later failure, sponsor dedup/fallback failures,
receipt authenticity and resource binding, recovery qualification, no legacy
reactivation, genuine operator/owner rights, and absence of global foreign-host
veto. Follow with real-contract integration and authenticated profile tests;
source scaffolding and mocks alone do not qualify production migration.
