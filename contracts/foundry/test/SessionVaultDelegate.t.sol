// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { SessionRig } from "./SessionVault.t.sol";
import { SessionVault, SessionVaultLib, CreateArgs } from "../../SessionVault.sol";
import { EnclaveDeployments as LedgerR15D } from "../../../deploy/ledger/EnclaveDeployments.sol";

/// Sessions acting on deployments the owner's WALLET holds, through the ledger delegation of the
/// deployable revision (deploy/ledger: live rev 15 + setDelegate). The owner grants the vault once;
/// the vault then enforces each session's policy. A wallet record is production to a session.
contract SessionVaultDelegateTest is SessionRig {
    uint8 constant CREATE = 0; uint8 constant FUND = 1; uint8 constant SET_APPREF = 2; uint8 constant SET_CONFIG = 3;
    uint8 constant SET_SHARES = 4; uint8 constant SET_MAXRATE = 5; uint8 constant SET_ACTIVE = 6; uint8 constant REFUND = 7;
    uint256 constant DELEGATE_SLOT = 23;
    uint256 constant SK3 = 0x5E57;              // isDelegate's storage slot (recorded with the deployment)
    LedgerR15D led;

    function setUp() public override {
        super.setUp();
        led = new LedgerR15D(address(usdc), payout, address(reg), address(0));
        led.setProofRequiredFrom(0);
        book.set("deployments", address(led));
    }

    function _walletRecord(uint256 fund6) internal returns (bytes32 id) {
        vm.startPrank(owner);
        id = led.create(freeRef, 0, 1000, 8080, "", false, "", address(0), 0, 1000);
        if (fund6 > 0) { usdc.approve(address(led), fund6); led.fund(id, fund6); }
        vm.stopPrank();
    }

    function _delegated(address o, address d) internal view returns (bool) {
        bytes32 inner = keccak256(abi.encode(o, DELEGATE_SLOT));
        return uint256(vm.load(address(led), keccak256(abi.encode(d, inner)))) == 1;
    }

    // ---- the ledger: what a delegate may and may not do ----------------------------------------

    function test_ledgerDelegateActsOnEveryOwnerRecordButNeverMovesOne() public {
        bytes32 id = _walletRecord(2e6);
        address d = makeAddr("delegate");
        vm.prank(d); vm.expectRevert(bytes("!owner")); led.setActive(id, false);
        assertFalse(_delegated(owner, d));
        vm.prank(owner); led.setDelegate(d, true);
        assertTrue(_delegated(owner, d), "readable from the recorded slot");
        vm.startPrank(d);
        led.setActive(id, false);
        led.setActive(id, true);
        led.setShares(id, 0, 500);
        led.setMaxRate(id, 900);
        led.setConfig(id, "{}");
        led.setAppRef(id, freeRef);
        vm.expectRevert(bytes("!owner")); led.transferDeployment(id, d);
        vm.stopPrank();
        // refund: the delegate triggers it, the OWNER is paid
        uint256 before = usdc.balanceOf(owner);
        vm.prank(d); led.refund(id);
        assertGt(usdc.balanceOf(owner), before);
        assertEq(usdc.balanceOf(d), 0);
        // revoked: refused again; and a delegate of one owner is nothing to another
        vm.prank(owner); led.setDelegate(d, false);
        vm.prank(d); vm.expectRevert(bytes("!owner")); led.setActive(id, true);
        address other = makeAddr("other-owner");
        vm.prank(other);
        bytes32 theirs = led.create(freeRef, 0, 1000, 8080, "", false, "", address(0), 0, 1000);
        vm.prank(owner); led.setDelegate(d, true);
        vm.prank(d); vm.expectRevert(bytes("!owner")); led.setActive(theirs, false);
    }

    // ---- sessions on wallet records ------------------------------------------------------------

    function test_sessionSuspendsAWalletRecordOnceTheOwnerDelegates() public {
        bytes32 sid = _openWithDeposit(_grant(keyHash, 10e6));
        bytes32 id = _walletRecord(1e6);
        // no delegation yet: the ledger itself refuses the vault
        _execExpectRevert(sid, 0, SET_ACTIVE, abi.encode(id, false), 0, abi.encodeWithSignature("Error(string)", "!owner"));
        vm.prank(owner); led.setDelegate(address(vault), true);
        _exec(sid, 0, SET_ACTIVE, abi.encode(id, false), 0);
        assertFalse(led.get(id).active, "suspended by the session, no wallet signature");
        _exec(sid, 1, SET_ACTIVE, abi.encode(id, true), 0);
        assertTrue(led.get(id).active);
        _exec(sid, 2, SET_SHARES, abi.encode(id, uint16(0), uint16(500)), 0);
        assertEq(led.get(id).cpuMilli, 500);
        assertEq(led.get(id).owner, owner, "still the wallet's record");
    }

    function test_aWalletRecordIsProductionToASession() public {
        bytes32 sid = _openWithDeposit(_grant(keyHash, 10e6));
        bytes32 id = _walletRecord(0);
        vm.prank(owner); led.setDelegate(address(vault), true);
        // what it runs stays the wallet's
        _execExpectRevert(sid, 0, SET_APPREF, abi.encode(id, freeRef), 0,
            abi.encodeWithSelector(SessionVault.WrongEnvironment.selector, id, uint8(2)));
        _execExpectRevert(sid, 0, SET_CONFIG, abi.encode(id, "{}"), 0,
            abi.encodeWithSelector(SessionVault.WrongEnvironment.selector, id, uint8(2)));
        // a production cap only ever goes down
        _execExpectRevert(sid, 0, SET_MAXRATE, abi.encode(id, uint256(1001)), 0,
            abi.encodeWithSelector(SessionVaultLib.RateCapOutOfRange.selector, 1001, 1000));
        _exec(sid, 0, SET_MAXRATE, abi.encode(id, uint256(800)), 0);
        assertEq(led.capOf(id), 800);
        // a staging-only grant (an agent's) never reaches the wallet's records
        SessionVault.Grant memory g = _grant(keyHash2(), 0);
        g.environments = _strs("staging");
        bytes32 sid2 = _open(g);
        _execAsExpectRevert(SK2, sid2, 0, SET_ACTIVE, abi.encode(id, false),
            abi.encodeWithSelector(SessionVault.EnvNotAllowed.selector, uint8(2)));
    }

    function test_fundingAWalletRecordRefundsToTheWallet() public {
        bytes32 sid = _openWithDeposit(_grant(keyHash, 10e6));
        bytes32 id = _walletRecord(0);
        vm.prank(owner); led.setDelegate(address(vault), true);
        _exec(sid, 0, FUND, abi.encode(id, uint256(2e6)), 0);
        assertEq(led.get(id).balance6, 2e6);
        assertGt(led.refundableOf(id), 0, "the escrowed share is the holder's (the wallet's)");
        uint256 w = usdc.balanceOf(owner);
        uint256 v = usdc.balanceOf(address(vault));
        _exec(sid, 1, REFUND, abi.encode(id), 0);
        assertGt(usdc.balanceOf(owner), w, "the refund went to the wallet");
        assertEq(usdc.balanceOf(address(vault)), v, "not into the vault");
    }

    function test_aGiftedPaidRecordNeedsItsAppNamed() public {
        // a stranger creates a PAID record and hands it to the owner's wallet
        address stranger = makeAddr("stranger");
        vm.startPrank(stranger);
        bytes32 id = led.create(storeRef, 0, 1000, 8080, "", false, "", publisher, 100, 1000);
        led.transferDeployment(id, owner);
        vm.stopPrank();
        vm.prank(owner); led.setDelegate(address(vault), true);
        bytes32 sid = _openWithDeposit(_grant(keyHash, 10e6));          // apps "*": paid apps never covered
        _execExpectRevert(sid, 0, FUND, abi.encode(id, uint256(1e6)), 0,
            abi.encodeWithSelector(SessionVault.AppNotAllowed.selector, storeAppId));
        SessionVault.Grant memory g = _grant(keyHash2(), 10e6);
        g.apps = _strs(vm.toString(storeAppId));
        g.grantNonce = keccak256("named");
        bytes32 sid2 = _openWithDeposit(g);
        _execAs(SK2, sid2, 0, FUND, abi.encode(id, uint256(1e6)), 0);
        assertEq(led.get(id).balance6, 1e6, "named: funded, the fee at most half (prepareFund)");
        // named, genuine, but above THIS grant's publisher-fee ceiling ($0.36/h > $0.30/h)
        (uint256 x3, uint256 y3) = vm.publicKeyP256(SK3);
        SessionVault.Grant memory g3 = _grant(keccak256(abi.encode(x3, y3)), 10e6);
        g3.apps = _strs(vm.toString(storeAppId));
        g3.maxAppFeePerHour = 300_000;
        g3.grantNonce = keccak256("ceiling");
        bytes32 sid3 = _openWithDeposit(g3);
        uint64 deadline = uint64(vm.getBlockTimestamp() + 120);
        bytes memory fargs = abi.encode(id, uint256(1e6));
        bytes32 dg = _callDigest(sid3, 0, FUND, fargs, 0, deadline);
        (bytes32 r, bytes32 s2) = vm.signP256(SK3, sha256(abi.encodePacked(dg)));
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(SessionVault.AppFeeTooHigh.selector, uint256(360_000), uint256(300_000)));
        vault.execute(sid3, 0, FUND, fargs, 0, deadline, x3, y3, r, s2);
    }

    function test_anUnadoptedVaultRecordStaysInert() public {
        bytes32 sid = _openWithDeposit(_grant(keyHash, 10e6));
        vm.prank(owner); led.setDelegate(address(vault), true);
        bytes32 id = _walletRecord(0);
        vm.prank(owner); led.transferDeployment(id, address(vault));   // moved INTO the vault, not adopted
        _execExpectRevert(sid, 0, SET_ACTIVE, abi.encode(id, false), 0,
            abi.encodeWithSelector(SessionVault.NotHeld.selector, id));
    }

    // ---- helpers --------------------------------------------------------------------------------

    function keyHash2() internal view returns (bytes32) {
        (uint256 x, uint256 y) = vm.publicKeyP256(SK2);
        return keccak256(abi.encode(x, y));
    }

    function _execAsExpectRevert(uint256 sk, bytes32 sid, uint256 nonce, uint8 action, bytes memory args, bytes memory err)
        internal
    {
        uint64 deadline = uint64(vm.getBlockTimestamp() + 120);
        bytes32 d = _callDigest(sid, nonce, action, args, 0, deadline);
        (bytes32 r, bytes32 s) = vm.signP256(sk, sha256(abi.encodePacked(d)));
        (uint256 x, uint256 y) = vm.publicKeyP256(sk);
        vm.prank(relayer);
        vm.expectRevert(err);
        vault.execute(sid, nonce, action, args, 0, deadline, x, y, r, s);
    }
}
