# Paid capacity verification

Implementation branch: `codex/paid-capacity-audits-20260930`. Workload app:
`EnclaveHost/enclave-apps`, branch `codex/capacity-work-20260930`, directory
`capacity-work`. These changes are not deployed and no verification spending is enabled.

## Price follows paid demand and qualified supply

`availability/pricing.mjs` prices a fixed-duration offer within one comparable
resource/isolation class. Demand and supply are normalized resource-seconds over
the same finalized observation window. Supply includes occupied qualified
capacity; only spare capacity can receive verification work.

The initial curve is `anchorRate × (paidDemand / qualifiedSupply)²`, bounded by
configured multiplier limits, a payer maximum rate, per-job spending and available
budget. At demand/supply 0.5, 1 and 2, the unconstrained multipliers are 0.25, 1 and
4. These are curve examples, not production dollar prices. A class-specific anchor
is still needed: a dimensionless ratio cannot set a dollar price by itself.

Stale observations, insufficient funds, unavailable capacity and offers below a
host's acceptance floor produce no job. Ordered observation epochs and elapsed-time
price-change limits prevent repeated polls from ratcheting the rate. Quotes expire.
Hosts explicitly accept negotiated rates; customer tariffs and already-claimed
lease prices remain intact. Compatible queued customer jobs take priority over new
verification work, even if the scarcity quote would be high.

## Accounting and execution

- `chain-observation.mjs` replays finalized ledger events with archive snapshots.
  Demand comes from USDC runner credits paired with proof-of-time checkpoints.
  Verification-funded jobs and known verification app versions are excluded.
  Missing archive state or a proof-policy change invalidates the observation.
- `accounting.mjs` matches that work to qualified hardware identities. It rejects
  conflicting aliases, duplicate service events and overlapping service intervals;
  excludes direct operator/payout self-hosting; and bounds funded queued demand
  and each owner's influence. Supply certificates must cover the observation
  window. Recent spare-capacity observations are required separately.
- `evidence.mjs` checks domain-bound EIP-712 capacity receipts. At least two
  configured independent witness groups must sign; the host's own configured
  group cannot count. `observation.mjs` binds their receipt to the current registry
  identity and payout wallet. Witness membership is explicit payer policy.
- `scheduler.mjs` spreads concurrent jobs across hardware identities, with
  cooldowns and budget reservations. `coordinator.mjs` persists pricing epochs and
  reservations and resumes unfinished jobs. It processes independent hosts
  concurrently; native reference computations are serialized to bound verifier RAM.
- `chain-adapter.mjs` creates ordinary catalog deployments, stages a per-job secret,
  obtains the host's rate offer, requests exact payer authorization and funds the
  job. It checks the actual lease identity and rate. Wrong-host results are rejected
  and the deployment is stopped. Existing permissionless claims do not guarantee
  that only the intended host can briefly claim a job.
- `workload.mjs` sends a fresh CPU/RAM challenge and compares the full result with
  a native reference. `verified-http.mjs` verifies the live Shield/SNP app evidence
  against independently loaded ledger, catalog, runtime and host expectations,
  and pins the workload request to that same TLS key. WebPKI alone is insufficient.
- The durable state directory holds private job tokens and authorizations with
  restrictive permissions. Transactions are journaled before submission. An
  uncertain broadcast with no transaction hash requires explicit reconciliation;
  the driver never guesses and submits a second payment. Interrupted tests fail
  rather than being rerun to select a better result. Completion waits for lease
  release/expiry and any currently refundable escrow to be returned.

The app is deliberately recognizable verification work. It uses normal WASI HTTP,
isolation, shares, scheduling and proof-of-time payments. Passing establishes the
work actually exercised, not every advertised CPU/RAM/GPU resource, exclusive
hardware possession or resistance to outsourced computation. The CPU/RAM algorithm
has possible time/memory tradeoffs and makes no GPU capacity claim. Witness trust
and per-owner demand limits are not Sybil-proof consensus or a complete defense
against wash trading or coordinated supply withholding.

## Contracts and payer authority

`EnclaveDeployments` revision 14 adds `offerJobRate` and `fundFor` without changing
the deployment tuple. The operator's offer snapshots owner and shares, expires,
and cannot reprice an existing lease. Ordinary owner caps, publisher fees and free
self-hosting still apply. `fundFor` debits its caller and explicitly attributes
refundable owner escrow; it cannot debit the named beneficiary.

