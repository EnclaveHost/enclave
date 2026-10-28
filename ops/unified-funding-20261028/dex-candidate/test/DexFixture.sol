// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {LeaseGasDexAdapter} from "../src/LeaseGasDexAdapter.sol";
import {DexGasIntent} from "../src/ILeaseGasDexAdapter.sol";
import {MockUSDC, MockWETH9, MockV3Factory, MockSwapRouter02} from "./mocks/DexMocks.sol";

/// Shared mock-DEX world: 6dp USDC, WETH9, a V3 factory with USDC/WETH pools at 100 / 500 / 3000, a SwapRouter02
/// stand-in bound to both. Generic: no chain id, Base addresses or bytecode hashes here (those are fork-plan evidence).
abstract contract DexFixture is Test {
    bytes32 internal constant ID = keccak256("eyes-off");
    uint256 internal constant PRICE = 2_400e6;           // USDC 6dp per ETH, before the pool fee
    uint256 internal constant MAX_ETH = 0.05 ether;
    uint256 internal constant POOL_WETH = 100 ether;
    uint256 internal constant POOL_USDC = 1_000_000e6;

    MockUSDC internal usdc;
    MockWETH9 internal weth;
    MockV3Factory internal factory;
    MockSwapRouter02 internal router;
    address internal pool100;
    address internal pool500;
    address internal pool3000;

    function _deployDex() internal {
        vm.warp(1_800_000_000);
        usdc = new MockUSDC(6);
        weth = new MockWETH9();
        factory = new MockV3Factory();
        router = new MockSwapRouter02(address(factory), address(weth));
        factory.setRouter(address(router));
        pool100 = _newPool(100);
        pool500 = _newPool(500);
        pool3000 = _newPool(3000);
    }

    function _newPool(uint24 fee) internal returns (address p) {
        p = factory.createPool(address(usdc), address(weth), fee);
        router.setPrice(fee, PRICE);
        _giveWeth(p, POOL_WETH);
        usdc.mint(p, POOL_USDC);
    }

    function _giveWeth(address to, uint256 a) internal {
        vm.deal(address(this), address(this).balance + a);
        weth.deposit{value: a}();
        weth.transfer(to, a);
    }

    function _intent(address payer, address owner_, uint256 ethOut, uint256 maxIn, uint24 fee)
        internal view returns (DexGasIntent memory)
    {
        return DexGasIntent({
            payer: payer, deployment: ID, expectedOwner: owner_, ethOut: ethOut, maxUsdcIn6: maxIn, fee: fee,
            deadline: uint64(block.timestamp + 5 minutes)
        });
    }

    /// The payer approves EXACTLY maxUsdcIn6, then submits its own intent.
    function _approve(LeaseGasDexAdapter a, DexGasIntent memory i) internal {
        vm.prank(i.payer);
        usdc.approve(address(a), i.maxUsdcIn6);
    }

    function _fund(LeaseGasDexAdapter a, DexGasIntent memory i) internal returns (uint256 spent) {
        _approve(a, i);
        vm.prank(i.payer);
        spent = a.fundGas(i);
    }

    function _poolOf(uint24 fee) internal view returns (address) {
        return fee == 100 ? pool100 : fee == 500 ? pool500 : pool3000;
    }
}
