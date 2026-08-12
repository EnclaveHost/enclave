// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {EnclaveRegistry} from "../../EnclaveRegistry.sol";

/// CAPABILITIES (registry schema 5): one registry for every box on the network,
/// whether it runs code or only carries it. The point of the revision is that a
/// relay needs no TEE — no measurement, no proof key, no price — and belongs
/// here anyway, so the properties worth pinning are the ones that keep the two
/// roles from damaging each other:
///
///   - a relay registers with NO price, which register() would have refused;
///   - the two announcements OR their bits, so a box that does both cannot lose
///     a role by booting in the wrong order (register() runs every boot);
///   - giving a role up is a deliberate act (setCaps), never a side effect;
///   - CAP_HOST is register()'s to grant — registerRelay cannot mint it, or any
///     box could pose as an enclave without ever claiming a measurement;
///   - legacy rows read as hosts. Every pre-schema-5 entry has caps == 0 and
///     every one runs code, so 0 MUST mean CAP_HOST to consumers. This suite
///     pins the on-chain half of that: register() never leaves caps at 0.
contract EnclaveRegistryCapsTest is Test {
    EnclaveRegistry internal reg;

    address internal alice = address(0xA11CE);   // runs a TEE
    address internal bob   = address(0xB0BB1E);  // a plain box with a public IP and no TEE

    uint64 internal CAP_HOST;
    uint64 internal CAP_APP_SNI;
    uint64 internal CAP_TUNNEL_HUB;

    function setUp() public {
        reg = new EnclaveRegistry();
        CAP_HOST       = reg.CAP_HOST();
        CAP_APP_SNI    = reg.CAP_APP_SNI();
        CAP_TUNNEL_HUB = reg.CAP_TUNNEL_HUB();
    }

    // ---- a relay is a first-class row, with none of a host's furniture ------

    function test_a_relay_registers_with_no_price_measurement_or_proof_key() public {
        vm.prank(bob);
        bytes32 id = reg.registerRelay("relay-sjc.enclave.host", "us-west", CAP_APP_SNI);

        EnclaveRegistry.Enclave memory e = reg.get(id);
        assertEq(e.operator, bob);
        assertEq(e.region, "us-west");
        assertEq(e.caps, CAP_APP_SNI);
        assertTrue(e.active);
        assertEq(e.cpuPricePerSec6, 0, "a relay sells no compute");
        assertEq(e.measurement, bytes32(0), "and claims no code");
        assertEq(e.proofKey, address(0));
        assertEq(reg.count(), 1);
    }

    function test_the_host_path_still_demands_a_price() public {
        vm.prank(alice);
        vm.expectRevert("cpu price required");
        reg.register("gpu0.enclave.host", "EnclaveHost/enclave", bytes32(uint256(1)), 0, 0, address(0));
    }

    function test_a_relay_that_carries_nothing_is_refused() public {
        vm.prank(bob);
        vm.expectRevert("relay caps required");
        reg.registerRelay("relay-null.enclave.host", "us-west", 0);
    }

    function test_registerRelay_cannot_mint_CAP_HOST() public {
        vm.prank(bob);
        vm.expectRevert("relay caps only");
        reg.registerRelay("liar.enclave.host", "us-west", CAP_APP_SNI | CAP_HOST);
    }

    // ---- the two roles compose, in either order ----------------------------

    function test_register_sets_CAP_HOST_without_clearing_relay_bits() public {
        vm.startPrank(alice);
        reg.registerRelay("both.enclave.host", "us-west", CAP_APP_SNI | CAP_TUNNEL_HUB);
        bytes32 id = reg.register("both.enclave.host", "EnclaveHost/enclave", bytes32(uint256(0xbeef)), 834, 1667, address(0xC0FFEE));
        vm.stopPrank();

        EnclaveRegistry.Enclave memory e = reg.get(id);
        assertEq(e.caps, CAP_HOST | CAP_APP_SNI | CAP_TUNNEL_HUB, "booting as a host must not drop the relay role");
        assertEq(e.region, "us-west", "nor the region");
        assertEq(e.cpuPricePerSec6, 834);
        assertEq(reg.count(), 1, "one box, one row");
    }

    function test_registerRelay_does_not_clear_CAP_HOST_or_the_price() public {
        vm.startPrank(alice);
        bytes32 id = reg.register("both.enclave.host", "EnclaveHost/enclave", bytes32(uint256(0xbeef)), 834, 1667, address(0xC0FFEE));
        reg.registerRelay("both.enclave.host", "eu-north", CAP_APP_SNI);
        vm.stopPrank();

        EnclaveRegistry.Enclave memory e = reg.get(id);
        assertEq(e.caps, CAP_HOST | CAP_APP_SNI);
        assertEq(e.cpuPricePerSec6, 834, "still selling compute");
        assertEq(e.measurement, bytes32(uint256(0xbeef)), "still claiming code");
        assertEq(e.region, "eu-north");
    }

    function test_register_always_leaves_caps_nonzero_so_0_can_mean_legacy_host() public {
        vm.prank(alice);
        bytes32 id = reg.register("gpu0.enclave.host", "EnclaveHost/enclave", bytes32(uint256(1)), 834, 1667, address(0));
        assertTrue(reg.get(id).caps & CAP_HOST != 0, "a schema-5 host row is never caps==0");
    }

    // ---- giving a role up is deliberate ------------------------------------

    function test_setCaps_assigns_absolutely_and_is_how_a_role_is_dropped() public {
        vm.startPrank(alice);
        bytes32 id = reg.register("both.enclave.host", "EnclaveHost/enclave", bytes32(uint256(0xbeef)), 834, 1667, address(0));
        reg.registerRelay("both.enclave.host", "us-west", CAP_APP_SNI);
        reg.setCaps(id, CAP_APP_SNI, "us-west");        // stop hosting, keep relaying
        vm.stopPrank();

        EnclaveRegistry.Enclave memory e = reg.get(id);
        assertEq(e.caps, CAP_APP_SNI, "CAP_HOST is gone");
        assertEq(e.measurement, bytes32(uint256(0xbeef)), "the record of what it claimed stays");
        assertEq(e.cpuPricePerSec6, 834);
    }

    function test_setCaps_refuses_zero_because_zero_means_legacy_host() public {
        vm.startPrank(alice);
        bytes32 id = reg.register("gpu0.enclave.host", "EnclaveHost/enclave", bytes32(uint256(1)), 834, 1667, address(0));
        vm.expectRevert("caps required");
        reg.setCaps(id, 0, "us-west");
        vm.stopPrank();
    }

    function test_only_the_operator_may_set_caps_or_reannounce() public {
        vm.prank(bob);
        bytes32 id = reg.registerRelay("relay-sjc.enclave.host", "us-west", CAP_APP_SNI);

        vm.startPrank(alice);
        vm.expectRevert("not operator"); reg.setCaps(id, CAP_APP_SNI, "eu");
        vm.expectRevert("not operator"); reg.registerRelay("relay-sjc.enclave.host", "eu", CAP_APP_SNI);
        vm.expectRevert("not operator"); reg.register("relay-sjc.enclave.host", "r", bytes32(0), 834, 0, address(0));
        vm.stopPrank();
    }

    function test_setCaps_on_an_unknown_id_reverts() public {
        vm.prank(alice);
        vm.expectRevert("unknown");
        reg.setCaps(keccak256("nope"), CAP_APP_SNI, "us-west");
    }

    // ---- discovery ---------------------------------------------------------

    function test_relays_and_hosts_share_one_enumerable_set() public {
        vm.prank(alice); reg.register("gpu0.enclave.host", "EnclaveHost/enclave", bytes32(uint256(1)), 834, 1667, address(0));
        vm.prank(bob);   reg.registerRelay("relay-sjc.enclave.host", "us-west", CAP_APP_SNI);
        vm.prank(bob);   reg.registerRelay("relay-hel.enclave.host", "eu-north", CAP_APP_SNI | CAP_TUNNEL_HUB);

        EnclaveRegistry.Enclave[] memory page = reg.getPage(0, 10);
        assertEq(page.length, 3, "one registry, one poll");
        assertTrue(page[0].caps & CAP_HOST != 0);
        assertTrue(page[1].caps & CAP_APP_SNI != 0 && page[1].caps & CAP_HOST == 0, "a relay is not a host");
        assertEq(page[2].region, "eu-north");
    }

    function test_schema_is_pinned() public view {
        assertEq(reg.registrySchema(), 5, "consumers sniff this before decoding the appended tail");
    }
}
