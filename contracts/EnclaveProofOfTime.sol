// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title EnclaveProofOfTime — proof that a host actually ran the app it is billing for.
/// @notice EnclaveDeployments pays a runner out of chain-held escrow as lease
///         time elapses. Through rev 8 that meter ran on HELD time: an enclave
///         that claimed a lease and then stopped serving — crashed app, wedged
///         box, or simple dishonesty — was paid to the end of its lease
///         quantum anyway, because nothing on-chain could tell the difference
///         between serving and silence. This contract is that difference.
///
///         Every proofWindowSec, a serving enclave signs a CHECKPOINT: "this
///         deployment was running here through time T". The signature comes
///         from a secp256k1 key MINTED INSIDE ITS CVM (EnclaveRegistry schema 3
///         publishes the address half; the operator running the host OS never
///         holds the private half, so it cannot sign for an app it has
///         stopped). Accepted checkpoints advance the deployment's
///         `provenUntil` watermark in the ledger, and the ledger's runner meter
///         credits min(now, leaseUntil, provenUntil). Unproven time inside a
///         paid lease earns nobody anything.
///
/// WHY IT IS A PROOF OF *TIME*, and not merely a claim about time. Each
///         checkpoint commits to the hash of a RECENT BLOCK, and that one
///         binding does three jobs:
///           1. the hash did not exist before that block was mined, so a
///              signature carrying it cannot have been pre-computed for a shift
///              the host had not yet worked. No signing a month of uptime up
///              front and walking away.
///           2. blockhash() only reaches back 256 blocks (~8.5 min on Base), so
///              a signature stops being redeemable shortly after it is made. No
///              hoarding proofs and cashing them in after the box is dead —
///              which is what bounds theft-by-dying to that window, against the
///              30 minutes a rev-8 ledger paid for the same silence.
///           3. the anchor is unpredictable. This is the property Storj buys
///              with randomly-timed audits from a satellite; here it falls out
///              of the chain itself, with nobody to trust for the randomness.
///         And a checkpoint may advance the watermark by at most proofWindowSec
///         AND at most the time that has actually elapsed since the last
///         accepted proof, so an hour of pay costs an hour of separately
///         anchored proofs. Time cannot be compressed into one transaction.
///
///         That second clamp is load-bearing and was missing until 2026-07-29.
///         The window alone bounds nothing: `base` is re-read from the ledger on
///         every call and creditProven writes it in the same call, so N
///         checkpoints in ONE transaction ratcheted N windows — and because the
///         digest commits to no watermark, one signature replayed N times did
///         it. Twelve copies of a single signature against a single anchor
///         bought 10,200 seconds of pay for zero service. Charging every advance
///         against the wall clock is what restores the property the paragraph
///         above claims.
///
/// PARTIAL PERIODS are the point, not an edge case. Because the watermark and
///         the meter are both per-second, a host is paid for exactly the
///         fraction of the period it served. A runner tearing down mid-hour —
///         the app crashed, the owner stopped it, the box is being drained —
///         posts a final checkpoint and THEN releases the lease, so the last
///         partial hour settles at teardown instead of being lost. That order is
///         load-bearing: release clears the watermark, so a proof sent after it
///         has no lease left to prove against. Skipping the final proof
///         entirely is legal and costs the runner the unproven tail, so the
///         incentive points at settling honestly either way.
///
/// Trust model, stated plainly:
///   - This contract is bound into EnclaveDeployments ONCE and then frozen
///     (setProver refuses to overwrite), so a seller's proof of service can
///     never be re-pointed at something the platform swaps in later.
///   - It is STATELESS with respect to money. It holds no funds, and the one
///     thing it can do to the ledger is advance a watermark. The ledger
///     re-applies every clamp that touches money — never past now, never past
///     leaseUntil, strictly monotonic, never beyond the escrow held — so the
///     worst a bug here can do is degrade the ledger to rev-8 held-time
///     metering. It can never overpay beyond what rev 8 already would.
///   - Checkpoints are PERMISSIONLESS to post: the signature is the authority,
///     not msg.sender. A relay, a watcher, or the tenant can carry a proof for
///     a host that is short of gas, and nobody can post one the enclave did
///     not sign.
///   - The one lie no contract here can catch is an operator registering a
///     proofKey whose private half is NOT in its CVM. That is also the one
///     lie ANYBODY can catch: the enclave serves its live proof key over its
///     attested origin (/v1/attestation), so a watcher compares the two and
///     has public evidence if they differ. The ledger's claim bond exists to
///     be slashed against exactly that evidence.

