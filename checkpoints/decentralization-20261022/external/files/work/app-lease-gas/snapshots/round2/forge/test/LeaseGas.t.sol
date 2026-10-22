// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {EnclaveLeaseGasPaymaster as PM, IEntryPointLease, ILedgerLease, IRegistryLease, IERC20Lease, IFeedLease}
    from "../src/EnclaveLeaseGasPaymaster.sol";
import {EnclaveDeployments} from "../src/live/EnclaveDeployments.sol";
import {EnclaveRegistry} from "../src/live/EnclaveRegistry.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// Chainlink-shaped ETH/USD feed (8 decimals) the test can move and age.
contract MockFeed {
    int256 public answer;
    uint256 public updatedAt;
    uint80 public round = 1;
    uint80 public answeredIn = 1;
    function set(int256 a, uint256 u) external { answer = a; updatedAt = u; round++; answeredIn = round; }
    function setIncomplete() external { round++; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (round, answer, updatedAt, updatedAt, answeredIn);
    }
}

/// A permissive account a host might delegate to instead of Simple7702Account (anything it likes in execute()).
contract RogueAccount {
    function validateUserOp(PM.PackedUserOperation calldata, bytes32, uint256) external pure returns (uint256) { return 0; }
    function execute(address t, uint256 v, bytes calldata d) external { (bool ok,) = t.call{value: v}(d); ok; }
}

interface IEP08 {
    function handleOps(PM.PackedUserOperation[] calldata ops, address payable beneficiary) external;
    function getUserOpHash(PM.PackedUserOperation calldata userOp) external view returns (bytes32);
    function getNonce(address sender, uint192 key) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function senderCreator() external view returns (address);
    error FailedOp(uint256 opIndex, string reason);
    error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner);
}

