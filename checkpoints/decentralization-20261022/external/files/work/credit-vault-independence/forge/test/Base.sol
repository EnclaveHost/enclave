// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {EnclaveDeployments} from "../src/live/EnclaveDeployments.sol";
import {EnclaveRegistry} from "../src/live/EnclaveRegistry.sol";
import {EnclaveAddressBook} from "../src/main/EnclaveAddressBook.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// The production credit-vault build (d36100ae), driven through its own ABI. The factory is deployed from the fixture's
/// BYTECODE (test/fixtures/credit-vault-d36100ae.json, the build the live factory 0xa891e439... is byte-identical to),
/// never recompiled from main's newer source.
interface IProdVault {
    struct WebAuthnSig { bytes authenticatorData; string clientDataJSON; uint256 r; uint256 s; uint256 x; uint256 y; }
    function deployAndFund(bytes calldata createCall, uint256 fund6, uint256 deadline, WebAuthnSig calldata sig) external returns (bytes32);
    function fundDeployment(bytes32 id, uint256 fund6, uint256 deadline, WebAuthnSig calldata sig) external;
    function controlDeployment(bytes calldata callData, uint256 deadline, WebAuthnSig calldata sig) external;
    function refundToTreasury(uint256 amount6, uint256 deadline, WebAuthnSig calldata sig) external;
    function addKey(uint256 x2, uint256 y2, uint256 deadline, WebAuthnSig calldata sig) external;
    function removeKey(bytes32 keyHash, uint256 deadline, WebAuthnSig calldata sig) external;
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
    function nonce() external view returns (uint256);
    function keyActive(bytes32) external view returns (bool);
    function keyCount() external view returns (uint256);
    function book() external view returns (address);
    function treasury() external view returns (address);
    function factory() external view returns (address);
}
interface IProdFactory {
    function vaultFor(uint256 x, uint256 y) external view returns (address);
    function createVault(uint256 x, uint256 y) external returns (address);
    function implementation() external view returns (address);
}

contract FeedMock {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) { return (1, 3000e8, block.timestamp, block.timestamp, 1); }
}

/// Newer forge serves RIP-7212 natively at 0x100 (and refuses vm.etch there); older forge has neither. Probe with a real
/// signature and etch the Daimo verifier fixture only when needed (contracts/foundry/test/EnclaveCreditVault.t.sol).
function ensureP256(Vm vm) {
    address p256 = 0x0000000000000000000000000000000000000100;
    bytes32 digest = keccak256("p256 probe");
    (bytes32 r, bytes32 s) = vm.signP256(0xA1CE, digest);
    (uint256 x, uint256 y) = vm.publicKeyP256(0xA1CE);
    (bool ok, bytes memory ret) = p256.staticcall(abi.encodePacked(digest, r, s, x, y));
    if (!(ok && ret.length == 32 && ret[31] == 0x01)) vm.etch(p256, vm.parseBytes(vm.readFile("fixtures/p256-verifier.hex")));
}

