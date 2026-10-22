// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {EnclaveLeaseExecutor, IEnclaveLeaseGasReserve} from "../src/EnclaveLeaseExecutor.sol";
import {EnclaveLeaseGasReserve, IRegistryR, IL1FeeOracle} from "../src/EnclaveLeaseGasReserve.sol";
import {EnclaveDeployments} from "../src/live/EnclaveDeployments.sol";
import {EnclaveRegistry} from "../src/live/EnclaveRegistry.sol";
import {SessionVault, SessionVaultFactory, ISVToken, ISVBook, ISVRouter, ISVKeyAttestations} from "../src/legacy/SessionVault.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract ExecMockFeed {
    int256 public answer = 3000e8;
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) { return (1, answer, block.timestamp, block.timestamp, 1); }
}
/// Base's GasPriceOracle predeploy shape (getL1FeeUpperBound); the value is a test constant, not a Base measurement.
contract MockL1Oracle {
    uint256 public perByte = 1_000_000;   // wei per byte of upper-bound size (test constant)
    function getL1FeeUpperBound(uint256 size) external view returns (uint256) { return size * perByte; }
}
contract MockBook { mapping(bytes32 => address) public addr; function set(bytes32 k, address a) external { addr[k] = a; } }
contract RevertingPayee { receive() external payable { revert("no"); } }
/// A delegate that is NOT the executor: it tries to drive the reserve itself.
contract RogueDelegate {
    function steal(EnclaveLeaseGasReserve r, bytes32 id) external { r.begin(id, 2, bytes32(0)); r.finish(id, payable(msg.sender), 5_000_000, 0); }
}

