# LeaseGasDexAdapter — dex-r1 review packet

**Status: source only. Not compiled, not tested, not deployed.** These files were written with read/write tools only. No shell,
`forge`, RPC, signing or transaction was run, and no secrets were read. Every behaviour below is what the source is
*intended* to do. Root must compile and run it. This is **one vertical slice** of `source/docs/unified-funding.md`
(USDC → exact ETH → lease-gas reserve, via **existing** Uniswap V3 liquidity). It does **not** complete unified funding (§9).

## 1. Files (all in this directory)

| File | Purpose |
| --- | --- |
| `src/ILeaseGasDexAdapter.sol` | `DexGasIntent` struct and the interface a successor SessionVault action, or an EOA, calls |
| `src/LeaseGasDexAdapter.sol` | The adapter (no imports beyond its interface; no admin) |
| `test/DexFixture.sol` | Generic mock-DEX world. **No chain id, Base addresses or hashes** |
| `test/mocks/DexMocks.sol` | Mocks:<ul><li>USDC: fee-on-transfer, false-return, approve false/revert/ignored, no-return, blacklist-incoming, reentry hook</li><li>WETH9: unwraps with a 2300-gas `transfer`; short-unwrap and poke modes</li><li>V3 factory and pool, fake pools</li><li>SwapRouter02 stand-in: honest plus 9 lie modes</li><li>illustrative successor vault</li></ul> |
| `test/LeaseGasDexAdapter.t.sol` | Unit, adversarial, ABI-selector and fuzz tests |
| `test/LeaseGasDexAdapter.invariant.t.sol` | Stateful conservation: 3 payers × 2 deployments × 3 owners, with transfers, price moves, donations and forced ETH |
| `test/LeaseGasDexAdapter.realReserve.t.sol` | Adapter against the **actual `EnclaveLeaseGasReserve` source**, with a mock ledger |
| `foundry.toml` | Standalone. Mirrors r2: solc 0.8.35, optimizer 200, via_ir, and the same remappings |
| `FORK-TEST-PLAN.md` | Opt-in, separate, read-only fork plan. **Not implemented here** |

**Reuse:**
- `MockLedger` and `MockReserve` are imported **unmodified** from `../r2/test/mocks/RouterMocks.sol` (local r2 work) through the `r2/` remapping.
- That import also compiles `../r2/src/LeaseGasFundingRouter.sol`.
- `MockUSDC` follows r2's `MockToken6` pattern, credited in a comment.
- There are no new external dependencies and no copied third-party code. The SafeERC20-style call and the lock are small, written here, and follow r2/SessionVault idioms.

## 2. Inputs read

- `../r2/ROUTER-REVIEW.md` and `../r2/src/ILeaseGasFundingRouter.sol` describe the optional RFQ alternative. This adapter needs no maker pool.
- `../../source/docs/unified-funding.md` sets the requirements, including "prefer an adapter using existing exchange liquidity".
- `../dex-live-20261028.json` holds live Base pins and quote evidence at block 53199497 (fork plan §2). This is **evidence for the fork plan and deployment only**; generic tests do not hardcode it.
- `work/enclave/contracts/EnclaveLeaseGasReserve.sol` (PROTOTYPE):
  - `deposit(id)` credits `(id, ledger owner at deposit time)` and requires `0 < value ≤ uint96.max`. It has no paused check.
  - `withdraw` works only from the caller's own owner key.
  - `configure` is owner-only and a separate step.
- `work/enclave/contracts/EnclaveDeployments.sol` defines the `Deployment` tuple. `IDXLedger` copies it field for field.
- `work/enclave/contracts/SessionVault.sol`:
  - `execute` refuses `action > ACT_LAST (8)`.
  - `_spend(amount + fee)` runs **before** dispatch, with `amount` taken from the args.
  - `fee` goes to `_payRouter` (treasury).
  - `ownerCall` is direct-only.
- Root verified the router ABI: `exactOutputSingle((address,address,uint24,address,uint256,uint256,uint160)) returns (uint256)`. It has **no deadline**.

## 3. What the adapter does

`fundGas(DexGasIntent i) returns (uint256 usdcSpent6)` runs as one atomic transaction. Any failure reverts all of it.

