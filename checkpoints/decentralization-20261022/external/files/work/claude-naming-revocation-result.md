# Naming follow-up: an agreed lease end revokes at once; an outage keeps only its bounded grace

Responds to `naming-review-next.txt`, written 2026-10-19. Repo:
`/home/steven/Documents/Codex/2026-10-18/wo/work/enclave`.

- Nothing is committed.
- No production, VM, SSH, Wine, GUI or chain writes.
- The mutation check ran in an isolated copy (`/tmp/revmut`, since removed).

## The bug, confirmed in source

- `Reader.readAt` judged the lease per peer, before the quorum formed: it rejected `active=false`, a zero runner and
  an ended lease. Agreed facts saying "cancelled", "released" or "ended" therefore produced per-peer errors, no
  agreement, and an "unavailable" result. `Authorization.Refresh` then treated a consistent revocation as an RPC
  outage, and the direct front kept serving owner-name certificates for up to `NameGrace` (10 minutes).
- Worse for releases: the ledger's `release()` (`contracts/EnclaveDeployments.sol:1164-1167`) zeroes `runner`,
  `runnerOperator` and `leaseUntil`. `decodeRow` refused the zero operator as malformed ABI, so a released lease
  could only ever look like an outage.

## Fix

### `isolation/m2/bootstrap/chain.go` (narrow fact-read refactor)

- `readAt` returns raw same-block facts only: block, hash, timestamp freshness, schema, and the decoded row with its
  identity check. It no longer judges the lease.
- `read()` is unchanged: at least two fresh peers must report identical `number/timestamp/hash/raw row` for the same
  block, with the existing rollback high-water mark.
- `decodeRow` accepts a fully zero operator word (`operator == ""`), which is the ledger's own released state. A
  nonzero high byte is still malformed.
- New `leaseCurrent(snapshot)` judges the AGREED row: active, nonzero runner and operator, `leaseUntil` after both
  the block time and now. New sentinel `errLeaseNotCurrent`.
- There is no new contract-number assumption; only fields the reader already decoded are used.

### Consumers

- **`Authorize` (startup):** an agreed but not-current lease is still returned as the retryable "pending" error, so
  `AuthorizeWhenConfirmed` keeps waiting for a just-claimed lease within its bounded window. It fails closed and
  never starts on it, exactly as before.
- **`Revalidate`:** an agreed not-current lease invalidates the authorization, as before.
- **`Refresh`** (running names):
  - An unavailable quorum still returns the transient error and the grant stands to its bound.
  - An agreed not-current lease now returns `ErrRevoked` (wrapped with the reason) and invalidates the
    authorization permanently.
  - Owner, runner, operator, appRef and envelope changes still revoke, unchanged.
- **The front** (`front/names.go`) already treats `errors.Is(err, bootstrap.ErrRevoked)` as revoke-for-good. No
  front source change was needed.
- **Ongoing ACME:** `acmeIssuer.issue` already re-checks the grant and the current child certificate state after
  `CreateOrderCert` and before install. That path is now covered by a test.

### Docs

`docs/network/independent-names.md` "Lifecycle and state" now states:

- the quorum-agreement-then-judgment order;
- immediate revocation on an agreed cancellation, release or end;
- single-liar resistance;
- outage-only bounded grace;
- unchanged fail-closed startup.

It also removes the old "within that grace period" statement.

## Tests (new)

`isolation/m2/bootstrap/revocation_test.go`:

| Test | What it proves |
| --- | --- |
| `TestDecodeAcceptsAReleasedRowAsAFact` | A released row decodes; `leaseCurrent` refuses it; a malformed operator word still fails. |
| `TestAgreedLeaseEndRevokesNamesImmediately` | For inactive, expired and released, with the third peer agreeing, lying "active" or unusable: `Refresh` returns `ErrRevoked` (not an outage), `NameGrant` stops, and a later live read cannot restore it. |
| `TestOneLiarCannotRevokeAnHonestPair` | One peer reporting inactive, expired, released, an owner change or a runner change: the honest pair's live lease stands. With only the liar and one honest peer answering, the result is an outage, never a revocation. |
| `TestUnavailableQuorumKeepsOnlyTheBoundedGrace` | No agreement is an outage. The grant is bounded at the last agreed snapshot plus `NameGrace` and is not renewed while stale. |
| `TestStartupStillWaitsForAJustClaimedLease` | For inactive, expired and released: retryable, fail-closed startup. |
| `TestRevalidateRefusesAnAgreedReleasedLease` | Revalidation refuses a released lease and invalidates the config. |

