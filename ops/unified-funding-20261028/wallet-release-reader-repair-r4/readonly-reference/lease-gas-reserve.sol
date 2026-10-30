// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title EnclaveLeaseGasReserve - an app's own ETH reserve pays the gas of its host's lease claim, renew and release.
///
/// PROTOTYPE (work/app-lease-gas, design B; design A is EnclaveLeaseGasPaymaster, ERC-4337). Additive: the ledger
/// (rev 16d) and the registry (schema 4) are used as deployed; no existing balance is touched or spendable here.
///
///   - APP OWNER (the ledger's owner of record: an EOA, a Safe, or a SessionVault through its owner's ownerCall)
///     deposits ETH for its deployment and configures the policy. Anyone may deposit (a gift to the current owner of
///     record). Only that owner configures or withdraws, and a reserve stays keyed to the owner that held it.
///   - HOST: its operator key is EIP-7702-delegated to EnclaveLeaseExecutor. It signs a Lease locally and needs no
///     ETH; the delegation authorization rides in a relayer's transaction.
///   - RELAYER (anyone, any number): sends the transaction and is paid in the same transaction by finish(): the gas
///     the executor measured, plus the transaction's intrinsic and calldata gas and a published constant overhead,
///     at min(tx.gasprice, the owner's cap, the admin's ceiling), plus Base's L1 data fee upper bound when enabled.
///     The key's FIRST lease through the executor also carries its EIP-7702 authorization: that one charge adds the
///     authorization's intrinsic gas (25,000, before any refund) and its encoded bytes to the L1 size. The L1 bound is
///     asked for the UNSIGNED transaction size (the oracle adds the signature itself). This is the whole fee model: no
///     oracle beyond Base's own, no markup, no pooled surplus; the owner's caps and the host's signed maximum bound it.
///   - A ledger revert reverts the whole transaction: the app never pays for a failed lease operation.
///
/// Enforced per operation (single source: _check, also behind statusOf):
///   - claim: the deployment is active and its lease expired (ledger: block.timestamp > leaseUntil); the claimant is
///     allowed by the owner's policy (0 any registered operator, 1 the owner's own boxes - registry payoutWallet ==
///     owner, 2 an explicit allowlist); the SAME operator cannot claim again within claimCooldown of its last
///     sponsored claim (release-and-reclaim churn), and nobody within minClaimInterval (admin); rate cap and the
///     minimum extension hold;
///   - renew: the current runner, inside [leaseUntil - renewWindow, leaseUntil], under the cap, minimum extension;
///   - release: the current runner, if the owner allows sponsored release (stop / move / early hand-back still work
///     with zero host ETH). A release requires a lease held, which requires a claim: releases are bounded by claims;
///   - money: per-operation cap, per-epoch cap, balance - all in finish(), after the measurement.
contract EnclaveLeaseGasReserve {
    // ---- bindings ---------------------------------------------------------------------------------------------------
    address public immutable ledger;
    IRegistryR public immutable registry;
    IL1FeeOracle public immutable l1Oracle;      // Base GasPriceOracle (0x420000000000000000000000000000000000000F) or 0
    address public executor;                     // bound once (the executor's constructor needs this address)
    bytes32 public delegationCodeHash;           // keccak256(0xef0100 || executor): an operator running the executor

    uint8 internal constant KIND_CLAIM = 1;
    uint8 internal constant KIND_RENEW = 2;
    uint8 internal constant KIND_RELEASE = 3;
    uint8 public constant POLICY_ANY = 0;
    uint8 public constant POLICY_SELF_HOSTED = 1;
    uint8 public constant POLICY_ALLOWLIST = 2;
    uint256 public constant INTRINSIC_GAS = 21_000;
    uint256 public constant CALLDATA_GAS_PER_BYTE = 16;   // upper bound (non-zero byte); EIP-7623's floor is below it here
    /// The L1 bound takes the UNSIGNED transaction size (GasPriceOracle.getL1FeeUpperBound adds 68 bytes for the signature
    /// itself). An unsigned type-2 transaction around the canonical call: type byte, list header, chain id, nonce, two
    /// fee fields, gas, `to` (21), value, the calldata's own header, an empty access list - at most 72 bytes with every
    /// variable field at its widest the relay can use.
    uint256 public constant UNSIGNED_ENVELOPE_BYTES = 72;
    /// One EIP-7702 authorization: its list header and tuple [chain id, address (21), nonce, y parity, r (33), s (33)],
    /// plus the authorization list's header - at most 105 bytes.
    uint256 public constant AUTHORIZATION_BYTES = 105;
    /// EIP-7702 PER_EMPTY_ACCOUNT_COST: charged per authorization as intrinsic gas; the 12,500 refund for an existing
    /// account is capped with every other refund of the transaction, so the gross amount is what is charged.
    uint256 public constant AUTHORIZATION_GAS = 25_000;
    /// Bound on each per-kind overhead (admin Limits). 80,000: the Base-fork calibration on the REAL rev-16d ledger needs a
    /// claim overhead above 60,000 for the relay's L2 gas alone to be covered (fixtures/base-fork-calibration-recalibrated.json).
    uint32 public constant MAX_OVERHEAD_GAS = 80_000;
    address internal constant NO_OPERATOR = address(1);       // "no sponsored claim yet" (a pre-initialized slot)

    // transient: the one operation between begin() and finish()
    bytes32 private constant T_ID = keccak256("EnclaveLeaseGasReserve.id");
    bytes32 private constant T_OP = keccak256("EnclaveLeaseGasReserve.op");      // operator | kind << 160
    bytes32 private constant T_OWNER = keccak256("EnclaveLeaseGasReserve.owner");
    bytes32 private constant T_DONE = keccak256("EnclaveLeaseGasReserve.done");   // one lease operation per transaction

    // ---- admin ------------------------------------------------------------------------------------------------------
    address public owner;
    address public pendingOwner;
    bool public paused;
    mapping(bytes32 => bool) public blockedDeployment;
    mapping(address => bool) public blockedOperator;
    struct Limits {
        uint64 maxGasPriceCeiling;   // wei; no owner cap may exceed it
        uint32 overheadClaimGas;     // per kind: the executor's entry and finish()'s own tail, net of the ledger's storage
        uint32 overheadRenewGas;     //   refunds, calibrated from receipts (see the result file); each <= MAX_OVERHEAD_GAS
        uint32 overheadReleaseGas;
        uint32 minClaimInterval;     // seconds between ANY two sponsored claims of one deployment
        uint16 l1Bps;                // share of the L1 fee upper bound charged (0 = none, 10000 = the full bound)
    }
    Limits public limits;

    // ---- reserves: ETH per (deployment id, owner of record) ----------------------------------------------------------
    struct Reserve {
        uint128 balanceWei;
        uint64 maxPerOpWei;
        uint64 epochCapWei;
        bool enabled;                // OFF until the owner authorizes
        uint8 claimPolicy;
        bool sponsorRelease;
        uint32 renewWindow;          // seconds before leaseUntil
        uint32 minExtension;         // seconds of lease a claim/renew must buy
        uint32 claimCooldown;        // seconds before the same operator may be sponsored to claim again
        uint32 epochSec;
        uint64 maxGasPrice;          // the owner's own gas price cap
        uint8 maxClaimsPerEpoch;     // sponsored claims per epoch (failover needs a few; churn gets no more)
        uint32 epochIndex;           // hot (written by finish)
        uint96 epochSpentWei;
        uint8 epochClaims;
        uint64 lastClaimAt;
        address lastClaimOperator;
    }
    /// What the owner of record sets (configure).
    struct Policy {
        bool enabled;
        uint8 claimPolicy;
        bool sponsorRelease;
        uint8 maxClaimsPerEpoch;
        uint64 maxPerOpWei;
        uint64 epochCapWei;
        uint32 epochSec;
        uint32 renewWindow;
        uint32 minExtension;
        uint32 claimCooldown;
        uint64 maxGasPrice;
    }
    mapping(bytes32 => Reserve) internal _reserves;                        // key = keccak256(abi.encode(id, owner))
    mapping(bytes32 => mapping(address => bool)) public claimantAllowed;   // key => operator => allowed (policy 2)

    enum Status {
        Ready, Paused, Blocked, Unknown, Retired, Disabled, Inactive, LeaseLive, LeaseExpired, NotRunner, NotOperator,
        ClaimantNotAllowed, ClaimCooldown, ClaimLimitReached, NotInRenewWindow, OverRateCap, ExtensionTooShort, ReleaseNotSponsored,
        EmptyReserve, EpochCapReached, BadKind, ProofKeyMissing, BondRequired
    }

    event OwnerChanged(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferStarted(address indexed owner, address indexed pendingOwner);
    event ExecutorBound(address executor, bytes32 delegationCodeHash);
    event LimitsSet(Limits limits);
    event Paused(bool paused);
    event DeploymentBlocked(bytes32 indexed id, bool blocked);
    event OperatorBlocked(address indexed operator, bool blocked);
    event Deposited(bytes32 indexed id, address indexed owner, address indexed from, uint256 amountWei);
    event ComputeFunded(bytes32 indexed id, address indexed from, uint256 amountWei);
    event Configured(bytes32 indexed id, address indexed owner, Policy policy);
    event ClaimantSet(bytes32 indexed id, address indexed owner, address indexed operator, bool allowed);
    event Withdrawn(bytes32 indexed id, address indexed owner, address to, uint256 amountWei);
    event LeaseGasPaid(bytes32 indexed id, address indexed owner, address indexed operator, address payee, uint8 kind,
                       uint256 gas, uint256 gasPrice, uint256 l1FeeWei, uint256 chargedWei);

    error Refused(Status status);

    constructor(address _ledger, IRegistryR _registry, IL1FeeOracle _l1Oracle, Limits memory _limits) {
        require(_ledger != address(0) && address(_registry) != address(0), "zero");
        ledger = _ledger;
        registry = _registry;
        l1Oracle = _l1Oracle;
        owner = msg.sender;
        emit OwnerChanged(address(0), msg.sender);
        _setLimits(_limits);
    }

    modifier onlyOwner() { require(msg.sender == owner, "!owner"); _; }

    // ========================================================================================================
    // the executor's calls (an operator key running EnclaveLeaseExecutor)
    // ========================================================================================================

    function begin(bytes32 id, uint8 kind, bytes32 enclaveId) external {
        bytes32 h;
        address op = msg.sender;
        assembly { h := extcodehash(op) }
        require(h == delegationCodeHash && h != bytes32(0), "!executor");
        require(_tload(T_ID) == 0, "busy");
        // a wrapper batching several leases into one transaction would be paid the intrinsic gas once per lease, and a
        // payee callback could start another: one lease operation per transaction, whatever calls the executor
        require(_tload(T_DONE) == 0, "one lease operation per transaction");
        (Status st, address o) = _check(id, kind, enclaveId, op);
        if (st != Status.Ready) revert Refused(st);
        _tstore(T_ID, uint256(id));
        _tstore(T_OP, uint256(uint160(op)) | (uint256(kind) << 160));
        _tstore(T_OWNER, uint256(uint160(o)));
    }

    function finish(bytes32 id, address payable payee, uint256 gasUsed, uint256 calldataLength, uint256 maxChargeWei, bool authorization) external {
        uint256 opw = _tload(T_OP);
        require(_tload(T_ID) == uint256(id) && address(uint160(opw)) == msg.sender && id != bytes32(0), "!begun");
        require(payee != address(0), "payee");
        address o = address(uint160(_tload(T_OWNER)));
        uint8 kind = uint8(opw >> 160);
        _tstore(T_ID, 0); _tstore(T_OP, 0); _tstore(T_OWNER, 0); _tstore(T_DONE, 1);

        Reserve storage r = _reserves[budgetKey(id, o)];
        uint256 price = tx.gasprice;
        if (price > r.maxGasPrice) price = r.maxGasPrice;
        if (price > limits.maxGasPriceCeiling) price = limits.maxGasPriceCeiling;
        uint256 gas = gasUsed + INTRINSIC_GAS + CALLDATA_GAS_PER_BYTE * calldataLength + _overhead(kind) + (authorization ? AUTHORIZATION_GAS : 0);
        uint256 l1 = _l1Fee(calldataLength, authorization);
        uint256 charge = gas * price + l1;
        require(charge <= r.maxPerOpWei, "over per-op cap");
        require(charge <= maxChargeWei, "over signed max charge");
        uint256 e = block.timestamp / r.epochSec;
        bool same = e == r.epochIndex;
        uint256 spent = same ? r.epochSpentWei : 0;
        require(spent + charge <= r.epochCapWei, "over epoch cap");
        require(r.balanceWei >= charge, "insufficient reserve");
        r.balanceWei -= uint128(charge);
        uint8 claims = same ? r.epochClaims : 0;
        (r.epochIndex, r.epochSpentWei) = (uint32(e), uint96(spent + charge));
        if (kind == KIND_CLAIM) (r.epochClaims, r.lastClaimAt, r.lastClaimOperator) = (claims + 1, uint64(block.timestamp), msg.sender);
        else r.epochClaims = claims;
        emit LeaseGasPaid(id, o, msg.sender, payee, kind, gas, price, l1, charge);
        (bool ok,) = payee.call{value: charge}("");
        require(ok, "payee");
    }

    // ========================================================================================================
    // the one rule set: begin() enforces it, statusOf() reports it
    // ========================================================================================================

    function _check(bytes32 id, uint8 kind, bytes32 enclaveId, address op) internal view returns (Status, address) {
        if (kind < KIND_CLAIM || kind > KIND_RELEASE) return (Status.BadKind, address(0));
        if (paused) return (Status.Paused, address(0));
        if (blockedDeployment[id] || blockedOperator[op]) return (Status.Blocked, address(0));
        ILedgerR.Deployment memory d = ILedgerR(ledger).get(id);
        if (d.id != id || id == bytes32(0)) return (Status.Unknown, address(0));
        Reserve storage r = _reserves[budgetKey(id, d.owner)];
        if (!r.enabled) return (Status.Disabled, d.owner);
        if (r.balanceWei == 0) return (Status.EmptyReserve, d.owner);
        if (block.timestamp / r.epochSec == r.epochIndex && r.epochSpentWei >= r.epochCapWei) return (Status.EpochCapReached, d.owner);
        if (kind == KIND_RELEASE) {
            if (!r.sponsorRelease) return (Status.ReleaseNotSponsored, d.owner);
            if (d.runnerOperator != op || op == address(0)) return (Status.NotRunner, d.owner);
            return (Status.Ready, d.owner);
        }
        if (ILedgerR(ledger).retired()) return (Status.Retired, d.owner);
        if (!d.active) return (Status.Inactive, d.owner);
        uint256 leaseSec = ILedgerR(ledger).leaseSec();
        uint256 cap = ILedgerR(ledger).capOf(id);
        uint256 rate;
        if (kind == KIND_CLAIM) {
            if (block.timestamp <= d.leaseUntil) return (Status.LeaseLive, d.owner);
            IRegistryR.Enclave memory e = registry.get(enclaveId);
            if (e.operator != op || !e.active) return (Status.NotOperator, d.owner);
            // the ledger's own claim gates, reported here (the ledger enforces them; a refusal there reverts everything)
            uint256 prf = ILedgerR(ledger).proofRequiredFrom();
            if (prf != 0 && block.timestamp >= prf && e.proofKey == address(0)) return (Status.ProofKeyMissing, d.owner);
            uint256 bond = ILedgerR(ledger).claimBond6();
            if (bond > 0) { (uint256 a, uint64 exitAt) = ILedgerR(ledger).bondOf(op); if (a < bond || exitAt != 0) return (Status.BondRequired, d.owner); }
            if (r.claimPolicy == POLICY_SELF_HOSTED ? e.payoutWallet != d.owner
                : r.claimPolicy == POLICY_ALLOWLIST && !claimantAllowed[budgetKey(id, d.owner)][op]) return (Status.ClaimantNotAllowed, d.owner);
            if (block.timestamp / r.epochSec == r.epochIndex && r.epochClaims >= r.maxClaimsPerEpoch) return (Status.ClaimLimitReached, d.owner);
            if (r.lastClaimAt > 1 && (block.timestamp < uint256(r.lastClaimAt) + limits.minClaimInterval
                || (op == r.lastClaimOperator && block.timestamp < uint256(r.lastClaimAt) + r.claimCooldown))) return (Status.ClaimCooldown, d.owner);
            rate = ILedgerR(ledger).rateFor(id, enclaveId);
        } else {
            if (d.runnerOperator != op) return (Status.NotRunner, d.owner);
            if (block.timestamp > d.leaseUntil) return (Status.LeaseExpired, d.owner);
            if (block.timestamp + r.renewWindow < d.leaseUntil) return (Status.NotInRenewWindow, d.owner);
            rate = d.rate;
        }
        if (cap != 0 && rate > cap) return (Status.OverRateCap, d.owner);
        uint256 secs = rate == 0 ? leaseSec : d.balance6 / rate;
        if (secs > leaseSec) secs = leaseSec;
        if (secs == 0 || secs < r.minExtension) return (Status.ExtensionTooShort, d.owner);
        return (Status.Ready, d.owner);
    }

    /// @notice POLICY ELIGIBILITY: whether `operator` may run `kind` on `id` right now under this reserve's rules and
    ///         the ledger's claim gates it can see (proof key, claim bond). It is NOT a promise the operation lands: the
    ///         MONEY is checked in finish() against the actual measured charge (balance, per-op cap, epoch cap, the
    ///         signed maximum), and the ledger stays the authority on its own conditions. A client's executable
    ///         preflight is a simulation of the exact relay transaction (network/lease-executor-client.mjs).
    function statusOf(bytes32 id, uint8 kind, bytes32 enclaveId, address operator)
        external view returns (Status status, uint256 availableWei, uint256 epochLeftWei, uint256 maxPerOpWei)
    {
        address o;
        (status, o) = _check(id, kind, enclaveId, operator);
        if (o != address(0)) {
            Reserve storage r = _reserves[budgetKey(id, o)];
            availableWei = r.balanceWei;
            uint256 spent = r.epochSec != 0 && block.timestamp / r.epochSec == r.epochIndex ? r.epochSpentWei : 0;
            epochLeftWei = r.epochCapWei > spent ? r.epochCapWei - spent : 0;
            maxPerOpWei = r.maxPerOpWei;
        }
    }

    /// @notice What finish() would charge for `gas` (as measured by the executor) and `calldataLength`, at `gasPrice`.
    function quote(bytes32 id, address owner_, uint8 kind, uint256 gasUsed, uint256 calldataLength, uint256 gasPrice, bool authorization)
        external view returns (uint256 chargeWei, uint256 l1FeeWei)
    {
        Reserve storage r = _reserves[budgetKey(id, owner_)];
        uint256 price = gasPrice;
        if (price > r.maxGasPrice) price = r.maxGasPrice;
        if (price > limits.maxGasPriceCeiling) price = limits.maxGasPriceCeiling;
        l1FeeWei = _l1Fee(calldataLength, authorization);
        chargeWei = (gasUsed + INTRINSIC_GAS + CALLDATA_GAS_PER_BYTE * calldataLength + _overhead(kind) + (authorization ? AUTHORIZATION_GAS : 0)) * price + l1FeeWei;
    }

    // ========================================================================================================
    // app owners
    // ========================================================================================================

    function budgetKey(bytes32 id, address owner_) public pure returns (bytes32) { return keccak256(abi.encode(id, owner_)); }
    function reserveOf(bytes32 id, address owner_) external view returns (Reserve memory) { return _reserves[budgetKey(id, owner_)]; }

    /// @notice Add ETH to the reserve of `id`'s CURRENT owner of record (anyone may pay).
    function deposit(bytes32 id) external payable {
        require(msg.value > 0 && msg.value <= type(uint96).max, "amount");
        address o = _ownerOf(id);
        _reserves[budgetKey(id, o)].balanceWei += uint128(msg.value);
        emit Deposited(id, o, msg.sender, msg.value);
    }

    /// @notice One payment, two destinations: `computeWei` to the ledger's own fundEth(id) (credited at the ledger's
    ///         oracle exactly as if the caller funded it), the rest to the gas reserve.
    function depositAndFundCompute(bytes32 id, uint256 computeWei) external payable {
        require(msg.value > computeWei, "amount");
        address o = _ownerOf(id);
        if (computeWei > 0) {
            ILedgerR(ledger).fundEth{value: computeWei}(id);
            emit ComputeFunded(id, msg.sender, computeWei);
        }
        uint256 rest = msg.value - computeWei;
        _reserves[budgetKey(id, o)].balanceWei += uint128(rest);
        emit Deposited(id, o, msg.sender, rest);
    }

    /// @notice The owner of record authorizes (or stops) sponsorship, with its policy and caps. A SessionVault owner
    ///         does this through its vault's ownerCall(reserve, configure(...)): msg.sender is then the vault.
    function configure(bytes32 id, Policy calldata p) external {
        require(_ownerOf(id) == msg.sender, "!owner");
        require(p.claimPolicy <= POLICY_ALLOWLIST && p.maxPerOpWei <= p.epochCapWei && p.epochSec >= 600 && p.epochSec <= 30 days, "bad config");
        require(p.renewWindow >= 30 && p.renewWindow <= 1 days && p.minExtension >= 1, "bad window");
        Reserve storage r = _reserves[budgetKey(id, msg.sender)];
        (r.enabled, r.claimPolicy, r.sponsorRelease, r.maxClaimsPerEpoch, r.maxPerOpWei, r.epochCapWei) =
            (p.enabled, p.claimPolicy, p.sponsorRelease, p.maxClaimsPerEpoch, p.maxPerOpWei, p.epochCapWei);
        if (r.epochSec != p.epochSec) { r.epochSec = p.epochSec; r.epochIndex = 0; r.epochSpentWei = 0; r.epochClaims = 0; }
        (r.renewWindow, r.minExtension, r.claimCooldown, r.maxGasPrice) = (p.renewWindow, p.minExtension, p.claimCooldown, p.maxGasPrice);
        // pre-initialize the slots finish() writes (sentinels that mean "none"), so the OWNER pays their one-time
        // creation here and every relayed operation has the same, calibrated tail
        if (r.lastClaimAt == 0) r.lastClaimAt = 1;
        if (r.lastClaimOperator == address(0)) r.lastClaimOperator = NO_OPERATOR;
        emit Configured(id, msg.sender, p);
    }

    function setClaimant(bytes32 id, address operator, bool allowed) external {
        require(_ownerOf(id) == msg.sender, "!owner");
        claimantAllowed[budgetKey(id, msg.sender)][operator] = allowed;
        emit ClaimantSet(id, msg.sender, operator, allowed);
    }

    /// @notice Withdraw from the caller's own reserve for `id` (keyed to the caller: a previous owner keeps what it put
    ///         in, and that reserve is never charged for a new owner's leases). No ledger read: works after migration.
    function withdraw(bytes32 id, uint256 amountWei, address payable to) external {
        require(_tload(T_ID) == 0, "busy");              // never between an operation's begin and finish
        Reserve storage r = _reserves[budgetKey(id, msg.sender)];
        require(r.balanceWei >= amountWei, "short");
        r.balanceWei -= uint128(amountWei);
        emit Withdrawn(id, msg.sender, to, amountWei);
        (bool ok,) = to.call{value: amountWei}("");
        require(ok, "send");
    }

    // ========================================================================================================
    // admin: limits, moderation, the one-time executor binding. No path to any reserve.
    // ========================================================================================================

    function bindExecutor(address _executor) external onlyOwner {
        require(executor == address(0) && _executor != address(0), "bound");
        require(IExecutorR(_executor).reserve() == address(this), "executor of another reserve");
        executor = _executor;
        delegationCodeHash = keccak256(abi.encodePacked(hex"ef0100", _executor));
        emit ExecutorBound(_executor, delegationCodeHash);
    }
    function setLimits(Limits calldata l) external onlyOwner { _setLimits(l); }
    function setPaused(bool p) external onlyOwner { paused = p; emit Paused(p); }
    function setBlockedDeployment(bytes32 id, bool b) external onlyOwner { blockedDeployment[id] = b; emit DeploymentBlocked(id, b); }
    function setBlockedOperator(address op, bool b) external onlyOwner { blockedOperator[op] = b; emit OperatorBlocked(op, b); }
    function transferOwnership(address next) external onlyOwner { pendingOwner = next; emit OwnershipTransferStarted(owner, next); }
    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "!pending");
        emit OwnerChanged(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ========================================================================================================
    // internals
    // ========================================================================================================

    function _overhead(uint8 kind) internal view returns (uint256) {
        return kind == KIND_CLAIM ? limits.overheadClaimGas : kind == KIND_RENEW ? limits.overheadRenewGas : limits.overheadReleaseGas;
    }

    function _l1Fee(uint256 calldataLength, bool authorization) internal view returns (uint256) {
        if (address(l1Oracle) == address(0) || limits.l1Bps == 0) return 0;
        uint256 unsignedSize = calldataLength + UNSIGNED_ENVELOPE_BYTES + (authorization ? AUTHORIZATION_BYTES : 0);
        return l1Oracle.getL1FeeUpperBound(unsignedSize) * limits.l1Bps / 10_000;
    }

    function _ownerOf(bytes32 id) internal view returns (address) {
        ILedgerR.Deployment memory d = ILedgerR(ledger).get(id);
        require(d.id == id && id != bytes32(0), "unknown");
        return d.owner;
    }

    function _setLimits(Limits memory l) internal {
        require(l.overheadClaimGas <= MAX_OVERHEAD_GAS && l.overheadRenewGas <= MAX_OVERHEAD_GAS && l.overheadReleaseGas <= MAX_OVERHEAD_GAS
                && l.l1Bps <= 10_000 && l.maxGasPriceCeiling > 0, "ceiling");
        limits = l;
        emit LimitsSet(l);
    }

    function _tload(bytes32 slot) private view returns (uint256 v) { assembly { v := tload(slot) } }
    function _tstore(bytes32 slot, uint256 v) private { assembly { tstore(slot, v) } }
}

interface ILedgerR {
    struct Deployment {
        bytes32 id; address owner; string appRef; string ports; string configCid;
        uint16 gpuMilli; uint16 cpuMilli; uint32 appPort; bool isPublic; bool active; uint64 createdAt;
        uint256 rate; uint256 balance6; uint256 spent6;
        bytes32 runner; address runnerOperator; uint64 leaseUntil;
    }
    function get(bytes32 id) external view returns (Deployment memory);
    function rateFor(bytes32 id, bytes32 enclaveId) external view returns (uint256);
    function capOf(bytes32 id) external view returns (uint256);
    function leaseSec() external view returns (uint64);
    function retired() external view returns (bool);
    function proofRequiredFrom() external view returns (uint64);
    function claimBond6() external view returns (uint256);
    function bondOf(address operator) external view returns (uint256 amount6, uint64 exitAt);
    function fundEth(bytes32 id) external payable;
}

interface IRegistryR {
    struct Enclave {
        string endpoint; string repo; bytes32 measurement; address operator; uint64 registeredAt; uint64 lastSeen;
        bool active; uint64 cpuPricePerSec6; uint64 gpuPricePerSec6; address proofKey; address payoutWallet;
    }
    function get(bytes32 id) external view returns (Enclave memory);
}

interface IL1FeeOracle { function getL1FeeUpperBound(uint256 unsignedTxSize) external view returns (uint256); }
interface IExecutorR { function reserve() external view returns (address); }
