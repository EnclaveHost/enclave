// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {EnclaveHostLifecycleRegistry as R} from "../contracts/EnclaveHostLifecycleRegistry.sol";

/// @dev ERC1271 contract-wallet owner. Test-only: no access control. `kill` makes every ERC1271 query revert,
///      standing in for an unavailable/upgraded wallet module during an emergency.
contract MockWallet {
    mapping(bytes32 => bool) public approved;
    bool public dead;
    function approve(bytes32 h) external { approved[h] = true; }
    function kill() external { dead = true; }
    function isValidSignature(bytes32 h, bytes calldata) external view returns (bytes4) {
        require(!dead, "wallet module unavailable");
        return approved[h] ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
    function exec(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
        return ret;
    }
}

abstract contract LifecycleBase is Test {
    R internal reg;

    // Deterministic test keys. Never fund or reuse outside tests.
    uint256 internal constant OPERATOR_PK = 0xA11CE;
    uint256 internal constant OWNER_PK = 0xB0B;
    uint256 internal constant PAYER_PK = 0xFA7E;
    uint256 internal constant NEW_OWNER_PK = 0xC0FFEE;
    uint256 internal constant NEW_OPERATOR_PK = 0xD00D;

    address internal operator;
    address internal owner;
    address internal payer;
    address internal newOwner;
    address internal newOperator;
    address internal submitter = address(0x5B5B);
    address internal anchorPublisher = address(0xA9C0);
    address internal payee = address(0xFEE0);
    address internal stranger = address(0x5757);

    uint256[] internal verifierPks;
    uint256[] internal reporterPks;
    uint256[] internal newReporterPks;
    bytes32 internal anchorId;

    bytes32 internal constant HW = keccak256("hw:snp-chip-0001");
    bytes32 internal constant JOB = keccak256("job:bootstrap-0001");
    bytes32 internal constant ATT = keccak256("attestation:snp-report-0001");
    bytes32 internal constant RES = keccak256("resources:cpu16/ram64/gpu1:vram80");
    bytes32 internal constant TESTD = keccak256("test:capacity-suite-v3:work-nonce-1:pass");
    string internal constant ENDPOINT = "https://host-1.example";
    string internal constant REPO = "EnclaveHost/enclave";
    uint128 internal constant PROTECTED = 0.05 ether;
    uint128 internal constant LISTING_CAP = 0.01 ether;
    uint128 internal constant PER_TRANSITION = 0.01 ether;
    uint128 internal constant L1 = 0.001 ether;
    uint64 internal constant MAX_GAS_PRICE = 50 gwei;

    struct Prepared {
        R.Enrollment e;
        R.ReporterPolicy p;
        R.QualificationReceipt q;
        bytes opSig;
        bytes ownSig;
        bytes[] approvals;
        bytes32 hostId;
        bytes32 resId;
    }

    struct RecoveryCase {
        R.Recovery v;
        R.QualificationReceipt q;
        bytes opSig;
        bytes ownSig;
        bytes[] approvals;
    }

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        vm.txGasPrice(1 gwei);
        reg = new R();
        operator = vm.addr(OPERATOR_PK);
        owner = vm.addr(OWNER_PK);
        payer = vm.addr(PAYER_PK);
        newOwner = vm.addr(NEW_OWNER_PK);
        newOperator = vm.addr(NEW_OPERATOR_PK);
        verifierPks = _sorted3(0x1001, 0x1002, 0x1003);
        reporterPks = _sorted3(0x2001, 0x2002, 0x2003);
        newReporterPks = _sorted3(0x3001, 0x3002, 0x3003);
        vm.prank(anchorPublisher);
        anchorId = reg.publishTrustAnchor(_addrs(verifierPks), 2, 1, 1 days, keccak256("policy:independent-qual:v1"));
        vm.deal(payer, 10 ether);
        vm.prank(payer);
        reg.depositSponsorFunds{value: 1 ether}();
    }

    // ------------------------------------------------------------------ key helpers
    function _sorted3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory k) {
        k = new uint256[](3);
        (k[0], k[1], k[2]) = (a, b, c);
        for (uint256 i = 1; i < 3; ++i) {
            for (uint256 j = i; j > 0 && vm.addr(k[j]) < vm.addr(k[j - 1]); --j) (k[j], k[j - 1]) = (k[j - 1], k[j]);
        }
    }

    function _addrs(uint256[] memory pks) internal pure returns (address[] memory a) {
        a = new address[](pks.length);
        for (uint256 i; i < pks.length; ++i) a[i] = vm.addr(pks[i]);
    }

    function _sig(uint256 pk, bytes32 d) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, d);
        return abi.encodePacked(r, s, v);
    }

    /// @dev First n keys of an address-sorted list sign in ascending signer order.
    function _quorum(uint256[] memory pks, uint256 n, bytes32 d) internal pure returns (bytes[] memory s) {
        s = new bytes[](n);
        for (uint256 i; i < n; ++i) s[i] = _sig(pks[i], d);
    }

    function _policy(uint256[] memory pks, uint8 t) internal pure returns (R.ReporterPolicy memory p) {
        p.reporters = _addrs(pks);
        p.threshold = t;
    }

    // ------------------------------------------------------------------ state readers (decode whole getter tuples)
    function _hs(bytes32 id) internal view returns (R.HostState memory) {
        (bool ok, bytes memory ret) = address(reg).staticcall(abi.encodeWithSignature("hostState(bytes32)", id));
        require(ok, "hostState");
        return abi.decode(ret, (R.HostState));
    }

    function _auth(bytes32 id) internal view returns (R.Authority memory) {
        (bool ok, bytes memory ret) = address(reg).staticcall(abi.encodeWithSignature("authority(bytes32)", id));
        require(ok, "authority");
        return abi.decode(ret, (R.Authority));
    }

    function _budget(bytes32 id) internal view returns (R.Budget memory) {
        (bool ok, bytes memory ret) = address(reg).staticcall(abi.encodeWithSignature("hostBudget(bytes32)", id));
        require(ok, "hostBudget");
        return abi.decode(ret, (R.Budget));
    }

    function _res(bytes32 id) internal view returns (R.Reservation memory) {
        (bool ok, bytes memory ret) = address(reg).staticcall(abi.encodeWithSignature("reservations(bytes32)", id));
        require(ok, "reservations");
        return abi.decode(ret, (R.Reservation));
    }

    function _gen(bytes32 id) internal view returns (uint64) { return _hs(id).generation; }
    function _status(bytes32 id) internal view returns (uint8) { return _hs(id).status; }
    function _lastOffline(bytes32 id) internal view returns (bytes32) { return _hs(id).lastOfflineDigest; }
    function _rev(bytes32 id) internal view returns (uint64) { return _auth(id).revision; }
    function _owner(bytes32 id) internal view returns (address) { return _auth(id).owner; }
    function _balance(bytes32 id) internal view returns (uint128) { return _budget(id).balance; }
    function _resStatus(bytes32 id) internal view returns (uint8) { return _res(id).status; }
    function _active(bytes32 id) internal view returns (bool) { return reg.get(id).active; }

    // ------------------------------------------------------------------ intent builders
    function _reservation(bytes32 hostId, bytes32 hw, bytes32 job, bytes32 anchor)
        internal view returns (R.SponsorReservation memory s)
    {
        s.hostId = hostId;
        s.hardwareId = hw;
        s.jobId = job;
        s.payer = payer;
        s.trustAnchorId = anchor;
        s.source = 1;
        s.sourceEvidence = keccak256("paid-work-host-receipt:host-7");
        s.protectedAmount = PROTECTED;
        s.listingGasCap = LISTING_CAP;
        s.perTransitionCap = PER_TRANSITION;
        s.l1FeeAllowance = L1;
        s.maxGasPrice = MAX_GAS_PRICE;
        s.nonce = 1;
        s.deadline = uint64(block.timestamp + 1 days);
    }

    function _reserve(R.SponsorReservation memory s) internal returns (bytes32) {
        bytes memory auth = _sig(PAYER_PK, reg.hashReservation(s));
        vm.prank(submitter);                       // anyone may carry the payer's authorization
        return reg.reserveBootstrap(s, auth);
    }

    function _listing() internal pure returns (R.Listing memory l) {
        l.endpoint = ENDPOINT;
        l.repo = REPO;
        l.measurement = keccak256("measurement:1");
        l.cpuPricePerSec6 = 10;
        l.gpuPricePerSec6 = 100;
        l.proofKey = address(0x9999);
        l.caps = 1;
        l.region = "eu-north";
    }

    function _receiptFor(bytes32 hostId, bytes32 intentDigest, uint64 gen, string memory repo, bytes32 m)
        internal view returns (R.QualificationReceipt memory q)
    {
        q.trustAnchorId = anchorId;
        q.hostId = hostId;
        q.hardwareId = HW;
        q.descriptorDigest = keccak256(abi.encode(keccak256(bytes(repo)), m));   // computed independently
        q.attestationDigest = ATT;
        q.resourceDigest = RES;
        q.testDigest = TESTD;
        q.intentDigest = intentDigest;
        q.generation = gen;
        q.issuedAt = uint64(block.timestamp);
        q.expiresAt = uint64(block.timestamp + 6 hours);
    }

    function _prepare() internal returns (Prepared memory c) {
        return _prepareWith(anchorId, verifierPks, 2);
    }

    function _prepareWith(bytes32 anchor, uint256[] memory vpks, uint256 nApprovals) internal returns (Prepared memory c) {
        c.hostId = keccak256(bytes(ENDPOINT));
        c.resId = _reserve(_reservation(c.hostId, HW, JOB, anchor));
        c.p = _policy(reporterPks, 2);
        c.e.listing = _listing();
        c.e.operator = operator;
        c.e.owner = owner;
        c.e.ownerPolicyHash = keccak256("owner-policy:1");
        c.e.hardwareId = HW;
        c.e.attestationDigest = ATT;
        c.e.resourceDigest = RES;
        c.e.trustAnchorId = anchor;
        c.e.reporterPolicyHash = reg.hashReporterPolicy(c.p);
        c.e.reservationId = c.resId;
        c.e.protectedAmount = PROTECTED;
        c.e.nonce = 1;
        c.e.deadline = uint64(block.timestamp + 1 hours);
        bytes32 d = reg.hashEnrollment(c.e);
        c.opSig = _sig(OPERATOR_PK, d);
        c.ownSig = _sig(OWNER_PK, d);
        c.q = _receiptFor(c.hostId, d, 1, REPO, c.e.listing.measurement);
        c.q.trustAnchorId = anchor;
        c.approvals = _quorum(vpks, nApprovals, reg.hashReceipt(c.q));
    }

    /// @dev Re-sign after mutating the enrollment (EOA owner) and re-bind the receipt to the new intent.
    function _resign(Prepared memory c, uint256[] memory vpks) internal view {
        bytes32 d = reg.hashEnrollment(c.e);
        c.opSig = _sig(OPERATOR_PK, d);
        c.ownSig = _sig(OWNER_PK, d);
        c.q.intentDigest = d;
        c.approvals = _quorum(vpks, 2, reg.hashReceipt(c.q));
    }

    /// @dev Switch the owner to an ERC1271 wallet that approves exactly this enrollment digest.
    function _withWalletOwner(Prepared memory c, MockWallet w) internal {
        c.e.owner = address(w);
        bytes32 d = reg.hashEnrollment(c.e);
        w.approve(d);
        c.opSig = _sig(OPERATOR_PK, d);
        c.ownSig = hex"01";                                         // non-empty: ERC1271 path
        c.q.intentDigest = d;
        c.approvals = _quorum(verifierPks, 2, reg.hashReceipt(c.q));
    }

    function _submit(Prepared memory c) internal returns (bytes32) {
        vm.prank(submitter);
        return reg.registerQualifiedHost(c.e, c.p, c.q, c.opSig, c.ownSig, c.approvals);
    }

    function _submitReverts(Prepared memory c, bytes4 err) internal {
        vm.prank(submitter);
        vm.expectRevert(err);
        reg.registerQualifiedHost(c.e, c.p, c.q, c.opSig, c.ownSig, c.approvals);
    }

    function _enrolled() internal returns (bytes32) { return _submit(_prepare()); }

    function _offline(bytes32 hostId) internal view returns (R.HostOffline memory o) {
        o.hostId = hostId;
        o.generation = _gen(hostId);
        o.operator = reg.get(hostId).operator;
        o.authorityRevision = _rev(hostId);
        o.targetStatus = 2;
        o.evidenceDigest = keccak256(abi.encode("evidence:missed-liveness", o.generation));
        o.deadline = uint64(block.timestamp + 1 hours);
        o.payee = payee;
        o.maxCharge = PER_TRANSITION;
    }

    function _reportOffline(bytes32 hostId, uint256[] memory pks) internal returns (bytes32 d) {
        R.HostOffline memory o = _offline(hostId);
        d = reg.hashOffline(o);
        bytes[] memory s = _quorum(pks, 2, d);
        vm.prank(stranger);
        assertTrue(reg.recordHostOffline(o, s));
    }

    function _recovery(bytes32 hostId, uint256 opPk) internal view returns (RecoveryCase memory c) {
        c.v.hostId = hostId;
        c.v.priorGeneration = _gen(hostId);
        c.v.priorOfflineDigest = _lastOffline(hostId);
        c.v.authorityRevision = _rev(hostId);
        c.v.operator = vm.addr(opPk);
        c.v.owner = owner;
        c.v.repo = REPO;
        c.v.measurement = keccak256("measurement:2");
        c.v.proofKey = address(0x8888);
        c.v.hardwareId = HW;
        c.v.attestationDigest = keccak256("attestation:snp-report-0002");
        c.v.resourceDigest = RES;
        c.v.trustAnchorId = anchorId;
        c.v.protectedAmount = PROTECTED / 2;
        c.v.nonce = 2;
        c.v.deadline = uint64(block.timestamp + 1 hours);
        _signRecovery(c, opPk);
    }

    function _signRecovery(RecoveryCase memory c, uint256 opPk) internal view {
        bytes32 d = reg.hashRecovery(c.v);
        c.opSig = _sig(opPk, d);
        c.ownSig = _sig(OWNER_PK, d);
        c.q = _receiptFor(c.v.hostId, d, c.v.priorGeneration + 1, c.v.repo, c.v.measurement);
        c.q.attestationDigest = c.v.attestationDigest;
        c.q.trustAnchorId = c.v.trustAnchorId;
        c.approvals = _quorum(verifierPks, 2, reg.hashReceipt(c.q));
    }

    function _recover(RecoveryCase memory c) internal returns (uint64) {
        vm.prank(submitter);
        return reg.recoverQualifiedHost(c.v, c.q, c.opSig, c.ownSig, c.approvals);
    }

    function _recoverReverts(RecoveryCase memory c, bytes4 err) internal {
        vm.prank(submitter);
        vm.expectRevert(err);
        reg.recoverQualifiedHost(c.v, c.q, c.opSig, c.ownSig, c.approvals);
    }
}

