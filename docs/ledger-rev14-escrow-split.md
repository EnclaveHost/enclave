# Ledger rev 14: funding splits at the cap, and a late-proof horizon

Status: **PROPOSED, not deployed.** Branch `ledger/rev14-escrow-split-5d`.
Steven decides whether to ship it. It is a new `EnclaveDeployments` address, so a
migration. Do not merge the branch to `main` before that decision:
`deploy.yml` treats any change to `contracts/EnclaveDeployments.sol` on `main` as a
contract deploy (gated on the `contract-deploy` approval).

## The decision

1. Ship rev 14 at all, or keep rev 13 and rely on the operational rule already in
   `docs/billing-runbook.md` §3a ("fund only after a paid claim").
2. If shipping: migrate now, or bundle it into the next ledger migration done for
   another reason. Today's exposure is small and entirely our own (below).
3. Two options this branch does NOT take, each one line: splitting a fee-free
   free lease's fundings at the cap (+15 bytes), and escrowing at the cap during
   live leases too (not measured; it has a real downside).

## What goes wrong on rev 13

`_splitFunding` splits every USDC funding at the record's **current** snapshot:
`d.rate` for the publisher's cut, `earnOf(id).runnerRate6` for the runner escrow.
`release` and a lapse leave the last lease's snapshot in place. So after a
**free** lease (rev 12, `payoutWallet == owner`), or after one so cheap its runner
share rounds to 0 (`floor((rate - fee) × 8000 / 10000)` is 0 at rate 1), a
funding:

- escrows nothing, and forwards everything except the publisher's cut to payout;
- adds nothing to `ownerEscrow6`, so none of it is ever refundable;
- leaves the next **paid** runner serving those seconds unbacked. `_creditRunner`
  caps each credit at the escrow, which is 0.

Serving itself is unaffected: leases burn `balance6`, never the escrow.

On the live ledger (`0xF9e71385`, read 09-26):

- `0xca141665` (our agent wallet). Three free leases on nucbox-k11, then
  `fund(250000)` at 09-22 03:25:17Z. Escrow 0, so `refundableOf` is 0 with
  `balance6` 233800. The paid runner that followed (enclave 4dde6d1b) was credited
  nothing.
- Steven's `a69dcbba`, `d9798e4c`, `a77d0c57`, `7ae476a3`. Today's balances come
  from top-ups on 09-22 by the agent wallet `0x29479b`, all made while the runner
  share stood at 0 (nucbox-k11 at rate 1). None of those top-ups had a live
  lease: `7ae476a3` was 13 min after its lease lapsed, `d9798e4c` 1 min after, and
  the other two had no lease event in the 11 h before. Escrow is 0, 1, 0 and 7 µUSDC.
- Ledger-wide: 64 records, 22 active. The active funded records are short of
  cap-level backing by **4.40 USDC** in total. Every one of them is owned by
  Steven (`0x0b2d…` governance, `0x3977E339…` funding wallet) or by us (agent
  wallet, NucBox operator). The largest is `e64f7cba` (RISC Box): 4.56 USDC
  balance, escrow 0, lapsed on nucbox-k11, 3.64 USDC short. No outside customer's
  record is affected.

The second gap: `refundableOf` reserves `(leaseUntil - creditedUntil) × runnerRate6`
for as long as `leaseUntil > creditedUntil`, and nothing but a `release` or a
re-claim ever changes that. `EnclaveProofOfTime` lets the runner prove a lapsed
lease at any later time (its window counts from the last proof, not from
`leaseUntil`). So a lapsed lease's unproven tail is reserved for ever.
`refund()`'s NatSpec says it "becomes refundable once … the lease lapses
unproven"; the code never did that.

## What rev 14 changes

Two rules, no surface. The ABI is unchanged and `deploymentsSchema` becomes 14.

**1. A funding with no live lease splits at the cap.** When
`leaseUntil <= now` (never claimed, released or lapsed) and the cap is above the
fee, `_splitFunding` uses the cap for the publisher's cut and the runner share of
the cap for the escrow. Those seconds will be sold by whoever claims next, at a
price nobody knows yet, and the cap is the worst case the owner allowed.
`setMaxRate`'s unleased re-base already meant this ("funding splits … keep telling
the truth about the worst case"). The split re-prices nothing: `d.rate` and
`runnerRate6` are untouched. A lapsed lease's uncredited tail is therefore still
credited at that runner's own rate.

- Never-claimed records are unchanged, because `d.rate` already is the cap.
- Uncapped records (cap 0, or a cap not above the fee) keep the old rule.
  Those are imported ones.
- A LIVE lease, free ones included, still splits at the rate it burns the
  balance at (next section).

**2. A lapsed lease is provable for `LATE_PROOF_SEC` = 900 s after it ends, and
never after.** `creditProven` treats a later call as "nothing to prove" (an
existing string, to save bytes). Under proof rules `refundableOf` then reserves
only what the lease proved and has not yet been credited, so a refund reaches the
rest. That makes `refund()`'s NatSpec true.

