# session-r1: FundingSessionVault (opt-in successor) + gas.fund. Review notes

**Status: SOURCE ONLY. Nothing was compiled, run, measured, signed or deployed in this stage.** Root must run
`prepare.py`, then build, test and measure. Every claim below about behavior is design intent backed by tests that
have **not yet run**. Runtime and initcode sizes are **UNMEASURED**.

## Files

| file | what |
|---|---|
| `prepare.py` | Checks that the original `enclave/contracts/SessionVault.sol` has SHA-256 `a447add6…eeb1c`, applies 1 counted rename (30 identifiers) and 18 exact, counted, anchored edits, then writes `src/FundingSessionVault.sol`. It aborts on any count mismatch. `--check` writes nothing. It never touches the original. |
| `src/FundingGasLib.sol` | New linked library: `checkPins` (constructor), `initPolicy` (open), `fundGas` (the action), and the `GasPolicy` struct. |
| `src/FundingSessionVault.sol` | **Generated**, not checked in by this stage. It holds `FundingSessionVault`, `FundingSessionVaultLib` and `FundingSessionVaultFactory`. |
| `foundry.toml` | solc 0.8.35, optimizer runs 1, via_ir. No size override. No RPC. |
| `test/FundingRig.sol` | Real ledger, catalog, address book, PaymentRouter, `EnclaveLeaseGasReserve`, dex-r1 `LeaseGasDexAdapter`, and the **original** `SessionVaultFactory` as the legacy factory. Mocks: USDC with EIP-3009, plus the dex-r1 WETH9, V3 factory/pools and SwapRouter02. Independent v1/v2 EIP-712 encoders. Real `vm.signP256`. The native 0x100 precompile is **required**: setUp reverts without it, and no verifier is ever etched. |
| `test/FundingSessionVault.gas.t.sol` | 40 tests plus a fuzz test for gas.fund (list below). |
| `test/FundingSessionVault.regression.t.sol` | Non-gas regressions and the constructor pins. |

## What changed vs. the original (all in the generated diff)

1. EIP-712 domain version `"2"`. No v1 grant, call or owner-op signature verifies on the successor; this is tested.
2. `SessionGrant` gains `uint256 maxGasUsdcPerOp, uint256 maxUsdcPerEth6, uint256 maxEthPerOp`, placed after `maxRatePerHour`. The exact type string is in `test/FundingRig.sol` `GRANT2_TYPEHASH`. `_hashGrant` now encodes in three parts.
3. `actionBit("gas.fund") = 1 << 10`. Nothing ever sets bit 9, and `ACT_LAST = 10`, so action 9 is refused for every grant. The original does not know the name `gas.fund`, so a v1 grant asking for it reverts `UnknownAction`. Old action 10 also reverts `NotAllowed(10)` on the original. Both are tested against the real original contract.
4. `initPolicy` at open:
   - If gas.fund is granted, all three limits must be nonzero, with `maxGasUsdcPerOp, maxUsdcPerEth6 ≤ 2^128-1` and `maxEthPerOp ≤ 2^96-1`.
   - If it is not granted, all three must be **zero**. This is stricter than "default 0 permitted": a non-gas grant cannot carry unreadable gas numbers.
   - The limits are stored in `mapping(bytes32 => GasPolicy) public gasPolicyOf`, **appended** after `held`. The `Session` tuple and every earlier slot keep the original layout.
5. Two new immutables, `gasAdapter` and `legacyFactory`. The constructor's `checkPins` requires:
   - both addresses have code;
   - `adapter.usdc() == usdc`;
   - `adapter.ledger() == book.addr("deployments")`;
   - `reserve.ledger() ==` that same ledger;
   - the legacy factory's `implementation().usdc()/book()` equal this vault's.

   `fundGas` re-checks `adapter.ledger() ==` the book's **current** ledger on every call. If the book moves, gas.fund stops; there is no fallback address. The factory constructor takes and forwards both pins.
6. `execute`: if `action == ACT_GAS`, the vault calls `_gas`. The relay fee for gas.fund is paid inside the library to `msg.sender`. Every other action is unchanged and still uses `_dispatch` + `_payRouter`, with the fee going to the treasury.
7. Unchanged: `release()` still resolves the book's `"sessionVaultFactory"` entry. `ownerCall`, revokeAll, withdraw, terminate, extend, topUp(+3009), promote, adopt, setEnvironment, close and attestation are byte-for-byte the original source apart from the renames.

## gas.fund semantics (new grant only)

