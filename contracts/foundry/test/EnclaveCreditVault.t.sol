// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Test, Vm } from "forge-std/Test.sol";
import { EnclaveCreditVault, EnclaveCreditVaultFactory, IERC20, IAddressBook } from "../../EnclaveCreditVault.sol";
import { EnclaveDeployments } from "../../EnclaveDeployments.sol";
import { MockUSDC } from "./mocks/MockUSDC.sol";
import { MockBook, MockDeployments } from "./mocks/MockPlatform.sol";

/// Newer forge (>=1.7) serves RIP-7212 natively at 0x100 and REFUSES vm.etch
/// there; older forge (CI's "stable" 1.5.x) has neither the precompile nor
/// the refusal. Probe with a real signature and etch the Daimo verifier
/// fixture (precompile-compatible, fetched from Base) only when needed - the
/// same bytes the anvil e2e installs via anvil_setCode.
function ensureP256(Vm vm) {
    address p256 = 0x0000000000000000000000000000000000000100;
    bytes32 digest = keccak256("p256 probe");
    (bytes32 r, bytes32 s) = vm.signP256(0xA1CE, digest);
    (uint256 x, uint256 y) = vm.publicKeyP256(0xA1CE);
    (bool ok, bytes memory ret) = p256.staticcall(abi.encodePacked(digest, r, s, x, y));
    if (!(ok && ret.length == 32 && ret[31] == 0x01))
        vm.etch(p256, vm.parseBytes(vm.readFile("contracts/foundry/test/fixtures/p256-verifier.hex")));
}

