// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;
import {EnclaveDeploymentLifecycleEmergency as Lc, LifecycleSettlementAck}
    from "../../contracts/EnclaveDeploymentLifecycleEmergency.sol";

/// TEST-ONLY REFERENCE MODEL of the schema-3 paired-ledger gates. It is NOT the
/// production ledger (deploy/lifecycle/EnclaveDeployments.sol is schema 2 and
/// unpatched). It models only the lease meter: balance6/spent6, tail refund,
/// runner credit, and the pending-cutoff gates on settle/fund/proof. Runner
/// escrow, refunds, publisher fees and USDC movement are out of scope.
contract MockPairedLedger {
    enum EndMode { Honest, Revert, SettleAtNow, WrongGeneration }
    struct Run { uint64 gen; bytes32 host; address op; uint64 start; uint64 leaseUntil; uint64 creditedUntil; bool live; }
    uint256 public immutable schema;
    address public controller;
    address public identity;
    bool public down;
    EndMode public endMode;
    mapping(bytes32 => address) private _owners;
    mapping(bytes32 => mapping(bytes32 => address)) private _operators;
    mapping(bytes32 => Run) public runs;
    mapping(bytes32 => bool) public active;
    mapping(bytes32 => uint256) public balance6;
    mapping(bytes32 => uint256) public spent6;
    mapping(bytes32 => uint256) public rate;
    mapping(bytes32 => uint256) public runnerRate;
    mapping(address => uint256) public earned6;
    mapping(bytes32 => mapping(uint64 => bytes32)) public settledAck;
    uint256 public endAtCalls;

    constructor(uint256 schema_) { schema = schema_; }
    modifier live() { require(!down, "ledger unavailable"); _; }
    modifier onlyController() { require(msg.sender == controller && controller != address(0), "only controller"); _; }

    // ---- test harness knobs ----
    function setController(address c) external { controller = c; }
    function setIdentity(address i) external { identity = i; }
    function setDown(bool d) external { down = d; }
    function setEndMode(EndMode m) external { endMode = m; }
    function setOwner(bytes32 id, address o) external { _owners[id] = o; active[id] = true; }
    function setOperator(bytes32 id, bytes32 host, address op) external { _operators[id][host] = op; }
    function setRates(bytes32 id, uint256 rate6, uint256 runnerRate6) external { rate[id] = rate6; runnerRate[id] = runnerRate6; }
    function credit(bytes32 id, uint256 amount6) external { balance6[id] += amount6; }

    // ---- schema-3 port ----
    function lifecycleSchema() external view returns (uint256) { return schema; }
    function lifecycleOwner(bytes32 id) external view live returns (address) { return _owners[id]; }
    function lifecycleOperator(bytes32 id, bytes32 host) external view live returns (address) { return _operators[id][host]; }
    function selfHostingIdentity() external view live returns (address) { return identity; }
    function lifecycleFunded(bytes32 id) external view live returns (bool) {
        Run storage r = runs[id];
        return r.live && (rate[id] == 0 || r.leaseUntil > block.timestamp);
    }
    function lifecycleStart(bytes32 id, bytes32 host, address op, uint64 gen) external live onlyController {
        require(!runs[id].live, "runner assigned");
        require(op != address(0) && _operators[id][host] == op, "operator mismatch");
        uint64 until = type(uint64).max;
        if (rate[id] > 0) {
            uint256 secs = balance6[id] / rate[id];
            require(secs > 0, "unfunded");
            balance6[id] -= secs * rate[id];
            spent6[id] += secs * rate[id];
            until = uint64(block.timestamp + secs);
        }
        runs[id] = Run(gen, host, op, uint64(block.timestamp), until, uint64(block.timestamp), true);
        active[id] = true;
    }
    function lifecycleEnd(bytes32 id, bool stopped) external live onlyController {
        require(!runs[id].live, "runner assigned"); // idle deactivation only
        if (stopped) active[id] = false;
    }
    function lifecycleEndAt(bytes32 id, uint64 gen, bytes32 host, address op, uint64 cutoff, bool stopped)
        external live onlyController returns (bytes32) {
        ++endAtCalls;
        if (endMode == EndMode.Revert) revert("settlement failed");
        bytes32 ack = LifecycleSettlementAck.hash(address(this), msg.sender, id, gen, host, op, cutoff, stopped);
        Run storage r = runs[id];
        if (!r.live && settledAck[id][gen] == ack) return ack; // idempotent, no mutation
        require(r.live && r.gen == gen && r.host == host && r.op == op, "stale settlement");
        require(r.start <= cutoff && cutoff <= block.timestamp, "cutoff out of range");
        uint64 at = endMode == EndMode.SettleAtNow ? uint64(block.timestamp) : cutoff; // adversarial
        _credit(id, at);
        if (rate[id] > 0 && r.leaseUntil > at) {
            uint256 tail = uint256(r.leaseUntil - at) * rate[id];
            balance6[id] += tail;
            spent6[id] -= tail;
        }
        if (stopped) active[id] = false;
        delete runs[id];
        uint64 ackGen = endMode == EndMode.WrongGeneration ? gen + 1 : gen;
        bytes32 out = LifecycleSettlementAck.hash(address(this), msg.sender, id, ackGen, host, op, at, stopped);
        settledAck[id][gen] = out;
        return out;
    }

    // ---- legacy-shaped paths that must honor a pending cutoff ----
    function _pendingCutoff(bytes32 id) internal view returns (bool pending, uint64 cutoff) {
        (uint64 gen, uint64 c,, bool p,,) = Lc(controller).offline(id);
        pending = p && runs[id].live && runs[id].gen == gen;
        cutoff = c;
    }
    function _credit(bytes32 id, uint64 upto) internal {
        Run storage r = runs[id];
        if (!r.live) return;
        if (upto > r.leaseUntil) upto = r.leaseUntil;
        (bool pending, uint64 cutoff) = _pendingCutoff(id);
        if (pending && upto > cutoff) upto = cutoff;
        if (upto <= r.creditedUntil) return;
        earned6[r.op] += uint256(upto - r.creditedUntil) * runnerRate[id];
        r.creditedUntil = upto;
    }
    function settle(bytes32 id) external live { _credit(id, uint64(block.timestamp)); }
    /// Final-proof ceiling: a late proof credits no further than the cutoff.
    function creditProven(bytes32 id, uint64 upto) external live {
        if (upto > block.timestamp) upto = uint64(block.timestamp);
        _credit(id, upto);
    }
    /// Funding during a pending stop is credited to balance but never extends
    /// (re-burns into) the revoked run.
    function fund(bytes32 id, uint256 amount6) external live {
        balance6[id] += amount6;
        Run storage r = runs[id];
        (bool pending,) = _pendingCutoff(id);
        if (!r.live || pending || rate[id] == 0 || r.leaseUntil <= block.timestamp) return;
        uint256 secs = balance6[id] / rate[id];
        balance6[id] -= secs * rate[id];
        spent6[id] += secs * rate[id];
        r.leaseUntil += uint64(secs);
    }
}

contract MockIdentity {
    bool public down;
    function setDown(bool d) external { down = d; }
    function principal(address a) external view returns (address) { require(!down, "identity unavailable"); return a; }
}

contract MockL1Oracle {
    bool public down;
    function setDown(bool d) external { down = d; }
    function getL1FeeUpperBound(uint256) external view returns (uint256) { require(!down, "oracle unavailable"); return 1 gwei; }
}

/// A submitter whose own address rejects ETH.
contract RejectingRelay {
    function submit(Lc lc, Lc.Emergency calldata x, bytes[] calldata sigs) external returns (bool) {
        return lc.emergencyOffline(x, sigs);
    }
    function claim(Lc lc, address to) external { lc.claimReimbursement(to); }
    receive() external payable { revert("no ETH"); }
}
