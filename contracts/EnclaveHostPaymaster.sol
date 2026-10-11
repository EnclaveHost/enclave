// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title EnclaveHostPaymaster - pays the gas for a new host's FIRST registration, once per piece of hardware.
///
/// A box joining Enclave as a host must call EnclaveRegistry.register() from its operator key, and that costs gas the
/// box's owner would otherwise have to buy before earning anything. This ERC-4337 paymaster (EntryPoint v0.8) pays it,
/// under rules it enforces itself:
///
///   - THE CALL: the operation must be the account's execute(registry, 0, register(...)) - the operator key delegated
///     to the standard Simple7702Account by EIP-7702, so the registry still sees that key as msg.sender and the box keeps
///     one ordinary operator key. Nothing else is paid for: no other target, no other function, no value.
///   - THE HARDWARE: a voucher from the VERIFIER (the relay, which only signs after the box proved real hardware: a TPM
///     endorsement certificate chained to a pinned manufacturer root with credential activation and a quote over the
///     relay's nonce, or an AMD SEV-SNP report under a verified VCEK) over this exact operation and a hardware id (the
///     EK certificate's sha256, or the SNP chip id). Verifying a TPM chain on chain is not affordable; the verifier key
///     is the trust, and these rules bound what a stolen one could spend.
///   - ONCE: each hardware id and each operator is sponsored once, recorded here. The record is taken when the voucher
///     validates and given back if the registration itself reverts, so a failed attempt does not spend the machine's
///     one sponsorship. Governance may forget a hardware id (a box rebuilt from scratch).
///   - THE PRICE: an operation may cost at most maxCostPerOp wei; the deposit at the EntryPoint is all it can ever spend.
contract EnclaveHostPaymaster {
    // ---- EntryPoint v0.8 types (inlined: the repo vendors no account-abstraction sources) -----------------------------
    struct PackedUserOperation {
        address sender;
        uint256 nonce;
        bytes initCode;
        bytes callData;
        bytes32 accountGasLimits;
        uint256 preVerificationGas;
        bytes32 gasFees;
        bytes paymasterAndData;
        bytes signature;
    }
    enum PostOpMode { opSucceeded, opReverted, postOpReverted }

    IEntryPointLite public immutable entryPoint;
    address public immutable registry;

    bytes4 private constant EXECUTE = 0xb61d27f6;          // execute(address,uint256,bytes) - Simple7702Account
    bytes4 private constant REGISTER = 0x7e5a25d7;         // register(string,string,bytes32,uint64,uint64,address)
    uint256 private constant PAYMASTER_DATA_OFFSET = 52;   // paymaster(20) | verificationGasLimit(16) | postOpGasLimit(16)
    uint256 private constant VOUCHER_LENGTH = 32 + 6 + 6 + 65; // hardwareId | validUntil | validAfter | signature

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant SPONSORSHIP_TYPEHASH = keccak256(
        "HostSponsorship(address sender,uint256 nonce,bytes32 initCodeHash,bytes32 callDataHash,bytes32 accountGasLimits,"
        "uint256 preVerificationGas,bytes32 gasFees,bytes32 paymasterGasLimits,bytes32 hardwareId,uint48 validUntil,"
        "uint48 validAfter)");

    address public owner;
    address public pendingOwner;
    address public verifier;
    uint256 public maxCostPerOp;

    /// @notice hardware id -> the operator its one sponsorship went to (zero: never sponsored).
    mapping(bytes32 => address) public hardwareSponsored;
    /// @notice operator -> the hardware id it was sponsored for (zero: never sponsored).
    mapping(address => bytes32) public operatorSponsored;

    event OwnerChanged(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferStarted(address indexed owner, address indexed pendingOwner);
    event VerifierChanged(address indexed previousVerifier, address indexed newVerifier);
    event MaxCostChanged(uint256 previousMaxCost, uint256 newMaxCost);
    event HostSponsored(bytes32 indexed hardwareId, address indexed operator, uint256 actualGasCost);
    event SponsorshipReleased(bytes32 indexed hardwareId, address indexed operator);
    event HardwareForgotten(bytes32 indexed hardwareId, address indexed operator);

    constructor(IEntryPointLite _entryPoint, address _registry, address _verifier, uint256 _maxCostPerOp) {
        require(address(_entryPoint) != address(0) && _registry != address(0) && _verifier != address(0), "zero");
        entryPoint = _entryPoint;
        registry = _registry;
        verifier = _verifier;
        maxCostPerOp = _maxCostPerOp;
        owner = msg.sender;
        emit OwnerChanged(address(0), msg.sender);
        emit VerifierChanged(address(0), _verifier);
        emit MaxCostChanged(0, _maxCostPerOp);
    }

    modifier onlyOwner() { require(msg.sender == owner, "!owner"); _; }
    modifier onlyEntryPoint() { require(msg.sender == address(entryPoint), "!entryPoint"); _; }

    // ========================================================================
    // the EntryPoint's calls
    // ========================================================================

    /// @notice Pay for this operation only if it is a register() on the registry, carries the verifier's voucher for
    ///         this exact operation and an unsponsored hardware id and operator, and costs at most maxCostPerOp.
    ///         A bad voucher signature is reported as SIG_VALIDATION_FAILED (the EntryPoint's convention); every
    ///         other broken rule reverts.
    function validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32, uint256 maxCost)
        external onlyEntryPoint returns (bytes memory context, uint256 validationData)
    {
        require(maxCost <= maxCostPerOp, "cost");
        _requireRegisterCall(userOp.callData);
        (bytes32 hardwareId, uint48 validUntil, uint48 validAfter, bytes calldata sig) = _voucher(userOp.paymasterAndData);
        require(hardwareId != bytes32(0), "hardware");
        require(hardwareSponsored[hardwareId] == address(0), "hardware sponsored");
        require(operatorSponsored[userOp.sender] == bytes32(0), "operator sponsored");
        bool valid = _recover(sponsorshipDigest(userOp, hardwareId, validUntil, validAfter), sig) == verifier;
        if (valid) {
            // taken now, so a second operation in the same bundle cannot use it too; postOp gives it back on a revert
            hardwareSponsored[hardwareId] = userOp.sender;
            operatorSponsored[userOp.sender] = hardwareId;
        }
        return (abi.encode(hardwareId, userOp.sender), _packValidationData(!valid, validUntil, validAfter));
    }

    /// @notice A registration that reverted gives the sponsorship back: the machine may try again.
    function postOp(PostOpMode mode, bytes calldata context, uint256 actualGasCost, uint256) external onlyEntryPoint {
        (bytes32 hardwareId, address operator) = abi.decode(context, (bytes32, address));
        if (mode == PostOpMode.opSucceeded) {
            emit HostSponsored(hardwareId, operator, actualGasCost);
            return;
        }
        delete hardwareSponsored[hardwareId];
        delete operatorSponsored[operator];
        emit SponsorshipReleased(hardwareId, operator);
    }

    // ========================================================================
    // the voucher
    // ========================================================================

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256("EnclaveHostPaymaster"), keccak256("1"),
                                    block.chainid, address(this)));
    }

    /// @notice What the verifier signs (EIP-712): every field of the operation that fixes what is paid for and how much,
    ///         except the paymaster data that carries the voucher itself, plus the hardware id and validity window.
    function sponsorshipDigest(PackedUserOperation calldata userOp, bytes32 hardwareId, uint48 validUntil, uint48 validAfter)
        public view returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(
            SPONSORSHIP_TYPEHASH, userOp.sender, userOp.nonce, keccak256(userOp.initCode), keccak256(userOp.callData),
            userOp.accountGasLimits, userOp.preVerificationGas, userOp.gasFees,
            bytes32(userOp.paymasterAndData[20:PAYMASTER_DATA_OFFSET]), hardwareId, validUntil, validAfter));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function _voucher(bytes calldata pnd)
        private pure returns (bytes32 hardwareId, uint48 validUntil, uint48 validAfter, bytes calldata sig)
    {
        require(pnd.length == PAYMASTER_DATA_OFFSET + VOUCHER_LENGTH, "voucher length");
        bytes calldata d = pnd[PAYMASTER_DATA_OFFSET:];
        hardwareId = bytes32(d[0:32]);
        validUntil = uint48(bytes6(d[32:38]));
        validAfter = uint48(bytes6(d[38:44]));
        sig = d[44:109];
    }

    /// @dev execute(registry, 0, register(...)) and nothing else.
    function _requireRegisterCall(bytes calldata callData) private view {
        require(callData.length >= 4 + 32 * 4 + 4 && bytes4(callData[0:4]) == EXECUTE, "!execute");
        (address target, uint256 value, bytes memory data) = abi.decode(callData[4:], (address, uint256, bytes));
        require(target == registry, "!registry");
        require(value == 0, "value");
        bytes4 selector;
        require(data.length >= 4, "!register");
        assembly { selector := mload(add(data, 32)) }
        require(selector == REGISTER, "!register");
    }

    function _packValidationData(bool sigFailed, uint48 validUntil, uint48 validAfter) private pure returns (uint256) {
        return (sigFailed ? 1 : 0) | (uint256(validUntil) << 160) | (uint256(validAfter) << 208);
    }

    /// @dev 65-byte ECDSA recovery with the malleability guard; a malformed signature recovers nobody (zero), which
    ///      the caller reads as an invalid voucher rather than a revert.
    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        return ecrecover(digest, v, r, s);
    }

    // ========================================================================
    // the deposit and stake at the EntryPoint (anyone may fund; only the owner takes out)
    // ========================================================================

    function deposit() external payable { entryPoint.depositTo{value: msg.value}(address(this)); }
    function getDeposit() external view returns (uint256) { return entryPoint.balanceOf(address(this)); }
    function withdrawTo(address payable to, uint256 amount) external onlyOwner { entryPoint.withdrawTo(to, amount); }
    function addStake(uint32 unstakeDelaySec) external payable onlyOwner { entryPoint.addStake{value: msg.value}(unstakeDelaySec); }
    function unlockStake() external onlyOwner { entryPoint.unlockStake(); }
    function withdrawStake(address payable to) external onlyOwner { entryPoint.withdrawStake(to); }

    // ========================================================================
    // governance
    // ========================================================================

    function setVerifier(address v) external onlyOwner {
        require(v != address(0), "zero");
        emit VerifierChanged(verifier, v);
        verifier = v;
    }

    function setMaxCostPerOp(uint256 c) external onlyOwner {
        emit MaxCostChanged(maxCostPerOp, c);
        maxCostPerOp = c;
    }

    /// @notice A box rebuilt from scratch (new operator key) may be sponsored again.
    function forgetHardware(bytes32 hardwareId) external onlyOwner {
        address operator = hardwareSponsored[hardwareId];
        delete hardwareSponsored[hardwareId];
        if (operator != address(0)) delete operatorSponsored[operator];
        emit HardwareForgotten(hardwareId, operator);
    }

    function transferOwnership(address next) external onlyOwner {
        pendingOwner = next;
        emit OwnershipTransferStarted(owner, next);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "!pending");
        emit OwnerChanged(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }
}

interface IEntryPointLite {
    function depositTo(address account) external payable;
    function balanceOf(address account) external view returns (uint256);
    function withdrawTo(address payable withdrawAddress, uint256 withdrawAmount) external;
    function addStake(uint32 unstakeDelaySec) external payable;
    function unlockStake() external;
    function withdrawStake(address payable withdrawAddress) external;
}
