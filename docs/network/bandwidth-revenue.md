# Bandwidth revenue shares (schema 16, not deployed)

A host offers a **gross USDC price per GiB**. Direct bandwidth debits the app's
existing deployment balance. `EnclaveConnectivity` snapshots the ledger's
`runnerBps` when the owner authorizes direct service. At the default 8000 bps,
$1.00 of bandwidth credits $0.80 to the serving host's normal withdrawable
earnings and routes $0.20 through the existing platform fee router. An active
verification-fee policy receives its existing 5% of that platform remainder:
$0.01 for verification and $0.19 for the platform. Without that policy, the
existing router sends the full remainder to the platform.

Bandwidth does not duplicate the publisher's compute-time royalty. The share
snapshot remains fixed for the authorization; changing runnerBps affects the
next authorization. The owner still controls maximum gross price, expiry and
total spending. The host cannot opt the owner into a higher allowance.

Self-hosted direct service costs zero when the current on-chain payout wallet
is the deployment owner. Neither the host nor platform receives a bandwidth
charge in that case. Provider qualification remains mandatory.

## Accounting

Both traffic directions count. A GiB is 2^30 bytes. Compute the cumulative
charge as ceil(sum(bytes * accepted gross price per GiB) / 2^30). Compute the
provider's cumulative entitlement as floor(cumulative charge * snapshotted
runnerBps / 10000); pay only the delta from the preceding receipt. The platform
receives the exact remainder. Splitting a byte stream into small receipts
cannot create fees or change the eventual revenue split.

Receipts bind the deployment, active host and lease, owner authorization nonce,
recent block anchor, price and monotonically increasing byte count. The
registry's attested meter key must sign them. Expired/revoked authorization,
invalid qualification, replay, exhausted budget and transfer failure revert the
entire settlement, including counters.

The legacy ledger distributes some funding fees before usage. Its nominal
USDC runtime balance therefore exceeds retained cash. `bandwidthBackingRequired6`
reports the additional cash required to back all unused credit and outstanding
compute earnings. Platform-funded rebacking, not another customer charge, must
precede spending those credits on bandwidth. Top-ups can create a new backing
shortfall. Settlement fails closed until it is filled.

## Implementation and validation

`EnclaveDeployments` binds one receipt verifier and enforces balance/escrow
clamps. Its immutable linked payment library preserves compute credit, funding
and refund semantics while keeping ledger runtime below EIP-170. Both the CLI
and browser deploy paths link compiler-declared slots before broadcasting.
The build exports the connectivity ABI, but deliberately does not offer its
unsupported array-valued constructor through the generic browser form.

The transport branch reads direct authorization and the provider share from
two agreeing chain peers at the same recent block as the compute lease. A local
policy file cannot resurrect a revoked authorization or substitute a foreign
connectivity contract. Direct and TUNA capability flags share qualification.

Validation: 322 Foundry contract tests, including 15 connectivity tests and
fuzzed share conservation; 2 JavaScript linker tests; deploy artifact build
with runtime size enforcement. The transport branch has 60 targeted passing
tests including TLS passthrough, SOCKS, quorum policy reads and metering.

## Remaining rollout work

This is local feature work, not a production release. No ledger migration,
customer debit or platform rebacking transaction has been submitted.

- Implement and attest the real meter receipt producer and bounded asynchronous
  settlement/reservation path. The network prototype currently requires an
  explicit settlement adapter for nonzero prices; it cannot enable paid service
  without one. Waiting for a blockchain transaction per network chunk is not an
  acceptable production implementation.
- Connect independent qualification probes and their signed reports to the
  on-chain qualification entry. Tests do not establish real host qualification.
- Finish host capability controls and owner route/budget authorization controls.
- Review and execute schema-16 migration, immutable library/companion bindings,
  platform rebacking, and address-book publication; preserve existing proof and
  verification-fee bindings and live leases.
- Integrate the same commercial split with TUNA settlement. Existing upstream
  TUNA services pay native NKN directly to their beneficiary; this USDC contract
  does not alter that protocol or perform currency conversion. Do not present
  native TUNA receipts as if these USDC shares had already been applied.