/// Design B against the LIVE rev-16d ledger and schema-4 registry sources, and the ORIGINAL legacy SessionVault source
/// (factory 0x1F5c... build, sha256 a447add6...). Operators are fresh keys holding no ETH, EIP-7702-delegated to the
/// executor by an authorization that rides in the relayer's call. MOCKED: USDC, the ETH/USD feed (for fundEth), the
/// L1 fee oracle (a test constant), and the book/router the SessionVault constructor stores.
abstract contract ExecBase is Test {
    uint256 constant T0 = 1_792_000_800;
    EnclaveDeployments ledger;
    EnclaveRegistry registry;
    MockUSDC usdc;
    ExecMockFeed feed;
    EnclaveLeaseGasReserve reserve;
    EnclaveLeaseExecutor executor;
    address constant L1 = 0x420000000000000000000000000000000000000F;

    address relayer = makeAddr("relayer");
    address relayer2 = makeAddr("relayer2");
    address payout = makeAddr("payout");
    uint256 constant ALICE_PK = 0xA11CE77;
    address alice = vm.addr(ALICE_PK);
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");
    uint256 constant OPA_PK = 0xA0A0A1; uint256 constant OPB_PK = 0xB0B0B2; uint256 constant OPC_PK = 0xC0C0C3;
    address opA; address opB; address opC;
    bytes32 encA; bytes32 encB; bytes32 encC;
    bytes32 A; bytes32 B; bytes32 Z;
    uint8 constant CLAIM = 1; uint8 constant RENEW = 2; uint8 constant RELEASE = 3;
    uint256 constant GASPRICE = 11_000_000;   // 0.011 gwei

    function setUp() public virtual {
        vm.warp(T0);
        vm.fee(10_000_000);
        vm.txGasPrice(GASPRICE);
        usdc = new MockUSDC();
        feed = new ExecMockFeed();
        registry = new EnclaveRegistry();
        ledger = new EnclaveDeployments(address(usdc), payout, address(registry), address(feed));
        vm.etch(L1, address(new MockL1Oracle()).code);
        vm.store(L1, bytes32(0), bytes32(uint256(1_000_000)));
        reserve = new EnclaveLeaseGasReserve(address(ledger), IRegistryR(address(registry)), IL1FeeOracle(L1),
            EnclaveLeaseGasReserve.Limits({maxGasPriceCeiling: 1 gwei, overheadClaimGas: 29_500, overheadRenewGas: 24_000, overheadReleaseGas: 7_000, minClaimInterval: 60, l1Bps: 10_000}));
        executor = new EnclaveLeaseExecutor(IEnclaveLeaseGasReserve(address(reserve)));
        reserve.bindExecutor(address(executor));
        opA = vm.addr(OPA_PK); opB = vm.addr(OPB_PK); opC = vm.addr(OPC_PK);
        encA = _register(opA, "https://a.exec.test", address(0xBEEF));
        encB = _register(opB, "https://b.exec.test", address(0xBEEF));
        encC = _register(opC, "https://c.exec.test", address(0xBEEF));
        vm.prank(carol); registry.setPayoutWallet(encC);          // carol's own box
        A = _create(alice, 6_000_000);
        B = _create(bob, 6_000_000);
        Z = _create(carol, 0);                                    // self-hosted on encC: rate 0
        _enable(alice, A, 0, true);
        _enable(bob, B, 0, true);
        _enable(carol, Z, 1, true);                               // policy: the owner's own boxes only
        vm.deal(relayer, 1 ether); vm.deal(relayer2, 1 ether);
        assertEq(opA.balance + opB.balance + opC.balance, 0);
    }

    // ---- helpers ----------------------------------------------------------------------------------------------------
    function _register(address op, string memory ep, address proofKey) internal returns (bytes32 id) {
        vm.prank(op); id = registry.register(ep, "EnclaveHost/enclave", bytes32(0), 1000, 0, proofKey);
    }
    function _create(address o, uint256 fund6) internal returns (bytes32 id) {
        vm.prank(o); id = ledger.create("catalog://app/0", 0, 500, 8080, "", true, "", address(0), 0, 1000);
        if (fund6 > 0) { usdc.mint(o, fund6); vm.prank(o); usdc.approve(address(ledger), fund6); vm.prank(o); ledger.fund(id, fund6); }
    }
    function _enable(address o, bytes32 id, uint8 policy, bool release_) internal {
        vm.deal(o, o.balance + 0.01 ether);
        vm.prank(o); reserve.deposit{value: 0.01 ether}(id);
        vm.prank(o); reserve.configure(id, _policy(policy, release_));
    }
    function _policy(uint8 policy, bool release_) internal pure returns (EnclaveLeaseGasReserve.Policy memory) {
        return EnclaveLeaseGasReserve.Policy({enabled: true, claimPolicy: policy, sponsorRelease: release_, maxClaimsPerEpoch: 4,
            maxPerOpWei: 0.0005 ether, epochCapWei: 0.003 ether, epochSec: 3600, renewWindow: 300, minExtension: 600,
            claimCooldown: 1800, maxGasPrice: 0.1 gwei});
    }
    function _lease(uint256 pk, bytes32 id, uint8 kind, bytes32 enc) internal view returns (EnclaveLeaseExecutor.Lease memory l, bytes memory sig) {
        address op = vm.addr(pk);
        uint64 n = op.code.length == 0 ? 0 : EnclaveLeaseExecutor(op).nonceOf(id);
        l = EnclaveLeaseExecutor.Lease({id: id, kind: kind, enclaveId: enc, nonce: n, deadline: uint64(vm.getBlockTimestamp() + 600)});
        bytes32 digest = _digest(op, l);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        sig = abi.encodePacked(r, s, v);
    }
    /// the EIP-712 digest as the executor computes it for `op` (verifyingContract = the operator's own address)
    function _digest(address op, EnclaveLeaseExecutor.Lease memory l) internal view returns (bytes32) {
        bytes32 ds = keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("EnclaveLeaseExecutor"), keccak256("1"), block.chainid, op));
        return keccak256(abi.encodePacked("\x19\x01", ds, keccak256(abi.encode(executor.LEASE_TYPEHASH(), address(reserve), l.id, l.kind, l.enclaveId, l.nonce, l.deadline))));
    }
    function _delegate(uint256 pk) internal { if (vm.addr(pk).code.length == 0) vm.signAndAttachDelegation(address(executor), pk); }
    /// relay one signed lease (the delegation rides along when the key is not yet delegated)
    function _relay(uint256 pk, bytes32 id, uint8 kind, bytes32 enc) internal returns (uint256 paid) {
        (EnclaveLeaseExecutor.Lease memory l, bytes memory sig) = _lease(pk, id, kind, enc);
        _delegate(pk);
        uint256 r0 = relayer.balance;
        vm.prank(relayer, relayer);
        EnclaveLeaseExecutor(vm.addr(pk)).lease(l, sig, payable(relayer));
        paid = relayer.balance - r0;
    }
    function _expectRefused(uint256 pk, bytes32 id, uint8 kind, bytes32 enc, EnclaveLeaseGasReserve.Status st) internal {
        (EnclaveLeaseExecutor.Lease memory l, bytes memory sig) = _lease(pk, id, kind, enc);
        _delegate(pk);
        (EnclaveLeaseGasReserve.Status s,,,) = reserve.statusOf(id, kind, enc, vm.addr(pk));
        assertEq(uint8(s), uint8(st), "statusOf reports exactly what begin() enforces");
        vm.prank(relayer, relayer);
        vm.expectRevert(abi.encodeWithSelector(EnclaveLeaseGasReserve.Refused.selector, st));
        EnclaveLeaseExecutor(vm.addr(pk)).lease(l, sig, payable(relayer));
    }
    function _bal(address o, bytes32 id) internal view returns (uint256) { return reserve.reserveOf(id, o).balanceWei; }
}

