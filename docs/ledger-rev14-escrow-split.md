# Ledger rev 14: funding splits at the cap, and a late-proof horizon

Status: **PROPOSED, not deployed.** Branch `ledger/rev14-escrow-split-5d`.
Reviewed by enclave-bf, with corrections (R1-R4) ruled in by enclave-87. Steven
decides whether to ship it. It is a new `EnclaveDeployments` address, so a
migration.

Do not merge this branch to `main` before that decision. `deploy.yml` treats a
change to `contracts/EnclaveDeployments.sol` on `main` as a contract deploy (gated
on the `contract-deploy` approval), and the branch also carries the regenerated
`site/js/gen/contract-artifacts.js`, which the site deploy would pick up.

## The decision

1. Ship rev 14 at all, or keep rev 13 and rely on the operational rule already on
   `main` in `docs/billing-runbook.md` §3a ("fund only after a paid claim").
2. If shipping: migrate now, or bundle it into the next ledger migration done for
   another reason. Today's exposure is small and entirely our own (below).
3. If migrating: accept the escrow handling in the migration section, including the
   companion change to the admin console.

## What goes wrong on rev 13

`_splitFunding` splits every USDC funding at the record's **current** snapshot:
`d.rate` for the publisher's cut, `earnOf(id).runnerRate6` for the runner escrow.
`release` and a lapse leave the last lease's snapshot in place. So after a **free**
lease (rev 12), or after one so cheap its runner share rounds to 0 (rate 1:
`floor(1 × 8000 / 10000) = 0`), a funding does three things:

- it escrows nothing, and forwards everything except the publisher's cut to payout;
- it adds nothing to `ownerEscrow6`, so none of it is ever refundable;
- it leaves the next **paid** runner serving those seconds unbacked. `_creditRunner`
  caps each credit at the escrow, which is 0.

Serving itself is unaffected: leases burn `balance6`, never the escrow.

On the live ledger (`0xF9e71385`, read 09-26):

- **`0xca141665`** (our agent wallet): three free leases, then `fund(250000)` at
  09-22 03:25:17Z. Escrow 0, so `refundableOf` is 0 with `balance6` 233800.
- **Steven's `a69dcbba`, `d9798e4c`, `a77d0c57`, `7ae476a3`:** their balances come
  from top-ups on 09-22 by the agent wallet, each made with **no live lease** and
  the runner share standing at 0 (nucbox-k11 at rate 1). Escrow is 0, 1, 0 and
  7 µUSDC.
- **Ledger-wide:** 64 records, 22 active. The active funded records are 4.40 USDC
  short of cap-level backing, and every one belongs to Steven's wallets or ours.
  The largest is `e64f7cba` (RISC Box), 3.64 USDC short. No outside customer's
  record is affected.

Separately, `refundableOf` reserves a lapsed lease's unproven tail for ever, because
`EnclaveProofOfTime` accepts a late proof at any time. `refund()`'s NatSpec claimed
a lapse freed it; the code never did.

## What rev 14 changes

`deploymentsSchema` becomes 14. The ABI is unchanged.

### 1. A funding with no live lease escrows the unfloored runner fraction of the cap

When `leaseUntil <= now` (never claimed, released, lapsed, or exactly at its end),
and the cap is above the fee:

- the publisher's cut is `fee / cap` of the funding;
- the escrow is `ceil(value × (cap - fee) × runnerBps / (cap × 10000))`.

Those seconds will be sold by whoever claims next, at a price nobody knows yet, and
any runner at or under the cap may claim. Why **unfloored** (enclave-bf R1): a
lease's runner share is floored per second, so the *floored* share of the cap can
sit below a cheaper runner's. At cap 17 (`7ae476a3`) the floored share is 13/17 =
0.765, but a runner at rate 9 (metal-iso0) earns 7/9 = 0.778 of each second. The
unfloored fraction `(x - fee) / x` only grows with x, so no runner at or under the
cap is owed more of a second than this escrows. The test
`test_unflooredCapShare_coversACheaperRunner` shows 400000 escrowed against 388885
owed, where a floored cap share would have escrowed 382353.

What else follows from rule 1:

- **Never-claimed records** are covered too (their `d.rate` already is the cap).
  They now escrow a few µUSDC more than rev 13's floored figure. The publisher's
  cut is as before.
