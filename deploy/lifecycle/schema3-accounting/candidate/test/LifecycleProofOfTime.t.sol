// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;
import {LifecycleTest} from "./Lifecycle.t.sol";
import {EnclaveProofOfTime as Proof} from "../deploy/EnclaveProofOfTime.sol";
import {EnclaveDeploymentLifecycleEmergency as Lifecycle} from "emergency/EnclaveDeploymentLifecycleEmergency.sol";
import {EnclaveRegistry} from "baseline/EnclaveRegistry.sol";

contract WrongProofLedger {
    function lifecycleSchema() external pure returns(uint256) { return 1; }
    function deploymentsSchema() external pure returns(uint256) { return 16; }
}

/// Prepared source only. Uses the actual lifecycle ledger/controller/identity
/// and registry fixture; no lease getter is added to a stand-in to hide failure.
abstract contract LifecycleProofOfTimeTest is LifecycleTest {
    uint256 internal proofKey = uint256(keccak256("lifecycle paid proof test key"));
    function _installProof() internal returns(Proof p) {
        p = new Proof(address(ledger), address(registry), 900, 1800);
        ledger.setProver(address(p));
        ledger.setProofRequiredFrom(uint64(vm.getBlockTimestamp()));
        vm.prank(operator); registry.setProofKey(host, vm.addr(proofKey));
    }
    function _paidStart() internal returns(uint256 start) {
        vm.prank(appOwner); registry.clearPayoutWallet(host);
        usdc.mint(appOwner, 2_000_000);
        vm.startPrank(appOwner); usdc.approve(address(ledger), 2_000_000); ledger.fund(app, 1_000_000); vm.stopPrank();
        start = vm.getBlockTimestamp(); _run();
    }
    function _checkpoint(Proof p, uint64 upto) internal {
        vm.roll(1000);
        bytes32 anchor = keccak256("lifecycle proof historical block");
        vm.setBlockhash(999, anchor);
        bytes32 digest = p.proofDigest(app, host, operator, upto, 999, anchor);
        p.checkpoint(app, host, upto, 999, anchor, _sign(proofKey, digest));
    }
    function test_proofLifecycleWindowWorksWithoutLeaseSelector() public {
        Proof p = _installProof();
        (bool ok,) = address(ledger).staticcall(abi.encodeWithSignature("leaseSec()"));
        assertFalse(ok);
        assertEq(p.proofSchema(), 2); assertEq(p.lifecycleProofSchema(), 2);
        assertEq(p.maxProofWindowSec(), 1800);
        p.setProofWindow(600); assertEq(p.proofWindowSec(), 600);
        vm.expectRevert("window range"); p.setProofWindow(59);
        vm.expectRevert("window range"); p.setProofWindow(1800);
        vm.expectRevert("!owner"); vm.prank(appOwner); p.setProofWindow(700);
    }
    function test_proofLifecycleConstructorRequiresExplicitBoundsAndPair() public {
        vm.expectRevert("window range"); new Proof(address(ledger), address(registry), 59, 1800);
        vm.expectRevert("window range"); new Proof(address(ledger), address(registry), 1800, 1800);
        vm.expectRevert("maximum window range"); new Proof(address(ledger), address(registry), 900, 86401);
        WrongProofLedger old = new WrongProofLedger();
        vm.expectRevert("not lifecycle ledger"); new Proof(address(old), address(registry), 900, 1800);
        EnclaveRegistry other = new EnclaveRegistry();
        vm.expectRevert("registry differs"); new Proof(address(ledger), address(other), 900, 1800);
    }
    function test_proofLifecyclePaysOnlyProvenElapsedService() public {
        Proof p = _installProof(); uint256 start = _paidStart();
        vm.warp(start + 600); assertEq(ledger.earned6(operator), 0);
        (uint256 rate,,) = ledger.earnOf(app);
        _checkpoint(p, uint64(start + 600));
        assertEq(ledger.provenUntil(app), start + 600);
        assertEq(ledger.earned6(operator), 600 * rate);
    }
    function test_proofLifecycleCannotRatchetTwoWindowsInOneBlock() public {
        Proof p = _installProof(); uint256 start = _paidStart();
        vm.warp(start + 3600); _checkpoint(p, uint64(start + 3600));
        assertEq(ledger.provenUntil(app), start + 900);
        // The second proof has a valid signature and anchor but no elapsed time.
        vm.roll(1001); bytes32 anchor = keccak256("second historical block"); vm.setBlockhash(1000, anchor);
        bytes memory sig = _sign(proofKey, p.proofDigest(app, host, operator, uint64(start + 3600), 1000, anchor));
        vm.expectRevert("nothing to prove"); p.checkpoint(app, host, uint64(start + 3600), 1000, anchor, sig);
        assertEq(ledger.provenUntil(app), start + 900);
    }
    function test_proofLifecycleClampsToPaidHorizon() public {
        Proof p = _installProof(); uint256 start = _paidStart();
        // Prove in 900-second steps, then request time beyond paid runtime.
        for (uint256 i = 1; i <= 11; ++i) { vm.warp(start + i * 900); _checkpoint(p, uint64(start + i * 900)); }
        vm.warp(start + 11000); _checkpoint(p, uint64(start + 11000));
        assertEq(ledger.provenUntil(app), ledger.get(app).leaseUntil);
        assertEq(ledger.provenUntil(app), start + 10000);
    }
    function test_proofLifecycleEndedAssignmentCannotReceiveAnotherCheckpoint() public {
        Proof p = _installProof(); uint256 start = _paidStart();
        vm.warp(start + 100); _checkpoint(p, uint64(start + 100));
        _send(_intent(app, Lifecycle.State.Queued, bytes32(0)), operatorKey);
        uint256 earned = ledger.earned6(operator);
        vm.roll(1001); bytes32 anchor = keccak256("ended historical block"); vm.setBlockhash(1000, anchor);
        bytes memory sig = _sign(proofKey, p.proofDigest(app, host, operator, uint64(start + 100), 1000, anchor));
        vm.expectRevert("not the runner"); p.checkpoint(app, host, uint64(start + 100), 1000, anchor, sig);
        assertEq(ledger.earned6(operator), earned);
    }
    function test_proofLifecycleZeroRateNeedsNoRecurringCheckpoint() public {
        Proof p = _installProof(); _run();
        (uint256 reserve,,,) = lc.budgets(app);
        vm.warp(vm.getBlockTimestamp() + 90 days);
        assertTrue(lc.funded(app)); assertEq(ledger.get(app).rate, 0);
        (uint256 afterReserve,,,) = lc.budgets(app); assertEq(afterReserve, reserve);
        (,,uint32 proofs) = p.recordOf(app); assertEq(proofs, 0);
        assertEq(ledger.earned6(operator), 0);
    }
    function test_proofLifecyclePreservesTwoStepAdministratorHandoff() public {
        Proof p = _installProof();
        p.transferOwnership(appOwner); assertEq(p.owner(), address(this));
        vm.expectRevert("!pendingOwner"); vm.prank(operator); p.acceptOwnership();
        vm.prank(appOwner); p.acceptOwnership();
        assertEq(p.owner(), appOwner); assertEq(p.pendingOwner(), address(0));
        vm.prank(appOwner); p.setProofWindow(700); assertEq(p.proofWindowSec(), 700);
        vm.expectRevert("!owner"); p.setProofWindow(800);
    }
    function test_proofLifecycleCodeSizeFits() public {
        Proof p = _installProof(); assertLe(address(p).code.length, 24576);
    }
}
