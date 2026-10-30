// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { DexGasIntent, ILeaseGasDexAdapter } from "dex-r1/src/ILeaseGasDexAdapter.sol";
import { FundingSessionVault, FundingSessionVaultLib, ISVBook, ISVLedger, ISVToken } from "./FundingSessionVault.sol";

/// gas.fund limits a session's owner signed in its SessionGrant (domain version 2). All zero for a grant without
/// gas.fund; all positive for one with it. Bounded so the price check below can never overflow.
struct GasPolicy {
    uint128 maxGasUsdc6;     // ceiling on one purchase's maxUsdcIn6 (the reserved, worst-case input)
    uint128 maxUsdcPerEth6;  // worst price: maxUsdcIn6 * 1e18 <= maxUsdcPerEth6 * ethOut
    uint96  maxEthWei;       // ceiling on one purchase's ethOut
}

/// The old factory and its clones, read-only. Trusted ONLY through the pinned factory: isVault proves the address is
/// one of ITS clones (so owner() and held() are the original implementation's), vaultFor(owner) proves it is THIS
/// owner's. An arbitrary contract answering owner() proves nothing.
interface IFGLegacyFactory {
    function isVault(address v) external view returns (bool);
    function vaultFor(address owner) external view returns (address);
    function implementation() external view returns (address);
}

interface IFGLegacyVault {
    function owner() external view returns (address);
    function usdc() external view returns (address);
    function book() external view returns (address);
    function held(bytes32 id) external view returns (uint8 env, bytes32 promoted, bytes32 createdBy);
}

interface IFGReserve { function ledger() external view returns (address); }