- **The record is never re-priced:** `d.rate` and `runnerRate6` are untouched, so
  a lapsed runner's uncredited tail is still credited at that runner's own rate.
- **ETH fundings** (enclave-bf S5) use the same rule for the publisher's cut, via
  the shared `_openCap`. ETH still escrows nothing. Rev 13 cut an ETH funding at
  `d.rate`: right after a fee-only free lease that sent 100% to the publisher.
- **Unchanged cases:** a **live** lease, free ones included, still splits at its
  own rate (next section). Uncapped records (cap 0, or a cap not above the fee:
  imported ones) keep the rev-13 rule.

### 2. A lapsed lease is provable for up to 900 s after it ends, or until the next claim

`creditProven` treats a proof later than `leaseUntil + 900` as "nothing to prove".
A re-claim inside the window resets `provenUntil` and ends the grace at once, as in
rev 13 (enclave-bf R4). Under proof rules, `refundableOf` then reserves only what the
lease proved and has not yet been credited, so a refund reaches the rest. That
makes `refund()`'s NatSpec true.

- 900 s is one default proof window.
- It is a private constant, so the platform owner can never shorten it.
- bf checked that nothing sends a late proof after that anyway. The supervisor's
  only one is `proveFinalPeriod`, at lapse + 90 s, once, with no retry. The NucBox
  node sends none. So 900 s changes no seller's income today.
- The held-time meter (proofs not required) is unchanged: a lapsed tail there is the
  runner's, so it stays reserved.

### Why a live lease keeps today's split, and what that costs

A live free lease of a paid app burns the balance at the publisher fee alone. So
today's split sends 100% of a funding made during it to the publisher: exactly the
fee for each second *that lease* burns. Splitting at the cap would underpay the
publisher for as long as the owner self-hosts.

The honest limit (enclave-bf S6): leases pre-burn their quantum, so a funding
during a live lease is burned only by later renews or claims. "The rate the lease
burns at" is really a bet that the same runner renews. When it doesn't:

- A fee-bearing free lease's funding has already paid the publisher 100%, while a
  later paid claim at rate r owes the publisher only `fee / r` of those seconds.
  The publisher is **overpaid**.
- A cheap live lease's funding escrowed at that lease's share, so a pricier next
  runner is **under-backed** (residual 1 below).

Closing either means changing the live-lease rule itself, which is not local. It is
documented, not fixed.

## Evidence

