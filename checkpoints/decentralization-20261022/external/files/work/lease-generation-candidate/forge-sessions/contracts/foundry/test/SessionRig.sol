// Extracted verbatim from SessionVault.t.sol at 4b7419bb (only SessionRig), so the delegate suite compiles
// within the 768 MiB test allocation without the 1,380-line SessionVault suite.
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
