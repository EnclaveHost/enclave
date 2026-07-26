// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../EnclaveHostReviews.sol";

/// Minimal EnclaveDeployments stand-in: only get() matters to the receipt.
contract MockLedger {
    mapping(bytes32 => IEnclaveDeployments.Deployment) private _d;
    bool public revertOnGet;
    function set(bytes32 id, address owner_, bytes32 runner, uint256 balance6, uint256 spent6) external {
        IEnclaveDeployments.Deployment memory d;
        d.id = id; d.owner = owner_; d.runner = runner; d.balance6 = balance6; d.spent6 = spent6;
        d.appRef = "catalog://0x00/1";
        _d[id] = d;
    }
    function setRevert(bool v) external { revertOnGet = v; }
    function get(bytes32 id) external view returns (IEnclaveDeployments.Deployment memory) {
        require(!revertOnGet, "ledger down");
        return _d[id];
    }
}

contract MockBook {
    mapping(bytes32 => address) public a;
    function set(bytes32 k, address v) external { a[k] = v; }
    function addr(bytes32 k) external view returns (address) { return a[k]; }
}

contract EnclaveHostReviewsTest is Test {
    EnclaveHostReviews r;
    MockLedger led;
    MockBook book;

    bytes32 constant ENC_A = keccak256("https://api.enclave.host/t/metal0");
    bytes32 constant ENC_B = keccak256("https://kryptos.enclave.host");
    bytes32 constant DEP = bytes32(uint256(0x1111));
    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);

    function setUp() public {
        led = new MockLedger();
        book = new MockBook();
        book.set("deployments", address(led));
        r = new EnclaveHostReviews(address(book), address(0));
        // Alice funded a deployment that metal0 (ENC_A) is running
        led.set(DEP, ALICE, ENC_A, 5_000_000, 260_000);
    }

    function test_ratesTheHostThatRanYourApp() public {
        vm.prank(ALICE);
        r.post(ENC_A, DEP, 5, "fast box, never dropped my lease");
        (uint32 c, uint32 s) = r.tallyOf(ENC_A);
        assertEq(c, 1); assertEq(s, 5);
        assertTrue(r.hasReviewed(ENC_A, ALICE));
    }

    function test_refusesWithoutAReceipt() public {
        vm.prank(BOB);                                    // not Bob's deployment
        vm.expectRevert(bytes("no funded deployment run by this enclave"));
        r.post(ENC_A, DEP, 5, "");
    }

    function test_refusesRatingAHostThatDidNotRunIt() public {
        vm.prank(ALICE);                                  // Alice ran on A, rates B
        vm.expectRevert(bytes("no funded deployment run by this enclave"));
        r.post(ENC_B, DEP, 1, "never used this one");
    }

    function test_refusesUnfundedDeployment() public {
        bytes32 dep2 = bytes32(uint256(0x2222));
        led.set(dep2, ALICE, ENC_A, 0, 0);                // created, never funded
        vm.prank(ALICE);
        vm.expectRevert(bytes("no funded deployment run by this enclave"));
        r.post(ENC_A, dep2, 5, "");
    }

    function test_editSurvivesTheLeaseMoving() public {
        vm.prank(ALICE);
        r.post(ENC_A, DEP, 5, "great");
        led.set(DEP, ALICE, ENC_B, 5_000_000, 260_000);   // lease moved to another box
        vm.prank(ALICE);
        r.post(ENC_A, bytes32(0), 2, "it got worse");     // edit needs no fresh receipt
        (uint32 c, uint32 s) = r.tallyOf(ENC_A);
        assertEq(c, 1); assertEq(s, 2);
        EnclaveHostReviews.Review memory rev = r.getReview(ENC_A, ALICE);
        assertEq(rev.deployment, DEP);                    // original receipt retained
        assertGt(rev.updatedAt, 0);
        assertEq(rev.createdAt, rev.updatedAt);           // same block here
    }

    function test_firstPostStillNeedsALiveReceipt() public {
        led.set(DEP, ALICE, ENC_B, 5_000_000, 0);         // Alice's app is on B now
        vm.prank(ALICE);
        vm.expectRevert(bytes("no funded deployment run by this enclave"));
        r.post(ENC_A, DEP, 5, "");                        // ...so she can't start rating A
    }

    function test_oneReviewPerWalletTallyMoves() public {
        vm.prank(ALICE); r.post(ENC_A, DEP, 5, "");
        vm.prank(ALICE); r.post(ENC_A, DEP, 3, "");
        (uint32 c, uint32 s) = r.tallyOf(ENC_A);
        assertEq(c, 1); assertEq(s, 3);
        assertEq(r.reviewCount(ENC_A), 1);
    }

    function test_moderationHidesFromTallyAndStaysHiddenThroughEdit() public {
        vm.prank(ALICE); r.post(ENC_A, DEP, 5, "spam");
        r.setHidden(ENC_A, ALICE, true);                  // test contract is owner
        (uint32 c, uint32 s) = r.tallyOf(ENC_A);
        assertEq(c, 0); assertEq(s, 0);
        vm.prank(ALICE); r.post(ENC_A, DEP, 5, "spam again");
        (c, s) = r.tallyOf(ENC_A);
        assertEq(c, 0); assertEq(s, 0);                   // takedown outlives the edit
        EnclaveHostReviews.Review memory rev = r.getReview(ENC_A, ALICE);
        assertTrue(rev.hidden);
    }

    function test_onlyOwnerModerates() public {
        vm.prank(ALICE); r.post(ENC_A, DEP, 5, "");
        vm.prank(BOB);
        vm.expectRevert(bytes("!owner"));
        r.setHidden(ENC_A, ALICE, true);
    }

    function test_ledgerFailureProvesNothing() public {
        led.setRevert(true);
        vm.prank(ALICE);
        vm.expectRevert(bytes("no funded deployment run by this enclave"));
        r.post(ENC_A, DEP, 5, "");
    }

    function test_bookRepointFollowsANewLedger() public {
        MockLedger led2 = new MockLedger();
        book.set("deployments", address(led2));           // ledger redeployed
        vm.prank(ALICE);
        vm.expectRevert(bytes("no funded deployment run by this enclave"));
        r.post(ENC_A, DEP, 5, "");                        // new ledger has no such record
        led2.set(DEP, ALICE, ENC_A, 1, 0);
        vm.prank(ALICE); r.post(ENC_A, DEP, 4, "");
        (uint32 c,) = r.tallyOf(ENC_A);
        assertEq(c, 1);
        assertEq(r.ledger(), address(led2));
    }

    function test_talliesOfAnswersTheWholePanel() public {
        bytes32 dep2 = bytes32(uint256(0x3333));
        led.set(dep2, BOB, ENC_B, 1, 0);
        vm.prank(ALICE); r.post(ENC_A, DEP, 5, "");
        vm.prank(BOB);   r.post(ENC_B, dep2, 3, "");
        bytes32[] memory ids = new bytes32[](3);
        ids[0] = ENC_A; ids[1] = ENC_B; ids[2] = keccak256("never-rated");
        (uint32[] memory counts, uint32[] memory sums) = r.talliesOf(ids);
        assertEq(counts[0], 1); assertEq(sums[0], 5);
        assertEq(counts[1], 1); assertEq(sums[1], 3);
        assertEq(counts[2], 0); assertEq(sums[2], 0);
    }

    function test_canReviewAnswersBeforeASignature() public {
        assertTrue(r.canReview(ENC_A, DEP, ALICE));
        assertFalse(r.canReview(ENC_A, DEP, BOB));
        vm.prank(ALICE); r.post(ENC_A, DEP, 5, "");
        led.set(DEP, ALICE, ENC_B, 5_000_000, 0);         // lease moved
        assertTrue(r.canReview(ENC_A, bytes32(0), ALICE)); // she may still edit
    }

    function test_boundsAndZeroSubject() public {
        vm.prank(ALICE);
        vm.expectRevert(bytes("stars 1..5"));
        r.post(ENC_A, DEP, 6, "");
        vm.prank(ALICE);
        vm.expectRevert(bytes("zero enclave"));
        r.post(bytes32(0), DEP, 5, "");
        vm.prank(ALICE);
        vm.expectRevert(bytes("body too long"));
        r.post(ENC_A, DEP, 5, new string(2001));
    }

    function test_pagingIncludesHiddenFlagged() public {
        bytes32 dep2 = bytes32(uint256(0x4444));
        led.set(dep2, BOB, ENC_A, 1, 0);
        vm.prank(ALICE); r.post(ENC_A, DEP, 5, "a");
        vm.prank(BOB);   r.post(ENC_A, dep2, 1, "b");
        r.setHidden(ENC_A, BOB, true);
        EnclaveHostReviews.Review[] memory page = r.getReviewsPage(ENC_A, 0, 10);
        assertEq(page.length, 2);
        assertFalse(page[0].hidden);
        assertTrue(page[1].hidden);
        (uint32 c,) = r.tallyOf(ENC_A);
        assertEq(c, 1);                                   // tally counts the visible one only
    }
}
