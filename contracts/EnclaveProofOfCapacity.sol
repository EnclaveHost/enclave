// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title EnclaveProofOfCapacity - a host is paid for time it proves, while other hosts vouch for its capacity and it
///        has done the same for them.
/// @notice A PROVER for EnclaveDeployments, in the place EnclaveProofOfTime holds today (the ledger's `prover`: the
///         one caller of creditProven). The proof of time is that contract's, unchanged: a checkpoint signed by the
///         host's in-enclave proof key, anchored to a recent block, advancing at most one window and at most the time
///         that actually passed. What this contract adds is a second condition on every checkpoint: the host must be
///         IN STANDING for the current epoch.
///
///         STANDING, for a host H in epoch E, looks at the epoch before (P = E - 1):
///           1. DUTY. Every host H was assigned to check in P has a report from H on chain: pass, fail or unreachable.
///              A host that did not check the others is not paid in E.
///           2. CAPACITY. Of the hosts assigned to check H in P: two or more fails and H is not paid in E, whatever
///              else. No fail and at least one pass and H is in standing. Anything in between (nobody reported, one
///              fail, only "unreachable") and H needs its own proof of capacity for E as well.
///           3. A host that was not credited in the epoch before P (the first host of a network, a new host, one that
///              was away) has nobody assigned to it and no duty: its own proof of capacity for E is its standing.
///         So a lone host proves capacity for itself, two hosts check each other, and from there every host is checked
///         by min(checkersPerHost, n - 1) others.
///
///         WHO CHECKS WHOM is nobody's choice. The ROSTER of an epoch is the hosts this contract credited in the epoch
///         before, in the order their first checkpoint landed. The epoch's SEED is taken from the previous block's hash
///         by the first transaction of the epoch. The checkers of the host at position p are the hosts at positions
///         p + o_1 .. p + o_k (mod n), the offsets o_j drawn from the seed, distinct and never 0. The same offsets read
///         backwards give a checker its targets, so both directions cost k reads, whatever the size of the network.
///         A host leaves the roster by not being credited: a dead host is gone after one epoch with no transaction
///         from anyone, and nothing here can remove a live one.
///
///         A REPORT is `CapacityReport(epoch, checker, target, verdict, seed, evidence)` signed by the CHECKER's proof
///         key, the same in-enclave key that signs its proofs of time: the operator of the checking host cannot sign a
///         verdict its enclave did not reach. `evidence` is the digest of the off-chain record of the check (what was
///         run, what came back); this contract does not judge it. Anyone may carry a report or a checkpoint to the
///         chain: the signature is the authority, not msg.sender. A report is accepted during its epoch and for
///         `reportGraceSec` after it, once per (epoch, checker, target).
///
/// What this does NOT do, stated plainly:
///   - It does not judge a check. A pass is the checker's enclave saying so. Collusion between hosts that are assigned
///     to each other is not detected; the assignment being unpredictable and several checkers being needed is what
///     bounds it, and with fewer hosts than that it is not bounded (two hosts of one owner pass each other, which is
///     no weaker than the self-proof a lone host is allowed).
///   - A self-proof is the host's own enclave vouching for itself: as strong as that host's attestation, no stronger.
///   - The seed is the previous block's hash as seen by the epoch's first transaction: a block producer, or whoever
///     sends that transaction, can choose among a few blocks. On Base that is the sequencer.
///   - It moves no money and cannot pay whoever carries a transaction: the ledger credits the runner's operator only.
///   - It cannot be bound into the ledger deployed today, whose prover is set once and for all. It takes a new ledger.
///   - There is no owner and no parameter that can be changed after deployment.

/// @dev Field order MUST match EnclaveDeployments.Deployment exactly.
interface IEnclaveDeploymentsP {
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
    function proofRequired() external view returns (bool);
    function creditProven(bytes32 id, uint64 upto) external;
}

