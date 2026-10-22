// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CreditVaultBase, IProdVault} from "./Base.sol";
import {EnclaveLeaseGasReserve, IRegistryR, IL1FeeOracle} from "../src/main/EnclaveLeaseGasReserve.sol";
import {EnclaveDeployments} from "../src/live/EnclaveDeployments.sol";

/// ROOT'S FINDING, TESTED: the current EnclaveLeaseGasReserve (main 1d173473, unmodified) has no enrollment path for a
/// deployment owned by an existing credit vault. Everything here is real: the PRODUCTION vault bytecode (d36100ae), the
/// live rev-16d ledger and schema-4 registry sources, main's reserve, WebAuthn-shaped P-256 assertions verified by the
/// RIP-7212 precompile (native or Daimo's verifier bytecode). Nothing about the authority boundary is mocked; MockUSDC and
/// the ETH/USD feed are the only stand-ins. Positive controls show each refusal is the boundary, not a broken rig.
contract CreditVaultReserveGapTest is CreditVaultBase {
    EnclaveLeaseGasReserve reserve;
    address alice = makeAddr("alice");            // an EOA owner (positive control)
    address gifter = makeAddr("gifter");          // a third party paying ETH into the reserve
    bytes32 aid;                                  // a deployment alice owns

    function setUp() public {
        _baseSetUp();
        reserve = new EnclaveLeaseGasReserve(address(ledger), IRegistryR(address(registry)), IL1FeeOracle(address(0)),
            EnclaveLeaseGasReserve.Limits({maxGasPriceCeiling: 1 gwei, overheadClaimGas: 29_500, overheadRenewGas: 24_000,
                                            overheadReleaseGas: 7_000, minClaimInterval: 60, l1Bps: 0}));
        vm.prank(alice); aid = ledger.create("catalog://app/1", 0, 500, 8080, "", true, "", address(0), 0, 1000);
        vm.deal(gifter, 1 ether); vm.deal(alice, 1 ether);
    }

    function policy() internal pure returns (EnclaveLeaseGasReserve.Policy memory) {
        return EnclaveLeaseGasReserve.Policy({enabled: true, claimPolicy: 0, sponsorRelease: true, maxClaimsPerEpoch: 4,
            maxPerOpWei: 0.0005 ether, epochCapWei: 0.003 ether, epochSec: 3600, renewWindow: 300, minExtension: 600,
            claimCooldown: 1800, maxGasPrice: 0.1 gwei});
    }

    /// negative control: with INJECT_FAILURE=true the suite must fail (run-forge.sh negative)
    function test_injectedFailure() public view { assertFalse(vm.envOr("INJECT_FAILURE", false), "injected failure"); }

    /// the setUp's passkey-signed deployAndFund really ran on the live ledger: the record belongs to the VAULT
    function test_vaultOwnsItsRecordOnTheLiveLedger() public view {
        EnclaveDeployments.Deployment memory d = ledger.get(vid);
        assertEq(d.owner, address(vault), "owner of record is the credit vault");
        assertEq(usdc.balanceOf(address(vault)), 70e6, "exactly $30 left the vault");
        assertEq(d.balance6, 30e6, "and funded the record");
        assertEq(vault.nonce(), 1);
        assertEq(factory.vaultFor(x1, y1), address(vault), "address derives from the passkey alone");
        assertEq(vault.book(), address(book));
    }

    /// The production build carries no recoveryAdmin / migrateToSuccessor (main's newer source does, live vaults do not).
    function test_productionBuildHasNoAdminMoveOrOwnerCall() public {
        (bool ok,) = address(vault).call(abi.encodeWithSignature("migrateToSuccessor(uint256,uint256)", x1, y1));
        assertFalse(ok, "no migrateToSuccessor in the live build");
        (ok,) = address(vault).call(abi.encodeWithSignature("ownerCall(address,bytes)", address(reserve), ""));
        assertFalse(ok, "no ownerCall");
        (ok,) = address(vault).call(abi.encodeWithSignature("execute(address,uint256,bytes)", address(reserve), 0, ""));
        assertFalse(ok, "no generic execute");
    }

    /// configure / setClaimant / withdraw are keyed to msg.sender == owner of record, for every caller but the vault
    function test_reserveOwnerActionsRefuseEveryoneButTheVaultAddress() public {
        address[5] memory callers = [relayer, treasury, address(this) /* reserve + book admin */, gifter, address(factory)];
        for (uint256 i; i < callers.length; i++) {
            vm.startPrank(callers[i]);
            vm.expectRevert(bytes("!owner")); reserve.configure(vid, policy());
            vm.expectRevert(bytes("!owner")); reserve.setClaimant(vid, relayer, true);
            vm.stopPrank();
        }
        // positive control: the owner of record (alice for her record) configures fine
        vm.prank(alice); reserve.configure(aid, policy());
        assertTrue(reserve.reserveOf(aid, alice).enabled, "an EOA owner enrolls directly");
    }

    /// No passkey-signed vault operation can originate a reserve call or move the record to an address that could.
    /// Each attempt carries a VALID signature from the vault's own key: the vault's allowlist refuses it (nonce unchanged).
    function test_noVaultOperationReachesTheReserveOrMovesTheRecord() public {
        bytes[5] memory bad = [
            abi.encodeCall(reserve.configure, (vid, policy())),
            abi.encodeCall(reserve.setClaimant, (vid, relayer, true)),
            abi.encodeCall(reserve.withdraw, (vid, 1, payable(relayer))),
            abi.encodeCall(reserve.deposit, (vid)),
            abi.encodeCall(ledger.transferDeployment, (vid, alice))
        ];
        for (uint256 i; i < bad.length; i++) {
            uint256 dl = block.timestamp + 300;
            IProdVault.WebAuthnSig memory w = sig(PK1, controlDigest(bad[i], dl));
            vm.prank(relayer);
            vm.expectRevert(bytes("selector not allowed"));
            vault.controlDeployment(bad[i], dl, w);
        }
        // hidden inside an allowed multicall: every inner selector is checked
        bytes[] memory inner = new bytes[](2);
        inner[0] = abi.encodeCall(ledger.setActive, (vid, true));
        inner[1] = abi.encodeCall(ledger.transferDeployment, (vid, alice));
        bytes memory mc = abi.encodeCall(ledger.multicall, (inner));
        uint256 dl2 = block.timestamp + 300;
        IProdVault.WebAuthnSig memory w2 = sig(PK1, controlDigest(mc, dl2));
        vm.prank(relayer);
        vm.expectRevert(bytes("inner selector not allowed"));
        vault.controlDeployment(mc, dl2, w2);
        // ...and a non-create() payload through deployAndFund
        bytes memory cfg = abi.encodeCall(reserve.configure, (vid, policy()));
        IProdVault.WebAuthnSig memory w3 = sig(PK1, deployDigest(cfg, 0, dl2));
        vm.prank(relayer);
        vm.expectRevert(bytes("not create()"));
        vault.deployAndFund(cfg, 0, dl2, w3);
        assertEq(vault.nonce(), 1, "every refused op reverted whole");
        assertEq(ledger.get(vid).owner, address(vault), "the record never moved");
        // positive control: an allowed control op from the same key lands (the signatures above were valid)
        control(abi.encodeCall(ledger.setActive, (vid, false)));
        assertEq(vault.nonce(), 2);
        assertFalse(ledger.get(vid).active);
    }

    /// Even the platform book (admin) cannot open a path: the vault's control target is book.addr("deployments"), but
    /// the selector allowlist is the ledger's owner calls, which the reserve does not implement.
    function test_bookRepointCannotTurnControlIntoAReserveCall() public {
        book.set(BOOK_DEPLOYMENTS, address(reserve));
        uint256 dl = block.timestamp + 300;
        bytes memory cd = abi.encodeCall(ledger.setActive, (vid, true));
        IProdVault.WebAuthnSig memory w = sig(PK1, controlDigest(cd, dl));
        vm.prank(relayer);
        vm.expectRevert(bytes("control failed"));
        vault.controlDeployment(cd, dl, w);
        book.set(BOOK_DEPLOYMENTS, address(ledger));
    }

    /// ERC-1271 is real and accepts a passkey signature over the reserve digest a candidate would use - but it is a VIEW,
    /// and the reserve exposes no function that takes a signature: nothing consumes it.
    function test_erc1271IsValidButNoReserveEntryPointConsumesIt() public view {
        bytes32 d = keccak256(abi.encode(keccak256("EnclaveLeaseGasReserve.configureBySig.v1"), address(reserve), block.chainid, vid,
            address(vault), keccak256(abi.encode(policy())), uint256(0), block.timestamp + 300));
        assertEq(vault.isValidSignature(d, sigBytes(PK1, d)), bytes4(0x1626ba7e), "the vault vouches for its passkey");
        assertEq(vault.isValidSignature(d, sigBytes(PK2, d)), bytes4(0xffffffff), "a stranger's key is refused");
        assertEq(vault.isValidSignature(d, abi.encode(sigFrom(PK1, d, "https://x.app.enclave.host"))), bytes4(0xffffffff), "wrong origin refused");
        // the reserve's whole external surface (compiled ABI): no `bytes` argument anywhere, so no signature path
        string[] memory fns = vm.parseJsonKeys(vm.readFile("out/EnclaveLeaseGasReserve.sol/EnclaveLeaseGasReserve.json"), ".methodIdentifiers");
        for (uint256 i; i < fns.length; i++) assertFalse(_hasBytesArg(fns[i]), fns[i]);
        assertGt(fns.length, 20);
    }

    /// A deposit for a vault-owned record: credited to (id, vault), never enabled, never withdrawable, no admin path.
    function test_depositForAVaultOwnedRecordIsStranded() public {
        vm.prank(gifter); reserve.deposit{value: 0.01 ether}(vid);
        EnclaveLeaseGasReserve.Reserve memory r = reserve.reserveOf(vid, address(vault));
        assertEq(r.balanceWei, 0.01 ether);
        assertFalse(r.enabled, "reserves start disabled; only configure (owner) enables");
        (EnclaveLeaseGasReserve.Status st,,,) = reserve.statusOf(vid, 2, bytes32(0), relayer);
        assertEq(uint8(st), uint8(EnclaveLeaseGasReserve.Status.Disabled), "no lease can ever draw on it");
        vm.prank(gifter); vm.expectRevert(bytes("short")); reserve.withdraw(vid, 0.01 ether, payable(gifter));
        vm.expectRevert(bytes("short")); reserve.withdraw(vid, 0.01 ether, payable(address(this)));
        // admin surface: limits, pause, moderation, ownership, the one-time executor binding - none takes a reserve
        string[] memory fns = vm.parseJsonKeys(vm.readFile("out/EnclaveLeaseGasReserve.sol/EnclaveLeaseGasReserve.json"), ".methodIdentifiers");
        uint256 writes;
        for (uint256 i; i < fns.length; i++) if (_isAdminWrite(fns[i])) writes++;
        assertEq(writes, 7, "exactly the 7 admin writes, none moving ETH");
        assertEq(address(reserve).balance, 0.01 ether, "the ETH stays in the reserve");
        // depositAndFundCompute: the compute share reaches the ledger (credited to the record), the rest is stranded too
        uint256 b6 = ledger.get(vid).balance6;
        vm.prank(gifter); reserve.depositAndFundCompute{value: 0.02 ether}(vid, 0.01 ether);
        assertGt(ledger.get(vid).balance6, b6, "compute share funded the record (vault-owned escrow)");
        assertEq(reserve.reserveOf(vid, address(vault)).balanceWei, 0.02 ether);
        // positive control: alice's own deposit is hers to withdraw
        vm.startPrank(alice); reserve.deposit{value: 0.01 ether}(aid); reserve.withdraw(aid, 0.01 ether, payable(alice)); vm.stopPrank();
    }

    /// Key management cannot help: a second passkey has the same powers, never a new call target.
    function test_addedKeyHasNoMorePower() public {
        (uint256 x2, uint256 y2) = vm.publicKeyP256(PK2);
        uint256 dl = block.timestamp + 300;
        IProdVault.WebAuthnSig memory w = sig(PK1, addKeyDigest(x2, y2, dl));
        vm.prank(relayer); vault.addKey(x2, y2, dl, w);
        assertEq(vault.keyCount(), 2);
        bytes memory cfg = abi.encodeCall(reserve.configure, (vid, policy()));
        dl = block.timestamp + 300;
        IProdVault.WebAuthnSig memory w2 = sig(PK2, controlDigest(cfg, dl));
        vm.prank(relayer); vm.expectRevert(bytes("selector not allowed")); vault.controlDeployment(cfg, dl, w2);
    }

    function _hasBytesArg(string memory s) internal pure returns (bool) {
        bytes memory b = bytes(s);
        for (uint256 i; i + 6 <= b.length; i++)
            if (b[i] == "b" && b[i+1] == "y" && b[i+2] == "t" && b[i+3] == "e" && b[i+4] == "s" && (b[i+5] == "," || b[i+5] == ")") && (i == 0 || b[i-1] == "(" || b[i-1] == ","))
                return true;
        return false;
    }
    function _isAdminWrite(string memory s) internal pure returns (bool) {
        bytes32 h = keccak256(bytes(s));
        return h == keccak256("bindExecutor(address)") || h == keccak256("setLimits((uint64,uint32,uint32,uint32,uint32,uint16))")
            || h == keccak256("setPaused(bool)") || h == keccak256("setBlockedDeployment(bytes32,bool)") || h == keccak256("setBlockedOperator(address,bool)")
            || h == keccak256("transferOwnership(address)") || h == keccak256("acceptOwnership()");
    }
}