`EnclaveAvailability` is an opt-in companion with no admin, pooled reserve or
retained job funds. A source deployment's payer sets executor, percentage (at most 10%), expiry,
per-job limit and a payer-wide daily limit. Only newly proof-credited service
submitted through its checkpoint wrapper unlocks budget. Verification-funded jobs
cannot recursively earn funding allowance through the same companion. Editing a
policy clears accrued allowance without resetting the payer's daily spend.

Each job needs an exact USDC authorization addressed to the companion, with a nonce
bound to chain, contract, source, policy epoch, deployment and reviewed job fields.
Only that companion can redeem it. Within one atomic transaction it enforces the
limits, receives USDC, grants the ledger an exact allowance and forwards the funds
with the original payer's refund attribution. No balance or residual allowance
remains after successful funding. A failed transfer rolls back budget accounting.

**Funding limitation:** this implementation is an explicit additional allocation
from the payer, bounded by a fraction of proven service revenue. It does not yet
carve money out of the existing platform fee or reduce an existing host/publisher
payment. Do not describe it as the requested automatic fee split. That integration
remains separate work. Native gas must still be supplied by transaction submitters;
this does not remove the host's gas requirement. EOA hardware-wallet users must
sign each authorization unless they separately configure a supported wallet policy.

## Deployment dependencies

The reusable coordinator entry point is:

```
node scripts/availability/run.mjs /absolute/private/config.mjs --once
```

The configuration exports `stateDirectory`, `intervalSec` (1–60), and
`configure(store)`. The latter returns `chain`, `workload`, `loadObservation`,
`policy`, and `scheduling` for `runRound`. Compose the real adapters above; do not
substitute a host-reported utilization value or an `attestationVerified` Boolean
for a verifier. A live configuration requires:

1. An approved ledger revision-14 migration preserving existing deployments,
   escrow, leases and ownership, plus its bound availability companion. Generated
   browser-admin artifacts contain the new contracts; nothing was deployed.
2. A published, pinned `capacity-work` app version, reviewed resource sizes and
   performance thresholds, authenticated secret staging, and real app-attestation
   expectations. The initial profile supports CPU/RAM work only.
3. Independent witness identities/groups, capacity qualification evidence,
   receipt expiry and resource normalization policy. A tiny readiness VM being
   responsive is not evidence for a machine's full advertised capacity.
4. Explicit payer source, funding percentage, daily/per-job limits, expiry,
   price anchors and wallet signing policy. No production funding values were
   inferred from the test fixtures. Fix the fee-allocation limitation above before
   claiming the original fee-funded availability design is complete.
5. Host-side offer acceptance and checkpoint submission through the companion.
   Choose observation freshness/window limits consistent with chain finality;
   never substitute unfinalized state just to keep quoting during an outage.
6. A hardware staging run covering valid and rejected evidence, then a bounded
   production canary. Local WASM and Anvil tests do not prove hardware isolation.

## Validation

- 32 JavaScript tests cover pricing, accounting, real event ABI replay, signature
  domains/quorums, durable recovery, concurrent scheduling, binding failures and
  workload/lease bounds.
- 180 relevant Solidity tests cover the ledger and companion (including 512-run
  funding fuzz coverage), ordinary pricing, self-hosting, publisher fees, fixed
  lease rates, revocation, daily limits, authorization bypass attempts, refunds
  and token-failure rollback.
- A local Anvil integration uses real contracts and signatures to prove source
  credit → accepted negotiated price → exact job funding → lease release/refund.
  Hardware attestation is mocked only in that test and explicitly labeled.
- The real WASI HTTP component matches its native reference at 0, 1 and 8 MiB,
  and refuses missing authentication and out-of-bounds requests. Three Rust tests
  cover input bounds and challenge sensitivity.
- solc 0.8.35/viaIR/runs=1 produces a 24,483-byte ledger runtime, below EIP-170.

Commands:

```
node --test test/availability-*.test.mjs
forge test --match-contract 'JobRatesTest|EnclaveAvailabilityTest|EnclaveDeployments.*'
node scripts/availability/test-chain.mjs
node scripts/availability/test-workload.mjs /absolute/path/to/enclave-apps/capacity-work
```
