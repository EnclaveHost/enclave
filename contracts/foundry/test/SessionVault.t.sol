// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Test, Vm } from "forge-std/Test.sol";
import { SessionVault, SessionVaultFactory, SessionVaultLib, CreateArgs, PublishArgs, ISVToken, ISVBook, ISVRouter,
    ISVKeyAttestations } from "../../SessionVault.sol";
import { EnclaveDeployments } from "../../EnclaveDeployments.sol";
import { EnclaveAppCatalog } from "../../EnclaveAppCatalog.sol";
import { EnclaveAddressBook } from "../../EnclaveAddressBook.sol";
import { PaymentRouter } from "../../PaymentRouter.sol";
import { MockUSDC3009, SessionRegistryStub, Mock1271Owner, MockKeyAttestations, HostileLedger }
    from "./mocks/SessionMocks.sol";

/// Shared rig: the REAL ledger, catalog, address book and PaymentRouter, a
/// USDC with EIP-3009, and real P-256 session signatures (vm.signP256). Every
/// digest the tests sign is computed HERE from the type strings, independently
/// of the vault's own encoder, so an encoding drift in either fails a test.
abstract contract SessionRig is Test {
    address constant P256 = 0x0000000000000000000000000000000000000100;
    uint256 constant T0 = 1_800_000_000;
    uint256 constant OWNER_PK = 0x0A11CE;
    uint256 constant OTHER_PK = 0xBADBAD;
    uint256 constant SK = 0x5E55;          // session key scalar
    uint256 constant SK2 = 0x5E56;

    bytes32 constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 constant GRANT_TYPEHASH = keccak256(
        "SessionGrant(string label,string preset,bytes32 sessionKey,string[] actions,string[] apps,"
        "string[] environments,uint256 budget,uint256 spendPerPeriod,uint32 periodSeconds,uint32 opsPerPeriod,"
        "uint256 maxFeePerOp,uint256 maxAppFeePerHour,uint256 maxRatePerHour,uint64 expiresAt,bytes32 measurement,"
        "bytes32 grantNonce,uint64 signBefore)");
    bytes32 constant CALL_TYPEHASH = keccak256(
        "SessionCall(bytes32 sessionId,uint256 nonce,uint8 action,bytes32 argsHash,uint256 fee,uint64 deadline)");
    bytes32 constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");

    MockUSDC3009 usdc;
    EnclaveAddressBook book;
    EnclaveDeployments ledger;
    EnclaveAppCatalog catalog;
    PaymentRouter router;
    SessionVaultFactory factory;
    SessionRegistryStub reg;

    address owner;
    address treasury = makeAddr("treasury");
    address payout = makeAddr("payout");
    address publisher = makeAddr("publisher");
    address relayer = makeAddr("relayer");
    SessionVault vault;          // the owner's vault (created lazily by openFor)
    uint256 kx; uint256 ky;      // session public key
    bytes32 keyHash;

    bytes32 storeAppId;          // a third-party, approved app (with a publisher fee)
    string storeRef;             // catalog://... of its version 0
    bytes32 freeAppId;           // a third-party, approved app (no fee)
    string freeRef;

    function setUp() public virtual {
        vm.warp(T0);
        _ensureP256();
        owner = vm.addr(OWNER_PK);
        usdc = new MockUSDC3009();
        book = new EnclaveAddressBook();
        reg = new SessionRegistryStub();
        ledger = new EnclaveDeployments(address(usdc), payout, address(reg), address(0));
        ledger.setProofRequiredFrom(0);
        catalog = new EnclaveAppCatalog();
        router = new PaymentRouter(address(usdc), treasury);
        book.set("deployments", address(ledger));
        book.set("appCatalog", address(catalog));
        factory = new SessionVaultFactory(ISVToken(address(usdc)), ISVBook(address(book)), ISVRouter(address(router)),
            ISVKeyAttestations(address(0)), 1_000e6);
        book.set("sessionVaultFactory", address(factory));
        vault = SessionVault(factory.vaultFor(owner));
        (kx, ky) = vm.publicKeyP256(SK);
        keyHash = keccak256(abi.encode(kx, ky));
        usdc.mint(owner, 10_000e6);

        uint32[4] memory res = [uint32(0), 0, 256, 10];
        vm.startPrank(publisher);
        (storeAppId, ) = catalog.publishVersion("store", "Store", "", "1.0.0", "bafystore", res, "", "", 100);
        (freeAppId, ) = catalog.publishVersion("freeapp", "Free", "", "2.0.0", "bafyfree", res, "", "", 0);
        vm.stopPrank();
        catalog.setApproval(storeAppId, 0, 1);
        catalog.setApproval(freeAppId, 0, 1);
        storeRef = _ref(storeAppId, 0);
        freeRef = _ref(freeAppId, 0);
    }

    function _ensureP256() internal {
        bytes32 digest = keccak256("p256 probe");
        (bytes32 r, bytes32 s) = vm.signP256(0xA1CE, digest);
        (uint256 x, uint256 y) = vm.publicKeyP256(0xA1CE);
        (bool ok, bytes memory ret) = P256.staticcall(abi.encodePacked(digest, r, s, x, y));
        if (!(ok && ret.length == 32 && ret[31] == 0x01))
            vm.etch(P256, vm.parseBytes(vm.readFile("contracts/foundry/test/fixtures/p256-verifier.hex")));
    }

    // ---- independent EIP-712 ----------------------------------------------------

    function _domain(address v) internal view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Enclave Sessions"), keccak256("1"), block.chainid, v));
    }

    function _typed(address v, bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _domain(v), structHash));
    }

    function _hs(string[] memory a) internal pure returns (bytes32) {
        bytes memory packed;
        for (uint256 i = 0; i < a.length; i++) packed = bytes.concat(packed, keccak256(bytes(a[i])));
        return keccak256(packed);
    }

    function _grantHash(SessionVault.Grant memory g) internal pure returns (bytes32) {
        bytes memory a = abi.encode(GRANT_TYPEHASH, keccak256(bytes(g.label)), keccak256(bytes(g.preset)), g.sessionKey,
            _hs(g.actions), _hs(g.apps), _hs(g.environments), g.budget);
        bytes memory b = abi.encode(g.spendPerPeriod, g.periodSeconds, g.opsPerPeriod, g.maxFeePerOp,
            g.maxAppFeePerHour, g.maxRatePerHour, g.expiresAt, g.measurement, g.grantNonce, g.signBefore);
        return keccak256(bytes.concat(a, b));
    }

    function _ecdsa(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // ---- grants -------------------------------------------------------------------

    function _strs(string memory a) internal pure returns (string[] memory o) { o = new string[](1); o[0] = a; }
    function _strs(string memory a, string memory b) internal pure returns (string[] memory o) {
        o = new string[](2); o[0] = a; o[1] = b;
    }

    function _allActions() internal pure returns (string[] memory o) {
        o = new string[](9);
        o[0] = "deploy.create"; o[1] = "deploy.fund"; o[2] = "deploy.setAppRef"; o[3] = "deploy.setConfig";
        o[4] = "deploy.setShares"; o[5] = "deploy.setMaxRate"; o[6] = "deploy.setActive"; o[7] = "deploy.refund";
        o[8] = "app.publish";
    }

    function _grant(bytes32 key, uint256 budget) internal view returns (SessionVault.Grant memory g) {
        g.label = "test session";
        g.preset = "custom";
        g.sessionKey = key;
        g.actions = _allActions();
        g.apps = _strs("*", "mine");
        g.environments = _strs("staging", "prod");
        g.budget = budget;
        g.spendPerPeriod = budget;
        g.periodSeconds = 1 days;
        g.opsPerPeriod = 0;
        g.maxFeePerOp = 50_000;              // $0.05
        g.maxAppFeePerHour = 1e6;            // $1/h
        g.maxRatePerHour = 10e6;             // $10/h: any rate cap the session sets
        g.expiresAt = uint64(vm.getBlockTimestamp() + 7 days);
        g.grantNonce = keccak256(abi.encode("grant", key, budget, vm.getBlockTimestamp()));
        g.signBefore = uint64(vm.getBlockTimestamp() + 10 minutes);
    }

    function _signGrant(SessionVault.Grant memory g) internal view returns (bytes memory) {
        return _ecdsa(OWNER_PK, _typed(address(vault), _grantHash(g)));
    }

    function _open(SessionVault.Grant memory g) internal returns (bytes32 sid) {
        vm.prank(relayer);
        (, sid) = factory.openFor(owner, g, _signGrant(g));
    }

    function _receiveSig(uint256 pk, address to, uint256 value, uint256 a, uint256 b, bytes32 nonce)
        internal view returns (bytes memory)
    {
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(),
            keccak256(abi.encode(RECEIVE_TYPEHASH, vm.addr(pk), to, value, a, b, nonce))));
        return _ecdsa(pk, d);
    }

    function _openWithDeposit(SessionVault.Grant memory g) internal returns (bytes32 sid) {
        bytes32 gd = _typed(address(vault), _grantHash(g));
        bytes memory auth = _receiveSig(OWNER_PK, address(vault), g.budget, 0, vm.getBlockTimestamp() + 1 hours, gd);
        vm.prank(relayer);
        (, sid) = factory.openWithDepositFor(owner, g, _signGrant(g), 0, vm.getBlockTimestamp() + 1 hours, auth);
    }

    // ---- session calls ------------------------------------------------------------

    function _callDigest(bytes32 sid, uint256 nonce, uint8 action, bytes memory args, uint256 fee, uint64 deadline)
        internal view returns (bytes32)
    {
        return _typed(address(vault),
            keccak256(abi.encode(CALL_TYPEHASH, sid, nonce, action, keccak256(args), fee, deadline)));
    }

    function _exec(bytes32 sid, uint256 nonce, uint8 action, bytes memory args, uint256 fee)
        internal returns (bytes memory)
    {
        return _execAs(SK, sid, nonce, action, args, fee);
    }

    function _execAs(uint256 sk, bytes32 sid, uint256 nonce, uint8 action, bytes memory args, uint256 fee)
        internal returns (bytes memory)
    {
        uint64 deadline = uint64(vm.getBlockTimestamp() + 120);
        bytes32 d = _callDigest(sid, nonce, action, args, fee, deadline);
        (bytes32 r, bytes32 s) = vm.signP256(sk, sha256(abi.encodePacked(d)));
        (uint256 x, uint256 y) = vm.publicKeyP256(sk);
        vm.prank(relayer);
        return vault.execute(sid, nonce, action, args, fee, deadline, x, y, r, s);
    }

    function _execExpectRevert(bytes32 sid, uint256 nonce, uint8 action, bytes memory args, uint256 fee,
        bytes memory err) internal
    {
        uint64 deadline = uint64(vm.getBlockTimestamp() + 120);
        bytes32 d = _callDigest(sid, nonce, action, args, fee, deadline);
        (bytes32 r, bytes32 s) = vm.signP256(SK, sha256(abi.encodePacked(d)));
        vm.prank(relayer);
        vm.expectRevert(err);
        vault.execute(sid, nonce, action, args, fee, deadline, kx, ky, r, s);
    }

    function _createArgs(string memory ref, uint8 env, uint256 fund6) internal pure returns (bytes memory) {
        return abi.encode(CreateArgs({ appRef: ref, gpuMilli: 0, cpuMilli: 1000, appPort: 8080, ports: "",
            isPublic: false, configCid: "", maxRate6: 1000, env: env, fund6: fund6 }));   // $3.60/h
    }

    function _ref(bytes32 appId, uint256 idx) internal pure returns (string memory) {
        return string.concat("catalog://", vm.toString(appId), "/", vm.toString(idx));
    }

    // owner-op signatures
    function _ownerSig(bytes32 structHash) internal view returns (bytes memory) {
        return _ecdsa(OWNER_PK, _typed(address(vault), structHash));
    }
}

