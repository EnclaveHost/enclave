// SPDX-License-Identifier: MIT
// Transparent paid verification. See docs/design/paid-capacity-verification.md.
pragma solidity ^0.8.20;

// A non-custodial, opt-in companion. Jobs are ordinary payer-owned deployments;
// execution and host payments use the ordinary deployment ledger.
interface IAvailabilityLedger {
    struct Deployment {
        bytes32 id; address owner; string appRef; string ports; string configCid;
        uint16 gpuMilli; uint16 cpuMilli; uint32 appPort; bool isPublic; bool active;
        uint64 createdAt; uint256 rate; uint256 balance6; uint256 spent6;
        bytes32 runner; address runnerOperator; uint64 leaseUntil;
    }
    function get(bytes32 id) external view returns (Deployment memory);
    function usdc() external view returns (address);
    function fundFor(bytes32 id, uint256 value, address payer) external;
    function earned6(address operator) external view returns (uint256);
    function prover() external view returns (address);
    function proofRequired() external view returns (bool);
}
interface IAvailabilityProof {
    function deployments() external view returns (address);
    function checkpoint(bytes32 id, bytes32 enclaveId, uint64 upto, uint64 anchorBlock,
        bytes32 anchorHash, bytes calldata sig) external;
}

interface IAvailabilityToken {
    function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter,
        uint256 validBefore, bytes32 nonce, bytes calldata signature) external;
    function approve(address spender, uint256 value) external returns (bool);
}