abstract contract CreditVaultBase is Test {
    string constant ORIGIN = "https://enclave.host";
    bytes32 constant BOOK_DEPLOYMENTS = "deployments";
    bytes32 constant BOOK_VAULT_FACTORY = "vaultFactory";
    uint256 constant PK1 = 0xC0FFEE01;      // the customer's passkey (P-256 scalar; vm.signP256)
    uint256 constant PK2 = 0xC0FFEE02;      // a second device
    uint256 constant T0 = 1_792_000_800;
    string constant CREATE10 = "create(string,uint16,uint16,uint32,string,bool,string,address,uint256,uint256)";

    MockUSDC usdc;
    EnclaveRegistry registry;
    EnclaveDeployments ledger;
    EnclaveAddressBook book;
    IProdFactory factory;
    IProdVault vault;
    address payout = makeAddr("payout");
    address treasury = makeAddr("treasury");
    address relayer = makeAddr("relayer");       // any submitter: holds ETH for gas, no authority
    uint256 x1; uint256 y1;
    bytes32 vid;                                  // a deployment the VAULT owns

    function _baseSetUp() internal {
        vm.warp(T0);
        ensureP256(vm);
        usdc = new MockUSDC();
        registry = new EnclaveRegistry();
        ledger = new EnclaveDeployments(address(usdc), payout, address(registry), address(new FeedMock()));
        book = new EnclaveAddressBook();
        book.set(BOOK_DEPLOYMENTS, address(ledger));
        factory = IProdFactory(_deployProductionFactory());
        book.set(BOOK_VAULT_FACTORY, address(factory));
        (x1, y1) = vm.publicKeyP256(PK1);
        vault = IProdVault(factory.createVault(x1, y1));
        usdc.mint(address(vault), 100e6);         // $100 of closed-loop credit (a settled card top-up, in production)
        vm.deal(relayer, 1 ether);
        bytes memory cc = createCall("catalog://app/0", 1000);
        uint256 dl = block.timestamp + 300;
        IProdVault.WebAuthnSig memory w = sig(PK1, deployDigest(cc, 30e6, dl));
        vm.prank(relayer);
        vid = vault.deployAndFund(cc, 30e6, dl, w);
    }

    function _deployProductionFactory() internal returns (address f) {
        bytes memory bc = vm.parseJsonBytes(vm.readFile("fixtures/credit-vault-d36100ae.json"), ".factory.bytecode");
        bytes memory init = abi.encodePacked(bc, abi.encode(address(usdc), address(book), treasury, ORIGIN, ""));
        assembly { f := create(0, add(init, 0x20), mload(init)) }
        require(f != address(0), "factory deploy");
    }

    // ---- WebAuthn assertions, as a browser at `origin` produces them (real P-256 signatures) ----
    function sig(uint256 pk, bytes32 digest) internal view returns (IProdVault.WebAuthnSig memory) { return sigFrom(pk, digest, ORIGIN); }
    function sigFrom(uint256 pk, bytes32 digest, string memory origin) internal view returns (IProdVault.WebAuthnSig memory w) {
        bytes memory auth = abi.encodePacked(sha256("enclave.host"), bytes1(0x05), uint32(7));   // rpIdHash | UP+UV | counter
        bytes memory b64 = bytes(vm.toBase64URL(abi.encodePacked(digest)));
        uint256 len = b64.length; while (len > 0 && b64[len - 1] == "=") len--;
        bytes memory chal = new bytes(len);
        for (uint256 i = 0; i < len; i++) chal[i] = b64[i];
        string memory cdj = string(abi.encodePacked('{"type":"webauthn.get","challenge":"', chal, '","origin":"', origin, '","crossOrigin":false}'));
        (bytes32 r, bytes32 s) = vm.signP256(pk, sha256(abi.encodePacked(auth, sha256(bytes(cdj)))));
        (uint256 px, uint256 py) = vm.publicKeyP256(pk);
        w = IProdVault.WebAuthnSig(auth, cdj, uint256(r), uint256(s), px, py);
    }
    function sigBytes(uint256 pk, bytes32 digest) internal view returns (bytes memory) { return abi.encode(sig(pk, digest)); }

    function createCall(string memory appRef, uint256 maxRate6) internal pure returns (bytes memory) {
        return abi.encodeWithSignature(CREATE10, appRef, uint16(0), uint16(500), uint32(8080), "", true, "", address(0), uint256(0), maxRate6);
    }
    function deployDigest(bytes memory cc, uint256 fund6, uint256 dl) internal view returns (bytes32) {
        return keccak256(abi.encode(keccak256("EnclaveVault.deployAndFund.v1"), address(vault), block.chainid, vault.nonce(), keccak256(cc), fund6, dl));
    }
    function controlDigest(bytes memory callData, uint256 dl) internal view returns (bytes32) {
        return keccak256(abi.encode(keccak256("EnclaveVault.controlDeployment.v1"), address(vault), block.chainid, vault.nonce(), keccak256(callData), dl));
    }
    function addKeyDigest(uint256 x2, uint256 y2, uint256 dl) internal view returns (bytes32) {
        return keccak256(abi.encode(keccak256("EnclaveVault.addKey.v1"), address(vault), block.chainid, vault.nonce(), x2, y2, dl));
    }
    function removeKeyDigest(bytes32 kh, uint256 dl) internal view returns (bytes32) {
        return keccak256(abi.encode(keccak256("EnclaveVault.removeKey.v1"), address(vault), block.chainid, vault.nonce(), kh, dl));
    }
    /// a passkey-signed control op, submitted by the relayer
    function control(bytes memory callData) internal {
        uint256 dl = block.timestamp + 300;
        IProdVault.WebAuthnSig memory w = sig(PK1, controlDigest(callData, dl));
        vm.prank(relayer);
        vault.controlDeployment(callData, dl, w);
    }
}
