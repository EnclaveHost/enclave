// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {EnclaveDeployments, IEnclaveRegistry} from "../../EnclaveDeployments.sol";
import {EnclaveRegistry} from "../../EnclaveRegistry.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// Per-host pricing + the per-deployment rate cap (rev 8). This suite uses the
/// REAL EnclaveRegistry rather than a mock: the price a claim charges has to be
/// the one an operator actually published, and the two contracts' struct layouts
/// have to agree (a drift there would silently mis-decode prices).
///
/// The properties under test:
///   - a claim prices the deployment at the CLAIMING enclave's posted rate;
///   - a dead host's work fails over to another enclave only if that enclave's
///     price for those shares is at or under the owner's ceiling;
///   - the ceiling is editable while the app runs, and lowering it below the
///     running rate lets the paid lease finish and then stops the app;
///   - a host re-pricing itself never touches a lease already sold.
contract EnclaveDeploymentsRateCapTest is Test {
    EnclaveDeployments internal dep;
    EnclaveRegistry internal reg;
    MockUSDC internal usdc;

    address internal user = makeAddr("user");
    address internal payout = makeAddr("payout");
    address internal publisher = makeAddr("publisher");
    address internal cheapOp = makeAddr("cheapOperator");
    address internal dearOp = makeAddr("dearOperator");

    bytes32 internal cheapId;   // $3.00/hr node, $6.00/hr card — today's hosted fleet
    bytes32 internal dearId;    // twice that

    uint64 internal constant CPU_CHEAP = 834;
    uint64 internal constant GPU_CHEAP = 1667;
    uint64 internal constant CPU_DEAR = 1668;
    uint64 internal constant GPU_DEAR = 3334;

    uint256 internal constant T0 = 1_700_000_000;

    // registry schema 3: every enclave publishes the in-CVM key that signs its
    // proof-of-time checkpoints. This suite is about PRICING, so the keys only
    // need to be present and distinct (setUp pins the pre-cutover meter).
    address internal constant cheapProofKey = address(uint160(uint256(keccak256("cheap.proof"))));
    address internal constant dearProofKey  = address(uint160(uint256(keccak256("dear.proof"))));

    function setUp() public {
        usdc = new MockUSDC();
        reg = new EnclaveRegistry();
        dep = new EnclaveDeployments(address(usdc), payout, address(reg), address(0));
        // These suites pin the PRE-CUTOVER meter (held lease time, the rev-8
        // semantics they were written against). Proven-time metering — what the
        // meter does once proofRequiredFrom passes, and the whole proof protocol
        // in EnclaveProofOfTime — has its own suite in
        // EnclaveDeployments.proofOfTime.t.sol.
        dep.setProofRequiredFrom(0);
        vm.prank(cheapOp);
        cheapId = reg.register("https://cheap.example", "EnclaveHost/enclave", bytes32(0), CPU_CHEAP, GPU_CHEAP, cheapProofKey);
        vm.prank(dearOp);
        dearId = reg.register("https://dear.example", "EnclaveHost/enclave", bytes32(0), CPU_DEAR, GPU_DEAR, dearProofKey);
        usdc.mint(user, 1_000_000e6);
        vm.prank(user);
        usdc.approve(address(dep), type(uint256).max);
        vm.warp(T0);
    }

    function _rate(uint64 gpuPrice, uint64 cpuPrice, uint16 gpuMilli, uint16 cpuMilli)
        internal pure returns (uint256)
    {
        return (uint256(gpuPrice) * gpuMilli + uint256(cpuPrice) * cpuMilli + 999) / 1000;
    }

    function _create(uint16 gpuMilli, uint16 cpuMilli, uint256 cap, uint256 fund6) internal returns (bytes32 id) {
        vm.startPrank(user);
        id = dep.create("catalog://app/0", gpuMilli, cpuMilli, 8080, "", true, "", address(0), 0, cap);
        if (fund6 > 0) dep.fund(id, fund6);
        vm.stopPrank();
    }

    // ---- registry: the enclave states its price ----------------------------

    function test_registryCarriesPrices_andOnlyTheOperatorRePricesThem() public {
        assertEq(reg.registrySchema(), 3);
        IEnclaveRegistry.Enclave memory e = _entry(cheapId);
        assertEq(e.cpuPricePerSec6, CPU_CHEAP);
        assertEq(e.gpuPricePerSec6, GPU_CHEAP);
        assertEq(e.proofKey, cheapProofKey);   // schema 3: register() carries it too

        vm.prank(dearOp);
        vm.expectRevert("not operator");
        reg.setPrices(cheapId, 1, 1);

        vm.prank(cheapOp);
        reg.setPrices(cheapId, 900, 1800);
        assertEq(_entry(cheapId).cpuPricePerSec6, 900);

        vm.prank(cheapOp);
        vm.expectRevert("cpu price required");
        reg.setPrices(cheapId, 0, 1800);          // an enclave that sells compute states a price
    }

    function _entry(bytes32 id) internal view returns (IEnclaveRegistry.Enclave memory e) {
        EnclaveRegistry.Enclave memory r = reg.get(id);
        e.operator = r.operator;
        e.active = r.active;
        e.cpuPricePerSec6 = r.cpuPricePerSec6;
        e.gpuPricePerSec6 = r.gpuPricePerSec6;
        e.proofKey = r.proofKey;
    }

    // ---- the claim prices the deployment ------------------------------------

    function test_claimPricesAtTheClaimingHost_notTheOtherOne() public {
        uint256 cap = _rate(GPU_DEAR, CPU_DEAR, 500, 250);       // room for either host
        bytes32 id = _create(500, 250, cap, 100e6);
        assertEq(dep.get(id).rate, cap, "pre-claim the ceiling stands in for a price");
        assertEq(dep.rateFor(id, cheapId), _rate(GPU_CHEAP, CPU_CHEAP, 500, 250));
        assertEq(dep.rateFor(id, dearId), _rate(GPU_DEAR, CPU_DEAR, 500, 250));

        vm.prank(cheapOp);
        dep.claim(id, cheapId);
        assertEq(dep.get(id).rate, _rate(GPU_CHEAP, CPU_CHEAP, 500, 250));
        // ... and the burn used that price, not the ceiling
        EnclaveDeployments.Deployment memory d = dep.get(id);
        assertEq(d.spent6, uint256(d.leaseUntil - T0) * d.rate);
    }

    function test_hostRePricingNeverTouchesALeaseAlreadySold() public {
        bytes32 id = _create(0, 500, _rate(0, CPU_DEAR, 0, 500), 100e6);
        vm.prank(cheapOp);
        dep.claim(id, cheapId);
        uint256 sold = dep.get(id).rate;

        vm.prank(cheapOp);
        reg.setPrices(cheapId, CPU_DEAR, GPU_DEAR);   // the host doubles its price mid-lease
        assertEq(dep.get(id).rate, sold);             // the tenant's lease is unmoved

        vm.warp(T0 + 600);
        vm.prank(cheapOp);
        dep.renew(id);                                // renewals continue at the price claimed
        assertEq(dep.get(id).rate, sold);

        // only the NEXT claim buys at the new price
        vm.warp(uint256(dep.get(id).leaseUntil) + 1);
        vm.prank(cheapOp);
        dep.claim(id, cheapId);
        assertEq(dep.get(id).rate, _rate(GPU_DEAR, CPU_DEAR, 0, 500));
    }

    // ---- failover is gated by the ceiling -----------------------------------

    function test_deadHostFailsOverOnlyToEnclavesUnderTheCap() public {
        // the owner signs up for the cheap host's price and no more
        uint256 cap = _rate(GPU_CHEAP, CPU_CHEAP, 0, 400);
        bytes32 id = _create(0, 400, cap, 100e6);
        vm.prank(cheapOp);
        dep.claim(id, cheapId);
        assertEq(dep.get(id).rate, cap);

        // the host goes dark: its lease simply lapses
        vm.warp(uint256(dep.get(id).leaseUntil) + 1);
        assertTrue(dep.claimable(id));
        assertTrue(dep.claimableBy(id, cheapId));
        assertFalse(dep.claimableBy(id, dearId));

        vm.prank(dearOp);
        vm.expectRevert("over rate cap");
        dep.claim(id, dearId);                       // the pricier box may not pick it up

        vm.prank(cheapOp);                           // an equally-priced box may
        dep.claim(id, cheapId);
        assertEq(dep.get(id).runner, cheapId);

        // raise the ceiling and the dear host becomes eligible for the next round
        vm.warp(uint256(dep.get(id).leaseUntil) + 1);
        vm.prank(user);
        dep.setMaxRate(id, _rate(GPU_DEAR, CPU_DEAR, 0, 400));
        assertTrue(dep.claimableBy(id, dearId));
        vm.prank(dearOp);
        dep.claim(id, dearId);
        assertEq(dep.get(id).rate, _rate(GPU_DEAR, CPU_DEAR, 0, 400));
        assertEq(dep.get(id).runner, dearId);
    }

    function test_capIsCheckedAgainstTheSharesBought_notTheWholeMachine() public {
        // 10% of the dear node costs less than 50% of the cheap one: the cap is
        // about what THIS deployment pays, never the host's headline price
        uint256 cap = _rate(0, CPU_CHEAP, 0, 500);
        bytes32 id = _create(0, 100, cap, 100e6);
        assertLt(dep.rateFor(id, dearId), cap);
        vm.prank(dearOp);
        dep.claim(id, dearId);                       // fine: a small slice of an expensive box
        assertEq(dep.get(id).rate, _rate(0, CPU_DEAR, 0, 100));
    }

    // ---- editing the ceiling on a running app -------------------------------

    function test_loweringTheCapUnderTheRunningRate_endsAtLeaseEnd() public {
        bytes32 id = _create(0, 400, _rate(0, CPU_CHEAP, 0, 400), 100e6);
        vm.prank(cheapOp);
        dep.claim(id, cheapId);
        uint64 leaseUntil = dep.get(id).leaseUntil;
        uint256 running = dep.get(id).rate;          // read first: prank applies to the NEXT call

        vm.prank(user);
        dep.setMaxRate(id, running - 1);             // "stop paying this much"
        assertEq(dep.get(id).leaseUntil, leaseUntil, "the paid lease is never broken");
        assertEq(dep.get(id).rate, _rate(0, CPU_CHEAP, 0, 400), "nor re-priced");

        vm.warp(T0 + 600);
        vm.prank(cheapOp);
        vm.expectRevert("over rate cap");
        dep.renew(id);                               // no more time is bought

        vm.warp(uint256(leaseUntil) + 1);            // and nobody may re-claim it
        vm.prank(cheapOp);
        vm.expectRevert("over rate cap");
        dep.claim(id, cheapId);
        assertFalse(dep.claimableBy(id, cheapId));

        vm.prank(user);                              // until the owner relents
        dep.setMaxRate(id, _rate(0, CPU_CHEAP, 0, 400));
        vm.prank(cheapOp);
        dep.claim(id, cheapId);
        assertEq(dep.get(id).runner, cheapId);
    }

    function test_capMovesTheUnleasedWorkingRate_notALiveOne() public {
        bytes32 id = _create(0, 400, 10_000, 0);
        assertEq(dep.get(id).rate, 10_000);
        vm.prank(user);
        dep.setMaxRate(id, 4_000);
        assertEq(dep.get(id).rate, 4_000);           // unleased: the ceiling IS the working rate
        (uint256 runnerRate6,,) = dep.earnOf(id);
        assertEq(runnerRate6, (4_000 * 8000) / 10000);

        vm.prank(user);
        dep.fund(id, 100e6);
        vm.prank(cheapOp);
        dep.claim(id, cheapId);
        uint256 live = dep.get(id).rate;
        vm.prank(user);
        dep.setMaxRate(id, 9_000);                   // leased: the ceiling moves, the price does not
        assertEq(dep.get(id).rate, live);
        assertEq(dep.capOf(id), 9_000);
    }

    function test_capBoundsAndAuth() public {
        uint256 fee = 500;
        vm.startPrank(user);
        vm.expectRevert("maxRate <= fee");
        dep.create("catalog://app/0", 0, 100, 8080, "", true, "", publisher, fee, fee);
        vm.expectRevert("range");
        dep.create("catalog://app/0", 0, 100, 8080, "", true, "", address(0), 0, uint256(type(uint96).max) + 1);
        bytes32 id = dep.create("catalog://app/0", 0, 100, 8080, "", true, "", publisher, fee, fee + 1);
        vm.stopPrank();
        assertEq(dep.capOf(id), fee + 1);

        vm.expectRevert("!owner");
        dep.setMaxRate(id, 10_000);                  // this test contract is not the owner

        vm.prank(user);
        vm.expectRevert("maxRate <= fee");
        dep.setMaxRate(id, fee);                     // a ceiling under the publisher's cut is unpayable
    }

    function test_resizeUnderADeregisteredHostFallsBackToTheCeiling() public {
        // the serving entry going away (deregistered, or a schema-1 registry)
        // must not make a live deployment nearly free while it serves out its
        // lease: the ceiling stands in, exactly as it does when unleased
        uint256 cap = _rate(GPU_DEAR, CPU_DEAR, 0, 400);
        bytes32 id = _create(0, 400, cap, 100e6);
        vm.prank(cheapOp);
        dep.claim(id, cheapId);
        DeadRegistry dead = new DeadRegistry();
        vm.etch(address(reg), address(dead).code);     // the entry stops answering with a price
        vm.prank(user);
        dep.setShares(id, 0, 200);
        assertEq(dep.get(id).rate, cap, "priced at the ceiling, never at zero");
    }

    // ---- migration ----------------------------------------------------------

    function test_importedRecordKeepsItsEconomics() public {
        EnclaveDeployments.Deployment[] memory items = new EnclaveDeployments.Deployment[](1);
        items[0].id = keccak256("imported");
        items[0].owner = user;
        items[0].appRef = "catalog://app/0";
        items[0].cpuMilli = 400;
        items[0].appPort = 8080;
        items[0].active = true;
        items[0].rate = _rate(0, CPU_CHEAP, 0, 400);   // what it paid on the old ledger
        items[0].balance6 = 100e6;
        dep.importDeployments(items);
        bytes32 id = items[0].id;

        // its old rate became its ceiling: same price, and no re-pricing upward
        assertEq(dep.capOf(id), items[0].rate);
        assertFalse(dep.claimableBy(id, dearId));
        vm.prank(cheapOp);
        dep.claim(id, cheapId);
        assertEq(dep.get(id).rate, items[0].rate);

        // the owner may widen it during the import window (or after, themselves)
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = id;
        uint256[] memory caps = new uint256[](1);
        caps[0] = 0;                                   // 0 = grandfathered, uncapped
        dep.importCaps(ids, caps);
        assertEq(dep.capOf(id), 0);
        vm.warp(uint256(dep.get(id).leaseUntil) + 1);
        vm.prank(dearOp);
        dep.claim(id, dearId);                         // uncapped: any registered enclave, any price
        assertEq(dep.get(id).rate, _rate(0, CPU_DEAR, 0, 400));

        dep.sealImports();
        vm.expectRevert("sealed");
        dep.importCaps(ids, caps);
    }

    // ---- the ledger no longer prices anything -------------------------------

    function test_thereIsNoPlatformPriceLeft() public {
        (bool ok,) = address(dep).call(abi.encodeWithSignature("pricePerSec6()"));
        assertFalse(ok, "the global GPU list price is gone");
        (ok,) = address(dep).call(abi.encodeWithSignature("cpuPricePerSec6()"));
        assertFalse(ok, "the global CPU list price is gone");
        (ok,) = address(dep).call(abi.encodeWithSignature("setPrice(uint256)", uint256(1)));
        assertFalse(ok, "and so is the setter");
    }

    function test_unpricedEnclaveCannotClaim() public {
        // a registry entry can only exist priced (register enforces it), so the
        // guard is defence in depth — prove it holds via a stub registry
        StubRegistry stub = new StubRegistry(cheapOp);
        EnclaveDeployments d2 = new EnclaveDeployments(address(usdc), payout, address(stub), address(0));
        vm.startPrank(user);
        usdc.approve(address(d2), type(uint256).max);
        bytes32 id = d2.create("catalog://app/0", 0, 100, 8080, "", true, "", address(0), 0, 10_000);
        d2.fund(id, 100e6);
        vm.stopPrank();
        vm.prank(cheapOp);
        vm.expectRevert("enclave unpriced");
        d2.claim(id, keccak256("stub"));
    }
}

/// A registry whose entries answer with no price at all: a deregistered or
/// schema-1 entry, as seen by a rev-8 ledger.
contract DeadRegistry {
    function get(bytes32) external pure returns (IEnclaveRegistry.Enclave memory e) { e.active = false; }
}

/// An entry that forgot to state a price (only reachable through a registry
/// that predates schema 2).
contract StubRegistry {
    address public operator;
    constructor(address o) { operator = o; }
    function get(bytes32) external view returns (IEnclaveRegistry.Enclave memory e) {
        e.operator = operator;
        e.active = true;
    }
}
