// ROOT PREPARED EXACT-REV16D FIXTURE. Original author assertions retained below; NOT RUN.
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// wallet-owned-session-create-r1: AUTHORED, NOT RUN. Real WalletSessionVault/Factory, the real deployable ledger
// (deploy/ledger rev 15d: create/transferDeployment/fundFor/setDelegate), the rig's real catalog/router/MockUSDC3009 and
// real P-256 signatures. Expectations marked [ledger-assumption] depend on ledger behaviour root must confirm on run.

import { SessionRig } from "./SessionVault.t.sol";
import { CreateArgs, ISVToken, ISVBook, ISVRouter, ISVKeyAttestations } from "../../SessionVault.sol";
import { WalletSessionVault, WalletSessionVaultFactory } from "../../WalletSessionVault.sol";
import { WalletSessionPolicy as WP } from "../../WalletSessionPolicy.sol";
import { EnclaveDeployments as LedgerR16D } from "./fixtures/EnclaveDeploymentsRev16D.sol";

contract WalletSessionVaultRev16DTest is SessionRig {
    uint8 constant CREATE = 0; uint8 constant FUND = 1; uint8 constant SET_APPREF = 2; uint8 constant SET_CONFIG = 3;
    uint8 constant SET_SHARES = 4; uint8 constant SET_MAXRATE = 5; uint8 constant SET_ACTIVE = 6; uint8 constant REFUND = 7;
    uint8 constant PUBLISH = 8;
    uint256 constant DELEGATE_SLOT = 23;
    bytes32 constant WGRANT_TYPEHASH = keccak256(
        "WalletSessionGrant(string label,string preset,bytes32 sessionKey,string[] actions,string[] apps,"
        "string[] environments,uint256 budget,uint256 spendPerPeriod,uint32 periodSeconds,uint32 opsPerPeriod,"
        "uint256 maxFeePerOp,uint256 maxAppFeePerHour,uint256 maxRatePerHour,uint64 expiresAt,bytes32 measurement,"
        "address ledger,bytes32 grantNonce,uint64 signBefore)");

    LedgerR16D led;
    WalletSessionVaultFactory wf;
    WalletSessionVault wv;

    function setUp() public override {
        super.setUp();
        led = new LedgerR16D(address(usdc), payout, address(reg), address(0));
        led.setProofRequiredFrom(0);
        book.set("deployments", address(led));
        wf = new WalletSessionVaultFactory(ISVToken(address(usdc)), ISVBook(address(book)), ISVRouter(address(router)),
            ISVKeyAttestations(address(0)), 1_000e6);
        wv = WalletSessionVault(wf.vaultFor(owner));
    }

    // ---- independent EIP-712 for the NEW domain ----------------------------------------------

    function _wdomain(address v) internal view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Enclave Wallet Sessions"), keccak256("1"), block.chainid, v));
    }
    function _wtyped(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _wdomain(address(wv)), structHash));
    }
    function _wgrantHash(WalletSessionVault.Grant memory g) internal pure returns (bytes32) {
        bytes memory a = abi.encode(WGRANT_TYPEHASH, keccak256(bytes(g.label)), keccak256(bytes(g.preset)), g.sessionKey,
            _hs(g.actions), _hs(g.apps), _hs(g.environments), g.budget);
        bytes memory b = abi.encode(g.spendPerPeriod, g.periodSeconds, g.opsPerPeriod, g.maxFeePerOp,
            g.maxAppFeePerHour, g.maxRatePerHour, g.expiresAt, g.measurement, g.ledger, g.grantNonce, g.signBefore);
        return keccak256(bytes.concat(a, b));
    }

    function _actions() internal pure returns (string[] memory o) {
        o = new string[](8);
        o[0] = "deploy.create"; o[1] = "deploy.fund"; o[2] = "deploy.setAppRef"; o[3] = "deploy.setConfig";
        o[4] = "deploy.setShares"; o[5] = "deploy.setMaxRate"; o[6] = "deploy.setActive"; o[7] = "deploy.refund";
    }
    function _hexId(bytes32 id) internal pure returns (string memory) { return vm.toString(id); }

    function _wgrant(string[] memory apps, string[] memory envs, uint256 budget) internal view
        returns (WalletSessionVault.Grant memory g)
    {
        g.label = "wallet session"; g.preset = "custom"; g.sessionKey = keyHash; g.actions = _actions();
        g.apps = apps; g.environments = envs; g.budget = budget; g.spendPerPeriod = budget; g.periodSeconds = 1 days;
        g.maxFeePerOp = 50_000; g.maxAppFeePerHour = 1e6; g.maxRatePerHour = 10e6;
        g.expiresAt = uint64(vm.getBlockTimestamp() + 7 days); g.ledger = address(led);
        g.grantNonce = keccak256(abi.encode("wgrant", apps.length, budget, vm.getBlockTimestamp()));
        g.signBefore = uint64(vm.getBlockTimestamp() + 10 minutes);
    }

    function _wopen(WalletSessionVault.Grant memory g) internal returns (bytes32 sid) {
        bytes32 gd = _wtyped(_wgrantHash(g));
        bytes memory auth = _receiveSig(OWNER_PK, address(wv), g.budget, 0, vm.getBlockTimestamp() + 1 hours, gd);
        vm.prank(relayer);
        (, sid) = wf.openWithDepositFor(owner, g, _ecdsa(OWNER_PK, gd), 0, vm.getBlockTimestamp() + 1 hours, auth);
    }

    function _sig(bytes32 sid, uint256 nonce, uint8 action, bytes memory args, uint256 fee, uint64 dl)
        internal view returns (uint256 x, uint256 y, bytes32 r, bytes32 s)
    {
        bytes32 d = _wtyped(keccak256(abi.encode(CALL_TYPEHASH, sid, nonce, action, keccak256(args), fee, dl)));
        (r, s) = vm.signP256(SK, sha256(abi.encodePacked(d)));
        (x, y) = vm.publicKeyP256(SK);
    }

    function _wexec(bytes32 sid, uint256 nonce, uint8 action, bytes memory args, uint256 fee) internal returns (bytes memory) {
        uint64 dl = uint64(vm.getBlockTimestamp() + 5 minutes);
        (uint256 x, uint256 y, bytes32 r, bytes32 s) = _sig(sid, nonce, action, args, fee, dl);
        vm.prank(relayer);
        return wv.execute(sid, nonce, action, args, fee, dl, x, y, r, s);
    }

    function _wexecRevert(bytes32 sid, uint256 nonce, uint8 action, bytes memory args, bytes memory err) internal {
        uint64 dl = uint64(vm.getBlockTimestamp() + 5 minutes);
        (uint256 x, uint256 y, bytes32 r, bytes32 s) = _sig(sid, nonce, action, args, 0, dl);
        vm.prank(relayer);
        vm.expectRevert(err);
        wv.execute(sid, nonce, action, args, 0, dl, x, y, r, s);
    }

    function _cargs(string memory ref, uint8 env, uint256 fund6) internal pure returns (bytes memory) {
        return abi.encode(CreateArgs({ appRef: ref, gpuMilli: 0, cpuMilli: 1000, appPort: 8080, ports: "", isPublic: false,
            configCid: "", maxRate6: 1000, env: env, fund6: fund6 }));
    }

    function _delegated(address o, address d) internal view returns (bool) {
        bytes32 inner = keccak256(abi.encode(o, DELEGATE_SLOT));
        return uint256(vm.load(address(led), keccak256(abi.encode(d, inner)))) == 1;
    }

    function _anyBoth() internal view returns (WalletSessionVault.Grant memory) {
        return _wgrant(_strs("*"), _strs("staging", "prod"), 10e6);
    }

    // ---- the positive slice ------------------------------------------------------------------

    function test_createTransfersSameIdToWalletThenFundsWithWalletAsPayer() public {
        bytes32 sid = _wopen(_anyBoth());
        uint256 before = usdc.balanceOf(address(wv));
        vm.recordLogs();
        bytes memory out = _wexec(sid, 0, CREATE, _cargs(freeRef, 1, 2e6), 10_000);
        bytes32 id = abi.decode(out, (bytes32));
        assertEq(led.get(id).owner, owner, "final custody is the wallet");
        assertEq(led.get(id).id, id, "the ledger's own id, not a second one");
        assertEq(led.get(id).balance6, 2e6, "funded once");
        assertEq(wf.creatorOf(id), address(wv), "registry names the creating vault");
        WP.Binding memory b = wv.policyOf(id);
        assertEq(b.state, 1); assertEq(b.env, 1); assertEq(b.revision, 1); assertEq(b.approved, bytes32(0)); assertEq(b.createdBy, sid);
        assertEq(usdc.balanceOf(address(wv)), before - 2e6 - 10_000, "fund + fee charged exactly once");
        assertEq(usdc.allowance(address(wv), address(led)), 0);
        assertEq(usdc.allowance(address(wv), address(router)), 0);
        (WalletSessionVault.Session memory s,,) = wv.sessionOf(sid);
        assertEq(s.spent6, 2e6 + 10_000);
        assertFalse(_delegated(owner, address(wv)), "create never fabricates a delegation");
        assertGt(vm.getRecordedLogs().length, 3, "Created(vault) + DeploymentTransferred + Bound + SessionOp in one receipt");
    }

    function test_zeroFundCreateIsWalletOwnedAndUnfunded() public {
        bytes32 sid = _wopen(_anyBoth());
        bytes32 id = abi.decode(_wexec(sid, 0, CREATE, _cargs(freeRef, 1, 0), 0), (bytes32));
        assertEq(led.get(id).owner, owner);
        assertEq(led.get(id).balance6, 0);
    }

    function test_prodCreateStaysUnapproved() public {
        bytes32 sid = _wopen(_anyBoth());
        bytes32 id = abi.decode(_wexec(sid, 0, CREATE, _cargs(freeRef, 2, 0), 0), (bytes32));
        WP.Binding memory b = wv.policyOf(id);
        assertEq(b.env, 2); assertEq(b.approved, bytes32(0), "never auto-approved");
    }

    function test_paidAppNeedsNamingWildcardNeverCoversIt() public {
        bytes32 sid = _wopen(_anyBoth());
        _wexecRevert(sid, 0, CREATE, _cargs(storeRef, 1, 0), abi.encodeWithSignature("AppNotAllowed(bytes32)", storeAppId));
    }

    // ---- atomic rollback ---------------------------------------------------------------------

    function test_fundingFailureUnwindsCreateTransferAndBinding() public {
        bytes32 sid = _wopen(_anyBoth());
        vm.mockCallRevert(address(led), abi.encodeWithSelector(LedgerR16D.fundFor.selector), "boom");
        _wexecRevert(sid, 0, CREATE, _cargs(freeRef, 1, 1e6), bytes("boom"));
        vm.clearMockedCalls();
        assertEq(wv.seqOf(sid, 0), 0, "nonce rolled back");
        (WalletSessionVault.Session memory s,,) = wv.sessionOf(sid);
        assertEq(s.spent6, 0, "spend rolled back");
        // the same call now succeeds at the same nonce: nothing half-done was left behind
        bytes32 id = abi.decode(_wexec(sid, 0, CREATE, _cargs(freeRef, 1, 1e6), 0), (bytes32));
        assertEq(led.get(id).owner, owner);
    }

    function test_transferFailureUnwinds() public {
        bytes32 sid = _wopen(_anyBoth());
        vm.mockCallRevert(address(led), abi.encodeWithSelector(LedgerR16D.transferDeployment.selector), "no-transfer");
        _wexecRevert(sid, 0, CREATE, _cargs(freeRef, 1, 0), bytes("no-transfer"));
        assertEq(wv.seqOf(sid, 0), 0);
    }

    function test_ledgerMovedInBookRefusesEverything() public {
        bytes32 sid = _wopen(_anyBoth());
        book.set("deployments", address(ledger));     // the rig's other ledger
        _wexecRevert(sid, 0, CREATE, _cargs(freeRef, 1, 0), abi.encodeWithSignature("LedgerMoved()"));
    }

    // ---- grant / domain / replay -------------------------------------------------------------

    function test_publishIsExplicitlyUnsupported() public {
        WalletSessionVault.Grant memory g = _anyBoth();
        string[] memory a = new string[](1); a[0] = "app.publish"; g.actions = a;
        bytes32 gd = _wtyped(_wgrantHash(g));
        bytes memory auth = _receiveSig(OWNER_PK, address(wv), g.budget, 0, vm.getBlockTimestamp() + 1 hours, gd);
        vm.expectRevert(abi.encodeWithSignature("Unsupported(uint8)", PUBLISH));
        wf.openWithDepositFor(owner, g, _ecdsa(OWNER_PK, gd), 0, vm.getBlockTimestamp() + 1 hours, auth);
        bytes32 sid = _wopen(_anyBoth());
        _wexecRevert(sid, 0, PUBLISH, "", abi.encodeWithSignature("Unsupported(uint8)", PUBLISH));
    }

    function test_legacyDomainGrantSignatureDoesNotOpenHere() public {
        WalletSessionVault.Grant memory g = _anyBoth();
        bytes32 legacy = keccak256(abi.encodePacked("\x19\x01", _domain(address(wv)), _wgrantHash(g)));
        wf.createVault(owner);
        vm.expectRevert(abi.encodeWithSignature("BadSignature()"));
        vm.prank(relayer); wv.open(g, _ecdsa(OWNER_PK, legacy));
    }

    function test_grantNamingAnotherLedgerIsRefused() public {
        WalletSessionVault.Grant memory g = _anyBoth();
        g.ledger = address(ledger);
        bytes32 gd = _wtyped(_wgrantHash(g));
        bytes memory auth = _receiveSig(OWNER_PK, address(wv), g.budget, 0, vm.getBlockTimestamp() + 1 hours, gd);
        vm.expectRevert(abi.encodeWithSignature("BadPolicy(uint8)", uint8(7)));
        wf.openWithDepositFor(owner, g, _ecdsa(OWNER_PK, gd), 0, vm.getBlockTimestamp() + 1 hours, auth);
    }

    function test_replayedCallAndExpiredDeadlineRefused() public {
        bytes32 sid = _wopen(_anyBoth());
        bytes memory args = _cargs(freeRef, 1, 0);
        uint64 dl = uint64(vm.getBlockTimestamp() + 5 minutes);
        (uint256 x, uint256 y, bytes32 r, bytes32 s) = _sig(sid, 0, CREATE, args, 0, dl);
        wv.execute(sid, 0, CREATE, args, 0, dl, x, y, r, s);
        vm.expectRevert(abi.encodeWithSignature("BadNonce()"));
        wv.execute(sid, 0, CREATE, args, 0, dl, x, y, r, s);
        (x, y, r, s) = _sig(sid, 1, CREATE, args, 0, dl);
        vm.warp(dl + 1);
        vm.expectRevert(abi.encodeWithSignature("Expired()"));
        wv.execute(sid, 1, CREATE, args, 0, dl, x, y, r, s);
    }

    function test_feeAboveCeilingAndBudgetAbovePeriodRefused() public {
        bytes32 sid = _wopen(_anyBoth());
        bytes memory args = _cargs(freeRef, 1, 0);
        uint64 dl = uint64(vm.getBlockTimestamp() + 5 minutes);
        (uint256 x, uint256 y, bytes32 r, bytes32 s) = _sig(sid, 0, CREATE, args, 60_000, dl);
        vm.expectRevert(abi.encodeWithSignature("FeeTooHigh(uint256,uint256)", 60_000, 50_000));
        wv.execute(sid, 0, CREATE, args, 60_000, dl, x, y, r, s);
        _wexecRevert(sid, 0, CREATE, _cargs(freeRef, 1, 11e6), abi.encodeWithSignature("BudgetExceeded(uint256,uint256)", 11e6, 10e6));
    }

    // ---- scope on every later action ---------------------------------------------------------

    function test_appAGrantCannotTouchWalletAppB() public {
        // a session for ANY app creates B; a session naming only A must not act on it
        bytes32 any = _wopen(_anyBoth());
        bytes32 idB = abi.decode(_wexec(any, 0, CREATE, _cargs(freeRef, 1, 0), 0), (bytes32));
        WalletSessionVault.Grant memory g = _wgrant(_strs(_hexId(storeAppId)), _strs("staging"), 5e6);
        g.sessionKey = keyHash; g.grantNonce = keccak256("only-A");
        bytes32 onlyA = _wopen(g);
        vm.prank(owner); led.setDelegate(address(wv), true);
        bytes memory err = abi.encodeWithSignature("AppNotAllowed(bytes32)", freeAppId);
        _wexecRevert(onlyA, 0, FUND, abi.encode(idB, uint256(1e6)), err);
        _wexecRevert(onlyA, 0, SET_ACTIVE, abi.encode(idB, false), err);
        _wexecRevert(onlyA, 0, REFUND, abi.encode(idB), err);
        _wexecRevert(onlyA, 0, SET_SHARES, abi.encode(idB, uint16(0), uint16(500)), err);
    }

    function test_walletsOwnUnboundRecordIsNotASessionTarget() public {
        bytes32 sid = _wopen(_anyBoth());
        vm.prank(owner);
        bytes32 mine = led.create(freeRef, 0, 1000, 8080, "", false, "", address(0), 0, 1000);
        vm.prank(owner); led.setDelegate(address(wv), true);
        _wexecRevert(sid, 0, SET_ACTIVE, abi.encode(mine, false), abi.encodeWithSignature("NotHeld(bytes32)", mine));
        _wexecRevert(sid, 0, FUND, abi.encode(mine, uint256(1e6)), abi.encodeWithSignature("NotHeld(bytes32)", mine));
    }

    function test_missingDelegationRefusesOwnerGatedButNotPermissionlessFund() public {
        bytes32 sid = _wopen(_anyBoth());
        bytes32 id = abi.decode(_wexec(sid, 0, CREATE, _cargs(freeRef, 1, 0), 0), (bytes32));
        // owner-gated: the ledger itself refuses without the wallet's setDelegate
        _wexecRevert(sid, 1, SET_ACTIVE, abi.encode(id, false), abi.encodeWithSignature("Error(string)", "!owner"));
        // fund is permissionless at the ledger [ledger-assumption: a fresh unleased record's rate already equals its cap,
        // so prepareFund needs no setMaxRate]
        _wexec(sid, 1, FUND, abi.encode(id, uint256(1e6)), 0);
        assertEq(led.get(id).balance6, 1e6);
        vm.prank(owner); led.setDelegate(address(wv), true);
        _wexec(sid, 2, SET_ACTIVE, abi.encode(id, false), 0);
        assertFalse(led.get(id).active);
        // refund: the ledger pays the WALLET, never the vault or the session
        uint256 w = usdc.balanceOf(owner); uint256 v = usdc.balanceOf(address(wv));
        _wexec(sid, 3, REFUND, abi.encode(id), 0);
        assertGt(usdc.balanceOf(owner), w);
        assertEq(usdc.balanceOf(address(wv)), v);
    }

    function test_prodContentIsOwnersStagingRetargetChecksTarget() public {
        WalletSessionVault.Grant memory g = _wgrant(_strs(_hexId(freeAppId)), _strs("staging", "prod"), 10e6);
        bytes32 sid = _wopen(g);
        bytes32 stg = abi.decode(_wexec(sid, 0, CREATE, _cargs(freeRef, 1, 0), 0), (bytes32));
        bytes32 prd = abi.decode(_wexec(sid, 1, CREATE, _cargs(freeRef, 2, 0), 0), (bytes32));
        vm.prank(owner); led.setDelegate(address(wv), true);
        _wexecRevert(sid, 2, SET_APPREF, abi.encode(prd, freeRef), abi.encodeWithSignature("WrongEnvironment(bytes32,uint8)", prd, uint8(2)));
        _wexecRevert(sid, 2, SET_CONFIG, abi.encode(prd, "{}"), abi.encodeWithSignature("WrongEnvironment(bytes32,uint8)", prd, uint8(2)));
        _wexecRevert(sid, 2, SET_APPREF, abi.encode(stg, storeRef), abi.encodeWithSignature("AppNotAllowed(bytes32)", storeAppId));
        _wexec(sid, 2, SET_CONFIG, abi.encode(stg, "{}"), 0);
        assertEq(led.get(stg).configCid, "{}");
    }

    function test_foreignOwnerAfterWalletTransferStopsSessions() public {
        bytes32 sid = _wopen(_anyBoth());
        bytes32 id = abi.decode(_wexec(sid, 0, CREATE, _cargs(freeRef, 1, 0), 0), (bytes32));
        address other = vm.addr(OTHER_PK);
        vm.prank(owner); led.transferDeployment(id, other);
        _wexecRevert(sid, 1, FUND, abi.encode(id, uint256(1e6)), abi.encodeWithSignature("NotMine(bytes32)", id));
    }

    // ---- owner policy control ----------------------------------------------------------------

    function test_ownerApprovesExactProdContentAndStaleRevisionFails() public {
        bytes32 sid = _wopen(_anyBoth());
        bytes32 id = abi.decode(_wexec(sid, 0, CREATE, _cargs(freeRef, 2, 0), 0), (bytes32));
        vm.prank(owner); wv.approveContent(id, freeRef, "", 1, bytes32(0), 0, "");
        WP.Binding memory b = wv.policyOf(id);
        assertEq(b.approved, keccak256(abi.encode(freeRef, ""))); assertEq(b.revision, 2);
        vm.prank(owner); vm.expectRevert(abi.encodeWithSignature("StaleRevision(uint64,uint64)", uint64(2), uint64(1)));
        wv.approveContent(id, freeRef, "", 1, bytes32(0), 0, "");
        // moving environments clears the approval; detaching removes the policy and every session's reach
        vm.prank(owner); wv.setEnvironment(id, "staging", 2, bytes32(0), 0, "");
        assertEq(wv.policyOf(id).approved, bytes32(0));
        vm.prank(owner); wv.detach(id, 3, bytes32(0), 0, "");
        assertEq(wv.policyOf(id).state, 2);
        _wexecRevert(sid, 1, FUND, abi.encode(id, uint256(1e6)), abi.encodeWithSignature("NotHeld(bytes32)", id));
    }

    function test_strangerCannotChangePolicyOrSign() public {
        bytes32 sid = _wopen(_anyBoth());
        bytes32 id = abi.decode(_wexec(sid, 0, CREATE, _cargs(freeRef, 2, 0), 0), (bytes32));
        vm.prank(vm.addr(OTHER_PK));
        vm.expectRevert(abi.encodeWithSignature("BadSignature()"));
        wv.approveContent(id, freeRef, "", 1, keccak256("n"), uint64(vm.getBlockTimestamp() + 60), new bytes(65));
    }

    function test_registryOnlyAcceptsItsOwnVaultsOnce() public {
        vm.expectRevert(abi.encodeWithSignature("NotVault()"));
        wf.noteCreated(keccak256("x"));
    }

    // Root regression: policy-owner checks must read the pinned ledger, never a moved address-book ledger.
    function test_rootOwnerPolicyRejectsMovedLedgerBeforeOwnershipRead() public {
        bytes32 sid = _wopen(_anyBoth());
        bytes32 id = abi.decode(_wexec(sid, 0, CREATE, _cargs(freeRef, 1, 0), 0), (bytes32));
        book.set("deployments", address(ledger));
        vm.expectRevert(abi.encodeWithSignature("LedgerMoved()"));
        vm.prank(owner);
        wv.setEnvironment(id, "prod", 1, bytes32(0), 0, "");
    }
}
