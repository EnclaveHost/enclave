// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "forge-std/Test.sol";
import {EnclaveDeployments,IEnclaveRegistry} from "../../EnclaveDeployments.sol";
import {EnclaveConnectivity} from "../../EnclaveConnectivity.sol";
import {EnclaveProofOfTime} from "../../EnclaveProofOfTime.sol";
import {EnclaveVerificationFees} from "../../EnclaveVerificationFees.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract ConnectivityRegistry {
    IEnclaveRegistry.Enclave internal host;
    mapping(bytes32=>IEnclaveRegistry.Enclave) internal specific;
    function configureProvider(bytes32 id,address operator,address proofKey) external {specific[id].operator=operator;specific[id].proofKey=proofKey;specific[id].active=true;}
    function configure(address operator,address payout,address proofKey) external {
        host.operator=operator;host.payoutWallet=payout;host.proofKey=proofKey;
        host.active=true;host.cpuPricePerSec6=834;
    }
    function get(bytes32 id) external view returns(IEnclaveRegistry.Enclave memory){return specific[id].operator!=address(0)?specific[id]:host;}
}
contract EnclaveConnectivityTest is Test {
    uint256 constant T0=1700000000;
    uint256 constant PROBE=111;
    uint256 constant METER=222;
    uint256 constant OWNER=333;
    bytes32 constant HOST=keccak256("host");
    uint128 constant GIB=1<<30;
    EnclaveDeployments ledger;
    EnclaveConnectivity connectivity;
    ConnectivityRegistry registry;
    MockUSDC usdc;
    address tenant;
    address operator=address(0x100);
    address payout=address(0x200);
    bytes32 id;
    function setUp() public {
        vm.warp(T0);vm.roll(100);vm.setBlockhash(99,keccak256("anchor"));
        tenant=vm.addr(OWNER);usdc=new MockUSDC();registry=new ConnectivityRegistry();
        registry.configure(operator,operator,vm.addr(METER));
        ledger=new EnclaveDeployments(address(usdc),payout,address(registry),address(0));
        ledger.setProofRequiredFrom(0);
        address[] memory signers=new address[](1);signers[0]=vm.addr(PROBE);
        connectivity=new EnclaveConnectivity(ledger,signers);ledger.setBandwidthRouter(address(connectivity));
        usdc.mint(tenant,1000e6);vm.startPrank(tenant);usdc.approve(address(ledger),type(uint256).max);
        id=ledger.create("catalog://app/0",0,1000,8080,"",true,"",address(0),0,834);
        ledger.fund(id,100e6);vm.stopPrank();vm.prank(operator);ledger.claim(id,HOST);
        _qualify();vm.prank(operator);connectivity.setHost(HOST,true,true,1e6);
        _policy(10e6);_back();
    }
    function _sig(uint256 key,bytes32 digest) internal pure returns(bytes memory){
        (uint8 v,bytes32 r,bytes32 s)=vm.sign(key,keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32",digest)));
        return abi.encodePacked(r,s,v);
    }
    function _qualify() internal {
        bytes32 addr=keccak256("8.8.8.8");
        bytes32 digest=connectivity.qualificationDigest(HOST,addr,uint64(T0),uint64(T0+300),511);
        connectivity.qualify(HOST,addr,uint64(T0),uint64(T0+300),511,_sig(PROBE,digest));
    }
    function _policy(uint128 budget) internal {
        uint64 expiry=uint64(T0+3600);
        connectivity.authorizeDirect(id,expiry,1e6,budget,_sig(OWNER,connectivity.policyDigest(id,expiry,1e6,budget)));
    }
    function _back() internal {
        uint256 missing=ledger.bandwidthBackingRequired6(id);
        usdc.mint(address(this),missing);usdc.approve(address(ledger),missing);ledger.fundEscrow(id,missing);
    }
    function _receipt(uint128 count) internal view returns(EnclaveConnectivity.Receipt memory r){
        (,uint64 nonce,,,,,)=connectivity.policies(id);
        return EnclaveConnectivity.Receipt(id,HOST,nonce,ledger.get(id).leaseUntil,uint64(T0),99,count,1e6);
    }
    function _settle(uint128 count) internal {
        EnclaveConnectivity.Receipt memory r=_receipt(count);
        connectivity.settle(r,_sig(METER,connectivity.receiptDigest(r)));
    }
    function _reject(uint128 count) internal {
        EnclaveConnectivity.Receipt memory r=_receipt(count);
        bytes memory signature=_sig(METER,connectivity.receiptDigest(r));
        vm.expectRevert();connectivity.settle(r,signature);
    }
    function test_administrationRequiresAcceptanceByNamedGovernance() public {
        address gov=address(0x1234);
        vm.prank(operator);vm.expectRevert();connectivity.transferAdministration(gov);
        connectivity.transferAdministration(gov);
        assertEq(connectivity.administrator(),address(this));
        vm.prank(operator);vm.expectRevert();connectivity.acceptAdministration();
        vm.prank(gov);connectivity.acceptAdministration();
        assertEq(connectivity.administrator(),gov);
        vm.expectRevert();connectivity.setProbeSigner(vm.addr(PROBE),false);
        vm.prank(gov);connectivity.setProbeSigner(vm.addr(PROBE),false);
        assertFalse(connectivity.qualified(HOST));
    }
    function test_bandwidthUsesComputeSplitAndExistingBalance() public {
        uint256 balance=ledger.get(id).balance6;uint256 platform=usdc.balanceOf(payout);
        (,uint256 escrow,)=ledger.earnOf(id);_settle(GIB);
        assertEq(ledger.get(id).balance6,balance-1e6);
        assertEq(ledger.earned6(operator),800000);assertEq(usdc.balanceOf(payout)-platform,200000);
        (,uint256 remaining,)=ledger.earnOf(id);assertEq(remaining,escrow-1e6);
        assertGe(usdc.balanceOf(address(ledger)),remaining+ledger.earned6(operator));
        assertEq(ledger.bandwidthBackingRequired6(id),0);
    }
    function test_splitSnapshotSurvivesAdminChange_untilNextAuthorization() public {
        ledger.setRunnerBps(5000);_settle(GIB);assertEq(ledger.earned6(operator),800000);
        _policy(10e6);_settle(GIB);assertEq(ledger.earned6(operator),1300000);
    }
    function test_fragmentationDoesNotChangePriceOrSplit() public {
        uint256 platform=usdc.balanceOf(payout);
        _settle(1);_settle(1074);_settle(GIB/2);_settle(GIB);
        assertEq(ledger.earned6(operator),800000);assertEq(usdc.balanceOf(payout)-platform,200000);
    }
    function test_cannotReplayReceiptOrExceedBudget() public {
        _settle(GIB);_reject(GIB);
        _reject(11*GIB);
        assertEq(ledger.earned6(operator),800000);
    }
    function test_revocationStopsSettlement() public {
        vm.prank(tenant);connectivity.revokeDirect(id);
        _reject(GIB);
    }
    function test_selfHostingIsFreeForBothParties() public {
        registry.configure(operator,tenant,vm.addr(METER));
        (uint64 price,bool free)=connectivity.quote(id);assertEq(price,0);assertTrue(free);
        uint256 platform=usdc.balanceOf(payout);_reject(GIB);
        assertEq(ledger.earned6(operator),0);assertEq(usdc.balanceOf(payout),platform);
    }
    function test_sameQualificationExpiresBothCapabilities() public {
        (bool direct,bool tuna)=connectivity.capabilities(HOST);assertTrue(direct&&tuna);
        vm.warp(T0+301);(direct,tuna)=connectivity.capabilities(HOST);assertFalse(direct||tuna);
        vm.prank(operator);vm.expectRevert();connectivity.setHost(HOST,true,false,1e6);
    }
    function test_wrongMeterCannotCharge() public {
        EnclaveConnectivity.Receipt memory r=_receipt(GIB);
        bytes memory signature=_sig(PROBE,connectivity.receiptDigest(r));
        vm.expectRevert();connectivity.settle(r,signature);
    }
    function test_topUpNeedsBackingBeforeBandwidthCanSpendIt() public {
        vm.prank(tenant);ledger.fund(id,100e6);
        assertGt(ledger.bandwidthBackingRequired6(id),0);
        _reject(GIB);
        _back();_settle(GIB);assertEq(ledger.earned6(operator),800000);
    }
    function test_revokedProbeStopsBothServicesImmediately() public {
        connectivity.setProbeSigner(vm.addr(PROBE),false);
        (bool direct,bool tuna)=connectivity.capabilities(HOST);assertFalse(direct||tuna);
        _reject(GIB);
    }
    function test_platformShareUsesExistingVerificationFeeRouting() public {
        EnclaveProofOfTime proof=new EnclaveProofOfTime(address(ledger),address(registry));
        ledger.setProver(address(proof));
        EnclaveVerificationFees fees=new EnclaveVerificationFees(address(ledger),address(proof));
        ledger.setFeeRouter(address(fees));
        vm.prank(tenant);fees.configure(id,address(0x500),125,1000,1e6,100000,1000,uint64(T0+1 days),"catalog://capacity-work/0","snp-guest-per-app");
        address wallet=fees.wallets(id,tenant);uint256 platform=usdc.balanceOf(payout);
        _settle(GIB);
        assertEq(ledger.earned6(operator),800000);
        assertEq(usdc.balanceOf(wallet),10000); // 5% of the platform's 20%.
        assertEq(usdc.balanceOf(payout)-platform,190000);
        assertEq(usdc.balanceOf(address(fees)),0);
    }
    function test_zeroAndFullProviderShares() public {
        ledger.setRunnerBps(0);_policy(10e6);uint256 platform=usdc.balanceOf(payout);
        _settle(GIB);assertEq(ledger.earned6(operator),0);assertEq(usdc.balanceOf(payout)-platform,1e6);
        ledger.setRunnerBps(10000);_policy(10e6);platform=usdc.balanceOf(payout);
        _settle(GIB);assertEq(ledger.earned6(operator),1e6);assertEq(usdc.balanceOf(payout),platform);
    }
    function test_transferFailureRollsBackAllCountersAndSplits() public {
        usdc.setFailTransfers(true);_reject(GIB);assertEq(ledger.earned6(operator),0);
        usdc.setFailTransfers(false);_settle(GIB);assertEq(ledger.earned6(operator),800000);
    }
    function testFuzz_splitIsConserved(uint16 bps,uint32 amount) public {
        bps=uint16(bound(bps,0,10000));amount=uint32(bound(amount,1,1000000000));
        ledger.setRunnerBps(bps);_policy(10e6);uint256 platform=usdc.balanceOf(payout);
        _settle(amount);uint256 gross=(uint256(amount)*1e6+GIB-1)/GIB;
        uint256 provider=gross*bps/10000;
        assertEq(ledger.earned6(operator),provider);assertEq(usdc.balanceOf(payout)-platform,gross-provider);
    }
    function test_revokeInvalidatesPreviouslySignedUnusedAuthorization() public {
        uint64 expires=uint64(T0+3600);
        bytes memory oldSig=_sig(OWNER,connectivity.policyDigest(id,expires,1e6,10e6));
        vm.prank(tenant);connectivity.revokeDirect(id);
        vm.expectRevert();connectivity.authorizeDirect(id,expires,1e6,10e6,oldSig);
        bytes memory off=_sig(OWNER,connectivity.policyDigest(id,0,0,0));
        connectivity.authorizeDirect(id,0,0,0,off);
        (,uint64 nonce,uint64 until,,,,)=connectivity.policies(id);
        assertEq(nonce,3);assertEq(until,0);
        vm.expectRevert();connectivity.authorizeDirect(id,0,0,0,off);
    }
    function test_computeOnlyDisablesBothInternetServices() public {
        vm.prank(operator);connectivity.setHost(HOST,false,false,0);
        (bool direct,bool tuna)=connectivity.capabilities(HOST);assertFalse(direct||tuna);
        _reject(GIB);
        assertTrue(ledger.get(id).active);
    }
    bytes32 constant PROVIDER=keccak256("independent provider");
    address providerOperator=address(0x456);
    uint256 constant PROVIDER_KEY=444;
    function _tuna() internal {
        registry.configureProvider(PROVIDER,providerOperator,vm.addr(PROVIDER_KEY));
        bytes32 addr=keccak256("9.9.9.9");
        bytes32 q=connectivity.qualificationDigest(PROVIDER,addr,uint64(T0),uint64(T0+300),511);
        if(!connectivity.qualified(PROVIDER)) connectivity.qualify(PROVIDER,addr,uint64(T0),uint64(T0+300),511,_sig(PROBE,q));
        vm.prank(providerOperator);connectivity.setHost(PROVIDER,false,true,1e6);
        bytes32[] memory providers=new bytes32[](1);providers[0]=PROVIDER;
        uint64 expiry=uint64(T0+3600);
        bytes32 digest=connectivity.tunaPolicyDigest(id,providers,expiry,1e6,10e6);
        connectivity.authorizeTuna(id,providers,expiry,1e6,10e6,_sig(OWNER,digest));
    }
    function _tunaReceipt(uint128 count) internal view returns(EnclaveConnectivity.TunaReceipt memory){
        (,uint64 nonce,,,,,)=connectivity.policies(id);
        return EnclaveConnectivity.TunaReceipt(id,HOST,PROVIDER,nonce,ledger.get(id).leaseUntil,uint64(T0),99,count,1e6);
    }
    function _tunaSettle(uint128 count) internal {
        EnclaveConnectivity.TunaReceipt memory r=_tunaReceipt(count);bytes32 digest=connectivity.tunaReceiptDigest(r);
        connectivity.settleTuna(r,_sig(METER,digest),_sig(PROVIDER_KEY,digest));
    }
    function test_tunaPaysActualProviderFromExistingBalance() public {
        _tuna();uint256 balance=ledger.get(id).balance6;uint256 platform=usdc.balanceOf(payout);
        _tunaSettle(GIB);
        assertEq(ledger.get(id).balance6,balance-1e6);assertEq(ledger.earned6(providerOperator),800000);
        assertEq(ledger.earned6(operator),0);assertEq(usdc.balanceOf(payout)-platform,200000);
        assertEq(ledger.bandwidthBackingRequired6(id),0);
        vm.prank(providerOperator);connectivity.setHost(PROVIDER,false,true,2000000);
        vm.expectRevert();connectivity.quoteTuna(id,PROVIDER);
    }
    function test_tunaRequiresBothSignersAndCannotReplayOrUseDirectAuthorization() public {
        _tuna();EnclaveConnectivity.TunaReceipt memory r=_tunaReceipt(GIB);bytes32 digest=connectivity.tunaReceiptDigest(r);
        bytes memory runnerSig=_sig(METER,digest);bytes memory providerSig=_sig(PROVIDER_KEY,digest);
        vm.expectRevert();connectivity.settleTuna(r,providerSig,providerSig);
        vm.expectRevert();connectivity.settleTuna(r,runnerSig,runnerSig);
        connectivity.settleTuna(r,runnerSig,providerSig);
        vm.expectRevert();connectivity.settleTuna(r,runnerSig,providerSig);
        vm.expectRevert();connectivity.quote(id);
        _policy(10e6);vm.expectRevert();connectivity.quoteTuna(id,PROVIDER);
    }
    function test_tunaCapsTheWholePathAndRejectsDuplicateProviders() public {
        _tuna();bytes32[] memory providers=new bytes32[](2);providers[0]=HOST;providers[1]=PROVIDER;
        uint64 expiry=uint64(T0+3600);bytes memory sig=_sig(OWNER,connectivity.tunaPolicyDigest(id,providers,expiry,1e6,10e6));
        vm.expectRevert();connectivity.authorizeTuna(id,providers,expiry,1e6,10e6,sig);
        sig=_sig(OWNER,connectivity.tunaPolicyDigest(id,providers,expiry,2e6,10e6));
        connectivity.authorizeTuna(id,providers,expiry,2e6,10e6,sig);
        assertEq(connectivity.quoteTuna(id,PROVIDER),1e6);
        providers[1]=HOST;sig=_sig(OWNER,connectivity.tunaPolicyDigest(id,providers,expiry,2e6,10e6));
        vm.expectRevert();connectivity.authorizeTuna(id,providers,expiry,2e6,10e6,sig);
    }
    function test_tunaRevocationBudgetAndQualificationStopPayment() public {
        _tuna();_tunaSettle(GIB);EnclaveConnectivity.TunaReceipt memory r=_tunaReceipt(11*GIB);
        bytes32 digest=connectivity.tunaReceiptDigest(r);bytes memory a=_sig(METER,digest);bytes memory b=_sig(PROVIDER_KEY,digest);
        vm.expectRevert();connectivity.settleTuna(r,a,b);
        vm.prank(tenant);connectivity.revokeDirect(id);vm.expectRevert();connectivity.quoteTuna(id,PROVIDER);
        _tuna();vm.warp(T0+301);vm.expectRevert();connectivity.quoteTuna(id,PROVIDER);
    }
    function test_tunaFragmentationConservesSplitAndSelfHostingDoesNotWaiveRemoteProvider() public {
        _tuna();registry.configure(operator,tenant,vm.addr(METER));
        _tunaSettle(1);_tunaSettle(1074);_tunaSettle(GIB/2);_tunaSettle(GIB);
        assertEq(ledger.earned6(providerOperator),800000);
    }
    function test_unavailableSiblingDoesNotBlockQualifiedProvider() public {
        _tuna();bytes32[] memory providers=new bytes32[](2);providers[0]=HOST;providers[1]=PROVIDER;
        uint64 expiry=uint64(T0+3600);bytes memory sig=_sig(OWNER,connectivity.tunaPolicyDigest(id,providers,expiry,2e6,10e6));
        connectivity.authorizeTuna(id,providers,expiry,2e6,10e6,sig);
        vm.prank(operator);connectivity.setHost(HOST,false,false,1e6);
        assertEq(connectivity.quoteTuna(id,PROVIDER),1e6);
        vm.expectRevert();connectivity.quoteTuna(id,HOST);
        _tunaSettle(GIB);assertEq(ledger.earned6(providerOperator),800000);
    }

}