Signed call: the normal `SessionCall(sessionId, nonce, action=10, argsHash, fee, deadline)`. `args` is exactly `abi.encode(DexGasIntent)`, 224 bytes. The P-256 session signature therefore covers every field: payer, deployment, expectedOwner, ethOut, maxUsdcIn6, pool fee tier, intent deadline, and the relay fee. Unchanged checks: live/epoch/expiry, call deadline, lane nonce, key hash, attestation, action bit, `fee ≤ maxFeePerOp`.

Order of operations, all in one transaction under the vault's `nonReentrant` lock:

1. `_spend(s, maxUsdcIn6 + fee)`. This is the original `_spend`: period roll, ops limit (one op counted), then `≤ balance6`, then `≤ period left`. It reserves the **worst case** before any external call.
2. `FundingGasLib.fundGas` runs these checks, all before any external write:
   - `payer == this vault`;
   - `0 < maxUsdcIn6 ≤ maxGasUsdc6`;
   - `0 < ethOut ≤ maxEthWei`;
   - `maxUsdcIn6·1e18 ≤ maxUsdcPerEth6·ethOut`. This is cross-multiplied with no division, and both sides stay below 2^256 by the bounds above.
   - The scope check (next section).
3. It then makes the purchase: `approve(adapter, maxUsdcIn6)` (verified), `adapter.fundGas(intent)`, then require the allowance is 0, `0 < used ≤ max`, and the vault's USDC down by exactly `used`.
4. It pays `fee` with `transfer(msg.sender, fee)`, with exact deltas checked on the vault and the submitter.
5. Back in `_gas`: `back = max − used` (checked) is added to `balance6` and `locked6` and subtracted from `spent6` and `periodSpent6`. `periodOps` is **not** given back. Finally the vault requires `usdc.balanceOf(vault) ≥ locked6`.

**Relayer fee:** the signed amount, capped by the grant's `maxFeePerOp`, goes to whichever account submitted the successful transaction.
- There is no recipient field, so nobody can name a third party.
- A front-runner who submits the same signed call earns the same fee for doing the same work.
- A losing or duplicate submission reverts (`BadNonce`) and is paid nothing.
- A fee of zero is valid.
- The fee is **not** derived from measured gas. Relayers quote a fee, the session signs it, and the grant caps it.
- The original fee path (PaymentRouter → treasury) is **not** independent relayer reimbursement. That is still true for every non-gas action, and for `close()`.

### Budget invariants (per successful gas.fund)

With `used` = pool input and `f` = fee: `balance6 −= used+f`, `spent6 += used+f`, `periodSpent6 += used+f`, `periodOps += 1`, `locked6 −= used+f`, vault USDC `−= used+f` (one debit). The submitter gets `+f`, the treasury `+0`, and the reserve `(deployment, holder)` gets `+ethOut` wei.

On any revert nothing moves and the nonce is not consumed (the whole transaction reverts). Overflow and underflow are covered as follows:
- `amount+fee` uses checked math, and `_spend` bounds it by `balance6 < 2^128`.
- `back ≤ max ≤ balance6`, so the uint128 cast is exact.
- `periodSpent6 ≥ max+f` holds right after `_spend` in the same transaction, even when the period rolled in that call. So the subtraction cannot underflow, and after a roll it leaves exactly `used+f`.

### Scope: whose record, and may this session touch it

| holder (ledger owner == `expectedOwner`) | condition | env |
|---|---|---|
| this vault | `held[id].env != 0` (unadopted = inert) | held env |
| owner's wallet | a paid app must be named and genuine, with fee/h ≤ `maxAppFeePerHour` (deploy.fund's wallet rule). **No** cap/rate/runner-rate check: gas buys no runtime, and a rate-0 self-hosted record is fine | `held` env, else prod |
| owner's OLD vault | `legacyFactory.isVault(holder) && legacyFactory.vaultFor(owner) == holder && holder.owner() == owner`. Old-vault custody stays where it is; the reserve credits `(id, oldVault)` | old vault's `held(id).env`, which must be nonzero |
| anything else | `NotMine` (this includes contracts that answer `owner()`, which is tested) | — |

After that, the env must be in the grant. A grant **without** `"*"` must list the record's catalog app, so gas.fund is stricter than deploy.fund here. A non-catalog appRef is therefore fundable only by `"*"` sessions.

No gas action can configure reserve policy, withdraw reserve ETH, move custody or call anything other than the pinned adapter. Those powers stay with the owner.

## Migration: without losing the $30, old custody or old factories