/// @dev Field order MUST match EnclaveDeployments.Deployment exactly (schema
///      rev 2..9 share this shape byte-for-byte).
interface IEnclaveDeployments {
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
    function provenUntil(bytes32 id) external view returns (uint64);
    function leaseSec() external view returns (uint64);
    function proofRequired() external view returns (bool);
    /// The single write this contract is allowed. Prover-gated there.
    function creditProven(bytes32 id, uint64 upto) external;
}

/// @dev registrySchema 3. Field order MUST match EnclaveRegistry.Enclave.
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
    }
    function get(bytes32 id) external view returns (Enclave memory);
}

contract EnclaveProofOfTime {
    /// @dev Struct-shape/feature revision, sniffed by consumers the way
    ///      deploymentsSchema and registrySchema are. Rev 1 clamped a
    ///      checkpoint by proofWindowSec ALONE, which bounded nothing (see the
    ///      header): rev 2 additionally charges every advance against elapsed
    ///      wall-clock time. The signed digest is UNCHANGED between the two, so
    ///      a supervisor needs no release to work with either — but only a rev-2
    ///      prover actually makes proven time cost time.
    uint256 public constant proofSchema = 2;

    IEnclaveDeployments public immutable deployments;
    IEnclaveRegistry    public immutable registry;

    address public owner;
    address public pendingOwner;

    /// @notice The most time ONE checkpoint may prove. This is the parameter
    ///         that makes proof of time cost time: a host wanting to be paid
    ///         for an hour must land at least 3600/proofWindowSec checkpoints
    ///         across that hour, each anchored to a different unpredictable
    ///         block. Raising it weakens the proof (longer stretches become
    ///         provable after the fact); lowering it raises the runner's gas
    ///         bill. 15 minutes against the ledger's 30-minute lease quantum
    ///         means a host proving on the usual 5–10 minute cadence can lose a
    ///         checkpoint to an RPC hiccup and still recover the whole gap on
    ///         the next one.
    uint64 public proofWindowSec = 900;

    /// @notice Per-deployment proof record. Purely observational — the money
    ///         lives in the ledger's watermark — but it is the honest answer to
    ///         "has this app actually been up?", and it is the only uptime
    ///         number in the system that no host can self-report.
    ///
    ///           lastProofAt  when the newest accepted checkpoint landed. A
    ///                        watcher reads this to spot a host that stopped
    ///                        proving: that is the on-chain shape of "stopped
    ///                        serving".
    ///           provenSec    lifetime proven seconds on this deployment,
    ///                        across every runner that ever served it.
    ///           proofs       lifetime accepted checkpoints. provenSec / proofs
    ///                        shows whether a host proves steadily or in
    ///                        suspicious bursts.
    struct Record { uint64 lastProofAt; uint64 provenSec; uint32 proofs; }
    mapping(bytes32 => Record) public recordOf;

    /// @notice Lifetime PROVEN hosting seconds per operator — the network's
    ///         "this box really did the work" counter. Buyers and host reviews
    ///         rank sellers by it, and it can only be grown by landing
    ///         block-anchored checkpoints in real time.
    mapping(address => uint64) public hostedSec;

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    /// @dev Every field is load-bearing. `id` stops a checkpoint for a cheap
    ///      deployment being replayed onto an expensive one; `enclaveId` and
    ///      `operator` bind it to the lease it was signed for, so a proof
    ///      cannot survive a failover to a different box; `upto` is the claim
    ///      itself; and the anchor pair is what dates the signature.
    bytes32 private constant PROOF_TYPEHASH = keccak256(
        "ProofOfTime(bytes32 id,bytes32 enclaveId,address operator,uint64 upto,uint64 anchorBlock,bytes32 anchorHash)"
    );

    event Checkpointed(bytes32 indexed id, bytes32 indexed enclaveId, address indexed operator,
                       uint64 provenUntil, uint64 secondsProven, uint64 anchorBlock);
    event CheckpointRejected(bytes32 indexed id, string reason);
    event ProofWindowSet(uint64 proofWindowSec);
    event OwnerChanged(address indexed owner);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);

    constructor(address _deployments, address _registry) {
        require(_deployments != address(0) && _registry != address(0), "zero addr");
        owner = msg.sender;
        deployments = IEnclaveDeployments(_deployments);
        registry = IEnclaveRegistry(_registry);
        emit OwnerChanged(msg.sender);
        emit ProofWindowSet(proofWindowSec);
    }

    // ========================================================================
    // the proof
    // ========================================================================

    /// @notice EIP-712 domain of a proof-of-time checkpoint. Computed live
    ///         rather than cached at construction, so a chain fork cannot
    ///         inherit a separator that lets proofs replay across both halves.
    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256("EnclaveProofOfTime"),
                                    keccak256("1"), block.chainid, address(this)));
    }

    /// @notice The exact digest an enclave signs for one checkpoint. Exposed so
    ///         a runner — or an auditor reconstructing what a host claimed —
    ///         can build and verify a proof with no ABI guesswork.
    function proofDigest(bytes32 id, bytes32 enclaveId, address operator,
                         uint64 upto, uint64 anchorBlock, bytes32 anchorHash)
        public view returns (bytes32)
    {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(),
            keccak256(abi.encode(PROOF_TYPEHASH, id, enclaveId, operator, upto, anchorBlock, anchorHash))));
    }

    /// @notice Post a proof that a deployment was being served, advance its
    ///         watermark in the ledger, and settle what that just unlocked.
    ///
    /// @param upto the instant through which service is claimed. Clamped, never
    ///        trusted: to now, to the lease this was signed under, and to one
    ///        proofWindowSec past what was already proven.
    /// @param anchorBlock a block within the last 256, whose hash the signature
    ///        commits to. This is the freshness gate — see the header.
    /// @param anchorHash blockhash(anchorBlock), as seen when signing.
    /// @param sig 65-byte secp256k1 signature over proofDigest(...) by the
    ///        serving enclave's registered in-CVM proof key.
    ///
    /// @dev Reverts rather than no-ops on a stale replay ("nothing to prove"),
    ///      so a runner's proving loop can tell the difference between "already
    ///      counted" and "landed". checkpointMany below is the forgiving
    ///      version for batching.
    function checkpoint(
        bytes32 id,
        bytes32 enclaveId,
        uint64  upto,
        uint64  anchorBlock,
        bytes32 anchorHash,
        bytes calldata sig
    ) public {
        // WHEN — a real, recent block. blockhash returns 0 for the current
        // block, any future block, and anything over 256 blocks back, so this
        // one comparison is both the "did not pre-sign" and the "cannot hoard"
        // gate. Checked first: it is the cheapest reject.
        require(anchorHash != bytes32(0) && blockhash(anchorBlock) == anchorHash, "stale or unknown anchor");

        IEnclaveDeployments.Deployment memory d = deployments.get(id);
        require(enclaveId != bytes32(0) && d.runner == enclaveId, "not the runner");

        // WHO — the in-CVM key the serving enclave published. The operator
        // holding the host OS does not have it, which is the whole point.
        address proofKey = registry.get(enclaveId).proofKey;
        require(proofKey != address(0), "enclave has no proof key");
        require(_recover(proofDigest(id, enclaveId, d.runnerOperator, upto, anchorBlock, anchorHash), sig) == proofKey,
                "bad proof signature");

        // HOW MUCH — never past now, never past the lease this was signed
        // under, and never more than one window past what was already proven.
        // The ledger re-applies the first two on the money; the window is this
        // contract's own rule, and the one that makes time incompressible.
        uint64 ceiling = uint64(block.timestamp);
        if (ceiling > d.leaseUntil) ceiling = d.leaseUntil;
        if (upto > ceiling) upto = ceiling;
        uint64 base = deployments.provenUntil(id);
        if (base == 0) {
            // Defence in depth, not a live path: the ledger seeds the watermark
            // at claim and clears it at release, and imported records arrive
            // unleased. If some future path ever presents a live lease with no
            // watermark, its first checkpoint gets exactly one window like
            // every other — never a base of 0 to prove back from 1970.
            base = ceiling > proofWindowSec ? ceiling - proofWindowSec : 0;
        }
        Record storage r = recordOf[id];
        // ... and never more than has actually ELAPSED since the last accepted
        // proof. Without this the window is not a limit at all: `base` is re-read
        // from the ledger on every call and creditProven writes it immediately,
        // so N checkpoints inside ONE transaction ratchet N windows — and since
        // the digest commits to no watermark, the SAME signature serves for all
        // N. Twelve copies of one signature, one anchor, one block bought 10,200
        // seconds of pay for zero service. Charging the advance against real time
        // is what actually makes an hour of pay cost an hour: a second proof in
        // the same block has a budget of zero and is refused "nothing to prove",
        // so the watermark can only ever walk forward as fast as the clock does.
        // A host that lost proofs to an RPC stall still recovers a whole window
        // on its next one, which is the tolerance the cadence was chosen for.
        uint64 elapsed = uint64(block.timestamp) > r.lastProofAt
            ? uint64(block.timestamp) - r.lastProofAt : 0;
        uint64 advance = elapsed < proofWindowSec ? elapsed : proofWindowSec;
        if (upto > base + advance) upto = base + advance;
        require(upto > base, "nothing to prove");

        deployments.creditProven(id, upto);   // the ledger re-clamps, then pays

        uint64 proven = upto - base;
        r.lastProofAt = uint64(block.timestamp);
        r.provenSec  += proven;
        r.proofs     += 1;
        hostedSec[d.runnerOperator] += proven;
        emit Checkpointed(id, enclaveId, d.runnerOperator, upto, proven, anchorBlock);
    }

    /// @dev One proof, as a batch element. A struct rather than six parallel
    ///      arrays: a supervisor building these per deployment cannot silently
    ///      misalign a signature against another deployment's id, and six
    ///      calldata arrays overflow legacy codegen's stack anyway.
    struct Checkpoint {
        bytes32 id;
        bytes32 enclaveId;
        uint64  upto;
        uint64  anchorBlock;
        bytes32 anchorHash;
        bytes   sig;
    }

    /// @notice Prove several deployments in one transaction, TOLERANTLY: one
    ///         that cannot land does not take the others down.
    /// @return landed which elements counted, positionally.
    /// @dev A supervisor proves every deployment it serves on one clock, and
    ///      those deployments fail independently — a lease that lapsed seconds
    ///      ago, a record another enclave just claimed, a stale anchor after an
    ///      RPC stall. Atomic batching would let any one of those cost the host
    ///      its income on all the rest, and it is the honest hosts — the ones
    ///      with many live tenants — who would lose the most. So each proof is
    ///      tried in its own external call and its failure is LOGGED, not
    ///      raised: CheckpointRejected carries the reason, so a seller can see
    ///      why a proof was refused instead of watching a whole batch revert
    ///      with one message.
    function checkpointMany(Checkpoint[] calldata cps) external returns (bool[] memory landed) {
        landed = new bool[](cps.length);
        for (uint256 i = 0; i < cps.length; i++) {
            Checkpoint calldata c = cps[i];
            try this.checkpoint(c.id, c.enclaveId, c.upto, c.anchorBlock, c.anchorHash, c.sig) {
                landed[i] = true;
            } catch Error(string memory reason) {
                emit CheckpointRejected(c.id, reason);
            } catch {
                emit CheckpointRejected(c.id, "reverted");
            }
        }
    }

    /// @dev 65-byte ECDSA recovery with the standard malleability guard (an
    ///      accepted high-s twin would be a second valid encoding of a proof
    ///      already posted — harmless, since a replay is rejected anyway, but
    ///      there is no reason to accept two spellings of one signature).
    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        require(sig.length == 65, "bad signature length");
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;                     // some signers emit 0/1
        require(v == 27 || v == 28, "bad signature v");
        require(uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0,
                "bad signature s");
        address a = ecrecover(digest, v, r, s);
        require(a != address(0), "bad signature");
        return a;
    }

    // ========================================================================
    // reads (watchers, clients, the seller's own dashboard)
    // ========================================================================

    /// @notice Seconds of the CURRENT lease that are held but not proven — the
    ///         live gap between what the tenant is paying for and what the
    ///         runner has shown it delivered. 0 on a healthy deployment (it
    ///         grows for at most one proof interval before the next checkpoint
    ///         clears it). A sustained non-zero value is a host that stopped
    ///         serving, and is exactly the evidence the ledger's claim bond
    ///         exists to be slashed against.
    function unprovenSec(bytes32 id) public view returns (uint64) {
        IEnclaveDeployments.Deployment memory d = deployments.get(id);
        if (d.runner == bytes32(0)) return 0;
        uint64 upto = uint64(block.timestamp);
        if (upto > d.leaseUntil) upto = d.leaseUntil;
        uint64 proven = deployments.provenUntil(id);
        return upto > proven ? upto - proven : 0;
    }

    /// @notice Everything a client needs to render "is this host doing its job"
    ///         in one call: the ledger's watermark, this contract's record, and
    ///         the live shortfall.
    function coverageOf(bytes32 id) external view returns (
        uint64 provenUntil_, uint64 lastProofAt, uint64 provenSec, uint32 proofs,
        uint64 unproven, bool required
    ) {
        Record storage r = recordOf[id];
        return (deployments.provenUntil(id), r.lastProofAt, r.provenSec, r.proofs,
                unprovenSec(id), deployments.proofRequired());
    }

    // ========================================================================
    // admin (one parameter; no custody, no access to any balance)
    // ========================================================================

    /// @notice Set how much time one checkpoint may prove.
    /// @dev Bounded to [60s, the ledger's leaseSec): below a minute the gas cost
    ///      of proving outruns a small deployment's earnings, and a window as
    ///      long as the lease would let a single checkpoint prove a whole
    ///      quantum — which is not a proof of time at all.
    function setProofWindow(uint64 _proofWindowSec) external {
        require(msg.sender == owner, "!owner");
        require(_proofWindowSec >= 60 && _proofWindowSec < deployments.leaseSec(), "window range");
        proofWindowSec = _proofWindowSec;
        emit ProofWindowSet(_proofWindowSec);
    }

    /// @notice Begin a two-step ownership handoff (the new owner must accept).
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

