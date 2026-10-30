// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// WalletSessionVault - an ADDITIVE session executor whose deployments end up owned by the owner's WALLET.
///
/// Provenance: NEW in wallet-owned-session-create-r1 (2026-10-29), derived from contracts/SessionVault.sol
/// (deployed v2, byte-for-byte unchanged and still the live version). Not deployed, not compiled, not
/// tested; EIP-170 / EIP-3860 size and gas are root acceptance gates. Nothing here migrates a legacy vault,
/// its grants, balances, op counters or held records, and no default/address book entry points at it.
///
/// What changes against SessionVault:
///  * deploy.create is create (empty) -> transferDeployment(id, owner) -> assert the ledger owner IS the
///    owner -> fundFor(id, fund6, owner), all in the one execute() and reverting as a whole. The ledger ID
///    it returns is the ID the ledger minted; the Created event names this vault and is followed by
///    DeploymentTransferred in the same receipt. Final custody is the wallet's.
///  * the environment/content gate is a WalletSessionPolicy binding (policyOf), decoupled from custody.
///    A session acts ONLY on records THIS vault created and bound, still held by the owner's wallet, inside
///    the session's environments AND its apps[] (the record's CURRENT appRef, re-read from the ledger).
///  * every owner-gated ledger call (setAppRef, setConfig, setShares, setMaxRate, setActive, refund) needs
///    the wallet's OWN ledger setDelegate(vault, true): nothing here grants, asks for or assumes it. fundFor
///    is permissionless at the ledger but still budget/scope checked here.
///  * app.publish is UNSUPPORTED: refused in the grant and at dispatch until a catalog design exists.
///  * no ownerCall, no release/adopt: the owner manages its records directly with its wallet on the ledger.
///  * a distinct EIP-712 domain ("Enclave Wallet Sessions") and a WalletSessionGrant type that names the
///    pinned ledger, so no legacy grant, call or owner signature replays here (or the reverse).

import { ISVToken, ISVBook, ISVRouter, ISV1271, ISVKeyAttestations, ISVLedger, CreateArgs, SessionVaultLib }
    from "./SessionVault.sol";
import { WalletSessionPolicy as WP } from "./WalletSessionPolicy.sol";

interface IWalletSessionRegistry { function noteCreated(bytes32 id) external; }

