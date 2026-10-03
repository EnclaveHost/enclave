// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "forge-std/Test.sol";
import {EnclaveDeployments} from "../../EnclaveDeployments.sol";
import {EnclaveRegistry} from "../../EnclaveRegistry.sol";
import {EnclaveProofOfTime} from "../../EnclaveProofOfTime.sol";
import {EnclaveAvailability} from "../../EnclaveAvailability.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract AvailabilityUSDC is MockUSDC {
    mapping(address => mapping(bytes32 => bool)) public used;
    function receiveWithAuthorization(address from, address to, uint256 value, uint256 after_,
        uint256 before_, bytes32 nonce, bytes calldata signature) external {
        require(msg.sender == to && block.timestamp > after_ && block.timestamp < before_, "auth time/payee");
        require(!used[from][nonce] && signature.length == 65, "auth replay");
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), keccak256(abi.encode(
            keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"),
            from, to, value, after_, before_, nonce))));
        bytes32 r; bytes32 s; uint8 v;
        assembly { r := calldataload(signature.offset) s := calldataload(add(signature.offset,32)) v := byte(0,calldataload(add(signature.offset,64))) }
        require(ecrecover(digest,v,r,s) == from && from != address(0), "auth signer");
        used[from][nonce] = true;
        allowance[from][address(this)] = value;
        require(this.transferFrom(from,to,value), "auth transfer");
    }
}

