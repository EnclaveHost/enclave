// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LeaseGasDexAdapter, ISwapRouter02} from "../../src/LeaseGasDexAdapter.sol";
import {DexGasIntent} from "../../src/ILeaseGasDexAdapter.sol";

/// FiatToken-shaped 6dp stand-in with switchable misbehaviour. Token pattern follows r2's MockToken6
/// (unified-funding-20261028/r2/test/mocks/RouterMocks.sol, local work), extended with approve/refund failure modes,
/// a no-return (USDT-style) mode and an incoming-transfer block (FiatToken blacklist on the refund leg).
contract MockUSDC {
    uint8 public immutable decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blockIncoming;

    uint256 public feeBps;
    bool public transferFromReturnsFalse;
    bool public approveReturnsFalse;
    bool public approveReverts;
    bool public approveIgnored;      // answers true, sets nothing
    bool public noReturn;            // approve / transfer / transferFrom return no data

    address public hookTarget;
    bytes public hookData;
    bool public hookArmed;
    bool public hookOnTransfer;      // false: fire inside transferFrom; true: inside transfer
    bool public hookOk;
    bytes public hookRet;

    constructor(uint8 d) { decimals = d; }

    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function setFeeBps(uint256 b) external { feeBps = b; }
    function setTransferFromReturnsFalse(bool v) external { transferFromReturnsFalse = v; }
    function setApproveReturnsFalse(bool v) external { approveReturnsFalse = v; }
    function setApproveReverts(bool v) external { approveReverts = v; }
    function setApproveIgnored(bool v) external { approveIgnored = v; }
    function setNoReturn(bool v) external { noReturn = v; }
    function setBlockIncoming(address who, bool v) external { blockIncoming[who] = v; }
    function setHook(address t, bytes calldata d, bool onTransfer) external {
        (hookTarget, hookData, hookArmed, hookOnTransfer) = (t, d, true, onTransfer);
    }

    function approve(address s, uint256 a) external returns (bool) {
        require(!approveReverts, "approve");
        if (approveReturnsFalse) return false;
        if (!approveIgnored) allowance[msg.sender][s] = a;
        _ret();
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        _move(msg.sender, to, a);
        if (hookArmed && hookOnTransfer) _fire();
        _ret();
        return true;
    }

    function transferFrom(address from, address to, uint256 a) external returns (bool) {
        if (transferFromReturnsFalse) return false;
        uint256 al = allowance[from][msg.sender];
        require(al >= a, "allowance");
        if (al != type(uint256).max) allowance[from][msg.sender] = al - a;
        _move(from, to, a);
        if (hookArmed && !hookOnTransfer) _fire();
        _ret();
        return true;
    }

    function _fire() private {
        hookArmed = false;
        (hookOk, hookRet) = hookTarget.call(hookData);
    }

    function _move(address from, address to, uint256 a) private {
        require(!blockIncoming[to], "blacklisted");
        require(balanceOf[from] >= a, "balance");
        balanceOf[from] -= a;
        balanceOf[to] += a - a * feeBps / 10_000;
    }

    /// No-return mode: end the external call here with empty returndata.
    function _ret() private view {
        if (noReturn) {
            assembly { return(0, 0) }
        }
    }
}

/// WETH9 shape: withdraw pays with transfer() (2300-gas stipend), as canonical WETH9 / Base's 0x4200..0006 do.
contract MockWETH9 {
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public unwrapShortBy;    // withdraw debits wad but sends wad - unwrapShortBy

    function setUnwrapShortBy(uint256 v) external { unwrapShortBy = v; }

    function deposit() public payable { balanceOf[msg.sender] += msg.value; }
    receive() external payable { deposit(); }

    function withdraw(uint256 wad) external {
        require(balanceOf[msg.sender] >= wad, "weth balance");
        balanceOf[msg.sender] -= wad;
        payable(msg.sender).transfer(wad - unwrapShortBy);
    }

    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { _move(msg.sender, to, a); return true; }
    function transferFrom(address from, address to, uint256 a) external returns (bool) {
        uint256 al = allowance[from][msg.sender];
        require(al >= a, "allowance");
        if (al != type(uint256).max) allowance[from][msg.sender] = al - a;
        _move(from, to, a);
        return true;
    }

    /// Sends ETH from WETH to `to` outside any unwrap (the adapter must refuse it).
    function poke(address to) external payable {
        (bool ok,) = to.call{value: msg.value}("");
        require(ok, "poke refused");
    }

    function _move(address from, address to, uint256 a) private {
        require(balanceOf[from] >= a, "balance");
        balanceOf[from] -= a;
        balanceOf[to] += a;
    }
}

