// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/// @title ReleaseAnchor — the on-chain authority for one IPNS name's site release.
/// @notice The ipns-publisher reads `state()` through a quorum of RPC endpoints at one agreed block and publishes
///         /ipfs/<cid> at IPNS sequence `sequenceOffset + seq`. The owner appoints a delegate whose only power is
///         publish(cid, expectedSeq): it cannot touch the publisher's config, secrets or key, the owner, or itself.
///         The owner's pin() always wins and revokes the delegate in the same transaction.
/// @dev Immutable by construction: no proxy, no delegatecall, no selfdestruct. `nameHash` is an immutable, so it
///      is part of the runtime code and the publisher's pinned codehash covers it.
contract ReleaseAnchor {
    bytes32 public constant SCHEMA = keccak256("enclave.ipns-release-anchor.v1");
    uint64 public constant MAX_DELEGATION_SECS = 180 days;

    /// keccak256 of the IPNS name's peer multihash bytes (identity multihash of the ed25519 public key protobuf).
    bytes32 public immutable nameHash;

    address public owner;
    address public pendingOwner;
    address public delegate;
    uint64 public delegateUntil;
    uint64 public seq;
    bool public retired;
    address public successor;
    string private _cid;

    event Published(uint64 indexed seq, string cid, address indexed by);
    event DelegateSet(address delegate, uint64 until);
    event OwnershipTransferStarted(address indexed owner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Retired(address successor, uint64 seq);

    error NotOwner();
    error NotAuthorized();
    error NotPendingOwner();
    error IsRetired();
    error ZeroAddress();
    error BadCid();
    error BadName();
    error StaleSeq(uint64 expected, uint64 current);
    error BadDelegation();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier live() {
        if (retired) revert IsRetired();
        _;
    }

    constructor(address owner_, bytes32 nameHash_, string memory cid_) {
        if (owner_ == address(0)) revert ZeroAddress();
        if (nameHash_ == bytes32(0)) revert BadName();
        _checkCid(bytes(cid_));
        owner = owner_;
        nameHash = nameHash_;
        seq = 1;
        _cid = cid_;
        emit OwnershipTransferred(address(0), owner_);
        emit Published(1, cid_, msg.sender);
    }

    /// The delegate's (and the owner's) release call. The compare-and-swap makes a stale or replayed transaction fail.
    function publish(string calldata cid_, uint64 expectedSeq) external live {
        if (msg.sender != owner && !(msg.sender == delegate && block.timestamp <= delegateUntil)) {
            revert NotAuthorized();
        }
        if (expectedSeq != seq) revert StaleSeq(expectedSeq, seq);
        _set(cid_);
    }

    /// Owner override: a new release AND no delegate, in one transaction. No CAS, so a racing delegate cannot block it.
    function pin(string calldata cid_) external onlyOwner live {
        _setDelegate(address(0), 0);
        _set(cid_);
    }

    /// Appoint (bounded in time) or revoke (d = 0, until = 0) the delegate.
    function setDelegate(address d, uint64 until) external onlyOwner live {
        if (d == address(0)) {
            if (until != 0) revert BadDelegation();
        } else if (until <= block.timestamp || until > block.timestamp + MAX_DELEGATION_SECS) {
            revert BadDelegation();
        }
        _setDelegate(d, until);
    }

    /// Two-step transfer; `to = 0` cancels a pending one.
    function transferOwnership(address to) external onlyOwner live {
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    /// The new owner starts with no delegate: an appointment never outlives the owner who made it.
    function acceptOwnership() external live {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        address previous = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        _setDelegate(address(0), 0);
        emit OwnershipTransferred(previous, msg.sender);
    }

    /// Freeze forever. `successor` is a pointer for humans; publishers never follow it without a new owner config.
    function retire(address successor_) external onlyOwner live {
        _setDelegate(address(0), 0);
        pendingOwner = address(0);
        retired = true;
        successor = successor_;
        emit Retired(successor_, seq);
    }

    function cid() external view returns (string memory) {
        return _cid;
    }

    /// Everything the publisher needs, read atomically at one block.
    function state()
        external
        view
        returns (
            bytes32 schema,
            bytes32 nameHash_,
            uint64 seq_,
            string memory cid_,
            address owner_,
            address delegate_,
            uint64 delegateUntil_,
            bool retired_,
            address successor_
        )
    {
        return (SCHEMA, nameHash, seq, _cid, owner, delegate, delegateUntil, retired, successor);
    }

    function _set(string calldata cid_) private {
        _checkCid(bytes(cid_));
        uint64 next = seq + 1; // checked: reverts at type(uint64).max
        seq = next;
        _cid = cid_;
        emit Published(next, cid_, msg.sender);
    }

    function _setDelegate(address d, uint64 until) private {
        if (delegate == d && delegateUntil == until) return;
        delegate = d;
        delegateUntil = until;
        emit DelegateSet(d, until);
    }

    /// A multibase base32-lower string: 'b' then [a-z2-7], 8..128 bytes. The publisher additionally decodes it as a
    /// CIDv1; this check keeps paths, whitespace and other encodings out of the record value.
    function _checkCid(bytes memory c) private pure {
        uint256 n = c.length;
        if (n < 8 || n > 128 || c[0] != "b") revert BadCid();
        for (uint256 i = 1; i < n; ++i) {
            bytes1 ch = c[i];
            if (!((ch >= "a" && ch <= "z") || (ch >= "2" && ch <= "7"))) revert BadCid();
        }
    }
}
