// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// A Chainlink-shaped ETH/USD feed for the ledger constructor (verbatim from work/app-lease-gas forge/test/LeaseGas.t.sol).
contract MockFeed {
    int256 public answer;
    uint256 public updatedAt;
    uint80 public round = 1;
    uint80 public answeredIn = 1;
    function set(int256 a, uint256 u) external { answer = a; updatedAt = u; round++; answeredIn = round; }
    function setIncomplete() external { round++; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (round, answer, updatedAt, updatedAt, answeredIn);
    }
}