/// @notice Payers authorize a revenue-bounded budget; funds stay in their wallets.
/// Actual newly credited runner USDC unlocks budget, never claimed capacity or
/// lease spend. Existing host/publisher payments are NOT reduced. This is an
/// explicit additional payer authorization, not a retroactive fee diversion.
/// Witness selection and workload/result checks live off-chain. Their selection
/// is private, but this contract's transactions are public and can reveal funding.
contract EnclaveAvailability {
    IAvailabilityLedger public immutable ledger;
    IAvailabilityProof public immutable proof;
    struct Policy {
        address payer;
        address executor;
        uint16 bps;
        uint64 expires;
        uint64 epoch;
        uint256 dailyCap6;
        uint256 jobCap6;
        uint256 available6;
    }
    struct DaySpend { uint256 day; uint256 spent6; }
    mapping(bytes32 => Policy) public policies;
    mapping(address => DaySpend) public dailySpend;
    // Permanent separation prevents rewards recursively generating reward budget.
    mapping(bytes32 => bool) public isSource;
    mapping(bytes32 => bool) public fundedJob;
    bool private entered;
    event PolicySet(bytes32 indexed source, address indexed payer, address executor,
        uint16 bps, uint256 dailyCap6, uint256 jobCap6, uint64 expires, uint64 epoch);
    event BudgetEarned(bytes32 indexed source, uint256 serviceCredit6, uint256 budget6);
    event JobFunded(bytes32 indexed source, bytes32 indexed job, address indexed payer, uint256 amount6);
    modifier nonReentrant() { require(!entered, "reentrant"); entered = true; _; entered = false; }

    constructor(address ledger_, address proof_) {
        ledger = IAvailabilityLedger(ledger_);
        proof = IAvailabilityProof(proof_);
        require(ledger.prover() == proof_ && proof.deployments() == ledger_, "wrong proof pair");
    }

    /// Set bps=0 to revoke. No accumulated allowance carries across policy changes.
    /// UTC daily usage is payer-wide and does not reset on edits or source changes.
    function setPolicy(bytes32 source, address executor, uint16 bps, uint256 dailyCap6,
        uint256 jobCap6, uint64 expires) external {
        require(ledger.get(source).owner == msg.sender, "not source owner");
        require(!fundedJob[source], "recursive budget");
        require(bps <= 1000, "max 10 percent");
        if (bps != 0) require(executor != address(0) && dailyCap6 > 0 && jobCap6 > 0
            && jobCap6 <= dailyCap6 && expires > block.timestamp, "invalid policy");
        uint64 epoch = policies[source].epoch + 1;
        policies[source] = Policy(msg.sender, executor, bps, expires, epoch, dailyCap6, jobCap6, 0);
        isSource[source] = true;
        emit PolicySet(source, msg.sender, executor, bps, dailyCap6, jobCap6, expires, epoch);
    }

    /// Same proof signature/domain as the existing prover. Anyone may submit.
    /// If no active policy exists this still settles the host normally.
    function checkpoint(bytes32 id, bytes32 enclaveId, uint64 upto, uint64 anchorBlock,
        bytes32 anchorHash, bytes calldata sig) external nonReentrant {
        IAvailabilityLedger.Deployment memory d = ledger.get(id);
        uint256 beforeCredit = ledger.earned6(d.runnerOperator);
        proof.checkpoint(id, enclaveId, upto, anchorBlock, anchorHash, sig);
        uint256 credit = ledger.earned6(d.runnerOperator) - beforeCredit;
        Policy storage p = policies[id];
        if (p.bps == 0 || block.timestamp >= p.expires || p.payer != d.owner
            || fundedJob[id] || !ledger.proofRequired()) return;
        uint256 budget = credit * p.bps / 10000;
        p.available6 += budget;
        emit BudgetEarned(id, credit, budget);
    }

    /// USDC authorization is redeemable ONLY here, then atomically forwarded to
    /// the ledger with original payer attribution. No balance remains here.
    /// No payer allowance, shared treasury or arbitrary payment destination.
    /// Each job additionally needs the payer's amount/id-bound token authorization.
    function fundJob(bytes32 source, bytes32 job, uint64 epoch, bytes32 expectedJobHash,
        uint256 amount6, uint256 validAfter, uint256 validBefore, bytes32 nonce,
        bytes calldata signature) external nonReentrant {
        Policy storage p = policies[source];
        require(p.bps != 0 && block.timestamp < p.expires && p.epoch == epoch, "inactive policy");
        require(msg.sender == p.executor, "not executor");
        require(ledger.get(source).owner == p.payer, "source owner changed");
        require(!isSource[job] && !fundedJob[job], "used job");
        IAvailabilityLedger.Deployment memory d = ledger.get(job);
        require(d.owner == p.payer && d.active && d.runner == bytes32(0)
            && d.balance6 == 0 && d.spent6 == 0, "not fresh payer job");
        require(jobHash(job) == expectedJobHash, "job changed");
        require(amount6 > 0 && amount6 <= p.jobCap6 && amount6 <= p.available6, "budget");
        DaySpend storage day = dailySpend[p.payer];
        uint256 today = block.timestamp / 1 days;
        if (day.day != today) { day.day = today; day.spent6 = 0; }
        require(day.spent6 + amount6 <= p.dailyCap6, "daily cap");
        p.available6 -= amount6;
        day.spent6 += amount6;
        fundedJob[job] = true;
        // Bind the token authorization to source, policy, job, mutable snapshot and
        // deadline. An executor cannot substitute a different reviewed job.
        require(nonce == fundingNonce(source, job, epoch, expectedJobHash), "wrong funding nonce");
        IAvailabilityToken token = IAvailabilityToken(ledger.usdc());
        token.receiveWithAuthorization(p.payer, address(this), amount6, validAfter, validBefore, nonce, signature);
        require(token.approve(address(ledger), amount6), "approval failed");
        ledger.fundFor(job, amount6, p.payer);
        emit JobFunded(source, job, p.payer, amount6);
    }

    function fundingNonce(bytes32 source, bytes32 job, uint64 epoch, bytes32 expectedJobHash)
        public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), source, job, epoch, expectedJobHash));
    }

    /// Snapshot mutable fields so a reviewed job cannot change before funding.
    function jobHash(bytes32 job) public view returns (bytes32) {
        IAvailabilityLedger.Deployment memory d = ledger.get(job);
        return keccak256(abi.encode(d.id, d.owner, d.appRef, d.ports, d.configCid,
            d.gpuMilli, d.cpuMilli, d.appPort, d.isPublic, d.active, d.rate));
    }
}
