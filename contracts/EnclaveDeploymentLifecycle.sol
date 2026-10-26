// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

/// The funded-runtime ledger, not this controller, owns compute accounting and
/// proof-of-service settlement. A v1 lease ledger MUST NOT implement this port
/// by bypassing its claim gates. Deployment requires an explicitly paired v2.
interface ILifecycleLedger {
    function lifecycleSchema() external view returns (uint256);
    function lifecycleOwner(bytes32 id) external view returns (address);
    function lifecycleOperator(bytes32 id, bytes32 host) external view returns (address);
    function lifecycleStart(bytes32 id, bytes32 host, address operator) external;
    function lifecycleEnd(bytes32 id, bool stopped) external;
    function lifecycleFunded(bytes32 id) external view returns (bool);
    function selfHostingIdentity() external view returns (address);
}
interface ILifecycleIdentity { function principal(address account) external view returns (address); }
interface ILifecycleL1Oracle {
    function getL1FeeUpperBound(uint256 txSize) external view returns (uint256);
}

/// Event-driven assignment controller. Heartbeats/serving permits never enter
/// this contract. Queued, Running and Stopped are the only paid transitions.
/// An unchanged app has no timer and no renew method. Runtime affordability is
/// read-only, and verified self-hosting is priced by the paired ledger.
///
/// Witnesses are explicitly selected by each owner. More than 2/3 must attest a
/// transition; 3 of 4 supports one Byzantine witness. They must durably fence a
/// generation before voting it out. Consumers also enforce fresh generation
/// reads and short-lived quorum permits. The contract cannot revoke a host's
/// access to raw hardware; fencing is enforced at protected data boundaries.
contract EnclaveDeploymentLifecycle {
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
    ILifecycleLedger public immutable ledger;
    ILifecycleL1Oracle public immutable l1Oracle;
    mapping(bytes32 => Assignment) public assignments;
    mapping(bytes32 => Budget) public budgets;
    mapping(bytes32 => address[]) private _witnesses;
    mapping(bytes32 => mapping(address => bool)) public witness;
    mapping(bytes32 => uint8) public threshold;
    // Zero keeps finality-only authorization. Opting into bounded off-chain
    // generation certificates is an explicit owner policy, never an RPC hint.
    mapping(bytes32 => uint32) public maxAnchorAgeSec;
    // Generation fencing is a short, off-chain permit bound, not a reservation
    // renewal. No write is needed when this delay elapses.
    uint64 public constant FENCE_SEC = 22;
    uint64 public constant HEALTHY_RESET_SEC = 600;
    uint32 public constant MAX_FAILURES = 5;
    uint64 public constant MAX_BACKOFF_SEC = 300;
    uint256 private constant CHARGE_OVERHEAD = 65000;
    // floor(secp256k1 group order / 2), a public curve parameter, not a key.
    uint256 private constant HALF_ORDER = 57896044618658097711785492504343953926418782139537452191302581570759080747168;
    bytes32 private constant INTENT_TYPE = keccak256("Transition(bytes32 id,uint64 generation,uint64 revision,uint8 target,bytes32 host,uint64 deadline,uint64 healthySince,address payee,uint256 maxChargeWei)");
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

    modifier nonReentrant() { require(!entered, "reentrant"); entered = true; _; entered = false; }
    constructor(address ledger_, address l1Oracle_) {
        ledger = ILifecycleLedger(ledger_);
        require(ledger.lifecycleSchema() == 2, "v2 ledger required");
        require(block.chainid != 8453 || l1Oracle_.code.length > 0, "Base L1 oracle required");
        l1Oracle = ILifecycleL1Oracle(l1Oracle_);
    }
    function ownerAuthority(bytes32 id) public view returns (address) {
        return ILifecycleIdentity(ledger.selfHostingIdentity()).principal(ledger.lifecycleOwner(id));
    }
    function canTransfer(bytes32 id) external view returns (bool) {
        Assignment storage a = assignments[id];
        return (a.state == State.Unknown || a.state == State.Stopped) &&
            budgets[id].balanceWei == 0 && block.timestamp >= a.startAfter;
    }

    /// Policy edits require an idle deployment. Running apps cannot have their
    /// witness set or final-stop protection weakened behind existing permits.
    function configure(bytes32 id, address[] calldata witnesses, uint8 required,
        uint128 maxTransitionWei, uint128 stopReserveWei, uint64 maxGasPrice) external nonReentrant {
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

    /// Funding is permissionless, but can never change the owner or policy.
    function deposit(bytes32 id) external payable nonReentrant {
        require(assignments[id].owner != address(0) && msg.value > 0, "unknown or empty deposit");
        require(assignments[id].owner == ledger.lifecycleOwner(id), "owner changed");
        budgets[id].balanceWei += msg.value;
        emit Deposited(id, msg.sender, msg.value);
    }

    function witnessesOf(bytes32 id) external view returns (address[] memory) { return _witnesses[id]; }
    function setAuthorityPolicy(bytes32 id, uint32 lagSec) external nonReentrant {
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
        return a.state == State.Running && a.owner == ledger.lifecycleOwner(id) && spendable(id) > 0 && ledger.lifecycleFunded(id);
    }

    function digest(Intent calldata x) public view returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(DOMAIN_TYPE, keccak256("EnclaveDeploymentLifecycle"),
            keccak256("1"), block.chainid, address(this)));
        return keccak256(abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(INTENT_TYPE,
            x.id, x.generation, x.revision, uint8(x.target), x.host, x.deadline, x.healthySince, x.payee, x.maxChargeWei))));
    }

    /// Same intent retries are a no-op, never another app charge. Relays check
    /// the receipt/intention before submitting; two different intents for one
    /// generation race safely and only one can commit.
    function transition(Intent calldata x, bytes calldata actorSignature, bytes[] calldata approvals)
        external nonReentrant returns (bool changed) {
        uint256 gasStart = gasleft();
        Assignment storage a = assignments[x.id];
        bytes32 h = digest(x);
        if (a.lastIntent == h && h != bytes32(0)) return false;
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
            _quorum(x.id, h, approvals); // readiness and exclusive assignment
            ledger.lifecycleStart(x.id, x.host, actor);
            a.host = x.host;
            a.operator = actor;
        } else {
            require(x.host == bytes32(0), "idle state has no host");
            bool byOwner = _signed(ownerAuthority(x.id), h, actorSignature);
            bool byOperator = a.state == State.Running && _signed(a.operator, h, actorSignature);
            if (!byOwner && !byOperator) _quorum(x.id, h, approvals);
            // Only the owner starts/resumes an idle deployment. A failure quorum
            // may queue/stop a RUNNING assignment, never silently restart one.
            if (a.state != State.Running) require(byOwner ||
                (x.target == State.Stopped && spendable(x.id) <= x.maxChargeWei), "owner resume required");
            if (a.state != State.Running && x.target == State.Stopped) ledger.lifecycleEnd(x.id, true);
            if (a.state == State.Running) {
                ledger.lifecycleEnd(x.id, x.target == State.Stopped);
                a.startAfter = uint64(block.timestamp) + FENCE_SEC;
                if (x.target == State.Queued && !byOwner) {
                    // Elapsed wall time is not healthy uptime. Only the witness
                    // quorum can attest a sustained healthy interval, folded
                    // into this real transition (never a periodic reset write).
                    if (x.healthySince != 0) {
                        require(x.healthySince >= a.changedAt && uint256(x.healthySince) + HEALTHY_RESET_SEC <= block.timestamp,
                            "invalid healthy interval");
                        _quorum(x.id, h, approvals);
                        a.failures = 0;
                    }
                    ++a.failures;
                    uint64 backoff = uint64(5 << (a.failures > 6 ? 6 : a.failures - 1));
                    if (backoff > MAX_BACKOFF_SEC) backoff = MAX_BACKOFF_SEC;
                    if (block.timestamp + backoff > a.startAfter) a.startAfter = uint64(block.timestamp) + backoff;
                    a.crashHeld = a.failures >= MAX_FAILURES;
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
        // Account for rollup data fees at the chain's pinned oracle, bounded by
        // the signed per-transition cap. This is an upper estimate; production
        // qualification must compare it against actual Base receipts.
        if (address(l1Oracle) != address(0)) charge += l1Oracle.getL1FeeUpperBound(msg.data.length + 72);
        require(charge <= x.maxChargeWei, "charge exceeds signed limit");
        b.balanceWei -= charge;
        emit TransitionPaid(x.id, h, msg.sender, charge);
        (bool ok,) = msg.sender.call{value: charge}("");
        require(ok, "fee payment failed");
        return true;
    }

    function resume(bytes32 id) external nonReentrant {
        Assignment storage a = assignments[id];
        require(msg.sender == ownerAuthority(id) && a.owner == ledger.lifecycleOwner(id), "not owner");
        require(a.state == State.Queued && block.timestamp >= a.startAfter, "not idle");
        a.failures = 0;
        a.crashHeld = false;
        ++a.revision; // all previously collected permits/intents are invalid
        emit Resumed(id, a.revision);
    }

    function withdraw(bytes32 id, uint256 amount) external nonReentrant {
        Assignment storage a = assignments[id];
        require(msg.sender == ownerAuthority(id) && a.owner == ledger.lifecycleOwner(id), "not owner");
        require(a.state == State.Stopped && block.timestamp >= a.startAfter, "not stopped");
        budgets[id].balanceWei -= amount;
        emit Withdrawn(id, msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}(""); require(ok, "withdraw failed");
    }

    function _quorum(bytes32 id, bytes32 h, bytes[] calldata signatures) private view {
        require(signatures.length >= threshold[id] && signatures.length <= _witnesses[id].length, "quorum missing");
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
