// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {MiniTest} from "./MiniTest.sol";
import {ReleaseAnchor} from "../src/ReleaseAnchor.sol";

contract ReleaseAnchorTest is MiniTest {
    ReleaseAnchor a;
    address owner = makeAddr("owner");
    address del = makeAddr("delegate");
    address other = makeAddr("other");
    bytes32 constant NAME = keccak256("peer-multihash");
    string constant CID0 = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
    string constant CID1 = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
    string constant CID2 = "bafybeibml5uieyxa5tufngvg7fgwbkwvlsuntwbxgtskoqynbt7wlchmfm";

    event Published(uint64 indexed seq, string cid, address indexed by);
    event DelegateSet(address delegate, uint64 until);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Retired(address successor, uint64 seq);

    function setUp() public {
        vm.warp(1_800_000_000);
        a = new ReleaseAnchor(owner, NAME, CID0);
    }

    function _state()
        internal
        view
        returns (bytes32 schema, bytes32 nh, uint64 seq, string memory cid, address o, address d, uint64 until, bool retired, address succ)
    {
        return a.state();
    }

    function _appoint() internal {
        vm.prank(owner);
        a.setDelegate(del, uint64(block.timestamp + 30 days));
    }

    // ---- construction --------------------------------------------------------------------------------------------

    function test_constructorState() public view {
        (bytes32 schema, bytes32 nh, uint64 seq, string memory cid, address o, address d, uint64 until, bool r, address s) = _state();
        assertEq(schema, keccak256("enclave.ipns-release-anchor.v1"));
        assertEq(schema, a.SCHEMA());
        assertEq(nh, NAME);
        assertEq(seq, 1);
        assertEq(cid, CID0);
        assertEq(o, owner);
        assertEq(d, address(0));
        assertEq(until, 0);
        assertFalse(r);
        assertEq(s, address(0));
        assertEq(a.MAX_DELEGATION_SECS(), 180 days);
    }

    function test_constructorRejects() public {
        vm.expectRevert(ReleaseAnchor.ZeroAddress.selector);
        new ReleaseAnchor(address(0), NAME, CID0);
        vm.expectRevert(ReleaseAnchor.BadName.selector);
        new ReleaseAnchor(owner, bytes32(0), CID0);
        vm.expectRevert(ReleaseAnchor.BadCid.selector);
        new ReleaseAnchor(owner, NAME, "/ipfs/bafy");
    }

    // ---- publish: CAS, authorization, expiry ---------------------------------------------------------------------

    function test_ownerPublishCas() public {
        vm.expectEmit(true, true, false, true, address(a));
        emit Published(2, CID1, owner);
        vm.prank(owner);
        a.publish(CID1, 1);
        assertEq(a.seq(), 2);
        assertEq(a.cid(), CID1);
        // the same transaction replayed (same expectedSeq) fails: no off-chain replay can move the anchor
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ReleaseAnchor.StaleSeq.selector, uint64(1), uint64(2)));
        a.publish(CID0, 1);
        assertEq(a.cid(), CID1);
    }

    function test_delegatePublishWithinWindow() public {
        _appoint();
        vm.prank(del);
        a.publish(CID1, 1);
        assertEq(a.seq(), 2);
        // exactly at the bound is still allowed; one second after is not
        vm.warp(block.timestamp + 30 days);
        vm.prank(del);
        a.publish(CID2, 2);
        vm.warp(block.timestamp + 1);
        vm.prank(del);
        vm.expectRevert(ReleaseAnchor.NotAuthorized.selector);
        a.publish(CID1, 3);
        assertEq(a.seq(), 3);
    }

    function test_strangerCannotPublish() public {
        _appoint();
        vm.prank(other);
        vm.expectRevert(ReleaseAnchor.NotAuthorized.selector);
        a.publish(CID1, 1);
    }

    function test_delegateHasNoOtherPower() public {
        _appoint();
        vm.startPrank(del);
        vm.expectRevert(ReleaseAnchor.NotOwner.selector);
        a.pin(CID1);
        vm.expectRevert(ReleaseAnchor.NotOwner.selector);
        a.setDelegate(del, uint64(block.timestamp + 180 days));
        vm.expectRevert(ReleaseAnchor.NotOwner.selector);
        a.setDelegate(other, uint64(block.timestamp + 1 days));
        vm.expectRevert(ReleaseAnchor.NotOwner.selector);
        a.transferOwnership(del);
        vm.expectRevert(ReleaseAnchor.NotPendingOwner.selector);
        a.acceptOwnership();
        vm.expectRevert(ReleaseAnchor.NotOwner.selector);
        a.retire(del);
        vm.stopPrank();
        assertEq(a.owner(), owner);
        assertEq(a.delegateUntil(), uint64(block.timestamp + 30 days));
    }

    // ---- delegation bounds and revocation ------------------------------------------------------------------------

    function test_delegationBounds() public {
        vm.startPrank(owner);
        vm.expectRevert(ReleaseAnchor.BadDelegation.selector);
        a.setDelegate(del, uint64(block.timestamp));
        vm.expectRevert(ReleaseAnchor.BadDelegation.selector);
        a.setDelegate(del, uint64(block.timestamp + 180 days + 1));
        vm.expectRevert(ReleaseAnchor.BadDelegation.selector);
        a.setDelegate(address(0), 5);
        a.setDelegate(del, uint64(block.timestamp + 180 days));
        assertEq(a.delegate(), del);
        vm.expectEmit(false, false, false, true, address(a));
        emit DelegateSet(address(0), 0);
        a.setDelegate(address(0), 0);
        vm.stopPrank();
        assertEq(a.delegate(), address(0));
        vm.prank(del);
        vm.expectRevert(ReleaseAnchor.NotAuthorized.selector);
        a.publish(CID1, 1);
    }

    function test_pinOverridesAndRevokes() public {
        _appoint();
        vm.prank(del);
        a.publish(CID1, 1); // the delegate's (say, compromised) release
        vm.expectEmit(false, false, false, true, address(a));
        emit DelegateSet(address(0), 0);
        vm.expectEmit(true, true, false, true, address(a));
        emit Published(3, CID2, owner);
        vm.prank(owner);
        a.pin(CID2); // no expectedSeq: a racing delegate publish cannot make the override fail
        assertEq(a.seq(), 3);
        assertEq(a.cid(), CID2);
        assertEq(a.delegate(), address(0));
        vm.prank(del);
        vm.expectRevert(ReleaseAnchor.NotAuthorized.selector);
        a.publish(CID1, 3);
    }

    // ---- ownership -----------------------------------------------------------------------------------------------

    function test_twoStepOwnershipClearsDelegate() public {
        _appoint();
        vm.prank(owner);
        a.transferOwnership(other);
        assertEq(a.owner(), owner); // nothing moves until accepted
        vm.prank(other);
        vm.expectRevert(ReleaseAnchor.NotOwner.selector);
        a.pin(CID1);
        vm.expectEmit(true, true, false, false, address(a));
        emit OwnershipTransferred(owner, other);
        vm.prank(other);
        a.acceptOwnership();
        assertEq(a.owner(), other);
        assertEq(a.pendingOwner(), address(0));
        assertEq(a.delegate(), address(0)); // the old owner's appointment does not survive
        vm.prank(del);
        vm.expectRevert(ReleaseAnchor.NotAuthorized.selector);
        a.publish(CID1, 1);
        vm.prank(owner);
        vm.expectRevert(ReleaseAnchor.NotOwner.selector);
        a.pin(CID1);
        vm.prank(other);
        a.pin(CID1);
        assertEq(a.seq(), 2);
    }

    function test_transferCancel() public {
        vm.startPrank(owner);
        a.transferOwnership(other);
        a.transferOwnership(address(0));
        vm.stopPrank();
        vm.prank(other);
        vm.expectRevert(ReleaseAnchor.NotPendingOwner.selector);
        a.acceptOwnership();
    }

    // ---- retirement ----------------------------------------------------------------------------------------------

    function test_retireFreezes() public {
        _appoint();
        vm.prank(owner);
        a.transferOwnership(other);
        vm.expectEmit(false, false, false, true, address(a));
        emit Retired(other, 1);
        vm.prank(owner);
        a.retire(other);
        (,, uint64 seq, string memory cid,, address d, uint64 until, bool r, address s) = _state();
        assertEq(seq, 1);
        assertEq(cid, CID0);
        assertEq(d, address(0));
        assertEq(until, 0);
        assertTrue(r);
        assertEq(s, other);
        assertEq(a.pendingOwner(), address(0));
        vm.startPrank(owner);
        vm.expectRevert(ReleaseAnchor.IsRetired.selector);
        a.publish(CID1, 1);
        vm.expectRevert(ReleaseAnchor.IsRetired.selector);
        a.pin(CID1);
        vm.expectRevert(ReleaseAnchor.IsRetired.selector);
        a.setDelegate(del, uint64(block.timestamp + 1 days));
        vm.expectRevert(ReleaseAnchor.IsRetired.selector);
        a.transferOwnership(other);
        vm.expectRevert(ReleaseAnchor.IsRetired.selector);
        a.retire(address(0));
        vm.stopPrank();
        vm.prank(other);
        vm.expectRevert(ReleaseAnchor.IsRetired.selector);
        a.acceptOwnership();
    }

    // ---- the CID rule --------------------------------------------------------------------------------------------

    function test_cidRule() public {
        vm.startPrank(owner);
        string[9] memory bad = [
            string("bafybei"),                    // 7 bytes
            "Bafybeigdyrzt5sfp7udm7hu76uh7y26",   // multibase 'B' (upper)
            "bafybeigDyrzt5sfp7udm7hu76uh7y26",   // upper case inside
            "bafybeig1yrzt5sfp7udm7hu76uh7y26",   // '1' is not base32
            "bafybeig8yrzt5sfp7udm7hu76uh7y26",   // '8'
            "bafybeig yrzt5sfp7udm7hu76uh7y26",   // space
            "bafybeig/yrzt5sfp7udm7hu76uh7y26",   // a path
            "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz", // base58 CIDv0
            ""
        ];
        for (uint256 i = 0; i < bad.length; ++i) {
            vm.expectRevert(ReleaseAnchor.BadCid.selector);
            a.publish(bad[i], 1);
        }
        bytes memory long = new bytes(129);
        long[0] = "b";
        for (uint256 i = 1; i < 129; ++i) long[i] = "a";
        vm.expectRevert(ReleaseAnchor.BadCid.selector);
        a.publish(string(long), 1);
        bytes memory max = new bytes(128);
        max[0] = "b";
        for (uint256 i = 1; i < 128; ++i) max[i] = "7";
        a.publish(string(max), 1);
        a.publish("baaaaaaa", 2); // 8 bytes, the minimum
        vm.stopPrank();
        assertEq(a.seq(), 3);
    }

    function testFuzz_cidCharset(bytes1 ch) public {
        bytes memory c = bytes("bafybeigdyrzt5sfp7udm7hu76uh7y26");
        c[10] = ch;
        bool ok = (ch >= "a" && ch <= "z") || (ch >= "2" && ch <= "7");
        vm.prank(owner);
        if (!ok) vm.expectRevert(ReleaseAnchor.BadCid.selector);
        a.publish(string(c), 1);
        assertEq(a.seq(), ok ? 2 : 1);
    }

    // ---- sequence overflow ---------------------------------------------------------------------------------------

    function test_seqOverflowReverts() public {
        // slot 3 packs seq (uint64, low bytes), retired (bool) and successor; set seq = max, the rest zero
        assertEq(uint256(vm.load(address(a), bytes32(uint256(3)))), 1);
        vm.store(address(a), bytes32(uint256(3)), bytes32(uint256(type(uint64).max)));
        assertEq(a.seq(), type(uint64).max);
        vm.prank(owner);
        vm.expectRevert(ARITHMETIC_PANIC);
        a.publish(CID1, type(uint64).max);
        vm.prank(owner);
        vm.expectRevert(ARITHMETIC_PANIC);
        a.pin(CID1);
    }

    // ---- what the publisher reads and pins -----------------------------------------------------------------------

    function test_stateAbiLayout() public {
        vm.prank(owner);
        a.publish(CID1, 1);
        (bool ok, bytes memory raw) = address(a).staticcall(abi.encodeWithSignature("state()"));
        assertTrue(ok);
        assertEq(bytes4(keccak256("state()")), ReleaseAnchor.state.selector);
        // the head is 9 words; the string lives at offset 9*32; this is the exact layout the Rust decoder accepts
        assertEq(raw.length, 9 * 32 + 32 + ((bytes(CID1).length + 31) / 32) * 32);
        bytes memory expected = abi.encode(
            a.SCHEMA(), NAME, uint64(2), CID1, owner, address(0), uint64(0), false, address(0)
        );
        assertEq(raw, expected);
        uint256 off;
        assembly {
            off := mload(add(raw, add(32, 96)))
        }
        assertEq(off, 9 * 32);
    }

    function test_codehashPinsNameAndIsStateIndependent() public {
        ReleaseAnchor same = new ReleaseAnchor(other, NAME, CID2);
        ReleaseAnchor diff = new ReleaseAnchor(owner, keccak256("another name"), CID0);
        // storage (owner, cid, seq) is not code: one codehash per (build, nameHash)
        assertEq(address(same).codehash, address(a).codehash);
        assertTrue(address(diff).codehash != address(a).codehash);
        vm.prank(owner);
        a.publish(CID1, 1);
        assertEq(address(same).codehash, address(a).codehash);
    }
}
