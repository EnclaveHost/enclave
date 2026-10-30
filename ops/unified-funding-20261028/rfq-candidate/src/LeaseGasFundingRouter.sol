// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LeaseGasQuote, ILeaseGasFundingRouter} from "./ILeaseGasFundingRouter.sol";

/// LeaseGasFundingRouter - USDC in, an EXACT amount of ETH into a deployment's lease-gas reserve out, in one atomic
/// transaction, from a permissionless liquidity provider's pre-funded ETH at that provider's signed quote.
///
/// UNREVIEWED SOURCE (unified-funding r2). Additive: the ledger and EnclaveLeaseGasReserve are used as they are; this
/// contract holds no USDC and has no admin, no pause, no upgrade, no fee, no sweep and no treasury.
///
///   - PROVIDER (anyone, any number): provide() pre-funds an ETH pool keyed to msg.sender; withdraw() takes back only
///     the unused part of its OWN pool. It signs EIP-712 LeaseGasQuotes off-chain; each nonce fills at most once, and
///     cancelNonce() retires one early.
///   - PAYER (msg.sender == q.payer, nobody else): fill() pulls exactly q.usdcIn6 from the payer straight to the
///     provider, moves exactly q.ethOut from the provider's pool into reserve.deposit(q.deployment), and checks the
///     reserve credited exactly that much under q.expectedOwner - the ledger owner of record before AND after the
///     deposit. Anything else reverts everything. Holding someone's quote does not let a third party spend that
///     payer's allowance: only the payer can submit.
///   - The quote is an executable negotiated price, not a market price. The payer (a successor SessionVault action, a
///     client) decides whether the price and freshness are acceptable before calling; see ROUTER-REVIEW.md.
///
/// Accounting: sum(liquidityOf) == totalLiquidity <= address(this).balance. ETH arrives only through provide(); there
/// is no receive/fallback. ETH forced in (selfdestruct, coinbase) is credited to nobody and stays stranded.

interface IGRToken {
    function balanceOf(address who) external view returns (uint256);
    function decimals() external view returns (uint8);
}

interface IGRLedger {
    // byte-for-byte the ledger's Deployment tuple (same as EnclaveLeaseGasReserve.ILedgerR / SessionVault.ISVLedger)
    struct Deployment {
        bytes32 id; address owner; string appRef; string ports; string configCid;
        uint16 gpuMilli; uint16 cpuMilli; uint32 appPort; bool isPublic; bool active; uint64 createdAt;
        uint256 rate; uint256 balance6; uint256 spent6;
        bytes32 runner; address runnerOperator; uint64 leaseUntil;
    }
    function get(bytes32 id) external view returns (Deployment memory);
}

interface IGRReserve {
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

contract LeaseGasFundingRouter is ILeaseGasFundingRouter {
    // ---- bindings (constructor-validated, immutable) -----------------------------------------------------------------
    address public immutable override usdc;
    address public immutable override ledger;
    address public immutable override reserve;
    uint256 public immutable override maxEthOut;   // per-fill ceiling, <= the reserve's own uint96 deposit bound

    uint256 public constant MAX_QUOTE_TTL = 15 minutes;   // a quote may not be valid for longer than this from its fill

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("Enclave LeaseGasFundingRouter");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "LeaseGasQuote(address payer,bytes32 deployment,address expectedOwner,uint256 usdcIn6,uint256 ethOut,"
        "uint256 nonce,uint64 expiry,address provider)");
    // secp256k1n / 2, in halves (as SessionVault): signatures above it are the malleable twin
    uint256 private constant HALF_N =
        (uint256(0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF) << 128) | 0x5D576E7357A4501DDFE92F46681B20A0;

    // ---- state -------------------------------------------------------------------------------------------------------
    mapping(address => uint256) public override liquidityOf;                    // provider => unused ETH (wei)
    uint256 public totalLiquidity;                                              // == sum(liquidityOf)
    mapping(address => mapping(uint256 => bool)) public override nonceUsed;     // provider => nonce => filled or cancelled
    uint256 private _lock = 1;                                                  // 1 = free, 2 = entered

