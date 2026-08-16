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
///         money — so leases can "burn" and "refund" it freely. The one deliberately
///         CUSTODIED slice (rev 7) is the RUNNER's share: it stays in this contract as
///         per-deployment escrow until a runner has actually held the lease for the
///         seconds it pays for — that escrow is exactly what makes seller payout
///         trustless (a permissionless runner is paid by the chain, not by an invoice
///         to the platform). Bonds (optional anti-sybil, below) and earned-but-
///         unwithdrawn runner balances are the only other funds ever held here.
///
/// Cancellation (rev 10): the owner can wind a deployment down and take its unused
///         runtime back on-chain — refund(). What it can pay out is exactly what this
///         contract still HOLDS for that record, which is the runner escrow: the
///         publisher's cut and the platform's remainder left at funding time and cannot
///         be clawed back from wallets this contract does not control. So a refund
///         returns the runner share (runnerBps of the platform component, 80% today) of
///         whatever time is still unspent — never the whole sticker price, and never a
///         promise the contract cannot keep. It is trustless in both directions: it can
///         no more fail for want of funds than it can pay out a seller's money, because
///         the seconds a live or provable lease can still claim are RESERVED out of it
///         (see refundableOf). Refunds go to d.owner and are capped at the escrow the
///         OWNER themselves funded (ownerEscrow6) — funding is permissionless, so that
///         cap is what keeps a refund a reversal of the owner's own payment rather than
///         a way to withdraw a third party's top-up (docs/billing-runbook.md §3).
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
///   - Pricing is the ENCLAVE'S, not the platform's (rev 8): every enclave states
///     what its whole machine costs per second in its EnclaveRegistry entry —
///     cpuPricePerSec6 for the node's vCPU+RAM, gpuPricePerSec6 for one card.
///     A deployment BUYS two shares — gpuMilli of a card's GPU+VRAM and cpuMilli
///     of a node's vCPU+RAM, in 1/1000ths — and pays that fraction of the host's
///     price: rate = (hostGpuPrice * gpuMilli + hostCpuPrice * cpuMilli) / 1000,
///     rounded up, plus the publisher fee. The rate is (re)snapshotted AT CLAIM
///     from whichever enclave takes the work, so a deployment that fails over to
///     a different box is priced by that box — and never above the owner's cap
///     (below). A live lease is never re-priced under the tenant: it was bought
///     at the price in force when it was claimed. Apps declare their EXACT
///     resource specs (VRAM, TFLOPS, RAM) in EnclaveAppCatalog; runners convert
///     those specs into each app's MINIMUM shares (spec / their hardware, the
///     larger of the memory and compute axes) and refuse deployments that
///     bought less.
///   - Rate cap (rev 8): every deployment carries maxRate6, the most it will pay
///     per second — set at create, changeable any time by the owner
///     (setMaxRate). It is checked on every purchase of time: claim, renew and
///     setShares all revert above it. That is what makes automatic failover safe
///     in a fleet of independently-priced enclaves: a dead host's work is picked
///     up by any enclave that fits AND charges at or under the cap, and by no
///     other. Lowering the cap under a running deployment's rate lets the paid
///     lease finish and then stops it — the cap is a spend ceiling, not just a
///     placement filter.
///   - THE TWO SHARES ARE INDEPENDENT (rev 13): revs <= 12 refused any
///     deployment whose cpuMilli exceeded a non-zero gpuMilli, on the reasoning
///     that a GPU app's CPU slice "rides along" on its card's node. It never
///     followed: the two shares are drawn from separate pools (a card's
///     VRAM+compute, the node's vCPU+RAM), a runner reserves them separately,
///     and the rate has always summed them independently. All the rule
///     achieved was forcing a CPU-heavy app that wants a small slice of card —
///     one model, plenty of pre/post-processing — to buy card it did not want,
///     at card prices. The floors that remain are the real ones: cpuMilli >= 1,
///     both <= 1000, gpuMilli <= maxGpuMilli, and the app's own catalog-derived
///     minimums (runner-enforced).
///   - SELF-HOSTING IS FREE (rev 12): when the claiming enclave's declared
///     payout wallet (EnclaveRegistry schema 4) IS the deployment's owner, the
///     host component of the rate is zero — a seller running their own app on
///     their own box pays nothing to run it. The publisher fee is untouched and
///     still funded and forwarded exactly as below: this waives what the host
///     and the platform would have charged, not what a third party is owed. A
///     free deployment needs no balance at all (claim burns nothing), earns its
///     runner nothing (the runner cut is a slice of the host component, so it
///     is zero too), and escrows nothing.
///
///     The registry is what makes this safe: that wallet is recorded only by a
///     transaction FROM it, so no operator can name a stranger and drag their
///     deployment into the free tier. That matters because the tenant's usual
///     defence against a squatting runner — dropping maxRate6 under its price —
///     cannot bite a rate of zero. The owner's remaining lever is setActive
///     (renew() refuses on an inactive record, so a squatted lease lapses
///     within leaseSec) and, on the registry side, clearPayoutWallet.
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
///   - PROOF OF TIME (rev 9): holding a lease is no longer what earns. A runner
///     is paid for time it can PROVE it served. The proof protocol itself -
///     block-anchored checkpoints signed by a key minted inside the serving
///     CVM - lives in EnclaveProofOfTime, a companion contract bound here ONCE
///     and then frozen (setProver / proverSealed). This contract keeps only
///     what touches money: the per-deployment watermark `provenUntil`, the
///     clamp that stops the runner meter at it, and the single prover-gated
///     entry point that advances it. See EnclaveProofOfTime for what a proof
///     is and why it cannot be forged, pre-signed, hoarded or compressed.
///
///     WHY TWO CONTRACTS: this one is a few dozen bytes under the EIP-170
///     limit. It is
///     not a layering preference - the verification simply does not fit here,
///     and putting it behind a sealed immutable binding was the only way to
///     ship proof of time without cutting something else out of the ledger.
///     The trust that grant carries is bounded and worth stating plainly: the
///     prover can advance a watermark, and nothing else. It cannot move a
///     tenant's balance, change a rate, redirect earnings, or credit past
///     `now`, past `leaseUntil`, or past what the escrow holds - every one of
///     those clamps is enforced HERE, below, on money this contract holds. A
///     broken prover degrades this ledger to rev-8 held-time metering at
///     worst; it can never overpay beyond what a rev-8 ledger already would.
///
/// BUILD SETTING, not a preference: this contract compiles at optimizer
///         runs=100, every other contract in the repo at the usual 200. Rev 12
///         costs 177 bytes of runtime code and rev 11 had 78 free, so the
///         choice was to spend the optimizer's size/gas dial or delete
///         something already shipped (sweepEscrow is 518 bytes, the claim-bond
///         family 1443). runs=100 changes no behaviour whatsoever - it only
///         tells solc to weight deploy size over per-call gas. Rev 13 gave
///         ~130 bytes back by DELETING the gpuMilli >= cpuMilli rule from
///         create and setShares, so the headroom is ~250 bytes.
///         scripts/deploy-deployments.mjs,
///         scripts/build-contract-artifacts.mjs and foundry.toml all pin it;
///         they must move together or the deployed bytecode stops being
///         reproducible from this source. Anything that needs materially more
///         room than that should go behind a companion binding, the way proof
///         of time did.
///
/// Fairness bounds (the cost of decentralized failover):
///   - a runner that dies mid-lease has already burned that lease: the TENANT
///     loses at most leaseSec of paid time per runner death (clean shutdowns
///     refund via release; the old per-tick freezing clock can't exist without
///     a trusted party). Under rev 9 the DEAD RUNNER is paid only through its
///     last checkpoint, so the gap between dying and being noticed costs the
///     host its own income and earns it nothing.
///   - a runner that stops serving but keeps its lease earns nothing after its
///     last checkpoint. The worst case it can steal is the proof anchor window
///     (~8.5 min on Base), against the 30 min (leaseSec) a rev-8 ledger paid
///     for the same silence.
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
///      The two price fields are registrySchema 2, `proofKey` is schema 3 and
///      `payoutWallet` is schema 4; this ledger requires all of them (an older
///      registry decodes short and every claim reverts), which is why they are
///      deployed as a set.
interface IEnclaveRegistry {
    struct Enclave {
        string  endpoint;
        string  repo;
        bytes32 measurement;
        address operator;
        uint64  registeredAt;
        uint64  lastSeen;
        bool    active;
        uint64  cpuPricePerSec6;
        uint64  gpuPricePerSec6;
        address proofKey;
        address payoutWallet;
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
        uint16  cpuMilli;       // CPU/RAM share bought, in 1/1000ths of a node (1..1000). INDEPENDENT of
                                // gpuMilli since rev 13: the two draw on different pools (a card's
                                // VRAM+compute vs the node's vCPU+RAM) and are priced additively, so a
                                // CPU-heavy GPU app may buy a sliver of a card beside most of a node.
                                // Revs <= 12 required gpuMilli == 0 || gpuMilli >= cpuMilli, which only
                                // ever forced tenants to over-buy card they had not asked for.
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
    bool    public retired;                // one-way end-of-life (rev 11): see retire()
    address public payout;                 // where funding lands (the Enclave cold wallet)
    IERC20Auth   public immutable usdc;
    IEnclaveRegistry public immutable registry;
    IAggregatorV3 public ethUsdFeed;       // 0x0 = ETH funding disabled (USDC only)

