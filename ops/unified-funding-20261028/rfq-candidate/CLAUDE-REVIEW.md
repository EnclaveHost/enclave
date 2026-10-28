# LeaseGasFundingRouter — r2 review packet

**Status: source only. Not compiled, not tested, not deployed.** I wrote these files with read/write tools only. No
shell, `forge`, RPC, signing or transaction was run. Every behaviour described below is what the source is
*intended* to do. None of it is a verified result. Root review is required before any integration.

This is **one vertical slice** of `source/docs/unified-funding.md`: **USDC → exact ETH → lease-gas reserve**. It does
**not** satisfy that document's completion criteria (see §8).

## 1. Files (all in this directory)

| File | Purpose |
| --- | --- |
| `src/LeaseGasFundingRouter.sol` | The router (≈230 lines, no imports beyond its own interface) |
| `src/ILeaseGasFundingRouter.sol` | `LeaseGasQuote` struct + the interface a successor SessionVault action would call |
| `test/LeaseGasFundingRouter.t.sol` | Unit and adversarial tests against mocks, plus a two-provider conservation fuzz test |
| `test/LeaseGasFundingRouter.invariant.t.sol` | Stateful invariants: 3 providers, 2 deployments, provide/withdraw/fill/cancel/forced-ETH |
| `test/LeaseGasFundingRouter.realReserve.t.sol` | The router against the **actual `EnclaveLeaseGasReserve` source** (mock ledger) |
| `test/mocks/RouterMocks.sol` | Mock USDC (fee/return-false/hook modes), no-return token, mock ledger, adversarial mock reserve, reentrant/rejecting recipients, session-payer shape |
| `foundry.toml` | Standalone test-only project; reuses the vendored forge-std read-only |

No new external dependencies. No copied third-party contract code: the SafeERC20-style call, ECDSA check and
reentrancy lock are small and written here. They follow the idioms SessionVault already uses (`HALF_N` split constant,
`_lock` 1/2, exact-amount discipline).

## 2. Source pins (inputs read; hashes NOT computed — no shell)

The design depends on these files as read on 2026-10-28. Root should record their `sha256` values and the deployed
runtime hashes before integration.

- `work/rpc-production-final-20261025/source/docs/unified-funding.md` — requirements.
- `work/enclave/contracts/EnclaveLeaseGasReserve.sol` (pragma ^0.8.24, header marked **PROTOTYPE**):
  - `deposit(bytes32 id)` payable. It requires `0 < msg.value <= type(uint96).max` and credits `_reserves[keccak256(abi.encode(id, ledger.get(id).owner))]`, so the owner of record **at deposit time** gets the credit.
  - `reserveOf(id, owner) returns (Reserve)`. It has 17 static fields, and `IGRReserve.Reserve` copies them field for field.
  - `ledger()` is a public immutable. Only the owner of record can call `withdraw`, and only from their own key. `configure` must be called by the owner of record to enable sponsorship.
- `work/enclave/contracts/SessionVault.sol`:
  - The action table is `ACT_CREATE..ACT_PUBLISH` (0..8), and `ACT_LAST = 8`. `execute` reverts `NotAllowed` for `action > 8`.
  - `fee` is paid only to the pinned PaymentRouter (treasury).
  - `ownerCall` is direct-only (`msg.sender == owner`) and refuses `target == usdc`.
  - The vault is an immutable implementation behind EIP-1167 clones. There is no upgrade.
- `work/enclave/contracts/EnclaveDeployments.sol`:
  - `fundEth` credits `balance6` at the oracle price and forwards ETH to `payout`.
  - `get(id)` returns the 17-field `Deployment` tuple. `IGRLedger.Deployment` copies it, as do the reserve's `ILedgerR` and the vault's `ISVLedger`.
- `work/enclave/contracts/EnclaveCreditVault.sol` — closed-loop credit. There is no withdraw, and the outflows are fixed. This slice does not touch it.
- `source/foundry.toml` — I mirrored its solc 0.8.35, optimizer 200 and via_ir settings.
- In-tree config `work/enclave/site/credit/credit-config.json` has `"leaseGasReserve": null`. I did **not** check chain state for any reserve deployment.

