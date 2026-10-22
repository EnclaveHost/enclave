// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {EnclaveDeployments, IEnclaveDeploymentsLeases, EnclaveLeaseGeneration} from "../../EnclaveDeployments.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {LeaseRegistry} from "./LeaseRig.sol";

/// Rev 17 lease generations on the deployed candidate (linked libraries, EIP-170 enforced by the EVM):
///   - every claim opens a new generation per id; renew keeps it; release leaves it; imports start at 0;
///   - releaseLease ends only the lease it names; wrong runner / generation / caller refuse;
///   - a same-block release + re-claim at an identical leaseUntil cannot be ended by the stale release;
///   - an operator's guardedReleaseOnly refuses its own unnamed release(id) and nobody else's;
///   - the fallback reaches only the extension's five entry points; value, unknown selectors and direct library calls fail.
contract EnclaveDeploymentsLeaseGenerationTest is Test {
    EnclaveDeployments internal dep;
    IEnclaveDeploymentsLeases internal leases;
    MockUSDC internal usdc;
    LeaseRegistry internal reg;

    address internal user = makeAddr("user");
    address internal payout = makeAddr("payout");
    address internal opA = makeAddr("operatorA");          // runs two hosts on ONE key (the same-operator move)
    address internal opB = makeAddr("operatorB");
    bytes32 internal constant HOST_A1 = keccak256("host-a1");
    bytes32 internal constant HOST_A2 = keccak256("host-a2");
    bytes32 internal constant HOST_B = keccak256("host-b");
    uint256 internal constant RATE = 834;
    uint256 internal constant T0 = 1_700_000_000;

    event LeaseOpened(bytes32 indexed id, bytes32 indexed enclaveId, uint64 generation);
    event Released(bytes32 indexed id, bytes32 indexed enclaveId, uint256 refunded6);
    event GuardedReleaseOnlySet(address indexed operator, bool on);

    function setUp() public {
        usdc = new MockUSDC();
        reg = new LeaseRegistry();
        reg.set(HOST_A1, opA, 834, 1667);
        reg.set(HOST_A2, opA, 834, 1667);
        reg.set(HOST_B, opB, 834, 1667);
        dep = new EnclaveDeployments(address(usdc), payout, address(reg), address(0));
        leases = IEnclaveDeploymentsLeases(address(dep));
        dep.setProofRequiredFrom(0);
        usdc.mint(user, 1_000_000e6);
        vm.prank(user); usdc.approve(address(dep), type(uint256).max);
        vm.warp(T0);
    }

    function _create(uint256 fund6) internal returns (bytes32 id) {
        vm.startPrank(user);
        id = dep.create("catalog://app/0", 0, 1000, 8080, "", true, "", address(0), 0, RATE);
        if (fund6 > 0) dep.fund(id, fund6);
        vm.stopPrank();
    }
    function _claim(bytes32 id, address op, bytes32 host) internal { vm.prank(op); dep.claim(id, host); }
    function _gen(bytes32 id) internal view returns (uint64 g) { (,,, g) = leases.leaseOf(id); }

    // NOTE: `forge test` does not enforce EIP-170 (a 24,577-byte runtime deploys in this EVM - measured), so the size is
    // ASSERTED here and the deployment under the real limit is proven on anvil (scripts/anvil-smoke.mjs).
    function test_deployedUnderEip170_withEveryEntryPoint() public view {
        assertLe(address(dep).code.length, 24576);
        assertEq(dep.deploymentsSchema(), 17);
    }

    function test_generationIsMonotonicPerId_renewKeepsIt_releaseLeavesIt() public {
        bytes32 a = _create(100e6);
        bytes32 b = _create(100e6);
        assertEq(_gen(a), 0);
        vm.expectEmit(true, true, false, true, address(dep));
        emit LeaseOpened(a, HOST_A1, 1);
        _claim(a, opA, HOST_A1);
        assertEq(_gen(a), 1);
        assertEq(_gen(b), 0, "per id");

        vm.warp(T0 + 600);
        vm.recordLogs();
        vm.prank(opA); dep.renew(a);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) assertTrue(logs[i].topics[0] != LeaseOpened.selector, "renew opens nothing");
        assertEq(_gen(a), 1, "renew continues the same lease");

        vm.prank(opA); leases.releaseLease(a, HOST_A1, 1);
        assertEq(_gen(a), 1, "release leaves the generation");
        (bytes32 runner, address op, uint64 until,) = leases.leaseOf(a);
        assertEq(runner, bytes32(0)); assertEq(op, address(0)); assertEq(until, 0);

        _claim(a, opB, HOST_B);
        assertEq(_gen(a), 2);
        vm.warp(block.timestamp + 1801);                       // lapse without a release
        _claim(a, opA, HOST_A2);
        assertEq(_gen(a), 3, "a lapsed lease's successor is a new generation");
        _claim(b, opB, HOST_B);
        assertEq(_gen(b), 1);
    }

    function test_leaseOfMatchesGet() public {
        bytes32 id = _create(100e6);
        _claim(id, opA, HOST_A1);
        (bytes32 runner, address op, uint64 until, uint64 g) = leases.leaseOf(id);
        EnclaveDeployments.Deployment memory d = dep.get(id);
        assertEq(runner, d.runner); assertEq(op, d.runnerOperator); assertEq(until, d.leaseUntil); assertEq(g, 1);
    }

    function test_releaseLeaseRefusesWrongRunnerGenerationCallerOrId() public {
        bytes32 id = _create(100e6);
        _claim(id, opA, HOST_A1);
        vm.startPrank(opA);
        vm.expectRevert(bytes("not this lease")); leases.releaseLease(id, HOST_A2, 1);   // same operator, other host
        vm.expectRevert(bytes("not this lease")); leases.releaseLease(id, HOST_A1, 2);
        vm.expectRevert(bytes("not this lease")); leases.releaseLease(id, HOST_A1, 0);
        vm.expectRevert(bytes("unknown")); leases.releaseLease(keccak256("nope"), HOST_A1, 1);
        vm.stopPrank();
        vm.prank(opB);
        vm.expectRevert(bytes("not runner")); leases.releaseLease(id, HOST_A1, 1);
        assertEq(dep.get(id).runnerOperator, opA, "nothing ended");
        vm.prank(opA); leases.releaseLease(id, HOST_A1, 1);
        assertEq(dep.get(id).runner, bytes32(0));
    }

    /// The collision (runner, leaseUntil) cannot tell apart: release + re-claim in ONE block at the SAME timestamp gives
    /// lease #2 the same runner, operator and leaseUntil as #1. The generation does.
    function test_sameBlockReclaimWithIdenticalLeaseUntil_staleReleaseCannotEndIt() public {
        bytes32 id = _create(100e6);
        _claim(id, opA, HOST_A1);
        uint64 until1 = dep.get(id).leaseUntil;
        vm.prank(opA); leases.releaseLease(id, HOST_A1, 1);
        _claim(id, opA, HOST_A1);                              // same block, same timestamp, same quantum
        EnclaveDeployments.Deployment memory d = dep.get(id);
        assertEq(d.leaseUntil, until1, "identical leaseUntil");
        assertEq(d.runner, HOST_A1); assertEq(d.runnerOperator, opA);
        assertEq(_gen(id), 2);

        vm.prank(opA);
        vm.expectRevert(bytes("not this lease")); leases.releaseLease(id, HOST_A1, 1);  // the stale, duplicated release
        assertEq(dep.get(id).leaseUntil, until1, "lease #2 survives");
        vm.prank(opA); leases.releaseLease(id, HOST_A1, 2);
        assertEq(dep.get(id).runner, bytes32(0));
    }

    /// A duplicate of a release that already landed, or a delayed one meant for a lease that lapsed and was re-claimed
    /// by the SAME key on another host (the same-operator move), ends nothing.
    function test_duplicateAndDelayedReleasesEndNothing() public {
        bytes32 id = _create(100e6);
        _claim(id, opA, HOST_A1);
        vm.prank(opA); leases.releaseLease(id, HOST_A1, 1);
        vm.prank(opA);
        vm.expectRevert(bytes("not runner")); leases.releaseLease(id, HOST_A1, 1);       // duplicate, nothing held

        _claim(id, opA, HOST_A1);                              // gen 2 on host A1
        vm.warp(block.timestamp + 1801);                        // A1 dies; the lease lapses
        _claim(id, opA, HOST_A2);                              // gen 3: the move target, same key
        vm.prank(opA);
        vm.expectRevert(bytes("not this lease")); leases.releaseLease(id, HOST_A1, 2);   // A1's queued release, late
        assertEq(dep.get(id).runner, HOST_A2, "the move target keeps its lease");
    }

    /// The hazard the opt-in closes: WITHOUT it, the legacy unnamed release(id) from the same key ends the new lease
    /// (rev-16d behaviour, kept). WITH it, that release reverts and only the named form works - for this key alone.
    function test_guardedReleaseOnly_refusesTheLegacyFormForItsOwnKeyOnly() public {
        bytes32 id = _create(100e6);
        bytes32 other = _create(100e6);
        _claim(id, opA, HOST_A2);
        _claim(other, opB, HOST_B);
        assertFalse(leases.guardedReleaseOnly(opA));
        vm.prank(opA); dep.release(id);                         // legacy, unguarded: ends whatever opA holds
        assertEq(dep.get(id).runner, bytes32(0));

        _claim(id, opA, HOST_A2);
        vm.expectEmit(true, false, false, true, address(dep));
        emit GuardedReleaseOnlySet(opA, true);
        vm.prank(opA); leases.setGuardedReleaseOnly(true);
        assertTrue(leases.guardedReleaseOnly(opA));
        vm.prank(opA);
        vm.expectRevert(bytes("guarded release only")); dep.release(id);
        vm.prank(opA);                                          // the multicall path is the same entry point
        bytes[] memory calls = new bytes[](1); calls[0] = abi.encodeWithSignature("release(bytes32)", id);
        vm.expectRevert(bytes("guarded release only")); dep.multicall(calls);
        assertEq(dep.get(id).runner, HOST_A2);
        vm.prank(opB); dep.release(other);                      // another key is unaffected
        assertEq(dep.get(other).runner, bytes32(0));

        calls[0] = abi.encodeWithSignature("releaseLease(bytes32,bytes32,uint64)", id, HOST_A2, uint64(2));
        vm.prank(opA); dep.multicall(calls);                    // named release through multicall (msg.sender kept)
        assertEq(dep.get(id).runner, bytes32(0));

        vm.prank(opA); leases.setGuardedReleaseOnly(false);
        _claim(id, opA, HOST_A2);
        vm.prank(opA); dep.release(id);                         // reversible by the operator itself
        assertEq(dep.get(id).runner, bytes32(0));
    }

    function test_releaseLeaseRefundsTheTailExactlyLikeRelease() public {
        bytes32 id = _create(100e6);
        _claim(id, opA, HOST_A1);
        uint64 until = dep.get(id).leaseUntil;
        vm.warp(T0 + 100);
        uint256 tail = uint256(until - (T0 + 100)) * RATE;
        uint256 bal = dep.get(id).balance6;
        vm.expectEmit(true, true, false, true, address(dep));
        emit Released(id, HOST_A1, tail);
        vm.prank(opA); leases.releaseLease(id, HOST_A1, 1);
        assertEq(dep.get(id).balance6, bal + tail);
        (,, uint64 creditedUntil) = dep.earnOf(id);
        assertEq(creditedUntil, 0); assertEq(dep.provenUntil(id), 0);
        assertGt(dep.earned6(opA), 0, "held time credited first");
    }

    function test_importedRecordsStartAtGenerationZero() public {
        EnclaveDeployments.Deployment[] memory items = new EnclaveDeployments.Deployment[](1);
        items[0].id = keccak256("imported"); items[0].owner = user; items[0].appRef = "catalog://app/0";
        items[0].cpuMilli = 1000; items[0].appPort = 8080; items[0].active = true; items[0].rate = RATE; items[0].balance6 = 10e6;
        items[0].runner = HOST_B; items[0].runnerOperator = opB; items[0].leaseUntil = uint64(T0 + 999);   // leases never migrate
        dep.importDeployments(items);
        (bytes32 runner, address op, uint64 until, uint64 g) = leases.leaseOf(items[0].id);
        assertEq(runner, bytes32(0)); assertEq(op, address(0)); assertEq(until, 0); assertEq(g, 0);
        _claim(items[0].id, opA, HOST_A1);
        assertEq(_gen(items[0].id), 1);
    }

    function test_fallbackReachesOnlyTheExtension() public {
        (bool ok, bytes memory ret) = address(dep).call(abi.encodeWithSignature("noSuchFunction()"));
        assertFalse(ok); assertEq(ret.length, 0, "unknown selector reverts with no data, as before");
        (ok, ret) = address(dep).call("");
        assertFalse(ok);
        vm.deal(address(this), 1 ether);
        (ok,) = address(dep).call{value: 1}("");
        assertFalse(ok, "no plain ETH");
        (ok,) = address(dep).call{value: 1}(abi.encodeWithSignature("setGuardedReleaseOnly(bool)", true));
        assertFalse(ok, "the extension takes no value");
        // the EnclaveLedgerBandwidth library is NOT reachable through the fallback
        (ok,) = address(dep).call(abi.encodeWithSignature("ethCredit(address,uint256,uint256)", address(0), 1, 1));
        assertFalse(ok);
        // views work from a static context
        (ok,) = address(dep).staticcall(abi.encodeWithSignature("leaseOf(bytes32)", bytes32(0)));
        assertTrue(ok);
        (ok,) = address(dep).staticcall(abi.encodeWithSignature("guardedReleaseOnly(address)", opA));
        assertTrue(ok);
    }

    function test_theLibraryItselfCannotBeDriven() public {
        address lib = address(EnclaveLeaseGeneration);
        assertGt(lib.code.length, 0);
        (bool ok,) = lib.call(abi.encodeWithSignature("setGuardedReleaseOnly(bool)", true));
        assertFalse(ok, "direct CALL refused by the library guard");
        (ok,) = lib.call(abi.encodeWithSignature("release(bytes32)", bytes32(0)));
        assertFalse(ok);
    }

    /// Expiry and renew boundaries are rev 16d's: releaseLease needs no live lease (a lapsed lease is still the
    /// caller's to clear), and a renew after expiry still reverts.
    function test_releaseLeaseOfALapsedLease_andRenewBoundary() public {
        bytes32 id = _create(100e6);
        _claim(id, opA, HOST_A1);
        vm.warp(block.timestamp + 1801);
        vm.prank(opA); vm.expectRevert(bytes("lease expired")); dep.renew(id);
        vm.prank(opA); leases.releaseLease(id, HOST_A1, 1);
        assertEq(dep.get(id).runner, bytes32(0));
    }
}
