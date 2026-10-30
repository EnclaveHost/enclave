// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/// @title EnclaveHostLifecycleRegistry - discovery registry whose `active` bit is a fenced host lifecycle.
/// @notice A NEW registry, staged beside the deployed EnclaveRegistry/EnclaveHostOwnership (both untouched).
///         It keeps the schema-5 `Enclave` tuple for get/getPage, but `active` is no longer an operator-set flag:
///         it is derived from this contract's own lifecycle state, and only two writers can change that state:
///
///   - ONLINE: registerQualifiedHost / recoverQualifiedHost. Each atomically verifies operator + owner consent, a
///     payer-funded sponsor reservation, and a qualification receipt signed by a quorum of an IMMUTABLE trust anchor
///     the payer chose and the owner bound. Then it installs row + owner + revision + reporters + budget + generation.
///     Any failure reverts the whole call, so no half-enrolled active row exists.
///   - OFFLINE: recordHostOffline (enrolled EOA reporter quorum) and deactivateHost (stored operator or accepted
///     owner as msg.sender). Both read ONLY local storage and use the ecrecover precompile. They make no other
///     external call: no ownership lookup, ERC1271, oracle, token or payee. The transition is written first, and
///     the reimbursement that follows is clamped arithmetic that cannot revert.
///
/// There is no admin, owner, pauser or platform verifier. Nobody can ban or deactivate a foreign-owned host except
/// that host's operator, accepted owner, or the reporter quorum its accepted owner installed.
/// Legacy register/registerRelay/heartbeat/deregister/setMeasurement selectors are deliberately ABSENT.
contract EnclaveHostLifecycleRegistry {
    // ------------------------------------------------------------------ legacy row (schema-5 tuple, unchanged)
    struct Enclave {
        string  endpoint;
        string  repo;
        bytes32 measurement;
        address operator;
        uint64  registeredAt;
        uint64  lastSeen;         // last lifecycle transition (enroll/recover/offline); heartbeats are off chain
        bool    active;           // DERIVED on read from hostState.status; the stored copy is never written
        uint64  cpuPricePerSec6;
        uint64  gpuPricePerSec6;
        address proofKey;
        address payoutWallet;
        uint64  caps;
        string  region;
    }

    // ------------------------------------------------------------------ intents and evidence
    struct Listing {
        string  endpoint;
        string  repo;
        bytes32 measurement;
        uint64  cpuPricePerSec6;
        uint64  gpuPricePerSec6;
        address proofKey;
        uint64  caps;
        string  region;
    }

    /// @dev Strictly ascending EOA keys. Empty only while the host is not Online.
    struct ReporterPolicy {
        address[] reporters;
        uint8     threshold;
    }

    struct Enrollment {
        Listing listing;            // signed as listingDigest = hashListing(listing)
        address operator;
        address owner;
        bytes32 ownerPolicyHash;
        bytes32 hardwareId;
        bytes32 attestationDigest;
        bytes32 resourceDigest;
        bytes32 trustAnchorId;
        bytes32 reporterPolicyHash;
        bytes32 reservationId;
        uint128 protectedAmount;
        uint256 nonce;
        uint64  deadline;
    }

    struct Recovery {
        bytes32 hostId;
        uint64  priorGeneration;
        bytes32 priorOfflineDigest;
        uint64  authorityRevision;
        address operator;           // may differ from the stored operator: that is operator rotation
        address owner;              // must be the accepted owner
        string  repo;
        bytes32 measurement;
        address proofKey;
        bytes32 hardwareId;
        bytes32 attestationDigest;
        bytes32 resourceDigest;
        bytes32 trustAnchorId;
        bytes32 reservationId;      // 0 = no new funds; then trustAnchorId must equal the payer-authorized anchor
        uint128 protectedAmount;
        uint256 nonce;
        uint64  deadline;
    }

    /// @dev Signed ONLY on success by verifiers of `trustAnchorId`. There is no `passed` flag to set.
    struct QualificationReceipt {
        bytes32 trustAnchorId;
        bytes32 hostId;
        bytes32 hardwareId;
        bytes32 descriptorDigest;
        bytes32 attestationDigest;
        bytes32 resourceDigest;
        bytes32 testDigest;         // measured test implementation/version/work nonce/result digest; nonzero
        bytes32 intentDigest;       // exact EIP-712 digest of the Enrollment/Recovery that consumes it
        uint64  generation;
        uint64  issuedAt;
        uint64  expiresAt;
    }

    struct HostOffline {
        bytes32 hostId;
        uint64  generation;
        address operator;
        uint64  authorityRevision;
        uint8   targetStatus;       // must be STATUS_OFFLINE
        bytes32 evidenceDigest;
        uint64  deadline;
        address payee;              // 0 = no reimbursement
        uint128 maxCharge;
    }

    struct SponsorReservation {
        bytes32 hostId;
        bytes32 hardwareId;
        bytes32 jobId;
        address payer;
        bytes32 trustAnchorId;
        uint8   source;             // SOURCE_PAID_WORK_HOST or SOURCE_STRIPE_FALLBACK
        bytes32 sourceEvidence;     // paid-work host receipt digest, or verified-absence digest for the fallback
        uint128 protectedAmount;
        uint128 listingGasCap;
        uint128 perTransitionCap;
        uint128 l1FeeAllowance;    // signed ceiling only; inactive until an independently qualified fee mechanism exists
        uint64  maxGasPrice;
        address submitter;          // 0 = any submitter may consume and be reimbursed
        uint256 nonce;
        uint64  deadline;
    }

    // ------------------------------------------------------------------ stored state
    struct Authority {
        address owner;
        address pendingOwner;
        uint64  revision;
        bytes32 policyHash;
    }

    struct HostState {
        uint64  generation;
        uint8   status;
        uint64  changedAt;
        uint64  qualificationExpiry;   // historical evidence of the accepted listing; never renewed on chain
        bytes32 hardwareId;
        bytes32 descriptorDigest;
        bytes32 qualificationDigest;
        bytes32 resourceDigest;
        bytes32 trustAnchorId;
        bytes32 lastOfflineDigest;
    }

    struct Reporters {
        address[] keys;
        uint8     threshold;
        uint64    revision;
    }

    struct Budget {
        address payer;
        uint128 balance;
        uint128 protectedReserve;
        uint128 perTransitionCap;
        uint128 l1FeeAllowance;    // signed ceiling only; inactive until an independently qualified fee mechanism exists
        uint64  maxGasPrice;
    }

    struct Reservation {
        address payer;
        uint8   status;
        uint64  deadline;
        address submitter;
        uint64  maxGasPrice;
        bytes32 hostId;
        bytes32 hardwareId;
        bytes32 jobId;
        bytes32 trustAnchorId;
        uint128 protectedAmount;
        uint128 listingGasCap;
        uint128 perTransitionCap;
        uint128 l1FeeAllowance;    // signed ceiling only; inactive until an independently qualified fee mechanism exists
    }

    struct TrustAnchor {
        address[] verifiers;
        uint8     threshold;
        uint32    version;
        uint64    maxReceiptAge;
        bytes32   metadataDigest;
        address   publisher;
    }

    // ------------------------------------------------------------------ constants
    uint256 public constant registrySchema = 5;                 // tuple shape for decoders: unchanged schema-5 row
    uint256 public constant hostLifecycleSchema = 1;            // consumers must require == 1, never >=
    bytes32 public constant registryFeature = keccak256("EnclaveHostLifecycleRegistry/feature/1");

    uint64 public constant CAP_HOST       = 1 << 0;
    uint64 public constant CAP_APP_SNI    = 1 << 1;
    uint64 public constant CAP_TCP_PORTS  = 1 << 2;
    uint64 public constant CAP_UDP        = 1 << 3;
    uint64 public constant CAP_TUNNEL_HUB = 1 << 4;
    uint64 public constant CAP_RELAY_ANY  = CAP_APP_SNI | CAP_TCP_PORTS | CAP_UDP | CAP_TUNNEL_HUB;

    uint8 public constant STATUS_NONE = 0;
    uint8 public constant STATUS_ONLINE = 1;
    uint8 public constant STATUS_OFFLINE = 2;

    uint8 public constant RES_RESERVED = 1;
    uint8 public constant RES_CONSUMED = 2;
    uint8 public constant RES_CANCELLED = 3;

    uint8 public constant SOURCE_PAID_WORK_HOST = 1;
    uint8 public constant SOURCE_STRIPE_FALLBACK = 2;

    uint256 public constant MAX_REPORTERS = 16;
    uint256 public constant MAX_VERIFIERS = 16;
    uint256 public constant MAX_ENDPOINT = 256;
    uint256 public constant MAX_REPO = 128;
    uint256 public constant MAX_REGION = 64;
    uint64  public constant MAX_RECEIPT_AGE = 30 days;
    /// @dev Flat estimate of intrinsic + calldata gas not visible to gasleft(). Bounded by payer caps anyway.
    uint256 public constant OFFLINE_GAS_OVERHEAD = 40_000;
    uint256 public constant LISTING_GAS_OVERHEAD = 90_000;

    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;
    uint256 internal constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant LISTING_TYPEHASH = keccak256(
        "Listing(string endpoint,string repo,bytes32 measurement,uint64 cpuPricePerSec6,uint64 gpuPricePerSec6,"
        "address proofKey,uint64 caps,string region)");
    bytes32 public constant REPORTER_POLICY_TYPEHASH = keccak256("ReporterPolicy(address[] reporters,uint8 threshold)");
    bytes32 public constant ENROLLMENT_TYPEHASH = keccak256(
        "Enrollment(bytes32 listingDigest,address operator,address owner,bytes32 ownerPolicyHash,bytes32 hardwareId,"
        "bytes32 attestationDigest,bytes32 resourceDigest,bytes32 trustAnchorId,bytes32 reporterPolicyHash,"
        "bytes32 reservationId,uint128 protectedAmount,uint256 nonce,uint64 deadline)");
    bytes32 public constant RECOVERY_TYPEHASH = keccak256(
        "Recovery(bytes32 hostId,uint64 priorGeneration,bytes32 priorOfflineDigest,uint64 authorityRevision,"
        "address operator,address owner,string repo,bytes32 measurement,address proofKey,bytes32 hardwareId,"
        "bytes32 attestationDigest,bytes32 resourceDigest,bytes32 trustAnchorId,bytes32 reservationId,"
        "uint128 protectedAmount,uint256 nonce,uint64 deadline)");
    bytes32 public constant QUALIFICATION_TYPEHASH = keccak256(
        "QualificationPassed(bytes32 trustAnchorId,bytes32 hostId,bytes32 hardwareId,bytes32 descriptorDigest,"
        "bytes32 attestationDigest,bytes32 resourceDigest,bytes32 testDigest,bytes32 intentDigest,uint64 generation,"
        "uint64 issuedAt,uint64 expiresAt)");
    bytes32 public constant OFFLINE_TYPEHASH = keccak256(
        "HostOffline(bytes32 hostId,uint64 generation,address operator,uint64 authorityRevision,uint8 targetStatus,"
        "bytes32 evidenceDigest,uint64 deadline,address payee,uint128 maxCharge)");
    bytes32 public constant RESERVATION_TYPEHASH = keccak256(
        "SponsorReservation(bytes32 hostId,bytes32 hardwareId,bytes32 jobId,address payer,bytes32 trustAnchorId,"
        "uint8 source,bytes32 sourceEvidence,uint128 protectedAmount,uint128 listingGasCap,uint128 perTransitionCap,"
        "uint128 l1FeeAllowance,uint64 maxGasPrice,address submitter,uint256 nonce,uint64 deadline)");

    // ------------------------------------------------------------------ storage
    bytes32[] private _ids;
    mapping(bytes32 => Enclave) private _rows;
    mapping(bytes32 => Authority) public authority;
    mapping(bytes32 => HostState) public hostState;
    mapping(bytes32 => Reporters) private _reporters;
    mapping(bytes32 => Budget) public hostBudget;
    mapping(bytes32 => TrustAnchor) private _anchors;
    mapping(bytes32 => Reservation) public reservations;
    mapping(bytes32 => bytes32) public hardwareReservation;   // bootstrap hardware id -> reservation (live or consumed)
    mapping(bytes32 => bytes32) public jobReservation;        // sponsor job id -> reservation (live or consumed)
    mapping(bytes32 => bytes32) public hardwareHost;          // hardware id -> host it was qualified for
    mapping(bytes32 => bool) public usedDigest;               // consumed enrollment/recovery/receipt digests
    mapping(address => uint256) public sponsorFunds;          // payer-entitled, unreserved
    mapping(address => uint256) public credits;               // pull reimbursements, always fully backed

    // ------------------------------------------------------------------ errors
    error HostExists();
    error UnknownHost();
    error NotAuthorized();
    error Expired();
    error Replay();
    error BadConsent();
    error Quorum();
    error BadPolicy();
    error BadListing();
    error BadReservation();
    error ReceiptMismatch();
    error StaleReceipt();
    error NotIndependent();
    error UnknownAnchor();
    error NotOnline();
    error NotOffline();
    error IntentMismatch();
    error Insufficient();
    error Duplicate();
    error TransferFailed();
    error BadBudget();

    // ------------------------------------------------------------------ events
    event Registered(bytes32 indexed id, address indexed operator, string endpoint, string repo);
    event Updated(bytes32 indexed id, string repo, bytes32 measurement);
    event PricesSet(bytes32 indexed id, uint64 cpuPricePerSec6, uint64 gpuPricePerSec6);
    event ProofKeySet(bytes32 indexed id, address indexed proofKey);
    event PayoutWalletSet(bytes32 indexed id, address indexed payoutWallet);
    event CapsSet(bytes32 indexed id, uint64 caps, string region);
    event Deregistered(bytes32 indexed id);
    event HostOnline(bytes32 indexed id, uint64 generation, address indexed operator, uint64 revision,
                     bytes32 qualificationDigest);
    event HostMarkedOffline(bytes32 indexed id, uint64 generation, bytes32 offlineDigest, bytes32 evidenceDigest,
                            address indexed submitter);
    event OfflineReimbursed(bytes32 indexed id, uint64 generation, address indexed payee, uint256 amount);
    event OwnerProposed(bytes32 indexed id, address indexed owner);
    event OwnerAccepted(bytes32 indexed id, address indexed owner, uint64 revision);
    event PolicySet(bytes32 indexed id, uint64 revision, bytes32 policyHash, bytes32 reporterPolicyHash);
    event TrustAnchorPublished(bytes32 indexed anchorId, address indexed publisher, uint32 version);
    event BootstrapReserved(bytes32 indexed reservationId, bytes32 indexed hostId, address indexed payer, uint8 source);
    event ReservationCancelled(bytes32 indexed reservationId);
    event ListingGasReleased(bytes32 indexed reservationId, address indexed submitter, uint256 paid, uint256 returned);
    event BudgetFunded(bytes32 indexed id, address indexed payer, uint256 amount);
    event BudgetReleased(bytes32 indexed id, address indexed payer, uint256 amount);
    event SponsorFunds(address indexed payer, int256 delta);
    event ReimbursementClaimed(address indexed payee, address to, uint256 amount);

    // ================================================================== reads (legacy-compatible)
    function idOf(string calldata endpoint) external pure returns (bytes32) { return keccak256(bytes(endpoint)); }
    function count() external view returns (uint256) { return _ids.length; }
    function idAt(uint256 i) external view returns (bytes32) { return _ids[i]; }

    /// @notice Schema-5 row; `active` is true iff the canonical lifecycle state is Online.
    function get(bytes32 id) public view returns (Enclave memory e) {
        e = _rows[id];
        e.active = hostState[id].status == STATUS_ONLINE;
    }

    function getPage(uint256 start, uint256 n) external view returns (Enclave[] memory page) {
        uint256 len = _ids.length;
        if (start >= len) return new Enclave[](0);
        uint256 end = n > len - start ? len : start + n;
        page = new Enclave[](end - start);
        for (uint256 i = start; i < end; ++i) page[i - start] = get(_ids[i]);
    }

    function reporterPolicy(bytes32 id) external view returns (address[] memory keys, uint8 threshold, uint64 revision) {
        Reporters storage r = _reporters[id];
        return (r.keys, r.threshold, r.revision);
    }

    function trustAnchor(bytes32 anchorId) external view returns (TrustAnchor memory) { return _anchors[anchorId]; }

    // ================================================================== EIP-712 hashing (pure functions of input)
    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("EnclaveHostLifecycleRegistry"), keccak256("1"),
                                    block.chainid, address(this)));
    }

    function _typed(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function descriptorOf(string calldata repo, bytes32 measurement) public pure returns (bytes32) {
        return keccak256(abi.encode(keccak256(bytes(repo)), measurement));
    }

    function hashListing(Listing calldata l) public pure returns (bytes32) {
        return keccak256(abi.encode(LISTING_TYPEHASH, keccak256(bytes(l.endpoint)), keccak256(bytes(l.repo)),
            l.measurement, l.cpuPricePerSec6, l.gpuPricePerSec6, l.proofKey, l.caps, keccak256(bytes(l.region))));
    }

    function hashReporterPolicy(ReporterPolicy calldata p) public pure returns (bytes32) {
        return keccak256(abi.encode(REPORTER_POLICY_TYPEHASH, keccak256(abi.encodePacked(p.reporters)), p.threshold));
    }

    function hashEnrollment(Enrollment calldata e) public view returns (bytes32) {
        return _typed(keccak256(bytes.concat(
            abi.encode(ENROLLMENT_TYPEHASH, hashListing(e.listing), e.operator, e.owner, e.ownerPolicyHash,
                       e.hardwareId, e.attestationDigest),
            abi.encode(e.resourceDigest, e.trustAnchorId, e.reporterPolicyHash, e.reservationId, e.protectedAmount,
                       e.nonce, e.deadline))));
    }

    function hashRecovery(Recovery calldata v) public view returns (bytes32) {
        return _typed(keccak256(bytes.concat(
            abi.encode(RECOVERY_TYPEHASH, v.hostId, v.priorGeneration, v.priorOfflineDigest, v.authorityRevision,
                       v.operator, v.owner, keccak256(bytes(v.repo)), v.measurement),
            abi.encode(v.proofKey, v.hardwareId, v.attestationDigest, v.resourceDigest, v.trustAnchorId,
                       v.reservationId, v.protectedAmount, v.nonce, v.deadline))));
    }

    function hashReceipt(QualificationReceipt calldata q) public view returns (bytes32) {
        return _typed(keccak256(bytes.concat(
            abi.encode(QUALIFICATION_TYPEHASH, q.trustAnchorId, q.hostId, q.hardwareId, q.descriptorDigest,
                       q.attestationDigest),
            abi.encode(q.resourceDigest, q.testDigest, q.intentDigest, q.generation, q.issuedAt, q.expiresAt))));
    }

    function hashOffline(HostOffline calldata o) public view returns (bytes32) {
        return _typed(keccak256(abi.encode(OFFLINE_TYPEHASH, o.hostId, o.generation, o.operator, o.authorityRevision,
            o.targetStatus, o.evidenceDigest, o.deadline, o.payee, o.maxCharge)));
    }

    function hashReservation(SponsorReservation calldata s) public view returns (bytes32) {
        return _typed(keccak256(bytes.concat(
            abi.encode(RESERVATION_TYPEHASH, s.hostId, s.hardwareId, s.jobId, s.payer, s.trustAnchorId, s.source,
                       s.sourceEvidence),
            abi.encode(s.protectedAmount, s.listingGasCap, s.perTransitionCap, s.l1FeeAllowance, s.maxGasPrice,
                       s.submitter, s.nonce, s.deadline))));
    }

    // ================================================================== trust anchors (immutable, versioned)
    /// @notice Anyone may publish; an anchor has no power until a payer names it in a signed reservation AND the
    ///         owner binds it in the enrollment intent. There is no setter: a new version is a new anchorId.
    function publishTrustAnchor(address[] calldata verifiers, uint8 threshold, uint32 version, uint64 maxReceiptAge,
                                bytes32 metadataDigest) external returns (bytes32 anchorId)
    {
        uint256 n = verifiers.length;
        if (n == 0 || n > MAX_VERIFIERS || threshold == 0 || threshold > n) revert BadPolicy();
        if (maxReceiptAge == 0 || maxReceiptAge > MAX_RECEIPT_AGE) revert BadPolicy();
        _requireAscending(verifiers);
        anchorId = keccak256(abi.encode(block.chainid, address(this), msg.sender, keccak256(abi.encodePacked(verifiers)),
                                        threshold, version, maxReceiptAge, metadataDigest));
        TrustAnchor storage t = _anchors[anchorId];
        if (t.threshold != 0) revert Duplicate();
        t.verifiers = verifiers;
        t.threshold = threshold;
        t.version = version;
        t.maxReceiptAge = maxReceiptAge;
        t.metadataDigest = metadataDigest;
        t.publisher = msg.sender;
        emit TrustAnchorPublished(anchorId, msg.sender, version);
    }

    // ================================================================== sponsor funds and reservations
    function depositSponsorFunds() external payable {
        sponsorFunds[msg.sender] += msg.value;
        emit SponsorFunds(msg.sender, int256(msg.value));
    }

    function withdrawSponsorFunds(uint256 amount, address payable to) external {
        uint256 bal = sponsorFunds[msg.sender];
        if (amount > bal) revert Insufficient();
        sponsorFunds[msg.sender] = bal - amount;
        emit SponsorFunds(msg.sender, -int256(amount));
        _send(to, amount);
    }

    /// @notice Lock payer funds for one candidate. Does NOT list anything or release gas. Bootstrap reservations
    ///         (host not yet enrolled) take the hardware's single bootstrap slot; every reservation takes its job id.
    function reserveBootstrap(SponsorReservation calldata s, bytes calldata payerAuthorization)
        external returns (bytes32 id)
    {
        if (s.payer == address(0) || s.hostId == 0 || s.hardwareId == 0 || s.jobId == 0 || s.trustAnchorId == 0)
            revert BadReservation();
        if (s.source != SOURCE_PAID_WORK_HOST && s.source != SOURCE_STRIPE_FALLBACK) revert BadReservation();
        if (s.sourceEvidence == 0) revert BadReservation();
        if (s.protectedAmount == 0 || s.perTransitionCap == 0 || s.perTransitionCap > s.protectedAmount
            || s.l1FeeAllowance > s.perTransitionCap || s.maxGasPrice == 0) revert BadBudget();
        if (block.timestamp > s.deadline) revert Expired();
        if (_anchors[s.trustAnchorId].threshold == 0) revert UnknownAnchor();
        id = hashReservation(s);
        if (reservations[id].status != 0) revert Replay();
        _checkConsent(s.payer, id, payerAuthorization);
        if (hostState[s.hostId].generation == 0) {
            if (hardwareReservation[s.hardwareId] != 0) revert Duplicate();
            hardwareReservation[s.hardwareId] = id;
        }
        if (jobReservation[s.jobId] != 0) revert Duplicate();
        jobReservation[s.jobId] = id;
        uint256 total = uint256(s.protectedAmount) + s.listingGasCap;
        uint256 bal = sponsorFunds[s.payer];
        if (total > bal) revert Insufficient();
        sponsorFunds[s.payer] = bal - total;
        reservations[id] = Reservation({
            payer: s.payer, status: RES_RESERVED, deadline: s.deadline, submitter: s.submitter,
            maxGasPrice: s.maxGasPrice, hostId: s.hostId, hardwareId: s.hardwareId, jobId: s.jobId,
            trustAnchorId: s.trustAnchorId, protectedAmount: s.protectedAmount, listingGasCap: s.listingGasCap,
            perTransitionCap: s.perTransitionCap, l1FeeAllowance: s.l1FeeAllowance
        });
        emit BootstrapReserved(id, s.hostId, s.payer, s.source);
    }

    /// @notice After its deadline an unconsumed reservation returns to its payer and frees its dedup slots.
    function cancelReservation(bytes32 id) external {
        Reservation storage r = reservations[id];
        if (r.payer != msg.sender) revert NotAuthorized();
        if (r.status != RES_RESERVED || block.timestamp <= r.deadline) revert BadReservation();
        r.status = RES_CANCELLED;
        if (hardwareReservation[r.hardwareId] == id) delete hardwareReservation[r.hardwareId];
        if (jobReservation[r.jobId] == id) delete jobReservation[r.jobId];
        sponsorFunds[r.payer] += uint256(r.protectedAmount) + r.listingGasCap;
        emit ReservationCancelled(id);
    }

    // ================================================================== enrollment and recovery
    function registerQualifiedHost(Enrollment calldata e, ReporterPolicy calldata reporters,
        QualificationReceipt calldata receipt, bytes calldata operatorConsent, bytes calldata ownerConsent,
        bytes[] calldata qualificationApprovals) external returns (bytes32 hostId)
    {
        uint256 g0 = gasleft();
        Listing calldata l = e.listing;
        _checkListing(l);
        hostId = keccak256(bytes(l.endpoint));
        if (hostState[hostId].generation != 0) revert HostExists();
        if (e.operator == address(0) || e.owner == address(0) || e.hardwareId == 0 || e.protectedAmount == 0)
            revert BadListing();
        if (hardwareHost[e.hardwareId] != 0) revert Duplicate();
        if (block.timestamp > e.deadline) revert Expired();
        if (hashReporterPolicy(reporters) != e.reporterPolicyHash) revert BadPolicy();
        _checkReporters(reporters, true);

        bytes32 digest = hashEnrollment(e);
        if (usedDigest[digest]) revert Replay();
        usedDigest[digest] = true;
        _checkConsent(e.operator, digest, operatorConsent);
        _checkConsent(e.owner, digest, ownerConsent);

        Reservation storage r = _consumeReservation(e.reservationId, hostId, e.hardwareId, e.trustAnchorId);
        if (r.protectedAmount != e.protectedAmount) revert BadReservation();

        bytes32 descriptor = descriptorOf(l.repo, l.measurement);
        _matchReceipt(receipt, hostId, e.hardwareId, descriptor, e.attestationDigest, e.resourceDigest, e.trustAnchorId);
        bytes32 qd = _verifyQualification(receipt, qualificationApprovals, digest, 1, e.operator, e.owner);

        // ---- every check passed: install row + authority + reporters + budget + Online in one transaction
        _ids.push(hostId);
        Enclave storage row = _rows[hostId];
        row.endpoint = l.endpoint;
        row.repo = l.repo;
        row.measurement = l.measurement;
        row.operator = e.operator;
        row.registeredAt = uint64(block.timestamp);
        row.lastSeen = uint64(block.timestamp);
        row.cpuPricePerSec6 = l.cpuPricePerSec6;
        row.gpuPricePerSec6 = l.gpuPricePerSec6;
        row.proofKey = l.proofKey;
        row.caps = l.caps | CAP_HOST;
        row.region = l.region;

        Authority storage a = authority[hostId];
        a.owner = e.owner;
        a.revision = 1;
        a.policyHash = e.ownerPolicyHash;
        _setReporters(hostId, reporters, 1);

        _fundBudget(hostId, r);
        hostBudget[hostId].protectedReserve = e.protectedAmount;
        hardwareHost[e.hardwareId] = hostId;

        _setOnline(hostId, 1, receipt, qd, descriptor);
        emit Registered(hostId, e.operator, l.endpoint, l.repo);
        emit Updated(hostId, l.repo, l.measurement);
        emit PricesSet(hostId, l.cpuPricePerSec6, l.gpuPricePerSec6);
        emit ProofKeySet(hostId, l.proofKey);
        emit CapsSet(hostId, row.caps, l.region);
        emit PolicySet(hostId, 1, e.ownerPolicyHash, e.reporterPolicyHash);
        emit HostOnline(hostId, 1, e.operator, 1, qd);
        _releaseListingGas(e.reservationId, r, g0);
    }

    /// @notice Install a strictly newer generation after a recorded Offline. Requires the accepted owner, the
    ///         (possibly rotated) operator, and a fresh receipt bound to THIS recovery intent and generation.
    function recoverQualifiedHost(Recovery calldata v, QualificationReceipt calldata receipt,
        bytes calldata operatorConsent, bytes calldata ownerConsent, bytes[] calldata qualificationApprovals)
        external returns (uint64 generation)
    {
        uint256 g0 = gasleft();
        bytes32 hostId = v.hostId;
        HostState storage st = hostState[hostId];
        Authority storage a = authority[hostId];
        if (st.status != STATUS_OFFLINE) revert NotOffline();
        if (st.generation != v.priorGeneration || st.lastOfflineDigest != v.priorOfflineDigest
            || a.revision != v.authorityRevision || a.owner != v.owner) revert IntentMismatch();
        if (v.operator == address(0) || v.protectedAmount == 0 || bytes(v.repo).length > MAX_REPO) revert BadListing();
        if (block.timestamp > v.deadline) revert Expired();
        if (_reporters[hostId].threshold == 0) revert BadPolicy();       // going Online needs an offline path
        bytes32 bound = hardwareHost[v.hardwareId];
        if (v.hardwareId == 0 || (bound != 0 && bound != hostId)) revert Duplicate();

        bytes32 digest = hashRecovery(v);
        if (usedDigest[digest]) revert Replay();
        usedDigest[digest] = true;
        _checkConsent(v.operator, digest, operatorConsent);
        _checkConsent(v.owner, digest, ownerConsent);

        if (v.reservationId != 0) {
            Reservation storage r = _consumeReservation(v.reservationId, hostId, v.hardwareId, v.trustAnchorId);
            if (r.protectedAmount != v.protectedAmount) revert BadReservation();
            _fundBudget(hostId, r);
        } else if (v.trustAnchorId != st.trustAnchorId) {
            revert ReceiptMismatch();      // without a new payer authorization only the payer's prior anchor applies
        }
        Budget storage b = hostBudget[hostId];
        // A recovery may not lower the live reserve below the payer-authorized maximum transition liability.
        if (v.protectedAmount < b.perTransitionCap) revert BadBudget();
        if (b.balance < v.protectedAmount) revert Insufficient();   // recovery funds its own protected reserve
        b.protectedReserve = v.protectedAmount;

        generation = st.generation + 1;
        bytes32 descriptor = descriptorOf(v.repo, v.measurement);
        _matchReceipt(receipt, hostId, v.hardwareId, descriptor, v.attestationDigest, v.resourceDigest,
                      v.trustAnchorId);
        bytes32 qd = _verifyQualification(receipt, qualificationApprovals, digest, generation, v.operator, v.owner);

        Enclave storage row = _rows[hostId];
        if (row.operator != v.operator) {
            row.operator = v.operator;
            if (row.payoutWallet != address(0)) {
                row.payoutWallet = address(0);           // a declaration for the old operator is not carried over
                emit PayoutWalletSet(hostId, address(0));
            }
        }
        row.repo = v.repo;
        row.measurement = v.measurement;
        row.proofKey = v.proofKey;
        row.lastSeen = uint64(block.timestamp);
        hardwareHost[v.hardwareId] = hostId;
        _setOnline(hostId, generation, receipt, qd, descriptor);
        emit Updated(hostId, v.repo, v.measurement);
        emit ProofKeySet(hostId, v.proofKey);
        emit HostOnline(hostId, generation, v.operator, a.revision, qd);
        if (v.reservationId != 0) _releaseListingGas(v.reservationId, reservations[v.reservationId], g0);
    }

    // ================================================================== offline (external-call free)
    /// @notice Enrolled EOA reporter quorum records Offline for the exact current generation and revision.
    /// @return recorded false only for an exact retry of the already recorded transition (no state change).
    function recordHostOffline(HostOffline calldata o, bytes[] calldata reporterApprovals) external returns (bool) {
        uint256 g0 = gasleft();
        bytes32 digest = hashOffline(o);
        HostState storage st = hostState[o.hostId];
        _checkOfflineIntent(o, st);
        Reporters storage rs = _reporters[o.hostId];
        _verifyQuorum(digest, reporterApprovals, rs.keys, rs.threshold);
        if (st.status == STATUS_OFFLINE && st.lastOfflineDigest == digest) return false;
        if (st.status != STATUS_ONLINE) revert NotOnline();
        _recordOffline(o, st, digest, g0);
        return true;
    }

    /// @notice Graceful shutdown by the locally stored operator or accepted owner (msg.sender; no ERC1271).
    function deactivateHost(HostOffline calldata o) external returns (bool) {
        uint256 g0 = gasleft();
        bytes32 digest = hashOffline(o);
        HostState storage st = hostState[o.hostId];
        if (msg.sender != _rows[o.hostId].operator && msg.sender != authority[o.hostId].owner) revert NotAuthorized();
        _checkOfflineIntent(o, st);
        if (st.status == STATUS_OFFLINE && st.lastOfflineDigest == digest) return false;
        if (st.status != STATUS_ONLINE) revert NotOnline();
        _recordOffline(o, st, digest, g0);
        return true;
    }

    // ================================================================== accepted-owner authority
    function proposeHostOwner(bytes32 hostId, address next) external {
        Authority storage a = authority[hostId];
        if (a.owner != msg.sender) revert NotAuthorized();
        a.pendingOwner = next;                                 // 0 cancels
        emit OwnerProposed(hostId, next);
    }

    /// @notice The proposed owner accepts and, in the same write, replaces the reporter quorum and policy.
    function acceptHostOwner(bytes32 hostId, ReporterPolicy calldata nextReporters, bytes32 nextPolicyHash) external {
        Authority storage a = authority[hostId];
        if (a.pendingOwner != msg.sender || msg.sender == address(0)) revert NotAuthorized();
        a.owner = msg.sender;
        a.pendingOwner = address(0);
        _installPolicy(hostId, a, nextReporters, nextPolicyHash);
        emit OwnerAccepted(hostId, msg.sender, a.revision);
    }

    function setHostPolicy(bytes32 hostId, ReporterPolicy calldata nextReporters, bytes32 nextPolicyHash) external {
        Authority storage a = authority[hostId];
        if (a.owner != msg.sender) revert NotAuthorized();
        _installPolicy(hostId, a, nextReporters, nextPolicyHash);
    }

    // ================================================================== operator configuration (never lifecycle)
    function setPrices(bytes32 id, uint64 cpuPricePerSec6, uint64 gpuPricePerSec6) external {
        Enclave storage e = _operatorRow(id);
        if (cpuPricePerSec6 == 0) revert BadListing();
        e.cpuPricePerSec6 = cpuPricePerSec6;
        e.gpuPricePerSec6 = gpuPricePerSec6;
        emit PricesSet(id, cpuPricePerSec6, gpuPricePerSec6);
    }

    /// @notice Compatibility no-op only. A different proof key requires fresh qualified recovery.
    function setProofKey(bytes32 id, address proofKey) external {
        if (_operatorRow(id).proofKey != proofKey) revert BadListing();
        emit ProofKeySet(id, proofKey);
    }

    function setCaps(bytes32 id, uint64 caps, string calldata region) external {
        Enclave storage e = _operatorRow(id);
        if (caps & CAP_HOST == 0 || bytes(region).length > MAX_REGION) revert BadListing();
        e.caps = caps;
        e.region = region;
        emit CapsSet(id, caps, region);
    }

    function setPayoutWallet(bytes32 id) external {
        if (hostState[id].generation == 0) revert UnknownHost();
        _rows[id].payoutWallet = msg.sender;
        emit PayoutWalletSet(id, msg.sender);
    }

    function clearPayoutWallet(bytes32 id) external {
        Enclave storage e = _rows[id];
        if (hostState[id].generation == 0) revert UnknownHost();
        if (e.payoutWallet != msg.sender && e.operator != msg.sender) revert NotAuthorized();
        e.payoutWallet = address(0);
        emit PayoutWalletSet(id, address(0));
    }

    // ================================================================== protected host budget and pull credits
    /// @notice Only the budget's payer adds funds, so every wei in a host budget has one entitled payer.
    function fundHostOffline(bytes32 hostId) external payable {
        Budget storage b = hostBudget[hostId];
        if (b.payer != msg.sender) revert NotAuthorized();
        uint256 nb = uint256(b.balance) + msg.value;
        if (nb > type(uint128).max) revert BadBudget();
        b.balance = uint128(nb);
        emit BudgetFunded(hostId, msg.sender, msg.value);
    }

    /// @notice Return unencumbered budget to the payer's sponsor funds. While Online the protected reserve stays.
    ///         Reimbursements already owed live in `credits` and are never touched here.
    function releaseHostBudget(bytes32 hostId, uint128 amount) external {
        Budget storage b = hostBudget[hostId];
        if (b.payer != msg.sender) revert NotAuthorized();
        uint256 free = b.balance;
        if (hostState[hostId].status == STATUS_ONLINE) free = free > b.protectedReserve ? free - b.protectedReserve : 0;
        if (amount > free) revert Insufficient();
        b.balance -= amount;
        sponsorFunds[msg.sender] += amount;
        emit BudgetReleased(hostId, msg.sender, amount);
    }

    function claimHostReimbursement(address payable to) external returns (uint256 amount) {
        amount = credits[msg.sender];
        credits[msg.sender] = 0;
        emit ReimbursementClaimed(msg.sender, to, amount);
        _send(to, amount);
    }

    // ================================================================== internals
    function _operatorRow(bytes32 id) private view returns (Enclave storage e) {
        e = _rows[id];
        if (hostState[id].generation == 0) revert UnknownHost();
        if (e.operator != msg.sender) revert NotAuthorized();
    }

    function _checkListing(Listing calldata l) private pure {
        uint256 el = bytes(l.endpoint).length;
        if (el == 0 || el > MAX_ENDPOINT || bytes(l.repo).length > MAX_REPO || bytes(l.region).length > MAX_REGION
            || l.cpuPricePerSec6 == 0) revert BadListing();
    }

    function _requireAscending(address[] calldata keys) private pure {
        address last;
        for (uint256 i; i < keys.length; ++i) {
            if (keys[i] <= last) revert BadPolicy();           // strictly ascending; excludes zero and duplicates
            last = keys[i];
        }
    }

    /// @dev Strict-majority quorum over at most MAX_REPORTERS unique keys. Empty only when allowed.
    function _checkReporters(ReporterPolicy calldata p, bool requireNonEmpty) private pure {
        uint256 n = p.reporters.length;
        if (n == 0) {
            if (requireNonEmpty || p.threshold != 0) revert BadPolicy();
            return;
        }
        if (n > MAX_REPORTERS || p.threshold == 0 || p.threshold > n || uint256(p.threshold) * 2 <= n)
            revert BadPolicy();
        _requireAscending(p.reporters);
    }

    function _setReporters(bytes32 hostId, ReporterPolicy calldata p, uint64 revision) private {
        Reporters storage r = _reporters[hostId];
        r.keys = p.reporters;
        r.threshold = p.threshold;
        r.revision = revision;
    }

    function _installPolicy(bytes32 hostId, Authority storage a, ReporterPolicy calldata p, bytes32 policyHash) private {
        _checkReporters(p, hostState[hostId].status == STATUS_ONLINE);
        uint64 revision = a.revision + 1;
        a.revision = revision;
        a.policyHash = policyHash;
        _setReporters(hostId, p, revision);
        emit PolicySet(hostId, revision, policyHash, hashReporterPolicy(p));
    }

    function _consumeReservation(bytes32 id, bytes32 hostId, bytes32 hardwareId, bytes32 anchorId)
        private returns (Reservation storage r)
    {
        r = reservations[id];
        if (r.status != RES_RESERVED || r.hostId != hostId || r.hardwareId != hardwareId
            || r.trustAnchorId != anchorId || block.timestamp > r.deadline) revert BadReservation();
        if (r.submitter != address(0) && r.submitter != msg.sender) revert NotAuthorized();
        r.status = RES_CONSUMED;
    }

    function _fundBudget(bytes32 hostId, Reservation storage r) private {
        Budget storage b = hostBudget[hostId];
        if (b.payer != r.payer) {
            if (b.balance != 0) revert BadBudget();             // never mix two payers' money in one budget
            b.payer = r.payer;
        }
        uint256 nb = uint256(b.balance) + r.protectedAmount;
        if (nb > type(uint128).max) revert BadBudget();
        b.balance = uint128(nb);
        b.perTransitionCap = r.perTransitionCap;
        b.l1FeeAllowance = r.l1FeeAllowance;
        b.maxGasPrice = r.maxGasPrice;
        emit BudgetFunded(hostId, r.payer, r.protectedAmount);
    }

    /// @dev Only after every check passed: measured execution cost at a payer-capped gas price, clamped to the
    ///      payer-signed listing cap, credited (pull) to the submitter; the unused cap returns to the payer.
    function _releaseListingGas(bytes32 id, Reservation storage r, uint256 g0) private {
        uint256 cap = r.listingGasCap;
        uint256 paid;
        if (cap != 0) {
            uint256 used = g0 - gasleft() + LISTING_GAS_OVERHEAD;
            paid = _min(_satMul(used, _min(tx.gasprice, r.maxGasPrice)), cap);
            credits[msg.sender] += paid;
        }
        sponsorFunds[r.payer] += cap - paid;
        emit ListingGasReleased(id, msg.sender, paid, cap - paid);
    }

    function _matchReceipt(QualificationReceipt calldata q, bytes32 hostId, bytes32 hardwareId, bytes32 descriptor,
                           bytes32 attestation, bytes32 resource, bytes32 anchorId) private pure
    {
        if (q.hostId != hostId || q.hardwareId != hardwareId || q.descriptorDigest != descriptor
            || q.attestationDigest != attestation || q.resourceDigest != resource || q.trustAnchorId != anchorId
            || attestation == 0 || resource == 0) revert ReceiptMismatch();
    }

    function _verifyQualification(QualificationReceipt calldata q, bytes[] calldata approvals, bytes32 intentDigest,
        uint64 generation, address operator, address owner) private returns (bytes32 qd)
    {
        TrustAnchor storage t = _anchors[q.trustAnchorId];
        if (t.threshold == 0) revert UnknownAnchor();
        if (q.intentDigest != intentDigest || q.generation != generation || q.testDigest == 0) revert ReceiptMismatch();
        if (q.issuedAt > block.timestamp || block.timestamp >= q.expiresAt || q.expiresAt - q.issuedAt > t.maxReceiptAge)
            revert StaleReceipt();
        address[] storage vs = t.verifiers;
        for (uint256 i; i < vs.length; ++i) if (vs[i] == operator || vs[i] == owner) revert NotIndependent();
        qd = hashReceipt(q);
        if (usedDigest[qd]) revert Replay();
        usedDigest[qd] = true;
        _verifyQuorum(qd, approvals, vs, t.threshold);
    }

    function _setOnline(bytes32 hostId, uint64 generation, QualificationReceipt calldata q, bytes32 qd,
                        bytes32 descriptor) private
    {
        HostState storage st = hostState[hostId];
        st.generation = generation;
        st.status = STATUS_ONLINE;
        st.changedAt = uint64(block.timestamp);
        st.qualificationExpiry = q.expiresAt;
        st.hardwareId = q.hardwareId;
        st.descriptorDigest = descriptor;
        st.qualificationDigest = qd;
        st.resourceDigest = q.resourceDigest;
        st.trustAnchorId = q.trustAnchorId;
    }

    /// @dev Pure local reads. Unknown hosts fail here (status NONE).
    function _checkOfflineIntent(HostOffline calldata o, HostState storage st) private view {
        if (st.status != STATUS_ONLINE && st.status != STATUS_OFFLINE) revert NotOnline();
        if (o.generation != st.generation || o.operator != _rows[o.hostId].operator
            || o.authorityRevision != authority[o.hostId].revision || o.targetStatus != STATUS_OFFLINE
            || o.evidenceDigest == 0) revert IntentMismatch();
        if (block.timestamp > o.deadline) revert Expired();
    }

    /// @dev Writes Offline, then computes a reimbursement that cannot revert: every term is clamped by min() or
    ///      saturating math, charge <= balance so the subtraction and uint128 cast are exact, and the credit is
    ///      backed by the same wei. No external call follows.
    function _recordOffline(HostOffline calldata o, HostState storage st, bytes32 digest, uint256 g0) private {
        st.status = STATUS_OFFLINE;
        st.changedAt = uint64(block.timestamp);
        st.lastOfflineDigest = digest;
        _rows[o.hostId].lastSeen = uint64(block.timestamp);
        emit HostMarkedOffline(o.hostId, o.generation, digest, o.evidenceDigest, msg.sender);
        emit Deregistered(o.hostId);

        Budget storage b = hostBudget[o.hostId];
        uint256 cap = _min(_min(o.maxCharge, b.perTransitionCap), b.balance);
        uint256 charge;
        if (cap != 0 && o.payee != address(0)) {
            uint256 used = g0 - gasleft() + OFFLINE_GAS_OVERHEAD;
            // No authenticated Base L1-fee mechanism exists in this version. The signed L1 cap is inert:
            // no unproven allowance is paid, no L1 debt is invented, and actual L1 fees remain unreimbursed.
            charge = _min(_satMul(used, _min(tx.gasprice, b.maxGasPrice)), cap);
            b.balance -= uint128(charge);
            credits[o.payee] += charge;
        }
        emit OfflineReimbursed(o.hostId, o.generation, o.payee, charge);
    }

    /// @dev Strictly ascending recovered signers, each a member of `set`, at least `threshold` of them.
    function _verifyQuorum(bytes32 digest, bytes[] calldata sigs, address[] storage set, uint8 threshold)
        private view
    {
        uint256 n = set.length;
        if (threshold == 0 || sigs.length < threshold || sigs.length > n) revert Quorum();
        address last;
        for (uint256 i; i < sigs.length; ++i) {
            address s = _recover(digest, sigs[i]);
            if (s <= last) revert Quorum();
            bool member;
            for (uint256 j; j < n; ++j) {
                if (set[j] == s) { member = true; break; }
            }
            if (!member) revert Quorum();
            last = s;
        }
    }

    /// @dev Normal-path consent: msg.sender itself, ERC1271 for contract wallets, else a 65-byte low-s ECDSA sig.
    function _checkConsent(address signer, bytes32 digest, bytes calldata sig) private view {
        if (sig.length == 0) {
            if (msg.sender != signer) revert BadConsent();
            return;
        }
        if (signer.code.length != 0) {
            (bool ok, bytes memory ret) = signer.staticcall(abi.encodeWithSelector(ERC1271_MAGIC, digest, sig));
            if (!ok || ret.length < 32 || bytes4(abi.decode(ret, (bytes32))) != ERC1271_MAGIC) revert BadConsent();
        } else if (signer == address(0) || _recover(digest, sig) != signer) {
            revert BadConsent();
        }
    }

    /// @dev Malformed or high-s signatures recover the zero address, which no check accepts.
    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        if ((v != 27 && v != 28) || uint256(s) > HALF_N) return address(0);
        return ecrecover(digest, v, r, s);
    }

    function _send(address payable to, uint256 amount) private {
        if (to == address(0)) revert TransferFailed();
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) { return a < b ? a : b; }

    function _satMul(uint256 a, uint256 b) private pure returns (uint256) {
        if (a == 0 || b == 0) return 0;
        unchecked { uint256 c = a * b; return c / a == b ? c : type(uint256).max; }
    }
}
