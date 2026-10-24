// SPDX-License-Identifier: MIT
// TEST ONLY: the parts of EnclaveLeaseGasReserve the executor and this preparation read (ledger, executor binding and
// delegationCodeHash = keccak256(0xef0100 || executor), as bindExecutor sets them). begin/finish accept anything.
pragma solidity ^0.8.24;
contract ReserveStub {
    address public ledger; address public executor; bytes32 public delegationCodeHash;
    constructor(address _ledger) { ledger = _ledger; }
    function bind(address e) external { executor = e; delegationCodeHash = keccak256(abi.encodePacked(hex"ef0100", e)); }
    function begin(bytes32, uint8, bytes32) external {}
    function finish(bytes32, address payable, uint256, uint256, uint256, bool) external {}
}
