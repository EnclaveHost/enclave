// SPDX-License-Identifier: MIT
// Test-only contract wallets for the app sign-in end-to-end tests (eyesoff-ai/tests/helpers/evm.mjs). Run on a LOCAL anvil
// chain only; never deployed anywhere real.
//   OwnerWallet     ERC-1271: a 65-byte ECDSA signature by `owner` over the hash is valid, unless the owner revoked that hash.
//   WalletFactory   deploys OwnerWallet(owner) with CREATE2, so a wallet's address is known before it exists (ERC-6492).
pragma solidity 0.8.35;

contract OwnerWallet {
    address public immutable owner;
    mapping(bytes32 => bool) public revoked;

    constructor(address owner_) { owner = owner_; }

    function revoke(bytes32 hash) external {
        require(msg.sender == owner, "not the owner");
        revoked[hash] = true;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (revoked[hash] || signature.length != 65) return 0xffffffff;
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        if (v < 27) v += 27;
        address signer = ecrecover(hash, v, r, s);
        return signer != address(0) && signer == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

contract WalletFactory {
    function deploy(address owner, bytes32 salt) external returns (address wallet) {
        wallet = address(new OwnerWallet{salt: salt}(owner));
    }

    function predict(address owner, bytes32 salt) external view returns (address) {
        bytes32 code = keccak256(abi.encodePacked(type(OwnerWallet).creationCode, abi.encode(owner)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, code)))));
    }
}