contract HostLifecycleRegistryTest is LifecycleBase {
    // ================================================================== enrollment
    function test_zeroEthOperatorEnrolledByIndependentSubmitter() public {
        Prepared memory c = _prepare();
        uint256 fundsBefore = reg.sponsorFunds(payer);
        assertEq(operator.balance, 0);
        bytes32 hostId = _submit(c);

        assertEq(hostId, c.hostId);
        assertEq(operator.balance, 0, "operator never paid");
        R.Enclave memory row = reg.get(hostId);
        assertTrue(row.active);
        assertEq(row.operator, operator);
        assertEq(row.endpoint, ENDPOINT);
        assertEq(row.cpuPricePerSec6, 10);
        assertEq(row.caps & reg.CAP_HOST(), reg.CAP_HOST());
        assertEq(reg.count(), 1);
        assertEq(_owner(hostId), owner);
        assertEq(_rev(hostId), 1);
        assertEq(_gen(hostId), 1);
        assertEq(_balance(hostId), PROTECTED);
        assertEq(_budget(hostId).protectedReserve, PROTECTED);
        assertEq(_budget(hostId).payer, payer);
        assertEq(_resStatus(c.resId), reg.RES_CONSUMED());
        assertEq(_hs(hostId).trustAnchorId, anchorId);
        assertEq(_hs(hostId).resourceDigest, RES);
        (address[] memory keys, uint8 t, uint64 rrev) = reg.reporterPolicy(hostId);
        assertEq(keys.length, 3);
        assertEq(t, 2);
        assertEq(rrev, 1);

        uint256 paid = reg.credits(submitter);
        assertGt(paid, 0, "submitter reimbursed after verification");
        assertLe(paid, LISTING_CAP);
        assertEq(reg.sponsorFunds(payer), fundsBefore + LISTING_CAP - paid, "unused listing cap returns to payer");
        assertEq(reg.hostLifecycleSchema(), 1);
        assertEq(reg.registrySchema(), 5);
    }

    function test_listingIsAtomic_unauthenticatedReceiptLeavesNoRow() public {
        Prepared memory c = _prepare();
        c.approvals = _quorum(_sorted3(0x4001, 0x4002, 0x4003), 2, reg.hashReceipt(c.q));
        _submitReverts(c, R.Quorum.selector);
        assertEq(reg.count(), 0);
        assertFalse(_active(c.hostId));
        assertEq(_gen(c.hostId), 0);
        assertEq(_owner(c.hostId), address(0));
        assertEq(_resStatus(c.resId), reg.RES_RESERVED(), "reservation not consumed");
        assertEq(reg.credits(submitter), 0, "no gas released without qualification");
        // The same intent, correctly approved, still lists: the failure consumed nothing.
        c.approvals = _quorum(verifierPks, 2, reg.hashReceipt(c.q));
        _submit(c);
        assertTrue(_active(c.hostId));
    }

    function test_receiptMustBindResourcesHardwareDescriptorAndIntent() public {
        Prepared memory c = _prepare();
        bytes32 good = c.q.resourceDigest;

        c.q.resourceDigest = keccak256("resources:gpu-claimed-from-cpu-test");
        c.approvals = _quorum(verifierPks, 2, reg.hashReceipt(c.q));
        _submitReverts(c, R.ReceiptMismatch.selector);
        c.q.resourceDigest = good;

        c.q.hardwareId = keccak256("hw:other");
        c.approvals = _quorum(verifierPks, 2, reg.hashReceipt(c.q));
        _submitReverts(c, R.ReceiptMismatch.selector);
        c.q.hardwareId = HW;

        c.q.descriptorDigest = keccak256("other-measurement");
        c.approvals = _quorum(verifierPks, 2, reg.hashReceipt(c.q));
        _submitReverts(c, R.ReceiptMismatch.selector);
        c.q.descriptorDigest = keccak256(abi.encode(keccak256(bytes(REPO)), c.e.listing.measurement));

        bytes32 intent = c.q.intentDigest;
        c.q.intentDigest = keccak256("some-other-intent");
        c.approvals = _quorum(verifierPks, 2, reg.hashReceipt(c.q));
        _submitReverts(c, R.ReceiptMismatch.selector);
        c.q.intentDigest = intent;

        c.q.testDigest = bytes32(0);
        c.approvals = _quorum(verifierPks, 2, reg.hashReceipt(c.q));
        _submitReverts(c, R.ReceiptMismatch.selector);
        assertEq(reg.count(), 0);
    }

    function test_receiptFreshnessEnforced() public {
        Prepared memory c = _prepare();
        c.q.issuedAt = uint64(block.timestamp - 2 days);           // older than the anchor's 1 day bound
        c.approvals = _quorum(verifierPks, 2, reg.hashReceipt(c.q));
        _submitReverts(c, R.StaleReceipt.selector);

        c.q.issuedAt = uint64(block.timestamp);
        c.q.expiresAt = uint64(block.timestamp);                   // already expired
        c.approvals = _quorum(verifierPks, 2, reg.hashReceipt(c.q));
        _submitReverts(c, R.StaleReceipt.selector);

        c.q.issuedAt = uint64(block.timestamp + 1);                // from the future
        c.q.expiresAt = uint64(block.timestamp + 1 hours);
        c.approvals = _quorum(verifierPks, 2, reg.hashReceipt(c.q));
        _submitReverts(c, R.StaleReceipt.selector);
    }

    function test_hostSelfAppointedVerifierRejected() public {
        // An anchor whose verifier set contains the operator is not independent evidence, even if a payer named it.
        uint256[] memory pks = _sorted3(OPERATOR_PK, 0x1001, 0x1002);
        vm.prank(operator);
        bytes32 selfAnchor = reg.publishTrustAnchor(_addrs(pks), 2, 1, 1 days, keccak256("self"));
        Prepared memory c = _prepareWith(selfAnchor, pks, 2);
        _submitReverts(c, R.NotIndependent.selector);
    }

    function test_receiptUnderAnchorPayerDidNotAuthorizeRejected() public {
        Prepared memory c = _prepare();
        uint256[] memory hostFriends = _sorted3(0x5001, 0x5002, 0x5003);
        vm.prank(stranger);
        bytes32 other = reg.publishTrustAnchor(_addrs(hostFriends), 2, 1, 1 days, keccak256("friends"));
        c.e.trustAnchorId = other;
        c.q.trustAnchorId = other;
        _resign(c, hostFriends);
        _submitReverts(c, R.BadReservation.selector);
    }

    function test_consentRequiredFromOperatorAndOwner() public {
        Prepared memory c = _prepare();
        bytes32 d = reg.hashEnrollment(c.e);
        bytes memory good = c.opSig;
        c.opSig = _sig(0xBAD, d);
        _submitReverts(c, R.BadConsent.selector);
        c.opSig = good;
        c.ownSig = _sig(0xBAD, d);
        _submitReverts(c, R.BadConsent.selector);
        c.ownSig = "";                                             // empty = msg.sender must be the owner
        _submitReverts(c, R.BadConsent.selector);
    }

    function test_contractWalletOwnerConsentOnNormalPath() public {
        MockWallet w = new MockWallet();
        Prepared memory c = _prepare();
        c.e.owner = address(w);
        bytes32 d = reg.hashEnrollment(c.e);
        c.opSig = _sig(OPERATOR_PK, d);
        c.ownSig = hex"01";
        c.q.intentDigest = d;
        c.approvals = _quorum(verifierPks, 2, reg.hashReceipt(c.q));
        _submitReverts(c, R.BadConsent.selector);                  // wallet has not approved yet
        w.approve(d);
        bytes32 hostId = _submit(c);
        assertEq(_owner(hostId), address(w));
    }

    function test_existingHostCannotBeReenrolled() public {
        Prepared memory c = _prepare();
        _submit(c);
        _submitReverts(c, R.HostExists.selector);
    }

    function test_enrollmentBoundsValidated() public {
        Prepared memory c = _prepare();
        c.p = _policy(reporterPks, 1);                             // 1-of-3 is not a strict majority
        c.e.reporterPolicyHash = reg.hashReporterPolicy(c.p);
        _resign(c, verifierPks);
        _submitReverts(c, R.BadPolicy.selector);

        c.p = R.ReporterPolicy(new address[](0), 0);               // no offline path at all
        c.e.reporterPolicyHash = reg.hashReporterPolicy(c.p);
        _resign(c, verifierPks);
        _submitReverts(c, R.BadPolicy.selector);

        c.p = _policy(reporterPks, 2);
        c.e.reporterPolicyHash = reg.hashReporterPolicy(c.p);
        c.e.listing.cpuPricePerSec6 = 0;
        _resign(c, verifierPks);
        _submitReverts(c, R.BadListing.selector);
    }

    // ================================================================== offline
    function test_reporterQuorumOffline_canonicalActiveFalse() public {
        bytes32 hostId = _enrolled();
        uint128 before = _balance(hostId);
        _reportOffline(hostId, reporterPks);

        assertFalse(_active(hostId));
        R.Enclave[] memory page = reg.getPage(0, 10);
        assertEq(page.length, 1);
        assertFalse(page[0].active, "getPage derives active from lifecycle state");
        assertEq(_status(hostId), reg.STATUS_OFFLINE());
        uint256 credit = reg.credits(payee);
        assertGt(credit, 0);
        assertLe(credit, PER_TRANSITION);
        assertEq(uint256(before) - _balance(hostId), credit, "credit moved out of the budget, fully backed");
    }

    function test_offlineMakesNoExternalCallsEvenWhenOwnerWalletIsDown() public {
        MockWallet w = new MockWallet();
        Prepared memory c = _prepare();
        _withWalletOwner(c, w);
        bytes32 hostId = _submit(c);
        w.kill();

        R.HostOffline memory o = _offline(hostId);
        bytes[] memory s = _quorum(reporterPks, 2, reg.hashOffline(o));
        vm.expectCall(address(w), bytes(""), 0);
        vm.startStateDiffRecording();
        vm.prank(stranger);
        bool recorded = reg.recordHostOffline(o, s);
        VmSafe.AccountAccess[] memory acc = vm.stopAndReturnStateDiff();
        assertTrue(recorded);
        for (uint256 i; i < acc.length; ++i) {
            VmSafe.AccountAccessKind k = acc[i].kind;
            if (k == VmSafe.AccountAccessKind.Call || k == VmSafe.AccountAccessKind.StaticCall
                || k == VmSafe.AccountAccessKind.DelegateCall || k == VmSafe.AccountAccessKind.CallCode) {
                address a = acc[i].account;
                assertTrue(a == address(reg) || a == address(1) || a == address(vm), "only self + ecrecover");
            }
        }
        assertFalse(_active(hostId));
    }

    function test_exactRetryIsIdempotentAndChargesOnce() public {
        bytes32 hostId = _enrolled();
        R.HostOffline memory o = _offline(hostId);
        bytes[] memory s = _quorum(reporterPks, 2, reg.hashOffline(o));
        assertTrue(reg.recordHostOffline(o, s));
        uint256 credit = reg.credits(payee);
        uint128 bal = _balance(hostId);
        assertFalse(reg.recordHostOffline(o, s));
        vm.prank(operator);
        assertFalse(reg.deactivateHost(o));
        assertEq(reg.credits(payee), credit);
        assertEq(_balance(hostId), bal);
    }

    function test_offlineDigestMatchesIndependentEip712() public {
        bytes32 hostId = _enrolled();
        R.HostOffline memory o = _offline(hostId);
        bytes32 domain = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("EnclaveHostLifecycleRegistry"), keccak256("1"), block.chainid, address(reg)));
        bytes32 sh = keccak256(abi.encode(
            keccak256("HostOffline(bytes32 hostId,uint64 generation,address operator,uint64 authorityRevision,"
                      "uint8 targetStatus,bytes32 evidenceDigest,uint64 deadline,address payee,uint128 maxCharge)"),
            o.hostId, o.generation, o.operator, o.authorityRevision, o.targetStatus, o.evidenceDigest, o.deadline,
            o.payee, o.maxCharge));
        assertEq(reg.hashOffline(o), keccak256(abi.encodePacked("\x19\x01", domain, sh)));
    }

    function test_wrongDomainDuplicateSignerOutsiderAndEpochRefused() public {
        bytes32 hostId = _enrolled();
        R.HostOffline memory o = _offline(hostId);
        R other = new R();
        bytes[] memory s = _quorum(reporterPks, 2, other.hashOffline(o));
        vm.expectRevert(R.Quorum.selector);
        reg.recordHostOffline(o, s);

        bytes32 d = reg.hashOffline(o);
        s = new bytes[](2);
        s[0] = _sig(reporterPks[0], d);
        s[1] = s[0];
        vm.expectRevert(R.Quorum.selector);
        reg.recordHostOffline(o, s);

        s = _quorum(_sorted3(0x6001, 0x6002, 0x6003), 2, d);
        vm.expectRevert(R.Quorum.selector);
        reg.recordHostOffline(o, s);

        s = new bytes[](1);
        s[0] = _sig(reporterPks[0], d);
        vm.expectRevert(R.Quorum.selector);
        reg.recordHostOffline(o, s);

        o.generation = 2;
        s = _quorum(reporterPks, 2, reg.hashOffline(o));
        vm.expectRevert(R.IntentMismatch.selector);
        reg.recordHostOffline(o, s);

        o.generation = 1;
        o.targetStatus = 1;
        s = _quorum(reporterPks, 2, reg.hashOffline(o));
        vm.expectRevert(R.IntentMismatch.selector);
        reg.recordHostOffline(o, s);

        o.targetStatus = 2;
        o.deadline = uint64(block.timestamp - 1);
        s = _quorum(reporterPks, 2, reg.hashOffline(o));
        vm.expectRevert(R.Expired.selector);
        reg.recordHostOffline(o, s);
        assertTrue(_active(hostId), "no failed report changed state");
    }

    function test_policyChangeInvalidatesOldQuorumImmediately() public {
        bytes32 hostId = _enrolled();
        R.HostOffline memory oldIntent = _offline(hostId);
        bytes[] memory oldSigs = _quorum(reporterPks, 2, reg.hashOffline(oldIntent));

        R.ReporterPolicy memory np = _policy(newReporterPks, 2);
        vm.prank(owner);
        reg.setHostPolicy(hostId, np, keccak256("owner-policy:2"));
        assertEq(_rev(hostId), 2);

        vm.expectRevert(R.IntentMismatch.selector);
        reg.recordHostOffline(oldIntent, oldSigs);

        R.HostOffline memory o = _offline(hostId);
        bytes32 d = reg.hashOffline(o);
        bytes[] memory stale = _quorum(reporterPks, 2, d);
        vm.expectRevert(R.Quorum.selector);
        reg.recordHostOffline(o, stale);

        bytes[] memory fresh = _quorum(newReporterPks, 2, d);
        assertTrue(reg.recordHostOffline(o, fresh));
        assertFalse(_active(hostId));
    }

    function test_ownerTransferAtomicallyReplacesQuorumAndRights() public {
        bytes32 hostId = _enrolled();
        R.HostOffline memory oldIntent = _offline(hostId);
        bytes[] memory oldSigs = _quorum(reporterPks, 2, reg.hashOffline(oldIntent));
        R.ReporterPolicy memory np = _policy(newReporterPks, 2);
        R.ReporterPolicy memory empty = R.ReporterPolicy(new address[](0), 0);

        vm.prank(owner);
        reg.proposeHostOwner(hostId, newOwner);
        vm.prank(stranger);
        vm.expectRevert(R.NotAuthorized.selector);
        reg.acceptHostOwner(hostId, np, bytes32(0));

        vm.prank(newOwner);
        vm.expectRevert(R.BadPolicy.selector);                     // cannot drop the last offline path while Online
        reg.acceptHostOwner(hostId, empty, bytes32(0));

        vm.prank(newOwner);
        reg.acceptHostOwner(hostId, np, keccak256("new-owner-policy"));
        assertEq(_owner(hostId), newOwner);
        assertEq(_rev(hostId), 2);

        vm.expectRevert(R.IntentMismatch.selector);
        reg.recordHostOffline(oldIntent, oldSigs);

        R.ReporterPolicy memory oldPolicy = _policy(reporterPks, 2);
        vm.prank(owner);
        vm.expectRevert(R.NotAuthorized.selector);
        reg.setHostPolicy(hostId, oldPolicy, bytes32(0));

        R.HostOffline memory o = _offline(hostId);
        vm.prank(owner);
        vm.expectRevert(R.NotAuthorized.selector);
        reg.deactivateHost(o);

        vm.prank(newOwner);
        assertTrue(reg.deactivateHost(o));
        assertFalse(_active(hostId));
    }

    function test_emptyReportersOnlyWhileOffline() public {
        bytes32 hostId = _enrolled();
        R.ReporterPolicy memory empty = R.ReporterPolicy(new address[](0), 0);
        vm.prank(owner);
        vm.expectRevert(R.BadPolicy.selector);
        reg.setHostPolicy(hostId, empty, bytes32(0));
        _reportOffline(hostId, reporterPks);
        vm.prank(owner);
        reg.setHostPolicy(hostId, empty, bytes32(0));
        (address[] memory keys, uint8 t,) = reg.reporterPolicy(hostId);
        assertEq(keys.length, 0);
        assertEq(t, 0);
        // Recovery refuses to go Online without an offline path.
        RecoveryCase memory c = _recovery(hostId, OPERATOR_PK);
        _recoverReverts(c, R.BadPolicy.selector);
    }

    // ================================================================== graceful shutdown and rights
    function test_operatorGracefulShutdown_andNoForeignVeto() public {
        bytes32 hostId = _enrolled();
        R.HostOffline memory o = _offline(hostId);
        o.payee = address(0);
        address[3] memory outsiders = [stranger, payer, anchorPublisher];
        for (uint256 i; i < 3; ++i) {
            vm.prank(outsiders[i]);
            vm.expectRevert(R.NotAuthorized.selector);
            reg.deactivateHost(o);
        }
        vm.prank(operator);
        assertTrue(reg.deactivateHost(o));
        assertFalse(_active(hostId));
        assertEq(_balance(hostId), PROTECTED, "no payee, no charge");
    }

    function test_contractWalletOwnerShutdownWithoutErc1271() public {
        MockWallet w = new MockWallet();
        Prepared memory c = _prepare();
        _withWalletOwner(c, w);
        bytes32 hostId = _submit(c);
        w.kill();
        R.HostOffline memory o = _offline(hostId);
        w.exec(address(reg), abi.encodeCall(R.deactivateHost, (o)));
        assertFalse(_active(hostId));
    }

    function test_noGlobalAdminSelectors() public {
        bytes32 hostId = _enrolled();
        bytes[] memory calls = new bytes[](5);
        calls[0] = abi.encodeWithSignature("owner()");
        calls[1] = abi.encodeWithSignature("pause()");
        calls[2] = abi.encodeWithSignature("setVerifier(address)", stranger);
        calls[3] = abi.encodeWithSignature("ban(bytes32)", hostId);
        calls[4] = abi.encodeWithSignature("deregister(bytes32)", hostId);
        for (uint256 i; i < calls.length; ++i) {
            vm.prank(stranger);
            (bool ok,) = address(reg).call(calls[i]);
            assertFalse(ok);
        }
        // Anchors are immutable: re-publishing cannot overwrite, and new anchors do not touch a qualified host.
        address[] memory vs = _addrs(verifierPks);
        vm.prank(anchorPublisher);
        vm.expectRevert(R.Duplicate.selector);
        reg.publishTrustAnchor(vs, 2, 1, 1 days, keccak256("policy:independent-qual:v1"));
        vm.prank(anchorPublisher);
        reg.publishTrustAnchor(vs, 3, 2, 1 days, keccak256("policy:independent-qual:v2"));
        assertTrue(_active(hostId));
        assertEq(_hs(hostId).trustAnchorId, anchorId);
    }

    function test_noLegacyReactivationAfterOffline() public {
        bytes32 hostId = _enrolled();
        _reportOffline(hostId, reporterPks);
        bytes[] memory legacy = new bytes[](4);
        legacy[0] = abi.encodeWithSignature("heartbeat(bytes32)", hostId);
        legacy[1] = abi.encodeWithSignature("register(string,string,bytes32,uint64,uint64,address)",
                                            ENDPOINT, REPO, bytes32(0), uint64(1), uint64(0), address(0));
        legacy[2] = abi.encodeWithSignature("registerRelay(string,string,uint64)", ENDPOINT, "x", uint64(2));
        legacy[3] = abi.encodeWithSignature("setMeasurement(bytes32,string,bytes32)", hostId, REPO, bytes32(0));
        for (uint256 i; i < legacy.length; ++i) {
            vm.prank(operator);
            (bool ok,) = address(reg).call(legacy[i]);
            assertFalse(ok);
        }
        vm.startPrank(operator);
        reg.setPrices(hostId, 11, 0);
        vm.expectRevert(R.BadListing.selector);
        reg.setProofKey(hostId, address(0x1234));
        reg.setCaps(hostId, 1, "us-west");
        vm.stopPrank();
        assertFalse(_active(hostId), "configuration writes never set Online");
        assertEq(reg.get(hostId).cpuPricePerSec6, 11);
    }

    function test_operatorConfigurationAndPayoutRights() public {
        bytes32 hostId = _enrolled();
        vm.prank(stranger);
        vm.expectRevert(R.NotAuthorized.selector);
        reg.setPrices(hostId, 5, 5);
        vm.prank(operator);
        vm.expectRevert(R.BadListing.selector);
        reg.setCaps(hostId, 2, "relay-only");                      // a host row keeps CAP_HOST
        address wallet = address(0xBA11E7);
        vm.prank(wallet);
        reg.setPayoutWallet(hostId);
        assertEq(reg.get(hostId).payoutWallet, wallet);
        vm.prank(operator);
        reg.clearPayoutWallet(hostId);
        assertEq(reg.get(hostId).payoutWallet, address(0));
        R.ReporterPolicy memory p = _policy(reporterPks, 2);
        vm.prank(owner);
        reg.setHostPolicy(hostId, p, keccak256("owner-policy:2"));
        assertEq(_auth(hostId).policyHash, keccak256("owner-policy:2"));
        assertEq(_rev(hostId), 2);
    }

    // ================================================================== recovery
    function test_recoveryInstallsStrictlyNewerQualifiedGeneration() public {
        bytes32 hostId = _enrolled();
        R.HostOffline memory o = _offline(hostId);
        bytes[] memory oldSigs = _quorum(reporterPks, 2, reg.hashOffline(o));
        assertTrue(reg.recordHostOffline(o, oldSigs));

        RecoveryCase memory c = _recovery(hostId, OPERATOR_PK);
        c.q.generation = 1;                                        // receipt for the old epoch
        c.approvals = _quorum(verifierPks, 2, reg.hashReceipt(c.q));
        _recoverReverts(c, R.ReceiptMismatch.selector);

        c.q.generation = 2;
        c.approvals = _quorum(verifierPks, 2, reg.hashReceipt(c.q));
        assertEq(_recover(c), 2);
        assertTrue(_active(hostId));
        assertEq(_gen(hostId), 2);
        assertEq(reg.get(hostId).measurement, keccak256("measurement:2"));

        // The old generation's report can neither retry nor apply to the new epoch.
        vm.expectRevert(R.IntentMismatch.selector);
        reg.recordHostOffline(o, oldSigs);

        // Recovery is single-use and only from Offline.
        _recoverReverts(c, R.NotOffline.selector);
    }

    function test_recoveryRequiresAcceptedOwnerAndPayerAnchor() public {
        bytes32 hostId = _enrolled();
        _reportOffline(hostId, reporterPks);
        RecoveryCase memory c = _recovery(hostId, OPERATOR_PK);

        c.v.owner = stranger;
        _recoverReverts(c, R.IntentMismatch.selector);
        c.v.owner = owner;

        uint256[] memory friends = _sorted3(0x7001, 0x7002, 0x7003);
        vm.prank(stranger);
        bytes32 other = reg.publishTrustAnchor(_addrs(friends), 2, 1, 1 days, bytes32(0));
        c.v.trustAnchorId = other;
        _signRecovery(c, OPERATOR_PK);
        c.approvals = _quorum(friends, 2, reg.hashReceipt(c.q));
        _recoverReverts(c, R.ReceiptMismatch.selector);            // no new payer authorization for that anchor
        assertFalse(_active(hostId));
    }

    function test_operatorRotationOnlyThroughOwnerConsentedRecovery() public {
        bytes32 hostId = _enrolled();
        vm.prank(address(0xBA11E7));
        reg.setPayoutWallet(hostId);
        R.HostOffline memory o = _offline(hostId);
        o.payee = address(0);
        vm.prank(operator);
        reg.deactivateHost(o);

        RecoveryCase memory c = _recovery(hostId, NEW_OPERATOR_PK);
        _recover(c);
        assertEq(reg.get(hostId).operator, newOperator);
        assertEq(reg.get(hostId).payoutWallet, address(0), "old declaration not carried to a new operator");

        vm.prank(operator);
        vm.expectRevert(R.NotAuthorized.selector);
        reg.setPrices(hostId, 1, 1);
        R.HostOffline memory o2 = _offline(hostId);
        assertEq(o2.operator, newOperator);
        vm.prank(operator);
        vm.expectRevert(R.NotAuthorized.selector);
        reg.deactivateHost(o2);
        vm.prank(newOperator);
        assertTrue(reg.deactivateHost(o2));
    }
}
