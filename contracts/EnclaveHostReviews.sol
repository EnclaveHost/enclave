// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title EnclaveHostReviews — 1-5 star ratings for the enclaves that RUN apps.
/// @notice The seller-side counterpart to EnclaveReviews. That contract rates
///         catalog apps; this one rates the HOSTS — the boxes in
///         EnclaveRegistry that claim deployments and serve them. As the fleet
///         opens to permissionless sellers, buyers need a reputation signal
///         attached to the operator, not just to the software.
///
/// The subject is the registry id:
///         `enclaveId` is keccak256(the endpoint the enclave registered), which
///         is exactly what EnclaveDeployments stores as a lease's `runner`. So
///         the receipt below is a direct field comparison — no name lookup, no
///         second contract to trust, nothing the caller can steer.
///
/// Who may rate — a RECEIPT, like app reviews:
///         rating `enclaveId` requires naming one of YOUR EnclaveDeployments
///         records that (a) you own, (b) names that enclave as its runner, and
///         (c) was actually funded. Creating a deployment costs only gas, so
///         the funding test is what makes sybil praise expensive: to stuff a
///         host's rating you must buy runtime that the host is paid for.
///
///         This means ratings come from people whose app that box actually
///         ran — not from competitors, and not from passers-by.
///
/// The lease moves; the experience doesn't:
///         `runner` names the CURRENT lease holder, so a receipt is only
///         provable while your deployment sits on that box. First post
///         therefore needs a live receipt — but EDITS never re-prove. Once
///         you've earned your say about a host you keep it, and can revise it
///         later, even after your app has moved on. (The alternative — losing
///         your review the moment a lease lapses — would quietly erase the
///         reviews of anyone whose app outlived one box.)
///
/// One rating per wallet per enclave, editable:
///         a second post() from the same wallet REPLACES the first and moves
///         the tally with it, rather than stacking. Editing keeps the original
///         createdAt.
///
/// Moderation — takedown only, never rewriting:
///         the owner can hide a review (illegal/abusive content). A hidden
///         review keeps its bytes on-chain but drops out of the tally, and
///         STAYS hidden through an edit. The owner cannot change a rating,
///         post as someone else, or delete anything.
///
/// Reading:
///         `talliesOf` answers a whole fleet panel in one eth_call (count + sum
///         per enclave; the average is the reader's division — no rounding is
///         baked in). `getReviewsPage` pages one host's reviews in storage
///         order, hidden ones included and flagged, so the moderation view and
///         the public view come from the same call.
interface IEnclaveAddressBook {
    function addr(bytes32 key) external view returns (address);
}

interface IEnclaveDeployments {
    /// EnclaveDeployments.Deployment, schema rev >= 2. Appended fields in a
    /// future rev stay compatible: a dynamic tuple's offsets are relative to
    /// its own head, so decoding a prefix is sound. A rev-1 ledger (extra
    /// sshPubKey string) is NOT readable here and simply proves nothing.
    struct Deployment {
        bytes32 id;
        address owner;
        string  appRef;
        string  ports;
        string  configCid;
        uint16  gpuMilli;
        uint16  cpuMilli;
        uint32  appPort;
        bool    isPublic;
        bool    active;
        uint64  createdAt;
        uint256 rate;
        uint256 balance6;
        uint256 spent6;
        bytes32 runner;
        address runnerOperator;
        uint64  leaseUntil;
    }
    function get(bytes32 id) external view returns (Deployment memory);
}