    event LiquidityAdded(address indexed provider, uint256 amountWei);
    event LiquidityWithdrawn(address indexed provider, address to, uint256 amountWei);
    event NonceCancelled(address indexed provider, uint256 nonce);
    event Filled(bytes32 indexed deployment, address indexed provider, address indexed payer, address owner,
        uint256 usdcIn6, uint256 ethOut, uint256 nonce, bytes32 digest);

    error BadBinding(uint8 code);
    error Reentrant();
    error ZeroAmount();
    error NotPayer();
    error QuoteExpired();
    error ExpiryTooFar();
    error BadAmount();
    error BadParty();
    error NonceUsed();
    error BadSignature();
    error InsufficientLiquidity(uint256 need, uint256 have);
    error UnknownDeployment(bytes32 id);
    error OwnerMismatch(address actual, address expected);
    error TokenTransferFailed();
    error ReserveMismatch();
    error EthSendFailed();

    modifier nonReentrant() {
        if (_lock == 2) revert Reentrant();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @param _usdc   the settlement token (6 decimals; Base native USDC in production)
    /// @param _ledger EnclaveDeployments - the owner-of-record authority
    /// @param _reserve EnclaveLeaseGasReserve bound to that same ledger
    /// @param _maxEthOut per-fill ceiling in wei (1 .. 2^96-1)
    constructor(address _usdc, address _ledger, address _reserve, uint256 _maxEthOut) {
        if (_usdc.code.length == 0 || _ledger.code.length == 0 || _reserve.code.length == 0) revert BadBinding(1);
        if (_usdc == _ledger || _usdc == _reserve || _ledger == _reserve) revert BadBinding(1);
        if (IGRReserve(_reserve).ledger() != _ledger) revert BadBinding(2);
        if (IGRToken(_usdc).decimals() != 6) revert BadBinding(3);
        if (_maxEthOut == 0 || _maxEthOut > type(uint96).max) revert BadBinding(4);
        usdc = _usdc;
        ledger = _ledger;
        reserve = _reserve;
        maxEthOut = _maxEthOut;
    }

    // =================================================================================================================
    // providers
    // =================================================================================================================

    function provide() external payable nonReentrant {
        if (msg.value == 0) revert ZeroAmount();
        liquidityOf[msg.sender] += msg.value;
        totalLiquidity += msg.value;
        emit LiquidityAdded(msg.sender, msg.value);
    }

    /// Only the caller's own unused pool; the recipient is the caller's choice.
    function withdraw(uint256 amountWei, address payable to) external nonReentrant {
        if (amountWei == 0 || to == address(0)) revert ZeroAmount();
        uint256 have = liquidityOf[msg.sender];
        if (amountWei > have) revert InsufficientLiquidity(amountWei, have);
        liquidityOf[msg.sender] = have - amountWei;
        totalLiquidity -= amountWei;
        emit LiquidityWithdrawn(msg.sender, to, amountWei);
        (bool ok,) = to.call{value: amountWei}("");
        if (!ok) revert EthSendFailed();
    }

    /// Retire one of the caller's quote nonces before anyone fills it.
    function cancelNonce(uint256 nonce) external {
        nonceUsed[msg.sender][nonce] = true;
        emit NonceCancelled(msg.sender, nonce);
    }

    // =================================================================================================================
    // the fill
    // =================================================================================================================

    function fill(LeaseGasQuote calldata q, bytes calldata providerSig)
        external override nonReentrant returns (bytes32 digest)
    {
        if (msg.sender != q.payer) revert NotPayer();
        if (block.timestamp > q.expiry) revert QuoteExpired();
        if (q.expiry > block.timestamp + MAX_QUOTE_TTL) revert ExpiryTooFar();
        if (q.ethOut == 0 || q.ethOut > maxEthOut || q.usdcIn6 == 0) revert BadAmount();
        if (q.provider == address(0) || q.provider == q.payer || q.expectedOwner == address(0)) revert BadParty();
        if (nonceUsed[q.provider][q.nonce]) revert NonceUsed();
        digest = quoteDigest(q);
        if (!_signedBy(digest, providerSig, q.provider)) revert BadSignature();
        uint256 have = liquidityOf[q.provider];
        if (q.ethOut > have) revert InsufficientLiquidity(q.ethOut, have);
        _requireOwner(q.deployment, q.expectedOwner);

        // effects
        nonceUsed[q.provider][q.nonce] = true;
        liquidityOf[q.provider] = have - q.ethOut;
        totalLiquidity -= q.ethOut;

        // interactions: USDC payer -> provider, then ETH pool -> reserve, each checked by exact deltas
        _pullExact(q.payer, q.provider, q.usdcIn6);
        _depositExact(q.deployment, q.expectedOwner, q.ethOut);
        // the deposit credits whoever is owner of record DURING it: the owner must not have moved across it
        _requireOwner(q.deployment, q.expectedOwner);

        emit Filled(q.deployment, q.provider, q.payer, q.expectedOwner, q.usdcIn6, q.ethOut, q.nonce, digest);
    }

    // =================================================================================================================
    // views
    // =================================================================================================================

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function quoteDigest(LeaseGasQuote calldata q) public view override returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(QUOTE_TYPEHASH, q.payer, q.deployment, q.expectedOwner, q.usdcIn6,
            q.ethOut, q.nonce, q.expiry, q.provider));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// ETH held but credited to no provider (forced in). Never withdrawable by anyone.
    function strandedEth() external view returns (uint256) {
        uint256 b = address(this).balance;
        return b > totalLiquidity ? b - totalLiquidity : 0;
    }

