// SPDX-License-Identifier: MIT
// TEST ONLY: EnclaveDeployments' read surface this preparation uses, with the production release's Deployment tuple
// (metal-deabf8f90 network/lease-gas-owner.mjs DEPLOYMENT_TUPLE) and leaseSec.
pragma solidity ^0.8.24;
contract LedgerStub {
    struct Deployment { bytes32 id; address owner; string appRef; string ports; string configCid; uint16 gpuMilli; uint16 cpuMilli; uint32 appPort;
        bool isPublic; bool active; uint64 createdAt; uint256 rate; uint256 balance6; uint256 spent6; bytes32 runner; address runnerOperator; uint64 leaseUntil; }
    mapping(bytes32 => Deployment) private d;
    function leaseSec() external pure returns (uint64) { return 1800; }
    function set(bytes32 id, bool active, address runnerOperator, uint64 leaseUntil) external {
        Deployment storage x = d[id]; x.id = id; x.active = active; x.runnerOperator = runnerOperator; x.leaseUntil = leaseUntil; x.appRef = "catalog://test/0";
    }
    function get(bytes32 id) external view returns (Deployment memory) { return d[id]; }
}