/// @dev Field order MUST match EnclaveRegistry.Enclave.
interface IEnclaveRegistryP {
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

contract EnclaveProofOfCapacity {
    uint256 public constant proofSchema = 3;

    uint8 public constant VERDICT_PASS = 1;
    uint8 public constant VERDICT_FAIL = 2;
    uint8 public constant VERDICT_UNREACHABLE = 3;
    /// Fails from this many assigned checkers end a host's standing for the next epoch. One checker alone cannot.
    uint8 public constant failQuorum = 2;

    IEnclaveDeploymentsP public immutable deployments;
    IEnclaveRegistryP    public immutable registry;
    uint64 public immutable proofWindowSec;
    uint64 public immutable epochSec;
    uint64 public immutable reportGraceSec;
    uint8  public immutable checkersPerHost;

    struct Record { uint64 lastProofAt; uint64 provenSec; uint32 proofs; }
    mapping(bytes32 => Record) public recordOf;
    mapping(address => uint64) public hostedSec;

    /// The seed of an epoch, fixed by its first transaction here. 0: no transaction in that epoch yet.
    mapping(uint64 => bytes32) public seedOf;
    /// roster[E]: the hosts credited during epoch E - 1, in the order of their first checkpoint. Frozen once E begins.
    mapping(uint64 => bytes32[]) private _roster;
    /// 1-based position in roster[E]; 0: not in it.
    mapping(uint64 => mapping(bytes32 => uint32)) public rosterPos;
    /// verdictOf[epoch][checker][target]
    mapping(uint64 => mapping(bytes32 => mapping(bytes32 => uint8))) public verdictOf;
    /// selfProved[epoch][host]
    mapping(uint64 => mapping(bytes32 => bool)) public selfProved;
    /// epoch + 1 of the last epoch a host was found in standing (0: never). Saves the reads on later checkpoints.
    mapping(bytes32 => uint64) private _standingSeen;

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant PROOF_TYPEHASH = keccak256(
        "ProofOfTime(bytes32 id,bytes32 enclaveId,address operator,uint64 upto,uint64 anchorBlock,bytes32 anchorHash)");
    bytes32 private constant REPORT_TYPEHASH = keccak256(
        "CapacityReport(uint64 epoch,bytes32 checker,bytes32 target,uint8 verdict,bytes32 seed,bytes32 evidence)");
    bytes32 private constant SELF_TYPEHASH = keccak256(
        "CapacitySelf(uint64 epoch,bytes32 host,bytes32 seed,bytes32 evidence)");

    event Checkpointed(bytes32 indexed id, bytes32 indexed enclaveId, address indexed operator,
                       uint64 provenUntil, uint64 secondsProven, uint64 anchorBlock);
    event CheckpointRejected(bytes32 indexed id, string reason);
    event EpochSeeded(uint64 indexed epoch, bytes32 seed, uint256 rosterSize);
    event Rostered(uint64 indexed epoch, bytes32 indexed host, uint32 position);
    event CapacityReported(uint64 indexed epoch, bytes32 indexed checker, bytes32 indexed target, uint8 verdict, bytes32 evidence);
    event CapacitySelfProved(uint64 indexed epoch, bytes32 indexed host, bytes32 evidence);

    constructor(address _deployments, address _registry, uint64 _proofWindowSec, uint64 _epochSec,
                uint64 _reportGraceSec, uint8 _checkersPerHost) {
        require(_deployments != address(0) && _registry != address(0), "zero addr");
        require(_proofWindowSec >= 60 && _epochSec >= 2 * _proofWindowSec, "epoch range");
        require(_reportGraceSec < _epochSec && _checkersPerHost >= 1 && _checkersPerHost <= 8, "policy range");
        deployments = IEnclaveDeploymentsP(_deployments);
        registry = IEnclaveRegistryP(_registry);
        proofWindowSec = _proofWindowSec;
        epochSec = _epochSec;
        reportGraceSec = _reportGraceSec;
        checkersPerHost = _checkersPerHost;
    }

    // ========================================================================
    // epochs, rosters and who checks whom
    // ========================================================================

    function epochNow() public view returns (uint64) { return uint64(block.timestamp) / epochSec; }

    function rosterOf(uint64 epoch) external view returns (bytes32[] memory) { return _roster[epoch]; }
    function rosterSize(uint64 epoch) external view returns (uint256) { return _roster[epoch].length; }

    /// Fix the current epoch's seed if no transaction has yet. Anyone may call it; every write here does.
    function touch() public returns (bytes32 seed) {
        uint64 e = epochNow();
        seed = seedOf[e];
        if (seed == bytes32(0)) {
            seed = keccak256(abi.encode(blockhash(block.number - 1), e, address(this)));
            seedOf[e] = seed;
            emit EpochSeeded(e, seed, _roster[e].length);
        }
    }

    /// How many hosts check each host in an epoch: checkersPerHost, or every other host of a smaller roster.
    function checkersIn(uint64 epoch) public view returns (uint256) {
        uint256 n = _roster[epoch].length;
        if (n < 2) return 0;
        return n - 1 < checkersPerHost ? n - 1 : checkersPerHost;
    }

    /// The offsets of an epoch: distinct, each in 1..n-1. Empty before the epoch is seeded or with fewer than 2 hosts.
    function offsetsOf(uint64 epoch) public view returns (uint32[] memory o) {
        uint256 n = _roster[epoch].length;
        uint256 k = checkersIn(epoch);
        bytes32 seed = seedOf[epoch];
        if (k == 0 || seed == bytes32(0)) return new uint32[](0);
        o = new uint32[](k);
        for (uint256 j = 0; j < k; j++) {
            uint32 c = uint32(1 + uint256(keccak256(abi.encode(seed, j))) % (n - 1));
            for (uint256 tries = 0; tries < n; tries++) {
                bool used = false;
                for (uint256 i = 0; i < j; i++) if (o[i] == c) { used = true; break; }
                if (!used) break;
                c = c % uint32(n - 1) + 1;          // the next of 1..n-1; k <= n-1, so one is free
            }
            o[j] = c;
        }
    }

    /// The hosts assigned to check `target` in `epoch` (empty: not on the roster, or nobody to check it).
    function checkersOf(uint64 epoch, bytes32 target) public view returns (bytes32[] memory out) {
        return _neighbours(epoch, target, true);
    }

    /// The hosts `checker` is assigned to check in `epoch`.
    function targetsOf(uint64 epoch, bytes32 checker) public view returns (bytes32[] memory out) {
        return _neighbours(epoch, checker, false);
    }

    function _neighbours(uint64 epoch, bytes32 host, bool forward) private view returns (bytes32[] memory out) {
        uint32 pos = rosterPos[epoch][host];
        uint32[] memory o = offsetsOf(epoch);
        if (pos == 0 || o.length == 0) return new bytes32[](0);
        bytes32[] storage r = _roster[epoch];
        uint256 n = r.length;
        out = new bytes32[](o.length);
        for (uint256 j = 0; j < o.length; j++)
            out[j] = r[forward ? (pos - 1 + o[j]) % n : (pos - 1 + n - o[j]) % n];
    }

    // ========================================================================
    // capacity: reports by the assigned checkers, and a host's own proof
    // ========================================================================

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256("EnclaveProofOfCapacity"),
                                    keccak256("1"), block.chainid, address(this)));
    }

    function reportDigest(uint64 epoch, bytes32 checker, bytes32 target, uint8 verdict, bytes32 seed, bytes32 evidence)
        public view returns (bytes32)
    {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(),
            keccak256(abi.encode(REPORT_TYPEHASH, epoch, checker, target, verdict, seed, evidence))));
    }

    function selfDigest(uint64 epoch, bytes32 host, bytes32 seed, bytes32 evidence) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(),
            keccak256(abi.encode(SELF_TYPEHASH, epoch, host, seed, evidence))));
    }

    /// A checker's verdict on a host it was assigned, for the current epoch or (within the grace) the one before.
    function report(uint64 epoch, bytes32 checker, bytes32 target, uint8 verdict, bytes32 evidence, bytes calldata sig)
        external
    {
        touch();
        uint64 e = epochNow();
        require(epoch == e || (epoch + 1 == e && block.timestamp - uint256(e) * epochSec <= reportGraceSec), "epoch closed");
        require(verdict >= VERDICT_PASS && verdict <= VERDICT_UNREACHABLE, "bad verdict");
        bytes32 seed = seedOf[epoch];
        require(seed != bytes32(0), "epoch has no seed");
        require(_assigned(epoch, checker, target), "not assigned");
        require(verdictOf[epoch][checker][target] == 0, "already reported");
        address key = registry.get(checker).proofKey;
        require(key != address(0), "checker has no proof key");
        require(_recover(reportDigest(epoch, checker, target, verdict, seed, evidence), sig) == key, "bad report signature");
        verdictOf[epoch][checker][target] = verdict;
        emit CapacityReported(epoch, checker, target, verdict, evidence);
    }

    /// A host's own proof of capacity for the current epoch, signed by its proof key over the epoch's seed.
    function proveSelf(bytes32 host, bytes32 evidence, bytes calldata sig) external {
        bytes32 seed = touch();
        uint64 e = epochNow();
        address key = registry.get(host).proofKey;
        require(key != address(0), "host has no proof key");
        require(_recover(selfDigest(e, host, seed, evidence), sig) == key, "bad self-proof signature");
        selfProved[e][host] = true;
        emit CapacitySelfProved(e, host, evidence);
    }

    function _assigned(uint64 epoch, bytes32 checker, bytes32 target) private view returns (bool) {
        uint32 pc = rosterPos[epoch][checker];
        uint32 pt = rosterPos[epoch][target];
        if (pc == 0 || pt == 0 || pc == pt) return false;
        uint256 n = _roster[epoch].length;
        uint256 d = (uint256(pc) + n - pt) % n;        // the checker sits this far after its target
        uint32[] memory o = offsetsOf(epoch);
        for (uint256 j = 0; j < o.length; j++) if (o[j] == d) return true;
        return false;
    }

    /// Is `host` in standing for `epoch`? `why` says what is missing when it is not.
    function standing(bytes32 host, uint64 epoch) public view returns (bool ok, string memory why) {
        if (epoch == 0 || rosterPos[epoch - 1][host] == 0)
            return selfProved[epoch][host] ? (true, "") : (false, "needs its own proof of capacity");
        uint64 p = epoch - 1;
        bytes32[] memory mine = targetsOf(p, host);
        for (uint256 j = 0; j < mine.length; j++)
            if (verdictOf[p][host][mine[j]] == 0) return (false, "did not check the hosts it was assigned");
        bytes32[] memory theirs = checkersOf(p, host);
        uint256 passes; uint256 fails;
        for (uint256 j = 0; j < theirs.length; j++) {
            uint8 v = verdictOf[p][theirs[j]][host];
            if (v == VERDICT_PASS) passes++; else if (v == VERDICT_FAIL) fails++;
        }
        if (fails >= failQuorum) return (false, "failed its capacity checks");
        if (fails == 0 && passes > 0) return (true, "");
        return selfProved[epoch][host] ? (true, "") : (false, "needs its own proof of capacity");
    }

    // ========================================================================
    // the proof of time (EnclaveProofOfTime's, with standing in front of it)
    // ========================================================================

    function proofDigest(bytes32 id, bytes32 enclaveId, address operator,
                         uint64 upto, uint64 anchorBlock, bytes32 anchorHash)
        public view returns (bytes32)
    {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(),
            keccak256(abi.encode(PROOF_TYPEHASH, id, enclaveId, operator, upto, anchorBlock, anchorHash))));
    }

    function checkpoint(bytes32 id, bytes32 enclaveId, uint64 upto, uint64 anchorBlock, bytes32 anchorHash,
                        bytes calldata sig) public {
        require(anchorHash != bytes32(0) && blockhash(anchorBlock) == anchorHash, "stale or unknown anchor");

        IEnclaveDeploymentsP.Deployment memory d = deployments.get(id);
        require(enclaveId != bytes32(0) && d.runner == enclaveId, "not the runner");

        address proofKey = registry.get(enclaveId).proofKey;
        require(proofKey != address(0), "enclave has no proof key");
        require(_recover(proofDigest(id, enclaveId, d.runnerOperator, upto, anchorBlock, anchorHash), sig) == proofKey,
                "bad proof signature");

        // STANDING - checked once per host and epoch, then remembered
        touch();
        uint64 e = epochNow();
        if (_standingSeen[enclaveId] != e + 1) {
            (bool ok, string memory why) = standing(enclaveId, e);
            require(ok, why);
            _standingSeen[enclaveId] = e + 1;
        }

        uint64 ceiling = uint64(block.timestamp);
        if (ceiling > d.leaseUntil) ceiling = d.leaseUntil;
        if (upto > ceiling) upto = ceiling;
        uint64 base = deployments.provenUntil(id);
        if (base == 0) base = ceiling > proofWindowSec ? ceiling - proofWindowSec : 0;
        Record storage r = recordOf[id];
        uint64 elapsed = uint64(block.timestamp) > r.lastProofAt ? uint64(block.timestamp) - r.lastProofAt : 0;
        uint64 advance = elapsed < proofWindowSec ? elapsed : proofWindowSec;
        if (upto > base + advance) upto = base + advance;
        require(upto > base, "nothing to prove");

        deployments.creditProven(id, upto);   // the ledger re-clamps, then pays

        uint64 proven = upto - base;
        r.lastProofAt = uint64(block.timestamp);
        r.provenSec  += proven;
        r.proofs     += 1;
        hostedSec[d.runnerOperator] += proven;
        // credited in this epoch: on the roster of the next
        if (rosterPos[e + 1][enclaveId] == 0) {
            _roster[e + 1].push(enclaveId);
            uint32 pos = uint32(_roster[e + 1].length);
            rosterPos[e + 1][enclaveId] = pos;
            emit Rostered(e + 1, enclaveId, pos);
        }
        emit Checkpointed(id, enclaveId, d.runnerOperator, upto, proven, anchorBlock);
    }

    struct Checkpoint {
        bytes32 id;
        bytes32 enclaveId;
        uint64  upto;
        uint64  anchorBlock;
        bytes32 anchorHash;
        bytes   sig;
    }

    /// Many checkpoints in one transaction; one that is refused does not sink the rest.
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

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        require(sig.length == 65, "bad signature length");
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "bad signature v");
        require(uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "bad signature s");
        address a = ecrecover(digest, v, r, s);
        require(a != address(0), "bad signature");
        return a;
    }

    // ========================================================================
    // reads
    // ========================================================================

    function unprovenSec(bytes32 id) public view returns (uint64) {
        IEnclaveDeploymentsP.Deployment memory d = deployments.get(id);
        if (d.runner == bytes32(0)) return 0;
        uint64 upto = uint64(block.timestamp);
        if (upto > d.leaseUntil) upto = d.leaseUntil;
        uint64 proven = deployments.provenUntil(id);
        return upto > proven ? upto - proven : 0;
    }

    function coverageOf(bytes32 id) external view returns (
        uint64 provenUntil_, uint64 lastProofAt, uint64 provenSec, uint32 proofs, uint64 unproven, bool required
    ) {
        Record storage r = recordOf[id];
        return (deployments.provenUntil(id), r.lastProofAt, r.provenSec, r.proofs, unprovenSec(id), deployments.proofRequired());
    }
}

/*
FUTURE (deliberately not in this rev):
  - judging the evidence: a report's `evidence` is a digest this contract stores and does not read. A challenge that
    lets anyone show a pass was signed over a result that does not verify would make a false pass costly.
  - paying the carrier: a checkpoint or a report can be carried by anyone, and nobody is paid for it here. Taking the
    carrier's gas out of what a checkpoint unlocks needs the operator key's executor (EnclaveLeaseExecutor) to grow a
    checkpoint-and-reimburse path, or a ledger that credits a submitter's share.
  - a seed nobody can lean on (a randomness beacon, or commit-reveal among the roster).
  - owners: hosts of one owner checking each other count as any other pair. A registry that records accepted
    ownership (EnclaveHostLifecycleRegistry) would let the assignment prefer checkers of another owner.
*/
