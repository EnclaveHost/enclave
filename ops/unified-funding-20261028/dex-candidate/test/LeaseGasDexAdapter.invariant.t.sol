// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {DexFixture} from "./DexFixture.sol";
import {LeaseGasDexAdapter} from "../src/LeaseGasDexAdapter.sol";
import {DexGasIntent} from "../src/ILeaseGasDexAdapter.sol";
import {MockUSDC, MockWETH9, MockSwapRouter02} from "./mocks/DexMocks.sol";
// reused read-only from r2 (local work)
import {MockLedger, MockReserve} from "r2/test/mocks/RouterMocks.sol";

/// Drives 3 payers x 2 deployments x 3 candidate owners through purchases (honest, stale-owner, below-quote), owner
/// transfers, price moves, USDC/WETH donations and forced ETH. Handler-side checks are COUNTED (not asserted) so that a
/// violation cannot hide behind fail_on_revert = false; the invariants assert the counters stay 0.
contract DexHandler is Test {
    LeaseGasDexAdapter public immutable adapter;
    MockUSDC public immutable usdc;
    MockWETH9 public immutable weth;
    MockSwapRouter02 public immutable router;
    MockLedger public immutable ledger;
    MockReserve public immutable reserve;
    uint256 public immutable maxEth;

    address[3] public payers;
    address[3] public owners;
    bytes32[2] public ids;

    uint256 public ghostSpent;          // sum of fundGas return values
    uint256 public ghostEthOut;         // sum of ethOut over successful calls
    uint256 public ghostDonUsdc;
    uint256 public ghostDonWeth;
    uint256 public ghostForced;
    uint256 public violations;          // a success that should not have happened, or a wrong amount
    uint256 public unexpectedFailures;  // an honest, sufficient, current-owner intent that failed
    uint256 public successes;
    uint256 public refusals;
    mapping(bytes32 => uint256) public ghostCredit;   // reserve key => wei credited by this handler
    bytes32[] public keys;
    mapping(bytes32 => bool) private _seen;

    constructor(LeaseGasDexAdapter a, MockUSDC u, MockWETH9 w, MockSwapRouter02 r, MockLedger l, MockReserve res,
        uint256 m)
    {
        adapter = a;
        usdc = u;
        weth = w;
        router = r;
        ledger = l;
        reserve = res;
        maxEth = m;
        payers = [makeAddr("payer0"), makeAddr("payer1"), makeAddr("payer2")];
        owners = [makeAddr("owner0"), makeAddr("owner1"), makeAddr("owner2")];
        ids = [keccak256("dep0"), keccak256("dep1")];
    }

    function keyCount() external view returns (uint256) { return keys.length; }
    function payerAt(uint256 k) external view returns (address) { return payers[k]; }

    function fund(uint256 pSeed, uint256 dSeed, uint256 ethOut, uint256 slack, uint8 feeIdx, uint8 kind) external {
        address p = payers[pSeed % 3];
        bytes32 id = ids[dSeed % 2];
        address current = ledger.ownerOf(id);
        bool stale = kind % 4 == 1;
        bool short = kind % 4 == 2;
        address expected = stale ? (current == owners[0] ? owners[1] : owners[0]) : current;
        ethOut = bound(ethOut, 1, maxEth);
        uint24 fee = [uint24(100), 500, 3000][feeIdx % 3];
        uint256 quote = router.quoteIn(fee, ethOut);
        uint256 maxIn = short ? quote - 1 : quote + bound(slack, 0, 5e6);
        DexGasIntent memory i = DexGasIntent({payer: p, deployment: id, expectedOwner: expected, ethOut: ethOut,
            maxUsdcIn6: maxIn, fee: fee, deadline: uint64(block.timestamp + 5 minutes)});

        uint256 before = usdc.balanceOf(p);
        vm.startPrank(p);
        usdc.approve(address(adapter), maxIn);
        try adapter.fundGas(i) returns (uint256 spent) {
            vm.stopPrank();
            successes++;
            if (stale || short || spent != quote || before - usdc.balanceOf(p) != spent) violations++;
            ghostSpent += spent;
            ghostEthOut += ethOut;
            bytes32 k = reserve.key(id, current);
            ghostCredit[k] += ethOut;
            if (!_seen[k]) { _seen[k] = true; keys.push(k); }
        } catch {
            vm.stopPrank();
            refusals++;
            if (usdc.balanceOf(p) != before) violations++;
            if (!stale && !short) unexpectedFailures++;
            vm.prank(p);
            usdc.approve(address(adapter), 0);
        }
    }

    function transferDeployment(uint256 dSeed, uint256 oSeed) external {
        ledger.setOwner(ids[dSeed % 2], owners[oSeed % 3]);
    }

    function movePrice(uint8 feeIdx, uint256 price) external {
        router.setPrice([uint24(100), 500, 3000][feeIdx % 3], bound(price, 500e6, 20_000e6));
    }

    function donateUsdc(uint256 a) external {
        a = bound(a, 1, 1_000e6);
        usdc.mint(address(adapter), a);
        ghostDonUsdc += a;
    }

    function donateWeth(uint256 a) external {
        a = bound(a, 1, 1 ether);
        vm.deal(address(this), a);
        weth.deposit{value: a}();
        weth.transfer(address(adapter), a);
        ghostDonWeth += a;
    }

    function forceEth(uint256 a) external {
        a = bound(a, 1, 1 ether);
        vm.deal(address(adapter), address(adapter).balance + a);
        ghostForced += a;
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 1 days));
    }
}

