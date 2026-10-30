// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { FundingRig } from "./FundingRig.sol";
import { FundingSessionVault, FundingSessionVaultFactory, ISVToken, ISVBook, ISVRouter, ISVKeyAttestations }
    from "../src/FundingSessionVault.sol";
import { FundingGasLib } from "../src/FundingGasLib.sol";
import { SessionVault as LegacyVault, SessionVaultFactory as LegacyFactory, ISVToken as LToken, ISVBook as LBook,
    ISVRouter as LRouter, ISVKeyAttestations as LKA } from "enclave-src/SessionVault.sol";
import { EnclaveAddressBook } from "enclave-src/EnclaveAddressBook.sol";

/// Answers the views checkPins reads - used ONLY to drive the constructor's pin checks into each failure; it is not
/// an adapter and no test here presents it as one.
contract PinStub {
    address public usdc; address public ledger; address public reserve;
    constructor(address u, address l, address r) { (usdc, ledger, reserve) = (u, l, r); }
}

/// The successor keeps every non-gas behaviour of the original (fees to the treasury, holder-credited funding,
/// refunds as free balance, owner kill switch, withdrawals, release) under the new grant shape and domain version 2.
contract FundingSessionVaultRegressionTest is FundingRig {
    bytes32 constant WITHDRAW_TYPEHASH = keccak256("Withdraw(uint256 amount,bytes32 opNonce,uint64 signBefore)");

    function test_createWithFunding_feeGoesToTreasuryNotRelayer() public {
        bytes32 sid = _openWithDeposit(_plainGrant(50e6));
        uint256 t0 = usdc.balanceOf(treasury);
        uint256 v0 = usdc.balanceOf(address(vault));
        bytes32 id = abi.decode(_exec(sid, 0, CREATE, _createArgs(freeRef, STAGING, 20e6), 10_000), (bytes32));
        assertEq(usdc.balanceOf(treasury), t0 + 10_000, "non-gas fee: PaymentRouter -> treasury");
        assertEq(usdc.balanceOf(relayer), 0, "non-gas fee: nothing to the submitter");
        assertEq(usdc.balanceOf(address(vault)), v0 - 20e6 - 10_000);
        FundingSessionVault.Session memory s = _sess(sid);
        assertEq(s.balance6, 50e6 - 20e6 - 10_000);
        assertEq(s.spent6, 20e6 + 10_000);
        assertEq(s.periodOps, 1);
        assertEq(vault.locked6(), s.balance6);
        (uint8 env, , bytes32 createdBy) = vault.held(id);
        assertEq(env, STAGING);
        assertEq(createdBy, sid);
        assertEq(ledger.get(id).owner, address(vault));
    }

    function test_fundHeldRecord() public {
        bytes32 sid = _openWithDeposit(_plainGrant(50e6));
        bytes32 id = _vaultRecord(STAGING);
        uint256 v0 = usdc.balanceOf(address(vault));
        _exec(sid, 0, FUND, abi.encode(id, uint256(5e6)), 0);
        assertEq(usdc.balanceOf(address(vault)), v0 - 5e6);
        assertEq(_sess(sid).balance6, 45e6);
        assertEq(usdc.allowance(address(vault), address(ledger)), 0);
    }

    function test_refundProceedsAreFreeBalanceNeverSession() public {
        bytes32 sid = _openWithDeposit(_plainGrant(50e6));
        bytes32 id = abi.decode(_exec(sid, 0, CREATE, _createArgs(freeRef, STAGING, 20e6), 0), (bytes32));
        uint256 refundable = ledger.refundableOf(id);
        assertGt(refundable, 0);
        uint256 lockedBefore = vault.locked6();
        _exec(sid, 1, REFUND, abi.encode(id), 0);
        assertEq(vault.locked6(), lockedBefore, "session balance unchanged");
        assertEq(vault.free(), refundable, "refund lands as the owner's free balance");
    }

    function test_ownerRevokeAllWithdrawsEverything_gasSessionsToo() public {
        bytes32 a = _openWithDeposit(_plainGrant(20e6));
        bytes32 b = _openWithDeposit(_gasGrant(30e6));
        bytes32 id = _vaultRecord(STAGING);
        _exec(b, 0, GAS, _gasArgs(id, address(vault)), 0);
        uint256 vaultBal = usdc.balanceOf(address(vault));
        uint256 before = usdc.balanceOf(owner);
        vm.prank(owner);
        vault.revokeAll(true, keccak256("k"), 0, "");
        assertFalse(vault.isLive(a));
        assertFalse(vault.isLive(b));
        assertEq(usdc.balanceOf(owner), before + vaultBal);
        assertEq(usdc.balanceOf(address(vault)), 0);
        assertEq(vault.locked6(), 0);
        // bought gas is not reachable by any session action: it sits in the reserve under the holder's key
        assertEq(reserve.reserveOf(id, address(vault)).balanceWei, ETH_OUT);
    }

    function test_terminateRefundsRemainderToOwner() public {
        bytes32 sid = _openWithDeposit(_gasGrant(30e6));
        bytes32 id = _vaultRecord(STAGING);
        _exec(sid, 0, GAS, _gasArgs(id, address(vault)), 20_000);
        uint256 left = _sess(sid).balance6;
        assertEq(left, 30e6 - _quote(ETH_OUT) - 20_000);
        uint256 before = usdc.balanceOf(owner);
        vm.prank(owner);
        vault.terminate(sid, keccak256("t"), 0, "");
        assertEq(usdc.balanceOf(owner), before + left);
        assertEq(vault.locked6(), 0);
    }

    function test_ownerSignedOpsUseDomainV2() public {
        bytes32 sid = _openWithDeposit(_plainGrant(10e6));
        vm.prank(owner);
        usdc.transfer(address(vault), 5e6);                        // free balance
        uint64 sb = uint64(vm.getBlockTimestamp() + 60);
        bytes32 sh = keccak256(abi.encode(WITHDRAW_TYPEHASH, uint256(5e6), keccak256("w1"), sb));
        bytes memory v1 = _ecdsa(OWNER_PK, _typed(address(vault), "1", sh));
        vm.prank(relayer);
        vm.expectRevert(FundingSessionVault.BadSignature.selector);
        vault.withdraw(5e6, keccak256("w1"), sb, v1);
        bytes memory v2 = _ecdsa(OWNER_PK, _typed(address(vault), "2", sh));
        uint256 before = usdc.balanceOf(owner);
        vm.prank(relayer);
        vault.withdraw(5e6, keccak256("w1"), sb, v2);
        assertEq(usdc.balanceOf(owner), before + 5e6);
        assertEq(_sess(sid).balance6, 10e6, "escrow untouched");
    }

    function test_releaseStillResolvesTheBooksFactory() public {
        _openWithDeposit(_plainGrant(1e6));
        bytes32 id = _vaultRecord(STAGING);
        legacyFactory.createVault(owner);
        // the book's sessionVaultFactory is still the ORIGINAL factory: release may target the owner's OLD vault
        vm.prank(owner);
        vault.release(id, address(oldVault), keccak256("r"), 0, "");
        assertEq(ledger.get(id).owner, address(oldVault));
        bytes32 id2 = _vaultRecord(STAGING);
        vm.prank(owner);
        vm.expectRevert(FundingSessionVault.BadTarget.selector);
        vault.release(id2, address(vault), keccak256("r2"), 0, "");
    }

    function test_legacyFactoryAndVaultsUnchanged() public {
        bytes32 id = _legacyRecord(PROD);
        assertEq(ledger.get(id).owner, address(oldVault));
        assertEq(legacyFactory.vaultFor(owner), address(oldVault));
        assertTrue(legacyFactory.isVault(address(oldVault)));
        assertEq(oldVault.domainSeparator(), _domain(address(oldVault), "1"));
        FundingSessionVault impl = factory.implementation();
        assertEq(impl.gasAdapter(), address(adapter));
        assertEq(impl.legacyFactory(), address(legacyFactory));
        assertTrue(address(vault) != address(oldVault), "a separate vault per factory: opt-in, nothing migrates itself");
    }

    // ---- constructor pins ----------------------------------------------------------------------------------------

    function _newFactory(address a, address l) internal {
        new FundingSessionVaultFactory(ISVToken(address(usdc)), ISVBook(address(book)), ISVRouter(address(payRouter)),
            ISVKeyAttestations(address(ka)), 1_000e6, a, l);
    }

    function test_pins() public {
        vm.expectRevert(abi.encodeWithSelector(FundingGasLib.BadPin.selector, uint8(1)));
        _newFactory(makeAddr("eoa"), address(legacyFactory));
        PinStub wrongToken = new PinStub(makeAddr("t"), address(ledger), address(reserve));
        vm.expectRevert(abi.encodeWithSelector(FundingGasLib.BadPin.selector, uint8(2)));
        _newFactory(address(wrongToken), address(legacyFactory));
        PinStub wrongLedger = new PinStub(address(usdc), makeAddr("l"), address(reserve));
        vm.expectRevert(abi.encodeWithSelector(FundingGasLib.BadPin.selector, uint8(3)));
        _newFactory(address(wrongLedger), address(legacyFactory));
        PinStub otherReserve = new PinStub(address(0), makeAddr("l2"), address(0));
        PinStub wrongReserve = new PinStub(address(usdc), address(ledger), address(otherReserve));
        vm.expectRevert(abi.encodeWithSelector(FundingGasLib.BadPin.selector, uint8(4)));
        _newFactory(address(wrongReserve), address(legacyFactory));
        // a REAL original factory, on another book
        LegacyFactory otherBook = new LegacyFactory(LToken(address(usdc)), LBook(address(new EnclaveAddressBook())),
            LRouter(address(payRouter)), LKA(address(ka)), 1_000e6);
        vm.expectRevert(abi.encodeWithSelector(FundingGasLib.BadPin.selector, uint8(5)));
        _newFactory(address(adapter), address(otherBook));
        _newFactory(address(adapter), address(legacyFactory));      // the real pair passes
    }
}
