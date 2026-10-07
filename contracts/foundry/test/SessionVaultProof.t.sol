// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { SessionRig } from "./SessionVault.t.sol";
import { SessionVaultLib, CreateArgs } from "../../SessionVault.sol";
import { IEnclaveRegistry } from "../../EnclaveDeployments.sol";
import { EnclaveProofOfTime } from "../../EnclaveProofOfTime.sol";

/// Same slot-0 layout as SessionRegistryStub, plus a proof key per enclave.
contract PoTRegistryStub {
    mapping(bytes32 => address) public operatorOf;
    mapping(bytes32 => address) public proofKeyOf;
    function set(bytes32 id, address operator) external { operatorOf[id] = operator; }
    function setProofKey(bytes32 id, address k) external { proofKeyOf[id] = k; }
    function get(bytes32 id) external view returns (IEnclaveRegistry.Enclave memory e) {
        e.operator = operatorOf[id];
        e.active = true;
        e.cpuPricePerSec6 = 834;
        e.gpuPricePerSec6 = 1667;
        e.proofKey = proofKeyOf[id];
    }
}

/// Sessions against the ledger in PROOF mode (production's default: a runner is paid only
/// for time it proves through EnclaveProofOfTime). The ledger credits a runner up to its last
/// proof before re-pricing a record, and pays the unproven stretch later at the CURRENT runner
/// rate - so no session action may raise the runner rate while a lease is attached (review 4).
contract SessionVaultProofTest is SessionRig {
    uint8 constant CREATE = 0; uint8 constant FUND = 1; uint8 constant SET_SHARES = 4;
    uint8 constant SET_MAXRATE = 5; uint8 constant SET_ACTIVE = 6;
    uint256 constant PROOF_PK = 0xB0B;
    EnclaveProofOfTime pot;
    address op;
    bytes32 enc;

    function setUp() public override {
        super.setUp();
        vm.etch(address(reg), address(new PoTRegistryStub()).code);
        pot = new EnclaveProofOfTime(address(ledger), address(reg));
        ledger.setProver(address(pot));
        ledger.setProofRequiredFrom(uint64(vm.getBlockTimestamp()));
        op = makeAddr("squatter-operator");
        enc = keccak256("squatter-enclave");
        PoTRegistryStub(address(reg)).set(enc, op);
        PoTRegistryStub(address(reg)).setProofKey(enc, vm.addr(PROOF_PK));
    }

    function _ca(uint256 fund6, uint256 rate) internal view returns (bytes memory) {
        return abi.encode(CreateArgs({ appRef: freeRef, gpuMilli: 0, cpuMilli: 1000, appPort: 8080, ports: "",
            isPublic: false, configCid: "", maxRate6: rate, env: 1, fund6: fund6 }));
    }

    /// a real checkpoint through EnclaveProofOfTime, anchored to the previous block
    function _prove(bytes32 id) internal returns (bool) {
        vm.roll(vm.getBlockNumber() + 1);
        uint64 ab = uint64(vm.getBlockNumber() - 1);
        bytes32 ah = keccak256(abi.encode("anchor", ab));
        vm.setBlockhash(ab, ah);
        uint64 upto = uint64(vm.getBlockTimestamp());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PROOF_PK, pot.proofDigest(id, enc, op, upto, ab, ah));
        try pot.checkpoint(id, enc, upto, ab, ah, abi.encodePacked(r, s, v)) { return true; } catch { return false; }
    }

    function _proveAll(bytes32 id) internal {
        uint64 end = ledger.get(id).leaseUntil;
        for (uint256 i = 0; i < 80 && ledger.provenUntil(id) < end; i++) {
            vm.warp(vm.getBlockTimestamp() + 900);
            _prove(id);
        }
    }

    /// the session creates + funds $10; the operator squats at a zero job rate for ~10 h,
    /// renewing for free and never proving (so nothing is credited)
    function _squat(bytes32 sid) internal returns (bytes32 id) {
        id = abi.decode(_exec(sid, 0, CREATE, _ca(10e6, 1000), 0), (bytes32));
        vm.startPrank(op);
        ledger.offerJobRate(id, enc, 0, uint64(vm.getBlockTimestamp() + 30 days));
        ledger.claim(id, enc);
        for (uint256 i = 0; i < 20; i++) { vm.warp(ledger.get(id).leaseUntil); ledger.renew(id); }
        vm.stopPrank();
        assertEq(ledger.get(id).rate, 0, "the tenant is charged nothing for the squat");
    }

    function test_resizeUnderALapsedSquatIsRefused() public {
        bytes32 sid = _openWithDeposit(_grant(keyHash, 50e6));
        bytes32 id = _squat(sid);
        vm.warp(ledger.get(id).leaseUntil + 1);                       // lapsed, still attached
        _execExpectRevert(sid, 1, SET_SHARES, abi.encode(id, uint16(0), uint16(1000)), 0,
            abi.encodeWithSelector(SessionVaultLib.LeaseUnsettled.selector, id));
        _execExpectRevert(sid, 1, SET_MAXRATE, abi.encode(id, uint256(900)), 0,
            abi.encodeWithSelector(SessionVaultLib.LeaseUnsettled.selector, id));
        _execExpectRevert(sid, 1, FUND, abi.encode(id, uint256(10e6)), 0,
            abi.encodeWithSelector(SessionVaultLib.FundRateTooLow.selector, 0, 0));
        _exec(sid, 1, SET_ACTIVE, abi.encode(id, false), 0);
        _proveAll(id);
        assertEq(ledger.earned6(op), 0, "the squatter proves its old lease and is paid nothing");
        assertEq(ledger.refundableOf(id), 8e6, "the escrow stays the owner's");
    }

    function test_resizeUnderALiveSquatIsRefused() public {
        // a resize off the job-rate shares sends the rate from 0 to the host's list price
        bytes32 sid = _openWithDeposit(_grant(keyHash, 50e6));
        bytes32 id = _squat(sid);
        assertGt(ledger.get(id).leaseUntil, vm.getBlockTimestamp(), "still live");
        _execExpectRevert(sid, 1, SET_SHARES, abi.encode(id, uint16(0), uint16(999)), 0,
            abi.encodeWithSelector(SessionVaultLib.LeaseUnsettled.selector, id));
        _exec(sid, 1, SET_ACTIVE, abi.encode(id, false), 0);
        _proveAll(id);
        assertEq(ledger.earned6(op), 0);
    }

    function test_resizeThatLowersTheRunnerRateUnderALeaseIsAllowed() public {
        bytes32 sid = _openWithDeposit(_grant(keyHash, 50e6));
        bytes32 id = abi.decode(_exec(sid, 0, CREATE, _ca(10e6, 1000), 0), (bytes32));
        vm.prank(op); ledger.claim(id, enc);                           // at the host's list price
        (uint256 rr0,,) = ledger.earnOf(id);
        _exec(sid, 1, SET_SHARES, abi.encode(id, uint16(0), uint16(500)), 0);   // a downsize
        (uint256 rr1,,) = ledger.earnOf(id);
        assertLt(rr1, rr0);
        // an upsize back is refused while the lease is attached ...
        _execExpectRevert(sid, 2, SET_SHARES, abi.encode(id, uint16(0), uint16(1000)), 0,
            abi.encodeWithSelector(SessionVaultLib.LeaseUnsettled.selector, id));
        // ... and allowed once the host has released
        vm.prank(op); ledger.release(id);
        _exec(sid, 2, SET_SHARES, abi.encode(id, uint16(0), uint16(1000)), 0);
        assertEq(ledger.get(id).cpuMilli, 1000);
    }
}
