// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {EnclaveHostPaymaster, IEntryPointLite} from "../../EnclaveHostPaymaster.sol";

/// The EntryPoint's money side, for the unit tests (the fork test below uses the real v0.8 EntryPoint on Base).
contract MockEntryPoint is IEntryPointLite {
    mapping(address => uint256) public balanceOf;
    function depositTo(address a) external payable { balanceOf[a] += msg.value; }
    function withdrawTo(address payable to, uint256 amt) external { balanceOf[msg.sender] -= amt; to.transfer(amt); }
    function addStake(uint32) external payable {}
    function unlockStake() external {}
    function withdrawStake(address payable) external {}
}

interface IEntryPoint08 {
    function handleOps(EnclaveHostPaymaster.PackedUserOperation[] calldata ops, address payable beneficiary) external;
    function getUserOpHash(EnclaveHostPaymaster.PackedUserOperation calldata op) external view returns (bytes32);
    function getNonce(address sender, uint192 key) external view returns (uint256);
}

interface IRegistryLite {
    struct Enclave {
        string endpoint; string repo; bytes32 measurement; address operator; uint64 registeredAt; uint64 lastSeen;
        bool active; uint64 cpuPricePerSec6; uint64 gpuPricePerSec6; address proofKey; address payoutWallet;
        uint64 caps; string region;
    }
    function register(string calldata endpoint, string calldata repo, bytes32 measurement, uint64 cpuPricePerSec6,
                      uint64 gpuPricePerSec6, address proofKey) external returns (bytes32);
    function get(bytes32 id) external view returns (Enclave memory);
}

abstract contract PaymasterFixture is Test {
    uint256 constant VERIFIER_PK = 0xA11CE;
    uint256 constant OPERATOR_PK = 0xB0B;
    bytes32 constant HW = keccak256("ek-cert-of-a-real-tpm");

    function _registerCall(address registry, string memory endpoint, uint64 cpuPrice) internal pure returns (bytes memory) {
        bytes memory inner = abi.encodeWithSelector(IRegistryLite.register.selector, endpoint, "EnclaveHost/enclave",
                                                    bytes32(0), cpuPrice, uint64(0), address(0));
        return abi.encodeWithSelector(bytes4(0xb61d27f6), registry, uint256(0), inner);   // execute(address,uint256,bytes)
    }

    function _op(address sender, uint256 nonce, bytes memory callData, address paymaster)
        internal pure returns (EnclaveHostPaymaster.PackedUserOperation memory op)
    {
        op.sender = sender;
        op.nonce = nonce;
        op.callData = callData;
        op.accountGasLimits = bytes32((uint256(100_000) << 128) | uint256(300_000));   // verification | call
        op.preVerificationGas = 60_000;
        op.gasFees = bytes32((uint256(1 gwei) << 128) | uint256(1 gwei));               // priority | max
        // a voucher-sized placeholder: the digest reads only the gas-limit word, which is final already
        op.paymasterAndData = abi.encodePacked(paymaster, uint128(150_000), uint128(80_000), new bytes(109));
    }

    /// The relay's side: sign the voucher for this operation and put it in place.
    function _vouch(EnclaveHostPaymaster pm, EnclaveHostPaymaster.PackedUserOperation memory op, bytes32 hw,
                    uint48 validUntil, uint48 validAfter, uint256 signerPk) internal view {
        bytes32 digest = pm.sponsorshipDigest(op, hw, validUntil, validAfter);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        op.paymasterAndData = abi.encodePacked(address(pm), uint128(150_000), uint128(80_000), hw, validUntil, validAfter, r, s, v);
    }
}

