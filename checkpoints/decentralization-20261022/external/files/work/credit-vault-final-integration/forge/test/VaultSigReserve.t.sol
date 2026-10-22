// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CreditVaultBase, IProdVault} from "./Base.sol";
import {Vm} from "forge-std/Test.sol";
import {EnclaveLeaseGasReserveSig, IRegistryR as IRegistryR2, IL1FeeOracle as IL1FeeOracle2} from "../src/proposal/EnclaveLeaseGasReserveSig.sol";
import {EnclaveLeaseGasReserve, IRegistryR, IL1FeeOracle} from "../src/main/EnclaveLeaseGasReserve.sol";
import {EnclaveLeaseExecutor, IEnclaveLeaseGasReserve} from "../src/main/EnclaveLeaseExecutor.sol";
import {EnclaveDeployments} from "../src/live/EnclaveDeployments.sol";

/// Base's GasPriceOracle predeploy shape; the per-byte value is a test constant (the live reserve has l1Bps 10000).
contract MockL1Oracle { function getL1FeeUpperBound(uint256 size) external pure returns (uint256) { return size * 1_000_000; } }

/// The PARALLEL signature reserve (proposal/EnclaveLeaseGasReserveSig.sol) beside an instance of the LIVE reserve
/// (main 1d173473, as deployed at 0x12A3f873...), both with the live constructor values (limits 1 gwei / 65000 / 55000 /
/// 36000 / 60 / 10000, the Base L1 oracle address). The PRODUCTION credit-vault bytecode (d36100ae), the live rev-16d
/// ledger, the unmodified EnclaveLeaseExecutor (one instance per reserve), real P-256 WebAuthn assertions, EIP-7702 hosts.
/// The OLDER credit-vault build (factory 0x848a..., implementation 0xaf81..., 2026-07-21) runs from its actual runtime bytes
/// read from Base (fixtures/credit-vault-older-impl-0xaf81.runtime.hex) at its real address.
contract VaultSigReserveTest is CreditVaultBase {
    address constant L1 = 0x420000000000000000000000000000000000000F;
    address constant OLD_IMPL = 0xaf81A59492409aB717afCE6E72A425Bdb2FAC507;
    address constant OLD_FACTORY = 0x848a8A89c3452Ce7Dc14764114a8c5886B6F0c08;
    uint256 constant OPA_PK = 0xA0A0A1;
    uint256 constant ALICE_PK = 0xA11CE5;
    uint256 constant GASPRICE = 11_000_000;
    EnclaveLeaseGasReserve live;      // an instance of the live reserve's code
    EnclaveLeaseExecutor liveExec;
    EnclaveLeaseGasReserveSig r2;    // the proposal
    EnclaveLeaseExecutor r2Exec;
    address opA; bytes32 encA;
    address alice; bytes32 aid;
    address payee = makeAddr("payee");
    bytes32 oldCloneHash;
    uint256 r2CreationGas; uint256 e2CreationGas;

    function setUp() public {
        _baseSetUp();
        vm.fee(10_000_000); vm.txGasPrice(GASPRICE);
        vm.etch(L1, address(new MockL1Oracle()).code);
        live = new EnclaveLeaseGasReserve(address(ledger), IRegistryR(address(registry)), IL1FeeOracle(L1), _liveLimits());
        liveExec = new EnclaveLeaseExecutor(IEnclaveLeaseGasReserve(address(live)));
        live.bindExecutor(address(liveExec));
        oldCloneHash = keccak256(abi.encodePacked(hex"363d3d373d3d3d363d73", OLD_IMPL, hex"5af43d82803e903d91602b57fd5bf3"));
        bytes32[] memory refused = new bytes32[](1); refused[0] = oldCloneHash;
        uint256 g = gasleft();
        r2 = new EnclaveLeaseGasReserveSig(address(ledger), IRegistryR2(address(registry)), IL1FeeOracle2(L1), _sigLimits(), refused);
        r2CreationGas = g - gasleft(); g = gasleft();
        r2Exec = new EnclaveLeaseExecutor(IEnclaveLeaseGasReserve(address(r2)));
        e2CreationGas = g - gasleft();
        r2.bindExecutor(address(r2Exec));
        opA = vm.addr(OPA_PK);
        vm.prank(opA); encA = registry.register("https://a.host.test", "EnclaveHost/enclave", bytes32(0), 1000, 0, address(0));
        // an EOA app enrolled in the LIVE reserve, as the 11 live enrollments are
        alice = vm.addr(ALICE_PK); vm.deal(alice, 1 ether);
        vm.startPrank(alice);
        aid = ledger.create("catalog://app/1", 0, 500, 8080, "", true, "", address(0), 0, 1000);
        live.deposit{value: 0.01 ether}(aid); live.configure(aid, _livePolicy());
        vm.stopPrank();
        usdc.mint(alice, 6e6); vm.startPrank(alice); usdc.approve(address(ledger), 6e6); ledger.fund(aid, 6e6); vm.stopPrank();
        vm.deal(makeAddr("gifter"), 1 ether);
        vm.prank(makeAddr("gifter")); r2.deposit{value: 0.01 ether}(vid);   // anyone may fund the vault-owned app's gas
    }

    function _liveLimits() internal pure returns (EnclaveLeaseGasReserve.Limits memory) {
        return EnclaveLeaseGasReserve.Limits({maxGasPriceCeiling: 1 gwei, overheadClaimGas: 65_000, overheadRenewGas: 55_000, overheadReleaseGas: 36_000, minClaimInterval: 60, l1Bps: 10_000});
    }
    function _sigLimits() internal pure returns (EnclaveLeaseGasReserveSig.Limits memory) {
        return EnclaveLeaseGasReserveSig.Limits({maxGasPriceCeiling: 1 gwei, overheadClaimGas: 65_000, overheadRenewGas: 55_000, overheadReleaseGas: 36_000, minClaimInterval: 60, l1Bps: 10_000});
    }
    function _livePolicy() internal pure returns (EnclaveLeaseGasReserve.Policy memory) {
        return EnclaveLeaseGasReserve.Policy({enabled: true, claimPolicy: 0, sponsorRelease: true, maxClaimsPerEpoch: 4, maxPerOpWei: 0.001 ether,
            epochCapWei: 0.005 ether, epochSec: 3600, renewWindow: 300, minExtension: 600, claimCooldown: 1800, maxGasPrice: 0.05 gwei});
    }
    function policy() internal pure returns (EnclaveLeaseGasReserveSig.Policy memory) {
        return EnclaveLeaseGasReserveSig.Policy({enabled: true, claimPolicy: 0, sponsorRelease: true, maxClaimsPerEpoch: 4, maxPerOpWei: 0.001 ether,
            epochCapWei: 0.005 ether, epochSec: 3600, renewWindow: 300, minExtension: 600, claimCooldown: 1800, maxGasPrice: 0.05 gwei});
    }
    function cfgSig(EnclaveLeaseGasReserveSig r, uint256 pk, bytes32 id, EnclaveLeaseGasReserveSig.Policy memory p, uint256 dl, string memory origin) internal view returns (bytes memory) {
        address o = ledger.get(id).owner;
        return abi.encode(sigFrom(pk, r.configureDigest(id, o, p, r.sigNonce(r.budgetKey(id, o)), dl), origin));
    }
    function enroll() internal returns (uint256 gasUsed) {
        uint256 dl = block.timestamp + 300;
        bytes memory s = cfgSig(r2, PK1, vid, policy(), dl, ORIGIN);
        vm.prank(relayer); uint256 g = gasleft(); r2.configureBySig(vid, policy(), dl, s); gasUsed = g - gasleft();
    }
    /// one signed lease by opA through whatever executor opA is delegated to (`delegateTo`), relayed by `relayer`
    function lease(address delegateTo, address reserveAddr, bytes32 id, uint8 kind, bytes32 enc) internal returns (bool ok, uint256 paid) {
        address op = opA;
        uint64 n = op.code.length == 0 ? 0 : EnclaveLeaseExecutor(op).nonceOf(id);
        EnclaveLeaseExecutor.Lease memory l = EnclaveLeaseExecutor.Lease({id: id, kind: kind, enclaveId: enc, nonce: n, deadline: uint64(block.timestamp + 600),
            payee: payee, maxChargeWei: 0.001 ether});
        bytes32 ds = keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("EnclaveLeaseExecutor"), keccak256("1"), block.chainid, op));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", ds, keccak256(abi.encode(EnclaveLeaseExecutor(delegateTo).LEASE_TYPEHASH(), reserveAddr, l.id, l.kind,
            l.enclaveId, l.nonce, l.deadline, l.payee, l.maxChargeWei))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OPA_PK, digest);
        if (op.code.length == 0 || keccak256(op.code) != keccak256(abi.encodePacked(hex"ef0100", delegateTo))) vm.signAndAttachDelegation(delegateTo, OPA_PK);
        uint256 p0 = payee.balance;
        vm.txGasPrice(GASPRICE);              // isolate mode: each top-level call is its own transaction, at this gas price
        vm.prank(relayer, relayer);
        (ok,) = op.call(abi.encodeCall(EnclaveLeaseExecutor.lease, (l, abi.encodePacked(r, s, v))));
        paid = payee.balance - p0;
    }

    /// negative control: with INJECT_FAILURE=true the suite must fail
    function test_injectedFailure() public view { assertFalse(vm.envOr("INJECT_FAILURE", false), "injected failure"); }

    function test_vaultPasskeyEnrollsInTheParallelReserve_zeroEthHostClaims_reservePaysExactly() public {
        (EnclaveLeaseGasReserveSig.Status st0,,,) = r2.statusOf(vid, 1, encA, opA);
        assertEq(uint8(st0), uint8(EnclaveLeaseGasReserveSig.Status.Disabled));
        uint256 vn = vault.nonce(); uint256 vu = usdc.balanceOf(address(vault));
        uint256 g = enroll();
        emit log_named_uint("gas: configureBySig (production vault passkey, WebAuthn P-256)", g);
        assertTrue(r2.reserveOf(vid, address(vault)).enabled);
        assertEq(vault.nonce(), vn, "ERC-1271 is a view: no vault op, no vault nonce");
        assertEq(usdc.balanceOf(address(vault)), vu, "closed-loop credit untouched");
        assertEq(opA.balance, 0);
        uint256 b0 = r2.reserveOf(vid, address(vault)).balanceWei;
        vm.recordLogs();
        (bool ok, uint256 paid) = lease(address(r2Exec), address(r2), vid, 1, encA);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("LeaseGasPaid(bytes32,address,address,address,uint8,uint256,uint256,uint256,uint256)");
        for (uint256 i; i < logs.length; i++) if (logs[i].emitter == address(r2) && logs[i].topics[0] == topic) {
            (, , uint256 gasCharged, uint256 price, uint256 l1, uint256 charged) = abi.decode(logs[i].data, (address, uint8, uint256, uint256, uint256, uint256));
            emit log_named_uint("claim: gas units charged (measured + intrinsic + calldata + overhead + authorization)", gasCharged);
            emit log_named_uint("claim: gas price applied by finish() in this forge run (isolate mode)", price);
            emit log_named_uint("claim: L1 share (test oracle constant)", l1);
            assertEq(charged, paid, "the event's charge is what the relayer received");
        }
        assertTrue(ok, "claim through the parallel executor");
        assertEq(ledger.get(vid).runnerOperator, opA);
        assertEq(b0 - r2.reserveOf(vid, address(vault)).balanceWei, paid, "the vault-owned app's reserve paid exactly the relayer");
        assertGt(paid, 0); assertEq(opA.balance, 0);
        emit log_named_uint("claim charged to the vault-owned app (wei, test L1 constant)", paid);
    }

    /// The live reserve is never touched: its enrollment, balance and code stay as they were, and it still refuses the vault.
    function test_liveReserveAndItsEnrollmentAreUntouched() public {
        bytes32 codeBefore = keccak256(address(live).code);
        EnclaveLeaseGasReserve.Reserve memory before_ = live.reserveOf(aid, alice);
        enroll();
        uint256 dl = block.timestamp + 300;
        bytes32 wd = r2.withdrawDigest(vid, address(vault), 0.001 ether, makeAddr("dest"), r2.sigNonce(r2.budgetKey(vid, address(vault))), dl);
        bytes memory wsig = abi.encode(sig(PK1, wd));     // signatures first: sha256 is a precompile CALL (it would take the prank)
        vm.prank(relayer); r2.withdrawBySig(vid, address(vault), 0.001 ether, payable(makeAddr("dest")), dl, wsig);
        EnclaveLeaseGasReserve.Reserve memory after_ = live.reserveOf(aid, alice);
        assertEq(after_.balanceWei, before_.balanceWei); assertEq(after_.enabled, before_.enabled); assertEq(after_.maxPerOpWei, before_.maxPerOpWei);
        assertEq(keccak256(address(live).code), codeBefore);
        assertFalse(live.reserveOf(vid, address(vault)).enabled, "the live reserve still cannot be enabled for the vault");
        vm.prank(relayer); vm.expectRevert(bytes("!owner")); live.configure(vid, _livePolicy());
    }

    /// One operator key, one delegation: while opA is delegated to the PARALLEL executor it cannot run the live reserve's
    /// leases, and the other way round. Switching back costs an authorization the executor does not charge again.
    function test_hostDelegationIsExclusivePerExecutor() public {
        enroll();
        // first, a live-reserve claim for alice's app (opA delegated to the live executor; the authorization is charged once)
        (bool ok1, uint256 paid1) = lease(address(liveExec), address(live), aid, 1, encA);
        assertTrue(ok1, "live claim");
        vm.warp(block.timestamp + 3600);   // the first lease has lapsed
        // re-delegated to the parallel executor: the vault-owned app's claim works ...
        (bool ok2,) = lease(address(r2Exec), address(r2), vid, 1, encA);
        assertTrue(ok2, "parallel claim after re-delegation");
        // ... and while so delegated, a live-reserve lease signed for the LIVE executor cannot run (opA executes the
        // parallel executor's code, which only asks ITS reserve - alice is not enrolled there)
        vm.warp(block.timestamp + 3600);
        EnclaveLeaseExecutor.Lease memory l = EnclaveLeaseExecutor.Lease({id: aid, kind: 1, enclaveId: encA, nonce: EnclaveLeaseExecutor(opA).nonceOf(aid),
            deadline: uint64(block.timestamp + 600), payee: payee, maxChargeWei: 0.001 ether});
        bytes32 ds = keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("EnclaveLeaseExecutor"), keccak256("1"), block.chainid, opA));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OPA_PK, keccak256(abi.encodePacked("\x19\x01", ds, keccak256(abi.encode(liveExec.LEASE_TYPEHASH(), address(live), l.id,
            l.kind, l.enclaveId, l.nonce, l.deadline, l.payee, l.maxChargeWei)))));
        vm.prank(relayer, relayer);
        (bool ok3, bytes memory ret3) = opA.call(abi.encodeCall(EnclaveLeaseExecutor.lease, (l, abi.encodePacked(r, s, v))));
        assertFalse(ok3, "no live-reserve lease while delegated to the parallel executor");
        // opA runs the PARALLEL executor's code, whose digest names ITS reserve: a lease signed for the live reserve does not verify
        assertEq(bytes4(ret3), EnclaveLeaseExecutor.BadSignature.selector);
        // and a lease signed for the parallel reserve for alice's app is refused there: she is enrolled only in the live one
        EnclaveLeaseExecutor.Lease memory l2 = EnclaveLeaseExecutor.Lease({id: aid, kind: 1, enclaveId: encA, nonce: EnclaveLeaseExecutor(opA).nonceOf(aid),
            deadline: uint64(block.timestamp + 600), payee: payee, maxChargeWei: 0.001 ether});
        (v, r, s) = vm.sign(OPA_PK, keccak256(abi.encodePacked("\x19\x01", ds, keccak256(abi.encode(r2Exec.LEASE_TYPEHASH(), address(r2), l2.id,
            l2.kind, l2.enclaveId, l2.nonce, l2.deadline, l2.payee, l2.maxChargeWei)))));
        vm.prank(relayer, relayer);
        (bool ok3b, bytes memory ret3b) = opA.call(abi.encodeCall(EnclaveLeaseExecutor.lease, (l2, abi.encodePacked(r, s, v))));
        assertFalse(ok3b);
        assertEq(keccak256(ret3b), keccak256(abi.encodeWithSelector(EnclaveLeaseGasReserveSig.Refused.selector, EnclaveLeaseGasReserveSig.Status.Disabled)));
        // back to the live executor: it runs again, but its one-time authorization was charged before, so this switch's
        // authorization gas is NOT reimbursed (the relayer bears it)
        (bool ok4, uint256 paid4) = lease(address(liveExec), address(live), aid, 1, encA);
        assertTrue(ok4, "live claim after switching back");
        assertLt(paid4, paid1, "the switch-back charge carries no authorization gas (charged only on the first lease per executor)");
        emit log_named_uint("live claim, first (with charged authorization) wei", paid1);
        emit log_named_uint("live claim after switching back (authorization not reimbursed) wei", paid4);
    }

    /// The OLDER credit-vault build (2026-07-21) does not check the signing origin: an assertion made on ANY page under
    /// enclave.host is valid for it. The parallel reserve therefore refuses its signatures outright (constructor-pinned
    /// code hash), whatever the origin; the current build checks the origin and is accepted.
    function test_olderVaultBuildHasNoOriginCheck_andItsSignaturesAreRefused() public {
        vm.etch(OLD_IMPL, vm.parseBytes(vm.readFile("fixtures/credit-vault-older-impl-0xaf81.runtime.hex")));
        address oldVault = makeAddr("older-credit-vault");
        vm.etch(oldVault, abi.encodePacked(hex"363d3d373d3d3d363d73", OLD_IMPL, hex"5af43d82803e903d91602b57fd5bf3"));
        assertEq(keccak256(oldVault.code), oldCloneHash);
        vm.prank(OLD_FACTORY); IOldVault(oldVault).initialize(x1, y1);
        assertEq(IOldVault(oldVault).factory(), OLD_FACTORY);
        bytes32 d = keccak256("any digest");
        string memory evil = "https://evil.app.enclave.host";
        assertEq(IProdVault(oldVault).isValidSignature(d, abi.encode(sigFrom(PK1, d, evil))), bytes4(0x1626ba7e), "OLDER build: a foreign-origin assertion is VALID");
        assertEq(vault.isValidSignature(d, abi.encode(sigFrom(PK1, d, evil))), bytes4(0xffffffff), "current build: refused");
        // a record owned by the older vault (none exists live; the reserve must not depend on that)
        vm.prank(oldVault); bytes32 oid = ledger.create("catalog://app/old", 0, 500, 8080, "", true, "", address(0), 0, 1000);
        uint256 dl = block.timestamp + 300;
        for (uint256 i; i < 2; i++) {
            string memory origin = i == 0 ? ORIGIN : evil;
            bytes memory s = abi.encode(sigFrom(PK1, r2.configureDigest(oid, oldVault, policy(), 0, dl), origin));
            assertEq(IProdVault(oldVault).isValidSignature(r2.configureDigest(oid, oldVault, policy(), 0, dl), s), bytes4(0x1626ba7e));
            vm.prank(relayer); vm.expectRevert(bytes("signer code refused")); r2.configureBySig(oid, policy(), dl, s);
        }
        vm.prank(makeAddr("gifter")); r2.deposit{value: 0.001 ether}(oid);
        bytes memory w = abi.encode(sigFrom(PK1, r2.withdrawDigest(oid, oldVault, 0.001 ether, makeAddr("thief"), 0, dl), evil));
        vm.prank(relayer); vm.expectRevert(bytes("signer code refused")); r2.withdrawBySig(oid, oldVault, 0.001 ether, payable(makeAddr("thief")), dl, w);
        assertTrue(r2.signerCodeRefused(oldCloneHash));
    }

    /// Owner-authorized withdraw: the existing withdraw() keeps its exact semantics; withdrawBySig needs a SIGNED recipient
    /// (no default, never zero or the reserve), and is keyed to the signer's own reserve like withdraw() to msg.sender.
    function test_withdrawSemantics() public {
        enroll();
        uint256 dl = block.timestamp + 300;
        address dest = makeAddr("owner-chosen");
        for (uint256 i; i < 2; i++) {
            address payable bad = payable(i == 0 ? address(0) : address(r2));
            bytes32 d = r2.withdrawDigest(vid, address(vault), 0.001 ether, bad, r2.sigNonce(r2.budgetKey(vid, address(vault))), dl);
            bytes memory bs = abi.encode(sig(PK1, d));
            vm.prank(relayer); vm.expectRevert(bytes("to")); r2.withdrawBySig(vid, address(vault), 0.001 ether, bad, dl, bs);
        }
        bytes32 wd = r2.withdrawDigest(vid, address(vault), 0.002 ether, dest, r2.sigNonce(r2.budgetKey(vid, address(vault))), dl);
        bytes memory ws = abi.encode(sig(PK1, wd));
        vm.prank(relayer); vm.expectRevert(bytes("bad signature")); r2.withdrawBySig(vid, address(vault), 0.002 ether, payable(relayer), dl, ws);
        vm.prank(relayer); uint256 g = gasleft(); r2.withdrawBySig(vid, address(vault), 0.002 ether, payable(dest), dl, ws); g -= gasleft();
        emit log_named_uint("gas: withdrawBySig", g);
        assertEq(dest.balance, 0.002 ether);
        // the plain withdraw() is unchanged: keyed to msg.sender, so the relayer (or anyone) has nothing to take
        vm.prank(relayer); vm.expectRevert(bytes("short")); r2.withdraw(vid, 1, payable(relayer));
        // and an EOA owner's own withdraw on the parallel reserve works exactly as on the live one
        vm.startPrank(alice); r2.deposit{value: 0.003 ether}(aid); r2.withdraw(aid, 0.003 ether, payable(alice)); vm.stopPrank();
        // the vault itself cannot receive ETH: a signed withdrawal TO the vault reverts and moves nothing
        bytes32 wv = r2.withdrawDigest(vid, address(vault), 0.001 ether, address(vault), r2.sigNonce(r2.budgetKey(vid, address(vault))), dl);
        bytes memory vs = abi.encode(sig(PK1, wv));
        vm.prank(relayer); vm.expectRevert(bytes("send")); r2.withdrawBySig(vid, address(vault), 0.001 ether, payable(address(vault)), dl, vs);
    }

    function test_protections_replay_deadline_chain_instance_removedKey_origin_tamper_record_eoa() public {
        uint256 dl = block.timestamp + 300;
        bytes memory s = cfgSig(r2, PK1, vid, policy(), dl, ORIGIN);
        // tampered policy (a relay raising the per-op cap)
        EnclaveLeaseGasReserveSig.Policy memory p = policy(); p.maxPerOpWei = 0.005 ether;
        vm.prank(relayer); vm.expectRevert(bytes("bad signature")); r2.configureBySig(vid, p, dl, s);
        // another reserve instance
        bytes32[] memory none = new bytes32[](0);
        EnclaveLeaseGasReserveSig other = new EnclaveLeaseGasReserveSig(address(ledger), IRegistryR2(address(registry)), IL1FeeOracle2(L1), _sigLimits(), none);
        vm.prank(relayer); vm.expectRevert(bytes("bad signature")); other.configureBySig(vid, policy(), dl, s);
        // another chain
        uint256 snap = vm.snapshotState(); vm.chainId(84532);
        vm.prank(relayer); vm.expectRevert(bytes("bad signature")); r2.configureBySig(vid, policy(), dl, s);
        vm.revertToState(snap);
        // another origin
        bytes memory se = cfgSig(r2, PK1, vid, policy(), dl, "https://evil.app.enclave.host");
        vm.prank(relayer); vm.expectRevert(bytes("bad signature")); r2.configureBySig(vid, policy(), dl, se);
        // valid once; replay refused
        vm.prank(relayer); r2.configureBySig(vid, policy(), dl, s);
        vm.prank(relayer); vm.expectRevert(bytes("bad signature")); r2.configureBySig(vid, policy(), dl, s);
        // expired
        bytes memory s2 = cfgSig(r2, PK1, vid, policy(), dl, ORIGIN);
        vm.warp(dl + 1);
        vm.prank(relayer); vm.expectRevert(bytes("expired")); r2.configureBySig(vid, policy(), dl, s2);
        // removed passkey: K1 adds K2, K2 removes K1; K1 refused, K2 accepted
        dl = block.timestamp + 300;
        (uint256 x2, uint256 y2) = vm.publicKeyP256(PK2);
        IProdVault.WebAuthnSig memory w = sig(PK1, addKeyDigest(x2, y2, dl)); vm.prank(relayer); vault.addKey(x2, y2, dl, w);
        bytes32 kh1 = keccak256(abi.encode(x1, y1));
        IProdVault.WebAuthnSig memory w2 = sig(PK2, removeKeyDigest(kh1, dl)); vm.prank(relayer); vault.removeKey(kh1, dl, w2);
        bytes memory s1 = cfgSig(r2, PK1, vid, policy(), dl, ORIGIN);
        vm.prank(relayer); vm.expectRevert(bytes("bad signature")); r2.configureBySig(vid, policy(), dl, s1);
        bytes memory sk2 = cfgSig(r2, PK2, vid, policy(), dl, ORIGIN);
        vm.prank(relayer); r2.configureBySig(vid, policy(), dl, sk2);
        // the signature names its record
        bytes memory cc = createCall("catalog://app/2", 1000);
        IProdVault.WebAuthnSig memory w3 = sig(PK2, deployDigest(cc, 0, dl)); vm.prank(relayer); bytes32 vid2 = vault.deployAndFund(cc, 0, dl, w3);
        bytes memory forFirst = cfgSig(r2, PK2, vid, policy(), dl, ORIGIN);
        vm.prank(relayer); vm.expectRevert(bytes("bad signature")); r2.configureBySig(vid2, policy(), dl, forFirst);
        // an EOA owner: no signature path, the direct one unchanged
        vm.prank(relayer); vm.expectRevert(bytes("owner is not a contract")); r2.configureBySig(aid, policy(), dl, s);
        vm.prank(alice); r2.configure(aid, policy());
        vm.prank(relayer); vm.expectRevert(bytes("!owner")); r2.configure(vid, policy());
    }

    function test_claimantBySig_andGasFigures() public {
        uint256 gc = enroll();
        uint256 dl = block.timestamp + 300;
        bytes32 cd = r2.claimantDigest(vid, address(vault), opA, true, r2.sigNonce(r2.budgetKey(vid, address(vault))), dl);
        bytes memory cs = abi.encode(sig(PK1, cd));
        vm.prank(relayer); uint256 g = gasleft(); r2.setClaimantBySig(vid, opA, true, dl, cs); g -= gasleft();
        assertTrue(r2.claimantAllowed(r2.budgetKey(vid, address(vault)), opA));
        vm.prank(alice); uint256 ge = gasleft(); r2.configure(aid, policy()); ge -= gasleft();
        emit log_named_uint("gas: configure by an EOA owner (direct, existing path)", ge);
        emit log_named_uint("gas: configureBySig by the vault passkey", gc);
        emit log_named_uint("gas: setClaimantBySig", g);
        emit log_named_uint("gas: create EnclaveLeaseGasReserveSig (constructor, 1 refused hash)", r2CreationGas);
        emit log_named_uint("gas: create EnclaveLeaseExecutor for it", e2CreationGas);
        emit log_named_uint("runtime bytes: EnclaveLeaseGasReserveSig", address(r2).code.length);
        emit log_named_uint("runtime bytes: live EnclaveLeaseGasReserve", address(live).code.length);
        emit log_named_uint("runtime bytes: EnclaveLeaseExecutor", address(r2Exec).code.length);
        assertLt(address(r2).code.length, 24_576, "EIP-170");
    }

    /// every selector of the live reserve is present unchanged; exactly 11 are added
    function test_originalSurfaceIsKept() public view {
        string[] memory a = vm.parseJsonKeys(vm.readFile("out/EnclaveLeaseGasReserve.sol/EnclaveLeaseGasReserve.json"), ".methodIdentifiers");
        string memory bj = vm.readFile("out/EnclaveLeaseGasReserveSig.sol/EnclaveLeaseGasReserveSig.json");
        for (uint256 i; i < a.length; i++) assertTrue(vm.keyExistsJson(bj, string.concat(".methodIdentifiers.['", a[i], "']")), a[i]);
        assertEq(vm.parseJsonKeys(bj, ".methodIdentifiers").length, a.length + 11, "3 tags, sigNonce, signerCodeRefused, 3 digests, 3 *BySig");
    }
}

interface IOldVault {
    function initialize(uint256 x, uint256 y) external;
    function factory() external view returns (address);
}