/// The paymaster against the ACTUAL EntryPoint v0.8 + Simple7702Account runtime code (read from Base, hash-pinned in
/// fixtures/aa-code-base.json, etched at their canonical addresses), the LIVE rev-16d ledger source and the live
/// schema-4 registry source. Operators are fresh keys that never hold ETH; their EIP-7702 delegation rides in the
/// bundler's handleOps transaction. MOCKED: USDC (MockUSDC) and the price feed (MockFeed) only. Tests whose names
/// start with test_mocked_ call the paymaster directly as the EntryPoint instead of running a real handleOps.
abstract contract LeaseGasBase is Test {
    address constant EP = 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108;
    address constant S7702 = 0xe6Cae83BdE06E4c305530e199D7217f42808555B;
    uint256 constant T0 = 1_792_000_800;              // an epoch boundary (497,778 * 3600): claim and renew window share an epoch
    uint256 constant EPOCH = 3600;
    bytes32 constant USEROP_EVENT = keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)");

    EnclaveDeployments ledger;
    EnclaveRegistry registry;
    MockUSDC usdc;
    MockFeed feed;
    PM pm;

    address payout = makeAddr("payout");
    address bundler = makeAddr("bundler");
    address sponsor = makeAddr("sponsor");
    uint256 constant ALICE_PK = 0xA11CE000A;
    address alice = vm.addr(ALICE_PK);   // owner of A (paid); a key so her own wallet can send a user operation
    address bob = makeAddr("bob");       // owner of B (paid)
    address carol = makeAddr("carol");   // owner of Z (self-hosted, rate 0)
    address dave = makeAddr("dave");     // receives A by transfer
    uint256 constant OPA_PK = 0xA11CE01;
    uint256 constant OPB_PK = 0xB0B0B02;
    uint256 constant OPC_PK = 0xCA401C3;
    address opA; address opB; address opC;
    bytes32 encA; bytes32 encB; bytes32 encC;
    bytes32 A; bytes32 B; bytes32 Z;

    // op gas profile (within the limits below)
    uint256 constant VER_GAS = 100_000;
    uint256 constant CALL_GAS = 200_000;
    uint256 constant PVG = 60_000;
    uint256 constant PM_VER_GAS = 300_000;
    uint256 constant POSTOP_GAS = 100_000;
    uint256 constant MAX_FEE = 1e8;          // 0.1 gwei
    uint256 constant PRIORITY = 1e6;         // 0.001 gwei
    uint256 constant BASEFEE = 1e7;          // 0.01 gwei

    function setUp() public {
        vm.chainId(8453);
        vm.warp(T0);
        vm.fee(BASEFEE);
        _etchAA();

        usdc = new MockUSDC();
        feed = new MockFeed();
        feed.set(3000e8, T0);
        registry = new EnclaveRegistry();
        ledger = new EnclaveDeployments(address(usdc), payout, address(registry), address(feed));

        opA = vm.addr(OPA_PK); opB = vm.addr(OPB_PK); opC = vm.addr(OPC_PK);
        encA = _register(opA, "https://host-a.lease-gas.test", 1000);
        encB = _register(opB, "https://host-b.lease-gas.test", 1000);
        encC = _register(opC, "https://host-c.lease-gas.test", 1000);
        vm.prank(carol); registry.setPayoutWallet(encC);   // carol's own box: her app runs free there (rate 0)

        A = _create(alice, 6_000_000);
        B = _create(bob, 6_000_000);
        Z = _create(carol, 0);

        pm = new PM(IEntryPointLease(EP), ILedgerLease(address(ledger)), IRegistryLease(address(registry)),
                    IERC20Lease(address(usdc)), S7702, EPOCH, IFeedLease(address(feed)), 3600, 1000e8, 10_000e8, _limits());
        vm.deal(address(this), 10 ether);
        pm.addStake{value: 1 ether}(86400);          // STO-031/033 need a staked paymaster in the canonical mempool
        vm.deal(sponsor, 1 ether);
        vm.prank(sponsor); pm.sponsorDeposit{value: 0.05 ether}();

        _budget(alice, A, 2_000_000);
        _budget(bob, B, 2_000_000);
        _budget(carol, Z, 2_000_000);

        assertEq(opA.balance + opB.balance + opC.balance, 0, "operators hold no ETH");
    }

    // =============================================================================================================
    // helpers
    // =============================================================================================================

    function _etchAA() internal {
        string memory j = vm.readFile("fixtures/aa-code-base.json");
        bytes memory ep = vm.parseJsonBytes(j, ".contracts.entryPoint08.code");
        bytes memory acct = vm.parseJsonBytes(j, ".contracts.simple7702Account.code");
        bytes memory sc = vm.parseJsonBytes(j, ".contracts.senderCreator.code");
        address scAddr = vm.parseJsonAddress(j, ".contracts.senderCreator.address");
        assertEq(keccak256(ep), vm.parseJsonBytes32(j, ".contracts.entryPoint08.keccak256"));
        assertEq(keccak256(acct), vm.parseJsonBytes32(j, ".contracts.simple7702Account.keccak256"));
        assertEq(keccak256(ep), 0x28f989233f4ffb52e4b168fb74df5dfa52fe0f846141774f5abc56c5604d8e46, "pinned EntryPoint v0.8 runtime");
        assertEq(keccak256(acct), 0xcc7b633aef4b2543cb8f37522adf1a401f910f0f6b2430c1eecc11f401ccfcf3, "pinned Simple7702Account runtime");
        vm.etch(EP, ep);
        vm.etch(S7702, acct);
        vm.etch(scAddr, sc);
        assertEq(IEP08(EP).senderCreator(), scAddr);
    }

    function _limits() internal pure returns (PM.Limits memory l) {
        l = PM.Limits({maxFeePerGas: 2e8, maxPriorityFeePerGas: 5e7, maxVerificationGas: 150_000, minCallGas: 120_000,
            maxCallGas: 300_000, maxPreVerificationGas: 120_000, maxPaymasterVerificationGas: 400_000, minPostOpGas: 100_000,
            maxPostOpGas: 150_000, postOpChargeGas: 50_000, markupBps: 500, minRenewWindow: 60, maxRenewWindow: 900,
            minExtensionFloor: 60, maxFailures: 2});
    }

    function _register(address op, string memory endpoint, uint64 price) internal returns (bytes32) {
        return _register(op, endpoint, price, address(0xBEEF));
    }
    function _register(address op, string memory endpoint, uint64 price, address proofKey) internal returns (bytes32 id) {
        vm.prank(op);   // registration itself is the existing EnclaveHostPaymaster's job; gas price 0 here, no ETH used
        id = registry.register(endpoint, "EnclaveHost/enclave", bytes32(0), price, 0, proofKey);
    }

    function _create(address owner_, uint256 fund6) internal returns (bytes32 id) {
        vm.prank(owner_);
        id = ledger.create("catalog://app/0", 0, 500, 8080, "", true, "", address(0), 0, 1000);
        if (fund6 > 0) {
            usdc.mint(owner_, fund6);
            vm.prank(owner_); usdc.approve(address(ledger), fund6);
            vm.prank(owner_); ledger.fund(id, fund6);
        }
    }

    function _budget(address owner_, bytes32 id, uint256 amount6) internal {
        usdc.mint(owner_, amount6);
        vm.prank(owner_); usdc.approve(address(pm), type(uint256).max);
        vm.prank(owner_); pm.fundBudget(id, amount6);
        vm.prank(owner_); pm.configureBudget(id, true, 500_000, 2_000_000, 300, 600);
    }

    function _avail(address owner_, bytes32 id) internal view returns (uint256) {
        return pm.budgetOf(id, owner_).balance6;
    }

    function _epoch() internal view returns (uint32) { return uint32(block.timestamp / EPOCH); }
    function _feedNow() internal { feed.set(3000e8, block.timestamp); }

    function _claimCall(bytes32 id, bytes32 enc) internal view returns (bytes memory) {
        return abi.encodeWithSignature("execute(address,uint256,bytes)", address(ledger), uint256(0),
                                       abi.encodeWithSignature("claim(bytes32,bytes32)", id, enc));
    }
    function _renewCall(bytes32 id) internal view returns (bytes memory) {
        return abi.encodeWithSignature("execute(address,uint256,bytes)", address(ledger), uint256(0),
                                       abi.encodeWithSignature("renew(bytes32)", id));
    }
    function _claimOp(uint256 pk, bytes32 id, bytes32 enc) internal view returns (PM.PackedUserOperation memory) {
        return _op(pk, _claimCall(id, enc), uint192(uint256(id) >> 64), sponsor, _epoch());
    }
    function _renewOp(uint256 pk, bytes32 id) internal view returns (PM.PackedUserOperation memory) {
        return _op(pk, _renewCall(id), uint192(uint256(id) >> 64), sponsor, _epoch());
    }
    function _op(uint256 pk, bytes memory callData, uint192 key, address sp, uint32 epoch) internal view returns (PM.PackedUserOperation memory) {
        return _opGas(pk, callData, key, sp, epoch, CALL_GAS);
    }
    /// One operation per deployment uses its own EntryPoint nonce key (2D nonces), so a host's ops for different
    /// deployments never queue behind each other.
    function _opGas(uint256 pk, bytes memory callData, uint192 key, address sp, uint32 epoch, uint256 callGas)
        internal view returns (PM.PackedUserOperation memory op)
    {
        address sender = vm.addr(pk);
        op.sender = sender;
        op.nonce = IEP08(EP).getNonce(sender, key);
        op.initCode = "";
        op.callData = callData;
        op.accountGasLimits = bytes32((VER_GAS << 128) | callGas);
        op.preVerificationGas = PVG;
        op.gasFees = bytes32((PRIORITY << 128) | MAX_FEE);
        op.paymasterAndData = abi.encodePacked(address(pm), uint128(PM_VER_GAS), uint128(POSTOP_GAS), sp, epoch);
        bytes32 h = IEP08(EP).getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, h);   // Simple7702Account: ECDSA over the userOpHash itself
        op.signature = abi.encodePacked(r, s, v);
    }
    function _maxCost(PM.PackedUserOperation memory op) internal pure returns (uint256) {
        return (VER_GAS + uint128(uint256(op.accountGasLimits)) + PVG + PM_VER_GAS + POSTOP_GAS) * MAX_FEE;
    }
    function _oneCall(address t, bytes memory d) internal pure returns (Call[] memory c) { c = new Call[](1); c[0] = Call(t, 0, d); }
    struct Call { address target; uint256 value; bytes data; }

    function _delegate(uint256 pk) internal {
        if (vm.addr(pk).code.length != 0) return;
        vm.signAndAttachDelegation(S7702, pk);
        (bool s,) = address(0).call("");
        s;
    }

    function _handle(PM.PackedUserOperation memory op, uint256 pk, bool attach) internal {
        PM.PackedUserOperation[] memory ops = new PM.PackedUserOperation[](1);
        ops[0] = op;
        if (attach && vm.addr(pk).code.length == 0) vm.signAndAttachDelegation(S7702, pk);
        vm.prank(bundler, bundler);
        IEP08(EP).handleOps(ops, payable(bundler));
    }

    function _expectEp(PM.PackedUserOperation memory op, string memory reason) internal {
        PM.PackedUserOperation[] memory ops = new PM.PackedUserOperation[](1);
        ops[0] = op;
        if (op.sender.code.length == 0) { _delegateAddr(op.sender); }
        vm.prank(bundler, bundler);
        vm.expectRevert(abi.encodeWithSelector(IEP08.FailedOp.selector, 0, reason));
        IEP08(EP).handleOps(ops, payable(bundler));
    }

    function _expectPm(PM.PackedUserOperation memory op, string memory reason) internal {
        PM.PackedUserOperation[] memory ops = new PM.PackedUserOperation[](1);
        ops[0] = op;
        if (op.sender.code.length == 0) { _delegateAddr(op.sender); }
        vm.prank(bundler, bundler);
        vm.expectRevert(abi.encodeWithSelector(IEP08.FailedOpWithRevert.selector, 0, "AA33 reverted",
                                               abi.encodeWithSignature("Error(string)", reason)));
        IEP08(EP).handleOps(ops, payable(bundler));
    }

    function _delegateAddr(address a) internal {
        if (a == opA) _delegate(OPA_PK); else if (a == opB) _delegate(OPB_PK); else if (a == opC) _delegate(OPC_PK);
    }

    function _selfPaidOp(uint256 pk, bytes memory callData) internal view returns (PM.PackedUserOperation memory op) {
        address sender = vm.addr(pk);
        op.sender = sender;
        op.nonce = IEP08(EP).getNonce(sender, 0);
        op.callData = callData;
        op.accountGasLimits = bytes32((VER_GAS << 128) | CALL_GAS);
        op.preVerificationGas = PVG;
        op.gasFees = bytes32((PRIORITY << 128) | MAX_FEE);
        op.paymasterAndData = "";
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, IEP08(EP).getUserOpHash(op));
        op.signature = abi.encodePacked(r, s, v);
    }

    function _succeeded(Vm.Log[] memory logs, address sender) internal pure returns (bool success) {
        bool found;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == EP && logs[i].topics[0] == USEROP_EVENT && address(uint160(uint256(logs[i].topics[2]))) == sender) {
                (, success,,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
                found = true;
            }
        }
        require(found, "no UserOperationEvent for sender");
    }

    function _opEvent() internal returns (bool success, uint256 actualGasCost) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == EP && logs[i].topics[0] == USEROP_EVENT) {
                (, success, actualGasCost,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
            }
        }
    }
}