contract LeaseExecutorLifecycleTest is ExecBase {
    function test_zeroEthHost_claimRenewStopReleaseMove_appReservePays() public {
        uint256 b0 = _bal(alice, A);
        uint256 paid = _relay(OPA_PK, A, CLAIM, encA);
        assertEq(opA.code, abi.encodePacked(hex"ef0100", address(executor)), "delegated by its own authorization, in the relayer's call");
        EnclaveDeployments.Deployment memory d = ledger.get(A);
        assertEq(d.runnerOperator, opA); assertEq(d.leaseUntil, T0 + 1800);
        assertGt(paid, 0); assertEq(b0 - _bal(alice, A), paid, "the relayer got exactly what the app paid");
        emit log_named_uint("claim charged (wei)", paid);
        // renew inside the window
        vm.warp(d.leaseUntil - 200);
        uint256 p2 = _relay(OPA_PK, A, RENEW, bytes32(0));
        assertEq(ledger.get(A).leaseUntil, T0 + 3600);
        emit log_named_uint("renew charged (wei)", p2);
        // STOP: the owner deactivates; the runner releases with zero ETH (sponsored release); the tail is refunded
        vm.prank(alice); ledger.setActive(A, false);
        uint256 bal6 = ledger.get(A).balance6;
        uint256 p3 = _relay(OPA_PK, A, RELEASE, bytes32(0));
        assertEq(ledger.get(A).runnerOperator, address(0)); assertGt(ledger.get(A).balance6, bal6, "unused tail refunded to the app");
        emit log_named_uint("release charged (wei)", p3);
        // MOVE: reactivate; another host claims at once (a different operator is not under the churn cooldown)
        vm.prank(alice); ledger.setActive(A, true);
        _relay(OPB_PK, A, CLAIM, encB);
        assertEq(ledger.get(A).runnerOperator, opB);
        assertEq(opA.balance + opB.balance, 0, "hosts never held ETH");
        assertEq(b0 - _bal(alice, A), paid + p2 + p3 + (b0 - _bal(alice, A) - paid - p2 - p3), "every charge came from A's reserve");
        assertEq(_bal(bob, B), 0.01 ether, "B untouched");
    }

    function test_exactBoundaries_claimStrictlyAfterExpiry_renewAtExpiryInclusive() public {
        _relay(OPA_PK, A, CLAIM, encA);
        uint256 lu = ledger.get(A).leaseUntil;
        // renew: window opens at leaseUntil - 300 (inclusive), closes at leaseUntil (inclusive), like the ledger
        vm.warp(lu - 301); _expectRefused(OPA_PK, A, RENEW, bytes32(0), EnclaveLeaseGasReserve.Status.NotInRenewWindow);
        vm.warp(lu - 300); (EnclaveLeaseGasReserve.Status s,,,) = reserve.statusOf(A, RENEW, bytes32(0), opA);
        assertEq(uint8(s), uint8(EnclaveLeaseGasReserve.Status.Ready));
        vm.warp(lu); _relay(OPA_PK, A, RENEW, bytes32(0));                       // exactly at leaseUntil: still renewable
        uint256 lu2 = ledger.get(A).leaseUntil;
        assertEq(lu2, lu + 1800);
        vm.warp(lu2 + 1); _expectRefused(OPA_PK, A, RENEW, bytes32(0), EnclaveLeaseGasReserve.Status.LeaseExpired);
        // claim: refused at leaseUntil exactly (the ledger requires vm.getBlockTimestamp() > leaseUntil), allowed one second later
        vm.warp(lu2); _expectRefused(OPB_PK, A, CLAIM, encB, EnclaveLeaseGasReserve.Status.LeaseLive);
        vm.prank(opB); vm.expectRevert(bytes("leased")); ledger.claim(A, encB);   // the deployed rule, independently
        vm.warp(lu2 + 1); _relay(OPB_PK, A, CLAIM, encB);
        assertEq(ledger.get(A).runnerOperator, opB);
    }

    function test_releaseReclaimChurn_sameOperatorCooldown_globalInterval_epochCap() public {
        _relay(OPA_PK, A, CLAIM, encA);
        _relay(OPA_PK, A, RELEASE, bytes32(0));
        // the same runner re-claims at once: refused (churn), and still refused until its cooldown (1800 s) passes
        _expectRefused(OPA_PK, A, CLAIM, encA, EnclaveLeaseGasReserve.Status.ClaimCooldown);
        // another operator (a move / failover) is only held to the global interval (60 s since the last claim)
        _expectRefused(OPB_PK, A, CLAIM, encB, EnclaveLeaseGasReserve.Status.ClaimCooldown);
        vm.warp(vm.getBlockTimestamp() + 60); _relay(OPB_PK, A, CLAIM, encB);
        // two colluding operators alternating release/claim: at most one sponsored claim per minClaimInterval, and the
        // epoch cap ends it - count what they can extract in one epoch
        uint256 b0 = _bal(alice, A);
        uint256 claims;
        for (uint256 i; i < 200; i++) {
            (uint256 pk, bytes32 enc, uint256 other) = i % 2 == 0 ? (OPB_PK, encB, OPA_PK) : (OPA_PK, encA, OPB_PK);
            (EnclaveLeaseExecutor.Lease memory rl, bytes memory rs) = _lease(pk, A, RELEASE, bytes32(0));
            vm.prank(relayer, relayer);
            try EnclaveLeaseExecutor(vm.addr(pk)).lease(rl, rs, payable(relayer)) {} catch (bytes memory why) { emit log_named_bytes("release stopped", why); break; }
            vm.warp(vm.getBlockTimestamp() + 60);
            bytes32 oenc = other == OPA_PK ? encA : encB;
            (EnclaveLeaseExecutor.Lease memory cl, bytes memory cs) = _lease(other, A, CLAIM, oenc);
            vm.prank(relayer, relayer);
            try EnclaveLeaseExecutor(vm.addr(other)).lease(cl, cs, payable(relayer)) { claims++; } catch (bytes memory why) { emit log_named_bytes("claim stopped", why); break; }
            enc;
        }
        uint256 drained = b0 - _bal(alice, A);
        emit log_named_uint("colluding churn: further sponsored claims in the epoch", claims);
        emit log_named_uint("colluding churn: wei spent on it", drained);
        // the epoch already had 2 sponsored claims (A, then B); maxClaimsPerEpoch = 4 leaves 2 more, whoever asks
        assertEq(claims, 2, "maxClaimsPerEpoch ends the loop inside the epoch");
        (EnclaveLeaseGasReserve.Status st,,,) = reserve.statusOf(A, CLAIM, encA, opA);
        assertTrue(st == EnclaveLeaseGasReserve.Status.ClaimLimitReached || st == EnclaveLeaseGasReserve.Status.LeaseLive);
        assertLe(drained, 0.003 ether, "and the epoch cap bounds the money regardless");
    }

    function test_claimantPolicy_selfHostedOnly_and_allowlist() public {
        // Z (carol, self-hosted policy): host A is not carol's box
        _expectRefused(OPA_PK, Z, CLAIM, encA, EnclaveLeaseGasReserve.Status.ClaimantNotAllowed);
        _relay(OPC_PK, Z, CLAIM, encC);
        assertEq(ledger.get(Z).rate, 0, "rate 0 kept: only the gas is the app's");
        // B (bob) switches to an allowlist naming host B only
        vm.prank(bob); reserve.configure(B, _policy(2, true));
        vm.prank(bob); reserve.setClaimant(B, opB, true);
        _expectRefused(OPA_PK, B, CLAIM, encA, EnclaveLeaseGasReserve.Status.ClaimantNotAllowed);
        _relay(OPB_PK, B, CLAIM, encB);
        vm.prank(alice); vm.expectRevert(bytes("!owner")); reserve.setClaimant(B, opA, true);
    }

    function test_signatureBinding_replay_deadline_otherDeployment_rogueDelegate() public {
        (EnclaveLeaseExecutor.Lease memory l, bytes memory sig) = _lease(OPA_PK, A, CLAIM, encA);
        _delegate(OPA_PK);
        // signed by another key
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OPB_PK, _digest(opA, l));
        vm.prank(relayer, relayer); vm.expectRevert(EnclaveLeaseExecutor.BadSignature.selector);
        EnclaveLeaseExecutor(opA).lease(l, abi.encodePacked(r, s, v), payable(relayer));
        // the same signature for another deployment id
        EnclaveLeaseExecutor.Lease memory other = EnclaveLeaseExecutor.Lease({id: B, kind: l.kind, enclaveId: l.enclaveId, nonce: l.nonce, deadline: l.deadline});
        vm.prank(relayer, relayer); vm.expectRevert(EnclaveLeaseExecutor.BadSignature.selector);
        EnclaveLeaseExecutor(opA).lease(other, sig, payable(relayer));
        // past the deadline
        vm.warp(l.deadline + 1);
        vm.prank(relayer, relayer); vm.expectRevert(EnclaveLeaseExecutor.Expired.selector);
        EnclaveLeaseExecutor(opA).lease(l, sig, payable(relayer));
        vm.warp(T0);
        // valid once; replay refused by the per-deployment nonce
        vm.prank(relayer, relayer); EnclaveLeaseExecutor(opA).lease(l, sig, payable(relayer));
        // the same signed operation offered again (another relayer, still before its deadline): the nonce refuses it
        vm.prank(relayer2, relayer2); vm.expectRevert(abi.encodeWithSelector(EnclaveLeaseExecutor.BadNonce.selector, uint64(1)));
        EnclaveLeaseExecutor(opA).lease(l, sig, payable(relayer2));
        // the executor at its own address can never pass (no key signs for it)
        vm.prank(relayer, relayer); vm.expectRevert(EnclaveLeaseExecutor.BadSignature.selector);
        executor.lease(l, sig, payable(relayer));
        // a key delegated to something else cannot drive the reserve
        RogueDelegate rogue = new RogueDelegate();
        vm.signAndAttachDelegation(address(rogue), OPB_PK);
        vm.prank(relayer, relayer); vm.expectRevert(bytes("!executor"));
        RogueDelegate(opB).steal(reserve, A);
        // nonce storage: the ERC-7201 slot
        bytes32 expect = keccak256(abi.encode(uint256(keccak256("enclave.lease-executor.nonces")) - 1)) & ~bytes32(uint256(0xff));
        assertEq(uint256(vm.load(opA, keccak256(abi.encode(A, expect)))), 1, "the nonce sits in the key's own ERC-7201 namespace");
    }

    function test_revertedLedgerCall_chargesNothing_noNonceSpent() public {
        // a proof-key-less enclave past the proof cutover: the ledger reverts "no proof key"; everything reverts
        bytes32 encN = _register(opB, "https://noproof.exec.test", address(0));
        vm.warp(ledger.proofRequiredFrom() + 1);
        (EnclaveLeaseExecutor.Lease memory l, bytes memory sig) = _lease(OPB_PK, A, CLAIM, encN);
        _delegate(OPB_PK);
        uint256 b0 = _bal(alice, A); uint256 r0 = relayer.balance;
        vm.prank(relayer, relayer); vm.expectRevert(bytes("no proof key"));
        EnclaveLeaseExecutor(opB).lease(l, sig, payable(relayer));
        assertEq(_bal(alice, A), b0); assertEq(relayer.balance, r0); assertEq(EnclaveLeaseExecutor(opB).nonceOf(A), 0);
    }
}

