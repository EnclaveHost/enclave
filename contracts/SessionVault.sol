// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// SessionVault - one per owner (an EIP-1167 clone at a CREATE2 address derived
/// from the owner), holding the owner's session escrow and the deployments and
/// catalog apps their sessions manage. Design: docs/design/sessions.md.
///
/// A SESSION is a P-256 key + a policy + an escrowed USDC budget, granted once
/// by the owner's wallet (an EIP-712 SessionGrant). The session key then signs
/// SessionCall intents that anyone may submit (the relay does, paying gas).
///
/// What a session can do is the action table below and nothing else. The vault
/// BUILDS every platform call itself from typed arguments - it never forwards
/// caller calldata, never calls an unlisted target, and never leaves an
/// allowance behind (each pull is approved for its exact amount and the
/// allowance is checked back at zero). Money leaves the vault to exactly three
/// places: the ledger (compute), the pinned PaymentRouter (orders and relay
/// fees, landing at the treasury), and the owner (refunds, withdrawals).
///
/// The OWNER (an EOA, or a contract wallet via ERC-1271) can always terminate,
/// revoke every session, and withdraw - directly, with no relay, no book read
/// and no admin in the way. There is no admin, no pause, no upgrade: a new
/// version is a new factory the owner opts into.
///
/// Deliberately NOT ERC-1271 itself: USDC honours 1271 for permit and EIP-3009,
/// so an owner signature the vault vouched for could be replayed as a USDC
/// permit FROM the vault, draining escrow around the session accounting. Off-chain
/// owner checks resolve vault.owner() instead.
///
/// Environments: every vault-held deployment is staging or prod. Sessions may
/// re-point a STAGING deployment's version/config; on prod only the owner can
/// (Promote), which records the promoted (appRef, configCid) that secret release
/// requires before prod secrets flow.

interface ISVToken {
    function transfer(address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address who) external view returns (uint256);
    function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter,
        uint256 validBefore, bytes32 nonce, bytes calldata signature) external;
}

interface ISVBook { function addr(bytes32 key) external view returns (address); }
interface ISVRouter { function pay(uint256 amount, bytes32 orderRef) external; }
interface ISV1271 { function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4); }
interface ISVFactory { function vaultFor(address owner) external view returns (address); }
interface ISVKeyAttestations {
    /// the measurement a session key was attested to have been generated under,
    /// and whether that binding has since been revoked (0 = never attested)
    function bindingOf(bytes32 keyHash) external view returns (bytes32 measurement, bool revoked);
}

interface ISVLedger {
    // byte-for-byte the ledger's Deployment tuple (stable since schema 2)
    struct Deployment {
        bytes32 id; address owner; string appRef; string ports; string configCid;
        uint16 gpuMilli; uint16 cpuMilli; uint32 appPort; bool isPublic; bool active; uint64 createdAt;
        uint256 rate; uint256 balance6; uint256 spent6;
        bytes32 runner; address runnerOperator; uint64 leaseUntil;
    }
    function get(bytes32 id) external view returns (Deployment memory);
    function create(string calldata appRef, uint16 gpuMilli, uint16 cpuMilli, uint32 appPort, string calldata ports,
        bool isPublic, string calldata configCid, address feeRecipient, uint256 feePerSec6, uint256 maxRate6)
        external returns (bytes32 id);
    function fundFor(bytes32 id, uint256 value, address payer) external;
    function capOf(bytes32 id) external view returns (uint256 maxRate6);
    function feeOf(bytes32 id) external view returns (address recipient, uint256 feePerSec6);
    function setAppRef(bytes32 id, string calldata appRef) external;
    function setConfig(bytes32 id, string calldata configCid) external;
    function setShares(bytes32 id, uint16 gpuMilli, uint16 cpuMilli) external;
    function setMaxRate(bytes32 id, uint256 maxRate6) external;
    function setActive(bytes32 id, bool active) external;
    function refund(bytes32 id) external;
    function transferDeployment(bytes32 id, address to) external;
}

interface ISVCatalog {
    struct App {
        bytes32 appId; address publisher; string slug; string name; string description;
        uint32 versionCount; uint64 createdAt; uint64 updatedAt; bool active;
    }
    struct Version {
        string cid; string version; uint32 vramMb; uint32 gpuGflops; uint32 memMb; uint32 cpuGflops;
        uint64 createdAt; bool verified; bool yanked; string ports; uint8 approval; string config;
    }
    function appIdOf(address publisher, string memory slug) external view returns (bytes32);
    function getApp(bytes32 appId) external view returns (App memory);
    function getVersion(bytes32 appId, uint256 index) external view returns (Version memory);
    function versionFee(bytes32 appId, uint256 index) external view returns (uint256);
    function publishVersion(string calldata slug, string calldata name, string calldata description,
        string calldata version, string calldata cid, uint32[4] calldata res, string calldata ports,
        string calldata config, uint256 feePerSec6) external returns (bytes32 appId, uint256 index);
    function publishVersionCfg(string calldata slug, string calldata name, string calldata description,
        string calldata version, string calldata cid, uint32[4] calldata res, string calldata ports,
        string calldata config, string calldata configCid, uint256 feePerSec6) external returns (bytes32 appId, uint256 index);
}

/// session-call argument shapes (abi.encode of ONE tuple each)
struct CreateArgs {
    string  appRef;
    uint16  gpuMilli;
    uint16  cpuMilli;
    uint32  appPort;
    string  ports;
    bool    isPublic;
    string  configCid;
    uint256 maxRate6;
    uint8   env;
    uint256 fund6;
}

struct PublishArgs {
    string    slug;
    string    name;
    string    description;
    string    version;
    string    cid;
    uint32[4] res;
    string    ports;
    string    config;
    string    configCid;   // "" = inline-config publishVersion, else publishVersionCfg
}