1. **Checks:**
   - `msg.sender == i.payer`.
   - `now ≤ deadline ≤ now + 15 min`.
   - `0 < ethOut ≤ maxEthOut` and `maxUsdcIn6 > 0`.
   - fee ∈ {100, 500, 3000}.
   - The pool is validated: the factory's tick spacing is ≠ 0, `getPool(USDC, WETH, fee)` has code, and the pool's `factory()`, `token0()`, `token1()` and `fee()` all match.
   - `expectedOwner ≠ 0`, and the payer is neither the router nor the pool.
   - `ledger.get(id)` is known and its owner equals `expectedOwner`.
2. **Snapshot:** payer USDC; adapter USDC, WETH and ETH; router USDC; pool USDC and WETH.
3. **Pull** exactly `maxUsdcIn6` from payer to adapter. No-return tokens are tolerated. Both deltas must be exact.
4. **Approve and swap:**
   - Approve exactly `maxUsdcIn6` to the router, then read the allowance back.
   - Call `exactOutputSingle{tokenIn: USDC, tokenOut: WETH, fee, recipient: adapter, amountOut: ethOut, amountInMaximum: maxUsdcIn6, sqrtPriceLimitX96: 0}`.
   - Then require:
     - `0 < amountIn ≤ max`
     - adapter USDC is `+max − amountIn`
     - router USDC is unchanged
     - **pool** USDC is `+amountIn`
     - adapter WETH is exactly `+ethOut`
     - **pool** WETH is `−ethOut`
     - adapter ETH is unchanged
   - Approve 0 and read back 0.
5. **Unwrap:**
   - Set `_state = UNWRAPPING`, call `WETH.withdraw(ethOut)`, then set `_state = ENTERED`.
   - Adapter WETH must return to its snapshot, and adapter ETH must be snapshot `+ethOut`.
   - `receive()` accepts ETH only when `msg.sender == WETH && _state == UNWRAPPING`. It is read-only, so it fits WETH9's 2300-gas `transfer`.
6. **Deposit:**
   - Call `reserve.deposit{value: ethOut}(id)`.
   - Adapter ETH must fall by exactly `ethOut`, and `reserveOf(id, expectedOwner)` must rise by exactly `ethOut`.
   - Re-check the owner of record.
7. **Refund** `max − amountIn` to the **payer only**. If the refund fails, everything reverts.
8. **End state:**
   - payer USDC is `snapshot − amountIn`
   - adapter USDC, WETH and ETH equal the snapshot
   - the router allowance is 0
   - `GasFunded` is emitted and `amountIn` is returned

**What the adapter does not have:** an admin, owner, pause, upgrade, fee, sweep or treasury; an arbitrary target, calldata, recipient or path; multi-hop; or a `fallback`.

**Constructor checks (all bindings immutable):**
- all six addresses have code and are pairwise distinct
- `reserve.ledger() == ledger`
- USDC has 6 decimals and WETH has 18
- `router.factory() == factory` and `router.WETH9() == WETH`
- `0 < maxEthOut ≤ 2^96−1`

## 4. Exact amount and balance invariant

For a successful call, with `s = usdcSpent6` and the snapshots taken at entry:

| Party | Change |
| --- | --- |
| payer USDC | exactly `−s` (pulled `max`, refunded `max − s`) |
| payer → adapter allowance | `−max` (consumed). Only the payer can trigger a pull, so any leftover allowance cannot be used by third parties |
| adapter USDC / WETH / ETH | `0` / `0` / `0`. Pre-existing and forced balances are left untouched and credited to no one |
| adapter → router allowance | `0` after the call |
| router USDC | `0` |
| validated pool | USDC `+s`, WETH `−ethOut` |
| reserve | `reserveOf(id, expectedOwner).balanceWei` `+ethOut`; ETH `+ethOut` |
| owner of record | `== expectedOwner` before the swap **and** after the deposit |
| bounds | `0 < s ≤ maxUsdcIn6`, `0 < ethOut ≤ maxEthOut ≤ uint96.max` |

- **No partial output.** A WETH surplus or shortfall reverts with `DexMismatch(5)`.
- **No WETH dust.** The output is exact.
- **Unused USDC is returned in full.**
- **The pool-delta checks also prove the venue.** The router must have traded against **the validated factory pool**, not some other venue (`test_routerTradesAnotherPool_reverts`).

