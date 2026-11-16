// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {EnclaveDeployments} from "../../EnclaveDeployments.sol";
import {EnclaveRegistry} from "../../EnclaveRegistry.sol";
import {EnclaveProofOfCapacity} from "../../EnclaveProofOfCapacity.sol";
import {EnclaveHostExecutor} from "../../EnclaveHostExecutor.sol";
import {EnclaveLeaseExecutor, IEnclaveLeaseGasReserve} from "../../EnclaveLeaseExecutor.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// a reserve whose ledger is a fixed address that only answers usdc() (for the digest vector)
contract LedgerAt { address public usdc; constructor(address u) { usdc = u; } }
contract ReserveStubAt { address public ledger; constructor(address at, address usdc_) { ledger = at; bytes memory code = address(new LedgerAt(usdc_)).code; address a = at; Vm(address(uint160(uint256(keccak256("hevm cheat code"))))).etch(a, code); Vm(address(uint160(uint256(keccak256("hevm cheat code"))))).store(a, bytes32(0), bytes32(uint256(uint160(usdc_)))); } }
contract ReserveStub { address public ledger; constructor(address l) { ledger = l; } function begin(bytes32, uint8, bytes32) external {} function finish(bytes32, address payable, uint256, uint256, uint256, bool) external {} }

/// EnclaveHostExecutor as the code of a host's operator key (the key's account carries the executor's runtime, as an
/// EIP-7702 delegation makes it), against the real ledger, registry and capacity prover: a host with no ETH is
/// credited, and the carrier is paid out of what the carried calls unlocked.
contract HostExecutorTest is Test {
    EnclaveDeployments dep; EnclaveRegistry reg; EnclaveProofOfCapacity poc; MockUSDC token; EnclaveHostExecutor code;
    uint64 constant T = 1_800_000_000 - (1_800_000_000 % 3600);
    uint256 constant OP_KEY = 0xB0B0; uint256 constant PROOF_KEY = 0xA11CE;
    address operator; address payer = address(0x100); address treasury = address(0x300);
    address carrier = address(0xCA11); address payout = address(0xC01D);
    bytes32 host; bytes32 app; uint256 blockNo = 1000;
    uint64 nowT = T;   // the time the test set (block.timestamp read after a warp is not reliable under via-IR)

    function setUp() public {
        vm.warp(T); vm.roll(blockNo); operator = vm.addr(OP_KEY);
        token = new MockUSDC(); reg = new EnclaveRegistry();
        dep = new EnclaveDeployments(address(token), treasury, address(reg), address(0));
        poc = new EnclaveProofOfCapacity(address(dep), address(reg), 900, 3600, 600, 2);
        dep.setProver(address(poc)); dep.setProofRequiredFrom(T);
        code = new EnclaveHostExecutor(IEnclaveLeaseGasReserve(address(new ReserveStub(address(dep)))));
        vm.prank(operator); host = reg.register("https://host.example", "repo", bytes32(0), 10000, 10000, vm.addr(PROOF_KEY));
        token.mint(payer, 10_000e6);
        vm.startPrank(payer); token.approve(address(dep), type(uint256).max);
        app = dep.create("catalog://app/0", 0, 1000, 8000, "", true, "", address(0), 0, 10000); dep.fund(app, 1000e6); vm.stopPrank();
        vm.prank(operator); dep.claim(app, host);          // (the claim itself is the lease path's business, not tested here)
        vm.etch(operator, address(code).code);             // the operator key now runs the executor
        _to(T + 600);
        assertEq(operator.balance, 0);
    }

    function _to(uint64 t) internal { nowT = t; blockNo += 50; vm.warp(t); vm.roll(blockNo); vm.setBlockhash(blockNo - 1, keccak256(abi.encode("b", blockNo))); }
    function _sig(uint256 key, bytes32 digest) internal pure returns (bytes memory) { (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest); return abi.encodePacked(r, s, v); }
    function exec() internal view returns (EnclaveHostExecutor) { return EnclaveHostExecutor(operator); }

    /// the calls of one round of a lone host: fix the seed, its own proof of capacity, its checkpoint
    function _round() internal returns (bytes[] memory calls) {
        uint64 e = poc.epochNow();
        bytes32 seed = poc.seedOf(e);
        if (seed == bytes32(0)) seed = keccak256(abi.encode(blockhash(block.number - 1), e, address(poc)));   // what touch() will fix
        uint64 upto = nowT; bytes32 anchor = blockhash(blockNo - 1);
        calls = new bytes[](3);
        calls[0] = abi.encodeCall(poc.touch, ());
        calls[1] = abi.encodeCall(poc.proveSelf, (host, bytes32("self"), _sig(PROOF_KEY, poc.selfDigest(e, host, seed, bytes32("self")))));
        calls[2] = abi.encodeCall(poc.checkpoint, (app, host, upto, uint64(blockNo - 1), anchor,
            _sig(PROOF_KEY, poc.proofDigest(app, host, operator, upto, uint64(blockNo - 1), anchor))));
    }
    function _order(bytes[] memory calls, uint256 fee6, address payee, address to) internal view returns (EnclaveHostExecutor.Carry memory c) {
        c = EnclaveHostExecutor.Carry(address(poc), keccak256(abi.encode(calls)), exec().carryNonce(), nowT + 300, payee, fee6, to);
    }
    function _signed(EnclaveHostExecutor.Carry memory c, uint256 key) internal view returns (bytes memory) { return _sig(key, exec().carryDigest(c)); }

    function testAHostWithNoEthIsCreditedAndTheCarrierIsPaidFromWhatWasUnlocked() public {
        bytes[] memory calls = _round();
        EnclaveHostExecutor.Carry memory c = _order(calls, 20_000, carrier, payout);
        bytes memory sig = _signed(c, OP_KEY);
        vm.prank(carrier); exec().carry(c, calls, sig);
        assertEq(token.balanceOf(carrier), 20_000);
        assertGt(token.balanceOf(payout), 0);
        assertEq(dep.earned6(operator), 0);                 // everything the key earned left the ledger
        assertEq(token.balanceOf(operator), 0);             // and none of it stayed on the key
        assertEq(operator.balance, 0);                      // which never held any ETH
        assertEq(exec().carryNonce(), 1);
        assertGt(dep.provenUntil(app), T);
    }

    function testAFeeLargerThanWhatWasUnlockedRevertsEverything() public {
        bytes[] memory calls = _round();
        EnclaveHostExecutor.Carry memory c = _order(calls, 1_000_000e6, carrier, payout);
        bytes memory sig = _signed(c, OP_KEY);
        uint64 provenBefore = dep.provenUntil(app);
        vm.prank(carrier); vm.expectPartialRevert(EnclaveHostExecutor.FeeNotCovered.selector); exec().carry(c, calls, sig);
        assertEq(exec().carryNonce(), 0); assertEq(dep.provenUntil(app), provenBefore); assertEq(token.balanceOf(carrier), 0);
        assertFalse(poc.selfProved(poc.epochNow(), host));
    }

    function testTheFeeNeverComesOutOfEarlierEarnings() public {
        // a first round leaves earnings on the ledger (no fee, no payout: nothing is withdrawn)
        bytes[] memory calls = _round();
        EnclaveHostExecutor.Carry memory c = _order(calls, 0, address(0), address(0));
        bytes memory sig = _signed(c, OP_KEY);
        vm.prank(carrier); exec().carry(c, calls, sig);
        uint256 kept = dep.earned6(operator); assertGt(kept, 0); assertEq(token.balanceOf(operator), 0);
        // an order that unlocks nothing new cannot spend them
        bytes[] memory idle = new bytes[](1); idle[0] = abi.encodeCall(poc.touch, ());
        c = _order(idle, 1, carrier, payout); sig = _signed(c, OP_KEY);
        vm.prank(carrier); vm.expectPartialRevert(EnclaveHostExecutor.FeeNotCovered.selector); exec().carry(c, idle, sig);
        assertEq(dep.earned6(operator), kept);
        // with no fee, the same order may pay the earlier earnings out to where the key says
        c = _order(idle, 0, address(0), payout); sig = _signed(c, OP_KEY);
        vm.prank(carrier); exec().carry(c, idle, sig);
        assertEq(token.balanceOf(payout), kept); assertEq(dep.earned6(operator), 0);
    }

    function testOnlyTheKeysOwnOrderTheseCallsOnceAndInTime() public {
        bytes[] memory calls = _round();
        EnclaveHostExecutor.Carry memory c = _order(calls, 20_000, carrier, payout);
        bytes memory sig = _signed(c, OP_KEY);
        // another key's signature
        bytes memory forged = _signed(c, 0xBAD);
        vm.expectRevert(EnclaveLeaseExecutor.BadSignature.selector); exec().carry(c, calls, forged);
        // other calls than the ones signed for (the carrier drops the checkpoint, or adds one)
        bytes[] memory fewer = new bytes[](2); fewer[0] = calls[0]; fewer[1] = calls[1];
        vm.expectRevert(EnclaveLeaseExecutor.BadSignature.selector); exec().carry(c, fewer, sig);
        // a changed fee, payee or payout
        EnclaveHostExecutor.Carry memory other = _order(calls, 30_000, carrier, payout);
        vm.expectRevert(EnclaveLeaseExecutor.BadSignature.selector); exec().carry(other, calls, sig);
        other = _order(calls, 20_000, carrier, carrier);
        vm.expectRevert(EnclaveLeaseExecutor.BadSignature.selector); exec().carry(other, calls, sig);
        // too late
        uint256 snap = vm.snapshotState(); vm.warp(nowT + 301);
        vm.expectRevert(EnclaveLeaseExecutor.Expired.selector); exec().carry(c, calls, sig);
        vm.revertToState(snap);
        // once
        vm.prank(carrier); exec().carry(c, calls, sig);
        vm.expectPartialRevert(EnclaveLeaseExecutor.BadNonce.selector); exec().carry(c, calls, sig);
        // nothing to carry
        bytes[] memory none = new bytes[](0); c = _order(none, 0, address(0), address(0)); sig = _signed(c, OP_KEY);
        vm.expectRevert(EnclaveHostExecutor.NothingToCarry.selector); exec().carry(c, none, sig);
    }

    function testTheNamedCarrierIsPaidWhoeverSendsAndWithNoneNamedTheSenderIs() public {
        bytes[] memory calls = _round();
        EnclaveHostExecutor.Carry memory c = _order(calls, 20_000, carrier, address(0));
        bytes memory sig = _signed(c, OP_KEY);
        vm.prank(address(0xD00D)); exec().carry(c, calls, sig);          // copied and sent by another
        assertEq(token.balanceOf(carrier), 20_000); assertEq(token.balanceOf(address(0xD00D)), 0);
        assertGt(token.balanceOf(operator), 0);                          // no payout named: the rest stays with the key
        // the next round, to whoever carries it
        _to(nowT + 600);
        bytes[] memory next = new bytes[](1);
        uint64 upto = nowT; bytes32 anchor = blockhash(blockNo - 1);
        next[0] = abi.encodeCall(poc.checkpoint, (app, host, upto, uint64(blockNo - 1), anchor, _sig(PROOF_KEY, poc.proofDigest(app, host, operator, upto, uint64(blockNo - 1), anchor))));
        c = _order(next, 5_000, address(0), address(0)); sig = _signed(c, OP_KEY);
        vm.prank(address(0xD00D)); exec().carry(c, next, sig);
        assertEq(token.balanceOf(address(0xD00D)), 5_000);
    }

    function testACallThatFailsTakesTheWholeOrderWithIt() public {
        // the checkpoint without the host's own proof: not in standing
        bytes[] memory all = _round();
        bytes[] memory calls = new bytes[](2); calls[0] = all[0]; calls[1] = all[2];
        EnclaveHostExecutor.Carry memory c = _order(calls, 20_000, carrier, payout);
        bytes memory sig = _signed(c, OP_KEY);
        vm.prank(carrier); vm.expectPartialRevert(EnclaveHostExecutor.CallFailed.selector); exec().carry(c, calls, sig);
        assertEq(exec().carryNonce(), 0); assertEq(poc.seedOf(poc.epochNow()), bytes32(0));
    }

    /// what the hosts' code signs (network/host-carry.mjs is held to the same two values)
    function testCarryDigestVector() public {
        vm.chainId(8453);
        address op = vm.addr(0xB0B0);                       // the operator key of this test, as the JS test derives it
        EnclaveHostExecutor fixedCode = new EnclaveHostExecutor(IEnclaveLeaseGasReserve(address(new ReserveStubAt(address(0xD1), address(token)))));
        vm.etch(op, address(fixedCode).code);
        bytes[] memory calls = new bytes[](2); calls[0] = hex"1234"; calls[1] = hex"abcdef";
        assertEq(keccak256(abi.encode(calls)), 0x235b07881835fd59445003e4559948b717643ee0ab15498b1e39e9ed94fcdd9a);
        EnclaveHostExecutor.Carry memory c = EnclaveHostExecutor.Carry(address(0x00000000000000000000000000000000000c0ffe), keccak256(abi.encode(calls)),
            7, 1800000900, address(0xCA11), 20000, address(0xC01D));
        assertEq(EnclaveHostExecutor(op).carryDigest(c), 0x8a06fb9d66f388e5ec836faaaacfa805b529860d23a681cd24605ed9fb2894f1);
    }

    function testTheLeasePathIsTheInheritedOne() public view {
        assertEq(exec().LEASE_TYPEHASH(), EnclaveLeaseExecutor(address(code)).LEASE_TYPEHASH());
        assertEq(exec().ledger(), address(dep)); assertEq(address(exec().usdc()), address(token));
        assertEq(exec().nonceOf(app), 0);
    }
}
