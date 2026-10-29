// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;
import {LifecycleTest} from "./Lifecycle.t.sol";
import {EnclaveDeployments as Ledger, EnclaveLifecycleAccounting} from "../deploy/EnclaveDeployments.sol";
import {EnclaveDeploymentLifecycleEmergency as Lifecycle} from "emergency/EnclaveDeploymentLifecycleEmergency.sol";

/// Regression source prepared before extraction. Not yet executed.
contract AccountingConservationTest is LifecycleTest {
    function _feeApp(uint256 amount) internal returns(address publisher) {
        publisher=makeAddr("publisher");
        vm.prank(appOwner); registry.clearPayoutWallet(host);
        vm.prank(appOwner); app=ledger.create("catalog://fee-app/0",0,1000,8000,"",true,"",publisher,10,110);
        _configure(app,appOwner);
        usdc.mint(appOwner,amount);
        vm.startPrank(appOwner); usdc.approve(address(ledger),amount); ledger.fund(app,amount); vm.stopPrank();
    }
    function test_splitPublisherRunnerPlatformAndRefundConserveActualToken() public {
        address publisher=_feeApp(110_000);
        assertEq(usdc.balanceOf(publisher),10_000); assertEq(usdc.balanceOf(ledger.payout()),20_000);
        assertEq(usdc.balanceOf(address(ledger)),80_000);
        (uint256 rate,uint256 escrow,)=ledger.earnOf(app); assertEq(rate,80); assertEq(escrow,80_000);
        uint256 start=vm.getBlockTimestamp(); _run();
        vm.warp(start+100); _send(_intent(app,Lifecycle.State.Stopped,bytes32(0)),ownerKey);
        assertEq(ledger.get(app).balance6,99_000); assertEq(ledger.get(app).spent6,11_000);
        assertEq(ledger.earned6(operator),8_000);
        vm.prank(operator); ledger.withdrawEarnings(operator);
        vm.prank(appOwner); ledger.refund(app);
        assertEq(usdc.balanceOf(operator),8_000); assertEq(usdc.balanceOf(appOwner),72_000);
        assertEq(usdc.balanceOf(address(ledger)),0);
        assertEq(usdc.balanceOf(operator)+usdc.balanceOf(appOwner)+usdc.balanceOf(publisher)+usdc.balanceOf(ledger.payout()),110_000);
    }
    function test_splitRoundingEscrowsCeilAndFeeFloors() public {
        address publisher=_feeApp(111);
        assertEq(usdc.balanceOf(publisher),10); assertEq(usdc.balanceOf(ledger.payout()),20);
        (,uint256 escrow,)=ledger.earnOf(app); assertEq(escrow,81);
        _run(); assertEq(ledger.get(app).balance6,1); assertEq(ledger.get(app).spent6,110);
    }
    function test_splitTokenTransferFailureRollsBackFundingAndAttribution() public {
        vm.prank(appOwner); registry.clearPayoutWallet(host);
        usdc.mint(appOwner,1_000_000); vm.prank(appOwner); usdc.approve(address(ledger),1_000_000);
        vm.mockCall(address(usdc),abi.encodeWithSignature("transfer(address,uint256)",ledger.payout(),200_000),abi.encode(false));
        vm.expectRevert(abi.encodeWithSelector(Ledger.LedgerRefused.selector,uint16(19)));
        vm.prank(appOwner); ledger.fund(app,1_000_000);
        vm.clearMockedCalls();
        assertEq(usdc.balanceOf(appOwner),1_000_000); assertEq(usdc.balanceOf(address(ledger)),0);
        assertEq(ledger.get(app).balance6,0); assertEq(ledger.ownerEscrow6(app),0);
        (,uint256 escrow,)=ledger.earnOf(app); assertEq(escrow,0);
    }
    function test_delegateRefundPaysOwnerAndNeverDelegate() public {
        _feeApp(110_000);
        vm.prank(appOwner); ledger.setDelegate(relay,true);
        vm.prank(relay); ledger.refund(app);
        assertEq(usdc.balanceOf(appOwner),80_000); assertEq(usdc.balanceOf(relay),0);
        assertFalse(ledger.get(app).active); assertEq(ledger.ownerEscrow6(app),0);
    }
    function _importRow() internal view returns(Ledger.Deployment memory d) {
        d=ledger.get(app); d.id=keccak256("import row regression");
        d.balance6=42; d.spent6=123; d.appRef="catalog://imported/7";
        d.configCid="preserved-config";
    }
    function test_importRetainsRecordAndDoesNotFabricateTokenEscrow() public {
        Ledger.Deployment memory d=_importRow();
        Ledger.Deployment[] memory rows=new Ledger.Deployment[](1); rows[0]=d;
        uint256 beforeCount=ledger.count(); uint256 tokenBalance=usdc.balanceOf(address(ledger));
        ledger.importDeployments(rows);
        assertEq(keccak256(abi.encode(ledger.get(d.id))),keccak256(abi.encode(d)));
        assertEq(ledger.count(),beforeCount+1); assertEq(ledger.capOf(d.id),d.rate);
        (,uint256 escrow,)=ledger.earnOf(d.id); assertEq(escrow,0);
        assertEq(ledger.ownerEscrow6(d.id),0); assertEq(usdc.balanceOf(address(ledger)),tokenBalance);
    }
    function test_importRequiresAdminAndOpenWindow() public {
        Ledger.Deployment[] memory rows=new Ledger.Deployment[](1); rows[0]=_importRow();
        vm.expectRevert(abi.encodeWithSelector(Ledger.LedgerRefused.selector,uint16(3)));
        vm.prank(appOwner); ledger.importDeployments(rows);
        ledger.sealImports();
        vm.expectRevert(abi.encodeWithSelector(Ledger.LedgerRefused.selector,uint16(4)));
        ledger.importDeployments(rows);
        assertEq(ledger.get(rows[0].id).createdAt,0);
    }
    function test_importDuplicateRollsBackEntireBatch() public {
        Ledger.Deployment[] memory rows=new Ledger.Deployment[](2); rows[0]=_importRow(); rows[1]=rows[0];
        uint256 beforeCount=ledger.count();
        vm.expectRevert(abi.encodeWithSelector(Ledger.LedgerRefused.selector,uint16(37)));
        ledger.importDeployments(rows);
        assertEq(ledger.count(),beforeCount); assertEq(ledger.get(rows[0].id).createdAt,0);
    }
    function test_importRefusesAssignedRunnerOrFundedTail() public {
        Ledger.Deployment[] memory rows=new Ledger.Deployment[](1); rows[0]=_importRow();
        rows[0].runnerOperator=operator;
        vm.expectRevert(abi.encodeWithSelector(Ledger.LedgerRefused.selector,uint16(38)));
        ledger.importDeployments(rows);
        rows[0].runnerOperator=address(0); rows[0].leaseUntil=uint64(vm.getBlockTimestamp());
        vm.expectRevert(abi.encodeWithSelector(Ledger.LedgerRefused.selector,uint16(38)));
        ledger.importDeployments(rows);
        assertEq(ledger.get(rows[0].id).createdAt,0);
    }
    function test_actualLinkedAccountingLibraryHasCodeAndSelfBinding() public {
        address lib=address(EnclaveLifecycleAccounting); bytes memory code=lib.code;
        assertGt(code.length,39); assertLe(code.length,24576);
        // Pinned viaIR solc emits its library_deploy_address immutable at7/32.
        assertEq(uint8(code[6]),0x7f);
        address embeddedSelf;
        assembly { embeddedSelf := mload(add(code,39)) }
        assertEq(embeddedSelf,lib);
        emit log_named_address("actual linked accounting library",lib);
        emit log_named_bytes32("actual local library code hash",lib.codehash);
    }

}
