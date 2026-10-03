# USDC and native NKN conversion

Requested 2026-10-03. Status: provider conversion policy, recovery state machine,
host runtime integration and read-only route discovery are implemented. No
production execution adapters or verified native-NKN conversion route are
configured. Conversion is not enabled. The deployment hold remains in effect.

## Required behavior

Support both Base USDC -> native NKN and native NKN -> Base USDC. Conversion is
an explicit wallet action with a signed amount, exact source and destination
networks, destination address, minimum received amount, disclosed fees and expiry.
An app owner may separately authorize bounded replenishment; authorizing bandwidth
does not authorize unrestricted currency conversion.

The Base USDC token is `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` on chain 8453.
TUNA's NanoPay uses native NKN on NKN mainnet. Ethereum ERC-20 NKN is a separate
asset on a separate chain. Receiving that ERC-20 token does not fund a TUNA wallet.
The amount credited must come from a confirmed destination-chain transfer to the
intended wallet, not an exchange's success response or an assumed 1:1 rate.

Conversion does not create bandwidth revenue. Apply the provider/platform share
only to delivered, authorized bandwidth. Do not take that split from deposits,
withdrawals, swap principal or provider currency conversions. The existing
custodial native-NKN collection/split worker is excluded from the intended design.

Do not reuse an app's nominal compute balance as transferable swap backing.
Existing balances and earnings have explicit escrow/refund constraints. Any
conversion from an app balance needs a separately authorized, fully backed debit
and a defined failure/refund path; no second customer charge or bookkeeping-only
USDC/NKN credit is acceptable.

## Verified constraints

- NKN's January 2026 announcement described an official swap and exchange routes.
  Its newer March 31, 2026 update says native-to-ERC-20 swaps are no longer
  guaranteed. The earlier schedule is not evidence of current availability.
- The official swap guide describes sending funds to a swap-system payment
  address. It is not evidence of atomic, non-custodial cross-chain settlement.
- The NKN v2.2.0 implementation used by this application verifies a 34-byte
  public-key program and an Ed25519 signature. No standard hash/time-lock swap
  path was found in that implementation. A USDC escrow contract by itself does
  not prove payment or provide a native-NKN refund.
- No verified non-custodial Base-USDC/native-NKN conversion integration has been
  identified. A quote API, two RPC responses, a bonded operator or a platform
  signer is not a substitute for a specified cross-chain settlement proof.
- A read-only SWFT `queryCoinList` request at 2026-10-03 20:24 UTC returned Base
  USDC but no native NKN asset entry. A mention of NKN in another asset's
  unsupported-pairs string is not a supported NKN listing. This observation is
  limited to that endpoint and time; it is not proof that every exchange lacks
  the asset. No swap order was created.

The user selected a single-USDC experience with automatic conversion behind the
scenes. Providers manage their own currency preferences and limits. External
services may be considered as conversion dependencies, with costs included in
quotes and their trust model disclosed; this does not authorize platform custody
of provider earnings. Do not deploy an external deposit flow under a decentralized label.
If non-custodial conversion is required, implement and validate the cross-chain
protocol and its refund/finality rules before taking real funds. Unsupported
directions must remain unavailable; do not advertise ERC-20-only liquidity as
native-NKN liquidity.

## Sources checked 2026-10-03

- [NKN March 2026 swap update](https://forum.nkn.org/t/nkn-swap-system-update/7566)
- [Earlier January 2026 announcement](https://forum.nkn.org/t/nkn-mainnet-token-swap-update-2026/2318)
- [Official swap guide](https://forum.nkn.org/t/guide-nkn-s-official-mainnet-token-swap-tool/1727)
- [NKN signature validation](https://github.com/nknorg/nkn/blob/master/signature/validation.go)
- [SWFT API documentation](https://docs-swft.swft.pro/)

No conversion order, token approval, wallet creation or transfer was performed
during this investigation.


## Host runtime implementation

`network/conversion/policy.mjs` plans USDC-to-NKN replenishment and NKN-to-USDC
payouts from provider-owned wallet inventory. USDC payout keeps a native-NKN
operating reserve. NKN payout can convert available provider USDC into native NKN.
Both directions enforce exact integer amounts, price bounds, expiry and limits.
This worker does not access an application's deployment balance or its escrow.
It does not implement TUNA's missing USDC bandwidth settlement path.

`network/conversion/automatic.mjs` journals the reserved daily limit and order
identity before side effects. Lost order responses use lookup, never a new order.
Funding retries reuse the persisted signed transaction. Completion requires a
finalized transfer to the configured wallet in the exact destination asset; short
payments stop for operator reconciliation. Refunds are confirmed on the source
chain and do not replenish the daily allowance automatically. A single host
process owns each state directory and its wallets. Wallet adapters must retain
an exclusive signer lock and verify prepared transactions before broadcasting.

`privacy-agent.mjs` starts the worker only with an explicit `currencyManagement`
configuration. This contains `addresses: {USDC, NKN}`, `policy`, and separate
`route` and `wallet` adapter specifications. Each adapter specifies an absolute
local `module`, its `sha256`, and its own `config`. Pin reviewed self-contained
bundles: the loader hashes the entry file, not an arbitrary dependency graph.
Wallet adapters must prove their loaded addresses match the provider's configured
addresses. There is no platform collection wallet or default funded signer.

Policy fields are `version: 1`, `payoutCurrency: USDC|NKN`, `allowExternal`,
`reserveNkn8`, `refillBelowNkn8`, `buyUsdc6`, `maxConversionUsdc6`,
`dailyConversionUsdc6`, `maxSellNkn8`, `minNknPerUsdc8`, `minUsdcPerNkn6`,
`maxSlippageBps` and `expiresAt` (milliseconds). Amounts are integer strings in
base units. The daily limit counts USDC input including the quoted fee bound for
buys, and quoted USDC output value for sells. Quote estimates without a protected
minimum are refused for automatic funding.

Run `node scripts/network/conversion-status.mjs` to inspect the available SWFT
assets without creating an order, loading a wallet or signing anything. This
adapter is deliberately discovery-only: SWFT's asset list and indicative rate
API do not establish an executable protected native-NKN quote. The live check
still returns `native_pair_unavailable` as of this implementation.

Validation: 14 conversion tests exercise both directions with simulated route
and wallet adapters, plus 11 existing network-control/USDC-settlement tests.
These tests do not constitute a real swap, an execution adapter audit, or a
production liquidity check. No customer UI claims that automatic conversion is
available, and no production configuration or funds were changed.