    // There is NO platform price here (rev 8): each enclave publishes what its
    // machine costs in its own registry entry, and a deployment is priced by
    // the enclave that claims it, bounded by the deployment's own rate cap.
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
    // reverts "length" on them.
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
    // Rev 8 keeps the struct byte-for-byte again and moves PRICING off the
    // platform and onto the enclaves: the two global list prices (and their
    // setters) are GONE, every enclave publishes its own per-machine price in
    // EnclaveRegistry (registrySchema 2), and a deployment's `rate` is
    // re-snapshotted from the claiming host on every claim. Each deployment
    // carries maxRate6 — an owner-set ceiling in the side mapping behind
    // capOf, settable at create and any time after (setMaxRate) — and claim /
    // renew / setShares all refuse to buy time above it. The cap + per-host
    // pricing feature gates on >= 8; a rev-8 ledger also REQUIRES a schema-2
    // registry (it reads prices out of the entry it already checks).
    // Rev 9 keeps the struct byte-for-byte one last time and changes WHAT
    // EARNS: the runner meter is capped by a per-deployment `provenUntil`
    // watermark that only a bound EnclaveProofOfTime may advance, so a runner
    // is paid for service it proved rather than lease time it held. New
    // surface here: provenUntil, creditProven, prover/setProver/proverSealed,
    // proofRequiredFrom/setProofRequiredFrom. The feature gates on >= 9, and a
    // rev-9 ledger REQUIRES a schema-3 registry (its claim gate reads proofKey
    // out of the entry it already checks). Metering only switches from held
    // time to proven time at proofRequiredFrom - see that field for why the
    // cutover is a date and not a deploy-time flag.
    // Rev 10 keeps the struct byte-for-byte and adds CANCELLATION: the owner
    // may end a deployment and take back the unspent runtime this contract
    // still holds for it (refund), bounded by ownerEscrow6 — the escrow that
    // the OWNER's own fundings contributed — and by what no live or still-
    // provable lease can claim. New surface: ownerEscrow6, refundableOf,
    // refund, and the Refunded event. The feature gates on >= 10; clients
    // below that simply never offer it (an older ledger has no refund path,
    // which is exactly what schema-9-and-under means).
    // Rev 11 keeps the struct byte-for-byte and makes the record itself
    // TRANSFERABLE: transferDeployment hands a deployment to another wallet.
    // Self-serve (the deployment's owner signs), unlike the catalog's
    // owner-ruled transferApp: a deployment is the buyer's asset, not a
    // curated lineage. A transfer moves CONTROL and never money — it is
    // refused while the contract still holds the owner's own refundable
    // backing (refund first; see the function's gate for why the check is
    // min(ownerEscrow6, escrow6) and not refundableOf). Rev 11 also adds
    // END-OF-LIFE: retire() (owner, one-way) closes every activity gate and
    // opens refund() to any caller — still always paying each record's
    // OWNER — so no ledger after this one can strand user funds at a
    // migration (see retire()). New surface: transferDeployment,
    // DeploymentTransferred, and retire/retired. The feature gates on >= 11.
    // Rev 12 keeps the struct byte-for-byte one more time and makes
    // SELF-HOSTING FREE: an enclave whose registry-declared payout wallet is
    // the deployment's own owner charges it nothing, so `rate` collapses to
    // the publisher fee (0 for a free app) and claim/renew burn nothing. No
    // new surface here at all — the whole feature is in what claim() prices
    // and what _burnLease() does at rate 0 — so clients gate on >= 12 only to
    // know that a rate of 0 is a legal, expected answer rather than a bug.
    // A rev-12 ledger REQUIRES a schema-4 registry (its rate reads
    // payoutWallet out of the entry it already fetches).
    // Rev 13 REMOVES a rule rather than adding surface: create/setShares no
    // longer require gpuMilli >= cpuMilli. Nothing changed shape, so a client
    // that never dials CPU above GPU cannot tell 12 from 13 — clients gate on
    // >= 13 only to know that offering the wider dial will not revert here.
    uint256 public constant deploymentsSchema = 13;

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
    /// @dev id -> the owner's per-second spend ceiling (USDC 6dp, rev 8). Never
    ///      0 for a record created here (create requires one); imported records
    ///      get theirs from importCaps, defaulting to the rate they carried.
    ///      A SIDE MAPPING for the same reason as _fees/_earn: the Deployment
    ///      tuple stays byte-for-byte across revs.
    mapping(bytes32 => uint256) private _maxRate6;
    mapping(address => uint256) public earned6;            // operator -> withdrawable runner earnings (USDC 6dp)

    /// @notice Of a deployment's escrow, how much the OWNER's own fundings put
    ///         there — the ceiling on what refund() may ever pay back (rev 10).
    ///         Funding is permissionless: anyone may top up anyone's active
    ///         deployment, and a sponsor's top-up buys the owner RUNTIME, not a
    ///         withdrawable deposit. Tracking the owner's own contribution is
    ///         what keeps a refund a reversal of the owner's payment to the
    ///         address that made it, rather than a way to withdraw someone
    ///         else's money (docs/billing-runbook.md §3). Decremented by
    ///         refund; ETH fundings never raise it because they escrow nothing.
    mapping(bytes32 => uint256) public ownerEscrow6;

    // ---- proof of time (rev 9) --------------------------------------------
    /// @notice How far each deployment's CURRENT runner has PROVEN it was
    ///         serving. The runner meter never credits past this once the
    ///         cutover has passed, so unproven time inside a paid lease earns
    ///         nothing. Seeded to block.timestamp at claim (a lease starts with
    ///         no proven time ahead of it), cleared at release, and advanced
    ///         ONLY by creditProven below.
    ///
    ///         The live shortfall a watcher looks for is
    ///         min(now, leaseUntil) - provenUntil: zero on a healthy
    ///         deployment, and a sustained non-zero value is a host that
    ///         stopped serving. It is deliberately computed off-chain rather
    ///         than exposed as a view here - see the size note in the header.
    mapping(bytes32 => uint64) public provenUntil;

    /// @notice The bound EnclaveProofOfTime, and whether that binding is final.
    ///         Set once, then frozen forever: a seller's proof of service must
    ///         not be re-pointable at a contract the platform swaps in later.
    ///         Zero (unbound) means no proof protocol is attached and the meter
    ///         behaves exactly as rev 8 did - which is also why "unset" doubles
    ///         as the one-shot guard: setProver refuses to overwrite a non-zero
    ///         binding, so the first write is the last.
    address public prover;

