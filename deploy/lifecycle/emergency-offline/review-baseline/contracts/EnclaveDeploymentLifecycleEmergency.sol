// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

// CANDIDATE PROTOTYPE - NOT BUILD-QUALIFIED, NOT DEPLOYABLE, NOT AN AUTHORIZATION.
// Derived from contracts/EnclaveDeploymentLifecycle.sol at EnclaveHost/enclave
// lifecycle candidate commit ecf364c0a81b9176163d254dcfc9685572bde0cd (read-only
// baseline .../work/enclave-deployment-lifecycle). Delta, see REPORT.md:
//   - quorum-only emergencyOffline: revokes the CURRENT Running assignment with
//     no external call (no ledger, identity, ERC-1271, oracle, token or payee);
//   - the revoked run's settlement is held PENDING at the exact recorded cutoff
//     and is completed by reconcileOffline through a schema-3 paired-ledger
//     port that must return an acknowledgement binding the same run
//     generation, host, operator, cutoff and stop flag;
//   - submitter reimbursement is bounded, pull-based and never blocks offline;
//     the Base L1 data component is recorded UNPRICED (no authenticated source).
// The schema-3 ledger port does not exist in the baseline ledger
// (deploy/lifecycle/EnclaveDeployments.sol is schema 2, ~107 B EIP-170 headroom).
// Production integration is BLOCKED on that ledger patch; this constructor
// refuses a schema-2 ledger so it cannot be paired with unpatched accounting.

/// Paired-ledger port, schema 3. Only lifecycleEndAt/lifecycleStart differ from
/// schema 2. lifecycleEndAt MUST settle the named run exactly at `cutoff`
/// (credit <= min(cutoff, leaseUntil, provenUntil), refund the tail from
/// max(cutoff, ...)), MUST refuse unless the stored run matches all of
/// (runGeneration, host, operator) with start <= cutoff <= block.timestamp, and
/// MUST be idempotent for an already-settled identical tuple. It returns
/// LifecycleSettlementAck.hash(...) computed over exactly what it applied.
interface ILifecycleLedgerV3 {
    function lifecycleSchema() external view returns (uint256);
    function lifecycleOwner(bytes32 id) external view returns (address);
    function lifecycleOperator(bytes32 id, bytes32 host) external view returns (address);
    function lifecycleStart(bytes32 id, bytes32 host, address operator, uint64 runGeneration) external;
    /// Idle deactivation only (no runner assigned).
    function lifecycleEnd(bytes32 id, bool stopped) external;
    function lifecycleEndAt(bytes32 id, uint64 runGeneration, bytes32 host, address operator,
        uint64 cutoff, bool stopped) external returns (bytes32 ack);
    function lifecycleFunded(bytes32 id) external view returns (bool);
    function selfHostingIdentity() external view returns (address);
}
interface ILifecycleIdentity { function principal(address account) external view returns (address); }
interface ILifecycleL1Oracle {
    function getL1FeeUpperBound(uint256 txSize) external view returns (uint256);
}

/// Shared acknowledgement encoding. The ack is an interface-conformance and
/// binding check against the pinned immutable ledger, not a new authority.
library LifecycleSettlementAck {
    bytes32 internal constant TYPEHASH = keccak256("LifecycleSettlement(address ledger,address controller,uint256 chainId,bytes32 id,uint64 runGeneration,bytes32 host,address operator,uint64 cutoff,bool stopped)");
    function hash(address ledger, address controller, bytes32 id, uint64 runGeneration, bytes32 host,
        address operator, uint64 cutoff, bool stopped) internal view returns (bytes32) {
        return keccak256(abi.encode(TYPEHASH, ledger, controller, block.chainid, id, runGeneration,
            host, operator, cutoff, stopped));
    }
}

