// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;
import "forge-std/Test.sol";
import {EnclaveDeploymentLifecycle as Lifecycle} from "../../../../contracts/EnclaveDeploymentLifecycle.sol";
import {EnclaveSelfHostingIdentity as Identity} from "../../../../contracts/EnclaveSelfHostingIdentity.sol";
import {EnclaveDeployments as Ledger} from "../../../../deploy/lifecycle/EnclaveDeployments.sol";
import {EnclaveRegistry} from "../../../../contracts/EnclaveRegistry.sol";
import {MockUSDC} from "../../../../contracts/foundry/test/mocks/MockUSDC.sol";
import {SessionVaultFactory, ISVToken, ISVBook, ISVRouter, ISVKeyAttestations} from "../../../../contracts/SessionVault.sol";

contract TestVault {
    address public owner;
    constructor(address o) { owner = o; }
}
contract TestFactory {
    mapping(address => bool) public isVault;
    mapping(address => address) public vaultFor;
    function create(address o) external returns(address v) {
        v = address(new TestVault(o)); isVault[v] = true; vaultFor[o] = v;
    }
}
contract LifecycleTest is Test {
    Lifecycle lc;
    Ledger ledger;
    EnclaveRegistry registry;
    MockUSDC usdc;
    Identity identity;
    TestFactory factory;
    uint256 ownerKey = uint256(keccak256("lifecycle owner test"));
    uint256 operatorKey = uint256(keccak256("lifecycle operator test"));
    address appOwner;
    address operator;
    address relay;
    bytes32 host;
    bytes32 app;
    uint256[] witnessKeys;
    address[] witnesses;

    function setUp() public {
        vm.warp(1_800_000_000); vm.txGasPrice(6_000_000);
        appOwner = vm.addr(ownerKey); operator = vm.addr(operatorKey); relay = makeAddr("relay");
        usdc = new MockUSDC(); registry = new EnclaveRegistry();
        ledger = new Ledger(address(usdc), makeAddr("payout"), address(registry), address(0));
        ledger.setProofRequiredFrom(0);
        lc = new Lifecycle(address(ledger), address(0));
        factory = new TestFactory();
        Identity.FactoryPin[] memory pins = new Identity.FactoryPin[](1);
        pins[0] = Identity.FactoryPin(address(factory), address(factory).codehash);
        identity = new Identity(pins); ledger.bindLifecycle(address(lc), address(identity));
        vm.prank(operator);
        host = registry.register("https://lifecycle.example", "EnclaveHost/enclave", bytes32(0), 100, 100, makeAddr("proof"));
        vm.prank(appOwner); registry.setPayoutWallet(host);
        for(uint256 i; i < 4; ++i) witnessKeys.push(uint256(keccak256(abi.encode("lifecycle witness test", i))));
        // Canonical signature order is ascending recovered address.
        for(uint256 i; i < 4; ++i) for(uint256 j=i+1; j<4; ++j) {
            if(vm.addr(witnessKeys[j]) < vm.addr(witnessKeys[i])) (witnessKeys[i], witnessKeys[j])=(witnessKeys[j],witnessKeys[i]);
        }
        for(uint256 i; i < 4; ++i) witnesses.push(vm.addr(witnessKeys[i]));
        vm.deal(appOwner, 1 ether); vm.deal(relay, 1 ether);
        app = _create(appOwner);
        _configure(app, appOwner);
    }
    function _create(address o) internal returns(bytes32) {
        vm.prank(o); return ledger.create("catalog://app/0",0,1000,8000,"",true,"",address(0),0,100);
    }
    function _configure(bytes32 id,address o) internal {
        vm.prank(o); lc.configure(id,witnesses,3,0.00001 ether,0.00001 ether,50_000_000);
        vm.prank(appOwner); lc.deposit{value:0.001 ether}(id);
    }
    function _intent(bytes32 id,Lifecycle.State target,bytes32 toHost) internal view returns(Lifecycle.Intent memory x) {
        (,,uint64 gen,uint64 rev,,,,,,,)=lc.assignments(id);
        x=Lifecycle.Intent(id,gen,rev,target,toHost,uint64(vm.getBlockTimestamp()+60),0,relay,0.00001 ether);
    }
    function _sign(uint256 key,bytes32 h) internal pure returns(bytes memory) {
        (uint8 v,bytes32 r,bytes32 s)=vm.sign(key,h); return abi.encodePacked(r,s,v);
    }
    function _approvals(Lifecycle.Intent memory x) internal view returns(bytes[] memory signatures) {
        signatures=new bytes[](3); bytes32 h=lc.digest(x);
        for(uint256 i;i<3;++i) signatures[i]=_sign(witnessKeys[i],h);
    }
    function _send(Lifecycle.Intent memory x,uint256 key) internal returns(bool) {
        bytes memory actor=key==0?bytes(""):_sign(key,lc.digest(x));
        bytes[] memory approvals=_approvals(x);
        vm.prank(relay); return lc.transition(x,actor,approvals);
    }
    function _reject(Lifecycle.Intent memory x,uint256 key,string memory why) internal {
        bytes memory actor=key==0?bytes(""):_sign(key,lc.digest(x));
        bytes[] memory approvals=_approvals(x);
        vm.expectRevert(bytes(why)); vm.prank(relay); lc.transition(x,actor,approvals);
    }
    function _run() internal {
        _send(_intent(app,Lifecycle.State.Queued,bytes32(0)),ownerKey);
        _send(_intent(app,Lifecycle.State.Running,host),operatorKey);
    }
    function test_contractsFitProductionCodeSize() public view {
        assertLe(address(ledger).code.length,24576); assertLe(address(lc).code.length,24576);
    }
    function test_selfHostedRunsForMonthsWithoutRenewalsOrReserveCharges() public {
        _run(); (uint256 beforeBalance,,,)=lc.budgets(app);
        assertEq(ledger.get(app).rate,0); assertEq(ledger.get(app).leaseUntil,type(uint64).max);
        vm.warp(vm.getBlockTimestamp()+90 days);
        assertTrue(lc.funded(app));
        (uint256 afterBalance,,,)=lc.budgets(app); assertEq(afterBalance,beforeBalance);
        (bool renewed,) = address(ledger).call(abi.encodeWithSignature("renew(bytes32)",app)); assertFalse(renewed);
        (bool claimed,) = address(ledger).call(abi.encodeWithSignature("claim(bytes32,bytes32)",app,host)); assertFalse(claimed);
    }
    function test_paidRunExpiresAtFundedHorizonAndTopupExtendsInSameTransaction() public {
        vm.prank(appOwner); registry.clearPayoutWallet(host);
        usdc.mint(appOwner,2_000_000);
        vm.startPrank(appOwner); usdc.approve(address(ledger),2_000_000); ledger.fund(app,1_000_000); vm.stopPrank();
        uint256 started=vm.getBlockTimestamp(); _run();
        assertEq(ledger.get(app).leaseUntil,started+10000);
        vm.warp(started+3600); assertTrue(lc.funded(app));
        vm.prank(appOwner); ledger.fund(app,1_000_000);
        assertEq(ledger.get(app).leaseUntil,started+20000);
        vm.warp(started+20000); assertFalse(lc.funded(app));
    }
    function test_idempotentRetryDoesNotChargeTwiceAndStaleIntentCannotReplaceGeneration() public {
        Lifecycle.Intent memory x=_intent(app,Lifecycle.State.Queued,bytes32(0));
        assertTrue(_send(x,ownerKey)); (uint256 beforeBalance,,,)=lc.budgets(app);
        assertFalse(_send(x,ownerKey)); (uint256 afterBalance,,,)=lc.budgets(app); assertEq(beforeBalance,afterBalance);
        x.deadline++; _reject(x,ownerKey,"stale assignment");
    }
    function test_failureQueuesAndFencesBeforeReplacementStarts() public {
        _run(); _send(_intent(app,Lifecycle.State.Queued,bytes32(0)),0);
        assertEq(ledger.get(app).runnerOperator,address(0));
        _reject(_intent(app,Lifecycle.State.Running,host),operatorKey,"not startable");
        vm.warp(vm.getBlockTimestamp()+lc.FENCE_SEC());
        _send(_intent(app,Lifecycle.State.Running,host),operatorKey); assertTrue(lc.funded(app));
    }
    function test_crashLoopHoldsAfterFiveAcrossGenerationsAndRequiresOwnerResume() public {
        _run();
        for(uint256 i;i<5;++i) {
            _send(_intent(app,Lifecycle.State.Queued,bytes32(0)),operatorKey);
            vm.warp(vm.getBlockTimestamp()+300);
            if(i<4) _send(_intent(app,Lifecycle.State.Running,host),operatorKey);
        }
        vm.warp(vm.getBlockTimestamp()+30 days);
        _reject(_intent(app,Lifecycle.State.Running,host),operatorKey,"not startable");
        vm.expectRevert("not owner"); lc.resume(app);
        vm.prank(appOwner); lc.resume(app);
        _send(_intent(app,Lifecycle.State.Running,host),operatorKey);
    }
    function test_duplicateWitnessCannotAuthorizeFailover() public {
        _run(); Lifecycle.Intent memory x=_intent(app,Lifecycle.State.Queued,bytes32(0));
        bytes[] memory sigs=_approvals(x); sigs[1]=sigs[0];
        vm.expectRevert("invalid witness quorum"); vm.prank(relay); lc.transition(x,"",sigs);
        assertTrue(lc.funded(app));
    }
    function test_adminRetirementAndOwnerStopOverrideWitnesses() public {
        _run(); ledger.retire(); assertFalse(lc.funded(app));
        _send(_intent(app,Lifecycle.State.Stopped,bytes32(0)),ownerKey);
        assertFalse(ledger.get(app).active);
    }
    function test_finalStopBudgetCannotBeSpentOnAnotherStart() public {
        // Set a transition cap nearly as large as the entire deposited budget.
        vm.prank(appOwner); lc.configure(app,witnesses,3,0.001 ether,0.001 ether,50_000_000);
        _reject(_intent(app,Lifecycle.State.Queued,bytes32(0)),ownerKey,"transition reserve");
        // A final stop remains payable from the protected portion.
        _send(_intent(app,Lifecycle.State.Stopped,bytes32(0)),ownerKey);
    }
    function test_verifiedVaultIsSelfHostedButArbitraryOwnerGetterIsNot() public {
        address vault=factory.create(appOwner); address fake=address(new TestVault(appOwner));
        assertTrue(identity.sameOwner(vault,appOwner)); assertFalse(identity.sameOwner(fake,appOwner));
        bytes32 vapp=_create(vault); bytes32 fapp=_create(fake);
        assertEq(ledger.rateFor(vapp,host),0); assertEq(ledger.rateFor(fapp,host),100);
    }
    function test_oldOwnerCannotWithdrawAndRunningReserveCannotBeDrained() public {
        _run(); vm.expectRevert("not stopped"); vm.prank(appOwner); lc.withdraw(app,1);
        vm.expectRevert(abi.encodeWithSelector(Ledger.LedgerRefused.selector, uint16(14))); vm.prank(appOwner); ledger.transferDeployment(app,makeAddr("new owner"));
    }
    function test_queuedStopAlsoDisablesLedgerAndAllowsCleanOwnershipTransfer() public {
        _send(_intent(app,Lifecycle.State.Queued,bytes32(0)),ownerKey);
        _send(_intent(app,Lifecycle.State.Stopped,bytes32(0)),ownerKey);
        assertFalse(ledger.get(app).active);
        address nextOwner=makeAddr("next owner");
        vm.expectRevert(abi.encodeWithSelector(Ledger.LedgerRefused.selector,uint16(14)));
        vm.prank(appOwner); ledger.transferDeployment(app,nextOwner);
        (uint256 remaining,,,)=lc.budgets(app);
        vm.prank(appOwner); lc.withdraw(app,remaining);
        vm.prank(appOwner); ledger.transferDeployment(app,nextOwner);
        vm.expectRevert("not owner"); vm.prank(appOwner); lc.configure(app,witnesses,3,1,1,1);
        vm.prank(nextOwner); lc.configure(app,witnesses,3,0.00001 ether,0.00001 ether,50_000_000);
        assertEq(lc.ownerAuthority(app),nextOwner);
    }
    function test_verifiedVaultOwnerControlsReserveWithoutImpersonatingVault() public {
        address vault=factory.create(appOwner); bytes32 id=_create(vault);
        _configure(id,appOwner);
        assertEq(lc.ownerAuthority(id),appOwner);
        _send(_intent(id,Lifecycle.State.Queued,bytes32(0)),ownerKey);
        _send(_intent(id,Lifecycle.State.Stopped,bytes32(0)),ownerKey);
        (uint256 remaining,,,)=lc.budgets(id);
        uint256 beforeBalance=appOwner.balance;
        vm.prank(appOwner); lc.withdraw(id,remaining);
        assertEq(appOwner.balance,beforeBalance+remaining);
    }
    function test_realSessionVaultCloneIdentityMatchesPinnedFactoryOnly() public {
        SessionVaultFactory realFactory=new SessionVaultFactory(ISVToken(address(usdc)),ISVBook(address(0)),ISVRouter(address(0)),ISVKeyAttestations(address(0)),10_000_000);
        address vault=realFactory.createVault(appOwner);
        Identity.FactoryPin[] memory pins=new Identity.FactoryPin[](1);
        pins[0]=Identity.FactoryPin(address(realFactory),address(realFactory).codehash);
        Identity realIdentity=new Identity(pins);
        assertEq(realIdentity.principal(vault),appOwner);
        address fake=address(new TestVault(appOwner));
        assertEq(realIdentity.principal(fake),fake);
    }
    function test_loweredRateCapPreventsTopupExtendingOldExpensiveAssignment() public {
        vm.prank(appOwner); registry.clearPayoutWallet(host);
        usdc.mint(appOwner,2_000_000);
        vm.startPrank(appOwner); usdc.approve(address(ledger),2_000_000); ledger.fund(app,1_000_000); vm.stopPrank();
        _run(); uint64 previous=ledger.get(app).leaseUntil;
        vm.prank(appOwner); ledger.setMaxRate(app,50);
        vm.expectRevert(abi.encodeWithSelector(Ledger.LedgerRefused.selector,uint16(15)));
        vm.prank(appOwner); ledger.fund(app,1_000_000);
        assertEq(ledger.get(app).leaseUntil,previous);
        assertEq(usdc.balanceOf(appOwner),1_000_000);
    }
}
