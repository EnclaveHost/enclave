// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "forge-std/Test.sol";
import {EnclaveDeployments} from "../../EnclaveDeployments.sol";
import {EnclaveRegistry} from "../../EnclaveRegistry.sol";
import {EnclaveProofOfTime} from "../../EnclaveProofOfTime.sol";
import {EnclaveVerificationFees,VerificationFeeWallet} from "../../EnclaveVerificationFees.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
contract VerificationFeesTest is Test {
    EnclaveDeployments dep;EnclaveRegistry reg;EnclaveProofOfTime proof;EnclaveVerificationFees fees;MockUSDC token;
    uint256 constant SIGNER=0xdef;uint256 constant EXECUTOR_KEY=0x12345;uint64 constant T=1_800_000_000;
    address payer=address(0x100);address operator=address(0x200);address treasury=address(0x300);address executor;
    bytes32 source;bytes32 host;address wallet;
    function setUp() public {
        vm.warp(T);vm.roll(1000);executor=vm.addr(EXECUTOR_KEY);
        token=new MockUSDC();reg=new EnclaveRegistry();dep=new EnclaveDeployments(address(token),treasury,address(reg),address(0));
        proof=new EnclaveProofOfTime(address(dep),address(reg));dep.setProver(address(proof));dep.setProofRequiredFrom(T);
        fees=new EnclaveVerificationFees(address(dep),address(proof));dep.setFeeRouter(address(fees));
        vm.prank(operator);host=reg.register("https://verification-host.example","repo",bytes32(0),10000,10000,vm.addr(SIGNER));
        vm.prank(payer);source=dep.create("catalog://source/0",0,1000,8000,"",true,"",address(0),0,10000);
        configure(1e6,100000);
        wallet=fees.wallets(source,payer);token.mint(payer,1000e6);
        vm.startPrank(payer);token.approve(address(dep),type(uint256).max);dep.fund(source,100e6);vm.stopPrank();
        vm.prank(operator);dep.claim(source,host);
    }
    function configure(uint256 daily,uint256 job) internal {
        vm.prank(payer);fees.configure(source,executor,125,1000,daily,job,1000,T+1 days,"catalog://capacity-work/0","snp-guest-per-app");
    }
    function checkpoint() internal {
        vm.warp(T+600);vm.roll(1100);bytes32 anchor=keccak256("anchor");vm.setBlockhash(1099,anchor);
        bytes32 digest=proof.proofDigest(source,host,operator,T+600,1099,anchor);
        (uint8 v,bytes32 r,bytes32 s)=vm.sign(SIGNER,digest);
        fees.checkpoint(source,host,T+600,1099,anchor,abi.encodePacked(r,s,v));
    }
    function createJob(uint64 duration) internal returns(bytes32 id){
        vm.prank(executor);id=fees.createJob(source,host,250,100,duration,T+1200,bytes32("test"));
        vm.prank(operator);dep.offerJobRate(id,host,100,T+1200);
    }
    function testFeeSliceDoesNotChargePayerOrReduceHostEscrow() public view {
        assertEq(token.balanceOf(payer),900e6);assertEq(token.balanceOf(wallet),1e6);
        assertEq(token.balanceOf(treasury),19e6);assertEq(token.balanceOf(address(fees)),0);
        (,uint256 escrow,)=dep.earnOf(source);assertEq(escrow,80e6);
    }
    function testOnlyLedgerCanAllocateAndBindingIsOneTime() public {
        vm.expectRevert("ledger only");fees.routeFee(source,payer,100);
        vm.expectRevert("sealed");dep.setFeeRouter(address(fees));
    }
    function testNoSpendingBeforeProvenService() public {
        vm.prank(executor);vm.expectRevert("job budget");fees.createJob(source,host,250,100,60,T+1200,bytes32(0));
    }
    function testHyperVBackendAcceptedAndUnknownBackendRejected() public {
        vm.prank(payer);fees.configure(source,executor,125,1000,1e6,100000,1000,T+1 days,"catalog://capacity-work/0","hyperv-partition-per-app");
        vm.prank(payer);vm.expectRevert();fees.configure(source,executor,125,1000,1e6,100000,1000,T+1 days,"catalog://capacity-work/0","unisolated");
    }
    function testQuoteExpiryDoesNotPermitPrematurePublicStop() public {
        checkpoint();bytes32 id=createJob(60);vm.prank(executor);fees.fundJob(source,id);
        vm.warp(T+1200);vm.expectRevert("not authorized");fees.stopJob(id);
        vm.warp(T+1260);assertTrue(fees.stopJob(id));
        assertFalse(dep.get(id).active);
        // Completing one job cannot drain the still-active source policy.
        assertGt(token.balanceOf(wallet),0);
    }
    function testFeeWalletPaysOrdinaryJobWithoutRecursiveFeeCredits() public {
        checkpoint();bytes32 id=createJob(60);uint256 beforeBalance=token.balanceOf(wallet);uint256 beforePayer=token.balanceOf(payer);
        vm.prank(executor);fees.fundJob(source,id);
        assertEq(token.balanceOf(wallet),beforeBalance-6000);assertEq(token.balanceOf(payer),beforePayer);
        assertEq(dep.get(id).owner,wallet);assertEq(dep.get(id).balance6,6000);assertEq(token.balanceOf(address(fees)),0);
        assertEq(token.allowance(wallet,address(dep)),0);assertEq(dep.ownerEscrow6(id),4800);
        vm.prank(operator);dep.claim(id,host);assertEq(dep.get(id).rate,100);
        vm.prank(executor);assertFalse(fees.stopJob(id));vm.prank(operator);dep.release(id);
        vm.prank(executor);assertTrue(fees.stopJob(id));assertGt(token.balanceOf(wallet),beforeBalance-6000);
    }
    function testRevocationReturnsFeesToTreasuryAndStopsExecutor() public {
        checkpoint();uint256 before=token.balanceOf(treasury);vm.prank(payer);fees.revoke(source);
        assertEq(token.balanceOf(wallet),0);assertEq(token.balanceOf(treasury),before+1e6);
        vm.prank(executor);vm.expectRevert("inactive executor");fees.createJob(source,host,250,100,60,T+1200,bytes32(0));
    }
    function testDailyCapAndReplay() public {
        configure(6000,6000);checkpoint();bytes32 first=createJob(60);
        vm.prank(executor);fees.fundJob(source,first);
        vm.prank(executor);vm.expectRevert("invalid job");fees.fundJob(source,first);
        bytes32 second=createJob(60);vm.prank(executor);vm.expectRevert("daily cap");fees.fundJob(source,second);
    }
    function testNoArbitraryWalletTransfersOrForeignJobs() public {
        vm.expectRevert("controller only");VerificationFeeWallet(wallet).returnUnused();
        vm.expectRevert("controller only");VerificationFeeWallet(wallet).fund(source,1);
        checkpoint();vm.prank(executor);vm.expectRevert("invalid job");fees.fundJob(source,source);
    }
    function testTokenFailureCannotSpendBudget() public {
        checkpoint();bytes32 id=createJob(60);token.setFailTransfers(true);
        vm.prank(executor);vm.expectRevert("USDC transfer failed");fees.fundJob(source,id);
        token.setFailTransfers(false);vm.prank(executor);fees.fundJob(source,id);assertEq(dep.get(id).balance6,6000);
    }
    function testSecretSignatureCannotAuthorizeTokenTypedData() public {
        string memory message="enclave-secrets:put:test-id:1800000100:payload-hash";
        bytes32 hash=keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n59",message));
        // Compute length independently; hard-coded length above must not be trusted.
        hash=keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n",vm.toString(bytes(message).length),message));
        (uint8 v,bytes32 r,bytes32 s)=vm.sign(EXECUTOR_KEY,hash);
        bytes memory wrapped=abi.encode(message,abi.encodePacked(r,s,v));
        assertEq(VerificationFeeWallet(wallet).isValidSignature(hash,wrapped),bytes4(0x1626ba7e));
        assertEq(VerificationFeeWallet(wallet).isValidSignature(keccak256("token typed-data digest"),wrapped),bytes4(0xffffffff));
        vm.prank(payer);fees.revoke(source);
        assertEq(VerificationFeeWallet(wallet).isValidSignature(hash,wrapped),bytes4(0xffffffff));
    }
    function testUnconfiguredPayerFeesAllGoToPlatform() public {
        address other=address(0x900);token.mint(other,1000000);
        vm.startPrank(other);bytes32 id=dep.create("catalog://other/0",0,1000,8000,"",true,"",address(0),0,10000);
        token.approve(address(dep),1000000);uint256 before=token.balanceOf(treasury);dep.fund(id,1000000);vm.stopPrank();
        assertEq(token.balanceOf(treasury),before+200000);
    }
    function testFuzzFeeConservation(uint96 value) public {
        value=uint96(bound(value,1,100e6));uint256 beforePayer=token.balanceOf(payer);uint256 beforeWallet=token.balanceOf(wallet);uint256 beforeTreasury=token.balanceOf(treasury);
        (,uint256 beforeEscrow,)=dep.earnOf(source);vm.prank(payer);dep.fund(source,value);(,uint256 afterEscrow,)=dep.earnOf(source);
        assertEq(beforePayer-token.balanceOf(payer),value);
        assertEq(token.balanceOf(wallet)-beforeWallet+token.balanceOf(treasury)-beforeTreasury+afterEscrow-beforeEscrow,value);
        assertEq(token.balanceOf(address(fees)),0);
    }
}