contract EnclaveAvailabilityTest is Test {
    EnclaveDeployments dep; EnclaveRegistry reg; EnclaveProofOfTime pot;
    AvailabilityUSDC token; EnclaveAvailability audit;
    uint256 constant USER_PK = 0xabc; uint256 constant PROOF_PK = 0xdef;
    uint64 constant T = 1_800_000_000;
    address user; address operator = address(0x123); address executor = address(0x456);
    bytes32 host; bytes32 source; bytes32 job;
    function setUp() public {
        vm.warp(T); vm.roll(1000); user = vm.addr(USER_PK);
        token = new AvailabilityUSDC(); reg = new EnclaveRegistry();
        dep = new EnclaveDeployments(address(token), address(0x999), address(reg), address(0));
        pot = new EnclaveProofOfTime(address(dep), address(reg)); dep.setProver(address(pot));
        dep.setProofRequiredFrom(T);
        audit = new EnclaveAvailability(address(dep),address(pot));
        vm.prank(operator); host = reg.register("https://host.example","EnclaveHost/enclave",bytes32(0),10000,10000,vm.addr(PROOF_PK));
        token.mint(user,1000e6); vm.prank(user); token.approve(address(dep),type(uint256).max);
        source = _create(); job = _create();
        vm.prank(user); dep.fund(source,100e6);
        vm.prank(operator); dep.claim(source,host);
        _policy(1000,10e6,1e6);
    }
    function _create() internal returns(bytes32 id) {
        vm.prank(user); return dep.create("catalog://ordinary-app/0",0,1000,8081,"",true,"",address(0),0,10000);
    }
    function _policy(uint16 bps,uint256 daily,uint256 perJob) internal {
        vm.prank(user); audit.setPolicy(source,executor,bps,daily,perJob,T+2 days);
    }
    function _checkpoint(uint64 until) internal {
        vm.warp(until); vm.roll(1100);
        bytes32 anchor=keccak256("anchor"); vm.setBlockhash(1099,anchor);
        bytes32 digest=pot.proofDigest(source,host,operator,until,1099,anchor);
        (uint8 v,bytes32 r,bytes32 s)=vm.sign(PROOF_PK,digest);
        audit.checkpoint(source,host,until,1099,anchor,abi.encodePacked(r,s,v));
    }
    function _fund(bytes32 target,uint256 amount) internal {
        (,,,,uint64 epoch,,,)=audit.policies(source);
        bytes32 expectedHash=audit.jobHash(target);
        bytes32 nonce = audit.fundingNonce(source,target,epoch,expectedHash);
        uint256 before_=T+1 days;
        bytes32 digest=keccak256(abi.encodePacked("\x19\x01",token.DOMAIN_SEPARATOR(),keccak256(abi.encode(
            keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"),
            user,address(audit),amount,uint256(T-1),before_,nonce))));
        (uint8 v,bytes32 r,bytes32 s)=vm.sign(USER_PK,digest);
        vm.prank(executor); audit.fundJob(source,target,epoch,expectedHash,amount,T-1,before_,nonce,abi.encodePacked(r,s,v));
    }
    function fund(bytes32 target,uint256 amount) external { _fund(target,amount); }
    function prove(uint64 until) external { _checkpoint(until); }
    function testPaidServiceFundsOrdinaryJobAndPreservesRefunds() public {
        _checkpoint(T+600);
        uint256 earned=dep.earned6(operator);
        (,,,,,,,uint256 budget)=audit.policies(source);
        assertEq(budget,earned/10); assertGt(budget,0);
        uint256 payerBefore=token.balanceOf(user);
        _fund(job,budget);
        assertEq(token.balanceOf(user),payerBefore-budget);
        assertEq(token.balanceOf(address(audit)),0);
        assertEq(dep.get(job).owner,user); assertEq(dep.get(job).balance6,budget);
        assertGt(dep.ownerEscrow6(job),0); assertEq(dep.earned6(operator),earned);
        vm.prank(operator); dep.claim(job,host);
        assertEq(dep.get(job).runner,host);
        assertGt(dep.get(job).rate,0); // normal paid hosting, never a special reward payout
    }
    function testNoBudgetWithoutProvenService() public { vm.expectRevert("budget"); this.fund(job,1); }
    function testNoRetroactiveBudget() public {
        _checkpoint(T+600); _policy(1000,10e6,1e6);
        (,,,,,,,uint256 budget)=audit.policies(source); assertEq(budget,0);
    }
    function testDuplicateProofDoesNotCreateMoreBudget() public {
        _checkpoint(T+600); vm.expectRevert("nothing to prove"); this.prove(T+600);
    }
    function testDailyLimitSurvivesPolicyEdit() public {
        _policy(1000,300000,300000); _checkpoint(T+600); _fund(job,300000);
        _policy(1000,300000,300000); _checkpoint(T+1200);
        bytes32 next=_create(); vm.expectRevert("daily cap"); this.fund(next,1);
    }
    function testFundedJobsCannotBeRevenueSources() public {
        _checkpoint(T+600); _fund(job,1);
        vm.prank(user); vm.expectRevert("recursive budget"); audit.setPolicy(job,executor,100,100,10,T+1 days);
    }
    function testSourcesCannotBeFundedAsJobs() public {
        _checkpoint(T+600); vm.expectRevert("used job"); this.fund(source,1);
    }
    function testJobFundingCannotReplay() public {
        _checkpoint(T+600); _fund(job,1); vm.expectRevert("used job"); this.fund(job,1);
    }
    function testRevocationStopsSpendingButNotHostSettlement() public {
        _policy(0,0,0); _checkpoint(T+600); assertGt(dep.earned6(operator),0);
        vm.expectRevert("inactive policy"); this.fund(job,1);
    }
    function testWrongPairRefused() public {
        EnclaveProofOfTime other=new EnclaveProofOfTime(address(dep),address(reg));
        vm.expectRevert("wrong proof pair"); new EnclaveAvailability(address(dep),address(other));
    }
    function testTokenFailureRollsBackBudgetAndJob() public {
        _checkpoint(T+600); token.setFailTransfers(true);
        vm.expectRevert("auth transfer"); this.fund(job,1);
        assertFalse(audit.fundedJob(job)); token.setFailTransfers(false); _fund(job,1);
    }
    function testBudgetOnlyAccruesAfterProofCutover() public {
        dep.setProofRequiredFrom(T+1 days); _checkpoint(T+600);
        (,,,,,,,uint256 budget)=audit.policies(source); assertEq(budget,0);
    }
    function testAuthorizationCannotBypassCompanion() public {
        _checkpoint(T+600);
        bytes32 hash=audit.jobHash(job);
        (,,,,uint64 epoch,,,)=audit.policies(source);
        bytes32 nonce=audit.fundingNonce(source,job,epoch,hash);
        bytes32 digest=keccak256(abi.encodePacked("\x19\x01",token.DOMAIN_SEPARATOR(),keccak256(abi.encode(
            keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"),
            user,address(audit),uint256(100),uint256(T-1),uint256(T+1 days),nonce))));
        (uint8 v,bytes32 r,bytes32 sigS)=vm.sign(USER_PK,digest);
        bytes memory sig=abi.encodePacked(r,sigS,v);
        // Publishing a token signature gives neither an arbitrary account nor
        // the ledger the ability to redeem it outside the budget checks.
        vm.expectRevert("auth time/payee");
        token.receiveWithAuthorization(user,address(audit),100,T-1,T+1 days,nonce,sig);
        vm.expectRevert();dep.fundWithAuthorization(job,user,100,T-1,T+1 days,nonce,sig);
        vm.prank(executor);audit.fundJob(source,job,epoch,hash,100,T-1,T+1 days,nonce,sig);
        assertEq(dep.get(job).balance6,100);assertTrue(audit.fundedJob(job));
        assertEq(token.balanceOf(address(audit)),0);
        assertEq(token.allowance(address(audit),address(dep)),0);
    }
    function testFundForOnlyDebitsCallerAndAttributesGift() public {
        address donor=address(0xbeef);token.mint(donor,100000);
        uint256 original=token.balanceOf(user);
        vm.prank(donor);token.approve(address(dep),100000);
        vm.prank(donor);dep.fundFor(job,100000,user);
        assertEq(token.balanceOf(user),original);assertEq(token.balanceOf(donor),0);
        assertGt(dep.ownerEscrow6(job),0);
        uint256 refund=dep.refundableOf(job);
        vm.prank(user);dep.refund(job);assertEq(token.balanceOf(user),original+refund);
    }
    function testFuzzBudgetNeverExceedsFraction(uint16 bps) public {
        bps=uint16(bound(bps,1,1000)); _policy(bps,10e6,1e6); _checkpoint(T+600);
        (,,,,,,,uint256 budget)=audit.policies(source);
        assertEq(budget,dep.earned6(operator)*bps/10000);
    }
}