## 3. What is implemented

### Roles
- **Provider (permissionless, any number).**
  - `provide()` pre-funds an ETH pool keyed to `msg.sender`.
  - `withdraw(amount, to)` takes back only the unused part of its **own** pool.
  - `cancelNonce(n)` retires one of its own quote nonces.
  - Providers sign EIP-712 `LeaseGasQuote`s. Signing is ECDSA from EOAs only, low-s, v ∈ {27, 28}.
- **Payer.** `fill(q, sig)` can be called **only by `q.payer`**. A third party that holds a quote cannot use it to spend the payer's allowance (`test_thirdPartyCannotSubmitPayersQuote`). Rewriting `q.payer` to itself breaks the signature (`test_thirdPartyCannotRedirectQuoteToItself`).
- There is no admin, owner, pause, upgrade, fee, sweep, treasury, "preferred maker", DEX, or arbitrary target/calldata.

### Signed quote (EIP-712)
- Domain: `name "Enclave LeaseGasFundingRouter"`, `version "1"`, `chainId` (read live from `block.chainid`, so a fork or other chain fails), and `verifyingContract` = the router. USDC, ledger and reserve are immutable per router, so the router address binds all three.
- Type: `LeaseGasQuote(address payer,bytes32 deployment,address expectedOwner,uint256 usdcIn6,uint256 ethOut,uint256 nonce,uint64 expiry,address provider)`.

### `fill` order
1. **Checks:**
   - caller is the payer
   - `block.timestamp <= expiry`
   - `expiry <= now + MAX_QUOTE_TTL` (15 min), so a long-lived quote is refused
   - `0 < ethOut <= maxEthOut` and `usdcIn6 > 0`
   - provider ≠ 0, provider ≠ payer, and expectedOwner ≠ 0
   - nonce unused
   - signature valid
   - the provider's **own** pool ≥ `ethOut`
   - ledger `get(id).owner == expectedOwner` and the id is known
2. **Effects:** mark the nonce used, debit the provider's pool, debit `totalLiquidity`.
3. **USDC:** `transferFrom(payer → provider, usdcIn6)`. No-return tokens are tolerated. Both balance deltas must equal exactly `usdcIn6`, so fee-on-transfer tokens or any surprise reverts. The router never holds USDC.
4. **ETH:** `reserve.deposit{value: ethOut}(id)`. The router's ETH must fall by exactly `ethOut`, and `reserveOf(id, expectedOwner).balanceWei` must rise by exactly `ethOut`.
5. **Owner re-check** after the deposit. The reserve credits whoever is owner *during* the deposit, so if the owner changes across the deposit the fill reverts.
6. `Filled` event.

Everything happens in one transaction. Any failure reverts all of it: the nonce is not consumed, no USDC moves and no ETH moves.