contract SessionVaultTest is SessionRig {
    uint8 constant CREATE = 0; uint8 constant FUND = 1; uint8 constant SET_APPREF = 2; uint8 constant SET_CONFIG = 3;
    uint8 constant SET_SHARES = 4; uint8 constant SET_MAXRATE = 5; uint8 constant SET_ACTIVE = 6;
    uint8 constant REFUND = 7; uint8 constant PUBLISH = 8;

    uint256 private _targets;
    /// a staging deployment the vault holds, made by a SEPARATE session (so the
    /// session under test keeps its own nonces and limits): what spend tests fund
    function _target() internal returns (bytes32 id) {
        SessionVault.Grant memory g = _grant(keyHash, 0);
        g.grantNonce = keccak256(abi.encode("target", _targets++));
        bytes32 tsid = _open(g);
        id = abi.decode(_exec(tsid, 0, CREATE, _createArgs(freeRef, 1, 0), 0), (bytes32));
    }
    function _fund(bytes32 id, uint256 amt) internal pure returns (bytes memory) { return abi.encode(id, amt); }
    function _createArgsRate(string memory ref, uint8 env, uint256 fund6, uint256 rate) internal pure returns (bytes memory) {
        return abi.encode(CreateArgs({ appRef: ref, gpuMilli: 0, cpuMilli: 1000, appPort: 8080, ports: "",
            isPublic: false, configCid: "", maxRate6: rate, env: env, fund6: fund6 }));
    }

    // ======================= opening =======================

    function test_openZeroBudgetCreatesVaultAndSession() public {
        assertEq(address(vault).code.length, 0, "vault not yet deployed");
        SessionVault.Grant memory g = _grant(keyHash, 0);
        bytes32 sid = _open(g);
        assertGt(address(vault).code.length, 0);
        assertTrue(factory.isVault(address(vault)));
        assertEq(vault.owner(), owner);
        assertEq(sid, keccak256(abi.encode(address(vault), keyHash, g.grantNonce)));
        assertEq(sid, vault.sessionIdOf(keyHash, g.grantNonce));
        assertTrue(vault.isLive(sid));
        assertEq(vault.grantDigest(g), _typed(address(vault), _grantHash(g)), "vault and test encoders agree");
        (SessionVault.Session memory s, bool live, bytes32[] memory apps) = vault.sessionOf(sid);
        assertTrue(live);
        assertEq(s.keyHash, keyHash);
        assertEq(s.envs, 3);
        assertTrue(s.anyApp);
        assertEq(apps.length, 1);
        assertEq(apps[0], catalog.appIdOf(address(vault), "mine"));
        assertEq(s.actions, (1 << 9) - 1);
    }

    function test_openRejectsWrongSignerExpiryAndReplay() public {
        SessionVault.Grant memory g = _grant(keyHash, 0);
        bytes memory bad = _ecdsa(OTHER_PK, _typed(address(vault), _grantHash(g)));
        vm.expectRevert(SessionVault.BadSignature.selector);
        factory.openFor(owner, g, bad);

        bytes memory sig = _signGrant(g);
        vm.warp(g.signBefore + 1);
        vm.expectRevert(SessionVault.Expired.selector);
        factory.openFor(owner, g, sig);

        vm.warp(T0);
        factory.openFor(owner, g, sig);
        vm.expectRevert(SessionVault.Exists.selector);
        factory.openFor(owner, g, sig);
    }

    function test_openRejectsTamperedGrant() public {
        SessionVault.Grant memory g = _grant(keyHash, 0);
        bytes memory sig = _signGrant(g);
        g.environments = _strs("prod");           // relayer widens nothing it can't re-sign
        vm.expectRevert(SessionVault.BadSignature.selector);
        factory.openFor(owner, g, sig);
        g = _grant(keyHash, 0);
        g.actions = _strs("deploy.fund");
        vm.expectRevert(SessionVault.BadSignature.selector);
        factory.openFor(owner, g, sig);
    }

    function test_ownerOpensDirectlyWithoutSignature() public {
        factory.createVault(owner);
        SessionVault.Grant memory g = _grant(keyHash, 0);
        vm.prank(owner);
        bytes32 sid = vault.open(g, "");
        assertTrue(vault.isLive(sid));
    }

    function test_openPolicyValidation() public {
        factory.createVault(owner);
        SessionVault.Grant memory g = _grant(keyHash, 0);
        g.actions = _strs("deploy.everything");
        vm.prank(owner);
        vm.expectRevert(SessionVaultLib.UnknownAction.selector);
        vault.open(g, "");
        g = _grant(keyHash, 0);
        g.environments = _strs("production");
        vm.prank(owner);
        vm.expectRevert(SessionVaultLib.UnknownEnvironment.selector);
        vault.open(g, "");
        g = _grant(keyHash, 0);
        g.expiresAt = uint64(vm.getBlockTimestamp());
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(SessionVault.BadPolicy.selector, uint8(3)));
        vault.open(g, "");
        g = _grant(keyHash, 0);
        g.periodSeconds = 0;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(SessionVault.BadPolicy.selector, uint8(4)));
        vault.open(g, "");
        g = _grant(keyHash, 0);
        g.apps = new string[](9);
        for (uint256 i = 0; i < 9; i++) g.apps[i] = "x";
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(SessionVault.BadPolicy.selector, uint8(6)));
        vault.open(g, "");
    }

    function test_openFromFreeBalanceNeedsFreeBalance() public {
        factory.createVault(owner);
        SessionVault.Grant memory g = _grant(keyHash, 5e6);
        vm.expectRevert(abi.encodeWithSelector(SessionVault.BudgetExceeded.selector, 5e6, 0));
        vm.prank(owner); vault.open(g, "");
        usdc.mint(address(vault), 5e6);           // e.g. a ledger refund landed
        vm.prank(owner); bytes32 sid = vault.open(g, "");
        assertEq(vault.locked6(), 5e6);
        assertEq(vault.free(), 0);
        (SessionVault.Session memory s,,) = vault.sessionOf(sid);
        assertEq(s.balance6, 5e6);
    }

    function test_openWithDepositPullsExactlyTheGrantBudget() public {
        SessionVault.Grant memory g = _grant(keyHash, 20e6);
        bytes32 sid = _openWithDeposit(g);
        assertEq(usdc.balanceOf(address(vault)), 20e6);
        assertEq(usdc.balanceOf(owner), 10_000e6 - 20e6);
        assertEq(vault.locked6(), 20e6);
        assertTrue(vault.isLive(sid));
    }

    function test_openWithDepositRefusesAuthorizationForAnotherGrant() public {
        SessionVault.Grant memory g = _grant(keyHash, 20e6);
        SessionVault.Grant memory other = _grant(keyHash, 20e6);
        other.grantNonce = keccak256("other");
        // the USDC authorization commits to `other`'s digest; it can't fund `g`
        bytes32 od = _typed(address(vault), _grantHash(other));
        bytes memory auth = _receiveSig(OWNER_PK, address(vault), 20e6, 0, vm.getBlockTimestamp() + 1 hours, od);
        bytes memory gsig = _signGrant(g);
        vm.expectRevert("invalid signature");
        factory.openWithDepositFor(owner, g, gsig, 0, vm.getBlockTimestamp() + 1 hours, auth);
    }

    function test_depositCap() public {
        SessionVault.Grant memory g = _grant(keyHash, 1_001e6);
        bytes32 gd = _typed(address(vault), _grantHash(g));
        bytes memory auth = _receiveSig(OWNER_PK, address(vault), g.budget, 0, vm.getBlockTimestamp() + 1 hours, gd);
        bytes memory gsig = _signGrant(g);
        vm.expectRevert(abi.encodeWithSelector(SessionVault.OverCap.selector, 1_001e6, 1_000e6));
        factory.openWithDepositFor(owner, g, gsig, 0, vm.getBlockTimestamp() + 1 hours, auth);
    }

    function test_implementationAndCloneCannotBeReinitialized() public {
        SessionVault impl = factory.implementation();
        vm.expectRevert(SessionVault.NotFactory.selector);
        impl.initialize(owner);
        factory.createVault(owner);
        vm.prank(address(factory));
        vm.expectRevert(SessionVault.Initialized.selector);
        vault.initialize(address(0xdead));
        assertEq(factory.createVault(owner), address(vault), "idempotent");
    }

    // ======================= session calls =======================

    function test_createStagingDeploymentHeldByVaultWithCatalogFee() public {
        SessionVault.Grant memory g = _grant(keyHash, 50e6);
        g.apps = _strs(vm.toString(storeAppId), "mine");   // a PAID app must be named; "*" never covers one
        bytes32 sid = _openWithDeposit(g);
        bytes memory ret = _exec(sid, 0, CREATE, _createArgs(storeRef, 1, 10e6), 1000);
        bytes32 id = abi.decode(ret, (bytes32));
        EnclaveDeployments.Deployment memory d = ledger.get(id);
        assertEq(d.owner, address(vault));
        assertEq(d.appRef, storeRef);
        (address feeTo, uint256 feeSec) = ledger.feeOf(id);
        assertEq(feeTo, publisher, "fee recipient comes from the catalog");
        assertEq(feeSec, 100);
        (uint8 env,, bytes32 createdBy) = vault.held(id);
        assertEq(env, 1);
        assertEq(createdBy, sid);
        assertEq(d.balance6, 10e6);
        (SessionVault.Session memory s,,) = vault.sessionOf(sid);
        assertEq(s.balance6, 50e6 - 10e6 - 1000);
        assertEq(s.spent6, 10e6 + 1000);
        assertEq(usdc.balanceOf(treasury), 1000, "relay fee reached the treasury via the router");
        assertEq(usdc.allowance(address(vault), address(ledger)), 0);
        assertEq(usdc.allowance(address(vault), address(router)), 0);
        assertEq(vault.locked6(), usdc.balanceOf(address(vault)));
    }

    function test_createRefusesExpensiveAppAndUnlistedApp() public {
        // no wildcard: only the named apps
        SessionVault.Grant memory g = _grant(keyHash, 10e6);
        g.apps = _strs("mine");
        bytes32 sid = _openWithDeposit(g);
        _execExpectRevert(sid, 0, CREATE, _createArgs(freeRef, 1, 0), 0,
            abi.encodeWithSelector(SessionVault.AppNotAllowed.selector, freeAppId));
        // a wildcard NEVER covers a paid app: a hostile publisher's fee is how a budget would leave at funding time
        SessionVault.Grant memory g2 = _grant(keyHash, 10e6);
        g2.grantNonce = keccak256("g2");
        g2.apps = _strs("*");
        bytes32 sid2 = _openWithDeposit(g2);
        _execExpectRevert(sid2, 0, CREATE, _createArgs(storeRef, 1, 0), 0,
            abi.encodeWithSelector(SessionVaultLib.AppNotAllowed.selector, storeAppId));
        _exec(sid2, 0, CREATE, _createArgs(freeRef, 1, 0), 0);           // a free app is fine under "*"
        // named, but its fee is over the grant's hourly ceiling
        SessionVault.Grant memory g3 = _grant(keyHash, 10e6);
        g3.grantNonce = keccak256("g3");
        g3.apps = _strs(vm.toString(storeAppId));
        g3.maxAppFeePerHour = 100 * 3600 - 1;
        bytes32 sid3 = _openWithDeposit(g3);
        _execExpectRevert(sid3, 0, CREATE, _createArgs(storeRef, 1, 0), 0,
            abi.encodeWithSelector(SessionVaultLib.AppFeeTooHigh.selector, 100 * 3600, 100 * 3600 - 1));
        // named and affordable, but a rate cap that would hand the publisher most of every funding
        SessionVault.Grant memory g4 = _grant(keyHash, 10e6);
        g4.grantNonce = keccak256("g4");
        g4.apps = _strs(vm.toString(storeAppId));
        bytes32 sid4 = _openWithDeposit(g4);
        _execExpectRevert(sid4, 0, CREATE, _createArgsRate(storeRef, 1, 1e6, 199), 0,
            abi.encodeWithSelector(SessionVaultLib.RateCapOutOfRange.selector, 199, 200));
        // and any rate cap above the grant's own ceiling
        _execExpectRevert(sid4, 0, CREATE, _createArgsRate(freeRef, 1, 0, 2778), 0,
            abi.encodeWithSelector(SessionVault.AppNotAllowed.selector, freeAppId));
        _execExpectRevert(sid2, 1, CREATE, _createArgsRate(freeRef, 1, 0, 2778), 0,
            abi.encodeWithSelector(SessionVault.RateCapOutOfRange.selector, 2778 * 3600, 10e6));
    }

    function test_createRefusesEnvironmentOutsidePolicyAndBadRefs() public {
        SessionVault.Grant memory g = _grant(keyHash, 10e6);
        g.environments = _strs("staging");
        bytes32 sid = _openWithDeposit(g);
        _execExpectRevert(sid, 0, CREATE, _createArgs(freeRef, 2, 0), 0,
            abi.encodeWithSelector(SessionVault.EnvNotAllowed.selector, uint8(2)));
        _execExpectRevert(sid, 0, CREATE, _createArgs("ipfs://bafyfree", 1, 0), 0,
            abi.encodeWithSelector(SessionVaultLib.BadRef.selector));
        _execExpectRevert(sid, 0, CREATE, _createArgs(string.concat(freeRef, "x"), 1, 0), 0,
            abi.encodeWithSelector(SessionVaultLib.BadRef.selector));
        _execExpectRevert(sid, 0, CREATE, _createArgs(freeRef, 3, 0), 0,
            abi.encodeWithSelector(SessionVault.UnknownEnvironment.selector));
    }

    function test_stagingVersusProdControls() public {
        bytes32 sid = _openWithDeposit(_grant(keyHash, 50e6));
        bytes32 stg = abi.decode(_exec(sid, 0, CREATE, _createArgs(freeRef, 1, 0), 0), (bytes32));
        bytes32 prd = abi.decode(_exec(sid, 1, CREATE, _createArgs(freeRef, 2, 0), 0), (bytes32));
        string memory other = _ref(storeAppId, 0);
        _exec(sid, 2, SET_APPREF, abi.encode(stg, other), 0);
        assertEq(ledger.get(stg).appRef, other);
        _exec(sid, 3, SET_CONFIG, abi.encode(stg, '{"config":{"a":1}}'), 0);
        assertEq(ledger.get(stg).configCid, '{"config":{"a":1}}');
        // prod: version and config are promotion, owner-only
        _execExpectRevert(sid, 4, SET_APPREF, abi.encode(prd, other), 0,
            abi.encodeWithSelector(SessionVault.WrongEnvironment.selector, prd, uint8(2)));
        _execExpectRevert(sid, 4, SET_CONFIG, abi.encode(prd, "{}"), 0,
            abi.encodeWithSelector(SessionVault.WrongEnvironment.selector, prd, uint8(2)));
        // but the non-promotion controls work on prod
        _exec(sid, 4, SET_SHARES, abi.encode(prd, uint16(0), uint16(500)), 0);
        _exec(sid, 5, SET_MAXRATE, abi.encode(prd, uint256(500)), 0);      // prod: lowering is fine
        _exec(sid, 6, SET_ACTIVE, abi.encode(prd, false), 0);
        assertFalse(ledger.get(prd).active);
        (, bytes32 promoted,) = vault.held(prd);
        assertEq(promoted, bytes32(0), "a session-created prod deployment starts unpromoted");
    }

    function test_refundProceedsAreFreeBalanceNeverSession() public {
        bytes32 sid = _openWithDeposit(_grant(keyHash, 50e6));
        bytes32 id = abi.decode(_exec(sid, 0, CREATE, _createArgs(freeRef, 1, 20e6), 0), (bytes32));
        uint256 refundable = ledger.refundableOf(id);
        assertGt(refundable, 0);
        uint256 lockedBefore = vault.locked6();
        _exec(sid, 1, REFUND, abi.encode(id), 0);
        assertEq(vault.locked6(), lockedBefore, "session balance unchanged");
        assertEq(vault.free(), refundable, "refund lands as the owner's free balance");
    }

    function test_fundRefusesWalletHeldDeploymentsEvenGiftedOnes() public {
        // the owner's own wallet deployment: sessions fund only what the VAULT holds
        vm.prank(owner);
        bytes32 mine = ledger.create(freeRef, 0, 1000, 8080, "", false, "", address(0), 0, 1000);
        // an attacker's deployment GIFTED to the owner's wallet (one-step transfer), carrying a
        // fee to the attacker and a rate cap barely above it: funding it would drain the budget
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        bytes32 gift = ledger.create(freeRef, 0, 1000, 8080, "", false, "", attacker, 1389, 1390);
        vm.prank(attacker); ledger.transferDeployment(gift, owner);
        bytes32 sid = _openWithDeposit(_grant(keyHash, 50e6));
        _execExpectRevert(sid, 0, FUND, _fund(mine, 5e6), 0, abi.encodeWithSelector(SessionVault.NotMine.selector, mine));
        _execExpectRevert(sid, 0, FUND, _fund(gift, 5e6), 0, abi.encodeWithSelector(SessionVault.NotMine.selector, gift));
        assertEq(usdc.balanceOf(attacker), 0);
    }

    function test_fundRefusesStrangersAndUnadoptedAndProdWhenStagingOnly() public {
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        bytes32 theirs = ledger.create(freeRef, 0, 1000, 8080, "", false, "", address(0), 0, 1e6);
        vm.prank(owner);
        bytes32 mineWallet = ledger.create(freeRef, 0, 1000, 8080, "", false, "", address(0), 0, 1e6);
        vm.prank(stranger);
        bytes32 gift = ledger.create(freeRef, 0, 1000, 8080, "", false, "", address(0), 0, 1e6);
        SessionVault.Grant memory g = _grant(keyHash, 50e6);
        g.environments = _strs("staging");
        bytes32 sid = _openWithDeposit(g);
        vm.prank(stranger); ledger.transferDeployment(gift, address(vault));
        _execExpectRevert(sid, 0, FUND, abi.encode(theirs, uint256(1e6)), 0,
            abi.encodeWithSelector(SessionVault.NotMine.selector, theirs));
        _execExpectRevert(sid, 0, FUND, abi.encode(mineWallet, uint256(1e6)), 0,
            abi.encodeWithSelector(SessionVault.NotMine.selector, mineWallet));
        _execExpectRevert(sid, 0, FUND, abi.encode(gift, uint256(1e6)), 0,
            abi.encodeWithSelector(SessionVault.NotHeld.selector, gift));
    }

    function test_publishToNamedVaultAppOnly() public {
        SessionVault.Grant memory g = _grant(keyHash, 0);
        g.apps = _strs("*", "mine-staging");
        bytes32 sid = _open(g);
        uint32[4] memory res = [uint32(0), 0, 256, 10];
        bytes memory args = abi.encode(PublishArgs({ slug: "mine-staging", name: "Mine (staging)", description: "",
            version: "0.1.0", cid: "bafymine1", res: res, ports: "", config: "{}", configCid: "" }));
        (bytes32 appId, uint256 idx) = abi.decode(_exec(sid, 0, PUBLISH, args, 0), (bytes32, uint256));
        assertEq(appId, catalog.appIdOf(address(vault), "mine-staging"));
        EnclaveAppCatalog.App memory a = catalog.getApp(appId);
        assertEq(a.publisher, address(vault));
        assertEq(catalog.getVersion(appId, idx).approval, 0, "session publishes land Pending");
        assertEq(catalog.versionFee(appId, idx), 0);
        // config CID path
        args = abi.encode(PublishArgs({ slug: "mine-staging", name: "Mine (staging)", description: "",
            version: "0.1.1", cid: "bafymine2", res: res, ports: "", config: "{}", configCid: "bafycfg" }));
        (, idx) = abi.decode(_exec(sid, 1, PUBLISH, args, 0), (bytes32, uint256));
        assertEq(catalog.versionConfigCid(appId, idx), "bafycfg");
        // "*" never covers publishing
        args = abi.encode(PublishArgs({ slug: "other", name: "O", description: "", version: "1", cid: "bafyo",
            res: res, ports: "", config: "", configCid: "" }));
        _execExpectRevert(sid, 2, PUBLISH, args, 0, abi.encodeWithSelector(SessionVault.AppNotAllowed.selector,
            catalog.appIdOf(address(vault), "other")));
    }

    function test_orderPayIsNotAnAction() public {
        // order.pay was dropped before launch: an orderRef binds no payer, so a leaked key
        // could pay an attacker's order. A grant naming it cannot even open.
        factory.createVault(owner);
        SessionVault.Grant memory g = _grant(keyHash, 0);
        g.actions = _strs("order.pay");
        vm.prank(owner);
        vm.expectRevert(SessionVaultLib.UnknownAction.selector);
        vault.open(g, "");
        // and action index 9 is refused even for a session with every bit
        bytes32 sid = _openWithDeposit(_grant(keyHash, 1e6));
        _execExpectRevert(sid, 0, 9, abi.encode(uint256(1), bytes32("o")), 0,
            abi.encodeWithSelector(SessionVault.NotAllowed.selector, uint8(9)));
    }

    // ======================= limits =======================

    function test_budgetPeriodRateAndFeeLimits() public {
        bytes32 t = _target();
        SessionVault.Grant memory g = _grant(keyHash, 30e6);
        g.spendPerPeriod = 10e6;
        g.opsPerPeriod = 3;
        g.maxFeePerOp = 1000;
        bytes32 sid = _openWithDeposit(g);
        _execExpectRevert(sid, 0, FUND, _fund(t, 6e6), 1001, abi.encodeWithSelector(SessionVault.FeeTooHigh.selector, 1001, 1000));
        _exec(sid, 0, FUND, _fund(t, 6e6), 1000);
        _execExpectRevert(sid, 1, FUND, _fund(t, 5e6), 0,
            abi.encodeWithSelector(SessionVault.PeriodLimit.selector, 5e6, 10e6 - 6e6 - 1000));
        _exec(sid, 1, FUND, _fund(t, 1e6), 0);
        _exec(sid, 2, FUND, _fund(t, 1), 0);
        _execExpectRevert(sid, 3, FUND, _fund(t, 1), 0, abi.encodeWithSelector(SessionVault.RateLimit.selector));
        vm.warp(vm.getBlockTimestamp() + 1 days);        // next period
        _exec(sid, 3, FUND, _fund(t, 9e6), 0);
        // remaining budget 30 - 6.001 - 1 - 0.000001 - 9 = 13.998999
        vm.warp(vm.getBlockTimestamp() + 1 days);
        _execExpectRevert(sid, 4, FUND, _fund(t, 14e6), 0,
            abi.encodeWithSelector(SessionVault.BudgetExceeded.selector, 14e6, 30e6 - 6e6 - 1000 - 1e6 - 1 - 9e6));
        assertEq(ledger.get(t).balance6, 6e6 + 1e6 + 1 + 9e6, "every unit spent landed on the vault-held deployment");
    }

    function test_actionsOutsidePolicyRefused() public {
        SessionVault.Grant memory g = _grant(keyHash, 10e6);
        g.actions = _strs("api.logs", "deploy.fund");
        bytes32 sid = _openWithDeposit(g);
        _execExpectRevert(sid, 0, SET_ACTIVE, abi.encode(bytes32(0), true), 0,
            abi.encodeWithSelector(SessionVault.NotAllowed.selector, uint8(6)));
        _execExpectRevert(sid, 0, 9, "", 0, abi.encodeWithSelector(SessionVault.NotAllowed.selector, uint8(9)));
        _execExpectRevert(sid, 0, 10, "", 0, abi.encodeWithSelector(SessionVault.NotAllowed.selector, uint8(10)));
        _execExpectRevert(sid, 0, 200, "", 0, abi.encodeWithSelector(SessionVault.NotAllowed.selector, uint8(200)));
    }

    // ======================= signatures & nonces =======================

    function test_nonceLanesAndReplay() public {
        bytes32 t = _target();
        bytes32 sid = _openWithDeposit(_grant(keyHash, 10e6));
        bytes memory a = _fund(t, 1);
        _exec(sid, 0, FUND, a, 0);
        _execExpectRevert(sid, 0, FUND, a, 0, abi.encodeWithSelector(SessionVault.BadNonce.selector));
        _execExpectRevert(sid, 2, FUND, a, 0, abi.encodeWithSelector(SessionVault.BadNonce.selector));
        uint256 lane7 = uint256(7) << 64;
        _exec(sid, lane7, FUND, a, 0);              // an independent lane starts at 0
        _exec(sid, 1, FUND, a, 0);
        _exec(sid, lane7 + 1, FUND, a, 0);
        assertEq(vault.seqOf(sid, 7), 2);
        assertEq(vault.seqOf(sid, 0), 2);
    }

    function test_badSessionSignaturesRefused() public {
        bytes32 t = _target();
        bytes32 sid = _openWithDeposit(_grant(keyHash, 10e6));
        bytes memory a = _fund(t, 1);
        uint64 deadline = uint64(vm.getBlockTimestamp() + 120);
        bytes32 d = _callDigest(sid, 0, FUND, a, 0, deadline);
        (bytes32 r, bytes32 s) = vm.signP256(SK, sha256(abi.encodePacked(d)));
        // another key's signature, presented with its own (unregistered) public key
        (bytes32 r2, bytes32 s2) = vm.signP256(SK2, sha256(abi.encodePacked(d)));
        (uint256 x2, uint256 y2) = vm.publicKeyP256(SK2);
        vm.expectRevert(SessionVault.BadSignature.selector);
        vault.execute(sid, 0, FUND, a, 0, deadline, x2, y2, r2, s2);
        // the right key's signature over different args
        vm.expectRevert(SessionVault.BadSignature.selector);
        vault.execute(sid, 0, FUND, _fund(t, 2), 0, deadline, kx, ky, r, s);
        // a different fee than signed
        vm.expectRevert(SessionVault.BadSignature.selector);
        vault.execute(sid, 0, FUND, a, 1, deadline, kx, ky, r, s);
        // signing the raw digest (not sha256 of it) is not what the vault verifies
        (bytes32 r3, bytes32 s3) = vm.signP256(SK, d);
        vm.expectRevert(SessionVault.BadSignature.selector);
        vault.execute(sid, 0, FUND, a, 0, deadline, kx, ky, r3, s3);
        // expired deadline
        vm.warp(deadline + 1);
        vm.expectRevert(SessionVault.Expired.selector);
        vault.execute(sid, 0, FUND, a, 0, deadline, kx, ky, r, s);
        vm.warp(T0);
        vault.execute(sid, 0, FUND, a, 0, deadline, kx, ky, r, s);
    }

    function test_signatureNotReplayableAcrossVaults() public {
        bytes32 t = _target();
        bytes32 sid = _openWithDeposit(_grant(keyHash, 10e6));
        // a second owner's vault with a session on the SAME key and grant nonce
        uint256 pk2 = 0xB0B;
        address owner2 = vm.addr(pk2);
        SessionVault v2 = SessionVault(factory.createVault(owner2));
        SessionVault.Grant memory g = _grant(keyHash, 0);
        vm.prank(owner2); bytes32 sid2 = v2.open(g, "");
        bytes memory a = _fund(t, 1);
        uint64 deadline = uint64(vm.getBlockTimestamp() + 120);
        bytes32 d = _callDigest(sid, 0, FUND, a, 0, deadline);
        (bytes32 r, bytes32 s) = vm.signP256(SK, sha256(abi.encodePacked(d)));
        vm.expectRevert(SessionVault.BadSignature.selector);
        v2.execute(sid2, 0, FUND, a, 0, deadline, kx, ky, r, s);
        assertTrue(sid != sid2);
    }

    // ======================= ending =======================

    function test_ownerTerminateRefundsWalletImmediately() public {
        bytes32 t = _target();
        bytes32 sid = _openWithDeposit(_grant(keyHash, 20e6));
        _exec(sid, 0, FUND, _fund(t, 3e6), 0);
        uint256 before = usdc.balanceOf(owner);
        bytes32 n = keccak256("t1");
        uint64 sb = uint64(vm.getBlockTimestamp() + 600);
        bytes memory sig = _ownerSig(keccak256(abi.encode(vault.TERMINATE_TYPEHASH(), sid, n, sb)));
        vm.prank(relayer);
        vault.terminate(sid, n, sb, sig);
        assertEq(usdc.balanceOf(owner), before + 17e6);
        assertFalse(vault.isLive(sid));
        assertEq(vault.locked6(), 0);
        _execExpectRevert(sid, 1, FUND, _fund(t, 1), 0, abi.encodeWithSelector(SessionVault.NotLive.selector));
        vm.prank(relayer);
        vm.expectRevert(SessionVault.NonceUsed.selector);
        vault.terminate(sid, n, sb, sig);
    }

    function test_sessionKeyTerminatesItself() public {
        bytes32 sid = _openWithDeposit(_grant(keyHash, 20e6));
        uint64 deadline = uint64(vm.getBlockTimestamp() + 120);
        bytes32 d = _typed(address(vault), keccak256(abi.encode(keccak256("SessionEnd(bytes32 sessionId,uint64 deadline)"), sid, deadline)));
        (bytes32 r, bytes32 s) = vm.signP256(SK, sha256(abi.encodePacked(d)));
        uint256 before = usdc.balanceOf(owner);
        vm.prank(relayer);
        vault.terminateBySession(sid, deadline, kx, ky, r, s);
        assertEq(usdc.balanceOf(owner), before + 20e6);
        assertFalse(vault.isLive(sid));
    }

    function test_closeAfterExpiryByAnyone() public {
        bytes32 t = _target();
        SessionVault.Grant memory g = _grant(keyHash, 20e6);
        g.maxFeePerOp = 2000;
        bytes32 sid = _openWithDeposit(g);
        vm.expectRevert(SessionVault.NotExpired.selector);
        vault.close(sid);
        vm.warp(g.expiresAt + 1);
        assertFalse(vault.isLive(sid));
        _execExpectRevert(sid, 0, FUND, _fund(t, 1), 0, abi.encodeWithSelector(SessionVault.NotLive.selector));
        uint256 before = usdc.balanceOf(owner);
        vm.prank(makeAddr("keeper"));
        vault.close(sid);
        assertEq(usdc.balanceOf(owner), before + 20e6 - 2000);
        assertEq(usdc.balanceOf(treasury), 2000);
        vm.expectRevert(SessionVault.NotLive.selector);
        vault.close(sid);
    }

    function test_closeFeeIsTheKeepersCostNotTheWholeCap() public {
        SessionVault.Grant memory g = _grant(keyHash, 20e6);
        g.maxFeePerOp = 250_000;                       // a generous per-op ceiling...
        bytes32 sid = _openWithDeposit(g);
        vm.warp(g.expiresAt + 1);
        vault.close(sid);
        assertEq(usdc.balanceOf(treasury), 20_000, "...but closing costs at most $0.02");
    }

    function test_ownerTerminatesAnExpiredSessionWithoutAFee() public {
        SessionVault.Grant memory g = _grant(keyHash, 20e6);
        bytes32 sid = _openWithDeposit(g);
        vm.warp(g.expiresAt + 1);
        uint256 before = usdc.balanceOf(owner);
        vm.prank(owner);
        vault.terminate(sid, bytes32(0), 0, "");
        assertEq(usdc.balanceOf(owner), before + 20e6);
        assertEq(usdc.balanceOf(treasury), 0);
    }

    function test_revokeAllKillsEverySessionInOneCall() public {
        bytes32 t = _target();
        bytes32 a = _openWithDeposit(_grant(keyHash, 20e6));
        (uint256 x2, uint256 y2) = vm.publicKeyP256(SK2);
        bytes32 b = _openWithDeposit(_grant(keccak256(abi.encode(x2, y2)), 30e6));
        usdc.mint(address(vault), 1e6);        // some free balance too
        bytes32 n = keccak256("r");
        uint64 sb = uint64(vm.getBlockTimestamp() + 600);
        bytes memory sig = _ownerSig(keccak256(abi.encode(vault.REVOKE_TYPEHASH(), true, n, sb)));
        uint256 before = usdc.balanceOf(owner);
        vm.prank(relayer);
        vault.revokeAll(true, n, sb, sig);
        assertFalse(vault.isLive(a));
        assertFalse(vault.isLive(b));
        assertEq(usdc.balanceOf(owner), before + 51e6);
        assertEq(usdc.balanceOf(address(vault)), 0);
        assertEq(vault.locked6(), 0);
        (SessionVault.Session memory s,,) = vault.sessionOf(a);
        assertEq(s.balance6, 0, "effective balance of a revoked session is 0");
        vault.close(a);                         // tidies without paying anything
        _execExpectRevert(b, 0, FUND, _fund(t, 1), 0, abi.encodeWithSelector(SessionVault.NotLive.selector));
    }

    function test_withdrawOnlyFreeBalanceOnlyToOwner() public {
        _openWithDeposit(_grant(keyHash, 20e6));
        usdc.mint(address(vault), 3e6);
        bytes32 n = keccak256("w");
        uint64 sb = uint64(vm.getBlockTimestamp() + 600);
        bytes memory sig = _ownerSig(keccak256(abi.encode(vault.WITHDRAW_TYPEHASH(), uint256(4e6), n, sb)));
        vm.expectRevert(abi.encodeWithSelector(SessionVault.BudgetExceeded.selector, 4e6, 3e6));
        vault.withdraw(4e6, n, sb, sig);
        sig = _ownerSig(keccak256(abi.encode(vault.WITHDRAW_TYPEHASH(), uint256(3e6), n, sb)));
        uint256 before = usdc.balanceOf(owner);
        vm.prank(relayer);
        vault.withdraw(3e6, n, sb, sig);
        assertEq(usdc.balanceOf(owner), before + 3e6);
        assertEq(vault.locked6(), 20e6);
        // a forged owner signature
        bytes memory forged = _ecdsa(OTHER_PK, _typed(address(vault),
            keccak256(abi.encode(vault.WITHDRAW_TYPEHASH(), uint256(1), keccak256("w2"), sb))));
        vm.expectRevert(SessionVault.BadSignature.selector);
        vault.withdraw(1, keccak256("w2"), sb, forged);
    }

    function test_topUpFromFreeAndFromWalletAndExtend() public {
        bytes32 sid = _openWithDeposit(_grant(keyHash, 10e6));
        usdc.mint(address(vault), 5e6);
        uint64 sb = uint64(vm.getBlockTimestamp() + 600);
        bytes32 n1 = keccak256("u1");
        vm.prank(relayer);
        vault.topUp(sid, 5e6, n1, sb, _ownerSig(keccak256(abi.encode(vault.TOPUP_TYPEHASH(), sid, uint256(5e6), n1, sb))));
        bytes32 n2 = keccak256("u2");
        uint64 vb = uint64(vm.getBlockTimestamp() + 600);
        bytes32 topd = _typed(address(vault), keccak256(abi.encode(vault.TOPUP_TYPEHASH(), sid, uint256(7e6), n2, vb)));
        bytes memory auth = _receiveSig(OWNER_PK, address(vault), 7e6, 0, vb, topd);
        vm.prank(relayer);
        vault.topUpWithAuthorization(sid, 7e6, n2, 0, vb, auth);
        (SessionVault.Session memory s,,) = vault.sessionOf(sid);
        assertEq(s.balance6, 22e6);
        assertEq(vault.locked6(), 22e6);
        // the same authorization can't top up a different amount or session
        vm.expectRevert();
        vault.topUpWithAuthorization(sid, 7e6, n2, 0, vb, auth);
        bytes32 n3 = keccak256("x");
        uint64 newExp = uint64(vm.getBlockTimestamp() + 30 days);
        vm.prank(relayer);
        vault.extend(sid, newExp, n3, sb, _ownerSig(keccak256(abi.encode(vault.EXTEND_TYPEHASH(), sid, newExp, n3, sb))));
        (s,,) = vault.sessionOf(sid);
        assertEq(s.expiresAt, newExp);
    }

    // ======================= custody =======================

    function _promoteSig(bytes32 id, string memory app, address pub, string memory ref, string memory cfg,
        string memory label, bool isPublic, bytes32 n, uint64 sb) internal view returns (bytes memory) {
        return _ownerSig(keccak256(abi.encode(vault.PROMOTE_TYPEHASH(), id, keccak256(bytes(app)), pub, keccak256(bytes(ref)),
            keccak256(bytes(cfg)), keccak256(bytes(label)), isPublic, n, sb)));
    }

    function test_promoteSetsVersionAndRecordsPromotion() public {
        bytes32 sid = _openWithDeposit(_grant(keyHash, 10e6));
        bytes32 prd = abi.decode(_exec(sid, 0, CREATE, _createArgs(freeRef, 2, 0), 0), (bytes32));
        uint32[4] memory res = [uint32(0), 0, 256, 10];
        vm.prank(publisher);
        catalog.publishVersion("freeapp", "Free", "", "2.1.0", "bafyfree2", res, "", "", 0);
        string memory next = _ref(freeAppId, 1);
        bytes32 n = keccak256("p");
        uint64 sb = uint64(vm.getBlockTimestamp() + 600);
        // the device shows app, publisher, version and exposure: each must match the chain
        // (slugs are unique only PER PUBLISHER - anyone can copy "freeapp" and "2.1.0")
        bytes memory badLabel = _promoteSig(prd, "freeapp", publisher, next, "{}", "2.0.9", false, n, sb);
        bytes memory badApp = _promoteSig(prd, "store", publisher, next, "{}", "2.1.0", false, n, sb);
        address copycat = makeAddr("copycat");
        bytes memory badPub = _promoteSig(prd, "freeapp", copycat, next, "{}", "2.1.0", false, n, sb);
        bytes memory badPublic = _promoteSig(prd, "freeapp", publisher, next, "{}", "2.1.0", true, n, sb);
        bytes memory good = _promoteSig(prd, "freeapp", publisher, next, "{}", "2.1.0", false, n, sb);
        vm.expectRevert(SessionVaultLib.LabelMismatch.selector);
        vault.promote(prd, "freeapp", publisher, next, "{}", "2.0.9", false, n, sb, badLabel);
        vm.expectRevert(SessionVaultLib.LabelMismatch.selector);
        vault.promote(prd, "store", publisher, next, "{}", "2.1.0", false, n, sb, badApp);
        vm.expectRevert(SessionVaultLib.LabelMismatch.selector);
        vault.promote(prd, "freeapp", copycat, next, "{}", "2.1.0", false, n, sb, badPub);
        vm.expectRevert(SessionVaultLib.LabelMismatch.selector);
        vault.promote(prd, "freeapp", publisher, next, "{}", "2.1.0", true, n, sb, badPublic);
        vm.prank(relayer);
        vault.promote(prd, "freeapp", publisher, next, "{}", "2.1.0", false, n, sb, good);
        EnclaveDeployments.Deployment memory d = ledger.get(prd);
        assertEq(d.appRef, next);
        assertEq(d.configCid, "{}");
        (uint8 env, bytes32 promoted,) = vault.held(prd);
        assertEq(env, 2);
        assertEq(promoted, keccak256(abi.encode(next, "{}")));
    }

    function test_environmentChangesNeverPromote() public {
        // a staging deployment moved to prod is UNPROMOTED: what a staging session last
        // pointed it at is not what the owner reviewed
        bytes32 sid = _openWithDeposit(_grant(keyHash, 10e6));
        bytes32 stg = abi.decode(_exec(sid, 0, CREATE, _createArgs(freeRef, 1, 0), 0), (bytes32));
        _exec(sid, 1, SET_APPREF, abi.encode(stg, storeRef), 0);       // the "race": re-pointed just before
        vm.prank(owner); vault.setEnvironment(stg, "prod", bytes32(0), 0, "");
        (uint8 env, bytes32 promoted,) = vault.held(stg);
        assertEq(env, 2);
        assertEq(promoted, bytes32(0), "moving into prod promotes nothing");
        // Promote names what runs; it also takes an unadopted record the vault owns straight to prod
        vm.prank(owner);
        bytes32 w = ledger.create(freeRef, 0, 1000, 8080, "", false, "", address(0), 0, 1000);
        vm.prank(owner); ledger.transferDeployment(w, address(vault));
        vm.prank(owner); vault.promote(w, "freeapp", publisher, freeRef, "", "2.0.0", false, bytes32(0), 0, "");
        (env, promoted,) = vault.held(w);
        assertEq(env, 2);
        assertEq(promoted, keccak256(abi.encode(freeRef, "")));
    }

    function test_rateCapBoundedByTheGrantAndOnlyLoweredOnProd() public {
        bytes32 sid = _openWithDeposit(_grant(keyHash, 10e6));
        bytes32 stg = abi.decode(_exec(sid, 0, CREATE, _createArgs(freeRef, 1, 0), 0), (bytes32));
        bytes32 prd = abi.decode(_exec(sid, 1, CREATE, _createArgs(freeRef, 2, 0), 0), (bytes32));
        // staging: up to the grant's $10/h ceiling, not beyond
        _exec(sid, 2, SET_MAXRATE, abi.encode(stg, uint256(2777)), 0);
        _execExpectRevert(sid, 3, SET_MAXRATE, abi.encode(stg, uint256(2778)), 0,
            abi.encodeWithSelector(SessionVault.RateCapOutOfRange.selector, 2778 * 3600, 10e6));
        // prod: only ever lowered (a raised cap lets a host the attacker runs earn the escrow)
        _execExpectRevert(sid, 3, SET_MAXRATE, abi.encode(prd, uint256(1001)), 0,
            abi.encodeWithSelector(SessionVault.RateCapOutOfRange.selector, 1001, 1000));
        _exec(sid, 3, SET_MAXRATE, abi.encode(prd, uint256(500)), 0);
        assertEq(ledger.capOf(prd), 500);
    }

    // ---- the ledger splits every funding by the record's CURRENT rate (review 2, F1/F3) ----

    function _cheapClaim(bytes32 id, bool releaseAfter) internal {
        address op = makeAddr("cheap-operator");
        bytes32 enc = keccak256("cheap-enclave");
        reg.set(enc, op);
        vm.startPrank(op);
        ledger.offerJobRate(id, enc, 0, uint64(vm.getBlockTimestamp() + 1 days));   // a zero host rate: rate == fee
        ledger.claim(id, enc);
        if (releaseAfter) ledger.release(id);
        vm.stopPrank();
    }

    function test_fundRebasesARateAHostLeftBehind() public {
        SessionVault.Grant memory g = _grant(keyHash, 50e6);
        g.apps = _strs(vm.toString(storeAppId));                       // the paid app is named
        bytes32 sid = _openWithDeposit(g);
        bytes32 id = abi.decode(_exec(sid, 0, CREATE, _createArgsRate(storeRef, 1, 1e6, 1000), 0), (bytes32));
        _cheapClaim(id, true);                                         // any operator, no key misuse
        assertEq(ledger.get(id).rate, 100, "released at the fee: a funding now would pay the publisher everything");
        uint256 before = usdc.balanceOf(publisher);
        _exec(sid, 1, FUND, abi.encode(id, uint256(10e6)), 0);
        assertEq(ledger.get(id).rate, 1000, "re-based on the cap first");
        assertEq(usdc.balanceOf(publisher) - before, 1e6, "the fee's share of the cap, never more than half");
        (uint256 rr, uint256 esc,) = ledger.earnOf(id);
        assertGt(rr, 0);
        assertGt(esc, 0, "a runner share is escrowed (and refundable)");
    }

    function test_fundRefusesALeaseThatPaysOnlyTheFee() public {
        SessionVault.Grant memory g = _grant(keyHash, 50e6);
        g.apps = _strs(vm.toString(storeAppId));
        bytes32 sid = _openWithDeposit(g);
        bytes32 id = abi.decode(_exec(sid, 0, CREATE, _createArgsRate(storeRef, 1, 1e6, 1000), 0), (bytes32));
        _cheapClaim(id, false);                                        // the cheap lease is LIVE: never re-priced
        _execExpectRevert(sid, 1, FUND, abi.encode(id, uint256(10e6)), 0,
            abi.encodeWithSelector(SessionVaultLib.FundRateTooLow.selector, 100, 200));
    }

    function test_fundRebasesAZeroedFreeApp() public {
        bytes32 sid = _openWithDeposit(_grant(keyHash, 50e6));
        bytes32 id = abi.decode(_exec(sid, 0, CREATE, _createArgsRate(freeRef, 1, 0, 1000), 0), (bytes32));
        _cheapClaim(id, true);                                         // rate 0: claimable with no balance at all
        assertEq(ledger.get(id).rate, 0);
        uint256 before = usdc.balanceOf(payout);
        _exec(sid, 1, FUND, abi.encode(id, uint256(10e6)), 0);
        assertEq(ledger.get(id).rate, 1000);
        assertLt(usdc.balanceOf(payout) - before, 10e6, "not all of it to the platform");
        assertGt(ledger.refundableOf(id), 0, "the runner share comes back on refund");
        // and a live zero-rate lease is never funded by a session
        bytes32 id2 = abi.decode(_exec(sid, 2, CREATE, _createArgsRate(freeRef, 1, 0, 1000), 0), (bytes32));
        _cheapClaim(id2, false);
        _execExpectRevert(sid, 3, FUND, abi.encode(id2, uint256(1e6)), 0,
            abi.encodeWithSelector(SessionVaultLib.FundRateTooLow.selector, 0, 0));
    }

    function test_setMaxRateNeverUnderTwiceTheFee() public {
        SessionVault.Grant memory g = _grant(keyHash, 50e6);
        g.apps = _strs(vm.toString(storeAppId));
        bytes32 sid = _openWithDeposit(g);
        bytes32 id = abi.decode(_exec(sid, 0, CREATE, _createArgsRate(storeRef, 1, 0, 1000), 0), (bytes32));
        _execExpectRevert(sid, 1, SET_MAXRATE, abi.encode(id, uint256(101)), 0,
            abi.encodeWithSelector(SessionVaultLib.RateCapOutOfRange.selector, 101, 200));
        _exec(sid, 1, SET_MAXRATE, abi.encode(id, uint256(200)), 0);
        assertEq(ledger.capOf(id), 200);
    }

    function test_fundRespectsTheGrantRateCeiling() public {
        SessionVault.Grant memory g = _grant(keyHash, 50e6);
        g.maxRatePerHour = 360_000;                                    // 100/s
        bytes32 sid = _openWithDeposit(g);
        vm.startPrank(owner);
        bytes32 id = ledger.create(freeRef, 0, 1000, 8080, "", false, "", address(0), 0, 100_000);   // 1000x the ceiling
        ledger.transferDeployment(id, address(vault));
        vm.stopPrank();
        vm.prank(owner); vault.adopt(id, "prod", bytes32(0), 0, "");
        _execExpectRevert(sid, 0, FUND, abi.encode(id, uint256(10e6)), 0,
            abi.encodeWithSelector(SessionVaultLib.RateCapOutOfRange.selector, uint256(100_000) * 3600, 360_000));
        // the owner lowers the cap to the grant's ceiling: now the session may fund it
        vm.prank(owner); vault.ownerCall(address(ledger), abi.encodeWithSignature("setMaxRate(bytes32,uint256)", id, 100));
        _exec(sid, 0, FUND, abi.encode(id, uint256(1e6)), 0);
        assertEq(ledger.get(id).balance6, 1e6);
    }

    function test_ownerCallRefusesMulticall() public {
        bytes32 sid = _openWithDeposit(_grant(keyHash, 10e6));
        bytes32 id = abi.decode(_exec(sid, 0, CREATE, _createArgs(freeRef, 1, 0), 0), (bytes32));
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeWithSignature("transferDeployment(bytes32,address)", id, owner);
        vm.prank(owner);
        vm.expectRevert(SessionVault.BadTarget.selector);
        vault.ownerCall(address(ledger), abi.encodeWithSignature("multicall(bytes[])", calls));
        assertEq(ledger.get(id).owner, address(vault));
    }

    function test_ownerCallTransferClearsCustody() public {
        bytes32 sid = _openWithDeposit(_grant(keyHash, 10e6));
        bytes32 id = abi.decode(_exec(sid, 0, CREATE, _createArgs(freeRef, 2, 0), 0), (bytes32));
        vm.prank(owner);
        vault.ownerCall(address(ledger), abi.encodeWithSignature("transferDeployment(bytes32,address)", id, owner));
        (uint8 env,,) = vault.held(id);
        assertEq(env, 0, "handed away: if it ever comes back it is unadopted");
        vm.prank(owner); ledger.transferDeployment(id, address(vault));
        _execExpectRevert(sid, 1, SET_ACTIVE, abi.encode(id, false), 0, abi.encodeWithSelector(SessionVault.NotHeld.selector, id));
    }

    function test_hostileLedgerCannotOverwriteCustody() public {
        bytes32 sid = _openWithDeposit(_grant(keyHash, 10e6));
        bytes32 prd = abi.decode(_exec(sid, 0, CREATE, _createArgs(freeRef, 2, 0), 0), (bytes32));
        HostileLedger h = new HostileLedger(address(usdc));
        h.setFixedId(prd);                             // its create() "returns" an existing prod record
        book.set("deployments", address(h));
        _execExpectRevert(sid, 1, CREATE, _createArgs(freeRef, 1, 0), 0, abi.encodeWithSelector(SessionVault.Exists.selector));
        (uint8 env,,) = vault.held(prd);
        assertEq(env, 2);
    }

    function test_parseRefRejectsNonCanonicalSpellings() public {
        string memory hexId = vm.toString(freeAppId);
        bytes memory up = bytes(vm.toString(freeAppId));                    // fresh copies: bytes() of a string aliases it
        for (uint256 i = 2; i < up.length; i++) if (up[i] >= "a" && up[i] <= "f") up[i] = bytes1(uint8(up[i]) - 32);
        vm.expectRevert(SessionVaultLib.BadRef.selector);
        this.parse(string.concat("catalog://", string(up), "/0"));            // upper-case hex
        bytes memory big = bytes(vm.toString(freeAppId)); big[1] = "X";
        vm.expectRevert(SessionVaultLib.BadRef.selector);
        this.parse(string.concat("catalog://", string(big), "/0"));           // 0X
        vm.expectRevert(SessionVaultLib.BadRef.selector);
        this.parse(string.concat("catalog://", hexId, "/07"));               // leading zero
        (bytes32 a, uint256 i2) = this.parse(string.concat("catalog://", hexId, "/0"));
        assertEq(a, freeAppId); assertEq(i2, 0);
    }

    function test_adoptReleaseAndEnvironment() public {
        vm.prank(owner);
        bytes32 id = ledger.create(freeRef, 0, 1000, 8080, "", false, "", address(0), 0, 1e6);
        factory.createVault(owner);
        vm.prank(owner); ledger.transferDeployment(id, address(vault));
        (uint8 env,,) = vault.held(id);
        assertEq(env, 0, "unadopted until the owner says so");
        vm.prank(owner); vault.adopt(id, "prod", bytes32(0), 0, "");
        bytes32 h;
        (env, h,) = vault.held(id);
        assertEq(env, 2);
        assertEq(h, bytes32(0), "adopting as prod promotes NOTHING - Promote names what may run");
        vm.prank(owner); vault.setEnvironment(id, "staging", bytes32(0), 0, "");
        (env, h,) = vault.held(id);
        assertEq(env, 1);
        assertEq(h, bytes32(0));
        vm.prank(owner);
        vm.expectRevert(SessionVault.BadTarget.selector);
        vault.release(id, makeAddr("elsewhere"), bytes32(0), 0, "");
        vm.prank(owner); vault.release(id, owner, bytes32(0), 0, "");
        assertEq(ledger.get(id).owner, owner);
        (env,,) = vault.held(id);
        assertEq(env, 0);
    }

    function test_ownerCallIsDirectOnlyAndCannotTouchUsdc() public {
        factory.createVault(owner);
        vm.expectRevert(SessionVault.NotOwner.selector);
        vault.ownerCall(address(catalog), "");
        vm.prank(owner);
        vm.expectRevert(SessionVault.BadTarget.selector);
        vault.ownerCall(address(usdc), abi.encodeWithSignature("approve(address,uint256)", owner, 1));
        vm.prank(owner);
        vm.expectRevert(SessionVault.BadTarget.selector);
        vault.ownerCall(address(vault), "");
        // publish then yank the vault's own app through ownerCall
        uint32[4] memory res = [uint32(0), 0, 256, 10];
        vm.prank(owner);
        vault.ownerCall(address(catalog), abi.encodeCall(EnclaveAppCatalog.publishVersion,
            ("own", "Own", "", "1", "bafyown", res, "", "", 0)));
        bytes32 appId = catalog.appIdOf(address(vault), "own");
        vm.prank(owner);
        vault.ownerCall(address(catalog), abi.encodeCall(EnclaveAppCatalog.yankVersion, ("own", 0)));
        assertTrue(catalog.getVersion(appId, 0).yanked);
    }

    function test_sessionsCannotReachOwnerOperations() public {
        // the only signer a session has is its P-256 key; owner ops take ECDSA/1271
        // from the owner, so a session-key holder (here: the relayer acting on its
        // behalf) has no path to withdraw, revoke, promote, release or adopt
        _openWithDeposit(_grant(keyHash, 10e6));
        vm.startPrank(relayer);
        vm.expectRevert(SessionVault.BadSignature.selector);
        vault.withdraw(1, keccak256("a"), uint64(vm.getBlockTimestamp() + 60), "");
        vm.expectRevert(SessionVault.BadSignature.selector);
        vault.revokeAll(true, keccak256("b"), uint64(vm.getBlockTimestamp() + 60), "");
        vm.expectRevert(SessionVault.NotOwner.selector);
        vault.ownerCall(address(catalog), "");
        vm.stopPrank();
    }

    function test_erc1271Owner() public {
        uint256 signerPk = 0xC0FFEE;
        Mock1271Owner wallet = new Mock1271Owner(vm.addr(signerPk));
        SessionVault v = SessionVault(factory.createVault(address(wallet)));
        SessionVault.Grant memory g = _grant(keyHash, 0);
        bytes32 gd = keccak256(abi.encodePacked("\x19\x01", _domain(address(v)), _grantHash(g)));
        bytes32 sid = v.open(g, _ecdsa(signerPk, gd));
        assertTrue(v.isLive(sid));
        g.grantNonce = keccak256("n2");
        bytes memory wrong = _ecdsa(OTHER_PK, keccak256(abi.encodePacked("\x19\x01", _domain(address(v)), _grantHash(g))));
        vm.expectRevert(SessionVault.BadSignature.selector);
        v.open(g, wrong);
    }

    function test_highSOwnerSignatureRefused() public {
        factory.createVault(owner);
        SessionVault.Grant memory g = _grant(keyHash, 0);
        bytes32 d = _typed(address(vault), _grantHash(g));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, d);
        uint256 n = (uint256(0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFE) << 128) | 0xBAAEDCE6AF48A03BBFD25E8CD0364141;  // secp256k1 order
        bytes memory twin = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(SessionVault.BadSignature.selector);
        vault.open(g, twin);
    }

    // ======================= hostile platform =======================

    function test_hostileLedgerCannotPullMoreOrReenter() public {
        bytes32 sid = _openWithDeposit(_grant(keyHash, 20e6));
        bytes32 id = abi.decode(_exec(sid, 0, CREATE, _createArgs(freeRef, 1, 0), 0), (bytes32));
        HostileLedger h = new HostileLedger(address(usdc));
        h.arm(address(vault), abi.encodeCall(SessionVault.withdraw, (1, bytes32(0), 0, "")));
        book.set("deployments", address(h));       // governance repoints the book at it
        _exec(sid, 1, FUND, abi.encode(id, uint256(5e6)), 0);
        assertEq(usdc.balanceOf(address(h)), 5e6, "took exactly what was approved");
        assertEq(usdc.allowance(address(vault), address(h)), 0);
        assertEq(vault.locked6(), 15e6);
        // owner recovery never reads the book
        bytes32 n = keccak256("t");
        vm.prank(owner);
        vault.terminate(sid, n, 0, "");
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    function test_ledgerThatLeavesAnAllowanceIsRefused() public {
        bytes32 sid = _openWithDeposit(_grant(keyHash, 20e6));
        bytes32 id = abi.decode(_exec(sid, 0, CREATE, _createArgs(freeRef, 1, 0), 0), (bytes32));
        HostileLedger h = new HostileLedger(address(usdc));
        h.arm(address(vault), "");
        h.setUnderPull(true);
        book.set("deployments", address(h));
        _execExpectRevert(sid, 1, FUND, abi.encode(id, uint256(5e6)), 0,
            abi.encodeWithSelector(SessionVault.AllowanceLeft.selector));
        assertEq(usdc.allowance(address(vault), address(h)), 0);
    }

    function test_heldDeploymentsOutsideTheSessionsEnvironmentsAreRefused() public {
        // a broad session creates one deployment in each environment...
        bytes32 broad = _openWithDeposit(_grant(keyHash, 20e6));
        bytes32 prd = abi.decode(_exec(broad, 0, CREATE, _createArgs(freeRef, 2, 0), 0), (bytes32));
        bytes32 stg = abi.decode(_exec(broad, 1, CREATE, _createArgs(freeRef, 1, 0), 0), (bytes32));
        // ...a staging-only session may touch the staging one, never the prod one
        SessionVault.Grant memory g = _grant(keyHash, 10e6);
        g.grantNonce = keccak256("staging-only");
        g.environments = _strs("staging");
        bytes32 narrow = _openWithDeposit(g);
        _execExpectRevert(narrow, 0, SET_ACTIVE, abi.encode(prd, false), 0,
            abi.encodeWithSelector(SessionVault.EnvNotAllowed.selector, uint8(2)));
        _execExpectRevert(narrow, 0, SET_SHARES, abi.encode(prd, uint16(0), uint16(500)), 0,
            abi.encodeWithSelector(SessionVault.EnvNotAllowed.selector, uint8(2)));
        _execExpectRevert(narrow, 0, REFUND, abi.encode(prd), 0,
            abi.encodeWithSelector(SessionVault.EnvNotAllowed.selector, uint8(2)));
        _execExpectRevert(narrow, 0, FUND, abi.encode(prd, uint256(1e6)), 0,
            abi.encodeWithSelector(SessionVault.EnvNotAllowed.selector, uint8(2)));
        _exec(narrow, 0, SET_ACTIVE, abi.encode(stg, false), 0);
        assertFalse(ledger.get(stg).active);
        assertTrue(ledger.get(prd).active);
    }

    // ======================= attested keys =======================

    function test_measurementBoundGrant() public {
        MockKeyAttestations ka = new MockKeyAttestations();
        SessionVaultFactory f2 = new SessionVaultFactory(ISVToken(address(usdc)), ISVBook(address(book)),
            ISVRouter(address(router)), ISVKeyAttestations(address(ka)), 1_000e6);
        SessionVault v = SessionVault(f2.createVault(owner));
        SessionVault.Grant memory g = _grant(keyHash, 0);
        g.measurement = keccak256("image-1");
        g.spendPerPeriod = 1e6;
        vm.prank(owner);
        vm.expectRevert(SessionVault.NoAttestation.selector);
        v.open(g, "");
        ka.set(keyHash, keccak256("image-2"));
        vm.prank(owner);
        vm.expectRevert(SessionVault.NoAttestation.selector);
        v.open(g, "");
        ka.set(keyHash, keccak256("image-1"));
        vm.prank(owner);
        bytes32 sid = v.open(g, "");
        bytes memory a = _createArgs(freeRef, 1, 0);
        uint64 deadline = uint64(vm.getBlockTimestamp() + 120);
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", _domain(address(v)),
            keccak256(abi.encode(CALL_TYPEHASH, sid, uint256(0), uint8(0), keccak256(a), uint256(0), deadline))));
        (bytes32 r, bytes32 s) = vm.signP256(SK, sha256(abi.encodePacked(d)));
        v.execute(sid, 0, 0, a, 0, deadline, kx, ky, r, s);
        ka.revoke(keyHash);
        d = keccak256(abi.encodePacked("\x19\x01", _domain(address(v)),
            keccak256(abi.encode(CALL_TYPEHASH, sid, uint256(1), uint8(0), keccak256(a), uint256(0), deadline))));
        (r, s) = vm.signP256(SK, sha256(abi.encodePacked(d)));
        vm.expectRevert(SessionVault.NoAttestation.selector);
        v.execute(sid, 1, 0, a, 0, deadline, kx, ky, r, s);
    }

    // ======================= parser fuzz =======================

    function testFuzz_parseRefRoundTrip(bytes32 appId, uint32 idx) public pure {
        (bytes32 a, uint256 i) = SessionVaultLib.parseRef(_ref(appId, idx));
        assertEq(a, appId);
        assertEq(i, idx);
    }

    function testFuzz_parseRefRejectsGarbage(bytes memory junk) public {
        vm.assume(junk.length < 200);
        // anything not shaped like a catalog ref must revert, never mis-parse
        bool shaped = junk.length >= 78 && junk.length <= 87;
        if (shaped) {
            bytes memory pre = "catalog://0x";
            for (uint256 i = 0; i < 12; i++) if (junk[i] != pre[i]) { shaped = false; break; }
        }
        vm.assume(!shaped);
        vm.expectRevert(SessionVaultLib.BadRef.selector);
        this.parse(string(junk));
    }

    function parse(string memory s) external pure returns (bytes32, uint256) { return SessionVaultLib.parseRef(s); }

    function testFuzz_spendNeverExceedsBudgetOrPeriod(uint64[8] memory amounts, uint32 per) public {
        uint256 budget = 50e6;
        per = uint32(bound(per, 1e6, 60e6));
        bytes32 t = _target();
        SessionVault.Grant memory g = _grant(keyHash, budget);
        g.spendPerPeriod = per;
        bytes32 sid = _openWithDeposit(g);
        uint256 spent; uint256 inPeriod;
        for (uint256 i = 0; i < 8; i++) {
            uint256 amt = bound(amounts[i], 1, 30e6);
            bytes memory a = _fund(t, amt);
            uint64 deadline = uint64(vm.getBlockTimestamp() + 120);
            bytes32 d = _callDigest(sid, vault.seqOf(sid, 0), FUND, a, 0, deadline);
            (bytes32 r, bytes32 s) = vm.signP256(SK, sha256(abi.encodePacked(d)));
            try vault.execute(sid, vault.seqOf(sid, 0), FUND, a, 0, deadline, kx, ky, r, s) {
                spent += amt; inPeriod += amt;
            } catch {}
            assertLe(spent, budget);
            assertLe(inPeriod, per);
            if (i % 3 == 2) { vm.warp(vm.getBlockTimestamp() + 1 days); inPeriod = 0; }
        }
        (SessionVault.Session memory s2,,) = vault.sessionOf(sid);
        assertEq(s2.spent6, spent);
        assertEq(ledger.get(t).balance6, spent);
        assertEq(vault.locked6(), budget - spent);
    }
}
