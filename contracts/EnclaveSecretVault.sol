// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title EnclaveSecretVault: encrypted deployment secrets, their owner-set release policy, and the custodian committees
///        that hold the key shares. docs/security/secret-custody.md is the design; custody/ is the off-chain half.
///
/// WHAT LIVES HERE (all of it public; none of it decryptable by this contract, the relay, or any single custodian):
///   - per deployment, a POLICY: its pinned owner, the release rules (canonical JSON the custodians enforce: app id, admitted
///     images, TCB floor), the custodian committee, a pause switch, and two monotonic revisions;
///   - per deployment, the current BUNDLE: AES-256-GCM ciphertext of the env map under a data key that only a threshold of
///     the committee's members can reconstruct (Shamir shares of it, each HPKE-sealed to one member's key, plus Feldman
///     commitments that make every share checkable);
///   - COMMITTEES: member operators, their HPKE keys and endpoints, by epoch. Membership changes need a threshold of the
///     CURRENT members; nobody else (not the platform governance, not the relay) can change a committee.
///   - RESHARE transcripts: old members re-share their shares to a new epoch's members without anyone reconstructing the key.
///
/// AUTHORIZATION. The owner of deployment D is the ledger's owner of D, resolved through the address book (and, for a
/// SessionVault-held record, that vault's owner). It is PINNED here at D's first policy write; afterwards only that owner
/// can change D's policy or bundle, by sending the transaction or by an EIP-712 signature checked with ecrecover for an EOA
/// and ERC-1271 for a contract owner (the passkey credit vault), so passkey owners never expose a key and need no gas.
/// If the ledger later names a different owner (a transfer), that new owner may claimPolicy(), which DESTROYS the old
/// owner's bundle: a new owner never inherits the previous owner's secrets, and custodians refuse every release while the
/// ledger and the pinned owner disagree. So repointing the address book (governance) can at worst wipe a bundle; it cannot
/// read one or redirect one to code the owner did not admit.
///
/// No proxy, no admin, no pause of the contract as a whole.
interface ISecretVaultBook { function addr(bytes32 key) external view returns (address); }
interface ISecretVaultLedger {
    // byte-for-byte the ledger's Deployment tuple (stable since schema 2; contracts/SessionVault.sol ISVLedger)
    struct Deployment {
        bytes32 id; address owner; string appRef; string ports; string configCid;
        uint16 gpuMilli; uint16 cpuMilli; uint32 appPort; bool isPublic; bool active; uint64 createdAt;
        uint256 rate; uint256 balance6; uint256 spent6;
        bytes32 runner; address runnerOperator; uint64 leaseUntil;
    }
    function get(bytes32 id) external view returns (Deployment memory);
}
interface ISecretVaultFactory { function isVault(address v) external view returns (bool); }
interface ISecretVaultSession { function owner() external view returns (address); }
interface ISecretVault1271 { function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4); }

