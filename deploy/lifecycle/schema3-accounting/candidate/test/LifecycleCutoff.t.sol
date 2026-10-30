// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;
import {LifecycleProofOfTimeTest} from "./LifecycleProofOfTime.t.sol";
import {EnclaveProofOfTime as Proof} from "../deploy/EnclaveProofOfTime.sol";
import {EnclaveDeployments as Ledger} from "../deploy/EnclaveDeployments.sol";
import {EnclaveDeploymentLifecycleEmergency as Lifecycle} from "emergency/EnclaveDeploymentLifecycleEmergency.sol";

/// Actual ledger/controller/prover integration. Source only until built and run.
/// Inherited tests are intentionally rerun, not counted as additional scenarios.
contract LifecycleCutoffTest is LifecycleProofOfTimeTest {
    function _offline(Lifecycle.State target) internal returns (Lifecycle.Emergency memory x) {
        (,,uint64 gen,uint64 rev,bytes32 h,address op,,,,,) = lc.assignments(app);
        x = Lifecycle.Emergency(app,gen,rev,Lifecycle.State.Running,h,op,target,
            uint64(vm.getBlockTimestamp()+60),address(0),0);
        bytes32 digest = lc.emergencyDigest(x);
        bytes[] memory approvals = new bytes[](3);
        for (uint256 i; i<3; ++i) approvals[i] = _sign(witnessKeys[i],digest);
        vm.prank(relay); assertTrue(lc.emergencyOffline(x,approvals));
    }
    function _ledgerRefusal(uint16 code) internal {
        vm.expectRevert(abi.encodeWithSelector(Ledger.LedgerRefused.selector,code));
    }
    function test_cutoffDelayedSettlementConservesBudgetAndEscrow() public {
        uint256 start = _paidStart();
        (uint256 rate,uint256 escrow,) = ledger.earnOf(app);
        vm.warp(start+100); _offline(Lifecycle.State.Queued);
        assertFalse(lc.funded(app));
        assertEq(ledger.get(app).runnerOperator,operator);
        vm.warp(start+5000); ledger.settle(app);
        assertEq(ledger.earned6(operator),100*rate);
        assertTrue(lc.reconcileOffline(app)); assertFalse(lc.reconcileOffline(app));
        Ledger.Deployment memory d = ledger.get(app);
        assertEq(d.runnerOperator,address(0)); assertEq(d.leaseUntil,0);
        assertEq(d.balance6,990_000); assertEq(d.spent6,10_000);
        assertEq(d.balance6+d.spent6,1_000_000);
        (,uint256 remaining,) = ledger.earnOf(app);
        assertEq(remaining+ledger.earned6(operator),escrow);
    }
    function test_cutoffProofAndCoverageStopAtRecordedInstant() public {
        Proof p = _installProof(); uint256 start = _paidStart();
        vm.warp(start+100); _offline(Lifecycle.State.Queued);
        vm.warp(start+1000); assertEq(p.unprovenSec(app),100);
        _checkpoint(p,uint64(start+1000));
        assertEq(ledger.provenUntil(app),start+100);
        (,uint64 proven,uint32 proofs) = p.recordOf(app);
        assertEq(proven,100); assertEq(proofs,1); assertEq(p.hostedSec(operator),100);
        assertEq(p.unprovenSec(app),0);
        (uint256 rate,,) = ledger.earnOf(app);
        assertEq(ledger.earned6(operator),100*rate);
        assertTrue(lc.reconcileOffline(app));
        assertEq(ledger.earned6(operator),100*rate);
        assertEq(ledger.get(app).balance6,990_000);
    }
    function test_cutoffTopupDoesNotReburnRevokedRun() public {
        uint256 start = _paidStart(); uint64 horizon=ledger.get(app).leaseUntil;
        vm.warp(start+100); _offline(Lifecycle.State.Queued);
        vm.prank(appOwner); ledger.fund(app,1_000_000);
        assertEq(ledger.get(app).leaseUntil,horizon);
        assertEq(ledger.get(app).balance6,1_000_000);
        vm.warp(start+5000); lc.reconcileOffline(app);
        assertEq(ledger.get(app).balance6,1_990_000);
        assertEq(ledger.get(app).spent6,10_000);
    }
    function test_cutoffBlocksRefundSweepTransferAndReplacementUntilReconciled() public {
        uint256 start=_paidStart(); vm.warp(start+100); _offline(Lifecycle.State.Queued);
        assertEq(ledger.refundableOf(app),0);
        _ledgerRefusal(45); vm.prank(appOwner); ledger.refund(app);
        _ledgerRefusal(45); ledger.sweepEscrow(app);
        _ledgerRefusal(14); vm.prank(appOwner); ledger.transferDeployment(app,relay);
        vm.warp(start+1000);
        // Build signature before expectRevert so helper reads do not consume it.
        Lifecycle.Intent memory x=_intent(app,Lifecycle.State.Running,host);
        bytes memory actor=_sign(operatorKey,lc.digest(x)); bytes[] memory approvals=_approvals(x);
        vm.expectRevert("offline settlement pending"); vm.prank(relay); lc.transition(x,actor,approvals);
        lc.reconcileOffline(app);
        _send(_intent(app,Lifecycle.State.Running,host),operatorKey);
        assertTrue(lc.funded(app));
    }
    function test_cutoffAcknowledgementIsExactIdempotentAndStaleSafe() public {
        uint256 start=_paidStart(); vm.warp(start+100);
        Lifecycle.Emergency memory x=_offline(Lifecycle.State.Queued);
        lc.reconcileOffline(app);
        bytes32 expected=lc.settlementAck(app,x.generation,host,operator,uint64(start+100),false);
        vm.prank(address(lc));
        assertEq(ledger.lifecycleEndAt(app,x.generation,host,operator,uint64(start+100),false),expected);
        _ledgerRefusal(46); vm.prank(address(lc));
        ledger.lifecycleEndAt(app,x.generation,host,operator,uint64(start+101),false);
        vm.warp(start+1000); _send(_intent(app,Lifecycle.State.Running,host),operatorKey);
        _ledgerRefusal(46); vm.prank(address(lc));
        ledger.lifecycleEndAt(app,x.generation,host,operator,uint64(start+100),false);
        assertEq(ledger.get(app).runnerOperator,operator);
    }
    function test_cutoffRejectsWrongHostGenerationFlagAndUnboundCaller() public {
        uint256 start=_paidStart(); vm.warp(start+100);
        Lifecycle.Emergency memory x=_offline(Lifecycle.State.Stopped);
        _ledgerRefusal(2); ledger.lifecycleEndAt(app,x.generation,host,operator,uint64(start+100),true);
        _ledgerRefusal(46); vm.prank(address(lc));
        ledger.lifecycleEndAt(app,x.generation+1,host,operator,uint64(start+100),true);
        _ledgerRefusal(46); vm.prank(address(lc));
        ledger.lifecycleEndAt(app,x.generation,bytes32(uint256(1)),operator,uint64(start+100),true);
        _ledgerRefusal(46); vm.prank(address(lc));
        ledger.lifecycleEndAt(app,x.generation,host,operator,uint64(start+100),false);
        assertTrue(lc.reconcileOffline(app)); assertFalse(ledger.get(app).active);
    }
    function test_cutoffPastFundedHorizonNeverReturnsUnpurchasedTail() public {
        uint256 start=_paidStart(); (uint256 rate,uint256 escrow,)=ledger.earnOf(app);
        vm.warp(start+20_000); _offline(Lifecycle.State.Stopped);
        vm.warp(start+30_000); lc.reconcileOffline(app);
        assertEq(ledger.get(app).balance6,0); assertEq(ledger.get(app).spent6,1_000_000);
        assertEq(ledger.earned6(operator),10_000*rate);
        (,uint256 remaining,)=ledger.earnOf(app);
        assertEq(remaining+ledger.earned6(operator),escrow);
    }
    function test_cutoffExpiredRunRateCannotBeRebasedBeforeSettlement() public {
        uint256 start=_paidStart(); vm.warp(start+100); _offline(Lifecycle.State.Queued);
        vm.warp(start+20_000); vm.prank(appOwner); ledger.setMaxRate(app,50);
        assertEq(ledger.get(app).rate,100);
        lc.reconcileOffline(app);
        assertEq(ledger.get(app).balance6,990_000); assertEq(ledger.get(app).spent6,10_000);
    }
    function test_cutoffZeroRateUnlimitedHorizonDoesNotOverflowOrCreateCredits() public {
        _run(); vm.warp(vm.getBlockTimestamp()+90 days); _offline(Lifecycle.State.Stopped);
        vm.warp(vm.getBlockTimestamp()+90 days); lc.reconcileOffline(app);
        assertEq(ledger.get(app).spent6,0); assertEq(ledger.earned6(operator),0);
        assertEq(ledger.get(app).leaseUntil,0); assertFalse(ledger.get(app).active);
    }
    function test_retirementCannotCancelOtherOwnersOrPreventFundingAndStarts() public {
        uint256 start=_paidStart(); ledger.retire(); assertTrue(lc.funded(app));
        _ledgerRefusal(3); vm.prank(relay); ledger.refund(app);
        vm.prank(appOwner); ledger.fund(app,1_000_000);
        assertEq(ledger.get(app).leaseUntil,start+20_000);
        _send(_intent(app,Lifecycle.State.Queued,bytes32(0)),operatorKey);
        vm.warp(start+1000); _send(_intent(app,Lifecycle.State.Running,host),operatorKey);
        assertTrue(lc.funded(app));
        _send(_intent(app,Lifecycle.State.Stopped,bytes32(0)),ownerKey);
        assertFalse(ledger.get(app).active);
    }
    function test_cutoffEarnedWithdrawalRemainsAvailableAndRefundIsConserved() public {
        uint256 start=_paidStart(); (uint256 rate,uint256 escrow,)=ledger.earnOf(app);
        vm.warp(start+100); ledger.settle(app); _offline(Lifecycle.State.Stopped);
        uint256 previous=usdc.balanceOf(operator);
        vm.prank(operator); ledger.withdrawEarnings(operator);
        assertEq(usdc.balanceOf(operator)-previous,100*rate);
        lc.reconcileOffline(app);
        uint256 refund=ledger.refundableOf(app);
        uint256 beforeOwner=usdc.balanceOf(appOwner);
        vm.prank(appOwner); ledger.refund(app);
        assertEq(usdc.balanceOf(appOwner)-beforeOwner,refund);
        assertEq(refund+100*rate,escrow);
        (,uint256 remaining,)=ledger.earnOf(app); assertEq(remaining,0);
    }
    function test_cutoffRecordsDespiteAdmissionDependencyFailure() public {
        uint256 start=_paidStart(); vm.warp(start+100);
        // Fail only the registry read. Real ledger/controller code is unchanged.
        vm.mockCallRevert(address(registry),abi.encodeWithSignature("get(bytes32)",host),bytes("registry unavailable"));
        _offline(Lifecycle.State.Stopped);
        (,,,bool pending,,)=lc.offline(app); assertTrue(pending);
        // Exact settlement has no admission lookup and remains independently usable.
        assertTrue(lc.reconcileOffline(app));
        assertFalse(ledger.get(app).active); assertEq(ledger.get(app).balance6,990_000);
        vm.clearMockedCalls();
    }
    function test_cutoffFailedLedgerSettlementPreservesPendingAndLaterUsesRealLedger() public {
        uint256 start=_paidStart(); vm.warp(start+100);
        Lifecycle.Emergency memory x=_offline(Lifecycle.State.Queued);
        bytes memory callData=abi.encodeWithSelector(ledger.lifecycleEndAt.selector,
            app,x.generation,host,operator,uint64(start+100),false);
        vm.mockCallRevert(address(ledger),callData,bytes("ledger unavailable"));
        vm.expectRevert(bytes("ledger unavailable")); lc.reconcileOffline(app);
        (,,,bool pending,,)=lc.offline(app); assertTrue(pending);
        assertEq(ledger.get(app).runnerOperator,operator);
        vm.clearMockedCalls(); vm.warp(start+5000);
        assertTrue(lc.reconcileOffline(app));
        assertEq(ledger.get(app).balance6,990_000); assertEq(ledger.get(app).spent6,10_000);
    }

}
