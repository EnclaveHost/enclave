# Narrow implementation ports for qualified host listing and offline state

Source interface design only; none of the names below are implemented selectors.
This complements the [offline audit](HOST-OFFLINE-INTERFACE-AUDIT.md), rather than
repeating it. It defines the minimum connections the next implementation needs.

## 1. Candidate qualification must work before registry activation

Current `availability/observation.mjs:createObservationLoader` first resolves an
active registry host and skips inactive/unregistered rows before receipt validation.
Keep that rule for observations of the existing active fleet. Add a distinct
candidate verifier; do not weaken the existing active-host guard globally.

`verifyCandidateQualification(candidate, receipt, ownerEnrollment, policy, now)`
should return a verified capability, not a caller-controlled `passed:true` flag.
Bind every input to:

- Chain, intended registry/lifecycle code profile, candidate/host ID and endpoint.
- Operator, hardware/descriptor digest, proposed owner and signed enrollment
  nonce/revision; explicit operator and wallet consent before listing.
- Fresh valid attestation, measured test implementation/version, work nonce,
  resource class/device IDs, verified totals, test success and expiry.
- The configured independent verifier/quorum policy and its revision.

Unregistered candidates are eligible to run the bounded test in isolation; they
are not schedulable, routable or publicly available. A CPU/RAM test cannot produce
a GPU capability. Failed, partial, stale or differently bound evidence does not
produce a listing capability. This port is separate from audit-market receipts
for an already active host.

## 2. Sponsor reservation is not permission to list

`reserveHostBootstrap(candidateIdentity, sponsorPolicy)` durably reserves a bounded
budget with one hardware/job idempotency identity. It must not release listing gas
or publish availability. Prefer an eligible online host with paid work; select the
scoped existing Stripe fallback only after verified absence, not a failed lookup.

`prepareQualifiedListing(verifiedCapability, reservation, acceptedConsent)` produces
one exact intent: candidate/hardware/operator/owner, policy revision, attestation
and test digests, first host generation, registry/lifecycle targets, expiry, nonce,
fee ceilings and protected offline allocation. Changes require a new intent.
The sender reconciles mined/pending nonce and receipts before retrying; a failed
transaction can consume bounded gas without creating another sponsorship grant.

## 3. Listing and owner/lifecycle enrollment need one atomic acceptance path

A proposed `registerQualifiedHost(intent, operatorSignature, ownerSignature,
qualificationApprovals)` must atomically:

1. Verify the exact qualification and sponsorship binding and current validity.
2. Enroll accepted host ownership/policy and invalidate obsolete reporter authority.
3. Install the host lifecycle generation and reporter quorum.
4. Protect the independent offline budget and its scoped sender authorization.
5. Make the registry/listing state active only if all prior steps succeed.

If any step fails, the host stays unavailable and no half-enrolled active row is
published. The legacy operator-only `register` plus wallet-only `acceptOwner`
cannot simply be called by a third-party batch contract: caller identity differs.
Use a reviewed signature-aware combined acceptance path/new registry or a wrapper
whose mandatory lifecycle status all consumers enforce. Do not imply this can
mutate the old deployed registry's permission model.

Owner transfer and policy changes must atomically advance the lifecycle authority
revision and revoke the obsolete reporter set. Otherwise an external-call-free
failure reporter could use a cached former-owner quorum. A payout declaration is
never a substitute for the accepted ownership record.

## 4. A single capacity projection must feed scheduler and UI

The present fleet UI reads `host.availability.cpuShareFree/gpuShareFree` (including
fallbacks); the active-fleet receipt loader is a different path. A verified receipt
in one subsystem does not make those displayed self-reported values verified.

`projectVerifiedAvailableCapacity(qualification, allocations, pendingAssignments,
headroom, freshSpareObservation)` returns an immutable snapshot with the same host,
hardware, generation, resource class and source-evidence IDs. For each resource:

`available = max(0, verifiedTotal - committed - pending - headroom)`

A separately fresh, bound spare observation can reduce that ceiling; it must not
raise it above verified unallocated capacity. Per-device GPU/VRAM and CPU/RAM remain
separate units. Missing/stale/failed qualification returns unavailable for that
resource, not raw `/availability` fallback or an invented zero-price service.

Both admission and `fleet-list`/deploy resource displays consume this projection.
Expose evidence age and resource-specific eligibility. Off-chain capacity updates
and allocation reservations never become recurring chain heartbeats or fixed
30-minute on-chain reservations.

## 5. Host offline recording is independent of the app ledger

`recordHostOffline(intent, reporterApprovals)` consumes the already enrolled host
epoch/owner revision/operator/quorum, records an idempotent Offline/Pending
transition and fences routes before settlement/payment dependencies are consulted.
Its local permit/journal authority must survive reboot and stale snapshots.
`reconcileHostOffline(hostId, generation)` then applies the canonical registry or
mandatory overlay transition and acknowledges that exact tuple. Payment is bounded
and cannot undo the offline record. Later qualification failure preserves the
protected offline reserve for an already-listed host.

The app controller still separately revokes each affected assignment and settles
its own run cutoff. One app crash does not imply the physical host is offline;
one host failure must not be hidden because a particular app ledger is unavailable.
Recovery requires a fresh qualified generation; legacy heartbeat/register/config
writes cannot overwrite a newer offline tombstone.

## First implementation acceptance checks

Cover unlisted qualification; wrong owner/operator/hardware/profile/resource
binding; capacity failure and stale evidence; atomic enrollment/listing rollback;
transfer invalidating old quorum; sponsor fallback on verified absence versus read
failure; nonce/receipt retry without duplicate funding; protected offline reserve
surviving later failure; offline reporting during downstream outages; and shared
UI/scheduler capacity projection. Preserve off-chain heartbeats and the separate
app cutoff/accounting tests. These are required new tests, not claimed results.
