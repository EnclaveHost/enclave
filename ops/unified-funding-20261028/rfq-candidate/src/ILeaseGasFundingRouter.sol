// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// One provider's signed, exact, executable offer: `ethOut` wei into `deployment`'s lease-gas reserve under
/// `expectedOwner`, for exactly `usdcIn6` USDC (6dp) pulled from `payer`. Negotiated values - NOT an oracle price.
/// EIP-712 domain: name "Enclave LeaseGasFundingRouter", version "1", chainId, verifyingContract = the router (which
/// pins USDC, ledger and reserve immutably, so the router address binds all three).
struct LeaseGasQuote {
    address payer;           // the ONLY address that may submit the fill (and the one USDC is pulled from)
    bytes32 deployment;      // ledger deployment id
    address expectedOwner;   // the ledger owner of record the ETH must be credited under
    uint256 usdcIn6;         // exact USDC pulled from payer, paid to provider
    uint256 ethOut;          // exact wei moved from provider's pool into the reserve
    uint256 nonce;           // per-provider, single use
    uint64  expiry;          // unix seconds; must also be within MAX_QUOTE_TTL of the fill
    address provider;        // signer and owner of the ETH pool debited
}

/// The surface a successor SessionVault action (or any payer contract) needs. The caller must be q.payer, must have
/// approved exactly q.usdcIn6 to the router, and must enforce its own price / freshness / budget limits BEFORE calling:
/// the router enforces the quote's integrity, not whether its price is fair.
interface ILeaseGasFundingRouter {
    function usdc() external view returns (address);
    function ledger() external view returns (address);
    function reserve() external view returns (address);
    function maxEthOut() external view returns (uint256);
    function liquidityOf(address provider) external view returns (uint256);
    function nonceUsed(address provider, uint256 nonce) external view returns (bool);
    function quoteDigest(LeaseGasQuote calldata q) external view returns (bytes32);
    function fill(LeaseGasQuote calldata q, bytes calldata providerSig) external returns (bytes32 digest);
}
