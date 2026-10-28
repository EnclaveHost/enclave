# Root review — optional RFQ candidate

This is source and offline test evidence, not a deployment. The initial production route will use existing DEX liquidity; no funded RFQ makers or quote service are established. The current funded SessionVault still cannot invoke either route.

The original source passed 52 tests, zero failures and zero skips using native solc 0.8.35, optimizer 200, via IR: 42 unit/fuzz tests, five stateful invariants (64 sequences, depth 64 each), and five actual-reserve-source integration tests. Tests include caller/quote/domain binding, owner changes, rollback, transfer semantics, per-provider conservation and reentrancy. The actual-reserve test uses a mock ledger; it is not a deployed-bytecode or Base fork test. Packaging changed import paths and split a public numeric curve constant into equivalent halves; the packaged run is recorded separately when completed.

Review confirmed the current reserve tuple and owner-keyed deposit semantics. Preserve exact payer restriction: a maker quote alone is not authority to spend someone else's allowance. Both USDC deltas, ETH debit and reserve credit are checked atomically. No arbitrary calldata or admin withdrawal exists. Forced ETH is intentionally stranded; EOA maker signatures only.

Expiry nuance: MAX_QUOTE_TTL bounds the remaining lifetime at fill, NOT the age since a quote was signed. A distant-expiry quote could become acceptable nearer its expiry. No issued-at field exists. This router therefore does not prove quote freshness or fair pricing; a payer/session must enforce its own independently bounded price and freshness policy. The source review's phrasing about long-lived quotes must be read with this limitation.

The proposed successor session integration is not implemented. Existing session fees go to PaymentRouter treasury; they are NOT direct permissionless relayer reimbursement. A new funding action must specify explicit reimbursement recipient/binding and account for actual input plus fees within the signed budget. Do not retrofit arbitrary calls into old grants.

Closed-loop credit cannot be spent into the existing freely withdrawable reserve without segregated credit-origin balances and refund restrictions. No credit conversion, grant migration, dashboard integration or production qualification is completed by these tests. No financial transactions were submitted.

The vendored reserve fixture is byte-for-byte pinned from work/enclave/contracts at collection. Its header still says PROTOTYPE; tests do not prove exact deployed reserve bytecode matches it. Live code/source reconciliation remains required.

One correction to the Claude review: reserve.withdraw debits budgetKey(id, msg.sender), not the ledger's current owner key. The former owner can withdraw its own remaining keyed reserve after a deployment transfer. This is deliberate preservation of paid balances, and reinforces why restricted compute credit cannot simply be converted into this reserve.

Packaged recheck completed: 52 passed, zero failed or skipped under the same compiler/optimizer and fuzz/invariant settings. Peak bounded process tree645MiB; minimum host available30107MiB. This establishes portability of the packaged offline tests only.