- **Size:** 24,325 → 24,534 bytes at runs=100, **42 under EIP-170**. The same
  figure comes from `forge build --sizes` and from
  `scripts/build-contract-artifacts.mjs` (the deploy pipeline's own build).
  - Paid for by merging three validation strings: "incomplete round" into "stale
    price", "unfunded at the new rate" into "unfunded", and "gpuShare > max" into
    "range". Nothing off-chain matches them (bf re-checked).
  - bf's dead-guard removal (S2) saved 47 bytes.
  - Two candidate fixes did not fit and are documented instead: S1 (106 bytes) and
    the fee-free free-lease option. Per 87: no new features in this package.
- **Tests:** Foundry **300/300**, of which the `EnclaveDeployments*` suites are
  171/171, 14 of them in `EnclaveDeployments.rev14.t.sol`. Node tests that read the
  ledger source or ABI: 174/174.
  - The new rev-14 tests:
    - the `0xca141665` sequence;
    - Steven's lapsed rate-1 case (800000 escrowed, then 200000 for the top-up);
    - never-claimed records at the unfloored share;
    - R1's coverage of a cheaper runner;
    - the S3 boundary (at `leaseUntil` the record counts as unleased, as in
      `setMaxRate`; one second earlier it does not);
    - S5's ETH publisher cut;
    - a live free lease keeping 100% for the publisher;
    - the horizon at +900 and +901, with exact refunds;
    - settle invariance;
    - the held-time meter unchanged;
    - three residuals, stated as tests.
  - Updated for the unfloored rule: `refund.t.sol`'s escrow helper, and
    `runnerPayout.t.sol`'s exact-split test.
  - The regenerated `site/js/gen/contract-artifacts.js` differs from main only in
    the ledger's bytecode and `schemaRev` 14 (enclave-bf S4).
- **Mutants,** each killed:

  | Mutant | Failing tests |
  |---|---|
  | never split at the cap | 10 |
  | split at the cap with a live lease | 5 |
  | `refundableOf` keeps the tail | 3 |
  | horizon without the `proofRequired()` guard | 2 |
  | no horizon in `creditProven` | 1 |
  | the horizon off by one second | 1 |
  | a floored cap share (R1) | 10 |
  | `fundEth` at `d.rate` (S5) | 1 |
  | the boundary as `<` (S3) | 1 |

## What it would have done here

All four of Steven's 09-22 top-ups had no live lease: two had lapsed 1 and 13
minutes earlier, and two had no lease event in the 11 hours before. So rev 14 would
have escrowed each at 80%:

| Record | Funding (µUSDC) | Escrowed under rev 14 |
|---|---|---|
| `7ae476a3` | 500000 | 400000 |
| `d9798e4c` | 250000 | 200000 |
| `a77d0c57` | 250000 | 200000 |
| `a69dcbba` | 250000 | 200000 |

Those fundings came from the agent wallet, not the owner. So the escrow would back
runners, but would not be owner-refundable. `0xca141665`'s owner-funded 250000
would have escrowed 200000, refundable.

## What it does not fix

1. **A funding during a LIVE cheap lease** still splits at that lease's rate, so a
   pricier next runner is under-backed. Live example: `0x31136008` (TEST2's
   operator-owned record, on nucbox-k11 at rate 1) is 7933 µUSDC short. The
   runbook rule covers it operationally.
2. **Over-escrow is refundable after the balance is spent** (enclave-bf R2).
   - Example: cap 9, 250000 funded with no live lease. 200000 is escrowed and 50000
     goes to the platform. A rate-1 box (runner share 0) then serves all 250000
     seconds, earns nothing, and the owner can still refund the 200000.
   - The test is `test_residual_overEscrowIsRefundableAfterFullConsumption`.
   - Rev 13 had the same arithmetic for a never-claimed first funding. Rev 14
     extends it to every released or lapsed record.
   - It matters only where boxes priced at rates 1-4 serve: there the floored
     runner share is far below 80%. Everywhere else the difference is rounding
     (fee-free) or the publisher fee.
3. **The kill switch after a horizon refund** (enclave-bf S1).
   - Sequence: proofs on, the horizon passes, the owner refunds, which takes the
     unproven tail's escrow. If the platform then turns proofs off
     (`setProofRequiredFrom(0)`), the held-time meter credits that tail again,
     paid from the owner's *next* funding's escrow.
   - bf's figure: 600 s × 667 = 400200 µUSDC. The test is
     `test_residual_killSwitchAfterAHorizonRefundPaysTheTailFromTheNextFunding`.
   - Rev 13 paid it from the never-released reserve.
   - The fix (refund forfeits a released tail for good) costs 106 bytes, and the
     ledger would be 25 bytes over EIP-170. It needs the platform owner to flip the
     kill switch after such a refund.
4. **The live-lease publisher overpay** (enclave-bf S6), explained above.
5. **Records that already exist.** Rev 14 changes future fundings only.

## Migration

The ledger cannot be patched in place. Rev 14 is a new address, following the
rev-12 (08-11) and rev-13 (08-16) path. Rev 13 took one day and about $0.74 of gas
for 24 records.

1. Deploy `EnclaveDeployments` rev 14 (runs=100), and a new `EnclaveProofOfTime`
   bound to it. Its constructor names its ledger, and `setProver` is one-shot.
2. Copy the parameters: `setProver`, `setProofRequiredFrom`, `runnerBps`,
   `leaseSec`, the claim bond, and the ETH feed.
3. For the records worth carrying (22 active, 30 funded of 64), run
   `importDeployments`, `importFees`, `importEarn` **and `importCaps`**
   (enclave-bf R3c). The admin console does call `importCaps`
   (`site/components/admin-console/migrate.js`). Without it, each cap is the last
   lease's rate (1 for Steven's records), and metal-iso0 at rate 9 is refused
   "over rate cap".
   - Gas, from the calibrated model (memory: enclave-contract-migration-txsize):
     about 0.86M per record at 611 string bytes. That is about 19M for the active
     records (2 transactions) and about 55M for all 64 (5-6).