**Charging rule for callers:**
- Charge `usdcSpent6`, the actual debit, not `maxUsdcIn6`.
- Admit the call only if `maxUsdcIn6` fits every limit (§6).

## 5. Threat model and coverage (tests written, **not run**)

| Threat | Defence | Tests |
| --- | --- | --- |
| A third party spends the payer's allowance or redirects the refund | `msg.sender == payer`; the refund goes only to the payer | `test_onlyPayerCanSubmit`, `test_giftToAnotherOwner_payerStillOnlyRefundee` |
| Stale or long-lived call | deadline ≥ now and ≤ now + 15 min (the router itself has no deadline) | `test_deadline` |
| Slippage | `amountInMaximum = maxUsdcIn6`; `sqrtPriceLimitX96 = 0`, so the router requires full output | `test_slippage_*`, `testFuzz_belowQuote_neverDebits` |
| Wrong or fake pool, unsupported tier | fee whitelist, factory/token/fee checks, pool deltas | `test_unsupportedFeeTiers`, `test_poolValidation`, `test_routerTradesAnotherPool_reverts` |
| Incorrect DEX return: short or extra output, over-pull, router keeps the input | exact deltas (`DexMismatch` 1–7) | `test_dexLies_allRevert` |
| Router pushes ETH | `receive` refuses anything not from WETH | `test_routerPushingEth_isRefused` |
| Unwrap shortfall | exact ETH and WETH deltas | `test_unwrapShortfall_reverts` |
| Arbitrary or forced ETH; token donations | gated `receive`, snapshot deltas, no sweep | `test_unexpectedEthRefused`, `test_forcedEthAndDonations_neverSpentOrCredited`, `test_routerAllowanceCannotReachDonatedUsdc`, fuzz, invariants |
| Fee-on-transfer, false return, no-return token, approve returning false / reverting / ignored | SafeERC20-style checks and allowance read-back | `test_feeOnTransfer_reverts`, `test_transferFromReturnsFalse_reverts`, `test_noReturnToken_supported`, `test_approveFailures_revert` |
| Insufficient allowance or balance | exact pull | `test_insufficientAllowanceOrBalance_reverts` |
| Refund failure (blacklisted payer) | revert everything | `test_refundFailure_revertsEverything` |
| Owner changes before or inside the deposit; unknown id; reserve lies or is down | owner check before and after, exact reserve credit | `test_ownerChangedBefore_orUnknown`, `test_ownerMovesInsideDeposit_*`, `test_reserveUnderCreditsOrDown`, real-reserve tests |
| Reentrancy via token pull, token refund, router or reserve | a single storage lock | `test_tokenCallbacksCannotReenter`, `test_routerCannotReenter`, `test_reserveCannotReenter` |
| Mis-binding at deploy | constructor checks | `test_constructorValidation`, `test_constructorRejectsReserveOfAnotherLedger` |
| ABI drift (the v1 struct with a deadline) | selector test | `test_abiSelectors` |
| Conservation under random sequences | ghosts and counters | `testFuzz_conservation`; invariants `noViolationsOrUnexpectedFailures`, `adapterHoldsOnlyDonations`, `usdcConservation`, `ethConservation` |