- **Nothing here touches the live $30 session** (original factory `0x1F5c…9C9C`, implementation `0x66C7…1F65`, bits 0–7). It cannot acquire gas.fund. No contract path moves a session balance from vault to vault. Do **not** terminate it to "migrate" until the replacement is built, reviewed, deployed, canaried and the owner has signed.
- There are two routes for funding the replacement. Both need owner signatures, prepared only after the reviewed build exists:
  - **A. Fresh USDC from the wallet:** one v2 `SessionGrant` signature plus one USDC `ReceiveWithAuthorization` for exactly `budget`, with `nonce =` the grant digest. A relayer submits `FundingSessionVaultFactory.openWithDepositFor`. The owner needs no ETH. This is tested offline.
  - **B. Recycle the $30:** the owner first ends the old session (owner `Terminate`, v1 domain; the refund goes to the owner's **wallet**, not to a vault), then does route A. Only do this after A has been proven with a canary amount, and coordinate with the KVM-recovery chat that may still rely on the old session.
- **Old custody:** the two B794-held apps stay in the old vault. gas.fund credits their reserve key in place, so no transfer is needed and nothing breaks for secrets or reserve keys.
  - **Root must verify on a fork** that B794 is `isVault` at the factory chosen as `legacyFactory`, and that `vaultFor(owner) == B794`.
  - If the old-vault apps sit under **different** old factories (the original vs. the later pinned factory), a single pin covers only one. That case needs a second successor deployment or a two-pin design. This is not implemented.
  - The "later pinned factory" ABI (`implementation()`, `usdc()`, `book()`, `held()`) must also be confirmed.
- **Wallet-held apps (7):** fundable from a prod-scoped grant with no ledger delegation (a reserve deposit is permissionless).
- **Book / factories:** do not change the address book's `sessionVaultFactory` entry. The successor's `release()` still targets the book's current factory's vault (tested). Both old factories stay deployed and untouched.
- **Deployment transactions** need an ETH-funded deployer. These are not a session action and not signed by the session. The order is:
  1. `FundingSessionVaultLib`
  2. `FundingGasLib` (linked to the vault lib)
  3. the dex-r1 adapter (already reviewed, not deployed)
  4. `FundingSessionVaultFactory`, linked to both libraries, with `(usdc, book, PaymentRouter, keyAttestations, maxVault6, adapter, legacyFactory)`

  After deployment, verify the library addresses in the factory/implementation bytecode against the reviewed build.

## Limitations: stated plainly

- **Price fairness:** `maxUsdcPerEth6` is a signed ceiling, not a fair price. Anyone can move the pool up to the ceiling before the relayer's transaction (sandwich risk). The loss per op is bounded by `maxUsdcIn6 − fair cost`. Signers and relayers must compare against an independent fresh valuation and keep `maxUsdcIn6` tight. The intent deadline is at most 15 minutes, set by the adapter.
- **Liquidity:** this depends on the Uniswap V3 USDC/WETH pools on Base at the signed fee tier. Thin or moved liquidity means a revert, and nothing is charged.
- **USDC upgradeability and blacklist:** FiatToken is an upgradeable proxy. A blacklisted vault, adapter or submitter makes gas.fund revert. A behavior change in the token could break the exact-delta checks; that would fail closed.
- **Sponsorship:** a reserve deposit does **not** enable sponsorship. Reserve `configure` is a separate owner step. Existing production policies are reportedly configured already. New onboarding typed owner ops for this are **not** implemented here.
- **Bought ETH is withdrawable** by the record's owner of record. This is fine for USDC sessions (which are the owner's money), but it means this route is **not** a closed-loop credit path.
- **Relayer economics:** the fee is a signed USDC amount, not measured gas, so relayers bear the risk of gas-price spikes. A production zero-ETH bootstrap needs an actual independent relayer that is operating and funded. This source does not provide one.

## Libraries, storage and size risks

