// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title EnclaveLeaseGasPaymaster - an application's own gas budget pays its host's lease claim and renew.
///
/// PROTOTYPE (work/app-lease-gas). Additive: the ledger (EnclaveDeployments rev 16d), the registry (schema 4) and the
/// existing EnclaveHostPaymaster are used exactly as deployed and never changed, and no existing balance is moved.
///
/// Why this shape:
///   - claim(id, enclaveId) and renew(id) authenticate the host by msg.sender (the registry operator / the current
///     runner). A host with no ETH can still be that msg.sender if its operator key is delegated (EIP-7702) to the
///     standard Simple7702Account and the ERC-4337 EntryPoint v0.8 runs execute(ledger, 0, claim|renew) from it, with
///     a paymaster paying. Exactly the pattern EnclaveHostPaymaster already uses for a host's first register().
///   - The ledger has no hook through which a companion could spend a deployment's balance6 / escrow, so an app's gas
///     must come from a NEW, explicitly funded budget: USDC per (deployment id, owner of record), opt-in, capped.
///   - Someone must front ETH: SPONSORS (any address; not one relayer) deposit ETH that the EntryPoint uses to repay
///     bundlers. Each operation names its sponsor; the sponsor is reimbursed in USDC from the app's budget at the
///     configured Chainlink ETH/USD price plus a bounded markup. Hosts never hold ETH or USDC for this.
///
/// ERC-7562 (validation scope rules), checked against the spec text:
///   - TIMESTAMP/NUMBER are blocked in validation (OP-011): every time condition - claim only after the lease expired,
///     renew only inside the owner's window before expiry, price freshness, the spend epoch, the proof cutover - is
///     returned as validAfter/validUntil and enforced by the EntryPoint.
///   - This paymaster writes only its own (transient) storage in validation (STO-031; OP-070 treats TLOAD/TSTORE as
///     storage) and READS the ledger, the registry and the price feed (STO-033). Both are allowed ONLY for a STAKED
///     paymaster: it must hold an EntryPoint stake >= the canonical mempool's MIN_STAKE_VALUE with an unstake delay >=
///     1 day, or canonical-mempool bundlers will refuse its operations.
///   - The 7702-delegated sender is accessed only as the sender (AUTH-030): EXTCODEHASH(sender).
///   - A negotiated job rate (ledger _jobRates) makes rateFor() execute TIMESTAMP; such a claim violates OP-011 and is
///     refused by a 7562-enforcing bundler (a direct handleOps submitter still accepts it).
///
/// Reservations are TRANSIENT (EIP-1153). Validation and postOp of every operation run inside ONE handleOps
/// transaction, and a later transaction's validation already sees the charges earlier ones committed, so nothing has
/// to stay reserved across transactions. What reservations prevent is several operations of one bundle overcommitting
/// a budget, an epoch cap or a sponsor, and two operations of one bundle on the same deployment (a claim race). Only
/// actual charges are persisted, in postOp - which is written so it cannot revert (bounded arithmetic, no external
/// calls, withdrawals net of in-transaction reservations, and a postOp gas floor the admin sets above its measured
/// worst case: see work/claude-app-lease-gas-result.txt): if it did, the EntryPoint would still take the cost from the
/// deposit without this bookkeeping seeing it.
contract EnclaveLeaseGasPaymaster {
    // ---- EntryPoint v0.8 types (inlined, as in EnclaveHostPaymaster) --------------------------------------------------
    struct PackedUserOperation {
        address sender;
        uint256 nonce;
        bytes initCode;
        bytes callData;
        bytes32 accountGasLimits;
        uint256 preVerificationGas;
        bytes32 gasFees;
        bytes paymasterAndData;
        bytes signature;
    }
    enum PostOpMode { opSucceeded, opReverted, postOpReverted }

    // ---- bindings (immutable: chain via the EntryPoint's userOpHash, ledger and registry here) ----------------------
    IEntryPointLease public immutable entryPoint;
    ILedgerLease public immutable ledger;
    IRegistryLease public immutable registry;
    IERC20Lease public immutable usdc;
    address public immutable account7702;            // Simple7702Account the operator key must be delegated to
    bytes32 public immutable delegationCodeHash;     // keccak256(0xef0100 || account7702): EXTCODEHASH of a delegated EOA
    uint256 public immutable epochSec;               // length of a spend-cap epoch

    bytes4 private constant EXECUTE = 0xb61d27f6;    // execute(address,uint256,bytes)
    bytes4 private constant CLAIM = ILedgerLease.claim.selector;   // claim(bytes32,bytes32) = 0x84cc9dfb
    bytes4 private constant RENEW = ILedgerLease.renew.selector;   // renew(bytes32) = 0x8e32762d
    uint256 private constant PMD_OFFSET = 52;        // paymaster(20) | verificationGasLimit(16) | postOpGasLimit(16)
    uint256 private constant PMD_LENGTH = 24;        // sponsor(20) | epoch(4)
    uint8 internal constant KIND_CLAIM = 1;
    uint8 internal constant KIND_RENEW = 2;

    // transient (EIP-1153) bookkeeping of ONE handleOps transaction; slot = keccak256(tag, key...)
    bytes32 private constant T_OP = keccak256("EnclaveLeaseGasPaymaster.op");             // id -> the operation (3 words)
    bytes32 private constant T_BUDGET = keccak256("EnclaveLeaseGasPaymaster.budget");     // budget key -> reserved6
    bytes32 private constant T_EPOCH = keccak256("EnclaveLeaseGasPaymaster.epoch");       // budget key, epoch -> reserved6
    bytes32 private constant T_SPONSOR = keccak256("EnclaveLeaseGasPaymaster.sponsor");   // sponsor -> reserved wei

    // hard ceilings no admin setting can exceed
    uint16 public constant MAX_MARKUP_BPS = 2000;    // 20%
    uint32 public constant MAX_POSTOP_CHARGE_GAS = 100_000;
    /// @notice Gas postOp's reverted-operation path spends on the failure counter (a fresh slot) on top of postOpChargeGas.
    uint32 public constant POSTOP_FAILURE_EXTRA_GAS = 25_000;

    // ---- admin (platform governance) --------------------------------------------------------------------------------
    address public owner;
    address public pendingOwner;
    bool public paused;
    mapping(bytes32 => bool) public blockedDeployment;   // moderation: a delisted / abusive app
    mapping(address => bool) public blockedOperator;     // moderation: a banned host

    struct Limits {
        uint64 maxFeePerGas;           // wei
        uint64 maxPriorityFeePerGas;   // wei
        uint32 maxVerificationGas;     // the account's validation
        uint32 minCallGas;             // below this a claim/renew would run out of gas on purpose
        uint32 maxCallGas;
        uint32 maxPreVerificationGas;  // covers the bundler's calldata / L1 data fee and the 7702 authorization
        uint32 maxPaymasterVerificationGas;
        uint32 minPostOpGas;           // postOp must never run out of gas (it must never revert)
        uint32 maxPostOpGas;
        uint32 postOpChargeGas;        // gas charged for postOp itself (it runs after actualGasCost is measured)
        uint16 markupBps;              // sponsor's margin over the oracle price, <= MAX_MARKUP_BPS
        uint32 minRenewWindow;         // owner's renew window bounds (seconds before leaseUntil)
        uint32 maxRenewWindow;
        uint32 minExtensionFloor;      // owner's minimum-extension floor (seconds)
        uint8 maxFailures;             // reverted sponsored ops per (deployment, operator) before it is cut off
    }
    Limits public limits;

    IFeedLease public feed;            // Chainlink ETH/USD (8 decimals), the same feed the ledger uses for fundEth
    uint32 public feedMaxAge;          // seconds; enforced as validUntil = updatedAt + feedMaxAge
    uint256 public minPrice8;          // sanity bounds on the answer
    uint256 public maxPrice8;

    // ---- application budgets: USDC per (deployment id, owner of record) --------------------------------------------
    struct Budget {
        uint128 balance6;              // USDC held here for this (deployment, owner)
        uint64 maxPerOp6;              // the most one operation may reserve
        uint64 epochCap6;              // the most all operations may be charged (+ reserve, within a bundle) per epoch
        bool enabled;                  // OFF until the owner authorizes sponsorship
        uint32 renewWindow;            // renew is sponsored only within this many seconds before leaseUntil
        uint32 minExtension;           // a claim/renew must buy at least this many seconds of lease
    }
    mapping(bytes32 => Budget) internal _budgets;                         // key = keccak256(abi.encode(id, owner))
    mapping(bytes32 => mapping(uint256 => uint256)) public epochSpent6;   // key => epoch => charged
    mapping(bytes32 => mapping(address => uint8)) public failures;        // id => operator => consecutive reverted ops

    // ---- sponsors: ETH fronted through the EntryPoint deposit, reimbursed in USDC ----------------------------------
    struct Sponsor {
        uint128 eth;                   // this sponsor's share of the EntryPoint deposit (wei)
        uint128 earned6;               // USDC reimbursed, withdrawable
        bool active;
    }
    mapping(address => Sponsor) public sponsors;
    uint256 public totalSponsorEth;    // sum of sponsors[*].eth; the deposit above it is surplus (see sweepSurplus)

    // ---- events ----------------------------------------------------------------------------------------------------
    event OwnerChanged(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferStarted(address indexed owner, address indexed pendingOwner);
    event LimitsSet(Limits limits);
    event FeedSet(address feed, uint32 maxAge, uint256 minPrice8, uint256 maxPrice8);
    event Paused(bool paused);
    event DeploymentBlocked(bytes32 indexed id, bool blocked);
    event OperatorBlocked(address indexed operator, bool blocked);
    event BudgetFunded(bytes32 indexed id, address indexed owner, address indexed payer, uint256 amount6);
    event ComputeFunded(bytes32 indexed id, address indexed payer, uint256 amount6);
    event BudgetConfigured(bytes32 indexed id, address indexed owner, bool enabled, uint64 maxPerOp6, uint64 epochCap6,
                           uint32 renewWindow, uint32 minExtension);
    event BudgetWithdrawn(bytes32 indexed id, address indexed owner, address to, uint256 amount6);
    event FailuresReset(bytes32 indexed id, address indexed operator);
    event SponsorDeposited(address indexed sponsor, uint256 amountWei);
    event SponsorActive(address indexed sponsor, bool active);
    event SponsorWithdrawn(address indexed sponsor, address to, uint256 amountWei, uint256 amount6);
    event LeaseGasCharged(bytes32 indexed id, address indexed owner, address indexed operator, address sponsor, uint8 kind,
                          bool succeeded, uint256 chargedWei, uint256 charged6);
    event SurplusSwept(address to, uint256 amountWei);

    constructor(IEntryPointLease _entryPoint, ILedgerLease _ledger, IRegistryLease _registry, IERC20Lease _usdc,
                address _account7702, uint256 _epochSec, IFeedLease _feed, uint32 _feedMaxAge, uint256 _minPrice8,
                uint256 _maxPrice8, Limits memory _limits)
    {
        require(address(_entryPoint) != address(0) && address(_ledger) != address(0) && address(_registry) != address(0)
                && address(_usdc) != address(0) && _account7702 != address(0), "zero");
        require(_epochSec >= 600 && _epochSec <= 30 days, "epoch");
        entryPoint = _entryPoint;
        ledger = _ledger;
        registry = _registry;
        usdc = _usdc;
        account7702 = _account7702;
        delegationCodeHash = keccak256(abi.encodePacked(hex"ef0100", _account7702));
        epochSec = _epochSec;
        owner = msg.sender;
        emit OwnerChanged(address(0), msg.sender);
        _setFeed(_feed, _feedMaxAge, _minPrice8, _maxPrice8);
        _setLimits(_limits);
    }

    modifier onlyOwner() { require(msg.sender == owner, "!owner"); _; }
    modifier onlyEntryPoint() { require(msg.sender == address(entryPoint), "!entryPoint"); _; }

    // ========================================================================================================
    // the EntryPoint's calls
    // ========================================================================================================

    /// @notice Sponsor this operation only if it is exactly execute(ledger, 0, claim(id, enclaveId) | renew(id)) from an
    ///         operator delegated to Simple7702Account, the ledger and registry say this sender may do it, the app's
    ///         owner enabled a budget that covers the worst case under its caps, and the named sponsor's ETH covers
    ///         maxCost. Reserves all three for this transaction; postOp charges the actual cost. Every broken rule reverts.
    function validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32, uint256 maxCost)
        external onlyEntryPoint returns (bytes memory context, uint256 validationData)
    {
        require(!paused, "paused");
        (address sponsor, uint32 epoch, uint256 extraGas) = _checkGas(userOp, maxCost);
        require(userOp.initCode.length == 0, "initCode");
        bytes32 codeHash;
        address sender = userOp.sender;
        assembly { codeHash := extcodehash(sender) }
        require(codeHash == delegationCodeHash, "!delegated");
        (uint8 kind, bytes32 id, bytes32 enclaveId) = _parseCall(userOp.callData);
        require(!blockedDeployment[id] && !blockedOperator[sender], "blocked");
        bytes32 opSlot = _slot(T_OP, id);
        require(_tload(opSlot) == 0, "in flight");
        require(failures[id][sender] < limits.maxFailures, "operator failures");

        ILedgerLease.Deployment memory d = ledger.get(id);
        require(d.id == id && d.active && !ledger.retired(), "inactive");
        bytes32 key = budgetKey(id, d.owner);
        Budget storage b = _budgets[key];
        require(b.enabled, "budget disabled");

        (uint256 validAfter, uint256 validUntil) = _eligibility(kind, id, enclaveId, sender, d, b);
        uint256 price8;
        {
            // fresh = [updatedAt, updatedAt + feedMaxAge]: a feed reporting a FUTURE updatedAt cannot stretch freshness,
            // because the operation is not valid before updatedAt either (TIMESTAMP is banned here; the EntryPoint checks)
            uint256 updatedAt; (price8, updatedAt) = _price();
            if (updatedAt + feedMaxAge < validUntil) validUntil = updatedAt + feedMaxAge;
            if (validAfter < updatedAt - 1) validAfter = updatedAt - 1;
        }
        {
            // the EntryPoint accepts only validAfter < block.timestamp <= validUntil: the epoch is [eStart, eEnd]
            uint256 eStart = uint256(epoch) * epochSec;
            uint256 eEnd = eStart + epochSec - 1;
            if (eStart > 0 && validAfter < eStart - 1) validAfter = eStart - 1;
            if (eEnd < validUntil) validUntil = eEnd;
        }
        require(validAfter < validUntil && validUntil <= type(uint48).max, "no valid window");

        uint256 reserve6 = toUsdc(maxCost, price8);
        require(maxCost <= type(uint96).max && reserve6 <= b.maxPerOp6, "over per-op cap");
        _reserve(key, epoch, b, reserve6, sponsor, maxCost);
        _tstore(opSlot, uint256(uint160(d.owner)) | (reserve6 << 160) | (uint256(epoch) << 224));
        _tstore(bytes32(uint256(opSlot) + 1), uint256(uint160(sponsor)) | (uint256(kind) << 160));
        _tstore(bytes32(uint256(opSlot) + 2), uint256(uint160(sender)) | (maxCost << 160));
        context = abi.encode(id, price8, extraGas);
        validationData = (validUntil << 160) | (validAfter << 208);
    }

    /// @notice Settle: charge the app the measured cost (actualGasCost + this postOp + the EntryPoint's worst-case
    ///         unused-gas penalty, never above what was reserved), reimburse the sponsor in USDC, release the rest of
    ///         the reservation. A reverted claim/renew is charged too (it consumed gas) and counts against that operator
    ///         for this deployment; a success resets the count. Cannot revert (see the contract notes).
    function postOp(PostOpMode mode, bytes calldata context, uint256 actualGasCost, uint256 actualUserOpFeePerGas)
        external onlyEntryPoint
    {
        (bytes32 id, uint256 price8, uint256 extraGas) = abi.decode(context, (bytes32, uint256, uint256));
        bytes32 opSlot = _slot(T_OP, id);
        uint256 w0 = _tload(opSlot);
        if (w0 == 0) return;
        uint256 w1 = _tload(bytes32(uint256(opSlot) + 1));
        uint256 w2 = _tload(bytes32(uint256(opSlot) + 2));
        _tstore(opSlot, 0); _tstore(bytes32(uint256(opSlot) + 1), 0); _tstore(bytes32(uint256(opSlot) + 2), 0);
        address owner_ = address(uint160(w0));
        uint256 reserved6 = uint64(w0 >> 160);
        uint256 epoch = uint32(w0 >> 224);
        address sponsor = address(uint160(w1));
        uint8 kind = uint8(w1 >> 160);
        address operator = address(uint160(w2));
        uint256 reservedWei = w2 >> 160;

        bytes32 key = budgetKey(id, owner_);
        _release(key, epoch, reserved6, sponsor, reservedWei);
        bool ok = mode == PostOpMode.opSucceeded;
        uint256 chargeWei = actualGasCost + (extraGas + (ok ? 0 : POSTOP_FAILURE_EXTRA_GAS)) * actualUserOpFeePerGas;
        if (chargeWei > reservedWei) chargeWei = reservedWei;
        uint256 charge6 = toUsdc(chargeWei, price8);
        if (charge6 > reserved6) charge6 = reserved6;

        // reserved6 <= the budget's balance and reservedWei <= the sponsor's ETH were checked in validation, nothing in
        // between can lower them (withdrawals are other transactions), so none of these can underflow
        _budgets[key].balance6 -= uint128(charge6);
        epochSpent6[key][epoch] += charge6;
        Sponsor storage s = sponsors[sponsor];
        s.eth -= uint128(chargeWei);
        s.earned6 += uint128(charge6);
        totalSponsorEth -= chargeWei;

        if (ok) { if (failures[id][operator] != 0) failures[id][operator] = 0; }
        else if (failures[id][operator] < type(uint8).max) failures[id][operator] += 1;
        emit LeaseGasCharged(id, owner_, operator, sponsor, kind, ok, chargeWei, charge6);
    }

    // ========================================================================================================
    // validation helpers (no TIMESTAMP/NUMBER anywhere on these paths)
    // ========================================================================================================

    /// @dev The ledger's own conditions, re-checked from its state so a sponsored operation does not revert there.
    ///      Time conditions come back as the window the EntryPoint enforces.
    function _eligibility(uint8 kind, bytes32 id, bytes32 enclaveId, address sender, ILedgerLease.Deployment memory d,
                          Budget storage b) private view returns (uint256 validAfter, uint256 validUntil)
    {
        uint256 leaseSec = ledger.leaseSec();
        uint256 cap = ledger.capOf(id);
        validUntil = type(uint48).max;
        if (kind == KIND_CLAIM) {
            IRegistryLease.Enclave memory e = registry.get(enclaveId);
            require(e.operator == sender && e.active && e.cpuPricePerSec6 > 0, "not runner");
            uint256 prf = ledger.proofRequiredFrom();
            if (e.proofKey == address(0) && prf != 0) { require(prf > 1, "no proof key"); validUntil = prf - 1; }
            uint256 bond = ledger.claimBond6();
            if (bond > 0) { (uint256 a, uint64 exitAt) = ledger.bondOf(sender); require(a >= bond && exitAt == 0, "bond required"); }
            uint256 rate = ledger.rateFor(id, enclaveId);
            require(cap == 0 || rate <= cap, "over rate cap");
            _requireExtension(rate, d.balance6, leaseSec, b.minExtension);
            validAfter = d.leaseUntil;                         // claim: only once block.timestamp > leaseUntil
        } else {
            require(d.runnerOperator == sender, "not runner");
            require(cap == 0 || d.rate <= cap, "over rate cap");
            _requireExtension(d.rate, d.balance6, leaseSec, b.minExtension);
            require(uint256(b.renewWindow) * 2 <= leaseSec && d.leaseUntil > b.renewWindow, "renew window");
            validAfter = d.leaseUntil - b.renewWindow;         // renew: only inside the window before expiry ...
            validUntil = d.leaseUntil;                         // ... and never after it (the ledger refuses that)
        }
    }

    /// @dev What the lease purchase buys: rate 0 (self-hosted) always a full quantum; otherwise the balance-limited
    ///      quantum, which must reach the owner's minimum so a host cannot spend gas on one-second leases.
    function _requireExtension(uint256 rate, uint256 balance6, uint256 leaseSec, uint256 minExtension) private pure {
        uint256 secs = rate == 0 ? leaseSec : balance6 / rate;
        if (secs > leaseSec) secs = leaseSec;
        require(secs > 0 && secs >= minExtension, "extension too short");
    }

    /// @dev Budget, epoch cap and sponsor ETH, each net of what earlier operations of this bundle already reserved.
    function _reserve(bytes32 key, uint256 epoch, Budget storage b, uint256 reserve6, address sponsor, uint256 maxCost) private {
        bytes32 bs = _slot(T_BUDGET, key);
        uint256 bRes = _tload(bs) + reserve6;
        require(b.balance6 >= bRes, "insufficient budget");
        bytes32 es = _slot2(T_EPOCH, key, epoch);
        uint256 eRes = _tload(es) + reserve6;
        require(epochSpent6[key][epoch] + eRes <= b.epochCap6, "over epoch cap");
        Sponsor storage s = sponsors[sponsor];
        bytes32 ss = _slot(T_SPONSOR, bytes32(uint256(uint160(sponsor))));
        uint256 sRes = _tload(ss) + maxCost;
        require(s.active && s.eth >= sRes, "sponsor");
        _tstore(bs, bRes); _tstore(es, eRes); _tstore(ss, sRes);
    }

    function _release(bytes32 key, uint256 epoch, uint256 reserve6, address sponsor, uint256 maxCost) private {
        bytes32 bs = _slot(T_BUDGET, key);
        bytes32 es = _slot2(T_EPOCH, key, epoch);
        bytes32 ss = _slot(T_SPONSOR, bytes32(uint256(uint160(sponsor))));
        _tstore(bs, _tload(bs) - reserve6); _tstore(es, _tload(es) - reserve6); _tstore(ss, _tload(ss) - maxCost);
    }

    /// @dev Exactly execute(ledger, 0, claim(id, enclaveId)) or execute(ledger, 0, renew(id)), canonically encoded,
    ///      byte for byte: no other target or function, no value, no batch, no trailing bytes.
    function _parseCall(bytes calldata cd) private view returns (uint8 kind, bytes32 id, bytes32 enclaveId) {
        require(cd.length >= 4 + 32 * 4 + 32 && bytes4(cd[0:4]) == EXECUTE, "!execute");
        bytes4 sel = bytes4(cd[4 + 128:4 + 132]);
        id = bytes32(cd[4 + 132:4 + 164]);
        bytes memory inner;
        if (sel == CLAIM) {
            kind = KIND_CLAIM;
            require(cd.length == 4 + 128 + 96, "!claim");
            enclaveId = bytes32(cd[4 + 164:4 + 196]);
            inner = abi.encodeWithSelector(CLAIM, id, enclaveId);
        } else if (sel == RENEW) {
            kind = KIND_RENEW;
            require(cd.length == 4 + 128 + 64, "!renew");
            inner = abi.encodeWithSelector(RENEW, id);
        } else revert("!lease call");
        require(keccak256(cd) == keccak256(abi.encodeWithSelector(EXECUTE, address(ledger), uint256(0), inner)), "!canonical");
    }

    /// @dev Gas fields within the configured bounds; returns the paymaster data and the gas postOp adds to the charge:
    ///      postOp itself and the EntryPoint's tail after it (postOpChargeGas, calibrated). MEASURED on this EntryPoint
    ///      v0.8 runtime (forge test_measure_noCallPenalty_postOpTail): no unused-gas penalty was charged even for 200k
    ///      unused call gas, so no penalty bound is added (it was pure over-charge in the first draft).
    function _checkGas(PackedUserOperation calldata op, uint256 maxCost)
        private view returns (address sponsor, uint32 epoch, uint256 extraGas)
    {
        bytes calldata pnd = op.paymasterAndData;
        require(pnd.length == PMD_OFFSET + PMD_LENGTH, "paymasterData");
        sponsor = address(bytes20(pnd[PMD_OFFSET:PMD_OFFSET + 20]));
        epoch = uint32(bytes4(pnd[PMD_OFFSET + 20:PMD_OFFSET + 24]));
        uint256 pmVerification = uint128(bytes16(pnd[20:36]));
        uint256 postOpGas = uint128(bytes16(pnd[36:52]));
        uint256 verification = uint256(op.accountGasLimits) >> 128;
        uint256 callGas = uint128(uint256(op.accountGasLimits));
        uint256 priority = uint256(op.gasFees) >> 128;
        uint256 maxFee = uint128(uint256(op.gasFees));
        Limits memory l = limits;
        require(maxFee <= l.maxFeePerGas && priority <= l.maxPriorityFeePerGas && priority <= maxFee, "fees");
        require(verification <= l.maxVerificationGas, "verification gas");
        require(callGas >= l.minCallGas && callGas <= l.maxCallGas, "call gas");
        require(op.preVerificationGas <= l.maxPreVerificationGas, "preVerification gas");
        require(pmVerification <= l.maxPaymasterVerificationGas, "paymaster gas");
        require(postOpGas >= l.minPostOpGas && postOpGas <= l.maxPostOpGas, "postOp gas");
        require(maxCost <= (verification + callGas + op.preVerificationGas + pmVerification + postOpGas) * maxFee, "maxCost");
        extraGas = uint256(l.postOpChargeGas);
    }

    /// @dev The feed's answer and its updatedAt; TIMESTAMP-free (freshness becomes the caller's validAfter/validUntil).
    function _price() private view returns (uint256 price8, uint256 updatedAt) {
        uint80 roundId; int256 answer; uint80 answeredInRound;
        (roundId, answer,, updatedAt, answeredInRound) = feed.latestRoundData();
        require(answer > 0 && answeredInRound >= roundId && updatedAt != 0, "price");
        price8 = uint256(answer);
        require(price8 >= minPrice8 && price8 <= maxPrice8, "price bounds");
    }

    function _slot(bytes32 tag, bytes32 k) private pure returns (bytes32) { return keccak256(abi.encode(tag, k)); }
    function _slot2(bytes32 tag, bytes32 k, uint256 n) private pure returns (bytes32) { return keccak256(abi.encode(tag, k, n)); }
    function _tload(bytes32 slot) private view returns (uint256 v) { assembly { v := tload(slot) } }
    function _tstore(bytes32 slot, uint256 v) private { assembly { tstore(slot, v) } }

    // ========================================================================================================
    // application owners
    // ========================================================================================================

    function budgetKey(bytes32 id, address owner_) public pure returns (bytes32) { return keccak256(abi.encode(id, owner_)); }
    function budgetOf(bytes32 id, address owner_) external view returns (Budget memory) { return _budgets[budgetKey(id, owner_)]; }
    /// @notice What operations of the CURRENT transaction still hold of a budget (always 0 between transactions).
    function reservedNow(bytes32 id, address owner_) external view returns (uint256) { return _tload(_slot(T_BUDGET, budgetKey(id, owner_))); }
    /// @notice What operations of the CURRENT transaction still hold of a sponsor's ETH (always 0 between transactions).
    function sponsorReservedNow(address sponsor) external view returns (uint256) { return _tload(_slot(T_SPONSOR, bytes32(uint256(uint160(sponsor))))); }

    /// @notice Add USDC to the gas budget of `id`'s CURRENT owner of record (anyone may pay; only that owner can
    ///         configure or withdraw it). Nothing is moved out of the ledger.
    function fundBudget(bytes32 id, uint256 amount6) external {
        address o = _ownerOf(id);
        _pull(amount6);
        _credit(id, o, amount6);
    }

    /// @notice One authorization, two destinations: `compute6` to the ledger through its existing fundFor(id, v, payer)
    ///         with the caller as payer (refundable escrow stays the caller's, exactly as fund() would make it), and
    ///         `gas6` to the gas budget. Existing ledger balances and escrow are not touched.
    function fundBoth(bytes32 id, uint256 compute6, uint256 gas6) external {
        address o = _ownerOf(id);
        _pull(compute6 + gas6);
        if (compute6 > 0) {
            require(usdc.approve(address(ledger), compute6), "approve");
            ledger.fundFor(id, compute6, msg.sender);
            emit ComputeFunded(id, msg.sender, compute6);
        }
        if (gas6 > 0) _credit(id, o, gas6);
    }

    /// @notice The owner of record authorizes (or stops) sponsorship of its deployment's claim/renew, with caps.
    function configureBudget(bytes32 id, bool enabled, uint64 maxPerOp6, uint64 epochCap6, uint32 renewWindow, uint32 minExtension)
        external
    {
        require(_ownerOf(id) == msg.sender, "!owner");
        Limits memory l = limits;
        require(renewWindow >= l.minRenewWindow && renewWindow <= l.maxRenewWindow, "renew window");
        require(minExtension >= l.minExtensionFloor, "min extension");
        require(maxPerOp6 <= epochCap6, "caps");
        Budget storage b = _budgets[budgetKey(id, msg.sender)];
        (b.enabled, b.maxPerOp6, b.epochCap6, b.renewWindow, b.minExtension) = (enabled, maxPerOp6, epochCap6, renewWindow, minExtension);
        emit BudgetConfigured(id, msg.sender, enabled, maxPerOp6, epochCap6, renewWindow, minExtension);
    }

    /// @notice Withdraw budget. Keyed to the caller: a previous owner keeps (and can withdraw) what it put in after a
    ///         transfer, and that budget is never charged for the new owner's leases. Needs no ledger read, so it works
    ///         after a ledger is retired or migrated.
    ///         It also respects what operations of the CURRENT transaction reserved: another operation in the same bundle
    ///         (any account's) could call this between a sponsored operation's validation and its postOp.
    function withdrawBudget(bytes32 id, uint256 amount6, address to) external {
        bytes32 key = budgetKey(id, msg.sender);
        Budget storage b = _budgets[key];
        require(b.balance6 >= amount6 + _tload(_slot(T_BUDGET, key)), "reserved or short");
        b.balance6 -= uint128(amount6);
        require(usdc.transfer(to, amount6), "transfer");
        emit BudgetWithdrawn(id, msg.sender, to, amount6);
    }

    /// @notice The owner re-admits an operator its budget cut off after reverted operations.
    function resetFailures(bytes32 id, address operator) external {
        require(_ownerOf(id) == msg.sender, "!owner");
        delete failures[id][operator];
        emit FailuresReset(id, operator);
    }

    /// Appended codes keep earlier numbering stable. Ready covers budget, price and moderation ONLY: the ledger's own
    /// conditions (runner, lease window, claimant) are judged by validation, not here.
    enum Status { Unknown, Disabled, Blocked, InsufficientBudget, EpochCapReached, Ready, PriceUnavailable, Inactive }

    /// @notice The state a host or owner reads before an operation, judged for an operation costing at most
    ///         `maxCostWei` (what the EntryPoint will pass as maxCost: its gas limits times its maxFeePerGas; 0 = the
    ///         worst case the admin's limits allow). Unknown (no such deployment), Disabled (the owner has not
    ///         authorized), Blocked (paused / moderated), InsufficientBudget (balance below that operation's reservation,
    ///         or the reservation above the per-op cap), EpochCapReached (this epoch's spending plus the reservation is
    ///         over the cap), Ready. `need6` is the reservation. Informational; validation is the authority.
    function statusOf(bytes32 id, uint256 maxCostWei) external view returns (Status status, uint256 available6, uint256 need6) {
        ILedgerLease.Deployment memory d = ledger.get(id);
        if (d.id != id) return (Status.Unknown, 0, 0);
        bytes32 key = budgetKey(id, d.owner);
        Budget storage b = _budgets[key];
        available6 = b.balance6;
        if (maxCostWei == 0) {
            Limits memory l = limits;
            maxCostWei = (uint256(l.maxVerificationGas) + l.maxCallGas + l.maxPreVerificationGas + l.maxPaymasterVerificationGas
                          + l.maxPostOpGas) * l.maxFeePerGas;
        }
        (uint80 r, int256 a,, uint256 upd, uint80 ar) = feed.latestRoundData();
        bool priceOk = a > 0 && ar >= r && upd != 0 && upd <= block.timestamp && block.timestamp <= upd + feedMaxAge
                       && uint256(a) >= minPrice8 && uint256(a) <= maxPrice8;
        need6 = priceOk ? toUsdc(maxCostWei, uint256(a)) : type(uint256).max;
        if (!d.active || ledger.retired()) return (Status.Inactive, available6, need6);
        if (!b.enabled) return (Status.Disabled, available6, need6);
        if (paused || blockedDeployment[id]) return (Status.Blocked, available6, need6);
        if (!priceOk) return (Status.PriceUnavailable, available6, need6);
        if (available6 < need6 || need6 > b.maxPerOp6) return (Status.InsufficientBudget, available6, need6);
        if (epochSpent6[key][block.timestamp / epochSec] + need6 > b.epochCap6) return (Status.EpochCapReached, available6, need6);
        return (Status.Ready, available6, need6);
    }

    // ========================================================================================================
    // sponsors
    // ========================================================================================================

    /// @notice Front ETH for sponsored operations (any address). It sits in this paymaster's EntryPoint deposit and is
    ///         spent only on operations naming this sponsor; reimbursement accrues in USDC.
    function sponsorDeposit() external payable {
        require(msg.value > 0 && msg.value <= type(uint128).max, "amount");
        entryPoint.depositTo{value: msg.value}(address(this));
        Sponsor storage s = sponsors[msg.sender];
        s.eth += uint128(msg.value);
        if (!s.active) { s.active = true; emit SponsorActive(msg.sender, true); }
        totalSponsorEth += msg.value;
        emit SponsorDeposited(msg.sender, msg.value);
    }

    function sponsorSetActive(bool active) external {
        sponsors[msg.sender].active = active;
        emit SponsorActive(msg.sender, active);
    }

    function sponsorWithdraw(uint256 amountWei, uint256 amount6, address payable to) external {
        Sponsor storage s = sponsors[msg.sender];
        // net of this transaction's reservations (see withdrawBudget)
        require(s.eth >= amountWei + _tload(_slot(T_SPONSOR, bytes32(uint256(uint160(msg.sender))))) && s.earned6 >= amount6,
                "reserved or short");
        s.eth -= uint128(amountWei);
        s.earned6 -= uint128(amount6);
        totalSponsorEth -= amountWei;
        if (amountWei > 0) entryPoint.withdrawTo(to, amountWei);
        if (amount6 > 0) require(usdc.transfer(to, amount6), "transfer");
        emit SponsorWithdrawn(msg.sender, to, amountWei, amount6);
    }

    // ========================================================================================================
    // admin (platform governance): limits, moderation, stake. Never app budgets or sponsor funds.
    // ========================================================================================================

    function setLimits(Limits calldata l) external onlyOwner { _setLimits(l); }
    function setFeed(IFeedLease f, uint32 maxAge, uint256 minP, uint256 maxP) external onlyOwner { _setFeed(f, maxAge, minP, maxP); }
    function setPaused(bool p) external onlyOwner { paused = p; emit Paused(p); }
    function setBlockedDeployment(bytes32 id, bool blocked) external onlyOwner { blockedDeployment[id] = blocked; emit DeploymentBlocked(id, blocked); }
    function setBlockedOperator(address op, bool blocked) external onlyOwner { blockedOperator[op] = blocked; emit OperatorBlocked(op, blocked); }

    /// @notice The canonical mempool requires a staked paymaster for this one's storage use (STO-031/033). The stake is
    ///         the admin's own ETH, separate from sponsors' deposit.
    function addStake(uint32 unstakeDelaySec) external payable onlyOwner { entryPoint.addStake{value: msg.value}(unstakeDelaySec); }
    function unlockStake() external onlyOwner { entryPoint.unlockStake(); }
    function withdrawStake(address payable to) external onlyOwner { entryPoint.withdrawStake(to); }

    /// @notice Deposit above every sponsor's tracked ETH: the conservative charge (postOp gas + the worst-case penalty)
    ///         exceeds what the EntryPoint actually took. Only that excess; tracked sponsor ETH is untouchable.
    function sweepSurplus(address payable to) external onlyOwner {
        uint256 dep = entryPoint.balanceOf(address(this));
        require(dep > totalSponsorEth, "none");
        uint256 amount = dep - totalSponsorEth;
        entryPoint.withdrawTo(to, amount);
        emit SurplusSwept(to, amount);
    }

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

    /// @notice wei -> USDC 6dp at an 8-decimal ETH/USD price plus the markup, rounded up.
    function toUsdc(uint256 weiAmount, uint256 price8) public view returns (uint256) {
        uint256 num = weiAmount * price8 * (10_000 + limits.markupBps);
        uint256 den = 1e20 * 10_000;
        return (num + den - 1) / den;
    }

    function _ownerOf(bytes32 id) private view returns (address) {
        ILedgerLease.Deployment memory d = ledger.get(id);
        require(d.id == id, "unknown");
        return d.owner;
    }

    function _pull(uint256 amount6) private {
        require(amount6 > 0 && amount6 <= type(uint64).max, "amount");
        require(usdc.transferFrom(msg.sender, address(this), amount6), "transferFrom");
    }

    function _credit(bytes32 id, address o, uint256 amount6) private {
        _budgets[budgetKey(id, o)].balance6 += uint128(amount6);
        emit BudgetFunded(id, o, msg.sender, amount6);
    }

    function _setLimits(Limits memory l) private {
        require(l.markupBps <= MAX_MARKUP_BPS && l.postOpChargeGas <= MAX_POSTOP_CHARGE_GAS, "ceiling");
        require(l.minCallGas <= l.maxCallGas && l.minPostOpGas <= l.maxPostOpGas && l.maxPriorityFeePerGas <= l.maxFeePerGas, "order");
        require(l.minRenewWindow > 0 && l.minRenewWindow <= l.maxRenewWindow && l.maxFailures > 0, "windows");
        limits = l;
        emit LimitsSet(l);
    }

    function _setFeed(IFeedLease f, uint32 maxAge, uint256 minP, uint256 maxP) private {
        // maxP <= 1e15 ($10M/ETH) keeps postOp's wei x price x markup product far from overflow: postOp must not revert
        require(address(f) != address(0) && maxAge > 0 && maxAge <= 2 hours && minP > 0 && minP < maxP && maxP <= 1e15, "feed");
        (feed, feedMaxAge, minPrice8, maxPrice8) = (f, maxAge, minP, maxP);
        emit FeedSet(address(f), maxAge, minP, maxP);
    }
}