    /// @notice When the meter switches from HELD time to PROVEN time (0 = never).
    /// @dev A DATE, not a boolean, because this contract does not run alone:
    ///      independent sellers (metal/PROTOCOL.md) upgrade their own boxes on
    ///      their own schedule, and flipping the meter the instant a new ledger
    ///      goes live would silently zero the income of every host still
    ///      running yesterday's supervisor. Before the cutover the meter pays
    ///      held time exactly as rev 8 did, while checkpoints are already
    ///      accepted and recorded - so every operator can watch their own
    ///      coverage and fix their box BEFORE it costs them anything. The
    ///      constructor sets it PROOF_GRACE ahead of deployment so the cutover
    ///      happens by itself, with no admin step to forget.
    ///
    ///      Also THE KILL SWITCH: if a rollout goes wrong and honest hosts are
    ///      losing income to a bug in their own proving loop, the owner moves
    ///      it forward (or to 0) and the meter falls back to held time with no
    ///      other state disturbed - provenUntil keeps advancing meanwhile, so
    ///      flipping it back on resumes exactly where it left off.
    uint64 public proofRequiredFrom;
    uint64 private constant PROOF_GRACE = 14 days;
    mapping(address => Bond) private _bonds;               // operator -> claim bond
    mapping(address => uint64) private _nonces;            // per-creator id salt
    /// @dev The first 4 bytes of every live id. Off-chain the platform names a
    ///      deployment by that prefix — `<8 hex>.app.enclave.host` is a DNS
    ///      label, and a full 64-hex id does not fit in one. 32 bits is not a
    ///      birthday problem here, it is a GRINDING one: ids are
    ///      keccak256(creator, nonce), so anyone can hash candidate creator
    ///      addresses offline until one's next id shares a victim's prefix —
    ///      seconds of work, no gas — and then create that single deployment to
    ///      make the victim's hostname ambiguous. Reserving the prefix makes
    ///      that impossible instead of merely unlikely: the create loop below
    ///      simply rolls to the next nonce, and the grind has nothing to land on.
    mapping(bytes4 => bool) private _prefixTaken;

    event Created(bytes32 indexed id, address indexed owner, string appRef, uint16 gpuMilli, uint16 cpuMilli, uint256 rate);
    event FeeSet(bytes32 indexed id, address indexed recipient, uint256 feePerSec6);
    event AppRefSet(bytes32 indexed id, string appRef);
    event SharesSet(bytes32 indexed id, uint16 gpuMilli, uint16 cpuMilli, uint256 rate);
    event ConfigSet(bytes32 indexed id, string configCid);
    event ActiveSet(bytes32 indexed id, bool active);
    event DeploymentTransferred(bytes32 indexed id, address indexed from, address indexed to);
    event Funded(bytes32 indexed id, address indexed payer, uint256 amount6);
    event FundedEth(bytes32 indexed id, address indexed payer, uint256 amountWei, uint256 credited6);
    event Claimed(bytes32 indexed id, bytes32 indexed enclaveId, address indexed operator, uint64 leaseUntil, uint256 burned6);
    event Renewed(bytes32 indexed id, bytes32 indexed enclaveId, uint64 leaseUntil, uint256 burned6);
    event Released(bytes32 indexed id, bytes32 indexed enclaveId, uint256 refunded6);
    event RunnerRateSet(bytes32 indexed id, uint256 runnerRate6);
    event RunnerCredited(bytes32 indexed id, address indexed operator, uint256 amount6, uint64 secondsCredited);
    event EarningsWithdrawn(address indexed operator, address indexed to, uint256 amount6);
    event EscrowFunded(bytes32 indexed id, address indexed from, uint256 amount6);
    event EscrowSwept(bytes32 indexed id, uint256 amount6);
    event Refunded(bytes32 indexed id, address indexed to, uint256 amount6);
    event RunnerBpsSet(uint16 runnerBps);
    event ClaimBondSet(uint256 bond6, uint64 exitDelaySec);
    event BondPosted(address indexed operator, uint256 amount6, uint256 bonded6);
    event BondExitRequested(address indexed operator, uint64 exitAt);
    event BondWithdrawn(address indexed operator, address indexed to, uint256 amount6);
    event BondSlashed(address indexed operator, uint256 amount6, string reason);
    event MaxRateSet(bytes32 indexed id, uint256 maxRate6);
    event ProverSet(address indexed prover);
    event ProofRequiredFromSet(uint64 at);
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
        emit MaxGpuMilliSet(maxGpuMilli);
        emit MaxFeeSet(maxFeePerSec6);
        emit RunnerBpsSet(runnerBps);              // runner payout live from deploy; bond off by default
        emit ClaimBondSet(claimBond6, bondExitDelay);
        // Proof of time runs in grace from block one: checkpoints are accepted
        // and recorded immediately, but the METER only switches to proven time
        // after the window, so a fleet of independently-operated boxes gets an
        // announced date to be ready by instead of a cliff.
        proofRequiredFrom = uint64(block.timestamp) + PROOF_GRACE;
        emit ProofRequiredFromSet(proofRequiredFrom);
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
    /// @param maxRate6 the owner's per-second spend ceiling (USDC 6dp, > the
    ///        publisher fee). REQUIRED: there is no platform price left to fall
    ///        back on, so a deployment states what it is willing to pay before
    ///        any enclave prices it. Until the first claim this doubles as the
    ///        record's rate — the worst case — so funding splits and
    ///        secondsFundable never over-promise. Change it any time with
    ///        setMaxRate.
    function create(
        string calldata appRef,
        uint16 gpuMilli,
        uint16 cpuMilli,
        uint32 appPort,
        string calldata ports,
        bool isPublic,
        string calldata configCid,
        address feeRecipient,
        uint256 feePerSec6,
        uint256 maxRate6
    ) external returns (bytes32 id) {
        // own frame: with rev 8's tenth argument the checks and the body no
        // longer fit one stack together (even under viaIR)
        _validateCreate(appRef, ports, configCid, gpuMilli, cpuMilli, appPort);

        // ids are creator-salted hashes; the loop guards the one collision path
        // that exists — a fresh contract's nonce restarting at 0 while imported
        // records already carry this creator's old (sender, nonce) ids.
        do { id = keccak256(abi.encodePacked(msg.sender, _nonces[msg.sender]++)); }
        while (_exists[id] || _prefixTaken[bytes4(id)]);
        _exists[id] = true;
        _prefixTaken[bytes4(id)] = true;   // the hostname label is unique too (see _prefixTaken)
        _ids.push(id);

        Deployment storage d = _deployments[id];
        d.id = id;
        d.owner = msg.sender;
        d.appRef = appRef;
        d.ports = ports;
        d.configCid = configCid;
        _initFee(d, feeRecipient, feePerSec6);   // before _initScalars: the rate fold reads the snapshot
        _initCap(id, maxRate6);                  // before too: the pre-claim rate IS the cap
        _initScalars(d, appRef, gpuMilli, cpuMilli, appPort, isPublic);
        _snapRunnerRate(d);                      // after: the runner cut is a slice of the folded rate
    }

    /// @dev create()'s shape/bounds checks (the parts that don't touch storage).
    function _validateCreate(string calldata appRef, string calldata ports, string calldata configCid,
                             uint16 gpuMilli, uint16 cpuMilli, uint32 appPort) private pure {
        require(bytes(appRef).length > 0 && bytes(appRef).length <= MAX_APPREF, "length");
        require(cpuMilli > 0 && cpuMilli <= 1000, "range");
        require(gpuMilli <= 1000, "range");
        require(appPort > 0, "range");
        require(bytes(ports).length <= MAX_PORTS, "length");
        require(bytes(configCid).length <= MAX_CFG, "length");
    }

    /// @dev Record the spend ceiling. Bounded by uint96 so every later
    ///      _snapRunnerRate (rate <= cap) is in range — a claim must never be
    ///      able to revert on an overflow check.
    function _initCap(bytes32 id, uint256 maxRate6) private {
        require(maxRate6 > _fees[id].rate6, "maxRate <= fee");
        require(maxRate6 <= type(uint96).max, "range");
        _maxRate6[id] = maxRate6;
        emit MaxRateSet(id, maxRate6);
    }

