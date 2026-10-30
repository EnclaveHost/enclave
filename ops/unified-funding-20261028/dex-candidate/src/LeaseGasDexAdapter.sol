// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DexGasIntent, ILeaseGasDexAdapter} from "./ILeaseGasDexAdapter.sol";

/// LeaseGasDexAdapter - USDC in (bounded), an EXACT amount of ETH into a deployment's lease-gas reserve out, in one
/// atomic transaction, bought from EXISTING Uniswap V3 USDC/WETH liquidity through a pinned SwapRouter02.
///
/// UNREVIEWED SOURCE (unified-funding dex-r1). Additive: the ledger and EnclaveLeaseGasReserve are used as they are.
/// No admin, owner, pause, upgrade, fee, sweep or treasury. No arbitrary target, calldata, recipient, path or
/// multi-hop: the only swap is exactOutputSingle(USDC -> WETH, fee in {100, 500, 3000}, recipient = this adapter,
/// sqrtPriceLimitX96 = 0) on the factory pool this contract validates itself.
///
///   1. msg.sender must be intent.payer (the authority: a successor SessionVault action whose session key signed the
///      args, or an EOA sending its own transaction). now <= deadline <= now + MAX_DEADLINE_WINDOW.
///   2. Pull EXACTLY maxUsdcIn6 from the payer (exact deltas on both sides).
///   3. Approve EXACTLY maxUsdcIn6 to the router, exactOutputSingle, then set the allowance back to 0. The router's
///      return value must equal the adapter's actual USDC debit and the pool's actual USDC credit, and the adapter must
///      have received exactly ethOut WETH out of that same pool. No partial or surplus output is accepted.
///   4. WETH.withdraw(ethOut): receive() accepts ETH only from the pinned WETH, only during this step.
///   5. reserve.deposit{value: ethOut}(deployment), credited exactly under expectedOwner, who must be the ledger owner
///      of record before the swap AND after the deposit.
///   6. Refund maxUsdcIn6 - amountIn to the payer (nobody else), then check the end state: payer debited exactly
///      amountIn; the adapter's USDC, WETH and ETH balances exactly what they were before the call.
/// Anything else reverts the whole call. Pre-existing or forced balances are never spent or credited to anyone: every
/// check is a delta against a snapshot taken at the start of the call, and nothing can withdraw them (no sweep).
///
/// maxUsdcIn6 is a loss bound, not a fairness check: the pool price is whatever the pool says. Price ceilings,
/// per-op / period / total budgets and app/env/ownership scope belong to the caller (see DEX-REVIEW.md).

interface IDXToken {
    function balanceOf(address who) external view returns (uint256);
    function allowance(address owner_, address spender) external view returns (uint256);
    function decimals() external view returns (uint8);
}

interface IDXWeth {
    function balanceOf(address who) external view returns (uint256);
    function decimals() external view returns (uint8);
    function withdraw(uint256 wad) external;
}

/// Uniswap SwapRouter02 (IV3SwapRouter): ExactOutputSingleParams has NO deadline field (unlike the v1 SwapRouter).
interface ISwapRouter02 {
    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceLimitX96;
    }
    function exactOutputSingle(ExactOutputSingleParams calldata params) external payable returns (uint256 amountIn);
    function factory() external view returns (address);
    function WETH9() external view returns (address);
}

interface IV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
    function feeAmountTickSpacing(uint24 fee) external view returns (int24);
}

interface IV3Pool {
    function factory() external view returns (address);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
}

interface IDXLedger {
    // byte-for-byte the ledger's Deployment tuple (same as EnclaveLeaseGasReserve.ILedgerR)
    struct Deployment {
        bytes32 id; address owner; string appRef; string ports; string configCid;
        uint16 gpuMilli; uint16 cpuMilli; uint32 appPort; bool isPublic; bool active; uint64 createdAt;
        uint256 rate; uint256 balance6; uint256 spent6;
        bytes32 runner; address runnerOperator; uint64 leaseUntil;
    }
    function get(bytes32 id) external view returns (Deployment memory);
}

