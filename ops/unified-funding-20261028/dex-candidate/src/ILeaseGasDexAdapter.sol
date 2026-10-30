// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// One USDC -> exact-ETH -> lease-gas-reserve purchase through the adapter's pinned Uniswap V3 SwapRouter02.
/// NOT a signed off-chain intent: the adapter's only authority is msg.sender == payer. A successor SessionVault binds it
/// by having the session key sign the action args (argsHash); a direct EOA caller binds it by sending the transaction.
struct DexGasIntent {
    address payer;           // msg.sender; the only USDC source and the only refund recipient
    bytes32 deployment;      // ledger deployment id
    address expectedOwner;   // ledger owner of record the reserve must credit (before AND after the deposit)
    uint256 ethOut;          // exact wei that must reach reserve.deposit(deployment); 1 .. maxEthOut
    uint256 maxUsdcIn6;      // exact USDC pulled up front; the unused part goes back to payer in the same call
    uint24 fee;              // pool fee tier: 100, 500 or 3000 (USDC/WETH pool of the pinned factory)
    uint64 deadline;         // unix seconds; now <= deadline <= now + MAX_DEADLINE_WINDOW
}

/// The surface a successor SessionVault action (or a direct EOA) calls. The caller must have approved exactly
/// maxUsdcIn6 to this adapter and must enforce its own price ceiling, per-op/period/total budget and freshness BEFORE
/// calling: maxUsdcIn6 bounds the loss, but nothing here says the pool price is fair.
interface ILeaseGasDexAdapter {
    function usdc() external view returns (address);
    function weth() external view returns (address);
    function swapRouter() external view returns (address);
    function factory() external view returns (address);
    function ledger() external view returns (address);
    function reserve() external view returns (address);
    function maxEthOut() external view returns (uint256);
    function poolFor(uint24 fee) external view returns (address pool);
    /// @return usdcSpent6 USDC actually consumed by the pool; exactly payer's net debit. Charge THIS to the budget.
    function fundGas(DexGasIntent calldata i) external returns (uint256 usdcSpent6);
}
