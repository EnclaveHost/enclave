// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {LeaseGasFundingRouter} from "../src/LeaseGasFundingRouter.sol";
import {LeaseGasQuote} from "../src/ILeaseGasFundingRouter.sol";
import {MockToken6, MockLedger, MockReserve} from "./mocks/RouterMocks.sol";

/// Random provide / withdraw / fill / cancel / forced-ETH sequences over three providers and two deployments.
contract RouterHandler is Test {
    LeaseGasFundingRouter public immutable router;
    MockToken6 public immutable usdc;
    MockReserve public immutable reserve;
    address public immutable payer;
    bytes32[2] public ids;
    address[2] public owners;
    uint256[3] internal pks;
    address[3] public providers;

    uint256 public ghostFilledWei;
    uint256 public ghostForcedWei;
    uint256 public ghostUsdcPaid;
    uint256 public ghostProvidedWei;
    uint256 public ghostWithdrawnWei;
    uint256 public fills;
    uint256 public refusedCancelled;
    uint256 internal _nonce;

    constructor(LeaseGasFundingRouter r, MockToken6 t, MockReserve res, address p, bytes32[2] memory i, address[2] memory o) {
        router = r;
        usdc = t;
        reserve = res;
        payer = p;
        ids = i;
        owners = o;
        pks = [uint256(0xA1), 0xA2, 0xA3];
        for (uint256 k = 0; k < 3; k++) providers[k] = vm.addr(pks[k]);
    }

    function provide(uint256 k, uint256 amt) external {
        k %= 3;
        amt = bound(amt, 1, 5 ether);
        address p = providers[k];
        vm.deal(p, p.balance + amt);
        vm.prank(p);
        router.provide{value: amt}();
        ghostProvidedWei += amt;
    }

    function withdraw(uint256 k, uint256 amt) external {
        k %= 3;
        address p = providers[k];
        uint256 have = router.liquidityOf(p);
        if (have == 0) return;
        amt = bound(amt, 1, have);
        vm.prank(p);
        router.withdraw(amt, payable(p));
        ghostWithdrawnWei += amt;
    }

    function fill(uint256 k, uint256 d, uint256 eth, uint256 usd) external {
        k %= 3;
        d %= 2;
        address p = providers[k];
        uint256 have = router.liquidityOf(p);
        uint256 payerBal = usdc.balanceOf(payer);
        if (have == 0 || payerBal == 0) return;
        uint256 cap = have < router.maxEthOut() ? have : router.maxEthOut();
        eth = bound(eth, 1, cap);
        usd = bound(usd, 1, payerBal < 1_000e6 ? payerBal : 1_000e6);
        uint256 n = _nonce++;
        LeaseGasQuote memory q = LeaseGasQuote({
            payer: payer, deployment: ids[d], expectedOwner: owners[d], usdcIn6: usd, ethOut: eth, nonce: n,
            expiry: uint64(block.timestamp + 60), provider: p
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pks[k], router.quoteDigest(q));
        bytes memory sig = abi.encodePacked(r, s, v);
        if (router.nonceUsed(p, n)) {
            // cancelled by its provider: must refuse, and (checked by the invariants) debit nobody
            vm.expectRevert(LeaseGasFundingRouter.NonceUsed.selector);
            vm.prank(payer);
            router.fill(q, sig);
            refusedCancelled++;
            return;
        }
        vm.prank(payer);
        router.fill(q, sig);
        ghostFilledWei += eth;
        ghostUsdcPaid += usd;
        fills++;
    }

    /// a provider cancels the nonce the next fill will use
    function cancelNext(uint256 k) external {
        k %= 3;
        vm.prank(providers[k]);
        router.cancelNonce(_nonce);
    }

    function force(uint256 amt) external {
        amt = bound(amt, 1, 1 ether);
        vm.deal(address(router), address(router).balance + amt);
        ghostForcedWei += amt;
    }

    function sumLiquidity() external view returns (uint256 s) {
        for (uint256 k = 0; k < 3; k++) s += router.liquidityOf(providers[k]);
    }

    function sumProviderUsdc() external view returns (uint256 s) {
        for (uint256 k = 0; k < 3; k++) s += usdc.balanceOf(providers[k]);
    }
}

contract LeaseGasFundingRouterInvariantTest is Test {
    uint256 constant PAYER_START = 1_000_000e6;
    LeaseGasFundingRouter router;
    MockToken6 usdc;
    MockLedger ledger;
    MockReserve reserve;
    RouterHandler handler;
    address payer = makeAddr("payer");
    bytes32[2] ids = [keccak256("d0"), keccak256("d1")];
    address[2] owners;

    function setUp() public {
        owners = [makeAddr("owner0"), makeAddr("owner1")];
        usdc = new MockToken6(6);
        ledger = new MockLedger();
        reserve = new MockReserve(address(ledger));
        router = new LeaseGasFundingRouter(address(usdc), address(ledger), address(reserve), 1 ether);
        ledger.setOwner(ids[0], owners[0]);
        ledger.setOwner(ids[1], owners[1]);
        usdc.mint(payer, PAYER_START);
        vm.prank(payer);
        usdc.approve(address(router), type(uint256).max);
        handler = new RouterHandler(router, usdc, reserve, payer, ids, owners);
        targetContract(address(handler));
    }

    function invariant_liquidityIsSumOfProviderPools() public view {
        assertEq(handler.sumLiquidity(), router.totalLiquidity());
    }

    function invariant_routerEthIsLiquidityPlusForced() public view {
        assertEq(address(router).balance, router.totalLiquidity() + handler.ghostForcedWei());
        assertEq(router.strandedEth(), handler.ghostForcedWei());
    }

    function invariant_ethFlowConserved() public view {
        // every wei provided is still pooled, was withdrawn by its provider, or sits in a reserve
        assertEq(handler.ghostProvidedWei(),
            router.totalLiquidity() + handler.ghostWithdrawnWei() + handler.ghostFilledWei());
        assertEq(address(reserve).balance, handler.ghostFilledWei());
    }

    function invariant_reserveCreditedOnlyToOwnersOfRecord() public view {
        uint256 credited = reserve.bal(reserve.key(ids[0], owners[0])) + reserve.bal(reserve.key(ids[1], owners[1]));
        assertEq(credited, handler.ghostFilledWei());
    }

    function invariant_usdcConserved_routerHoldsNone() public view {
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(usdc.balanceOf(payer) + handler.sumProviderUsdc(), PAYER_START);
        assertEq(PAYER_START - usdc.balanceOf(payer), handler.ghostUsdcPaid());
    }
}
