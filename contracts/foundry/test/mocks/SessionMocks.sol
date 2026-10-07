// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { MockUSDC } from "./MockUSDC.sol";
import { IEnclaveRegistry } from "../../../EnclaveDeployments.sol";

/// MockUSDC plus a faithful EIP-3009 receiveWithAuthorization (the bytes-
/// signature overload Base's FiatTokenV2_2 exposes): payee must be the caller,
/// the time window is exclusive on both ends like USDC's, a (from, nonce) pair
/// is single-use, and the signature is ECDSA by `from` over the USDC domain.
contract MockUSDC3009 is MockUSDC {
    mapping(address => mapping(bytes32 => bool)) public authorizationState;
    bytes32 public constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");

    function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter,
        uint256 validBefore, bytes32 nonce, bytes calldata signature) external
    {
        require(msg.sender == to, "caller must be the payee");
        require(block.timestamp > validAfter, "authorization is not yet valid");
        require(block.timestamp < validBefore, "authorization is expired");
        require(!authorizationState[from][nonce], "authorization is used or canceled");
        require(signature.length == 65, "sig length");
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(),
            keccak256(abi.encode(RECEIVE_TYPEHASH, from, to, value, validAfter, validBefore, nonce))));
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        address rec = ecrecover(digest, v, r, s);
        require(rec != address(0) && rec == from, "invalid signature");
        authorizationState[from][nonce] = true;
        require(balanceOf[from] >= value, "balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}

contract SessionRegistryStub {
    mapping(bytes32 => address) public operatorOf;
    function set(bytes32 id, address operator) external { operatorOf[id] = operator; }
    function get(bytes32 id) external view returns (IEnclaveRegistry.Enclave memory e) {
        e.operator = operatorOf[id];
        e.active = true;
        e.cpuPricePerSec6 = 834;
        e.gpuPricePerSec6 = 1667;
    }
}

/// A contract wallet owner (ERC-1271) that accepts its EOA signer's ECDSA.
contract Mock1271Owner {
    address public signer;
    constructor(address s) { signer = s; }
    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        if (sig.length != 65) return 0xffffffff;
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        return ecrecover(hash, v, r, s) == signer ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
    function call(address to, bytes calldata data) external returns (bytes memory ret) {
        bool ok;
        (ok, ret) = to.call(data);
        require(ok, "inner");
    }
}

contract MockKeyAttestations {
    mapping(bytes32 => bytes32) public m;
    mapping(bytes32 => bool) public revoked;
    function set(bytes32 keyHash, bytes32 measurement) external { m[keyHash] = measurement; }
    function revoke(bytes32 keyHash) external { revoked[keyHash] = true; }
    function bindingOf(bytes32 keyHash) external view returns (bytes32, bool) { return (m[keyHash], revoked[keyHash]); }
}

/// A hostile "ledger" governance could repoint the book at: on every call it
/// tries to pull MORE than the vault approved and to re-enter the vault.
contract HostileLedger {
    address public token;
    address public vault;
    bytes public reenter;
    bool public underPull;
    bytes32 public fixedId;
    constructor(address t) { token = t; }
    function setFixedId(bytes32 v) external { fixedId = v; }
    /// "creates" by returning an id of its choosing - e.g. an existing custody record
    function create(string calldata, uint16, uint16, uint32, string calldata, bool, string calldata, address, uint256,
        uint256) external view returns (bytes32) { return fixedId; }
    function arm(address v, bytes calldata data) external { vault = v; reenter = data; }
    function setUnderPull(bool v) external { underPull = v; }
    function fundFor(bytes32, uint256 value, address) external {
        if (underPull) {   // take one unit LESS than approved, leaving an allowance behind
            (bool okU, ) = token.call(abi.encodeWithSignature("transferFrom(address,address,uint256)", vault, address(this), value - 1));
            require(okU, "pull");
            return;
        }
        if (reenter.length > 0) {
            (bool ok, ) = vault.call(reenter);
            require(!ok, "re-entry succeeded");
        }
        // over-pull: one more unit than approved must fail
        (bool ok2, ) = token.call(abi.encodeWithSignature("transferFrom(address,address,uint256)", vault, address(this), value + 1));
        require(!ok2, "over-pull succeeded");
        (bool ok3, ) = token.call(abi.encodeWithSignature("transferFrom(address,address,uint256)", vault, address(this), value));
        require(ok3, "pull");
    }
    struct Deployment {
        bytes32 id; address owner; string appRef; string ports; string configCid;
        uint16 gpuMilli; uint16 cpuMilli; uint32 appPort; bool isPublic; bool active; uint64 createdAt;
        uint256 rate; uint256 balance6; uint256 spent6;
        bytes32 runner; address runnerOperator; uint64 leaseUntil;
    }
    function get(bytes32) external view returns (Deployment memory d) { d.owner = vault; d.rate = 1000; }
    function capOf(bytes32) external pure returns (uint256) { return 1000; }
    function feeOf(bytes32) external pure returns (address, uint256) { return (address(0), 0); }
    function setMaxRate(bytes32, uint256) external {}
}
