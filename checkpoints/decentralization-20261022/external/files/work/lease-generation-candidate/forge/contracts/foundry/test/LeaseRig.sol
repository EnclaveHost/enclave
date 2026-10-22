// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IEnclaveRegistry} from "../../EnclaveDeployments.sol";

/// A registry stand-in: every entry is set explicitly (operator, prices, proof key, payout wallet). Read-only for ledgers.
contract LeaseRegistry {
    mapping(bytes32 => IEnclaveRegistry.Enclave) internal _e;
    function set(bytes32 id, address operator, uint64 cpuPrice, uint64 gpuPrice) external {
        IEnclaveRegistry.Enclave storage e = _e[id];
        e.operator = operator; e.active = true; e.cpuPricePerSec6 = cpuPrice; e.gpuPricePerSec6 = gpuPrice;
        e.proofKey = address(0xBEEF);
    }
    function setPayoutWallet(bytes32 id, address w) external { _e[id].payoutWallet = w; }
    function get(bytes32 id) external view returns (IEnclaveRegistry.Enclave memory) { return _e[id]; }
}

contract LeaseFeed {
    int256 public answer = 3000e8;
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, block.timestamp, block.timestamp, 1);
    }
}

/// A bandwidth/fee router stand-in: reports its ledger and accepts routed fees.
contract LeaseRouter {
    address public ledger;
    uint256 public routed;
    constructor(address l) { ledger = l; }
    function routeFee(bytes32, address, uint256 amount) external { routed += amount; }
    function charge(address l, bytes32 id, uint256 amount6, uint256 provider6, address beneficiary) external {
        (bool ok, bytes memory r) = l.call(abi.encodeWithSignature("chargeBandwidth(bytes32,uint256,uint256,address)", id, amount6, provider6, beneficiary));
        if (!ok) assembly { revert(add(r, 32), mload(r)) }
    }
}