contract WalletSessionVault {
    ISVToken  public immutable usdc;
    ISVBook   public immutable book;
    ISVRouter public immutable router;
    address   public immutable factory;
    ISVKeyAttestations public immutable keyAttestations;
    uint256   public immutable maxVault6;
    ISVLedger public immutable ledger;          // the ONE ledger every create/fund of this version uses

    bytes32 public constant PROTOCOL = WP.PROTOCOL;
    bytes32 private constant BOOK_DEPLOYMENTS = "deployments";
    address private constant P256_VERIFY = address(0x100);

    uint8 public constant ACT_CREATE = 0;
    uint8 public constant ACT_FUND = 1;
    uint8 public constant ACT_SET_APPREF = 2;
    uint8 public constant ACT_SET_CONFIG = 3;
    uint8 public constant ACT_SET_SHARES = 4;
    uint8 public constant ACT_SET_MAXRATE = 5;
    uint8 public constant ACT_SET_ACTIVE = 6;
    uint8 public constant ACT_REFUND = 7;
    uint8 public constant ACT_PUBLISH = 8;      // unsupported in this version
    uint8 private constant ACT_LAST = 7;
    uint256 private constant CLOSE_FEE_MAX6 = 20_000;

    uint8 public constant ENV_STAGING = 1;
    uint8 public constant ENV_PROD = 2;
    uint8 private constant LIVE = 1;
    uint8 private constant ENDED = 2;
    uint256 private constant MAX_APPS = 8;
    uint256 private constant HALF_N =
        (uint256(0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF) << 128) | 0x5D576E7357A4501DDFE92F46681B20A0;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("Enclave Wallet Sessions");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 public constant GRANT_TYPEHASH = keccak256(
        "WalletSessionGrant(string label,string preset,bytes32 sessionKey,string[] actions,string[] apps,"
        "string[] environments,uint256 budget,uint256 spendPerPeriod,uint32 periodSeconds,uint32 opsPerPeriod,"
        "uint256 maxFeePerOp,uint256 maxAppFeePerHour,uint256 maxRatePerHour,uint64 expiresAt,bytes32 measurement,"
        "address ledger,bytes32 grantNonce,uint64 signBefore)");
    bytes32 public constant CALL_TYPEHASH = keccak256(
        "SessionCall(bytes32 sessionId,uint256 nonce,uint8 action,bytes32 argsHash,uint256 fee,uint64 deadline)");
    bytes32 public constant END_TYPEHASH = keccak256("SessionEnd(bytes32 sessionId,uint64 deadline)");
    bytes32 public constant TOPUP_TYPEHASH =
        keccak256("TopUp(bytes32 sessionId,uint256 amount,bytes32 opNonce,uint64 signBefore)");
    bytes32 public constant EXTEND_TYPEHASH =
        keccak256("Extend(bytes32 sessionId,uint64 expiresAt,bytes32 opNonce,uint64 signBefore)");
    bytes32 public constant TERMINATE_TYPEHASH =
        keccak256("Terminate(bytes32 sessionId,bytes32 opNonce,uint64 signBefore)");
    bytes32 public constant REVOKE_TYPEHASH = keccak256("RevokeAll(bool withdraw,bytes32 opNonce,uint64 signBefore)");
    bytes32 public constant WITHDRAW_TYPEHASH = keccak256("Withdraw(uint256 amount,bytes32 opNonce,uint64 signBefore)");
    bytes32 public constant APPROVE_TYPEHASH = keccak256(
        "ApproveContent(bytes32 deployment,string appRef,string configCid,uint64 revision,bytes32 opNonce,uint64 signBefore)");
    bytes32 public constant SETENV_TYPEHASH = keccak256(
        "SetEnvironment(bytes32 deployment,string environment,uint64 revision,bytes32 opNonce,uint64 signBefore)");
    bytes32 public constant DETACH_TYPEHASH =
        keccak256("Detach(bytes32 deployment,uint64 revision,bytes32 opNonce,uint64 signBefore)");

    /// SessionVault.Grant plus the ledger the owner consents to (must equal `ledger`)
    struct Grant {
        string   label;
        string   preset;
        bytes32  sessionKey;
        string[] actions;
        string[] apps;             // "*" | "0x<64 hex appId>" (catalog slugs are refused: no publisher to scope them)
        string[] environments;
        uint256  budget;
        uint256  spendPerPeriod;
        uint32   periodSeconds;
        uint32   opsPerPeriod;
        uint256  maxFeePerOp;
        uint256  maxAppFeePerHour;
        uint256  maxRatePerHour;
        uint64   expiresAt;
        bytes32  measurement;
        address  ledger;
        bytes32  grantNonce;
        uint64   signBefore;
    }

    /// identical layout to SessionVault.Session, so relay/host sessionOf decoders read both
    struct Session {
        bytes32 keyHash;
        bytes32 measurement;
        uint256 actions;
        uint64  expiresAt;
        uint64  epoch;
        uint8   envs;
        uint8   state;
        bool    anyApp;
        uint128 balance6;
        uint128 spent6;
        uint128 perPeriod6;
        uint128 maxFee6;
        uint128 maxAppFeeHour6;
        uint128 maxRateHour6;
        uint64  periodStart;
        uint32  period;
        uint32  opsPerPeriod;
        uint128 periodSpent6;
        uint32  periodOps;
    }

    address public owner;
    uint64  public epoch;
    uint256 public locked6;
    uint256 private _lock;
    mapping(bytes32 => Session) private _s;
    mapping(bytes32 => bytes32[]) private _apps;
    mapping(bytes32 => mapping(uint192 => uint64)) public seqOf;
    mapping(bytes32 => bool) public ownerNonceUsed;
    mapping(bytes32 => WP.Binding) private _policy;

    event SessionOpened(bytes32 indexed sid, bytes32 indexed keyHash, uint64 expiresAt, uint256 actions,
        uint8 envs, uint256 budget6, string label);
    event SessionOp(bytes32 indexed sid, uint256 nonce, uint8 indexed action, bytes32 argsHash,
        uint256 amount6, uint256 fee6, bytes result);
    event ToppedUp(bytes32 indexed sid, uint256 amount6, bool fromWallet);
    event Extended(bytes32 indexed sid, uint64 expiresAt);
    event SessionEnded(bytes32 indexed sid, uint8 reason, uint256 refund6, uint256 fee6);
    event RevokedAll(uint64 epoch, uint256 withdrawn6);
    event Withdrawn(uint256 amount6);
    /// a create bound `id` (now held by `wallet`) to environment `env`
    event Bound(bytes32 indexed id, uint8 env, bytes32 indexed createdBy, address indexed wallet);
    event PolicyChanged(bytes32 indexed id, uint8 state, uint8 env, bytes32 approved, uint64 revision);

    error NotOwner();
    error NotFactory();
    error Initialized();
    error Reentrant();
    error NotLive();
    error Expired();
    error NotExpired();
    error BadNonce();
    error BadSignature();
    error NonceUsed();
    error Exists();
    error UnknownEnvironment();
    error BadPolicy(uint8 code);
    error NotAllowed(uint8 action);
    error Unsupported(uint8 action);
    error EnvNotAllowed(uint8 env);
    error AppNotAllowed(bytes32 appId);
    error BudgetExceeded(uint256 need, uint256 have);
    error PeriodLimit(uint256 need, uint256 left);
    error RateLimit();
    error FeeTooHigh(uint256 fee, uint256 max);
    error AppFeeTooHigh(uint256 perHour, uint256 max);
    error NotHeld(bytes32 id);
    error WrongEnvironment(bytes32 id, uint8 env);
    error NotMine(bytes32 id);
    error StaleRevision(uint64 have, uint64 signed);
    error OverCap(uint256 balance, uint256 cap);
    error AllowanceLeft();
    error NoAttestation();
    error TransferFailed();
    error LedgerMoved();
    error RateCapOutOfRange(uint256 rate, uint256 limit);

    modifier nonReentrant() {
        if (_lock == 2) revert Reentrant();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(ISVToken _usdc, ISVBook _book, ISVRouter _router, ISVKeyAttestations _ka, uint256 _maxVault6,
        ISVLedger _ledger)
    {
        usdc = _usdc; book = _book; router = _router; keyAttestations = _ka; maxVault6 = _maxVault6;
        ledger = _ledger;
        factory = msg.sender;
        owner = address(1);
    }

    function initialize(address owner_) external {
        if (msg.sender != factory) revert NotFactory();
        if (owner != address(0)) revert Initialized();
        if (owner_ == address(0)) revert NotOwner();
        owner = owner_;
        _lock = 1;
    }

    // =========================================================================
    // Opening sessions (owner-authorized)
    // =========================================================================

    function open(Grant calldata g, bytes calldata ownerSig) external nonReentrant returns (bytes32 sid) {
        bytes32 gd = _hashTypedData(_hashGrant(g));
        _checkGrantAuth(gd, g.signBefore, ownerSig);
        if (g.budget > _free()) revert BudgetExceeded(g.budget, _free());
        sid = _open(g);
    }

    function openWithDeposit(Grant calldata g, bytes calldata ownerSig, uint256 validAfter, uint256 validBefore,
        bytes calldata authSig) external nonReentrant returns (bytes32 sid)
    {
        bytes32 gd = _hashTypedData(_hashGrant(g));
        _checkGrantAuth(gd, g.signBefore, ownerSig);
        if (g.budget == 0) revert BadPolicy(1);
        usdc.receiveWithAuthorization(owner, address(this), g.budget, validAfter, validBefore, gd, authSig);
        _capCheck();
        sid = _open(g);
    }

    function _checkGrantAuth(bytes32 gd, uint64 signBefore, bytes calldata ownerSig) private view {
        if (msg.sender == owner) return;
        if (block.timestamp > signBefore) revert Expired();
        if (!_ownerSigValid(gd, ownerSig)) revert BadSignature();
    }

    function _open(Grant calldata g) private returns (bytes32 sid) {
        if (g.sessionKey == bytes32(0)) revert BadPolicy(2);
        if (g.expiresAt <= block.timestamp) revert BadPolicy(3);
        if (g.periodSeconds == 0) revert BadPolicy(4);
        if (g.budget > type(uint128).max || g.spendPerPeriod > type(uint128).max
            || g.maxFeePerOp > type(uint128).max || g.maxAppFeePerHour > type(uint128).max
            || g.maxRatePerHour > type(uint128).max) revert BadPolicy(5);
        if (g.apps.length > MAX_APPS) revert BadPolicy(6);
        if (g.ledger != address(ledger)) revert BadPolicy(7);
        sid = keccak256(abi.encode(address(this), g.sessionKey, g.grantNonce));
        Session storage s = _s[sid];
        if (s.state != 0) revert Exists();
        if (g.measurement != bytes32(0)) _requireAttested(g.sessionKey, g.measurement);

        uint256 acts;
        for (uint256 i = 0; i < g.actions.length; i++) acts |= SessionVaultLib.actionBit(g.actions[i]);
        // explicit, never silently dropped: this version has no catalog-ownership design yet
        if ((acts >> ACT_PUBLISH) & 1 != 0) revert Unsupported(ACT_PUBLISH);
        uint8 envs;
        for (uint256 i = 0; i < g.environments.length; i++) envs |= SessionVaultLib.envOf(g.environments[i]);

        bool anyApp;
        bytes32[] storage ids = _apps[sid];
        for (uint256 i = 0; i < g.apps.length; i++) {
            bytes memory a = bytes(g.apps[i]);
            if (a.length == 1 && a[0] == "*") { anyApp = true; continue; }
            (bytes32 hexId, bool isHex) = SessionVaultLib.parseHex32(a, 0);
            if (!isHex || a.length != 66) revert BadPolicy(8);
            ids.push(hexId);
        }

        s.keyHash = g.sessionKey;
        s.measurement = g.measurement;
        s.actions = acts;
        s.expiresAt = g.expiresAt;
        s.epoch = epoch;
        s.envs = envs;
        s.state = LIVE;
        s.anyApp = anyApp;
        s.balance6 = uint128(g.budget);
        s.perPeriod6 = uint128(g.spendPerPeriod);
        s.maxFee6 = uint128(g.maxFeePerOp);
        s.maxAppFeeHour6 = uint128(g.maxAppFeePerHour);
        s.maxRateHour6 = uint128(g.maxRatePerHour);
        s.periodStart = uint64(block.timestamp);
        s.period = g.periodSeconds;
        s.opsPerPeriod = g.opsPerPeriod;
        locked6 += g.budget;
        emit SessionOpened(sid, g.sessionKey, g.expiresAt, acts, envs, g.budget, g.label);
    }

    // =========================================================================
    // Session operations (session-key-authorized)
    // =========================================================================

    function execute(bytes32 sid, uint256 nonce, uint8 action, bytes calldata args, uint256 fee, uint64 deadline,
        uint256 x, uint256 y, bytes32 r, bytes32 sv) external nonReentrant returns (bytes memory result)
    {
        Session storage s = _s[sid];
        if (!_live(s)) revert NotLive();
        if (block.timestamp > deadline) revert Expired();
        {
            uint192 lane = uint192(nonce >> 64);
            if (seqOf[sid][lane] != uint64(nonce)) revert BadNonce();
            seqOf[sid][lane] = uint64(nonce) + 1;
        }
        bytes32 argsHash = keccak256(args);
        bytes32 d = _hashTypedData(keccak256(abi.encode(CALL_TYPEHASH, sid, nonce, action, argsHash, fee, deadline)));
        if (!_sessionSigValid(s, d, x, y, r, sv)) revert BadSignature();
        if (action == ACT_PUBLISH) revert Unsupported(ACT_PUBLISH);
        if (action > ACT_LAST || ((s.actions >> action) & 1) == 0) revert NotAllowed(action);
        if (fee > s.maxFee6) revert FeeTooHigh(fee, s.maxFee6);
        if (s.measurement != bytes32(0)) _requireAttested(s.keyHash, s.measurement);

        uint256 amount = _amountOf(action, args);
        _spend(s, amount + fee);
        result = _dispatch(sid, s, action, args, amount);
        if (fee > 0) _payRouter(fee, keccak256(abi.encode("enclave.wallet-session.fee", address(this), sid, nonce)));
        emit SessionOp(sid, nonce, action, argsHash, amount, fee, result);
    }

    function terminateBySession(bytes32 sid, uint64 deadline, uint256 x, uint256 y, bytes32 r, bytes32 sv)
        external nonReentrant
    {
        Session storage s = _s[sid];
        if (!_live(s)) revert NotLive();
        if (block.timestamp > deadline) revert Expired();
        bytes32 d = _hashTypedData(keccak256(abi.encode(END_TYPEHASH, sid, deadline)));
        if (!_sessionSigValid(s, d, x, y, r, sv)) revert BadSignature();
        _end(sid, s, 2, 0);
    }

    function close(bytes32 sid) external nonReentrant {
        Session storage s = _s[sid];
        if (s.state != LIVE) revert NotLive();
        if (s.epoch != epoch) {
            s.state = ENDED;
            s.balance6 = 0;
            emit SessionEnded(sid, 4, 0, 0);
            return;
        }
        if (block.timestamp <= s.expiresAt) revert NotExpired();
        uint256 fee = s.maxFee6 < CLOSE_FEE_MAX6 ? s.maxFee6 : CLOSE_FEE_MAX6;
        if (fee > s.balance6) fee = s.balance6;
        _end(sid, s, 3, fee);
    }

    // =========================================================================
    // Owner operations: direct (msg.sender == owner) or owner-signed in THIS domain
    // =========================================================================

    function topUp(bytes32 sid, uint256 amount, bytes32 opNonce, uint64 signBefore, bytes calldata sig)
        external nonReentrant
    {
        _ownerAuth(keccak256(abi.encode(TOPUP_TYPEHASH, sid, amount, opNonce, signBefore)), opNonce, signBefore, sig);
        if (amount > _free()) revert BudgetExceeded(amount, _free());
        _credit(sid, amount, false);
    }

    function topUpWithAuthorization(bytes32 sid, uint256 amount, bytes32 opNonce, uint256 validAfter,
        uint64 validBefore, bytes calldata authSig) external nonReentrant
    {
        bytes32 d = _hashTypedData(keccak256(abi.encode(TOPUP_TYPEHASH, sid, amount, opNonce, validBefore)));
        usdc.receiveWithAuthorization(owner, address(this), amount, validAfter, validBefore, d, authSig);
        _capCheck();
        _credit(sid, amount, true);
    }

    function extend(bytes32 sid, uint64 expiresAt, bytes32 opNonce, uint64 signBefore, bytes calldata sig)
        external nonReentrant
    {
        _ownerAuth(keccak256(abi.encode(EXTEND_TYPEHASH, sid, expiresAt, opNonce, signBefore)), opNonce, signBefore, sig);
        Session storage s = _s[sid];
        if (!_live(s)) revert NotLive();
        if (expiresAt <= block.timestamp) revert BadPolicy(3);
        s.expiresAt = expiresAt;
        emit Extended(sid, expiresAt);
    }

    function terminate(bytes32 sid, bytes32 opNonce, uint64 signBefore, bytes calldata sig) external nonReentrant {
        _ownerAuth(keccak256(abi.encode(TERMINATE_TYPEHASH, sid, opNonce, signBefore)), opNonce, signBefore, sig);
        Session storage s = _s[sid];
        if (s.state != LIVE || s.epoch != epoch) revert NotLive();
        _end(sid, s, 1, 0);
    }

    function revokeAll(bool alsoWithdraw, bytes32 opNonce, uint64 signBefore, bytes calldata sig) external nonReentrant {
        _ownerAuth(keccak256(abi.encode(REVOKE_TYPEHASH, alsoWithdraw, opNonce, signBefore)), opNonce, signBefore, sig);
        epoch += 1;
        locked6 = 0;
        uint256 out;
        if (alsoWithdraw) {
            out = usdc.balanceOf(address(this));
            if (out > 0) _send(owner, out);
        }
        emit RevokedAll(epoch, out);
    }

    function withdraw(uint256 amount, bytes32 opNonce, uint64 signBefore, bytes calldata sig) external nonReentrant {
        _ownerAuth(keccak256(abi.encode(WITHDRAW_TYPEHASH, amount, opNonce, signBefore)), opNonce, signBefore, sig);
        if (amount > _free()) revert BudgetExceeded(amount, _free());
        _send(owner, amount);
        emit Withdrawn(amount);
    }

    /// The ONLY way a PROD record's secrets start to flow: the owner names the exact (appRef, configCid), at the
    /// binding revision it saw. Consumers compare it with the row's CURRENT content, so any later drift (the
    /// wallet re-pointing it, a delegate) stops release until the owner approves again. Never done by create.
    function approveContent(bytes32 id, string calldata appRef, string calldata configCid, uint64 revision,
        bytes32 opNonce, uint64 signBefore, bytes calldata sig) external nonReentrant
    {
        _ownerAuth(keccak256(abi.encode(APPROVE_TYPEHASH, id, keccak256(bytes(appRef)), keccak256(bytes(configCid)),
            revision, opNonce, signBefore)), opNonce, signBefore, sig);
        WP.Binding storage b = _ownerBinding(id, revision);
        if (b.state != WP.BOUND) revert NotHeld(id);
        if (b.env != ENV_PROD) revert WrongEnvironment(id, b.env);
        b.approved = WP.contentHash(appRef, configCid);
        _changed(id, b);
    }

    /// Move a bound (or re-bind a detached) record to staging/prod. Always clears any approval: a record
    /// entering prod starts unapproved.
    function setEnvironment(bytes32 id, string calldata environment, uint64 revision, bytes32 opNonce,
        uint64 signBefore, bytes calldata sig) external nonReentrant
    {
        _ownerAuth(keccak256(abi.encode(SETENV_TYPEHASH, id, keccak256(bytes(environment)), revision, opNonce,
            signBefore)), opNonce, signBefore, sig);
        WP.Binding storage b = _ownerBinding(id, revision);
        b.env = SessionVaultLib.envOf(environment);
        b.state = WP.BOUND;
        b.approved = bytes32(0);
        _changed(id, b);
    }

    /// The owner takes the record out of session management entirely: no session acts on it again and the
    /// policy stops applying (consumers see DETACHED, an explicit owner decision - never "missing").
    function detach(bytes32 id, uint64 revision, bytes32 opNonce, uint64 signBefore, bytes calldata sig)
        external nonReentrant
    {
        _ownerAuth(keccak256(abi.encode(DETACH_TYPEHASH, id, revision, opNonce, signBefore)), opNonce, signBefore, sig);
        WP.Binding storage b = _ownerBinding(id, revision);
        b.state = WP.DETACHED;
        b.env = 0;
        b.approved = bytes32(0);
        _changed(id, b);
    }

    // =========================================================================
    // Views
    // =========================================================================

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function grantDigest(Grant calldata g) external view returns (bytes32) { return _hashTypedData(_hashGrant(g)); }

    function sessionIdOf(bytes32 sessionKey, bytes32 grantNonce) external view returns (bytes32) {
        return keccak256(abi.encode(address(this), sessionKey, grantNonce));
    }

    function free() external view returns (uint256) { return _free(); }

    function isLive(bytes32 sid) external view returns (bool) { return _live(_s[sid]); }

    function sessionOf(bytes32 sid) external view returns (Session memory s, bool live, bytes32[] memory apps) {
        live = _live(_s[sid]);
        s = _s[sid];
        if (s.epoch != epoch) s.balance6 = 0;
        apps = _apps[sid];
    }

    /// the binding the relay, hosts and secret release read for a wallet-held record this vault created
    function policyOf(bytes32 id) external view returns (WP.Binding memory) { return _policy[id]; }

    // =========================================================================
    // Internals
    // =========================================================================

    function _live(Session storage s) private view returns (bool) {
        return s.state == LIVE && s.epoch == epoch && block.timestamp <= s.expiresAt;
    }

    function _free() private view returns (uint256) {
        uint256 b = usdc.balanceOf(address(this));
        return b > locked6 ? b - locked6 : 0;
    }

    function _capCheck() private view {
        uint256 b = usdc.balanceOf(address(this));
        if (b > maxVault6) revert OverCap(b, maxVault6);
    }

    function _credit(bytes32 sid, uint256 amount, bool fromWallet) private {
        Session storage s = _s[sid];
        if (!_live(s)) revert NotLive();
        if (uint256(s.balance6) + amount > type(uint128).max) revert BadPolicy(5);
        s.balance6 += uint128(amount);
        locked6 += amount;
        emit ToppedUp(sid, amount, fromWallet);
    }

    function _end(bytes32 sid, Session storage s, uint8 reason, uint256 fee) private {
        uint256 bal = s.balance6;
        s.balance6 = 0;
        s.state = ENDED;
        locked6 -= bal;
        if (fee > 0) _payRouter(fee, keccak256(abi.encode("enclave.wallet-session.close", address(this), sid)));
        uint256 refund = bal - fee;
        if (refund > 0) _send(owner, refund);
        emit SessionEnded(sid, reason, refund, fee);
    }

    function _ownerBinding(bytes32 id, uint64 revision) private view returns (WP.Binding storage b) {
        b = _policy[id];
        if (b.state == WP.UNBOUND) revert NotHeld(id);
        if (b.revision != revision) revert StaleRevision(b.revision, revision);
        // [wallet-owned-session-repair-r2] the SAME ledger create/dispatch use, never a book lookup
        if (ledger.get(id).owner != owner) revert NotMine(id);
    }

    function _changed(bytes32 id, WP.Binding storage b) private {
        b.revision += 1;
        emit PolicyChanged(id, b.state, b.env, b.approved, b.revision);
    }

    function _ownerAuth(bytes32 structHash, bytes32 opNonce, uint64 signBefore, bytes calldata sig) private {
        if (msg.sender == owner) return;
        if (block.timestamp > signBefore) revert Expired();
        if (ownerNonceUsed[opNonce]) revert NonceUsed();
        ownerNonceUsed[opNonce] = true;
        if (!_ownerSigValid(_hashTypedData(structHash), sig)) revert BadSignature();
    }

    function _ownerSigValid(bytes32 digest, bytes calldata sig) private view returns (bool) {
        address o = owner;
        if (sig.length == 65) {
            bytes32 r = bytes32(sig[0:32]);
            bytes32 s = bytes32(sig[32:64]);
            uint8 v = uint8(sig[64]);
            if (uint256(s) <= HALF_N && (v == 27 || v == 28)) {
                address rec = ecrecover(digest, v, r, s);
                if (rec != address(0) && rec == o) return true;
            }
        }
        if (o.code.length == 0) return false;
        (bool ok, bytes memory ret) = o.staticcall(abi.encodeCall(ISV1271.isValidSignature, (digest, sig)));
        return ok && ret.length >= 32 && bytes4(bytes32(ret)) == 0x1626ba7e;
    }

    function _sessionSigValid(Session storage s, bytes32 digest, uint256 x, uint256 y, bytes32 r, bytes32 sv)
        private view returns (bool)
    {
        if (keccak256(abi.encode(x, y)) != s.keyHash) return false;
        (bool ok, bytes memory ret) =
            P256_VERIFY.staticcall(abi.encode(sha256(abi.encodePacked(digest)), r, sv, x, y));
        return ok && ret.length == 32 && uint256(bytes32(ret)) == 1;
    }

    function _requireAttested(bytes32 keyHash, bytes32 measurement) private view {
        if (address(keyAttestations) == address(0)) revert NoAttestation();
        (bytes32 m, bool revoked) = keyAttestations.bindingOf(keyHash);
        if (m != measurement || revoked) revert NoAttestation();
    }

    function _spend(Session storage s, uint256 amt) private {
        if (block.timestamp >= uint256(s.periodStart) + s.period) {
            s.periodStart = uint64(block.timestamp);
            s.periodSpent6 = 0;
            s.periodOps = 0;
        }
        if (s.opsPerPeriod != 0 && s.periodOps >= s.opsPerPeriod) revert RateLimit();
        s.periodOps += 1;
        if (amt == 0) return;
        if (amt > s.balance6) revert BudgetExceeded(amt, s.balance6);
        uint256 left = s.perPeriod6 > s.periodSpent6 ? s.perPeriod6 - s.periodSpent6 : 0;
        if (amt > left) revert PeriodLimit(amt, left);
        s.balance6 -= uint128(amt);
        s.spent6 += uint128(amt);
        s.periodSpent6 += uint128(amt);
        locked6 -= amt;
    }

    function _amountOf(uint8 action, bytes calldata args) private pure returns (uint256) {
        if (action == ACT_CREATE) return abi.decode(args, (CreateArgs)).fund6;
        if (action == ACT_FUND) { (, uint256 v) = abi.decode(args, (bytes32, uint256)); return v; }
        return 0;
    }

    function _dispatch(bytes32 sid, Session storage s, uint8 action, bytes calldata args, uint256 amount)
        private returns (bytes memory)
    {
        ISVLedger L = _ledger();
        if (action == ACT_CREATE) return abi.encode(_create(sid, s, L, abi.decode(args, (CreateArgs))));
        if (action == ACT_FUND) {
            (bytes32 id, ) = abi.decode(args, (bytes32, uint256));
            _bound(sid, s, L, id);
            // the record's publisher fee must still be the catalog's own, to that app's publisher, and a paid app
            // must be NAMED in the grant within its fee ceiling - a staging re-point can't smuggle one in
            (uint256 fee, bytes32 feeApp, bool genuine) = SessionVaultLib.feeAndApp(book, id);
            if (fee > 0) {
                if (!genuine || !_appListed(sid, feeApp)) revert AppNotAllowed(feeApp);
                if (fee * 3600 > s.maxAppFeeHour6) revert AppFeeTooHigh(fee * 3600, s.maxAppFeeHour6);
            }
            // may re-base an unleased record on its cap: that is L.setMaxRate, which needs the wallet's delegation
            SessionVaultLib.prepareFund(book, id, s.maxRateHour6, owner);
            _fund(L, id, amount, owner);
            return "";
        }
        if (action == ACT_SET_APPREF) {
            (bytes32 id, string memory ref) = abi.decode(args, (bytes32, string));
            WP.Binding storage b = _bound(sid, s, L, id);           // the CURRENT app is in scope ...
            if (!WP.contentMutable(b)) revert WrongEnvironment(id, b.env);
            (bytes32 target, ) = SessionVaultLib.parseRef(ref);
            _requireApp(sid, s, target);                             // ... and so is the target
            L.setAppRef(id, ref);
            return "";
        }
        if (action == ACT_SET_CONFIG) {
            (bytes32 id, string memory cfg) = abi.decode(args, (bytes32, string));
            WP.Binding storage b = _bound(sid, s, L, id);
            if (!WP.contentMutable(b)) revert WrongEnvironment(id, b.env);
            L.setConfig(id, cfg);
            return "";
        }
        if (action == ACT_SET_SHARES) {
            (bytes32 id, uint16 g, uint16 c) = abi.decode(args, (bytes32, uint16, uint16));
            _bound(sid, s, L, id);
            SessionVaultLib.setShares(book, id, g, c);
            return "";
        }
        if (action == ACT_SET_MAXRATE) {
            (bytes32 id, uint256 r) = abi.decode(args, (bytes32, uint256));
            WP.Binding storage b = _bound(sid, s, L, id);
            SessionVaultLib.checkMaxRate(book, id, r, b.env == ENV_PROD, s.maxRateHour6);
            L.setMaxRate(id, r);
            return "";
        }
        if (action == ACT_SET_ACTIVE) {
            (bytes32 id, bool a) = abi.decode(args, (bytes32, bool));
            _bound(sid, s, L, id);
            L.setActive(id, a);
            return "";
        }
        // ACT_REFUND: the ledger pays d.owner, which _bound just proved is the owner's wallet
        (bytes32 rid) = abi.decode(args, (bytes32));
        _bound(sid, s, L, rid);
        L.refund(rid);
        return "";
    }

    /// create (empty) -> transfer the SAME id to the owner -> prove the ledger says so -> bind -> fund with the
    /// owner as payer. Any revert anywhere unwinds the nonce, spend, ledger record, transfer, binding and funding.
    function _create(bytes32 sid, Session storage s, ISVLedger L, CreateArgs memory c) private returns (bytes32 id) {
        if (c.env != ENV_STAGING && c.env != ENV_PROD) revert UnknownEnvironment();
        if (s.envs & c.env == 0) revert EnvNotAllowed(c.env);
        (bytes32 appId, uint256 idx) = SessionVaultLib.parseRef(c.appRef);
        _requireApp(sid, s, appId);
        if (c.maxRate6 * 3600 > s.maxRateHour6) revert RateCapOutOfRange(c.maxRate6 * 3600, s.maxRateHour6);
        id = SessionVaultLib.create(book, c, appId, idx, s.maxAppFeeHour6, _appListed(sid, appId));
        if (_ledger() != L) revert LedgerMoved();
        WP.Binding storage b = _policy[id];
        if (b.state != WP.UNBOUND) revert Exists();          // a hostile ledger can't overwrite a binding
        if (L.get(id).owner != address(this)) revert NotMine(id);
        L.transferDeployment(id, owner);
        if (L.get(id).owner != owner) revert NotMine(id);
        b.env = c.env;
        b.state = WP.BOUND;
        b.revision = 1;
        b.createdBy = sid;                                    // approved stays 0: never auto-approved
        IWalletSessionRegistry(factory).noteCreated(id);
        emit Bound(id, c.env, sid, owner);
        if (c.fund6 > 0) _fund(L, id, c.fund6, owner);
    }

    /// A session acts on `id` only if THIS vault bound it, the owner's wallet still holds it on the pinned
    /// ledger, the binding's environment is one of the session's, and the record's CURRENT app is in apps[].
    function _bound(bytes32 sid, Session storage s, ISVLedger L, bytes32 id) private view returns (WP.Binding storage b) {
        b = _policy[id];
        if (b.state != WP.BOUND) revert NotHeld(id);
        ISVLedger.Deployment memory d = L.get(id);
        if (d.owner != owner) revert NotMine(id);
        if (!WP.sessionMayAct(b, s.envs)) revert EnvNotAllowed(b.env);
        (bytes32 appId, ) = SessionVaultLib.parseRef(d.appRef);
        _requireApp(sid, s, appId);
    }

    function _requireApp(bytes32 sid, Session storage s, bytes32 appId) private view {
        if (s.anyApp) return;
        if (!_appListed(sid, appId)) revert AppNotAllowed(appId);
    }

    function _appListed(bytes32 sid, bytes32 appId) private view returns (bool) {
        bytes32[] storage ids = _apps[sid];
        for (uint256 i = 0; i < ids.length; i++) if (ids[i] == appId) return true;
        return false;
    }

    function _fund(ISVLedger L, bytes32 id, uint256 amount, address payer) private {
        if (!usdc.approve(address(L), amount)) revert TransferFailed();
        L.fundFor(id, amount, payer);
        if (usdc.allowance(address(this), address(L)) != 0) revert AllowanceLeft();
    }

    function _payRouter(uint256 amount, bytes32 ref) private {
        if (!usdc.approve(address(router), amount)) revert TransferFailed();
        router.pay(amount, ref);
        if (usdc.allowance(address(this), address(router)) != 0) revert AllowanceLeft();
    }

    function _send(address to, uint256 amount) private {
        if (!usdc.transfer(to, amount)) revert TransferFailed();
    }

    /// [wallet-owned-session-repair-r2] the ONE ledger this vault was built against. `book` is the factory's immutable
    /// WalletSessionProfile (its "deployments" IS this ledger), so no foreign book change can redirect or veto it; the
    /// r1 LedgerMoved check against a mutable book is gone (LedgerMoved stays declared for ABI continuity, unused).
    function _ledger() private view returns (ISVLedger) {
        return ledger;
    }

    function _hashTypedData(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function _hashGrant(Grant calldata g) private pure returns (bytes32) {
        bytes memory head = abi.encode(
            GRANT_TYPEHASH, keccak256(bytes(g.label)), keccak256(bytes(g.preset)), g.sessionKey,
            _hashStrings(g.actions), _hashStrings(g.apps), _hashStrings(g.environments), g.budget);
        bytes memory tail = abi.encode(
            g.spendPerPeriod, g.periodSeconds, g.opsPerPeriod, g.maxFeePerOp, g.maxAppFeePerHour, g.maxRatePerHour,
            g.expiresAt, g.measurement, g.ledger, g.grantNonce, g.signBefore);
        return keccak256(bytes.concat(head, tail));
    }

    function _hashStrings(string[] calldata a) private pure returns (bytes32) {
        bytes32[] memory h = new bytes32[](a.length);
        for (uint256 i = 0; i < a.length; i++) h[i] = keccak256(bytes(a[i]));
        return keccak256(abi.encodePacked(h));
    }
}

/// One EIP-1167 clone per owner at a CREATE2 address salted by the owner, exactly like SessionVaultFactory,
/// plus the creator registry consumers use to find a wallet-held record's binding. No owner, no admin, no
/// allowlist: anyone may deploy this factory; consumers trust a factory only by pinned address + code hash +
/// ledger, never by who deployed it.
contract WalletSessionVaultFactory {
    bytes32 public constant PROTOCOL = WP.PROTOCOL;
    WalletSessionVault public immutable implementation;
    ISVLedger public immutable ledger;
    mapping(address => bool) public isVault;
    mapping(bytes32 => address) public creatorOf;

    event VaultCreated(address indexed owner, address vault);
    event Bound(bytes32 indexed id, address indexed vault, address indexed owner);

    error NotVault();
    error AlreadyBound();

    /// [wallet-owned-session-repair-r2] the dependencies the deployer's chosen book names NOW, snapshotted once into an
    /// immutable profile (CREATE nonce 1) that the implementation (nonce 2) routes every library call through
    WalletSessionProfile public immutable profile;

    constructor(ISVToken usdc, ISVBook book, ISVRouter router, ISVKeyAttestations keyAttestations, uint256 maxVault6) {
        address l = book.addr("deployments");
        require(l != address(0), "ledger");
        ledger = ISVLedger(l);
        profile = new WalletSessionProfile(l, book.addr("appCatalog"));
        implementation = new WalletSessionVault(usdc, ISVBook(address(profile)), router, keyAttestations, maxVault6, ISVLedger(l));
    }

    function vaultFor(address owner) public view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(
            bytes1(0xff), address(this), bytes32(uint256(uint160(owner))), keccak256(_cloneCode()))))));
    }

    function createVault(address owner) public returns (address vault) {
        vault = vaultFor(owner);
        if (vault.code.length != 0) return vault;
        bytes memory code = _cloneCode();
        bytes32 salt = bytes32(uint256(uint160(owner)));
        assembly ("memory-safe") { vault := create2(0, add(code, 0x20), mload(code), salt) }
        require(vault != address(0), "create2");
        isVault[vault] = true;
        WalletSessionVault(vault).initialize(owner);
        emit VaultCreated(owner, vault);
    }

    /// called by a vault of THIS factory inside its create, once per ledger id
    function noteCreated(bytes32 id) external {
        if (!isVault[msg.sender]) revert NotVault();
        if (creatorOf[id] != address(0)) revert AlreadyBound();
        creatorOf[id] = msg.sender;
        emit Bound(id, msg.sender, WalletSessionVault(msg.sender).owner());
    }

    function openFor(address owner, WalletSessionVault.Grant calldata g, bytes calldata ownerSig)
        external returns (address vault, bytes32 sid)
    {
        vault = createVault(owner);
        sid = WalletSessionVault(vault).open(g, ownerSig);
    }

    function openWithDepositFor(address owner, WalletSessionVault.Grant calldata g, bytes calldata ownerSig,
        uint256 validAfter, uint256 validBefore, bytes calldata authSig) external returns (address vault, bytes32 sid)
    {
        vault = createVault(owner);
        sid = WalletSessionVault(vault).openWithDeposit(g, ownerSig, validAfter, validBefore, authSig);
    }

    function _cloneCode() private view returns (bytes memory) {
        return abi.encodePacked(
            hex"3d602d80600a3d3981f3363d3d373d3d3d363d73",
            address(implementation),
            hex"5af43d82803e903d91602b57fd5bf3");
    }
}