contract EnclaveHostReviews {
    struct Review {
        address reviewer;    // wallet that posted it (one review per wallet per enclave)
        uint8   stars;       // 1..5
        bool    hidden;      // owner takedown: out of the tally, still on-chain
        uint64  createdAt;   // first post (survives edits)
        uint64  updatedAt;   // last edit
        bytes32 deployment;  // the funded deployment this host ran for the reviewer
        string  body;        // the comment ("" = a bare rating)
    }

    /// @notice Struct-schema revision, for readers: 1 = this layout.
    uint256 public constant hostReviewsSchema = 1;
    /// @notice Comment ceiling in bytes (matches EnclaveReviews).
    uint256 public constant MAX_BODY = 2000;

    address public owner;         // moderation (hide/unhide) only
    address public pendingOwner;  // two-step handoff: must acceptOwnership()

    /// @notice The platform root (EnclaveAddressBook). The ledger whose records
    ///         prove a host ran your app is resolved THROUGH it on every call,
    ///         so a ledger redeploy reaches this contract with one `set` on the
    ///         book — no transaction here, no drift to notice.
    IEnclaveAddressBook public immutable book;
    bytes32 public constant LEDGER_KEY = "deployments";   // ascii, right-padded — the book's derivation

    /// @notice Fallback ledger, used only when the book can't answer (no book
    ///         at all — a local or testnet deploy — or the key retired to
    ///         zero). Owner-settable so that case stays recoverable.
    address public ledgerFallback;

    struct Tally { uint32 count; uint32 sum; }   // visible reviews only; sum <= 5 * count

    mapping(bytes32 => Review[]) private _reviews;                  // enclaveId -> reviews, storage order
    mapping(bytes32 => mapping(address => uint256)) private _idx1;  // enclaveId -> reviewer -> index + 1 (0 = none)
    mapping(bytes32 => Tally) private _tally;                       // enclaveId -> visible count/sum

    event ReviewPosted(bytes32 indexed enclaveId, address indexed reviewer, uint8 stars, bytes32 deployment);
    event ReviewUpdated(bytes32 indexed enclaveId, address indexed reviewer, uint8 stars);
    event ReviewHidden(bytes32 indexed enclaveId, address indexed reviewer, bool hidden);
    event LedgerFallbackSet(address indexed ledger);
    event OwnerChanged(address indexed owner);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);

    /// @param _book           EnclaveAddressBook, the platform root (0 = none;
    ///                        then the fallback is the only ledger).
    /// @param _ledgerFallback EnclaveDeployments to use when the book can't answer.
    constructor(address _book, address _ledgerFallback) {
        require(_book != address(0) || _ledgerFallback != address(0), "no ledger source");
        owner = msg.sender;
        book = IEnclaveAddressBook(_book);
        ledgerFallback = _ledgerFallback;
        emit LedgerFallbackSet(_ledgerFallback);
        emit OwnerChanged(msg.sender);
    }

    /// @notice The EnclaveDeployments ledger this contract checks receipts
    ///         against right now. Reads never revert — an unresolvable ledger
    ///         is address(0), which _proved treats as "proves nothing".
    function ledger() public view returns (address) {
        if (address(book) != address(0)) {
            try book.addr(LEDGER_KEY) returns (address a) { if (a != address(0)) return a; } catch {}
        }
        return ledgerFallback;
    }

    /* ---- write ---- */

    /// @notice Rate `enclaveId` 1..5 with an optional comment, proving that box
    ///         ran `deploymentId` for you. Posting again replaces your review
    ///         (and moves the tally with it); a hidden review stays hidden
    ///         through the edit. An edit does NOT need a fresh receipt — see
    ///         the header: the lease moves, the experience doesn't.
    function post(bytes32 enclaveId, bytes32 deploymentId, uint8 stars, string calldata body) external {
        require(enclaveId != bytes32(0), "zero enclave");
        require(stars >= 1 && stars <= 5, "stars 1..5");
        require(bytes(body).length <= MAX_BODY, "body too long");

        uint256 i1 = _idx1[enclaveId][msg.sender];
        Tally storage t = _tally[enclaveId];
        if (i1 == 0) {
            require(_proved(enclaveId, deploymentId, msg.sender), "no funded deployment run by this enclave");
            _reviews[enclaveId].push(Review({
                reviewer: msg.sender, stars: stars, hidden: false,
                createdAt: uint64(block.timestamp), updatedAt: uint64(block.timestamp),
                deployment: deploymentId, body: body
            }));
            _idx1[enclaveId][msg.sender] = _reviews[enclaveId].length;
            t.count += 1;
            t.sum += stars;
            emit ReviewPosted(enclaveId, msg.sender, stars, deploymentId);
        } else {
            Review storage r = _reviews[enclaveId][i1 - 1];
            if (!r.hidden) t.sum = t.sum - r.stars + stars;   // hidden reviews are outside the tally
            r.stars = stars;
            r.body = body;
            // keep the ORIGINAL receipt: it is the record of what earned the
            // say. A caller may pass bytes32(0) on an edit (nothing to prove),
            // and a fresh receipt only replaces it when it genuinely proves.
            if (deploymentId != bytes32(0) && _proved(enclaveId, deploymentId, msg.sender)) r.deployment = deploymentId;
            r.updatedAt = uint64(block.timestamp);
            emit ReviewUpdated(enclaveId, msg.sender, stars);
        }
    }

    /// @notice Owner moderation: take a review out of the tally (or put it
    ///         back). The text stays on-chain — this hides it from readers, it
    ///         does not rewrite the record.
    function setHidden(bytes32 enclaveId, address reviewer, bool hidden) external {
        require(msg.sender == owner, "!owner");
        uint256 i1 = _idx1[enclaveId][reviewer];
        require(i1 != 0, "no review");
        Review storage r = _reviews[enclaveId][i1 - 1];
        if (r.hidden == hidden) return;
        r.hidden = hidden;
        Tally storage t = _tally[enclaveId];
        if (hidden) { t.count -= 1; t.sum -= r.stars; }
        else        { t.count += 1; t.sum += r.stars; }
        emit ReviewHidden(enclaveId, reviewer, hidden);
    }

    /* ---- the receipt ---- */

    /// @notice Would `who` be allowed to rate `enclaveId` with `deploymentId`?
    ///         The UI asks before it puts a wallet through a signature. Note a
    ///         wallet that ALREADY has a review may always edit it, receipt or
    ///         not — `hasReviewed` answers that half.
    function canReview(bytes32 enclaveId, bytes32 deploymentId, address who) external view returns (bool) {
        return _idx1[enclaveId][who] != 0 || _proved(enclaveId, deploymentId, who);
    }

    /// @notice Has this wallet already rated this enclave? (Then edits need no receipt.)
    function hasReviewed(bytes32 enclaveId, address who) external view returns (bool) {
        return _idx1[enclaveId][who] != 0;
    }

    /// @dev The deployment must be theirs, name THIS enclave as its runner, and
    ///      have been funded (balance + spent — a released lease refunds into
    ///      balance, so either side alone would miss real customers).
    ///      Fail-closed either way: a reverting or non-existent record returns
    ///      false, and a reply this contract can't decode (the ledger pointer
    ///      aimed at something that isn't a rev-2+ ledger) reverts the whole
    ///      call — neither path can mint a review.
    function _proved(bytes32 enclaveId, bytes32 deploymentId, address who) private view returns (bool) {
        if (deploymentId == bytes32(0) || who == address(0)) return false;
        address l = ledger();
        if (l == address(0)) return false;
        try IEnclaveDeployments(l).get(deploymentId) returns (IEnclaveDeployments.Deployment memory d) {
            if (d.owner != who) return false;
            if (d.balance6 + d.spent6 == 0) return false;
            return d.runner == enclaveId && enclaveId != bytes32(0);
        } catch {
            return false;
        }
    }

    /* ---- reads ---- */

    function reviewCount(bytes32 enclaveId) external view returns (uint256) { return _reviews[enclaveId].length; }

    /// @notice One host's reviews in storage order. Hidden ones are INCLUDED
    ///         and flagged: readers drop them, the owner's console lists them
    ///         to unhide, and both come from this one call.
    function getReviewsPage(bytes32 enclaveId, uint256 start, uint256 n) external view returns (Review[] memory page) {
        Review[] storage rs = _reviews[enclaveId];
        uint256 total = rs.length;
        if (start >= total) return new Review[](0);
        uint256 end = start + n; if (end > total) end = total;
        page = new Review[](end - start);
        for (uint256 i = start; i < end; i++) page[i - start] = rs[i];
    }

    /// @notice A wallet's review of a host (reviewer == address(0) = none).
    function getReview(bytes32 enclaveId, address reviewer) external view returns (Review memory) {
        uint256 i1 = _idx1[enclaveId][reviewer];
        if (i1 == 0) return Review(address(0), 0, false, 0, 0, bytes32(0), "");
        return _reviews[enclaveId][i1 - 1];
    }

    /// @notice Visible count + star sum. The average is count == 0 ? none :
    ///         sum / count — left to the reader so no rounding is baked in.
    function tallyOf(bytes32 enclaveId) external view returns (uint32 count, uint32 sum) {
        Tally storage t = _tally[enclaveId];
        return (t.count, t.sum);
    }

    /// @notice The fleet panel's call: every box's rating in one round trip.
    function talliesOf(bytes32[] calldata enclaveIds) external view returns (uint32[] memory counts, uint32[] memory sums) {
        counts = new uint32[](enclaveIds.length);
        sums = new uint32[](enclaveIds.length);
        for (uint256 i = 0; i < enclaveIds.length; i++) {
            Tally storage t = _tally[enclaveIds[i]];
            counts[i] = t.count;
            sums[i] = t.sum;
        }
    }

    /* ---- admin ---- */

    /// @notice Set the fallback ledger. Normally dead weight — with a book
    ///         configured, `ledger()` follows it and this is never consulted.
    function setLedgerFallback(address _ledger) external {
        require(msg.sender == owner, "!owner");
        ledgerFallback = _ledger;
        emit LedgerFallbackSet(_ledger);
    }
    function transferOwnership(address newOwner) external {
        require(msg.sender == owner, "!owner");
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }
    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "!pendingOwner");
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnerChanged(owner);
    }
}