contract LeaseExecutorMoneyTest is ExecBase {
    function test_capsAndInsufficient_revertEverything() public {
        EnclaveLeaseGasReserve.Policy memory p = _policy(0, true); p.maxPerOpWei = 1 gwei;
        vm.prank(alice); reserve.configure(A, p);   // per-op cap tiny
        (EnclaveLeaseExecutor.Lease memory l, bytes memory sig) = _lease(OPA_PK, A, CLAIM, encA);
        _delegate(OPA_PK);
        vm.prank(relayer, relayer); vm.expectRevert(bytes("over per-op cap"));
        EnclaveLeaseExecutor(opA).lease(l, sig, payable(relayer));
        assertEq(ledger.get(A).runnerOperator, address(0), "no lease without payment");
        p = _policy(0, true); p.epochCapWei = 0.0005 ether;
        vm.prank(alice); reserve.configure(A, p);
        uint256 keep = _bal(alice, A) - 1000;
        vm.prank(alice); reserve.withdraw(A, keep, payable(alice));
        vm.prank(relayer, relayer); vm.expectRevert(bytes("insufficient reserve"));
        EnclaveLeaseExecutor(opA).lease(l, sig, payable(relayer));
        vm.prank(alice); reserve.withdraw(A, 1000, payable(alice));
        (EnclaveLeaseGasReserve.Status s,,,) = reserve.statusOf(A, CLAIM, encA, opA);
        assertEq(uint8(s), uint8(EnclaveLeaseGasReserve.Status.EmptyReserve), "explicit empty-reserve state");
    }

    function test_gasPriceCappedByOwner_andCeiling() public {
        vm.txGasPrice(5 gwei);                                       // a relayer overpaying: charged at the owner's 0.1 gwei
        vm.recordLogs();
        uint256 paid = _relay(OPA_PK, A, CLAIM, encA);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) if (logs[i].topics[0] == keccak256("LeaseGasPaid(bytes32,address,address,address,uint8,uint256,uint256,uint256,uint256)")) {
            (, , uint256 gas, uint256 price, uint256 l1, uint256 charged) = abi.decode(logs[i].data, (address, uint8, uint256, uint256, uint256, uint256));
            assertEq(price, 0.1 gwei); assertEq(charged, gas * price + l1); assertEq(charged, paid);
        }
    }

    function test_transfer_oldReserveNeverCharged_newOwnerMustEnable() public {
        // transferDeployment needs no owner escrow live: a gifted deployment
        vm.prank(alice); bytes32 T = ledger.create("catalog://app/0", 0, 500, 8080, "", true, "", address(0), 0, 1000);
        usdc.mint(bob, 6_000_000); vm.prank(bob); usdc.approve(address(ledger), 6_000_000); vm.prank(bob); ledger.fundFor(T, 6_000_000, bob);
        _enable(alice, T, 0, true);
        _relay(OPA_PK, T, CLAIM, encA);
        uint256 a0 = _bal(alice, T);
        vm.prank(alice); ledger.transferDeployment(T, dave);
        vm.warp(ledger.get(T).leaseUntil - 100);
        _expectRefused(OPA_PK, T, RENEW, bytes32(0), EnclaveLeaseGasReserve.Status.Disabled);
        assertEq(_bal(alice, T), a0, "the previous owner's reserve is not charged for the new owner's lease");
        vm.prank(alice); vm.expectRevert(bytes("!owner")); reserve.configure(T, _policy(0, true));
        _enable(dave, T, 0, true);
        _relay(OPA_PK, T, RENEW, bytes32(0));
        assertLt(_bal(dave, T), 0.01 ether); assertEq(_bal(alice, T), a0);
        vm.prank(alice); reserve.withdraw(T, a0, payable(alice));
        vm.prank(dave); vm.expectRevert(bytes("short")); reserve.withdraw(T, 0.02 ether, payable(dave));
    }

    function test_statusTruthful_unknownInactiveRetiredDisabledNeverConfigured() public {
        (EnclaveLeaseGasReserve.Status s, uint256 av,,) = reserve.statusOf(keccak256("nope"), CLAIM, encA, opA);
        assertEq(uint8(s), uint8(EnclaveLeaseGasReserve.Status.Unknown)); assertEq(av, 0);
        bytes32 fresh = _create(dave, 0);   // never configured: epochSec 0 must not divide by zero
        (s,,,) = reserve.statusOf(fresh, CLAIM, encA, opA);
        assertEq(uint8(s), uint8(EnclaveLeaseGasReserve.Status.Disabled));
        vm.prank(alice); ledger.setActive(A, false);
        _expectRefused(OPA_PK, A, CLAIM, encA, EnclaveLeaseGasReserve.Status.Inactive);
        vm.prank(alice); ledger.setActive(A, true);
        _expectRefused(OPA_PK, A, RENEW, bytes32(0), EnclaveLeaseGasReserve.Status.NotRunner);
        _expectRefused(OPA_PK, A, 7, bytes32(0), EnclaveLeaseGasReserve.Status.BadKind);
        reserve.setPaused(true);
        _expectRefused(OPA_PK, A, CLAIM, encA, EnclaveLeaseGasReserve.Status.Paused);
        reserve.setPaused(false);
        reserve.setBlockedOperator(opA, true);
        _expectRefused(OPA_PK, A, CLAIM, encA, EnclaveLeaseGasReserve.Status.Blocked);
        reserve.setBlockedOperator(opA, false);
        ledger.retire();
        _expectRefused(OPA_PK, A, CLAIM, encA, EnclaveLeaseGasReserve.Status.Retired);
        // after retirement the owner still withdraws everything
        uint256 bal = _bal(alice, A); uint256 e0 = alice.balance;
        vm.prank(alice); reserve.withdraw(A, bal, payable(alice));
        assertEq(alice.balance - e0, bal);
    }

    function test_adminCannotTouchReserves_bindOnce_ceilings() public {
        vm.expectRevert(bytes("short")); reserve.withdraw(A, 1, payable(address(this)));
        vm.expectRevert(bytes("bound")); reserve.bindExecutor(address(executor));
        vm.expectRevert(bytes("ceiling")); reserve.setLimits(EnclaveLeaseGasReserve.Limits({maxGasPriceCeiling: 1 gwei, overheadClaimGas: 60_001, overheadRenewGas: 0, overheadReleaseGas: 0, minClaimInterval: 60, l1Bps: 0}));
        vm.prank(dave); vm.expectRevert(bytes("!owner")); reserve.setPaused(true);
    }

    function test_revertingPayee_revertsWholeOperation() public {
        RevertingPayee p = new RevertingPayee();
        (EnclaveLeaseExecutor.Lease memory l, bytes memory sig) = _lease(OPA_PK, A, CLAIM, encA);
        _delegate(OPA_PK);
        vm.prank(relayer, relayer); vm.expectRevert(bytes("payee"));
        EnclaveLeaseExecutor(opA).lease(l, sig, payable(address(p)));
        assertEq(ledger.get(A).runnerOperator, address(0));
    }

    function test_depositAndFundCompute_throughLedgerFundEth() public {
        uint256 b6 = ledger.get(A).balance6; uint256 r0 = _bal(alice, A);
        vm.deal(dave, 1 ether);
        vm.prank(dave); reserve.depositAndFundCompute{value: 0.02 ether}(A, 0.01 ether);
        assertEq(ledger.get(A).balance6 - b6, 30_000_000, "0.01 ETH at $3000 credited by the ledger's own fundEth");
        assertEq(_bal(alice, A) - r0, 0.01 ether, "the rest to alice's reserve (a gift to the owner of record)");
    }

    function test_twoRelayers_sameSignedOperation_exactlyOneLands() public {
        (EnclaveLeaseExecutor.Lease memory l, bytes memory sig) = _lease(OPA_PK, A, CLAIM, encA);
        _delegate(OPA_PK);
        vm.prank(relayer2, relayer2); EnclaveLeaseExecutor(opA).lease(l, sig, payable(relayer2));
        vm.prank(relayer, relayer); vm.expectRevert(abi.encodeWithSelector(EnclaveLeaseExecutor.BadNonce.selector, uint64(1)));
        EnclaveLeaseExecutor(opA).lease(l, sig, payable(relayer));
        // and a second deployment's operation by the same key is independent (its own nonce lane)
        _relay(OPA_PK, B, CLAIM, encA);
        assertEq(EnclaveLeaseExecutor(opA).nonceOf(A), 1); assertEq(EnclaveLeaseExecutor(opA).nonceOf(B), 1);
    }
}

