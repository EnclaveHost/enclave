// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LifecycleBase} from "./HostLifecycleRegistry.t.sol";
import {EnclaveHostLifecycleRegistry as R} from "../contracts/EnclaveHostLifecycleRegistry.sol";

/// @dev Sponsor reservation dedup, protected budgets, zero-safe reimbursement and pull credits.
contract HostLifecycleSponsorBudgetTest is LifecycleBase {
    uint256 internal constant PAYER2_PK = 0xFA7E2;
    bytes32 internal constant HW2 = keccak256("hw:snp-chip-0002");
    bytes32 internal constant JOB2 = keccak256("job:bootstrap-0002");

    function _reserveAs(uint256 pk, R.SponsorReservation memory s) internal returns (bytes32) {
        s.payer = vm.addr(pk);
        bytes memory auth = _sig(pk, reg.hashReservation(s));
        vm.prank(submitter);
        return reg.reserveBootstrap(s, auth);
    }

    function _reserveReverts(R.SponsorReservation memory s, uint256 pk, bytes4 err) internal {
        bytes memory auth = _sig(pk, reg.hashReservation(s));
        vm.prank(submitter);
        vm.expectRevert(err);
        reg.reserveBootstrap(s, auth);
    }

    // ================================================================== sponsor reservation
    function test_hardwareAndJobDedupAcrossProviderFallback() public {
        bytes32 hostId = keccak256(bytes(ENDPOINT));
        R.SponsorReservation memory s = _reservation(hostId, HW, JOB, anchorId);
        _reserve(s);
        _reserveReverts(s, PAYER_PK, R.Replay.selector);           // exact retry cannot create a second grant

        R.SponsorReservation memory fallbackSameHw = _reservation(hostId, HW, JOB2, anchorId);
        fallbackSameHw.source = 2;
        fallbackSameHw.sourceEvidence = keccak256("verified-absence:paid-work-hosts@block-123");
        _reserveReverts(fallbackSameHw, PAYER_PK, R.Duplicate.selector);

        R.SponsorReservation memory sameJob = _reservation(hostId, HW2, JOB, anchorId);
        _reserveReverts(sameJob, PAYER_PK, R.Duplicate.selector);
    }

    function test_fallbackSourceNeedsAbsenceEvidence() public {
        bytes32 hostId = keccak256(bytes(ENDPOINT));
        R.SponsorReservation memory s = _reservation(hostId, HW, JOB, anchorId);
        s.source = 2;
        s.sourceEvidence = bytes32(0);                             // a failed lookup is not verified absence
        _reserveReverts(s, PAYER_PK, R.BadReservation.selector);
        s.source = 3;
        s.sourceEvidence = keccak256("x");
        _reserveReverts(s, PAYER_PK, R.BadReservation.selector);
        s.source = 2;
        bytes32 id = _reserve(s);
        assertEq(_resStatus(id), reg.RES_RESERVED());
    }

    function test_reservationRequiresPayerAuthorizationFundsAndBounds() public {
        bytes32 hostId = keccak256(bytes(ENDPOINT));
        R.SponsorReservation memory s = _reservation(hostId, HW, JOB, anchorId);
        _reserveReverts(s, 0xBAD, R.BadConsent.selector);          // signed by someone other than the payer

        s.protectedAmount = 2 ether;                               // payer deposited only 1 ether
        s.perTransitionCap = 0.01 ether;
        _reserveReverts(s, PAYER_PK, R.Insufficient.selector);

        s.protectedAmount = PROTECTED;
        s.perTransitionCap = PROTECTED + 1;
        _reserveReverts(s, PAYER_PK, R.BadBudget.selector);

        s.perTransitionCap = PER_TRANSITION;
        s.trustAnchorId = keccak256("unpublished-anchor");
        _reserveReverts(s, PAYER_PK, R.UnknownAnchor.selector);
    }

    function test_reservationIsNotPermissionToList() public {
        bytes32 hostId = keccak256(bytes(ENDPOINT));
        _reserve(_reservation(hostId, HW, JOB, anchorId));
        assertEq(reg.count(), 0);
        assertFalse(_active(hostId));
        assertEq(reg.credits(submitter), 0);
    }

    function test_consumedReservationCannotFundAnotherListing() public {
        Prepared memory c = _prepare();
        _submit(c);
        c.e.listing.endpoint = "https://host-2.example";
        c.e.hardwareId = HW2;
        _resign(c, verifierPks);
        _submitReverts(c, R.BadReservation.selector);
    }

    function test_submitterBoundReservation() public {
        bytes32 hostId = keccak256(bytes(ENDPOINT));
        R.SponsorReservation memory s = _reservation(hostId, HW, JOB, anchorId);
        s.submitter = address(0xC0DE);
        bytes32 rid = _reserve(s);
        Prepared memory c = _preparedFor(rid);
        _submitReverts(c, R.NotAuthorized.selector);
        vm.prank(address(0xC0DE));
        reg.registerQualifiedHost(c.e, c.p, c.q, c.opSig, c.ownSig, c.approvals);
        assertTrue(_active(hostId));
    }

    /// @dev Enrollment against an already reserved id (used when the reservation is built by hand).
    function _preparedFor(bytes32 rid) internal view returns (Prepared memory c) {
        c.hostId = keccak256(bytes(ENDPOINT));
        c.resId = rid;
        c.p = _policy(reporterPks, 2);
        c.e.listing = _listing();
        c.e.operator = operator;
        c.e.owner = owner;
        c.e.hardwareId = HW;
        c.e.attestationDigest = ATT;
        c.e.resourceDigest = RES;
        c.e.trustAnchorId = anchorId;
        c.e.reporterPolicyHash = reg.hashReporterPolicy(c.p);
        c.e.reservationId = rid;
        c.e.protectedAmount = PROTECTED;
        c.e.nonce = 1;
        c.e.deadline = uint64(block.timestamp + 1 hours);
        c.q = _receiptFor(c.hostId, bytes32(0), 1, REPO, c.e.listing.measurement);
        _resign(c, verifierPks);
    }

    function test_cancelOnlyAfterDeadlineReturnsFundsAndFreesSlots() public {
        bytes32 hostId = keccak256(bytes(ENDPOINT));
        uint256 before = reg.sponsorFunds(payer);
        bytes32 rid = _reserve(_reservation(hostId, HW, JOB, anchorId));
        assertEq(reg.sponsorFunds(payer), before - PROTECTED - LISTING_CAP);

        vm.prank(payer);
        vm.expectRevert(R.BadReservation.selector);
        reg.cancelReservation(rid);
        vm.warp(block.timestamp + 2 days);
        vm.prank(stranger);
        vm.expectRevert(R.NotAuthorized.selector);
        reg.cancelReservation(rid);
        vm.prank(payer);
        reg.cancelReservation(rid);
        assertEq(reg.sponsorFunds(payer), before);
        assertEq(reg.hardwareReservation(HW), bytes32(0));
        assertEq(reg.jobReservation(JOB), bytes32(0));

        R.SponsorReservation memory again = _reservation(hostId, HW, JOB, anchorId);
        again.nonce = 2;
        bytes32 rid2 = _reserve(again);
        assertEq(_resStatus(rid2), reg.RES_RESERVED());
    }

    function test_sponsorFundsWithdrawOnlyUnreserved() public {
        _reserve(_reservation(keccak256(bytes(ENDPOINT)), HW, JOB, anchorId));
        uint256 free = reg.sponsorFunds(payer);
        vm.prank(payer);
        vm.expectRevert(R.Insufficient.selector);
        reg.withdrawSponsorFunds(free + 1, payable(payer));
        uint256 bal = payer.balance;
        vm.prank(payer);
        reg.withdrawSponsorFunds(free, payable(payer));
        assertEq(payer.balance, bal + free);
        assertEq(reg.sponsorFunds(payer), 0);
    }

    // ================================================================== protected budget
    function test_protectedReserveLockedWhileOnline_foreignSponsorCannotReclaim() public {
        bytes32 hostId = _enrolled();
        vm.prank(payer);
        vm.expectRevert(R.Insufficient.selector);
        reg.releaseHostBudget(hostId, 1);
        vm.prank(stranger);
        vm.expectRevert(R.NotAuthorized.selector);
        reg.releaseHostBudget(hostId, 1);
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(R.NotAuthorized.selector);
        reg.fundHostOffline{value: 1}(hostId);

        vm.prank(payer);
        reg.fundHostOffline{value: 0.01 ether}(hostId);
        vm.prank(payer);
        reg.releaseHostBudget(hostId, 0.01 ether);                 // only the excess above the reserve
        vm.prank(payer);
        vm.expectRevert(R.Insufficient.selector);
        reg.releaseHostBudget(hostId, 1);
        assertEq(_balance(hostId), PROTECTED);
    }

    function test_protectedBudgetSurvivesLaterFailureAndPaysReporters() public {
        bytes32 hostId = _enrolled();
        // A later off-chain qualification failure is reported by the enrolled quorum; the reserve pays for it.
        _reportOffline(hostId, reporterPks);
        uint256 credit = reg.credits(payee);
        assertGt(credit, 0);
        assertEq(_balance(hostId), PROTECTED - credit);

        // After the epoch is fenced the payer may release the unencumbered balance; owed credits stay intact.
        uint128 rest = _balance(hostId);
        vm.prank(payer);
        reg.releaseHostBudget(hostId, rest);
        assertEq(_balance(hostId), 0);
        assertEq(reg.credits(payee), credit);

        address payable sink = payable(address(0xBEEF));
        vm.prank(payee);
        assertEq(reg.claimHostReimbursement(sink), credit);
        assertEq(sink.balance, credit);
        vm.prank(payee);
        assertEq(reg.claimHostReimbursement(sink), 0);
        assertEq(sink.balance, credit);
    }

    // ================================================================== zero-safe reimbursement
    function test_zeroMaxChargeStillRecordsOffline() public {
        bytes32 hostId = _enrolled();
        R.HostOffline memory o = _offline(hostId);
        o.maxCharge = 0;
        bytes[] memory s = _quorum(reporterPks, 2, reg.hashOffline(o));
        assertTrue(reg.recordHostOffline(o, s));
        assertFalse(_active(hostId));
        assertEq(reg.credits(payee), 0);
        assertEq(_balance(hostId), PROTECTED);
    }

    function test_chargeClampedToSignedMaxEvenAtExtremeGasPrice() public {
        bytes32 hostId = _enrolled();
        vm.txGasPrice(1_000_000 gwei);                             // far above the payer's maxGasPrice
        R.HostOffline memory o = _offline(hostId);
        o.maxCharge = uint128(L1 / 2);                             // below measured execution at the capped gas price
        bytes[] memory s = _quorum(reporterPks, 2, reg.hashOffline(o));
        assertTrue(reg.recordHostOffline(o, s));
        assertEq(reg.credits(payee), L1 / 2);
    }

    function test_zeroGasPriceDoesNotChargeUnprovenL1Allowance() public {
        bytes32 hostId = _enrolled();
        vm.txGasPrice(0);
        _reportOffline(hostId, reporterPks);
        assertEq(reg.credits(payee), 0);
    }

    function test_nearEmptyBudgetClampsChargeAndStillRecords() public {
        // A deliberately tiny payer-signed cap, not recovery bypassing a larger protected reserve floor.
        bytes32 hostId = keccak256(bytes(ENDPOINT));
        R.SponsorReservation memory budget = _reservation(hostId, HW, JOB, anchorId);
        budget.protectedAmount = 1;
        budget.perTransitionCap = 1;
        budget.l1FeeAllowance = 0;
        bytes32 rid = _reserve(budget);
        Prepared memory c = _preparedFor(rid);
        c.e.protectedAmount = 1;
        _resign(c, verifierPks);
        _submit(c);
        assertTrue(_active(hostId));
        assertEq(_balance(hostId), 1);
        _reportOffline(hostId, reporterPks);
        assertFalse(_active(hostId));
        assertEq(reg.credits(payee), 1, "charge clamped to the 1 wei actually available");
        assertEq(_balance(hostId), 0);
    }

    function test_claimToZeroAddressRefusedCreditPreserved() public {
        bytes32 hostId = _enrolled();
        _reportOffline(hostId, reporterPks);
        uint256 credit = reg.credits(payee);
        vm.prank(payee);
        vm.expectRevert(R.TransferFailed.selector);
        reg.claimHostReimbursement(payable(address(0)));
        assertEq(reg.credits(payee), credit);
    }

    // ================================================================== recovery funding
    function test_recoveryNewPayerOnlyAfterOldBudgetReleased_creditsUntouched() public {
        bytes32 hostId = _enrolled();
        _reportOffline(hostId, reporterPks);
        uint256 owed = reg.credits(payee);

        address payer2 = vm.addr(PAYER2_PK);
        vm.deal(payer2, 1 ether);
        vm.prank(payer2);
        reg.depositSponsorFunds{value: 1 ether}();
        bytes32 rid = _reserveAs(PAYER2_PK, _reservation(hostId, HW, JOB2, anchorId));
        assertEq(reg.hardwareReservation(HW) != rid, true, "recovery reservations do not take a bootstrap slot");

        RecoveryCase memory c = _recovery(hostId, OPERATOR_PK);
        c.v.reservationId = rid;
        c.v.protectedAmount = PROTECTED;
        _signRecovery(c, OPERATOR_PK);
        _recoverReverts(c, R.BadBudget.selector);                  // never mix two payers' funds

        uint128 rest = _balance(hostId);
        vm.prank(payer);
        reg.releaseHostBudget(hostId, rest);

        uint256 submitterBefore = reg.credits(submitter);
        _recover(c);
        assertTrue(_active(hostId));
        assertEq(_budget(hostId).payer, payer2);
        assertEq(_balance(hostId), PROTECTED);
        assertEq(reg.credits(payee), owed, "recovery does not reset or consume owed credits");
        assertGt(reg.credits(submitter), submitterBefore);
        assertEq(_resStatus(rid), reg.RES_CONSUMED());
    }
}
