// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Copied into session-r1/test only AFTER the source-only Claude job has finished.
import {FundingRig} from "./FundingRig.sol";
import {FundingSessionVault} from "../src/FundingSessionVault.sol";
import {FundingGasLib} from "../src/FundingGasLib.sol";
import {MockUSDC3009} from "enclave-src/foundry/test/mocks/SessionMocks.sol";
import {EnclaveDeployments} from "enclave-src/EnclaveDeployments.sol";
import {Vm} from "forge-std/Vm.sol";

// Test-only token instrumentation. Delegate to the identical original mock code so all balances,
// allowances and EIP-3009 state stay in their existing slots. The only added behavior is a callback
// AFTER a successful transfer to the relayer; adapter refund transfers do not trigger it.
contract RootFeeTokenCallback {
    address immutable original;
    address immutable relayer;
    address immutable owner;
    constructor(address logic, address r, address o) { original = logic; relayer = r; owner = o; }
    fallback() external {
        (bool ok, bytes memory ret) = original.delegatecall(msg.data);
        if (!ok) assembly ("memory-safe") { revert(add(ret, 32), mload(ret)) }
        if (msg.sig == bytes4(keccak256("transfer(address,uint256)"))) {
            (address to,) = abi.decode(msg.data[4:], (address, uint256));
            if (to == relayer) {
                (bool changed,) = owner.call(abi.encodeWithSignature("rotate()"));
                require(changed, "ownership callback must execute");
            }
        }
        assembly ("memory-safe") { return(add(ret, 32), mload(ret)) }
    }
}
contract RootOwnerCallback {
    EnclaveDeployments immutable ledger;
    bytes32 immutable id;
    address immutable next;
    constructor(EnclaveDeployments l, bytes32 d, address n) { ledger = l; id = d; next = n; }
    function rotate() external { ledger.transferDeployment(id, next); }
}

contract FundingRootRegressionTest is FundingRig {
    function test_rootSessionOpReportsActualDebitNotMaximum() public {
        bytes32 sid = _openWithDeposit(_gasGrant(30e6));
        bytes32 id = _walletRecord(freeRef, address(0), 0, 1000);
        uint256 fee = 1234;
        uint256 actual = _quote(ETH_OUT);
        assertLt(actual, MAX_IN);
        vm.recordLogs();
        _exec(sid, 0, GAS, _gasArgs(id, owner), fee);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("SessionOp(bytes32,uint256,uint8,bytes32,uint256,uint256,bytes)");
        uint256 matches;
        for (uint256 k; k < logs.length; k++) {
            if (logs[k].emitter == address(vault) && logs[k].topics[0] == topic) {
                // sid and action are indexed; nonce remains in event data.
                (,, uint256 amount6, uint256 fee6,) = abi.decode(logs[k].data, (uint256,bytes32,uint256,uint256,bytes));
                assertEq(amount6, actual, "event must not report unspent maximum as spending");
                assertEq(fee6, fee);
                matches++;
            }
        }
        assertEq(matches, 1);
        assertEq(_sess(sid).spent6, actual + fee);
        assertEq(usdc.balanceOf(address(vault)), 30e6 - actual - fee);
    }

    function test_rootFeeCallbackOwnerChangeRevertsEverything() public {
        bytes32 sid = _openWithDeposit(_gasGrant(30e6));
        bytes32 id = _walletRecord(freeRef, address(0), 0, 1000);
        address next = makeAddr("callback next owner");
        RootOwnerCallback ownerHook = new RootOwnerCallback(ledger, id, next);
        vm.etch(owner, address(ownerHook).code);
        RootFeeTokenCallback tokenHook = new RootFeeTokenCallback(address(new MockUSDC3009()), relayer, owner);
        vm.etch(address(usdc), address(tokenHook).code);
        uint256 initialRelayer = usdc.balanceOf(relayer);
        _execExpect(sid, 0, GAS, _gasArgs(id, owner), 1234,
            abi.encodeWithSelector(FundingGasLib.NotMine.selector, id));
        assertEq(ledger.get(id).owner, owner);
        assertEq(reserve.reserveOf(id, owner).balanceWei, 0);
        assertEq(usdc.balanceOf(relayer), initialRelayer);
        assertEq(usdc.balanceOf(address(vault)), 30e6);
        assertEq(usdc.allowance(address(vault), address(adapter)), 0);
        assertEq(_sess(sid).spent6, 0);
        assertEq(_sess(sid).periodSpent6, 0);
        assertEq(_sess(sid).periodOps, 0);
        assertEq(vault.locked6(), 30e6);
        assertEq(_seq(sid, 0), 0);
        assertEq(swapRouter.calls(), 0);
    }
}