/// The ORIGINAL SessionVault (legacy build source, verbatim): an owner reaches the reserve through ownerCall - DIRECT
/// ONLY, never signable, refused for USDC and the vault itself. No ERC-1271 and no session action is assumed.
contract LeaseExecutorSessionVaultTest is ExecBase {
    SessionVaultFactory factory;
    SessionVault vault;
    uint256 constant VOWNER_PK = 0x5E5510;
    address vowner = vm.addr(VOWNER_PK);
    bytes32 V;

    function setUp() public override {
        super.setUp();
        MockBook book = new MockBook();
        book.set("deployments", address(ledger));
        factory = new SessionVaultFactory(ISVToken(address(usdc)), ISVBook(address(book)), ISVRouter(address(0xBEEF)), ISVKeyAttestations(address(0)), 250_000_000);
        vault = SessionVault(factory.createVault(vowner));
        assertTrue(factory.isVault(address(vault)));
        assertEq(vault.owner(), vowner);
        // the vault creates a deployment through ownerCall: the vault is the owner of record
        vm.prank(vowner);
        bytes memory ret = vault.ownerCall(address(ledger), abi.encodeWithSignature(
            "create(string,uint16,uint16,uint32,string,bool,string,address,uint256,uint256)",
            "catalog://app/0", uint16(0), uint16(500), uint32(8080), "", true, "", address(0), uint256(0), uint256(1000)));
        V = abi.decode(ret, (bytes32));
        assertEq(ledger.get(V).owner, address(vault));
        // compute funded by anyone (fundFor attributes refundable escrow to the payer, never moving the vault's)
        usdc.mint(vowner, 6_000_000); vm.prank(vowner); usdc.approve(address(ledger), 6_000_000);
        vm.prank(vowner); ledger.fundFor(V, 6_000_000, vowner);
    }

    function test_sessionVaultOwnedDeployment_fund_configure_sponsor_withdraw() public {
        // funding needs no vault action: the owner's wallet deposits for the vault (the owner of record)
        vm.deal(vowner, 1 ether);
        vm.prank(vowner); reserve.deposit{value: 0.01 ether}(V);
        assertEq(_bal(address(vault), V), 0.01 ether);
        // configure: only the owner of record, i.e. the vault, reached through the owner's direct ownerCall
        vm.prank(vowner); vm.expectRevert(bytes("!owner"));
        reserve.configure(V, _policy(0, true));
        vm.prank(vowner);
        vault.ownerCall(address(reserve), abi.encodeCall(reserve.configure, (V, _policy(0, true))));
        // nobody else can drive the vault
        vm.prank(dave); vm.expectRevert(SessionVault.NotOwner.selector);
        vault.ownerCall(address(reserve), abi.encodeCall(reserve.withdraw, (V, 1, payable(dave))));
        // a host claims, the VAULT's reserve pays
        uint256 paid = _relay(OPA_PK, V, CLAIM, encA);
        assertEq(_bal(address(vault), V), 0.01 ether - paid);
        // refund: to the owner's wallet (the vault cannot receive ETH: sending there reverts, nothing moves)
        uint256 left = _bal(address(vault), V);
        vm.prank(vowner); vm.expectRevert(bytes("send"));
        vault.ownerCall(address(reserve), abi.encodeCall(reserve.withdraw, (V, left, payable(address(vault)))));
        uint256 e0 = vowner.balance;
        vm.prank(vowner); vault.ownerCall(address(reserve), abi.encodeCall(reserve.withdraw, (V, left, payable(vowner))));
        assertEq(vowner.balance - e0, left);
        assertEq(_bal(address(vault), V), 0);
    }
}
