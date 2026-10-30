// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;
import {StdStorage, stdStorage} from "forge-std/StdStorage.sol";
import {LifecycleEmergencyTest} from "./LifecycleEmergency.t.sol";
import {EnclaveDeploymentLifecycleEmergency as Lc} from "../contracts/EnclaveDeploymentLifecycleEmergency.sol";

/// Independent review regression. The reduced accounting balance models an
/// already-running app after prior charges; no production funds are involved.
contract RootReserveRegressionTest is LifecycleEmergencyTest {
    using stdStorage for StdStorage;

    function _remaining(uint256 value) private {
        stdstore.target(address(lc)).sig("budgets(bytes32)").with_key(APP).depth(0).checked_write(value);
    }

    function test_rootQueuePreservesFinalStopReserveAndOneWei() public {
        _run();
        _remaining(uint256(CAP) + 1);
        vm.txGasPrice(50_000_000);
        assertTrue(_offer(_emergency(Lc.State.Queued, relay, CAP), relay));
        assertTrue(_pending());
        assertEq(_balance(), uint256(CAP) + 1);
        assertEq(lc.reimbursable(relay), 0);
    }

    function test_rootQueueAtReserveRecordsWithoutConsumingIt() public {
        _run();
        _remaining(CAP);
        assertTrue(_offer(_emergency(Lc.State.Queued, relay, CAP), relay));
        assertTrue(_pending());
        assertEq(_balance(), CAP);
        assertEq(lc.reimbursable(relay), 0);
    }

    function test_rootQueueWithNoBudgetStillRecords() public {
        _run();
        _remaining(0);
        assertTrue(_offer(_emergency(Lc.State.Queued, relay, CAP), relay));
        assertTrue(_pending());
        assertEq(_balance(), 0);
        assertEq(lc.reimbursable(relay), 0);
    }

    function test_rootFinalStopMayUseProtectedReserve() public {
        _run();
        _remaining(CAP);
        assertTrue(_offer(_emergency(Lc.State.Stopped, relay, CAP), relay));
        assertTrue(_pending());
        assertGt(lc.reimbursable(relay), 0);
        assertEq(_balance() + lc.reimbursable(relay), CAP);
    }
}