/// Drives the vault with REAL WebAuthn-shaped P-256 signatures: vm.signP256
/// signs op digests, vm.toBase64URL builds the clientDataJSON challenge (an
/// encoder independent of the contract's own base64url), and the RIP-7212
/// precompile address carries Daimo's verifier bytecode (fetched from Base,
/// precompile-compatible by construction) via vm.etch - the same bytes the
/// e2e stack etches into anvil.
contract EnclaveCreditVaultTest is Test {
    address constant P256_VERIFY = 0x0000000000000000000000000000000000000100;
    bytes32 constant BOOK_KEY_DEPLOYMENTS = 0x6465706c6f796d656e7473000000000000000000000000000000000000000000;
    bytes32 constant BOOK_KEY_VAULT_FACTORY = 0x7661756c74466163746f72790000000000000000000000000000000000000000;

    uint256 constant PK1 = 0xA1CE;   // customer passkey scalar
    uint256 constant PK2 = 0xB0B2;   // second device
    string constant ORIGIN = "https://enclave.host";   // the vault's pinned signing origin

    MockUSDC usdc;
    MockBook book;
    MockDeployments dep;
    EnclaveCreditVaultFactory factory;
    EnclaveCreditVault vault;
    address treasury = address(0x7E57);
    address constant RECOVERY_ADMIN = address(0xAD11);
    uint256 x1; uint256 y1;

    function setUp() public {
        ensureP256(vm);
        usdc = new MockUSDC();
        book = new MockBook();
        dep = new MockDeployments(IERC20(address(usdc)), address(0xFEE));
        book.set(BOOK_KEY_DEPLOYMENTS, address(dep));
        factory = new EnclaveCreditVaultFactory(IERC20(address(usdc)), IAddressBook(address(book)), treasury,
            RECOVERY_ADMIN, ORIGIN, "");
        (x1, y1) = vm.publicKeyP256(PK1);
        vault = EnclaveCreditVault(factory.createVault(x1, y1));
        usdc.mint(address(vault), 100e6);   // $100 of credit
    }

    // ---- helpers ----------------------------------------------------------------

    function _sig(uint256 pk, bytes32 digest) internal view returns (EnclaveCreditVault.WebAuthnSig memory w) {
        return _sigFrom(pk, digest, ORIGIN);
    }

    /// same assertion, but claiming to be signed on `origin` - what a tenant app
    /// at <label>.app.enclave.host can genuinely produce, since a passkey with
    /// rpId "enclave.host" is reachable from every origin under it
    function _sigFrom(uint256 pk, bytes32 digest, string memory origin)
        internal view returns (EnclaveCreditVault.WebAuthnSig memory w) {
        bytes memory auth = abi.encodePacked(bytes32(uint256(0x1234)), bytes1(0x05), uint32(7)); // rpIdHash|UP+UV|counter
        // vm.toBase64URL pads with '='; WebAuthn challenges are UNPADDED - strip
        bytes memory b64 = bytes(vm.toBase64URL(abi.encodePacked(digest)));
        uint256 len = b64.length; while (len > 0 && b64[len - 1] == "=") len--;
        bytes memory chal = new bytes(len);
        for (uint256 i = 0; i < len; i++) chal[i] = b64[i];
        string memory cdj = string(abi.encodePacked(
            '{"type":"webauthn.get","challenge":"', chal,
            '","origin":"', origin, '","crossOrigin":false}'));
        bytes32 message = sha256(abi.encodePacked(auth, sha256(bytes(cdj))));
        (bytes32 r, bytes32 s) = vm.signP256(pk, message);
        (uint256 px, uint256 py) = vm.publicKeyP256(pk);
        w = EnclaveCreditVault.WebAuthnSig(auth, cdj, uint256(r), uint256(s), px, py);
    }

    function _createCall() internal pure returns (bytes memory) {
        return abi.encodeWithSignature("create(string,uint16,uint16,uint32,string,bool,string,address,uint256)",
            "ipfs://bafyvault", uint16(250), uint16(100), uint32(8080), "", true, "", address(0), uint256(0));
    }

    function _deployDigest(bytes memory createCall, uint256 fund6, uint256 deadline) internal view returns (bytes32) {
        return keccak256(abi.encode(keccak256("EnclaveVault.deployAndFund.v1"), address(vault), block.chainid,
            vault.nonce(), keccak256(createCall), fund6, deadline));
    }

    // ---- factory ---------------------------------------------------------------

    function test_counterfactualAddressMatches() public view {
        assertEq(factory.vaultFor(x1, y1), address(vault));
    }

    function test_duplicateVaultReverts() public {
        vm.expectRevert(bytes("exists"));
        factory.createVault(x1, y1);
    }

    function test_implementationIsInert() public {
        EnclaveCreditVault impl = factory.implementation();
        vm.prank(address(factory));
        vm.expectRevert(bytes("initialized"));
        impl.initialize(x1, y1);
    }

    function test_initializeOnlyFactory() public {
        (uint256 x2, uint256 y2) = vm.publicKeyP256(PK2);
        address predicted = factory.vaultFor(x2, y2);
        factory.createVault(x2, y2);
        vm.expectRevert(bytes("factory only"));
        EnclaveCreditVault(predicted).initialize(x2, y2);
    }

    // ---- deployAndFund ----------------------------------------------------------

    function test_deployAndFund() public {
        bytes memory cc = _createCall();
        uint256 deadline = block.timestamp + 300;
        bytes32 id = vault.deployAndFund(cc, 30e6, deadline, _sig(PK1, _deployDigest(cc, 30e6, deadline)));
        assertEq(dep.ownerOf(id), address(vault), "vault owns the deployment");
        assertEq(dep.funded6(id), 30e6);
        assertEq(usdc.balanceOf(address(vault)), 70e6);
        assertEq(usdc.balanceOf(address(0xFEE)), 30e6, "funding landed at the ledger payout");
        assertEq(vault.nonce(), 1);
    }

    /// REGRESSION (2026-08-03 production wedge): the live factory had been
    /// deployed a week before rev 8 grew create() a tenth argument, so its
    /// baked allowlist rejected the calldata the relay builds for every
    /// rev>=8 ledger - "not create()" on every credit deploy, with the vaults'
    /// funds reachable only through customer-signed refunds. This pins the
    /// allowlist to the REAL ledger's create selector: reshape create() in
    /// EnclaveDeployments.sol and this fails until the vault's list moves in
    /// the same commit (and the deployed factory moves with it - the admin
    /// console's vault-factory panel flags the live skew).
    function test_deployAndFund_liveLedgerCreateShape() public {
        bytes memory cc = abi.encodeWithSelector(EnclaveDeployments.create.selector,
            "ipfs://bafyvault", uint16(250), uint16(100), uint32(8080), "", true, "", address(0), uint256(0), uint256(278));
        uint256 deadline = block.timestamp + 300;
        bytes32 id = vault.deployAndFund(cc, 10e6, deadline, _sig(PK1, _deployDigest(cc, 10e6, deadline)));
        assertEq(dep.ownerOf(id), address(vault), "vault owns the deployment made with the live create() shape");
        assertEq(dep.funded6(id), 10e6);
    }

    function test_replayRejected() public {
        bytes memory cc = _createCall();
        uint256 deadline = block.timestamp + 300;
        EnclaveCreditVault.WebAuthnSig memory w = _sig(PK1, _deployDigest(cc, 10e6, deadline));
        vault.deployAndFund(cc, 10e6, deadline, w);
        vm.expectRevert(bytes("bad signature"));   // nonce moved; old digest is dead
        vault.deployAndFund(cc, 10e6, deadline, w);
    }

    function test_unregisteredKeyRejected() public {
        bytes memory cc = _createCall();
        uint256 deadline = block.timestamp + 300;
        // digest+sig BEFORE expectRevert: the helpers call vault.nonce(), an
        // external view that would otherwise consume the expected revert
        EnclaveCreditVault.WebAuthnSig memory w = _sig(PK2, _deployDigest(cc, 10e6, deadline));
        vm.expectRevert(bytes("bad signature"));
        vault.deployAndFund(cc, 10e6, deadline, w);
    }

    function test_tamperedAmountRejected() public {
        bytes memory cc = _createCall();
        uint256 deadline = block.timestamp + 300;
        EnclaveCreditVault.WebAuthnSig memory w = _sig(PK1, _deployDigest(cc, 10e6, deadline));
        vm.expectRevert(bytes("bad signature"));
        vault.deployAndFund(cc, 99e6, deadline, w);   // signed $10, submitted $99
    }

    function test_expiredDeadlineRejected() public {
        bytes memory cc = _createCall();
        uint256 deadline = block.timestamp + 300;
        EnclaveCreditVault.WebAuthnSig memory w = _sig(PK1, _deployDigest(cc, 10e6, deadline));
        vm.warp(deadline + 1);
        vm.expectRevert(bytes("expired"));
        vault.deployAndFund(cc, 10e6, deadline, w);
    }

    function test_missingUPFlagRejected() public {
        bytes memory cc = _createCall();
        uint256 deadline = block.timestamp + 300;
        EnclaveCreditVault.WebAuthnSig memory w = _sig(PK1, _deployDigest(cc, 10e6, deadline));
        w.authenticatorData[32] = bytes1(0x04);   // UV without UP
        vm.expectRevert(bytes("bad signature"));
        vault.deployAndFund(cc, 10e6, deadline, w);
    }

    function test_nonCreateSelectorRejected() public {
        bytes memory evil = abi.encodeWithSignature("transfer(address,uint256)", address(0xdead), 100e6);
        uint256 deadline = block.timestamp + 300;
        EnclaveCreditVault.WebAuthnSig memory w = _sig(PK1, _deployDigest(evil, 0, deadline));
        vm.expectRevert(bytes("not create()"));
        vault.deployAndFund(evil, 0, deadline, w);
    }

    // ---- fund / control ---------------------------------------------------------

    function test_fundExisting() public {
        bytes memory cc = _createCall();
        uint256 deadline = block.timestamp + 300;
        bytes32 id = vault.deployAndFund(cc, 10e6, deadline, _sig(PK1, _deployDigest(cc, 10e6, deadline)));
        bytes32 digest = keccak256(abi.encode(keccak256("EnclaveVault.fundDeployment.v1"), address(vault),
            block.chainid, vault.nonce(), id, 25e6, deadline));
        vault.fundDeployment(id, 25e6, deadline, _sig(PK1, digest));
        assertEq(dep.funded6(id), 35e6);
    }

    function test_controlAllowsLedgerSettersOnly() public {
        bytes memory cc = _createCall();
        uint256 deadline = block.timestamp + 300;
        bytes32 id = vault.deployAndFund(cc, 10e6, deadline, _sig(PK1, _deployDigest(cc, 10e6, deadline)));

        bytes memory setA = abi.encodeWithSignature("setActive(bytes32,bool)", id, false);
        bytes32 d1 = keccak256(abi.encode(keccak256("EnclaveVault.controlDeployment.v1"), address(vault),
            block.chainid, vault.nonce(), keccak256(setA), deadline));
        vault.controlDeployment(setA, deadline, _sig(PK1, d1));
        assertEq(dep.activeOf(id), false);

        bytes memory evil = abi.encodeWithSignature("fund(bytes32,uint256)", id, 1);
        bytes32 d2 = keccak256(abi.encode(keccak256("EnclaveVault.controlDeployment.v1"), address(vault),
            block.chainid, vault.nonce(), keccak256(evil), deadline));
        EnclaveCreditVault.WebAuthnSig memory w2 = _sig(PK1, d2);
        vm.expectRevert(bytes("selector not allowed"));
        vault.controlDeployment(evil, deadline, w2);
    }

    function _controlDigest(bytes memory callData, uint256 deadline) internal view returns (bytes32) {
        return keccak256(abi.encode(keccak256("EnclaveVault.controlDeployment.v1"), address(vault),
            block.chainid, vault.nonce(), keccak256(callData), deadline));
    }

    function test_controlSetShares() public {
        bytes memory cc = _createCall();
        uint256 deadline = block.timestamp + 300;
        bytes32 id = vault.deployAndFund(cc, 10e6, deadline, _sig(PK1, _deployDigest(cc, 10e6, deadline)));

        bytes memory resize = abi.encodeWithSignature("setShares(bytes32,uint16,uint16)", id, uint16(800), uint16(400));
        vault.controlDeployment(resize, deadline, _sig(PK1, _controlDigest(resize, deadline)));
        assertEq(dep.gpuMilliOf(id), 800);
        assertEq(dep.cpuMilliOf(id), 400);
    }

    function test_controlMulticall_versionPlusResize_oneSignature() public {
        bytes memory cc = _createCall();
        uint256 deadline = block.timestamp + 300;
        bytes32 id = vault.deployAndFund(cc, 10e6, deadline, _sig(PK1, _deployDigest(cc, 10e6, deadline)));

        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeWithSignature("setAppRef(bytes32,string)", id, "catalog://app/2");
        calls[1] = abi.encodeWithSignature("setShares(bytes32,uint16,uint16)", id, uint16(500), uint16(250));
        bytes memory mc = abi.encodeWithSignature("multicall(bytes[])", calls);
        vault.controlDeployment(mc, deadline, _sig(PK1, _controlDigest(mc, deadline)));
        assertEq(dep.appRefOf(id), "catalog://app/2");
        assertEq(dep.gpuMilliOf(id), 500);
    }

    function test_controlMulticall_innerFundRejected() public {
        bytes memory cc = _createCall();
        uint256 deadline = block.timestamp + 300;
        bytes32 id = vault.deployAndFund(cc, 10e6, deadline, _sig(PK1, _deployDigest(cc, 10e6, deadline)));

        // an allowed head must not smuggle a fund-moving inner call through
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeWithSignature("setAppRef(bytes32,string)", id, "catalog://app/2");
        calls[1] = abi.encodeWithSignature("fund(bytes32,uint256)", id, 1);
        bytes memory mc = abi.encodeWithSignature("multicall(bytes[])", calls);
        EnclaveCreditVault.WebAuthnSig memory w = _sig(PK1, _controlDigest(mc, deadline));
        vm.expectRevert(bytes("inner selector not allowed"));
        vault.controlDeployment(mc, deadline, w);

        // and an empty batch is refused rather than silently passing
        bytes memory empty = abi.encodeWithSignature("multicall(bytes[])", new bytes[](0));
        EnclaveCreditVault.WebAuthnSig memory w2 = _sig(PK1, _controlDigest(empty, deadline));
        vm.expectRevert(bytes("empty multicall"));
        vault.controlDeployment(empty, deadline, w2);
    }

    // ---- refund + keys ----------------------------------------------------------

    function test_refundGoesOnlyToTreasury() public {
        uint256 deadline = block.timestamp + 300;
        bytes32 digest = keccak256(abi.encode(keccak256("EnclaveVault.refundToTreasury.v1"), address(vault),
            block.chainid, vault.nonce(), uint256(40e6), deadline));
        vault.refundToTreasury(40e6, deadline, _sig(PK1, digest));
        assertEq(usdc.balanceOf(treasury), 40e6);
        assertEq(usdc.balanceOf(address(vault)), 60e6);
    }

    function test_addAndRemoveKey_lastKeyGuard() public {
        (uint256 x2, uint256 y2) = vm.publicKeyP256(PK2);
        uint256 deadline = block.timestamp + 300;
        bytes32 dAdd = keccak256(abi.encode(keccak256("EnclaveVault.addKey.v1"), address(vault),
            block.chainid, vault.nonce(), x2, y2, deadline));
        vault.addKey(x2, y2, deadline, _sig(PK1, dAdd));
        assertEq(vault.keyCount(), 2);

        // the new device can sign ops
        bytes32 dRef = keccak256(abi.encode(keccak256("EnclaveVault.refundToTreasury.v1"), address(vault),
            block.chainid, vault.nonce(), uint256(1e6), deadline));
        vault.refundToTreasury(1e6, deadline, _sig(PK2, dRef));

        bytes32 kh1 = keccak256(abi.encode(x1, y1));
        bytes32 dDel = keccak256(abi.encode(keccak256("EnclaveVault.removeKey.v1"), address(vault),
            block.chainid, vault.nonce(), kh1, deadline));
        vault.removeKey(kh1, deadline, _sig(PK2, dDel));
        assertEq(vault.keyCount(), 1);

        bytes32 kh2 = keccak256(abi.encode(x2, y2));
        bytes32 dLast = keccak256(abi.encode(keccak256("EnclaveVault.removeKey.v1"), address(vault),
            block.chainid, vault.nonce(), kh2, deadline));
        EnclaveCreditVault.WebAuthnSig memory wLast = _sig(PK2, dLast);
        vm.expectRevert(bytes("last key"));
        vault.removeKey(kh2, deadline, wLast);
    }

    // ---- ERC-1271 ---------------------------------------------------------------

    function test_isValidSignature() public view {
        bytes32 h = keccak256("an enclave session challenge");
        EnclaveCreditVault.WebAuthnSig memory w = _sig(PK1, h);
        assertEq(vault.isValidSignature(h, abi.encode(w)), bytes4(0x1626ba7e));
        EnclaveCreditVault.WebAuthnSig memory bad = _sig(PK2, h);
        assertEq(vault.isValidSignature(h, abi.encode(bad)), bytes4(0xffffffff));
    }

    // ---- fuzz -------------------------------------------------------------------

    function testFuzz_fundAmounts(uint96 amount) public {
        vm.assume(amount > 0 && amount <= 100e6);
        bytes memory cc = _createCall();
        uint256 deadline = block.timestamp + 300;
        bytes32 id = vault.deployAndFund(cc, 0, deadline, _sig(PK1, _deployDigest(cc, 0, deadline)));
        bytes32 digest = keccak256(abi.encode(keccak256("EnclaveVault.fundDeployment.v1"), address(vault),
            block.chainid, vault.nonce(), id, uint256(amount), deadline));
        vault.fundDeployment(id, amount, deadline, _sig(PK1, digest));
        assertEq(dep.funded6(id), amount);
    }

    // ---- signing ORIGIN ---------------------------------------------------------
    //
    // A passkey with rpId "enclave.host" can be exercised by ANY origin under that
    // registrable domain, and every tenant app is served at
    // <label>.app.enclave.host. So a hostile app can genuinely call
    // navigator.credentials.get() with a vault-op digest as the challenge, under a
    // prompt naming the RP as "enclave.host". The signature it gets back is real:
    // correct key, correct digest, UP set. Only the origin in clientDataJSON says
    // it did not come from our page.
    //
    // addKey is why this is not merely a nuisance: one harvested assertion adds the
    // attacker's own passkey permanently, and every later op needs no phish at all.

    function test_tenantSubdomainOriginRejected_addKey() public {
        (uint256 x2, uint256 y2) = vm.publicKeyP256(PK2);
        uint256 deadline = block.timestamp + 300;
        bytes32 dAdd = keccak256(abi.encode(keccak256("EnclaveVault.addKey.v1"), address(vault),
            block.chainid, vault.nonce(), x2, y2, deadline));
        // a real deployment subdomain - the exact origin a tenant app runs on.
        // build the assertion FIRST: _sigFrom hits the sha256 precompile, and
        // expectRevert binds to the next call it sees
        EnclaveCreditVault.WebAuthnSig memory tenant = _sigFrom(PK1, dAdd, "https://a1b2c3d4.app.enclave.host");
        vm.expectRevert("bad signature");
        vault.addKey(x2, y2, deadline, tenant);
        assertEq(vault.keyCount(), 1, "no key may be added from a tenant origin");

        // and the same digest from OUR origin still works, so the op itself is fine
        vault.addKey(x2, y2, deadline, _sigFrom(PK1, dAdd, ORIGIN));
        assertEq(vault.keyCount(), 2);
    }

    function test_tenantSubdomainOriginRejected_spend() public {
        bytes memory cc = _createCall();
        uint256 deadline = block.timestamp + 300;
        bytes32 d = _deployDigest(cc, 10e6, deadline);
        EnclaveCreditVault.WebAuthnSig memory tenant = _sigFrom(PK1, d, "https://deadbeef.app.enclave.host");
        vm.expectRevert("bad signature");
        vault.deployAndFund(cc, 10e6, deadline, tenant);
        assertEq(usdc.balanceOf(address(vault)), 100e6, "credit must not move");
    }

    function test_originMustEndWhereOursDoes() public {
        bytes memory cc = _createCall();
        uint256 deadline = block.timestamp + 300;
        bytes32 d = _deployDigest(cc, 10e6, deadline);
        // a domain anyone can register: our origin is a strict PREFIX of it, so a
        // prefix compare without the closing-quote check would accept this
        EnclaveCreditVault.WebAuthnSig memory suffixed = _sigFrom(PK1, d, "https://enclave.host.evil.example");
        EnclaveCreditVault.WebAuthnSig memory cut      = _sigFrom(PK1, d, "https://enclave.hos");
        EnclaveCreditVault.WebAuthnSig memory plain    = _sigFrom(PK1, d, "http://enclave.host");
        vm.expectRevert("bad signature");
        vault.deployAndFund(cc, 10e6, deadline, suffixed);
        vm.expectRevert("bad signature");
        vault.deployAndFund(cc, 10e6, deadline, cut);          // truncation
        vm.expectRevert("bad signature");
        vault.deployAndFund(cc, 10e6, deadline, plain);        // scheme matters too
        assertEq(usdc.balanceOf(address(vault)), 100e6);
    }

    function test_secondOriginSlotAccepted_whenConfigured() public {
        // a factory pinning apex + www accepts either, and nothing else
        EnclaveCreditVaultFactory f2 = new EnclaveCreditVaultFactory(
            IERC20(address(usdc)), IAddressBook(address(book)), treasury, RECOVERY_ADMIN, ORIGIN, "https://www.enclave.host");
        EnclaveCreditVault v2 = EnclaveCreditVault(f2.createVault(x1, y1));
        usdc.mint(address(v2), 50e6);
        uint256 deadline = block.timestamp + 300;

        bytes32 d1 = keccak256(abi.encode(keccak256("EnclaveVault.refundToTreasury.v1"), address(v2),
            block.chainid, v2.nonce(), uint256(1e6), deadline));
        v2.refundToTreasury(1e6, deadline, _sigFrom(PK1, d1, "https://www.enclave.host"));

        bytes32 d2 = keccak256(abi.encode(keccak256("EnclaveVault.refundToTreasury.v1"), address(v2),
            block.chainid, v2.nonce(), uint256(1e6), deadline));
        v2.refundToTreasury(1e6, deadline, _sigFrom(PK1, d2, ORIGIN));

        bytes32 d3 = keccak256(abi.encode(keccak256("EnclaveVault.refundToTreasury.v1"), address(v2),
            block.chainid, v2.nonce(), uint256(1e6), deadline));
        EnclaveCreditVault.WebAuthnSig memory tenant = _sigFrom(PK1, d3, "https://x.app.enclave.host");
        vm.expectRevert("bad signature");
        v2.refundToTreasury(1e6, deadline, tenant);
    }

    // ---- migrateToSuccessor (the no-passkey recovery) ---------------------------

    /// Stand up the successor world: a NEW factory, the book repointed at it,
    /// and this customer's vault minted there. Mirrors what the admin console's
    /// migration flow does on-chain.
    function _successorFactory() internal returns (EnclaveCreditVaultFactory f2, address succ) {
        f2 = new EnclaveCreditVaultFactory(IERC20(address(usdc)), IAddressBook(address(book)), treasury,
            RECOVERY_ADMIN, ORIGIN, "");
        book.set(BOOK_KEY_VAULT_FACTORY, address(f2));
        succ = f2.createVault(x1, y1);
    }

    function test_migrateToSuccessor_movesCreditToTheSameCustomer() public {
        (, address succ) = _successorFactory();
        vm.prank(RECOVERY_ADMIN);
        vault.migrateToSuccessor(x1, y1);
        assertEq(usdc.balanceOf(address(vault)), 0, "stranded vault drained");
        assertEq(usdc.balanceOf(succ), 100e6, "credit landed at the customer's new vault");
        // and it is genuinely THEIRS: the same passkey still spends it
        assertEq(EnclaveCreditVault(succ).keyActive(keccak256(abi.encode(x1, y1))), true);
        assertEq(usdc.balanceOf(treasury), 0, "the company took nothing");
    }

    /// The whole security claim in one test: recoveryAdmin picks NOTHING about
    /// where the money goes. No amount, no recipient - the only reachable
    /// destination is the derived successor.
    function test_migrateToSuccessor_companyCannotRedirectOrSkim() public {
        (, address succ) = _successorFactory();
        // a second registered device does NOT retarget the transfer: only the
        // ROOT key (this vault's CREATE2 salt) is accepted
        (uint256 x2, uint256 y2) = vm.publicKeyP256(PK2);
        uint256 deadline = block.timestamp + 300;
        bytes32 dAdd = keccak256(abi.encode(keccak256("EnclaveVault.addKey.v1"), address(vault),
            block.chainid, vault.nonce(), x2, y2, deadline));
        vault.addKey(x2, y2, deadline, _sig(PK1, dAdd));
        vm.prank(RECOVERY_ADMIN);
        vm.expectRevert(bytes("not this vault's root key"));
        vault.migrateToSuccessor(x2, y2);
        // an unregistered key is refused too
        vm.prank(RECOVERY_ADMIN);
        vm.expectRevert(bytes("not this vault's root key"));
        vault.migrateToSuccessor(uint256(1), uint256(2));
        // and the honest call still pays only the customer
        vm.prank(RECOVERY_ADMIN);
        vault.migrateToSuccessor(x1, y1);
        assertEq(usdc.balanceOf(succ), 100e6);
    }

    function test_migrateToSuccessor_onlyRecoveryAdmin() public {
        _successorFactory();
        vm.expectRevert(bytes("recovery admin only"));
        vault.migrateToSuccessor(x1, y1);            // this test contract
        vm.prank(treasury);
        vm.expectRevert(bytes("recovery admin only"));
        vault.migrateToSuccessor(x1, y1);
    }

    /// The gate that protects LIVE credit: while this vault is still the one
    /// the current factory mints, its balance cannot be moved at all.
    function test_migrateToSuccessor_refusedWhileCurrent() public {
        book.set(BOOK_KEY_VAULT_FACTORY, address(factory));
        vm.prank(RECOVERY_ADMIN);
        vm.expectRevert(bytes("not superseded"));
        vault.migrateToSuccessor(x1, y1);
        assertEq(usdc.balanceOf(address(vault)), 100e6);
    }

    /// Never send credit to an address with no code: the successor must be
    /// minted first, or the funds would be stranded past all recovery.
    function test_migrateToSuccessor_requiresAMintedSuccessor() public {
        EnclaveCreditVaultFactory f2 = new EnclaveCreditVaultFactory(IERC20(address(usdc)),
            IAddressBook(address(book)), treasury, RECOVERY_ADMIN, ORIGIN, "");
        book.set(BOOK_KEY_VAULT_FACTORY, address(f2));   // predicted, but not created
        vm.prank(RECOVERY_ADMIN);
        vm.expectRevert(bytes("successor not minted"));
        vault.migrateToSuccessor(x1, y1);
        f2.createVault(x1, y1);
        vm.prank(RECOVERY_ADMIN);
        vault.migrateToSuccessor(x1, y1);               // now it lands
        assertEq(usdc.balanceOf(f2.vaultFor(x1, y1)), 100e6);
    }

    function test_migrateToSuccessor_zeroAdminDisablesItForever() public {
        EnclaveCreditVaultFactory f0 = new EnclaveCreditVaultFactory(IERC20(address(usdc)),
            IAddressBook(address(book)), treasury, address(0), ORIGIN, "");
        EnclaveCreditVault v0 = EnclaveCreditVault(f0.createVault(x1, y1));
        usdc.mint(address(v0), 10e6);
        (, address succ) = _successorFactory();
        assertTrue(succ != address(v0));
        vm.prank(address(0));
        vm.expectRevert(bytes("recovery admin only"));
        v0.migrateToSuccessor(x1, y1);
        assertEq(usdc.balanceOf(address(v0)), 10e6, "a zero-admin vault only ever moves on a passkey");
    }

    /// Draining twice must not be possible, and an empty vault is not a
    /// silent no-op the operator could mistake for success.
    function test_migrateToSuccessor_notRepeatable() public {
        _successorFactory();
        vm.prank(RECOVERY_ADMIN);
        vault.migrateToSuccessor(x1, y1);
        vm.prank(RECOVERY_ADMIN);
        vm.expectRevert(bytes("empty"));
        vault.migrateToSuccessor(x1, y1);
    }

    /// A migrated-away vault still belongs to its customer: the passkey keeps
    /// working, so credit sent there later is theirs, not the company's.
    function test_migrateToSuccessor_leavesThePasskeyInCharge() public {
        _successorFactory();
        vm.prank(RECOVERY_ADMIN);
        vault.migrateToSuccessor(x1, y1);
        usdc.mint(address(vault), 7e6);                 // a late top-up to the old address
        uint256 deadline = block.timestamp + 300;
        bytes32 d = keccak256(abi.encode(keccak256("EnclaveVault.refundToTreasury.v1"), address(vault),
            block.chainid, vault.nonce(), uint256(7e6), deadline));
        vault.refundToTreasury(7e6, deadline, _sig(PK1, d));
        assertEq(usdc.balanceOf(treasury), 7e6);
    }

    function test_factoryRequiresAnOrigin() public {
        vm.expectRevert("origin required");
        new EnclaveCreditVaultFactory(IERC20(address(usdc)), IAddressBook(address(book)), treasury, RECOVERY_ADMIN, "", "");
    }
}
