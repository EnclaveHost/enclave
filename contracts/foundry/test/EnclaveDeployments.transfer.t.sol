// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {EnclaveDeployments, IEnclaveRegistry} from "../../EnclaveDeployments.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract MockRegistryTransfer {
    mapping(bytes32 => address) public operatorOf;
    function set(bytes32 id, address operator) external { operatorOf[id] = operator; }
    function get(bytes32 id) external view returns (IEnclaveRegistry.Enclave memory e) {
        e.operator = operatorOf[id];
        e.active = true;
        e.cpuPricePerSec6 = 834;
        e.gpuPricePerSec6 = 1667;
    }
}

/// Deployment transfer (rev 11): transferDeployment hands a record — every
/// owner right AND the rev-10 refund right — to another wallet, one-shot.
/// The invariants under test:
///   - the handoff is total: the old key keeps nothing, the new key holds
///     everything (config, active, cap, resize, refund);
///   - the refund right travels WITH the escrow: ownerEscrow6 stays on the
///     record, refund() pays whoever owns it at call time — transferring an
///     un-refunded backing is giving it away, by design;
///   - who-is-the-owner is evaluated at funding time: the new owner's top-ups
///     become refundable, the old owner's become sponsorship;
///   - a live lease neither blocks a transfer nor notices one — the seller's
///     escrow, meter and earnings are untouched;
///   - the contract stays solvent throughout.
contract EnclaveDeploymentsTransferTest is Test {
    EnclaveDeployments internal dep;
    MockUSDC internal usdc;
    MockRegistryTransfer internal reg;

    address internal alice = makeAddr("alice");     // creates + transfers away
    address internal bob = makeAddr("bob");         // receives
    address internal carol = makeAddr("carol");     // second hop
    address internal payout = makeAddr("payout");
    address internal operator = makeAddr("operator");
    bytes32 internal constant ENCLAVE_ID = keccak256("enclave-1");

    uint256 internal constant CPU_PRICE = 834;
    uint16 internal constant GPU_MILLI = 0;
    uint16 internal constant CPU_MILLI = 1000;
    uint256 internal constant RATE = (CPU_PRICE * 1000 + 999) / 1000;   // 834

    // Absolute warps only — see the note in EnclaveDeployments.runnerPayout.t.sol.
    uint256 internal constant T0 = 1_700_000_000;

    event DeploymentTransferred(bytes32 indexed id, address indexed from, address indexed to);

    function setUp() public {
        usdc = new MockUSDC();
        reg = new MockRegistryTransfer();
        reg.set(ENCLAVE_ID, operator);
        dep = new EnclaveDeployments(address(usdc), payout, address(reg), address(0));
        dep.setProofRequiredFrom(0);           // pre-cutover meter, as in the refund suite
        usdc.mint(alice, 1_000_000e6);
        usdc.mint(bob, 1_000_000e6);
        vm.prank(alice);
        usdc.approve(address(dep), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(dep), type(uint256).max);
        vm.warp(T0);
    }

    function _create(uint256 fund6) internal returns (bytes32 id) {
        vm.startPrank(alice);
        id = dep.create("catalog://app/0", GPU_MILLI, CPU_MILLI, 8080, "", true, "", address(0), 0, RATE);
        if (fund6 > 0) dep.fund(id, fund6);
        vm.stopPrank();
    }

    function _claim(bytes32 id) internal {
        vm.prank(operator);
        dep.claim(id, ENCLAVE_ID);
    }

    function _assertSolvent(bytes32 id) internal view {
        (, uint256 escrow6,) = dep.earnOf(id);
        assertGe(usdc.balanceOf(address(dep)), escrow6 + dep.earned6(operator));
    }

    // ---- the handoff is total ----------------------------------------------

    function test_transferHandsEveryOwnerRightToTheNewWallet() public {
        bytes32 id = _create(0);

        vm.prank(alice);
        vm.expectEmit(true, true, true, true);
        emit DeploymentTransferred(id, alice, bob);
        dep.transferDeployment(id, bob);

        assertEq(dep.get(id).owner, bob, "the record names the new owner");

        // the new key holds everything
        vm.startPrank(bob);
        dep.setConfig(id, "{\"config\":{}}");
        dep.setActive(id, false);
        dep.setActive(id, true);
        dep.setMaxRate(id, RATE * 2);
        vm.stopPrank();

        // the old key keeps nothing
        vm.startPrank(alice);
        vm.expectRevert("!owner");
        dep.setConfig(id, "x");
        vm.expectRevert("!owner");
        dep.setActive(id, false);
        vm.expectRevert("!owner");
        dep.setMaxRate(id, RATE * 3);
        vm.expectRevert("!owner");
        dep.refund(id);
        vm.expectRevert("!owner");
        dep.transferDeployment(id, carol);      // and cannot take it back
        vm.stopPrank();
    }

    function test_onlyTheOwnerMayTransfer() public {
        bytes32 id = _create(0);
        vm.prank(bob);
        vm.expectRevert("!owner");
        dep.transferDeployment(id, bob);
    }

    function test_unknownIdIsRefused() public {
        vm.expectRevert("unknown");
        dep.transferDeployment(keccak256("nope"), bob);
    }

    function test_zeroAddressIsRefused() public {
        bytes32 id = _create(0);
        vm.prank(alice);
        vm.expectRevert("zero addr");
        dep.transferDeployment(id, address(0));
    }

    function test_recordCanBeTransferredAgain() public {
        bytes32 id = _create(0);
        vm.prank(alice);
        dep.transferDeployment(id, bob);
        vm.prank(bob);
        dep.transferDeployment(id, carol);
        assertEq(dep.get(id).owner, carol);
    }

    // ---- the refund right travels with the escrow ---------------------------

    /// The headline semantic: an un-refunded backing is part of what `to`
    /// receives. refund() after the handoff pays BOB alice's escrowed funding.
    function test_unRefundedEscrowGoesToTheNewOwner() public {
        bytes32 id = _create(100e6);
        uint256 quoted = dep.refundableOf(id);
        assertGt(quoted, 0, "alice's funding is escrowed and refundable");

        vm.prank(alice);
        dep.transferDeployment(id, bob);

        assertEq(dep.refundableOf(id), quoted, "the quote survives the handoff unchanged");
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore = usdc.balanceOf(bob);
        vm.prank(bob);
        dep.refund(id);
        assertEq(usdc.balanceOf(bob) - bobBefore, quoted, "the new owner collects it");
        assertEq(usdc.balanceOf(alice), aliceBefore, "the old owner gets nothing");
        _assertSolvent(id);
    }

    /// ...and the reverse: refunding BEFORE transferring is how an owner keeps
    /// their money out of the deal.
    function test_refundFirstThenTransferHandsOverAnEmptyBacking() public {
        bytes32 id = _create(100e6);
        vm.startPrank(alice);
        dep.refund(id);
        dep.setActive(id, true);                // refund deactivates; hand it over live
        dep.transferDeployment(id, bob);
        vm.stopPrank();
        assertEq(dep.refundableOf(id), 0, "nothing left for the new owner to take");
        vm.prank(bob);
        vm.expectRevert("amount=0");
        dep.refund(id);
    }

    // ---- who-is-the-owner is a funding-time question ------------------------

    function test_newOwnersFundingsAreRefundable_oldOwnersAreSponsorship() public {
        bytes32 id = _create(0);
        vm.prank(alice);
        dep.transferDeployment(id, bob);

        vm.prank(bob);
        dep.fund(id, 50e6);                     // the owner's own backing
        uint256 bobEsc = dep.ownerEscrow6(id);
        assertGt(bobEsc, 0, "the new owner's funding is theirs to refund");

        vm.prank(alice);
        dep.fund(id, 50e6);                     // the OLD owner is now just a sponsor
        assertEq(dep.ownerEscrow6(id), bobEsc, "a sponsor's top-up is not the owner's to take");
        assertEq(dep.refundableOf(id), bobEsc);
        _assertSolvent(id);
    }

    // ---- a live lease neither blocks nor notices a transfer -----------------

    function test_transferMidLeaseLeavesTheSellerWhole() public {
        bytes32 id = _create(100e6);
        _claim(id);
        (uint256 r6, uint256 escBefore,) = dep.earnOf(id);
        uint64 leaseUntil = dep.get(id).leaseUntil;

        vm.warp(T0 + 600);                      // part-way through the lease
        vm.prank(alice);
        dep.transferDeployment(id, bob);

        (, uint256 escAfter,) = dep.earnOf(id);
        assertEq(escAfter, escBefore, "the seller's escrow is untouched");
        assertEq(dep.get(id).leaseUntil, leaseUntil, "the lease is untouched");

        // the runner serves the lease out and is paid for every second of it
        vm.warp(uint256(leaseUntil));
        dep.settle(id);
        assertEq(dep.earned6(operator), uint256(leaseUntil - T0) * r6, "paid in full across the handoff");
        _assertSolvent(id);
    }

    /// Mid-lease the reserve math is the new owner's problem and privilege,
    /// exactly as it was the old owner's: the lease's remaining seconds stay
    /// reserved for the seller, the free part refunds to the new owner now.
    function test_midLeaseRefundAfterTransferPaysTheNewOwnerTheFreePart() public {
        bytes32 id = _create(100e6);
        _claim(id);
        vm.prank(alice);
        dep.transferDeployment(id, bob);

        uint256 quoted = dep.refundableOf(id);
        (uint256 r6,,) = dep.earnOf(id);
        uint64 leaseUntil = dep.get(id).leaseUntil;
        uint256 reserve = uint256(leaseUntil - uint64(block.timestamp)) * r6;

        uint256 before = usdc.balanceOf(bob);
        vm.prank(bob);
        dep.refund(id);
        assertEq(usdc.balanceOf(bob) - before, quoted, "the quote was exact for the new owner too");
        (, uint256 escAfter,) = dep.earnOf(id);
        assertEq(escAfter, reserve, "exactly the seller's reserve stays behind");
        _assertSolvent(id);
    }

    // ---- the schema gate clients sniff --------------------------------------

    function test_schemaMarksTheTransferSurface() public view {
        assertEq(dep.deploymentsSchema(), 11);
    }
}