interface IDXReserve {
    // field-for-field EnclaveLeaseGasReserve.Reserve (work/enclave/contracts/EnclaveLeaseGasReserve.sol)
    struct Reserve {
        uint128 balanceWei;
        uint64 maxPerOpWei;
        uint64 epochCapWei;
        bool enabled;
        uint8 claimPolicy;
        bool sponsorRelease;
        uint32 renewWindow;
        uint32 minExtension;
        uint32 claimCooldown;
        uint32 epochSec;
        uint64 maxGasPrice;
        uint8 maxClaimsPerEpoch;
        uint32 epochIndex;
        uint96 epochSpentWei;
        uint8 epochClaims;
        uint64 lastClaimAt;
        address lastClaimOperator;
    }
    function ledger() external view returns (address);
    function deposit(bytes32 id) external payable;
    function reserveOf(bytes32 id, address owner_) external view returns (Reserve memory);
}

contract LeaseGasDexAdapter is ILeaseGasDexAdapter {
    // ---- bindings (constructor-validated, immutable) -----------------------------------------------------------------
    address public immutable override usdc;
    address public immutable override weth;
    address public immutable override swapRouter;
    address public immutable override factory;
    address public immutable override ledger;
    address public immutable override reserve;
    uint256 public immutable override maxEthOut;   // per-call ceiling, <= the reserve's own uint96 deposit bound
    address private immutable _token0;             // the USDC/WETH pair, sorted as the factory sorts it
    address private immutable _token1;

    uint256 public constant MAX_DEADLINE_WINDOW = 15 minutes;
    uint24 public constant FEE_100 = 100;
    uint24 public constant FEE_500 = 500;
    uint24 public constant FEE_3000 = 3000;

    // 1 = idle, 2 = inside fundGas, 3 = inside WETH.withdraw (the only state receive() accepts ETH in)
    uint256 private constant IDLE = 1;
    uint256 private constant ENTERED = 2;
    uint256 private constant UNWRAPPING = 3;
    uint256 private _state = IDLE;

    /// Balances at the start of fundGas; every later check is a delta against these.
    struct Snap {
        uint256 payerUsdc;
        uint256 selfUsdc;
        uint256 selfWeth;
        uint256 selfEth;
        uint256 routerUsdc;
        uint256 poolUsdc;
        uint256 poolWeth;
    }

    event GasFunded(bytes32 indexed deployment, address indexed payer, address indexed owner, address pool, uint24 fee,
        uint256 ethOut, uint256 usdcSpent6, uint256 maxUsdcIn6);

    error BadBinding(uint8 code);
    error Reentrant();
    error NotPayer();
    error Expired();
    error DeadlineTooFar();
    error BadAmount();
    error BadParty();
    error UnsupportedFee(uint24 fee);
    error BadPool(uint24 fee);
    error UnknownDeployment(bytes32 id);
    error OwnerMismatch(address actual, address expected);
    error TokenTransferFailed();
    error ApproveFailed();
    error DexMismatch(uint8 code);
    error UnwrapMismatch();
    error ReserveMismatch();
    error RefundFailed();
    error Conservation(uint8 code);
    error UnexpectedEth();

    modifier nonReentrant() {
        if (_state != IDLE) revert Reentrant();
        _state = ENTERED;
        _;
        _state = IDLE;
    }

    /// @param _usdc    the settlement token (6 decimals; Base native USDC in production)
    /// @param _weth    the router's WETH9 (18 decimals; Base 0x4200..0006)
    /// @param _router  Uniswap SwapRouter02 (IV3SwapRouter ABI: no deadline field)
    /// @param _factory the Uniswap V3 factory the router is bound to
    /// @param _ledger  EnclaveDeployments - the owner-of-record authority
    /// @param _reserve EnclaveLeaseGasReserve bound to that same ledger
    /// @param _maxEthOut per-call ceiling in wei (1 .. 2^96-1)
    constructor(address _usdc, address _weth, address _router, address _factory, address _ledger, address _reserve,
        uint256 _maxEthOut)
    {
        address[6] memory a = [_usdc, _weth, _router, _factory, _ledger, _reserve];
        for (uint256 x; x < 6; ++x) {
            if (a[x].code.length == 0) revert BadBinding(1);
            for (uint256 y; y < x; ++y) if (a[x] == a[y]) revert BadBinding(1);
        }
        if (IDXReserve(_reserve).ledger() != _ledger) revert BadBinding(2);
        if (IDXToken(_usdc).decimals() != 6 || IDXWeth(_weth).decimals() != 18) revert BadBinding(3);
        if (ISwapRouter02(_router).factory() != _factory || ISwapRouter02(_router).WETH9() != _weth) revert BadBinding(4);
        if (_maxEthOut == 0 || _maxEthOut > type(uint96).max) revert BadBinding(5);
        usdc = _usdc;
        weth = _weth;
        swapRouter = _router;
        factory = _factory;
        ledger = _ledger;
        reserve = _reserve;
        maxEthOut = _maxEthOut;
        (_token0, _token1) = _usdc < _weth ? (_usdc, _weth) : (_weth, _usdc);
    }

    /// ETH is accepted from the pinned WETH only, and only while this contract is unwrapping its own swap output.
    /// WETH9.withdraw pays with transfer() (2300 gas): this stays read-only - one warm SLOAD, no storage write.
    receive() external payable {
        if (msg.sender != weth || _state != UNWRAPPING) revert UnexpectedEth();
    }

    // =================================================================================================================
    // the purchase
    // =================================================================================================================

    function fundGas(DexGasIntent calldata i) external override nonReentrant returns (uint256 usdcSpent6) {
        if (msg.sender != i.payer) revert NotPayer();
        if (block.timestamp > i.deadline) revert Expired();
        if (i.deadline > block.timestamp + MAX_DEADLINE_WINDOW) revert DeadlineTooFar();
        if (i.ethOut == 0 || i.ethOut > maxEthOut || i.maxUsdcIn6 == 0) revert BadAmount();
        address pool = poolFor(i.fee);
        if (i.expectedOwner == address(0) || i.payer == swapRouter || i.payer == pool) revert BadParty();
        _requireOwner(i.deployment, i.expectedOwner);

        Snap memory s = Snap({
            payerUsdc: _bal(usdc, i.payer),
            selfUsdc: _bal(usdc, address(this)),
            selfWeth: _bal(weth, address(this)),
            selfEth: address(this).balance,
            routerUsdc: _bal(usdc, swapRouter),
            poolUsdc: _bal(usdc, pool),
            poolWeth: _bal(weth, pool)
        });

        _pullExact(i.payer, i.maxUsdcIn6, s);
        usdcSpent6 = _swapExact(i, pool, s);
        _unwrapExact(i.ethOut, s);
        _depositExact(i.deployment, i.expectedOwner, i.ethOut);
        _refund(i.payer, i.maxUsdcIn6 - usdcSpent6);
        // Refund is also a mutable external call: bind the final owner after ALL interactions.
        _requireOwner(i.deployment, i.expectedOwner);

        // end state: the payer paid exactly what the pool took; nothing else the adapter holds moved
        if (_bal(usdc, i.payer) + usdcSpent6 != s.payerUsdc) revert Conservation(1);
        if (_bal(usdc, address(this)) != s.selfUsdc) revert Conservation(2);
        if (_bal(weth, address(this)) != s.selfWeth) revert Conservation(3);
        if (address(this).balance != s.selfEth) revert Conservation(4);
        if (IDXToken(usdc).allowance(address(this), swapRouter) != 0) revert Conservation(5);

        emit GasFunded(i.deployment, i.payer, i.expectedOwner, pool, i.fee, i.ethOut, usdcSpent6, i.maxUsdcIn6);
    }

    // =================================================================================================================
    // views
    // =================================================================================================================

    /// The pinned factory's USDC/WETH pool for a supported fee tier, validated (code, factory, tokens, fee); reverts
    /// otherwise. The router derives the same address (CREATE2 from the factory); the swap's exact pool balance
    /// deltas then prove the router actually traded against THIS pool.
    function poolFor(uint24 fee) public view override returns (address pool) {
        if (fee != FEE_100 && fee != FEE_500 && fee != FEE_3000) revert UnsupportedFee(fee);
        if (IV3Factory(factory).feeAmountTickSpacing(fee) == 0) revert BadPool(fee);
        pool = IV3Factory(factory).getPool(usdc, weth, fee);
        if (pool.code.length == 0 || IV3Pool(pool).factory() != factory || IV3Pool(pool).token0() != _token0
            || IV3Pool(pool).token1() != _token1 || IV3Pool(pool).fee() != fee) revert BadPool(fee);
    }

    // =================================================================================================================
    // internals
    // =================================================================================================================

    function _requireOwner(bytes32 id, address expected) private view {
        IDXLedger.Deployment memory d = IDXLedger(ledger).get(id);
        if (id == bytes32(0) || d.id != id) revert UnknownDeployment(id);
        if (d.owner != expected) revert OwnerMismatch(d.owner, expected);
    }

    /// transferFrom(payer -> this, amount), tolerating no-return tokens, then exact deltas on both sides.
    function _pullExact(address from, uint256 amount, Snap memory s) private {
        if (!_tokenCall(usdc, abi.encodeWithSelector(0x23b872dd, from, address(this), amount))) revert TokenTransferFailed();
        if (_bal(usdc, from) + amount != s.payerUsdc || _bal(usdc, address(this)) != s.selfUsdc + amount) {
            revert TokenTransferFailed();
        }
    }

    /// Exact allowance to the router, exactOutputSingle, allowance back to 0. The router's answer must match what
    /// actually moved: adapter USDC -amountIn, pool USDC +amountIn, router USDC unchanged, adapter WETH +amountOut out
    /// of the pool, adapter ETH unchanged.
    function _swapExact(DexGasIntent calldata i, address pool, Snap memory s) private returns (uint256 amountIn) {
        _approveExact(i.maxUsdcIn6);
        amountIn = ISwapRouter02(swapRouter).exactOutputSingle(ISwapRouter02.ExactOutputSingleParams({
            tokenIn: usdc,
            tokenOut: weth,
            fee: i.fee,
            recipient: address(this),
            amountOut: i.ethOut,
            amountInMaximum: i.maxUsdcIn6,
            sqrtPriceLimitX96: 0
        }));
        if (amountIn == 0 || amountIn > i.maxUsdcIn6) revert DexMismatch(1);
        if (_bal(usdc, address(this)) != s.selfUsdc + i.maxUsdcIn6 - amountIn) revert DexMismatch(2);
        if (_bal(usdc, swapRouter) != s.routerUsdc) revert DexMismatch(3);
        if (_bal(usdc, pool) != s.poolUsdc + amountIn) revert DexMismatch(4);
        if (_bal(weth, address(this)) != s.selfWeth + i.ethOut) revert DexMismatch(5);
        if (_bal(weth, pool) + i.ethOut != s.poolWeth) revert DexMismatch(6);
        if (address(this).balance != s.selfEth) revert DexMismatch(7);
        _approveExact(0);
    }

    function _approveExact(uint256 amount) private {
        if (!_tokenCall(usdc, abi.encodeWithSelector(0x095ea7b3, swapRouter, amount))) revert ApproveFailed();
        if (IDXToken(usdc).allowance(address(this), swapRouter) != amount) revert ApproveFailed();
    }

    /// Unwrap exactly the swap output; WETH back to its snapshot, ETH up by exactly `amount`.
    function _unwrapExact(uint256 amount, Snap memory s) private {
        _state = UNWRAPPING;
        IDXWeth(weth).withdraw(amount);
        _state = ENTERED;
        if (_bal(weth, address(this)) != s.selfWeth || address(this).balance != s.selfEth + amount) revert UnwrapMismatch();
    }

    /// The reserve must take exactly `amount` from this contract and credit exactly `amount` to (id, owner_).
    function _depositExact(bytes32 id, address owner_, uint256 amount) private {
        uint256 reserveBefore = IDXReserve(reserve).reserveOf(id, owner_).balanceWei;
        uint256 ethBefore = address(this).balance;
        IDXReserve(reserve).deposit{value: amount}(id);
        if (address(this).balance + amount != ethBefore) revert ReserveMismatch();
        if (IDXReserve(reserve).reserveOf(id, owner_).balanceWei != reserveBefore + amount) revert ReserveMismatch();
    }

    /// Unused input goes back to the payer and nobody else; a refusing payer (e.g. blacklisted) reverts everything.
    function _refund(address payer, uint256 amount) private {
        if (amount == 0) return;
        if (!_tokenCall(usdc, abi.encodeWithSelector(0xa9059cbb, payer, amount))) revert RefundFailed();
    }

    /// SafeERC20-style: the call succeeds and returns nothing or exactly `true`.
    function _tokenCall(address token, bytes memory data) private returns (bool) {
        (bool ok, bytes memory ret) = token.call(data);
        return ok && (ret.length == 0 || (ret.length == 32 && abi.decode(ret, (uint256)) == 1));
    }

    function _bal(address token, address who) private view returns (uint256) {
        return IDXToken(token).balanceOf(who);
    }
}
