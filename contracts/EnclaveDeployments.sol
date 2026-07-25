// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title EnclaveDeployments — portable deployment ledger + failover lease market for Enclave.
/// @notice Makes a deployment a CHAIN OBJECT instead of one enclave's private state,
///         so any registered enclave can pick up a deployment whose runner died and
///         keep serving it until the funded time runs out. Three things move on-chain
///         that today live only in a supervisor's state.json:
///           1. the INTENT  — what to run (appRef), with what share/ports/visibility;
///           2. the BALANCE — funded runtime, credited by payments, burned by leases;
///           3. the LEASE   — which enclave is serving it right now, and until when.
///         Deployments become work items in a queue: an enclave CLAIMS one (taking a
///         bounded lease and burning its cost from the balance), RENEWs while healthy,
///         and RELEASEs on graceful shutdown (refunding the unused tail). If a runner
///         dies silently, its lease simply expires and any other enclave may claim
///         the remainder — at-most-one-runner-at-a-time is enforced by the chain, not
///         by an operator.
///
/// Non-custodial for the PLATFORM and PUBLISHER, like EnclavePay: their splits of every
///         funding forward payer -> payout / publisher wallet in the SAME transaction.
///         `balance6` is an ACCOUNTING number (prepaid runtime, USDC 6dp), not escrowed
///         money — so leases can "burn" and "refund" it freely, but stopping a deployment
///         cannot push funds back to the payer on-chain (that stays a payout-wallet
///         action, as today). The one deliberately CUSTODIED slice (rev 7) is the
///         RUNNER's share: it stays in this contract as per-deployment escrow until a
///         runner has actually held the lease for the seconds it pays for — that escrow
///         is exactly what makes seller payout trustless (a permissionless runner is
///         paid by the chain, not by an invoice to the platform). Bonds (optional
///         anti-sybil, below) and earned-but-unwithdrawn runner balances are the only
///         other funds ever held here.
///
/// Trust model (consistent with the other Enclave contracts — claims here, attestation
///         gates trust at connect time):
///   - CREATE is permissionless: any address records an intent (it is inert until
///     funded — an unfunded deployment cannot be claimed and costs nobody anything).
///   - CLAIM is structurally gated to registered enclaves: msg.sender must be the
///     operator of an active EnclaveRegistry entry. That does NOT make the runner
///     trusted — callers still attest the enclave itself when they connect. A rogue
///     operator can claim, but can't fake the measurement clients verify.
///   - Catalog approval is enforced by RUNNERS, off-chain, exactly as today: an
///     enclave refuses to claim an ipfs:// appRef whose version isn't Approved in
///     EnclaveAppCatalog (one cidStatus eth_call, fail closed). The ledger doesn't parse
///     appRefs; the enclave that would run the code is the one that checks it.
///   - Pricing: two global per-second prices, hardcoded at deploy (~$6.00/hour
///     for a full GPU card, ~$3.00/hour for a full CPU node — cpuPricePerSec6=834)
///     and owner-adjustable
///     later; each deployment SNAPSHOTS its rate at create (price changes never
///     re-price existing deployments). A deployment BUYS two shares — gpuMilli
///     of a card's GPU+VRAM and cpuMilli of a node's vCPU+RAM, in 1/1000ths —
///     and pays for both: rate = (gpuPrice * gpuMilli + cpuPrice * cpuMilli)
///     / 1000, rounded up. Apps declare their EXACT resource specs (VRAM,
///     TFLOPS, RAM) in EnclaveAppCatalog; runners convert those specs into each
///     app's MINIMUM shares (spec / their hardware, the larger of the memory
///     and compute axes) and refuse deployments that bought less.
///   - Publisher fee: a catalog version may declare a per-second publisher fee
///     (EnclaveAppCatalog.versionFee, capped at publish). A deployment SNAPSHOTS
///     that fee and its payee at create — rate = platform shares + fee — and
///     every funding is split in the same transaction: the fee's pro-rata cut
///     straight to the publisher's wallet, the rest to payout. The ledger still
///     never parses appRefs: clients copy the fee from the catalog before the
///     signature, and RUNNERS refuse to claim a deployment that under-declares
///     the fee of the version it references (fail closed, exactly like catalog
///     approval — the enclave that would run the code checks the price too).
///   - Runner payout (rev 7): each deployment snapshots a per-second RUNNER cut
///     (runnerBps of the platform component); USDC fundings leave that share in
///     the contract as escrow, and the operator EOA holding the lease is
///     credited as lease time elapses (claim/renew/release/settle advance the
///     meter). withdrawEarnings pays the accrued total to any address. This is
///     what makes permissionless selling real (metal/PROTOCOL.md Phase C): the
///     seller's payout comes from chain-held escrow, not a platform promise.
///     An optional claim bond (off by default) prices sybil claims.
///
/// Fairness bounds (the cost of decentralized failover, all bounded by leaseSec):
///   - a runner that dies mid-lease has already burned that lease: the user loses at
///     most leaseSec of paid time per runner death (clean shutdowns refund via
///     release; the old per-tick freezing clock can't exist without a trusted party).
///   - two enclaves may race to claim; the loser's tx reverts (gas, cents on Base).
interface IERC20Auth {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    /// EIP-3009 (FiatTokenV2_2 bytes-signature variant: ECDSA or EIP-1271, so
    /// smart-contract wallets can pay too). Reverts unless to == msg.sender.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;
}

/// @dev Field order MUST match EnclaveRegistry.Enclave exactly (ABI-decoded struct).
interface IEnclaveRegistry {
    struct Enclave {
        string  endpoint;
        string  repo;
        bytes32 measurement;
        address operator;
        uint64  registeredAt;
        uint64  lastSeen;
        bool    active;
    }
    function get(bytes32 id) external view returns (Enclave memory);
}

/// @dev Chainlink price feed (ETH/USD, 8 decimals on Base).
interface IAggregatorV3 {
    function latestRoundData() external view returns (
        uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound
    );
}

