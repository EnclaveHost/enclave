// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {LeaseGasFundingRouter} from "../src/LeaseGasFundingRouter.sol";
import {LeaseGasQuote} from "../src/ILeaseGasFundingRouter.sol";
import {MockToken6, NoReturnToken6, MockLedger, MockReserve, RejectEth, ReentrantProvider, MockSessionPayer}
    from "./mocks/RouterMocks.sol";

abstract contract RouterFixture is Test {
    uint256 constant P1_PK = 0xA11CE;
    uint256 constant P2_PK = 0xB0B;
    bytes32 constant ID = keccak256("deployment-1");
    uint256 constant N = ((uint256(0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFE) << 128) | 0xBAAEDCE6AF48A03BBFD25E8CD0364141);   // secp256k1 order

    MockToken6 usdc;
    MockLedger ledger;
    MockReserve reserve;
    LeaseGasFundingRouter router;
    address p1;
    address p2;
    address payer = makeAddr("payer");
    address appOwner = makeAddr("appOwner");
    address attacker = makeAddr("attacker");

    function setUp() public virtual {
        vm.chainId(8453);
        vm.warp(1_800_000_000);
        p1 = vm.addr(P1_PK);
        p2 = vm.addr(P2_PK);
        usdc = new MockToken6(6);
        ledger = new MockLedger();
        reserve = new MockReserve(address(ledger));
        router = new LeaseGasFundingRouter(address(usdc), address(ledger), address(reserve), 1 ether);
        ledger.setOwner(ID, appOwner);
        usdc.mint(payer, 1_000e6);
        vm.prank(payer);
        usdc.approve(address(router), type(uint256).max);
        vm.deal(p1, 10 ether);
        vm.deal(p2, 10 ether);
        vm.prank(p1);
        router.provide{value: 1 ether}();
        vm.prank(p2);
        router.provide{value: 1 ether}();
    }

    function _quote(address provider, uint256 usdcIn6, uint256 ethOut, uint256 nonce)
        internal view returns (LeaseGasQuote memory q)
    {
        q = LeaseGasQuote({
            payer: payer, deployment: ID, expectedOwner: appOwner, usdcIn6: usdcIn6, ethOut: ethOut, nonce: nonce,
            expiry: uint64(block.timestamp + 5 minutes), provider: provider
        });
    }

    function _sign(LeaseGasFundingRouter r, LeaseGasQuote memory q, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(pk, r.quoteDigest(q));
        return abi.encodePacked(rr, s, v);
    }

    function _reserveBal(address o) internal view returns (uint256) {
        return reserve.bal(reserve.key(ID, o));
    }

    /// Everything a failed fill must leave untouched.
    function _assertUntouched(LeaseGasQuote memory q, uint256 payerUsdc, uint256 provUsdc, uint256 provLiq) internal view {
        assertEq(usdc.balanceOf(q.payer), payerUsdc, "payer USDC moved");
        assertEq(usdc.balanceOf(q.provider), provUsdc, "provider USDC moved");
        assertEq(router.liquidityOf(q.provider), provLiq, "liquidity moved");
        assertEq(router.totalLiquidity(), address(router).balance, "router ETH != total");
        assertFalse(router.nonceUsed(q.provider, q.nonce), "nonce consumed");
        assertEq(_reserveBal(appOwner), 0, "reserve credited");
        assertEq(address(reserve).balance, 0, "reserve got ETH");
    }
}

