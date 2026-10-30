// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LeaseGasFundingRouter, IGRLedger, IGRReserve} from "../../src/LeaseGasFundingRouter.sol";
import {LeaseGasQuote} from "../../src/ILeaseGasFundingRouter.sol";

/// 6dp (or any-dp) ERC20 stand-in with switchable misbehaviour: fee-on-transfer, return-false, and a one-shot hook
/// that calls out from inside transferFrom (a callback / reentry attempt) and records what happened.
contract MockToken6 {
    uint8 public immutable decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public feeBps;
    bool public returnFalse;

    address public hookTarget;
    bytes public hookData;
    bool public hookArmed;
    bool public hookOk;
    bytes public hookRet;

    constructor(uint8 d) { decimals = d; }

    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function setFeeBps(uint256 b) external { feeBps = b; }
    function setReturnFalse(bool v) external { returnFalse = v; }
    function setHook(address t, bytes calldata d) external { (hookTarget, hookData, hookArmed) = (t, d, true); }

    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { _move(msg.sender, to, a); return true; }

    function transferFrom(address from, address to, uint256 a) external returns (bool) {
        if (returnFalse) return false;
        uint256 al = allowance[from][msg.sender];
        require(al >= a, "allowance");
        if (al != type(uint256).max) allowance[from][msg.sender] = al - a;
        _move(from, to, a);
        if (hookArmed) {
            hookArmed = false;
            (hookOk, hookRet) = hookTarget.call(hookData);
        }
        return true;
    }

    function _move(address from, address to, uint256 a) private {
        require(balanceOf[from] >= a, "balance");
        balanceOf[from] -= a;
        balanceOf[to] += a - a * feeBps / 10_000;
    }
}

/// USDT-style: approve / transferFrom return nothing.
contract NoReturnToken6 {
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external { allowance[msg.sender][s] = a; }
    function transferFrom(address from, address to, uint256 a) external {
        uint256 al = allowance[from][msg.sender];
        require(al >= a && balanceOf[from] >= a, "nope");
        allowance[from][msg.sender] = al - a;
        balanceOf[from] -= a;
        balanceOf[to] += a;
    }
}

/// The ledger's read side: get(id) with the real Deployment tuple, owner settable by anyone (tests drive it).
contract MockLedger {
    mapping(bytes32 => address) public ownerOf;

    function setOwner(bytes32 id, address o) external { ownerOf[id] = o; }

    function get(bytes32 id) external view returns (IGRLedger.Deployment memory d) {
        address o = ownerOf[id];
        if (o == address(0)) return d;            // unknown: id 0, like a missing mapping entry
        d.id = id;
        d.owner = o;
        d.active = true;
    }
}

/// A lease-gas reserve with the real deposit semantics (credit the CURRENT owner of record) and switchable lies.
contract MockReserve {
    uint8 public constant HONEST = 0;
    uint8 public constant UNDER_CREDIT = 1;      // credits 1 wei less than it received
    uint8 public constant FLIP_BEFORE = 2;       // owner of record moves first, so the new owner is credited
    uint8 public constant FLIP_AFTER = 3;        // credits the expected owner, then the owner of record moves
    uint8 public constant REENTER = 4;           // calls out (into the router) from inside deposit
    uint8 public constant DOWN = 5;              // deposit reverts

    address public immutable ledger;
    address public constant OTHER = address(0xBEEF);
    uint8 public mode;
    mapping(bytes32 => uint256) public bal;

    address public reenterTarget;
    bytes public reenterData;
    bool public reentryOk;
    bytes public reentryRet;

    constructor(address l) { ledger = l; }

    function setMode(uint8 m) external { mode = m; }
    function setReenter(address t, bytes calldata d) external { (reenterTarget, reenterData) = (t, d); }
    function key(bytes32 id, address o) public pure returns (bytes32) { return keccak256(abi.encode(id, o)); }

    function deposit(bytes32 id) external payable {
        if (mode == DOWN) revert("reserve down");
        if (mode == REENTER) (reentryOk, reentryRet) = reenterTarget.call(reenterData);
        if (mode == FLIP_BEFORE) MockLedger(ledger).setOwner(id, OTHER);
        address o = MockLedger(ledger).get(id).owner;
        require(o != address(0), "unknown");
        bal[key(id, o)] += mode == UNDER_CREDIT ? msg.value - 1 : msg.value;
        if (mode == FLIP_AFTER) MockLedger(ledger).setOwner(id, OTHER);
    }

    function reserveOf(bytes32 id, address o) external view returns (IGRReserve.Reserve memory r) {
        r.balanceWei = uint128(bal[key(id, o)]);
    }
}

contract RejectEth {
    receive() external payable { revert("no ETH"); }
}

/// A provider contract whose ETH receipt re-enters withdraw() for its own (sufficient) pool.
contract ReentrantProvider {
    LeaseGasFundingRouter public immutable router;
    bool public innerOk;
    bytes public innerRet;
    bool private _armed;

    constructor(LeaseGasFundingRouter r) { router = r; }

    function provideAndWithdraw(uint256 w) external payable {
        router.provide{value: msg.value}();
        _armed = true;
        router.withdraw(w, payable(address(this)));
    }

    receive() external payable {
        if (!_armed) return;
        _armed = false;
        (innerOk, innerRet) = address(router).call(abi.encodeCall(LeaseGasFundingRouter.withdraw, (1, payable(address(this)))));
    }
}

/// The shape a successor SessionVault action would take: approve EXACTLY the quote's input, fill as the payer,
/// require the allowance back at zero (the existing vault's _fund/_payRouter discipline).
contract MockSessionPayer {
    function fundGas(LeaseGasFundingRouter r, MockToken6 t, LeaseGasQuote calldata q, bytes calldata sig)
        external returns (bytes32 digest)
    {
        require(t.approve(address(r), q.usdcIn6), "approve");
        digest = r.fill(q, sig);
        require(t.allowance(address(this), address(r)) == 0, "allowance left");
    }
}