contract EnclaveHostPaymasterTest is PaymasterFixture {
    MockEntryPoint ep;
    EnclaveHostPaymaster pm;
    address registry = makeAddr("registry");
    address verifier;
    address operator;

    function setUp() public {
        ep = new MockEntryPoint();
        verifier = vm.addr(VERIFIER_PK);
        operator = vm.addr(OPERATOR_PK);
        pm = new EnclaveHostPaymaster(ep, registry, verifier, 0.001 ether);
    }

    function _good() internal view returns (EnclaveHostPaymaster.PackedUserOperation memory op) {
        op = _op(operator, 0, _registerCall(registry, "https://api.enclave.host/t/new-box", 12), address(pm));
        _vouch(pm, op, HW, uint48(block.timestamp + 600), 0, VERIFIER_PK);
    }

    function _validate(EnclaveHostPaymaster.PackedUserOperation memory op) internal returns (bytes memory ctx, uint256 vd) {
        vm.prank(address(ep));
        return pm.validatePaymasterUserOp(op, bytes32(0), 0.0005 ether);
    }

    function test_aVouchedRegistrationIsPaidAndRecordedOnce() public {
        (bytes memory ctx, uint256 vd) = _validate(_good());
        assertEq(vd & 1, 0, "signature valid");
        assertEq(uint48(vd >> 160), uint48(block.timestamp + 600), "validUntil carried");
        assertEq(pm.hardwareSponsored(HW), operator);
        assertEq(pm.operatorSponsored(operator), HW);
        vm.prank(address(ep));
        pm.postOp(EnclaveHostPaymaster.PostOpMode.opSucceeded, ctx, 1234, 0);
        assertEq(pm.hardwareSponsored(HW), operator, "kept after success");
    }

    function test_theSameHardwareOrOperatorIsNotSponsoredTwice() public {
        _validate(_good());
        // same TPM, a different operator key
        EnclaveHostPaymaster.PackedUserOperation memory again =
            _op(vm.addr(0xC0FFEE), 0, _registerCall(registry, "https://api.enclave.host/t/second", 12), address(pm));
        _vouch(pm, again, HW, uint48(block.timestamp + 600), 0, VERIFIER_PK);
        vm.prank(address(ep));
        vm.expectRevert(bytes("hardware sponsored"));
        pm.validatePaymasterUserOp(again, bytes32(0), 0.0005 ether);
        // same operator, another TPM
        EnclaveHostPaymaster.PackedUserOperation memory other =
            _op(operator, 1, _registerCall(registry, "https://api.enclave.host/t/new-box", 12), address(pm));
        _vouch(pm, other, keccak256("another-tpm"), uint48(block.timestamp + 600), 0, VERIFIER_PK);
        vm.prank(address(ep));
        vm.expectRevert(bytes("operator sponsored"));
        pm.validatePaymasterUserOp(other, bytes32(0), 0.0005 ether);
    }

    function test_aRevertedRegistrationGivesTheSponsorshipBack() public {
        (bytes memory ctx,) = _validate(_good());
        vm.prank(address(ep));
        pm.postOp(EnclaveHostPaymaster.PostOpMode.opReverted, ctx, 1234, 0);
        assertEq(pm.hardwareSponsored(HW), address(0));
        assertEq(pm.operatorSponsored(operator), bytes32(0));
        (, uint256 vd) = _validate(_good());
        assertEq(vd & 1, 0, "the machine may try again");
    }

    function test_aVoucherFromAnyoneElseFailsAndRecordsNothing() public {
        EnclaveHostPaymaster.PackedUserOperation memory op = _good();
        _vouch(pm, op, HW, uint48(block.timestamp + 600), 0, 0xBAD);
        (, uint256 vd) = _validate(op);
        assertEq(vd & 1, 1, "SIG_VALIDATION_FAILED");
        assertEq(pm.hardwareSponsored(HW), address(0), "nothing taken");
    }

    function test_theVoucherCoversTheOperation() public {
        EnclaveHostPaymaster.PackedUserOperation memory op = _good();
        op.callData = _registerCall(registry, "https://api.enclave.host/t/someone-else", 12);   // swapped after vouching
        (, uint256 vd) = _validate(op);
        assertEq(vd & 1, 1, "another endpoint is another operation");
        op = _good();
        op.gasFees = bytes32((uint256(50 gwei) << 128) | uint256(50 gwei));                    // a pricier bid
        (, vd) = _validate(op);
        assertEq(vd & 1, 1);
        op = _good();
        op.sender = vm.addr(0xC0FFEE);
        (, vd) = _validate(op);
        assertEq(vd & 1, 1, "another sender");
    }

    function test_onlyARegisterCallOnTheRegistryIsPaidFor() public {
        bytes memory inner = abi.encodeWithSignature("transfer(address,uint256)", address(this), 1);
        bytes[4] memory calls = [
            abi.encodeWithSelector(bytes4(0xb61d27f6), makeAddr("usdc"), uint256(0),
                abi.encodeWithSelector(IRegistryLite.register.selector, "x", "r", bytes32(0), uint64(1), uint64(0), address(0))),
            abi.encodeWithSelector(bytes4(0xb61d27f6), registry, uint256(0), inner),
            abi.encodeWithSelector(bytes4(0xb61d27f6), registry, uint256(1),
                abi.encodeWithSelector(IRegistryLite.register.selector, "x", "r", bytes32(0), uint64(1), uint64(0), address(0))),
            abi.encodeWithSignature("executeBatch((address,uint256,bytes)[])", new bytes(0))
        ];
        string[4] memory why = ["!registry", "!register", "value", "!execute"];
        for (uint256 i = 0; i < 4; i++) {
            EnclaveHostPaymaster.PackedUserOperation memory op = _op(operator, 0, calls[i], address(pm));
            _vouch(pm, op, HW, uint48(block.timestamp + 600), 0, VERIFIER_PK);
            vm.prank(address(ep));
            vm.expectRevert(bytes(why[i]));
            pm.validatePaymasterUserOp(op, bytes32(0), 0.0005 ether);
        }
    }

    function test_costCapVoucherShapeAndCaller() public {
        EnclaveHostPaymaster.PackedUserOperation memory op = _good();
        vm.prank(address(ep));
        vm.expectRevert(bytes("cost"));
        pm.validatePaymasterUserOp(op, bytes32(0), 0.002 ether);
        vm.expectRevert(bytes("!entryPoint"));
        pm.validatePaymasterUserOp(op, bytes32(0), 0.0005 ether);
        op.paymasterAndData = abi.encodePacked(address(pm), uint128(150_000), uint128(80_000), HW);
        vm.prank(address(ep));
        vm.expectRevert(bytes("voucher length"));
        pm.validatePaymasterUserOp(op, bytes32(0), 0.0005 ether);
        EnclaveHostPaymaster.PackedUserOperation memory zero = _good();
        _vouch(pm, zero, bytes32(0), uint48(block.timestamp + 600), 0, VERIFIER_PK);
        vm.prank(address(ep));
        vm.expectRevert(bytes("hardware"));
        pm.validatePaymasterUserOp(zero, bytes32(0), 0.0005 ether);
        vm.expectRevert(bytes("!entryPoint"));
        pm.postOp(EnclaveHostPaymaster.PostOpMode.opReverted, abi.encode(HW, operator), 0, 0);
    }

    function test_governance() public {
        address stranger = makeAddr("stranger");
        vm.startPrank(stranger);
        vm.expectRevert(bytes("!owner")); pm.setVerifier(stranger);
        vm.expectRevert(bytes("!owner")); pm.setMaxCostPerOp(1);
        vm.expectRevert(bytes("!owner")); pm.forgetHardware(HW);
        vm.expectRevert(bytes("!owner")); pm.withdrawTo(payable(stranger), 1);
        vm.stopPrank();
        pm.deposit{value: 1 ether}();
        assertEq(pm.getDeposit(), 1 ether, "anyone funds");
        _validate(_good());
        pm.forgetHardware(HW);
        assertEq(pm.hardwareSponsored(HW), address(0));
        assertEq(pm.operatorSponsored(operator), bytes32(0), "a rebuilt box may be sponsored again");
        address next = makeAddr("trezor");
        pm.transferOwnership(next);
        assertEq(pm.owner(), address(this), "two steps");
        vm.prank(next); pm.acceptOwnership();
        assertEq(pm.owner(), next);
    }
}

