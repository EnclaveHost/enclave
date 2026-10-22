// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Test } from "forge-std/Test.sol";
import { EnclaveSecretVaultV2, IVaultV2Ledger } from "../../variants/EnclaveSecretVaultV2PinnedAuthorities.sol";
import { EnclaveHostOwnership } from "../../EnclaveHostOwnership.sol";
import { EnclaveRegistry } from "../../EnclaveRegistry.sol";

contract V2Book {
    mapping(bytes32 => address) public addr;
    function set(bytes32 k, address v) external { addr[k] = v; }
}
contract V2Ledger {
    mapping(bytes32 => IVaultV2Ledger.Deployment) private d;
    function setOwner(bytes32 id, address o) external { d[id].id = id; d[id].owner = o; }
    function get(bytes32 id) external view returns (IVaultV2Ledger.Deployment memory) { return d[id]; }
}
contract V2Factory {
    mapping(address => bool) public isVault;
    function add(address v) external { isVault[v] = true; }
}
contract V2SessionVault {
    address public owner;
    constructor(address o) { owner = o; }
}
contract V21271 {
    address public signer;
    constructor(address s) { signer = s; }
    function isValidSignature(bytes32 h, bytes calldata sig) external view returns (bytes4) {
        if (sig.length != 65) return 0xffffffff;
        bytes32 r = bytes32(sig[0:32]); bytes32 s = bytes32(sig[32:64]); uint8 v = uint8(sig[64]);
        return ecrecover(h, v, r, s) == signer ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

/// The REAL EnclaveRegistry (schema 5: caps and region appended after payoutWallet) stands behind the book, so the vault's
/// schema-4 prefix decode is exercised against the live struct shape.
contract EnclaveSecretVaultV2Test is Test {
    EnclaveSecretVaultV2 vault;
    V2Book book;
    EnclaveRegistry registry;
    EnclaveHostOwnership ownership;
    V2Ledger ledger;
    V2Factory factory;
    address enclaveOwner = makeAddr("enclaveOwner");
    address otherWallet = makeAddr("someHostsWallet");
    address stranger = makeAddr("stranger");
    bytes32 constant M = keccak256("custodian-measurement-1");
    bytes32 constant M2 = keccak256("custodian-measurement-2");
    bytes Y;

    mapping(address => uint256) idKey;      // machine identity -> its key
    mapping(bytes32 => uint256) opKey;      // registry id -> host operator key

    uint256 ownerKey = 0xA11CE;
    address owner;
    bytes32 constant D = keccak256("deployment-1");

    function setUp() public {
        vm.warp(1_800_000_000);
        book = new V2Book();
        registry = new EnclaveRegistry();
        ledger = new V2Ledger();
        factory = new V2Factory();
        book.set("registry", address(registry));
        book.set("deployments", address(ledger));
        book.set("sessionVaultFactory", address(factory));
        ownership = new EnclaveHostOwnership(address(registry));
        vault = new EnclaveSecretVaultV2(address(book), enclaveOwner, address(ownership));
        Y = abi.encodePacked(bytes1(0x02), keccak256("committee-key"));
        owner = vm.addr(ownerKey);
        ledger.setOwner(D, owner);
    }

    // ================================================================= helpers
    function _psign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest)));
        return abi.encodePacked(r, s, v);
    }
    function _mh(EnclaveSecretVaultV2.Machine memory m) internal pure returns (bytes32) {
        return keccak256(abi.encode(m.identity, m.encKey, keccak256(bytes(m.endpoint)), m.chipId, m.registryId, m.measurement));
    }
    function _hostDigest(EnclaveSecretVaultV2.Machine memory m) internal view returns (bytes32) {
        return keccak256(abi.encode("enclave-custody-v2 host", block.chainid, address(vault), _mh(m)));
    }
    function _hostSig(EnclaveSecretVaultV2.Machine memory m) internal view returns (bytes memory) {
        return _psign(opKey[m.registryId], _hostDigest(m));
    }

    /// a host registered by its own operator; `payout` is what its payout wallet declares (address(0) = none)
    function _host(uint256 seed, address payout) internal returns (bytes32 rid) {
        uint256 k = 0x2000 + seed;
        vm.prank(vm.addr(k));
        rid = registry.register(string.concat("https://host", vm.toString(seed), ".example"), "EnclaveHost/enclave", bytes32(0), 1, 0, address(0));
        opKey[rid] = k;
        if (payout != address(0)) {
            vm.prank(payout); registry.setPayoutWallet(rid);
            (address accepted,,,) = ownership.authority(rid);
            if (accepted == address(0)) {
                vm.prank(vm.addr(k)); ownership.proposeOwner(rid,payout);
                vm.prank(payout); ownership.acceptOwner(rid);
            }
        }
    }
    /// a custodian machine on its own host; Enclave-owned iff `enclave`
    function _machine(uint256 seed, bool enclave) internal returns (EnclaveSecretVaultV2.Machine memory m) {
        bytes32 rid = _host(seed, enclave ? enclaveOwner : otherWallet);
        m = _machineOn(seed, rid);
    }
    function _machineOn(uint256 seed, bytes32 rid) internal returns (EnclaveSecretVaultV2.Machine memory m) {
        uint256 k = 0x1000 + seed;
        m = EnclaveSecretVaultV2.Machine(vm.addr(k), keccak256(abi.encode("enc", seed)), string.concat("https://custodian", vm.toString(seed), ".example"),
                                         keccak256(abi.encode("chip", seed)), rid, M);
        idKey[m.identity] = k;
    }

    function _codeSet() internal pure returns (bytes32[] memory cs) { cs = new bytes32[](1); cs[0] = M; }
    function _independentMachines() internal returns (EnclaveSecretVaultV2.Machine[] memory ms) {
        ms = new EnclaveSecretVaultV2.Machine[](3);
        for (uint256 i; i < 3; i++) ms[i] = _machineOn(800+i, _host(800+i, vm.addr(900+i)));
    }
    function _independentSigs(EnclaveSecretVaultV2.Machine[] memory ms, bytes memory cs, bytes32[] memory codes)
        internal view returns (bytes[] memory sigs) {
        bytes32[] memory hashes = new bytes32[](ms.length);
        for (uint256 i; i < ms.length; i++) hashes[i] = _mh(ms[i]);
        bytes32 digest = keccak256(abi.encode("enclave-custody-v2 independent genesis", block.chainid,
            address(vault), _cid("independent"), keccak256(cs), keccak256(abi.encode(hashes)), keccak256(abi.encode(codes))));
        sigs = new bytes[](ms.length);
        for (uint256 i; i < ms.length; i++) sigs[i] = _psign(idKey[ms[i].identity], digest);
    }
    function _genesisDigest(bytes32 cid, EnclaveSecretVaultV2.Machine memory m, bytes32[] memory cs) internal view returns (bytes32) {
        return keccak256(abi.encode("enclave-custody-v2 genesis", block.chainid, address(vault), cid, keccak256(Y), _mh(m), keccak256(abi.encode(cs))));
    }
    function _cid(bytes32 salt) internal view returns (bytes32) { return keccak256(abi.encode(block.chainid, address(vault), salt, keccak256(Y))); }

    function _genesis(EnclaveSecretVaultV2.Machine memory m) internal returns (bytes32 cid) {
        bytes32[] memory cs = _codeSet();
        cid = vault.createCommittee("salt", m, Y, cs, _psign(idKey[m.identity], _genesisDigest(_cid("salt"), m, cs)), _hostSig(m));
    }

    function _hostSigs(EnclaveSecretVaultV2.Machine[] memory next) internal view returns (bytes[] memory s) {
        s = new bytes[](next.length);
        for (uint256 i = 0; i < next.length; i++) s[i] = _hostSig(next[i]);
    }
    function _handoverDigest(bytes32 cid, EnclaveSecretVaultV2.Machine[] memory next, uint32[] memory dealers) internal view returns (bytes32) {
        (, uint32 epoch,,,) = vault.committeeOf(cid);
        bytes32[] memory hs = new bytes32[](next.length);
        for (uint256 i = 0; i < next.length; i++) hs[i] = _mh(next[i]);
        return keccak256(abi.encode("enclave-custody-v2 handover", block.chainid, address(vault), cid, epoch, keccak256(abi.encode(hs)), keccak256(abi.encode(dealers))));
    }
    function _sigs(address[] memory who, bytes32 digest) internal view returns (bytes[] memory s) {
        s = new bytes[](who.length);
        for (uint256 i = 0; i < who.length; i++) s[i] = _psign(idKey[who[i]], digest);
    }
    function _seq(uint256 t) internal pure returns (uint32[] memory d) { d = new uint32[](t); for (uint256 i = 0; i < t; i++) d[i] = uint32(i + 1); }
    function _current(bytes32 cid) internal view returns (address[] memory ids) {
        (, uint32 epoch,,,) = vault.committeeOf(cid);
        (EnclaveSecretVaultV2.Machine[] memory ms,) = vault.machinesOf(cid, epoch);
        ids = new address[](ms.length);
        for (uint256 i = 0; i < ms.length; i++) ids[i] = ms[i].identity;
    }
    function _list(EnclaveSecretVaultV2.Machine memory a) internal pure returns (EnclaveSecretVaultV2.Machine[] memory l) { l = new EnclaveSecretVaultV2.Machine[](1); l[0] = a; }
    function _list(EnclaveSecretVaultV2.Machine memory a, EnclaveSecretVaultV2.Machine memory b) internal pure returns (EnclaveSecretVaultV2.Machine[] memory l) {
        l = new EnclaveSecretVaultV2.Machine[](2); l[0] = a; l[1] = b;
    }
    function _addrs(address a) internal pure returns (address[] memory l) { l = new address[](1); l[0] = a; }

    /// propose with every current machine approving and dealers 1..t_old
    function _propose(bytes32 cid, EnclaveSecretVaultV2.Machine[] memory next) internal returns (uint32 toEpoch) {
        (,, uint8 tOld,,) = vault.committeeOf(cid);
        uint32[] memory dealers = _seq(tOld);
        address[] memory ap = _current(cid);
        vault.proposeHandover(cid, next, _hostSigs(next), dealers, ap, _sigs(ap, _handoverDigest(cid, next, dealers)));
        (toEpoch,,,,,,) = vault.pendingOf(cid);
    }

    /// the test's own copy of protocol.mjs seatLayout: who holds share index k in `epoch`
    function _holder(bytes32 cid, uint32 epoch, uint32 k) internal view returns (address) {
        (EnclaveSecretVaultV2.Machine[] memory ms, bool[] memory enc) = vault.machinesOf(cid, epoch);
        uint256 others; bool hasE;
        for (uint256 i = 0; i < enc.length; i++) { if (enc[i]) hasE = true; else others++; }
        uint256 n = others + (hasE ? 1 : 0);
        uint256 wE = n >= 3 ? (hasE ? 1 : 0) : others + 1;
        if (k <= wE) { for (uint256 i = 0; i < enc.length; i++) if (enc[i]) return ms[i].identity; }
        uint256 next = wE + 1;
        for (uint256 i = 0; i < enc.length; i++) if (!enc[i]) { if (next == k) return ms[i].identity; next++; }
        revert("no holder");
    }
    function _dealDigest(bytes32 cid, uint32 toEpoch, uint32 k, bytes memory com, bytes[] memory sealedTo) internal view returns (bytes32) {
        return keccak256(abi.encode("enclave-custody-v2 deal", block.chainid, address(vault), cid, toEpoch, k, keccak256(com), keccak256(abi.encode(sealedTo))));
    }
    function _dealParts(uint256 tNew, uint256 n) internal pure returns (bytes memory com, bytes[] memory sealedTo) {
        com = new bytes(tNew * 33);
        for (uint256 j = 0; j < tNew; j++) com[j * 33] = 0x02;
        sealedTo = new bytes[](n);
        for (uint256 i = 0; i < n; i++) sealedTo[i] = abi.encodePacked(keccak256(abi.encode(i)), keccak256(abi.encode(i, 1)));
    }
    function _deal(bytes32 cid, uint32 toEpoch, uint32 k, address dealer) internal {
        (,,, uint8 tNew,,,) = vault.pendingOf(cid);
        (, EnclaveSecretVaultV2.Machine[] memory next,,,,,) = vault.pendingOf(cid);
        (bytes memory com, bytes[] memory sealedTo) = _dealParts(tNew, next.length);
        vault.postDeal(cid, toEpoch, k, com, sealedTo, dealer, _psign(idKey[dealer], _dealDigest(cid, toEpoch, k, com, sealedTo)));
    }
    function _newCommitments(uint256 tNew, uint8 tag) internal view returns (bytes memory c) {
        c = bytes.concat(Y, new bytes((tNew - 1) * 33));
        if (tNew > 1) c[33] = bytes1(tag);
    }
    function _ackSig(bytes32 cid, uint32 toEpoch, bytes memory com, address who) internal view returns (bytes memory) {
        return _psign(idKey[who], keccak256(abi.encode("enclave-custody-v2 ack", block.chainid, address(vault), cid, toEpoch, keccak256(com))));
    }
    function _ackAll(bytes32 cid, uint32 toEpoch) internal {
        (, EnclaveSecretVaultV2.Machine[] memory next,, uint8 tNew,,,) = vault.pendingOf(cid);
        bytes memory com = _newCommitments(tNew, 7);
        for (uint256 i = 0; i < next.length; i++) vault.ackHandover(cid, toEpoch, com, next[i].identity, _ackSig(cid, toEpoch, com, next[i].identity));
    }
    /// a whole handover: propose (all current machines approve), every dealer deals, every new machine acks
    function _handover(bytes32 cid, EnclaveSecretVaultV2.Machine[] memory next) internal returns (uint32 toEpoch) {
        (, uint32 epoch,,,) = vault.committeeOf(cid);
        toEpoch = _propose(cid, next);
        (,,,,, uint32[] memory dealers,) = vault.pendingOf(cid);
        for (uint256 i = 0; i < dealers.length; i++) _deal(cid, toEpoch, dealers[i], _holder(cid, epoch, dealers[i]));
        _ackAll(cid, toEpoch);
        (, uint32 now_,,,) = vault.committeeOf(cid);
        assertEq(now_, toEpoch);
    }

    // ================================================================= genesis


    function _highS(bytes memory sig) internal pure returns (bytes memory) {
        bytes32 r; bytes32 s; uint8 v;
        assembly { r := mload(add(sig, 32)) s := mload(add(sig, 64)) v := byte(0, mload(add(sig, 96))) }
        // s' = n - s (n = the secp256k1 group order) with the other parity: the same signature in its high-s form
        return abi.encodePacked(r, bytes32(0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141 - uint256(s)), v == 27 ? uint8(28) : uint8(27));
    }


    // ================================================================= seats
    function _pendingTW(bytes32 cid) internal view returns (uint8 t, uint8 W) { (,,, t, W,,) = vault.pendingOf(cid); }



    // ================================================================= handover approvals
    function _fiveSeatCommittee() internal returns (bytes32 cid, EnclaveSecretVaultV2.Machine[] memory l) {
        // [e, e2, a, b, c] = 4 seats, t 3
        EnclaveSecretVaultV2.Machine memory e = _machine(1, true);
        cid = _genesis(e);
        l = new EnclaveSecretVaultV2.Machine[](5);
        l[0] = e; l[1] = _machine(2, true); l[2] = _machine(11, false); l[3] = _machine(12, false); l[4] = _machine(13, false);
        _handover(cid, l);
    }

    function test_handoverApprovalWeightCountsTheEnclaveSeatOnce() public {
        (bytes32 cid, EnclaveSecretVaultV2.Machine[] memory l) = _fiveSeatCommittee();
        EnclaveSecretVaultV2.Machine[] memory next = l;
        bytes[] memory hs = _hostSigs(next);
        uint32[] memory dl = _seq(3);
        bytes32 dig = _handoverDigest(cid, next, dl);
        // both Enclave machines: one seat, weight 1
        address[] memory ap = new address[](2); ap[0] = l[0].identity; ap[1] = l[1].identity;
        vm.expectRevert(abi.encodeWithSelector(EnclaveSecretVaultV2.Weight.selector, uint256(1), uint256(3)));
        vault.proposeHandover(cid, next, hs, dl, ap, _sigs(ap, dig));
        // both Enclave machines + a: weight 2
        ap = new address[](3); ap[0] = l[0].identity; ap[1] = l[1].identity; ap[2] = l[2].identity;
        vm.expectRevert(abi.encodeWithSelector(EnclaveSecretVaultV2.Weight.selector, uint256(2), uint256(3)));
        vault.proposeHandover(cid, next, hs, dl, ap, _sigs(ap, dig));
        // a twice + b: weight 2 (a machine counts once)
        ap = new address[](3); ap[0] = l[2].identity; ap[1] = l[2].identity; ap[2] = l[3].identity;
        vm.expectRevert(abi.encodeWithSelector(EnclaveSecretVaultV2.Weight.selector, uint256(2), uint256(3)));
        vault.proposeHandover(cid, next, hs, dl, ap, _sigs(ap, dig));
        // a stranger's signature is not a current machine
        address s = vm.addr(0x5555); idKey[s] = 0x5555;
        ap = new address[](3); ap[0] = l[2].identity; ap[1] = l[3].identity; ap[2] = s;
        vm.expectRevert(EnclaveSecretVaultV2.NotMachine.selector);
        vault.proposeHandover(cid, next, hs, dl, ap, _sigs(ap, dig));
        // a signature by the wrong key for an approver
        ap = new address[](3); ap[0] = l[2].identity; ap[1] = l[3].identity; ap[2] = l[4].identity;
        bytes[] memory sg = _sigs(ap, dig); sg[2] = _psign(0x5555, dig);
        vm.expectRevert(EnclaveSecretVaultV2.BadSignature.selector);
        vault.proposeHandover(cid, next, hs, dl, ap, sg);
        // a signature over another proposal (other dealers)
        sg = _sigs(ap, _handoverDigest(cid, next, _seq(2)));
        vm.expectRevert(EnclaveSecretVaultV2.BadSignature.selector);
        vault.proposeHandover(cid, next, hs, dl, ap, sg);
        // three non-Enclave seats: weight 3
        vault.proposeHandover(cid, next, hs, dl, ap, _sigs(ap, dig));
        vm.warp(block.timestamp + 1 days);
        // one Enclave machine + two others: weight 3
        ap = new address[](3); ap[0] = l[1].identity; ap[1] = l[2].identity; ap[2] = l[4].identity;
        vault.proposeHandover(cid, next, hs, dl, ap, _sigs(ap, dig));
    }

    function test_twoSeatCommitteeEnclaveAloneApproves() public {
        EnclaveSecretVaultV2.Machine memory e = _machine(1, true);
        EnclaveSecretVaultV2.Machine memory a = _machine(11, false);
        bytes32 cid = _genesis(e);
        _handover(cid, _list(e, a));                       // t 2, Enclave holds 1,2; a holds 3
        EnclaveSecretVaultV2.Machine[] memory next = _list(e, a);
        bytes[] memory hs = _hostSigs(next);
        uint32[] memory dl = _seq(2);
        bytes32 dig = _handoverDigest(cid, next, dl);
        address[] memory ap = _addrs(a.identity);
        vm.expectRevert(abi.encodeWithSelector(EnclaveSecretVaultV2.Weight.selector, uint256(1), uint256(2)));
        vault.proposeHandover(cid, next, hs, dl, ap, _sigs(ap, dig));
        ap = _addrs(e.identity);
        vault.proposeHandover(cid, next, hs, dl, ap, _sigs(ap, dig));
        // the Enclave machine deals both of its indices; a cannot deal index 1
        (, uint32 epoch,,,) = vault.committeeOf(cid);
        (uint32 to,,,,,,) = vault.pendingOf(cid);
        (bytes memory com, bytes[] memory st) = _dealParts(2, 2);
        bytes memory sig = _psign(idKey[a.identity], _dealDigest(cid, to, 1, com, st));
        vm.expectRevert(EnclaveSecretVaultV2.BadDealers.selector);
        vault.postDeal(cid, to, 1, com, st, a.identity, sig);
        _deal(cid, to, 1, e.identity);
        _deal(cid, to, 2, e.identity);
        _ackAll(cid, to);
        (, uint32 e2,,,) = vault.committeeOf(cid);
        assertEq(e2, epoch + 1);
    }

    function test_dealerIndicesAreValidated() public {
        (bytes32 cid, EnclaveSecretVaultV2.Machine[] memory l) = _fiveSeatCommittee();   // t 3, W 4
        bytes[] memory hs = _hostSigs(l);
        address[] memory ap = _current(cid);
        uint32[][] memory bad = new uint32[][](5);
        bad[0] = _seq(2);                                               // too few
        bad[1] = _seq(4);                                               // too many
        bad[2] = new uint32[](3); bad[2][0] = 0; bad[2][1] = 1; bad[2][2] = 2;     // index 0
        bad[3] = new uint32[](3); bad[3][0] = 1; bad[3][1] = 2; bad[3][2] = 5;     // above W
        bad[4] = new uint32[](3); bad[4][0] = 2; bad[4][1] = 3; bad[4][2] = 2;     // duplicate
        for (uint256 i = 0; i < bad.length; i++) {
            bytes[] memory sg = _sigs(ap, _handoverDigest(cid, l, bad[i]));
            vm.expectRevert(EnclaveSecretVaultV2.BadDealers.selector);
            vault.proposeHandover(cid, l, hs, bad[i], ap, sg);
        }
        uint32[] memory ok = new uint32[](3); ok[0] = 4; ok[1] = 1; ok[2] = 3;
        vault.proposeHandover(cid, l, hs, ok, ap, _sigs(ap, _handoverDigest(cid, l, ok)));
        (,,,,, uint32[] memory dealers,) = vault.pendingOf(cid);
        assertEq(dealers.length, 3); assertEq(dealers[0], 4);
    }

    function test_postDealOnlyByTheHolderOfThatIndex() public {
        (bytes32 cid, EnclaveSecretVaultV2.Machine[] memory l) = _fiveSeatCommittee();   // e,e2 -> 1; a 2; b 3; c 4
        uint32[] memory dl = new uint32[](3); dl[0] = 1; dl[1] = 2; dl[2] = 3;
        address[] memory ap = _current(cid);
        vault.proposeHandover(cid, l, _hostSigs(l), dl, ap, _sigs(ap, _handoverDigest(cid, l, dl)));
        (uint32 to,,, uint8 tNew,,,) = vault.pendingOf(cid);
        (bytes memory com, bytes[] memory st) = _dealParts(tNew, l.length);
        // b (index 3) posting index 2
        bytes memory sig = _psign(idKey[l[3].identity], _dealDigest(cid, to, 2, com, st));
        vm.expectRevert(EnclaveSecretVaultV2.BadDealers.selector);
        vault.postDeal(cid, to, 2, com, st, l[3].identity, sig);
        // index 4 is c's, but not one of the proposal's dealers
        sig = _psign(idKey[l[4].identity], _dealDigest(cid, to, 4, com, st));
        vm.expectRevert(EnclaveSecretVaultV2.BadDealers.selector);
        vault.postDeal(cid, to, 4, com, st, l[4].identity, sig);
        // a non-machine
        address s = vm.addr(0x5555);
        sig = _psign(0x5555, _dealDigest(cid, to, 2, com, st));
        vm.expectRevert(EnclaveSecretVaultV2.NotMachine.selector);
        vault.postDeal(cid, to, 2, com, st, s, sig);
        // a's index, signed by someone else
        vm.expectRevert(EnclaveSecretVaultV2.BadSignature.selector);
        vault.postDeal(cid, to, 2, com, st, l[2].identity, sig);
        // shape: wrong commitment count, wrong envelope count, empty envelope
        bytes memory shortCom = new bytes((tNew - 1) * 33);
        vm.expectRevert(EnclaveSecretVaultV2.BadDeal.selector);
        vault.postDeal(cid, to, 2, shortCom, st, l[2].identity, _psign(idKey[l[2].identity], _dealDigest(cid, to, 2, shortCom, st)));
        bytes[] memory fewer = new bytes[](4);
        for (uint256 i = 0; i < 4; i++) fewer[i] = st[i];
        vm.expectRevert(EnclaveSecretVaultV2.BadDeal.selector);
        vault.postDeal(cid, to, 2, com, fewer, l[2].identity, _psign(idKey[l[2].identity], _dealDigest(cid, to, 2, com, fewer)));
        // the wrong toEpoch
        vm.expectRevert(EnclaveSecretVaultV2.NoPending.selector);
        vault.postDeal(cid, to + 1, 2, com, st, l[2].identity, sig);
        // the Enclave replica e2 deals the Enclave seat's index; a deals its own; once per index
        _deal(cid, to, 1, l[1].identity);
        vm.expectRevert(EnclaveSecretVaultV2.BadDealers.selector);
        this.dealExt(cid, to, 1, l[0].identity);
        _deal(cid, to, 2, l[2].identity);
        (bytes memory gotCom, bytes[] memory gotSt) = vault.dealOf(cid, to, 2);
        assertEq(keccak256(gotCom), keccak256(com)); assertEq(gotSt.length, 5); assertEq(keccak256(gotSt[4]), keccak256(st[4]));
    }
    function dealExt(bytes32 cid, uint32 to, uint32 k, address dealer) external { _deal(cid, to, k, dealer); }

    function test_ackRulesAndActivation() public {
        (bytes32 cid, EnclaveSecretVaultV2.Machine[] memory l) = _fiveSeatCommittee();
        // next: drop c -> [e, e2, a, b] = 3 seats, t 2
        EnclaveSecretVaultV2.Machine[] memory next = new EnclaveSecretVaultV2.Machine[](4);
        for (uint256 i = 0; i < 4; i++) next[i] = l[i];
        uint32 to = _propose(cid, next);
        (,,, uint8 tNew,,,) = vault.pendingOf(cid);
        assertEq(tNew, 2);
        bytes memory com = _newCommitments(tNew, 7);
        // acks wait for every dealer's deal
        bytes memory sig = _ackSig(cid, to, com, next[0].identity);
        vm.expectRevert(EnclaveSecretVaultV2.BadAck.selector);
        vault.ackHandover(cid, to, com, next[0].identity, sig);
        _deal(cid, to, 1, l[0].identity);
        _deal(cid, to, 2, l[2].identity);
        _deal(cid, to, 3, l[3].identity);
        // C0 != Y
        bytes memory badC0 = bytes.concat(com); badC0[1] = bytes1(uint8(badC0[1]) ^ 1);
        vm.expectRevert(EnclaveSecretVaultV2.BadAck.selector);
        vault.ackHandover(cid, to, badC0, next[0].identity, _ackSig(cid, to, badC0, next[0].identity));
        // the wrong length (t_new - 1 points)
        bytes memory shortCom = Y;
        vm.expectRevert(EnclaveSecretVaultV2.BadAck.selector);
        vault.ackHandover(cid, to, shortCom, next[0].identity, _ackSig(cid, to, shortCom, next[0].identity));
        // c is not in next
        vm.expectRevert(EnclaveSecretVaultV2.NotMachine.selector);
        vault.ackHandover(cid, to, com, l[4].identity, _ackSig(cid, to, com, l[4].identity));
        // a signature by another machine
        vm.expectRevert(EnclaveSecretVaultV2.BadSignature.selector);
        vault.ackHandover(cid, to, com, next[1].identity, sig);
        vault.ackHandover(cid, to, com, next[0].identity, sig);
        assertEq(vault.ackCount(cid, to), 1);
        // twice
        vm.expectRevert(EnclaveSecretVaultV2.BadAck.selector);
        vault.ackHandover(cid, to, com, next[0].identity, sig);
        // different commitments from the first ack
        bytes memory other = _newCommitments(tNew, 9);
        vm.expectRevert(EnclaveSecretVaultV2.BadAck.selector);
        vault.ackHandover(cid, to, other, next[1].identity, _ackSig(cid, to, other, next[1].identity));
        vault.ackHandover(cid, to, com, next[1].identity, _ackSig(cid, to, com, next[1].identity));
        vault.ackHandover(cid, to, com, next[2].identity, _ackSig(cid, to, com, next[2].identity));
        (, uint32 epoch,,,) = vault.committeeOf(cid);
        assertEq(epoch, to - 1);                           // 3 of 4: not yet
        vm.expectEmit(true, false, false, true);
        emit EnclaveSecretVaultV2.EpochActivated(cid, to);
        vault.ackHandover(cid, to, com, next[3].identity, _ackSig(cid, to, com, next[3].identity));
        (bytes memory y, uint32 e2, uint8 t, uint8 W, uint64 at) = vault.committeeOf(cid);
        assertEq(y, Y); assertEq(e2, to); assertEq(t, 2); assertEq(W, 3); assertEq(at, block.timestamp);
        assertEq(vault.commitmentsOf(cid, to), com);
        (EnclaveSecretVaultV2.Machine[] memory ms,) = vault.machinesOf(cid, to);
        assertEq(ms.length, 4);
        (uint32 pend,,,,,,) = vault.pendingOf(cid);
        assertEq(pend, 0);
        // the old machine c is no longer an approver
        address[] memory ap = _addrs(l[4].identity);
        uint32[] memory dl = _seq(2);
        bytes[] memory sg = _sigs(ap, _handoverDigest(cid, next, dl));
        bytes[] memory hs = _hostSigs(next);
        vm.expectRevert(EnclaveSecretVaultV2.NotMachine.selector);
        vault.proposeHandover(cid, next, hs, dl, ap, sg);
    }


    // ================================================================= code set
    function _codeSigs(bytes32 cid, bytes32 m, bool add, address[] memory ap) internal view returns (bytes[] memory) {
        (, uint32 epoch,,,) = vault.committeeOf(cid);
        return _sigs(ap, keccak256(abi.encode("enclave-custody-v2 code", block.chainid, address(vault), cid, epoch, m, add)));
    }


    // ================================================================= Enclave flag and uniqueness




    /// the spec's maximum: 96 machines (33 Enclave replicas + 63 other hosts = 64 seats), 40-byte endpoints. Reports the gas
    /// of each step (forge test -vv) so the per-transaction gas cap can be judged.

    // ================================================================= policies and bundles
    function _committee() internal returns (bytes32) { return _genesis(_machine(1, true)); }
    function _policyOnly(bytes32 cid, uint64 rev) internal pure returns (EnclaveSecretVaultV2.Update memory u) {
        u.expectPolicyRev = rev;
        u.setPolicy = true;
        u.committeeId = cid;
        u.rules = bytes('{"v":1}');
    }
    function _withBundle(bytes32 cid, uint64 rev) internal pure returns (EnclaveSecretVaultV2.Update memory u) {
        u = _policyOnly(cid, rev);
        u.setBundle = true;
        u.bundle = new bytes(200);
        u.bundle[0] = 0x02;
    }
    function _sign712(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }










}
