// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {EnclaveDeployments, IEnclaveRegistry} from "../../EnclaveDeployments.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// Registry stand-in: one active enclave whose operator is settable, matching
/// the structural claim gate (msg.sender must be the entry's operator).
contract MockRegistry {
    address public operator;
    constructor(address _operator) { operator = _operator; }
    function get(bytes32) external view returns (IEnclaveRegistry.Enclave memory e) {
        e.operator = operator;
        e.active = true;
    }
}

/// setShares (rev 6): the owner re-buys the deployment's two shares in place
/// and the rate is recalculated at current list prices. The money invariant
/// under test everywhere: a live lease's unserved tail settles at the rate it
/// was burned at BEFORE the rate changes — balance6 + spent6 is conserved by
/// the settle itself, spent6 can never underflow, and release() after a
/// resize refunds at the new rate the re-burn used.
contract EnclaveDeploymentsSetSharesTest is Test {
    EnclaveDeployments internal dep;
    MockUSDC internal usdc;
    MockRegistry internal reg;

    address internal user = makeAddr("user");
    address internal payout = makeAddr("payout");
    address internal operator = makeAddr("operator");
    address internal publisher = makeAddr("publisher");
    bytes32 internal constant ENCLAVE_ID = keccak256("enclave-1");

    uint256 internal constant GPU_PRICE = 1667; // per-sec 6dp, full card (contract default)
    uint256 internal constant CPU_PRICE = 834;  // per-sec 6dp, full node (contract default)

    function setUp() public {
        usdc = new MockUSDC();
        reg = new MockRegistry(operator);
        dep = new EnclaveDeployments(address(usdc), payout, address(reg), address(0));
        usdc.mint(user, 1_000_000e6);
        vm.prank(user);
        usdc.approve(address(dep), type(uint256).max);
        // deterministic lease math in every test below
        vm.warp(1_700_000_000);
    }

    function _rate(uint16 gpuMilli, uint16 cpuMilli) internal pure returns (uint256) {
        return (GPU_PRICE * gpuMilli + CPU_PRICE * cpuMilli + 999) / 1000;
    }

    function _create(uint16 gpuMilli, uint16 cpuMilli, uint256 fund6) internal returns (bytes32 id) {
        vm.startPrank(user);
        id = dep.create("catalog://app/0", gpuMilli, cpuMilli, 8080, "", true, "", address(0), 0);
        if (fund6 > 0) dep.fund(id, fund6);
        vm.stopPrank();
    }

    function _claim(bytes32 id) internal {
        vm.prank(operator);
        dep.claim(id, ENCLAVE_ID);
    }

    // ---- schema marker ----------------------------------------------------

    function test_schemaIsSix() public view {
        assertEq(dep.deploymentsSchema(), 6);
    }

    // ---- unleased resizes -------------------------------------------------

    function test_resizeUnleased_repricesAtCurrentList() public {
        bytes32 id = _create(500, 250, 0);
        vm.prank(user);
        dep.setShares(id, 800, 400);
        EnclaveDeployments.Deployment memory d = dep.get(id);
        assertEq(d.gpuMilli, 800);
        assertEq(d.cpuMilli, 400);
        assertEq(d.rate, _rate(800, 400));
        assertEq(d.balance6, 0);
        assertEq(d.spent6, 0);
    }

    function test_resizeAfterPriceChange_repricesUnchangedShares() public {
        bytes32 id = _create(500, 250, 0);
        uint256 before = dep.get(id).rate;
        dep.setPrice(GPU_PRICE * 2); // owner of this test contract deployed dep
        // same shares, new list price: the resize IS the re-pricing decision
        vm.prank(user);
        dep.setShares(id, 500, 250);
        assertEq(dep.get(id).rate, (GPU_PRICE * 2 * 500 + CPU_PRICE * 250 + 999) / 1000);
        assertGt(dep.get(id).rate, before);
    }

    function test_resizeExpiredLease_skipsSettle() public {
        bytes32 id = _create(500, 250, 100e6);
        _claim(id);
        EnclaveDeployments.Deployment memory d0 = dep.get(id);
        vm.warp(uint256(d0.leaseUntil) + 1); // lease lapsed: nothing to settle
        vm.prank(user);
        dep.setShares(id, 100, 100);
        EnclaveDeployments.Deployment memory d = dep.get(id);
        assertEq(d.balance6, d0.balance6);   // untouched: no live tail to settle
        assertEq(d.spent6, d0.spent6);
        assertEq(d.rate, _rate(100, 100));
    }

    // ---- live-lease settle math -------------------------------------------

    function test_shrinkMidLease_refundsTailDelta_keepsLeaseUntil() public {
        bytes32 id = _create(500, 250, 100e6);
        uint256 oldRate = _rate(500, 250);
        _claim(id);
        EnclaveDeployments.Deployment memory d0 = dep.get(id);
        vm.warp(block.timestamp + 600); // 1200s of the 1800s lease left
        uint256 tail = uint256(d0.leaseUntil) - block.timestamp;

        vm.prank(user);
        dep.setShares(id, 200, 100);
        uint256 newRate = _rate(200, 100);
        EnclaveDeployments.Deployment memory d = dep.get(id);
        assertEq(d.leaseUntil, d0.leaseUntil); // shrink always affords the full tail
        assertEq(d.rate, newRate);
        assertEq(d.balance6, d0.balance6 + tail * (oldRate - newRate));
        assertEq(d.spent6, d0.spent6 - tail * (oldRate - newRate));
        // conservation: the settle moved credit between the two ledgers only
        assertEq(d.balance6 + d.spent6, d0.balance6 + d0.spent6);
    }

    function test_growMidLease_richBalance_keepsLeaseUntil() public {
        bytes32 id = _create(200, 100, 500e6);
        uint256 oldRate = _rate(200, 100);
        _claim(id);
        EnclaveDeployments.Deployment memory d0 = dep.get(id);
        vm.warp(block.timestamp + 600);
        uint256 tail = uint256(d0.leaseUntil) - block.timestamp;

        vm.prank(user);
        dep.setShares(id, 900, 450);
        uint256 newRate = _rate(900, 450);
        EnclaveDeployments.Deployment memory d = dep.get(id);
        assertEq(d.leaseUntil, d0.leaseUntil); // balance covered the whole tail at the new rate
        assertEq(d.balance6, d0.balance6 + tail * oldRate - tail * newRate);
        assertEq(d.balance6 + d.spent6, d0.balance6 + d0.spent6);
    }

    function test_growMidLease_poorBalance_shrinksLease() public {
        // fund exactly one lease quantum: after the claim burns it, balance6 is
        // 0 and the only credit left is the refunded tail
        uint256 oldRate = _rate(200, 100);
        bytes32 id = _create(200, 100, oldRate * 1800);
        _claim(id);
        EnclaveDeployments.Deployment memory d0 = dep.get(id);
        assertEq(d0.balance6, 0);
        vm.warp(block.timestamp + 600);
        uint256 tail = uint256(d0.leaseUntil) - block.timestamp;

        vm.prank(user);
        dep.setShares(id, 900, 450);
        uint256 newRate = _rate(900, 450);
        uint256 affordable = (tail * oldRate) / newRate; // < tail: the lease must shrink
        assertLt(affordable, tail);
        EnclaveDeployments.Deployment memory d = dep.get(id);
        assertEq(uint256(d.leaseUntil), block.timestamp + affordable);
        assertEq(d.balance6, tail * oldRate - affordable * newRate);
        assertEq(d.balance6 + d.spent6, d0.balance6 + d0.spent6);
    }

    function test_growMidLease_unfundable_reverts() public {
        // one quantum funded at a tiny rate, then a grow so large the refunded
        // tail can't buy one second at the new rate: revert, record untouched
        uint256 oldRate = _rate(0, 1);
        bytes32 id = _create(0, 1, oldRate * 1800);
        _claim(id);
        vm.warp(block.timestamp + 1799); // 1s of tail left: refund = oldRate * 1
        EnclaveDeployments.Deployment memory d0 = dep.get(id);

        vm.prank(user);
        vm.expectRevert("unfunded at the new rate");
        dep.setShares(id, 1000, 1000);
        EnclaveDeployments.Deployment memory d = dep.get(id);
        assertEq(d.rate, d0.rate);
        assertEq(d.gpuMilli, d0.gpuMilli);
        assertEq(d.balance6, d0.balance6);
    }

    function test_releaseAfterResize_refundsAtNewRate_noUnderflow() public {
        bytes32 id = _create(500, 250, 300e6);
        _claim(id);
        vm.warp(block.timestamp + 600);
        vm.prank(user);
        dep.setShares(id, 100, 100); // shrink mid-lease: re-burned at the new rate
        EnclaveDeployments.Deployment memory d1 = dep.get(id);
        vm.warp(block.timestamp + 300);
        uint256 tail = uint256(d1.leaseUntil) - block.timestamp;

        vm.prank(operator);
        dep.release(id); // must refund tail * NEW rate without underflowing spent6
        EnclaveDeployments.Deployment memory d = dep.get(id);
        assertEq(d.balance6, d1.balance6 + tail * d1.rate);
        assertEq(d.spent6, d1.spent6 - tail * d1.rate);
        assertEq(d.leaseUntil, 0);
    }

    function test_repeatedResizesMidLease_conserveCredit() public {
        bytes32 id = _create(500, 250, 400e6);
        _claim(id);
        EnclaveDeployments.Deployment memory d0 = dep.get(id);
        uint256 total = d0.balance6 + d0.spent6;
        uint16[3] memory gpus = [uint16(100), 900, 300];
        uint16[3] memory cpus = [uint16(100), 400, 200];
        for (uint256 i = 0; i < 3; i++) {
            vm.warp(block.timestamp + 120);
            vm.prank(user);
            dep.setShares(id, gpus[i], cpus[i]);
            EnclaveDeployments.Deployment memory d = dep.get(id);
            assertEq(d.balance6 + d.spent6, total);
            assertEq(d.rate, _rate(gpus[i], cpus[i]));
        }
    }

    // ---- publisher-fee interplay ------------------------------------------

    function test_resizeCarriesFeeSnapshotIntoNewRate() public {
        uint256 fee = 500;
        vm.startPrank(user);
        bytes32 id = dep.create("catalog://app/0", 500, 250, 8080, "", true, "", publisher, fee);
        vm.stopPrank();
        assertEq(dep.get(id).rate, _rate(500, 250) + fee);

        vm.prank(user);
        dep.setShares(id, 100, 100);
        assertEq(dep.get(id).rate, _rate(100, 100) + fee); // fee snapshot immutable, folded back in

        // and the next funding splits pro-rata against the NEW rate
        vm.prank(user);
        dep.fund(id, 1_000_000);
        assertEq(usdc.balanceOf(publisher), (1_000_000 * fee) / (_rate(100, 100) + fee));
    }

    // ---- bounds (create's rules, re-applied) ------------------------------

    function test_boundsAndAuth() public {
        bytes32 id = _create(500, 250, 0);

        vm.expectRevert("not owner");
        dep.setShares(id, 100, 100); // not the owner (this test contract)

        vm.startPrank(user);
        vm.expectRevert("cpuMilli range");
        dep.setShares(id, 100, 0);
        vm.expectRevert("cpuMilli range");
        dep.setShares(id, 0, 1001);
        vm.expectRevert("gpuMilli range");
        dep.setShares(id, 1001, 1000);
        vm.expectRevert("gpuShare < cpuShare");
        dep.setShares(id, 100, 200);
        vm.stopPrank();

        dep.setMaxGpuMilli(400);
        vm.prank(user);
        vm.expectRevert("gpuShare > max");
        dep.setShares(id, 500, 250); // the create-time cap re-applies to resizes
    }

    // ---- the intended combined flow ---------------------------------------

    function test_multicall_setAppRefPlusSetShares_oneTx() public {
        bytes32 id = _create(500, 250, 100e6);
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(EnclaveDeployments.setAppRef, (id, "catalog://app/1"));
        calls[1] = abi.encodeCall(EnclaveDeployments.setShares, (id, 800, 400));
        vm.prank(user);
        dep.multicall(calls);
        EnclaveDeployments.Deployment memory d = dep.get(id);
        assertEq(d.appRef, "catalog://app/1");
        assertEq(d.gpuMilli, 800);
        assertEq(d.rate, _rate(800, 400));
    }
}