contract EnclaveSecretVault {
    bytes32 private constant BOOK_DEPLOYMENTS = "deployments";
    bytes32 private constant BOOK_SESSION_FACTORY = "sessionVaultFactory";
    uint256 public constant MAX_MEMBERS = 32;
    uint256 public constant MAX_CIPHERTEXT = 24576;   // the 16 KB env map + JSON + nonce + tag, with headroom
    uint256 public constant MAX_RULES = 4096;
    uint256 public constant MAX_ENDPOINT = 200;
    uint256 public constant SEALED_SHARE = 80;        // HPKE enc(32) + 32-byte share + GCM tag(16)
    uint256 public constant POINT = 33;               // compressed secp256k1 point

    ISecretVaultBook public immutable book;

    // ---------------------------------------------------------------- committees
    struct Member { address operator; bytes32 encKey; string endpoint; }
    struct Epoch { uint8 threshold; uint64 activatedAt; Member[] members; }
    struct Committee { address creator; uint32 epoch; }
    mapping(bytes32 => Committee) private _committees;
    mapping(bytes32 => mapping(uint32 => Epoch)) private _epochs;
    // committee -> proposal hash -> approver bitmap (by member index in the CURRENT epoch)
    mapping(bytes32 => mapping(bytes32 => uint256)) private _approvals;

    // ---------------------------------------------------------------- policies and bundles
    struct Policy {
        address owner;        // pinned at the first write (beneficial ledger owner)
        uint64 policyRev;     // +1 on EVERY owner change (rules, committee, pause, bundle, clear, claim)
        uint64 secretRev;     // +1 on every bundle put or clear
        bytes32 committeeId;
        bool paused;          // owner's emergency stop: custodians release nothing while set
        bytes rules;          // canonical JSON, enforced by custodians (custody/rules.mjs)
    }
    struct Bundle { uint32 epoch; bytes ciphertext; }   // the CURRENT revision only; history is in events
    mapping(bytes32 => Policy) private _policies;
    mapping(bytes32 => Bundle) private _bundles;

    // shares: deployment -> secretRev -> epoch -> set -> sealed shares. Set 0 = the owner's own split; a reshare's set is
    // shareSetOf(source, commitments): its dealer source AND its exact commitments. _activeSource names the set that completed.
    struct ShareSet { bytes commitments; uint8 posted; mapping(uint8 => bytes) sealedBy; }
    mapping(bytes32 => mapping(uint64 => mapping(uint32 => mapping(uint256 => ShareSet)))) private _shares;
    mapping(bytes32 => mapping(uint64 => mapping(uint32 => uint256))) private _activeSource;
    mapping(bytes32 => mapping(uint64 => mapping(uint32 => bool))) private _complete;
    // the bundle's constant commitment C0 = s*G, per revision: every reshare's commitments must start with it (same secret)
    mapping(bytes32 => mapping(uint64 => bytes)) private _c0;
    // reshare deals: deployment -> secretRev -> from epoch -> to epoch -> old member index -> deal bytes (custody/reshare.mjs)
    mapping(bytes32 => mapping(uint64 => mapping(uint32 => mapping(uint32 => mapping(uint8 => bytes))))) private _deals;
    mapping(bytes32 => mapping(uint64 => mapping(uint32 => mapping(uint32 => uint256)))) private _dealBitmap;

    // ---------------------------------------------------------------- EIP-712
    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant UPDATE_TYPEHASH = keccak256("Update(bytes32 id,uint64 expectPolicyRev,uint64 deadline,bytes32 contentHash)");
    bytes32 private constant CLAIM_TYPEHASH = keccak256("Claim(bytes32 id,uint64 expectPolicyRev,uint64 deadline)");

    // ---------------------------------------------------------------- events
    event CommitteeCreated(bytes32 indexed committeeId, address indexed creator, uint8 threshold, uint256 members);
    event EpochApproved(bytes32 indexed committeeId, bytes32 indexed proposal, address approver, uint256 approvals);
    event EpochActivated(bytes32 indexed committeeId, uint32 epoch, uint8 threshold, uint256 members);
    event PolicyUpdated(bytes32 indexed id, address indexed owner, uint64 policyRev, bytes32 committeeId, bool paused);
    event BundlePut(bytes32 indexed id, uint64 secretRev, bytes32 committeeId, uint32 epoch, uint256 ciphertextBytes);
    event BundleCleared(bytes32 indexed id, uint64 secretRev);
    event PolicyClaimed(bytes32 indexed id, address indexed previousOwner, address indexed newOwner, uint64 policyRev);
    event DealPosted(bytes32 indexed id, uint64 secretRev, uint32 toEpoch, uint8 dealer);
    event ResharePosted(bytes32 indexed id, uint64 secretRev, uint32 toEpoch, uint256 source, uint8 member);
    event ReshareComplete(bytes32 indexed id, uint64 secretRev, uint32 epoch, uint256 source);

    error NotOwner();
    error StaleRevision(uint64 current, uint64 expected);
    error BadCommittee();
    error BadMembers();
    error BadBundle();
    error BadRules();
    error NotMember();
    error Expired();
    error BadSignature();
    error NoLedger();
    error NothingToClaim();
    error BadReshare();

    constructor(ISecretVaultBook book_) { book = book_; }

    // ================================================================= committees
    function _checkMembers(uint8 threshold, Member[] calldata members) private pure {
        uint256 n = members.length;
        if (threshold == 0 || n < threshold || n > MAX_MEMBERS) revert BadMembers();
        for (uint256 i = 0; i < n; i++) {
            if (members[i].operator == address(0) || members[i].encKey == bytes32(0)) revert BadMembers();
            uint256 len = bytes(members[i].endpoint).length;
            if (len == 0 || len > MAX_ENDPOINT) revert BadMembers();
            for (uint256 j = 0; j < i; j++)
                if (members[j].operator == members[i].operator || members[j].encKey == members[i].encKey) revert BadMembers();
        }
    }
    function _store(bytes32 cid, uint32 epoch, uint8 threshold, Member[] calldata members) private {
        Epoch storage e = _epochs[cid][epoch];
        e.threshold = threshold;
        e.activatedAt = uint64(block.timestamp);
        for (uint256 i = 0; i < members.length; i++) e.members.push(members[i]);
    }

    /// anyone may create a committee; owners choose which committee holds their deployment's shares
    function createCommittee(bytes32 salt, uint8 threshold, Member[] calldata members) external returns (bytes32 cid) {
        _checkMembers(threshold, members);
        cid = keccak256(abi.encode(msg.sender, salt));
        if (_committees[cid].epoch != 0) revert BadCommittee();
        _committees[cid] = Committee(msg.sender, 1);
        _store(cid, 1, threshold, members);
        emit CommitteeCreated(cid, msg.sender, threshold, members.length);
        emit EpochActivated(cid, 1, threshold, members.length);
    }

    function proposalHash(bytes32 cid, uint32 baseEpoch, uint8 threshold, Member[] calldata members) public pure returns (bytes32) {
        return keccak256(abi.encode(cid, baseEpoch, threshold, members));
    }

    /// a member of the CURRENT epoch approves the next epoch's membership (or key rotation: same operators, new keys). When a
    /// threshold of current members has approved the same content, it becomes the current epoch. Bundles move to it only by
    /// resharing (postDeal / postReshare), so until then the old epoch's members keep serving them.
    function approveEpoch(bytes32 cid, uint8 threshold, Member[] calldata members) external {
        Committee storage c = _committees[cid];
        if (c.epoch == 0) revert BadCommittee();
        _checkMembers(threshold, members);
        Epoch storage cur = _epochs[cid][c.epoch];
        uint256 idx = _memberIndex(cur, msg.sender);
        bytes32 p = proposalHash(cid, c.epoch, threshold, members);
        uint256 bits = _approvals[cid][p] | (uint256(1) << idx);
        _approvals[cid][p] = bits;
        uint256 count = _popcount(bits);
        emit EpochApproved(cid, p, msg.sender, count);
        if (count >= cur.threshold) {
            uint32 next = c.epoch + 1;
            c.epoch = next;
            _store(cid, next, threshold, members);
            emit EpochActivated(cid, next, threshold, members.length);
        }
    }

    function _memberIndex(Epoch storage e, address who) private view returns (uint256) {
        for (uint256 i = 0; i < e.members.length; i++) if (e.members[i].operator == who) return i;
        revert NotMember();
    }
    function _popcount(uint256 x) private pure returns (uint256 n) { while (x != 0) { x &= x - 1; n++; } }

    function committeeOf(bytes32 cid) external view returns (address creator, uint32 epoch) {
        Committee storage c = _committees[cid];
        return (c.creator, c.epoch);
    }
    function epochOf(bytes32 cid, uint32 epoch) external view returns (uint8 threshold, uint64 activatedAt, Member[] memory members) {
        Epoch storage e = _epochs[cid][epoch];
        return (e.threshold, e.activatedAt, e.members);
    }

    // ================================================================= ownership
    function _ledger() private view returns (ISecretVaultLedger) {
        address a = book.addr(BOOK_DEPLOYMENTS);
        if (a == address(0)) revert NoLedger();
        return ISecretVaultLedger(a);
    }
    /// the ledger's owner of `id`, or, for a SessionVault-held record, that vault's owner (who alone may set secrets: a
    /// session key never can). address(0) for no such deployment.
    function beneficialOwnerOf(bytes32 id) public view returns (address o) {
        o = _ledger().get(id).owner;
        if (o == address(0) || o.code.length == 0) return o;
        address f = book.addr(BOOK_SESSION_FACTORY);
        if (f != address(0)) {
            try ISecretVaultFactory(f).isVault(o) returns (bool v) {
                if (v) return ISecretVaultSession(o).owner();
            } catch {}
        }
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("EnclaveSecretVault"), keccak256("1"), block.chainid, address(this)));
    }
    function _isValidSig(address signer, bytes32 digest, bytes calldata sig) private view returns (bool) {
        if (signer == address(0)) return false;
        if (signer.code.length > 0) {
            try ISecretVault1271(signer).isValidSignature(digest, sig) returns (bytes4 m) { return m == 0x1626ba7e; } catch { return false; }
        }
        if (sig.length != 65) return false;
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        // EIP-2: the low-s half only, so a signature has exactly one valid form
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0 || (v != 27 && v != 28)) return false;
        address got = ecrecover(digest, v, r, s);
        return got != address(0) && got == signer;
    }

    // ================================================================= owner updates
    struct Update {
        uint64 expectPolicyRev;   // the policy revision this update was built against (also its replay guard)
        bool setPolicy;           // replace committeeId, paused and rules
        bytes32 committeeId;
        bool paused;
        bytes rules;
        bool putBundle;           // a new bundle for secretRev + 1 (encrypted by the owner for exactly that revision)
        bool clearBundle;         // destroy the bundle (secretRev + 1, nothing stored)
        uint32 epoch;             // the committee epoch the shares are sealed to (its current one)
        bytes ciphertext;
        bytes commitments;        // threshold x 33 bytes
        bytes[] sealedShares;     // one per member of that epoch, in member order, 80 bytes each
    }

    function contentHash(Update calldata u) public pure returns (bytes32) { return keccak256(abi.encode(u)); }
    function updateDigest(bytes32 id, Update calldata u, uint64 deadline) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(),
            keccak256(abi.encode(UPDATE_TYPEHASH, id, u.expectPolicyRev, deadline, contentHash(u)))));
    }

    function update(bytes32 id, Update calldata u) external {
        address owner = _ownerFor(id);
        if (msg.sender != owner) revert NotOwner();
        _apply(id, owner, u);
    }

    /// gasless and passkey path: anyone submits; the pinned owner (or, at the first write, the ledger's owner) signed it
    function updateBySig(bytes32 id, Update calldata u, uint64 deadline, bytes calldata sig) external {
        if (block.timestamp > deadline) revert Expired();
        address owner = _ownerFor(id);
        if (!_isValidSig(owner, updateDigest(id, u, deadline), sig)) revert BadSignature();
        _apply(id, owner, u);
    }

    function _ownerFor(bytes32 id) private view returns (address) {
        Policy storage p = _policies[id];
        if (p.policyRev != 0) return p.owner;
        address o = beneficialOwnerOf(id);
        if (o == address(0)) revert NotOwner();
        return o;
    }

    function _apply(bytes32 id, address owner, Update calldata u) private {
        Policy storage p = _policies[id];
        if (u.expectPolicyRev != p.policyRev) revert StaleRevision(p.policyRev, u.expectPolicyRev);
        if (p.policyRev == 0) {
            // first write: it must establish a policy (a committee and rules) for anything to be releasable
            if (!u.setPolicy) revert BadRules();
            p.owner = owner;
        } else if (beneficialOwnerOf(id) != p.owner) {
            // the ledger moved the deployment: only claimPolicy (which destroys the bundle) may follow
            revert NotOwner();
        }
        if (u.putBundle && u.clearBundle) revert BadBundle();
        if (u.setPolicy) {
            if (_committees[u.committeeId].epoch == 0) revert BadCommittee();
            if (u.rules.length == 0 || u.rules.length > MAX_RULES) revert BadRules();
            // shares are sealed to ONE committee: changing it with a bundle in place needs a fresh bundle (or a clear)
            if (u.committeeId != p.committeeId && _bundles[id].ciphertext.length != 0 && !u.putBundle && !u.clearBundle) revert BadCommittee();
            p.committeeId = u.committeeId;
            p.paused = u.paused;
            p.rules = u.rules;
        }
        if (u.putBundle) _putBundle(id, p, u);
        if (u.clearBundle) {
            p.secretRev += 1;
            delete _bundles[id];
            emit BundleCleared(id, p.secretRev);
        }
        p.policyRev += 1;
        emit PolicyUpdated(id, p.owner, p.policyRev, p.committeeId, p.paused);
    }

    function _putBundle(bytes32 id, Policy storage p, Update calldata u) private {
        bytes32 cid = p.committeeId;
        Committee storage c = _committees[cid];
        if (c.epoch == 0 || u.epoch != c.epoch) revert BadCommittee();
        Epoch storage e = _epochs[cid][u.epoch];
        uint256 n = e.members.length;
        if (u.ciphertext.length == 0 || u.ciphertext.length > MAX_CIPHERTEXT) revert BadBundle();
        if (u.commitments.length != uint256(e.threshold) * POINT || u.sealedShares.length != n) revert BadBundle();
        uint64 rev = p.secretRev + 1;
        p.secretRev = rev;
        _bundles[id] = Bundle(u.epoch, u.ciphertext);
        ShareSet storage s = _shares[id][rev][u.epoch][0];
        s.commitments = u.commitments;
        for (uint256 i = 0; i < n; i++) {
            if (u.sealedShares[i].length != SEALED_SHARE) revert BadBundle();
            s.sealedBy[uint8(i)] = u.sealedShares[i];
        }
        s.posted = uint8(n);
        _c0[id][rev] = u.commitments[0:POINT];
        _activeSource[id][rev][u.epoch] = 0;
        _complete[id][rev][u.epoch] = true;
        emit BundlePut(id, rev, cid, u.epoch, u.ciphertext.length);
    }

    /// the ledger's current owner takes over a policy the ledger no longer gives the pinned owner. The bundle is destroyed:
    /// the new owner starts with no secrets, and the previous owner's never reach code the new owner controls.
    function claimPolicy(bytes32 id) external { _claim(id, msg.sender); }
    function claimPolicyBySig(bytes32 id, uint64 expectPolicyRev, uint64 deadline, bytes calldata sig) external {
        if (block.timestamp > deadline) revert Expired();
        Policy storage p = _policies[id];
        if (expectPolicyRev != p.policyRev) revert StaleRevision(p.policyRev, expectPolicyRev);
        address o = beneficialOwnerOf(id);
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", domainSeparator(), keccak256(abi.encode(CLAIM_TYPEHASH, id, expectPolicyRev, deadline))));
        if (!_isValidSig(o, d, sig)) revert BadSignature();
        _claim(id, o);
    }
    function _claim(bytes32 id, address claimant) private {
        Policy storage p = _policies[id];
        address o = beneficialOwnerOf(id);
        if (p.policyRev == 0 || o == p.owner) revert NothingToClaim();
        if (claimant != o) revert NotOwner();
        address prev = p.owner;
        p.owner = o;
        p.paused = true;               // nothing is releasable until the new owner sets its own policy
        p.secretRev += 1;
        p.policyRev += 1;
        delete _bundles[id];
        emit BundleCleared(id, p.secretRev);
        emit PolicyClaimed(id, prev, o, p.policyRev);
        emit PolicyUpdated(id, o, p.policyRev, p.committeeId, true);
    }

    function policyOf(bytes32 id) external view returns (address owner, uint64 policyRev, uint64 secretRev, bytes32 committeeId, bool paused, bytes memory rules) {
        Policy storage p = _policies[id];
        return (p.owner, p.policyRev, p.secretRev, p.committeeId, p.paused, p.rules);
    }
    function bundleOf(bytes32 id) external view returns (uint64 secretRev, uint32 epoch, bytes memory ciphertext) {
        Bundle storage b = _bundles[id];
        return (_policies[id].secretRev, b.epoch, b.ciphertext);
    }
    /// the completed share set of (id, secretRev, epoch): commitments and one sealed share per member of that epoch
    /// (`source` is the set's key: 0 for the owner's own split, else shareSetOf(source, commitments))
    function sharesOf(bytes32 id, uint64 secretRev, uint32 epoch) external view returns (bool complete, uint256 source, bytes memory commitments, bytes[] memory sealedShares) {
        complete = _complete[id][secretRev][epoch];
        source = _activeSource[id][secretRev][epoch];
        ShareSet storage s = _shares[id][secretRev][epoch][source];
        commitments = s.commitments;
        uint256 n = _epochs[_policies[id].committeeId][epoch].members.length;
        sealedShares = new bytes[](n);
        for (uint256 i = 0; i < n; i++) sealedShares[i] = s.sealedBy[uint8(i)];
    }

    // ================================================================= resharing (old epoch -> new epoch, same key)
    /// a reshare SOURCE names the old epoch and the old members whose deals were combined: (fromEpoch << 32) | bitmap.
    /// The owner's own split is source 0 (epochs start at 1, so no reshare source is 0).
    function sourceOf(uint32 fromEpoch, uint32 bitmap) public pure returns (uint256) { return (uint256(fromEpoch) << 32) | bitmap; }

    /// a member of the bundle's CURRENT share epoch posts its deal for a newer epoch of the same committee: sub-commitments
    /// and one HPKE-sealed sub-share per new member (custody/reshare.mjs). Once per member and target; the contract cannot
    /// check the cryptography, the new members do (and a deal that fails it is simply not used). Allowed while paused: a
    /// reshare releases nothing to any application.
    function postDeal(bytes32 id, uint32 toEpoch, bytes calldata deal) external {
        Policy storage p = _policies[id];
        Bundle storage b = _bundles[id];
        Committee storage c = _committees[p.committeeId];
        uint32 from = b.epoch;
        if (b.ciphertext.length == 0 || toEpoch <= from || toEpoch > c.epoch) revert BadReshare();
        if (deal.length == 0 || deal.length > 4096) revert BadReshare();
        uint256 idx = _memberIndex(_epochs[p.committeeId][from], msg.sender);
        uint64 rev = p.secretRev;
        uint256 bit = uint256(1) << idx;
        if (_dealBitmap[id][rev][from][toEpoch] & bit != 0) revert BadReshare();
        _dealBitmap[id][rev][from][toEpoch] |= bit;
        _deals[id][rev][from][toEpoch][uint8(idx)] = deal;
        emit DealPosted(id, rev, toEpoch, uint8(idx));
    }
    function dealsOf(bytes32 id, uint64 secretRev, uint32 fromEpoch, uint32 toEpoch) external view returns (uint256 bitmap, bytes[] memory deals) {
        bitmap = _dealBitmap[id][secretRev][fromEpoch][toEpoch];
        deals = new bytes[](MAX_MEMBERS);
        for (uint256 i = 0; i < MAX_MEMBERS; i++) if (bitmap & (uint256(1) << i) != 0) deals[i] = _deals[id][secretRev][fromEpoch][toEpoch][uint8(i)];
    }

    /// the share set a reshare post belongs to: its dealer SOURCE and the exact commitments it states. Keyed by both, so a
    /// member stating junk commitments opens a set of its own and can never squat a source the honest members need
    /// (review M1); the owner's own split is set 0.
    function shareSetOf(uint256 source, bytes calldata commitments) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(source, keccak256(commitments))));
    }

    /// a member of `toEpoch` posts its new share (sealed to its own key) computed from the deals named by `source` (exactly
    /// the old epoch's threshold of old members, all of whom posted deals), with the new commitments it derived, whose
    /// constant term must be the bundle's own C0 (the same secret). When the new epoch's threshold of members have posted
    /// the SAME (source, commitments), the bundle moves to `toEpoch`. A member may still post into the completed set
    /// afterwards (so every new member ends up holding a share), never into another.
    function postReshare(bytes32 id, uint32 toEpoch, uint256 source, bytes calldata commitments, bytes calldata sealedShare) external {
        Policy storage p = _policies[id];
        Bundle storage b = _bundles[id];
        uint64 rev = p.secretRev;
        uint32 from = uint32(source >> 32);
        uint256 bitmap = source & 0xffffffff;
        if (b.ciphertext.length == 0 || source >> 64 != 0) revert BadReshare();
        uint256 set = shareSetOf(source, commitments);
        if (_complete[id][rev][toEpoch]) { if (set != _activeSource[id][rev][toEpoch]) revert BadReshare(); }
        else if (from != b.epoch || toEpoch <= from) revert BadReshare();
        Epoch storage oldE = _epochs[p.committeeId][from];
        if (bitmap == 0 || bitmap & _dealBitmap[id][rev][from][toEpoch] != bitmap || _popcount(bitmap) != oldE.threshold) revert BadReshare();
        Epoch storage newE = _epochs[p.committeeId][toEpoch];
        if (newE.members.length == 0 || commitments.length != uint256(newE.threshold) * POINT || sealedShare.length != SEALED_SHARE) revert BadReshare();
        if (keccak256(commitments[0:POINT]) != keccak256(_c0[id][rev])) revert BadReshare();
        uint8 idx = uint8(_memberIndex(newE, msg.sender));
        ShareSet storage s = _shares[id][rev][toEpoch][set];
        if (s.sealedBy[idx].length != 0) revert BadReshare();
        if (s.posted == 0) s.commitments = commitments;
        s.sealedBy[idx] = sealedShare;
        s.posted += 1;
        emit ResharePosted(id, rev, toEpoch, source, idx);
        if (s.posted >= newE.threshold && !_complete[id][rev][toEpoch]) {
            _complete[id][rev][toEpoch] = true;
            _activeSource[id][rev][toEpoch] = set;
            b.epoch = toEpoch;
            emit ReshareComplete(id, rev, toEpoch, source);
        }
    }
    /// a reshare in progress, by its share set (shareSetOf), to read the posts before the threshold is reached
    function resharePostsOf(bytes32 id, uint64 secretRev, uint32 toEpoch, uint256 set) external view returns (uint8 posted, bytes memory commitments, bytes[] memory sealedShares) {
        ShareSet storage s = _shares[id][secretRev][toEpoch][set];
        uint256 n = _epochs[_policies[id].committeeId][toEpoch].members.length;
        sealedShares = new bytes[](n);
        for (uint256 i = 0; i < n; i++) sealedShares[i] = s.sealedBy[uint8(i)];
        return (s.posted, s.commitments, sealedShares);
    }
}