/// UNREVIEWED SOURCE (unified-funding session-r1). The gas.fund action of FundingSessionVault, kept out of the vault's
/// own runtime for EIP-170. A LINKED library: its external functions run by DELEGATECALL in the vault's context, so
/// address(this) is the vault, msg.sender is whoever called vault.execute (the submitter), the adapter sees the VAULT
/// as payer, and every read of the vault's state goes through the vault's own public views (no storage slot is
/// written here except the GasPolicy pointer initPolicy is handed). Non-view entry points cannot be called directly
/// (solc's library call guard), and the vault's nonReentrant lock is held across every call into this library.
///
/// No arbitrary target, calldata, recipient, path or quote provider: the only external writes are
/// usdc.approve(pinned adapter, exact max), adapter.fundGas(the signed intent), usdc.transfer(msg.sender, signed fee).
library FundingGasLib {
    uint8 internal constant GAS_ACTION = 10;
    uint8 internal constant ENV_PROD = 2;
    uint256 internal constant INTENT_BYTES = 7 * 32;      // abi.encode(DexGasIntent): seven static words, nothing else
    bytes32 private constant BOOK_DEPLOYMENTS = "deployments";

    event GasFunded(bytes32 indexed sid, bytes32 indexed deployment, address indexed holder, uint256 ethOut,
        uint256 usdcSpent6, uint256 maxUsdcIn6, address relayer, uint256 fee6);

    error BadPin(uint8 code);
    error BadGasPolicy();
    error BadGasArgs();
    error NotPayer();
    error GasCapExceeded(uint256 maxIn, uint256 cap);
    error EthCapExceeded(uint256 ethOut, uint256 cap);
    error PriceCapExceeded(uint256 maxIn, uint256 ethOut, uint256 maxUsdcPerEth6);
    error LedgerMismatch();
    error UnknownDeployment(bytes32 id);
    error NotMine(bytes32 id);
    error NotHeld(bytes32 id);
    error EnvNotAllowed(uint8 env);
    error AppNotAllowed(bytes32 appId);
    error AppFeeTooHigh(uint256 perHour, uint256 max);
    error ApproveFailed();
    error AllowanceLeft();
    error SpendMismatch();
    error BadRelayer();
    error FeeMismatch();

    // =================================================================================================================
    // construction and opening
    // =================================================================================================================

    /// The implementation's constructor: the adapter speaks the vault's token and the book's CURRENT ledger, its
    /// reserve is bound to that ledger, and the legacy factory's implementation uses the same token and book (so an
    /// old vault's records live on the same ledger). Run once; gas.fund re-checks the ledger on every call.
    function checkPins(address usdc, address book, address adapter, address legacy) external view {
        if (adapter.code.length == 0 || legacy.code.length == 0) revert BadPin(1);
        address L = ISVBook(book).addr(BOOK_DEPLOYMENTS);
        if (ILeaseGasDexAdapter(adapter).usdc() != usdc) revert BadPin(2);
        if (L == address(0) || ILeaseGasDexAdapter(adapter).ledger() != L) revert BadPin(3);
        if (IFGReserve(ILeaseGasDexAdapter(adapter).reserve()).ledger() != L) revert BadPin(4);
        address impl = IFGLegacyFactory(legacy).implementation();
        if (IFGLegacyVault(impl).usdc() != usdc || IFGLegacyVault(impl).book() != book) revert BadPin(5);
    }

    /// _open: gas.fund granted => all three limits positive and bounded; not granted => all three zero (a non-gas
    /// grant carrying gas numbers would be a signature whose meaning the owner cannot read off the action list).
    function initPolicy(GasPolicy storage p, uint256 acts, uint256 maxGasUsdcPerOp, uint256 maxUsdcPerEth6,
        uint256 maxEthPerOp) external
    {
        if ((acts >> GAS_ACTION) & 1 == 0) {
            if (maxGasUsdcPerOp | maxUsdcPerEth6 | maxEthPerOp != 0) revert BadGasPolicy();
            return;
        }
        if (maxGasUsdcPerOp == 0 || maxUsdcPerEth6 == 0 || maxEthPerOp == 0 || maxGasUsdcPerOp > type(uint128).max
            || maxUsdcPerEth6 > type(uint128).max || maxEthPerOp > type(uint96).max) revert BadGasPolicy();
        p.maxGasUsdc6 = uint128(maxGasUsdcPerOp);
        p.maxUsdcPerEth6 = uint128(maxUsdcPerEth6);
        p.maxEthWei = uint96(maxEthPerOp);
    }

    // =================================================================================================================
    // gas.fund
    // =================================================================================================================

    /// Called by FundingSessionVault._gas AFTER execute verified the session (live, epoch, expiry, deadline, nonce
    /// lane, P-256 signature over the args, action bit 10, fee <= maxFeePerOp, attestation) and _spend reserved
    /// maxUsdcIn6 + fee within total, period and op limits. Returns the USDC the pool actually took.
    function fundGas(bytes32 sid, bytes calldata args, uint256 fee) external returns (uint256 used) {
        if (args.length != INTENT_BYTES) revert BadGasArgs();
        DexGasIntent memory i = abi.decode(args, (DexGasIntent));
        FundingSessionVault v = FundingSessionVault(address(this));
        _checkLimits(v, sid, i);
        address holder = _checkScope(v, sid, i);
        used = _buy(v, i);
        _payRelayer(v, fee);
        emit GasFunded(sid, i.deployment, holder, i.ethOut, used, i.maxUsdcIn6, msg.sender, fee);
    }

    /// The signed per-op limits, on the WORST case (the reserved maximum), before any external write.
    function _checkLimits(FundingSessionVault v, bytes32 sid, DexGasIntent memory i) private view {
        if (i.payer != address(this)) revert NotPayer();
        (uint128 maxIn, uint128 maxPx, uint96 maxEth) = v.gasPolicyOf(sid);
        if (i.maxUsdcIn6 == 0 || i.maxUsdcIn6 > maxIn) revert GasCapExceeded(i.maxUsdcIn6, maxIn);
        if (i.ethOut == 0 || i.ethOut > maxEth) revert EthCapExceeded(i.ethOut, maxEth);
        // cross-multiplied, no division: nothing rounds in the session's disfavour. maxUsdcIn6 < 2^128 and
        // ethOut < 2^96, so both sides stay below 2^188 / 2^224 (checked arithmetic regardless).
        if (i.maxUsdcIn6 * 1e18 > uint256(maxPx) * i.ethOut) revert PriceCapExceeded(i.maxUsdcIn6, i.ethOut, maxPx);
    }

    /// Whose record is it, and may THIS session act on it? Exactly three holders qualify:
    ///   this vault        - its custody record must be adopted (env != 0), as for every session action;
    ///   the owner's wallet - production, and a PAID app must be named and genuine at a fee within the grant
    ///                        (deploy.fund's wallet rule; nothing about compute rate - gas funding buys no runtime);
    ///   the owner's OLD vault at the pinned legacy factory - its own held env, nonzero. Its records stay where they
    ///                        are: the reserve credits (deployment, old vault), the old vault's owner's key.
    /// Then: the env must be one the grant named, and a session without "*" must have the record's app listed.
    function _checkScope(FundingSessionVault v, bytes32 sid, DexGasIntent memory i) private view returns (address holder) {
        ISVBook book = v.book();
        ISVLedger L = ISVLedger(book.addr(BOOK_DEPLOYMENTS));
        if (address(L) == address(0) || ILeaseGasDexAdapter(v.gasAdapter()).ledger() != address(L)) revert LedgerMismatch();
        ISVLedger.Deployment memory d = L.get(i.deployment);
        if (i.deployment == bytes32(0) || d.id != i.deployment) revert UnknownDeployment(i.deployment);
        holder = d.owner;
        if (holder == address(0) || i.expectedOwner != holder) revert NotMine(i.deployment);

        address owner_ = v.owner();
        (FundingSessionVault.Session memory s, , bytes32[] memory apps) = v.sessionOf(sid);
        uint8 env;
        if (holder == address(this) || holder == owner_) {
            (env, , ) = v.held(i.deployment);
            if (holder == owner_) {
                if (env == 0) env = ENV_PROD;
                (uint256 fee6, bytes32 feeApp, bool genuine) = FundingSessionVaultLib.feeAndApp(book, i.deployment);
                if (fee6 > 0) {
                    if (!genuine || !_listed(apps, feeApp)) revert AppNotAllowed(feeApp);
                    if (fee6 * 3600 > s.maxAppFeeHour6) revert AppFeeTooHigh(fee6 * 3600, s.maxAppFeeHour6);
                }
            }
        } else {
            IFGLegacyFactory f = IFGLegacyFactory(v.legacyFactory());
            if (!f.isVault(holder) || f.vaultFor(owner_) != holder || IFGLegacyVault(holder).owner() != owner_) {
                revert NotMine(i.deployment);
            }
            (env, , ) = IFGLegacyVault(holder).held(i.deployment);
        }
        if (env == 0) revert NotHeld(i.deployment);
        if (s.envs & env == 0) revert EnvNotAllowed(env);
        if (!s.anyApp) {
            (bytes32 appId, ) = FundingSessionVaultLib.parseRef(d.appRef);
            if (!_listed(apps, appId)) revert AppNotAllowed(appId);
        }
    }

    /// One pinned purchase: approve exactly the maximum, let the adapter pull it and refund the unused part, then
    /// require the allowance back at 0 and the vault's USDC down by exactly what the adapter reports (<= maximum).
    function _buy(FundingSessionVault v, DexGasIntent memory i) private returns (uint256 used) {
        ISVToken T = v.usdc();
        address A = v.gasAdapter();
        uint256 before = T.balanceOf(address(this));
        if (!T.approve(A, i.maxUsdcIn6) || T.allowance(address(this), A) != i.maxUsdcIn6) revert ApproveFailed();
        used = ILeaseGasDexAdapter(A).fundGas(i);
        if (T.allowance(address(this), A) != 0) revert AllowanceLeft();
        if (used == 0 || used > i.maxUsdcIn6 || T.balanceOf(address(this)) + used != before) revert SpendMismatch();
    }

    /// The op's signed fee to the account that actually submitted this successful call - no recipient argument
    /// exists. A front-runner who submits the same signed call earns the same fee for doing the same work; a failed
    /// or duplicate submission reverts and is paid nothing. Exact deltas on both sides.
    function _payRelayer(FundingSessionVault v, uint256 fee) private {
        if (fee == 0) return;
        address to = msg.sender;
        if (to == address(this)) revert BadRelayer();
        ISVToken T = v.usdc();
        uint256 vb = T.balanceOf(address(this));
        uint256 rb = T.balanceOf(to);
        if (!T.transfer(to, fee)) revert FeeMismatch();
        if (T.balanceOf(address(this)) + fee != vb || T.balanceOf(to) != rb + fee) revert FeeMismatch();
    }

    function _listed(bytes32[] memory ids, bytes32 appId) private pure returns (bool) {
        for (uint256 k = 0; k < ids.length; k++) if (ids[k] == appId) return true;
        return false;
    }
}