/*
FUTURE (deliberately not in this rev):
  - proof of SERVICE, not just presence: a checkpoint says the ENCLAVE believed
    the app was running. Binding a client-signed receipt (the tenant's own
    traffic — Storj's uplink orders) or an independent prober's signature into
    the same digest would make the proof adversarial rather than self-reported
    from inside an attested boundary.
  - trustless slashing: the ledger ships the bond (claim gate + timelocked
    exit) but slashing is an owner action with public evidence. This contract
    now GENERATES that evidence on-chain — unprovenSec, and a lastProofAt that
    stopped moving — so what remains is a challenge game that lets a watcher
    slash against it without the owner's judgment.
  - refunding unproven time to the TENANT: PARTLY ADDRESSED by the ledger's
    rev-10 refund(). Escrow a runner never proved against is escrow no lease can
    still claim, so once the lease is closed out (released, or settled after it
    lapsed) the owner can take it back with the rest of their unused runtime.
    What is still open is the automatic case — crediting it back to balance6 as
    the silence happens, so a deployment that outlives a dead host keeps its
    runtime instead of needing the owner to cancel and re-fund. That still needs
    a decision about who owns the gap when a host is down but the app is still
    reachable through a cached route.
  - a proof key inside the quote: on metal the SNP report_data has 32 free bytes
    (metal/guest/agent.mjs radWithReportData), so the proof key could be bound
    into the hardware quote itself rather than served over the attested origin.
    On the Tinfoil fleet that needs a shim change — report_data there is already
    spent on the TLS key.
*/
