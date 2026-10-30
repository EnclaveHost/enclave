// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

// Independent review regressions, added after preserving the terminal author delivery.
import {LifecycleBase} from "./HostLifecycleRegistry.t.sol";
import {EnclaveHostLifecycleRegistry as R} from "../contracts/EnclaveHostLifecycleRegistry.sol";

contract RejectHostReimbursement {
    receive() external payable { revert("recipient unavailable"); }
}

contract HostLifecycleReviewTest is LifecycleBase {
    function _resignRecovery(RecoveryCase memory c) internal view {
        bytes32 digest = reg.hashRecovery(c.v);
        c.opSig = _sig(OPERATOR_PK, digest);
        c.ownSig = _sig(OWNER_PK, digest);
        c.q.intentDigest = digest;
        c.approvals = _quorum(verifierPks, 2, reg.hashReceipt(c.q));
    }

    function test_unprovenL1AllowanceIsNotPaid() public {
        bytes32 hostId = _enrolled();
        uint128 balanceBefore = _balance(hostId);
        vm.txGasPrice(0);
        _reportOffline(hostId, reporterPks);
        assertFalse(_active(hostId));
        assertEq(reg.credits(payee), 0, "unproven L1 fee is not actual reimbursement");
        assertEq(_balance(hostId), balanceBefore);
    }

    function test_recoveryCannotShrinkReserveBelowTransitionCap() public {
        bytes32 hostId = _enrolled();
        _reportOffline(hostId, reporterPks);
        uint128 balanceBefore = _balance(hostId);
        uint256 creditBefore = reg.credits(payee);
        RecoveryCase memory c = _recovery(hostId, OPERATOR_PK);
        c.v.protectedAmount = 1;
        _resignRecovery(c);
        vm.prank(submitter);
        vm.expectRevert(R.BadBudget.selector);
        reg.recoverQualifiedHost(c.v, c.q, c.opSig, c.ownSig, c.approvals);
        assertFalse(_active(hostId));
        assertEq(_balance(hostId), balanceBefore);
        assertEq(reg.credits(payee), creditBefore);
    }

    function test_recoveryNewReservationRequiresExactProtectedAmount() public {
        bytes32 hostId = _enrolled();
        _reportOffline(hostId, reporterPks);
        uint128 balanceBefore = _balance(hostId);
        R.SponsorReservation memory s = _reservation(hostId, HW, keccak256("recovery-new-budget"), anchorId);
        s.nonce = 9;
        bytes32 reservationId = _reserve(s);
        RecoveryCase memory c = _recovery(hostId, OPERATOR_PK);
        c.v.reservationId = reservationId;
        c.v.protectedAmount = s.protectedAmount - 1;
        _resignRecovery(c);
        vm.prank(submitter);
        vm.expectRevert(R.BadReservation.selector);
        reg.recoverQualifiedHost(c.v, c.q, c.opSig, c.ownSig, c.approvals);
        assertFalse(_active(hostId));
        assertEq(_balance(hostId), balanceBefore);
        assertEq(_resStatus(reservationId), reg.RES_RESERVED());
    }

    function test_exactOfflineRetryRejectsObsoleteAuthorityRevision() public {
        bytes32 hostId = _enrolled();
        R.HostOffline memory o = _offline(hostId);
        bytes[] memory signatures = _quorum(reporterPks, 2, reg.hashOffline(o));
        assertTrue(reg.recordHostOffline(o, signatures));
        uint256 creditBefore = reg.credits(payee);
        vm.prank(owner);
        reg.setHostPolicy(hostId, _policy(newReporterPks, 2), keccak256("new-authority"));
        vm.expectRevert(R.IntentMismatch.selector);
        reg.recordHostOffline(o, signatures);
        vm.prank(owner);
        vm.expectRevert(R.IntentMismatch.selector);
        reg.deactivateHost(o);
        assertEq(reg.credits(payee), creditBefore);
        assertFalse(_active(hostId));
    }

    function test_exactOfflineRetryStillRequiresReporterQuorum() public {
        bytes32 hostId = _enrolled();
        R.HostOffline memory o = _offline(hostId);
        bytes[] memory signatures = _quorum(reporterPks, 2, reg.hashOffline(o));
        assertTrue(reg.recordHostOffline(o, signatures));
        vm.expectRevert(R.Quorum.selector);
        reg.recordHostOffline(o, new bytes[](0));
        assertFalse(reg.recordHostOffline(o, signatures));
    }

    function test_exactGracefulRetryStillRequiresCurrentOwnerOrOperator() public {
        bytes32 hostId = _enrolled();
        R.HostOffline memory o = _offline(hostId);
        vm.prank(owner);
        assertTrue(reg.deactivateHost(o));
        vm.prank(stranger);
        vm.expectRevert(R.NotAuthorized.selector);
        reg.deactivateHost(o);
        vm.prank(operator);
        assertFalse(reg.deactivateHost(o));
    }

    function test_proofKeyCannotChangeWithoutFreshQualification() public {
        bytes32 hostId = _enrolled();
        address original = reg.get(hostId).proofKey;
        vm.prank(operator);
        vm.expectRevert(R.BadListing.selector);
        reg.setProofKey(hostId, address(0xBAD));
        assertEq(reg.get(hostId).proofKey, original);
        vm.prank(operator);
        reg.setProofKey(hostId, original); // idempotent compatibility only
        _reportOffline(hostId, reporterPks);
        RecoveryCase memory c = _recovery(hostId, OPERATOR_PK);
        _recover(c);
        assertEq(reg.get(hostId).proofKey, c.v.proofKey);
    }

    function test_rejectingRecipientPreservesCreditAndOfflineState() public {
        bytes32 hostId = _enrolled();
        _reportOffline(hostId, reporterPks);
        uint256 owed = reg.credits(payee);
        RejectHostReimbursement receiver = new RejectHostReimbursement();
        vm.prank(payee);
        vm.expectRevert(R.TransferFailed.selector);
        reg.claimHostReimbursement(payable(address(receiver)));
        assertEq(reg.credits(payee), owed);
        assertFalse(_active(hostId));
        uint256 before = payee.balance;
        vm.prank(payee);
        assertEq(reg.claimHostReimbursement(payable(payee)), owed);
        assertEq(payee.balance, before + owed);
        assertEq(reg.credits(payee), 0);
    }
}