/// Every ledger/catalog READ (the big struct decodes) and the bulky call
/// builders, kept out of the vault's own code for EIP-170. A LINKED library:
/// its external functions run by DELEGATECALL in the vault's context, so the
/// ledger and catalog still see the VAULT as msg.sender and address(this) is
/// the vault.
library SessionVaultLib {
    bytes32 private constant BOOK_DEPLOYMENTS = "deployments";
    bytes32 private constant BOOK_CATALOG = "appCatalog";

    // same signatures as the vault's, so callers decode one error set
    error BadRef();
    error NoContract(bytes32 key);
    error AppFeeTooHigh(uint256 perHour, uint256 max);
    error LabelMismatch();
    error NotMine(bytes32 id);
    error UnknownAction();
    error UnknownEnvironment();
    error AppNotAllowed(bytes32 appId);
    error RateCapOutOfRange(uint256 rate, uint256 limit);
    error FundRateTooLow(uint256 rate, uint256 feeTimesTwo);

    function ledger(ISVBook book) internal view returns (ISVLedger) {
        address a = book.addr(BOOK_DEPLOYMENTS);
        if (a == address(0)) revert NoContract(BOOK_DEPLOYMENTS);
        return ISVLedger(a);
    }

    function catalog(ISVBook book) internal view returns (ISVCatalog) {
        address a = book.addr(BOOK_CATALOG);
        if (a == address(0)) revert NoContract(BOOK_CATALOG);
        return ISVCatalog(a);
    }

    function ownerOf(ISVBook book, bytes32 id) external view returns (address) {
        return ledger(book).get(id).owner;
    }

    /// A session funding must BUY RUNTIME at a price the grant allows. The ledger
    /// splits every funding by the record's CURRENT rate, and a host's cheap (or zero)
    /// job-rate claim leaves that rate behind after release - at rate == fee a funding
    /// pays the publisher everything, at rate 0 the platform, with nothing escrowed for
    /// a runner and nothing refundable. So: only records this vault owns, whose cap
    /// fits the grant's ceiling (an imported cap-0 record never); an unleased record is
    /// re-based on its cap first (the ledger's own unleased rule); and the rate the
    /// funding splits at must leave the fee at most half of it. A live lease priced
    /// under that is funded by the owner's wallet, never by a session.
    function prepareFund(ISVBook book, bytes32 id, uint256 maxRateHour6) external {
        ISVLedger L = ledger(book);
        ISVLedger.Deployment memory d = L.get(id);
        if (d.owner != address(this)) revert NotMine(id);
        uint256 cap = L.capOf(id);
        if (cap == 0 || cap * 3600 > maxRateHour6) revert RateCapOutOfRange(cap * 3600, maxRateHour6);
        uint256 rate = d.rate;
        if (d.leaseUntil <= block.timestamp && rate != cap) { L.setMaxRate(id, cap); rate = cap; }
        (, uint256 fee) = L.feeOf(id);
        if (rate == 0 || rate < 2 * fee) revert FundRateTooLow(rate, 2 * fee);
    }

    /// A session's new cap: within the grant's ceiling, never under twice the fee (the
    /// unleased rate IS the cap, so a lower one would tip every funding to the
    /// publisher), and on a production record only ever lowered (a raised cap is what
    /// lets a host the attacker runs claim at that price and earn the record's escrow).
    function checkMaxRate(ISVBook book, bytes32 id, uint256 r, bool prod, uint256 maxRateHour6) external view {
        ISVLedger L = ledger(book);
        if (prod) {
            uint256 cap = L.capOf(id);
            if (r > cap) revert RateCapOutOfRange(r, cap);
        }
        if (r * 3600 > maxRateHour6) revert RateCapOutOfRange(r * 3600, maxRateHour6);
        (, uint256 fee) = L.feeOf(id);
        if (r < 2 * fee) revert RateCapOutOfRange(r, 2 * fee);
    }

    function appIdOf(ISVBook book, string memory slug) external view returns (bytes32) {
        return catalog(book).appIdOf(address(this), slug);
    }

    /// The ledger snapshots whatever fee create() is handed and checks it
    /// against nothing: derive it from the catalog, never from the caller. A
    /// PAID app must be named in the grant ("*" never covers one: a hostile
    /// publisher's fee is the one way a session's budget could reach a third
    /// party at funding time), its fee must fit the grant's hourly ceiling, and
    /// the deployment's rate cap must leave the fee at most half of every funding.
    function create(ISVBook book, CreateArgs memory c, bytes32 appId, uint256 idx, uint256 maxAppFeeHour6, bool listed)
        external returns (bytes32)
    {
        ISVCatalog cat = catalog(book);
        uint256 feeSec = cat.versionFee(appId, idx);
        address feeTo;
        if (feeSec > 0) {
            if (!listed) revert AppNotAllowed(appId);
            if (feeSec * 3600 > maxAppFeeHour6) revert AppFeeTooHigh(feeSec * 3600, maxAppFeeHour6);
            if (c.maxRate6 < 2 * feeSec) revert RateCapOutOfRange(c.maxRate6, 2 * feeSec);
            feeTo = cat.getApp(appId).publisher;
        }
        return ledger(book).create(c.appRef, c.gpuMilli, c.cpuMilli, c.appPort, c.ports, c.isPublic, c.configCid,
            feeTo, feeSec, c.maxRate6);
    }

    /// Session publishes carry no publisher fee (v1).
    function publish(ISVBook book, PublishArgs memory p) external returns (bytes32, uint256) {
        ISVCatalog cat = catalog(book);
        if (bytes(p.configCid).length == 0)
            return cat.publishVersion(p.slug, p.name, p.description, p.version, p.cid, p.res, p.ports, p.config, 0);
        return cat.publishVersionCfg(p.slug, p.name, p.description, p.version, p.cid, p.res, p.ports, p.config,
            p.configCid, 0);
    }

    /// Point a deployment this vault owns at (appRef, configCid), after checking what
    /// the owner saw against the chain: the app slug, its PUBLISHER (slugs are unique
    /// only per publisher, so anyone can copy a name and a version label), the version
    /// label, and whether the record is public (fixed at create - a session chose it).
    function promote(ISVBook book, bytes32 id, string memory app, address publisher, string memory appRef,
        string memory configCid, string memory label, bool isPublic) external returns (bytes32)
    {
        (bytes32 appId, uint256 idx) = parseRef(appRef);
        ISVCatalog cat = catalog(book);
        ISVCatalog.Version memory v = cat.getVersion(appId, idx);
        if (keccak256(bytes(v.version)) != keccak256(bytes(label))) revert LabelMismatch();
        ISVCatalog.App memory a = cat.getApp(appId);
        if (keccak256(bytes(a.slug)) != keccak256(bytes(app)) || a.publisher != publisher) revert LabelMismatch();
        ISVLedger L = ledger(book);
        ISVLedger.Deployment memory d = L.get(id);
        if (d.owner != address(this)) revert NotMine(id);
        if (d.isPublic != isPublic) revert LabelMismatch();
        if (keccak256(bytes(d.appRef)) != keccak256(bytes(appRef))) L.setAppRef(id, appRef);
        if (keccak256(bytes(d.configCid)) != keccak256(bytes(configCid))) L.setConfig(id, configCid);
        return keccak256(abi.encode(appRef, configCid));
    }

    function actionBit(string memory name) public pure returns (uint256) {
        bytes32 h = keccak256(bytes(name));
        if (h == keccak256("deploy.create")) return 1 << 0;
        if (h == keccak256("deploy.fund")) return 1 << 1;
        if (h == keccak256("deploy.setAppRef")) return 1 << 2;
        if (h == keccak256("deploy.setConfig")) return 1 << 3;
        if (h == keccak256("deploy.setShares")) return 1 << 4;
        if (h == keccak256("deploy.setMaxRate")) return 1 << 5;
        if (h == keccak256("deploy.setActive")) return 1 << 6;
        if (h == keccak256("deploy.refund")) return 1 << 7;
        if (h == keccak256("app.publish")) return 1 << 8;
        // off-chain API scopes, enforced by the relay and the hosts from this mask
        if (h == keccak256("api.status")) return 1 << 128;
        if (h == keccak256("api.logs")) return 1 << 129;
        if (h == keccak256("api.restart")) return 1 << 130;
        if (h == keccak256("api.upload")) return 1 << 131;
        if (h == keccak256("api.appAccess")) return 1 << 132;
        if (h == keccak256("api.placement")) return 1 << 133;
        if (h == keccak256("api.account")) return 1 << 134;      // a relay account token (sign-in, SSO)
        revert UnknownAction();
    }

    function envOf(string memory name) public pure returns (uint8) {
        bytes32 h = keccak256(bytes(name));
        if (h == keccak256("staging")) return 1;
        if (h == keccak256("prod")) return 2;
        revert UnknownEnvironment();
    }

    /// "catalog://0x<64 hex>/<decimal index>" -> (appId, index). Strict AND
    /// canonical, so one version has exactly one spelling: lower-case "0x" and
    /// hex, 1-10 decimal digits with no leading zero, nothing after.
    function parseRef(string memory ref) public pure returns (bytes32 appId, uint256 idx) {
        bytes memory b = bytes(ref);
        if (b.length < 78 || b.length > 87) revert BadRef();
        bytes memory pre = "catalog://0x";
        for (uint256 i = 0; i < 12; i++) if (b[i] != pre[i]) revert BadRef();
        for (uint256 i = 12; i < 76; i++) if (uint8(b[i]) >= 65 && uint8(b[i]) <= 70) revert BadRef();
        bool ok;
        (appId, ok) = parseHex32(b, 10);
        if (!ok || b[76] != "/" || (b.length > 78 && b[77] == "0")) revert BadRef();
        for (uint256 i = 77; i < b.length; i++) {
            uint8 c = uint8(b[i]);
            if (c < 48 || c > 57) revert BadRef();
            idx = idx * 10 + (c - 48);
        }
    }

    /// "0x" + 64 hex digits starting at `at`
    function parseHex32(bytes memory b, uint256 at) public pure returns (bytes32 v, bool ok) {
        if (b.length < at + 66 || b[at] != "0" || (b[at + 1] != "x" && b[at + 1] != "X")) return (0, false);
        uint256 acc;
        for (uint256 i = at + 2; i < at + 66; i++) {
            uint8 c = uint8(b[i]);
            uint256 d;
            if (c >= 48 && c <= 57) d = c - 48;
            else if (c >= 97 && c <= 102) d = c - 87;
            else if (c >= 65 && c <= 70) d = c - 55;
            else return (0, false);
            acc = (acc << 4) | d;
        }
        return (bytes32(acc), true);
    }
}

