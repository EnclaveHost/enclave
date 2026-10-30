// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// TEST MOCK - native-host-r1 fixture ONLY, deployed only on the test's own loopback Anvil. NOT Uniswap QuoterV2.
/// No QuoterV2 mock existed in dex-r1/test/mocks or session-r1; the funding route pins a quoter and calls
/// quoteExactOutputSingle, factory() and WETH9() on it. This answers from the dex-r1 MockSwapRouter02's own price
/// (quoteIn), i.e. exactly what that mock router will charge; the real Base QuoterV2 is qualified separately (fork stages).
interface IMockRouterQuote {
    function quoteIn(uint24 fee, uint256 amountOut) external view returns (uint256);
    function factory() external view returns (address);
    function WETH9() external view returns (address);
}

contract MockQuoterV2 {
    struct QuoteExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amount;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    IMockRouterQuote public immutable router;
    address public immutable factory;
    address public immutable WETH9;
    address public immutable usdc;

    constructor(IMockRouterQuote r, address usdc_) {
        router = r;
        factory = r.factory();
        WETH9 = r.WETH9();
        usdc = usdc_;
    }

    function quoteExactOutputSingle(QuoteExactOutputSingleParams memory p)
        external
        view
        returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)
    {
        require(p.tokenIn == usdc && p.tokenOut == WETH9 && p.sqrtPriceLimitX96 == 0, "MockQuoterV2: pair");
        amountIn = router.quoteIn(p.fee, p.amount);
        require(amountIn != 0, "MockQuoterV2: no quote");
        return (amountIn, 0, 0, 0);
    }
}
