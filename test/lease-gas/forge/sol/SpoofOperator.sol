// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// TEST FIXTURE (relay security): a contract that accepts ANY call, burns gas and emits an event shaped exactly like
/// EnclaveLeaseGasReserve.LeaseGasPaid (same signature, same indexed layout) naming whatever payee it is told - without
/// paying anyone. A relay must never send to it; a host must never accept its event.
contract SpoofOperator {
    event LeaseGasPaid(bytes32 indexed id, address indexed owner, address indexed operator, address payee, uint8 kind,
                       uint256 gas, uint256 gasPrice, uint256 l1FeeWei, uint256 chargedWei);
    bytes32 public id; address public payee; uint8 public kind; address public operatorAddr;
    function arm(bytes32 id_, address payee_, uint8 kind_, address operator_) external { id = id_; payee = payee_; kind = kind_; operatorAddr = operator_; }
    fallback() external payable {
        for (uint256 i; i < 200; i++) { assembly { pop(keccak256(0, 64)) } }
        emit LeaseGasPaid(id, address(1), operatorAddr, payee, kind, 150_000, 1, 0, 1 ether);
    }
}

/// TEST FIXTURE: always reverts (a "reverted receipt" a lying relay can point a host at).
contract AlwaysReverts { fallback() external payable { revert("nope"); } }