/// Lifecycle, time conditions, call shape and authorization (real EntryPoint unless named test_mocked_).
contract LeaseGasCoreTest is LeaseGasBase {
    // =============================================================================================================
    // the happy path: a host with NO ETH claims and renews; the app's budget pays
    // =============================================================================================================

    function test_zeroEthHost_claimsAndRenews_appBudgetPays() public {
        uint256 b0 = _avail(alice, A);
        uint256 dep0 = IEP08(EP).balanceOf(address(pm));
        (uint128 sEth0,,) = pm.sponsors(sponsor);
        uint256 bundler0 = bundler.balance;

        // claim: the 7702 authorization rides in the bundler's transaction; the operator never pays anything
        PM.PackedUserOperation memory op = _claimOp(OPA_PK, A, encA);
        (PM.Status st,,) = pm.statusOf(A, _maxCost(op));
        assertEq(uint8(st), uint8(PM.Status.Ready), "Ready for this operation");
        vm.recordLogs();
        _handle(op, OPA_PK, true);
        (bool ok, uint256 actualGasCost) = _opEvent();
        assertTrue(ok, "claim succeeded");
        assertEq(opA.code, abi.encodePacked(hex"ef0100", S7702), "operator delegated to Simple7702Account by its own authorization");
        assertEq(opA.balance, 0, "operator still holds no ETH");
        EnclaveDeployments.Deployment memory d = ledger.get(A);
        assertEq(d.runner, encA); assertEq(d.runnerOperator, opA);
        assertEq(d.leaseUntil, T0 + 1800);

        uint256 charged6 = b0 - _avail(alice, A);
        (uint128 sEth1, uint128 earned1,) = pm.sponsors(sponsor);
        uint256 sRes1 = pm.sponsorReservedNow(sponsor);
        uint256 debitWei = sEth0 - sEth1;
        uint256 depDrop = dep0 - IEP08(EP).balanceOf(address(pm));
        assertGt(charged6, 0, "the app paid");
        assertEq(earned1, charged6, "exactly what the app paid reimburses the sponsor");
        assertEq(sRes1, 0, "nothing left reserved");
        assertEq(bundler.balance - bundler0, depDrop, "the EntryPoint repaid the bundler from the deposit");
        assertGe(debitWei, depDrop, "the sponsor is debited at least what the EntryPoint took (solvent)");
        assertEq(charged6, pm.toUsdc(debitWei, 3000e8), "the app pays the sponsor's debit at the oracle price + markup");
        assertGe(IEP08(EP).balanceOf(address(pm)), pm.totalSponsorEth(), "deposit covers every sponsor's tracked ETH");
        emit log_named_uint("claim actualGasCost (wei, UserOperationEvent total)", actualGasCost);
        emit log_named_uint("claim EntryPoint deposit drop (wei)", depDrop);
        emit log_named_uint("claim sponsor debit = app charge basis (wei)", debitWei);
        emit log_named_uint("claim app charge (USDC 6dp)", charged6);

        // renew inside the owner's 300 s window: no authorization needed any more
        vm.warp(d.leaseUntil - 200);
        _feedNow();
        uint256 b1 = _avail(alice, A);
        dep0 = IEP08(EP).balanceOf(address(pm));
        sEth0 = sEth1;
        vm.recordLogs();
        _handle(_renewOp(OPA_PK, A), OPA_PK, false);
        (ok, actualGasCost) = _opEvent();
        assertTrue(ok, "renew succeeded");
        assertEq(ledger.get(A).leaseUntil, T0 + 3600, "a paid renew extends from leaseUntil by a full quantum");
        uint256 charged6r = b1 - _avail(alice, A);
        (sEth1,,) = pm.sponsors(sponsor);
        depDrop = dep0 - IEP08(EP).balanceOf(address(pm));
        assertGt(charged6r, 0);
        assertGe(sEth0 - sEth1, depDrop);
        emit log_named_uint("renew EntryPoint deposit drop (wei)", depDrop);
        emit log_named_uint("renew sponsor debit (wei)", sEth0 - sEth1);
        emit log_named_uint("renew app charge (USDC 6dp)", charged6r);
        assertEq(opA.balance, 0);
        assertEq(pm.failures(A, opA), 0);
    }

    // =============================================================================================================
    // time conditions are the EntryPoint's (validAfter / validUntil): premature, expired, stale price, epoch
    // =============================================================================================================

    function test_renewOutsideWindow_refusedByEntryPoint_budgetUntouched() public {
        _handle(_claimOp(OPA_PK, A, encA), OPA_PK, true);
        uint256 lu = ledger.get(A).leaseUntil;
        uint256 b0 = _avail(alice, A);
        vm.warp(lu - 400); _feedNow();                                    // window is 300 s
        _expectEp(_renewOp(OPA_PK, A), "AA32 paymaster expired or not due");
        vm.warp(lu + 1); _feedNow();                                      // the lease lapsed: renew is gone, claim again
        _expectPm(_renewOp(OPA_PK, A), "no valid window");                // [updatedAt, leaseUntil] is empty now
        assertEq(_avail(alice, A), b0, "refused operations charge nothing");
        _handle(_claimOp(OPA_PK, A, encA), OPA_PK, false);
        assertEq(ledger.get(A).runnerOperator, opA);
    }

    function test_selfHostedZeroRate_renewSpamBounded() public {
        _handle(_claimOp(OPC_PK, Z, encC), OPC_PK, true);
        EnclaveDeployments.Deployment memory d = ledger.get(Z);
        assertEq(d.rate, 0, "self-hosted: free on the ledger");
        // the ledger itself would accept renew every block (one quantum from NOW); the paymaster only inside the window
        _expectEp(_renewOp(OPC_PK, Z), "AA32 paymaster expired or not due");
        vm.warp(d.leaseUntil - 100); _feedNow();
        _handle(_renewOp(OPC_PK, Z), OPC_PK, false);
        uint256 lu2 = ledger.get(Z).leaseUntil;
        assertEq(lu2, block.timestamp + 1800);
        _expectEp(_renewOp(OPC_PK, Z), "AA32 paymaster expired or not due");   // again right away: not due
        vm.warp(lu2 - 299); _feedNow();
        _handle(_renewOp(OPC_PK, Z), OPC_PK, false);                          // next window: one more
    }

    function test_stalePrice_and_priceBounds() public {
        vm.warp(T0 + 3601);                                // feed last updated at T0, max age 3600
        _expectEp(_claimOp(OPA_PK, A, encA), "AA32 paymaster expired or not due");
        feed.set(50e8, block.timestamp);                   // outside [1000, 10000] USD
        _expectPm(_claimOp(OPA_PK, A, encA), "price bounds");
        feed.set(3000e8, block.timestamp);
        feed.setIncomplete();                              // answeredInRound < roundId
        _expectPm(_claimOp(OPA_PK, A, encA), "price");
        feed.set(3000e8, block.timestamp);
        _handle(_claimOp(OPA_PK, A, encA), OPA_PK, true);
    }

    /// Root review: the ledger's claim needs block.timestamp > leaseUntil; the EntryPoint accepts only
    /// block.timestamp > validAfter. validAfter = leaseUntil is therefore exact: refused AT leaseUntil, valid one second later.
    function test_claimBoundary_exactlyAtLeaseUntil_refused_oneSecondLater_valid() public {
        _handle(_claimOp(OPA_PK, A, encA), OPA_PK, true);
        uint256 lu = ledger.get(A).leaseUntil;
        vm.warp(lu); _feedNow();
        _delegate(OPB_PK);
        _expectEp(_claimOp(OPB_PK, A, encB), "AA32 paymaster expired or not due");
        vm.prank(opB); vm.expectRevert(bytes("leased")); ledger.claim(A, encB);   // the deployed rule agrees
        vm.warp(lu + 1); _feedNow();
        _handle(_claimOp(OPB_PK, A, encB), OPB_PK, false);
        assertEq(ledger.get(A).runnerOperator, opB);
    }

    /// Root review: a feed reporting a FUTURE updatedAt must not stretch freshness. The operation becomes valid only
    /// from updatedAt and stays valid until updatedAt + feedMaxAge.
    function test_futureOracleTimestamp_notValidBeforeIt() public {
        uint256 future = vm.getBlockTimestamp() + 1800;
        feed.set(3000e8, future);
        _expectEp(_claimOp(OPA_PK, A, encA), "AA32 paymaster expired or not due");
        (PM.Status st,,) = pm.statusOf(A, 0);
        assertEq(uint8(st), uint8(PM.Status.PriceUnavailable), "status says so too");
        vm.warp(future); feed.set(3000e8, future);
        _handle(_claimOp(OPA_PK, A, encA), OPA_PK, true);
    }

    function test_epochMustBeCurrent() public {
        uint32 e = uint32(block.timestamp / EPOCH);
        _expectEp(_op(OPA_PK, _claimCall(A, encA), 1, sponsor, e + 1), "AA32 paymaster expired or not due");  // a future epoch
        _expectPm(_op(OPA_PK, _claimCall(A, encA), 1, sponsor, e - 1), "no valid window");   // a past one: empty window, refused in validation
    }

    function test_proofCutover_claimWithoutProofKey() public {
        bytes32 encN = _register(opB, "https://host-noproof.lease-gas.test", 1000, address(0));
        uint64 prf = ledger.proofRequiredFrom();
        assertGt(prf, block.timestamp);
        _handle(_claimOp(OPB_PK, A, encN), OPB_PK, true);   // before the cutover: fine
        vm.warp(prf + 1); _feedNow();
        _handle(_claimOp(OPB_PK, B, encB), OPB_PK, false);  // a proof-keyed enclave still can (A's lease lapsed long ago)
        // the ledger would revert "no proof key": the paymaster's window for this claim ended at the cutover, so it
        // refuses in validation (nothing reserved, nothing charged)
        _expectPm(_claimOp(OPB_PK, A, encN), "no valid window");
    }

    // =============================================================================================================
    // who and what: operator, runner, exact call, delegation
    // =============================================================================================================

    function test_unauthorizedOperator_claimAndRenew() public {
        _expectPm(_claimOp(OPB_PK, A, encA), "not runner");          // opB is not encA's registry operator
        _handle(_claimOp(OPA_PK, A, encA), OPA_PK, true);
        vm.warp(ledger.get(A).leaseUntil - 100); _feedNow();
        _delegate(OPB_PK);
        _expectPm(_renewOp(OPB_PK, A), "not runner");                // not the current runner
    }

    function test_onlyTheExactLeaseCall() public {
        _delegate(OPA_PK);
        bytes memory rel = abi.encodeWithSignature("release(bytes32)", A);
        _expectPm(_op(OPA_PK, abi.encodeWithSignature("execute(address,uint256,bytes)", address(ledger), 0, rel), 1, sponsor, _epoch()), "!lease call");
        bytes memory claimData = abi.encodeWithSignature("claim(bytes32,bytes32)", A, encA);
        _expectPm(_op(OPA_PK, abi.encodeWithSignature("execute(address,uint256,bytes)", address(ledger), 1, claimData), 1, sponsor, _epoch()), "!canonical");
        _expectPm(_op(OPA_PK, abi.encodeWithSignature("execute(address,uint256,bytes)", address(usdc), 0, claimData), 1, sponsor, _epoch()), "!canonical");
        _expectPm(_op(OPA_PK, abi.encodePacked(_claimCall(A, encA), bytes1(0)), 1, sponsor, _epoch()), "!claim");
        bytes memory transferData = abi.encodeWithSignature("transfer(address,uint256)", opA, 1);
        _expectPm(_op(OPA_PK, abi.encodeWithSignature("execute(address,uint256,bytes)", address(usdc), 0, transferData), 1, sponsor, _epoch()), "!lease call");
        // a batch, even of one exact claim
        bytes memory batch = abi.encodeWithSignature("executeBatch((address,uint256,bytes)[])", _oneCall(address(ledger), claimData));
        _expectPm(_op(OPA_PK, batch, 1, sponsor, _epoch()), "!execute");
        // a non-canonical encoding of the right call (data offset moved)
        bytes memory dirty = abi.encodePacked(bytes4(0xb61d27f6), abi.encode(address(ledger), uint256(0), uint256(0x60)), uint256(68), claimData, bytes28(uint224(1)));
        assertEq(dirty.length, _claimCall(A, encA).length);
        _expectPm(_op(OPA_PK, dirty, 1, sponsor, _epoch()), "!canonical");   // same length and selector, non-zero padding
    }

    function test_senderMustBeDelegatedToSimple7702Account() public {
        RogueAccount rogue = new RogueAccount();
        vm.signAndAttachDelegation(address(rogue), OPA_PK);
        (bool s,) = address(0).call("");                   // the next call carries the authorization
        s;
        assertEq(opA.code, abi.encodePacked(hex"ef0100", address(rogue)));
        _expectPm(_claimOp(OPA_PK, A, encA), "!delegated");
    }

    function test_replayRefusedByNonce() public {
        PM.PackedUserOperation memory op = _claimOp(OPA_PK, A, encA);
        _handle(op, OPA_PK, true);
        vm.warp(ledger.get(A).leaseUntil + 1); _feedNow();
        _expectEp(op, "AA25 invalid account nonce");
    }
}

