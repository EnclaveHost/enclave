# Paid capacity verification

Implementation branch: `codex/paid-capacity-audits-20260930`. Workload app:
`EnclaveHost/enclave-apps`, branch `codex/capacity-work-20260930`, directory
`capacity-work`. Capacity Work 1.0.0 is published and approved on Base; revision-15 ledger, proof and fee contracts are deployed and bound in staging; migration and verification spending are not activated. The relay supports contract-wallet secret staging.

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
- `evidence.mjs` checks domain-bound EIP-712 capacity receipts. Independent mode
  requires two configured independent groups, excluding the host's group. The
  explicitly authorized bootstrap mode permits one Enclave-operated group, but
  requires the signed payload and scheduler offers to say `operator-bootstrap`.
  Such receipts cannot satisfy independent mode. `observation.mjs` binds receipts
  to the registry identity and payout wallet. Membership is explicit payer policy.
- `scheduler.mjs` spreads concurrent jobs across hardware identities, with
  cooldowns and budget reservations. `coordinator.mjs` persists pricing epochs and
  reservations and resumes unfinished jobs. It processes independent hosts
  concurrently; native reference computations are serialized to bound verifier RAM.
- `fee-chain-adapter.mjs` creates ordinary catalog deployments owned by a
  segregated fee wallet, stages a per-job secret using ERC-1271, obtains the
  host's explicit price acceptance, and funds within on-chain policy limits.
  It checks the actual lease identity and rate. Wrong-host results are rejected
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

`EnclaveDeployments` revision 15 adds negotiated job rates, explicit refund
attribution, and a one-time binding to `EnclaveVerificationFees`. The bound router
must identify this ledger. Ordinary caps, publisher fees, runner escrow and free
self-hosting retain their behavior.

The router directs 5% of an opted-in source's existing platform fee to its
`VerificationFeeWallet`; at the current 80/20 split this is 1% of the gross host
charge. It adds no payer charge and reduces neither publisher nor runner proceeds.
Each source/payer pair has a separate immutable wallet. There is no pooled reserve,
admin withdrawal or arbitrary-call facility. Unallocated fees follow the ordinary
platform payout. Revoked/expired unused fees return only to that same platform
payout, since they came from its share.

The payer configures executor, pinned workload/backend, expiry, maximum CPU share,
rate, per-job limit, payer-wide daily limit and proven-revenue fraction (at most
10%). Newly proof-credited paid source service unlocks a spending allowance; jobs
are additionally bounded by actual segregated fee funds. Verification jobs cannot
recursively earn budget. Policy edits clear allowance, preserve the daily spend
counter and invalidate old offers. The executor cannot fund arbitrary deployments.

Ordinary ledger funding escrows the runner share and attributes refundable amounts
to the fee wallet. Each approval is exact and cleared after use. Unused job escrow
returns to that wallet, not the executor. Anyone may finish cleanup after the job's
funding deadline plus its complete duration, policy expiry or revocation. Before
then only the payer/executor may stop it. Completing a job does not drain an
otherwise active source policy's wallet.

ERC-1271 support authorizes only readable `enclave-secrets:put:` messages signed by
the policy's current executor. It cannot authorize token typed-data transfers.
The relay reads the deployment owner from the ledger, validates that contract's
signature and preserves payload binding, expiry, replay checks and isolated secret
release. This does not grant access to ordinary customer deployments.

`EnclaveAvailability` and `chain-adapter.mjs` remain an earlier, separately funded
prototype. They are not the production funding route and must not be activated for
this rollout. Native transaction gas still comes from submitters: fee-funded USDC
verification payments do not themselves implement host gas sponsorship.

## Host proof routing

`windows/node/verification-checkpoints.mjs` routes opted-in source proofs through
its ledger-bound fee contract. Both the Linux supervisor and Windows node use it.
The proof's signed domain and fields do not change. Ordinary deployments retain
normal proof batching. Missing policies, older ledgers and unavailable fee reads
fall back to ordinary proof submission, which preserves runner earnings but earns
no new verification allowance. Broadcast failures are not automatically retried
inside the planner. Individual failures do not mark rejected service as proven.
This host integration is tested in source and not deployed yet.

The deployed staged contracts on Base are:

