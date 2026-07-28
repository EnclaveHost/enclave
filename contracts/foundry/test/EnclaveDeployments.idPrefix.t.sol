// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {EnclaveDeployments, IEnclaveRegistry} from "../../EnclaveDeployments.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract MockRegistry {
    address public operator;
    constructor(address _operator) { operator = _operator; }
    function get(bytes32) external view returns (IEnclaveRegistry.Enclave memory e) {
        e.operator = operator;
        e.active = true;
    }
}

/// The first 4 bytes of a deployment id are its PUBLIC NAME off-chain:
/// `<8 hex>.app.enclave.host` is a DNS label and a full 64-hex id does not fit
/// in one. 32 bits would be plenty against accidents, but this is not an
/// accident problem — ids are keccak256(creator, nonce), so an attacker hashes
/// candidate creator addresses OFFLINE (seconds, no gas) until one's first id
/// shares a victim's prefix, then creates that single deployment to make the
/// victim's hostname resolve to two records. create() therefore reserves the
/// prefix and rolls the nonce past any that is taken, so the grind has nothing
/// to land on. Imports reserve too — idempotently, since a pre-rule source may
/// carry a colliding pair that still has to migrate verbatim.
contract EnclaveDeploymentsIdPrefixTest is Test {
    EnclaveDeployments internal dep;
    MockUSDC internal usdc;
    MockRegistry internal reg;

    address internal user = makeAddr("user");
    address internal payout = makeAddr("payout");
    address internal operator = makeAddr("operator");

    function setUp() public {
        usdc = new MockUSDC();
        reg = new MockRegistry(operator);
        dep = new EnclaveDeployments(address(usdc), payout, address(reg), address(0));
        // These suites pin the PRE-CUTOVER meter (held lease time, the rev-8
        // semantics they were written against). Proven-time metering — what the
        // meter does once proofRequiredFrom passes, and the whole proof protocol
        // in EnclaveProofOfTime — has its own suite in
        // EnclaveDeployments.proofOfTime.t.sol.
        dep.setProofRequiredFrom(0);
        vm.warp(1_700_000_000);
    }

    function _create(address who) internal returns (bytes32 id) {
        vm.prank(who);
        id = dep.create("catalog://app/0", 0, 10, 8080, "", true, "", address(0), 0, 2501);
    }

    /// The id create() is about to mint for `who` at its current nonce.
    function _next(address who, uint64 nonce) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(who, nonce));
    }

    function test_everyCreatedPrefixIsUnique() public {
        bytes32[] memory ids = new bytes32[](24);
        for (uint256 i = 0; i < ids.length; i++) ids[i] = _create(makeAddr(string(abi.encodePacked("u", i))));
        for (uint256 i = 0; i < ids.length; i++)
            for (uint256 j = i + 1; j < ids.length; j++)
                assertTrue(bytes4(ids[i]) != bytes4(ids[j]), "two deployments share a hostname label");
    }

    /// The grind, staged exactly: something already holds the prefix that
    /// `user`'s nonce-0 id would have taken. create() must not mint it.
    function test_createRollsPastATakenPrefix() public {
        bytes32 wouldBe = _next(user, 0);
        // reserve that prefix through the (owner-only) import path
        EnclaveDeployments.Deployment[] memory items = new EnclaveDeployments.Deployment[](1);
        items[0].id = bytes32(bytes4(wouldBe)) | bytes32(uint256(0xdead));   // same prefix, different id
        items[0].owner = makeAddr("squatter");
        items[0].appRef = "catalog://squat/0";
        items[0].cpuMilli = 10;
        items[0].appPort = 8080;
        items[0].active = true;
        items[0].rate = 9;
        dep.importDeployments(items);
        assertTrue(items[0].id != wouldBe, "fixture must be a prefix twin, not the same id");

        bytes32 got = _create(user);
        assertTrue(got != wouldBe, "create minted the id whose prefix was already taken");
        assertTrue(bytes4(got) != bytes4(wouldBe), "create minted a colliding hostname label");
        assertEq(got, _next(user, 1), "it should simply roll to the next nonce");
        // and the record is otherwise completely normal
        assertEq(dep.get(got).owner, user);
    }

    /// A source that already contains a colliding pair (created before the
    /// rule) must still migrate verbatim — the reservation is idempotent.
    function test_importAcceptsAPreExistingPrefixCollision() public {
        EnclaveDeployments.Deployment[] memory items = new EnclaveDeployments.Deployment[](2);
        for (uint256 i = 0; i < 2; i++) {
            items[i].id = bytes32(bytes4(0xaabbccdd)) | bytes32(uint256(i + 1));
            items[i].owner = user;
            items[i].appRef = "catalog://old/0";
            items[i].cpuMilli = 10;
            items[i].appPort = 8080;
            items[i].active = true;
            items[i].rate = 9;
        }
        dep.importDeployments(items);
        assertEq(dep.count(), 2, "both historical records migrate");
        assertEq(dep.get(items[0].id).owner, user);
        assertEq(dep.get(items[1].id).owner, user);
    }
}
