# Ledger rev 14: decision brief

For Steven. Your decision: ship rev 14 now (**A**), bundle it into the next ledger
migration (**B**, recommended), or don't ship it (**C**). Details are in
`docs/ledger-rev14-escrow-split.md`. bf reviewed the contract (GO); nothing is
deployed.

## The problem today

- **A top-up can leave the next paid host unpaid.** A funding made after a free lease
  (your own box) or a very cheap lease (rate 1) escrows nothing for hosts. The next
  paid host then serves that time for nothing, and the owner can't refund any of it.
- **Refunds can get stuck after a lapse.** When a lease ends without its final proof,
  that part of the escrow stays reserved for ever.
- **Exposure today: 4.40 USDC,** all on records owned by you or by us. Your RISC Box
  `e64f7cba` is 3.64 of it, and your four apps are 0.56. No customer is affected.
  Your apps still serve normally on metal-iso0; that box just earns about 0 on them.

## What rev 14 changes

| Who | What changes |
|---|---|
| Owners | A funding made when no lease is running escrows about 80% for hosts. That share is refundable if the owner paid it. A lapsed lease's unproven time becomes refundable 15 minutes after it ends. |
| Hosts | Always backed for time they sell at or under the owner's price cap. A late proof must land within 15 minutes of the lease ending; today's software sends it at +90 s. |
| Publishers | A funding with no running lease pays them fee ÷ cap, which is less than today's fee ÷ last price when the last lease was cheaper. ETH fundings follow the same rule. |
| Platform | Takes about 20% up front on such fundings instead of up to 100%. The rest goes to hosts, or back to the owner. |

Unchanged: fundings during a running lease, the contract's interface, and every
client.

## Known gaps rev 14 leaves

1. A funding made **during** a running cheap lease can still leave the next pricier
   host short.
2. If the platform turns proofs off after an owner has refunded a lapsed tail, that
   tail can be paid again out of the owner's next funding. The fix needs 106 bytes
   the contract doesn't have.
3. A funding during a running free lease of a paid app can overpay the publisher.
4. Escrow that a cheap host never earns is refundable to the owner even after the
   time was used. This matters only with hosts priced at rates 1-4.

## Cost

- **Contract size:** 42 bytes of headroom are left. The next contract change will
  have to buy its own space.
- **Migration:**
  - A new ledger address.
  - A handful of governance (Trezor) transactions: two contract deploys, about two
    import transactions for the 22 active records, seal, and the address-book switch.
  - Gas: a few dollars (rev 13 cost about $0.74).
- **Required change alongside:** the admin console's migration step "Back the escrow
  BEFORE sealing" must be skipped or rewritten. As written it pays escrow twice: once
  refunded on the old ledger and once re-created on the new one.
- **Also required:** the price caps must be imported, or metal-iso0 would be refused
  "over rate cap". Each carried third-party record needs one escrow decision. Today
  there are none; every active record is yours or ours.

## Options

- **A. Ship now.** It fixes new fundings from the day of the migration. It costs a
  migration week and the console change, for 4.40 USDC of exposure that is all our
  own.
- **B. Bundle it into the next ledger migration done for another reason
  (recommended).** Until then the rule already on main applies: *fund only after a
  paid host has claimed.* It's in the billing runbook and the CLI's messages. The fix
  is ready on its branch whenever a migration happens.
- **C. Don't ship it.** Rely on the runbook rule permanently. The stuck-refund gap
  also stays.

**Recommendation: B.** Today only our own records are exposed. A migration has fixed
costs and a real operational risk (the console change and the per-record escrow
decisions), and the 42 bytes of headroom mean the next contract change will want a
migration anyway. **Switch to A** if a paying customer starts topping up after free or
cheap leases, or if the stuck-refund case reaches anyone outside.