`isolation/m2/front/revocation_test.go`:

- **`TestDirectAgreedCancellationEndsServedNamesAtOnce`** (inactive and released), on the real direct startup over a
  three-RPC fake quorum:
  1. With a CA certificate installed and served, one lying RPC changes nothing.
  2. A split quorum is an outage, and the names stay.
  3. Two honest RPCs agreeing on the cancellation end it at once: the CA certificate is no longer served, the CSR
     is refused, and status says revoked with no `authorizedUntil`.
  4. A later live read does not restore the names.
- **`TestInFlightACMEOrderDoesNotInstallAfterRevocation`:** the quorum revocation lands while the CA signs the
  order. The CA signs, the guest installs nothing, the issuer reports "revoked", and nothing is served.

Fixture changes in `front/names_test.go`, test-only:

- `chainRows` can give one RPC its own answer.
- The quorum has three RPCs.
- New `inactive` and `released` rows.
- A CA `onFinalize` hook.

All earlier tests are unchanged and pass.

**Mutation check (isolated copy).** With the pre-fix `chain.go` and the consumers' new checks removed:

- These fail, as they should: `TestDecodeAcceptsAReleasedRowAsAFact`, `TestAgreedLeaseEndRevokesNamesImmediately`,
  `TestStartupStillWaitsForAJustClaimedLease` (error identity) and `TestDirectAgreedCancellationEndsServedNamesAtOnce`.
- The single-liar and outage-grace tests pass on both versions, because they guard properties that already held.

Commands (targeted, `-p 1`, Go only, no broad Node sweep):

```sh
cd isolation/m2
GOPROXY=off go vet ./bootstrap ./front                                  # ok
GOPROXY=off go test -count=1 -p 1 ./bootstrap/ ./front/ ./egress/ ./release/   # all ok
GOPROXY=off go test -race -count=3 ./bootstrap/                         # ok
GOPROXY=off go test -race -count=1 ./front/ -run 'AgreedCancellation|InFlightACME|OwnerNames|DirectOwner|ChangedOwner'  # ok
go build -o /dev/null -tags bootstrapdirect ./front && go build -o /dev/null ./front   # both build
(cd ../m4/guestd && go vet ./... && go test -run Bootstrap .); (cd ../m3 && go vet ./...)  # ok (guestd only uses WritePackage)
```

## Preserved

- **Startup:** fail-closed, with bounded confirmed-wait retry.
- **Existing behaviour and tests:** `Revalidate` semantics; all existing bootstrap, wait and front tests; the S2 ACME
  checks.
- **Untouched code:** the network routing changes (`network/*`, JS); the oracle report-path audit; the `-race`
  cleanliness of the new tests.

## Residuals

- **Quorum threshold:** two agreeing fresh RPCs. Two colluding RPCs can revoke, which only fails closed, or keep a
  lease alive. That is the existing threshold, not a new one.
- **Host-side direct routing** (JS `network/owner-names.mjs`) retires a route on a lease scope change via the host's
  own `LeaseReader`/`AdmissionGate`. That reader already removes an inactive or changed-runner lease on a definite
  answer, and it was not changed here.
- **Still to do:** a measured release and hardware validation of the new front, and live CA and DNS evidence, as in
  the earlier reports.

## Files

- **Modified:**
  - `isolation/m2/bootstrap/chain.go`
  - `isolation/m2/bootstrap/manifest.go` (two liveness checks)
  - `isolation/m2/bootstrap/names.go` (`Refresh` and comments)
  - `isolation/m2/front/names_test.go` (fixture only)
  - `docs/network/independent-names.md` (lifecycle)
- **New:**
  - `isolation/m2/bootstrap/revocation_test.go`
  - `isolation/m2/front/revocation_test.go`