    /// @notice Change the deployment's per-second spend ceiling — the owner's
    ///         "never pay more than this" line, editable while the app runs.
    /// @dev Checked on every purchase of time: claim, renew and setShares all
    ///      revert above it. RAISING it opens the deployment to pricier
    ///      enclaves on the next claim; LOWERING it below the current rate lets
    ///      the already-paid lease finish and then stops the app (no renew, no
    ///      re-claim) until a cheap enough enclave exists or the cap goes back
    ///      up — that is the point of a ceiling, and clients warn before
    ///      signing it. An UNLEASED record re-bases its placeholder rate on the
    ///      new cap, so funding splits and secondsFundable keep telling the
    ///      truth about the worst case; a live lease is never re-priced.
    function setMaxRate(bytes32 id, uint256 maxRate6) external {
        Deployment storage d = _requireOwned(id);
        require(maxRate6 > _fees[id].rate6, "maxRate <= fee");
        require(maxRate6 <= type(uint96).max, "range");
        _maxRate6[id] = maxRate6;
        if (d.leaseUntil <= block.timestamp) {   // unleased: the cap IS the working rate
            d.rate = maxRate6;
            _snapRunnerRate(d);
        }
        emit MaxRateSet(id, maxRate6);
    }

    /// @dev Snapshot the runner's per-second cut: runnerBps of the PLATFORM
    ///      component (rate minus the publisher fee). Own frame, same stack
    ///      reason as _initScalars; also the resize path's recompute (a resize
    ///      is a new purchase decision, so it re-reads the CURRENT runnerBps,
    ///      exactly as it re-reads the current list prices).
    function _snapRunnerRate(Deployment storage d) private {
        uint256 r6 = ((d.rate - _fees[d.id].rate6) * runnerBps) / 10000;
        require(r6 <= type(uint96).max, "range");
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
        require(feePerSec6 <= maxFeePerSec6, "range");    // create-only cap; imports bypass (grandfathered)
        require(feeRecipient != address(0), "fee recipient");
        _fees[d.id] = Fee(feeRecipient, uint96(feePerSec6));  // cast safe: maxFeePerSec6 <= uint96.max (setter-enforced)
        emit FeeSet(d.id, feeRecipient, feePerSec6);
    }

    /// @dev Split out (emit included) so create() keeps a workable stack frame
    ///      without viaIR (same shape as the catalog's `_reserveCid` / `_touchApp`).
    function _initScalars(Deployment storage d, string calldata appRef, uint16 gpuMilli,
                          uint16 cpuMilli, uint32 appPort, bool isPublic) private {
        require(gpuMilli <= maxGpuMilli, "gpuShare > max");   // create-only cap; imports bypass (grandfathered)
        d.gpuMilli = gpuMilli;
        d.cpuMilli = cpuMilli;
        d.appPort = appPort;
        d.isPublic = isPublic;
        d.active = true;
        d.createdAt = uint64(block.timestamp);
        // No host has priced this yet, so the working rate is the CAP: the most
        // it could ever cost. Every rate-derived number (funding splits,
        // secondsFundable, claimable) then states the worst case until a claim
        // replaces it with the actual host's price.
        d.rate = _maxRate6[d.id];
        emit Created(d.id, msg.sender, appRef, gpuMilli, cpuMilli, d.rate);
    }

    /// @dev What `e` charges THIS deployment for `gpuMilli`/`cpuMilli`
    ///      thousandths of its machine, per second: its registered whole-machine
    ///      prices scaled by the shares, ceil'd so a 1-milli deployment still
    ///      pays >= 1 unit/sec. The publisher fee is added by callers (it is the
    ///      deployment's, not the host's).
    ///
    ///      ZERO when the box's declared payout wallet IS this deployment's
    ///      owner (rev 12): a seller's own app on a seller's own box is free.
    ///      That comparison is the whole feature; everything else it touches is
    ///      just arithmetic that must not divide by the zero it produces.
    function _hostRate(IEnclaveRegistry.Enclave memory e, Deployment storage d,
                       uint16 gpuMilli, uint16 cpuMilli) private view returns (uint256)
    {
        if (e.payoutWallet == d.owner) return 0;
        return (uint256(e.gpuPricePerSec6) * gpuMilli + uint256(e.cpuPricePerSec6) * cpuMilli + 999) / 1000;
    }

    /// @notice What this deployment would cost per second on `enclaveId` — the
    ///         exact number claim() would snapshot. Runners and clients
    ///         pre-check with it (a claim over the cap reverts). 0 is a legal
    ///         answer from rev 12 on: a free app self-hosted by its own owner.
    function rateFor(bytes32 id, bytes32 enclaveId) public view returns (uint256) {
        require(_exists[id], "unknown");
        Deployment storage d = _deployments[id];
        return _hostRate(registry.get(enclaveId), d, d.gpuMilli, d.cpuMilli) + _fees[id].rate6;
    }

    /// @notice True iff `enclaveId` could claim `id` right now: open (active,
    ///         no live lease), priced at or under the cap, and funded at THAT
    ///         enclave's price — which a self-hosted deployment satisfies with
    ///         an empty balance, since its price is zero.
    /// @dev Deliberately does NOT go through claimable(), whose funded test is
    ///      against the record's own (worst-case) rate: that reads a free
    ///      deployment as unclaimable and would hide it from the very host that
    ///      hosts it for nothing.
    /// @dev _open FIRST, and not merely for the short-circuit: rateFor reverts
    ///      "unknown" on an id that does not exist, and this call answered
    ///      `false` there before rev 12. A view that starts reverting is a
    ///      client outage, not a nicety.
    function claimableBy(bytes32 id, bytes32 enclaveId) external view returns (bool) {
        if (!_open(id)) return false;
        uint256 r = rateFor(id, enclaveId);
        uint256 cap = _maxRate6[id];
        return (cap == 0 || r <= cap) && _deployments[id].balance6 >= r;
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
        require(bytes(appRef).length > 0 && bytes(appRef).length <= MAX_APPREF, "length");
        d.appRef = appRef;
        emit AppRefSet(id, appRef);
    }

