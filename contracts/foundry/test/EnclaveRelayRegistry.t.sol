// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {EnclaveRelayRegistry} from "../../EnclaveRelayRegistry.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// RELAY REGISTRY (schema 1): discovery for the boxes that CARRY traffic, as
/// opposed to the ones that run code. The properties worth pinning are the ones
/// that encode the trust argument, not the getters:
///
///   - registration is OPEN and does not require attestation, because a relay
///     is never handed plaintext to protect. A relay with no repo/measurement
///     is a first-class entry, and `attested` is a preference a router applies.
///   - the endpoint IS the identity: re-registering updates in place, only the
///     original operator may, and there is no way to repoint an endpoint at a
///     different operator's entry.
///   - the bond is a BAR, not a gate: registration works with no bond at all,
///     and meetsBond is what a router filters on.
///   - a bond in exit stops meeting the bar IMMEDIATELY, so a relay that is
///     leaving stops attracting traffic before its money is actually gone.
///   - slashing is bounded by the bond and owner-only — the relay's exposure to
///     a hostile registry owner is the bond and never more.
contract EnclaveRelayRegistryTest is Test {
    EnclaveRelayRegistry internal reg;
    MockUSDC internal usdc;

    address internal owner   = address(this);
    address internal payout  = address(0xB0B);
    address internal alice   = address(0xA11CE);   // a plain, unattested relay operator
    address internal bob     = address(0xB0BB1E);  // a second operator

    uint64 internal constant CAP_SNI = 1 << 0;
    uint64 internal constant CAP_TCP = 1 << 1;

    function setUp() public {
        usdc = new MockUSDC();
        reg = new EnclaveRelayRegistry(address(usdc), payout);
        usdc.mint(alice, 1_000_000e6);
        usdc.mint(bob, 1_000_000e6);
        vm.prank(alice); usdc.approve(address(reg), type(uint256).max);
        vm.prank(bob);   usdc.approve(address(reg), type(uint256).max);
    }

    // ---- registration is open, and attestation is optional -----------------

    function test_a_relay_with_no_attestation_is_a_first_class_entry() public {
        vm.prank(alice);
        bytes32 id = reg.register("relay-sjc.enclave.host", "us-west", "", bytes32(0), CAP_SNI);

        EnclaveRelayRegistry.Relay memory r = reg.get(id);
        assertEq(r.operator, alice);
        assertEq(r.region, "us-west");
        assertEq(r.repo, "");
        assertEq(r.measurement, bytes32(0));
        assertTrue(r.active, "an unattested relay registers active");
        assertEq(reg.count(), 1);
        // and it needs no bond to exist: bonding is inert at deploy
        assertTrue(reg.meetsBond(alice), "no bar set means everyone clears it");
    }

    function test_attestation_is_recorded_when_offered() public {
        vm.prank(bob);
        bytes32 id = reg.register("relay-tee.enclave.host", "eu-north",
                                  "EnclaveHost/enclave", bytes32(uint256(0xbeef)), CAP_SNI | CAP_TCP);
        EnclaveRelayRegistry.Relay memory r = reg.get(id);
        assertEq(r.repo, "EnclaveHost/enclave");
        assertEq(r.measurement, bytes32(uint256(0xbeef)));
        assertEq(r.caps, CAP_SNI | CAP_TCP);
    }

    function test_a_relay_that_carries_nothing_is_refused() public {
        vm.prank(alice);
        vm.expectRevert("caps required");
        reg.register("relay-null.enclave.host", "us-west", "", bytes32(0), 0);
    }

    // ---- the endpoint is the identity --------------------------------------

    function test_reregistering_the_same_endpoint_updates_in_place() public {
        vm.startPrank(alice);
        bytes32 a = reg.register("relay-sjc.enclave.host", "us-west", "", bytes32(0), CAP_SNI);
        bytes32 b = reg.register("relay-sjc.enclave.host", "us-west-2", "", bytes32(0), CAP_SNI | CAP_TCP);
        vm.stopPrank();
        assertEq(a, b, "same endpoint, same id");
        assertEq(reg.count(), 1, "an update must not append a second row");
        assertEq(reg.get(a).region, "us-west-2");
        assertEq(reg.get(a).caps, CAP_SNI | CAP_TCP);
    }

    function test_a_stranger_cannot_take_over_an_endpoint() public {
        vm.prank(alice);
        reg.register("relay-sjc.enclave.host", "us-west", "", bytes32(0), CAP_SNI);
        vm.prank(bob);
        vm.expectRevert("not operator");
        reg.register("relay-sjc.enclave.host", "eu-north", "", bytes32(0), CAP_SNI);
    }

    function test_only_the_operator_may_update_heartbeat_or_deregister() public {
        vm.prank(alice);
        bytes32 id = reg.register("relay-sjc.enclave.host", "us-west", "", bytes32(0), CAP_SNI);

        vm.startPrank(bob);
        vm.expectRevert("not operator"); reg.update(id, "eu", "", bytes32(0), CAP_SNI);
        vm.expectRevert("not operator"); reg.heartbeat(id);
        vm.expectRevert("not operator"); reg.deregister(id);
        vm.stopPrank();
    }

    function test_deregister_keeps_the_row_so_history_stays_readable() public {
        vm.startPrank(alice);
        bytes32 id = reg.register("relay-sjc.enclave.host", "us-west", "", bytes32(0), CAP_SNI);
        reg.deregister(id);
        vm.stopPrank();
        assertEq(reg.count(), 1, "the entry survives");
        assertFalse(reg.get(id).active);
    }

    function test_heartbeat_moves_lastSeen_and_revives_a_deregistered_relay() public {
        vm.startPrank(alice);
        bytes32 id = reg.register("relay-sjc.enclave.host", "us-west", "", bytes32(0), CAP_SNI);
        reg.deregister(id);
        uint64 before = reg.get(id).lastSeen;
        vm.warp(block.timestamp + 3600);
        reg.heartbeat(id);
        vm.stopPrank();
        assertTrue(reg.get(id).active, "a heartbeat is a relay saying it is back");
        assertGt(reg.get(id).lastSeen, before);
    }

    // ---- the bond is a bar, not a gate -------------------------------------

    function test_bond_below_the_bar_fails_the_filter_but_not_registration() public {
        reg.setBondBar(1_000e6, 7 days);
        vm.startPrank(alice);
        reg.register("relay-sjc.enclave.host", "us-west", "", bytes32(0), CAP_SNI);
        assertFalse(reg.meetsBond(alice), "registered, but below the bar");
        reg.postBond(999e6);
        assertFalse(reg.meetsBond(alice));
        reg.postBond(1e6);                        // posting ADDS
        assertTrue(reg.meetsBond(alice));
        vm.stopPrank();
        (uint256 amt,) = reg.bondOf(alice);
        assertEq(amt, 1_000e6);
    }

    function test_a_bond_in_exit_stops_meeting_the_bar_immediately() public {
        reg.setBondBar(1_000e6, 7 days);
        vm.startPrank(alice);
        reg.postBond(1_000e6);
        assertTrue(reg.meetsBond(alice));
        reg.requestBondExit();
        assertFalse(reg.meetsBond(alice), "leaving stops attracting traffic before the money moves");
        vm.stopPrank();
    }

    function test_posting_again_cancels_a_pending_exit() public {
        reg.setBondBar(1_000e6, 7 days);
        vm.startPrank(alice);
        reg.postBond(1_000e6);
        reg.requestBondExit();
        reg.postBond(1e6);                        // re-commit
        vm.stopPrank();
        (, uint64 exitAt) = reg.bondOf(alice);
        assertEq(exitAt, 0);
        assertTrue(reg.meetsBond(alice));
    }

    function test_withdraw_waits_out_the_timelock() public {
        reg.setBondBar(1_000e6, 7 days);
        vm.startPrank(alice);
        reg.postBond(1_000e6);
        vm.expectRevert("exit pending");
        reg.withdrawBond(alice);                  // no exit requested at all
        reg.requestBondExit();
        vm.expectRevert("exit pending");
        reg.withdrawBond(alice);                  // requested, not yet due
        vm.warp(block.timestamp + 7 days);
        reg.withdrawBond(alice);
        vm.stopPrank();
        (uint256 amt,) = reg.bondOf(alice);
        assertEq(amt, 0);
        assertEq(usdc.balanceOf(alice), 1_000_000e6);
    }

    // ---- slashing is bounded and owner-only --------------------------------

    function test_slash_is_owner_only_and_bounded_by_the_bond() public {
        vm.prank(alice); reg.postBond(1_000e6);

        vm.prank(bob);
        vm.expectRevert("!owner");
        reg.slashBond(alice, 1e6, "blackholed 0xe64f7cba for 6h");

        vm.expectRevert("range");
        reg.slashBond(alice, 1_001e6, "more than posted");   // exposure is the bond, never more

        reg.slashBond(alice, 400e6, "blackholed 0xe64f7cba for 6h");
        (uint256 amt,) = reg.bondOf(alice);
        assertEq(amt, 600e6);
        assertEq(usdc.balanceOf(payout), 400e6);
    }

    function test_a_slashed_relay_can_still_be_withdrawn_down_to_the_remainder() public {
        reg.setBondBar(0, 0);
        vm.prank(alice); reg.postBond(1_000e6);
        reg.slashBond(alice, 250e6, "evidence: incident-2026-08-11");
        vm.startPrank(alice);
        reg.requestBondExit();
        reg.withdrawBond(alice);
        vm.stopPrank();
        assertEq(usdc.balanceOf(alice), 1_000_000e6 - 250e6);
    }

    // ---- governance --------------------------------------------------------

    function test_ownership_handoff_is_two_step() public {
        reg.transferOwnership(bob);
        assertEq(reg.owner(), owner, "not until accepted");
        vm.prank(alice);
        vm.expectRevert("!owner");
        reg.acceptOwnership();
        vm.prank(bob);
        reg.acceptOwnership();
        assertEq(reg.owner(), bob);
    }

    function test_only_owner_moves_the_bar_or_the_payout() public {
        vm.startPrank(alice);
        vm.expectRevert("!owner"); reg.setBondBar(1e6, 1 days);
        vm.expectRevert("!owner"); reg.setPayout(alice);
        vm.stopPrank();
    }

    // ---- discovery ---------------------------------------------------------

    function test_paging_walks_the_whole_set_and_clamps() public {
        vm.prank(alice); reg.register("r1.enclave.host", "us-west", "", bytes32(0), CAP_SNI);
        vm.prank(alice); reg.register("r2.enclave.host", "us-east", "", bytes32(0), CAP_SNI);
        vm.prank(bob);   reg.register("r3.enclave.host", "eu-north", "", bytes32(0), CAP_TCP);

        assertEq(reg.getPage(0, 10).length, 3, "n past the end clamps");
        assertEq(reg.getPage(3, 1).length, 0, "start past the end is empty, not a revert");
        EnclaveRelayRegistry.Relay[] memory page = reg.getPage(1, 2);
        assertEq(page.length, 2);
        assertEq(page[0].endpoint, "r2.enclave.host");
        assertEq(page[1].endpoint, "r3.enclave.host");
        assertEq(reg.idAt(0), reg.idOf("r1.enclave.host"));
    }

    function test_schema_is_pinned() public view {
        assertEq(reg.relayRegistrySchema(), 1, "consumers sniff this before decoding");
    }
}
