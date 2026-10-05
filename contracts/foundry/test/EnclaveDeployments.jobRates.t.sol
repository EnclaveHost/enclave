// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "forge-std/Test.sol";
import {EnclaveDeployments} from "../../EnclaveDeployments.sol";
import {EnclaveRegistry} from "../../EnclaveRegistry.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
contract JobRatesTest is Test {
    EnclaveDeployments dep; EnclaveRegistry reg; MockUSDC token;
    address user=address(0x100);address op=address(0x200);address other=address(0x300);
    bytes32 host;bytes32 job;
    function setUp() public {
        vm.warp(10000);token=new MockUSDC();reg=new EnclaveRegistry();
        dep=new EnclaveDeployments(address(token),address(0x999),address(reg),address(0));
        dep.setProofRequiredFrom(0);
        vm.prank(op);host=reg.register("host","repo",bytes32(0),10000,10000,address(0x800));
        vm.prank(user);job=dep.create("catalog://app/0",0,1000,8081,"",true,"",address(0x400),10,50000);
        token.mint(user,100e6);vm.startPrank(user);token.approve(address(dep),type(uint256).max);dep.fund(job,100e6);vm.stopPrank();
    }
    function offer(uint96 price,uint64 until) internal {vm.prank(op);dep.offerJobRate(job,host,price,until);}
    function testStandardTariffUnaffectedWithoutOffer() public {assertEq(dep.rateFor(job,host),10010);}
    function testHostCanOfferLowerOrHigherRateWithPublisherFeePreserved() public {
        offer(100,20000);assertEq(dep.rateFor(job,host),110);
        offer(20000,20000);assertEq(dep.rateFor(job,host),20010);
    }
    function testOnlyHostOperatorCanOffer() public {
        vm.prank(user);vm.expectRevert("not runner");dep.offerJobRate(job,host,1,20000);
    }
    function testClaimSnapshotsOfferAndRenewDoesNotReprice() public {
        offer(100,10010);vm.prank(op);dep.claim(job,host);assertEq(dep.get(job).rate,110);
        vm.warp(10011);assertEq(dep.rateFor(job,host),10010);
        vm.prank(op);dep.renew(job);assertEq(dep.get(job).rate,110);
        offer(30000,20000);assertEq(dep.get(job).rate,110);
    }
    function testOwnerCapStillApplies() public {
        offer(60000,20000);vm.prank(op);vm.expectRevert("over rate cap");dep.claim(job,host);
    }
    function testShareChangesInvalidateOfferedAllocation() public {
        offer(100,20000);vm.prank(user);dep.setShares(job,0,500);assertEq(dep.rateFor(job,host),5010);
    }
    function testExpiryAndRevocationReturnFutureClaimsToTariff() public {
        offer(100,10001);vm.warp(10001);assertEq(dep.rateFor(job,host),10010);
        offer(100,20000);offer(100,0);assertEq(dep.rateFor(job,host),10010);
    }
    function testSelfHostingRemainsFreeExceptPublisherFee() public {
        vm.prank(user);reg.setPayoutWallet(host);offer(30000,20000);assertEq(dep.rateFor(job,host),10);
    }
}