/// Holds the pool's token balances; only the factory's bound router may pay out of it.
contract MockV3Pool {
    address public immutable factory;
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;

    constructor(address f, address t0, address t1, uint24 fee_) {
        factory = f;
        token0 = t0;
        token1 = t1;
        fee = fee_;
    }

    function payOut(address token, address to, uint256 amount) external {
        require(msg.sender == MockV3Factory(factory).router(), "!router");
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "pool pay");
    }
}

/// Uniswap V3 factory shape: getPool (both orders), feeAmountTickSpacing (100/500/3000/10000 enabled).
contract MockV3Factory {
    mapping(uint24 => int24) public feeAmountTickSpacing;
    mapping(address => mapping(address => mapping(uint24 => address))) public getPool;
    address public router;

    constructor() {
        feeAmountTickSpacing[100] = 1;
        feeAmountTickSpacing[500] = 10;
        feeAmountTickSpacing[3000] = 60;
        feeAmountTickSpacing[10000] = 200;
    }

    function setRouter(address r) external { require(router == address(0), "bound"); router = r; }
    function setTickSpacing(uint24 fee, int24 s) external { feeAmountTickSpacing[fee] = s; }

    function createPool(address a, address b, uint24 fee) external returns (address pool) {
        (address t0, address t1) = a < b ? (a, b) : (b, a);
        pool = address(new MockV3Pool(address(this), t0, t1, fee));
        getPool[a][b][fee] = pool;
        getPool[b][a][fee] = pool;
    }

    /// Test override: point (a, b, fee) at anything (a fake pool, an EOA, zero).
    function setPool(address a, address b, uint24 fee, address pool) external {
        getPool[a][b][fee] = pool;
        getPool[b][a][fee] = pool;
    }
}

/// A pool impersonator with configurable identity, for the adapter's pool-validation checks.
contract FakePool {
    address public factory;
    address public token0;
    address public token1;
    uint24 public fee;
    constructor(address f, address t0, address t1, uint24 fee_) { (factory, token0, token1, fee) = (f, t0, t1, fee_); }
}

