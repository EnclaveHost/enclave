# Billing ops runbook

Operational procedures for the hybrid billing system (card via hosted Stripe
Checkout, USDC via the PaymentRouter on Base). This document is the manual
half of the design: everything here is deliberately a HUMAN process, and the
code refuses to automate it. Pair it with the hard invariants the software
enforces:

- Money flows **in only**. Company wallets never send crypto to customer
  addresses, there is no onramp, no customer crypto balance, no self-serve
  refund or withdrawal anywhere in the product.
- The PaymentRouter is immutable and non-custodial: payer -> treasury in one
  transaction, zero balance between transactions, no owner, no admin surface.
  "Rotating" anything about it means deploying a new router.
- Accepting crypto as payment for services makes the company a *user* of
  crypto under FinCEN guidance, not a money transmitter. Every procedure
  below is written to keep it that way: no value ever flows outward to
  customers, and no customer funds are ever held.

## 1. Converting Stripe fiat revenue to crypto (treasury management)

Card revenue settles to the Stripe balance and pays out to the company bank
account like any SaaS. If the treasury strategy calls for holding part of it
as USDC, that conversion is **manual, finance-executed, and completely
disconnected from customer flows**:

- Preferred: a **business account at a regulated exchange** (e.g. Coinbase
  Prime/Exchange or Kraken Institutional) in the company's name. Wire fiat
  from the company bank, buy USDC, withdraw to the treasury address on Base.
- Alternative: **Stripe/Bridge stablecoin settlement** (Stripe's USDC payout
  rails), which settles card revenue directly as USDC. Adopt only after
  finance reviews the terms; it changes nothing else in this document.
- Never automate this conversion from platform infrastructure, never run it
  from relay/enclave boxes, and never let a conversion touch any address a
  customer has ever paid from or to. It is treasury management, not product.

Each conversion gets a ledger entry (date, fiat amount, USDC amount, venue,
tx hash of the withdrawal) - see §4 accounting.

## 2. Treasury custody

**Current state.** The treasury is the cold wallet already receiving
EnclavePay/EnclaveDeployments payouts, and the PaymentRouter's immutable
`treasury` points at it. Its key must live in a hardware wallet, held by the
founder, with the seed backed up offline in a second location. It signs
rarely (treasury movements only) and never appears on any server.

The **provisioner wallet** (relay-held `PROVISIONER_PRIVATE_KEY`) is NOT the
treasury: it is an operating wallet that spends company USDC into the
company's own EnclaveDeployments contract to fulfil paid orders. Keep it
funded like petty cash - enough USDC for a few days of expected orders plus
gas ETH, topped up manually from the treasury. A compromise of the relay box
caps out at that float. If its balance guard alerts
(`provisioner_underfunded`), top it up from the treasury; orders wait
safely in `confirmed_provisioning` until then.

**Migration criteria - move signing into the company's own TEE
infrastructure** (the platform's CVM stack can hold the provisioner key the
same way enclaves hold session keys) when EITHER:
- provisioner float regularly exceeds ~$5k, or
- order volume makes manual top-ups more than a weekly chore.

**Migration criteria - add a Safe multisig treasury** when the treasury
balance is material (rule of thumb: more than one month of operating costs,
or ~$50k, whichever comes first):
1. Deploy a 2-of-3 Safe on Base (founder hardware key + two independently
   held keys, no two on the same machine or with the same person).
2. Deploy a NEW PaymentRouter with `TREASURY_ADDRESS` = the Safe
   (`scripts/deploy-payment-router.mjs`, mainnet guard demands `--replace`).
3. Repoint the address book key `paymentRouter` (admin console or
   `scripts/update-address-book.mjs`) and the relay's
   `PAYMENT_ROUTER_ADDRESS` env, then restart the relay.
4. Nothing drains, nothing migrates: the old router holds zero by
   construction and simply stops being advertised. Keep indexing it for a
   few days (`OFAC`/unmatched sweeps) in case a stale client pays it - those
   funds still land at the OLD treasury and are attributed manually.

## 3. Refunds (manual, finance-approved, no exceptions)

There is no refund code path anywhere, deliberately. All refunds:

1. Land in the review queue or support inbox and get a ticket.
2. Are approved by finance (a named human) before anything moves.
3. **Card orders**: refund through the Stripe dashboard against the original
   payment. Never by bank transfer, never in crypto - a card payment is
   refunded on card rails or not at all.
4. **USDC orders**: a crypto refund is only ever a **reversal of one
   specific inbound payment, to the exact address that sent it, capped at
   the original amount** (partial for partial disputes). Confirm the inbound
   tx hash from the order's `usdc.payments` record; screen the address
   against the SDN list again ON THE DAY of the refund; send from the
   treasury (finance executes, not ops); record the outbound hash on the
   ticket. Never send to a "new address" the customer names, never more than
   they paid, never aggregate multiple payments into one send.