contract SessionVault {
    // ---- shared by every clone (immutables live in the implementation's code) ----
    ISVToken  public immutable usdc;
    ISVBook   public immutable book;
    ISVRouter public immutable router;          // pinned: PaymentRouter is immutable itself
    address   public immutable factory;
    ISVKeyAttestations public immutable keyAttestations;   // 0 = measurement-bound grants refused
    uint256   public immutable maxVault6;       // beta cap: a deposit may not lift the vault above this

    bytes32 private constant BOOK_DEPLOYMENTS = "deployments";
    bytes32 private constant BOOK_FACTORY = "sessionVaultFactory";
    address private constant P256_VERIFY = address(0x100);

    // ---- action table: bit i of Session.actions; bits >= 128 are off-chain API scopes ----
    uint8 public constant ACT_CREATE = 0;      // deploy.create
    uint8 public constant ACT_FUND = 1;        // deploy.fund
    uint8 public constant ACT_SET_APPREF = 2;  // deploy.setAppRef (staging only)
    uint8 public constant ACT_SET_CONFIG = 3;  // deploy.setConfig (staging only)
    uint8 public constant ACT_SET_SHARES = 4;  // deploy.setShares
    uint8 public constant ACT_SET_MAXRATE = 5; // deploy.setMaxRate
    uint8 public constant ACT_SET_ACTIVE = 6;  // deploy.setActive
    uint8 public constant ACT_REFUND = 7;      // deploy.refund
    uint8 public constant ACT_PUBLISH = 8;     // app.publish
    uint8 private constant ACT_LAST = 8;       // (9 was order.pay: dropped before launch - an orderRef binds no payer)
    uint256 private constant CLOSE_FEE_MAX6 = 20_000;   // what close() may charge for the keeper's gas: $0.02
    bytes4 private constant SEL_TRANSFER = bytes4(keccak256("transferDeployment(bytes32,address)"));
    bytes4 private constant SEL_MULTICALL = bytes4(keccak256("multicall(bytes[])"));

    uint8 public constant ENV_STAGING = 1;
    uint8 public constant ENV_PROD = 2;

    uint8 private constant LIVE = 1;
    uint8 private constant ENDED = 2;
    uint256 private constant MAX_APPS = 8;
    // secp256k1n / 2: signatures above it are the malleable twin (a public
    // curve constant, written in halves so secret scanners don't take it for a key)
    uint256 private constant HALF_N =
        (uint256(0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF) << 128) | 0x5D576E7357A4501DDFE92F46681B20A0;

    // ---- EIP-712 ----
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("Enclave Sessions");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 public constant GRANT_TYPEHASH = keccak256(
        "SessionGrant(string label,string preset,bytes32 sessionKey,string[] actions,string[] apps,"
        "string[] environments,uint256 budget,uint256 spendPerPeriod,uint32 periodSeconds,uint32 opsPerPeriod,"
        "uint256 maxFeePerOp,uint256 maxAppFeePerHour,uint256 maxRatePerHour,uint64 expiresAt,bytes32 measurement,"
        "bytes32 grantNonce,uint64 signBefore)");
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
    bytes32 public constant PROMOTE_TYPEHASH = keccak256(
        "Promote(bytes32 deployment,string app,address publisher,string appRef,string configCid,string versionLabel,"
        "bool isPublic,bytes32 opNonce,uint64 signBefore)");
    bytes32 public constant ADOPT_TYPEHASH =
        keccak256("Adopt(bytes32 deployment,string environment,bytes32 opNonce,uint64 signBefore)");
    bytes32 public constant SETENV_TYPEHASH =
        keccak256("SetEnvironment(bytes32 deployment,string environment,bytes32 opNonce,uint64 signBefore)");
    bytes32 public constant RELEASE_TYPEHASH =
        keccak256("Release(bytes32 deployment,address to,bytes32 opNonce,uint64 signBefore)");

    // ---- types ----
    struct Grant {
        string   label;            // shown on the device and in /sessions (untrusted text)
        string   preset;           // informational ("browser", "staging-publish", ...)
        bytes32  sessionKey;       // keccak256(abi.encode(x, y)) of the P-256 public key
        string[] actions;          // names from the action table ("deploy.fund", "api.logs", ...)
        string[] apps;             // "*" | a slug under this vault | "0x<64 hex appId>"
        string[] environments;     // "staging" and/or "prod"
        uint256  budget;           // USDC 6dp escrowed for this session
        uint256  spendPerPeriod;   // USDC 6dp spendable per period (amounts + fees)
        uint32   periodSeconds;    // > 0
        uint32   opsPerPeriod;     // on-chain ops per period; 0 = unlimited
        uint256  maxFeePerOp;      // USDC 6dp ceiling on a single op's relay fee
        uint256  maxAppFeePerHour; // USDC 6dp ceiling on a created deployment's publisher fee
        uint256  maxRatePerHour;   // USDC 6dp ceiling on any rate cap the session sets (create, setMaxRate)
        uint64   expiresAt;
        bytes32  measurement;      // 0 = no TEE requirement (attested keys)
        bytes32  grantNonce;
        uint64   signBefore;
    }

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

    struct Held {
        uint8   env;        // 0 = unadopted (inert), ENV_STAGING, ENV_PROD
        bytes32 promoted;   // keccak256(abi.encode(appRef, configCid)) the OWNER last promoted (prod)
        bytes32 createdBy;  // session id that created it, 0 for owner-adopted
    }

    // ---- storage (per clone) ----
    address public owner;
    uint64  public epoch;
    uint256 public locked6;              // sum of live sessions' balances
    uint256 private _lock;               // 1 = free, 2 = entered
    mapping(bytes32 => Session) private _s;
    mapping(bytes32 => bytes32[]) private _apps;
    mapping(bytes32 => mapping(uint192 => uint64)) public seqOf;
    mapping(bytes32 => bool) public ownerNonceUsed;
    mapping(bytes32 => Held) public held;

    // ---- events ----
    event SessionOpened(bytes32 indexed sid, bytes32 indexed keyHash, uint64 expiresAt, uint256 actions,
        uint8 envs, uint256 budget6, string label);
    event SessionOp(bytes32 indexed sid, uint256 nonce, uint8 indexed action, bytes32 argsHash,
        uint256 amount6, uint256 fee6, bytes result);
    event ToppedUp(bytes32 indexed sid, uint256 amount6, bool fromWallet);
    event Extended(bytes32 indexed sid, uint64 expiresAt);
    /// reason: 1 terminated by owner, 2 terminated by the session key, 3 closed after expiry,
    ///         4 closed after revokeAll
    event SessionEnded(bytes32 indexed sid, uint8 reason, uint256 refund6, uint256 fee6);
    event RevokedAll(uint64 epoch, uint256 withdrawn6);
    event Withdrawn(uint256 amount6);
    event HeldSet(bytes32 indexed id, uint8 env, bytes32 createdBy);
    event Promoted(bytes32 indexed id, bytes32 promoted, string appRef, string configCid);
    event Released(bytes32 indexed id, address to);

    // ---- errors ----
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
    error UnknownAction();
    error UnknownEnvironment();
    error BadPolicy(uint8 code);
    error NotAllowed(uint8 action);
    error EnvNotAllowed(uint8 env);
    error AppNotAllowed(bytes32 appId);
    error BudgetExceeded(uint256 need, uint256 have);
    error PeriodLimit(uint256 need, uint256 left);
    error RateLimit();
    error FeeTooHigh(uint256 fee, uint256 max);
    error AppFeeTooHigh(uint256 perHour, uint256 max);
    error BadRef();
    error NotHeld(bytes32 id);
    error WrongEnvironment(bytes32 id, uint8 env);
    error NotMine(bytes32 id);
    error LabelMismatch();
    error BadTarget();
    error OverCap(uint256 balance, uint256 cap);
    error Insolvent();
    error AllowanceLeft();
    error NoAttestation();
    error TransferFailed();
    error NoContract(bytes32 key);
    error RateCapOutOfRange(uint256 rate, uint256 limit);

    modifier nonReentrant() {
        if (_lock == 2) revert Reentrant();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(ISVToken _usdc, ISVBook _book, ISVRouter _router, ISVKeyAttestations _ka, uint256 _maxVault6) {
        usdc = _usdc; book = _book; router = _router; keyAttestations = _ka; maxVault6 = _maxVault6;
        factory = msg.sender;
        owner = address(1);          // the implementation itself can never be initialized or used
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

    /// Open a session whose budget (possibly 0) comes from the vault's free
    /// balance. The owner calls directly, or anyone submits the owner's
    /// signature over the SessionGrant.
    function open(Grant calldata g, bytes calldata ownerSig) external nonReentrant returns (bytes32 sid) {
        bytes32 gd = _hashTypedData(_hashGrant(g));
        _checkGrantAuth(gd, g.signBefore, ownerSig);
        if (g.budget > _free()) revert BudgetExceeded(g.budget, _free());
        sid = _open(g);
    }

    /// Open a session funded from the owner's wallet in the same transaction:
    /// the readable grant signature plus a USDC EIP-3009 ReceiveWithAuthorization
    /// for exactly `g.budget` whose nonce IS the grant digest, so the
    /// authorization can fund this grant and nothing else.
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
        sid = keccak256(abi.encode(address(this), g.sessionKey, g.grantNonce));
        Session storage s = _s[sid];
        if (s.state != 0) revert Exists();
        if (g.measurement != bytes32(0)) _requireAttested(g.sessionKey, g.measurement);

        uint256 acts;
        for (uint256 i = 0; i < g.actions.length; i++) acts |= SessionVaultLib.actionBit(g.actions[i]);
        uint8 envs;
        for (uint256 i = 0; i < g.environments.length; i++) envs |= SessionVaultLib.envOf(g.environments[i]);

        bool anyApp;
        bytes32[] storage ids = _apps[sid];
        for (uint256 i = 0; i < g.apps.length; i++) {
            bytes memory a = bytes(g.apps[i]);
            if (a.length == 1 && a[0] == "*") { anyApp = true; continue; }
            (bytes32 hexId, bool isHex) = SessionVaultLib.parseHex32(a, 0);
            if (isHex && a.length == 66) ids.push(hexId);
            else ids.push(SessionVaultLib.appIdOf(book, g.apps[i]));
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

    /// Execute one action from the session's policy. `nonce` = (lane << 64) | seq,
    /// where seq must equal seqOf[sid][lane] (independent lanes let an agent run
    /// operations concurrently). The session key signs the EIP-712 SessionCall
    /// digest; the P-256 check runs over sha256(digest), which is what WebCrypto
    /// and node:crypto ECDSA-with-SHA-256 sign.
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
        if (action > ACT_LAST || ((s.actions >> action) & 1) == 0) revert NotAllowed(action);
        if (fee > s.maxFee6) revert FeeTooHigh(fee, s.maxFee6);
        if (s.measurement != bytes32(0)) _requireAttested(s.keyHash, s.measurement);

        uint256 amount = _amountOf(action, args);
        _spend(s, amount + fee);
        result = _dispatch(sid, s, action, args, amount);
        if (fee > 0) _payRouter(fee, keccak256(abi.encode("enclave.session.fee", address(this), sid, nonce)));
        emit SessionOp(sid, nonce, action, argsHash, amount, fee, result);
    }

    /// The session ends itself (sign-out). Refunds the remaining balance to the owner.
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

    /// Anyone (the keeper) closes an expired session, or one killed by revokeAll.
    /// The refund goes to the owner; the closer is reimbursed at most maxFeePerOp,
    /// paid to the treasury via the router.
    function close(bytes32 sid) external nonReentrant {
        Session storage s = _s[sid];
        if (s.state != LIVE) revert NotLive();
        if (s.epoch != epoch) {                       // revokeAll already freed its balance
            s.state = ENDED;
            s.balance6 = 0;
            emit SessionEnded(sid, 4, 0, 0);
            return;
        }
        if (block.timestamp <= s.expiresAt) revert NotExpired();
        // the keeper's real cost (~90k gas), never the session's whole fee ceiling
        uint256 fee = s.maxFee6 < CLOSE_FEE_MAX6 ? s.maxFee6 : CLOSE_FEE_MAX6;
        if (fee > s.balance6) fee = s.balance6;
        _end(sid, s, 3, fee);
    }

    // =========================================================================
    // Owner operations: direct (msg.sender == owner) or owner-signed (anyone submits)
    // =========================================================================

    /// Move `amount` of the vault's free balance into a live session.
    function topUp(bytes32 sid, uint256 amount, bytes32 opNonce, uint64 signBefore, bytes calldata sig)
        external nonReentrant
    {
        _ownerAuth(keccak256(abi.encode(TOPUP_TYPEHASH, sid, amount, opNonce, signBefore)), opNonce, signBefore, sig);
        if (amount > _free()) revert BudgetExceeded(amount, _free());
        _credit(sid, amount, false);
    }

    /// Top up from the owner's wallet with ONE signature: a USDC EIP-3009
    /// ReceiveWithAuthorization whose nonce is the TopUp digest (sid, amount,
    /// opNonce, validBefore), so the authorization funds this top-up only.
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
        // expired is fine: the owner may always end it themselves, with no keeper fee
        if (s.state != LIVE || s.epoch != epoch) revert NotLive();
        _end(sid, s, 1, 0);
    }

    /// Kill switch: every session dies in O(1) (their epoch goes stale) and all
    /// escrow becomes free balance; with `withdraw` the whole vault balance goes
    /// to the owner in the same call.
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

    /// Free balance to the owner - there is no recipient argument.
    function withdraw(uint256 amount, bytes32 opNonce, uint64 signBefore, bytes calldata sig) external nonReentrant {
        _ownerAuth(keccak256(abi.encode(WITHDRAW_TYPEHASH, amount, opNonce, signBefore)), opNonce, signBefore, sig);
        if (amount > _free()) revert BudgetExceeded(amount, _free());
        _send(owner, amount);
        emit Withdrawn(amount);
    }

    /// Production promotion: point a held deployment at (appRef, configCid) and
    /// record that the OWNER sanctioned exactly that pair. versionLabel must equal
    /// the catalog's label for the ref, so the device shows a verified "1.0.79".
    function promote(bytes32 id, string calldata app, address publisher, string calldata appRef,
        string calldata configCid, string calldata versionLabel, bool isPublic, bytes32 opNonce, uint64 signBefore,
        bytes calldata sig) external nonReentrant
    {
        _ownerAuth(keccak256(abi.encode(PROMOTE_TYPEHASH, id, keccak256(bytes(app)), publisher, keccak256(bytes(appRef)),
            keccak256(bytes(configCid)), keccak256(bytes(versionLabel)), isPublic, opNonce, signBefore)),
            opNonce, signBefore, sig);
        Held storage h = held[id];
        // the ONLY way into production: what runs is exactly what the owner reviewed (an
        // unadopted record the vault owns is adopted by it, as prod)
        h.promoted = SessionVaultLib.promote(book, id, app, publisher, appRef, configCid, versionLabel, isPublic);
        if (h.env != ENV_PROD) { h.env = ENV_PROD; emit HeldSet(id, ENV_PROD, h.createdBy); }
        emit Promoted(id, h.promoted, appRef, configCid);
    }

    /// Take a deployment this vault already owns on the ledger (moved in by
    /// transferDeployment) under management. Until adopted it is inert: no
    /// session may touch it, and secret release refuses it. Adopting as prod
    /// promotes its current (appRef, configCid).
    function adopt(bytes32 id, string calldata environment, bytes32 opNonce, uint64 signBefore, bytes calldata sig)
        external nonReentrant
    {
        _ownerAuth(keccak256(abi.encode(ADOPT_TYPEHASH, id, keccak256(bytes(environment)), opNonce, signBefore)),
            opNonce, signBefore, sig);
        Held storage h = held[id];
        if (h.env != 0) revert Exists();
        _setEnv(id, h, SessionVaultLib.envOf(environment));
        emit HeldSet(id, h.env, bytes32(0));
    }

    function setEnvironment(bytes32 id, string calldata environment, bytes32 opNonce, uint64 signBefore,
        bytes calldata sig) external nonReentrant
    {
        _ownerAuth(keccak256(abi.encode(SETENV_TYPEHASH, id, keccak256(bytes(environment)), opNonce, signBefore)),
            opNonce, signBefore, sig);
        Held storage h = held[id];
        if (h.env == 0) revert NotHeld(id);
        _setEnv(id, h, SessionVaultLib.envOf(environment));
        emit HeldSet(id, h.env, h.createdBy);
    }

    /// Hand a held deployment back to the owner's wallet, or to the owner's vault
    /// at the book's CURRENT factory (a derived destination - never a free choice).
    /// The ledger refuses while refundable escrow is attributed to this vault.
    function release(bytes32 id, address to, bytes32 opNonce, uint64 signBefore, bytes calldata sig)
        external nonReentrant
    {
        _ownerAuth(keccak256(abi.encode(RELEASE_TYPEHASH, id, to, opNonce, signBefore)), opNonce, signBefore, sig);
        if (to != owner) {
            address f = book.addr(BOOK_FACTORY);
            if (f == address(0) || to != ISVFactory(f).vaultFor(owner) || to == address(this)) revert BadTarget();
        }
        _ledger().transferDeployment(id, to);
        delete held[id];
        emit Released(id, to);
    }

    /// The owner's full authority over what the vault holds, for anything the
    /// typed operations don't cover (yank, delist, edit an app, act on a
    /// deployment while the book is broken). DIRECT ONLY - never signable, so a
    /// phished signature can't reach it - and never USDC or the vault itself, so
    /// it cannot touch escrow or session state.
    function ownerCall(address target, bytes calldata data) external nonReentrant returns (bytes memory ret) {
        if (msg.sender != owner) revert NotOwner();
        if (target == address(usdc) || target == address(this) || target.code.length == 0) revert BadTarget();
        // a batch could carry a transferDeployment the custody cleanup below can't see: one call at a time
        if (data.length >= 4 && bytes4(data[:4]) == SEL_MULTICALL) revert BadTarget();
        bool ok;
        (ok, ret) = target.call(data);
        if (!ok) assembly ("memory-safe") { revert(add(ret, 32), mload(ret)) }
        if (usdc.balanceOf(address(this)) < locked6) revert Insolvent();
        // a deployment handed away here must come back UNADOPTED if it ever returns
        if (data.length >= 36 && bytes4(data[:4]) == SEL_TRANSFER) delete held[bytes32(data[4:36])];
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

    /// The full session record. balance6 is the EFFECTIVE balance (0 once a
    /// revokeAll has freed it); live folds state, epoch and expiry together.
    function sessionOf(bytes32 sid) external view returns (Session memory s, bool live, bytes32[] memory apps) {
        live = _live(_s[sid]);
        s = _s[sid];
        if (s.epoch != epoch) s.balance6 = 0;
        apps = _apps[sid];
    }

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
        if (fee > 0) _payRouter(fee, keccak256(abi.encode("enclave.session.close", address(this), sid)));
        uint256 refund = bal - fee;
        if (refund > 0) _send(owner, refund);
        emit SessionEnded(sid, reason, refund, fee);
    }

    /// Environment changes never promote: a record entering prod (adopt or move)
    /// starts UNPROMOTED - no prod secrets - until the owner's Promote names the
    /// exact version and config it may run. Otherwise whatever a staging session
    /// pointed it at the moment before would be what got promoted.
    function _setEnv(bytes32 id, Held storage h, uint8 env) private {
        if (env != ENV_STAGING && env != ENV_PROD) revert UnknownEnvironment();
        if (SessionVaultLib.ownerOf(book, id) != address(this)) revert NotMine(id);
        h.env = env;
        h.promoted = bytes32(0);
    }

    function _ownerAuth(bytes32 structHash, bytes32 opNonce, uint64 signBefore, bytes calldata sig) private {
        if (msg.sender == owner) return;
        if (block.timestamp > signBefore) revert Expired();
        if (ownerNonceUsed[opNonce]) revert NonceUsed();
        ownerNonceUsed[opNonce] = true;
        if (!_ownerSigValid(_hashTypedData(structHash), sig)) revert BadSignature();
    }

    /// ECDSA from the owner EOA (low-s, v 27/28); failing that, ERC-1271 when the
    /// owner carries code (a Safe, or an EIP-7702 account whose delegate speaks 1271).
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
        if (action == ACT_CREATE) return abi.encode(_create(sid, s, abi.decode(args, (CreateArgs))));
        if (action == ACT_PUBLISH) {
            (bytes32 appId, uint256 index) = _publish(sid, abi.decode(args, (PublishArgs)));
            return abi.encode(appId, index);
        }
        ISVLedger L = _ledger();
        if (action == ACT_FUND) {
            (bytes32 id, ) = abi.decode(args, (bytes32, uint256));
            // only records THIS vault holds: a deployment anyone could transfer to the
            // owner's wallet carries a fee and a rate cap the session never vetted
            if (SessionVaultLib.ownerOf(book, id) != address(this)) revert NotMine(id);
            _requireHeldEnv(s, id);
            // ... at a cap the grant allows and a rate that buys runtime
            SessionVaultLib.prepareFund(book, id, s.maxRateHour6);
            _fund(L, id, amount, address(this));
            return "";
        }
        if (action == ACT_SET_APPREF) {
            (bytes32 id, string memory ref) = abi.decode(args, (bytes32, string));
            if (_requireHeldEnv(s, id) != ENV_STAGING) revert WrongEnvironment(id, held[id].env);
            (bytes32 appId, ) = SessionVaultLib.parseRef(ref);
            _requireApp(sid, s, appId);
            L.setAppRef(id, ref);
            return "";
        }
        if (action == ACT_SET_CONFIG) {
            (bytes32 id, string memory cfg) = abi.decode(args, (bytes32, string));
            if (_requireHeldEnv(s, id) != ENV_STAGING) revert WrongEnvironment(id, held[id].env);
            L.setConfig(id, cfg);
            return "";
        }
        if (action == ACT_SET_SHARES) {
            (bytes32 id, uint16 g, uint16 c) = abi.decode(args, (bytes32, uint16, uint16));
            _requireHeldEnv(s, id);
            L.setShares(id, g, c);
            return "";
        }
        if (action == ACT_SET_MAXRATE) {
            (bytes32 id, uint256 r) = abi.decode(args, (bytes32, uint256));
            SessionVaultLib.checkMaxRate(book, id, r, _requireHeldEnv(s, id) == ENV_PROD, s.maxRateHour6);
            L.setMaxRate(id, r);
            return "";
        }
        if (action == ACT_SET_ACTIVE) {
            (bytes32 id, bool a) = abi.decode(args, (bytes32, bool));
            _requireHeldEnv(s, id);
            L.setActive(id, a);
            return "";
        }
        // ACT_REFUND: the ledger pays d.owner = this vault; the proceeds are FREE
        // balance (the owner's), never the session's
        (bytes32 rid) = abi.decode(args, (bytes32));
        _requireHeldEnv(s, rid);
        L.refund(rid);
        return "";
    }

    function _create(bytes32 sid, Session storage s, CreateArgs memory c) private returns (bytes32 id) {
        if (c.env != ENV_STAGING && c.env != ENV_PROD) revert UnknownEnvironment();
        if (s.envs & c.env == 0) revert EnvNotAllowed(c.env);
        (bytes32 appId, uint256 idx) = SessionVaultLib.parseRef(c.appRef);
        _requireApp(sid, s, appId);
        if (c.maxRate6 * 3600 > s.maxRateHour6) revert RateCapOutOfRange(c.maxRate6 * 3600, s.maxRateHour6);
        id = SessionVaultLib.create(book, c, appId, idx, s.maxAppFeeHour6, _appListed(sid, appId));
        if (held[id].env != 0) revert Exists();          // a hostile ledger can't overwrite a custody record
        held[id] = Held({ env: c.env, promoted: bytes32(0), createdBy: sid });
        emit HeldSet(id, c.env, sid);
        if (c.fund6 > 0) _fund(_ledger(), id, c.fund6, address(this));
    }

    function _publish(bytes32 sid, PublishArgs memory p) private returns (bytes32, uint256) {
        bytes32 appId = SessionVaultLib.appIdOf(book, p.slug);
        // publishing needs the app NAMED in the grant - "*" never covers it
        if (!_appListed(sid, appId)) revert AppNotAllowed(appId);
        return SessionVaultLib.publish(book, p);
    }

    function _requireHeldEnv(Session storage s, bytes32 id) private view returns (uint8 env) {
        env = held[id].env;
        if (env == 0) revert NotHeld(id);
        if (s.envs & env == 0) revert EnvNotAllowed(env);
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

    function _ledger() private view returns (ISVLedger) {
        address a = book.addr(BOOK_DEPLOYMENTS);
        if (a == address(0)) revert NoContract(BOOK_DEPLOYMENTS);
        return ISVLedger(a);
    }

    function _hashTypedData(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function _hashGrant(Grant calldata g) private pure returns (bytes32) {
        // two halves: one abi.encode of all 17 words overflows the stack
        bytes memory head = abi.encode(
            GRANT_TYPEHASH, keccak256(bytes(g.label)), keccak256(bytes(g.preset)), g.sessionKey,
            _hashStrings(g.actions), _hashStrings(g.apps), _hashStrings(g.environments), g.budget);
        bytes memory tail = abi.encode(
            g.spendPerPeriod, g.periodSeconds, g.opsPerPeriod, g.maxFeePerOp, g.maxAppFeePerHour, g.maxRatePerHour,
            g.expiresAt, g.measurement, g.grantNonce, g.signBefore);
        return keccak256(bytes.concat(head, tail));
    }

    function _hashStrings(string[] calldata a) private pure returns (bytes32) {
        bytes32[] memory h = new bytes32[](a.length);
        for (uint256 i = 0; i < a.length; i++) h[i] = keccak256(bytes(a[i]));
        return keccak256(abi.encodePacked(h));
    }

}

/// Deploys the implementation once, then one EIP-1167 clone per owner at a
/// CREATE2 address salted by the owner - knowable (and nameable in an EIP-712
/// domain) before it exists. Anyone may create a vault for anyone: the salt
/// binds the owner, so there is nothing to front-run. No owner, no admin.
contract SessionVaultFactory {
    SessionVault public immutable implementation;
    mapping(address => bool) public isVault;

    event VaultCreated(address indexed owner, address vault);

    constructor(ISVToken usdc, ISVBook book, ISVRouter router, ISVKeyAttestations keyAttestations, uint256 maxVault6) {
        implementation = new SessionVault(usdc, book, router, keyAttestations, maxVault6);
    }

    function vaultFor(address owner) public view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(
            bytes1(0xff), address(this), bytes32(uint256(uint160(owner))), keccak256(_cloneCode()))))));
    }

    /// Idempotent: returns the existing vault when there is one.
    function createVault(address owner) public returns (address vault) {
        vault = vaultFor(owner);
        if (vault.code.length != 0) return vault;
        bytes memory code = _cloneCode();
        bytes32 salt = bytes32(uint256(uint160(owner)));
        assembly ("memory-safe") { vault := create2(0, add(code, 0x20), mload(code), salt) }
        require(vault != address(0), "create2");
        isVault[vault] = true;
        SessionVault(vault).initialize(owner);
        emit VaultCreated(owner, vault);
    }

    /// First sign-in in one transaction: make the vault if needed, then open
    /// (the vault still requires the owner's grant signature - the factory is
    /// just another submitter).
    function openFor(address owner, SessionVault.Grant calldata g, bytes calldata ownerSig)
        external returns (address vault, bytes32 sid)
    {
        vault = createVault(owner);
        sid = SessionVault(vault).open(g, ownerSig);
    }

    function openWithDepositFor(address owner, SessionVault.Grant calldata g, bytes calldata ownerSig,
        uint256 validAfter, uint256 validBefore, bytes calldata authSig) external returns (address vault, bytes32 sid)
    {
        vault = createVault(owner);
        sid = SessionVault(vault).openWithDeposit(g, ownerSig, validAfter, validBefore, authSig);
    }

    function _cloneCode() private view returns (bytes memory) {
        return abi.encodePacked(
            hex"3d602d80600a3d3981f3363d3d373d3d3d363d73",
            address(implementation),
            hex"5af43d82803e903d91602b57fd5bf3");
    }
}