contract LeaseGasDexAdapterInvariantTest is DexFixture {
    uint256 constant PAYER_START = 1e15;   // 1bn USDC each: balance never the reason an honest intent fails

    MockLedger ledger;
    MockReserve reserve;
    LeaseGasDexAdapter adapter;
    DexHandler handler;
    uint256 poolUsdcStart;
    uint256 poolWethStart;

    function setUp() public {
        _deployDex();
        ledger = new MockLedger();
        reserve = new MockReserve(address(ledger));
        adapter = new LeaseGasDexAdapter(address(usdc), address(weth), address(router), address(factory),
            address(ledger), address(reserve), MAX_ETH);
        handler = new DexHandler(adapter, usdc, weth, router, ledger, reserve, MAX_ETH);
        ledger.setOwner(keccak256("dep0"), makeAddr("owner0"));
        ledger.setOwner(keccak256("dep1"), makeAddr("owner1"));
        for (uint256 k; k < 3; ++k) usdc.mint(handler.payerAt(k), PAYER_START);
        poolUsdcStart = _poolsUsdc();
        poolWethStart = _poolsWeth();

        bytes4[] memory sel = new bytes4[](7);
        sel[0] = DexHandler.fund.selector;
        sel[1] = DexHandler.transferDeployment.selector;
        sel[2] = DexHandler.movePrice.selector;
        sel[3] = DexHandler.donateUsdc.selector;
        sel[4] = DexHandler.donateWeth.selector;
        sel[5] = DexHandler.forceEth.selector;
        sel[6] = DexHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
        targetContract(address(handler));
    }

    function _poolsUsdc() internal view returns (uint256) {
        return usdc.balanceOf(pool100) + usdc.balanceOf(pool500) + usdc.balanceOf(pool3000);
    }

    function _poolsWeth() internal view returns (uint256) {
        return weth.balanceOf(pool100) + weth.balanceOf(pool500) + weth.balanceOf(pool3000);
    }

    function invariant_noViolationsOrUnexpectedFailures() public view {
        assertEq(handler.violations(), 0);
        assertEq(handler.unexpectedFailures(), 0);
    }

    /// Pre-existing / forced balances are never spent and never credited.
    function invariant_adapterHoldsOnlyDonations() public view {
        assertEq(usdc.balanceOf(address(adapter)), handler.ghostDonUsdc());
        assertEq(weth.balanceOf(address(adapter)), handler.ghostDonWeth());
        assertEq(address(adapter).balance, handler.ghostForced());
        assertEq(usdc.allowance(address(adapter), address(router)), 0);
    }

    /// USDC: payers' total net debit == sum of returned spend == pools' total gain; the router keeps nothing.
    function invariant_usdcConservation() public view {
        uint256 debited;
        for (uint256 k; k < 3; ++k) debited += PAYER_START - usdc.balanceOf(handler.payerAt(k));
        assertEq(debited, handler.ghostSpent());
        assertEq(_poolsUsdc() - poolUsdcStart, handler.ghostSpent());
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    /// ETH: pools' WETH loss == ETH in the reserve == sum of per-(id, owner-of-record) credits.
    function invariant_ethConservation() public view {
        assertEq(poolWethStart - _poolsWeth(), handler.ghostEthOut());
        assertEq(address(reserve).balance, handler.ghostEthOut());
        uint256 sum;
        for (uint256 k; k < handler.keyCount(); ++k) {
            bytes32 key = handler.keys(k);
            assertEq(reserve.bal(key), handler.ghostCredit(key));
            sum += reserve.bal(key);
        }
        assertEq(sum, handler.ghostEthOut());
    }
}
