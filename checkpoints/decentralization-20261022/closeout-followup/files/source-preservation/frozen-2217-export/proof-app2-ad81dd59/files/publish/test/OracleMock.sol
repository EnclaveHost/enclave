// SPDX-License-Identifier: MIT
// TEST ONLY: stands in for Base's GasPriceOracle predeploy on a local chain. mode (slot 0): 0 normal, 1 not Isthmus,
// 2 getOperatorFee reverts. L1 bound = 1000 wei per byte of the oracle-side size (argument + 68); operator fee = 7 wei
// per gas.
pragma solidity ^0.8.20;
contract OracleMock {
    uint256 public mode;
    function getL1FeeUpperBound(uint256 size) external pure returns (uint256) { return (size + 68) * 1000; }
    function isIsthmus() external view returns (bool) { return mode != 1; }
    function getOperatorFee(uint256 gasUsed) external view returns (uint256) { require(mode != 2, "mock revert"); return gasUsed * 7; }
}
