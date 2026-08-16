// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {EnclaveDeployments, IEnclaveRegistry} from "../../EnclaveDeployments.sol";
import {EnclaveRegistry} from "../../EnclaveRegistry.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// FREE SELF-HOSTING (ledger rev 12 + registry schema 4): a seller running
/// their own app on their own box pays no hosting charge. The rule is one
/// comparison — the claiming enclave's DECLARED PAYOUT WALLET against the
/// deployment's owner — but it turns `rate` into a number that can legitimately
/// be zero, and almost everything else in this suite exists because of that.
///
/// Uses the REAL EnclaveRegistry, not a mock: the exemption is a fact about two
/// contracts agreeing on a struct layout and on who may write one field, and a
/// mock would let both drift.
///
/// The properties under test:
///   - the host component is waived, the PUBLISHER FEE is not;
///   - a free deployment needs no balance, burns nothing, and earns nothing;
///   - only the payout wallet itself can create the exemption (the anti-grief
///     property the pull-only setter exists for), and it can revoke it;
///   - the exemption is a property of the PAIR, so the same deployment on
///     another box, or the same box after a transfer, is priced normally;
///   - a zero rate cannot divide by zero anywhere time is bought or refunded.
contract EnclaveDeploymentsSelfHostTest is Test {
    EnclaveDeployments internal dep;
    EnclaveRegistry internal reg;
    MockUSDC internal usdc;

    address internal payout = makeAddr("platformPayout");
    address internal publisher = makeAddr("publisher");
    address internal seller = makeAddr("seller");        // owns the box AND the app
    address internal sellerOp = makeAddr("sellerOperator"); // the box's in-CVM gas key
    address internal tenant = makeAddr("tenant");        // an unrelated customer
    address internal otherOp = makeAddr("otherOperator");

    bytes32 internal sellerBox;   // the seller's own enclave
    bytes32 internal otherBox;    // somebody else's enclave

    uint64 internal constant CPU_PRICE = 834;    // whole node, USDC 6dp/sec (~$3.00/hr)
    uint64 internal constant GPU_PRICE = 1667;   // whole card, USDC 6dp/sec (~$6.00/hr)
    uint256 internal constant T0 = 1_700_000_000;
    uint64 internal constant LEASE = 1800;       // the ledger's default quantum

    address internal constant sellerKey = address(uint160(uint256(keccak256("seller.proof"))));
    address internal constant otherKey  = address(uint160(uint256(keccak256("other.proof"))));

    function setUp() public {
        usdc = new MockUSDC();
        reg = new EnclaveRegistry();
        dep = new EnclaveDeployments(address(usdc), payout, address(reg), address(0));
        dep.setProofRequiredFrom(0);             // pre-cutover meter, like the sibling suites

        vm.prank(sellerOp);
        sellerBox = reg.register("https://seller.example", "EnclaveHost/enclave", bytes32(0),
                                 CPU_PRICE, GPU_PRICE, sellerKey);
        vm.prank(otherOp);
        otherBox = reg.register("https://other.example", "EnclaveHost/enclave", bytes32(0),
                                CPU_PRICE, GPU_PRICE, otherKey);

        // The declaration that makes it free: sent BY the seller's wallet, not
        // by the operator EOA that runs the box.
        vm.prank(seller);
        reg.setPayoutWallet(sellerBox);

        usdc.mint(seller, 1_000_000e6);
        usdc.mint(tenant, 1_000_000e6);
        vm.prank(seller);
        usdc.approve(address(dep), type(uint256).max);
        vm.prank(tenant);
        usdc.approve(address(dep), type(uint256).max);
        vm.warp(T0);
    }

    function _hostRate(uint16 gpuMilli, uint16 cpuMilli) internal pure returns (uint256) {
        return (uint256(GPU_PRICE) * gpuMilli + uint256(CPU_PRICE) * cpuMilli + 999) / 1000;
    }

    function _create(address owner_, uint256 fund6, address feeTo, uint256 fee6)
        internal returns (bytes32 id)
    {
        uint256 cap = _hostRate(0, 1000) + fee6;
        vm.startPrank(owner_);
        id = dep.create("catalog://app/0", 0, 1000, 8080, "", true, "", feeTo, fee6, cap);
        if (fund6 > 0) dep.fund(id, fund6);
        vm.stopPrank();
    }

    // ---- the exemption itself ----------------------------------------------

    function test_theSellersOwnAppOnTheSellersOwnBoxIsFree() public {
        bytes32 id = _create(seller, 0, address(0), 0);
        assertEq(dep.rateFor(id, sellerBox), 0, "the host component is waived");
        assertGt(dep.rateFor(id, otherBox), 0, "and only on the box that declared them");
    }

    function test_claimNeedsNoBalanceAndBurnsNothing() public {
        bytes32 id = _create(seller, 0, address(0), 0);     // NOT funded, on purpose
        vm.prank(sellerOp);
        dep.claim(id, sellerBox);

        EnclaveDeployments.Deployment memory d = dep.get(id);
        assertEq(d.rate, 0, "priced free");
        assertEq(d.balance6, 0);
        assertEq(d.spent6, 0, "a free lease burns nothing");
        assertEq(d.leaseUntil, T0 + LEASE, "and still gets a full quantum");
        assertEq(d.runnerOperator, sellerOp);
    }

    function test_renewKeepsExtendingForFree_butOnlyOneQuantumFromNow() public {
        bytes32 id = _create(seller, 0, address(0), 0);
        vm.startPrank(sellerOp);
        dep.claim(id, sellerBox);
        vm.warp(T0 + 60);
        dep.renew(id);
        vm.stopPrank();

        EnclaveDeployments.Deployment memory d = dep.get(id);
        // A PAID renew extends from leaseUntil (that time is bought). A free one
        // extends from NOW, or nothing would bound it — see the next test.
        assertEq(d.leaseUntil, T0 + 60 + LEASE, "a free lease is always one quantum from now");
        assertEq(d.spent6, 0);
    }

    function test_aFreeRunnerCannotStackQuantaToPinTheDeployment() public {
        // The attack the anchor above exists to stop: renew() costs nothing on a
        // free lease, so if it extended from leaseUntil a runner could batch a
        // hundred of them into one multicall and hold the deployment for months
        // — outliving setActive(false), which is the owner's only lever once the
        // rate cap cannot bite. Stacking must buy exactly nothing.
        bytes32 id = _create(seller, 0, address(0), 0);
        vm.prank(sellerOp);
        dep.claim(id, sellerBox);

        bytes[] memory calls = new bytes[](50);
        for (uint256 i = 0; i < calls.length; i++)
            calls[i] = abi.encodeWithSelector(dep.renew.selector, id);
        vm.prank(sellerOp);
        dep.multicall(calls);

        assertEq(dep.get(id).leaseUntil, T0 + LEASE, "50 free renewals are worth one quantum");

        // and so the eviction lever really is bounded by leaseSec
        vm.prank(seller);
        dep.setActive(id, false);
        vm.warp(T0 + LEASE + 1);
        assertTrue(dep.get(id).leaseUntil < block.timestamp);
    }

    function test_aPaidRenewStillExtendsFromLeaseUntil() public {
        // The anchor must not change what a PAID lease does: that time is bought
        // and has to be honoured, or every prepaying tenant silently loses the
        // tail of each quantum.
        bytes32 id = _create(seller, 100e6, address(0), 0);
        vm.startPrank(otherOp);
        dep.claim(id, otherBox);
        vm.warp(T0 + 60);
        dep.renew(id);
        vm.stopPrank();
        assertEq(dep.get(id).leaseUntil, T0 + 2 * LEASE, "paid time still extends from leaseUntil");
    }

    function test_claimableByStillAnswersForAnUnknownId() public view {
        // rateFor reverts "unknown"; this view answered false before rev 12 and
        // must keep doing so, or every client that probes an id it has not
        // confirmed starts throwing.
        assertFalse(dep.claimableBy(keccak256("nope"), sellerBox));
    }

    function test_aFreeDeploymentEarnsItsRunnerNothing() public {
        bytes32 id = _create(seller, 0, address(0), 0);
        vm.startPrank(sellerOp);
        dep.claim(id, sellerBox);
        vm.warp(T0 + LEASE);
        dep.renew(id);
        vm.stopPrank();

        (uint256 runnerRate6, uint256 escrow6,) = dep.earnOf(id);
        assertEq(runnerRate6, 0, "the runner cut is a slice of a host component that is zero");
        assertEq(escrow6, 0);
        assertEq(dep.earned6(sellerOp), 0, "nobody is owed anything: nobody paid anything");
    }

    function test_claimableBySeesItWithAnEmptyBalance() public {
        bytes32 id = _create(seller, 0, address(0), 0);
        assertTrue(dep.claimableBy(id, sellerBox), "the box that hosts it free must be able to find it");
        assertFalse(dep.claimableBy(id, otherBox), "an unfunded record is still unclaimable by anyone else");
        assertFalse(dep.claimable(id), "the enclave-agnostic view stays worst-case, by construction");
    }

    // ---- what is NOT waived -------------------------------------------------

    function test_thePublisherFeeIsStillChargedAndStillPaid() public {
        uint256 fee = 100;                                  // USDC 6dp/sec
        bytes32 id = _create(seller, 3600 * fee, publisher, fee);
        assertEq(dep.rateFor(id, sellerBox), fee, "free hosting, unchanged fee");
        assertGt(usdc.balanceOf(publisher), 0, "paid pro-rata at funding, as always");

        vm.prank(sellerOp);
        dep.claim(id, sellerBox);

        EnclaveDeployments.Deployment memory d = dep.get(id);
        assertEq(d.rate, fee);
        assertEq(d.spent6, LEASE * fee, "the fee is burned like any other rate");

        // ... and once the record is priced free, the fee IS the rate, so every
        // further dollar the owner puts in is the publisher's in full.
        uint256 pub = usdc.balanceOf(publisher);
        uint256 plat = usdc.balanceOf(payout);
        vm.prank(seller);
        dep.fund(id, 1000);
        assertEq(usdc.balanceOf(publisher) - pub, 1000, "all of it");
        assertEq(usdc.balanceOf(payout), plat, "the platform takes nothing from a free deployment");
    }

    function test_aFeeBearingSelfHostStillRunsOutOfMoney() public {
        uint256 fee = 100;
        bytes32 id = _create(seller, fee - 1, publisher, fee);   // cannot buy one second
        vm.prank(sellerOp);
        vm.expectRevert("unfunded");
        dep.claim(id, sellerBox);
    }

    // ---- only the wallet can create the exemption (the anti-grief property) --

    function test_anOperatorCannotNameSomebodyElsesWallet() public {
        // The whole reason setPayoutWallet takes no argument: otherOp would
        // love to declare `tenant` and host their deployment for free, forever,
        // out of reach of the rate cap. It has no way to say so.
        bytes32 id = _create(tenant, 100e6, address(0), 0);
        vm.prank(otherOp);
        reg.setPayoutWallet(otherBox);                     // names ITSELF, the only thing it can do

        assertEq(reg.get(otherBox).payoutWallet, otherOp);
        assertGt(dep.rateFor(id, otherBox), 0, "a stranger's deployment is still charged");
    }

    function test_aFreeRateIsIndeedBeyondTheRateCap() public {
        // Documented consequence, pinned so it cannot regress silently: the
        // owner's spend ceiling cannot exclude a zero rate (0 <= any cap), which
        // is exactly why the exemption must be unforgeable at the registry.
        bytes32 id = _create(seller, 0, address(0), 0);
        vm.prank(seller);
        dep.setMaxRate(id, 1);                             // the lowest a fee-free record allows
        vm.prank(sellerOp);
        dep.claim(id, sellerBox);                          // no "over rate cap"
        assertEq(dep.get(id).leaseUntil, T0 + LEASE);
    }

    function test_theOwnerCanStillEvictAFreeRunnerWithSetActive() public {
        // The lever that replaces the rate cap in the free tier: renew() refuses
        // on an inactive record, so a lease nobody is paying for still lapses
        // within one quantum.
        bytes32 id = _create(seller, 0, address(0), 0);
        vm.prank(sellerOp);
        dep.claim(id, sellerBox);

        vm.prank(seller);
        dep.setActive(id, false);
        vm.warp(T0 + 60);
        vm.prank(sellerOp);
        vm.expectRevert("inactive");
        dep.renew(id);

        vm.warp(T0 + LEASE + 1);
        assertTrue(dep.get(id).leaseUntil < block.timestamp, "the lease lapsed on its own");
    }

    function test_clearingTheDeclarationRestoresTheCharge() public {
        bytes32 id = _create(seller, 0, address(0), 0);
        assertEq(dep.rateFor(id, sellerBox), 0);

        vm.prank(seller);                                   // the wallet revoking its own consent
        reg.clearPayoutWallet(sellerBox);
        assertEq(dep.rateFor(id, sellerBox), _hostRate(0, 1000));

        vm.prank(sellerOp);
        vm.expectRevert("unfunded");                        // and an empty record can no longer be claimed
        dep.claim(id, sellerBox);
    }

    function test_theOperatorMayAlsoClearIt_butStrangersMayNot() public {
        vm.prank(tenant);
        vm.expectRevert("not payee");
        reg.clearPayoutWallet(sellerBox);

        vm.prank(sellerOp);                                 // the box changing hands
        reg.clearPayoutWallet(sellerBox);
        assertEq(reg.get(sellerBox).payoutWallet, address(0));
    }

    function test_reRegisteringAtBootDoesNotWipeTheDeclaration() public {
        // Metal boxes re-register on every relaunch (a fresh in-CVM proof key).
        // If that cleared the wallet, free hosting would last exactly one boot.
        vm.prank(sellerOp);
        reg.register("https://seller.example", "EnclaveHost/enclave", bytes32(0),
                     CPU_PRICE, GPU_PRICE, address(uint160(uint256(keccak256("rotated")))));
        assertEq(reg.get(sellerBox).payoutWallet, seller, "survives re-registration");
        bytes32 id = _create(seller, 0, address(0), 0);
        assertEq(dep.rateFor(id, sellerBox), 0);
    }

    // ---- the exemption belongs to the PAIR ----------------------------------

    function test_failoverToAnotherBoxIsPricedNormally() public {
        uint256 rate = _hostRate(0, 1000);
        bytes32 id = _create(seller, 100e6, address(0), 0);
        vm.prank(sellerOp);
        dep.claim(id, sellerBox);
        assertEq(dep.get(id).rate, 0);

        vm.warp(T0 + LEASE + 1);                            // the seller's box dies
        vm.prank(otherOp);
        dep.claim(id, otherBox);
        assertEq(dep.get(id).rate, rate, "somebody else's hardware is somebody else's price");
        assertEq(dep.get(id).spent6, LEASE * rate);
    }

    function test_transferringTheDeploymentEndsTheExemption() public {
        bytes32 id = _create(seller, 0, address(0), 0);
        assertEq(dep.rateFor(id, sellerBox), 0);
        vm.prank(seller);
        dep.transferDeployment(id, tenant);
        assertEq(dep.rateFor(id, sellerBox), _hostRate(0, 1000),
                 "the exemption follows the owner, not the record");
    }

    // ---- a zero rate must not divide by zero --------------------------------

    function test_resizingAFreeLeaseKeepsItFreeAndDoesNotRevert() public {
        bytes32 id = _create(seller, 0, address(0), 0);
        vm.prank(sellerOp);
        dep.claim(id, sellerBox);

        vm.warp(T0 + 600);
        vm.prank(seller);
        dep.setShares(id, 0, 500);                          // shrink, mid-lease, at rate 0

        EnclaveDeployments.Deployment memory d = dep.get(id);
        assertEq(d.rate, 0, "still free after a resize");
        assertEq(d.cpuMilli, 500);
        assertEq(d.leaseUntil, T0 + LEASE, "the window it already held is kept, not re-bought");
        assertEq(d.balance6, 0);
        assertEq(d.spent6, 0);
    }

    function test_releasingAFreeLeaseRefundsNothingAndReopensTheQueue() public {
        bytes32 id = _create(seller, 0, address(0), 0);
        vm.prank(sellerOp);
        dep.claim(id, sellerBox);
        vm.warp(T0 + 600);
        vm.prank(sellerOp);
        dep.release(id);

        EnclaveDeployments.Deployment memory d = dep.get(id);
        assertEq(d.leaseUntil, 0);
        assertEq(d.runner, bytes32(0));
        assertEq(d.balance6, 0, "nothing was burned, so nothing comes back");
        assertEq(d.spent6, 0);
    }

    function test_moneyPaidBeforeTheExemptionStaysRefundable() public {
        // A record that ran PAID on another box and then went free must not
        // strand the escrow its earlier fundings left behind.
        bytes32 id = _create(seller, 100e6, address(0), 0);
        vm.prank(otherOp);
        dep.claim(id, otherBox);                            // paid lease, escrows the runner share
        vm.warp(T0 + LEASE + 1);
        vm.prank(sellerOp);
        dep.claim(id, sellerBox);                           // now free

        assertEq(dep.get(id).rate, 0);
        assertGt(dep.refundableOf(id), 0, "the unspent runner escrow is still the owner's");
        uint256 before = usdc.balanceOf(seller);
        vm.prank(seller);
        dep.refund(id);
        assertGt(usdc.balanceOf(seller), before);
    }

    function test_schemaMarksTheFreeHostingSurface() public view {
        assertEq(dep.deploymentsSchema(), 13);   // >= 12 is what free self-hosting gates on
        // schema 5 APPENDED caps+region. The ledger still reads this registry
        // through an 11-field IEnclaveRegistry.Enclave and every assertion in
        // this suite passes, which is the property that matters: appending
        // leaves the earlier fields exactly where a stale decoder expects them.
        assertEq(reg.registrySchema(), 5);
    }
}