- Ledger: `0xb36dce7689834d59364ca37ade1896d0e6404830`
- Proof of time: `0x89feafcb69e328af61561f0f73f8f3b84405f19a`
- Verification fees: `0x6773fb58e0de3806ec6aa84c3596009145ff52b8`

These are not the live address-book entries. Host rate acceptance, bootstrap
capacity qualification, scheduler configuration and a real hosted canary remain
necessary. The old ledger holds real escrow; importing deployment records alone
cannot migrate that money or preserve leases.

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

1. A revision-15 migration preserving deployments, escrow and ownership, with
   a coordinated lease cutover and a new proof-of-time contract bound to that
   ledger. The current migration engine clears leases and cannot transfer USDC: a
   dry-run import alone is insufficient. Reconcile backing and owner refund rights
   before sealing or changing the address book. A staged deployment is unused.
2. A published, pinned `capacity-work` app version, reviewed resource sizes and
   performance thresholds, authenticated secret staging, and real app-attestation
   expectations. The initial profile supports CPU/RAM work only.
3. Explicitly labeled bootstrap or independent witness identities/groups, capacity qualification evidence,
   receipt expiry and resource normalization policy. A tiny readiness VM being
   responsive is not evidence for a machine's full advertised capacity.
4. Explicit payer source, funding percentage, daily/per-job limits, expiry,
   price anchors and wallet signing policy. No production funding values were
   inferred from the test fixtures. Free self-hosting produces no paid demand or
   fee funding; an empty budget must pause verification rather than invent revenue.
5. Host-side offer acceptance and checkpoint submission through the companion.
   Choose observation freshness/window limits consistent with chain finality;
   never substitute unfinalized state just to keep quoting during an outage.
6. A hardware staging run covering valid and rejected evidence, then a bounded
   production canary. Local WASM and Anvil tests do not prove hardware isolation.

## Validation

- 79 JavaScript tests cover pricing, accounting, real event ABI replay, signature
  domains/quorums, durable recovery, concurrent scheduling, binding failures,
  workload/lease bounds and existing/contract-wallet secret authorization.
- 22 proof-domain/routing tests cover unchanged signatures, opt-in routing,
  old-ledger behavior, failed reads and mismatched bindings.
- 42 admin-console tests cover encoding, migration and generated artifacts.
- 193 relevant Solidity tests cover the ledger and companion (including 512-run
  funding fuzz coverage), ordinary pricing, self-hosting, publisher fees, fixed
  lease rates, revocation, daily limits, authorization bypass attempts, refunds
  and token-failure rollback.
- A local Anvil integration uses real contracts and signatures to prove source
  credit → existing platform-fee allocation → accepted negotiated price → exact
  job funding → lease release/refund, with no additional payer charge.
  Hardware attestation is mocked only in that test and explicitly labeled.
- The real WASI HTTP component matches its native reference at 0, 1 and 8 MiB,
  and refuses missing authentication and out-of-bounds requests. Three Rust tests
  cover input bounds and challenge sensitivity.
- solc 0.8.35/viaIR/runs=1 produces a 24,267-byte ledger runtime, below EIP-170.

Commands:

```
node --test test/availability-*.test.mjs test/verification-checkpoints.test.mjs test/proof-of-time.test.mjs
forge test --match-contract 'VerificationFeesTest|JobRatesTest|EnclaveAvailabilityTest|EnclaveDeployments.*'
node scripts/availability/test-fee-chain.mjs
node scripts/availability/test-workload.mjs /absolute/path/to/enclave-apps/capacity-work
```

## Published workload

Capacity Work 1.0.0 is approved with zero publisher fee and catalog requirements
256 MiB RAM, CPU only. No hardware capacity result is implied by publication.

- App: `catalog://0x962622b0284b438f58ad480b824d4fbf7fa9ce3dc84e2af97b65bd15392a5e6f/0`
- CID: `bafkreihcpsmtq246majw4ncfam7j3fauj57vfsfbb3cn5ace5k2lmas72i`
- WASM SHA-256: `e27c99386b9e60136e3445033e9d94144f7f52c8a10ec4de8044eab4b6025fd2`

The published bytes were retrieved through the production IPFS gateway and
compared with the tested build. Bootstrap capacity receipts and a production
verification canary remain rollout work; no capacity has been certified by this
publication alone.
