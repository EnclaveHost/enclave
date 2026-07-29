// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {EnclaveDeployments, IEnclaveRegistry} from "../../EnclaveDeployments.sol";
import {EnclaveProofOfTime} from "../../EnclaveProofOfTime.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// Registry stand-in carrying registry schema 3's proofKey, so a test can put
/// a key it holds the private half of behind an enclave id — and take it away
/// again (a CVM relaunch mints a new one).
contract MockRegistryProof {
    mapping(bytes32 => address) public operatorOf;
    mapping(bytes32 => address) public proofKeyOf;
    function set(bytes32 id, address operator, address proofKey) external {
        operatorOf[id] = operator;
        proofKeyOf[id] = proofKey;
    }
    function get(bytes32 id) external view returns (IEnclaveRegistry.Enclave memory e) {
        e.operator = operatorOf[id];
        e.active = true;
        e.cpuPricePerSec6 = 834;
        e.gpuPricePerSec6 = 1667;
        e.proofKey = proofKeyOf[id];
    }
}

/// Proof of time (rev 9): a runner is paid for service it PROVED, not for lease
/// time it held.
///
/// The properties under test, in the order they matter:
///   - unproven time inside a paid lease earns the runner nothing;
///   - a checkpoint pays PRO RATA to the second, so a crash 19 minutes into an
///     hour pays 19 minutes — this is the partial-period behaviour the whole
///     design exists for;
///   - one checkpoint can never buy more than proofWindowSec, so an hour of pay
///     costs an hour of separately-anchored proofs (time is not compressible);
///   - a proof cannot be pre-signed (its anchor did not exist yet) and cannot be
///     hoarded (its anchor falls out of blockhash range), which bounds what a
///     host can steal by dying to the anchor window;
///   - nobody but the enclave's in-CVM key can produce one, and a proof does not
///     survive being pointed at another deployment, another host, or another
///     chain.
contract EnclaveDeploymentsProofOfTimeTest is Test {
    EnclaveDeployments internal dep;
    EnclaveProofOfTime internal pot;
    MockUSDC internal usdc;
    MockRegistryProof internal reg;

    address internal user = makeAddr("user");
    address internal payout = makeAddr("payout");
    address internal operator = makeAddr("operator");
    address internal operator2 = makeAddr("operator2");
    address internal coldWallet = makeAddr("coldWallet");

    bytes32 internal constant ENCLAVE_ID = keccak256("enclave-1");
    bytes32 internal constant ENCLAVE_ID_2 = keccak256("enclave-2");

    // The in-CVM signers. `proofPk` never leaves the "enclave"; `roguePk` is
    // what an operator who tried to sign for an app it is not running would
    // have to use.
    uint256 internal proofPk = 0xA11CE;
    uint256 internal proofPk2 = 0xB0B;
    uint256 internal roguePk = 0xBAD;
    address internal proofKey;
    address internal proofKey2;

    uint256 internal constant GPU_PRICE = 1667;
    uint256 internal constant CPU_PRICE = 834;
    uint256 internal constant ROOMY_CAP = (GPU_PRICE * 1000 + CPU_PRICE * 1000 + 999) / 1000;

    // Absolute warps only — see the note in EnclaveDeployments.runnerPayout.t.sol
    // about via_ir CSE-ing chained relative vm.warp calls onto one instant.
    uint256 internal constant T0 = 1_700_000_000;
    uint64 internal constant WINDOW = 900;

    function setUp() public {
        proofKey = vm.addr(proofPk);
        proofKey2 = vm.addr(proofPk2);
        usdc = new MockUSDC();
        reg = new MockRegistryProof();
        reg.set(ENCLAVE_ID, operator, proofKey);
        reg.set(ENCLAVE_ID_2, operator2, proofKey2);
        dep = new EnclaveDeployments(address(usdc), payout, address(reg), address(0));
        // Deploy order: ledger, then prover (which takes the ledger immutably),
        // then the one-shot binding that completes the pair.
        pot = new EnclaveProofOfTime(address(dep), address(reg));
        dep.setProver(address(pot));
        // This suite is the cutover: proven-time metering live from T0.
        dep.setProofRequiredFrom(uint64(T0));
        usdc.mint(user, 1_000_000e6);
        vm.prank(user);
        usdc.approve(address(dep), type(uint256).max);
        vm.warp(T0);
        vm.roll(1000);            // blockhash() needs history behind it
    }

    // ---- helpers ------------------------------------------------------------

    function _rate(uint16 gpuMilli, uint16 cpuMilli) internal pure returns (uint256) {
        return (GPU_PRICE * gpuMilli + CPU_PRICE * cpuMilli + 999) / 1000;
    }

    function _create(uint16 gpuMilli, uint16 cpuMilli, uint256 fund6) internal returns (bytes32 id) {
        vm.startPrank(user);
        id = dep.create("catalog://app/0", gpuMilli, cpuMilli, 8080, "", true, "", address(0), 0, ROOMY_CAP);
        if (fund6 > 0) dep.fund(id, fund6);
        vm.stopPrank();
    }

    function _claim(bytes32 id) internal {
        vm.prank(operator);
        dep.claim(id, ENCLAVE_ID);
    }

    function _runnerRate(bytes32 id) internal view returns (uint256 r6) {
        (r6,,) = dep.earnOf(id);
    }

    /// Sign a checkpoint the way a live enclave does: anchor to the previous
    /// block (the newest hash that exists), claim service through `upto`.
    function _sign(uint256 pk, bytes32 id, bytes32 enclaveId, address op, uint64 upto)
        internal view returns (uint64 anchorBlock, bytes32 anchorHash, bytes memory sig)
    {
        anchorBlock = uint64(block.number - 1);
        anchorHash = blockhash(anchorBlock);
        bytes32 digest = pot.proofDigest(id, enclaveId, op, upto, anchorBlock, anchorHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        sig = abi.encodePacked(r, s, v);
    }

    /// The whole runner-side move: prove service through `upto` and collect.
    function _checkpoint(bytes32 id, uint64 upto) internal {
        (uint64 ab, bytes32 ah, bytes memory sig) = _sign(proofPk, id, ENCLAVE_ID, operator, upto);
        pot.checkpoint(id, ENCLAVE_ID, upto, ab, ah, sig);
    }

    /// Move the clock AND the block height together, the way a real chain does
    /// (Base: ~2s blocks). Absolute, never relative.
    function _travelTo(uint256 ts) internal {
        require(ts >= T0, "backwards");
        vm.warp(ts);
        vm.roll(1000 + (ts - T0) / 2);
    }

    function _assertSolvent(bytes32 id) internal view {
        (, uint256 escrow6,) = dep.earnOf(id);
        assertGe(usdc.balanceOf(address(dep)),
            escrow6 + dep.earned6(operator) + dep.earned6(operator2));
    }

    // ---- the cutover --------------------------------------------------------

    function test_beforeCutover_heldTimePays_andProofsStillAccrue() public {
        dep.setProofRequiredFrom(uint64(T0) + 1 days);   // grace: not yet required
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        assertFalse(dep.proofRequired());

        _travelTo(T0 + 600);
        vm.prank(operator);
        dep.renew(id);
        // rev-8 behaviour intact: no checkpoint was posted, held time still pays
        assertEq(dep.earned6(operator), 600 * _runnerRate(id));
        // ... and a host that IS proving already builds its record, so it can
        // see its own coverage before the cutover can cost it anything
        _checkpoint(id, uint64(T0 + 600));
        uint64 provenUntil = dep.provenUntil(id);
        (, uint64 provenSec, uint32 proofs) = pot.recordOf(id);
        assertEq(provenUntil, T0 + 600);
        assertEq(provenSec, 600);
        assertEq(proofs, 1);
        assertEq(pot.hostedSec(operator), 600);
    }

    function test_cutoverIsADate_andTheOwnerCanMoveItBothWays() public {
        assertTrue(dep.proofRequired());
        dep.setProofRequiredFrom(0);                     // the kill switch
        assertFalse(dep.proofRequired());
        dep.setProofRequiredFrom(uint64(T0));
        assertTrue(dep.proofRequired());
        vm.prank(operator);
        vm.expectRevert("!owner");
        dep.setProofRequiredFrom(0);
    }

    function test_freshDeployRunsInGraceThenSwitchesByItself() public {
        // A brand-new ledger must not zero the income of hosts still running
        // yesterday's supervisor: it meters held time for the grace window and
        // switches on its own, with no admin step to forget.
        EnclaveDeployments fresh = new EnclaveDeployments(address(usdc), payout, address(reg), address(0));
        assertFalse(fresh.proofRequired());
        uint64 cutover = fresh.proofRequiredFrom();
        assertEq(cutover, uint64(T0) + 14 days);
        _travelTo(cutover);                                // absolute, per the warp note above
        assertTrue(fresh.proofRequired());
    }

    // ---- the core: unproven time is not paid --------------------------------

    function test_heldButUnproven_earnsNothing() public {
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        _travelTo(T0 + 600);
        dep.settle(id);
        assertEq(dep.earned6(operator), 0);          // the lease is paid; the service was not shown
        assertEq(pot.unprovenSec(id), 600);
        _assertSolvent(id);
    }

    function test_checkpointPaysExactlyWhatItProves() public {
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        uint256 r6 = _runnerRate(id);
        _travelTo(T0 + 600);
        _checkpoint(id, uint64(T0 + 600));
        assertEq(dep.earned6(operator), 600 * r6);   // credited in the same tx as the proof
        assertEq(pot.unprovenSec(id), 0);
        _assertSolvent(id);
    }

    function test_gapIsForfeit_notRetroCreditedOnReturn() public {
        // Down for 40 minutes inside a lease it kept paying for: the host
        // recovers one window of that on its return, never the whole gap.
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        uint256 r6 = _runnerRate(id);
        _travelTo(T0 + 300);
        _checkpoint(id, uint64(T0 + 300));           // last proof before going dark
        assertEq(dep.earned6(operator), 300 * r6);

        _travelTo(T0 + 1500);                        // 20 min of silence (lease runs to T0+1800)
        _checkpoint(id, uint64(T0 + 1500));
        // proven: 300 + one window, NOT 1500
        assertEq(dep.earned6(operator), (300 + WINDOW) * r6);
        uint64 provenUntil = dep.provenUntil(id);
        assertEq(provenUntil, T0 + 300 + WINDOW);
        assertEq(pot.unprovenSec(id), 1500 - 300 - WINDOW);
    }

    function test_oneCheckpointCannotBuyAWholeLease() public {
        // The property that makes this proof of TIME: a host cannot sit out the
        // lease and settle it all at the end.
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        uint64 leaseUntil = dep.get(id).leaseUntil;
        _travelTo(uint256(leaseUntil));
        _checkpoint(id, leaseUntil);
        assertEq(dep.earned6(operator), WINDOW * _runnerRate(id));  // one window, not 1800s
    }

    function test_manyCheckpointsInOneBlockCannotCompressTime() public {
        // REGRESSION (2026-07-29). The window alone bounded nothing: `base` is
        // re-read from the ledger on every call and creditProven writes it in
        // the same call, so checkpoints stacked inside ONE block each ratcheted
        // a fresh window. Twelve of them bought 10,200s of pay for zero service.
        // Every advance is now charged against the clock, so the second proof in
        // a block has a budget of zero.
        bytes32 id = _create(0, 100, 1000e6);
        _claim(id);
        uint256 r6 = _runnerRate(id);

        _travelTo(T0 + 1500);                    // 25 minutes of total silence
        _checkpoint(id, uint64(T0 + 1500));      // recovers exactly one window
        assertEq(dep.earned6(operator), WINDOW * r6);

        // ... and every further attempt in the SAME block buys nothing. Sign
        // first: expectRevert applies to the next CALL, and _checkpoint's own
        // proofDigest staticcall would otherwise absorb it.
        for (uint256 i = 0; i < 5; i++) {
            (uint64 ab, bytes32 ah, bytes memory sig) =
                _sign(proofPk, id, ENCLAVE_ID, operator, uint64(T0 + 1500));
            vm.expectRevert("nothing to prove");
            pot.checkpoint(id, ENCLAVE_ID, uint64(T0 + 1500), ab, ah, sig);
        }
        assertEq(dep.earned6(operator), WINDOW * r6, "silence stayed unpaid");
        assertEq(dep.provenUntil(id), T0 + WINDOW);
    }

    function test_oneSignatureReplayedInABatchBuysNothingExtra() public {
        // The digest commits to no watermark, so a signature IS replayable —
        // it just cannot buy a second window, because the clock has not moved.
        bytes32 id = _create(0, 100, 1000e6);
        _claim(id);
        uint256 r6 = _runnerRate(id);
        _travelTo(T0 + 1500);

        uint64 upto = uint64(T0 + 1500);
        (uint64 ab, bytes32 ah, bytes memory sig) = _sign(proofPk, id, ENCLAVE_ID, operator, upto);
        EnclaveProofOfTime.Checkpoint[] memory cps = new EnclaveProofOfTime.Checkpoint[](12);
        for (uint256 i = 0; i < 12; i++) cps[i] = EnclaveProofOfTime.Checkpoint(id, ENCLAVE_ID, upto, ab, ah, sig);
        bool[] memory landed = pot.checkpointMany(cps);

        assertTrue(landed[0]);
        for (uint256 i = 1; i < 12; i++) assertFalse(landed[i], "replay bought a window");
        assertEq(dep.earned6(operator), WINDOW * r6, "one window total, not twelve");
        (, uint64 provenSec, uint32 proofs) = pot.recordOf(id);
        assertEq(provenSec, WINDOW);
        assertEq(proofs, 1);
        assertEq(pot.hostedSec(operator), WINDOW, "reputation cannot be inflated either");
    }

    function test_provenTimeCanOnlyWalkForwardAsFastAsTheClock() public {
        // The header's property, as an assertion: between any two proofs the
        // watermark moves by at most the wall-clock time that separated them
        // (and never by more than one window). That is what makes an hour of
        // pay cost an hour, and it is what a per-call window clamp alone
        // could not deliver.
        bytes32 id = _create(0, 100, 1000e6);
        _claim(id);

        uint64 prevProven = dep.provenUntil(id);
        uint256 prevAt = block.timestamp;
        for (uint256 k = 1; k <= 5; k++) {
            uint256 step = k * 400;                       // 400s apart, inside the window
            _travelTo(T0 + step);
            vm.prank(operator);
            dep.renew(id);                                // keep the lease ahead of us
            _checkpoint(id, uint64(T0 + step));

            uint64 nowProven = dep.provenUntil(id);
            uint256 wall = block.timestamp - prevAt;
            assertLe(nowProven - prevProven, wall, "watermark outran the clock");
            prevProven = nowProven; prevAt = block.timestamp;
        }
        // proving on a steady cadence is still paid to the second
        assertEq(dep.earned6(operator), 2000 * _runnerRate(id));
    }

    function test_anHourOfPayCostsAnHourOfProofs() public {
        // The honest path, end to end: a host proving on a 10-minute cadence is
        // paid for every second of the hour it worked.
        uint256 fund = 100e6;
        bytes32 id = _create(0, 100, fund);
        _claim(id);
        uint256 r6 = _runnerRate(id);
        for (uint256 t = 600; t <= 3600; t += 600) {
            _travelTo(T0 + t);
            if (t % 1800 == 0) {                     // renew at the lease quantum, as the supervisor does
                vm.prank(operator);
                dep.renew(id);
            }
            _checkpoint(id, uint64(T0 + t));
        }
        assertEq(dep.earned6(operator), 3600 * r6);
        assertEq(pot.hostedSec(operator), 3600);
        (, uint64 provenSec, uint32 proofs) = pot.recordOf(id);
        assertEq(provenSec, 3600);
        assertEq(proofs, 6);
        _assertSolvent(id);
    }

    // ---- partial periods: the crash / early-termination case ----------------

    function test_crashMidHour_paysTheFractionServed() public {
        // THE HEADLINE CASE, on the cadence a real supervisor runs: prove every
        // 5 minutes, then the app dies 19 minutes in. Teardown proves through
        // the moment of death and THEN hands the lease back, so the host is paid
        // 19 minutes — 1140 seconds, not a rounded hour and not a rounded zero —
        // and the tenant gets the unserved tail back.
        //
        // The two calls are ORDERED, not atomic: proof and release live on
        // different contracts now, so there is no one multicall that spans
        // them. Order is what matters — release clears the watermark, so a
        // final proof after it would have nothing to settle. The supervisor's
        // operator-tx queue serializes through confirmation, which is exactly
        // the guarantee this needs.
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        uint256 r6 = _runnerRate(id);
        EnclaveDeployments.Deployment memory d0 = dep.get(id);

        for (uint256 t = 300; t <= 900; t += 300) {    // 5, 10, 15 min: the steady cadence
            _travelTo(T0 + t);
            _checkpoint(id, uint64(T0 + t));
        }
        uint64 died = uint64(T0 + 19 minutes);
        _travelTo(died);

        _checkpoint(id, died);                         // 1. settle the partial period
        vm.prank(operator);
        dep.release(id);                               // 2. hand the lease back

        assertEq(dep.earned6(operator), uint256(19 minutes) * r6);   // pro rata, to the second
        assertEq(pot.hostedSec(operator), 19 minutes);
        EnclaveDeployments.Deployment memory d = dep.get(id);
        assertEq(d.runner, bytes32(0));                              // back in the queue
        uint256 tail = uint256(d0.leaseUntil) - died;
        assertEq(d.balance6, d0.balance6 + tail * d.rate);           // unserved tail refunded whole
        _assertSolvent(id);
    }

    function test_releaseBeforeTheFinalProofLosesThePartialPeriod() public {
        // The ordering the supervisor must get right, stated as a test: release
        // clears the watermark, so a proof that arrives after it settles nothing
        // and the host eats the partial period.
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        uint256 r6 = _runnerRate(id);
        _travelTo(T0 + 600);
        _checkpoint(id, uint64(T0 + 600));
        uint64 died = uint64(T0 + 900);
        _travelTo(died);
        vm.prank(operator);
        dep.release(id);                               // released FIRST — the mistake
        assertEq(dep.provenUntil(id), 0);
        (uint64 ab, bytes32 ah, bytes memory sig) = _sign(proofPk, id, ENCLAVE_ID, operator, died);
        vm.expectRevert("not the runner");             // no lease left to prove against
        pot.checkpoint(id, ENCLAVE_ID, died, ab, ah, sig);
        assertEq(dep.earned6(operator), 600 * r6);     // the last 300s are gone
    }

    function test_aLateFinalProofOnlyRecoversOneWindow() public {
        // The same crash WITHOUT the steady cadence. A host that proved nothing
        // for 19 minutes and tries to settle it all at teardown collects one
        // window, because that is all a single checkpoint is ever worth. This
        // is the flip side of the test above: the pro rata is generous only to
        // a host that was actually proving as it went.
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        uint256 r6 = _runnerRate(id);
        uint64 died = uint64(T0 + 19 minutes);
        _travelTo(died);
        _checkpoint(id, died);
        assertEq(dep.earned6(operator), uint256(WINDOW) * r6);
        assertEq(pot.unprovenSec(id), uint64(19 minutes) - WINDOW);
    }

    function test_releaseWithoutAFinalProof_costsTheRunnerTheTail() public {
        // The incentive check: settling honestly is what pays, and skipping the
        // final checkpoint only ever hurts the runner.
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        uint256 r6 = _runnerRate(id);
        _travelTo(T0 + 600);
        _checkpoint(id, uint64(T0 + 600));
        _travelTo(T0 + 900);
        vm.prank(operator);
        dep.release(id);                             // no final proof for the last 300s
        assertEq(dep.earned6(operator), 600 * r6);
    }

    function test_deadRunnerEarnsOnlyThroughItsLastProof() public {
        // rev 8 paid a silently-dead host the whole lease quantum. Now the
        // failover claim settles it at its last checkpoint and no further.
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        uint256 r6 = _runnerRate(id);
        _travelTo(T0 + 400);
        _checkpoint(id, uint64(T0 + 400));           // ... then the box dies
        uint64 leaseUntil = dep.get(id).leaseUntil;

        _travelTo(uint256(leaseUntil) + 100);
        vm.prank(operator2);
        dep.claim(id, ENCLAVE_ID_2);                 // another enclave picks the work up
        assertEq(dep.earned6(operator), 400 * r6);   // paid for 400s of a 1800s lease
    }

    function test_failoverGivesTheNewRunnerNoInheritedProof() public {
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        _travelTo(T0 + 600);
        _checkpoint(id, uint64(T0 + 600));
        uint64 leaseUntil = dep.get(id).leaseUntil;

        _travelTo(uint256(leaseUntil) + 10);
        vm.prank(operator2);
        dep.claim(id, ENCLAVE_ID_2);
        uint64 provenUntil = dep.provenUntil(id);
        assertEq(provenUntil, block.timestamp);      // the new lease starts unproven, not pre-credited

        _travelTo(uint256(leaseUntil) + 310);
        dep.settle(id);
        assertEq(dep.earned6(operator2), 0);         // 300s held, none proven
    }

    // ---- the anchor: no pre-signing, no hoarding ----------------------------

    function test_futureAnchorRejected_soProofsCannotBePreSigned() public {
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        _travelTo(T0 + 600);
        uint64 upto = uint64(T0 + 600);
        uint64 future = uint64(block.number + 5);
        // the host would have to know a hash that does not exist yet; whatever
        // it guesses, blockhash(future) is 0 and the anchor does not match
        bytes32 guess = keccak256("tomorrow's block");
        bytes32 digest = pot.proofDigest(id, ENCLAVE_ID, operator, upto, future, guess);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(proofPk, digest);
        vm.expectRevert("stale or unknown anchor");
        pot.checkpoint(id, ENCLAVE_ID, upto, future, guess, abi.encodePacked(r, s, v));
    }

    function test_anchorExpires_soProofsCannotBeHoarded() public {
        // A checkpoint signed and then sat on is worthless once its anchor
        // leaves blockhash range — this is what bounds what a host can collect
        // after it stops serving.
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        _travelTo(T0 + 300);
        (uint64 ab, bytes32 ah, bytes memory sig) = _sign(proofPk, id, ENCLAVE_ID, operator, uint64(T0 + 300));
        _travelTo(T0 + 900);                         // 300 blocks later at 2s/block
        assertEq(blockhash(ab), bytes32(0));         // out of range
        vm.expectRevert("stale or unknown anchor");
        pot.checkpoint(id, ENCLAVE_ID, uint64(T0 + 300), ab, ah, sig);
    }

    function test_zeroAnchorHashRejected() public {
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        _travelTo(T0 + 600);
        uint64 upto = uint64(T0 + 600);
        // blockhash() of an out-of-range block is 0 too — accepting a 0 anchor
        // would let any far-past block number through
        bytes32 digest = pot.proofDigest(id, ENCLAVE_ID, operator, upto, 1, bytes32(0));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(proofPk, digest);
        vm.expectRevert("stale or unknown anchor");
        pot.checkpoint(id, ENCLAVE_ID, upto, 1, bytes32(0), abi.encodePacked(r, s, v));
    }

    // ---- the signer: only the in-CVM key ------------------------------------

    function test_operatorCannotSignForItself() public {
        // The property the whole design rests on: the host OS holds the
        // operator EOA, but not the key minted inside the CVM.
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        _travelTo(T0 + 600);
        uint64 upto = uint64(T0 + 600);
        (uint64 ab, bytes32 ah,) = _sign(proofPk, id, ENCLAVE_ID, operator, upto);
        bytes32 digest = pot.proofDigest(id, ENCLAVE_ID, operator, upto, ab, ah);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(roguePk, digest);
        vm.prank(operator);
        vm.expectRevert("bad proof signature");
        pot.checkpoint(id, ENCLAVE_ID, upto, ab, ah, abi.encodePacked(r, s, v));
    }

    function test_anotherEnclavesKeyCannotProveThisLease() public {
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        _travelTo(T0 + 600);
        uint64 upto = uint64(T0 + 600);
        (uint64 ab, bytes32 ah, bytes memory sig) = _sign(proofPk2, id, ENCLAVE_ID, operator, upto);
        vm.expectRevert("bad proof signature");
        pot.checkpoint(id, ENCLAVE_ID, upto, ab, ah, sig);
    }

    function test_proofForAnotherDeploymentDoesNotReplay() public {
        bytes32 a = _create(0, 100, 100e6);
        bytes32 b = _create(0, 100, 100e6);
        _claim(a);
        _claim(b);
        _travelTo(T0 + 600);
        uint64 upto = uint64(T0 + 600);
        (uint64 ab, bytes32 ah, bytes memory sig) = _sign(proofPk, a, ENCLAVE_ID, operator, upto);
        vm.expectRevert("bad proof signature");      // the digest binds the id
        pot.checkpoint(b, ENCLAVE_ID, upto, ab, ah, sig);
    }

    function test_checkpointForAnEnclaveThatIsNotTheRunnerReverts() public {
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        _travelTo(T0 + 600);
        uint64 upto = uint64(T0 + 600);
        (uint64 ab, bytes32 ah, bytes memory sig) = _sign(proofPk2, id, ENCLAVE_ID_2, operator2, upto);
        vm.expectRevert("not the runner");
        pot.checkpoint(id, ENCLAVE_ID_2, upto, ab, ah, sig);
    }

    function test_rotatedKeyProvesGoingForward_retiredKeyStops() public {
        // The CVM has no disk: a relaunch mints a new proof key and the enclave
        // republishes it. Proofs already accepted stand; the retired key stops.
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        uint256 r6 = _runnerRate(id);
        _travelTo(T0 + 300);
        _checkpoint(id, uint64(T0 + 300));

        address rotated = vm.addr(roguePk);
        reg.set(ENCLAVE_ID, operator, rotated);      // setProofKey at boot

        _travelTo(T0 + 600);
        (uint64 ab, bytes32 ah, bytes memory old) = _sign(proofPk, id, ENCLAVE_ID, operator, uint64(T0 + 600));
        vm.expectRevert("bad proof signature");
        pot.checkpoint(id, ENCLAVE_ID, uint64(T0 + 600), ab, ah, old);

        bytes memory fresh;
        (ab, ah, fresh) = _sign(roguePk, id, ENCLAVE_ID, operator, uint64(T0 + 600));
        pot.checkpoint(id, ENCLAVE_ID, uint64(T0 + 600), ab, ah, fresh);
        assertEq(dep.earned6(operator), 600 * r6);   // the earlier 300s were never at risk
    }

    function test_claimRefusedWithoutAProofKey_pastTheCutover() public {
        reg.set(ENCLAVE_ID, operator, address(0));
        bytes32 id = _create(0, 100, 100e6);
        vm.prank(operator);
        vm.expectRevert("no proof key");
        dep.claim(id, ENCLAVE_ID);

        dep.setProofRequiredFrom(0);               // before the cutover it is allowed
        vm.prank(operator);
        dep.claim(id, ENCLAVE_ID);
    }

    function test_malformedSignaturesRejected() public {
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        _travelTo(T0 + 600);
        uint64 upto = uint64(T0 + 600);
        (uint64 ab, bytes32 ah, bytes memory sig) = _sign(proofPk, id, ENCLAVE_ID, operator, upto);

        vm.expectRevert("bad signature length");
        pot.checkpoint(id, ENCLAVE_ID, upto, ab, ah, hex"1234");

        // high-s twin of a valid signature: a second spelling of one proof
        bytes32 r; bytes32 s; uint8 v;
        assembly { r := mload(add(sig, 32)) s := mload(add(sig, 64)) v := byte(0, mload(add(sig, 96))) }
        uint256 N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory flipped = abi.encodePacked(r, bytes32(N - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert("bad signature s");
        pot.checkpoint(id, ENCLAVE_ID, upto, ab, ah, flipped);

        pot.checkpoint(id, ENCLAVE_ID, upto, ab, ah, sig);   // the canonical one still works
    }

    function test_domainSeparatorBindsChainAndContract() public {
        bytes32 here = pot.domainSeparator();
        vm.chainId(999);
        assertTrue(pot.domainSeparator() != here);           // no cross-fork replay
        vm.chainId(8453);
        EnclaveProofOfTime other = new EnclaveProofOfTime(address(dep), address(reg));
        assertTrue(other.domainSeparator() != pot.domainSeparator());   // nor between provers
    }

    // ---- clamps and idempotence ---------------------------------------------

    function test_replayIsANoOp() public {
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        uint256 r6 = _runnerRate(id);
        _travelTo(T0 + 600);
        (uint64 ab, bytes32 ah, bytes memory sig) = _sign(proofPk, id, ENCLAVE_ID, operator, uint64(T0 + 600));
        pot.checkpoint(id, ENCLAVE_ID, uint64(T0 + 600), ab, ah, sig);
        assertEq(dep.earned6(operator), 600 * r6);
        vm.expectRevert("nothing to prove");          // the watermark already passed it
        pot.checkpoint(id, ENCLAVE_ID, uint64(T0 + 600), ab, ah, sig);
        assertEq(dep.earned6(operator), 600 * r6);
        (, uint64 provenSec, uint32 proofs) = pot.recordOf(id);
        assertEq(provenSec, 600);
        assertEq(proofs, 1);
    }

    function test_uptoAheadOfNowIsClamped_notPaidForward() public {
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        uint256 r6 = _runnerRate(id);
        _travelTo(T0 + 300);
        uint64 greedy = uint64(T0 + 3000);            // "I will have served through then"
        (uint64 ab, bytes32 ah, bytes memory sig) = _sign(proofPk, id, ENCLAVE_ID, operator, greedy);
        pot.checkpoint(id, ENCLAVE_ID, greedy, ab, ah, sig);
        uint64 provenUntil = dep.provenUntil(id);
        assertEq(provenUntil, T0 + 300);              // clamped to now
        assertEq(dep.earned6(operator), 300 * r6);
    }

    function test_provenTimeIsClampedToTheLease() public {
        // A host proving right up to the end of a lapsed lease is paid to the
        // second it expired and not one second past it: the watermark stops at
        // leaseUntil however far the checkpoint reaches.
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        uint256 r6 = _runnerRate(id);
        uint64 leaseUntil = dep.get(id).leaseUntil;    // T0 + 1800
        _travelTo(T0 + 900);
        _checkpoint(id, uint64(T0 + 900));
        _travelTo(uint256(leaseUntil) + 200);          // lapsed, unrenewed, still proving
        _checkpoint(id, uint64(leaseUntil) + 200);
        uint64 provenUntil = dep.provenUntil(id);
        assertEq(provenUntil, leaseUntil);             // clamped to what was bought
        assertEq(dep.earned6(operator), uint256(leaseUntil - T0) * r6);
        assertEq(pot.unprovenSec(id), 0);
    }

    function test_creditStillCappedByEscrow() public {
        // The rev-7 invariant survives: a proof can never promise money the
        // contract does not hold.
        EnclaveDeployments.Deployment[] memory items = new EnclaveDeployments.Deployment[](1);
        items[0].id = keccak256("imported");
        items[0].owner = user;
        items[0].appRef = "catalog://app/0";
        items[0].cpuMilli = 100;
        items[0].appPort = 8080;
        items[0].active = true;
        items[0].rate = _rate(0, 100);
        items[0].balance6 = 100e6;
        dep.importDeployments(items);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = items[0].id;
        uint256[] memory rates = new uint256[](1);
        rates[0] = (_rate(0, 100) * 8000) / 10000;
        dep.importEarn(ids, rates);

        _claim(ids[0]);
        _travelTo(T0 + 600);
        _checkpoint(ids[0], uint64(T0 + 600));
        assertEq(dep.earned6(operator), 0);           // no escrow behind it: proven, unpaid
        (, uint64 provenSec,) = pot.recordOf(ids[0]);
        assertEq(provenSec, 600);                     // the work still counts toward the record
        _assertSolvent(ids[0]);
    }

    function test_importedRecordStartsUnprovenAndUnleased() public {
        // Leases do not survive migration, so an imported record arrives with
        // no runner and a zero watermark — there is no way for it to be
        // "already proven" and no way to prove it before someone claims it.
        EnclaveDeployments.Deployment[] memory items = new EnclaveDeployments.Deployment[](1);
        items[0].id = keccak256("imported-live");
        items[0].owner = user;
        items[0].appRef = "catalog://app/0";
        items[0].cpuMilli = 100;
        items[0].appPort = 8080;
        items[0].active = true;
        items[0].rate = _rate(0, 100);
        items[0].balance6 = 100e6;
        items[0].runner = ENCLAVE_ID;                 // the source ledger had it leased ...
        items[0].runnerOperator = operator;
        items[0].leaseUntil = uint64(T0 + 1800);
        dep.importDeployments(items);

        EnclaveDeployments.Deployment memory d = dep.get(items[0].id);
        assertEq(d.runner, bytes32(0));               // ... and this one does not
        assertEq(d.leaseUntil, 0);
        uint64 provenUntil = dep.provenUntil(items[0].id);
        assertEq(provenUntil, 0);
        assertEq(pot.unprovenSec(items[0].id), 0);

        _travelTo(T0 + 60);
        uint64 upto = uint64(T0 + 60);
        (uint64 ab, bytes32 ah, bytes memory sig) = _sign(proofPk, items[0].id, ENCLAVE_ID, operator, upto);
        vm.expectRevert("not the runner");
        pot.checkpoint(items[0].id, ENCLAVE_ID, upto, ab, ah, sig);
    }

    // ---- the user's side is untouched ---------------------------------------

    function test_proofsNeverMoveUserLedgers() public {
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        EnclaveDeployments.Deployment memory d0 = dep.get(id);
        _travelTo(T0 + 600);
        _checkpoint(id, uint64(T0 + 600));
        EnclaveDeployments.Deployment memory d = dep.get(id);
        assertEq(d.balance6, d0.balance6);
        assertEq(d.spent6, d0.spent6);
        assertEq(d.leaseUntil, d0.leaseUntil);
    }

    function test_hostedSecIsPerOperator_andOnlyGrowsWithRealProofs() public {
        bytes32 a = _create(0, 100, 100e6);
        _claim(a);
        _travelTo(T0 + 600);
        _checkpoint(a, uint64(T0 + 600));
        assertEq(pot.hostedSec(operator), 600);
        assertEq(pot.hostedSec(operator2), 0);

        uint64 leaseUntil = dep.get(a).leaseUntil;
        _travelTo(uint256(leaseUntil) + 10);
        vm.prank(operator2);
        dep.claim(a, ENCLAVE_ID_2);
        _travelTo(uint256(leaseUntil) + 310);
        (uint64 ab, bytes32 ah, bytes memory sig) =
            _sign(proofPk2, a, ENCLAVE_ID_2, operator2, uint64(leaseUntil) + 310);
        pot.checkpoint(a, ENCLAVE_ID_2, uint64(leaseUntil) + 310, ab, ah, sig);
        assertEq(pot.hostedSec(operator), 600);       // unchanged
        assertEq(pot.hostedSec(operator2), 300);
    }

    function test_anyoneMayCarryAProof() public {
        // Permissionless on purpose: the signature is the authority, so a relay
        // or the tenant can land a proof for a host that is short of gas.
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        uint256 r6 = _runnerRate(id);
        _travelTo(T0 + 600);
        (uint64 ab, bytes32 ah, bytes memory sig) = _sign(proofPk, id, ENCLAVE_ID, operator, uint64(T0 + 600));
        vm.prank(makeAddr("a passing stranger"));
        pot.checkpoint(id, ENCLAVE_ID, uint64(T0 + 600), ab, ah, sig);
        assertEq(dep.earned6(operator), 600 * r6);    // and it pays the RUNNER, not the sender
    }

    // ---- parameter bounds ----------------------------------------------------

    function test_proofWindowMustStayUnderTheLeaseQuantum() public {
        vm.expectRevert("window range");
        pot.setProofWindow(1800);                     // == leaseSec: one proof would buy a whole lease
        vm.expectRevert("window range");
        pot.setProofWindow(59);
        pot.setProofWindow(1799);
        vm.prank(operator);
        vm.expectRevert("!owner");
        pot.setProofWindow(600);
    }

    function test_proverBindingIsOneShot() public {
        // A seller's proof of service must never be re-pointable at a contract
        // the platform swaps in later.
        EnclaveProofOfTime other = new EnclaveProofOfTime(address(dep), address(reg));
        vm.expectRevert("sealed");
        dep.setProver(address(other));
        assertEq(dep.prover(), address(pot));

        vm.prank(operator);
        vm.expectRevert("!owner");
        dep.setProver(address(other));
    }

    function test_onlyTheProverMayAdvanceTheWatermark() public {
        // The ledger's single prover-gated write. Everything else about proofs
        // is permissionless; this is not.
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        _travelTo(T0 + 600);
        vm.prank(operator);
        vm.expectRevert("!prover");
        dep.creditProven(id, uint64(T0 + 600));
        vm.expectRevert("!prover");
        dep.creditProven(id, uint64(T0 + 600));
        assertEq(dep.provenUntil(id), T0);            // untouched
    }

    function test_ledgerReClampsWhateverTheProverAsks() public {
        // The ledger does not trust the prover with the clamps that touch money.
        // Bind a hostile prover to a throwaway ledger and try to walk the
        // watermark into the future, past the lease, and backwards.
        EnclaveDeployments l = new EnclaveDeployments(address(usdc), payout, address(reg), address(0));
        l.setProofRequiredFrom(uint64(T0));
        l.setProver(address(this));                   // this test IS the hostile prover
        usdc.mint(user, 100e6);
        vm.startPrank(user);
        usdc.approve(address(l), type(uint256).max);
        bytes32 id = l.create("catalog://app/0", 0, 100, 8080, "", true, "", address(0), 0, ROOMY_CAP);
        l.fund(id, 100e6);
        vm.stopPrank();
        vm.prank(operator);
        l.claim(id, ENCLAVE_ID);
        uint64 leaseUntil = l.get(id).leaseUntil;

        _travelTo(T0 + 600);
        l.creditProven(id, uint64(T0 + 999999));      // "we served the next decade"
        assertEq(l.provenUntil(id), T0 + 600);        // clamped to now
        vm.expectRevert("nothing to prove");
        l.creditProven(id, uint64(T0 + 300));         // and never backwards
        _travelTo(uint256(leaseUntil) + 5000);
        l.creditProven(id, uint64(leaseUntil) + 5000);
        assertEq(l.provenUntil(id), leaseUntil);      // clamped to what the tenant bought

        // an unleased / unknown id has leaseUntil 0, so the ceiling clamp alone
        // rejects it — no separate guard in the ledger
        vm.expectRevert("nothing to prove");
        l.creditProven(keccak256("nope"), uint64(block.timestamp));
    }

    function test_withdrawPaysProvenEarnings() public {
        bytes32 id = _create(0, 100, 100e6);
        _claim(id);
        _travelTo(T0 + 600);
        _checkpoint(id, uint64(T0 + 600));
        uint256 earned = dep.earned6(operator);
        assertGt(earned, 0);
        vm.prank(operator);
        dep.withdrawEarnings(coldWallet);
        assertEq(usdc.balanceOf(coldWallet), earned);
    }
}