**Not defended (by design or out of reach):**
- **Price fairness.**
  - `maxUsdcIn6` bounds the loss but is not a fairness check. There is no oracle here.
  - A sandwich can extract up to `maxUsdcIn6 − fair`. That includes a sandwich by the relayer that submits a session op.
  - Mitigations: keep slack tight and deadlines short, and enforce the price ceiling in the caller (§6).
  - An optional oracle band (the ledger's Chainlink ETH/USD plus a sequencer-uptime check) belongs in the successor grant, not here. It adds staleness and outage failure modes.
- **USDC is an upgradeable FiatTokenProxy** that can pause and blacklist.
  - Pause and blacklist fail closed.
  - A malicious upgrade that keeps `balanceOf` self-consistent is outside this contract's defence.
  - Root should record the implementation slot (fork plan step 1).
- **The reserve, ledger, router and WETH are trusted as pinned.** The exact-delta checks are defence in depth, not a substitute for review.
  - The reserve source is PROTOTYPE and has its own admin.
  - That admin can pause or block **sponsorship** but has no path to the reserves.
  - `deposit` and `withdraw` ignore `paused`.
- **Unbounded forwarded gas.** Calls to the fixed, pinned router, WETH and reserve forward unbounded gas.

## 6. Session requirements (successor, NOT implemented)

**The existing immutable SessionVault cannot call this adapter, and nothing should be bent to make it:**
- Its actions are fixed at 0..8.
- `ownerCall` is direct-only and refuses USDC as a target.
- `fee` is a relay fee paid to the PaymentRouter/treasury. Using `fee` or `deploy.fund` as a conduit would change what the relayer fee means and bypass the grant's action limits. **That is not done, and it must not be done.**

This adapter also does not reimburse relayers. The relayer fee still routes to the treasury exactly as it does today. Nothing here pays an arbitrary relayer directly.

A successor implementation (new domain version, fresh action bit ≥ 10, an **immutable** pinned adapter address) must:

1. **Get a new owner-signed grant.** Old grants are never reinterpreted. The grant needs explicit fields:
   - `maxGasUsdcPerOp`
   - `maxUsdcPerEth6` (the price ceiling)
   - `maxEthPerOp`
   - optionally, the allowed fee tiers and an oracle band
2. **Sign the args.** The session key signs `args = abi.encode(DexGasIntent)` via `argsHash`, plus the call deadline, with `i.deadline ≤` the call deadline.
3. **Check before calling:**
   - `i.payer == address(this)`
   - deployment scope: vault-held env/app, or the owner wallet under the same rule as `deploy.fund`
   - `i.expectedOwner == ledger.get(id).owner`
   - the **worst case** `i.maxUsdcIn6` fits the per-op, period-left, total-balance and ops limits
   - `i.maxUsdcIn6 * 1e18 ≤ maxUsdcPerEth6 * i.ethOut` (multiplication, so no rounding in the payer's favour)
   - `i.ethOut ≤ maxEthPerOp`
4. **Run the call:**
   - `approve(adapter, maxUsdcIn6)`, then `fundGas`.
   - Require the allowance back at 0.
   - Charge the **returned** `usdcSpent6` through `_spend` in the same call.
   - Keep `usdc.balanceOf(this) ≥ locked6`.

   Today's `execute` charges `_amountOf(args)` *before* dispatch, so the successor must do one of these:
   - **(a) recommended:** pre-check the worst case, then `_spend(actual)` after the call. This needs one ops increment.
   - **(b):** `_spend(max)`, then reverse exactly `max − actual` across `balance6`, `spent6`, `periodSpent6` and `locked6`.
5. **Keep the relay `fee` as it is:** separate, capped, and routed to the treasury.
6. **Add typed owner-signed ops** for `reserve.configure` and for `reserve.withdraw → owner` when the reserve is vault-keyed. Without them, that ETH is reachable only through the direct-only `ownerCall`.

A direct EOA payer binds the intent by sending its own transaction. **No off-chain signed intent exists, and none is claimed.**

## 7. ABI, compile and code-size risks (none checked; no compiler was run)

**SwapRouter02 vs the v1 SwapRouter.**
- The v1 struct has a `deadline`, so its selector differs. `test_abiSelectors` pins the string form.
- The constructor's `factory()`/`WETH9()` checks pass on **both** routers.
- Pinning the v1 router by mistake fails closed on every call, because v1 has neither the selector nor a fallback.
- Pin the router by runtime codehash (`0x38bd…24e4` in the evidence) at deployment.
- Optional hardening for root to decide: also require `factoryV2()`, which only SwapRouter02 has.

**QuoterV2 struct order** (fork plan): `(tokenIn, tokenOut, amount, fee, limit)`. This differs from the router's order.

**WETH9's 2300-gas stipend.**
- `receive()` must stay read-only: one warm SLOAD of `_state` and an immutable compare.
- A storage write, a cold read, an event or extra logic there would break unwrapping with the real WETH.
- The mock reproduces `transfer()`. The fork plan measures the margin on Base's real WETH predeploy.

**Struct decoding.**
- `IDXLedger.Deployment` and `IDXReserve.Reserve` must match the deployed ledger and reserve exactly. They are copied from the read sources and match r2's copies.
- `feeAmountTickSpacing` returns `int24`.

**Compile risks to watch:**
- relative `libs`/`remappings`/`allow_paths` that leave this directory (`../../source`, `../../../enclave/contracts`, `../r2`)
- the `r2/` import also compiles r2's router
- the `address[6]` memory literal in the constructor
- the calldata→storage struct copy in the mock router
- the `assembly { return(0, 0) }` no-return mode under via_ir
- the qualified `emit LeaseGasDexAdapter.GasFunded` (needs ≥ 0.8.21)
- `vm.expectEmit(address)`, `vm.expectRevert(bytes4)` and `targetSelector`. All three are present in the vendored forge-std.
- the real reserve's `tload`/`tstore`, which need EVM ≥ cancun. The solc 0.8.35 default is expected to satisfy this; per root, r2's identical setup passed.

**Code size.**
- Not measured.
- The adapter is about 300 lines with no libraries, so it is expected to be far below EIP-170.
- Root should record `forge build --sizes` and the fork `code.length`.

**Gas.**
- Not measured.
- Besides the swap itself, a call makes roughly 30 external calls: pool validation, owner checks, balance and allowance reads.
- Root should measure per tier on the fork.

## 8. Deployment blockers (honest state)

1. **Successor SessionVault and a new owner grant.**
   - Neither exists.
   - Moving the existing 30 USDC session needs owner signatures (`terminate`/`withdraw`, then `openWithDeposit`). Those signatures have not been requested.
2. **Reserve.**
   - It is not deployed: the in-tree config has `leaseGasReserve: null`, and the source is PROTOTYPE.
   - The owner's `configure` is a separate step sent by the owner. Until it happens, `statusOf` reports `Disabled` (`test_depositDoesNotEnableSponsorship`).
   - A zero-ETH EOA owner cannot send `configure` without either the successor's relayable owner op or a first ETH top-up. This is unresolved.
3. **Adapter deployment.**
   - Pins needed: the live ledger (not known to this packet), the reviewed reserve, USDC `0x8335…2913`, WETH `0x4200…0006`, router `0x2626…e481`, factory `0x3312…FdfD`.
   - `maxEthOut` is a policy choice, for example on the order of a reserve epoch cap.
   - Verify the runtime hash after deploying.
   - Anyone can deploy it because it has no owner, but deploying is a transaction: it costs ETH and needs root review.
4. **Fork qualification.** See `FORK-TEST-PLAN.md`. It has not been run, and no fork claim is made.
5. **Client (not implemented):**
   - quote via a QuoterV2 `eth_call`
   - choose a tier, falling back across tiers when one lacks liquidity
   - set `maxUsdcIn6 = quote × (1 + slack)`
   - before signing, show the price, its spread against a reference, and the remaining budget

## 9. Remaining routes — explicitly NOT done

- **Credit → gas.** This route is **not closed-loop-credit-safe**.
  - The ETH lands in `EnclaveLeaseGasReserve`, where the owner of record can `withdraw` it (`test_creditsOwnersKey_ownerCanWithdraw_payerCannot`).
  - Funding it from closed-loop credit would therefore create a cash-out path.
  - Credit needs its own route: typed liability retirement, backed liquidity, and a source-restricted refund path.
- **ETH → backed compute/service settlement.**
- **Migration of existing credit liabilities** (`fundEth`-forwarded `balance6`, EnclaveCreditVault) without duplication.
- **First-transaction relayer economics for a zero-ETH user.** This depends on the successor vault. Today's treasury-routed fee is not a trustless relayer reimbursement.
- **Product surfaces:** planner, status model, browser/CLI/dashboard integration, multi-provider retry, canaries, receipts and reconciliation.

Per `unified-funding.md`, a new contract without activated session and dashboard support does not satisfy the requirement.
**This slice does not complete unified funding.** No funds were spent.

## 10. Commands (unexecuted; for root)

```sh
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/unified-funding-20261028/dex-r1
forge build --sizes
forge test -vvv
forge test --match-contract LeaseGasDexAdapterTest -vvv
forge test --match-contract LeaseGasDexAdapterRealReserveTest -vvv
forge test --match-contract LeaseGasDexAdapterInvariantTest -vvv
```
