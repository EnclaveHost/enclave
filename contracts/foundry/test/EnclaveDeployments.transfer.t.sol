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
/// owner right, one-shot — to another wallet, and NEVER moves money between
/// wallets. The invariants under test:
///   - the handoff is total: the old key keeps nothing, the new key holds
///     everything (config, active, cap, resize, refund-going-forward);
///   - the money gate: while the contract holds any of the owner's own
///     refundable backing (min(ownerEscrow6, escrow6) > 0) the transfer is
///     refused — refund first, so funds return to the wallet that paid them
///     and what changes hands is the record alone;
///   - the gate is NOT refundableOf: mid-lease that reads zero while the
///     seller's reserve is still escrowed and would free to the NEW owner at
///     release; and a fully-spent record's stale ownerEscrow6 must not brick
///     the handoff;
///   - sponsored/ETH runtime (never the owner's to withdraw) rides along;
///   - who-is-the-owner is evaluated at funding time: the new owner's top-ups
///     become refundable, the old owner's become sponsorship;
///   - the seller is paid in full through every sequence;
///   - the contract stays solvent throughout.
contract EnclaveDeploymentsTransferTest is Test {
    EnclaveDeployments internal dep;
    MockUSDC internal usdc;
    MockRegistryTransfer internal reg;

    address internal alice = makeAddr("alice");     // creates + transfers away
    address internal bob = makeAddr("bob");         // receives
    address internal carol = makeAddr("carol");     // sponsor / second hop
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
        usdc.mint(carol, 1_000_000e6);
        vm.prank(alice);
        usdc.approve(address(dep), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(dep), type(uint256).max);
        vm.prank(carol);
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

    function _rate6(bytes32 id) internal view returns (uint256 r6) {
        (r6,,) = dep.earnOf(id);
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

    // ---- a transfer never moves money ---------------------------------------

    /// The headline gate: while the contract holds ANY of the owner's own
    /// refundable backing, the record does not change hands. Refund first —
    /// the money returns to the wallet that paid it — then hand over the
    /// (empty) record. What `to` receives is control, never funds.
    function test_fundedRecordRefusesTransfer_untilRefunded() public {
        bytes32 id = _create(100e6);
        uint256 quoted = dep.refundableOf(id);
        assertGt(quoted, 0);

        vm.prank(alice);
        vm.expectRevert("refund first");
        dep.transferDeployment(id, bob);

        uint256 before = usdc.balanceOf(alice);
        vm.startPrank(alice);
        dep.refund(id);                          // the money comes home first
        dep.setActive(id, true);                 // refund deactivates; hand it over live
        dep.transferDeployment(id, bob);         // now it is only a record
        vm.stopPrank();

        assertEq(usdc.balanceOf(alice) - before, quoted, "the old owner keeps their money");
        assertEq(dep.get(id).owner, bob);
        assertEq(dep.refundableOf(id), 0, "the new owner receives no withdrawable funds");
        vm.prank(bob);
        vm.expectRevert("amount=0");
        dep.refund(id);
        _assertSolvent(id);
    }

    /// Mid-lease the gate holds TWICE, which is exactly why it reads
    /// min(ownerEscrow6, escrow6) and not refundableOf: after the first
    /// refund the free part is home but the seller's reserve is still
    /// escrowed — refundableOf reads ZERO in that window, and gating on it
    /// would let the released tail land with the NEW owner. The seller is
    /// paid in full through the whole sequence.
    function test_midLeaseTransferWaitsForTheTail_andTheSellerIsWhole() public {
        bytes32 id = _create(100e6);
        _claim(id);
        vm.warp(T0 + 600);

        vm.prank(alice);
        vm.expectRevert("refund first");
        dep.transferDeployment(id, bob);

        vm.prank(alice);
        dep.refund(id);                          // free part home; the tail stays reserved
        assertEq(dep.refundableOf(id), 0, "the reserve is not refundable yet");
        vm.prank(alice);
        vm.expectRevert("refund first");         // the refundableOf==0 window does NOT open the gate
        dep.transferDeployment(id, bob);

        vm.warp(T0 + 900);
        vm.prank(operator);
        dep.release(id);                         // seller hands back; the unserved tail frees
        assertEq(dep.earned6(operator), 900 * _rate6(id), "the seller is paid for every held second");

        uint256 tail = dep.refundableOf(id);
        assertGt(tail, 0);
        uint256 before = usdc.balanceOf(alice);
        vm.startPrank(alice);
        dep.refund(id);                          // the tail comes home too
        dep.transferDeployment(id, bob);
        vm.stopPrank();
        assertEq(usdc.balanceOf(alice) - before, tail);
        assertEq(dep.get(id).owner, bob);
        _assertSolvent(id);
    }

    /// ownerEscrow6 == 0 means nothing held here is the owner's to withdraw,
    /// so a sponsored record transfers freely — mid-lease included — with its
    /// runtime riding along and the seller untouched. The new owner cannot
    /// withdraw the sponsor's money either (the rev-10 cap, unchanged).
    function test_sponsoredRuntimeRidesAlong() public {
        bytes32 id = _create(0);
        vm.prank(carol);
        dep.fund(id, 100e6);                     // a third party buys alice runtime
        _claim(id);
        (, uint256 escBefore,) = dep.earnOf(id);
        assertGt(escBefore, 0);
        assertEq(dep.ownerEscrow6(id), 0, "none of it is the owner's");

        vm.prank(alice);
        dep.transferDeployment(id, bob);         // no gate: no owner money is held

        (, uint256 escAfter,) = dep.earnOf(id);
        assertEq(escAfter, escBefore, "the seller's escrow is untouched");
        assertGt(dep.get(id).balance6, 0, "the runtime rides along");
        assertEq(dep.refundableOf(id), 0, "and none of it becomes the new owner's to take");
        _assertSolvent(id);
    }

    /// A fully-spent record keeps a stale ownerEscrow6 forever (only refund
    /// decrements it) with no escrow behind it. The escrow6 side of the gate
    /// keeps it transferable — there is no money left to protect.
    function test_spentRecordStaysTransferable() public {
        bytes32 id = _create(1e6);               // one short lease consumes it all
        _claim(id);
        vm.warp(uint256(dep.get(id).leaseUntil));
        dep.settle(id);                          // the seller takes everything it served
        uint256 dust = dep.refundableOf(id);     // rounding remainder, if any, goes home
        if (dust > 0) { vm.prank(alice); dep.refund(id); }
        (, uint256 esc,) = dep.earnOf(id);
        assertEq(esc, 0, "nothing is held any more");
        assertGt(dep.ownerEscrow6(id), 0, "the stale cap survives spending");
        vm.prank(alice);
        dep.transferDeployment(id, bob);         // and must not brick the handoff
        assertEq(dep.get(id).owner, bob);
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

    // ---- the schema gate clients sniff --------------------------------------

    function test_schemaMarksTheTransferSurface() public view {
        assertEq(dep.deploymentsSchema(), 13);   // >= 11 is what the transfer surface gates on
    }
}