/// SwapRouter02.exactOutputSingle shape (IV3SwapRouter: no deadline). Linear price per fee tier, the input rounded up
/// like V3 exact output, "Too much requested" above amountInMaximum - and switchable lies.
contract MockSwapRouter02 {
    uint8 public constant HONEST = 0;
    uint8 public constant SHORT_OUT = 1;       // delivers amountOut - 1
    uint8 public constant EXTRA_OUT = 2;       // delivers amountOut + 1
    uint8 public constant UNDER_REPORT = 3;    // returns amountIn - 1
    uint8 public constant OVER_REPORT = 4;     // returns amountIn + 1
    uint8 public constant KEEP_IN_ROUTER = 5;  // pulls the input to itself instead of the pool
    uint8 public constant OTHER_POOL = 6;      // trades against otherPool, not the factory pool for the fee
    uint8 public constant REENTER = 7;         // calls out from inside the swap
    uint8 public constant SEND_ETH = 8;        // also pushes 1 wei of ETH at the recipient
    uint8 public constant PULL_EXTRA = 9;      // pulls amountIn + 1, reports amountIn

    address public immutable factory;
    address public immutable WETH9;
    mapping(uint24 => uint256) public usdcPerEth6;   // USDC (6dp) per 1e18 wei, before the pool fee
    uint8 public mode;
    address public otherPool;

    address public reenterTarget;
    bytes public reenterData;
    bool public reentryOk;
    bytes public reentryRet;

    ISwapRouter02.ExactOutputSingleParams public last;
    uint256 public calls;

    constructor(address f, address w) {
        factory = f;
        WETH9 = w;
    }

    receive() external payable {}

    function setPrice(uint24 fee, uint256 p) external { usdcPerEth6[fee] = p; }
    function setMode(uint8 m) external { mode = m; }
    function setOtherPool(address p) external { otherPool = p; }
    function setReenter(address t, bytes calldata d) external { (reenterTarget, reenterData) = (t, d); }

    function quoteIn(uint24 fee, uint256 amountOut) public view returns (uint256) {
        uint256 base = (amountOut * usdcPerEth6[fee] + 1e18 - 1) / 1e18;
        return (base * (1e6 + fee) + 1e6 - 1) / 1e6;
    }

    function exactOutputSingle(ISwapRouter02.ExactOutputSingleParams calldata p) external payable returns (uint256 amountIn) {
        last = p;
        calls++;
        address pool = MockV3Factory(factory).getPool(p.tokenIn, p.tokenOut, p.fee);
        require(pool != address(0) && usdcPerEth6[p.fee] != 0, "no pool");
        if (mode == OTHER_POOL) pool = otherPool;
        amountIn = quoteIn(p.fee, p.amountOut);
        require(amountIn <= p.amountInMaximum, "Too much requested");
        if (mode == REENTER) (reentryOk, reentryRet) = reenterTarget.call(reenterData);
        if (mode == SEND_ETH) {
            (bool sent,) = p.recipient.call{value: 1}("");
            require(sent, "eth refused");
        }
        address payTo = mode == KEEP_IN_ROUTER ? address(this) : pool;
        uint256 pull = mode == PULL_EXTRA ? amountIn + 1 : amountIn;
        (bool ok, bytes memory ret) = p.tokenIn.call(abi.encodeWithSelector(0x23b872dd, msg.sender, payTo, pull));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "STF");
        uint256 out = mode == SHORT_OUT ? p.amountOut - 1 : mode == EXTRA_OUT ? p.amountOut + 1 : p.amountOut;
        MockV3Pool(pool).payOut(p.tokenOut, p.recipient, out);
        if (mode == UNDER_REPORT) return amountIn - 1;
        if (mode == OVER_REPORT) return amountIn + 1;
    }
}

/// ILLUSTRATIVE successor-SessionVault shape - NOT the successor. Shows the limits the real action must enforce around
/// fundGas: per-op cap and total budget on the PRE-APPROVED maximum, a USDC-per-ETH ceiling on the worst case
/// (multiplication, no rounding in the payer's favour), exact approval, allowance back to 0, charge the ACTUAL spend.
contract MockSuccessorVault {
    LeaseGasDexAdapter public immutable adapter;
    MockUSDC public immutable usdc;
    uint256 public maxPerOp6;
    uint256 public budget6;
    uint256 public maxUsdcPerEth6;
    uint256 public charged6;

    constructor(LeaseGasDexAdapter a, MockUSDC u, uint256 perOp, uint256 budget, uint256 ceiling) {
        adapter = a;
        usdc = u;
        (maxPerOp6, budget6, maxUsdcPerEth6) = (perOp, budget, ceiling);
    }

    function fundGas(DexGasIntent calldata i) external returns (uint256 spent) {
        require(i.payer == address(this), "payer");
        require(i.maxUsdcIn6 <= maxPerOp6, "per-op");
        require(i.maxUsdcIn6 <= budget6, "budget");
        require(i.maxUsdcIn6 * 1e18 <= maxUsdcPerEth6 * i.ethOut, "price");
        require(usdc.approve(address(adapter), i.maxUsdcIn6), "approve");
        spent = adapter.fundGas(i);
        require(usdc.allowance(address(this), address(adapter)) == 0, "allowance left");
        budget6 -= spent;
        charged6 += spent;
    }
}

/// A plain contract caller, for "who may push ETH / unknown selectors" checks.
contract PlainSender {
    function push(address payable to) external payable returns (bool ok, bytes memory ret) {
        (ok, ret) = to.call{value: msg.value}("");
    }
    function callData(address to, bytes calldata data) external returns (bool ok, bytes memory ret) {
        (ok, ret) = to.call(data);
    }
}