### Constructor validation (immutable bindings)
- USDC, ledger and reserve all have code and are pairwise distinct.
- `reserve.ledger() == ledger`.
- `usdc.decimals() == 6`.
- `0 < maxEthOut <= 2^96-1` (the reserve's own deposit bound).

### ETH accounting
- `sum(liquidityOf) == totalLiquidity <= address(this).balance`.
- There is no `receive` or `fallback`: plain or unknown-selector ETH is refused.
- Forced ETH (selfdestruct or coinbase) is credited to nobody. `strandedEth()` reports it, and nobody can withdraw it. That is deliberate: a sweep would need an owner.

### Reentrancy
One storage lock covers `provide`, `withdraw` and `fill`. The tests reenter through three paths: the token callback, the reserve callback, and a withdraw recipient. Each reentry records a `Reentrant()` revert while the outer call completes correctly.

## 4. Test inventory (written, **not run**)

| Concern | Tests |
| --- | --- |
| Exact atomic movement, event, digest vs published type string | `test_fill_movesExactAmountsAtomically`, `test_digest_matchesPublishedTypedData` |
| Payer binding / third-party allowance | `test_thirdPartyCannotSubmitPayersQuote`, `test_thirdPartyCannotRedirectQuoteToItself` |
| Field tampering, wrong signer, malleable/short/bad-v sigs | `test_tamperedFieldsFailSignature`, `test_wrongSigner`, `test_highS_badLength_badV` |
| Wrong chain / wrong router instance | `test_wrongChain`, `test_wrongRouter` |
| Replay, nonce reuse, per-provider nonces, cancel | `test_replay`, `test_nonceReuseWithDifferentTerms`, `test_noncesArePerProvider`, `test_cancelNonce` |
| Expiry boundary / max TTL / amount bounds / bad parties | `test_expiry_boundary`, `test_expiryTooFar`, `test_amountBounds`, `test_badParties` |
| Owner transfer before / inside deposit (before and after credit), unknown id | `test_ownerTransferredBeforeFill`, `test_ownerMovesInsideDeposit_beforeCredit`, `test_ownerMovesInsideDeposit_afterCredit`, `test_unknownDeployment` |
| Reserve under-credit / reserve revert (partial failure) | `test_reserveUnderCredits`, `test_reserveReverts_usdcNotMoved` |
| Insufficient liquidity (no cross-provider use), provider outage → other provider | `test_insufficientLiquidity_cannotUseAnotherProvidersPool`, `test_providerOutage_payerUsesAnotherProvider` |
| Allowance / balance shortfall, return-false, fee-on-transfer, no-return tokens | `test_insufficientAllowance_revertsEverything`, `test_insufficientPayerBalance`, `test_returnFalseToken`, `test_feeOnTransferToken`, `test_noReturnToken` |
| Reentrancy (token, reserve, withdraw recipient) | `test_tokenCallbackCannotReenter`, `test_reserveCallbackCannotReenter`, `test_withdrawRecipientCannotReenter` |
| Withdraw own-only, failed ETH send restores, zero amounts | `test_withdraw_onlyOwnUnusedBalance`, `test_withdraw_failedSendRestores`, `test_zeroAmounts` |
| Unexpected ETH, forced balance | `test_unexpectedEthRefused`, `test_forcedEth_creditsNobody` |
| Constructor binding validation | `test_constructorValidation`, `test_constructorRejectsReserveOfAnotherLedger` (real reserve) |
| Session-payer shape (exact approve, allowance back to 0) | `test_sessionPayerContract_exactAllowanceBackToZero`, `test_vaultHeldDeployment_sessionPayerShape` (real reserve) |
| Conservation, multiple providers | `testFuzz_conservation_twoProviders`; invariants in `LeaseGasFundingRouterInvariantTest` (pool sum, ETH = pools + forced, provided = pooled + withdrawn + filled, reserve credited only to owners of record, USDC conserved and router holds none, cancelled nonce refuses) |
| Real reserve semantics | `test_fillCreditsOwnersReserveKey_ownerCanWithdrawIt`, `test_ownerTransferBeforeFill_refused`, `test_ownerTransferAfterFill_reserveStaysWithPreviousOwner` |

### Commands (unexecuted; for root)
```sh
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/unified-funding-20261028/r2
forge build
forge test -vvv
forge test --match-contract LeaseGasFundingRouterTest -vvv
forge test --match-contract LeaseGasFundingRouterRealReserveTest -vvv
forge test --match-contract LeaseGasFundingRouterInvariantTest -vvv
```
Compile risks to watch, none of them checked:
- `foundry.toml` uses relative `libs`, `remappings` and `allow_paths` that reach outside this directory (into `../../source/...` and `../../../enclave/contracts`).
- The real-reserve test needs an EVM version ≥ cancun because the reserve uses `tload`/`tstore`. I left the solc 0.8.35 default in place.
- The tests use qualified event emission (`emit LeaseGasFundingRouter.Filled`, solc ≥ 0.8.21) and `vm.expectEmit(address)`, so they need a vendored forge-std recent enough to have it.

## 5. Deployment and signature blockers (honest state)

1. **The existing SessionVault cannot use this router, and nothing should be bent to make it.**
   - Actions are fixed at 0..8. `execute` refuses any other action.
   - The relay `fee` is routed only to the PaymentRouter/treasury. Using `fee` or `deploy.fund` (action 1) as a gas conduit would turn a relayer reimbursement into a platform-held subsidy and bypass the grant's meaning. **It is not done here and must not be done.**
   - `ownerCall` is direct-only and refuses USDC as target, so even the owner cannot make the vault approve or pay the router.
   - The owner's existing funded session (30 USDC) therefore **cannot** buy lease gas through any existing permission.
2. **A successor is needed:** a new SessionVault implementation and factory with an explicit gas action (§7). That means:
   - an admin step to point the address book's `sessionVaultFactory` at it, if `release` to the new vault is wanted
   - a **new owner-signed grant** naming the new action and limits; old grants must never be reinterpreted
   - moving the 30 USDC. Either:
     - `terminate`/`terminateBySession` refunds it to the owner wallet, then `openWithDeposit` into the new vault (EIP-3009, relayable), or
     - the owner-signed `withdraw` (relayable) does the same.

   Each of these is an owner signature that has not been requested.
3. **Reserve sponsorship must be enabled separately.**
   - `deposit` credits the owner's reserve, but `configure(id, policy)` must be called by the owner of record. Until then the reserve reports `Disabled`.
   - For a vault-held deployment, `configure` goes through the old vault's `ownerCall(reserve, configure(...))`, which is direct-only. For a wallet-held deployment, the wallet calls it directly.
   - **Either path needs a transaction sent by the owner**, so an EOA owner with zero ETH cannot complete it without a successor-vault owner op or a first ETH top-up. This is unresolved.
4. **Router deployment** needs pinned live addresses: Base native USDC, the live ledger, and a **reviewed, deployed `EnclaveLeaseGasReserve`** (its source is marked PROTOTYPE, and the in-tree config has `leaseGasReserve: null`). It also needs a chosen `maxEthOut`. Anyone can deploy it because it has no owner, but the address that clients and the successor vault pin must be the reviewed one (runtime hash verified).
5. **Providers must exist.** Nothing here operates a provider. If no independent provider funds a pool, the route simply fails. There is no platform fallback by design.
6. **EyesOff (rate 0):**
   - No extra compute funding is needed. `prepareFund` would refuse rate-0 funding anyway, and the reserve's `_check` treats rate 0 as a full `leaseSec` extension.
   - Only reserve deposit plus `configure` are needed for lease gas.
7. **Existing ETH-funded deployment credit:**
   - `fundEth` forwarded that ETH to `payout`, and `balance6` is ledger accounting.
   - It is not withdrawable, and this router neither reads nor spends it. That makes double-spending impossible here.
   - Converting it to gas is the separate "credit → gas" route (§8), which needs explicit platform backing.

## 6. Limitations and protections still needed

- **The price is not checked on-chain.** The quote is an executable, negotiated, exact value. The router guarantees integrity (who, what, where, once, until when), not fairness. A payer that approves a bad quote overpays the provider. **The session or client must enforce:**
  - a max USDC per op
  - a max USDC-per-ETH ceiling, compared by multiplication: `usdcIn6 * 1e18 <= maxUsdcPerEth6 * ethOut`, which avoids rounding in the payer's favour
  - quote freshness: short `expiry`, and the session call `deadline` ≤ `q.expiry`
  - the total and period budget
  - display of the effective price, and its spread against a reference price, **before** approval
- **Oracle price band, a trade-off for review.**
  - *Pro:* an on-chain band, for example against the ledger's existing Chainlink ETH/USD feed, still bounds loss if the client or quote service is compromised.
  - *Con:* it adds oracle-staleness and Base sequencer-uptime failure modes (fills blocked during an outage). The band must also leave room for provider spread and gas, and an oracle stub would bind the router to an admin-maintained feed.
  - *Recommendation:* put the band in the **successor vault's grant check** (owner-chosen ceiling, optional relative band with staleness and sequencer checks), not in the router. The router then stays oracle-free and reusable.
- **Overfunding.** A session could buy more ETH than the lease needs. The ETH stays in the owner's own reserve key, withdrawable by the owner of record, so the loss is bounded by price, not by theft. The successor action should still cap `ethOut` (for example against the reserve's `epochCapWei`, or a grant field).
- **Vault-keyed reserve ETH.** If `expectedOwner` is the vault, only the vault can `withdraw` it. The existing vault can do that only via the direct `ownerCall`. The successor vault needs a typed, owner-signed "reserve withdraw → owner" op.
- **Provider liveness and griefing.**
  - A provider can withdraw or cancel before a fill. The fill then reverts and the payer is not debited; the payer retries with another provider. A provider can refuse service, but it cannot take funds.
  - A USDC-blacklisted provider makes fills revert.
  - Contract providers (ERC-1271) are not supported in this slice.