// ---- the deployed contracts' surfaces this paymaster uses (rev 16d ledger, schema-4 registry) ------------------------
interface ILedgerLease {
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
    function claimBond6() external view returns (uint256);
    function bondOf(address operator) external view returns (uint256 amount6, uint64 exitAt);
    function proofRequiredFrom() external view returns (uint64);
    function fundFor(bytes32 id, uint256 value, address payer) external;
    function claim(bytes32 id, bytes32 enclaveId) external;
    function renew(bytes32 id) external;
}

interface IRegistryLease {
    struct Enclave {
        string endpoint; string repo; bytes32 measurement; address operator; uint64 registeredAt; uint64 lastSeen;
        bool active; uint64 cpuPricePerSec6; uint64 gpuPricePerSec6; address proofKey; address payoutWallet;
    }
    function get(bytes32 id) external view returns (Enclave memory);
}

interface IFeedLease {
    function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

interface IERC20Lease {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IEntryPointLease {
    function depositTo(address account) external payable;
    function balanceOf(address account) external view returns (uint256);
    function withdrawTo(address payable withdrawAddress, uint256 withdrawAmount) external;
    function addStake(uint32 unstakeDelaySec) external payable;
    function unlockStake() external;
    function withdrawStake(address payable withdrawAddress) external;
}
