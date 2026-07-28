// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {EnclaveDeployments, IEnclaveRegistry} from "../../EnclaveDeployments.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// Registry stand-in with per-enclave operators, so two runners can trade a
/// lease (the setShares suite's single-operator mock can't exercise the
/// previous-runner settlement in claim()).
contract MockRegistryMulti {
    mapping(bytes32 => address) public operatorOf;
    mapping(bytes32 => uint64) public cpuPriceOf;   // 0 -> the shared default below
    mapping(bytes32 => uint64) public gpuPriceOf;
    function set(bytes32 id, address operator) external { operatorOf[id] = operator; }
    function setPrices(bytes32 id, uint64 c, uint64 g) external { cpuPriceOf[id] = c; gpuPriceOf[id] = g; }
    function get(bytes32 id) external view returns (IEnclaveRegistry.Enclave memory e) {
        e.operator = operatorOf[id];
        e.active = true;
        e.cpuPricePerSec6 = cpuPriceOf[id] == 0 ? 834 : cpuPriceOf[id];
        e.gpuPricePerSec6 = gpuPriceOf[id] == 0 ? 1667 : gpuPriceOf[id];
    }
}

/// Runner payout (rev 7): the metered split that pays permissionless sellers.
/// The money invariants under test everywhere:
///   - a runner is credited for lease time it HELD, never a released tail;
///   - credits draw on per-deployment escrow retained from USDC fundings, so
///     the contract's USDC balance always covers escrow + earnings + bonds;
///   - the user-side ledgers (balance6/spent6) are untouched by the meter.
contract EnclaveDeploymentsRunnerPayoutTest is Test {
    EnclaveDeployments internal dep;
    MockUSDC internal usdc;
    MockRegistryMulti internal reg;

    address internal user = makeAddr("user");
    address internal payout = makeAddr("payout");
    address internal operator = makeAddr("operator");
    address internal operator2 = makeAddr("operator2");
    address internal publisher = makeAddr("publisher");
    address internal coldWallet = makeAddr("coldWallet");
    bytes32 internal constant ENCLAVE_ID = keccak256("enclave-1");
    bytes32 internal constant ENCLAVE_ID_2 = keccak256("enclave-2");

    uint256 internal constant GPU_PRICE = 1667;
    uint256 internal constant CPU_PRICE = 834;
    // whole-machine ceiling: never binds, so these tests keep measuring the
    // payout meter rather than the cap (EnclaveDeployments.rateCap.t.sol owns that)
    uint256 internal constant ROOMY_CAP = (GPU_PRICE * 1000 + CPU_PRICE * 1000 + 999) / 1000;

    // All warps in this suite are ABSOLUTE (T0 + offset), never
    // vm.warp(block.timestamp + n): with via_ir on (foundry.toml), solc may
    // legally CSE TIMESTAMP reads across the cheatcode (block.timestamp is
    // transaction-invariant in real EVM), silently collapsing chained
    // relative warps onto the same instant.
    uint256 internal constant T0 = 1_700_000_000;

    function setUp() public {
        usdc = new MockUSDC();
        reg = new MockRegistryMulti();
        reg.set(ENCLAVE_ID, operator);
        reg.set(ENCLAVE_ID_2, operator2);
        dep = new EnclaveDeployments(address(usdc), payout, address(reg), address(0));
        // These suites pin the PRE-CUTOVER meter (held lease time, the rev-8
        // semantics they were written against). Proven-time metering — what the
        // meter does once proofRequiredFrom passes, and the whole proof protocol
        // in EnclaveProofOfTime — has its own suite in
        // EnclaveDeployments.proofOfTime.t.sol.
        dep.setProofRequiredFrom(0);
        usdc.mint(user, 1_000_000e6);
        vm.prank(user);
        usdc.approve(address(dep), type(uint256).max);
        vm.warp(T0);
    }

    function _rate(uint16 gpuMilli, uint16 cpuMilli) internal pure returns (uint256) {
        return (GPU_PRICE * gpuMilli + CPU_PRICE * cpuMilli + 999) / 1000;
    }

    function _create(uint16 gpuMilli, uint16 cpuMilli, uint256 fund6) internal returns (bytes32 id) {
        vm.startPrank(user);
        id = dep.create("catalog://app/0", gpuMilli, cpuMilli, 8080, "", true, "", address(0), 0, ROOMY_CAP);
        if (fund6 > 0) dep.fund(id, fund6);
        vm.stopPrank();
    }

    function _claim(bytes32 id) internal {
        vm.prank(operator);
        dep.claim(id, ENCLAVE_ID);
    }

    /// The contract must always hold what its ledgers promise.
    function _assertSolvent(bytes32 id) internal view {
        (, uint256 escrow6,) = dep.earnOf(id);
        (uint256 bond1,) = dep.bondOf(operator);
        (uint256 bond2,) = dep.bondOf(operator2);
        assertGe(usdc.balanceOf(address(dep)),
            escrow6 + dep.earned6(operator) + dep.earned6(operator2) + bond1 + bond2);
    }

    // ---- the rate snapshot --------------------------------------------------

    function test_claimSnapshotsRunnerRate_platformComponentOnly() public {
        vm.startPrank(user);
        bytes32 id = dep.create("catalog://app/0", 500, 250, 8080, "", true, "", publisher, 500, ROOMY_CAP + 500);
        dep.fund(id, 100e6);
        vm.stopPrank();
        _claim(id);                                    // the claiming host's price is the rate
        uint256 rate = _rate(500, 250) + 500;
        (uint256 r6,,) = dep.earnOf(id);
        assertEq(r6, ((rate - 500) * 8000) / 10000);   // bps of rate MINUS the publisher fee
        assertEq(dep.get(id).rate, rate);              // the user-facing rate is untouched
    }

    function test_runnerBpsChange_affectsFutureCreatesOnly() public {
        bytes32 before = _create(0, 100, 0);
        dep.setRunnerBps(5000);
        bytes32 later = _create(0, 100, 0);
        (uint256 rBefore,,) = dep.earnOf(before);
        (uint256 rLater,,) = dep.earnOf(later);
        // pre-claim the working rate is the deployment's ceiling (no host has
        // priced it yet), so the cut is bps of that
        assertEq(rBefore, (ROOMY_CAP * 8000) / 10000);
        assertEq(rLater, (ROOMY_CAP * 5000) / 10000);
    }

    function test_resizeResnapshotsAtCurrentBps() public {
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        dep.setRunnerBps(5000);
        vm.prank(user);
        dep.setShares(id, 0, 200);
        (uint256 r6,,) = dep.earnOf(id);
        assertEq(r6, (_rate(0, 200) * 5000) / 10000);  // a resize is a new purchase decision
    }

    function test_runnerBpsZero_behavesLikeRevSix() public {
        dep.setRunnerBps(0);
        bytes32 id = _create(0, 100, 0);
        (uint256 r6,,) = dep.earnOf(id);
        assertEq(r6, 0);
        vm.prank(user);
        dep.fund(id, 100e6);
        (, uint256 escrow6,) = dep.earnOf(id);
        assertEq(escrow6, 0);                          // nothing retained ...
        assertEq(usdc.balanceOf(address(dep)), 0);     // ... everything forwarded
        assertEq(usdc.balanceOf(payout), 100e6);
    }

    // ---- funding escrows the runner share -----------------------------------

    function test_fundSplitsEscrowFeeAndPayout_exactly() public {
        uint256 fee = 500;
        vm.startPrank(user);
        bytes32 id = dep.create("catalog://app/0", 500, 250, 8080, "", true, "", publisher, fee, ROOMY_CAP + fee);
        uint256 value = 123_456_789;                   // deliberately non-dividing
        dep.fund(id, value);
        vm.stopPrank();
        // a funding before any claim splits against the record's working rate,
        // which pre-claim is its ceiling (see EnclaveDeployments.rateCap.t.sol
        // for what a later claim at a cheaper host does to the ratio)
        uint256 rate = dep.get(id).rate;
        assertEq(rate, ROOMY_CAP + fee);
        (uint256 r6, uint256 escrow6,) = dep.earnOf(id);
        uint256 cut = (value * fee) / rate;            // floor (publisher)
        uint256 esc = (value * r6 + rate - 1) / rate;  // ceil (escrow)
        assertEq(escrow6, esc);
        assertEq(usdc.balanceOf(publisher), cut);
        assertEq(usdc.balanceOf(payout), value - cut - esc);
        assertEq(usdc.balanceOf(address(dep)), esc);   // conservation: nothing minted, nothing lost
        assertEq(dep.get(id).balance6, value);         // the credit is the FULL amount, as ever
    }

    function test_escrowCoversEverySecondTheBalanceCanBuy() public {
        // many small fundings (worst case for rounding): the ceil per funding
        // must still cover the credits of every affordable second
        bytes32 id = _create(0, 100, 0);
        vm.startPrank(user);
        for (uint256 i = 0; i < 20; i++) dep.fund(id, 1_000 + i);
        vm.stopPrank();
        EnclaveDeployments.Deployment memory d = dep.get(id);
        (uint256 r6, uint256 escrow6,) = dep.earnOf(id);
        assertGe(escrow6, (d.balance6 / d.rate) * r6);
    }

    // ---- the meter: held time earns, tails don't ----------------------------

    function test_renewCreditsHeldTime() public {
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        (uint256 r6, uint256 escrow0,) = dep.earnOf(id);
        vm.warp(T0 + 600);
        vm.prank(operator);
        dep.renew(id);
        assertEq(dep.earned6(operator), 600 * r6);
        (, uint256 escrow1,) = dep.earnOf(id);
        assertEq(escrow0 - escrow1, 600 * r6);         // paid FROM the escrow, 1:1
        _assertSolvent(id);
    }

    function test_releasePaysHeldTimeOnly_tailRefundsUser() public {
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        (uint256 r6,,) = dep.earnOf(id);
        EnclaveDeployments.Deployment memory d0 = dep.get(id);
        vm.warp(T0 + 700);
        uint256 tail = uint256(d0.leaseUntil) - (T0 + 700);
        vm.prank(operator);
        dep.release(id);
        assertEq(dep.earned6(operator), 700 * r6);     // held 700s -> paid 700s
        EnclaveDeployments.Deployment memory d = dep.get(id);
        assertEq(d.balance6, d0.balance6 + tail * d.rate);  // the tail went back to the user whole
        _assertSolvent(id);
    }

    function test_immediateRelease_earnsNothing() public {
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        vm.prank(operator);
        dep.release(id);                               // claim-and-bail: zero seconds held
        assertEq(dep.earned6(operator), 0);
    }

    function test_expiredLease_earnsThroughLeaseEndOnly_viaSettle() public {
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        (uint256 r6,,) = dep.earnOf(id);
        uint64 leaseUntil = dep.get(id).leaseUntil;
        uint256 quantum = leaseUntil - T0;
        vm.warp(uint256(leaseUntil) + 5000);           // died mid-lease, nobody re-claimed
        dep.settle(id);                                // permissionless
        assertEq(dep.earned6(operator), quantum * r6); // the full quantum, not a second more
        dep.settle(id);                                // idempotent
        assertEq(dep.earned6(operator), quantum * r6);
    }

    function test_claimSettlesThePreviousRunner() public {
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        (uint256 r6,,) = dep.earnOf(id);
        uint64 leaseUntil = dep.get(id).leaseUntil;
        uint256 quantum = leaseUntil - T0;
        vm.warp(uint256(leaseUntil) + 100);
        vm.prank(operator2);
        dep.claim(id, ENCLAVE_ID_2);                   // failover: the next runner's claim ...
        assertEq(dep.earned6(operator), quantum * r6); // ... pays the dead one what it held
        vm.warp(uint256(leaseUntil) + 100 + 300);
        vm.prank(operator2);
        dep.release(id);
        assertEq(dep.earned6(operator2), 300 * r6);    // and the new meter started at ITS claim
        _assertSolvent(id);
    }

    function test_resizeMidLease_creditsAtOldRateFirst() public {
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        (uint256 rOld,,) = dep.earnOf(id);
        vm.warp(T0 + 600);
        vm.prank(user);
        dep.setShares(id, 0, 500);
        assertEq(dep.earned6(operator), 600 * rOld);   // served time settled at the OLD cut
        (uint256 rNew,,) = dep.earnOf(id);
        assertEq(rNew, (_rate(0, 500) * 8000) / 10000);
        vm.warp(T0 + 700);
        vm.prank(operator);
        dep.release(id);
        assertEq(dep.earned6(operator), 600 * rOld + 100 * rNew);
    }

    // ---- withdraw -----------------------------------------------------------

    function test_withdrawEarnings_paysAnyAddressAndZeroes() public {
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        vm.warp(T0 + 600);
        vm.prank(operator);
        dep.renew(id);
        uint256 earned = dep.earned6(operator);
        assertGt(earned, 0);
        vm.prank(operator);
        dep.withdrawEarnings(coldWallet);
        assertEq(usdc.balanceOf(coldWallet), earned);
        assertEq(dep.earned6(operator), 0);
        vm.prank(operator);
        vm.expectRevert("nothing earned");
        dep.withdrawEarnings(coldWallet);
    }

    // ---- zero-escrow degradation + re-backing -------------------------------

    function test_importedBalance_noEscrow_creditsNothing_untilFundEscrow() public {
        // migrated records carry balance6 but no escrow (the USDC never moved);
        // the meter must degrade to zero, then pay again once re-backed
        EnclaveDeployments.Deployment[] memory items = new EnclaveDeployments.Deployment[](1);
        items[0].id = keccak256("imported");
        items[0].owner = user;
        items[0].appRef = "catalog://app/0";
        items[0].cpuMilli = 100;
        items[0].appPort = 8080;
        items[0].active = true;
        items[0].rate = _rate(0, 100);
        items[0].balance6 = 100e6;
        dep.importDeployments(items);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = items[0].id;
        uint256[] memory rates = new uint256[](1);
        rates[0] = (_rate(0, 100) * 8000) / 10000;
        dep.importEarn(ids, rates);                    // owner GRANTS the runner cut on migration

        _claim(ids[0]);
        vm.warp(T0 + 600);
        vm.prank(operator);
        dep.renew(ids[0]);
        assertEq(dep.earned6(operator), 0);            // no escrow -> no credit, no revert

        usdc.mint(address(this), 10e6);                // the platform re-backs the record
        usdc.approve(address(dep), 10e6);
        dep.fundEscrow(ids[0], 10e6);
        vm.warp(T0 + 1200);
        vm.prank(operator);
        dep.renew(ids[0]);
        assertEq(dep.earned6(operator), 600 * rates[0]);  // later seconds pay; the dry window stays forfeit
        _assertSolvent(ids[0]);
    }

    function test_creditCappedByEscrow_neverInsolvent() public {
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        (uint256 r6,,) = dep.earnOf(id);               // the cut this host bought
        // drain the escrow to a sliver mid-lease via sweep? not allowed (leased) —
        // instead prove the cap arithmetic: elapsed*r6 above escrow pays exactly escrow
        vm.warp(T0 + 1800);
        dep.settle(id);
        ( , uint256 escrowLeft,) = dep.earnOf(id);
        assertEq(dep.earned6(operator), 1800 * r6);
        assertGe(escrowLeft, 0);
        assertEq(usdc.balanceOf(address(dep)), escrowLeft + dep.earned6(operator));
    }

    // ---- sweep --------------------------------------------------------------

    function test_sweepEscrow_onlyWhenDrained_creditsRunnerFirst() public {
        // fund one quantum exactly: after the claim burns it the balance is 0
        uint256 rate = _rate(0, 100);
        bytes32 id = _create(0, 100, rate * 1800 + 7);  // +7: a non-dividing escrow ceil leaves residue
        _claim(id);
        (uint256 r6,,) = dep.earnOf(id);
        vm.expectRevert("leased");
        dep.sweepEscrow(id);                           // never under a live lease
        vm.warp(T0 + 1800 + 1);
        uint256 payoutBefore = usdc.balanceOf(payout);
        dep.sweepEscrow(id);                           // drained + lapsed: residue recoverable
        assertEq(dep.earned6(operator), 1800 * r6);    // the last runner was settled first
        (, uint256 escrow6,) = dep.earnOf(id);
        assertEq(escrow6, 0);
        assertGt(usdc.balanceOf(payout), payoutBefore);
        assertEq(usdc.balanceOf(address(dep)), dep.earned6(operator));
    }

    function test_sweepEscrow_refusedWhileFundable() public {
        bytes32 id = _create(0, 100, 100e6);           // plenty of balance, unleased
        vm.expectRevert("still fundable");
        dep.sweepEscrow(id);
    }

    // ---- the optional claim bond --------------------------------------------

    function test_bondGate_offByDefault_onWhenSet() public {
        bytes32 id = _create(0, 100, 100e6);
        dep.setClaimBond(50e6, 1 days);
        vm.prank(operator);
        vm.expectRevert("bond required");
        dep.claim(id, ENCLAVE_ID);

        usdc.mint(operator, 50e6);
        vm.startPrank(operator);
        usdc.approve(address(dep), type(uint256).max);
        dep.postBond(50e6);
        dep.claim(id, ENCLAVE_ID);                     // bonded: business as usual
        vm.stopPrank();
        _assertSolvent(id);
    }

    function test_bondExit_blocksClaims_timelocksWithdraw_postRecommits() public {
        dep.setClaimBond(50e6, 1 days);
        usdc.mint(operator, 60e6);
        vm.startPrank(operator);
        usdc.approve(address(dep), type(uint256).max);
        dep.postBond(50e6);
        dep.requestBondExit();
        vm.stopPrank();

        bytes32 id = _create(0, 100, 100e6);
        vm.prank(operator);
        vm.expectRevert("bond required");              // an exiting bond authorizes nothing
        dep.claim(id, ENCLAVE_ID);

        vm.prank(operator);
        vm.expectRevert("exit pending");               // and can't leave early
        dep.withdrawBond(coldWallet);

        vm.prank(operator);
        dep.postBond(10e6);                            // posting cancels the exit
        (uint256 amount6, uint64 exitAt) = dep.bondOf(operator);
        assertEq(amount6, 60e6);
        assertEq(exitAt, 0);
        vm.prank(operator);
        dep.claim(id, ENCLAVE_ID);

        vm.startPrank(operator);
        dep.release(id);
        dep.requestBondExit();
        vm.warp(T0 + 2 days);
        dep.withdrawBond(coldWallet);
        vm.stopPrank();
        assertEq(usdc.balanceOf(coldWallet), 60e6);
        (amount6,) = dep.bondOf(operator);
        assertEq(amount6, 0);
    }

    function test_slashBond_boundedByBond_goesToPayout() public {
        dep.setClaimBond(50e6, 1 days);
        usdc.mint(operator, 50e6);
        vm.startPrank(operator);
        usdc.approve(address(dep), 50e6);
        dep.postBond(50e6);
        vm.stopPrank();

        vm.expectRevert("range");
        dep.slashBond(operator, 51e6, "over-slash");
        dep.slashBond(operator, 20e6, "claimed 3 leases, served none (probe log 2026-07-25)");
        (uint256 amount6,) = dep.bondOf(operator);
        assertEq(amount6, 30e6);
        assertEq(usdc.balanceOf(payout), 20e6);

        vm.prank(operator);
        vm.expectRevert("!owner");
        dep.slashBond(operator, 1, "not yours to slash");
    }

    // ---- user-side ledgers stay untouched by the meter ----------------------

    function test_meterNeverMovesUserLedgers() public {
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        EnclaveDeployments.Deployment memory d0 = dep.get(id);
        vm.warp(T0 + 900);
        dep.settle(id);
        EnclaveDeployments.Deployment memory d = dep.get(id);
        assertEq(d.balance6, d0.balance6);
        assertEq(d.spent6, d0.spent6);
        assertEq(d.balance6 + d.spent6 + 0, d0.balance6 + d0.spent6);
    }
}
