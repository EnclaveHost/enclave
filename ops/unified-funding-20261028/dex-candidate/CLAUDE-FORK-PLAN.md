# dex-r1 fork-test plan (opt-in, separate, NOT implemented here)

**Status:** this is a plan only. This packet contains no fork test file, no skipped test, and no RPC configuration.
Nothing here claims a fork result. Root implements and runs the harness after review.

## 1. Ground rules

- **Read-only.** Use a public Base RPC (`https://base-rpc.publicnode.com` or `https://base-mainnet.public.blastapi.io`,
  as in `dex-live-20261028.json`) pinned to one block. Every state change happens inside the local fork EVM only.
- **No broadcasting.** Use no `--broadcast`, no `vm.broadcast`, no private keys and no `cast send`. Record `transactionsSent: 0` in the result.
- **Separate profile and directory.** Put the harness in its own directory, for example `fork/`, outside `test/`. That way default
  `forge test` neither compiles it nor reports it as passed or skipped. Suggested shape:

  ```toml
  [profile.fork]
  test = "fork"
  # no rpc_endpoints committed; the URL is passed on the command line
  ```
  ```sh
  FOUNDRY_PROFILE=fork forge test --fork-url "$BASE_RPC" --fork-block-number 53199497 -vvv
  ```
- **Fail closed when it is not configured.** If `BASE_RPC` is unset, the harness must **fail** with a clear message. It must not
  `vm.skip`, so that a missing fork run can never look like a pass.

## 2. Pins (evidence, from `../dex-live-20261028.json`; asserted in the fork harness, not hardcoded in generic tests)

| What | Value |
| --- | --- |
| chain id | 8453 |
| block | 53199497, hash `0xb411a57c0e55597bf70c04e362097e0f0e87cbc43590f25a42ac07e83eccb6ac` |
| SwapRouter02 | `0x2626664c2603336E57B271c5C0b26F421741e481`, codehash `0x38bd640f…124e4` |
| V3 factory | `0x33128a8fC17869897dcE68Ed026d694621f6FDfD`, codehash `0x95707a4a…68132` |
| WETH9 predeploy | `0x4200000000000000000000000000000000000006`, codehash `0x8a3a1f6a…08b1c` |
| USDC (FiatTokenProxy) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, codehash `0xa6705a10…fefab` (proxy only) |
| QuoterV2 | `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a`, codehash `0xceb5b8bc…ee51e` |
| pools | fee 100 `0xb4CB8009…B00e5`, 500 `0xd0b53D92…8F224`, 3000 `0x6c561B44…71372` |
| quote evidence | 20,000,000,000,000 wei out: 47253 / 47290 / 47428 USDC6 in (100 / 500 / 3000) |

The full hashes are in the JSON. The harness must compare against the full values.

## 3. Steps

1. **Identity.**
   - `block.chainid == 8453` and `blockhash` matches.
   - `extcodehash` matches for router, factory, WETH, USDC proxy and QuoterV2.
   - Read the USDC EIP-1967 implementation slot (`0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`) and record its address and codehash as *new* evidence. This is the upgradeability limitation made concrete.
2. **Bindings.**
   - `router.factory() == factory` and `router.WETH9() == WETH`.
   - `USDC.decimals() == 6` and `WETH.decimals() == 18`.
   - For each fee in {100, 500, 3000}: `factory.getPool(USDC, WETH, fee)` equals the evidence pool, `feeAmountTickSpacing(fee) != 0`, the pool's `factory()` and `fee()` match, `token0 == WETH` and `token1 == USDC` (0x4200… < 0x8335…).
3. **Ledger and reserve.**
   - Use the **live** `EnclaveDeployments` address, which root pins from the address book. This packet does not know it.
   - Deploy the `EnclaveLeaseGasReserve` **source** on the fork with that ledger. The in-tree config has `leaseGasReserve: null`, so there is no live reserve to pin yet. If a reviewed reserve is later deployed, pin its address and runtime hash instead.
   - Choose a live deployment id and read its owner of record.
4. **Adapter.** Deploy `LeaseGasDexAdapter(USDC, WETH, router, factory, ledger, reserve, maxEthOut)` on the fork and record
   `address(adapter).code.length` (the EIP-170 margin) and its runtime codehash.
5. **Payer.** Use `deal(USDC, payer, X)`, which finds the FiatToken balance slot, or `vm.prank` from a USDC holder. Record which one.
   The payer approves exactly `maxUsdcIn6`.
6. **Quote parity.**
   - For each tier, static-call `QuoterV2.quoteExactOutputSingle((tokenIn, tokenOut, amount, fee, sqrtPriceLimitX96))` for 2e13 wei.
   - Watch the ABI pitfall: the quoter struct puts `amount` **before** `fee`, which differs from the router struct.
   - Then run `fundGas` with `maxUsdcIn6 = quote`. Expect `usdcSpent6 == quote`, and expect it to equal the JSON evidence at this block.
7. **Exact-amount checks on real contracts.** For each tier, check:
   - the payer's delta is `-spent`
   - the pool's USDC delta is `+spent` and its WETH delta is `-ethOut`
   - the reserve's `reserveOf(id, owner).balanceWei` delta is `+ethOut`
   - the adapter's USDC, WETH and ETH are unchanged
   - the adapter's allowance to the router is `0`
8. **WETH9 stipend (critical).**
   - The honest path proves that real `WETH.withdraw` (which uses `transfer`, so 2300 gas) can pay the adapter's `receive()` as compiled with via_ir.
   - Also measure the gas used by `receive()` with `vm.startStateDiffRecording` or a trace, and record the margin.
9. **Adversarial on real contracts.** Each case below must revert, with no balance moved:
   - `maxUsdcIn6 = quote - 1` reverts with the router string `Too much requested`
   - unsupported fee 10000 reverts with `UnsupportedFee`, even though the pool exists on Base
   - a stale `expectedOwner`
   - deadline `now - 1` and deadline `now + 15 min + 1`
   - a third-party caller
   - a payer that is blacklisted for incoming transfers, with a refund > 0. Only if impersonating the USDC blacklister on the fork is acceptable to root; otherwise omit it and note that it was omitted.
   - forced ETH (`vm.deal`), plus USDC and WETH donated to the adapter beforehand. These must be preserved, and the purchase must still be exact.
   - a plain ETH send to the adapter, and a WETH-origin send outside an unwrap
10. **Size and gas.** Record the gas used per tier for `fundGas`, the adapter's code size, and the `--sizes` output.
11. **Result file.** Write JSON with block, hashes, addresses, per-tier `spent` vs quoter, gas, code size and `transactionsSent: 0`. Keep the
    raw `forge test` output.

## 4. Out of scope for the fork run

- Successor SessionVault behaviour. It does not exist yet, so the fork can only use an EOA payer or the illustrative mock vault.
- Any production deployment or canary. Those need reviewed transactions and owner signatures that have not been requested.
