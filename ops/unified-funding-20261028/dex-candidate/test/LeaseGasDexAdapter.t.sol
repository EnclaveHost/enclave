// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DexFixture} from "./DexFixture.sol";
import {LeaseGasDexAdapter, ISwapRouter02} from "../src/LeaseGasDexAdapter.sol";
import {DexGasIntent} from "../src/ILeaseGasDexAdapter.sol";
import {MockUSDC, MockWETH9, MockV3Factory, MockSwapRouter02, FakePool, MockSuccessorVault, PlainSender}
    from "./mocks/DexMocks.sol";
// reused read-only from r2 (local work): ledger owner-of-record stand-in and the switchable-lie reserve
import {MockLedger, MockReserve} from "r2/test/mocks/RouterMocks.sol";

contract LeaseGasDexAdapterTest is DexFixture {
    MockLedger ledger;
    MockReserve reserve;
    LeaseGasDexAdapter adapter;
    address payer = makeAddr("payer");
    address appOwner = makeAddr("appOwner");
    address stranger = makeAddr("stranger");

    function setUp() public {
        _deployDex();
        ledger = new MockLedger();
        reserve = new MockReserve(address(ledger));
        ledger.setOwner(ID, appOwner);
        adapter = new LeaseGasDexAdapter(address(usdc), address(weth), address(router), address(factory),
            address(ledger), address(reserve), MAX_ETH);
        usdc.mint(payer, 1_000e6);
    }

    function _credited(address o) internal view returns (uint256) { return reserve.bal(reserve.key(ID, o)); }

    function _assertUntouched() internal view {
        assertEq(usdc.balanceOf(payer), 1_000e6, "payer debited");
        assertEq(_credited(appOwner), 0, "reserve credited");
        assertEq(address(reserve).balance, 0, "reserve got ETH");
        assertEq(usdc.balanceOf(address(adapter)), 0);
        assertEq(weth.balanceOf(address(adapter)), 0);
        assertEq(address(adapter).balance, 0);
        assertEq(usdc.allowance(address(adapter), address(router)), 0);
    }

    function _expectFail(DexGasIntent memory i, bytes memory err) internal {
        _approve(adapter, i);
        vm.expectRevert(err);
        vm.prank(i.payer);
        adapter.fundGas(i);
    }

    // =================================================================================================================
    // happy path, exact amounts
    // =================================================================================================================

    function test_fundGas_exactAmounts_refundsUnused() public {
        uint256 ethOut = 0.004 ether;
        uint256 quote = router.quoteIn(500, ethOut);
        DexGasIntent memory i = _intent(payer, appOwner, ethOut, quote + 1e6, 500);
        uint256 poolUsdc = usdc.balanceOf(pool500);
        uint256 poolWeth = weth.balanceOf(pool500);

        _approve(adapter, i);
        vm.expectEmit(address(adapter));
        emit LeaseGasDexAdapter.GasFunded(ID, payer, appOwner, pool500, 500, ethOut, quote, quote + 1e6);
        vm.prank(payer);
        uint256 spent = adapter.fundGas(i);

        assertEq(spent, quote);
        assertEq(usdc.balanceOf(payer), 1_000e6 - quote, "payer charged exactly the pool input");
        assertEq(usdc.allowance(payer, address(adapter)), 0, "exact pre-approval consumed");
        assertEq(_credited(appOwner), ethOut);
        assertEq(address(reserve).balance, ethOut);
        assertEq(usdc.balanceOf(pool500), poolUsdc + quote);
        assertEq(weth.balanceOf(pool500), poolWeth - ethOut);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(usdc.balanceOf(address(adapter)), 0);
        assertEq(weth.balanceOf(address(adapter)), 0);
        assertEq(address(adapter).balance, 0);
        assertEq(usdc.allowance(address(adapter), address(router)), 0);

        (address tIn, address tOut, uint24 f, address rcpt, uint256 aOut, uint256 aMax, uint160 lim) = router.last();
        assertEq(tIn, address(usdc));
        assertEq(tOut, address(weth));
        assertEq(f, 500);
        assertEq(rcpt, address(adapter), "router pays the adapter only");
        assertEq(aOut, ethOut);
        assertEq(aMax, quote + 1e6);
        assertEq(lim, 0);
    }

    function test_exactMaxInput_noRefund() public {
        uint256 quote = router.quoteIn(100, 0.01 ether);
        uint256 spent = _fund(adapter, _intent(payer, appOwner, 0.01 ether, quote, 100));
        assertEq(spent, quote);
        assertEq(usdc.balanceOf(payer), 1_000e6 - quote);
        assertEq(_credited(appOwner), 0.01 ether);
    }

    function test_allSupportedFeeTiers() public {
        uint24[3] memory fees = [uint24(100), 500, 3000];
        uint256 total;
        for (uint256 k; k < 3; ++k) {
            uint256 quote = router.quoteIn(fees[k], 0.002 ether);
            uint256 poolBefore = usdc.balanceOf(_poolOf(fees[k]));
            total += _fund(adapter, _intent(payer, appOwner, 0.002 ether, quote + 5e5, fees[k]));
            assertEq(usdc.balanceOf(_poolOf(fees[k])), poolBefore + quote);
        }
        assertEq(_credited(appOwner), 0.006 ether);
        assertEq(usdc.balanceOf(payer), 1_000e6 - total);
        assertGt(router.quoteIn(3000, 1 ether), router.quoteIn(100, 1 ether), "fee tiers priced differently");
    }

    function test_maxEthOutBoundary() public {
        uint256 quote = router.quoteIn(500, MAX_ETH);
        _fund(adapter, _intent(payer, appOwner, MAX_ETH, quote, 500));
        assertEq(_credited(appOwner), MAX_ETH);
    }

    function test_giftToAnotherOwner_payerStillOnlyRefundee() public {
        // a direct EOA may fund someone else's deployment (the reserve allows gifts); the refund still returns to it
        uint256 quote = router.quoteIn(500, 0.001 ether);
        usdc.mint(stranger, 10e6);
        _fund(adapter, _intent(stranger, appOwner, 0.001 ether, 10e6, 500));
        assertEq(usdc.balanceOf(stranger), 10e6 - quote);
        assertEq(_credited(appOwner), 0.001 ether);
        assertEq(_credited(stranger), 0);
    }

    // =================================================================================================================
    // caller binding, bounds, deadline
    // =================================================================================================================

    function test_onlyPayerCanSubmit() public {
        DexGasIntent memory i = _intent(payer, appOwner, 0.001 ether, 10e6, 500);
        _approve(adapter, i);
        vm.expectRevert(LeaseGasDexAdapter.NotPayer.selector);
        vm.prank(stranger);
        adapter.fundGas(i);
        // rewriting payer to itself only spends the stranger's own (absent) funds
        i.payer = stranger;
        vm.expectRevert(LeaseGasDexAdapter.TokenTransferFailed.selector);
        vm.prank(stranger);
        adapter.fundGas(i);
        // undo the payer's standing approval so the shared check below is about balances only
        vm.prank(payer);
        usdc.approve(address(adapter), 0);
        _assertUntouched();
    }

    function test_deadline() public {
        DexGasIntent memory i = _intent(payer, appOwner, 0.001 ether, 10e6, 500);
        i.deadline = uint64(block.timestamp - 1);
        _expectFail(i, abi.encodeWithSelector(LeaseGasDexAdapter.Expired.selector));
        i.deadline = uint64(block.timestamp + 15 minutes + 1);
        _expectFail(i, abi.encodeWithSelector(LeaseGasDexAdapter.DeadlineTooFar.selector));
        _assertUntouched();
        i.deadline = uint64(block.timestamp + 15 minutes);
        _fund(adapter, i);
        i.deadline = uint64(block.timestamp);
        _fund(adapter, i);
        assertEq(_credited(appOwner), 0.002 ether);
    }

    function test_amountBounds() public {
        bytes memory bad = abi.encodeWithSelector(LeaseGasDexAdapter.BadAmount.selector);
        _expectFail(_intent(payer, appOwner, 0, 10e6, 500), bad);
        _expectFail(_intent(payer, appOwner, MAX_ETH + 1, 1_000e6, 500), bad);
        _expectFail(_intent(payer, appOwner, 0.001 ether, 0, 500), bad);
        _assertUntouched();
    }

    function test_badParties() public {
        bytes memory bad = abi.encodeWithSelector(LeaseGasDexAdapter.BadParty.selector);
        _expectFail(_intent(payer, address(0), 0.001 ether, 10e6, 500), bad);
        DexGasIntent memory i = _intent(address(router), appOwner, 0.001 ether, 10e6, 500);
        vm.expectRevert(bad);
        vm.prank(address(router));
        adapter.fundGas(i);
        i.payer = pool500;
        vm.expectRevert(bad);
        vm.prank(pool500);
        adapter.fundGas(i);
    }

    function test_slippage_maxInputTooLow_revertsWithoutDebit() public {
        uint256 quote = router.quoteIn(500, 0.004 ether);
        _expectFail(_intent(payer, appOwner, 0.004 ether, quote - 1, 500), bytes("Too much requested"));
        vm.prank(payer);
        usdc.approve(address(adapter), 0);
        _assertUntouched();
    }

    // =================================================================================================================
    // pool choice
    // =================================================================================================================

    function test_unsupportedFeeTiers() public {
        uint24[4] memory fees = [uint24(0), 10000, 250, 1];
        for (uint256 k; k < 4; ++k) {
            _expectFail(_intent(payer, appOwner, 0.001 ether, 10e6, fees[k]),
                abi.encodeWithSelector(LeaseGasDexAdapter.UnsupportedFee.selector, fees[k]));
        }
        _assertUntouched();
    }

    function test_poolValidation() public {
        bytes memory bad = abi.encodeWithSelector(LeaseGasDexAdapter.BadPool.selector, uint24(500));
        DexGasIntent memory i = _intent(payer, appOwner, 0.001 ether, 10e6, 500);
        (address t0, address t1) =
            address(usdc) < address(weth) ? (address(usdc), address(weth)) : (address(weth), address(usdc));

        factory.setTickSpacing(500, 0);
        _expectFail(i, bad);
        factory.setTickSpacing(500, 10);

        address[6] memory fakes = [
            address(0),
            makeAddr("eoa-pool"),
            address(new FakePool(makeAddr("other-factory"), t0, t1, 500)),   // wrong factory
            address(new FakePool(address(factory), t1, t0, 500)),           // tokens swapped
            address(new FakePool(address(factory), t0, address(this), 500)), // wrong token
            address(new FakePool(address(factory), t0, t1, 3000))            // wrong fee
        ];
        for (uint256 k; k < fakes.length; ++k) {
            factory.setPool(address(usdc), address(weth), 500, fakes[k]);
            _expectFail(i, bad);
            vm.expectRevert(bad);
            adapter.poolFor(500);
        }
        factory.setPool(address(usdc), address(weth), 500, pool500);
        assertEq(adapter.poolFor(500), pool500);
        vm.prank(payer);
        usdc.approve(address(adapter), 0);
        _assertUntouched();
    }

    function test_routerTradesAnotherPool_reverts() public {
        router.setMode(router.OTHER_POOL());
        router.setOtherPool(pool3000);
        _expectFail(_intent(payer, appOwner, 0.001 ether, 10e6, 500),
            abi.encodeWithSelector(LeaseGasDexAdapter.DexMismatch.selector, uint8(4)));
        _assertUntouched();
    }

    // =================================================================================================================
    // incorrect DEX behaviour
    // =================================================================================================================

    function _dexLie(uint8 mode, uint256 maxIn, bytes memory err) internal {
        router.setMode(mode);
        _expectFail(_intent(payer, appOwner, 0.004 ether, maxIn, 500), err);
        _assertUntouched();
        router.setMode(0);
    }

    function test_dexLies_allRevert() public {
        uint256 quote = router.quoteIn(500, 0.004 ether);
        bytes4 m = LeaseGasDexAdapter.DexMismatch.selector;
        _dexLie(router.SHORT_OUT(), quote + 1e6, abi.encodeWithSelector(m, uint8(5)));
        _dexLie(router.EXTRA_OUT(), quote + 1e6, abi.encodeWithSelector(m, uint8(5)));
        _dexLie(router.UNDER_REPORT(), quote + 1e6, abi.encodeWithSelector(m, uint8(2)));
        _dexLie(router.OVER_REPORT(), quote + 1e6, abi.encodeWithSelector(m, uint8(2)));
        _dexLie(router.OVER_REPORT(), quote, abi.encodeWithSelector(m, uint8(1)));       // reports above the maximum
        _dexLie(router.PULL_EXTRA(), quote + 1e6, abi.encodeWithSelector(m, uint8(2)));
        _dexLie(router.KEEP_IN_ROUTER(), quote + 1e6, abi.encodeWithSelector(m, uint8(3)));
    }

    function test_routerPushingEth_isRefused() public {
        vm.deal(address(router), 1 ether);
        router.setMode(router.SEND_ETH());
        _expectFail(_intent(payer, appOwner, 0.001 ether, 10e6, 500), bytes("eth refused"));
        _assertUntouched();
    }

    function test_unwrapShortfall_reverts() public {
        weth.setUnwrapShortBy(1);
        _expectFail(_intent(payer, appOwner, 0.004 ether, 20e6, 500),
            abi.encodeWithSelector(LeaseGasDexAdapter.UnwrapMismatch.selector));
        _assertUntouched();
    }

    // =================================================================================================================
    // ETH acceptance, forced balances, donations
    // =================================================================================================================

    function test_unexpectedEthRefused() public {
        PlainSender s = new PlainSender();
        vm.deal(address(this), 1 ether);
        (bool ok, bytes memory ret) = s.push{value: 1}(payable(address(adapter)));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(LeaseGasDexAdapter.UnexpectedEth.selector));
        // the pinned WETH itself, outside an unwrap
        vm.expectRevert(bytes("poke refused"));
        weth.poke{value: 1}(address(adapter));
        // unknown selector: no fallback
        (ok,) = s.callData(address(adapter), hex"deadbeef");
        assertFalse(ok);
        assertEq(address(adapter).balance, 0);
    }

    function test_forcedEthAndDonations_neverSpentOrCredited() public {
        vm.deal(address(adapter), 1 ether);           // selfdestruct / coinbase stand-in
        usdc.mint(address(adapter), 7e6);
        _giveWeth(address(adapter), 0.3 ether);
        uint256 quote = router.quoteIn(500, 0.004 ether);
        uint256 spent = _fund(adapter, _intent(payer, appOwner, 0.004 ether, quote + 2e6, 500));

        assertEq(spent, quote);
        assertEq(usdc.balanceOf(payer), 1_000e6 - quote, "payer refunded only its own unused input");
        assertEq(address(adapter).balance, 1 ether);
        assertEq(usdc.balanceOf(address(adapter)), 7e6);
        assertEq(weth.balanceOf(address(adapter)), 0.3 ether);
        assertEq(_credited(appOwner), 0.004 ether, "forced ETH not deposited");
    }

    function test_routerAllowanceCannotReachDonatedUsdc() public {
        // a donation sits in the adapter; the router's allowance is exactly maxUsdcIn6, so the swap cannot use it
        usdc.mint(address(adapter), 500e6);
        router.setMode(router.PULL_EXTRA());
        uint256 quote = router.quoteIn(500, 0.004 ether);
        _expectFail(_intent(payer, appOwner, 0.004 ether, quote, 500), bytes("STF"));
        assertEq(usdc.balanceOf(address(adapter)), 500e6);
        assertEq(usdc.balanceOf(payer), 1_000e6);
    }

    // =================================================================================================================
    // token misbehaviour
    // =================================================================================================================

    function test_feeOnTransfer_reverts() public {
        usdc.setFeeBps(10);
        _expectFail(_intent(payer, appOwner, 0.001 ether, 10e6, 500),
            abi.encodeWithSelector(LeaseGasDexAdapter.TokenTransferFailed.selector));
        usdc.setFeeBps(0);
        vm.prank(payer);
        usdc.approve(address(adapter), 0);
        _assertUntouched();
    }

    function test_transferFromReturnsFalse_reverts() public {
        usdc.setTransferFromReturnsFalse(true);
        _expectFail(_intent(payer, appOwner, 0.001 ether, 10e6, 500),
            abi.encodeWithSelector(LeaseGasDexAdapter.TokenTransferFailed.selector));
    }

    function test_insufficientAllowanceOrBalance_reverts() public {
        DexGasIntent memory i = _intent(payer, appOwner, 0.001 ether, 10e6, 500);
        vm.prank(payer);
        usdc.approve(address(adapter), 10e6 - 1);
        vm.expectRevert(LeaseGasDexAdapter.TokenTransferFailed.selector);
        vm.prank(payer);
        adapter.fundGas(i);
        i.maxUsdcIn6 = 1_000e6 + 1;
        _expectFail(i, abi.encodeWithSelector(LeaseGasDexAdapter.TokenTransferFailed.selector));
        vm.prank(payer);
        usdc.approve(address(adapter), 0);
        _assertUntouched();
    }

    function test_approveFailures_revert() public {
        bytes memory bad = abi.encodeWithSelector(LeaseGasDexAdapter.ApproveFailed.selector);
        DexGasIntent memory i = _intent(payer, appOwner, 0.001 ether, 10e6, 500);
        // modes are switched AFTER the payer's own approval
        for (uint256 k; k < 3; ++k) {
            _approve(adapter, i);
            if (k == 0) usdc.setApproveReturnsFalse(true);
            if (k == 1) usdc.setApproveReverts(true);
            if (k == 2) usdc.setApproveIgnored(true);
            vm.expectRevert(bad);
            vm.prank(payer);
            adapter.fundGas(i);
            usdc.setApproveReturnsFalse(false);
            usdc.setApproveReverts(false);
            usdc.setApproveIgnored(false);
        }
        vm.prank(payer);
        usdc.approve(address(adapter), 0);
        _assertUntouched();
    }

    function test_noReturnToken_supported() public {
        DexGasIntent memory i = _intent(payer, appOwner, 0.004 ether, 20e6, 500);
        _approve(adapter, i);
        usdc.setNoReturn(true);
        vm.prank(payer);
        uint256 spent = adapter.fundGas(i);
        assertEq(spent, router.quoteIn(500, 0.004 ether));
        assertEq(usdc.balanceOf(payer), 1_000e6 - spent);
        assertEq(usdc.allowance(address(adapter), address(router)), 0);
        assertEq(_credited(appOwner), 0.004 ether);
    }

    function test_refundFailure_revertsEverything() public {
        usdc.setBlockIncoming(payer, true);
        _expectFail(_intent(payer, appOwner, 0.004 ether, 20e6, 500),
            abi.encodeWithSelector(LeaseGasDexAdapter.RefundFailed.selector));
        assertEq(usdc.balanceOf(payer), 1_000e6);
        assertEq(_credited(appOwner), 0);
        // with nothing to refund, a payer that cannot receive USDC can still buy exactly
        uint256 quote = router.quoteIn(500, 0.004 ether);
        _fund(adapter, _intent(payer, appOwner, 0.004 ether, quote, 500));
        assertEq(usdc.balanceOf(payer), 1_000e6 - quote);
        assertEq(_credited(appOwner), 0.004 ether);
    }

    // =================================================================================================================
    // owner of record
    // =================================================================================================================

    function test_ownerChangedBefore_orUnknown() public {
        address next = makeAddr("next");
        ledger.setOwner(ID, next);
        _expectFail(_intent(payer, appOwner, 0.001 ether, 10e6, 500),
            abi.encodeWithSelector(LeaseGasDexAdapter.OwnerMismatch.selector, next, appOwner));
        DexGasIntent memory i = _intent(payer, appOwner, 0.001 ether, 10e6, 500);
        i.deployment = keccak256("nope");
        _expectFail(i, abi.encodeWithSelector(LeaseGasDexAdapter.UnknownDeployment.selector, i.deployment));
        vm.prank(payer);
        usdc.approve(address(adapter), 0);
        _assertUntouched();
    }

    function test_ownerMovesInsideDeposit_beforeCredit() public {
        reserve.setMode(reserve.FLIP_BEFORE());
        _expectFail(_intent(payer, appOwner, 0.001 ether, 10e6, 500),
            abi.encodeWithSelector(LeaseGasDexAdapter.ReserveMismatch.selector));
        _assertUntouched();
        assertEq(_credited(reserve.OTHER()), 0);
    }

    function test_ownerMovesInsideDeposit_afterCredit() public {
        reserve.setMode(reserve.FLIP_AFTER());
        _expectFail(_intent(payer, appOwner, 0.001 ether, 10e6, 500),
            abi.encodeWithSelector(LeaseGasDexAdapter.OwnerMismatch.selector, reserve.OTHER(), appOwner));
        _assertUntouched();
    }

    function test_reserveUnderCreditsOrDown() public {
        reserve.setMode(reserve.UNDER_CREDIT());
        _expectFail(_intent(payer, appOwner, 0.001 ether, 10e6, 500),
            abi.encodeWithSelector(LeaseGasDexAdapter.ReserveMismatch.selector));
        reserve.setMode(reserve.DOWN());
        _expectFail(_intent(payer, appOwner, 0.001 ether, 10e6, 500), bytes("reserve down"));
        vm.prank(payer);
        usdc.approve(address(adapter), 0);
        _assertUntouched();
    }

    // =================================================================================================================
    // reentrancy (token pull, token refund, router, reserve)
    // =================================================================================================================

    function _reentryData() internal view returns (bytes memory) {
        return abi.encodeCall(LeaseGasDexAdapter.fundGas, (_intent(payer, appOwner, 0.001 ether, 10e6, 500)));
    }

    function test_tokenCallbacksCannotReenter() public {
        bytes memory reentrant = abi.encodeWithSelector(LeaseGasDexAdapter.Reentrant.selector);
        for (uint256 k; k < 2; ++k) {
            usdc.setHook(address(adapter), _reentryData(), k == 1);   // 0: inside the pull, 1: inside the refund
            uint256 spent = _fund(adapter, _intent(payer, appOwner, 0.001 ether, 10e6, 500));
            assertFalse(usdc.hookOk());
            assertEq(usdc.hookRet(), reentrant);
            assertEq(spent, router.quoteIn(500, 0.001 ether));
        }
        assertEq(_credited(appOwner), 0.002 ether);
    }

    function test_routerCannotReenter() public {
        router.setMode(router.REENTER());
        router.setReenter(address(adapter), _reentryData());
        _fund(adapter, _intent(payer, appOwner, 0.001 ether, 10e6, 500));
        assertFalse(router.reentryOk());
        assertEq(router.reentryRet(), abi.encodeWithSelector(LeaseGasDexAdapter.Reentrant.selector));
        assertEq(_credited(appOwner), 0.001 ether);
    }

    function test_reserveCannotReenter() public {
        reserve.setMode(reserve.REENTER());
        reserve.setReenter(address(adapter), _reentryData());
        _fund(adapter, _intent(payer, appOwner, 0.001 ether, 10e6, 500));
        assertFalse(reserve.reentryOk());
        assertEq(reserve.reentryRet(), abi.encodeWithSelector(LeaseGasDexAdapter.Reentrant.selector));
        assertEq(_credited(appOwner), 0.001 ether);
    }

    // =================================================================================================================
    // constructor bindings, ABI
    // =================================================================================================================

    function _deploy(address u, address w, address r, address f, address l, address res, uint256 m, uint8 code) internal {
        vm.expectRevert(abi.encodeWithSelector(LeaseGasDexAdapter.BadBinding.selector, code));
        new LeaseGasDexAdapter(u, w, r, f, l, res, m);
    }

    function test_constructorValidation() public {
        address u = address(usdc); address w = address(weth); address r = address(router);
        address f = address(factory); address l = address(ledger); address res = address(reserve);
        _deploy(makeAddr("eoa"), w, r, f, l, res, MAX_ETH, 1);
        _deploy(u, w, r, f, address(0), res, MAX_ETH, 1);
        _deploy(u, u, r, f, l, res, MAX_ETH, 1);
        _deploy(u, w, r, f, l, l, MAX_ETH, 1);
        _deploy(u, w, r, f, l, address(new MockReserve(address(new MockLedger()))), MAX_ETH, 2);
        _deploy(address(new MockUSDC(18)), w, r, f, l, res, MAX_ETH, 3);
        _deploy(u, address(new MockUSDC(6)), r, f, l, res, MAX_ETH, 3);
        _deploy(u, w, address(new MockSwapRouter02(address(new MockV3Factory()), w)), f, l, res, MAX_ETH, 4);
        _deploy(u, w, address(new MockSwapRouter02(f, address(new MockWETH9()))), f, l, res, MAX_ETH, 4);
        _deploy(u, w, r, f, l, res, 0, 5);
        _deploy(u, w, r, f, l, res, uint256(type(uint96).max) + 1, 5);
        LeaseGasDexAdapter ok = new LeaseGasDexAdapter(u, w, r, f, l, res, type(uint96).max);
        assertEq(ok.maxEthOut(), type(uint96).max);
        assertEq(ok.swapRouter(), r);
        assertEq(ok.factory(), f);
        assertEq(ok.weth(), w);
    }

    function test_abiSelectors() public pure {
        // SwapRouter02 / IV3SwapRouter: seven fields, NO deadline (the v1 SwapRouter's struct has eight)
        assertTrue(ISwapRouter02.exactOutputSingle.selector
            == bytes4(keccak256("exactOutputSingle((address,address,uint24,address,uint256,uint256,uint160))")));
        assertTrue(ISwapRouter02.exactOutputSingle.selector
            != bytes4(keccak256("exactOutputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))")));
        assertTrue(LeaseGasDexAdapter.fundGas.selector
            == bytes4(keccak256("fundGas((address,bytes32,address,uint256,uint256,uint24,uint64))")));
    }

    // =================================================================================================================
    // successor-vault shape (illustrative)
    // =================================================================================================================

    function test_successorVaultShape_chargesActualWithinLimits() public {
        // ceiling 2,500 USDC/ETH, per-op 15 USDC, budget 30 USDC
        MockSuccessorVault vault = new MockSuccessorVault(adapter, usdc, 15e6, 30e6, 2_500e6);
        ledger.setOwner(ID, address(vault));
        usdc.mint(address(vault), 30e6);

        uint256 quote = router.quoteIn(500, 0.004 ether);
        uint256 spent = vault.fundGas(_intent(address(vault), address(vault), 0.004 ether, 10e6, 500));
        assertEq(spent, quote);
        assertEq(vault.charged6(), quote, "budget charged the actual debit, not the maximum");
        assertEq(vault.budget6(), 30e6 - quote);
        assertEq(usdc.balanceOf(address(vault)), 30e6 - quote);
        assertEq(_credited(address(vault)), 0.004 ether);

        vm.expectRevert(bytes("per-op"));
        vault.fundGas(_intent(address(vault), address(vault), 0.004 ether, 15e6 + 1, 500));
        vm.expectRevert(bytes("price"));
        vault.fundGas(_intent(address(vault), address(vault), 0.004 ether, 10_000_001, 500));   // > 2,500/ETH
        // the pool price rising above the ceiling is caught by the worst-case bound, not by the adapter
        router.setPrice(500, 3_000e6);
        vm.expectRevert(bytes("Too much requested"));
        vault.fundGas(_intent(address(vault), address(vault), 0.004 ether, 10e6, 500));
        assertEq(vault.charged6(), quote);
    }

    // =================================================================================================================
    // fuzz: conservation over price, size, fee tier, slack and pre-existing balances
    // =================================================================================================================

    function testFuzz_conservation(uint256 ethOut, uint256 slack, uint8 feeIdx, uint256 price, uint96 donUsdc,
        uint96 donWeth, uint96 forced) public
    {
        ethOut = bound(ethOut, 1, MAX_ETH);
        uint24 fee = [uint24(100), 500, 3000][feeIdx % 3];
        router.setPrice(fee, bound(price, 1e6, 100_000e6));
        uint256 quote = router.quoteIn(fee, ethOut);
        slack = bound(slack, 0, 100e6);
        usdc.mint(payer, quote + slack);
        uint256 payerBefore = usdc.balanceOf(payer);
        donUsdc = uint96(bound(donUsdc, 0, 1_000e6));
        donWeth = uint96(bound(donWeth, 0, 10 ether));
        forced = uint96(bound(forced, 0, 10 ether));
        usdc.mint(address(adapter), donUsdc);
        if (donWeth > 0) _giveWeth(address(adapter), donWeth);
        vm.deal(address(adapter), forced);
        address pool = _poolOf(fee);
        uint256 poolUsdc = usdc.balanceOf(pool);
        uint256 poolWeth = weth.balanceOf(pool);

        uint256 spent = _fund(adapter, _intent(payer, appOwner, ethOut, quote + slack, fee));

        assertEq(spent, quote);
        assertLe(spent, quote + slack);
        assertEq(payerBefore - usdc.balanceOf(payer), spent, "payer net debit == pool input");
        assertEq(usdc.balanceOf(pool) - poolUsdc, spent, "pool received exactly the debit");
        assertEq(poolWeth - weth.balanceOf(pool), ethOut);
        assertEq(_credited(appOwner), ethOut);
        assertEq(address(reserve).balance, ethOut);
        assertEq(usdc.balanceOf(address(adapter)), donUsdc);
        assertEq(weth.balanceOf(address(adapter)), donWeth);
        assertEq(address(adapter).balance, forced);
        assertEq(usdc.allowance(address(adapter), address(router)), 0);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function testFuzz_belowQuote_neverDebits(uint256 ethOut, uint256 shortBy) public {
        ethOut = bound(ethOut, 1e12, MAX_ETH);
        uint256 quote = router.quoteIn(500, ethOut);
        shortBy = bound(shortBy, 1, quote);
        DexGasIntent memory i = _intent(payer, appOwner, ethOut, quote - shortBy, 500);
        _approve(adapter, i);
        vm.prank(payer);
        (bool ok,) = address(adapter).call(abi.encodeCall(LeaseGasDexAdapter.fundGas, (i)));
        assertFalse(ok);
        vm.prank(payer);
        usdc.approve(address(adapter), 0);
        _assertUntouched();
    }
    // Root regression: token refund is the last mutable external call. An owner change there must roll back.
    function test_rootRefundOwnerChangeMustRevert() public {
        usdc.setHook(address(ledger), abi.encodeWithSignature("setOwner(bytes32,address)", ID, stranger), true);
        _expectFail(_intent(payer, appOwner, 0.001 ether, 10e6, 500),
            abi.encodeWithSelector(LeaseGasDexAdapter.OwnerMismatch.selector, stranger, appOwner));
        _assertUntouched();
        assertEq(ledger.ownerOf(ID), appOwner);
    }

}
