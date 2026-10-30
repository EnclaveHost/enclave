# Proposed r3 carry-floor contract — source only, pending role alignment

The r2 stage remains frozen and has 15 unit passes. This proposal is not a
deployment or a qualification claim. It extends the same declared v1 API before
the composed runtime is released.

## Required role / IPC interface

`enrollDerivedState(config, {anchorJournal, verifyEnrollment, commit,
enrollmentFloor:null, commitTimeoutMs:10000, signal})`.

`enrollmentFloor` is only a proposal from the role descriptor's `highWater` for
recover. It is not accepted as authenticated configuration. KVM hashes the
computed target floor and passes `{binding,floorDigest,signal}` to the trusted
provider. The provider authenticates the complete signed package and returns:

```
format: enclave-derived-enrollment-result/v1
digest, mode, binding, floorDigest, highWater, priorFiles
previousBinding, previousEnrollmentDigest, stateDigest
```

`previousBinding` comes from the verified previous enrollment package, not from
host JSON. `previousEnrollmentDigest` is the current signed package's
`previousDigest`. `stateDigest` is that signed package's original committed
manifest digest, before any rebind writes. `priorFiles` remains the FRESH current
committed-majority manifest, including any pending writes now reconciled.
Its two possible keys are `reader/derived-state.json` and
`bridge/anchor-journal.json`. It may differ from the original signed manifest
after a partial rebind; the pending record carries the original manifest.

## Floor rules

Read both the reader's rollback floor and the bridge's Base authority anchor.
Neither is proof of a chain; both are restrictions on the next live derivation.
For every pair, compare Base and L1 block numbers independently. Equality on a
chain requires equality of its hash, state root and timestamp; Base also checks
output root and message-passer storage root. A candidate dominates another only
when both chain numbers are at least as high. Incomparable or contradictory
anchors refuse; never build a synthetic anchor out of parts of two records.

For **rotate**, target exactly the dominating existing floor; null is allowed
only when both journals still have null floors. The signed floor digest must
match. The old complete journals must belong to `previousBinding` and
`previousEnrollmentDigest`. A pending old genesis is completed under its original
signed enrollment before rotation; rotation cannot erase it.

For **recover**, the verified admin-retained `highWater` must dominate every
surviving journal floor, and the target is exactly that high-water. An archive
alone cannot provide high-water. KVM verifies the echoed signed floor digest,
the exact proposed high-water and all surviving floors. Missing/partial archive
state requires explicit signed recover authorization; it cannot be treated as
genesis or rotation. Non-null high-water is mandatory in this KVM revision.

## Crash-consistent rebind

KVM owns both local journal locks. Current local bytes must match `priorFiles`
exactly; any unknown local outcome first needs the role's committed-scan reseed.
On first rebind, hash the current manifest and compare it with signed
`stateDigest`. Preserve its two-file hashes in the new reader's enrollment
metadata together with prior binding/digest, mode and signed target-floor digest.

Then commit, in order:

1. A deterministic pending reader record with the target floor and the metadata.
2. A deterministic bridge record with that same floor.
3. The final committed reader record.

The new reader starts an empty entry chain **at the carried floor**, linked to
the signed prior manifest hashes. It does not clear the floor or claim a new
derivation. The local in-flight marker remains until every ACK is confirmed.

For a restarted pending rebind, validate the metadata's original manifest
against signed `stateDigest`, prior binding/digest, current enrollment and target
floor. Accept only the deterministic prefix: pending reader with exact original
bridge bytes; pending reader with exact target bridge; final reader with exact
target bridge. Complete only missing commits. Advanced or divergent new records
refuse enrollment and are handled by normal startup; never replay an older plan
over newer progress. Exact old bridge hashes remain necessary even when a
parsed floor looks equivalent. Unknown outcomes may later be present; a failed
ACK never proves absence.

## Adapter and startup changes

Call enrollment for any pending phase, a changed reader binding or changed
enrollment digest, as well as missing files. Call normal startup for a complete
matching enrollment, including advanced floors. The adapter checks the exact
API declaration and exported function set.

Select the disposable cache path by the verified binding, for example
`stateDir/coverage/<binding>`. An old-binding cache must not deadlock rotation,
and KVM must not silently delete existing cache contents. Keep a shared runs
directory and acquire its exclusive lock before reaping any owned child.

The role still owns cross-child serialization, signed-package TOCTOU protection,
current primary/epoch checks, majority scan validation, same-enrollment resume,
bounded commit requests, fail-closed writer selection and distinct-host caveats.
The fixed writer freshness policy is unchanged. Actual role + KVM + IPC tests
remain required before release.
