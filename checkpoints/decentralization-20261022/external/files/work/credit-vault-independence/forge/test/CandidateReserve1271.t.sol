// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CreditVaultBase, IProdVault} from "./Base.sol";
import {EnclaveLeaseGasReserve1271, IRegistryR, IL1FeeOracle} from "../src/proposal/EnclaveLeaseGasReserve1271.sol";
import {EnclaveLeaseExecutor, IEnclaveLeaseGasReserve} from "../src/main/EnclaveLeaseExecutor.sol";
import {EnclaveDeployments} from "../src/live/EnclaveDeployments.sol";

/// The OPTIONAL, UNAPPROVED candidate (proposal/EnclaveLeaseGasReserve1271.sol): an existing PRODUCTION credit vault
/// (d36100ae bytecode, unchanged) enrolls its own deployment in app-funded lease gas with a passkey signature, through
/// the vault's existing ERC-1271 - and a zero-ETH host then claims the app with the reserve paying the relayer, via the
/// unmodified EnclaveLeaseExecutor and an EIP-7702 delegation. Then every protection: replay, deadline, chain, reserve
/// instance, removed key, origin, tampered policy/record/recipient, EOA owners, and the unchanged msg.sender surface.
contract CandidateReserve1271Test is CreditVaultBase {
    EnclaveLeaseGasReserve1271 reserve;
    EnclaveLeaseExecutor executor;
    uint256 constant OPA_PK = 0xA0A0A1;
    address opA;
    bytes32 encA;
    address alice = makeAddr("alice");
    address payee = makeAddr("payee");
    uint256 constant GASPRICE = 11_000_000;

    function setUp() public {
        _baseSetUp();
        vm.fee(10_000_000); vm.txGasPrice(GASPRICE);
        reserve = _newReserve();
        executor = new EnclaveLeaseExecutor(IEnclaveLeaseGasReserve(address(reserve)));
        reserve.bindExecutor(address(executor));
        opA = vm.addr(OPA_PK);
        vm.prank(opA); encA = registry.register("https://a.host.test", "EnclaveHost/enclave", bytes32(0), 1000, 0, address(0));
        vm.deal(alice, 1 ether);
        vm.prank(alice); reserve.deposit{value: 0.01 ether}(vid);     // anyone may fund the vault-owned app's gas
    }

    function _newReserve() internal returns (EnclaveLeaseGasReserve1271) {
        return new EnclaveLeaseGasReserve1271(address(ledger), IRegistryR(address(registry)), IL1FeeOracle(address(0)),
            EnclaveLeaseGasReserve1271.Limits({maxGasPriceCeiling: 1 gwei, overheadClaimGas: 29_500, overheadRenewGas: 24_000,
                                                overheadReleaseGas: 7_000, minClaimInterval: 60, l1Bps: 0}));
    }
    function policy(uint8 claimPolicy) internal pure returns (EnclaveLeaseGasReserve1271.Policy memory) {
        return EnclaveLeaseGasReserve1271.Policy({enabled: true, claimPolicy: claimPolicy, sponsorRelease: true, maxClaimsPerEpoch: 4,
            maxPerOpWei: 0.0005 ether, epochCapWei: 0.003 ether, epochSec: 3600, renewWindow: 300, minExtension: 600,
            claimCooldown: 1800, maxGasPrice: 0.1 gwei});
    }
    function cfgSig(uint256 pk, bytes32 id, EnclaveLeaseGasReserve1271.Policy memory p, uint256 dl, string memory origin) internal view returns (bytes memory) {
        bytes32 d = reserve.configureDigest(id, ledger.get(id).owner, p, reserve.sigNonce(reserve.budgetKey(id, ledger.get(id).owner)), dl);
        return abi.encode(sigFrom(pk, d, origin));
    }
    function enroll() internal {
        uint256 dl = block.timestamp + 300;
        bytes memory s = cfgSig(PK1, vid, policy(0), dl, ORIGIN);
        vm.prank(relayer); reserve.configureBySig(vid, policy(0), dl, s);
    }

    /// negative control: with INJECT_FAILURE=true the suite must fail (run-forge.sh negative)
    function test_injectedFailure() public view { assertFalse(vm.envOr("INJECT_FAILURE", false), "injected failure"); }

    function test_vaultPasskeyEnrollsAndAZeroEthHostClaimsPaidByTheReserve() public {
        (EnclaveLeaseGasReserve1271.Status st0,,,) = reserve.statusOf(vid, 1, encA, opA);
        assertEq(uint8(st0), uint8(EnclaveLeaseGasReserve1271.Status.Disabled));
        uint256 vaultNonce = vault.nonce(); uint256 usdc0 = usdc.balanceOf(address(vault));
        enroll();
        assertTrue(reserve.reserveOf(vid, address(vault)).enabled, "the vault's own reserve is enabled");
        assertEq(reserve.sigNonce(reserve.budgetKey(vid, address(vault))), 1);
        assertEq(vault.nonce(), vaultNonce, "ERC-1271 is a view: no vault op consumed, no credit touched");
        assertEq(usdc.balanceOf(address(vault)), usdc0);
        (EnclaveLeaseGasReserve1271.Status st,,,) = reserve.statusOf(vid, 1, encA, opA);
        assertEq(uint8(st), uint8(EnclaveLeaseGasReserve1271.Status.Ready));
        // the host's key holds no ETH; its EIP-7702 delegation rides in the relayer's transaction
        assertEq(opA.balance, 0);
        EnclaveLeaseExecutor.Lease memory l = EnclaveLeaseExecutor.Lease({id: vid, kind: 1, enclaveId: encA, nonce: 0,
            deadline: uint64(block.timestamp + 600), payee: payee, maxChargeWei: 0.0005 ether});
        bytes32 ds = keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("EnclaveLeaseExecutor"), keccak256("1"), block.chainid, opA));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", ds, keccak256(abi.encode(executor.LEASE_TYPEHASH(), address(reserve), l.id, l.kind,
            l.enclaveId, l.nonce, l.deadline, l.payee, l.maxChargeWei))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OPA_PK, digest);
        vm.signAndAttachDelegation(address(executor), OPA_PK);
        uint256 b0 = reserve.reserveOf(vid, address(vault)).balanceWei;
        vm.prank(relayer, relayer);
        EnclaveLeaseExecutor(opA).lease(l, abi.encodePacked(r, s, v));
        EnclaveDeployments.Deployment memory d = ledger.get(vid);
        assertEq(d.runnerOperator, opA, "the vault-owned app is claimed");
        uint256 paid = payee.balance;
        assertGt(paid, 0);
        assertEq(b0 - reserve.reserveOf(vid, address(vault)).balanceWei, paid, "the app's own reserve paid exactly the relayer");
        assertEq(opA.balance, 0, "no host ETH");
        assertEq(d.owner, address(vault), "ownership never moved");
        emit log_named_uint("claim charged to the vault-owned app's reserve (wei)", paid);
    }

    function test_replayOfASignedConfigureIsRefused() public {
        uint256 dl = block.timestamp + 300;
        bytes memory s = cfgSig(PK1, vid, policy(0), dl, ORIGIN);
        vm.prank(relayer); reserve.configureBySig(vid, policy(0), dl, s);
        vm.prank(relayer); vm.expectRevert(bytes("bad signature")); reserve.configureBySig(vid, policy(0), dl, s);
    }

    function test_expiredSignatureIsRefused() public {
        uint256 dl = block.timestamp + 300;
        bytes memory s = cfgSig(PK1, vid, policy(0), dl, ORIGIN);
        vm.warp(dl + 1);
        vm.prank(relayer); vm.expectRevert(bytes("expired")); reserve.configureBySig(vid, policy(0), dl, s);
    }

    function test_signatureForAnotherChainIsRefused() public {
        uint256 dl = block.timestamp + 300;
        bytes memory s = cfgSig(PK1, vid, policy(0), dl, ORIGIN);
        vm.chainId(84532);
        vm.prank(relayer); vm.expectRevert(bytes("bad signature")); reserve.configureBySig(vid, policy(0), dl, s);
    }

    function test_signatureForAnotherReserveIsRefused() public {
        EnclaveLeaseGasReserve1271 other = _newReserve();
        uint256 dl = block.timestamp + 300;
        bytes memory s = cfgSig(PK1, vid, policy(0), dl, ORIGIN);     // bound to `reserve`
        vm.prank(relayer); vm.expectRevert(bytes("bad signature")); other.configureBySig(vid, policy(0), dl, s);
    }

    function test_removedPasskeyIsRefusedAndTheRemainingOneWorks() public {
        (uint256 x2, uint256 y2) = vm.publicKeyP256(PK2);
        uint256 dl = block.timestamp + 300;
        IProdVault.WebAuthnSig memory w = sig(PK1, addKeyDigest(x2, y2, dl));
        vm.prank(relayer); vault.addKey(x2, y2, dl, w);
        bytes32 kh1 = keccak256(abi.encode(x1, y1));
        IProdVault.WebAuthnSig memory w2 = sig(PK2, removeKeyDigest(kh1, dl));
        vm.prank(relayer); vault.removeKey(kh1, dl, w2);
        bytes memory s1 = cfgSig(PK1, vid, policy(0), dl, ORIGIN);
        vm.prank(relayer); vm.expectRevert(bytes("bad signature")); reserve.configureBySig(vid, policy(0), dl, s1);
        bytes memory s2 = cfgSig(PK2, vid, policy(0), dl, ORIGIN);
        vm.prank(relayer); reserve.configureBySig(vid, policy(0), dl, s2);
        assertTrue(reserve.reserveOf(vid, address(vault)).enabled);
    }

    function test_assertionFromAnotherOriginIsRefused() public {
        uint256 dl = block.timestamp + 300;
        bytes memory s = cfgSig(PK1, vid, policy(0), dl, "https://evil.app.enclave.host");
        vm.prank(relayer); vm.expectRevert(bytes("bad signature")); reserve.configureBySig(vid, policy(0), dl, s);
    }

    function test_tamperedPolicyOrRecordIsRefused() public {
        uint256 dl = block.timestamp + 300;
        bytes memory s = cfgSig(PK1, vid, policy(0), dl, ORIGIN);
        EnclaveLeaseGasReserve1271.Policy memory p = policy(0); p.maxPerOpWei = 0.003 ether;   // a relay raising the cap
        vm.prank(relayer); vm.expectRevert(bytes("bad signature")); reserve.configureBySig(vid, p, dl, s);
        // a second vault-owned record: the signature names the first
        bytes memory cc = createCall("catalog://app/2", 1000);
        IProdVault.WebAuthnSig memory w = sig(PK1, deployDigest(cc, 0, dl));
        vm.prank(relayer); bytes32 vid2 = vault.deployAndFund(cc, 0, dl, w);
        vm.prank(relayer); vm.expectRevert(bytes("bad signature")); reserve.configureBySig(vid2, policy(0), dl, s);
    }

    function test_eoaOwnerHasNoSignaturePathAndKeepsTheDirectOne() public {
        vm.prank(alice); bytes32 aid = ledger.create("catalog://app/3", 0, 500, 8080, "", true, "", address(0), 0, 1000);
        uint256 dl = block.timestamp + 300;
        bytes memory s = cfgSig(PK1, aid, policy(0), dl, ORIGIN);
        vm.prank(relayer); vm.expectRevert(bytes("owner is not a contract")); reserve.configureBySig(aid, policy(0), dl, s);
        vm.prank(alice); reserve.configure(aid, policy(0));
        assertTrue(reserve.reserveOf(aid, alice).enabled);
        vm.prank(relayer); vm.expectRevert(bytes("!owner")); reserve.configure(vid, policy(0));   // msg.sender path unchanged
    }

    function test_claimantAllowlistAndWithdrawBySignature() public {
        enroll();
        uint256 dl = block.timestamp + 300;
        address k = address(vault);
        bytes32 cd = reserve.claimantDigest(vid, k, opA, true, reserve.sigNonce(reserve.budgetKey(vid, k)), dl);
        vm.prank(relayer); reserve.setClaimantBySig(vid, opA, true, dl, abi.encode(sig(PK1, cd)));
        assertTrue(reserve.claimantAllowed(reserve.budgetKey(vid, k), opA));
        address to = makeAddr("owner-chosen-recipient");
        bytes32 wd = reserve.withdrawDigest(vid, k, 0.004 ether, to, reserve.sigNonce(reserve.budgetKey(vid, k)), dl);
        bytes memory ws = abi.encode(sig(PK1, wd));
        vm.prank(relayer); vm.expectRevert(bytes("bad signature")); reserve.withdrawBySig(vid, k, 0.004 ether, payable(relayer), dl, ws);
        vm.prank(relayer); reserve.withdrawBySig(vid, k, 0.004 ether, payable(to), dl, ws);
        assertEq(to.balance, 0.004 ether);
        assertEq(reserve.reserveOf(vid, k).balanceWei, 0.006 ether);
        assertEq(reserve.sigNonce(reserve.budgetKey(vid, k)), 3);
    }

    /// the candidate keeps every function of main's reserve (same selectors), adding only the signature surface
    function test_originalSurfaceIsKept() public view {
        string[] memory a = vm.parseJsonKeys(vm.readFile("out/EnclaveLeaseGasReserve.sol/EnclaveLeaseGasReserve.json"), ".methodIdentifiers");
        string memory bj = vm.readFile("out/EnclaveLeaseGasReserve1271.sol/EnclaveLeaseGasReserve1271.json");
        for (uint256 i; i < a.length; i++)
            assertTrue(vm.keyExistsJson(bj, string.concat(".methodIdentifiers.['", a[i], "']")), a[i]);
        string[] memory b = vm.parseJsonKeys(bj, ".methodIdentifiers");
        assertEq(b.length, a.length + 10, "exactly 10 additions: 3 tags, sigNonce, 3 digests, 3 *BySig");
    }
}
