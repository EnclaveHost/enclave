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




    function dealExt(bytes32 cid, uint32 to, uint32 k, address dealer) external { _deal(cid, to, k, dealer); }


    function test_expiredPendingProposalIsReplaceable() public {
        (bytes32 cid, EnclaveSecretVaultV2.Machine[] memory l) = _fiveSeatCommittee();
        (, uint32 epoch,,,) = vault.committeeOf(cid);
        uint32 to = _propose(cid, l);
        assertEq(to, epoch + 1);
        (,,,,,, uint64 expires) = vault.pendingOf(cid);
        assertEq(expires, block.timestamp + 1 days);
        _deal(cid, to, 1, l[0].identity);
        // a second proposal before expiry
        EnclaveSecretVaultV2.Machine[] memory next = new EnclaveSecretVaultV2.Machine[](4);
        for (uint256 i = 0; i < 4; i++) next[i] = l[i];
        uint32[] memory dl = _seq(3);
        address[] memory ap = _current(cid);
        bytes[] memory hs = _hostSigs(next);
        bytes[] memory sg = _sigs(ap, _handoverDigest(cid, next, dl));
        vm.warp(expires - 1);
        vm.expectRevert(EnclaveSecretVaultV2.Pending.selector);
        vault.proposeHandover(cid, next, hs, dl, ap, sg);
        vm.warp(expires);
        vault.proposeHandover(cid, next, hs, dl, ap, sg);
        // the replacement takes a FRESH epoch number, so the replaced round's deals and acks cannot be replayed into it
        (uint32 to2, EnclaveSecretVaultV2.Machine[] memory pn,,,,,) = vault.pendingOf(cid);
        assertEq(to2, to + 1); assertEq(pn.length, 4);
        vm.expectRevert(EnclaveSecretVaultV2.NoPending.selector);
        this.dealExt(cid, to, 2, l[2].identity);
        (bytes memory oldCom,) = vault.dealOf(cid, to2, 1);
        assertEq(oldCom.length, 0);
        _deal(cid, to2, 1, l[0].identity);
        _deal(cid, to2, 2, l[2].identity);
        _deal(cid, to2, 3, l[3].identity);
        _ackAll(cid, to2);
        (, uint32 now_,,,) = vault.committeeOf(cid);
        assertEq(now_, to2);
    }

    // ================================================================= code set
    function _codeSigs(bytes32 cid, bytes32 m, bool add, address[] memory ap) internal view returns (bytes[] memory) {
        (, uint32 epoch,,,) = vault.committeeOf(cid);
        return _sigs(ap, keccak256(abi.encode("enclave-custody-v2 code", block.chainid, address(vault), cid, epoch, m, add)));
    }

    function test_proposeCodeIsTimelockedAndRemoveIsImmediate() public {
        (bytes32 cid, EnclaveSecretVaultV2.Machine[] memory l) = _fiveSeatCommittee();
        // weight: two Enclave machines + a = 2 < 3
        address[] memory weak = new address[](3); weak[0] = l[0].identity; weak[1] = l[1].identity; weak[2] = l[2].identity;
        bytes[] memory weakSigs = _codeSigs(cid, M2, true, weak);
        vm.expectRevert(abi.encodeWithSelector(EnclaveSecretVaultV2.Weight.selector, uint256(2), uint256(3)));
        vault.proposeCode(cid, M2, weak, weakSigs);
        address[] memory ap = new address[](3); ap[0] = l[0].identity; ap[1] = l[2].identity; ap[2] = l[3].identity;
        // an approval for removal does not add
        bytes[] memory rm = _codeSigs(cid, M2, false, ap);
        vm.expectRevert(EnclaveSecretVaultV2.BadSignature.selector);
        vault.proposeCode(cid, M2, ap, rm);
        bytes[] memory add = _codeSigs(cid, M2, true, ap);
        vault.proposeCode(cid, M2, ap, add);
        uint64 activeAt = uint64(block.timestamp) + 7 days;
        assertEq(vault.codeActiveAt(cid, M2), activeAt);
        // the same approvals again: consumed
        vm.expectRevert(EnclaveSecretVaultV2.BadSignature.selector);
        vault.proposeCode(cid, M2, ap, add);

        // a machine running M2 cannot join before the delay has passed
        EnclaveSecretVaultV2.Machine[] memory next = new EnclaveSecretVaultV2.Machine[](5);
        for (uint256 i = 0; i < 5; i++) next[i] = l[i];
        EnclaveSecretVaultV2.Machine memory up = _machine(21, false); up.measurement = M2;
        next[4] = up;
        uint32[] memory dl = _seq(3);
        bytes[] memory hs = _hostSigs(next);
        address[] memory all = _current(cid);
        bytes[] memory sg = _sigs(all, _handoverDigest(cid, next, dl));
        vm.warp(activeAt - 1);
        vm.expectRevert(EnclaveSecretVaultV2.BadCode.selector);
        vault.proposeHandover(cid, next, hs, dl, all, sg);
        vm.warp(activeAt);
        vault.proposeHandover(cid, next, hs, dl, all, sg);
        (uint32 to,,,,,,) = vault.pendingOf(cid);

        // removing M2 is immediate, and a pending handover onto it can no longer activate
        rm = _codeSigs(cid, M2, false, ap);
        vault.removeCode(cid, M2, ap, rm);
        assertEq(vault.codeActiveAt(cid, M2), 0);
        vm.expectRevert(EnclaveSecretVaultV2.BadSignature.selector);
        vault.removeCode(cid, M2, ap, rm);                 // consumed
        _deal(cid, to, 1, l[0].identity);
        _deal(cid, to, 2, l[2].identity);
        _deal(cid, to, 3, l[3].identity);
        (,,, uint8 tNew,,,) = vault.pendingOf(cid);
        bytes memory com = _newCommitments(tNew, 7);
        for (uint256 i = 0; i < 4; i++) vault.ackHandover(cid, to, com, next[i].identity, _ackSig(cid, to, com, next[i].identity));
        bytes memory last = _ackSig(cid, to, com, next[4].identity);
        vm.expectRevert(EnclaveSecretVaultV2.BadCode.selector);
        vault.ackHandover(cid, to, com, next[4].identity, last);
        // removing something not in the set; proposing the zero measurement
        bytes[] memory rm3 = _codeSigs(cid, keccak256("never"), false, ap);
        vm.expectRevert(EnclaveSecretVaultV2.BadCode.selector);
        vault.removeCode(cid, keccak256("never"), ap, rm3);
        bytes[] memory z = _codeSigs(cid, bytes32(0), true, ap);
        vm.expectRevert(EnclaveSecretVaultV2.BadCode.selector);
        vault.proposeCode(cid, bytes32(0), ap, z);
        // the genesis code can be removed at once too
        bytes[] memory rmM = _codeSigs(cid, M, false, ap);
        vault.removeCode(cid, M, ap, rmM);
        assertEq(vault.codeActiveAt(cid, M), 0);
    }

    // ================================================================= Enclave flag and uniqueness
    function test_aHostNamingAnotherWalletIsNotEnclave() public {
        EnclaveSecretVaultV2.Machine memory e = _machine(1, true);
        bytes32 cid = _genesis(e);
        // a host whose payout wallet is NOT the Enclave wallet: listed as a regular seat, whatever it calls itself
        EnclaveSecretVaultV2.Machine memory fake = _machine(30, false);
        fake.endpoint = "https://enclave-official.example";
        _propose(cid, _list(e, fake));
        (,, bool[] memory enc, uint8 t, uint8 W,,) = vault.pendingOf(cid);
        assertTrue(enc[0]); assertFalse(enc[1]); assertEq(t, 2); assertEq(W, 3);
        // nor can it borrow an Enclave host's registry entry: its own operator key does not sign for that entry
        EnclaveSecretVaultV2.Machine memory borrow = _machineOn(31, e.registryId);
        EnclaveSecretVaultV2.Machine[] memory next = _list(e, borrow);
        bytes[] memory hs = new bytes[](2);
        hs[0] = _hostSig(e);
        hs[1] = _psign(0x2000 + 30, _hostDigest(borrow));     // signed by the fake host's operator
        uint32[] memory dl = _seq(1);
        address[] memory ap = _addrs(e.identity);
        bytes[] memory sg = _sigs(ap, _handoverDigest(cid, next, dl));
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(EnclaveSecretVaultV2.BadHost.selector);
        vault.proposeHandover(cid, next, hs, dl, ap, sg);
        // and it cannot open a committee
        bytes32[] memory cs = _codeSet();
        bytes memory idSig = _psign(idKey[fake.identity], _genesisDigest(_cid("x"), fake, cs));
        bytes memory fh = _hostSig(fake);
        vm.expectRevert(EnclaveSecretVaultV2.NotEnclave.selector);
        vault.createCommittee("x", fake, Y, cs, idSig, fh);
    }

    function test_chipIdUniqueAmongNonEnclaveMachines() public {
        EnclaveSecretVaultV2.Machine memory e = _machine(1, true);
        bytes32 cid = _genesis(e);
        EnclaveSecretVaultV2.Machine memory a = _machine(11, false);
        EnclaveSecretVaultV2.Machine memory b = _machine(12, false);
        EnclaveSecretVaultV2.Machine memory e2 = _machine(2, true);
        // two non-Enclave machines on one chip
        b.chipId = a.chipId;
        EnclaveSecretVaultV2.Machine[] memory l = new EnclaveSecretVaultV2.Machine[](3);
        l[0] = e; l[1] = a; l[2] = b;
        bytes[] memory hs = _hostSigs(l);
        uint32[] memory dl = _seq(1);
        address[] memory ap = _addrs(e.identity);
        bytes[] memory sg = _sigs(ap, _handoverDigest(cid, l, dl));
        vm.expectRevert(EnclaveSecretVaultV2.BadMachine.selector);
        vault.proposeHandover(cid, l, hs, dl, ap, sg);
        // the same identity twice
        b = _machine(12, false); b.identity = a.identity;
        l[2] = b; hs = _hostSigs(l); sg = _sigs(ap, _handoverDigest(cid, l, dl));
        vm.expectRevert(EnclaveSecretVaultV2.BadMachine.selector);
        vault.proposeHandover(cid, l, hs, dl, ap, sg);
        // Enclave replicas on one chip (an upgrade in place), and an Enclave machine sharing a chip with another host: fine
        e2.chipId = e.chipId;
        b = _machine(12, false); b.chipId = e.chipId;
        l = new EnclaveSecretVaultV2.Machine[](4); l[0] = e; l[1] = e2; l[2] = a; l[3] = b;
        _propose(cid, l);
        (,, bool[] memory enc, uint8 t,,,) = vault.pendingOf(cid);
        assertTrue(enc[1]); assertEq(t, 2);
        // shape: an empty endpoint, an over-long one
        vm.warp(block.timestamp + 1 days);
        a.endpoint = "";
        l = _list(e, a); hs = _hostSigs(l); sg = _sigs(ap, _handoverDigest(cid, l, dl));
        vm.expectRevert(EnclaveSecretVaultV2.BadMachine.selector);
        vault.proposeHandover(cid, l, hs, dl, ap, sg);
        a.endpoint = string(new bytes(191));
        l = _list(e, a); hs = _hostSigs(l); sg = _sigs(ap, _handoverDigest(cid, l, dl));
        vm.expectRevert(EnclaveSecretVaultV2.BadMachine.selector);
        vault.proposeHandover(cid, l, hs, dl, ap, sg);
    }

    function test_unknownCommitteeAndLimits() public {
        EnclaveSecretVaultV2.Machine[] memory none = new EnclaveSecretVaultV2.Machine[](0);
        vm.expectRevert(EnclaveSecretVaultV2.BadCommittee.selector);
        vault.proposeHandover(keccak256("nope"), none, new bytes[](0), new uint32[](0), new address[](0), new bytes[](0));
        vm.expectRevert(EnclaveSecretVaultV2.BadCommittee.selector);
        vault.proposeCode(keccak256("nope"), M2, new address[](0), new bytes[](0));
        bytes32 cid = _genesis(_machine(1, true));
        vm.expectRevert(EnclaveSecretVaultV2.BadSeats.selector);
        vault.proposeHandover(cid, none, new bytes[](0), _seq(1), new address[](0), new bytes[](0));
        EnclaveSecretVaultV2.Machine[] memory many = new EnclaveSecretVaultV2.Machine[](97);
        vm.expectRevert(EnclaveSecretVaultV2.BadSeats.selector);
        vault.proposeHandover(cid, many, new bytes[](97), _seq(1), new address[](0), new bytes[](0));
    }


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