/// The whole path on a fork of Base: the real EntryPoint v0.8, the real Simple7702Account and the live EnclaveRegistry.
/// An operator key holding NO ETH delegates to Simple7702Account (EIP-7702) and registers through the paymaster.
/// Skipped unless BASE_FORK_RPC is set (CI has no Base RPC).
contract EnclaveHostPaymasterForkTest is PaymasterFixture {
    IEntryPoint08 constant EP = IEntryPoint08(0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108);
    address constant SIMPLE_7702 = 0xe6Cae83BdE06E4c305530e199D7217f42808555B;
    address constant REGISTRY = 0x868eB7fc5B5A84B2FF082eafc9bf40b7AAc5CCAC;
    EnclaveHostPaymaster pm;
    bool forked;

    function setUp() public {
        string memory rpc = vm.envOr("BASE_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
        pm = new EnclaveHostPaymaster(IEntryPointLite(address(EP)), REGISTRY, vm.addr(VERIFIER_PK), 0.001 ether);
        pm.deposit{value: 0.01 ether}();
    }

    function _sponsoredRegister(uint256 operatorPk, string memory endpoint, uint64 cpuPrice, bytes32 hw)
        internal returns (address operator)
    {
        operator = vm.addr(operatorPk);
        vm.signAndAttachDelegation(SIMPLE_7702, operatorPk);
        EnclaveHostPaymaster.PackedUserOperation memory op =
            _op(operator, EP.getNonce(operator, 0), _registerCall(REGISTRY, endpoint, cpuPrice), address(pm));
        op.gasFees = bytes32((uint256(0.001 gwei) << 128) | uint256(block.basefee + 0.01 gwei));
        _vouch(pm, op, hw, uint48(block.timestamp + 600), 0, VERIFIER_PK);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(operatorPk, EP.getUserOpHash(op));
        op.signature = abi.encodePacked(r, s, v);
        EnclaveHostPaymaster.PackedUserOperation[] memory ops = new EnclaveHostPaymaster.PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(makeAddr("bundler"), makeAddr("bundler"));
        EP.handleOps(ops, payable(makeAddr("bundler")));
    }

    function test_fork_anOperatorWithNoEthRegistersThroughThePaymaster() public {
        if (!forked) return;
        string memory endpoint = string.concat("https://api.enclave.host/t/paymaster-fork-", vm.toString(block.number));
        address operator = vm.addr(OPERATOR_PK);
        assertEq(operator.balance, 0, "the operator holds no gas at all");
        uint256 before = pm.getDeposit();
        vm.recordLogs();
        _sponsoredRegister(OPERATOR_PK, endpoint, 12, HW);
        // the live registry is an older build than this tree's struct, so read its Registered event, not get()
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool registered;
        for (uint256 i = 0; i < logs.length; i++)
            if (logs[i].emitter == REGISTRY && logs[i].topics[0] == keccak256("Registered(bytes32,address,string,string)")) {
                assertEq(logs[i].topics[1], keccak256(bytes(endpoint)), "this endpoint's id");
                assertEq(address(uint160(uint256(logs[i].topics[2]))), operator, "the operator key itself is the operator");
                registered = true;
            }
        assertTrue(registered, "registered");
        assertEq(pm.hardwareSponsored(HW), operator);
        assertEq(operator.balance, 0, "and still holds none");
        assertLt(pm.getDeposit(), before, "the paymaster paid");
        emit log_named_uint("gas paid by the paymaster (wei)", before - pm.getDeposit());
    }

    function test_fork_aRevertedRegisterIsPaidButGivesTheMachineAnotherTry() public {
        if (!forked) return;
        // cpuPricePerSec6 0: the registry refuses - the op reverts inside execute, the gas is still spent
        _sponsoredRegister(OPERATOR_PK, "https://api.enclave.host/t/paymaster-fork-refused", 0, HW);
        assertEq(pm.hardwareSponsored(HW), address(0), "given back");
        assertEq(pm.operatorSponsored(vm.addr(OPERATOR_PK)), bytes32(0));
    }
}
