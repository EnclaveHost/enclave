// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title EnclaveLeaseExecutor - EIP-7702 delegate for a host OPERATOR key: lease calls signed by that key, relayed by
///        anyone, gas paid from the app's reserve.
///
/// PROTOTYPE (work/app-lease-gas, design B). The operator key delegates (EIP-7702) to this code. Then ANY relayer may
/// call lease() on the operator's address with a Lease the key itself signed (EIP-712, verifyingContract = the
/// operator's own address). The code runs AS the operator: the ledger sees the operator as msg.sender, exactly as
/// when the key pays its own gas. It can do NOTHING else:
///   - one function: claim(id, enclaveId) / renew(id) / release(id) on the reserve's ledger, nothing more;
///   - only for a Lease signed by this very key, before its deadline, at the key's next nonce for that deployment;
///   - only when the app's reserve (EnclaveLeaseGasReserve) admits it (owner's budget, policy, caps).
/// The reserve then pays the relayer the measured gas from the app's ETH reserve, in the same transaction. A
/// reverted ledger call reverts everything: no lease, no charge, the relayer's own (simulated-away) loss.
///
/// The key's nonces live in the key's own storage under an ERC-7201 namespace, so a later re-delegation cannot
/// collide with them.
///
/// Round 3 (root review): the signed Lease binds the PAYEE (the relay the host chose: a front-runner who copies the
/// transaction can only pay that relay) and the MAXIMUM CHARGE (a relay bidding a high gas price cannot make the app
/// pay more than the host agreed to). The call must be the canonical encoding (exactly CANONICAL_LENGTH bytes: no
/// trailing calldata to inflate the calldata term), and the reserve admits ONE lease operation per transaction (a
/// wrapper batching several cannot collect the intrinsic gas twice; a payee callback cannot start another).
///
/// Round 3 economics (root review 17:14Z/17:25Z): the FIRST lease of a key through THIS executor is the transaction that
/// carries the key's EIP-7702 authorization (the host client attaches one exactly when the key is not yet delegated
/// here). It is recorded in the key's own storage and reported to the reserve, which then charges the authorization's
/// intrinsic gas and its encoded bytes once, instead of leaving them to the relay. Bounded edge cases, once per key:
/// a delegation that already existed (a reverted earlier attempt applies its authorization too) is still charged once
/// on the first successful lease; a re-delegation back to this executor later is not charged again.
contract EnclaveLeaseExecutor {
    struct Lease {
        bytes32 id;
        uint8 kind;            // 1 claim, 2 renew, 3 release
        bytes32 enclaveId;     // claim only (0 otherwise)
        uint64 nonce;          // this key's next nonce for this deployment
        uint64 deadline;       // unix seconds
        address payee;         // the relay paid (bound: copying the transaction cannot redirect the payment)
        uint256 maxChargeWei;  // the most the app may be charged for this operation (the host's quote)
    }
    /// selector + the static Lease (7 words) + the signature's offset + its length + 65 bytes padded to 96
    uint256 public constant CANONICAL_LENGTH = 4 + 7 * 32 + 32 + 32 + 96;

    IEnclaveLeaseGasReserve public immutable reserve;
    address public immutable ledger;
    address private immutable SELF;           // this executor's own address (the code runs AS the operator)

    uint8 internal constant KIND_CLAIM = 1;
    uint8 internal constant KIND_RENEW = 2;
    uint8 internal constant KIND_RELEASE = 3;
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant LEASE_TYPEHASH = keccak256(
        "Lease(address reserve,bytes32 id,uint8 kind,bytes32 enclaveId,uint64 nonce,uint64 deadline,address payee,uint256 maxChargeWei)");
    /// keccak256(abi.encode(uint256(keccak256("enclave.lease-executor.nonces")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant NONCES_SLOT = 0xd4303515233e7d5d6aff53061198d268e21693bbe46ee8802da444a318c9fa00;
    /// keccak256(abi.encode(uint256(keccak256("enclave.lease-executor.authorized")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant AUTHORIZED_SLOT = 0xa56564ef639f1ba7b44970246267b2ab8c83a9eb9d0bde5c2e8a5ec36c96cb00;

    error Expired();
    error BadSignature();
    error BadNonce(uint64 expected);
    error BadKind();
    error NotCanonical();

    constructor(IEnclaveLeaseGasReserve _reserve) {
        reserve = _reserve;
        ledger = _reserve.ledger();
        SELF = address(this);
    }

    /// @notice Run one signed lease operation as this key and pay `payee` (the relayer) from the app's reserve.
    function lease(Lease calldata l, bytes calldata signature) external {
        uint256 gasStart = gasleft();
        if (msg.data.length != CANONICAL_LENGTH || signature.length != 65) revert NotCanonical();
        if (block.timestamp > l.deadline) revert Expired();
        if (_recover(leaseDigest(l), signature) != address(this)) revert BadSignature();
        bytes32 slot = keccak256(abi.encode(l.id, NONCES_SLOT));
        uint64 next;
        assembly { next := sload(slot) }
        if (l.nonce != next) revert BadNonce(next);
        assembly { sstore(slot, add(next, 1)) }
        // the key's first lease through this executor: its transaction carried the EIP-7702 authorization
        bytes32 aslot = keccak256(abi.encode(SELF, AUTHORIZED_SLOT));
        bool firstAuthorization;
        assembly { firstAuthorization := iszero(sload(aslot)) }
        if (firstAuthorization) assembly { sstore(aslot, 1) }
        reserve.begin(l.id, l.kind, l.enclaveId);
        if (l.kind == KIND_CLAIM) ILeaseLedger(ledger).claim(l.id, l.enclaveId);
        else if (l.kind == KIND_RENEW) ILeaseLedger(ledger).renew(l.id);
        else if (l.kind == KIND_RELEASE) ILeaseLedger(ledger).release(l.id);
        else revert BadKind();
        reserve.finish(l.id, payable(l.payee), gasStart - gasleft(), CANONICAL_LENGTH, l.maxChargeWei, firstAuthorization);
    }

    /// @notice Whether this key has completed a lease through this executor (its authorization has been charged once).
    function authorizationCharged() external view returns (bool done) {
        bytes32 aslot = keccak256(abi.encode(SELF, AUTHORIZED_SLOT));
        assembly { done := sload(aslot) }
    }
    /// @notice This key's next nonce for a deployment (read on the delegated address).
    function nonceOf(bytes32 id) external view returns (uint64 n) {
        bytes32 slot = keccak256(abi.encode(id, NONCES_SLOT));
        assembly { n := sload(slot) }
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("EnclaveLeaseExecutor"), keccak256("1"), block.chainid, address(this)));
    }

    function leaseDigest(Lease calldata l) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(),
            keccak256(abi.encode(LEASE_TYPEHASH, address(reserve), l.id, l.kind, l.enclaveId, l.nonce, l.deadline, l.payee, l.maxChargeWei))));
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        return ecrecover(digest, v, r, s);
    }
}

interface IEnclaveLeaseGasReserve {
    function ledger() external view returns (address);
    function begin(bytes32 id, uint8 kind, bytes32 enclaveId) external;
    function finish(bytes32 id, address payable payee, uint256 gasUsed, uint256 calldataLength, uint256 maxChargeWei, bool authorization) external;
}

interface ILeaseLedger {
    function claim(bytes32 id, bytes32 enclaveId) external;
    function renew(bytes32 id) external;
    function release(bytes32 id) external;
}