/// Money, ownership, concurrency, failures, funding and the mocked callbacks.
contract LeaseGasAdversarialTest is LeaseGasBase {
    // =============================================================================================================
    // money: per-app isolation, caps, insufficient budget, sponsors
    // =============================================================================================================

    function test_appA_cannotSpend_appB() public {
        vm.prank(bob); pm.configureBudget(B, false, 500_000, 2_000_000, 300, 600);   // B's owner turns sponsorship off
        uint256 a0 = _avail(alice, A);
        _expectPm(_claimOp(OPA_PK, B, encA), "budget disabled");     // A's money is not reachable through B's id
        assertEq(_avail(alice, A), a0);
        vm.prank(bob); pm.configureBudget(B, true, 500_000, 2_000_000, 300, 600);
        uint256 bb0 = _avail(bob, B);
        _handle(_claimOp(OPA_PK, B, encA), OPA_PK, true);
        assertLt(_avail(bob, B), bb0, "B pays for B");
        assertEq(_avail(alice, A), a0, "A untouched");
    }

    function test_overBudget_perOpCap_epochCap_insufficient() public {
        // per-op cap below the worst-case reservation
        vm.prank(alice); pm.configureBudget(A, true, 1_000, 1_000_000, 300, 600);
        _expectPm(_claimOp(OPA_PK, A, encA), "over per-op cap");
        (PM.Status st,, uint256 need6) = pm.statusOf(A, 0);
        assertEq(uint8(st), uint8(PM.Status.InsufficientBudget));
        emit log_named_uint("worst-case reservation at the limits (USDC 6dp)", need6);
        // epoch cap that admits exactly one operation
        PM.PackedUserOperation memory op = _claimOp(OPA_PK, A, encA);
        uint256 reserve = pm.toUsdc(_maxCost(op), 3000e8);
        vm.prank(alice); pm.configureBudget(A, true, uint64(reserve), uint64(reserve + 1), 300, 600);
        _handle(op, OPA_PK, true);
        vm.warp(ledger.get(A).leaseUntil - 100); _feedNow();
        assertEq(block.timestamp / EPOCH, T0 / EPOCH, "same epoch");
        _expectPm(_renewOp(OPA_PK, A), "over epoch cap");
        (st,,) = pm.statusOf(A, _maxCost(_renewOp(OPA_PK, A)));
        assertEq(uint8(st), uint8(PM.Status.EpochCapReached), "explicit epoch-cap state");
        // insufficient balance: withdraw all but a little
        vm.warp((block.timestamp / EPOCH + 1) * EPOCH + 1); _feedNow();
        vm.warp(ledger.get(A).leaseUntil + 1); _feedNow();
        uint256 avail = _avail(alice, A);
        vm.prank(alice); pm.withdrawBudget(A, avail - 10, alice);
        vm.prank(alice); pm.configureBudget(A, true, 500_000, 2_000_000, 300, 600);
        _expectPm(_claimOp(OPA_PK, A, encA), "insufficient budget");
        (st,,) = pm.statusOf(A, _maxCost(_claimOp(OPA_PK, A, encA)));
        assertEq(uint8(st), uint8(PM.Status.InsufficientBudget), "explicit insufficient-budget state");
    }

    function test_sponsorMustCoverMaxCost_andBeActive() public {
        address poor = makeAddr("poorSponsor");
        vm.deal(poor, 1 ether);
        vm.prank(poor); pm.sponsorDeposit{value: 1 gwei}();
        _delegate(OPA_PK);
        _expectPm(_op(OPA_PK, _claimCall(A, encA), 1, poor, _epoch()), "sponsor");
        vm.prank(sponsor); pm.sponsorSetActive(false);
        _expectPm(_claimOp(OPA_PK, A, encA), "sponsor");
        vm.prank(sponsor); pm.sponsorSetActive(true);
        _handle(_claimOp(OPA_PK, A, encA), OPA_PK, false);
    }

    function test_sponsorWithdrawsEarnedUsdcAndUnreservedEth() public {
        _handle(_claimOp(OPA_PK, A, encA), OPA_PK, true);
        (uint128 eth, uint128 earned,) = pm.sponsors(sponsor);
        assertEq(pm.sponsorReservedNow(sponsor), 0);
        address payable to = payable(makeAddr("sponsorTreasury"));
        vm.prank(sponsor); pm.sponsorWithdraw(eth, earned, to);
        assertEq(to.balance, eth); assertEq(usdc.balanceOf(to), earned);
        vm.prank(sponsor); vm.expectRevert(bytes("reserved or short")); pm.sponsorWithdraw(1, 0, to);
    }

    // =============================================================================================================
    // ownership: transfer, retirement/migration, admin cannot take budgets
    // =============================================================================================================

    function test_transfer_oldOwnersBudgetNeverCharged_andStaysWithdrawable() public {
        // the live ledger refuses transferDeployment while the owner's OWN escrow is live ("refund first"), so this
        // deployment is funded by a third party (fundFor with another payer), which the ledger lets its owner transfer
        vm.prank(alice); bytes32 T = ledger.create("catalog://app/0", 0, 500, 8080, "", true, "", address(0), 0, 1000);
        address gifter = makeAddr("gifter");
        usdc.mint(gifter, 6_000_000);
        vm.prank(gifter); usdc.approve(address(ledger), 6_000_000);
        vm.prank(gifter); ledger.fundFor(T, 6_000_000, gifter);
        _budget(alice, T, 2_000_000);
        _transferFlow(T);
    }

    function _transferFlow(bytes32 T) internal {
        _handle(_claimOp(OPA_PK, T, encA), OPA_PK, true);
        uint256 aliceAvail = _avail(alice, T);
        vm.prank(alice); ledger.transferDeployment(T, dave);
        vm.warp(ledger.get(T).leaseUntil - 100); _feedNow();
        _expectPm(_renewOp(OPA_PK, T), "budget disabled");             // dave has not authorized anything
        assertEq(_avail(alice, T), aliceAvail, "alice's budget is not charged for dave's lease");
        vm.prank(dave); vm.expectRevert(bytes("reserved or short")); pm.withdrawBudget(T, 1, dave);
        vm.prank(alice); vm.expectRevert(bytes("!owner")); pm.configureBudget(T, true, 500_000, 2_000_000, 300, 600);
        _budget(dave, T, 1_000_000);
        _handle(_renewOp(OPA_PK, T), OPA_PK, false);
        assertLt(_avail(dave, T), 1_000_000, "dave pays for dave's lease");
        assertEq(_avail(alice, T), aliceAvail);
        vm.prank(alice); pm.withdrawBudget(T, aliceAvail, alice);
        assertEq(_avail(alice, T), 0);
    }

    function test_retiredLedger_noSponsorship_budgetsWithdrawable() public {
        ledger.retire();                                                  // this test contract deployed the ledger: its admin
        _expectPm(_claimOp(OPA_PK, A, encA), "inactive");
        uint256 avail = _avail(alice, A);
        uint256 bal0 = usdc.balanceOf(alice);
        vm.prank(alice); pm.withdrawBudget(A, avail, alice);
        assertEq(usdc.balanceOf(alice) - bal0, avail, "the whole budget comes back after a migration");
    }

    function test_adminModeration_andNoAccessToFunds() public {
        pm.setPaused(true);
        _expectPm(_claimOp(OPA_PK, A, encA), "paused");
        pm.setPaused(false);
        pm.setBlockedDeployment(A, true);
        _expectPm(_claimOp(OPA_PK, A, encA), "blocked");
        pm.setBlockedDeployment(A, false);
        pm.setBlockedOperator(opA, true);
        _expectPm(_claimOp(OPA_PK, A, encA), "blocked");
        pm.setBlockedOperator(opA, false);
        // the admin has no budget of A and cannot touch alice's or the sponsor's money
        vm.expectRevert(bytes("reserved or short")); pm.withdrawBudget(A, 1, address(this));
        vm.expectRevert(bytes("reserved or short")); pm.sponsorWithdraw(1, 0, payable(address(this)));
        vm.expectRevert(bytes("none")); pm.sweepSurplus(payable(address(this)));   // nothing above tracked sponsor ETH yet
        // outsiders cannot govern
        vm.prank(dave); vm.expectRevert(bytes("!owner")); pm.setPaused(true);
        vm.prank(dave); vm.expectRevert(bytes("!owner")); pm.setBlockedOperator(opA, true);
        // limits are bounded by hard ceilings
        PM.Limits memory l = _limits(); l.markupBps = 2001;
        vm.expectRevert(bytes("ceiling")); pm.setLimits(l);
        vm.expectRevert(bytes("feed")); pm.setFeed(IFeedLease(address(feed)), 3600, 1000e8, 1e16);   // price ceiling bounded
        // after an operation the conservative charge leaves a surplus; sweeping it never touches tracked sponsor ETH
        _handle(_claimOp(OPA_PK, A, encA), OPA_PK, true);
        uint256 tracked = pm.totalSponsorEth();
        assertGe(IEP08(EP).balanceOf(address(pm)), tracked, "solvent");
        if (IEP08(EP).balanceOf(address(pm)) > tracked) {
            pm.sweepSurplus(payable(makeAddr("treasury")));
            assertEq(IEP08(EP).balanceOf(address(pm)), tracked, "only the surplus left");
        }
    }

    // =============================================================================================================
    // concurrency, reverted operations, failure breaker
    // =============================================================================================================

    function test_oneInFlightPerDeployment_perBundle() public {
        _delegate(OPA_PK); _delegate(OPB_PK);
        PM.PackedUserOperation[] memory ops = new PM.PackedUserOperation[](2);
        ops[0] = _claimOp(OPA_PK, A, encA);
        ops[1] = _claimOp(OPB_PK, A, encB);                               // a racing claim of the SAME deployment
        vm.prank(bundler, bundler);
        vm.expectRevert(abi.encodeWithSelector(IEP08.FailedOpWithRevert.selector, 1, "AA33 reverted", abi.encodeWithSignature("Error(string)", "in flight")));
        IEP08(EP).handleOps(ops, payable(bundler));
        // different deployments in one bundle: both go through, each on its own budget, one sponsor reserved twice
        ops[1] = _claimOp(OPB_PK, B, encB);
        uint256 a0 = _avail(alice, A); uint256 b0 = _avail(bob, B);
        vm.prank(bundler, bundler);
        IEP08(EP).handleOps(ops, payable(bundler));
        assertEq(ledger.get(A).runnerOperator, opA); assertEq(ledger.get(B).runnerOperator, opB);
        assertLt(_avail(alice, A), a0); assertLt(_avail(bob, B), b0);
        assertEq(pm.sponsorReservedNow(sponsor), 0);
    }

    /// Real EntryPoint: one bundle [alice's own self-paid operation emptying her budget, opA's sponsored claim]. All
    /// validations run before all executions, so the claim's reservation already holds when alice's withdrawal
    /// executes: the withdrawal reverts (alice's operation fails, she keeps her USDC in the budget), the claim settles.
    function test_bundle_ownersOwnOperationCannotWithdrawReservedBudget() public {
        _delegate(OPA_PK);
        vm.deal(alice, 1 ether);                                   // alice pays for HER operation herself
        vm.signAndAttachDelegation(S7702, ALICE_PK);
        (bool s0,) = address(0).call(""); s0;
        uint256 bal = pm.budgetOf(A, alice).balance6;
        uint256 aliceUsdc = usdc.balanceOf(alice);
        PM.PackedUserOperation[] memory ops = new PM.PackedUserOperation[](2);
        ops[0] = _selfPaidOp(ALICE_PK, abi.encodeWithSignature("execute(address,uint256,bytes)", address(pm), uint256(0),
                             abi.encodeWithSignature("withdrawBudget(bytes32,uint256,address)", A, bal, alice)));
        ops[1] = _claimOp(OPA_PK, A, encA);
        vm.recordLogs();
        vm.prank(bundler, bundler);
        IEP08(EP).handleOps(ops, payable(bundler));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertFalse(_succeeded(logs, alice), "the withdrawal of reserved budget reverted");
        assertTrue(_succeeded(logs, opA), "the sponsored claim went through");
        assertEq(usdc.balanceOf(alice), aliceUsdc, "nothing was withdrawn");
        assertLt(pm.budgetOf(A, alice).balance6, bal, "the claim was charged");
        assertEq(pm.reservedNow(A, alice), 0);
        assertEq(ledger.get(A).runnerOperator, opA);
    }

    function test_claimRaceAcrossBundles_loserNotCharged() public {
        _delegate(OPB_PK);
        PM.PackedUserOperation memory loser = _claimOp(OPB_PK, A, encB);   // built and signed before the winner lands
        _handle(_claimOp(OPA_PK, A, encA), OPA_PK, true);
        uint256 a0 = _avail(alice, A);
        _expectEp(loser, "AA32 paymaster expired or not due");             // the lease is live now: not due
        assertEq(_avail(alice, A), a0, "the losing claim costs the app nothing (its bundler pays)");
    }

    function test_revertedOperation_charged_unreserved_breakerCutsOperatorOff() public {
        PM.Limits memory l = _limits(); l.minCallGas = 20_000;          // admin allows a tiny call gas for this test only
        pm.setLimits(l);
        _delegate(OPA_PK);
        for (uint256 i; i < 2; i++) {
            uint256 a0 = _avail(alice, A);
            uint256 dep0 = IEP08(EP).balanceOf(address(pm));
            (uint128 e0,,) = pm.sponsors(sponsor);
            vm.recordLogs();
            _handle(_opGas(OPA_PK, _claimCall(A, encA), 1, sponsor, _epoch(), 25_000), OPA_PK, false);   // runs out of gas in claim()
            (bool ok,) = _opEvent();
            (uint128 e1,,) = pm.sponsors(sponsor);
            assertGe(e0 - e1, dep0 - IEP08(EP).balanceOf(address(pm)), "revert path: sponsor debit covers what the EntryPoint took");
            assertFalse(ok, "the claim reverted");
            assertLt(_avail(alice, A), a0, "a reverted operation still cost gas, and is charged");
            assertEq(pm.reservedNow(A, alice), 0, "its reservation released");
            assertEq(pm.failures(A, opA), i + 1);
        }
        _expectPm(_claimOp(OPA_PK, A, encA), "operator failures");          // cut off for this deployment
        vm.prank(dave); vm.expectRevert(bytes("!owner")); pm.resetFailures(A, opA);
        vm.prank(alice); pm.resetFailures(A, opA);
        _handle(_claimOp(OPA_PK, A, encA), OPA_PK, false);
        assertEq(ledger.get(A).runnerOperator, opA);
    }

    function test_minimumExtension_lowBalancePaidLease() public {
        bytes32 L = _create(alice, 500 * 300);                   // 300 s of funding at 500/s
        usdc.mint(alice, 1_000_000);
        vm.prank(alice); usdc.approve(address(pm), type(uint256).max);
        vm.prank(alice); pm.fundBudget(L, 1_000_000);
        vm.prank(alice); pm.configureBudget(L, true, 500_000, 2_000_000, 300, 600);
        _expectPm(_claimOp(OPA_PK, L, encA), "extension too short");
        vm.prank(alice); pm.configureBudget(L, true, 500_000, 2_000_000, 300, 300);
        _handle(_claimOp(OPA_PK, L, encA), OPA_PK, true);
        assertEq(ledger.get(L).leaseUntil, block.timestamp + 300);
    }

    function test_statusTruthful_unknown_inactive_stalePrice() public {
        (PM.Status st,,) = pm.statusOf(keccak256("no such deployment"), 0);
        assertEq(uint8(st), uint8(PM.Status.Unknown), "an unknown id answers Unknown (no revert)");
        vm.prank(alice); ledger.setActive(A, false);
        (st,,) = pm.statusOf(A, 0);
        assertEq(uint8(st), uint8(PM.Status.Inactive));
        vm.prank(alice); ledger.setActive(A, true);
        vm.warp(vm.getBlockTimestamp() + 3601);                    // the feed's last update is now older than feedMaxAge
        (st,,) = pm.statusOf(A, 0);
        assertEq(uint8(st), uint8(PM.Status.PriceUnavailable), "a stale price is not Ready");
    }

    function test_overRateCap_refusedBeforeCharging() public {
        vm.prank(alice); ledger.setMaxRate(A, 400);              // encA would charge 500/s
        _expectPm(_claimOp(OPA_PK, A, encA), "over rate cap");
    }

    // =============================================================================================================
    // funding: the router splits ONE authorized top-up between the ledger (fundFor) and the gas budget
    // =============================================================================================================

    function test_fundBoth_computeThroughFundFor_gasToBudget() public {
        address gifter = makeAddr("gifter");
        usdc.mint(gifter, 5_000_000);
        vm.prank(gifter); usdc.approve(address(pm), type(uint256).max);
        uint256 bal0 = ledger.get(A).balance6;
        uint256 ref0 = ledger.refundableOf(A);
        uint256 g0 = _avail(alice, A);
        vm.prank(gifter); pm.fundBoth(A, 3_000_000, 1_000_000);
        assertEq(ledger.get(A).balance6 - bal0, 3_000_000, "compute credited on the ledger exactly as fund() would");
        assertEq(_avail(alice, A) - g0, 1_000_000, "gas budget credited to the owner of record");
        assertEq(usdc.balanceOf(address(pm)), _avail(alice, A) + _avail(bob, B) + _avail(carol, Z), "the paymaster holds only budgets");
        assertGe(ledger.refundableOf(A), ref0, "escrow attribution follows fundFor (payer = the funder)");
        // a non-owner cannot configure or withdraw what it gifted
        vm.prank(gifter); vm.expectRevert(bytes("!owner")); pm.configureBudget(A, true, 1, 1, 300, 600);
        vm.prank(gifter); vm.expectRevert(bytes("reserved or short")); pm.withdrawBudget(A, 1, gifter);
    }

    // =============================================================================================================
    // MOCKED callbacks (the paymaster called directly as the EntryPoint): the backstop and postOp robustness
    // =============================================================================================================

    function testFuzz_mocked_postOpNeverReverts(uint256 actualGasCost, uint256 fee, bool succeeded) public {
        _delegate(OPA_PK);
        PM.PackedUserOperation memory op = _claimOp(OPA_PK, A, encA);
        uint256 maxCost = _maxCost(op);
        vm.prank(EP); (bytes memory ctx,) = pm.validatePaymasterUserOp(op, bytes32(0), maxCost);
        assertGt(pm.reservedNow(A, alice), 0, "reserved for this transaction");
        assertEq(pm.sponsorReservedNow(sponsor), maxCost);
        actualGasCost = bound(actualGasCost, 0, maxCost * 4);
        fee = bound(fee, 0, MAX_FEE * 4);
        uint256 b0 = pm.budgetOf(A, alice).balance6;
        (uint128 eth0,,) = pm.sponsors(sponsor);
        vm.prank(EP);
        pm.postOp(succeeded ? PM.PostOpMode.opSucceeded : PM.PostOpMode.opReverted, ctx, actualGasCost, fee);
        uint256 charged = b0 - pm.budgetOf(A, alice).balance6;
        (uint128 eth1, uint128 earned1,) = pm.sponsors(sponsor);
        assertEq(pm.reservedNow(A, alice), 0); assertEq(pm.sponsorReservedNow(sponsor), 0);
        assertLe(charged, pm.toUsdc(maxCost, 3000e8), "never more than the reservation");
        assertLe(eth0 - eth1, maxCost, "the sponsor is never debited above maxCost");
        assertEq(earned1, charged, "the sponsor earns exactly what the app paid");
        assertEq(pm.epochSpent6(pm.budgetKey(A, alice), _epoch()), charged, "epoch spend = what was charged");
        assertEq(pm.failures(A, opA), succeeded ? 0 : 1);
    }

    /// The reservation also binds the budget owner and the sponsor within the transaction: a withdrawal between a
    /// sponsored operation's validation and its postOp (e.g. by another operation of the same bundle) is refused.
    function test_mocked_withdrawalsRespectInTransactionReservations() public {
        _delegate(OPA_PK);
        PM.PackedUserOperation memory op = _claimOp(OPA_PK, A, encA);
        uint256 maxCost = _maxCost(op);
        vm.prank(EP); (bytes memory ctx,) = pm.validatePaymasterUserOp(op, bytes32(0), maxCost);
        uint256 bal = pm.budgetOf(A, alice).balance6;
        uint256 res = pm.reservedNow(A, alice);
        vm.prank(alice); vm.expectRevert(bytes("reserved or short")); pm.withdrawBudget(A, bal, alice);
        vm.prank(alice); pm.withdrawBudget(A, bal - res, alice);          // the unreserved part is still free
        (uint128 eth,,) = pm.sponsors(sponsor);
        vm.prank(sponsor); vm.expectRevert(bytes("reserved or short")); pm.sponsorWithdraw(eth, 0, payable(sponsor));
        vm.prank(EP); pm.postOp(PM.PostOpMode.opSucceeded, ctx, 3e12, 1.1e7);   // and settlement still balances
        assertEq(pm.reservedNow(A, alice), 0);
    }

    /// Calibration evidence (mocked callbacks, cold slots: first touches in this test's transaction): the gas of the
    /// paymaster's validation and postOp and of the bare ledger calls, to size postOpChargeGas and the call gas limits.
    function test_mocked_measureGasProfile() public {
        _delegate(OPA_PK);
        PM.PackedUserOperation memory op = _claimOp(OPA_PK, A, encA);
        uint256 maxCost = _maxCost(op);
        uint256 g = gasleft();
        vm.prank(EP); (bytes memory ctx,) = pm.validatePaymasterUserOp(op, bytes32(0), maxCost);
        uint256 vGas = g - gasleft();
        g = gasleft();
        vm.prank(EP); pm.postOp(PM.PostOpMode.opSucceeded, ctx, 3e12, 1.1e7);
        uint256 pGas = g - gasleft();
        g = gasleft();
        vm.prank(opA); ledger.claim(A, encA);
        uint256 cGas = g - gasleft();
        vm.warp(ledger.get(A).leaseUntil - 100);
        g = gasleft();
        vm.prank(opA); ledger.renew(A);
        uint256 rGas = g - gasleft();
        // worst case: a REVERTED operation, first charge of an epoch, failure counter 0 -> 1 (deployment B, fresh slots)
        _delegate(OPB_PK);
        PM.PackedUserOperation memory opB_ = _claimOp(OPB_PK, B, encB);
        vm.prank(EP); (bytes memory ctxB,) = pm.validatePaymasterUserOp(opB_, bytes32(0), _maxCost(opB_));
        g = gasleft();
        vm.prank(EP); pm.postOp(PM.PostOpMode.opReverted, ctxB, 3e12, 1.1e7);
        uint256 pWorst = g - gasleft();
        emit log_named_uint("paymaster postOp gas, worst case (reverted, fresh epoch + failure slots)", pWorst);
        assertLe(pWorst, uint256(_limits().postOpChargeGas) + pm.POSTOP_FAILURE_EXTRA_GAS(), "the revert-path charge covers its postOp");
        assertLt(pWorst * 3 / 2, _limits().minPostOpGas, "the postOp gas floor is at least 1.5x the worst case");
        emit log_named_uint("paymaster validation gas (claim, cold)", vGas);
        emit log_named_uint("paymaster postOp gas (cold)", pGas);
        emit log_named_uint("bare ledger.claim gas", cGas);
        emit log_named_uint("bare ledger.renew gas", rGas);
        assertLt(vGas, PM_VER_GAS, "validation fits the paymaster verification gas used by the operations");
        assertLt(pGas, _limits().minPostOpGas, "postOp fits the minimum postOp gas: it cannot run out of gas");
    }

    /// Real EntryPoint: where is the unused CALL-gas penalty charged? Two identical
    /// renews, callGasLimit 80k vs 280k: pre-postOp cost = chargedWei - extraGas * fee (from LeaseGasCharged).
    function test_measure_noCallPenalty_postOpTail() public {
        PM.Limits memory l = _limits(); l.minCallGas = 60_000; pm.setLimits(l);
        _handle(_claimOp(OPA_PK, A, encA), OPA_PK, true);
        uint256[2] memory pre;
        uint256[2] memory taken;
        uint256[2] memory callGas = [uint256(80_000), uint256(280_000)];
        for (uint256 i; i < 2; i++) {
            vm.warp(ledger.get(A).leaseUntil - 100); _feedNow();
            uint256 dep0 = IEP08(EP).balanceOf(address(pm));
            vm.recordLogs();
            _handle(_opGas(OPA_PK, _renewCall(A), uint192(uint256(A) >> 64), sponsor, _epoch(), callGas[i]), OPA_PK, false);
            Vm.Log[] memory logs = vm.getRecordedLogs();
            for (uint256 k; k < logs.length; k++) if (logs[k].emitter == address(pm) && logs[k].topics[0] == keccak256("LeaseGasCharged(bytes32,address,address,address,uint8,bool,uint256,uint256)")) {
                (, , , uint256 chargedWei,) = abi.decode(logs[k].data, (address, uint8, bool, uint256, uint256));
                uint256 fee = BASEFEE + PRIORITY;
                uint256 extra = 50_000;   // _limits().postOpChargeGas: the whole extra (no penalty term)
                pre[i] = chargedWei / fee - extra;
            }
            taken[i] = (dep0 - IEP08(EP).balanceOf(address(pm))) / (BASEFEE + PRIORITY);
        }
        emit log_named_uint("renew pre-postOp gas (actualGasCost/fee), callGasLimit 80k", pre[0]);
        emit log_named_uint("renew pre-postOp gas (actualGasCost/fee), callGasLimit 280k", pre[1]);
        emit log_named_uint("renew gas the EntryPoint TOOK from the deposit, callGasLimit 80k", taken[0]);
        emit log_named_uint("renew gas the EntryPoint TOOK from the deposit, callGasLimit 280k", taken[1]);
        // FINDING (this EntryPoint v0.8 runtime, keccak 0x28f98923...): 200k MORE unused call gas changes neither the
        // actualGasCost postOp receives nor what the EntryPoint takes from the deposit (< 1k either way): no unused-gas
        // penalty is charged for this operation. What the deposit loses beyond actualGasCost is postOp plus the
        // EntryPoint's own tail (taken - pre), measured here.
        assertLt(pre[1] > pre[0] ? pre[1] - pre[0] : pre[0] - pre[1], 1_000, "no call penalty inside actualGasCost");
        assertLt(taken[1] > taken[0] ? taken[1] - taken[0] : taken[0] - taken[1], 1_000, "and none taken after postOp");
        emit log_named_uint("deposit taken beyond actualGasCost (postOp + EntryPoint tail), gas", taken[0] - pre[0]);
    }

    function test_mocked_onlyEntryPointMayCall() public {
        PM.PackedUserOperation memory op = _claimOp(OPA_PK, A, encA);
        vm.expectRevert(bytes("!entryPoint")); pm.validatePaymasterUserOp(op, bytes32(0), 1);
        vm.expectRevert(bytes("!entryPoint")); pm.postOp(PM.PostOpMode.opSucceeded, "", 0, 0);
    }
}