- 900 s is one default proof window: the RPC-stall tolerance `EnclaveProofOfTime`
  was tuned for.
- It is a constant, so the platform owner can never shorten a seller's grace.
- The horizon limits only *when* a late proof may land. How far each proof reaches
  is still the prover's window.
- The held-time meter (proofs not required) is unchanged. A lapsed tail there is
  the runner's (settle pays it), so it stays reserved.

### Why a live free lease keeps today's split

A live lease burns the balance at its own rate. A free lease of a paid app burns
at the publisher fee alone, so today's split sends 100% of a funding to the
publisher: exactly the fee for each second that lease burns. Splitting at the cap
instead would pay the publisher `fee / cap` of each funding while the free lease
burns the full fee per second. The publisher would be underpaid for as long as the
owner self-hosts. The same holds for any live paid lease: its shares stay pro-rata
to the seconds it sells.

That argument needs a fee. A **fee-free** free lease has rate 0 and burns nothing,
so a funding made during it only ever buys future leases at unknown prices. That
is exactly the unleased case, yet today (and in this branch) it sends 100% to
payout and escrows nothing. **Option:** add `|| rate == 0` to the rule-1
condition. Measured cost: 15 bytes (74 would remain). Not taken, per the brief.

## Evidence

- Size: 24,325 → 24,487 bytes at runs=100, **89 under EIP-170**. The same figure
  comes from `forge build --sizes` and from `scripts/build-contract-artifacts.mjs`
  (the deploy pipeline's own build).
  - Cost by rule: rule 1 is 145 bytes; rule 2 is 127 in `refundableOf` plus 47 in
    `creditProven`.
  - Paid for by merging three validation strings, as the size note in
    `contracts/DEPLOYMENTS.md` recommends: "incomplete round" into "stale price",
    "unfunded at the new rate" into "unfunded", and "gpuShare > max" into "range".
  - Off-chain, nothing branches on those three. The only string that does is
    "over rate cap" in supervisor.js, which is untouched. Two Foundry expectations
    and one CLI comment are updated.
- Tests: all 11 `EnclaveDeployments*` Foundry suites pass, **166/166**. Nine are
  new, in `EnclaveDeployments.rev14.t.sol`:
  - the `0xca141665` sequence: a free lease, released, then the owner funds, then
    a paid claim. The funding escrows at the cap, the paid runner is credited from
    it, and `refund` returns exactly `refundableOf`;
  - Steven's case: a rate-1 lease lapses, then a top-up escrows 194445 µUSDC where
    rev 13 escrowed 0, then a claim at rate 9 is backed;
  - never-claimed records are unchanged;
  - a live free lease with a fee keeps 100% for the publisher;
  - the live near-free residual, stated as a test;
  - the horizon: reserved and provable at `leaseUntil + 900`, refused and released
    at `+901` with `refund` paying exactly the quote, a settle leaving the quote
    unchanged, and the held-time meter unchanged.
- Changed tests: three schema pins (13 → 14), and the hostile-prover clamp test,
  whose late proof moved from `+5000 s` to `+600 s` (inside the horizon).
- Mutants, each killed:

  | Mutant | Failing tests |
  |---|---|
  | never split at the cap | 2 |
  | split at the cap even with a live lease | 4 |
  | `refundableOf` keeps the tail | 2 |
  | horizon without the `proofRequired()` guard | 2 |
  | no horizon in `creditProven` | 1 |
  | the horizon off by one second | 1 |

## What it would have done here

- All four of Steven's 09-22 top-ups had no live lease, so rev 14 would have
  escrowed them at the cap. Those fundings came from the agent wallet, not the
  owner, so the escrow would back runners but would not be owner-refundable
  (`ownerEscrow6` counts only the owner's own money):

  | Record | Funding (µUSDC) | Escrowed at the cap |
  |---|---|---|
  | `7ae476a3` | 500000 | 382353 |
  | `d9798e4c` | 250000 | 194445 |
  | `a77d0c57` | 250000 | 194445 |
  | `a69dcbba` | 250000 | 194445 |

- `0xca141665`'s funding (09-22 03:25:17Z, the owner's own, no live lease) would
  have escrowed about 194k µUSDC. That would have been refundable, and would have
  paid enclave 4dde6d1b.

## What it does not fix

1. **A funding during a LIVE cheap lease** still splits at that lease's rate. If
   the balance outlives the lease and a pricier runner claims next, that runner is
   under-backed.
   - Live example: `0x31136008` (TEST2's operator-owned record, on nucbox-k11 at
     rate 1) is 7933 µUSDC short.
   - Closing it means escrowing at the larger of the live and cap runner fractions
     during live leases too. The downside: at tiny rates (rate 1 gives a runner
     share of 0) the escrow a live runner can never earn becomes refundable to the
     owner, a discount at the runner's expense.
   - Not implemented or measured. The runbook rule (fund after a paid claim)
     covers it operationally.
2. **Over-escrow after a cap split.** Escrow from a cap split that a cheaper runner
   never earns is refundable to the owner (if the owner funded it) or swept to
   payout once the record drains (`sweepEscrow`).
   - With no publisher fee the runner fraction is almost rate-independent (0.8), so
     the difference is floor rounding. It is large only at tiny rates.
   - With a fee, the publisher's cut at the cap (`fee / cap`) is below `fee / rate`
     for seconds later sold cheaper. Bounded by the owner's own cap.
3. **Records that already exist.** Rev 14 changes future fundings only. Existing
   under-backed balances stay under-backed wherever they live (next section).

## Migration

The ledger cannot be patched in place. Rev 14 is a new address, following the
rev-12 (08-11) and rev-13 (08-16) path. Rev 13 took one day and about $0.74 of gas
for 24 records (memory: enclave-split-shares-rev13, enclave-free-self-hosting). The
steps:

1. Deploy `EnclaveDeployments` rev 14 (runs=100), and a new `EnclaveProofOfTime`
   bound to it. Its constructor names its ledger, and `setProver` is one-shot.
2. Copy the parameters: `setProver`, `setProofRequiredFrom`, `runnerBps`,
   `leaseSec` and the rest, as rev 13 has them.
3. `importDeployments`, `importFees` and `importEarn` for the records worth
   carrying: 22 active and 30 funded of 64. The calibrated gas model
   (enclave-contract-migration-txsize) is ~1.2 × (270k + 730 × bytes) per record,
   with records averaging 611 string bytes: ~0.86M gas each, ~19M for the active
   ones (2 transactions at the 11M budget), ~55M for all 64 (5-6).
4. Decide the escrow (below), then `sealImports`.
5. Point the address book's `deployments` key at the new ledger. Running
   components follow within a poll; baked fallbacks (CLI `DEFAULTS`, the site
   fallback, relay env) need `sync-contract-addresses.sh`. The rev-13 memory notes
   that it once silently skipped the site fallback.
6. Later, `retire()` the old ledger, which opens `refund` there to anyone (it still
   pays each record's owner).

**Escrow at migration is the real decision.** Escrow is real USDC held by the OLD
ledger and does not migrate. Imported records start with escrow 0, so migrated
balances begin with exactly today's gap.

- Rev 12 and rev 13 migrated without re-seating escrow and left it refundable on
  the old ledger. The old ledger holds 14.91 USDC of escrow today.
- Re-seating on the new ledger (`fundEscrow` while imports are open, which credits
  `ownerEscrow6`) backs the runners. But it would **double-pay** an owner who also
  refunds the same balance on the retired old ledger. Refund on the old ledger or
  re-seat on the new one, per record, never both.
- Because every affected record is ours or Steven's, the simplest correct choice
  is rev 13's: carry the balances without re-seating, and let owners refund
  old-ledger escrow there.

Cost, all small: two contract deploys, a handful of import transactions, one
address-book write, all Trezor-signed (the governance key). Gas is on the order of
the rev-13 migration, a few dollars at most. Clients need no lockstep: the ABI is
unchanged, and clients gating on `>= 13` behave the same at 14. The site
regenerates `site/js/gen/contract-artifacts.js` on every bundle.

## Steven's four records: repair without a contract change

- **Needed?** No, for serving. Each runs `balance6 / rate`: 3.65-5.93 h on
  metal-iso0. metal-iso0 earns about 0 on them, and it is Steven's money on every
  side (his records, his box's payout, and the platform's payout that received the
  top-ups).
- **Possible?** Yes, but only after metal-iso0 has claimed. Before that,
  `runnerRate6` is 0: `fundEscrow` reverts ("no runner rate") and `fund()` escrows
  nothing. After the claim, a `fundEscrow` of each record's gap backs the runner:

  | Record | Gap (µUSDC) |
  |---|---|
  | `7ae476a3` | 277394 |
  | `d9798e4c` | 91996 |
  | `a77d0c57` | 92244 |
  | `a69dcbba` | 100644 |
  | **Total** | **≈ 0.562 USDC** |

  - From Steven (the owner) it is refundable. From the platform (payout) it is not,
    because imports are sealed.
  - `e64f7cba` (3.64 USDC short) works the same way, if a paid box ever claims it.
- A rev-14 migration alone does not repair any of these. Imports carry balances
  with escrow 0.

## Risks

- **A runner that cannot land its last proof within 15 minutes of its lease
  ending loses the unproven tail.** Rev 13 allowed that proof at any time. A normal
  runner sends checkpoint-then-release before `leaseUntil`, so this bites only
  during an outage longer than the grace. 1800 s (one lease quantum) is the obvious
  alternative if 900 s feels tight.
- **Publisher income on fee-bearing apps:** a funding made with no live lease pays
  the publisher `fee / cap` instead of `fee / lastRate`. That is lower whenever the
  last lease was cheaper than the cap.
- **Three revert strings change text.** Nothing off-chain branches on them.
  Anything that matches revert text should be re-grepped at deploy time.
- **89 bytes of headroom.** The next feature must again buy its bytes (strings
  first).
- **Merging this branch to `main` requests a contract deploy** (see the status
  line at the top).
