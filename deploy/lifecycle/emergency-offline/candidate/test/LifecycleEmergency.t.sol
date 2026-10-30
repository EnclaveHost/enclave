// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;
import "forge-std/Test.sol";
import {EnclaveDeploymentLifecycleEmergency as Lc} from "../contracts/EnclaveDeploymentLifecycleEmergency.sol";
import {MockPairedLedger, MockIdentity, MockL1Oracle, RejectingRelay} from "./mocks/EmergencyMocks.sol";

/// Controller-level semantics against adversarial mocks. Paid-accounting
/// assertions run against MockPairedLedger, a reference model of the proposed
/// schema-3 gates, NOT the production ledger (integration BLOCKED, see REPORT).
contract LifecycleEmergencyTest is Test {
    Lc lc;
    MockPairedLedger ledger;
    MockIdentity identity;
    MockL1Oracle oracle;
    // Deterministic public test labels only; never real keys.
    uint256 ownerKey = uint256(keccak256("lifecycle owner test"));
    uint256 operatorKey = uint256(keccak256("lifecycle operator test"));
    uint256 outsiderKey = uint256(keccak256("lifecycle emergency outsider test"));
    address appOwner;
    address operator;
    address relay;
    bytes32 constant HOST = keccak256("emergency test host");
    bytes32 constant APP = keccak256("emergency test app");
    uint128 constant CAP = 0.00001 ether;
    // secp256k1 group order, a public curve parameter.
    uint256 constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256[] witnessKeys;
    address[] witnesses;

    function setUp() public {
        vm.warp(1_800_000_000); vm.txGasPrice(6_000_000);
        appOwner = vm.addr(ownerKey); operator = vm.addr(operatorKey); relay = makeAddr("relay");
        ledger = new MockPairedLedger(3); identity = new MockIdentity(); oracle = new MockL1Oracle();
        ledger.setIdentity(address(identity));
        lc = new Lc(address(ledger), address(oracle));
        ledger.setController(address(lc));
        ledger.setOwner(APP, appOwner); ledger.setOperator(APP, HOST, operator);
        for (uint256 i; i < 4; ++i) witnessKeys.push(uint256(keccak256(abi.encode("lifecycle witness test", i))));
        for (uint256 i; i < 4; ++i) for (uint256 j = i + 1; j < 4; ++j) {
            if (vm.addr(witnessKeys[j]) < vm.addr(witnessKeys[i])) (witnessKeys[i], witnessKeys[j]) = (witnessKeys[j], witnessKeys[i]);
        }
        for (uint256 i; i < 4; ++i) witnesses.push(vm.addr(witnessKeys[i]));
        vm.deal(appOwner, 1 ether); vm.deal(relay, 1 ether);
        vm.prank(appOwner); lc.configure(APP, witnesses, 3, CAP, CAP, 50_000_000);
        vm.prank(appOwner); lc.deposit{value: 0.001 ether}(APP);
    }

    // ---------------------------------------------------------------- helpers
    function _a() internal view returns (Lc.State state, uint64 gen, uint64 rev, bytes32 host, address op) {
        (, state, gen, rev, host, op,,,,,) = lc.assignments(APP);
    }
    function _balance() internal view returns (uint256 b) { (b,,,) = lc.budgets(APP); }
    function _pending() internal view returns (bool p) { (,,, p,,) = lc.offline(APP); }
    function _sign(uint256 key, bytes32 h) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, h); return abi.encodePacked(r, s, v);
    }
    function _approvals(bytes32 h, uint256 n) internal view returns (bytes[] memory sigs) {
        sigs = new bytes[](n);
        for (uint256 i; i < n; ++i) sigs[i] = _sign(witnessKeys[i], h);
    }
    function _intent(Lc.State target, bytes32 toHost) internal view returns (Lc.Intent memory x) {
        (, uint64 gen, uint64 rev,,) = _a();
        x = Lc.Intent(APP, gen, rev, target, toHost, uint64(vm.getBlockTimestamp() + 60), 0, relay, CAP);
    }
    function _send(Lc.Intent memory x, uint256 actorKey) internal returns (bool) {
        bytes32 h = lc.digest(x);
        bytes memory actor = actorKey == 0 ? bytes("") : _sign(actorKey, h);
        bytes[] memory sigs = _approvals(h, 3);
        vm.prank(relay); return lc.transition(x, actor, sigs);
    }
    function _rejectT(Lc.Intent memory x, uint256 actorKey, string memory why) internal {
        bytes32 h = lc.digest(x);
        bytes memory actor = actorKey == 0 ? bytes("") : _sign(actorKey, h);
        bytes[] memory sigs = _approvals(h, 3);
        vm.expectRevert(bytes(why)); vm.prank(relay); lc.transition(x, actor, sigs);
    }
    function _run() internal {
        _send(_intent(Lc.State.Queued, bytes32(0)), ownerKey);
        _send(_intent(Lc.State.Running, HOST), operatorKey);
    }
    function _emergency(Lc.State target, address payee, uint128 cap) internal view returns (Lc.Emergency memory x) {
        (, uint64 gen, uint64 rev, bytes32 host, address op) = _a();
        x = Lc.Emergency(APP, gen, rev, Lc.State.Running, host, op, target, uint64(vm.getBlockTimestamp() + 60), payee, cap);
    }
    function _eSigs(Lc.Emergency memory x, uint256 n) internal view returns (bytes[] memory) {
        return _approvals(lc.emergencyDigest(x), n);
    }
    function _offer(Lc.Emergency memory x, address sender) internal returns (bool) {
        bytes[] memory sigs = _eSigs(x, 3);
        vm.prank(sender); return lc.emergencyOffline(x, sigs);
    }
    function _rejectE(Lc.Emergency memory x, bytes[] memory sigs, address sender, string memory why) internal {
        vm.expectRevert(bytes(why)); vm.prank(sender); lc.emergencyOffline(x, sigs);
    }
    /// Independent off-chain digest construction, so wrong-controller and
    /// wrong-chain approvals are genuinely signed over a different domain.
    function _eDigestFor(Lc.Emergency memory x, address verifying, uint256 chainId) internal pure returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("EnclaveDeploymentLifecycle.EmergencyOffline"), keccak256("1"), chainId, verifying));
        bytes32 typeHash = keccak256("EmergencyOffline(bytes32 id,uint64 generation,uint64 revision,uint8 fromState,bytes32 host,address operator,uint8 target,uint64 deadline,address payee,uint128 maxReimburseWei)");
        return keccak256(abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(typeHash, x.id, x.generation,
            x.revision, uint8(x.fromState), x.host, x.operator, uint8(x.target), x.deadline, x.payee, x.maxReimburseWei))));
    }
    function _highS(bytes memory sig) internal pure returns (bytes memory) {
        bytes32 r; bytes32 s; uint8 v;
        assembly { r := mload(add(sig, 32)) s := mload(add(sig, 64)) v := byte(0, mload(add(sig, 96))) }
        return abi.encodePacked(r, bytes32(N - uint256(s)), v == 27 ? uint8(28) : uint8(27));
    }

    // ------------------------------------------------- critical durable record
    function test_offlineIsDurableWithLedgerIdentityOracleAndPayeeAllUnavailable() public {
        _run();
        (, uint64 gen,,,) = _a();
        RejectingRelay rr = new RejectingRelay();
        Lc.Emergency memory x = _emergency(Lc.State.Queued, address(rr), CAP);
        bytes[] memory sigs = _eSigs(x, 3);
        Lc.Intent memory n = _intent(Lc.State.Queued, bytes32(0));
        bytes32 nh = lc.digest(n);
        bytes memory ownerSig = _sign(ownerKey, nh);
        bytes[] memory nsigs = _approvals(nh, 3);
        ledger.setDown(true); identity.setDown(true); oracle.setDown(true);
        // The normal path stays coupled to every dependency (baseline semantics).
        vm.expectRevert(bytes("ledger unavailable")); vm.prank(relay); lc.transition(n, ownerSig, nsigs);

        vm.expectCall(address(ledger), abi.encodeWithSelector(MockPairedLedger.lifecycleOwner.selector), 0);
        vm.expectCall(address(ledger), abi.encodeWithSelector(MockPairedLedger.selfHostingIdentity.selector), 0);
        vm.expectCall(address(ledger), abi.encodeWithSelector(MockPairedLedger.lifecycleEndAt.selector), 0);
        vm.expectCall(address(identity), abi.encodeWithSelector(MockIdentity.principal.selector), 0);
        vm.expectCall(address(oracle), abi.encodeWithSelector(MockL1Oracle.getL1FeeUpperBound.selector), 0);
        assertTrue(rr.submit(lc, x, sigs));

        (Lc.State state, uint64 gen2,, bytes32 host2, address op2) = _a();
        assertEq(uint8(state), uint8(Lc.State.Queued));
        assertEq(gen2, gen + 1);
        assertEq(host2, bytes32(0));
        assertEq(op2, address(0));
        (uint64 runGen, uint64 cutoff, bool stopped, bool pending, bytes32 ph, address pop) = lc.offline(APP);
        assertEq(runGen, gen);
        assertEq(cutoff, vm.getBlockTimestamp());
        assertFalse(stopped);
        assertTrue(pending);
        assertEq(ph, HOST);
        assertEq(pop, operator);
        assertFalse(lc.canTransfer(APP));

        // Reimbursement is pending pull debt; a rejecting payee loses nothing.
        uint256 owed = lc.reimbursable(address(rr));
        assertGt(owed, 0); assertLe(owed, CAP);
        assertEq(address(lc).balance, _balance() + owed);
        vm.expectRevert(bytes("reimbursement transfer failed")); rr.claim(lc, address(rr));
        assertEq(lc.reimbursable(address(rr)), owed);
        address sink = makeAddr("reimbursement sink");
        rr.claim(lc, sink);
        assertEq(sink.balance, owed);
        assertEq(lc.reimbursable(address(rr)), 0);
        assertEq(address(lc).balance, _balance());
        vm.expectRevert(bytes("nothing owed")); rr.claim(lc, sink);
    }

    function test_admissionDenialBoundsOnlyReimbursementNeverTheRecord() public {
        _run();
        vm.txGasPrice(1e12); // above the owner's maxGasPrice: normal admission refuses
        _rejectT(_intent(Lc.State.Queued, bytes32(0)), ownerKey, "fee cap");
        uint256 before = _balance();
        assertTrue(_offer(_emergency(Lc.State.Stopped, address(0), 0), makeAddr("independent reporter")));
        assertEq(_balance(), before); // self-funded report: no budget spent
        assertTrue(_pending());
    }

    function test_reimbursementPricedAtOwnerGasCapAndL1LeftUnpriced() public {
        _run();
        vm.txGasPrice(1e12);
        Lc.Emergency memory x = _emergency(Lc.State.Queued, relay, CAP);
        uint256 before = _balance();
        assertTrue(_offer(x, relay));
        uint256 owed = lc.reimbursable(relay);
        assertGt(owed, 0); assertLe(owed, CAP);
        assertEq(owed % 50_000_000, 0); // priced at min(tx.gasprice, maxGasPrice)
        assertEq(before - _balance(), owed);
        (address payee, uint128 exec, uint128 l1Cap, uint32 l1Bytes) = lc.reimbursements(lc.emergencyDigest(x));
        assertEq(payee, relay);
        assertEq(exec, owed);
        assertEq(uint256(l1Cap), uint256(CAP) - owed); // recorded, neither reserved nor claimable
        assertGt(l1Bytes, 0);
        assertEq(address(lc).balance, _balance() + owed);
    }

    // ------------------------------------------------ authentication & replay
    function test_invalidQuorumForgeryDomainAndAssignmentMismatchesFail() public {
        _run();
        Lc.Emergency memory x = _emergency(Lc.State.Queued, relay, CAP);
        bytes32 h = lc.emergencyDigest(x);
        assertEq(_eDigestFor(x, address(lc), block.chainid), h);
        bytes[] memory s = _approvals(h, 2);
        _rejectE(x, s, relay, "quorum missing");
        _rejectE(x, new bytes[](0), relay, "quorum missing");
        s = _approvals(h, 3); s[1] = s[0];
        _rejectE(x, s, relay, "invalid witness quorum");
        s = _approvals(h, 3); (s[0], s[1]) = (s[1], s[0]);
        _rejectE(x, s, relay, "invalid witness quorum");
        s = _approvals(h, 3); s[2] = _sign(outsiderKey, h);
        _rejectE(x, s, relay, "invalid witness quorum");
        s = _approvals(h, 3); s[0] = _highS(s[0]);
        _rejectE(x, s, relay, "invalid witness quorum");
        _rejectE(x, _approvals(_eDigestFor(x, address(0xBEEF), block.chainid), 3), relay, "invalid witness quorum");
        _rejectE(x, _approvals(_eDigestFor(x, address(lc), 8453), 3), relay, "invalid witness quorum");
        // Normal Transition approvals for the same generation are not emergency approvals.
        _rejectE(x, _approvals(lc.digest(_intent(Lc.State.Queued, bytes32(0))), 3), relay, "invalid witness quorum");

        Lc.Emergency memory y;
        y = _emergency(Lc.State.Queued, relay, CAP); y.generation -= 1;
        _rejectE(y, _eSigs(y, 3), relay, "stale assignment");
        y = _emergency(Lc.State.Queued, relay, CAP); y.generation += 1;
        _rejectE(y, _eSigs(y, 3), relay, "stale assignment");
        y = _emergency(Lc.State.Queued, relay, CAP); y.revision += 1;
        _rejectE(y, _eSigs(y, 3), relay, "stale assignment");
        y = _emergency(Lc.State.Queued, relay, CAP); y.host = keccak256("other host");
        _rejectE(y, _eSigs(y, 3), relay, "stale assignment");
        y = _emergency(Lc.State.Queued, relay, CAP); y.operator = vm.addr(outsiderKey);
        _rejectE(y, _eSigs(y, 3), relay, "stale assignment");
        y = _emergency(Lc.State.Queued, relay, CAP); y.fromState = Lc.State.Queued;
        _rejectE(y, _eSigs(y, 3), relay, "not running");
        y = _emergency(Lc.State.Running, relay, CAP);
        _rejectE(y, _eSigs(y, 3), relay, "revocation only");
        y = _emergency(Lc.State.Unknown, relay, CAP);
        _rejectE(y, _eSigs(y, 3), relay, "revocation only");
        y = _emergency(Lc.State.Queued, relay, CAP); y.deadline = uint64(vm.getBlockTimestamp() - 1);
        _rejectE(y, _eSigs(y, 3), relay, "intent deadline");
        y = _emergency(Lc.State.Queued, relay, CAP); y.deadline = uint64(vm.getBlockTimestamp() + 121);
        _rejectE(y, _eSigs(y, 3), relay, "intent deadline");
        y = _emergency(Lc.State.Queued, relay, CAP);
        _rejectE(y, _eSigs(y, 3), makeAddr("front runner"), "wrong payee");
        y = _emergency(Lc.State.Queued, address(0), 1);
        _rejectE(y, _eSigs(y, 3), relay, "wrong payee");
        y = _emergency(Lc.State.Queued, relay, CAP + 1);
        _rejectE(y, _eSigs(y, 3), relay, "reimbursement cap");
        y = _emergency(Lc.State.Queued, relay, CAP); y.id = keccak256("unknown app");
        _rejectE(y, _eSigs(y, 3), relay, "unknown deployment");

        (Lc.State state,,,,) = _a();
        assertEq(uint8(state), uint8(Lc.State.Running));
        assertFalse(_pending());
    }

    function test_exactRetryIsNoopNeverRechargesAndCompetingIntentFails() public {
        _run();
        Lc.Emergency memory x = _emergency(Lc.State.Queued, relay, CAP);
        bytes[] memory s = _eSigs(x, 3);
        vm.prank(relay); assertTrue(lc.emergencyOffline(x, s));
        uint256 bal = _balance();
        uint256 owed = lc.reimbursable(relay);
        (, uint64 gen,,,) = _a();
        (,,,,,,, uint64 startAfter, uint32 failures,,) = lc.assignments(APP);

        vm.prank(relay); assertFalse(lc.emergencyOffline(x, s));
        vm.prank(makeAddr("other relay")); assertFalse(lc.emergencyOffline(x, new bytes[](0)));
        assertEq(_balance(), bal);
        assertEq(lc.reimbursable(relay), owed);
        (, uint64 genAfter,,,) = _a();
        (,,,,,,, uint64 startAfter2, uint32 failures2,,) = lc.assignments(APP);
        assertEq(genAfter, gen); assertEq(startAfter2, startAfter); assertEq(failures2, failures);

        Lc.Emergency memory y = Lc.Emergency(x.id, x.generation, x.revision, x.fromState, x.host, x.operator,
            x.target, x.deadline + 1, x.payee, x.maxReimburseWei);
        _rejectE(y, _eSigs(y, 3), relay, "not running");

        assertTrue(lc.reconcileOffline(APP));
        vm.prank(relay); assertFalse(lc.emergencyOffline(x, s));
        assertFalse(lc.reconcileOffline(APP));
        assertEq(ledger.endAtCalls(), 1);
        assertEq(lc.reimbursable(relay), owed);
    }

    function test_normalQuorumQueueFirstMakesSameGenerationEmergencyFail() public {
        _run();
        Lc.Emergency memory x = _emergency(Lc.State.Queued, relay, CAP);
        bytes[] memory s = _eSigs(x, 3);
        _send(_intent(Lc.State.Queued, bytes32(0)), 0);
        _rejectE(x, s, relay, "not running");
        assertFalse(_pending());
    }

    // ------------------------------------------------------- pending gates
    function test_pendingSettlementBlocksStartResumeConfigurePolicyStopAndTransfer() public {
        _run();
        assertTrue(_offer(_emergency(Lc.State.Queued, relay, CAP), relay));
        vm.warp(vm.getBlockTimestamp() + 400);
        _rejectT(_intent(Lc.State.Running, HOST), operatorKey, "offline settlement pending");
        _rejectT(_intent(Lc.State.Stopped, bytes32(0)), ownerKey, "offline settlement pending");
        vm.expectRevert(bytes("offline settlement pending")); vm.prank(appOwner); lc.resume(APP);
        vm.expectRevert(bytes("offline settlement pending")); vm.prank(appOwner);
        lc.configure(APP, witnesses, 3, CAP, CAP, 50_000_000);
        vm.expectRevert(bytes("offline settlement pending")); vm.prank(appOwner); lc.setAuthorityPolicy(APP, 1800);
        assertFalse(lc.canTransfer(APP));
        assertFalse(lc.funded(APP));

        assertTrue(lc.reconcileOffline(APP));
        assertFalse(_pending());
        _send(_intent(Lc.State.Running, HOST), operatorKey);
        (Lc.State state, uint64 gen,,,) = _a();
        assertEq(uint8(state), uint8(Lc.State.Running));
        (uint64 runGen,,,,,, bool live) = ledger.runs(APP);
        assertEq(runGen, gen); assertTrue(live);
        assertTrue(lc.funded(APP));
    }

    function test_emergencyStopHoldsWithdrawUntilExactSettlementThenDeactivates() public {
        _run();
        assertTrue(_offer(_emergency(Lc.State.Stopped, address(0), 0), makeAddr("independent reporter")));
        vm.warp(vm.getBlockTimestamp() + 30);
        uint256 bal = _balance();
        vm.expectRevert(bytes("offline settlement pending")); vm.prank(appOwner); lc.withdraw(APP, bal);
        assertTrue(ledger.active(APP));
        assertTrue(lc.reconcileOffline(APP));
        assertFalse(ledger.active(APP));
        vm.prank(appOwner); lc.withdraw(APP, bal);
        assertTrue(lc.canTransfer(APP));
        assertEq(address(lc).balance, 0);
    }

    function test_emergencyQueuesKeepFenceBackoffAndCrashHoldRequiringOwnerResume() public {
        _run();
        for (uint256 i; i < 5; ++i) {
            assertTrue(_offer(_emergency(Lc.State.Queued, relay, CAP), relay));
            assertTrue(lc.reconcileOffline(APP));
            if (i == 0) _rejectT(_intent(Lc.State.Running, HOST), operatorKey, "not startable");
            vm.warp(vm.getBlockTimestamp() + 300);
            if (i < 4) _send(_intent(Lc.State.Running, HOST), operatorKey);
        }
        (,,,,,,,, uint32 failures, bool held,) = lc.assignments(APP);
        assertEq(failures, 5); assertTrue(held);
        vm.warp(vm.getBlockTimestamp() + 30 days);
        _rejectT(_intent(Lc.State.Running, HOST), operatorKey, "not startable");
        vm.expectRevert(bytes("not owner")); lc.resume(APP);
        vm.prank(appOwner); lc.resume(APP);
        _send(_intent(Lc.State.Running, HOST), operatorKey);
    }

    // ----------------------------------------------- exact-cutoff settlement
    function test_paidRunSettlesAtRecordedCutoffDespiteLaterSettleFundAndProof() public {
        ledger.setRates(APP, 100, 80); ledger.credit(APP, 1_000_000);
        _send(_intent(Lc.State.Queued, bytes32(0)), ownerKey);
        uint64 t0 = uint64(vm.getBlockTimestamp());
        _send(_intent(Lc.State.Running, HOST), operatorKey);
        (,,,, uint64 leaseUntil,,) = ledger.runs(APP);
        assertEq(leaseUntil, t0 + 10_000);
        assertEq(ledger.spent6(APP), 1_000_000);

        vm.warp(t0 + 1000);
        assertTrue(_offer(_emergency(Lc.State.Queued, relay, CAP), relay));
        vm.warp(t0 + 6000);
        // Legacy-shaped mutators during the pending window honor the cutoff.
        ledger.settle(APP);
        ledger.creditProven(APP, t0 + 5000);
        ledger.fund(APP, 500_000);
        assertEq(ledger.earned6(operator), 1000 * 80);
        (,,,, uint64 leaseAfterFund,,) = ledger.runs(APP);
        assertEq(leaseAfterFund, t0 + 10_000);

        assertTrue(lc.reconcileOffline(APP));
        // Settled at t0+1000, not at the reconcile block (t0+6000).
        assertEq(ledger.spent6(APP), 1000 * 100);
        assertEq(ledger.balance6(APP), 500_000 + 9000 * 100);
        assertEq(ledger.balance6(APP) + ledger.spent6(APP), 1_500_000); // conservation
        assertEq(ledger.earned6(operator), 1000 * 80);

        vm.warp(t0 + 9000);
        assertFalse(lc.reconcileOffline(APP));
        assertEq(ledger.endAtCalls(), 1);
        assertEq(ledger.spent6(APP), 1000 * 100);
        assertEq(ledger.balance6(APP), 500_000 + 9000 * 100);
    }

    function test_failedOrMisboundSettlementKeepsOfflinePending() public {
        ledger.setRates(APP, 100, 80); ledger.credit(APP, 1_000_000);
        _run();
        vm.warp(vm.getBlockTimestamp() + 100);
        assertTrue(_offer(_emergency(Lc.State.Queued, relay, CAP), relay));
        vm.warp(vm.getBlockTimestamp() + 500);

        ledger.setDown(true);
        vm.expectRevert(bytes("ledger unavailable")); lc.reconcileOffline(APP);
        assertTrue(_pending());
        ledger.setDown(false);

        ledger.setEndMode(MockPairedLedger.EndMode.Revert);
        vm.expectRevert(bytes("settlement failed")); lc.reconcileOffline(APP);
        assertTrue(_pending());

        ledger.setEndMode(MockPairedLedger.EndMode.SettleAtNow);
        vm.expectRevert(bytes("settlement ack mismatch")); lc.reconcileOffline(APP);
        assertTrue(_pending());
        (,,,,,, bool live) = ledger.runs(APP);
        assertTrue(live);
        assertEq(ledger.spent6(APP), 1_000_000);

        ledger.setEndMode(MockPairedLedger.EndMode.WrongGeneration);
        vm.expectRevert(bytes("settlement ack mismatch")); lc.reconcileOffline(APP);
        assertTrue(_pending());

        ledger.setEndMode(MockPairedLedger.EndMode.Honest);
        assertTrue(lc.reconcileOffline(APP));
        assertFalse(_pending());
        assertEq(ledger.spent6(APP), 100 * 100);
    }

    /// Reference-model check of the ledger-side binding the REPORT requires.
    function test_referenceLedgerRefusesForeignStaleOrOutOfRangeSettlement() public {
        _run();
        (, uint64 gen,,,) = _a();
        vm.warp(vm.getBlockTimestamp() + 50);
        assertTrue(_offer(_emergency(Lc.State.Queued, relay, CAP), relay));
        (, uint64 cutoff,,,,) = lc.offline(APP);
        vm.expectRevert(bytes("only controller"));
        ledger.lifecycleEndAt(APP, gen, HOST, operator, cutoff, false);
        vm.expectRevert(bytes("stale settlement")); vm.prank(address(lc));
        ledger.lifecycleEndAt(APP, gen + 1, HOST, operator, cutoff, false);
        vm.expectRevert(bytes("stale settlement")); vm.prank(address(lc));
        ledger.lifecycleEndAt(APP, gen, keccak256("other host"), operator, cutoff, false);
        vm.expectRevert(bytes("stale settlement")); vm.prank(address(lc));
        ledger.lifecycleEndAt(APP, gen, HOST, vm.addr(outsiderKey), cutoff, false);
        vm.expectRevert(bytes("cutoff out of range")); vm.prank(address(lc));
        ledger.lifecycleEndAt(APP, gen, HOST, operator, cutoff + 1000, false);
        vm.expectRevert(bytes("cutoff out of range")); vm.prank(address(lc));
        ledger.lifecycleEndAt(APP, gen, HOST, operator, 1, false);
        assertTrue(_pending());
        assertTrue(lc.reconcileOffline(APP));
    }

    // ------------------------------------------------ normal path & pairing
    function test_normalOwnerStopRemainsAndIsAckBoundAtCurrentBlock() public {
        _run();
        oracle.setDown(true);
        _rejectT(_intent(Lc.State.Stopped, bytes32(0)), ownerKey, "oracle unavailable");
        oracle.setDown(false);
        assertTrue(_send(_intent(Lc.State.Stopped, bytes32(0)), ownerKey));
        assertEq(ledger.endAtCalls(), 1);
        assertFalse(ledger.active(APP));
        assertFalse(_pending());
        (,,,,,, bool live) = ledger.runs(APP);
        assertFalse(live);
    }

    function test_candidateRefusesToPairWithUnpatchedSchema2Ledger() public {
        MockPairedLedger legacy = new MockPairedLedger(2);
        vm.expectRevert(bytes("paired schema-3 ledger required"));
        new Lc(address(legacy), address(oracle));
    }
}
