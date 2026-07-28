// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {EnclaveDeployments, IEnclaveRegistry} from "../../EnclaveDeployments.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// multicall() delegatecalls, which preserves BOTH msg.sender and msg.value.
/// msg.sender is the point - a batch acts as the caller, so each inner call is
/// still owner-gated. msg.value is the hazard: a payable multicall would hand
/// EVERY inner call the same msg.value, and fundEth credits against msg.value.
/// Batch N fundEth calls with one payment and the ledger credits N times what
/// was paid - free runtime, minted out of an accounting mistake.
///
/// Today that cannot happen, for one reason only: multicall is NOT payable, so
/// the ETH never gets in and an inner fundEth sees msg.value == 0 and reverts on
/// its own require. That safety is one keyword deep and nothing stated it, so a
/// later "let multicall take value too" would reintroduce it silently. These
/// tests are that statement.
contract MockRegistry {
    address public operator;
    constructor(address _operator) { operator = _operator; }
    function get(bytes32) external view returns (IEnclaveRegistry.Enclave memory e) {
        e.operator = operator;
        e.active = true;
    }
}

/// Chainlink-shaped feed so fundEth is ENABLED - the test has to be able to
/// reach the payable path, or it would pass for the wrong reason.
contract MockFeed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, 3000e8, block.timestamp, block.timestamp, 1);   // $3000/ETH
    }
}

contract EnclaveDeploymentsMulticallValueTest is Test {
    EnclaveDeployments internal dep;
    MockUSDC internal usdc;
    MockRegistry internal reg;
    MockFeed internal feed;

    address internal user = makeAddr("user");
    address internal payout = makeAddr("payout");
    address internal operator = makeAddr("operator");

    function setUp() public {
        usdc = new MockUSDC();
        reg = new MockRegistry(operator);
        feed = new MockFeed();
        dep = new EnclaveDeployments(address(usdc), payout, address(reg), address(feed));
        // These suites pin the PRE-CUTOVER meter (held lease time, the rev-8
        // semantics they were written against). Proven-time metering — what the
        // meter does once proofRequiredFrom passes, and the whole proof protocol
        // in EnclaveProofOfTime — has its own suite in
        // EnclaveDeployments.proofOfTime.t.sol.
        dep.setProofRequiredFrom(0);
        usdc.mint(user, 1_000_000e6);
        vm.prank(user);
        usdc.approve(address(dep), type(uint256).max);
        vm.deal(user, 100 ether);
        vm.warp(1_700_000_000);
    }

    function _create() internal returns (bytes32 id) {
        vm.prank(user);
        id = dep.create("catalog://app/0", 0, 100, 8080, "", true, "", address(0), 0, 2501);
    }

    /// the payable path itself works - otherwise the reverts below prove nothing
    function test_fundEthDirectlyStillWorks() public {
        bytes32 id = _create();
        vm.prank(user);
        dep.fundEth{value: 1 ether}(id);
        assertEq(dep.get(id).balance6, (1 ether * 3000e8) / 1e20, "$3000 of credit for 1 ETH");
    }

    function test_multicallRejectsValue() public {
        bytes32 id = _create();
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeWithSelector(EnclaveDeployments.fundEth.selector, id);

        // non-payable: the call fails before any inner call runs
        vm.prank(user);
        (bool ok, ) = address(dep).call{value: 1 ether}(
            abi.encodeWithSelector(EnclaveDeployments.multicall.selector, calls));
        assertFalse(ok, "multicall must not accept value - a payable one double-credits fundEth");
        assertEq(dep.get(id).balance6, 0, "no credit may appear from a rejected call");
    }

    /// the actual attack shape, spelled out: one payment, three credits
    function test_multicallCannotMintCreditFromOnePayment() public {
        bytes32 id = _create();
        bytes[] memory calls = new bytes[](3);
        for (uint256 i = 0; i < 3; i++)
            calls[i] = abi.encodeWithSelector(EnclaveDeployments.fundEth.selector, id);

        uint256 before = user.balance;
        vm.prank(user);
        (bool ok, ) = address(dep).call{value: 1 ether}(
            abi.encodeWithSelector(EnclaveDeployments.multicall.selector, calls));
        assertFalse(ok);
        assertEq(user.balance, before, "no ETH left the caller");
        assertEq(dep.get(id).balance6, 0, "3x credit for 1x payment is the bug this pins");
    }

    /// and with no value attached, an inner fundEth reverts on its own guard -
    /// so even a future payable multicall would need msg.value handling, not
    /// just the keyword
    function test_multicallWithoutValueCannotFundEth() public {
        bytes32 id = _create();
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeWithSelector(EnclaveDeployments.fundEth.selector, id);
        vm.prank(user);
        vm.expectRevert(bytes("amount=0"));
        dep.multicall(calls);
    }

    /// USDC batching, the reason multicall exists, keeps working
    function test_multicallStillBatchesOwnerOps() public {
        bytes32 id = _create();
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeWithSelector(EnclaveDeployments.setAppRef.selector, id, "catalog://app/1");
        calls[1] = abi.encodeWithSelector(EnclaveDeployments.setActive.selector, id, false);
        vm.prank(user);
        dep.multicall(calls);
        assertEq(dep.get(id).appRef, "catalog://app/1");
        assertFalse(dep.get(id).active);
    }

    /// delegatecall preserves msg.sender, so a batch is NOT a way around
    /// per-record ownership
    function test_multicallIsNotAnOwnershipBypass() public {
        bytes32 id = _create();
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeWithSelector(EnclaveDeployments.setActive.selector, id, false);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        dep.multicall(calls);
    }

}