contract LeaseGasFundingRouterTest is RouterFixture {
    // ---------------------------------------------------------------------------------------------------------------
    // happy path, digest, payer contract
    // ---------------------------------------------------------------------------------------------------------------

    function test_fill_movesExactAmountsAtomically() public {
        LeaseGasQuote memory q = _quote(p1, 30e6, 0.01 ether, 1);
        bytes memory sig = _sign(router, q, P1_PK);
        bytes32 expectDigest = router.quoteDigest(q);

        vm.expectEmit(address(router));
        emit LeaseGasFundingRouter.Filled(ID, p1, payer, appOwner, 30e6, 0.01 ether, 1, expectDigest);
        vm.prank(payer);
        bytes32 d = router.fill(q, sig);

        assertEq(d, expectDigest);
        assertEq(usdc.balanceOf(payer), 970e6);
        assertEq(usdc.balanceOf(p1), 30e6);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(_reserveBal(appOwner), 0.01 ether);
        assertEq(address(reserve).balance, 0.01 ether);
        assertEq(router.liquidityOf(p1), 0.99 ether);
        assertEq(router.liquidityOf(p2), 1 ether);
        assertEq(router.totalLiquidity(), 1.99 ether);
        assertEq(address(router).balance, 1.99 ether);
        assertTrue(router.nonceUsed(p1, 1));
    }

    /// The digest is recomputed here from the published type string, independently of the contract's constants.
    function test_digest_matchesPublishedTypedData() public view {
        LeaseGasQuote memory q = _quote(p1, 30e6, 0.01 ether, 7);
        bytes32 dom = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("Enclave LeaseGasFundingRouter"), keccak256("1"), uint256(8453), address(router)));
        bytes32 th = keccak256("LeaseGasQuote(address payer,bytes32 deployment,address expectedOwner,uint256 usdcIn6,"
            "uint256 ethOut,uint256 nonce,uint64 expiry,address provider)");
        bytes32 sh = keccak256(abi.encode(th, q.payer, q.deployment, q.expectedOwner, q.usdcIn6, q.ethOut, q.nonce,
            q.expiry, q.provider));
        assertEq(router.quoteDigest(q), keccak256(abi.encodePacked("\x19\x01", dom, sh)));
        assertEq(router.domainSeparator(), dom);
    }

    function test_sessionPayerContract_exactAllowanceBackToZero() public {
        MockSessionPayer vault = new MockSessionPayer();
        usdc.mint(address(vault), 30e6);
        ledger.setOwner(ID, address(vault));              // a vault-held deployment
        LeaseGasQuote memory q = _quote(p1, 30e6, 0.01 ether, 1);
        q.payer = address(vault);
        q.expectedOwner = address(vault);
        bytes memory sig = _sign(router, q, P1_PK);
        vault.fundGas(router, usdc, q, sig);
        assertEq(usdc.balanceOf(address(vault)), 0);
        assertEq(usdc.allowance(address(vault), address(router)), 0);
        assertEq(reserve.bal(reserve.key(ID, address(vault))), 0.01 ether);
    }

    function test_payerNeedNotOwnDeployment_creditGoesToOwnerOfRecord() public {
        // e.g. a session vault funding gas for a deployment the owner's WALLET holds: credited to the wallet's key
        LeaseGasQuote memory q = _quote(p2, 5e6, 0.002 ether, 9);
        bytes memory sig = _sign(router, q, P2_PK);
        vm.prank(payer);
        router.fill(q, sig);
        assertEq(_reserveBal(appOwner), 0.002 ether);
        assertEq(_reserveBal(payer), 0);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // binding: payer, signer, fields, chain, router
    // ---------------------------------------------------------------------------------------------------------------

    function test_thirdPartyCannotSubmitPayersQuote() public {
        LeaseGasQuote memory q = _quote(p1, 30e6, 0.01 ether, 1);
        bytes memory sig = _sign(router, q, P1_PK);
        vm.expectRevert(LeaseGasFundingRouter.NotPayer.selector);
        vm.prank(attacker);
        router.fill(q, sig);
        _assertUntouched(q, 1_000e6, 0, 1 ether);
    }

    function test_thirdPartyCannotRedirectQuoteToItself() public {
        LeaseGasQuote memory q = _quote(p1, 30e6, 0.01 ether, 1);
        bytes memory sig = _sign(router, q, P1_PK);
        q.payer = attacker;                               // the signature no longer matches
        vm.expectRevert(LeaseGasFundingRouter.BadSignature.selector);
        vm.prank(attacker);
        router.fill(q, sig);
    }

    /// The signature is checked before liquidity and owner of record, so each tampered field fails on it alone.
    function test_tamperedFieldsFailSignature() public {
        LeaseGasQuote memory base = _quote(p1, 30e6, 0.01 ether, 1);
        bytes memory sig = _sign(router, base, P1_PK);
        LeaseGasQuote[] memory bad = new LeaseGasQuote[](6);
        for (uint256 i = 0; i < 6; i++) bad[i] = _quote(p1, 30e6, 0.01 ether, 1);
        bad[0].usdcIn6 = 29e6;
        bad[1].ethOut = 0.02 ether;
        bad[2].deployment = keccak256("deployment-2");
        bad[3].expectedOwner = attacker;
        bad[4].nonce = 2;
        bad[5].expiry = base.expiry - 1;
        for (uint256 i = 0; i < 6; i++) {
            vm.expectRevert(LeaseGasFundingRouter.BadSignature.selector);
            vm.prank(payer);
            router.fill(bad[i], sig);
        }
        _assertUntouched(base, 1_000e6, 0, 1 ether);
    }

    function test_wrongSigner() public {
        LeaseGasQuote memory q = _quote(p1, 30e6, 0.01 ether, 1);
        bytes memory sig = _sign(router, q, P2_PK);       // p2 signs a quote naming p1's pool
        vm.expectRevert(LeaseGasFundingRouter.BadSignature.selector);
        vm.prank(payer);
        router.fill(q, sig);
    }

    function test_highS_badLength_badV() public {
        LeaseGasQuote memory q = _quote(p1, 30e6, 0.01 ether, 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(P1_PK, router.quoteDigest(q));
        bytes memory twin = abi.encodePacked(r, bytes32(N - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(LeaseGasFundingRouter.BadSignature.selector);
        vm.prank(payer);
        router.fill(q, twin);

        bytes memory short = abi.encodePacked(r, s);
        vm.expectRevert(LeaseGasFundingRouter.BadSignature.selector);
        vm.prank(payer);
        router.fill(q, short);

        bytes memory badV = abi.encodePacked(r, s, uint8(v - 27));
        vm.expectRevert(LeaseGasFundingRouter.BadSignature.selector);
        vm.prank(payer);
        router.fill(q, badV);

        bytes memory good = abi.encodePacked(r, s, v);
        vm.prank(payer);
        router.fill(q, good);
        assertEq(_reserveBal(appOwner), 0.01 ether);
    }

    function test_wrongChain() public {
        LeaseGasQuote memory q = _quote(p1, 30e6, 0.01 ether, 1);
        bytes memory sig = _sign(router, q, P1_PK);       // signed for chain 8453
        vm.chainId(1);
        vm.expectRevert(LeaseGasFundingRouter.BadSignature.selector);
        vm.prank(payer);
        router.fill(q, sig);
    }

    function test_wrongRouter() public {
        LeaseGasFundingRouter other = new LeaseGasFundingRouter(address(usdc), address(ledger), address(reserve), 1 ether);
        LeaseGasQuote memory q = _quote(p1, 30e6, 0.01 ether, 1);
        bytes memory sig = _sign(other, q, P1_PK);        // a quote for a different router instance
        vm.expectRevert(LeaseGasFundingRouter.BadSignature.selector);
        vm.prank(payer);
        router.fill(q, sig);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // replay, nonce, expiry, bounds
    // ---------------------------------------------------------------------------------------------------------------

    function test_replay() public {
        LeaseGasQuote memory q = _quote(p1, 30e6, 0.01 ether, 1);
        bytes memory sig = _sign(router, q, P1_PK);
        vm.prank(payer);
        router.fill(q, sig);
        vm.expectRevert(LeaseGasFundingRouter.NonceUsed.selector);
        vm.prank(payer);
        router.fill(q, sig);
        assertEq(_reserveBal(appOwner), 0.01 ether);
        assertEq(usdc.balanceOf(payer), 970e6);
    }

    function test_nonceReuseWithDifferentTerms() public {
        LeaseGasQuote memory a = _quote(p1, 30e6, 0.01 ether, 1);
        LeaseGasQuote memory b = _quote(p1, 1e6, 0.5 ether, 1);
        bytes memory sa = _sign(router, a, P1_PK);
        bytes memory sb = _sign(router, b, P1_PK);
        vm.prank(payer);
        router.fill(a, sa);
        vm.expectRevert(LeaseGasFundingRouter.NonceUsed.selector);
        vm.prank(payer);
        router.fill(b, sb);
    }

    function test_noncesArePerProvider() public {
        LeaseGasQuote memory a = _quote(p1, 30e6, 0.01 ether, 1);
        LeaseGasQuote memory b = _quote(p2, 30e6, 0.01 ether, 1);
        bytes memory sa = _sign(router, a, P1_PK);
        bytes memory sb = _sign(router, b, P2_PK);
        vm.prank(payer);
        router.fill(a, sa);
        vm.prank(payer);
        router.fill(b, sb);
        assertEq(_reserveBal(appOwner), 0.02 ether);
    }

    function test_cancelNonce() public {
        LeaseGasQuote memory q = _quote(p1, 30e6, 0.01 ether, 1);
        bytes memory sig = _sign(router, q, P1_PK);
        vm.prank(p1);
        router.cancelNonce(1);
        vm.expectRevert(LeaseGasFundingRouter.NonceUsed.selector);
        vm.prank(payer);
        router.fill(q, sig);
        // a cancel touches only the caller's own nonce namespace
        vm.prank(attacker);
        router.cancelNonce(2);
        assertFalse(router.nonceUsed(p1, 2));
        assertTrue(router.nonceUsed(attacker, 2));
    }

    function test_expiry_boundary() public {
        LeaseGasQuote memory q = _quote(p1, 30e6, 0.01 ether, 1);
        bytes memory sig = _sign(router, q, P1_PK);
        vm.warp(q.expiry + 1);
        vm.expectRevert(LeaseGasFundingRouter.QuoteExpired.selector);
        vm.prank(payer);
        router.fill(q, sig);
        vm.warp(q.expiry);                                // inclusive
        vm.prank(payer);
        router.fill(q, sig);
    }

    function test_expiryTooFar() public {
        LeaseGasQuote memory q = _quote(p1, 30e6, 0.01 ether, 1);
        q.expiry = uint64(block.timestamp + 15 minutes + 1);
        bytes memory sig = _sign(router, q, P1_PK);
        vm.expectRevert(LeaseGasFundingRouter.ExpiryTooFar.selector);
        vm.prank(payer);
        router.fill(q, sig);
        // the bound is relative to the fill: one second later the same quote is inside it
        vm.warp(block.timestamp + 1);
        vm.prank(payer);
        router.fill(q, sig);
    }

    function test_amountBounds() public {
        uint256[3] memory usdcs = [uint256(0), 30e6, 30e6];
        uint256[3] memory eths = [uint256(0.01 ether), 0, 1 ether + 1];   // last: above maxEthOut
        vm.prank(p1);
        router.provide{value: 2 ether}();
        for (uint256 i = 0; i < 3; i++) {
            LeaseGasQuote memory q = _quote(p1, usdcs[i], eths[i], 10 + i);
            bytes memory sig = _sign(router, q, P1_PK);
            vm.expectRevert(LeaseGasFundingRouter.BadAmount.selector);
            vm.prank(payer);
            router.fill(q, sig);
        }
    }

    function test_badParties() public {
        // provider == payer: the exact-delta check would be meaningless
        LeaseGasQuote memory q = _quote(p1, 30e6, 0.01 ether, 1);
        q.payer = p1;
        bytes memory sig = _sign(router, q, P1_PK);
        vm.expectRevert(LeaseGasFundingRouter.BadParty.selector);
        vm.prank(p1);
        router.fill(q, sig);

        LeaseGasQuote memory z = _quote(p1, 30e6, 0.01 ether, 2);
        z.expectedOwner = address(0);
        bytes memory zs = _sign(router, z, P1_PK);
        vm.expectRevert(LeaseGasFundingRouter.BadParty.selector);
        vm.prank(payer);
        router.fill(z, zs);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // owner of record
    // ---------------------------------------------------------------------------------------------------------------

    function test_ownerTransferredBeforeFill() public {
        LeaseGasQuote memory q = _quote(p1, 30e6, 0.01 ether, 1);
        bytes memory sig = _sign(router, q, P1_PK);
        ledger.setOwner(ID, attacker);
        vm.expectRevert(abi.encodeWithSelector(LeaseGasFundingRouter.OwnerMismatch.selector, attacker, appOwner));
        vm.prank(payer);
        router.fill(q, sig);
        assertEq(reserve.bal(reserve.key(ID, attacker)), 0);
        assertEq(usdc.balanceOf(payer), 1_000e6);
    }

    function test_unknownDeployment() public {
        LeaseGasQuote memory q = _quote(p1, 30e6, 0.01 ether, 1);
        q.deployment = keccak256("nope");
        bytes memory sig = _sign(router, q, P1_PK);
        vm.expectRevert(abi.encodeWithSelector(LeaseGasFundingRouter.UnknownDeployment.selector, q.deployment));
        vm.prank(payer);
        router.fill(q, sig);
    }

    function test_ownerMovesInsideDeposit_beforeCredit() public {
        reserve.setMode(reserve.FLIP_BEFORE());
        LeaseGasQuote memory q = _quote(p1, 30e6, 0.01 ether, 1);
        bytes memory sig = _sign(router, q, P1_PK);
        vm.expectRevert(LeaseGasFundingRouter.ReserveMismatch.selector);
        vm.prank(payer);
        router.fill(q, sig);
        assertEq(ledger.ownerOf(ID), appOwner);           // the flip itself was rolled back
        _assertUntouched(q, 1_000e6, 0, 1 ether);
    }

    function test_ownerMovesInsideDeposit_afterCredit() public {
        reserve.setMode(reserve.FLIP_AFTER());
        address other = reserve.OTHER();
        LeaseGasQuote memory q = _quote(p1, 30e6, 0.01 ether, 1);
        bytes memory sig = _sign(router, q, P1_PK);
        vm.expectRevert(abi.encodeWithSelector(LeaseGasFundingRouter.OwnerMismatch.selector, other, appOwner));
        vm.prank(payer);
        router.fill(q, sig);
        _assertUntouched(q, 1_000e6, 0, 1 ether);
    }

    function test_reserveUnderCredits() public {
        reserve.setMode(reserve.UNDER_CREDIT());
        LeaseGasQuote memory q = _quote(p1, 30e6, 0.01 ether, 1);
        bytes memory sig = _sign(router, q, P1_PK);
        vm.expectRevert(LeaseGasFundingRouter.ReserveMismatch.selector);
        vm.prank(payer);
        router.fill(q, sig);
        _assertUntouched(q, 1_000e6, 0, 1 ether);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // liquidity, partial failures
    // ---------------------------------------------------------------------------------------------------------------

    function test_insufficientLiquidity_cannotUseAnotherProvidersPool() public {
        vm.prank(p1);
        router.withdraw(0.5 ether, payable(p1));          // p1 has 0.5; the router holds 1.5 in total
        LeaseGasQuote memory q = _quote(p1, 30e6, 1 ether, 1);
        bytes memory sig = _sign(router, q, P1_PK);
        vm.expectRevert(abi.encodeWithSelector(LeaseGasFundingRouter.InsufficientLiquidity.selector, 1 ether, 0.5 ether));
        vm.prank(payer);
        router.fill(q, sig);
        _assertUntouched(q, 1_000e6, 0, 0.5 ether);
        assertEq(router.liquidityOf(p2), 1 ether);
    }

    function test_providerOutage_payerUsesAnotherProvider() public {
        LeaseGasQuote memory a = _quote(p1, 30e6, 0.01 ether, 1);
        bytes memory sa = _sign(router, a, P1_PK);
        vm.prank(p1);
        router.withdraw(1 ether, payable(p1));            // p1 pulls out (or simply stops quoting)
        vm.expectRevert(abi.encodeWithSelector(LeaseGasFundingRouter.InsufficientLiquidity.selector, 0.01 ether, 0));
        vm.prank(payer);
        router.fill(a, sa);
        LeaseGasQuote memory b = _quote(p2, 31e6, 0.01 ether, 1);
        bytes memory sb = _sign(router, b, P2_PK);
        vm.prank(payer);
        router.fill(b, sb);
        assertEq(_reserveBal(appOwner), 0.01 ether);
        assertEq(usdc.balanceOf(payer), 1_000e6 - 31e6);
        assertEq(usdc.balanceOf(p1), 0);
    }

    function test_insufficientAllowance_revertsEverything() public {
        vm.prank(payer);
        usdc.approve(address(router), 29e6);
        LeaseGasQuote memory q = _quote(p1, 30e6, 0.01 ether, 1);
        bytes memory sig = _sign(router, q, P1_PK);
        vm.expectRevert(LeaseGasFundingRouter.TokenTransferFailed.selector);
        vm.prank(payer);
        router.fill(q, sig);
        _assertUntouched(q, 1_000e6, 0, 1 ether);
    }

    function test_insufficientPayerBalance() public {
        LeaseGasQuote memory q = _quote(p1, 1_001e6, 0.01 ether, 1);
        bytes memory sig = _sign(router, q, P1_PK);
        vm.expectRevert(LeaseGasFundingRouter.TokenTransferFailed.selector);
        vm.prank(payer);
        router.fill(q, sig);
        _assertUntouched(q, 1_000e6, 0, 1 ether);
    }

    function test_reserveReverts_usdcNotMoved() public {
        reserve.setMode(reserve.DOWN());
        LeaseGasQuote memory q = _quote(p1, 30e6, 0.01 ether, 1);
        bytes memory sig = _sign(router, q, P1_PK);
        vm.expectRevert(bytes("reserve down"));
        vm.prank(payer);
        router.fill(q, sig);
        _assertUntouched(q, 1_000e6, 0, 1 ether);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // token behaviour
    // ---------------------------------------------------------------------------------------------------------------

    function _routerWith(address token) internal returns (LeaseGasFundingRouter r) {
        r = new LeaseGasFundingRouter(token, address(ledger), address(reserve), 1 ether);
        vm.prank(p1);
        r.provide{value: 1 ether}();
    }

    function test_returnFalseToken() public {
        usdc.setReturnFalse(true);
        LeaseGasQuote memory q = _quote(p1, 30e6, 0.01 ether, 1);
        bytes memory sig = _sign(router, q, P1_PK);
        vm.expectRevert(LeaseGasFundingRouter.TokenTransferFailed.selector);
        vm.prank(payer);
        router.fill(q, sig);
        _assertUntouched(q, 1_000e6, 0, 1 ether);
    }

    function test_feeOnTransferToken() public {
        MockToken6 fot = new MockToken6(6);
        fot.setFeeBps(10);
        LeaseGasFundingRouter r = _routerWith(address(fot));
        fot.mint(payer, 100e6);
        vm.prank(payer);
        fot.approve(address(r), type(uint256).max);
        LeaseGasQuote memory q = _quote(p1, 30e6, 0.01 ether, 1);
        bytes memory sig = _sign(r, q, P1_PK);
        vm.expectRevert(LeaseGasFundingRouter.TokenTransferFailed.selector);
        vm.prank(payer);
        r.fill(q, sig);
        assertEq(fot.balanceOf(payer), 100e6);
        assertEq(r.liquidityOf(p1), 1 ether);
        assertFalse(r.nonceUsed(p1, 1));
    }

    function test_noReturnToken() public {
        NoReturnToken6 nrt = new NoReturnToken6();
        LeaseGasFundingRouter r = _routerWith(address(nrt));
        nrt.mint(payer, 100e6);
        vm.prank(payer);
        nrt.approve(address(r), 30e6);
        LeaseGasQuote memory q = _quote(p1, 30e6, 0.01 ether, 1);
        bytes memory sig = _sign(r, q, P1_PK);
        vm.prank(payer);
        r.fill(q, sig);
        assertEq(nrt.balanceOf(payer), 70e6);
        assertEq(nrt.balanceOf(p1), 30e6);
        assertEq(_reserveBal(appOwner), 0.01 ether);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // reentrancy / callbacks
    // ---------------------------------------------------------------------------------------------------------------

    function test_tokenCallbackCannotReenter() public {
        // from inside transferFrom, try to fill a second, validly signed quote naming the token as payer
        LeaseGasQuote memory inner = _quote(p1, 1e6, 0.5 ether, 2);
        inner.payer = address(usdc);
        bytes memory isig = _sign(router, inner, P1_PK);
        usdc.setHook(address(router), abi.encodeWithSelector(LeaseGasFundingRouter.fill.selector, inner, isig));

        LeaseGasQuote memory q = _quote(p1, 30e6, 0.01 ether, 1);
        bytes memory sig = _sign(router, q, P1_PK);
        vm.prank(payer);
        router.fill(q, sig);

        assertFalse(usdc.hookOk());
        assertEq(bytes4(usdc.hookRet()), LeaseGasFundingRouter.Reentrant.selector);
        assertEq(router.liquidityOf(p1), 0.99 ether);
        assertFalse(router.nonceUsed(p1, 2));
    }

    function test_reserveCallbackCannotReenter() public {
        reserve.setMode(reserve.REENTER());
        reserve.setReenter(address(router), abi.encodeWithSelector(LeaseGasFundingRouter.provide.selector));
        LeaseGasQuote memory q = _quote(p1, 30e6, 0.01 ether, 1);
        bytes memory sig = _sign(router, q, P1_PK);
        vm.prank(payer);
        router.fill(q, sig);
        assertFalse(reserve.reentryOk());
        assertEq(bytes4(reserve.reentryRet()), LeaseGasFundingRouter.Reentrant.selector);
        assertEq(_reserveBal(appOwner), 0.01 ether);
    }

    function test_withdrawRecipientCannotReenter() public {
        ReentrantProvider rp = new ReentrantProvider(router);
        rp.provideAndWithdraw{value: 1 ether}(0.4 ether);
        assertFalse(rp.innerOk());
        assertEq(bytes4(rp.innerRet()), LeaseGasFundingRouter.Reentrant.selector);
        assertEq(router.liquidityOf(address(rp)), 0.6 ether);
        assertEq(address(rp).balance, 0.4 ether);
        assertEq(router.totalLiquidity(), address(router).balance);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // provider ETH: withdraw, unexpected and forced ETH
    // ---------------------------------------------------------------------------------------------------------------

    function test_withdraw_onlyOwnUnusedBalance() public {
        vm.expectRevert(abi.encodeWithSelector(LeaseGasFundingRouter.InsufficientLiquidity.selector, 1, 0));
        vm.prank(attacker);
        router.withdraw(1, payable(attacker));

        LeaseGasQuote memory q = _quote(p1, 30e6, 0.25 ether, 1);
        bytes memory sig = _sign(router, q, P1_PK);
        vm.prank(payer);
        router.fill(q, sig);
        vm.expectRevert(abi.encodeWithSelector(LeaseGasFundingRouter.InsufficientLiquidity.selector, 1 ether, 0.75 ether));
        vm.prank(p1);
        router.withdraw(1 ether, payable(p1));

        uint256 before = p1.balance;
        vm.prank(p1);
        router.withdraw(0.75 ether, payable(p1));
        assertEq(p1.balance, before + 0.75 ether);
        assertEq(router.liquidityOf(p1), 0);
        assertEq(router.liquidityOf(p2), 1 ether);
    }

    function test_withdraw_failedSendRestores() public {
        RejectEth rej = new RejectEth();
        vm.expectRevert(LeaseGasFundingRouter.EthSendFailed.selector);
        vm.prank(p1);
        router.withdraw(0.5 ether, payable(address(rej)));
        assertEq(router.liquidityOf(p1), 1 ether);
        assertEq(router.totalLiquidity(), 2 ether);
        assertEq(address(router).balance, 2 ether);
    }

    function test_zeroAmounts() public {
        vm.expectRevert(LeaseGasFundingRouter.ZeroAmount.selector);
        vm.prank(p1);
        router.withdraw(0, payable(p1));
        vm.expectRevert(LeaseGasFundingRouter.ZeroAmount.selector);
        vm.prank(p1);
        router.withdraw(1, payable(address(0)));
        vm.expectRevert(LeaseGasFundingRouter.ZeroAmount.selector);
        vm.prank(p1);
        router.provide{value: 0}();
    }

    function test_unexpectedEthRefused() public {
        vm.deal(attacker, 1 ether);
        vm.startPrank(attacker);
        (bool ok1,) = address(router).call{value: 1}("");
        (bool ok2,) = address(router).call{value: 1}(hex"deadbeef");
        vm.stopPrank();
        assertFalse(ok1);
        assertFalse(ok2);
        assertEq(address(router).balance, 2 ether);
    }

    function test_forcedEth_creditsNobody() public {
        vm.deal(address(router), address(router).balance + 5 ether);   // stands in for selfdestruct / coinbase
        assertEq(router.totalLiquidity(), 2 ether);
        assertEq(router.strandedEth(), 5 ether);
        vm.expectRevert(abi.encodeWithSelector(LeaseGasFundingRouter.InsufficientLiquidity.selector, 1 ether + 1, 1 ether));
        vm.prank(p1);
        router.withdraw(1 ether + 1, payable(p1));
        // fills and the exact ETH-delta check still hold with a surplus present
        LeaseGasQuote memory q = _quote(p1, 30e6, 0.01 ether, 1);
        bytes memory sig = _sign(router, q, P1_PK);
        vm.prank(payer);
        router.fill(q, sig);
        assertEq(router.strandedEth(), 5 ether);
        assertEq(address(router).balance, router.totalLiquidity() + 5 ether);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // constructor bindings
    // ---------------------------------------------------------------------------------------------------------------

    function test_constructorValidation() public {
        address noCode = makeAddr("noCode");
        vm.expectRevert(abi.encodeWithSelector(LeaseGasFundingRouter.BadBinding.selector, uint8(1)));
        new LeaseGasFundingRouter(noCode, address(ledger), address(reserve), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(LeaseGasFundingRouter.BadBinding.selector, uint8(1)));
        new LeaseGasFundingRouter(address(usdc), address(0), address(reserve), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(LeaseGasFundingRouter.BadBinding.selector, uint8(1)));
        new LeaseGasFundingRouter(address(usdc), address(ledger), address(ledger), 1 ether);

        MockReserve foreign = new MockReserve(address(new MockLedger()));
        vm.expectRevert(abi.encodeWithSelector(LeaseGasFundingRouter.BadBinding.selector, uint8(2)));
        new LeaseGasFundingRouter(address(usdc), address(ledger), address(foreign), 1 ether);

        MockToken6 eighteen = new MockToken6(18);
        vm.expectRevert(abi.encodeWithSelector(LeaseGasFundingRouter.BadBinding.selector, uint8(3)));
        new LeaseGasFundingRouter(address(eighteen), address(ledger), address(reserve), 1 ether);

        vm.expectRevert(abi.encodeWithSelector(LeaseGasFundingRouter.BadBinding.selector, uint8(4)));
        new LeaseGasFundingRouter(address(usdc), address(ledger), address(reserve), 0);
        vm.expectRevert(abi.encodeWithSelector(LeaseGasFundingRouter.BadBinding.selector, uint8(4)));
        new LeaseGasFundingRouter(address(usdc), address(ledger), address(reserve), uint256(type(uint96).max) + 1);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // conservation across providers (fuzz)
    // ---------------------------------------------------------------------------------------------------------------

    function testFuzz_conservation_twoProviders(uint256 e1, uint256 e2, uint256 u1, uint256 u2, uint256 w1) public {
        e1 = bound(e1, 1, 1 ether);
        e2 = bound(e2, 1, 1 ether);
        u1 = bound(u1, 1, 500e6);
        u2 = bound(u2, 1, 500e6);
        uint256 ethSum = p1.balance + p2.balance + address(router).balance + address(reserve).balance;
        uint256 usdcSum = usdc.balanceOf(payer) + usdc.balanceOf(p1) + usdc.balanceOf(p2);

        LeaseGasQuote memory a = _quote(p1, u1, e1, 1);
        LeaseGasQuote memory b = _quote(p2, u2, e2, 1);
        bytes memory sa = _sign(router, a, P1_PK);
        bytes memory sb = _sign(router, b, P2_PK);
        vm.prank(payer);
        router.fill(a, sa);
        vm.prank(payer);
        router.fill(b, sb);

        w1 = bound(w1, 0, 1 ether - e1);
        if (w1 > 0) {
            vm.prank(p1);
            router.withdraw(w1, payable(p1));
        }

        assertEq(router.liquidityOf(p1), 1 ether - e1 - w1);
        assertEq(router.liquidityOf(p2), 1 ether - e2);
        assertEq(router.totalLiquidity(), router.liquidityOf(p1) + router.liquidityOf(p2));
        assertEq(address(router).balance, router.totalLiquidity());
        assertEq(address(reserve).balance, e1 + e2);
        assertEq(_reserveBal(appOwner), e1 + e2);
        assertEq(p1.balance + p2.balance + address(router).balance + address(reserve).balance, ethSum);

        assertEq(usdc.balanceOf(p1), u1);
        assertEq(usdc.balanceOf(p2), u2);
        assertEq(usdc.balanceOf(payer), 1_000e6 - u1 - u2);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(usdc.balanceOf(payer) + usdc.balanceOf(p1) + usdc.balanceOf(p2), usdcSum);
    }
}