- Two linked libraries, both called via DELEGATECALL in the vault's context, exactly like the original `SessionVaultLib`. There is no hand-written delegatecall: `prepare.py` asserts zero occurrences and exactly the original two `assembly` blocks.
- `FundingGasLib` writes **no** vault storage, except the `GasPolicy` pointer that `initPolicy` receives. It reads vault state only through the vault's own public views: `owner, usdc, book, gasAdapter, legacyFactory, gasPolicyOf, held, sessionOf`. Those self-staticcalls cost extra gas (several thousand) but avoid duplicating struct layouts.
- Non-view library entry points are protected by solc's library call guard, so they cannot be called directly.
- **Size: UNMEASURED.** The original runtime was 23,664 bytes, leaving 912 bytes of headroom.
  - Additions to the vault's runtime: the 3 grant fields (calldata decode plus a 3-part `_hashGrant`), the `initPolicy` call, the `_gas` function, the `_amountOf` branch, the `execute` branch, 2 immutable getters, the `gasPolicyOf` getter and `ACT_GAS`.
  - My rough estimate is 600–1,100 bytes. **Exceeding EIP-170 is a real possibility.**
  - If it is over, these are reviewed fallbacks that keep every function, cheapest change first:
    1. Move the `_gas` restore into `FundingGasLib`, passing a `FundingSessionVault.Session storage` pointer and returning `back` for `locked6`.
    2. Replace the two immutable getters with one `gasPins()` view.
    3. Move `_hashStrings` and the head of `_hashGrant` into `FundingSessionVaultLib`.
  - Factory initcode embeds the implementation's initcode, about 24–25 KB, against a 49,152 limit. That should fit, but it is also unmeasured.
  - The tests contain no `code_size_limit` override.

## Tests (unrun)

**Gas tests:**
- Native P-256 probe.
- v2 digest equality using an independent encoder with a different word split.
- v1-domain grant refused.
- Policy stored and bit 10 set, bit 9 clear.
- Six bad gas policies (zero or out-of-bound), with the bounds themselves accepted.
- Non-gas grant must have zero gas limits.
- Old grant cannot acquire gas.fund (real original contract), and an old session's action 10 is refused.
- Successor without the bit refuses 10; any grant refuses 9 and 11.

**Happy paths, each with the exact budget/locked/vault/treasury/submitter/allowance deltas asserted:**
- vault-held
- zero fee
- wallet-held prod, where deploy.fund is refused for the cap but gas.fund passes
- old-vault-held, funded in place

**Scope:**
- wallet-held needs prod
- paid wallet app must be named
- allowlist without `"*"`
- old vault wrong env
- old vault unadopted
- fake old vault
- someone else's genuine old vault
- unadopted successor record
- wrong expectedOwner
- unknown id

**Signed limits:**
- per-op USDC
- per-op ETH and ETH = 0
- price at its exact boundary (±1)
- fee cap
- budget on max+fee
- period limit on the max, then a period roll restoring exactly
- ops limit
- args must be exactly 224 bytes, and short args revert
- payer must be the vault
- adapter intent deadline
- book ledger swap refused

**Session gates:**
- call deadline
- expiry
- revokeAll
- wrong key
- wrong chain
- tampered args/fee
- attestation revoked

**Nonces and rollbacks:**
- independent lanes
- replay refused with nothing moved
- front-running relayer paid, slower relayer paid nothing
- failed swap (adapter delta lie, or pool above max): nothing charged and nonce unspent
- fee transfer revert rolls back the swap

**Zero-ETH and fuzz:**
- zero-ETH owner, relayer-only flow (EIP-3009 nonce = grant digest)
- a 3009 authorization cannot fund a different grant
- fuzz over (ethOut, maxIn, fee, price): success means an exact charge, revert means nothing moved

**Regression tests (successor, non-gas):**
- create+fund with the fee to the treasury and nothing to the submitter
- deploy.fund of a held record
- refund lands as free balance
- revokeAll(withdraw), including after gas.fund
- terminate refund
- owner-signed withdraw: v1 refused, v2 accepted
- release still resolves the book's (old) factory and refuses self
- legacy factory and vault unchanged
- constructor pins 1–5 plus the real pair passes. `PinStub` exists only to trigger pin failures and is not an adapter.

**Known compile/run risks for root to check first:**
- the circular import (`FundingGasLib` ↔ generated vault; a library using the contract's `Session` type)
- expectRevert on the public library `actionBit`
- the P-256 precompile and `evm_version` (record the choice next to the sizes)
- `MockSwapRouter02` revert-string bubbling through the adapter
- ledger refund/fund-split assumptions copied from the original suite

No Base-fork test of the successor exists yet. The dex-r1 fork tests cover only the adapter.

## Still required for the full unified-funding goal

1. Root build, test, measure and review of this source, plus a Base-fork run against the live old factory/B794/ledger/reserve/USDC state with no broadcast.
2. Concrete deployment, linking and canary plan; rollback plan (stop issuing v2 grants; the owner can revoke/withdraw at any time).
3. Owner signing packet: the v2 grant and EIP-3009, prepared only after items 1–2.
4. A real independent relayer service that quotes fees.
5. ETH → backed compute, and restricted (non-cash-out) credit → gas with source-aware reserve accounting.
6. Planner, dashboard, API and CLI surfaces.
7. Reconciliation of the old `fundEth` accounting-credit backing.

None of these is done here.
