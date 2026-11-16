// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {EnclaveDeployments} from "../../EnclaveDeployments.sol";
import {EnclaveRegistry} from "../../EnclaveRegistry.sol";
import {EnclaveProofOfCapacity} from "../../EnclaveProofOfCapacity.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// EnclaveProofOfCapacity as the prover of the REAL ledger and registry: a host is credited only while it is in
/// standing (checked by others or, alone, by itself; and having checked the others).
contract ProofOfCapacityTest is Test {
    EnclaveDeployments dep; EnclaveRegistry reg; EnclaveProofOfCapacity poc; MockUSDC token;
    uint64 constant T = 1_800_000_000 - (1_800_000_000 % 3600);   // an epoch boundary
    uint64 constant EPOCH = 3600;
    address payer = address(0x100); address treasury = address(0x300);
    uint256 blockNo = 1000;

    struct Host { bytes32 id; uint256 key; address operator; bytes32 app; }
    Host[] hosts;

    function setUp() public {
        vm.warp(T); vm.roll(blockNo);
        token = new MockUSDC(); reg = new EnclaveRegistry();
        dep = new EnclaveDeployments(address(token), treasury, address(reg), address(0));
        poc = new EnclaveProofOfCapacity(address(dep), address(reg), 900, EPOCH, 600, 2);
        dep.setProver(address(poc)); dep.setProofRequiredFrom(T);
        token.mint(payer, 100_000e6);
        vm.prank(payer); token.approve(address(dep), type(uint256).max);
        for (uint256 i = 0; i < 4; i++) _addHost(i);
    }

    function _addHost(uint256 i) internal {
        Host memory h; h.key = 0xA000 + i; h.operator = address(uint160(0x2000 + i));
        vm.prank(h.operator);
        h.id = reg.register(string.concat("https://host", vm.toString(i), ".example"), "repo", bytes32(0), 10000, 10000, vm.addr(h.key));
        vm.prank(payer);
        h.app = dep.create(string.concat("catalog://app/", vm.toString(i)), 0, 1000, 8000, "", true, "", address(0), 0, 10000);
        vm.prank(payer); dep.fund(h.app, 1000e6);
        hosts.push(h);
    }

    // ---- helpers -----------------------------------------------------------------------------------------------
    function _sig(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest); return abi.encodePacked(r, s, v);
    }
    function _to(uint64 t) internal { blockNo += 50; vm.warp(t); vm.roll(blockNo); vm.setBlockhash(blockNo - 1, keccak256(abi.encode("b", blockNo))); }
    function _epochStart(uint64 e) internal pure returns (uint64) { return e * EPOCH; }
    function _lease(uint256 i) internal {
        Host memory h = hosts[i];
        EnclaveDeployments.Deployment memory d = dep.get(h.app);
        vm.startPrank(h.operator);
        if (d.runner == bytes32(0) || d.leaseUntil < block.timestamp) dep.claim(h.app, h.id); else dep.renew(h.app);
        vm.stopPrank();
    }
    function _self(uint256 i) internal {
        Host memory h = hosts[i]; bytes32 seed = poc.touch(); uint64 e = poc.epochNow();
        poc.proveSelf(h.id, bytes32("self"), _sig(h.key, poc.selfDigest(e, h.id, seed, bytes32("self"))));
    }
    function _report(uint256 checker, uint256 target, uint64 epoch, uint8 verdict) internal {
        Host memory c = hosts[checker];
        poc.report(epoch, c.id, hosts[target].id, verdict, bytes32("ev"),
            _sig(c.key, poc.reportDigest(epoch, c.id, hosts[target].id, verdict, poc.seedOf(epoch), bytes32("ev"))));
    }
    function _checkpointCall(uint256 i) internal returns (bytes memory call) {
        Host memory h = hosts[i]; uint64 upto = uint64(block.timestamp); bytes32 anchor = blockhash(blockNo - 1);
        return abi.encodeCall(poc.checkpoint, (h.app, h.id, upto, uint64(blockNo - 1), anchor,
            _sig(h.key, poc.proofDigest(h.app, h.id, h.operator, upto, uint64(blockNo - 1), anchor))));
    }
    function _checkpoint(uint256 i) internal { this.checkpointExternal(_checkpointCall(i)); }
    function _refused(uint256 i, string memory why) internal { bytes memory c = _checkpointCall(i); vm.expectRevert(bytes(why)); this.checkpointExternal(c); }
    /// a report refused with `why`: `key` signs `signedVerdict` over `seed`, and `verdict` is what is submitted
    function _reportRefused(string memory why, uint64 epoch, bytes32 checker, bytes32 target, uint8 verdict, uint256 key, uint8 signedVerdict, bytes32 seed) internal {
        bytes memory sig = _sig(key, poc.reportDigest(epoch, checker, target, signedVerdict, seed, bytes32("ev")));
        vm.expectRevert(bytes(why)); poc.report(epoch, checker, target, verdict, bytes32("ev"), sig);
    }
    function checkpointExternal(bytes calldata call) external { (bool ok, bytes memory ret) = address(poc).call(call); if (!ok) assembly ("memory-safe") { revert(add(ret, 32), mload(ret)) } }
    function _earned(uint256 i) internal view returns (uint256) { return dep.earned6(hosts[i].operator); }
    function _indexOf(bytes32 id) internal view returns (uint256) { for (uint256 i = 0; i < hosts.length; i++) if (hosts[i].id == id) return i; revert("unknown host"); }

    /// An epoch in which hosts 0..n-1 all hold a lease, prove themselves and are credited: the next epoch's roster.
    function _bootstrap(uint256 n) internal returns (uint64 e) {
        _to(T + 10); e = poc.epochNow();
        for (uint256 i = 0; i < n; i++) _lease(i);
        _to(T + 600);
        for (uint256 i = 0; i < n; i++) { _self(i); _checkpoint(i); }
    }
    /// Every host of the roster reports `pass` on every host it was assigned, in `epoch` (which must be current).
    function _allPass(uint64 epoch, uint256 n) internal {
        poc.touch();
        for (uint256 c = 0; c < n; c++) {
            bytes32[] memory ts = poc.targetsOf(epoch, hosts[c].id);
            for (uint256 j = 0; j < ts.length; j++) _report(c, _indexOf(ts[j]), epoch, 1);
        }
    }

    // ---- a lone host ---------------------------------------------------------------------------------------------
    function testLoneHostNeedsItsOwnProofThenIsPaid() public {
        _to(T + 10); _lease(0); _to(T + 600);
        _refused(0, "needs its own proof of capacity");
        assertEq(_earned(0), 0);
        _self(0); _checkpoint(0);
        assertGt(_earned(0), 0);
        uint64 e = poc.epochNow();
        assertEq(poc.rosterSize(e + 1), 1); assertEq(poc.rosterPos(e + 1, hosts[0].id), 1);
        // alone on the roster of the next epoch: nobody to check, nobody checking; its own proof again
        _to(_epochStart(e + 1) + 300); _lease(0); _to(_epochStart(e + 1) + 900);
        assertEq(poc.checkersIn(e + 1), 0);
        _refused(0, "needs its own proof of capacity");
        _self(0); _checkpoint(0);
        // and the epoch after that, still alone
        _to(_epochStart(e + 2) + 300); _lease(0); _to(_epochStart(e + 2) + 900);
        _refused(0, "needs its own proof of capacity");
        _self(0); _checkpoint(0);
    }

    function testASelfProofIsOnlyTheHostsOwnKeyAndOnlyThisEpoch() public {
        _to(T + 10); _lease(0); _to(T + 600);
        bytes32 seed = poc.touch(); uint64 e = poc.epochNow();
        bytes32 d = poc.selfDigest(e, hosts[0].id, seed, bytes32("self"));
        vm.expectRevert(bytes("bad self-proof signature")); poc.proveSelf(hosts[0].id, bytes32("self"), _sig(hosts[1].key, d));
        bytes memory good = _sig(hosts[0].key, d);
        poc.proveSelf(hosts[0].id, bytes32("self"), good);
        _to(_epochStart(e + 1) + 300);
        vm.expectRevert(bytes("bad self-proof signature")); poc.proveSelf(hosts[0].id, bytes32("self"), good);   // another seed
        assertFalse(poc.selfProved(e + 1, hosts[0].id));
    }

    // ---- two hosts check each other ------------------------------------------------------------------------------
    function testTwoHostsCheckEachOtherAndNeedNoSelfProofAfterThat() public {
        uint64 e = _bootstrap(2);
        // epoch e+1: both on the roster, one checker each (the other); not yet checked, so their own proof once more
        _to(_epochStart(e + 1) + 300); _lease(0); _lease(1); _to(_epochStart(e + 1) + 900);
        poc.touch();
        assertEq(poc.checkersIn(e + 1), 1);
        assertEq(poc.checkersOf(e + 1, hosts[0].id)[0], hosts[1].id);
        assertEq(poc.targetsOf(e + 1, hosts[0].id)[0], hosts[1].id);
        _self(0); _self(1); _checkpoint(0); _checkpoint(1);
        _allPass(e + 1, 2);
        // epoch e+2: checked by the other and having checked it: in standing with no proof of their own
        _to(_epochStart(e + 2) + 300); _lease(0); _lease(1); _to(_epochStart(e + 2) + 900);
        (bool ok, ) = poc.standing(hosts[0].id, e + 2); assertTrue(ok);
        uint256 before = _earned(0);
        _checkpoint(0); _checkpoint(1);
        assertGt(_earned(0), before);
    }

    function testAHostThatDidNotCheckIsNotPaidAndTheOneItSkippedFallsBackOnItsOwnProof() public {
        uint64 e = _bootstrap(2);
        _to(_epochStart(e + 1) + 300); _lease(0); _lease(1); _to(_epochStart(e + 1) + 900);
        _self(0); _self(1); _checkpoint(0); _checkpoint(1);
        _report(0, 1, e + 1, 1);                       // host 0 checks host 1; host 1 checks nobody
        _to(_epochStart(e + 2) + 300); _lease(0); _lease(1); _to(_epochStart(e + 2) + 900);
        _refused(1, "did not check the hosts it was assigned");
        _self(1); _refused(1, "did not check the hosts it was assigned");   // its own proof does not buy off the duty
        _refused(0, "needs its own proof of capacity");                     // nobody reported on host 0
        _self(0); _checkpoint(0);
    }

    function testUnreachableIsDutyDoneAndTheDeadHostLeavesTheRoster() public {
        uint64 e = _bootstrap(2);
        // epoch e+1: host 1 is dead (no lease, no checkpoint, no report); host 0 reports it unreachable
        _to(_epochStart(e + 1) + 300); _lease(0); _to(_epochStart(e + 1) + 900);
        _self(0); _checkpoint(0);
        _report(0, 1, e + 1, 3);
        assertEq(poc.rosterSize(e + 2), 1);            // only host 0 was credited in e+1
        assertEq(poc.rosterPos(e + 2, hosts[1].id), 0);
        // epoch e+2: host 0 did its duty; nobody vouched for it; its own proof
        _to(_epochStart(e + 2) + 300); _lease(0); _to(_epochStart(e + 2) + 900);
        _refused(0, "needs its own proof of capacity");
        _self(0); _checkpoint(0);
        // the dead host coming back in e+2 was still on the roster of e+1 and checked nobody then: not this epoch
        _lease(1); _to(_epochStart(e + 2) + 1500);
        _self(1); _refused(1, "did not check the hosts it was assigned");
        // in e+3 it is a new host: on no roster, no duty held against it, its own proof
        _to(_epochStart(e + 3) + 300); _lease(1); _to(_epochStart(e + 3) + 900);
        _refused(1, "needs its own proof of capacity");
        _self(1); _checkpoint(1);
    }

    // ---- a fail needs more than one checker ----------------------------------------------------------------------
    function testOneFailIsNotEnoughTwoAre() public {
        uint64 e = _bootstrap(4);
        _to(_epochStart(e + 1) + 300); for (uint256 i = 0; i < 4; i++) _lease(i);
        _to(_epochStart(e + 1) + 900); poc.touch();
        for (uint256 i = 0; i < 4; i++) { _self(i); _checkpoint(i); }
        assertEq(poc.checkersIn(e + 1), 2);
        bytes32[] memory checkers = poc.checkersOf(e + 1, hosts[0].id);
        assertEq(checkers.length, 2); assertTrue(checkers[0] != checkers[1] && checkers[0] != hosts[0].id && checkers[1] != hosts[0].id);
        uint256 c0 = _indexOf(checkers[0]); uint256 c1 = _indexOf(checkers[1]);
        // everyone does their duty; host 0 gets one fail and one pass
        for (uint256 c = 0; c < 4; c++) {
            bytes32[] memory ts = poc.targetsOf(e + 1, hosts[c].id);
            for (uint256 j = 0; j < ts.length; j++) {
                uint256 t = _indexOf(ts[j]);
                _report(c, t, e + 1, (t == 0 && c == c0) ? 2 : 1);
            }
        }
        _to(_epochStart(e + 2) + 300); for (uint256 i = 0; i < 4; i++) _lease(i);
        _to(_epochStart(e + 2) + 900); poc.touch();
        _refused(0, "needs its own proof of capacity");   // one fail: not out, but a pass beside a fail is not enough
        _self(0); _checkpoint(0);
        for (uint256 i = 1; i < 4; i++) _checkpoint(i);   // the others: passes only
        // epoch e+2: both of host 0's checkers fail it
        checkers = poc.checkersOf(e + 2, hosts[0].id); c0 = _indexOf(checkers[0]); c1 = _indexOf(checkers[1]);
        for (uint256 c = 0; c < 4; c++) {
            bytes32[] memory ts = poc.targetsOf(e + 2, hosts[c].id);
            for (uint256 j = 0; j < ts.length; j++) {
                uint256 t = _indexOf(ts[j]);
                _report(c, t, e + 2, (t == 0 && (c == c0 || c == c1)) ? 2 : 1);
            }
        }
        _to(_epochStart(e + 3) + 300); for (uint256 i = 0; i < 4; i++) _lease(i);
        _to(_epochStart(e + 3) + 900);
        _refused(0, "failed its capacity checks");
        _self(0); _refused(0, "failed its capacity checks");   // its own word does not outweigh two checkers
        uint256 before = _earned(0);
        for (uint256 i = 1; i < 4; i++) _checkpoint(i);
        assertEq(_earned(0), before);
        // the failed host is still on the roster of e+3: it keeps checking the others, and this time they pass it
        _allPass(e + 3, 4);
        // one epoch: in e+4 it is paid again (checked and having checked), though not credited in e+3
        _to(_epochStart(e + 4) + 300); _lease(0); _to(_epochStart(e + 4) + 900);
        assertEq(poc.rosterPos(e + 4, hosts[0].id), 0);
        _checkpoint(0);
        assertGt(_earned(0), before);
    }

    // ---- reports -------------------------------------------------------------------------------------------------
    function testAReportIsTheAssignedCheckersOnceAndInItsEpoch() public {
        uint64 e = _bootstrap(2);
        _to(_epochStart(e + 1) + 900); bytes32 seed = poc.touch();
        bytes32 a = hosts[0].id; bytes32 b = hosts[1].id;
        // a host that is not on the roster is nobody's checker
        _reportRefused("not assigned", e + 1, hosts[2].id, a, 1, hosts[2].key, 1, seed);
        // nor a host its own
        _reportRefused("not assigned", e + 1, a, a, 1, hosts[0].key, 1, seed);
        // the target cannot sign its checker's verdict, and a verdict is one of three
        _reportRefused("bad report signature", e + 1, b, a, 1, hosts[0].key, 1, seed);
        _reportRefused("bad verdict", e + 1, b, a, 4, hosts[1].key, 4, seed);
        // a signature over one verdict does not carry another
        _reportRefused("bad report signature", e + 1, b, a, 1, hosts[1].key, 2, seed);
        _report(1, 0, e + 1, 2);
        assertEq(poc.verdictOf(e + 1, b, a), 2);
        _reportRefused("already reported", e + 1, b, a, 1, hosts[1].key, 1, seed);
        // within the grace after its epoch a report still lands; after it, not
        _to(_epochStart(e + 2) + 590); _report(0, 1, e + 1, 1);
        assertEq(poc.verdictOf(e + 1, a, b), 1);
        _to(_epochStart(e + 2) + 610);
        _reportRefused("epoch closed", e, b, a, 1, hosts[1].key, 1, poc.seedOf(e));
    }

    function testAnEpochNobodyTouchedHasNoSeedAndTakesNoLateReport() public {
        uint64 e = _bootstrap(2);
        _to(_epochStart(e + 2) + 300);   // nothing happened in e+1
        assertEq(poc.seedOf(e + 1), bytes32(0));
        _reportRefused("epoch has no seed", e + 1, hosts[1].id, hosts[0].id, 1, hosts[1].key, 1, bytes32(0));
    }

    // ---- the proof of time is unchanged ----------------------------------------------------------------------------
    function testTimeCannotBeCompressedAndAnotherKeyProvesNothing() public {
        _to(T + 10); _lease(0); _to(T + 600); _self(0);
        bytes memory call = _checkpointCall(0);
        (bool ok, ) = address(poc).call(call); assertTrue(ok);
        uint256 once = _earned(0);
        vm.expectRevert(bytes("nothing to prove")); this.checkpointExternal(call);   // the same signature again
        assertEq(_earned(0), once);
        Host memory h = hosts[0]; uint64 upto = uint64(block.timestamp); bytes32 anchor = blockhash(blockNo - 1);
        bytes memory wrongKey = _sig(hosts[1].key, poc.proofDigest(h.app, h.id, h.operator, upto, uint64(blockNo - 1), anchor));
        vm.expectRevert(bytes("bad proof signature"));
        poc.checkpoint(h.app, h.id, upto, uint64(blockNo - 1), anchor, wrongKey);
        bytes memory otherAnchor = _sig(h.key, poc.proofDigest(h.app, h.id, h.operator, upto, uint64(blockNo - 1), bytes32("other")));
        vm.expectRevert(bytes("stale or unknown anchor"));
        poc.checkpoint(h.app, h.id, upto, uint64(blockNo - 1), bytes32("other"), otherAnchor);
    }

    function testCheckpointManyLandsWhatIsInStandingAndReportsTheRest() public {
        _to(T + 10); _lease(0); _lease(1); _to(T + 600); _self(0);
        EnclaveProofOfCapacity.Checkpoint[] memory cps = new EnclaveProofOfCapacity.Checkpoint[](2);
        for (uint256 i = 0; i < 2; i++) {
            Host memory h = hosts[i]; uint64 upto = uint64(block.timestamp); bytes32 anchor = blockhash(blockNo - 1);
            cps[i] = EnclaveProofOfCapacity.Checkpoint(h.app, h.id, upto, uint64(blockNo - 1), anchor,
                _sig(h.key, poc.proofDigest(h.app, h.id, h.operator, upto, uint64(blockNo - 1), anchor)));
        }
        bool[] memory landed = poc.checkpointMany(cps);
        assertTrue(landed[0]); assertFalse(landed[1]);
        assertGt(_earned(0), 0); assertEq(_earned(1), 0);
    }

    // ---- the three signed messages, as the hosts' code builds them (network/proof-of-capacity.mjs is held to these) ----
    function testDigestVectors() public {
        vm.chainId(8453);
        EnclaveProofOfCapacity fixed_ = EnclaveProofOfCapacity(address(0x00000000000000000000000000000000000c0ffe));
        vm.etch(address(fixed_), address(poc).code);
        bytes32 a = bytes32(uint256(0xA1)); bytes32 b = bytes32(uint256(0xB2)); bytes32 seed = keccak256("seed"); bytes32 ev = keccak256("evidence");
        assertEq(fixed_.reportDigest(495000, a, b, 1, seed, ev), 0x13391c317e45a647fc8a1cffaab5b38edec71610cbaa1af9dbacd49a8903f6ba);
        assertEq(fixed_.selfDigest(495000, a, seed, ev), 0xf0fb7c458454ef71aa272c79ecaa7ffe4aa67625218ced2da664dfc85e13ff80);
        assertEq(fixed_.proofDigest(b, a, address(0x1234), 1800000600, 1099, keccak256("anchor")), 0x8fe5b3045f7eb0e314870e125f23b10bd185ac176491b4a77413810c17ebd70d);
    }

    // ---- who checks whom -------------------------------------------------------------------------------------------
    function testAssignmentIsSymmetricDistinctAndNeverAHostItself() public {
        uint64 e = _bootstrap(4);
        _to(_epochStart(e + 1) + 300); poc.touch();
        uint32[] memory o = poc.offsetsOf(e + 1);
        assertEq(o.length, 2); assertTrue(o[0] != o[1] && o[0] >= 1 && o[0] <= 3 && o[1] >= 1 && o[1] <= 3);
        for (uint256 t = 0; t < 4; t++) {
            bytes32[] memory cs = poc.checkersOf(e + 1, hosts[t].id);
            assertEq(cs.length, 2);
            for (uint256 j = 0; j < 2; j++) {
                assertTrue(cs[j] != hosts[t].id);
                bytes32[] memory back = poc.targetsOf(e + 1, cs[j]);
                assertTrue(back[0] == hosts[t].id || back[1] == hosts[t].id);
            }
        }
        // a host that is not on the roster checks nobody and is checked by nobody
        _addHost(4);
        assertEq(poc.checkersOf(e + 1, hosts[4].id).length, 0);
        assertEq(poc.targetsOf(e + 1, hosts[4].id).length, 0);
    }
}
