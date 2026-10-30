// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

/// Lifecycle proof-of-service candidate. Not deployed.
/// Keeps proof schema 2, signatures, elapsed-time accounting, funded-horizon
/// clamping and two-step administrator control. The proof window is independent
/// of scheduling: no reservation, renewal or heartbeat transaction is added.
/// The deployer supplies the initial window and an immutable exclusive maximum;
/// migration must read and preserve the source prover's current window and the
/// source ledger's former upper bound. Both are explicit constructor inputs.
/// Self-hosted zero-rate runs do not need paid-service checkpoints.
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
    function lifecycleSchema() external view returns (uint256);
    function deploymentsSchema() external view returns (uint256);
    function registry() external view returns (address);
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
    ///         bill. The explicit constructor maximum bounds this tradeoff; it
    ///         does not determine how long an assignment may run.
    uint64 public proofWindowSec;
    uint64 public immutable maxProofWindowSec;
    uint256 public constant lifecycleProofSchema = 1;

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

    constructor(address _deployments, address _registry, uint64 initialWindowSec, uint64 maximumWindowSec) {
        require(_deployments.code.length != 0 && _registry.code.length != 0, "authority code missing");
        IEnclaveDeployments ledger = IEnclaveDeployments(_deployments);
        require(ledger.lifecycleSchema() == 2 && ledger.deploymentsSchema() == 17, "not lifecycle ledger");
        require(ledger.registry() == _registry, "registry differs");
        // Preserve the old permitted upper-bound range without treating it as
        // a lease length. No call to the removed leaseSec selector is made.
        require(maximumWindowSec > 60 && maximumWindowSec <= 1 days, "maximum window range");
        require(initialWindowSec >= 60 && initialWindowSec < maximumWindowSec, "window range");
        owner = msg.sender;
        deployments = ledger;
        registry = IEnclaveRegistry(_registry);
        maxProofWindowSec = maximumWindowSec;
        proofWindowSec = initialWindowSec;
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

    /// @notice Set the paid-service checkpoint window, independently of runtime.
    /// @dev Owner-only, bounded by the explicit immutable constructor maximum.
    /// This parameter never creates a reservation or extends a funded horizon.
    function setProofWindow(uint64 _proofWindowSec) external {
        require(msg.sender == owner, "!owner");
        require(_proofWindowSec >= 60 && _proofWindowSec < maxProofWindowSec, "window range");
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

