// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Test } from "forge-std/Test.sol";
import { EnclaveSecretVault, ISecretVaultBook, ISecretVaultLedger } from "../../EnclaveSecretVault.sol";

contract SVBook {
    mapping(bytes32 => address) public addr;
    function set(bytes32 k, address v) external { addr[k] = v; }
}
contract SVLedger {
    mapping(bytes32 => ISecretVaultLedger.Deployment) private d;
    function setOwner(bytes32 id, address o) external { d[id].id = id; d[id].owner = o; }
    function get(bytes32 id) external view returns (ISecretVaultLedger.Deployment memory) { return d[id]; }
}
contract SVFactory {
    mapping(address => bool) public isVault;
    function add(address v) external { isVault[v] = true; }
}
contract SVSessionVault {
    address public owner;
    constructor(address o) { owner = o; }
}
/// an ERC-1271 owner standing in for the passkey credit vault: valid iff `signer` signed the digest
contract SV1271 {
    address public signer;
    constructor(address s) { signer = s; }
    function isValidSignature(bytes32 h, bytes calldata sig) external view returns (bytes4) {
        if (sig.length != 65) return 0xffffffff;
        bytes32 r = bytes32(sig[0:32]); bytes32 s = bytes32(sig[32:64]); uint8 v = uint8(sig[64]);
        return ecrecover(h, v, r, s) == signer ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

contract EnclaveSecretVaultTest is Test {
    EnclaveSecretVault vault;
    SVBook book;
    SVLedger ledger;
    SVFactory factory;
    uint256 ownerKey = 0xA11CE;
    address owner;
    address stranger = makeAddr("stranger");
    bytes32 constant D = keccak256("deployment-1");
    bytes32 cid;
    address[5] ops;
    uint256[5] opKeys;

    function setUp() public {
        vm.warp(1_800_000_000);
        owner = vm.addr(ownerKey);
        book = new SVBook();
        ledger = new SVLedger();
        factory = new SVFactory();
        book.set("deployments", address(ledger));
        book.set("sessionVaultFactory", address(factory));
        vault = new EnclaveSecretVault(ISecretVaultBook(address(book)));
        ledger.setOwner(D, owner);
        for (uint256 i = 0; i < 5; i++) { opKeys[i] = 0xC0 + i; ops[i] = vm.addr(opKeys[i]); }
        cid = vault.createCommittee(bytes32("c1"), 3, _members(ops, 1));
    }

    function _members(address[5] memory o, uint256 keySalt) internal pure returns (EnclaveSecretVault.Member[] memory m) {
        m = new EnclaveSecretVault.Member[](5);
        for (uint256 i = 0; i < 5; i++) m[i] = EnclaveSecretVault.Member(o[i], keccak256(abi.encode("enc", keySalt, i)), "https://custodian.example/x");
    }
    function _members3(address a, address b, address c) internal pure returns (EnclaveSecretVault.Member[] memory m) {
        m = new EnclaveSecretVault.Member[](3);
        m[0] = EnclaveSecretVault.Member(a, keccak256("k0"), "https://a.example");
        m[1] = EnclaveSecretVault.Member(b, keccak256("k1"), "https://b.example");
        m[2] = EnclaveSecretVault.Member(c, keccak256("k2"), "https://c.example");
    }

    function _policyOnly(uint64 rev) internal view returns (EnclaveSecretVault.Update memory u) {
        u.expectPolicyRev = rev;
        u.setPolicy = true;
        u.committeeId = cid;
        u.rules = bytes('{"v":1}');
    }
    function _withBundle(uint64 rev, uint32 epoch) internal view returns (EnclaveSecretVault.Update memory u) {
        u = _policyOnly(rev);
        u.putBundle = true;
        u.epoch = epoch;
        u.ciphertext = hex"0102030405";
        u.commitments = new bytes(3 * 33);
        u.sealedShares = new bytes[](5);
        for (uint256 i = 0; i < 5; i++) u.sealedShares[i] = new bytes(80);
    }
    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    // ---------------------------------------------------------------- committees
    function test_committeeRejectsBadMembership() public {
        address[5] memory dup = ops; dup[1] = ops[0];
        vm.expectRevert(EnclaveSecretVault.BadMembers.selector);
        vault.createCommittee(bytes32("x"), 3, _members(dup, 1));
        vm.expectRevert(EnclaveSecretVault.BadMembers.selector);
        vault.createCommittee(bytes32("x"), 6, _members(ops, 1));
        vm.expectRevert(EnclaveSecretVault.BadMembers.selector);
        vault.createCommittee(bytes32("x"), 0, _members(ops, 1));
        // same creator + salt twice
        vm.expectRevert(EnclaveSecretVault.BadCommittee.selector);
        vault.createCommittee(bytes32("c1"), 3, _members(ops, 1));
    }

    function test_epochNeedsThresholdOfCurrentMembers() public {
        EnclaveSecretVault.Member[] memory next = _members(ops, 2);   // key rotation: same operators, new keys
        vm.prank(stranger);
        vm.expectRevert(EnclaveSecretVault.NotMember.selector);
        vault.approveEpoch(cid, 3, next);
        vm.prank(ops[0]); vault.approveEpoch(cid, 3, next);
        vm.prank(ops[0]); vault.approveEpoch(cid, 3, next);          // the same member twice counts once
        // a DIFFERENT proposal does not pool approvals with this one
        vm.prank(ops[1]); vault.approveEpoch(cid, 2, next);
        (, uint32 e) = vault.committeeOf(cid);
        assertEq(e, 1);
        vm.prank(ops[1]); vault.approveEpoch(cid, 3, next);
        (, e) = vault.committeeOf(cid);
        assertEq(e, 1);
        vm.prank(ops[2]); vault.approveEpoch(cid, 3, next);
        (, e) = vault.committeeOf(cid);
        assertEq(e, 2);
        (uint8 t,, EnclaveSecretVault.Member[] memory m) = vault.epochOf(cid, 2);
        assertEq(t, 3);
        assertEq(m[0].encKey, next[0].encKey);
        // the stale proposal (against epoch 1) can no longer complete
        vm.prank(ops[3]); vault.approveEpoch(cid, 2, next);
        vm.prank(ops[4]); vault.approveEpoch(cid, 2, next);
        (, e) = vault.committeeOf(cid);
        assertEq(e, 2);
    }

    // ---------------------------------------------------------------- owner writes
    function test_onlyLedgerOwnerRegistersAndThePolicyOwnerIsPinned() public {
        vm.prank(stranger);
        vm.expectRevert(EnclaveSecretVault.NotOwner.selector);
        vault.update(D, _policyOnly(0));
        // the first write must set a policy
        EnclaveSecretVault.Update memory bare;
        vm.prank(owner);
        vm.expectRevert(EnclaveSecretVault.BadRules.selector);
        vault.update(D, bare);
        vm.prank(owner);
        vault.update(D, _withBundle(0, 1));
        (address o, uint64 pr, uint64 sr, bytes32 c,,) = vault.policyOf(D);
        assertEq(o, owner); assertEq(pr, 1); assertEq(sr, 1); assertEq(c, cid);
        (uint64 rev, uint32 ep, bytes memory ct) = vault.bundleOf(D);
        assertEq(rev, 1); assertEq(ep, 1); assertEq(ct, hex"0102030405");
        (bool complete,, bytes memory com, bytes[] memory sh) = vault.sharesOf(D, 1, 1);
        assertTrue(complete); assertEq(com.length, 99); assertEq(sh.length, 5);
    }

    function test_revisionIsTheReplayGuard() public {
        vm.startPrank(owner);
        vault.update(D, _withBundle(0, 1));
        vm.expectRevert(abi.encodeWithSelector(EnclaveSecretVault.StaleRevision.selector, uint64(1), uint64(0)));
        vault.update(D, _withBundle(0, 1));
        vault.update(D, _withBundle(1, 1));
        (, uint64 pr, uint64 sr,,,) = vault.policyOf(D);
        assertEq(pr, 2); assertEq(sr, 2);
        vm.stopPrank();
    }

    function test_bundleShapeIsChecked() public {
        EnclaveSecretVault.Update memory u = _withBundle(0, 2);   // not the committee's current epoch
        vm.startPrank(owner);
        vm.expectRevert(EnclaveSecretVault.BadCommittee.selector);
        vault.update(D, u);
        u = _withBundle(0, 1); u.sealedShares = new bytes[](4);
        vm.expectRevert(EnclaveSecretVault.BadBundle.selector);
        vault.update(D, u);
        u = _withBundle(0, 1); u.commitments = new bytes(2 * 33);
        vm.expectRevert(EnclaveSecretVault.BadBundle.selector);
        vault.update(D, u);
        u = _withBundle(0, 1); u.sealedShares[3] = new bytes(79);
        vm.expectRevert(EnclaveSecretVault.BadBundle.selector);
        vault.update(D, u);
        u = _withBundle(0, 1); u.ciphertext = new bytes(24577);
        vm.expectRevert(EnclaveSecretVault.BadBundle.selector);
        vault.update(D, u);
        u = _withBundle(0, 1); u.clearBundle = true;
        vm.expectRevert(EnclaveSecretVault.BadBundle.selector);
        vault.update(D, u);
        vm.stopPrank();
    }

    function test_committeeChangeNeedsAFreshBundle() public {
        bytes32 c2 = vault.createCommittee(bytes32("c2"), 2, _members3(ops[0], ops[1], ops[2]));
        vm.startPrank(owner);
        vault.update(D, _withBundle(0, 1));
        EnclaveSecretVault.Update memory u = _policyOnly(1);
        u.committeeId = c2;
        vm.expectRevert(EnclaveSecretVault.BadCommittee.selector);
        vault.update(D, u);
        u.clearBundle = true;
        vault.update(D, u);
        (,, uint64 sr, bytes32 c,,) = vault.policyOf(D);
        assertEq(c, c2); assertEq(sr, 2);
        (, , bytes memory ct) = vault.bundleOf(D);
        assertEq(ct.length, 0);
        vm.stopPrank();
    }

    function test_updateBySigEoa() public {
        EnclaveSecretVault.Update memory u = _withBundle(0, 1);
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory sig = _sign(ownerKey, vault.updateDigest(D, u, deadline));
        vm.prank(stranger);                          // a relayer pays the gas; the owner only signed
        vault.updateBySig(D, u, deadline, sig);
        (, uint64 pr,,,,) = vault.policyOf(D);
        assertEq(pr, 1);
        // the same signature again is stale (it named policy revision 0)
        vm.expectRevert(abi.encodeWithSelector(EnclaveSecretVault.StaleRevision.selector, uint64(1), uint64(0)));
        vault.updateBySig(D, u, deadline, sig);
        // a stranger's signature, an expired one, and a signature over different content
        EnclaveSecretVault.Update memory u2 = _withBundle(1, 1);
        bytes memory wrong = _sign(0xBAD, vault.updateDigest(D, u2, deadline));
        vm.expectRevert(EnclaveSecretVault.BadSignature.selector);
        vault.updateBySig(D, u2, deadline, wrong);
        bytes memory good = _sign(ownerKey, vault.updateDigest(D, u2, deadline));
        u2.ciphertext = hex"ff";
        vm.expectRevert(EnclaveSecretVault.BadSignature.selector);
        vault.updateBySig(D, u2, deadline, good);
        u2.ciphertext = hex"0102030405";
        vm.warp(deadline + 1);
        vm.expectRevert(EnclaveSecretVault.Expired.selector);
        vault.updateBySig(D, u2, deadline, good);
    }

    function test_contractOwnerSignsWithErc1271() public {
        uint256 passkey = 0x9A55;                    // stands in for the passkey behind the credit vault
        SV1271 cv = new SV1271(vm.addr(passkey));
        bytes32 d2 = keccak256("passkey-deployment");
        ledger.setOwner(d2, address(cv));
        EnclaveSecretVault.Update memory u = _withBundle(0, 1);
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory notThePasskey = _sign(ownerKey, vault.updateDigest(d2, u, deadline));
        bytes memory byThePasskey = _sign(passkey, vault.updateDigest(d2, u, deadline));
        vm.expectRevert(EnclaveSecretVault.BadSignature.selector);
        vault.updateBySig(d2, u, deadline, notThePasskey);
        vault.updateBySig(d2, u, deadline, byThePasskey);
        (address o,,,,,) = vault.policyOf(d2);
        assertEq(o, address(cv));
    }

    function test_sessionVaultRecordAnswersToTheVaultOwner() public {
        SVSessionVault sv = new SVSessionVault(owner);
        factory.add(address(sv));
        bytes32 d3 = keccak256("session-deployment");
        ledger.setOwner(d3, address(sv));
        assertEq(vault.beneficialOwnerOf(d3), owner);
        vm.prank(address(sv));                        // the session vault itself is not the owner here
        vm.expectRevert(EnclaveSecretVault.NotOwner.selector);
        vault.update(d3, _policyOnly(0));
        vm.prank(owner);
        vault.update(d3, _policyOnly(0));
    }

    function test_transferDestroysTheBundleAndPausesUntilTheNewOwnerActs() public {
        vm.prank(owner);
        vault.update(D, _withBundle(0, 1));
        address newOwner = makeAddr("newOwner");
        ledger.setOwner(D, newOwner);                 // the ledger moved the deployment
        vm.prank(owner);                              // the old owner can no longer write
        vm.expectRevert(EnclaveSecretVault.NotOwner.selector);
        vault.update(D, _withBundle(1, 1));
        vm.prank(newOwner);                           // nor can the new one, until it claims
        vm.expectRevert(EnclaveSecretVault.NotOwner.selector);
        vault.update(D, _withBundle(1, 1));
        vm.prank(stranger);
        vm.expectRevert(EnclaveSecretVault.NotOwner.selector);
        vault.claimPolicy(D);
        vm.prank(newOwner);
        vault.claimPolicy(D);
        (address o, uint64 pr, uint64 sr,, bool paused,) = vault.policyOf(D);
        assertEq(o, newOwner); assertEq(pr, 2); assertEq(sr, 2); assertTrue(paused);
        (, , bytes memory ct) = vault.bundleOf(D);
        assertEq(ct.length, 0);
        vm.prank(newOwner);
        vm.expectRevert(EnclaveSecretVault.NothingToClaim.selector);
        vault.claimPolicy(D);
    }

    /// governance repoints the book at a ledger that names an attacker: the attacker can destroy the bundle (DoS) but the
    /// ciphertext it could have read was public anyway, and no update path lets it redirect the OLD secrets
    function test_repointedLedgerCanOnlyDestroy() public {
        vm.prank(owner);
        vault.update(D, _withBundle(0, 1));
        SVLedger evil = new SVLedger();
        address attacker = makeAddr("attacker");
        evil.setOwner(D, attacker);
        book.set("deployments", address(evil));
        vm.prank(attacker);
        vm.expectRevert(EnclaveSecretVault.NotOwner.selector);
        vault.update(D, _policyOnly(1));              // pinned owner: no rules change for the attacker
        vm.prank(attacker);
        vault.claimPolicy(D);                         // possible, and it wipes the bundle
        (uint64 sr,, bytes memory ct) = vault.bundleOf(D);
        assertEq(ct.length, 0); assertEq(sr, 2);
    }

    // ---------------------------------------------------------------- resharing
    function _rotateCommittee() internal {
        EnclaveSecretVault.Member[] memory next = _members(ops, 2);
        for (uint256 i = 0; i < 3; i++) { vm.prank(ops[i]); vault.approveEpoch(cid, 3, next); }
    }

    function test_reshareMovesTheBundleAtTheNewThreshold() public {
        vm.prank(owner);
        vault.update(D, _withBundle(0, 1));
        // before the new epoch exists nothing can be dealt
        vm.prank(ops[0]);
        vm.expectRevert(EnclaveSecretVault.BadReshare.selector);
        vault.postDeal(D, 2, hex"aa");
        _rotateCommittee();
        vm.prank(stranger);
        vm.expectRevert(EnclaveSecretVault.NotMember.selector);
        vault.postDeal(D, 2, hex"aa");
        vm.prank(ops[0]); vault.postDeal(D, 2, hex"a0");
        vm.prank(ops[0]);
        vm.expectRevert(EnclaveSecretVault.BadReshare.selector);   // once per member
        vault.postDeal(D, 2, hex"a1");
        vm.prank(ops[2]); vault.postDeal(D, 2, hex"a2");
        vm.prank(ops[4]); vault.postDeal(D, 2, hex"a4");
        (uint256 bm, bytes[] memory deals) = vault.dealsOf(D, 1, 1, 2);
        assertEq(bm, 0x15); assertEq(deals[2], hex"a2");

        uint256 src = vault.sourceOf(1, 0x15);
        uint256 tooFew = vault.sourceOf(1, 0x05);
        uint256 notDealt = vault.sourceOf(1, 0x07);
        bytes memory com = new bytes(99);   // C0 = the bundle's (all zero in _withBundle), then the new coefficients
        com[40] = 0x01;
        bytes memory share = new bytes(80);
        // commitments whose constant term is not the bundle's C0 would change the secret: refused
        bytes memory wrongC0 = new bytes(99); wrongC0[0] = 0x03;
        vm.prank(ops[0]);
        vm.expectRevert(EnclaveSecretVault.BadReshare.selector);
        vault.postReshare(D, 2, src, wrongC0, share);
        // a source of two dealers (below the old threshold), or naming a member that did not deal, is refused
        vm.prank(ops[0]);
        vm.expectRevert(EnclaveSecretVault.BadReshare.selector);
        vault.postReshare(D, 2, tooFew, com, share);
        vm.prank(ops[0]);
        vm.expectRevert(EnclaveSecretVault.BadReshare.selector);
        vault.postReshare(D, 2, notDealt, com, share);
        // review M1: a member that posts FIRST with junk commitments (right C0, wrong rest) opens a set of its own; it
        // does not squat the source, and the honest members complete theirs
        bytes memory junk = new bytes(99); junk[60] = 0x09;
        vm.prank(ops[4]); vault.postReshare(D, 2, src, junk, share);
        vm.prank(ops[0]); vault.postReshare(D, 2, src, com, share);
        vm.prank(ops[1]); vault.postReshare(D, 2, src, com, share);
        (, uint32 ep,) = vault.bundleOf(D);
        assertEq(ep, 1);                               // two of three: not yet
        vm.prank(ops[3]); vault.postReshare(D, 2, src, com, share);
        (, ep,) = vault.bundleOf(D);
        assertEq(ep, 2);
        (bool complete, uint256 s, bytes memory gotCom,) = vault.sharesOf(D, 1, 2);
        assertTrue(complete); assertEq(s, vault.shareSetOf(src, com)); assertEq(keccak256(gotCom), keccak256(com));
        // a late member may still post into the completed set, never another set
        vm.prank(ops[2]); vault.postReshare(D, 2, src, com, share);
        vm.prank(ops[4]);
        vm.expectRevert(EnclaveSecretVault.BadReshare.selector);
        vault.postReshare(D, 2, src, junk, share);
        (bool c2,,, bytes[] memory sealedShares) = vault.sharesOf(D, 1, 2);
        assertTrue(c2); assertEq(sealedShares[2].length, 80); assertEq(sealedShares[4].length, 0);
    }

    function test_aNewBundleStartsANewRevisionWithItsOwnShares() public {
        vm.prank(owner); vault.update(D, _withBundle(0, 1));
        _rotateCommittee();
        vm.prank(ops[0]); vault.postDeal(D, 2, hex"a0");
        // the owner puts a new bundle under epoch 2: the old revision's deals are left behind
        vm.prank(owner); vault.update(D, _withBundle(1, 2));
        (uint256 bm,) = vault.dealsOf(D, 2, 2, 3);
        assertEq(bm, 0);
        (uint64 sr, uint32 ep,) = vault.bundleOf(D);
        assertEq(sr, 2); assertEq(ep, 2);
    }
}