contract EnclaveDeploymentLifecycleEmergency {
    enum State { Unknown, Queued, Running, Stopped }
    struct Assignment {
        address owner;
        State state;
        uint64 generation;
        uint64 revision;
        bytes32 host;
        address operator;
        uint64 changedAt;
        uint64 startAfter;
        uint32 failures;
        bool crashHeld;
        bytes32 lastIntent;
    }
    struct Budget {
        uint256 balanceWei;
        uint128 maxTransitionWei;
        uint128 stopReserveWei;
        uint64 maxGasPrice;
    }
    struct Intent {
        bytes32 id;
        uint64 generation;
        uint64 revision;
        State target;
        bytes32 host;
        uint64 deadline;
        uint64 healthySince;
        address payee;
        uint256 maxChargeWei;
    }
    /// Revocation of exactly one Running assignment. fromState is always
    /// Running; host/operator/generation/revision bind the current run.
    struct Emergency {
        bytes32 id;
        uint64 generation;
        uint64 revision;
        State fromState;
        bytes32 host;
        address operator;
        State target;
        uint64 deadline;
        address payee;
        uint128 maxReimburseWei;
    }
    /// The revoked run, awaiting exact-cutoff settlement in the paired ledger.
    struct Offline {
        uint64 runGeneration;
        uint64 cutoff;
        bool stopped;
        bool pending;
        bytes32 host;
        address operator;
    }
    struct Reimbursement {
        address payee;
        uint128 execWei;          // moved from the app budget into reimbursable[payee]
        uint128 l1UnpricedCapWei; // remaining signed cap; NOT reserved, NOT claimable
        uint32 l1DataBytes;       // input for a future authenticated receipt capability
    }

    ILifecycleLedgerV3 public immutable ledger;
    ILifecycleL1Oracle public immutable l1Oracle;
    mapping(bytes32 => Assignment) public assignments;
    mapping(bytes32 => Budget) public budgets;
    mapping(bytes32 => address[]) private _witnesses;
    mapping(bytes32 => mapping(address => bool)) public witness;
    mapping(bytes32 => uint8) public threshold;
    mapping(bytes32 => uint32) public maxAnchorAgeSec;
    mapping(bytes32 => Offline) public offline;
    mapping(bytes32 => bytes32) public lastEmergency;
    mapping(bytes32 => Reimbursement) public reimbursements; // by emergency digest
    mapping(address => uint256) public reimbursable;
    uint64 public constant FENCE_SEC = 22;
    uint64 public constant HEALTHY_RESET_SEC = 600;
    uint32 public constant MAX_FAILURES = 5;
    uint64 public constant MAX_BACKOFF_SEC = 300;
    uint256 private constant CHARGE_OVERHEAD = 65000;
    // floor(secp256k1 group order / 2), a public curve parameter, not a key.
    uint256 private constant HALF_ORDER = 57896044618658097711785492504343953926418782139537452191302581570759080747168;
    bytes32 private constant INTENT_TYPE = keccak256("Transition(bytes32 id,uint64 generation,uint64 revision,uint8 target,bytes32 host,uint64 deadline,uint64 healthySince,address payee,uint256 maxChargeWei)");
    bytes32 private constant EMERGENCY_TYPE = keccak256("EmergencyOffline(bytes32 id,uint64 generation,uint64 revision,uint8 fromState,bytes32 host,address operator,uint8 target,uint64 deadline,address payee,uint128 maxReimburseWei)");
    bytes32 private constant DOMAIN_TYPE = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bool private entered;
    event Configured(bytes32 indexed id, address indexed owner, uint64 revision);
    event Deposited(bytes32 indexed id, address indexed payer, uint256 amountWei);
    event Transitioned(bytes32 indexed id, uint64 indexed generation, State state, bytes32 host,
        address operator, uint64 startAfter, uint32 failures, bool crashHeld);
    event TransitionPaid(bytes32 indexed id, bytes32 indexed intent, address indexed payee, uint256 chargedWei);
    event Resumed(bytes32 indexed id, uint64 revision);
    event Withdrawn(bytes32 indexed id, address indexed owner, uint256 amountWei);
    event AuthorityPolicySet(bytes32 indexed id, uint64 revision, uint32 maxAnchorAgeSec);
    event OfflineRecorded(bytes32 indexed id, bytes32 indexed intent, uint64 runGeneration, uint64 cutoff, State target);
    event OfflineSettled(bytes32 indexed id, uint64 runGeneration, uint64 cutoff, bytes32 ack);
    event ReimbursementPending(bytes32 indexed id, bytes32 indexed intent, address indexed payee,
        uint256 execWei, uint256 l1UnpricedCapWei, uint32 l1DataBytes);
    event ReimbursementClaimed(address indexed payee, address indexed to, uint256 amountWei);

    modifier nonReentrant() { require(!entered, "reentrant"); entered = true; _; entered = false; }
    constructor(address ledger_, address l1Oracle_) {
        ledger = ILifecycleLedgerV3(ledger_);
        require(ledger.lifecycleSchema() == 3, "paired schema-3 ledger required");
        require(block.chainid != 8453 || l1Oracle_.code.length > 0, "Base L1 oracle required");
        l1Oracle = ILifecycleL1Oracle(l1Oracle_);
    }
    function ownerAuthority(bytes32 id) public view returns (address) {
        return ILifecycleIdentity(ledger.selfHostingIdentity()).principal(ledger.lifecycleOwner(id));
    }
    function canTransfer(bytes32 id) external view returns (bool) {
        Assignment storage a = assignments[id];
        return (a.state == State.Unknown || a.state == State.Stopped) && !offline[id].pending &&
            budgets[id].balanceWei == 0 && block.timestamp >= a.startAfter;
    }
    function _notPending(bytes32 id) private view {
        require(!offline[id].pending, "offline settlement pending");
    }

    function configure(bytes32 id, address[] calldata witnesses, uint8 required,
        uint128 maxTransitionWei, uint128 stopReserveWei, uint64 maxGasPrice) external nonReentrant {
        _notPending(id);
        address owner = ledger.lifecycleOwner(id);
        require(owner != address(0) && ownerAuthority(id) == msg.sender, "not owner");
        Assignment storage a = assignments[id];
        require(a.state != State.Running && block.timestamp >= a.startAfter, "assignment active");
        require(a.owner == address(0) || a.owner == owner ||
            (a.state == State.Stopped && budgets[id].balanceWei == 0), "ownership migration required");
        require(witnesses.length >= 3 && witnesses.length <= 16 && required * 3 > witnesses.length * 2 &&
            required <= witnesses.length, "witness quorum");
        require(maxTransitionWei > 0 && stopReserveWei >= maxTransitionWei && maxGasPrice > 0, "invalid budget");
        for (uint256 i; i < _witnesses[id].length; ++i) delete witness[id][_witnesses[id][i]];
        delete _witnesses[id];
        for (uint256 i; i < witnesses.length; ++i) {
            require(witnesses[i] != address(0) && !witness[id][witnesses[i]], "duplicate witness");
            witness[id][witnesses[i]] = true;
            _witnesses[id].push(witnesses[i]);
        }
        threshold[id] = required;
        if (a.owner != owner) maxAnchorAgeSec[id] = 0;
        a.owner = owner;
        ++a.revision;
        Budget storage b = budgets[id];
        b.maxTransitionWei = maxTransitionWei;
        b.stopReserveWei = stopReserveWei;
        b.maxGasPrice = maxGasPrice;
        emit Configured(id, owner, a.revision);
    }

    function deposit(bytes32 id) external payable nonReentrant {
        require(assignments[id].owner != address(0) && msg.value > 0, "unknown or empty deposit");
        require(assignments[id].owner == ledger.lifecycleOwner(id), "owner changed");
        budgets[id].balanceWei += msg.value;
        emit Deposited(id, msg.sender, msg.value);
    }

    function witnessesOf(bytes32 id) external view returns (address[] memory) { return _witnesses[id]; }
    function setAuthorityPolicy(bytes32 id, uint32 lagSec) external nonReentrant {
        _notPending(id);
        Assignment storage a = assignments[id];
        require(a.owner != address(0) && a.owner == ledger.lifecycleOwner(id) && msg.sender == ownerAuthority(id), "not owner");
        require(a.state != State.Running && block.timestamp >= a.startAfter, "assignment active");
        require(lagSec == 0 || (lagSec >= 20 && lagSec <= 3600), "anchor age bound");
        maxAnchorAgeSec[id] = lagSec;
        ++a.revision;
        emit AuthorityPolicySet(id, a.revision, lagSec);
    }
    function spendable(bytes32 id) public view returns (uint256) {
        Budget storage b = budgets[id];
        return b.balanceWei > b.stopReserveWei ? b.balanceWei - b.stopReserveWei : 0;
    }
    function funded(bytes32 id) external view returns (bool) {
        Assignment storage a = assignments[id];
        return a.state == State.Running && !offline[id].pending && a.owner == ledger.lifecycleOwner(id) &&
            spendable(id) > 0 && ledger.lifecycleFunded(id);
    }

    function digest(Intent calldata x) public view returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(DOMAIN_TYPE, keccak256("EnclaveDeploymentLifecycle"),
            keccak256("1"), block.chainid, address(this)));
        return keccak256(abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(INTENT_TYPE,
            x.id, x.generation, x.revision, uint8(x.target), x.host, x.deadline, x.healthySince, x.payee, x.maxChargeWei))));
    }
    /// Distinct EIP-712 domain name AND type: a Transition approval can never
    /// be replayed as an emergency approval or vice versa.
    function emergencyDigest(Emergency calldata x) public view returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(DOMAIN_TYPE, keccak256("EnclaveDeploymentLifecycle.EmergencyOffline"),
            keccak256("1"), block.chainid, address(this)));
        return keccak256(abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(EMERGENCY_TYPE,
            x.id, x.generation, x.revision, uint8(x.fromState), x.host, x.operator, uint8(x.target),
            x.deadline, x.payee, x.maxReimburseWei))));
    }
    function settlementAck(bytes32 id, uint64 runGeneration, bytes32 host, address operator,
        uint64 cutoff, bool stopped) public view returns (bytes32) {
        return LifecycleSettlementAck.hash(address(ledger), address(this), id, runGeneration, host, operator, cutoff, stopped);
    }

    function transition(Intent calldata x, bytes calldata actorSignature, bytes[] calldata approvals)
        external nonReentrant returns (bool changed) {
        uint256 gasStart = gasleft();
        Assignment storage a = assignments[x.id];
        bytes32 h = digest(x);
        if (a.lastIntent == h && h != bytes32(0)) return false;
        // No resume/start/stop/queue may touch a revoked run's ledger row
        // until its exact-cutoff settlement is acknowledged.
        _notPending(x.id);
        require(a.owner != address(0) && a.owner == ledger.lifecycleOwner(x.id), "owner changed or unknown");
        require(x.generation == a.generation && x.revision == a.revision, "stale assignment");
        require(x.deadline >= block.timestamp && x.deadline <= block.timestamp + 120, "intent deadline");
        require(x.payee == msg.sender && x.maxChargeWei > 0, "wrong payee or charge");
        require(x.target != State.Unknown && x.target != a.state, "not a transition");
        Budget storage b = budgets[x.id];
        require(x.maxChargeWei <= b.maxTransitionWei && tx.gasprice <= b.maxGasPrice, "fee cap");
        require(b.balanceWei >= x.maxChargeWei + (x.target == State.Stopped ? 0 : b.stopReserveWei + 1), "transition reserve");
        address actor;
        if (x.target == State.Running) {
            require(x.healthySince == 0, "unexpected healthy interval");
            require(a.state == State.Queued && !a.crashHeld && block.timestamp >= a.startAfter, "not startable");
            require(x.host != bytes32(0), "host required");
            actor = ledger.lifecycleOperator(x.id, x.host);
            require(actor != address(0), "host refused");
            require(_signed(actor, h, actorSignature), "not host operator");
            _quorum(x.id, h, approvals);
            // The ledger records the controller generation this run will hold.
            ledger.lifecycleStart(x.id, x.host, actor, a.generation + 1);
            a.host = x.host;
            a.operator = actor;
        } else {
            require(x.host == bytes32(0), "idle state has no host");
            bool byOwner = _signed(ownerAuthority(x.id), h, actorSignature);
            bool byOperator = a.state == State.Running && _signed(a.operator, h, actorSignature);
            if (!byOwner && !byOperator) _quorum(x.id, h, approvals);
            if (a.state != State.Running) require(byOwner ||
                (x.target == State.Stopped && spendable(x.id) <= x.maxChargeWei), "owner resume required");
            if (a.state != State.Running && x.target == State.Stopped) ledger.lifecycleEnd(x.id, true);
            if (a.state == State.Running) {
                // Synchronous normal path: cutoff is this block, still acked.
                _endAt(x.id, a.generation, a.host, a.operator, uint64(block.timestamp), x.target == State.Stopped);
                a.startAfter = uint64(block.timestamp) + FENCE_SEC;
                if (x.target == State.Queued && !byOwner) {
                    if (x.healthySince != 0) {
                        require(x.healthySince >= a.changedAt && uint256(x.healthySince) + HEALTHY_RESET_SEC <= block.timestamp,
                            "invalid healthy interval");
                        _quorum(x.id, h, approvals);
                        a.failures = 0;
                    }
                    _countFailure(a);
                }
            }
            if (x.target != State.Queued || a.state != State.Running || byOwner) require(x.healthySince == 0, "unexpected healthy interval");
            a.host = bytes32(0);
            a.operator = address(0);
        }
        a.state = x.target;
        a.changedAt = uint64(block.timestamp);
        ++a.generation;
        a.lastIntent = h;
        emit Transitioned(x.id, a.generation, a.state, a.host, a.operator, a.startAfter, a.failures, a.crashHeld);
        uint256 charge = (gasStart - gasleft() + CHARGE_OVERHEAD + msg.data.length * 16) * tx.gasprice;
        if (address(l1Oracle) != address(0)) charge += l1Oracle.getL1FeeUpperBound(msg.data.length + 72);
        require(charge <= x.maxChargeWei, "charge exceeds signed limit");
        b.balanceWei -= charge;
        emit TransitionPaid(x.id, h, msg.sender, charge);
        (bool ok,) = msg.sender.call{value: charge}("");
        require(ok, "fee payment failed");
        return true;
    }

    /// Authenticated durable offline. Witness quorum only (the same quorum that
    /// may already queue/stop a Running assignment via transition). Revokes the
    /// current run; never starts, resumes or selects a host. The critical path
    /// performs NO external call: ecrecover is a precompile and every other
    /// read/write is local storage. Admission caps (gas price, reserve,
    /// balance) bound only reimbursement, never the record.
    function emergencyOffline(Emergency calldata x, bytes[] calldata approvals)
        external nonReentrant returns (bool recorded) {
        uint256 gasStart = gasleft();
        bytes32 h = emergencyDigest(x);
        if (lastEmergency[x.id] == h) return false; // exact retry: no state, no charge
        Assignment storage a = assignments[x.id];
        require(a.owner != address(0) && threshold[x.id] != 0, "unknown deployment");
        require(x.fromState == State.Running && a.state == State.Running, "not running");
        require(x.generation == a.generation && x.revision == a.revision &&
            x.host == a.host && x.operator == a.operator, "stale assignment");
        require(x.target == State.Queued || x.target == State.Stopped, "revocation only");
        require(x.deadline >= block.timestamp && x.deadline <= block.timestamp + 120, "intent deadline");
        require(x.payee == address(0) ? x.maxReimburseWei == 0 : x.payee == msg.sender, "wrong payee");
        Budget storage b = budgets[x.id];
        require(x.maxReimburseWei <= b.maxTransitionWei, "reimbursement cap");
        _quorum(x.id, h, approvals);

        uint64 cutoff = uint64(block.timestamp);
        offline[x.id] = Offline(a.generation, cutoff, x.target == State.Stopped, true, a.host, a.operator);
        uint64 fence = cutoff + FENCE_SEC;
        if (fence > a.startAfter) a.startAfter = fence;
        if (x.target == State.Queued) _countFailure(a); // never a healthy reset here
        a.state = x.target;
        a.host = bytes32(0);
        a.operator = address(0);
        a.changedAt = cutoff;
        ++a.generation;
        lastEmergency[x.id] = h;
        emit Transitioned(x.id, a.generation, a.state, bytes32(0), address(0), a.startAfter, a.failures, a.crashHeld);
        emit OfflineRecorded(x.id, h, a.generation - 1, cutoff, x.target);

        if (x.payee != address(0)) {
            // Execution gas only, chain-measured, priced at min(tx.gasprice,
            // owner maxGasPrice), capped by the signed cap and the budget.
            uint256 price = tx.gasprice < b.maxGasPrice ? tx.gasprice : b.maxGasPrice;
            uint256 owed = (gasStart - gasleft() + CHARGE_OVERHEAD + msg.data.length * 16) * price;
            if (owed > x.maxReimburseWei) owed = x.maxReimburseWei;
            if (owed > b.balanceWei) owed = b.balanceWei;
            b.balanceWei -= owed;
            reimbursable[x.payee] += owed;
            uint32 l1Bytes = uint32(msg.data.length + 72);
            reimbursements[h] = Reimbursement(x.payee, uint128(owed), uint128(x.maxReimburseWei - owed), l1Bytes);
            emit ReimbursementPending(x.id, h, x.payee, owed, x.maxReimburseWei - owed, l1Bytes);
        }
        return true;
    }

    /// Permissionless completion of a pending offline. Reverts (keeping the
    /// record pending) unless the paired ledger acknowledges exactly the stored
    /// run and cutoff. Returns false once settled: never settles twice.
    function reconcileOffline(bytes32 id) external nonReentrant returns (bool settled) {
        Offline storage p = offline[id];
        if (!p.pending) return false;
        bytes32 ack = _endAt(id, p.runGeneration, p.host, p.operator, p.cutoff, p.stopped);
        p.pending = false;
        emit OfflineSettled(id, p.runGeneration, p.cutoff, ack);
        return true;
    }

    /// Pull payment. A rejecting recipient reverts this call only; the debt
    /// survives and may be claimed to another address.
    function claimReimbursement(address to) external nonReentrant {
        uint256 amount = reimbursable[msg.sender];
        require(amount > 0 && to != address(0), "nothing owed");
        reimbursable[msg.sender] = 0;
        emit ReimbursementClaimed(msg.sender, to, amount);
        (bool ok,) = to.call{value: amount}("");
        require(ok, "reimbursement transfer failed");
    }

    function resume(bytes32 id) external nonReentrant {
        _notPending(id);
        Assignment storage a = assignments[id];
        require(msg.sender == ownerAuthority(id) && a.owner == ledger.lifecycleOwner(id), "not owner");
        require(a.state == State.Queued && block.timestamp >= a.startAfter, "not idle");
        a.failures = 0;
        a.crashHeld = false;
        ++a.revision;
        emit Resumed(id, a.revision);
    }

    function withdraw(bytes32 id, uint256 amount) external nonReentrant {
        _notPending(id);
        Assignment storage a = assignments[id];
        require(msg.sender == ownerAuthority(id) && a.owner == ledger.lifecycleOwner(id), "not owner");
        require(a.state == State.Stopped && block.timestamp >= a.startAfter, "not stopped");
        budgets[id].balanceWei -= amount;
        emit Withdrawn(id, msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}(""); require(ok, "withdraw failed");
    }

    function _endAt(bytes32 id, uint64 runGeneration, bytes32 host, address operator, uint64 cutoff, bool stopped)
        private returns (bytes32 ack) {
        ack = ledger.lifecycleEndAt(id, runGeneration, host, operator, cutoff, stopped);
        require(ack == settlementAck(id, runGeneration, host, operator, cutoff, stopped), "settlement ack mismatch");
    }
    function _countFailure(Assignment storage a) private {
        ++a.failures;
        uint64 backoff = uint64(5) << (a.failures > 6 ? 6 : a.failures - 1);
        if (backoff > MAX_BACKOFF_SEC) backoff = MAX_BACKOFF_SEC;
        if (block.timestamp + backoff > a.startAfter) a.startAfter = uint64(block.timestamp) + backoff;
        a.crashHeld = a.failures >= MAX_FAILURES;
    }
    function _quorum(bytes32 id, bytes32 h, bytes[] calldata signatures) private view {
        uint8 required = threshold[id];
        require(required != 0 && signatures.length >= required && signatures.length <= _witnesses[id].length, "quorum missing");
        address previous;
        for (uint256 i; i < signatures.length; ++i) {
            address signer = _recover(h, signatures[i]);
            require(signer > previous && witness[id][signer], "invalid witness quorum");
            previous = signer;
        }
    }
    function _signed(address signer, bytes32 h, bytes calldata signature) private view returns (bool) {
        if (signer == address(0)) return false;
        if (signer.code.length != 0) {
            (bool ok, bytes memory result) = signer.staticcall(abi.encodeWithSelector(bytes4(0x1626ba7e), h, signature));
            return ok && result.length >= 32 && abi.decode(result, (bytes4)) == bytes4(0x1626ba7e);
        }
        return _recover(h, signature) == signer;
    }
    function _recover(bytes32 h, bytes calldata signature) private pure returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 r; bytes32 s; uint8 v;
        assembly { r := calldataload(signature.offset) s := calldataload(add(signature.offset, 32)) v := byte(0, calldataload(add(signature.offset, 64))) }
        if (uint256(s) > HALF_ORDER || (v != 27 && v != 28)) return address(0);
        return ecrecover(h, v, r, s);
    }
}