4. **SKIP the admin console's escrow step** (`escrowPlan`, migrate.js lines
   115-160: "Back the escrow BEFORE sealing"). That step is the re-seat path. It
   backs the old rate's share, not the cap's, and together with an old-ledger
   refund it pays twice (next section).
5. `sealImports`.
6. Point the address book's `deployments` key at the new ledger. Running
   components follow within a poll. Baked fallbacks (CLI `DEFAULTS`, the site
   fallback, relay env) need `sync-contract-addresses.sh`, which once silently
   skipped the site fallback.
7. `retire()` the old ledger only when the escrow question below is settled for
   every record.

### The escrow at migration (enclave-bf R3a/R3b)

Escrow is real USDC held by the OLD ledger, and it does not migrate. A carried
record starts on the new ledger with its `balance6` and escrow 0.

The old ledger keeps its escrow refundable to the owner: `refund()` is
owner-callable at any time, and `retire()` opens it to anyone, still paying the
owner. So a carried record gives its owner **two** benefits for one payment: the
old runner-share escrow back on the old ledger, AND the same `balance6` served on
the new ledger, unbacked, by a runner who earns nothing. Re-seating the escrow on
the new ledger (the console's step) would make that a double *payout*. Skipping it
leaves a double *benefit*. Neither is right for someone else's money.

How this package handles it:

- **Today every carried record is ours or Steven's.** The active funded records'
  owners are `0x0b2d…`, `0x3977E339…`, `0x29479b…` and `0x389c…`. It is our money on
  every side, so carrying balances without re-seating (rev 13's path) is
  acceptable. Owners, meaning us, may refund old escrow or not; nobody outside is
  paid twice.
- **For a third-party record present at migration time**, do exactly one of these:
  (a) leave it on the old ledger and let its owner refund there (not carried); or
  (b) carry it, and treat its old refundable escrow as already returned: carry
  `balance6` reduced by the seconds that escrow backs, or refund it on the owner's
  behalf first, which zeroes the old balance and so carries nothing. Never carry
  the full balance AND leave the old escrow refundable.
- **Required companion change if rev 14 is adopted:** the admin console's migration
  copy and `escrowPlan` ("Back the escrow BEFORE sealing …") must change. It should
  say *skip*, or apply rule (b) per record, and never re-seat at the old rate.
  Without that change the console walks an operator into the double payout.

Cost, all small: two contract deploys, a handful of import transactions, one
address-book write, all Trezor-signed (the governance key). Gas is on the order of
the rev-13 migration, a few dollars at most. Clients need no lockstep: the ABI is
unchanged, and clients gating on `>= 13` behave the same at 14.

## Steven's four records: repair without a contract change

- **Needed?** No, for serving. Each runs `balance6 / rate`: 3.65-5.93 h on
  metal-iso0. metal-iso0 earns about 0 on them, and it is Steven's money on every
  side.
- **Possible?** Yes, but only after metal-iso0 has claimed. Before that,
  `runnerRate6` is 0: `fundEscrow` reverts ("no runner rate") and `fund()` escrows
  nothing on rev 13. After the claim, a `fundEscrow` of each record's gap backs the
  runner:

  | Record | Gap (µUSDC) |
  |---|---|
  | `7ae476a3` | 277394 |
  | `d9798e4c` | 91996 |
  | `a77d0c57` | 92244 |
  | `a69dcbba` | 100644 |
  | **Total** | **≈ 0.562 USDC** |

  - From Steven (the owner) it is refundable. From the platform it is not, because
    imports are sealed.
  - `e64f7cba` works the same way.
- A rev-14 migration alone does not repair any of these. Imports carry balances
  with escrow 0.

## Risks

- **A runner that cannot land a proof within 15 minutes of its lease ending loses
  the unproven tail.** No current runner sends one later than 90 s. A longer
  horizon would lengthen post-lapse backdating: each late proof reaches back a
  window, whether or not the box served it.
- **Publisher income:** a funding with no live lease pays the publisher `fee / cap`.
  That is lower than `fee / lastRate` when the last lease was cheaper.
- **Three revert strings change text.** Nothing off-chain branches on them.
- **42 bytes of headroom.** The next change must again buy its bytes.
- **Merging this branch requests a contract deploy** (see the status line).