    /// @notice Re-buy the deployment's two shares in place (grow OR shrink) —
    ///         the owner's RESIZE path, typically batched with setAppRef via
    ///         multicall() when a new version needs different resources. The
    ///         rate is RECALCULATED — at the SERVING enclave's prices while a
    ///         lease is live (that box is the one selling the bigger slice),
    ///         at the cap when the record is unleased (no host has priced it,
    ///         so the worst case stands in) — plus the deployment's immutable
    ///         publisher-fee snapshot. A resize is a new purchase decision,
    ///         exactly like create, and it may not push the rate above the
    ///         owner's cap: raise the cap first (setMaxRate) if it does. Same
    ///         bounds as create, including the operator's maxGpuMilli cap.
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
        require(cpuMilli > 0 && cpuMilli <= 1000, "range");
        require(gpuMilli <= 1000, "range");
        require(gpuMilli <= maxGpuMilli, "gpuShare > max");
        uint256 newRate = _resizeRate(id, d, gpuMilli, cpuMilli);
        _requireUnderCap(id, newRate);
        _creditRunner(d);                            // settle served time at the OLD runner rate first
        if (d.leaseUntil > block.timestamp) {
            uint256 tail = d.leaseUntil - block.timestamp;
            uint256 refund = tail * d.rate;          // settle the unserved tail at the rate it was burned at
            d.balance6 += refund;
            d.spent6 -= refund;
            uint256 secs = newRate == 0 ? tail       // self-hosted: the window costs nothing to keep
                                        : d.balance6 / newRate;   // re-burn it at the new rate
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

    /// @dev The working rate of a record no enclave is currently serving: its
    ///      ceiling, or — for a legacy import that was never given one — the
    ///      rate it carried over. Never 0, so _burnLease's division is safe.
    function _unleasedRate(bytes32 id, Deployment storage d) private view returns (uint256) {
        uint256 cap = _maxRate6[id];
        return cap > 0 ? cap : d.rate;
    }

    /// @dev What a resize re-buys the shares at: the SERVING enclave's posted
    ///      price plus the fee snapshot. Falls back to the unleased basis (the
    ///      ceiling) when nothing is serving it, or when its runner id is not a
    ///      registered entry — an UNPRICED runner (the zero struct) must not
    ///      make a deployment free while it keeps serving out its lease.
    ///      Rev 12 moves that test from "priced at zero" to "no entry": a
    ///      registered enclave always prices above zero (register/setPrices
    ///      both require cpuPricePerSec6 > 0, and every deployment buys at
    ///      least 1 cpuMilli), so the only zero left is the SELF-HOSTED one —
    ///      which is meant, and must survive a resize instead of bouncing the
    ///      deployment back up to its cap.
    function _resizeRate(bytes32 id, Deployment storage d, uint16 gpuMilli, uint16 cpuMilli)
        private view returns (uint256)
    {
        if (d.leaseUntil <= block.timestamp) return _unleasedRate(id, d);
        IEnclaveRegistry.Enclave memory e = registry.get(d.runner);
        if (e.operator == address(0)) return _unleasedRate(id, d);
        return _hostRate(e, d, gpuMilli, cpuMilli) + _fees[id].rate6;
    }

    /// @dev The spend ceiling, enforced everywhere time is BOUGHT (claim /
    ///      renew / setShares). cap 0 = uncapped, which only an import can
    ///      produce (create requires one) — a legacy record keeps behaving
    ///      exactly as it did before rev 8 until its owner sets a cap.
    function _requireUnderCap(bytes32 id, uint256 rate) private view {
        uint256 cap = _maxRate6[id];
        require(cap == 0 || rate <= cap, "over rate cap");
    }

    /// @notice Update the portable config; runners apply it on the next (re)launch.
    function setConfig(bytes32 id, string calldata configCid) external {
        Deployment storage d = _requireOwned(id);
        require(bytes(configCid).length <= MAX_CFG, "length");
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

    /// @notice Hand this deployment to another wallet (rev 11): every owner
    ///         right — config, active, cap, resize, version changes — moves in
    ///         one signature. A transfer NEVER moves money between wallets:
    ///         while this contract still holds any of the owner's own
    ///         refundable backing, the transfer is refused — refund() first,
    ///         so the money returns to the wallet that paid it and what
    ///         changes hands is the record alone. Zero-balance records
    ///         transfer freely (the new owner funds them, and from then on
    ///         it is THEIR fundings that credit ownerEscrow6); sponsored or
    ///         ETH-bought runtime rides along untouched, because none of it
    ///         was ever the owner's to withdraw.
    /// @dev The gate is min(ownerEscrow6, escrow6) == 0, NOT refundableOf == 0:
    ///      mid-lease the free part refunds immediately but the lease reserve
    ///      stays escrowed for the seller and frees again at release — a
    ///      refundableOf gate passes in that window and would hand the
    ///      released tail to the NEW owner. And a fully-SPENT record keeps a
    ///      stale ownerEscrow6 (only refund decrements it) with no escrow
    ///      behind it; it must stay transferable — the escrow6 side clears it.
    ///      ONE-SHOT, no pending/accept step: a two-step handoff costs ~460
    ///      bytes of runtime code and this contract has ~100 under EIP-170
    ///      (see WHY TWO CONTRACTS above) — so clients must confirm `to`
    ///      before signing. A mistyped `to` loses the RECORD but never money:
    ///      the gate already sent the money home. Zero is refused so a
    ///      transfer cannot orphan the record into the sweep path. The id
    ///      keeps embedding the CREATOR (ids are (creator, nonce) hashes,
    ///      never re-derived), so a transferred id never moves or collides.
    function transferDeployment(bytes32 id, address to) external {
        Deployment storage d = _requireOwned(id);
        require(to != address(0), "zero addr");
        require(ownerEscrow6[id] == 0 || _earn[id].escrow6 == 0, "refund first");
        d.owner = to;
        emit DeploymentTransferred(id, msg.sender, to);
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
        _splitFunding(id, from, d.rate, value);
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
        require(usdc.transferFrom(msg.sender, address(this), value), "USDC transfer failed");
        _splitFunding(id, msg.sender, d.rate, value);
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
    function _splitFunding(bytes32 id, address payer, uint256 rate, uint256 value) private {
        (address feeTo, uint256 cut) = _feeShare(id, rate, value);
        uint256 esc = 0;
        uint96 r6 = _earn[id].rate6;
        if (r6 > 0) {
            esc = (value * r6 + (rate - 1)) / rate;            // ceil — escrow must cover its seconds
            if (esc > value - cut) esc = value - cut;
            // cast safe: esc <= value = real USDC received (total supply << uint96.max 6dp)
            _earn[id].escrow6 += uint96(esc);
            // only the owner's own money is refundable to the owner (rev 10)
            if (payer == _deployments[id].owner) ownerEscrow6[id] += esc;
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
        require(msg.value > 0, "amount=0");
        require(address(ethUsdFeed) != address(0), "eth funding disabled");
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = ethUsdFeed.latestRoundData();
        require(answer > 0 && block.timestamp - updatedAt <= FEED_MAX_AGE, "stale price");
        require(answeredInRound >= roundId, "incomplete round");   // reject an answer carried over from an earlier (unfinalized) round
        // wei(1e18) * price(1e8) -> USDC 6dp: divide by 1e20
        uint256 credited = (msg.value * uint256(answer)) / 1e20;
        require(credited > 0, "amount=0");
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

    /// @notice Take the lease on a claimable deployment AT THIS ENCLAVE'S PRICE.
    ///         Re-snapshots the rate from the caller's registered per-machine
    ///         prices (rev 8), burns min(leaseSec, remaining funded time) from
    ///         the balance and makes the caller the sole legitimate runner until
    ///         leaseUntil. Claimable = active, funded, and no live lease (never
    ///         claimed, expired, or released).
    /// @dev msg.sender must be the operator of `enclaveId`, an active EnclaveRegistry
    ///      entry — structural gating, same shape as catalog lineage ownership.
    ///      The previous runner's burned lease is NOT refunded (it may be dead;
    ///      nobody trustworthy can attest how much it actually served).
    ///
    ///      This is where automatic failover meets the owner's ceiling: a dead
    ///      host's work is open to every enclave, and the ones whose price for
    ///      these shares exceeds maxRate6 simply cannot take it ("over rate
    ///      cap"). The rate a tenant pays therefore only ever moves when the
    ///      work moves, and never above what they signed for.
    function claim(bytes32 id, bytes32 enclaveId) external {
        Deployment storage d = _requireActive(id);
        require(block.timestamp > d.leaseUntil, "leased");
        IEnclaveRegistry.Enclave memory e = registry.get(enclaveId);
        require(e.operator == msg.sender, "not runner");
        require(e.active, "enclave inactive");
        require(e.cpuPricePerSec6 > 0, "enclave inactive");
        // Past the cutover, an enclave with no published in-CVM proof key could
        // hold a lease it can never be paid for, and the tenant's app would sit
        // on a box with no incentive to keep it up. Refuse the claim: the work
        // stays in the queue for a host that can prove its service.
        require(!proofRequired() || e.proofKey != address(0), "no proof key");
        if (claimBond6 > 0) {                    // optional anti-sybil gate (0 = off)
            Bond storage b = _bonds[msg.sender];
            require(b.amount6 >= claimBond6 && b.exitAt == 0, "bond required");
        }
        _creditRunner(d);                        // settle the PREVIOUS runner's expired-lease tail at ITS rate

        uint256 newRate = _hostRate(e, d, d.gpuMilli, d.cpuMilli) + _fees[id].rate6;
        _requireUnderCap(id, newRate);
        d.rate = newRate;                        // the price in force for this lease
        _snapRunnerRate(d);                      // this host earns runnerBps of its OWN ask
        (uint64 until, uint256 burned) = _burnLease(d, uint64(block.timestamp));
        d.runner = enclaveId;
        d.runnerOperator = msg.sender;
        d.leaseUntil = until;
        _earn[id].creditedUntil = uint64(block.timestamp);   // the new runner's meter starts NOW
        provenUntil[id] = uint64(block.timestamp);           // ... and so does its proof obligation:
                                                             // the previous runner's watermark must not
                                                             // carry over and hand this one free seconds
        emit Claimed(id, enclaveId, msg.sender, until, burned);
    }

    /// @notice Extend a live lease (only the current runner, only before expiry —
    ///         after expiry the job is back in the open queue and even the same
    ///         runner must re-claim). Burns the next quantum at the rate this
    ///         lease was claimed at; extends FROM leaseUntil, since time up to
    ///         there is already paid.
    /// @dev A renew BUYS time, so it is capped like a claim: if the owner has
    ///      dropped maxRate6 under the running rate this reverts "over rate
    ///      cap" and the app finishes the lease it already paid for, then
    ///      stops. Runners surface that to the owner rather than retrying.
    function renew(bytes32 id) external {
        Deployment storage d = _requireActive(id);
        require(d.runnerOperator == msg.sender, "not runner");
        require(block.timestamp <= d.leaseUntil, "lease expired");
        _requireUnderCap(id, d.rate);
        _creditRunner(d);                        // credit the lease time held so far
        (uint64 until, uint256 burned) = _burnLease(d, d.leaseUntil);
        d.leaseUntil = until;
        emit Renewed(id, d.runner, until, burned);
    }

    /// @notice Graceful hand-back: refund the unused lease tail to the balance and
    ///         reopen the queue. Called on clean shutdown, on teardown after the
    ///         owner stops the deployment, or when provisioning fails right after
    ///         a claim (so the user doesn't pay for a runner that never served).
    /// @dev THE PARTIAL-PERIOD PATH, and it is ORDER-SENSITIVE. A runner tearing
    ///      down mid-hour - the app crashed, the owner stopped it, the box is
    ///      being drained - settles the fraction it actually served by posting a
    ///      final checkpoint to EnclaveProofOfTime and THEN releasing. The
    ///      checkpoint moves provenUntil to the moment of the crash, this call
    ///      credits exactly that, and the unserved remainder of the lease goes
    ///      back to the tenant.
    ///
    ///      Proof and release live on different contracts, so there is no single
    ///      multicall spanning them - and this call CLEARS the watermark, so a
    ///      final proof sent after it has no lease left to prove against and
    ///      settles nothing. Runners must send checkpoint-then-release, in that
    ///      order, through a queue that serializes on confirmation. Releasing
    ///      without the final proof at all is legal and costs the runner the
    ///      unproven tail, so the incentive points at settling honestly either
    ///      way.
    function release(bytes32 id) external {
        Deployment storage d = _deployments[id];
        require(_exists[id], "unknown");
        require(d.runnerOperator == msg.sender, "not runner");
        _creditRunner(d);                        // pay for time HELD; the refunded tail earns nothing
        uint256 tail = 0;                        // not `refund` — that names the owner-facing rev-10 call
        if (d.leaseUntil > block.timestamp) {
            tail = (d.leaseUntil - block.timestamp) * d.rate;
            d.balance6 += tail;
            d.spent6 -= tail;
        }
        bytes32 enclaveId = d.runner;
        d.runner = bytes32(0);
        d.runnerOperator = address(0);
        d.leaseUntil = 0;
        _earn[id].creditedUntil = 0;             // meter idles until the next claim restarts it
        provenUntil[id] = 0;                     // and the proof watermark resets with it
        emit Released(id, enclaveId, tail);
    }

    /// @dev Burn one lease quantum starting at `from`: as many seconds as the
    ///      balance affords, capped at leaseSec. Reverts if the balance can't buy
    ///      a single second ("no more time left" — the queue drops the item).
    ///      Rate 0 is the self-hosted case (rev 12): a full quantum, nothing
    ///      burned, and no balance required — which is also why this returns
    ///      before the division rather than relying on it.
    function _burnLease(Deployment storage d, uint64 from) private returns (uint64 until, uint256 burned) {
        uint256 rate = d.rate;
        uint256 secs = rate == 0 ? leaseSec : d.balance6 / rate;
        if (secs > leaseSec) secs = leaseSec;
        require(secs > 0, "unfunded");
        burned = secs * rate;
        d.balance6 -= burned;
        d.spent6 += burned;
        // A PAID renew extends from leaseUntil, because the time up to there is
        // already bought and must be honoured. A FREE one may not: nothing is
        // bought, so `from` would let a runner stack quantum after quantum in a
        // single multicall and pin a deployment months into the future at no
        // cost — outliving any eviction its owner has. A free lease is always
        // exactly one quantum from NOW, which is what makes setActive(false)
        // (renew then reverts "inactive") a bound of leaseSec and not a wish.
        until = (rate == 0 ? uint64(block.timestamp) : from) + uint64(secs);
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
    ///
    ///      Rev 9 adds the third ceiling: provenUntil. Past the cutover a
    ///      runner is paid for the intersection of time it HELD the lease and
    ///      time it PROVED it was serving - so silence inside a paid lease
    ///      earns nothing, and the pro-rata is exact to the second in both
    ///      directions. Unproven time is forfeit on the same principle as
    ///      unbacked time: creditedUntil does not advance past it, so a host
    ///      that goes dark and comes back is paid for what it proves after it
    ///      returns, never for the gap.
    function _creditRunner(Deployment storage d) private {
        if (d.runner == bytes32(0)) return;                  // no lease has ever started, or released
        Earn storage e = _earn[d.id];
        uint64 upto = uint64(block.timestamp);
        if (upto > d.leaseUntil) upto = d.leaseUntil;        // an expired lease earns through its end, no further
        if (proofRequired()) {
            uint64 proven = provenUntil[d.id];
            if (upto > proven) upto = proven;                // ... and no further than it proved it served
        }
        if (upto <= e.creditedUntil) return;
        uint64 secs = upto - e.creditedUntil;
        uint256 credit = uint256(secs) * e.rate6;
        if (credit > e.escrow6) credit = e.escrow6;
        e.creditedUntil = upto;
        if (credit == 0) return;
        e.escrow6 -= uint96(credit);                         // cast safe: credit <= escrow6 (uint96)
        earned6[d.runnerOperator] += credit;
        emit RunnerCredited(d.id, d.runnerOperator, credit, secs);
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

    /// @notice Advance a deployment's proven-service watermark and pay out what
    ///         that just unlocked. The ONLY way provenUntil ever moves forward,
    ///         and callable only by the bound EnclaveProofOfTime, which accepts
    ///         it only against a block-anchored signature from the serving
    ///         enclave's in-CVM key.
    /// @dev Every clamp that touches money is re-applied HERE rather than
    ///      trusted to the prover, so the worst a broken or hostile prover can
    ///      do is degrade this ledger to rev-8 held-time metering:
    ///        - never past `now` (no buying future seconds);
    ///        - never past `leaseUntil` (no earning outside what the tenant
    ///          bought - the released tail is refunded to them, so it can
    ///          never also be earned);
    ///        - strictly monotonic (a watermark cannot be walked backwards to
    ///          replay a window, and a repeat is a revert, not a silent no-op);
    ///        - and _creditRunner below still caps the payout by the escrow
    ///          this contract actually holds.
    ///      The prover owns exactly one rule this contract does not re-check:
    ///      how far back a single proof may reach (its window). That is what
    ///      makes proof of time expensive to fake, and it is enforced there.
    /// @notice True once the meter pays for PROVEN service instead of held
    ///         lease time. Checkpoints are accepted and recorded either way -
    ///         this only decides whether _creditRunner is capped by the
    ///         watermark. Clients show it so a seller knows which rules its
    ///         income is under today.
    function proofRequired() public view returns (bool) {
        return proofRequiredFrom != 0 && block.timestamp >= proofRequiredFrom;
    }

    function creditProven(bytes32 id, uint64 upto) external {
        require(msg.sender == prover, "!prover");
        Deployment storage d = _deployments[id];
        uint64 ceiling = uint64(block.timestamp);
        if (ceiling > d.leaseUntil) ceiling = d.leaseUntil;
        if (upto > ceiling) upto = ceiling;
        require(upto > provenUntil[id], "nothing to prove");
        provenUntil[id] = upto;
        _creditRunner(d);
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
        require(amt > 0, "amount=0");
        earned6[msg.sender] = 0;                             // effects before interaction
        require(usdc.transfer(to, amt), "USDC transfer failed");
        emit EarningsWithdrawn(msg.sender, to, amt);
    }

    /// @notice Top up a deployment's runner escrow directly (USDC allowance,
    ///         forwarded into the contract). Permissionless — this only ever
    ///         ADDS backing for runner credits. The platform uses it to re-back
    ///         records whose balance arrived outside the escrowing paths:
    ///         imported (migrated) balances and ETH fundings.
    /// @dev Who that escrow counts as REFUNDABLE for (rev 10) splits on exactly
    ///      those two cases, and the import window separates them. While
    ///      imports are OPEN the platform is re-seating escrow that a migrated
    ///      record's balance already represents — money the OWNER paid on the
    ///      source contract — so it credits ownerEscrow6. Without that, every
    ///      deployment predating this ledger would arrive permanently
    ///      un-refundable and sealImports would make it permanent. Once SEALED,
    ///      a platform top-up is the ETH-funding case instead: that payer's ETH
    ///      went to payout, and this is the platform making runners whole with
    ///      its own money, so it backs credits without becoming refundable.
    function fundEscrow(bytes32 id, uint256 amount6) external {
        Deployment storage d = _requireActive(id);
        require(amount6 > 0, "amount=0");
        require(_earn[id].rate6 > 0, "no runner rate");      // a rate-0 record can never credit it back out
        require(usdc.transferFrom(msg.sender, address(this), amount6), "USDC transfer failed");
        _earn[d.id].escrow6 += uint96(amount6);              // cast safe: real USDC received
        if (msg.sender == d.owner || (msg.sender == owner && !importsSealed))
            ownerEscrow6[id] += amount6;                     // owner's own backing stays refundable
        emit EscrowFunded(id, msg.sender, amount6);
    }

    /// @notice What refund() would pay the owner right now (USDC 6dp): the
    ///         escrow this contract still holds for the record, less whatever a
    ///         lease can still legitimately claim, capped by the escrow the
    ///         owner's own fundings put there. Zero is the normal answer for a
    ///         deployment that has spent everything it bought.
    /// @dev EXACT, not an estimate, even though this is a view that cannot
    ///      advance the meter first: _creditRunner moves escrow6 and
    ///      creditedUntil by the same number of seconds' worth, so
    ///      (escrow6 - reserve) is invariant across a settle. When the credit
    ///      is escrow-clamped, reserve already exceeds escrow6 and both this
    ///      and refund() see zero. Clients can therefore render this number
    ///      directly and refund() will pay it.
    function refundableOf(bytes32 id) public view returns (uint256) {
        Deployment storage d = _deployments[id];
        Earn storage e = _earn[id];
        // seconds a live lease — or a late checkpoint against one that lapsed —
        // could still prove and be paid for. That money is the seller's.
        uint256 reserve = d.leaseUntil > e.creditedUntil
            ? uint256(d.leaseUntil - e.creditedUntil) * e.rate6
            : 0;
        uint256 free = e.escrow6 > reserve ? e.escrow6 - reserve : 0;
        uint256 own = ownerEscrow6[id];
        return own < free ? own : free;
    }

    /// @notice Cancel a deployment and take its unused runtime back (rev 10).
    ///         Owner only. Pays out the held escrow that no lease can still
    ///         claim — see refundableOf for exactly how much, and the header
    ///         for why that is the runner share and not the full sticker price
    ///         (the publisher's cut and the platform's remainder left this
    ///         contract at funding time). Zeroes the balance and deactivates
    ///         the record: the runtime goes back with the money, and the
    ///         deployment stops being claimable. It can be funded again later.
    /// @dev Ordering is load-bearing. _creditRunner runs FIRST, so a runner is
    ///      paid for everything it has proven before a cent moves to the owner,
    ///      and the reserve keeps back whatever a still-open lease could prove
    ///      afterwards — so cancelling mid-lease can never strand a seller, and
    ///      never needs to make the owner wait for the lease to lapse either.
    ///      Refunding during a live lease pays the free part now; the reserved
    ///      tail becomes refundable once the runner releases (which returns the
    ///      unused tail to balance6) or the lease lapses unproven, so a second
    ///      call collects it. All state is written before the transfer (CEI).
    function refund(bytes32 id) external {
        Deployment storage d = _deployments[id];
        require(_exists[id], "unknown");
        // RETIRED ledgers open this to ANY caller (rev 11): the payout still
        // goes to d.owner below, so a permissionless sweep can only ever push
        // money home, never take it — see retire() for why that must not need
        // ten thousand owner signatures.
        require(d.owner == msg.sender || retired, "!owner");
        _creditRunner(d);
        uint256 amt = refundableOf(id);
        require(amt > 0, "amount=0");
        ownerEscrow6[id] -= amt;                             // <= by refundableOf's cap
        _earn[id].escrow6 -= uint96(amt);                    // cast safe: amt <= escrow6 (uint96)
        d.balance6 = 0;
        d.active = false;
        require(usdc.transfer(d.owner, amt), "USDC transfer failed");
        emit ActiveSet(id, false);
        emit Refunded(id, d.owner, amt);
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
        require(usdc.transferFrom(msg.sender, address(this), amount6), "USDC transfer failed");
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
        require(amount6 > 0 && amount6 <= b.amount6, "range");
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
            require(id != bytes32(0), "range");
            require(!_exists[id], "exists");
            // rate == 0 is ALLOWED. This used to refuse it, on the grounds that
            // "a rate==0 record would divide-by-zero in _burnLease (balance6 /
            // rate)". That was true when it was written and stopped being true
            // in rev 12, which added FREE SELF-HOSTING and taught _burnLease the
            // case outright (`secs = rate == 0 ? leaseSec : balance6 / rate`).
            //
            // Leaving the guard up made this contract refuse to import a state
            // it happily CREATES: a host willing to serve for nothing and a
            // deployer willing to pay nothing is a real arrangement, and 4 of
            // the 17 live records are exactly that. It made a rev-12 -> rev-13
            // migration impossible while any free deployment existed.
            //
            // Free is not the same as unprotected. What lets such a deployment
            // survive its host disappearing is its CAP — the rate it would pay
            // someone else — which _unleasedRate falls back to the moment no
            // one is serving it. A record with no cap AND no rate has chosen to
            // be free forever, and that is its owner's call to make.
            _exists[id] = true;
            // reserve the hostname label too, so a later create() cannot be
            // ground onto an IMPORTED record's prefix. Idempotent on purpose: a
            // pre-rule source may already contain a colliding pair, and history
            // migrates verbatim — refusing it here would strand a real record.
            _prefixTaken[bytes4(id)] = true;
            _ids.push(id);
            _deployments[id] = items[i];
            Deployment storage d = _deployments[id];
            d.runner = bytes32(0);
            d.runnerOperator = address(0);
            d.leaseUntil = 0;
            // A migrated record keeps its economics exactly: its own snapshot
            // becomes its ceiling, so it goes on paying what it paid and can
            // only fail over to an enclave priced at or under that. Owners
            // raise it (setMaxRate) to reach pricier hardware. importCaps
            // overrides this while the window is open.
            _maxRate6[id] = d.rate;
            emit MaxRateSet(id, d.rate);
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
        require(ids.length == recipients.length && ids.length == rates6.length, "range");
        for (uint256 i = 0; i < ids.length; i++) {
            require(_exists[ids[i]], "unknown");
            require(rates6[i] <= type(uint96).max, "range");
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
        require(ids.length == rates6.length, "range");
        for (uint256 i = 0; i < ids.length; i++) {
            require(_exists[ids[i]], "unknown");
            require(rates6[i] <= type(uint96).max, "range");
            _earn[ids[i]].rate6 = uint96(rates6[i]);
            emit RunnerRateSet(ids[i], rates6[i]);
        }
    }

    /// @notice Set migrated records' spend ceilings explicitly (rev-8 sources
    ///         carry real caps; from an older source importDeployments has
    ///         already defaulted each one to the rate it arrived with, and this
    ///         is how the owner widens or tightens that before sealing).
    /// @dev A cap of 0 means UNCAPPED — the pre-rev-8 behaviour, where any
    ///      registered enclave may claim at its own price. Deliberately
    ///      expressible for grandfathered records; create() never produces it.
    function importCaps(bytes32[] calldata ids, uint256[] calldata caps6) external {
        require(msg.sender == owner, "!owner");
        require(!importsSealed, "sealed");
        require(ids.length == caps6.length, "range");
        for (uint256 i = 0; i < ids.length; i++) {
            require(_exists[ids[i]], "unknown");
            require(caps6[i] <= type(uint96).max, "range");
            require(caps6[i] == 0 || caps6[i] > _fees[ids[i]].rate6, "maxRate <= fee");
            _maxRate6[ids[i]] = caps6[i];
            emit MaxRateSet(ids[i], caps6[i]);
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
    // admin (parameters; no custody, no access to balances, NO PRICING — that
    // belongs to the enclaves now: each one publishes its own per-machine price
    // in EnclaveRegistry and buyers bound it with their per-deployment cap)
    // ========================================================================

    /// @notice Cap the GPU share (1/1000ths of one card) any single NEW
    ///         deployment may buy. Enforced at create() only: existing records
    ///         and owner imports are untouched, and the catalog keeps listing
    ///         apps whose specs exceed it — publishable, not deployable until
    ///         the cap covers their minimum. 0 pauses GPU creates entirely
    ///         (CPU-only deployments are never affected).
    function setMaxGpuMilli(uint16 _maxGpuMilli) external {
        require(msg.sender == owner, "!owner");
        require(_maxGpuMilli <= 1000, "range");
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
        require(_maxFeePerSec6 <= type(uint96).max, "range");
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
        require(_runnerBps <= 10000, "range");
        runnerBps = _runnerBps;                    // affects FUTURE creates/resizes only
        emit RunnerBpsSet(_runnerBps);
    }

    /// @notice The optional claim bond (USDC 6dp; 0 = off, the deploy default)
    ///         and its exit timelock. Checked at claim() only — running leases
    ///         and their renew/release never re-check, so turning the bond on
    ///         strands nobody mid-lease.
    function setClaimBond(uint256 _bond6, uint64 _exitDelaySec) external {
        require(msg.sender == owner, "!owner");
        require(_exitDelaySec >= 1 hours && _exitDelaySec <= 30 days, "range");
        claimBond6 = _bond6;
        bondExitDelay = _exitDelaySec;
        emit ClaimBondSet(_bond6, _exitDelaySec);
    }

    /// @notice Bind the EnclaveProofOfTime that may advance proven-service
    ///         watermarks. ONE-SHOT: a non-zero binding can never be changed,
    ///         because a seller's proof of service must not be re-pointable at
    ///         a contract the platform swaps in later. Deploy order is prover-
    ///         after-ledger (the prover takes this address immutably), so this
    ///         is the single call that completes the pair.
    function setProver(address p) external {
        require(msg.sender == owner, "!owner");
        require(prover == address(0), "sealed");   // reuses an existing literal: this
        prover = p;                                // contract is byte-bound (see the header)
        emit ProverSet(p);
    }

    /// @notice Move the proven-time cutover (0 = never require proofs). See
    ///         proofRequiredFrom: this is both the rollout date and the kill
    ///         switch if honest hosts start losing income to a proving bug.
    function setProofRequiredFrom(uint64 at) external {
        require(msg.sender == owner, "!owner");
        proofRequiredFrom = at;
        emit ProofRequiredFromSet(at);
    }

    function setLeaseSec(uint64 _leaseSec) external {
        require(msg.sender == owner, "!owner");
        require(_leaseSec >= 60 && _leaseSec <= 1 days, "range");
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
    /// @notice END-OF-LIFE (rev 11, ONE-WAY): closes every activity gate —
    ///         claim, renew, and all funding go through _requireActive, which
    ///         refuses a retired ledger — and opens refund() to ANY caller,
    ///         still always paying each record's OWNER. This is the migration
    ///         answer to stranded funds: a successor ledger takes the fleet,
    ///         this one is retired, and one permissionless sweep pushes every
    ///         record's held escrow back to the wallet that funded it — no
    ///         owner signatures needed, so real users' money can never be
    ///         trapped by a redeploy again.
    /// @dev The power this grants is deliberately NOTHING until the end: while
    ///      un-retired the platform still cannot stop, drain or refund anyone's
    ///      record, and retiring is exactly what repointing the fleet already
    ///      does de facto (no runner will claim here again) — made honest,
    ///      observable on-chain, and paired with the money going home. Live
    ///      leases keep their reserve through the sweep (_creditRunner runs
    ///      first, exactly as in an owner refund), so retiring mid-lease can
    ///      never strand a seller either; sweep again after the last lease
    ///      lapses to collect the tails. There is no un-retire: a successor
    ///      exists, and flip-flopping an ended ledger back into claimability
    ///      would let it race its own replacement. Deliberately NO event: the
    ///      public flag is the durable record and this tx is the timeline
    ///      marker — an event is ~36 bytes this contract does not have.
    function retire() external {
        require(msg.sender == owner, "!owner");
        retired = true;
    }

    function setOwner(address o) external {
        require(msg.sender == owner, "!owner");
        require(o != address(0), "zero addr");
        pendingOwner = o;
        emit OwnershipTransferStarted(owner, o);
    }

    /// @notice Complete the handoff. Only the pending owner may finalize.
    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "!owner");
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

    /// @notice True iff an enclave may claim right now (active + funded + no
    ///         live lease). Funded is judged against the record's CURRENT rate:
    ///         the price of its last lease, or — while no enclave is serving it
    ///         — its cap, i.e. the worst case. A cheaper enclave can therefore
    ///         afford work this reads as unfundable; claimableBy(id, enclaveId)
    ///         answers that exactly, and claim() itself is the authority.
    function claimable(bytes32 id) public view returns (bool) {
        return _open(id) && _deployments[id].balance6 >= _deployments[id].rate;
    }

    /// @dev The half of claimable() that is not about money: a live record,
    ///      switched on, with no lease running. Shared with claimableBy, which
    ///      applies the funded test at the asking enclave's price instead.
    function _open(bytes32 id) private view returns (bool) {
        Deployment storage d = _deployments[id];
        return _exists[id] && d.active && block.timestamp > d.leaseUntil;
    }

    /// @notice Funded runtime left OUTSIDE the current lease (what future claims
    ///         can buy) at the record's current rate — the floor of what an
    ///         unleased deployment gets, since its rate is its ceiling until a
    ///         host prices it.
    function secondsFundable(bytes32 id) external view returns (uint256) {
        Deployment storage d = _deployments[id];
        return d.rate == 0 ? 0 : d.balance6 / d.rate;
    }

    /// @notice The owner's per-second spend ceiling (USDC 6dp). Every purchase
    ///         of time — claim, renew, setShares — is checked against it, so it
    ///         is also the answer to "which enclaves may pick this up if its
    ///         host dies". 0 = uncapped (only reachable for records imported
    ///         from a pre-rev-8 ledger).
    function capOf(bytes32 id) external view returns (uint256 maxRate6) {
        return _maxRate6[id];
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
        // deliberately the admin gate's string: a unique one here costs ~46
        // bytes of the EIP-170 headroom this contract does not have
        require(d.owner == msg.sender, "!owner");
    }
    function _requireActive(bytes32 id) private view returns (Deployment storage d) {
        d = _deployments[id];
        require(!retired, "retired");   // end-of-life: no claims, renewals or funding (see retire())
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
  - auctions: rev 8 gives each enclave a posted price and each deployment a
    ceiling, so the queue clears at whatever fits — but it is first-come, not a
    bid. A real auction (the lease going to the CHEAPEST attested enclave that
    wants it, rather than the first one to send the tx) needs a commit window
    on top of this, and buys little until the fleet is deep.
  - consumed-time attestation: runners could periodically post signed usage
    checkpoints, shrinking the "dead runner burns one lease" loss toward zero —
    and letting the runner meter pay for VERIFIED service instead of held time.
  - ETH-funded runner escrow: fundEth forwards everything (no on-chain USDC
    conversion); the runner share of ETH fundings relies on fundEscrow re-backing.
    Rev 10 gives this a second consequence: an ETH-funded deployment escrows
    nothing, so it has nothing to refund either — cancelling one returns zero
    until fundEscrow has re-backed it.
  - FULL refunds: rev 10 returns the runner escrow, which is all this contract
    holds. The platform's own share of unspent time is unrecoverable because it
    forwards at funding time. Escrowing it instead — and forwarding it as it is
    EARNED, the way the runner's share already works — would make a cancellation
    whole, at the cost of making the contract custodial for the platform slice.
    That is a deliberate trade against the non-custodial property in the header,
    not an oversight; the publisher's cut cannot follow either way, since it is
    another party's money in another party's wallet.
*/
