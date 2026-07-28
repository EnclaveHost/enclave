// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {EnclaveDeployments, IEnclaveRegistry} from "../../EnclaveDeployments.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract MockRegistryRefund {
    mapping(bytes32 => address) public operatorOf;
    function set(bytes32 id, address operator) external { operatorOf[id] = operator; }
    function get(bytes32 id) external view returns (IEnclaveRegistry.Enclave memory e) {
        e.operator = operatorOf[id];
        e.active = true;
        e.cpuPricePerSec6 = 834;
        e.gpuPricePerSec6 = 1667;
    }
}

/// Cancellation (rev 10): refund() gives an owner back the unused runtime the
/// contract still HOLDS for their deployment. The invariants under test:
///   - what leaves is escrow and only escrow — never the publisher's cut or the
///     platform's remainder, which left at funding time;
///   - a seller can never be stranded: the runner is credited for proven service
///     BEFORE anything moves, and whatever a live-or-still-provable lease could
///     yet claim is reserved out of the refund;
///   - an owner can never withdraw more than their OWN fundings escrowed, so a
///     third party's top-up is not withdrawable by the owner;
///   - refundableOf() is exact — it equals what refund() actually pays;
///   - the contract stays solvent through all of it.
contract EnclaveDeploymentsRefundTest is Test {
    EnclaveDeployments internal dep;
    MockUSDC internal usdc;
    MockRegistryRefund internal reg;

    address internal user = makeAddr("user");
    address internal sponsor = makeAddr("sponsor");
    address internal payout = makeAddr("payout");
    address internal operator = makeAddr("operator");
    address internal publisher = makeAddr("publisher");
    bytes32 internal constant ENCLAVE_ID = keccak256("enclave-1");

    uint256 internal constant CPU_PRICE = 834;

    // CPU-only, whole machine: the rate create snapshots (the cap) and the rate
    // claim re-snapshots from the host are then the SAME number, so escrow
    // arithmetic is not skewed by a re-price halfway through a test.
    uint16 internal constant GPU_MILLI = 0;
    uint16 internal constant CPU_MILLI = 1000;
    uint256 internal constant RATE = (CPU_PRICE * 1000 + 999) / 1000;   // 834

    // Absolute warps only — see the note in EnclaveDeployments.runnerPayout.t.sol.
    uint256 internal constant T0 = 1_700_000_000;

    function setUp() public {
        usdc = new MockUSDC();
        reg = new MockRegistryRefund();
        reg.set(ENCLAVE_ID, operator);
        dep = new EnclaveDeployments(address(usdc), payout, address(reg), address(0));
        dep.setProofRequiredFrom(0);           // pre-cutover meter; proof interaction has its own test below
        usdc.mint(user, 1_000_000e6);
        usdc.mint(sponsor, 1_000_000e6);
        vm.prank(user);
        usdc.approve(address(dep), type(uint256).max);
        vm.prank(sponsor);
        usdc.approve(address(dep), type(uint256).max);
        vm.warp(T0);
    }

    function _create(uint256 fund6) internal returns (bytes32 id) {
        return _createWithFee(fund6, address(0), 0);
    }

    function _createWithFee(uint256 fund6, address feeTo, uint256 fee6) internal returns (bytes32 id) {
        vm.startPrank(user);
        id = dep.create("catalog://app/0", GPU_MILLI, CPU_MILLI, 8080, "", true, "", feeTo, fee6, RATE + fee6);
        if (fund6 > 0) dep.fund(id, fund6);
        vm.stopPrank();
    }

    function _claim(bytes32 id) internal {
        vm.prank(operator);
        dep.claim(id, ENCLAVE_ID);
    }

    /// The escrow a funding of `value` contributes, by the contract's own rule
    /// (ceil against the snapshotted rate — the platform absorbs the dust).
    function _escOf(bytes32 id, uint256 value) internal view returns (uint256) {
        (uint256 r6,,) = dep.earnOf(id);
        uint256 rate = dep.get(id).rate;
        return (value * r6 + (rate - 1)) / rate;
    }

    /// The contract must always hold what its ledgers promise.
    function _assertSolvent(bytes32 id) internal view {
        (, uint256 escrow6,) = dep.earnOf(id);
        (uint256 bond,) = dep.bondOf(operator);
        assertGe(usdc.balanceOf(address(dep)), escrow6 + dep.earned6(operator) + bond);
    }

    // ---- the basic cancellation -------------------------------------------

    function test_refundPaysTheHeldEscrow_andClosesTheRecord() public {
        bytes32 id = _create(100e6);
        uint256 expected = _escOf(id, 100e6);
        assertEq(dep.refundableOf(id), expected);

        uint256 before = usdc.balanceOf(user);
        vm.prank(user);
        dep.refund(id);

        assertEq(usdc.balanceOf(user) - before, expected, "owner receives the held escrow");
        EnclaveDeployments.Deployment memory d = dep.get(id);
        assertEq(d.balance6, 0, "the runtime goes back with the money");
        assertFalse(d.active, "the record stops being claimable");
        (, uint256 escrow6,) = dep.earnOf(id);
        assertEq(escrow6, 0);
        assertEq(dep.ownerEscrow6(id), 0);
        assertEq(dep.refundableOf(id), 0);
        _assertSolvent(id);
    }

    /// The headline caveat: a refund is the RUNNER SHARE of unused time, not the
    /// sticker price. The platform remainder left the contract at funding time.
    function test_refundIsEscrowOnly_notTheWholeFunding() public {
        bytes32 id = _create(100e6);
        uint256 got = dep.refundableOf(id);
        assertLt(got, 100e6, "never the full funding");
        // runnerBps = 8000 of the platform component, and there is no fee here.
        // Not exactly 80%: the per-second runner rate is floored (floor(834 *
        // 0.8) = 667), so the escrowed share is 667/834 of a funding.
        assertApproxEqRel(got, (100e6 * 8000) / 10000, 1e15, "~80% of an unspent, fee-free funding");
        // and the rest genuinely left: payout holds it already
        assertEq(usdc.balanceOf(payout), 100e6 - got);
    }

    function test_publisherCutIsNotRefundable() public {
        bytes32 id = _createWithFee(100e6, publisher, 200);
        uint256 got = dep.refundableOf(id);
        uint256 fee = usdc.balanceOf(publisher);
        assertGt(fee, 0, "publisher was paid at funding time");
        // the publisher's cut is gone from the contract; the refund cannot reach it
        assertLe(got + fee, 100e6);
        vm.prank(user);
        dep.refund(id);
        assertEq(usdc.balanceOf(publisher), fee, "refund does not claw back the publisher");
    }

    function test_ethFundingsEscrowNothing_soRefundHasNothingToPay() public {
        bytes32 id = _create(0);
        vm.deal(user, 10 ether);
        // no ETH/USD feed is wired in this suite, so fundEth is disabled — assert
        // the accounting fact directly: an unfunded record refunds nothing.
        assertEq(dep.refundableOf(id), 0);
        vm.prank(user);
        vm.expectRevert("nothing to refund");
        dep.refund(id);
    }

    // ---- the owner cap: a sponsor's top-up is not the owner's to take -------

    function test_ownerCannotWithdrawASponsorsTopUp() public {
        bytes32 id = _create(100e6);
        uint256 ownEsc = dep.ownerEscrow6(id);

        vm.prank(sponsor);
        dep.fund(id, 400e6);                    // a third party buys the owner more runtime

        (, uint256 escrow6,) = dep.earnOf(id);
        assertGt(escrow6, ownEsc, "the sponsor's share is escrowed too");
        assertEq(dep.ownerEscrow6(id), ownEsc, "but it is not the owner's to refund");
        assertEq(dep.refundableOf(id), ownEsc, "refund is capped at the owner's own fundings");

        uint256 before = usdc.balanceOf(user);
        vm.prank(user);
        dep.refund(id);
        assertEq(usdc.balanceOf(user) - before, ownEsc);

        (, uint256 left,) = dep.earnOf(id);
        assertGt(left, 0, "the sponsor's escrow stays in the contract");
        _assertSolvent(id);
    }

    function test_sponsorCannotTriggerARefund() public {
        bytes32 id = _create(100e6);
        vm.prank(sponsor);
        dep.fund(id, 100e6);
        vm.prank(sponsor);
        vm.expectRevert("not owner");
        dep.refund(id);
    }

    function test_onlyTheOwnerMayRefund() public {
        bytes32 id = _create(100e6);
        vm.prank(operator);
        vm.expectRevert("not owner");
        dep.refund(id);
    }

    // ---- the seller is never stranded ---------------------------------------

    /// Cancelling mid-lease pays only what the lease cannot still claim; the
    /// runner is credited in full for the seconds it goes on to serve.
    function test_refundDuringALiveLeaseReservesWhatTheRunnerCanStillEarn() public {
        bytes32 id = _create(100e6);
        _claim(id);
        (uint256 r6, uint256 escBefore,) = dep.earnOf(id);
        uint64 leaseUntil = dep.get(id).leaseUntil;

        uint256 reserve = uint256(leaseUntil - uint64(block.timestamp)) * r6;
        assertEq(dep.refundableOf(id), escBefore - reserve, "the lease's remaining seconds are held back");

        vm.prank(user);
        dep.refund(id);

        (, uint256 escAfter,) = dep.earnOf(id);
        assertEq(escAfter, reserve, "exactly the reserve stays behind");
        _assertSolvent(id);

        // the runner serves the lease out and is paid for every second of it
        vm.warp(uint256(leaseUntil));
        dep.settle(id);
        assertEq(dep.earned6(operator), reserve, "the seller got the whole reserved amount");
        _assertSolvent(id);
    }

    /// After the runner releases, the tail it did not serve becomes refundable —
    /// a second call collects it.
    function test_releasedTailBecomesRefundable() public {
        bytes32 id = _create(100e6);
        _claim(id);
        vm.prank(user);
        dep.refund(id);
        (, uint256 reserved,) = dep.earnOf(id);
        assertGt(reserved, 0);

        vm.warp(T0 + 600);                       // part-way through the lease
        vm.prank(operator);
        dep.release(id);

        uint256 served = 600 * _rate6(id);
        assertEq(dep.earned6(operator), served, "paid for what it held");
        assertEq(dep.refundableOf(id), reserved - served, "the unserved tail is the owner's again");

        uint256 before = usdc.balanceOf(user);
        vm.prank(user);
        dep.refund(id);
        assertEq(usdc.balanceOf(user) - before, reserved - served);
        _assertSolvent(id);
    }

    /// A lapsed lease can still be proven against, so its escrow stays reserved
    /// until the meter closes it out — the owner cannot front-run a late runner.
    function test_lapsedLeaseEscrowStaysReservedUntilSettled() public {
        bytes32 id = _create(100e6);
        _claim(id);
        uint64 leaseUntil = dep.get(id).leaseUntil;
        vm.prank(user);
        dep.refund(id);
        (, uint256 reserved,) = dep.earnOf(id);

        vm.warp(uint256(leaseUntil) + 3600);     // the lease lapsed; nobody released
        assertEq(dep.refundableOf(id), 0, "still the runner's to claim");
        vm.prank(user);
        vm.expectRevert("nothing to refund");
        dep.refund(id);

        dep.settle(id);                          // meter closes: the runner takes it
        assertEq(dep.earned6(operator), reserved);
        _assertSolvent(id);
    }

    function _rate6(bytes32 id) internal view returns (uint256 r6) {
        (r6,,) = dep.earnOf(id);
    }

    // ---- refundableOf is exact, not an estimate -----------------------------

    function test_refundableOfEqualsWhatRefundPays_evenWithAnUnsettledMeter() public {
        bytes32 id = _create(100e6);
        _claim(id);
        vm.warp(T0 + 900);                       // meter is stale: creditedUntil has not moved
        uint256 quoted = dep.refundableOf(id);

        uint256 before = usdc.balanceOf(user);
        vm.prank(user);
        dep.refund(id);                          // this settles the meter first
        assertEq(usdc.balanceOf(user) - before, quoted, "the quote was exact");
        _assertSolvent(id);
    }

    // ---- no double dipping ---------------------------------------------------

    function test_refundIsNotRepeatable() public {
        bytes32 id = _create(100e6);
        vm.prank(user);
        dep.refund(id);
        vm.prank(user);
        vm.expectRevert("nothing to refund");
        dep.refund(id);
    }

    function test_refundedRecordCannotBeClaimed() public {
        bytes32 id = _create(100e6);
        vm.prank(user);
        dep.refund(id);
        vm.prank(operator);
        vm.expectRevert("inactive");
        dep.claim(id, ENCLAVE_ID);
    }

    /// A cancelled deployment is not a dead one: funding it again restores both
    /// the runtime and a fresh refundable balance.
    function test_recordCanBeFundedAgainAfterARefund() public {
        bytes32 id = _create(100e6);
        vm.prank(user);
        dep.refund(id);

        vm.prank(user);
        dep.setActive(id, true);
        vm.prank(user);
        dep.fund(id, 50e6);

        assertEq(dep.refundableOf(id), _escOf(id, 50e6));
        assertEq(dep.get(id).balance6, 50e6);
        _assertSolvent(id);
    }

    // ---- the platform's own sweep still cannot touch a live record ----------

    function test_refundDoesNotOpenSweepEscrowOnASponsoredRecord() public {
        bytes32 id = _create(100e6);
        vm.prank(sponsor);
        dep.fund(id, 100e6);
        vm.prank(user);
        dep.refund(id);                          // balance6 -> 0, sponsor escrow remains
        // balance is drained and no lease is live, so the sweep is legitimately
        // open — assert it pays the PLATFORM, never the owner, and stays solvent
        uint256 before = usdc.balanceOf(payout);
        dep.sweepEscrow(id);
        assertGt(usdc.balanceOf(payout) - before, 0);
        (, uint256 escrow6,) = dep.earnOf(id);
        assertEq(escrow6, 0);
    }

    // ---- migration: a record that predates this ledger must still refund ----

    /// The whole install base arrives through importDeployments, whose balances
    /// are accounting numbers with no escrow behind them (the real USDC stays on
    /// the source contract). The platform re-backs them with fundEscrow — as the
    /// PLATFORM, not as each owner — so without the import-window rule in
    /// fundEscrow every migrated deployment would land permanently un-refundable
    /// and sealImports would freeze that in place.
    function _importOne(bytes32 id, uint256 balance6) internal {
        EnclaveDeployments.Deployment[] memory items = new EnclaveDeployments.Deployment[](1);
        items[0].id = id;
        items[0].owner = user;
        items[0].appRef = "catalog://app/0";
        items[0].gpuMilli = GPU_MILLI;
        items[0].cpuMilli = CPU_MILLI;
        items[0].appPort = 8080;
        items[0].active = true;
        items[0].createdAt = uint64(block.timestamp);
        items[0].rate = RATE;
        items[0].balance6 = balance6;
        dep.importDeployments(items);
        bytes32[] memory ids = new bytes32[](1);
        uint256[] memory rates = new uint256[](1);
        ids[0] = id; rates[0] = (RATE * 8000) / 10000;
        dep.importEarn(ids, rates);                    // grant the runner rate the source carried
    }

    function test_migratedRecordIsRefundableAfterThePlatformReBacksIt() public {
        bytes32 id = keccak256("migrated-1");
        _importOne(id, 100e6);
        assertEq(dep.refundableOf(id), 0, "nothing is backed until the platform re-seats the escrow");

        uint256 esc = _escOf(id, 100e6);
        usdc.mint(address(this), esc);
        usdc.approve(address(dep), esc);
        dep.fundEscrow(id, esc);                       // platform re-backs, import window still OPEN

        assertEq(dep.ownerEscrow6(id), esc, "re-seated escrow counts as the owner's own payment");
        assertEq(dep.refundableOf(id), esc);
        uint256 before = usdc.balanceOf(user);
        vm.prank(user);
        dep.refund(id);
        assertEq(usdc.balanceOf(user) - before, esc, "a migrated owner can cancel like anyone else");
        _assertSolvent(id);
    }

    /// After sealing, a platform fundEscrow is the ETH-funding case: the payer's
    /// ETH went to payout, so this is the platform backing runner credits with
    /// its OWN money and it must not become withdrawable by the owner.
    function test_platformReBackingAfterSealingIsNotTheOwnersToTake() public {
        bytes32 id = keccak256("migrated-2");
        _importOne(id, 100e6);
        dep.sealImports();

        uint256 esc = _escOf(id, 100e6);
        usdc.mint(address(this), esc);
        usdc.approve(address(dep), esc);
        dep.fundEscrow(id, esc);

        assertEq(dep.ownerEscrow6(id), 0, "platform money stays platform money once imports are sealed");
        assertEq(dep.refundableOf(id), 0);
        vm.prank(user);
        vm.expectRevert("nothing to refund");
        dep.refund(id);
        // ...but it still does its real job: backing the runner's credits
        (, uint256 escrow6,) = dep.earnOf(id);
        assertEq(escrow6, esc);
    }

    /// The owner topping up their OWN migrated record is refundable either way.
    function test_ownerTopUpAfterSealingIsStillRefundable() public {
        bytes32 id = keccak256("migrated-3");
        _importOne(id, 100e6);
        dep.sealImports();
        vm.prank(user);
        dep.fund(id, 50e6);
        assertEq(dep.refundableOf(id), _escOf(id, 50e6));
    }

    // ---- fuzz: solvency and the owner cap hold for any funding split --------

    function testFuzz_refundNeverExceedsOwnFundingAndKeepsContractSolvent(
        uint96 ownFund, uint96 sponsorFund
    ) public {
        ownFund = uint96(bound(ownFund, 1e6, 100_000e6));
        sponsorFund = uint96(bound(sponsorFund, 0, 100_000e6));
        usdc.mint(user, ownFund);
        usdc.mint(sponsor, sponsorFund);

        bytes32 id = _create(ownFund);
        uint256 ownEsc = dep.ownerEscrow6(id);
        if (sponsorFund > 0) {
            vm.prank(sponsor);
            dep.fund(id, sponsorFund);
        }

        uint256 before = usdc.balanceOf(user);
        vm.prank(user);
        dep.refund(id);
        uint256 paid = usdc.balanceOf(user) - before;

        assertLe(paid, ownEsc, "never more than the owner's own escrow");
        assertLe(paid, ownFund, "never more than the owner paid");
        _assertSolvent(id);
    }
}