    // =================================================================================================================
    // internals
    // =================================================================================================================

    function _requireOwner(bytes32 id, address expected) private view {
        IGRLedger.Deployment memory d = IGRLedger(ledger).get(id);
        if (id == bytes32(0) || d.id != id) revert UnknownDeployment(id);
        if (d.owner != expected) revert OwnerMismatch(d.owner, expected);
    }

    /// transferFrom tolerating no-return tokens, then exact balance deltas on both sides (fee-on-transfer, rebasing
    /// or otherwise surprising token behaviour reverts instead of under-paying the provider).
    function _pullExact(address from, address to, uint256 amount) private {
        uint256 fromBefore = IGRToken(usdc).balanceOf(from);
        uint256 toBefore = IGRToken(usdc).balanceOf(to);
        (bool ok, bytes memory ret) = usdc.call(abi.encodeWithSelector(0x23b872dd, from, to, amount));
        if (!ok || (ret.length != 0 && (ret.length != 32 || abi.decode(ret, (uint256)) != 1))) revert TokenTransferFailed();
        if (IGRToken(usdc).balanceOf(from) + amount != fromBefore || toBefore + amount != IGRToken(usdc).balanceOf(to)) {
            revert TokenTransferFailed();
        }
    }

    /// The reserve must take exactly `amount` from this contract and credit exactly `amount` to (id, owner_).
    function _depositExact(bytes32 id, address owner_, uint256 amount) private {
        uint256 reserveBefore = IGRReserve(reserve).reserveOf(id, owner_).balanceWei;
        uint256 ethBefore = address(this).balance;
        IGRReserve(reserve).deposit{value: amount}(id);
        if (address(this).balance + amount != ethBefore) revert ReserveMismatch();
        if (IGRReserve(reserve).reserveOf(id, owner_).balanceWei != reserveBefore + amount) revert ReserveMismatch();
    }

    /// 65-byte ECDSA (r, s, v), low-s, v in {27, 28}. EOA providers only (no ERC-1271 in this slice).
    function _signedBy(bytes32 digest, bytes calldata sig, address signer) private pure returns (bool) {
        if (sig.length != 65) return false;
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (uint256(s) > HALF_N || (v != 27 && v != 28)) return false;
        address rec = ecrecover(digest, v, r, s);
        return rec != address(0) && rec == signer;
    }
}