- **Provider USDC goes straight to the provider address.** There is no escrow or refund path, because the amounts are exact-in and exact-out, so there is never unused input to refund.
- **Stranded forced ETH** stays permanently unclaimable.
- **The reserve is trusted as bound.** Its immutable binding plus the exact-delta and owner re-checks are defense in depth, not a substitute for reviewing the reserve.
- **Unbounded gas** is forwarded to `reserve.deposit`; it is a fixed, reviewed contract.
- **Mocks are not chain truth.** The real-reserve test uses a mock ledger. No fork test against Base, the live ledger or live USDC (which is a proxy, blacklist-capable and upgradeable) has been written or run.

## 7. Next: successor SessionVault integration plan (not implemented)

1. **New action:** a new name `"gas.fund"`, on a fresh bit (≥ 10, not the retired 9 `order.pay`), in a new implementation with domain `version "2"`. The grant typehash should gain explicit fields: `maxGasUsdcPerOp`, `maxUsdcPerEth6`, an optional band setting, and `maxEthPerOp`. Old signed grants cannot carry the action because `actionBit` reverts on unknown names; keep it that way.
2. **Args:** `abi.encode(LeaseGasQuote q, bytes providerSig)`. The session key signs `argsHash`, so the session approved the exact quote.
3. **Vault checks before calling:**
   - `q.payer == address(this)`
   - the deployment is held by this vault (`held[id].env` within the session's envs) or by the owner wallet (production-only rule, as `deploy.fund`)
   - `q.expectedOwner == ledger.get(id).owner`
   - the router is the vault's **immutable pinned** router
   - the price and size limits from §6, plus `deadline <= q.expiry`
4. **Accounting:** `amount = q.usdcIn6` goes through `_spend` (balance, period and ops limits) atomically with the call. The relay `fee` stays a separate, capped relay reimbursement to the PaymentRouter, exactly as today.
5. **Mechanics:** reuse `_fund`'s discipline: `approve(router, usdcIn6)` → `router.fill` → require allowance back at 0 → require `usdc.balanceOf(this) >= locked6`.
6. **Owner ops:** add typed, owner-signed (relayable) ops for `reserve.configure` and for `reserve.withdraw → owner`. These solve blocker 3 for zero-ETH owners and give vault-keyed ETH an exit.
7. **Zero-ETH first transaction:** grant opening via the factory's `openWithDepositFor` and each session `execute` are relayer-submitted. The relayer is reimbursed from the capped `fee`, so a USDC-only owner never needs ETH once the successor vault exists.
8. **Tests to add then:**
   - vault-level fuzzing of budget, period and price ceilings
   - a fork test on Base with live USDC and ledger and a reviewed reserve
   - concurrent providers and relayers
   - canary claim and renewal from a USDC-only session, with receipts kept

## 8. Remaining routes — explicitly NOT done

- ETH → backed compute/service settlement.
- Compute credit → lease gas (atomic retirement plus *backed* ETH liquidity).
- Migration of existing credit liabilities (including `fundEth`-forwarded balances and EnclaveCreditVault balances) without duplication.
- Quote discovery and planner, provider networking, multi-provider retry orchestration, the status model, and browser/CLI/dashboard integration.
- Fork and production canaries, receipts, reconciliation.

Per `unified-funding.md`, "a new contract without activated session/dashboard support does not satisfy this requirement." **This slice does not complete unified funding.**
