// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/// The few forge cheatcodes these tests use, and plain assertions. forge-std's Test.sol pulls ~20 files whose
/// compilation alone exceeds this project's 512 MiB test allocation; this keeps the suite inside it.
interface Vm {
    function warp(uint256) external;
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function expectEmit(bool, bool, bool, bool, address) external;
    function store(address, bytes32, bytes32) external;
    function load(address, bytes32) external view returns (bytes32);
    function addr(uint256) external pure returns (address);
}

abstract contract MiniTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes internal constant ARITHMETIC_PANIC = abi.encodeWithSignature("Panic(uint256)", 0x11);

    function makeAddr(string memory label) internal pure returns (address) {
        return vm.addr(uint256(keccak256(bytes(label))));
    }

    function assertTrue(bool c) internal pure {
        require(c, "assertTrue");
    }

    function assertFalse(bool c) internal pure {
        require(!c, "assertFalse");
    }

    function assertEq(uint256 x, uint256 y) internal pure {
        require(x == y, "assertEq(uint)");
    }

    function assertEq(address x, address y) internal pure {
        require(x == y, "assertEq(address)");
    }

    function assertEq(bytes32 x, bytes32 y) internal pure {
        require(x == y, "assertEq(bytes32)");
    }

    function assertEq(string memory x, string memory y) internal pure {
        require(keccak256(bytes(x)) == keccak256(bytes(y)), "assertEq(string)");
    }

    function assertEq(bytes memory x, bytes memory y) internal pure {
        require(keccak256(x) == keccak256(y), "assertEq(bytes)");
    }
}
