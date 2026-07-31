// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {EnclaveDeployments, IEnclaveRegistry} from "../../EnclaveDeployments.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract MockRegistryRetire {
    mapping(bytes32 => address) public operatorOf;
    function set(bytes32 id, address operator) external { operatorOf[id] = operator; }
    function get(bytes32 id) external view returns (IEnclaveRegistry.Enclave memory e) {
        e.operator = operatorOf[id];
        e.active = true;
        e.cpuPricePerSec6 = 834;
        e.gpuPricePerSec6 = 1667;
    }
}

/// End-of-life (rev 11): retire() is the migration answer to stranded funds.
/// The invariants under test:
///   - retirement is owner-ruled and one-way (there is no setter back);
///   - a retired ledger refuses every activity gate - no claim, no renewal,
///     no funding of any kind - so a rogue operator cannot race the sweep
///     and burn owners' balances into lease earnings;
///   - refund() opens to ANY caller, but the payout still goes to the
///     record's OWNER - a permissionless sweep pushes money home, never out;
///   - the platform gains nothing early: before retire() every gate reads
///     exactly as rev 10 - a non-owner refund is still refused;
///   - the seller is never stranded: a live lease's reserve survives the
///     sweep and pays the runner in full, exactly as an owner refund would;
///   - the sweep opens ONLY refund: every other owner right (transfer,
///     config, active) stays owner-gated after retirement.
contract EnclaveDeploymentsRetireTest is Test {
    EnclaveDeployments internal dep;
    MockUSDC internal usdc;
    MockRegistryRetire internal reg;

    address internal alice = makeAddr("alice");     // a user with funded records
    address internal sweeper = makeAddr("sweeper"); // anyone at all, post-retirement
    address internal payout = makeAddr("payout");
    address internal operator = makeAddr("operator");
    bytes32 internal constant ENCLAVE_ID = keccak256("enclave-1");

    uint256 internal constant CPU_PRICE = 834;
    uint16 internal constant GPU_MILLI = 0;
    uint16 internal constant CPU_MILLI = 1000;
    uint256 internal constant RATE = (CPU_PRICE * 1000 + 999) / 1000;   // 834

    // Absolute warps only — see the note in EnclaveDeployments.runnerPayout.t.sol.
    uint256 internal constant T0 = 1_700_000_000;

    function setUp() public {
        usdc = new MockUSDC();
        reg = new MockRegistryRetire();
        reg.set(ENCLAVE_ID, operator);
        dep = new EnclaveDeployments(address(usdc), payout, address(reg), address(0));
        dep.setProofRequiredFrom(0);           // pre-cutover meter, as in the refund suite
        usdc.mint(alice, 1_000_000e6);
        vm.prank(alice);
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

    // ---- the switch itself --------------------------------------------------

    function test_onlyTheOwnerMayRetire() public {
        vm.prank(alice);
        vm.expectRevert("!owner");
        dep.retire();
        assertFalse(dep.retired());
        dep.retire();
        assertTrue(dep.retired());
    }

    /// Before retirement, nothing changed: the platform holds NO early power.
    function test_beforeRetirementEveryGateReadsAsRevTen() public {
        bytes32 id = _create(100e6);
        vm.prank(sweeper);
        vm.expectRevert("!owner");
        dep.refund(id);                          // a stranger still cannot sweep
        _claim(id);                              // ...and the ledger still works
        assertGt(uint256(dep.get(id).leaseUntil), block.timestamp);
    }

    // ---- a retired ledger is closed for business ----------------------------

    function test_retiredLedgerRefusesEveryActivityGate() public {
        bytes32 id = _create(100e6);
        dep.retire();
        vm.prank(alice);
        vm.expectRevert("retired");
        dep.fund(id, 1e6);                       // no fresh money onto a dead ledger
        vm.prank(operator);
        vm.expectRevert("retired");
        dep.claim(id, ENCLAVE_ID);               // no rogue claim can race the sweep
        vm.expectRevert("retired");
        dep.fundEscrow(id, 1e6);                 // no re-backing either
    }

    function test_retiredLedgerRefusesRenewals() public {
        bytes32 id = _create(100e6);
        _claim(id);
        dep.retire();
        vm.warp(T0 + 600);
        vm.prank(operator);
        vm.expectRevert("retired");
        dep.renew(id);                           // the running lease just lapses
    }

    // ---- the permissionless sweep -------------------------------------------

    /// The headline: after retirement ANYONE can push a record's escrow home,
    /// and home is the OWNER's wallet - the sweeper touches nothing.
    function test_anyoneCanSweep_theOwnerIsPaid() public {
        bytes32 id = _create(100e6);
        uint256 quoted = dep.refundableOf(id);
        dep.retire();

        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.prank(sweeper);
        dep.refund(id);
        assertEq(usdc.balanceOf(alice) - aliceBefore, quoted, "the owner is paid");
        assertEq(usdc.balanceOf(sweeper), 0, "the sweeper gets nothing");
        assertFalse(dep.get(id).active, "the record closes with the money");
        assertEq(dep.refundableOf(id), 0);
    }

    /// A sweep mid-lease is exactly an owner refund mid-lease: the free part
    /// goes home now, the reserve stays for the seller, and once the lease
    /// lapses a second sweep sends the tail home too.
    function test_sweepMidLeaseNeverStrandsTheSeller() public {
        bytes32 id = _create(100e6);
        _claim(id);
        uint64 leaseUntil = dep.get(id).leaseUntil;
        dep.retire();

        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 quoted = dep.refundableOf(id);
        vm.prank(sweeper);
        dep.refund(id);                          // free part home; reserve held back
        assertEq(usdc.balanceOf(alice) - aliceBefore, quoted);

        // the lease lapses unproven-unreleased; the meter closes it out and
        // the runner is paid for every second it held
        vm.warp(uint256(leaseUntil) + 1);
        dep.settle(id);
        assertEq(dep.earned6(operator), uint256(leaseUntil - uint64(T0)) * _rate6(id), "the seller is whole");

        uint256 tail = dep.refundableOf(id);
        if (tail > 0) {                          // any unclaimed remainder goes home too
            vm.prank(sweeper);
            dep.refund(id);
            assertEq(usdc.balanceOf(alice) - aliceBefore, quoted + tail);
        }
        (, uint256 escrow6,) = dep.earnOf(id);
        assertGe(usdc.balanceOf(address(dep)), escrow6 + dep.earned6(operator), "solvent throughout");
    }

    /// Retirement opens refund and ONLY refund: every other owner right stays
    /// owner-gated, so a sweeper can push money home but never take the
    /// record, its config, or its state.
    function test_retirementOpensOnlyTheRefundGate() public {
        bytes32 id = _create(0);
        dep.retire();
        vm.startPrank(sweeper);
        vm.expectRevert("!owner");
        dep.transferDeployment(id, sweeper);
        vm.expectRevert("!owner");
        dep.setConfig(id, "x");
        vm.expectRevert("!owner");
        dep.setActive(id, false);
        vm.stopPrank();
        // ...and the owner keeps every right they had
        vm.prank(alice);
        dep.transferDeployment(id, sweeper);
        assertEq(dep.get(id).owner, sweeper);
    }
}
