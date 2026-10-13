// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Test, Vm } from "forge-std/Test.sol";
import { EnclaveKeyAttestations } from "../../EnclaveKeyAttestations.sol";
import { SessionVault, SessionVaultFactory, ISVToken, ISVBook, ISVRouter, ISVKeyAttestations }
    from "../../SessionVault.sol";
import { SessionRig } from "./SessionVault.t.sol";

/// The registry on its own: who may write, what a binding may never do, and
/// how governance moves.
contract EnclaveKeyAttestationsTest is Test {
    EnclaveKeyAttestations ka;
    address gov = makeAddr("gov");
    address attestor = makeAddr("attestor");
    address attestor2 = makeAddr("attestor2");
    address stranger = makeAddr("stranger");
    bytes32 constant K = keccak256("key");
    bytes32 constant M = keccak256("image-1");
    bytes32 constant M2 = keccak256("image-2");

    event OwnershipTransferStarted(address indexed owner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AttestorSet(address indexed attestor, bool enabled);
    event KeyAttested(bytes32 indexed keyHash, bytes32 indexed measurement, address indexed attestor);
    event KeyRevoked(bytes32 indexed keyHash, address indexed by);

    function setUp() public {
        vm.warp(1_800_000_000);
        ka = new EnclaveKeyAttestations(gov, attestor);
        vm.prank(gov);
        ka.setAttestor(attestor2, true);
    }

    function _binding(bytes32 k) internal view returns (bytes32 m, bool revoked) { return ka.bindingOf(k); }

    // ======================= construction =======================

    function test_constructorSetsOwnerAndOptionalAttestor() public {
        assertEq(ka.owner(), gov);
        assertEq(ka.pendingOwner(), address(0));
        assertTrue(ka.isAttestor(attestor));
        EnclaveKeyAttestations bare = new EnclaveKeyAttestations(gov, address(0));
        assertFalse(bare.isAttestor(address(0)), "zero is never named an attestor");
        vm.expectRevert(EnclaveKeyAttestations.ZeroAddress.selector);
        new EnclaveKeyAttestations(address(0), attestor);
    }

    function test_constructorEmits() public {
        vm.expectEmit(true, true, false, true);
        emit OwnershipTransferred(address(0), gov);
        vm.expectEmit(true, false, false, true);
        emit AttestorSet(attestor, true);
        new EnclaveKeyAttestations(gov, attestor);
    }

    // ======================= attest =======================

    function test_attestRecordsTheBinding() public {
        (bytes32 m0, bool r0) = _binding(K);
        assertEq(m0, bytes32(0), "unknown key: no measurement");
        assertFalse(r0);
        vm.expectEmit(true, true, true, true);
        emit KeyAttested(K, M, attestor);
        vm.prank(attestor);
        ka.attest(K, M);
        (bytes32 m, bool revoked) = _binding(K);
        assertEq(m, M);
        assertFalse(revoked);
        EnclaveKeyAttestations.Binding memory b = ka.getBinding(K);
        assertEq(b.measurement, M);
        assertEq(b.attestedAt, uint64(block.timestamp));
        assertEq(b.attestor, attestor);
        assertFalse(b.revoked);
    }

    function testFuzz_onlyAttestorsAttest(address caller, bytes32 k, bytes32 m) public {
        vm.assume(caller != attestor && caller != attestor2);
        vm.prank(caller);
        vm.expectRevert(EnclaveKeyAttestations.NotAttestor.selector);
        ka.attest(k, m);
    }

    function test_ownerIsNotAnAttestorByOffice() public {
        vm.prank(gov);
        vm.expectRevert(EnclaveKeyAttestations.NotAttestor.selector);
        ka.attest(K, M);
    }

    function test_zeroKeyAndZeroMeasurementRefused() public {
        vm.startPrank(attestor);
        vm.expectRevert(EnclaveKeyAttestations.ZeroKey.selector);
        ka.attest(bytes32(0), M);
        vm.expectRevert(EnclaveKeyAttestations.ZeroMeasurement.selector);
        ka.attest(K, bytes32(0));
        vm.stopPrank();
    }

    function testFuzz_neverMovesToAnotherMeasurement(bytes32 k, bytes32 m1, bytes32 m2, bool sameAttestor) public {
        vm.assume(k != bytes32(0) && m1 != bytes32(0) && m2 != bytes32(0) && m1 != m2);
        vm.prank(attestor);
        ka.attest(k, m1);
        vm.prank(sameAttestor ? attestor : attestor2);
        vm.expectRevert(abi.encodeWithSelector(EnclaveKeyAttestations.MeasurementConflict.selector, k, m1));
        ka.attest(k, m2);
        (bytes32 m, bool revoked) = _binding(k);
        assertEq(m, m1);
        assertFalse(revoked);
    }

    function testFuzz_sameMeasurementIsIdempotent(bytes32 k, bytes32 m, uint32 later, bool sameAttestor) public {
        vm.assume(k != bytes32(0) && m != bytes32(0));
        vm.prank(attestor);
        ka.attest(k, m);
        uint64 first = uint64(block.timestamp);
        vm.warp(block.timestamp + later);
        vm.recordLogs();
        vm.prank(sameAttestor ? attestor : attestor2);
        ka.attest(k, m);
        assertEq(vm.getRecordedLogs().length, 0, "a repeat records nothing");
        EnclaveKeyAttestations.Binding memory b = ka.getBinding(k);
        assertEq(b.measurement, m);
        assertEq(b.attestedAt, first, "first recording stands");
        assertEq(b.attestor, attestor, "first attestor stands");
    }

    // ======================= revoke =======================

    function test_recordingAttestorRevokes() public {
        vm.prank(attestor);
        ka.attest(K, M);
        vm.expectEmit(true, true, false, true);
        emit KeyRevoked(K, attestor);
        vm.prank(attestor);
        ka.revoke(K);
        (bytes32 m, bool revoked) = _binding(K);
        assertEq(m, M, "the measurement stays readable");
        assertTrue(revoked);
        assertTrue(ka.getBinding(K).revoked);
    }

    function test_ownerRevokes() public {
        vm.prank(attestor);
        ka.attest(K, M);
        vm.prank(gov);
        ka.revoke(K);
        (, bool revoked) = _binding(K);
        assertTrue(revoked);
    }

    function test_anotherAttestorCannotRevoke() public {
        vm.prank(attestor);
        ka.attest(K, M);
        vm.prank(attestor2);
        vm.expectRevert(EnclaveKeyAttestations.NotRevoker.selector);
        ka.revoke(K);
    }

    function testFuzz_revokeOnlyByRecorderOrOwner(address caller, bytes32 k, bytes32 m) public {
        vm.assume(caller != attestor && caller != gov);
        vm.assume(k != bytes32(0) && m != bytes32(0));
        vm.prank(attestor);
        ka.attest(k, m);
        vm.prank(caller);
        vm.expectRevert(EnclaveKeyAttestations.NotRevoker.selector);
        ka.revoke(k);
        (, bool revoked) = _binding(k);
        assertFalse(revoked);
    }

    function test_onlyOwnerRevokesAnUnrecordedKey() public {
        vm.prank(attestor);
        vm.expectRevert(EnclaveKeyAttestations.NotRevoker.selector);
        ka.revoke(K);
        vm.prank(gov);
        ka.revoke(K);
        (bytes32 m, bool revoked) = _binding(K);
        assertEq(m, bytes32(0));
        assertTrue(revoked);
        vm.prank(attestor);
        vm.expectRevert(abi.encodeWithSelector(EnclaveKeyAttestations.KeyIsRevoked.selector, K));
        ka.attest(K, M);
    }

    function testFuzz_revocationIsPermanent(bytes32 m2, bool sameAttestor) public {
        vm.assume(m2 != bytes32(0));
        vm.prank(attestor);
        ka.attest(K, M);
        vm.prank(gov);
        ka.revoke(K);
        vm.prank(sameAttestor ? attestor : attestor2);
        vm.expectRevert(abi.encodeWithSelector(EnclaveKeyAttestations.KeyIsRevoked.selector, K));
        ka.attest(K, m2);
        vm.prank(gov);
        vm.expectRevert(abi.encodeWithSelector(EnclaveKeyAttestations.KeyIsRevoked.selector, K));
        ka.revoke(K);
        // removing the recording attestor changes nothing about a revoked key
        vm.prank(gov);
        ka.setAttestor(attestor, false);
        vm.prank(attestor2);
        vm.expectRevert(abi.encodeWithSelector(EnclaveKeyAttestations.KeyIsRevoked.selector, K));
        ka.attest(K, m2);
        (, bool revoked) = _binding(K);
        assertTrue(revoked);
    }

    function test_zeroKeyRevokeRefused() public {
        vm.prank(gov);
        vm.expectRevert(EnclaveKeyAttestations.ZeroKey.selector);
        ka.revoke(bytes32(0));
    }

    // ======================= attestor removal =======================

    function test_removingAnAttestorVoidsItsBindings() public {
        vm.prank(attestor);
        ka.attest(K, M);
        bytes32 k2 = keccak256("key2");
        vm.prank(attestor2);
        ka.attest(k2, M);
        vm.prank(gov);
        ka.setAttestor(attestor, false);
        (bytes32 m, bool revoked) = _binding(K);
        assertEq(m, M);
        assertTrue(revoked, "recorded by a removed attestor: refused");
        (, bool r2) = _binding(k2);
        assertFalse(r2, "another attestor's binding is untouched");
        assertFalse(ka.getBinding(K).revoked, "void, not revoked: storage is unchanged");
        // the removed key can no longer write
        vm.prank(attestor);
        vm.expectRevert(EnclaveKeyAttestations.NotAttestor.selector);
        ka.attest(keccak256("key3"), M);
        // re-adding the same address revives what it recorded
        vm.prank(gov);
        ka.setAttestor(attestor, true);
        (, revoked) = _binding(K);
        assertFalse(revoked);
    }

    function test_aVoidBindingMayBeRecordedAfreshByACurrentAttestor() public {
        vm.prank(attestor);
        ka.attest(K, M);
        vm.prank(gov);
        ka.setAttestor(attestor, false);
        vm.warp(block.timestamp + 100);
        vm.expectEmit(true, true, true, true);
        emit KeyAttested(K, M2, attestor2);
        vm.prank(attestor2);
        ka.attest(K, M2);
        EnclaveKeyAttestations.Binding memory b = ka.getBinding(K);
        assertEq(b.measurement, M2);
        assertEq(b.attestor, attestor2);
        assertEq(b.attestedAt, uint64(block.timestamp));
        (bytes32 m, bool revoked) = _binding(K);
        assertEq(m, M2);
        assertFalse(revoked);
        // and it is now attestor2's binding: re-adding the old attestor does not give it back
        vm.prank(gov);
        ka.setAttestor(attestor, true);
        vm.prank(attestor);
        vm.expectRevert(EnclaveKeyAttestations.NotRevoker.selector);
        ka.revoke(K);
    }

    function test_removedAttestorMayStillRevokeWhatItRecorded() public {
        vm.prank(attestor);
        ka.attest(K, M);
        vm.prank(gov);
        ka.setAttestor(attestor, false);
        vm.prank(attestor);
        ka.revoke(K);
        assertTrue(ka.getBinding(K).revoked);
    }

    // ======================= governance =======================

    function testFuzz_setAttestorIsOwnerOnly(address caller, address a, bool on) public {
        vm.assume(caller != gov);
        vm.prank(caller);
        vm.expectRevert(EnclaveKeyAttestations.NotOwner.selector);
        ka.setAttestor(a, on);
    }

    function test_setAttestorEmitsAndRefusesZero() public {
        vm.expectEmit(true, false, false, true);
        emit AttestorSet(stranger, true);
        vm.prank(gov);
        ka.setAttestor(stranger, true);
        assertTrue(ka.isAttestor(stranger));
        vm.prank(gov);
        vm.expectRevert(EnclaveKeyAttestations.ZeroAddress.selector);
        ka.setAttestor(address(0), true);
    }

    function testFuzz_ownershipIsTwoStep(address next, address intruder) public {
        vm.assume(next != address(0) && next != gov && intruder != next);
        vm.prank(intruder == gov ? stranger : intruder);
        vm.expectRevert(EnclaveKeyAttestations.NotOwner.selector);
        ka.transferOwnership(next);

        vm.expectEmit(true, true, false, true);
        emit OwnershipTransferStarted(gov, next);
        vm.prank(gov);
        ka.transferOwnership(next);
        assertEq(ka.owner(), gov, "nothing moves until accepted");
        assertEq(ka.pendingOwner(), next);

        vm.prank(intruder);
        vm.expectRevert(EnclaveKeyAttestations.NotPendingOwner.selector);
        ka.acceptOwnership();

        vm.expectEmit(true, true, false, true);
        emit OwnershipTransferred(gov, next);
        vm.prank(next);
        ka.acceptOwnership();
        assertEq(ka.owner(), next);
        assertEq(ka.pendingOwner(), address(0));

        // the old owner has no power left; the new one has all of it
        vm.prank(gov);
        vm.expectRevert(EnclaveKeyAttestations.NotOwner.selector);
        ka.setAttestor(stranger, true);
        vm.prank(next);
        ka.setAttestor(stranger, true);
        assertTrue(ka.isAttestor(stranger));
    }

    function test_pendingTransferCanBeCancelled() public {
        vm.prank(gov);
        ka.transferOwnership(stranger);
        vm.prank(gov);
        ka.transferOwnership(address(0));
        assertEq(ka.pendingOwner(), address(0));
        vm.prank(stranger);
        vm.expectRevert(EnclaveKeyAttestations.NotPendingOwner.selector);
        ka.acceptOwnership();
        // nobody can accept a zero pending owner
        vm.prank(address(0));
        vm.expectRevert(EnclaveKeyAttestations.NotPendingOwner.selector);
        ka.acceptOwnership();
        assertEq(ka.owner(), gov);
    }
}

/// The registry wired into a REAL SessionVaultFactory as its keyAttestations:
/// a measurement-bound grant opens only for a key attested under that
/// measurement, and every operation re-checks the binding.
contract EnclaveKeyAttestationsVaultTest is SessionRig {
    EnclaveKeyAttestations ka;
    address gov = makeAddr("gov");
    address attestor = makeAddr("attestor");
    address attestor2 = makeAddr("attestor2");
    bytes32 constant M = keccak256("image-1");
    bytes32 constant M2 = keccak256("image-2");
    uint8 constant CREATE = 0;

    function setUp() public override {
        super.setUp();
        ka = new EnclaveKeyAttestations(gov, attestor);
        factory = new SessionVaultFactory(ISVToken(address(usdc)), ISVBook(address(book)), ISVRouter(address(router)),
            ISVKeyAttestations(address(ka)), 1_000e6);
        book.set("sessionVaultFactory", address(factory));
        vault = SessionVault(factory.vaultFor(owner));
        assertEq(address(factory.implementation().keyAttestations()), address(ka));
    }

    function _boundGrant(bytes32 key, bytes32 m) internal view returns (SessionVault.Grant memory g) {
        g = _grant(key, 5e6);
        g.measurement = m;
    }

    function _openExpect(SessionVault.Grant memory g, bytes memory err) internal {
        bytes memory sig = _signGrant(g);
        vm.prank(relayer);
        vm.expectRevert(err);
        factory.openFor(owner, g, sig);
    }

    function _payArgs() internal pure returns (bytes memory) { return abi.encode(uint256(1), bytes32("order")); }

    function test_unattestedKeyCannotOpenABoundGrant() public {
        usdc.mint(address(vault), 5e6);
        _openExpect(_boundGrant(keyHash, M), abi.encodeWithSelector(SessionVault.NoAttestation.selector));
    }

    function test_keyAttestedUnderAnotherImageCannotOpen() public {
        usdc.mint(address(vault), 5e6);
        vm.prank(attestor);
        ka.attest(keyHash, M2);
        _openExpect(_boundGrant(keyHash, M), abi.encodeWithSelector(SessionVault.NoAttestation.selector));
    }

    function test_attestedKeyOpensAndOperatesUntilRevoked() public {
        usdc.mint(address(vault), 5e6);
        vm.prank(attestor);
        ka.attest(keyHash, M);
        bytes32 sid = _open(_boundGrant(keyHash, M));
        assertTrue(vault.isLive(sid));
        uint256 t0 = usdc.balanceOf(treasury);
        _exec(sid, 0, CREATE, _createArgs(freeRef, 1, 0), 1);       // a 1-unit relay fee: proof the op ran
        assertEq(usdc.balanceOf(treasury), t0 + 1);

        vm.prank(attestor);
        ka.revoke(keyHash);
        _execExpectRevert(sid, 1, CREATE, _createArgs(freeRef, 1, 0), 0, abi.encodeWithSelector(SessionVault.NoAttestation.selector));

        // revocation strands nothing: the owner still ends the session and gets the balance back
        uint256 before = usdc.balanceOf(owner);
        vm.prank(owner);
        vault.terminate(sid, bytes32(0), 0, "");
        assertEq(usdc.balanceOf(owner), before + 5e6 - 1);
        assertFalse(vault.isLive(sid));
    }

    function test_ownerRevocationAfterAnAdvisoryStopsOperations() public {
        usdc.mint(address(vault), 5e6);
        vm.prank(attestor);
        ka.attest(keyHash, M);
        bytes32 sid = _open(_boundGrant(keyHash, M));
        vm.prank(gov);
        ka.revoke(keyHash);
        _execExpectRevert(sid, 0, CREATE, _createArgs(freeRef, 1, 0), 0, abi.encodeWithSelector(SessionVault.NoAttestation.selector));
    }

    function test_removingTheAttestorStopsItsSessionsAndAFreshAttestationRestoresThem() public {
        usdc.mint(address(vault), 5e6);
        vm.prank(attestor);
        ka.attest(keyHash, M);
        bytes32 sid = _open(_boundGrant(keyHash, M));
        _exec(sid, 0, CREATE, _createArgs(freeRef, 1, 0), 0);

        vm.prank(gov);
        ka.setAttestor(attestor, false);
        _execExpectRevert(sid, 1, CREATE, _createArgs(freeRef, 1, 0), 0, abi.encodeWithSelector(SessionVault.NoAttestation.selector));

        // a second attestor verifies the key afresh: the binding is live again under it
        vm.prank(gov);
        ka.setAttestor(attestor2, true);
        vm.prank(attestor2);
        ka.attest(keyHash, M);
        _exec(sid, 1, CREATE, _createArgs(freeRef, 1, 0), 0);
    }

    function test_anUnboundGrantNeedsNoAttestation() public {
        usdc.mint(address(vault), 5e6);
        bytes32 sid = _open(_grant(keyHash, 5e6));
        _exec(sid, 0, CREATE, _createArgs(freeRef, 1, 0), 0);
        // and a second key attested elsewhere does not change that
        (uint256 x2, uint256 y2) = vm.publicKeyP256(SK2);
        bytes32 k2 = keccak256(abi.encode(x2, y2));
        vm.prank(attestor);
        ka.attest(k2, M);
        _exec(sid, 1, CREATE, _createArgs(freeRef, 1, 0), 0);
    }
}