5. Unmatched payments (funds that arrived with an unknown or expired
   orderRef, visible in the review queue as `unmatched_payment`) follow the
   same rule if the payer surfaces and proves control of the sending
   address; otherwise they simply remain treasury income.

The same-address/capped-amount rule is what keeps refunds a payment
reversal rather than a transfer service. Do not relax it for convenience.

## 4. Accounting

- **Crypto received for services is ordinary income at fair market value on
  the date of receipt.** With USDC, FMV equals face value, so each confirmed
  order's `amount6` (and any overpayment excess) books as revenue at
  face on the payment's block date. The order store (`orders.json`) and the
  on-chain PaymentReceived log are the audit trail; export both monthly.
- **Basis tracking**: every treasury conversion (fiat->USDC per §1) and any
  disposal (USDC->fiat, or spending USDC - including every provisioner
  fund() into EnclaveDeployments) needs cost-basis records. USDC basis is
  face, so gains/losses are ~zero, but the records must exist.
- **Sub-ledger**: adopt a crypto sub-ledger tool (e.g. Bitwave, Cryptio, or
  TaxBit) once volume is non-trivial; feed it the treasury address, the
  provisioner address, and the router's PaymentReceived event stream. Until
  then, a spreadsheet with one row per payment/conversion/refund is fine -
  but it is maintained monthly, not reconstructed at year-end.
- **Review queue exports** (`GET /v1/billing/review?all=1` with the admin
  token) are part of the monthly close: every resolved item shows who
  approved what and why.

## 5. Quick reference - activation & rotation

| Action | How |
|---|---|
| Enable accounts + billing on the relay | add `AUTH_DATA_DIR=/var/lib/enclave-relay` (+ Stripe keys, router address, provisioner key) to `/etc/nan-relay/api-relay.env`, restart `enclave-api-relay` |
| Register the Stripe webhook | Stripe dashboard -> webhook to `https://api.enclave.host/v1/billing/stripe/webhook`, events `checkout.session.completed` + async variants; put the signing secret in `STRIPE_WEBHOOK_SECRET` |
| Deploy / rotate the router | `scripts/deploy-payment-router.mjs` (explicit `TREASURY_ADDRESS`), repoint book key `paymentRouter` + relay env |
| Light up the site checkout | flip `ACCOUNTS_ENABLED` default to `true` in `site/js/core/config.js` (one line; revert = rollback) |
| Review queue | `GET /v1/billing/review` / `POST /v1/billing/review/:id/resolve` with `x-admin-token` |
| Provisioner top-up | send USDC + a little ETH from the treasury to the provisioner address; the 60s sweep resumes held orders automatically |

## 6. Credit vaults (closed-loop prepaid credit, on-chain)

Customer "credit" is USDC held in a per-customer EnclaveCreditVault on Base -
a contract with NO exit: funds move only on the customer's passkey signature,
and only toward the platform (EnclaveDeployments funding, or the treasury for
the manual refund flow). Customers see dollars everywhere; nothing in the UI
names the token. Legally this is structured as closed-loop prepaid service
credit; the no-exit property is what keeps the company outside money
transmission. Have counsel sanity-check this structure before/soon after
launch (CVC-denominated closed loops are newer ground than fiat gift cards).

Operational rules:

- **The $2,000 balance cap is a legal boundary, not a growth lever**
  (closed-loop prepaid exemption). VAULT_CAP_6 lowers it; never raise it
  above $2,000 without counsel.
- **Top-up settlement is company USDC**: card revenue arrives at Stripe, the
  relayer wallet (PROVISIONER_PRIVATE_KEY) deposits matching USDC into the
  customer's vault. Keep the relayer's USDC float ahead of expected top-ups
  (same petty-cash sizing as §2); a shortfall alerts and retries - orders
  wait in "crediting", nothing is lost.
- **Refunds are dual-authorized**: the customer signs refundToTreasury with
  their passkey (support walks them through it), THEN finance refunds the
  card via Stripe. Never refund the card first. Crypto never goes to the
  customer, same as ever.
- **Lost passkeys strand vault balances permanently** (no admin recovery
  exists ON PURPOSE - an admin path would be custody). Support answer:
  add a second passkey while you still have the first. Stranded balances
  stay at the vault address forever; account for them as unredeemed
  prepaid credit (escheatment rules may eventually apply - counsel item).
- **Factory rotation**: deploy a new EnclaveCreditVaultFactory (admin
  console) and repoint the book key `vaultFactory` + relay env
  VAULT_FACTORY_ADDRESS. Existing vaults keep working forever (they carry
  their own book reference for the ledger); only NEW vault addresses change.
