// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// EnclaveKeyAttestations - which enclave image a session key was generated in.
/// Design: docs/design/sessions.md §10 (attested session keys, phase g).
///
/// A grant whose `measurement` is non-zero may only be used by a session key
/// that was GENERATED INSIDE an enclave running that image. The enclave proves
/// it off-chain: it puts a digest of the key in its hardware report's
/// report_data, and an ATTESTOR (the relay operator's key, named here by
/// governance) verifies that report and records keyHash -> measurement here.
/// SessionVault reads bindingOf() when such a session opens and on every
/// operation it makes (ISVKeyAttestations in SessionVault.sol).
///
///   keyHash      keccak256(abi.encode(uint256 x, uint256 y)) of the P-256 key,
///                exactly the vault's Session.keyHash
///   measurement  the image's measurement as the attestor maps it to 32 bytes
///                (SEV-SNP: sha256 of the 48-byte launch measurement; the
///                mapping lives with the verifier, relay/sessions.mjs)
///
/// What this contract trusts: the attestors. It cannot check a hardware report
/// itself, so an attestor key can bind any key to any measurement. The limits
/// on that are below: governance names and removes attestors, a binding never
/// changes image, revocation is permanent, and removing an attestor voids every
/// binding it recorded in one transaction.
///
/// Rules:
/// - A key is generated inside ONE image, so a binding never moves to another
///   measurement. A changed image means a new key (and a new grant).
/// - Recording the same (key, measurement) again is a no-op.
/// - revoke() is permanent: a revoked key can never be bound again. The
///   attestor that recorded a binding may revoke it, and so may the owner
///   (e.g. after a TCB advisory). The owner may also revoke a key that was
///   never recorded, so that it never can be.
/// - A binding recorded by an address that is no longer an attestor reads as
///   revoked (bindingOf) - the response to a stolen attestor key is
///   setAttestor(key, false), not a hunt through events. Such a VOID binding
///   may be recorded afresh by a current attestor (from a fresh verification);
///   a revoked one may not. Re-adding the removed address revives the bindings
///   it recorded, so a compromised key must never be re-added.
/// - The owner is never zero: there is no renounce, so someone can always
///   revoke. Ownership moves in two steps.
///
/// No proxy, no upgrade, no pause: a new version is a new deployment, which a
/// new SessionVaultFactory names (the vault pins this address as an immutable).
contract EnclaveKeyAttestations {
    struct Binding {
        bytes32 measurement;   // 0 = never recorded
        uint64  attestedAt;    // block time of the recording
        address attestor;      // who recorded it
        bool    revoked;       // permanent
    }

    address public owner;
    address public pendingOwner;
    mapping(address => bool) public isAttestor;
    mapping(bytes32 => Binding) private _bindings;

    // ---- events ----
    event OwnershipTransferStarted(address indexed owner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AttestorSet(address indexed attestor, bool enabled);
    event KeyAttested(bytes32 indexed keyHash, bytes32 indexed measurement, address indexed attestor);
    event KeyRevoked(bytes32 indexed keyHash, address indexed by);

    // ---- errors ----
    error NotOwner();
    error NotPendingOwner();
    error NotAttestor();
    error NotRevoker();
    error ZeroAddress();
    error ZeroKey();
    error ZeroMeasurement();
    error MeasurementConflict(bytes32 keyHash, bytes32 recorded);
    error KeyIsRevoked(bytes32 keyHash);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @param owner_    governance (revokes, names attestors); never zero
    /// @param attestor_ an initial attestor, or zero for none
    constructor(address owner_, address attestor_) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
        if (attestor_ != address(0)) {
            isAttestor[attestor_] = true;
            emit AttestorSet(attestor_, true);
        }
    }

    // =========================================================================
    // Reads
    // =========================================================================

    /// What SessionVault checks (ISVKeyAttestations): the measurement `keyHash`
    /// was attested under (0 = never recorded), and whether the binding must be
    /// refused - revoked, or recorded by an address that is no longer an
    /// attestor.
    function bindingOf(bytes32 keyHash) external view returns (bytes32 measurement, bool revoked) {
        Binding storage b = _bindings[keyHash];
        measurement = b.measurement;
        revoked = b.revoked || (measurement != bytes32(0) && !isAttestor[b.attestor]);
    }

    /// The stored record, as written (bindingOf is the verdict).
    function getBinding(bytes32 keyHash) external view returns (Binding memory) {
        return _bindings[keyHash];
    }

    // =========================================================================
    // Attestors
    // =========================================================================

    /// Record that the session key `keyHash` was generated inside an enclave
    /// running `measurement`. The caller has verified the enclave's report.
    function attest(bytes32 keyHash, bytes32 measurement) external {
        if (!isAttestor[msg.sender]) revert NotAttestor();
        if (keyHash == bytes32(0)) revert ZeroKey();
        if (measurement == bytes32(0)) revert ZeroMeasurement();
        Binding storage b = _bindings[keyHash];
        if (b.revoked) revert KeyIsRevoked(keyHash);
        // a live binding: same image is a no-op, another image is refused
        if (b.measurement != bytes32(0) && isAttestor[b.attestor]) {
            if (b.measurement != measurement) revert MeasurementConflict(keyHash, b.measurement);
            return;
        }
        // never recorded, or void (its attestor was removed): record afresh
        b.measurement = measurement;
        b.attestedAt = uint64(block.timestamp);
        b.attestor = msg.sender;
        emit KeyAttested(keyHash, measurement, msg.sender);
    }

    /// Revoke a binding, permanently. The attestor that recorded it, or the
    /// owner (who may also revoke a key that was never recorded).
    function revoke(bytes32 keyHash) external {
        if (keyHash == bytes32(0)) revert ZeroKey();
        Binding storage b = _bindings[keyHash];
        if (msg.sender != owner && (b.measurement == bytes32(0) || msg.sender != b.attestor)) revert NotRevoker();
        if (b.revoked) revert KeyIsRevoked(keyHash);
        b.revoked = true;
        emit KeyRevoked(keyHash, msg.sender);
    }

    // =========================================================================
    // Governance
    // =========================================================================

    /// Name (true) or remove (false) an attestor. Removing one voids every
    /// binding it recorded (bindingOf reports them revoked).
    function setAttestor(address attestor, bool enabled) external onlyOwner {
        if (attestor == address(0)) revert ZeroAddress();
        isAttestor[attestor] = enabled;
        emit AttestorSet(attestor, enabled);
    }

    /// Step one of an ownership transfer; zero cancels a pending one.
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// Step two: the pending owner accepts (never zero: the owner is never zero).
    function acceptOwnership() external {
        if (msg.sender != pendingOwner || msg.sender == address(0)) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }
}