contract EnclaveDeployments {
    struct Deployment {
        bytes32 id;
        address owner;          // the user: controls config + active, receives nothing (non-custodial)
        string  appRef;         // "catalog://<appId>/<versionIndex>" (raw "ipfs://<cid>" refs are refused by runners)
        string  ports;          // firewall CSV, same grammar as EnclaveAppCatalog Version.ports ("" = plain wasi:http)
        string  configCid;      // "" or the deployment-options envelope {"waf":{…},"config":{…}}
                                // (inline JSON interpreted by runners; raw CIDs are refused by them —
                                // the field name survives from the retired CID design). NOTE: the
                                // whole string is PUBLIC on-chain; see DEPLOYMENTS.md "secrets".
        uint16  gpuMilli;       // GPU/VRAM share bought, in 1/1000ths of a card (0 = CPU-only
                                // deployment). GPU deployments (gpuMilli > 0) are claimable by GPU
                                // enclaves ONLY; CPU-only ones by CPU-only enclaves first, and by GPU
                                // enclaves with spare CPU/RAM after a grace window (runner-enforced).
                                // Must be >= the app's minimum share: runners derive minimums from the
                                // app's exact specs in EnclaveAppCatalog (spec / their hardware, the larger
                                // of the memory and compute axes) and refuse under-provisioned claims.
        uint16  cpuMilli;       // CPU/RAM share bought, in 1/1000ths of a node (1..1000). A GPU
                                // deployment's CPU share rides along on the same node, so it may never
                                // exceed the GPU share: gpuMilli == 0 || gpuMilli >= cpuMilli.
        uint32  appPort;        // guest HTTP port the app serves on
        bool    isPublic;       // anyone may hit the data path (vs owner-only)
        bool    active;         // owner-set; inactive is not claimable/fundable (kept for history)
        uint64  createdAt;
        // ---- billing (USDC 6dp; accounting numbers, never held funds) ----
        uint256 rate;           // per-second price, snapshotted at create
        uint256 balance6;       // funded runtime credit not yet burned by a lease
        uint256 spent6;         // burned by leases (release refunds the unused tail back to balance6)
        // ---- lease (the "processing lock") ----
        bytes32 runner;         // EnclaveRegistry enclave id currently serving (0x0 = unclaimed)
        address runnerOperator; // the operator EOA that claimed (sends renew/release)
        uint64  leaseUntil;     // lease expiry; in the past (or 0) = claimable
    }

    uint256 private constant MAX_APPREF = 100;   // ipfs://<cid> fits
    uint256 private constant MAX_PORTS  = 96;    // mirrors EnclaveAppCatalog
    uint256 private constant MAX_CFG    = 4096; // the deployment-options envelope ({"waf":{…},"config":{…}}); mirrors the runners' DEP_OPTIONS_MAX_BYTES (rev <= 4 capped at 100 — CID-sized)
    uint256 private constant FEED_MAX_AGE = 2 hours; // reject stale ETH/USD answers

    address public owner;                  // sets price/leaseSec/payout; NOT a custodian
    address public pendingOwner;           // two-step handoff: must acceptOwnership()
    address public payout;                 // where funding lands (the Enclave cold wallet)
    IERC20Auth   public immutable usdc;
    IEnclaveRegistry public immutable registry;
    IAggregatorV3 public ethUsdFeed;       // 0x0 = ETH funding disabled (USDC only)

    // Prices are HARDCODED at deploy (no post-deploy setter txs needed — Base's
    // public RPC caps delegated EOAs at one in-flight tx, so follow-up sends
    // right after the deploy bounce). Owner setters remain for later changes.
    uint256 public pricePerSec6 = 1667;    // USDC 6dp per second, FULL card (gpuMilli = 1000): ~$6.00/hour
    uint256 public cpuPricePerSec6 = 834;  // USDC 6dp per second, FULL CPU node (cpuMilli = 1000): ~$3.00/hour
    uint64  public leaseSec = 1800;        // lease quantum: max claim/renew burn, max time lost to a dead runner
    uint16  public maxGpuMilli = 1000;     // per-deployment GPU-share cap, enforced at create() only — the
                                           // catalog still lists apps whose specs exceed it (publishable,
                                           // just not deployable until the cap is raised)
    uint256 public maxFeePerSec6 = 1389;   // cap on the per-second publisher fee (USDC 6dp) a NEW deployment
                                           // may declare: ~$5.00/hour. Mirrors the catalog's publish-time cap
                                           // and bounds what a buggy or hostile client could sign away to a
                                           // fee recipient. Create-only, like maxGpuMilli (imports bypass).

    // Struct-shape revision, sniffed by consumers (site/CLI/relay/runners) the
    // way catalogSchema is: rev 1 (no getter — the call reverts there) carried
    // an sshPubKey string in Deployment/create/setConfig; rev 2 dropped it.
    // Rev 3 keeps the rev-2 struct byte-for-byte and marks the setAppRef
    // surface (owner version changes): struct decodes keep gating on >= 2,
    // the version-change feature gates on >= 3. Rev 4 again keeps the struct
    // byte-for-byte (the publisher-fee snapshot lives in a side mapping) and
    // marks the fee surface: create() grew (feeRecipient, feePerSec6) and
    // feeOf/maxFeePerSec6 exist; the fee feature gates on >= 4. Rev 5 keeps
    // every signature and only widens MAX_CFG from CID-sized (100) to
    // envelope-sized (4096) so configCid can carry the deployment-options
    // envelope's `config` namespace (a per-deployment app-config override);
    // senders gate envelopes over 100 bytes on >= 5 — the rev-4 create()
    // reverts "configCid length" on them.
    // Rev 6 again keeps the struct byte-for-byte and marks the setShares
    // surface (owner share resizes with rate recalculation): the shares are
    // no longer immutable — an owner may re-buy gpuMilli/cpuMilli in place,
    // re-priced at the CURRENT list prices (a resize is a new purchase
    // decision, exactly like create; non-resizing deployments keep their
    // snapshots untouched). The share-resize feature gates on >= 6.
    // Rev 7 once more keeps the struct byte-for-byte (runner-payout state
    // lives in side mappings behind earnOf/earned6/bondOf) and marks the
    // RUNNER-PAYOUT surface: new deployments snapshot a per-second runner
    // rate (runnerBps of the platform component), USDC fundings escrow that
    // share in-contract, lease time credits the serving runner's operator as
    // it elapses, and withdrawEarnings pays it out. The payout feature (and
    // the optional claim bond) gates on >= 7.
    uint256 public constant deploymentsSchema = 7;

    /// @dev Publisher-fee snapshot, taken at create from the catalog version
    ///      the deployment references (recipient = the app's publisher wallet).
    ///      A SIDE MAPPING so the Deployment tuple stays byte-for-byte across
    ///      revs (see deploymentsSchema). Packs into one slot.
    struct Fee { address recipient; uint96 rate6; }

    // ---- runner payout (rev 7) --------------------------------------------
    // The runner's share of every burned lease second, so a permissionless
    // seller (metal/PROTOCOL.md Phase C) is paid BY THE CHAIN for serving.
    //
    //   rate6         per-second runner cut (USDC 6dp), snapshotted at create/
    //                 resize: runnerBps of the PLATFORM component (rate minus
    //                 the publisher fee). Snapshotted like the price — later
    //                 runnerBps changes never re-price existing deployments.
    //   escrow6       USDC actually HELD here to back future credits: every
    //                 USDC funding leaves the runner's pro-rata share in the
    //                 contract (ceil; platform absorbs the dust) instead of
    //                 forwarding it. Credits are capped by it, so the runner
    //                 meter can never promise money the contract doesn't hold.
    //   creditedUntil the lease meter: the timestamp up to which the CURRENT
    //                 runner has been credited. Advanced by claim/renew/
    //                 release/settle/setShares; capped at leaseUntil, so a
    //                 runner is paid for time it HELD the lease, never the
    //                 released tail. Packs into one slot.
    struct Earn { uint96 rate6; uint96 escrow6; uint64 creditedUntil; }

    /// @dev Optional anti-sybil claim bond (metal/PROTOCOL.md gate 4). While
    ///      claimBond6 > 0, claim() requires the operator to have bonded at
    ///      least that much USDC with no exit pending. Exit is timelocked so
    ///      provable misbehavior can be slashed before the bond walks.
    struct Bond { uint192 amount6; uint64 exitAt; }

    uint16 public runnerBps = 8000;        // runner share of the platform component, in bps
                                           // (80% to the seller). Affects FUTURE creates and
                                           // resizes only — snapshotted per deployment.
    uint256 public claimBond6 = 0;         // USDC bond required to claim (0 = bond off, default)
    uint64  public bondExitDelay = 1 days; // requestBondExit -> withdrawBond timelock

    bytes32[] private _ids;                                // every deployment ever created
    mapping(bytes32 => Deployment) private _deployments;
    mapping(bytes32 => bool) private _exists;
    mapping(bytes32 => Fee) private _fees;                 // id -> publisher-fee snapshot (rate6 0 = none)
    mapping(bytes32 => Earn) private _earn;                // id -> runner-payout snapshot + escrow + meter
    mapping(address => uint256) public earned6;            // operator -> withdrawable runner earnings (USDC 6dp)
    mapping(address => Bond) private _bonds;               // operator -> claim bond
    mapping(address => uint64) private _nonces;            // per-creator id salt

    event Created(bytes32 indexed id, address indexed owner, string appRef, uint16 gpuMilli, uint16 cpuMilli, uint256 rate);
    event FeeSet(bytes32 indexed id, address indexed recipient, uint256 feePerSec6);
    event AppRefSet(bytes32 indexed id, string appRef);
    event SharesSet(bytes32 indexed id, uint16 gpuMilli, uint16 cpuMilli, uint256 rate);
    event ConfigSet(bytes32 indexed id, string configCid);
    event ActiveSet(bytes32 indexed id, bool active);
    event Funded(bytes32 indexed id, address indexed payer, uint256 amount6);
    event FundedEth(bytes32 indexed id, address indexed payer, uint256 amountWei, uint256 credited6);
    event Claimed(bytes32 indexed id, bytes32 indexed enclaveId, address indexed operator, uint64 leaseUntil, uint256 burned6);
    event Renewed(bytes32 indexed id, bytes32 indexed enclaveId, uint64 leaseUntil, uint256 burned6);
    event Released(bytes32 indexed id, bytes32 indexed enclaveId, uint256 refunded6);
    event RunnerRateSet(bytes32 indexed id, uint256 runnerRate6);
    event RunnerCredited(bytes32 indexed id, address indexed operator, uint256 amount6);
    event EarningsWithdrawn(address indexed operator, address indexed to, uint256 amount6);
    event EscrowFunded(bytes32 indexed id, address indexed from, uint256 amount6);
    event EscrowSwept(bytes32 indexed id, uint256 amount6);
    event RunnerBpsSet(uint16 runnerBps);
    event ClaimBondSet(uint256 bond6, uint64 exitDelaySec);
    event BondPosted(address indexed operator, uint256 amount6, uint256 bonded6);
    event BondExitRequested(address indexed operator, uint64 exitAt);
    event BondWithdrawn(address indexed operator, address indexed to, uint256 amount6);
    event BondSlashed(address indexed operator, uint256 amount6, string reason);
    event PriceSet(uint256 pricePerSec6);
    event CpuPriceSet(uint256 cpuPricePerSec6);
    event LeaseSecSet(uint64 leaseSec);
    event MaxGpuMilliSet(uint16 maxGpuMilli);
    event MaxFeeSet(uint256 maxFeePerSec6);
    event PayoutChanged(address indexed payout);
    event OwnerChanged(address indexed owner);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event FeedChanged(address indexed feed);

    constructor(address _usdc, address _payout, address _registry, address _ethUsdFeed) {
        require(_usdc != address(0) && _payout != address(0) && _registry != address(0), "zero addr");
        owner = msg.sender;
        usdc = IERC20Auth(_usdc);
        payout = _payout;
        registry = IEnclaveRegistry(_registry);
        ethUsdFeed = IAggregatorV3(_ethUsdFeed);   // may be 0x0: ETH funding off
        emit PayoutChanged(_payout);
        emit OwnerChanged(msg.sender);
        emit PriceSet(pricePerSec6);               // prices are live from deploy (hardcoded defaults)
        emit CpuPriceSet(cpuPricePerSec6);
        emit MaxGpuMilliSet(maxGpuMilli);
        emit MaxFeeSet(maxFeePerSec6);
        emit RunnerBpsSet(runnerBps);              // runner payout live from deploy; bond off by default
        emit ClaimBondSet(claimBond6, bondExitDelay);
    }

    // ========================================================================
    // user side: create / configure / fund
    // ========================================================================

    /// @notice Record a deployment intent. Permissionless and inert until funded.
    /// @dev id embeds the creator + a per-creator nonce, so ids can't be squatted
    ///      or predicted across owners (same structural-ownership trick as the
    ///      catalog's appId). The rate snapshot makes future price changes
    ///      non-retroactive. The two shares pick which enclaves will claim:
    ///      gpuMilli > 0 is served by GPU enclaves only; gpuMilli == 0 is served
    ///      by CPU-only enclaves first, then by GPU enclaves with spare CPU/RAM.
    ///      A GPU deployment's CPU share may never exceed its GPU share. The
    ///      shares must also cover the app's minimum (derived by runners from
    ///      its EnclaveAppCatalog specs) or no enclave will claim the deployment,
    ///      and gpuMilli may not exceed the operator-set maxGpuMilli cap.
    ///      feeRecipient/feePerSec6 copy the referenced catalog version's
    ///      publisher fee (the app's publisher wallet; 0x0/0 for a free app):
    ///      the fee is snapshotted like the rate, folded into it, and paid out
    ///      pro-rata from every funding. Under-declaring it just makes the
    ///      deployment unclaimable (runners re-check against the catalog),
    ///      same as under-provisioned shares.
    function create(
        string calldata appRef,
        uint16 gpuMilli,
        uint16 cpuMilli,
        uint32 appPort,
        string calldata ports,
        bool isPublic,
        string calldata configCid,
        address feeRecipient,
        uint256 feePerSec6
    ) external returns (bytes32 id) {
        require(bytes(appRef).length > 0 && bytes(appRef).length <= MAX_APPREF, "appRef length");
        require(cpuMilli > 0 && cpuMilli <= 1000, "cpuMilli range");
        require(gpuMilli <= 1000, "gpuMilli range");
        require(gpuMilli == 0 || gpuMilli >= cpuMilli, "gpuShare < cpuShare");
        require(appPort > 0, "appPort range");
        require(bytes(ports).length <= MAX_PORTS, "ports length");
        require(bytes(configCid).length <= MAX_CFG, "configCid length");

        // ids are creator-salted hashes; the loop guards the one collision path
        // that exists — a fresh contract's nonce restarting at 0 while imported
        // records already carry this creator's old (sender, nonce) ids.
        do { id = keccak256(abi.encodePacked(msg.sender, _nonces[msg.sender]++)); } while (_exists[id]);
        _exists[id] = true;
        _ids.push(id);

        Deployment storage d = _deployments[id];
        d.id = id;
        d.owner = msg.sender;
        d.appRef = appRef;
        d.ports = ports;
        d.configCid = configCid;
        _initFee(d, feeRecipient, feePerSec6);   // before _initScalars: the rate fold reads the snapshot
        _initScalars(d, appRef, gpuMilli, cpuMilli, appPort, isPublic);
        _snapRunnerRate(d);                      // after: the runner cut is a slice of the folded rate
    }

    /// @dev Snapshot the runner's per-second cut: runnerBps of the PLATFORM
    ///      component (rate minus the publisher fee). Own frame, same stack
    ///      reason as _initScalars; also the resize path's recompute (a resize
    ///      is a new purchase decision, so it re-reads the CURRENT runnerBps,
    ///      exactly as it re-reads the current list prices).
    function _snapRunnerRate(Deployment storage d) private {
        uint256 r6 = ((d.rate - _fees[d.id].rate6) * runnerBps) / 10000;
        require(r6 <= type(uint96).max, "runner rate range");
        _earn[d.id].rate6 = uint96(r6);
        emit RunnerRateSet(d.id, r6);
    }

    /// @dev Record the publisher-fee snapshot (own stack frame, same reason as
    ///      _initScalars). Runs BEFORE _initScalars so the rate fold there can
    ///      read it back — keeping Created's rate the FULL stored rate (what
    ///      leases burn), consistent with import re-emits; FeeSet tells
    ///      indexers how much of it is the publisher's cut.
    function _initFee(Deployment storage d, address feeRecipient, uint256 feePerSec6) private {
        if (feePerSec6 == 0) return;
        require(feePerSec6 <= maxFeePerSec6, "fee > max");    // create-only cap; imports bypass (grandfathered)
        require(feeRecipient != address(0), "fee recipient");
        _fees[d.id] = Fee(feeRecipient, uint96(feePerSec6));  // cast safe: maxFeePerSec6 <= uint96.max (setter-enforced)
        emit FeeSet(d.id, feeRecipient, feePerSec6);
    }

    /// @dev Split out (emit included) so create() keeps a workable stack frame
    ///      without viaIR (same shape as the catalog's `_reserveCid` / `_touchApp`).
    function _initScalars(Deployment storage d, string calldata appRef, uint16 gpuMilli,
                          uint16 cpuMilli, uint32 appPort, bool isPublic) private {
        require(cpuPricePerSec6 > 0 && (gpuMilli == 0 || pricePerSec6 > 0), "price unset");
        require(gpuMilli <= maxGpuMilli, "gpuShare > max");   // create-only cap; imports bypass (grandfathered)
        d.gpuMilli = gpuMilli;
        d.cpuMilli = cpuMilli;
        d.appPort = appPort;
        d.isPublic = isPublic;
        d.active = true;
        d.createdAt = uint64(block.timestamp);
        // both shares are paid for; ceil so a 1-milli deployment still pays >= 1
        // unit/sec, plus the publisher's per-second cut recorded by _initFee
        d.rate = (pricePerSec6 * gpuMilli + cpuPricePerSec6 * cpuMilli + 999) / 1000 + _fees[d.id].rate6;
        emit Created(d.id, msg.sender, appRef, gpuMilli, cpuMilli, d.rate);
    }

    /// @notice Repoint the deployment at another catalog version — the owner's
    ///         UPGRADE path. Funded time, shares, rate and any live lease all
    ///         stay on the record, so a new release never costs a second
    ///         buy-in: the current runner sees the change on its next ledger
    ///         pass and restarts the app in place onto the new version; an
    ///         unclaimed deployment simply launches the new version when
    ///         claimed. The ledger doesn't parse appRefs (same trust model as
    ///         create) — runners re-gate the new record on catalog approval
    ///         and on the app's minimum shares. A version needing more than
    ///         the bought shares cover is refused by every runner; clients
    ///         pre-check before the signature, exactly as they do for create,
    ///         and offer a share resize (setShares, batched with this call
    ///         via multicall) when the new version needs different resources.
    function setAppRef(bytes32 id, string calldata appRef) external {
        Deployment storage d = _requireOwned(id);
        require(bytes(appRef).length > 0 && bytes(appRef).length <= MAX_APPREF, "appRef length");
        d.appRef = appRef;
        emit AppRefSet(id, appRef);
    }

    /// @notice Re-buy the deployment's two shares in place (grow OR shrink) —
    ///         the owner's RESIZE path, typically batched with setAppRef via
    ///         multicall() when a new version needs different resources. The
    ///         rate is RECALCULATED at the current list prices plus the
    ///         deployment's immutable publisher-fee snapshot: a resize is a
    ///         new purchase decision, exactly like create (deployments that
    ///         never resize keep their original snapshot — price changes stay
    ///         non-retroactive for them). Same bounds as create, including
    ///         the operator's maxGpuMilli cap.
    ///
    ///         A LIVE lease is settled, never re-priced retroactively: the
    ///         unserved tail is refunded at the OLD rate (the rate it was
    ///         burned at — the same arithmetic as release(), so spent6 can
    ///         never underflow), then re-burned at the NEW rate for as many
    ///         of those same seconds as the balance affords. leaseUntil never
    ///         extends; a grow the balance can't fully cover shrinks it, and
    ///         the runner just renews (or lapses) sooner. A resize that could
    ///         not fund even one second reverts "unfunded at the new rate" —
    ///         top up first; a resize never silently kills a running app.
    ///
    ///         The serving runner sees the changed shares on its next ledger
    ///         pass and re-gates them like a claim (app minimums, local
    ///         capacity, fail closed): it restarts the app in place on a
    ///         resized slice, or releases the lease (tail refunded) so an
    ///         enclave that CAN fit the new size claims the work. Clients
    ///         pre-check fleet capacity and app minimums before the
    ///         signature, exactly as they do for create.
    function setShares(bytes32 id, uint16 gpuMilli, uint16 cpuMilli) external {
        Deployment storage d = _requireOwned(id);
        require(cpuMilli > 0 && cpuMilli <= 1000, "cpuMilli range");
        require(gpuMilli <= 1000, "gpuMilli range");
        require(gpuMilli == 0 || gpuMilli >= cpuMilli, "gpuShare < cpuShare");
        require(gpuMilli <= maxGpuMilli, "gpuShare > max");
        require(cpuPricePerSec6 > 0 && (gpuMilli == 0 || pricePerSec6 > 0), "price unset");
        uint256 newRate = (pricePerSec6 * gpuMilli + cpuPricePerSec6 * cpuMilli + 999) / 1000 + _fees[id].rate6;
        _creditRunner(d);                            // settle served time at the OLD runner rate first
        if (d.leaseUntil > block.timestamp) {
            uint256 tail = d.leaseUntil - block.timestamp;
            uint256 refund = tail * d.rate;          // settle the unserved tail at the rate it was burned at
            d.balance6 += refund;
            d.spent6 -= refund;
            uint256 secs = d.balance6 / newRate;     // re-burn the same window at the new rate
            if (secs > tail) secs = tail;            // a lease never EXTENDS from a resize
            require(secs > 0, "unfunded at the new rate");
            uint256 burned = secs * newRate;
            d.balance6 -= burned;
            d.spent6 += burned;
            d.leaseUntil = uint64(block.timestamp) + uint64(secs);
        }
        d.gpuMilli = gpuMilli;
        d.cpuMilli = cpuMilli;
        d.rate = newRate;
        _snapRunnerRate(d);                          // a resize re-buys the runner cut too (current runnerBps)
        emit SharesSet(id, gpuMilli, cpuMilli, newRate);
    }

    /// @notice Update the portable config; runners apply it on the next (re)launch.
    function setConfig(bytes32 id, string calldata configCid) external {
        Deployment storage d = _requireOwned(id);
        require(bytes(configCid).length <= MAX_CFG, "configCid length");
        d.configCid = configCid;
        emit ConfigSet(id, configCid);
    }

    /// @notice Stop (or restart) a deployment. Stopping does NOT touch the current
    ///         lease — a well-behaved runner sees ActiveSet, tears down, and
    ///         releases (refunding the lease tail to the balance). The balance
    ///         stays recorded, so reactivating later resumes from what's left.
    function setActive(bytes32 id, bool active) external {
        Deployment storage d = _requireOwned(id);
        d.active = active;
        emit ActiveSet(id, active);
    }

    /// @notice Fund/top-up with a signed USDC authorization (EIP-3009). Callable by
    ///         anyone; the payer credited is `from`. Same non-custodial forward and
    ///         nonce-binding as EnclavePay: the authorization's nonce must start with
    ///         the first 16 bytes of `id`, so a relayer can't redirect the credit.
    function fundWithAuthorization(
        bytes32 id,
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        Deployment storage d = _requireActive(id);
        require(value > 0, "amount=0");
        require(bytes16(nonce) == bytes16(id), "nonce !~ id");
        usdc.receiveWithAuthorization(from, address(this), value, validAfter, validBefore, nonce, signature);
        _splitFunding(id, d.rate, value);
        d.balance6 += value;
        emit Funded(id, from, value);
    }

    /// @notice Fund/top-up from a prior USDC allowance: approve(this, value) then
    ///         fund(id, value), both plain transactions authorized by msg.sender —
    ///         no signature for the token to reinterpret. This is the funding path
    ///         for payers whose address carries code (smart-contract wallets, and
    ///         EIP-7702-delegated EOAs such as gas-sponsored embedded wallets):
    ///         USDC validates EIP-3009 signatures from code-bearing addresses via
    ///         ERC-1271 instead of ecrecover, which typical account implementations
    ///         reject for raw digests, so fundWithAuthorization can never serve
    ///         them. Same non-custodial forward, payer -> payout (and payer ->
    ///         publisher for the fee cut) straight from the allowance.
    function fund(bytes32 id, uint256 value) external {
        Deployment storage d = _requireActive(id);
        require(value > 0, "amount=0");
        require(usdc.transferFrom(msg.sender, address(this), value), "USDC transferFrom failed");
        _splitFunding(id, d.rate, value);
        d.balance6 += value;
        emit Funded(id, msg.sender, value);
    }

    /// @dev Distribute a USDC funding that has already LANDED in this contract:
    ///      the publisher's pro-rata cut to their wallet, the RUNNER's pro-rata
    ///      share retained here as escrow (what future lease credits are paid
    ///      from — see Earn), the platform remainder to payout. The escrow
    ///      rounds UP and the fee rounds down: the platform absorbs the dust on
    ///      both, so the escrow always covers every second the credited balance
    ///      can buy. fee + runner share never exceed the rate (the runner cut
    ///      is a bps slice of rate-minus-fee), so the clamp is belt-and-braces
    ///      for the ceil's +1 at the bps=10000 edge.
    function _splitFunding(bytes32 id, uint256 rate, uint256 value) private {
        (address feeTo, uint256 cut) = _feeShare(id, rate, value);
        uint256 esc = 0;
        uint96 r6 = _earn[id].rate6;
        if (r6 > 0) {
            esc = (value * r6 + (rate - 1)) / rate;            // ceil — escrow must cover its seconds
            if (esc > value - cut) esc = value - cut;
            // cast safe: esc <= value = real USDC received (total supply << uint96.max 6dp)
            _earn[id].escrow6 += uint96(esc);
        }
        if (cut > 0) require(usdc.transfer(feeTo, cut), "USDC transfer failed");
        if (value - cut - esc > 0) require(usdc.transfer(payout, value - cut - esc), "USDC transfer failed");
    }

    /// @notice Fund/top-up with native ETH, credited as USDC-equivalent at the live
    ///         Chainlink ETH/USD rate (on-chain, unlike EnclavePay where the supervisor
    ///         priced it off-chain — here the BALANCE is chain state, so the
    ///         conversion must be too). Forwarded straight to payout.
    /// @dev ETH fundings do NOT feed the runner escrow (the escrow pays runners
    ///      in USDC and this contract can't convert). Runner credits for
    ///      ETH-funded seconds draw on whatever USDC escrow the deployment has
    ///      (the min-cap in _creditRunner degrades gracefully to zero); the
    ///      platform can re-back such a deployment with fundEscrow.
    function fundEth(bytes32 id) external payable {
        Deployment storage d = _requireActive(id);
        require(msg.value > 0, "value=0");
        require(address(ethUsdFeed) != address(0), "eth funding disabled");
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = ethUsdFeed.latestRoundData();
        require(answer > 0 && block.timestamp - updatedAt <= FEED_MAX_AGE, "stale price");
        require(answeredInRound >= roundId, "incomplete round");   // reject an answer carried over from an earlier (unfinalized) round
        // wei(1e18) * price(1e8) -> USDC 6dp: divide by 1e20
        uint256 credited = (msg.value * uint256(answer)) / 1e20;
        require(credited > 0, "dust");
        d.balance6 += credited;                                    // effects before interaction (CEI): a contract payout can't reenter mid-credit
        // the publisher's cut splits the WEI (their wallet gets ETH, not USDC).
        // A fee recipient that reverts on plain sends blocks only ETH funding
        // of their own app's deployments — USDC paths never call out to them.
        (address feeTo, uint256 cutWei) = _feeShare(id, d.rate, msg.value);
        if (cutWei > 0) {
            (bool okFee, ) = feeTo.call{value: cutWei}("");
            require(okFee, "ETH transfer failed");
        }
        (bool ok, ) = payout.call{value: msg.value - cutWei}("");
        require(ok, "ETH transfer failed");
        emit FundedEth(id, msg.sender, msg.value, credited);
    }

    /// @dev The publisher's cut of a funding amount: pro-rata by the fee's
    ///      share of the snapshotted rate (floor — the platform absorbs the
    ///      dust). rate >= 1 always (create ceils to at least one unit/sec
    ///      and imports refuse rate 0), so the division is safe.
    function _feeShare(bytes32 id, uint256 rate, uint256 value) private view returns (address to, uint256 cut) {
        Fee storage f = _fees[id];
        if (f.rate6 == 0) return (address(0), 0);
        return (f.recipient, (value * f.rate6) / rate);
    }

    // ========================================================================
    // runner side: claim / renew / release (the failover queue)
    // ========================================================================

    /// @notice Take the lease on a claimable deployment. Burns min(leaseSec,
    ///         remaining funded time) from the balance and makes the caller the
    ///         sole legitimate runner until leaseUntil. Claimable = active, funded,
    ///         and no live lease (never claimed, expired, or released).
    /// @dev msg.sender must be the operator of `enclaveId`, an active EnclaveRegistry
    ///      entry — structural gating, same shape as catalog lineage ownership.
    ///      The previous runner's burned lease is NOT refunded (it may be dead;
    ///      nobody trustworthy can attest how much it actually served).
    function claim(bytes32 id, bytes32 enclaveId) external {
        Deployment storage d = _requireActive(id);
        require(block.timestamp > d.leaseUntil, "leased");
        IEnclaveRegistry.Enclave memory e = registry.get(enclaveId);
        require(e.operator == msg.sender, "not operator");
        require(e.active, "enclave inactive");
        if (claimBond6 > 0) {                    // optional anti-sybil gate (0 = off)
            Bond storage b = _bonds[msg.sender];
            require(b.amount6 >= claimBond6 && b.exitAt == 0, "bond required");
        }
        _creditRunner(d);                        // settle the PREVIOUS runner's expired-lease tail

        (uint64 until, uint256 burned) = _burnLease(d, uint64(block.timestamp));
        d.runner = enclaveId;
        d.runnerOperator = msg.sender;
        d.leaseUntil = until;
        _earn[id].creditedUntil = uint64(block.timestamp);   // the new runner's meter starts NOW
        emit Claimed(id, enclaveId, msg.sender, until, burned);
    }

    /// @notice Extend a live lease (only the current runner, only before expiry —
    ///         after expiry the job is back in the open queue and even the same
    ///         runner must re-claim). Burns the next quantum; extends FROM
    ///         leaseUntil, since time up to there is already paid.
    function renew(bytes32 id) external {
        Deployment storage d = _requireActive(id);
        require(d.runnerOperator == msg.sender, "not runner");
        require(block.timestamp <= d.leaseUntil, "lease expired");
        _creditRunner(d);                        // credit the lease time held so far
        (uint64 until, uint256 burned) = _burnLease(d, d.leaseUntil);
        d.leaseUntil = until;
        emit Renewed(id, d.runner, until, burned);
    }

    /// @notice Graceful hand-back: refund the unused lease tail to the balance and
    ///         reopen the queue. Called on clean shutdown, on teardown after the
    ///         owner stops the deployment, or when provisioning fails right after
    ///         a claim (so the user doesn't pay for a runner that never served).
    function release(bytes32 id) external {
        Deployment storage d = _deployments[id];
        require(_exists[id], "unknown");
        require(d.runnerOperator == msg.sender, "not runner");
        _creditRunner(d);                        // pay for time HELD; the refunded tail earns nothing
        uint256 refund = 0;
        if (d.leaseUntil > block.timestamp) {
            refund = (d.leaseUntil - block.timestamp) * d.rate;
            d.balance6 += refund;
            d.spent6 -= refund;
        }
        bytes32 enclaveId = d.runner;
        d.runner = bytes32(0);
        d.runnerOperator = address(0);
        d.leaseUntil = 0;
        _earn[id].creditedUntil = 0;             // meter idles until the next claim restarts it
        emit Released(id, enclaveId, refund);
    }

    /// @dev Burn one lease quantum starting at `from`: as many seconds as the
    ///      balance affords, capped at leaseSec. Reverts if the balance can't buy
    ///      a single second ("no more time left" — the queue drops the item).
    function _burnLease(Deployment storage d, uint64 from) private returns (uint64 until, uint256 burned) {
        uint256 secs = d.balance6 / d.rate;
        if (secs > leaseSec) secs = leaseSec;
        require(secs > 0, "unfunded");
        burned = secs * d.rate;
        d.balance6 -= burned;
        d.spent6 += burned;
        until = from + uint64(secs);
    }

    // ========================================================================
    // runner payout (rev 7) — the metered split that pays permissionless sellers
    // ========================================================================

    /// @dev The runner meter: credit the CURRENT runner's operator for lease
    ///      time elapsed since the last credit point, at the deployment's
    ///      snapshotted per-second runner rate, capped at leaseUntil (a
    ///      released tail is refunded to the user, so it can never also be
    ///      earned) and capped by the deployment's escrow (credits can never
    ///      promise money this contract doesn't hold — an ETH-funded or
    ///      imported record with no escrow just credits nothing until one of
    ///      its fundings escrows). Piggybacks on the transactions runners
    ///      already send — claim (settling the PREVIOUS runner), renew,
    ///      release, setShares — plus the permissionless settle(). The meter
    ///      always ADVANCES over a zero-escrow window: served-but-unbacked
    ///      time is forfeit, never retro-credited from later escrow (which
    ///      backs later seconds).
    function _creditRunner(Deployment storage d) private {
        if (d.runner == bytes32(0)) return;                  // no lease has ever started, or released
        Earn storage e = _earn[d.id];
        uint64 upto = uint64(block.timestamp);
        if (upto > d.leaseUntil) upto = d.leaseUntil;        // an expired lease earns through its end, no further
        if (upto <= e.creditedUntil) return;
        uint256 credit = uint256(upto - e.creditedUntil) * e.rate6;
        if (credit > e.escrow6) credit = e.escrow6;
        e.creditedUntil = upto;
        if (credit == 0) return;
        e.escrow6 -= uint96(credit);                         // cast safe: credit <= escrow6 (uint96)
        earned6[d.runnerOperator] += credit;
        emit RunnerCredited(d.id, d.runnerOperator, credit);
    }

    /// @notice Advance the runner meter without any other state change.
    ///         Permissionless and idempotent: anyone may settle anyone's
    ///         deployment (it only ever moves already-owed money from escrow
    ///         to the runner's balance). The one case the piggybacked credits
    ///         miss is a lease that expired and was never re-claimed or
    ///         released — the runner (or its supervisor's payout loop) calls
    ///         this to collect that final quantum.
    function settle(bytes32 id) external {
        require(_exists[id], "unknown");
        _creditRunner(_deployments[id]);
    }

    /// @notice Withdraw the caller's accrued runner earnings (every credit
    ///         from every deployment it ever served) to any address — the
    ///         seller's cold wallet, typically. The caller is the operator
    ///         EOA that signs claim/renew/release (inside the CVM on a metal
    ///         enclave), so the host OS never holds a key that could redirect
    ///         someone else's earnings.
    function withdrawEarnings(address to) external {
        require(to != address(0), "zero addr");
        uint256 amt = earned6[msg.sender];
        require(amt > 0, "nothing earned");
        earned6[msg.sender] = 0;                             // effects before interaction
        require(usdc.transfer(to, amt), "USDC transfer failed");
        emit EarningsWithdrawn(msg.sender, to, amt);
    }

    /// @notice Top up a deployment's runner escrow directly (USDC allowance,
    ///         forwarded into the contract). Permissionless — this only ever
    ///         ADDS backing for runner credits. The platform uses it to re-back
    ///         records whose balance arrived outside the escrowing paths:
    ///         imported (migrated) balances and ETH fundings.
    function fundEscrow(bytes32 id, uint256 amount6) external {
        Deployment storage d = _requireActive(id);
        require(amount6 > 0, "amount=0");
        require(_earn[id].rate6 > 0, "no runner rate");      // a rate-0 record can never credit it back out
        require(usdc.transferFrom(msg.sender, address(this), amount6), "USDC transferFrom failed");
        _earn[d.id].escrow6 += uint96(amount6);              // cast safe: real USDC received
        emit EscrowFunded(id, msg.sender, amount6);
    }

    /// @notice Recover a DRAINED deployment's residual escrow dust to payout.
    ///         Deliberately narrow: only when no lease is live and the balance
    ///         can't buy one more second — while a deployment can still be
    ///         claimed, its escrow is the sellers' money-in-waiting and the
    ///         platform cannot touch it (that immutability is the seller's
    ///         trust anchor, like the fee snapshot is the publisher's). Any
    ///         served-but-unsettled time is credited first, so a sweep can
    ///         never short the last runner.
    function sweepEscrow(bytes32 id) external {
        require(msg.sender == owner, "!owner");
        Deployment storage d = _deployments[id];
        require(_exists[id], "unknown");
        _creditRunner(d);
        require(block.timestamp > d.leaseUntil, "leased");
        require(d.balance6 < d.rate, "still fundable");
        uint256 amt = _earn[id].escrow6;
        require(amt > 0, "no escrow");
        _earn[id].escrow6 = 0;
        require(usdc.transfer(payout, amt), "USDC transfer failed");
        emit EscrowSwept(id, amt);
    }

    // ---- optional claim bond (anti-sybil, metal/PROTOCOL.md gate 4) --------
    // Inert while claimBond6 == 0 (the deploy default): claim() checks nothing
    // and none of these calls are needed. When the operator turns it on, a
    // runner must lock USDC before claiming; leaving is timelocked so provable
    // misbehavior can be slashed before the bond walks. Slashing is an OWNER
    // action with public evidence (the reason string in the event) — the
    // seller's exposure to a malicious platform is bounded by the bond itself,
    // never by its earnings.

    /// @notice Lock USDC as the caller's claim bond (adds to any existing
    ///         bond; cancels a pending exit — posting re-commits).
    function postBond(uint256 amount6) external {
        require(amount6 > 0, "amount=0");
        require(usdc.transferFrom(msg.sender, address(this), amount6), "USDC transferFrom failed");
        Bond storage b = _bonds[msg.sender];
        b.amount6 += uint192(amount6);                       // cast safe: real USDC received
        b.exitAt = 0;
        emit BondPosted(msg.sender, amount6, b.amount6);
    }

    /// @notice Start the timelocked exit. While an exit is pending the bond no
    ///         longer authorizes claims (renew/release of already-held leases
    ///         still work — winding down is exactly what an exit is for).
    function requestBondExit() external {
        Bond storage b = _bonds[msg.sender];
        require(b.amount6 > 0, "no bond");
        b.exitAt = uint64(block.timestamp) + bondExitDelay;
        emit BondExitRequested(msg.sender, b.exitAt);
    }

    /// @notice Reclaim the whole bond after the exit timelock has passed.
    function withdrawBond(address to) external {
        require(to != address(0), "zero addr");
        Bond storage b = _bonds[msg.sender];
        require(b.exitAt != 0 && block.timestamp >= b.exitAt, "exit pending");
        uint256 amt = b.amount6;
        require(amt > 0, "no bond");
        delete _bonds[msg.sender];                           // effects before interaction
        require(usdc.transfer(to, amt), "USDC transfer failed");
        emit BondWithdrawn(msg.sender, to, amt);
    }

    /// @notice Slash (part of) an operator's bond to payout, with public
    ///         evidence in the reason string (e.g. a claim-without-serving
    ///         incident reference). Owner-gated; bounded by the bond.
    function slashBond(address operator, uint256 amount6, string calldata reason) external {
        require(msg.sender == owner, "!owner");
        Bond storage b = _bonds[operator];
        require(amount6 > 0 && amount6 <= b.amount6, "amount range");
        b.amount6 -= uint192(amount6);
        require(usdc.transfer(payout, amount6), "USDC transfer failed");
        emit BondSlashed(operator, amount6, reason);
    }

    // ========================================================================
    // one-time migration (owner-gated, permanently sealable)
    // ========================================================================

    /// @notice While true, the owner may still import records from a previous
    ///         EnclaveDeployments. Anyone auditing this contract should treat
    ///         records as owner-attested until `importsSealed` — after sealing,
    ///         every new record can only come from the permissionless paths.
    bool public importsSealed;
    event ImportsSealed();

    /// @notice Migrate records verbatim from a previous EnclaveDeployments (the
    ///         admin console reads them via getPage and replays them here).
    ///         balance6/spent6 are ACCOUNTING numbers (nothing is custodied, so
    ///         there are no funds to move); rate keeps each deployment's original
    ///         snapshot. Leases do NOT survive migration: runner fields reset and
    ///         the fleet re-claims funded work items on this contract as soon as
    ///         the address book points here.
    /// @dev Owner-trusted input (bounds were enforced by the source contract's
    ///      create()); ids are unforgeable creator-salted hashes preserved
    ///      verbatim, and create() skips over any imported id.
    function importDeployments(Deployment[] calldata items) external {
        require(msg.sender == owner, "!owner");
        require(!importsSealed, "sealed");
        for (uint256 i = 0; i < items.length; i++) {
            bytes32 id = items[i].id;
            require(id != bytes32(0), "id=0");
            require(!_exists[id], "exists");
            // create() always yields rate >= 1 (cpuMilli >= 1, cpuPrice > 0), but
            // import copies rate verbatim from the source record. A rate==0 record
            // would divide-by-zero in _burnLease (balance6 / rate) the moment the
            // fleet tries to claim it — permanently unclaimable. Refuse it here.
            require(items[i].rate > 0, "rate=0");
            _exists[id] = true;
            _ids.push(id);
            _deployments[id] = items[i];
            Deployment storage d = _deployments[id];
            d.runner = bytes32(0);
            d.runnerOperator = address(0);
            d.leaseUntil = 0;
            emit Created(id, d.owner, d.appRef, d.gpuMilli, d.cpuMilli, d.rate);
            // re-emit the funded credit so a LOG-ONLY indexer rebuilds balance6:
            // import copies balance6 straight into storage, and without a Funded
            // log a log-following indexer would show the migrated deployment at
            // zero credit. Non-custodial, so this is payer attribution only (the
            // original payer isn't recoverable — owner stands in as the payer).
            if (d.balance6 > 0) emit Funded(id, d.owner, d.balance6);
        }
    }

    /// @notice Migrate publisher-fee snapshots (rev-4 sources only — earlier
    ///         records have none to carry). Verbatim, no cap check
    ///         (grandfathered like imported gpuMilli): the imported `rate`
    ///         already contains each record's fee, so this only restores WHO
    ///         gets the cut — skipping it for a fee-bearing record would
    ///         silently redirect the publisher's share to payout.
    function importFees(bytes32[] calldata ids, address[] calldata recipients, uint256[] calldata rates6) external {
        require(msg.sender == owner, "!owner");
        require(!importsSealed, "sealed");
        require(ids.length == recipients.length && ids.length == rates6.length, "length mismatch");
        for (uint256 i = 0; i < ids.length; i++) {
            require(_exists[ids[i]], "unknown");
            require(rates6[i] <= type(uint96).max, "fee range");
            require(rates6[i] == 0 || recipients[i] != address(0), "fee recipient");
            _fees[ids[i]] = Fee(recipients[i], uint96(rates6[i]));
            if (rates6[i] > 0) emit FeeSet(ids[i], recipients[i], rates6[i]);
        }
    }

    /// @notice Migrate runner-rate snapshots (rev-7 sources; also how a rev-6
    ///         migration GRANTS runner rates to grandfathered records, at the
    ///         owner's choice — records left at 0 never pay runners). Verbatim
    ///         like importFees. Escrow and earned balances do NOT migrate:
    ///         escrow is real USDC held by the SOURCE contract (re-back the
    ///         migrated balances here with fundEscrow) and earnings stay
    ///         withdrawable on the source by their operators forever.
    function importEarn(bytes32[] calldata ids, uint256[] calldata rates6) external {
        require(msg.sender == owner, "!owner");
        require(!importsSealed, "sealed");
        require(ids.length == rates6.length, "length mismatch");
        for (uint256 i = 0; i < ids.length; i++) {
            require(_exists[ids[i]], "unknown");
            require(rates6[i] <= type(uint96).max, "rate range");
            _earn[ids[i]].rate6 = uint96(rates6[i]);
            emit RunnerRateSet(ids[i], rates6[i]);
        }
    }

    /// @notice Permanently close the import window (there is no re-open).
    function sealImports() external {
        require(msg.sender == owner, "!owner");
        importsSealed = true;
        emit ImportsSealed();
    }

    /// @notice Batch several calls to THIS contract into one transaction
    ///         (delegatecall to self: msg.sender is preserved, so every inner
    ///         call keeps its own auth check). Atomic — any inner revert
    ///         bubbles up and undoes the lot. Lets a whole migration ride one
    ///         wallet confirmation. Non-payable, so msg.value can't be
    ///         double-counted across inner calls.
    function multicall(bytes[] calldata calls) external returns (bytes[] memory results) {
        results = new bytes[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, bytes memory ret) = address(this).delegatecall(calls[i]);
            if (!ok) {
                if (ret.length == 0) revert("multicall failed");
                assembly { revert(add(ret, 32), mload(ret)) }
            }
            results[i] = ret;
        }
    }

    // ========================================================================
    // admin (pricing + parameters; no custody, no access to balances)
    // ========================================================================

    function setPrice(uint256 _pricePerSec6) external {
        require(msg.sender == owner, "!owner");
        require(_pricePerSec6 > 0, "price=0");
        pricePerSec6 = _pricePerSec6;      // affects FUTURE creates only (rate is snapshotted)
        emit PriceSet(_pricePerSec6);
    }

    /// @notice Whole-CPU-node per-second price (every deployment pays it on its
    ///         cpuMilli). 0 keeps creates disabled until it is deliberately set.
    function setCpuPrice(uint256 _cpuPricePerSec6) external {
        require(msg.sender == owner, "!owner");
        require(_cpuPricePerSec6 > 0, "price=0");
        cpuPricePerSec6 = _cpuPricePerSec6;   // affects FUTURE creates only (rate is snapshotted)
        emit CpuPriceSet(_cpuPricePerSec6);
    }

    /// @notice Cap the GPU share (1/1000ths of one card) any single NEW
    ///         deployment may buy. Enforced at create() only: existing records
    ///         and owner imports are untouched, and the catalog keeps listing
    ///         apps whose specs exceed it — publishable, not deployable until
    ///         the cap covers their minimum. 0 pauses GPU creates entirely
    ///         (CPU-only deployments are never affected).
    function setMaxGpuMilli(uint16 _maxGpuMilli) external {
        require(msg.sender == owner, "!owner");
        require(_maxGpuMilli <= 1000, "max range");
        maxGpuMilli = _maxGpuMilli;                // affects FUTURE creates only
        emit MaxGpuMilliSet(_maxGpuMilli);
    }

    /// @notice Cap the per-second publisher fee (USDC 6dp) any single NEW
    ///         deployment may declare. Enforced at create() only: existing
    ///         records keep their snapshots and owner imports bypass it, like
    ///         maxGpuMilli. Keep it in lockstep with the catalog's publish-time
    ///         cap — a fee-bearing version above the LOWER of the two becomes
    ///         undeployable (creates revert here, or runners refuse the
    ///         under-declared fee there). Bounded to uint96 so the packed
    ///         snapshot cast in _initFee can never truncate.
    function setMaxFee(uint256 _maxFeePerSec6) external {
        require(msg.sender == owner, "!owner");
        require(_maxFeePerSec6 <= type(uint96).max, "max range");
        maxFeePerSec6 = _maxFeePerSec6;                // affects FUTURE creates only
        emit MaxFeeSet(_maxFeePerSec6);
    }

    /// @notice The runner's share (bps) of the PLATFORM component of every
    ///         lease second. Affects FUTURE creates and resizes only — the
    ///         per-deployment snapshot keeps bps changes non-retroactive,
    ///         exactly like the prices. 0 pauses runner earning for new
    ///         deployments (existing snapshots keep paying).
    function setRunnerBps(uint16 _runnerBps) external {
        require(msg.sender == owner, "!owner");
        require(_runnerBps <= 10000, "bps range");
        runnerBps = _runnerBps;                    // affects FUTURE creates/resizes only
        emit RunnerBpsSet(_runnerBps);
    }

    /// @notice The optional claim bond (USDC 6dp; 0 = off, the deploy default)
    ///         and its exit timelock. Checked at claim() only — running leases
    ///         and their renew/release never re-check, so turning the bond on
    ///         strands nobody mid-lease.
    function setClaimBond(uint256 _bond6, uint64 _exitDelaySec) external {
        require(msg.sender == owner, "!owner");
        require(_exitDelaySec >= 1 hours && _exitDelaySec <= 30 days, "delay range");
        claimBond6 = _bond6;
        bondExitDelay = _exitDelaySec;
        emit ClaimBondSet(_bond6, _exitDelaySec);
    }

    function setLeaseSec(uint64 _leaseSec) external {
        require(msg.sender == owner, "!owner");
        require(_leaseSec >= 60 && _leaseSec <= 1 days, "lease range");
        leaseSec = _leaseSec;
        emit LeaseSecSet(_leaseSec);
    }

    function setEthUsdFeed(address feed) external {
        require(msg.sender == owner, "!owner");
        ethUsdFeed = IAggregatorV3(feed);  // 0x0 disables ETH funding
        emit FeedChanged(feed);
    }

    function setPayout(address p) external {
        require(msg.sender == owner, "!owner");
        require(p != address(0), "zero addr");
        payout = p;
        emit PayoutChanged(p);
    }

    /// @notice Begin a TWO-STEP ownership handoff. `o` must call acceptOwnership()
    ///         to take control; until then `owner` is unchanged, so a mistyped
    ///         address can never strand price/lease/payout governance.
    function setOwner(address o) external {
        require(msg.sender == owner, "!owner");
        require(o != address(0), "zero addr");
        pendingOwner = o;
        emit OwnershipTransferStarted(owner, o);
    }

    /// @notice Complete the handoff. Only the pending owner may finalize.
    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "!pendingOwner");
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnerChanged(owner);
    }

    // ========================================================================
    // reads (enclave work-queue polling + client endpoint resolution)
    // ========================================================================

    function count() external view returns (uint256) { return _ids.length; }
    function idAt(uint256 i) external view returns (bytes32) { return _ids[i]; }
    function get(bytes32 id) external view returns (Deployment memory) { return _deployments[id]; }

    /// @notice True iff an enclave may claim right now (active + funded + no live lease).
    function claimable(bytes32 id) public view returns (bool) {
        Deployment storage d = _deployments[id];
        return _exists[id] && d.active && block.timestamp > d.leaseUntil && d.balance6 >= d.rate;
    }

    /// @notice Funded runtime left OUTSIDE the current lease (what future claims can buy).
    function secondsFundable(bytes32 id) external view returns (uint256) {
        Deployment storage d = _deployments[id];
        return d.rate == 0 ? 0 : d.balance6 / d.rate;
    }

    /// @notice The publisher-fee snapshot taken at create: payee wallet and
    ///         per-second cut (USDC 6dp), both immutable for the deployment's
    ///         life. (0x0, 0) = no fee — every pre-rev-4 record reads that way.
    ///         The cut is INSIDE `rate`, not on top of it: displays subtract it
    ///         to show the platform/publisher split, and runners compare it to
    ///         the referenced catalog version's fee before claiming.
    function feeOf(bytes32 id) external view returns (address recipient, uint256 feePerSec6) {
        Fee storage f = _fees[id];
        return (f.recipient, f.rate6);
    }

    /// @notice The runner-payout state of a deployment (rev 7): the immutable*
    ///         per-second runner cut (*until an owner resize re-buys it), the
    ///         USDC held here backing future credits, and the meter position.
    ///         (0, 0, 0) = a pre-rev-7 or runnerBps-0 record — never pays.
    function earnOf(bytes32 id) external view returns (uint256 runnerRate6, uint256 escrow6, uint64 creditedUntil) {
        Earn storage e = _earn[id];
        return (e.rate6, e.escrow6, e.creditedUntil);
    }

    /// @notice An operator's claim bond and its exit state (exitAt 0 = no exit
    ///         pending; otherwise the timestamp withdrawBond unlocks at).
    function bondOf(address operator) external view returns (uint256 amount6, uint64 exitAt) {
        Bond storage b = _bonds[operator];
        return (b.amount6, b.exitAt);
    }

    /// @notice Paginated dump (enclaves filter client-side, like registry discovery).
    function getPage(uint256 start, uint256 n) external view returns (Deployment[] memory page) {
        uint256 len = _ids.length;
        if (start >= len) return new Deployment[](0);
        uint256 end = start + n; if (end > len) end = len;
        page = new Deployment[](end - start);
        for (uint256 i = start; i < end; i++) page[i - start] = _deployments[_ids[i]];
    }

    // ------------------------------------------------------------------------
    function _requireOwned(bytes32 id) private view returns (Deployment storage d) {
        d = _deployments[id];
        require(_exists[id], "unknown");
        require(d.owner == msg.sender, "not owner");
    }
    function _requireActive(bytes32 id) private view returns (Deployment storage d) {
        d = _deployments[id];
        require(_exists[id], "unknown");
        require(d.active, "inactive");
    }
}

/*
FUTURE (deliberately not in this rev):
  - trustless slashing: rev 7 ships the bond (claim gate + timelocked exit) but
    slashing is an owner action with public evidence; a watcher protocol that
    PROVES a runner never served (failed attested probes, signed by N watchers)
    would replace the owner's judgment with a challenge game.
  - per-deployment price floors/auctions: today price is platform-set; a market
    would let runners bid, with the lease going to the cheapest attested enclave.
  - consumed-time attestation: runners could periodically post signed usage
    checkpoints, shrinking the "dead runner burns one lease" loss toward zero —
    and letting the runner meter pay for VERIFIED service instead of held time.
  - ETH-funded runner escrow: fundEth forwards everything (no on-chain USDC
    conversion); the runner share of ETH fundings relies on fundEscrow re-backing.
*/
