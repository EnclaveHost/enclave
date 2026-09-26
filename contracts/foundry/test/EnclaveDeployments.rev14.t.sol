// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {EnclaveDeployments} from "../../EnclaveDeployments.sol";
import {EnclaveRegistry} from "../../EnclaveRegistry.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract Rev14Feed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, 3000e8, block.timestamp, block.timestamp, 1);   // $3000/ETH
    }
}

/// Rev 14 (docs/ledger-rev14-escrow-split.md): the two money rules it changes.
///   1. A funding on a record with NO LIVE LEASE splits at the CAP and escrows
///      the UNFLOORED runner fraction of it, not the last lease's snapshot. Before, a
///      funding made after a free lease, or after one so cheap its runner
///      share rounded to 0, escrowed nothing: the next paid runner served
///      unbacked and none of it was refundable (0xca141665 on the live ledger,
///      and Steven's four records). A LIVE lease, free ones included, keeps
///      splitting at the rate it burns the balance at.
///   2. A lapsed lease may be proven for LATE_PROOF_SEC (900 s) after it ends.
///      Past that, what it never proved stops being reserved, so a refund
///      reaches it; before, a lapse alone never freed the reserve.
contract EnclaveDeploymentsRev14Test is Test {
    EnclaveDeployments internal dep;
    EnclaveRegistry internal reg;
    MockUSDC internal usdc;

    address internal payout = makeAddr("platformPayout");
    address internal publisher = makeAddr("publisher");
    address internal seller = makeAddr("seller");          // owns a box AND a deployment: its own box is free
    address internal sellerOp = makeAddr("sellerOperator");
    address internal tenant = makeAddr("tenant");
    address internal otherOp = makeAddr("otherOperator");  // a paid box at the list price
    address internal cheapOp = makeAddr("cheapOperator");  // a box priced so low its runner share rounds to 0
    address internal midOp = makeAddr("midOperator");      // a box whose rate for 2% of a node is 9 (the cap is 17)

    bytes32 internal sellerBox;
    bytes32 internal otherBox;
    bytes32 internal cheapBox;
    bytes32 internal midBox;

    uint64 internal constant CPU_PRICE = 834;    // whole node, µUSDC/s
    uint64 internal constant GPU_PRICE = 1667;
    uint256 internal constant T0 = 1_700_000_000;
    uint256 internal constant LEASE = 1800;
    uint256 internal constant LATE = 900;        // EnclaveDeployments.LATE_PROOF_SEC

    function setUp() public {
        usdc = new MockUSDC();
        reg = new EnclaveRegistry();
        dep = new EnclaveDeployments(address(usdc), payout, address(reg), address(0));
        dep.setProofRequiredFrom(0);             // held-time meter; the horizon tests turn proofs on

        vm.prank(sellerOp);
        sellerBox = reg.register("https://seller.example", "EnclaveHost/enclave", bytes32(0), CPU_PRICE, GPU_PRICE,
                                 address(uint160(uint256(keccak256("seller.proof")))));
        vm.prank(otherOp);
        otherBox = reg.register("https://other.example", "EnclaveHost/enclave", bytes32(0), CPU_PRICE, GPU_PRICE,
                                address(uint160(uint256(keccak256("other.proof")))));
        vm.prank(cheapOp);
        cheapBox = reg.register("https://cheap.example", "EnclaveHost/enclave", bytes32(0), 1, 1,
                                address(uint160(uint256(keccak256("cheap.proof")))));
        vm.prank(midOp);
        midBox = reg.register("https://mid.example", "EnclaveHost/enclave", bytes32(0), 401, 401,
                              address(uint160(uint256(keccak256("mid.proof")))));
        vm.prank(seller);
        reg.setPayoutWallet(sellerBox);          // the seller's own box hosts the seller's deployments free

        for (uint256 i = 0; i < 2; i++) {
            address a = i == 0 ? seller : tenant;
            usdc.mint(a, 1_000_000e6);
            vm.prank(a);
            usdc.approve(address(dep), type(uint256).max);
        }
        vm.warp(T0);
    }

    // ---- helpers ----------------------------------------------------------------------------------------------------

    function _hostRate(uint16 cpuMilli, uint64 price) internal pure returns (uint256) {
        return (uint256(price) * cpuMilli + 999) / 1000;
    }

    function _create(address owner_, uint16 cpuMilli, address feeTo, uint256 fee6) internal returns (bytes32 id) {
        vm.prank(owner_);
        id = dep.create("catalog://app/0", 0, cpuMilli, 8080, "", true, "", feeTo, fee6, _hostRate(cpuMilli, CPU_PRICE) + fee6);
    }

    function _fund(address from, bytes32 id, uint256 value) internal {
        vm.prank(from);
        dep.fund(id, value);
    }

    function _claim(address op, bytes32 id, bytes32 box) internal {
        vm.prank(op);
        dep.claim(id, box);
    }

    function _escrow(bytes32 id) internal view returns (uint256 e) {
        (, e,) = dep.earnOf(id);
    }

    function _rate6(bytes32 id) internal view returns (uint256 r) {
        (r,,) = dep.earnOf(id);
    }

    /// what rev 14 escrows for `value` at cap `cap` with fee `fee`: the UNFLOORED runner fraction of the cap, ceil
    function _escAtCap(uint256 value, uint256 cap, uint256 fee) internal view returns (uint256) {
        return (value * (cap - fee) * dep.runnerBps() + cap * 10000 - 1) / (cap * 10000);
    }

    function _assertSolvent() internal view {
        uint256 owed = dep.earned6(otherOp) + dep.earned6(cheapOp) + dep.earned6(sellerOp);
        assertGe(usdc.balanceOf(address(dep)), owed, "the contract holds at least what runners are owed");
    }

    // ---- 1. a funding with no live lease splits at the cap -----------------------------------------------------------

    /// 0xca141665's sequence: a free lease on the owner's own box, released; then the owner funds; then a PAID box
    /// claims. Rev 13 escrowed 0 here (the free lease's rate6 0 stood), so the paid runner was credited nothing and
    /// refundableOf was 0 with a positive balance.
    function test_fundAfterAReleasedFreeLease_escrowsAtTheCap_paysTheNextRunner_andRefundsTheRest() public {
        bytes32 id = _create(seller, 1000, address(0), 0);
        uint256 cap = _hostRate(1000, CPU_PRICE);                 // 834

        _claim(sellerOp, id, sellerBox);                          // free: payoutWallet == owner
        assertEq(dep.get(id).rate, 0);
        assertEq(_rate6(id), 0, "the free lease's runner share");
        vm.warp(T0 + 600);
        vm.prank(sellerOp);
        dep.release(id);
        assertEq(_rate6(id), 0, "release leaves the free snapshot standing (unchanged in rev 14)");

        uint256 payoutBefore = usdc.balanceOf(payout);
        _fund(seller, id, 100e6);
        uint256 esc = _escAtCap(100e6, cap, 0);
        assertEq(esc, 80e6, "80% of a fee-free funding, unfloored");
        assertEq(_escrow(id), esc, "escrowed at the cap's runner share, not the free lease's 0");
        assertEq(dep.ownerEscrow6(id), esc, "the owner's own money: refundable");
        assertEq(usdc.balanceOf(payout) - payoutBefore, 100e6 - esc, "the platform remainder, and no more");
        assertEq(_rate6(id), 0, "the split does not re-price the record");

        _claim(otherOp, id, otherBox);                            // paid, at the list price
        uint256 r6 = _rate6(id);
        assertEq(r6, (cap * dep.runnerBps()) / 10000);
        vm.warp(T0 + 600 + 900);
        dep.settle(id);
        assertEq(dep.earned6(otherOp), 900 * r6, "the paid runner is credited from the escrow the funding made");

        vm.prank(otherOp);
        dep.release(id);                                          // the unused tail goes back to the balance
        uint256 quote = dep.refundableOf(id);
        assertEq(quote, esc - 900 * r6, "what the runner did not earn is the owner's");
        uint256 before = usdc.balanceOf(seller);
        vm.prank(seller);
        dep.refund(id);
        assertEq(usdc.balanceOf(seller) - before, quote, "refundableOf is exact");
        _assertSolvent();
    }

    /// Steven's records: a lease so cheap its runner share rounds to 0 (rate 1 -> floor(0.8) = 0) LAPSED, never
    /// released; then a top-up; then a paid box claims at rate 9. Rev 13 escrowed 0 for the top-up.
    function test_fundAfterALapsedNearFreeLease_escrowsAtTheCap() public {
        bytes32 id = _create(tenant, 10, address(0), 0);          // 1% of a node: cap 9, like Steven's four
        uint256 cap = _hostRate(10, CPU_PRICE);
        assertEq(cap, 9);
        _fund(tenant, id, 1e6);                                   // never claimed: d.rate is the cap either way
        uint256 first = _escrow(id);
        assertEq(first, _escAtCap(1e6, 9, 0));
        assertEq(first, 800000, "rev 13 escrowed 777778 here (the floored 7/9, as Steven's d9798e4c/a77d0c57 did in August)");

        _claim(cheapOp, id, cheapBox);
        assertEq(dep.get(id).rate, 1);
        assertEq(_rate6(id), 0, "rate 1: the runner share rounds to 0");
        uint256 leaseUntil = dep.get(id).leaseUntil;
        vm.warp(leaseUntil + 2000);                               // lapsed, not released: nucbox-k11's leases on 09-25

        _fund(tenant, id, 250000);
        assertEq(_escrow(id) - first, _escAtCap(250000, 9, 0), "the top-up escrows at the cap: 200000, not 0");
        assertEq(_escAtCap(250000, 9, 0), 200000);

        _claim(otherOp, id, otherBox);                            // settles cheapOp's tail at ITS rate6 (0) first
        assertEq(dep.earned6(cheapOp), 0);
        assertEq(_rate6(id), 7);
        vm.warp(block.timestamp + 600);
        dep.settle(id);
        assertEq(dep.earned6(otherOp), 600 * 7, "backed");
        _assertSolvent();
    }

    /// A never-claimed record: d.rate IS the cap, and it too escrows the UNFLOORED share now (a few µUSDC more than
    /// rev 13's floored runnerRate6), since any runner at or under the cap may claim it. The publisher's cut is as before.
    function test_fundNeverClaimed_escrowsTheUnflooredCapShare() public {
        bytes32 id = _create(tenant, 1000, publisher, 100);
        uint256 cap = _hostRate(1000, CPU_PRICE) + 100;
        assertEq(dep.get(id).rate, cap);
        _fund(tenant, id, 50e6);
        assertEq(_escrow(id), _escAtCap(50e6, cap, 100));
        assertGe(_escrow(id), (50e6 * _rate6(id) + cap - 1) / cap, "never less than rev 13's floored escrow");
        assertEq(usdc.balanceOf(publisher), (50e6 * 100) / cap);
    }

    /// enclave-bf's R1: the FLOORED share of the cap can sit below a cheaper runner's. Cap 17 (7ae476a3's) is
    /// floor(13.6) = 13 per second, 13/17 = 0.765; a runner at rate 9 is 7/9 = 0.778 of each second. The unfloored cap
    /// fraction (0.8) covers every second that runner can sell.
    function test_unflooredCapShare_coversACheaperRunner() public {
        bytes32 id = _create(tenant, 20, address(0), 0);
        assertEq(dep.capOf(id), 17);
        _fund(tenant, id, 500000);
        uint256 esc = _escrow(id);
        assertEq(esc, 400000);
        uint256 flooredAtCap = (500000 * uint256(13) + 16) / 17;             // what a floored cap share would escrow
        _claim(midOp, id, midBox);
        assertEq(dep.get(id).rate, 9);
        assertEq(_rate6(id), 7);
        uint256 owed = (uint256(500000) / 9) * 7;                                     // every second the balance buys at rate 9
        assertGe(esc, owed, "the unfloored cap share covers the cheaper runner");
        assertLt(flooredAtCap, owed, "the floored cap share would not (enclave-bf R1)");
    }

    /// enclave-bf's S3: the boundary second. At block.timestamp == leaseUntil a runner may still renew, but the record
    /// counts as having no live lease (as setMaxRate and the resize path already treat it), so a funding then splits at
    /// the cap; one second earlier it splits at the live lease's rate.
    function test_boundary_atLeaseUntilTheRecordIsUnleased() public {
        bytes32 id = _create(tenant, 10, address(0), 0);
        _fund(tenant, id, 1e6);
        _claim(cheapOp, id, cheapBox);                                       // rate 1, runner share 0
        uint256 leaseUntil = dep.get(id).leaseUntil;
        vm.warp(leaseUntil - 1);
        uint256 e0 = _escrow(id);
        _fund(tenant, id, 250000);
        assertEq(_escrow(id), e0, "one second before the end: the live lease's split (share 0)");
        vm.warp(leaseUntil);
        _fund(tenant, id, 250000);
        assertEq(_escrow(id) - e0, _escAtCap(250000, 9, 0), "at leaseUntil: the cap's");
    }

    /// enclave-bf's S5: fundEth's publisher cut follows the same rule. After a fee-only free lease is released, d.rate
    /// is the fee alone; rev 13 then sent 100% of an ETH funding to the publisher. Rev 14 cuts it at the cap.
    function test_fundEthOnAnUnleasedRecord_cutsThePublisherAtTheCap() public {
        dep.setEthUsdFeed(address(new Rev14Feed()));
        bytes32 id = _create(seller, 1000, publisher, 100);
        uint256 cap = _hostRate(1000, CPU_PRICE) + 100;
        _fund(seller, id, 1e6);
        _claim(sellerOp, id, sellerBox);
        assertEq(dep.get(id).rate, 100, "free: the fee alone");
        vm.warp(T0 + 600);
        vm.prank(sellerOp);
        dep.release(id);
        vm.deal(tenant, 1 ether);
        uint256 before = publisher.balance;
        vm.prank(tenant);
        dep.fundEth{value: 1 ether}(id);
        assertEq(publisher.balance - before, (1 ether * 100) / cap, "fee / cap of the ETH, not 100%");
    }

    // ---- 1b. a LIVE lease keeps today's split -----------------------------------------------------------------------

    /// A live FREE lease of a paid app burns the balance at the publisher fee alone, so the publisher's pro-rata cut
    /// of a funding is 100% of it, as rev 12 intends. Splitting at the cap instead would underpay the publisher for
    /// every second the free lease then burns.
    function test_fundDuringALiveFreeLease_keepsTodaysSplit() public {
        bytes32 id = _create(seller, 1000, publisher, 100);
        _fund(seller, id, 1e6);                                   // the fee-only free lease still needs a balance
        uint256 escBefore = _escrow(id);
        _claim(sellerOp, id, sellerBox);
        assertEq(dep.get(id).rate, 100, "free: the fee alone");
        uint256 pubBefore = usdc.balanceOf(publisher);
        _fund(seller, id, 10e6);
        assertEq(usdc.balanceOf(publisher) - pubBefore, 10e6, "100% to the publisher, as today");
        assertEq(_escrow(id), escBefore, "nothing escrowed during the live free lease");
    }

    /// enclave-bf's required test: the LIVE-lease path, which rev 14 rewrote as ceil(value x (rate6 x 10000) / (rate x
    /// 10000)), must still escrow exactly rev 13's ceil(value x rate6 / rate) for a top-up during a paid lease, the most
    /// common funding in production. Exact escrow, ownerEscrow6, the publisher's cut and payout's share, with a fee.
    function test_topUpDuringALivePaidLease_escrowsExactlyTheLeasesShare() public {
        bytes32 id = _create(tenant, 1000, publisher, 100);
        _fund(tenant, id, 10e6);
        _claim(otherOp, id, otherBox);                            // paid, at the list price plus the fee
        uint256 rate = dep.get(id).rate;
        uint256 r6 = _rate6(id);
        assertEq(rate, _hostRate(1000, CPU_PRICE) + 100);
        assertEq(r6, ((rate - 100) * dep.runnerBps()) / 10000);
        uint256 esc0 = _escrow(id);
        uint256 own0 = dep.ownerEscrow6(id);
        uint256 pub0 = usdc.balanceOf(publisher);
        uint256 pay0 = usdc.balanceOf(payout);
        uint256 v = 1e6;
        _fund(tenant, id, v);
        uint256 esc = (v * r6 + rate - 1) / rate;                // rev 13's rule, unchanged for a live lease
        uint256 cut = (v * 100) / rate;
        assertEq(_escrow(id) - esc0, esc, "exactly the lease's share");
        assertEq(dep.ownerEscrow6(id) - own0, esc, "the owner's own money: refundable");
        assertEq(usdc.balanceOf(publisher) - pub0, cut, "the publisher's cut at the lease's rate");
        assertEq(usdc.balanceOf(payout) - pay0, v - cut - esc, "the platform remainder");
        // and the fee-free figure bf quotes: 1e6 at rate 834, rate6 667 escrows 799761
        assertEq((uint256(1e6) * 667 + 833) / 834, 799761);
    }

    /// The residual rev 14 does NOT close, stated as a test: a funding during a LIVE near-free lease splits at that
    /// lease's rate (runner share 0), and a later paid runner serves those seconds unbacked, as before.
    function test_fundDuringALiveNearFreeLease_isTheResidual() public {
        bytes32 id = _create(tenant, 10, address(0), 0);
        _fund(tenant, id, 1e6);
        _claim(cheapOp, id, cheapBox);
        uint256 escBefore = _escrow(id);
        _fund(tenant, id, 250000);                                // the lease is LIVE
        assertEq(_escrow(id), escBefore, "split at the live rate 1: runner share 0, as in rev 13");
    }

    /// enclave-bf's R2, stated as a test: escrow a cap split makes that a cheaper runner never earns stays refundable
    /// AFTER the balance is spent. Cap 9, 250000 funded with no live lease (200000 escrowed, 50000 to the platform),
    /// then served to the end by a rate-1 box whose runner share is 0: the owner can still refund the 200000.
    function test_residual_overEscrowIsRefundableAfterFullConsumption() public {
        bytes32 id = _create(tenant, 10, address(0), 0);
        uint256 payout0 = usdc.balanceOf(payout);
        _fund(tenant, id, 250000);
        assertEq(_escrow(id), 200000);
        assertEq(usdc.balanceOf(payout) - payout0, 50000);
        _claim(cheapOp, id, cheapBox);
        vm.startPrank(cheapOp);
        while (dep.get(id).balance6 >= dep.get(id).rate) dep.renew(id);   // every second the balance buys, at rate 1
        vm.stopPrank();
        assertEq(dep.get(id).balance6, 0);
        vm.warp(dep.get(id).leaseUntil + 1);
        assertEq(dep.get(id).spent6, 250000, "250000 s served");
        uint256 before = usdc.balanceOf(tenant);
        vm.prank(tenant);
        dep.refund(id);
        assertEq(usdc.balanceOf(tenant) - before, 200000, "and 200000 refunded after it was all served");
    }

    // ---- 2. the late-proof horizon ----------------------------------------------------------------------------------

    function _proofMode() internal {
        dep.setProofRequiredFrom(uint64(T0));
        dep.setProver(address(this));                             // this test is the prover
    }

    /// Under proof rules a lapsed lease's unproven tail is reserved while a late proof may still land, i.e. up to and
    /// including leaseUntil + LATE_PROOF_SEC, and a late proof in that window is credited.
    function test_lapsedTail_isReservedAndProvableInsideTheHorizon() public {
        _proofMode();
        bytes32 id = _create(tenant, 1000, address(0), 0);
        _fund(tenant, id, 100e6);
        _claim(otherOp, id, otherBox);
        uint256 r6 = _rate6(id);
        uint64 leaseUntil = dep.get(id).leaseUntil;
        vm.warp(T0 + 1200);
        dep.creditProven(id, uint64(T0 + 1200));
        assertEq(dep.earned6(otherOp), 1200 * r6);

        vm.warp(uint256(leaseUntil) + LATE);                      // the last second of the horizon
        uint256 esc = _escrow(id);
        assertEq(dep.refundableOf(id), esc - 600 * r6, "the unproven 600 s are still the seller's to prove");
        dep.creditProven(id, leaseUntil);                         // a late proof, on time
        assertEq(dep.provenUntil(id), leaseUntil);
        assertEq(dep.earned6(otherOp), 1800 * r6, "credited");
        assertEq(dep.refundableOf(id), _escrow(id), "nothing left to reserve");
        _assertSolvent();
    }

    /// Past the horizon the unproven tail is no longer provable, and no longer reserved: a refund reaches it.
    /// Rev 13: reserved for ever (the NatSpec said a lapse freed it; the code did not).
    function test_lapsedTail_isFreedAfterTheHorizon_andRefundPaysIt() public {
        _proofMode();
        bytes32 id = _create(tenant, 1000, address(0), 0);
        _fund(tenant, id, 100e6);
        _claim(otherOp, id, otherBox);
        uint256 r6 = _rate6(id);
        uint64 leaseUntil = dep.get(id).leaseUntil;
        vm.warp(T0 + 1200);
        dep.creditProven(id, uint64(T0 + 1200));

        vm.warp(uint256(leaseUntil) + LATE + 1);
        vm.expectRevert("nothing to prove");
        dep.creditProven(id, leaseUntil);
        assertEq(dep.provenUntil(id), T0 + 1200);

        uint256 esc = _escrow(id);
        uint256 quote = dep.refundableOf(id);
        assertEq(quote, esc, "the unproven 600 s are no longer held");
        assertEq(quote, dep.ownerEscrow6(id) - 1200 * r6, "all the owner's escrow the runner did not earn");
        uint256 before = usdc.balanceOf(tenant);
        vm.prank(tenant);
        dep.refund(id);
        assertEq(usdc.balanceOf(tenant) - before, quote, "refundableOf is exact");
        assertEq(dep.earned6(otherOp), 1200 * r6, "the runner keeps exactly what it proved");
        _assertSolvent();
    }

    /// After the horizon a settle moves nothing a refund could see: the quote is the same before and after it
    /// (creditProven credits at once, so no proven stretch is left unsettled to reserve).
    function test_afterTheHorizon_settleLeavesTheQuoteUnchanged() public {
        _proofMode();
        bytes32 id = _create(tenant, 1000, address(0), 0);
        _fund(tenant, id, 100e6);
        _claim(otherOp, id, otherBox);
        uint64 leaseUntil = dep.get(id).leaseUntil;
        vm.warp(T0 + 1200);
        dep.creditProven(id, uint64(T0 + 1200));                  // credits through T0+1200 at once
        vm.warp(uint256(leaseUntil) + LATE + 1);
        assertEq(dep.refundableOf(id), _escrow(id));
        // the invariant refundableOf's exactness rests on: a settle changes nothing it quotes
        uint256 q = dep.refundableOf(id);
        dep.settle(id);
        assertEq(dep.refundableOf(id), q);
    }

    /// Under the held-time meter (no proofs required) the horizon changes nothing: a lapsed tail is still the
    /// runner's (settle pays it), so it stays reserved, and refund() credits it before paying.
    function test_heldTimeMeter_lapsedTailStillCreditedAndReserved() public {
        bytes32 id = _create(tenant, 1000, address(0), 0);
        _fund(tenant, id, 100e6);
        _claim(otherOp, id, otherBox);
        uint256 r6 = _rate6(id);
        uint64 leaseUntil = dep.get(id).leaseUntil;
        vm.warp(uint256(leaseUntil) + LATE + 5000);
        uint256 quote = dep.refundableOf(id);
        assertEq(quote, _escrow(id) - 1800 * r6, "the whole held lease is the runner's");
        uint256 before = usdc.balanceOf(tenant);
        vm.prank(tenant);
        dep.refund(id);
        assertEq(usdc.balanceOf(tenant) - before, quote, "refundableOf is exact");
        assertEq(dep.earned6(otherOp), 1800 * r6);
        _assertSolvent();
    }

    /// enclave-bf's S1, stated as a test (a residual, not fixed: the fix costs 106 bytes the ledger does not have). Proofs
    /// on, the horizon passes, the owner refunds the unproven tail. If the platform then turns proofs OFF
    /// (setProofRequiredFrom(0), the kill switch), the held-time meter credits that tail again, paid from the owner's
    /// NEXT funding's escrow: 600 s x 667 = 400200. Rev 13 paid it from its own (never released) reserve.
    function test_residual_killSwitchAfterAHorizonRefundPaysTheTailFromTheNextFunding() public {
        _proofMode();
        bytes32 id = _create(tenant, 1000, address(0), 0);
        _fund(tenant, id, 100e6);
        _claim(otherOp, id, otherBox);
        uint256 r6 = _rate6(id);
        uint64 leaseUntil = dep.get(id).leaseUntil;
        vm.warp(T0 + 1200);
        dep.creditProven(id, uint64(T0 + 1200));
        vm.warp(uint256(leaseUntil) + LATE + 1);
        vm.prank(tenant);
        dep.refund(id);                                           // takes the released tail's escrow too
        assertEq(_escrow(id), 0);
        dep.setProofRequiredFrom(0);                              // the kill switch
        vm.startPrank(tenant);
        dep.setActive(id, true);
        dep.fund(id, 10e6);
        vm.stopPrank();
        uint256 earned0 = dep.earned6(otherOp);
        dep.settle(id);
        assertEq(dep.earned6(otherOp) - earned0, 600 * r6, "the refunded tail is credited from the new funding");
        assertEq(600 * r6, 400200);
    }
}
