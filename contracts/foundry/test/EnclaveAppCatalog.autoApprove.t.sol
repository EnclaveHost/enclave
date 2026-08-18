// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../EnclaveAppCatalog.sol";

/// The rev-9 owner auto-approval rule. A version the OWNER publishes starts
/// Approved instead of Pending: the publish signature and the approval
/// signature were the same key ruling on the same record, so the separate
/// setApproval tap was pure ceremony. Every other publisher still starts
/// Pending, and the owner can still unwind their own ruling with setApproval.
///
/// What these tests pin down: both publish entry points auto-approve for the
/// CURRENT owner only, the minted ruling is emitted (log-only indexers replay
/// approval from events), the claim consequence (an owner publish binds its
/// CID from the same block), that auto-approval never bypasses _reserveCid,
/// and that imports stay verbatim (no retroactive approval of owner rows).
contract EnclaveAppCatalogAutoApproveTest is Test {
    EnclaveAppCatalog cat;

    address constant OWNER = address(0x0D06);
    address constant PUB = address(0xBEEF);
    address constant NEXT = address(0x0E37);

    uint32[4] RES = [uint32(0), 0, 256, 10];

    event VersionApprovalSet(bytes32 indexed appId, uint256 indexed index, uint8 status);

    function setUp() public {
        vm.prank(OWNER);
        cat = new EnclaveAppCatalog();
    }

    function publish(address who, string memory slug, string memory label, string memory cid)
        internal returns (bytes32 appId, uint256 idx)
    {
        vm.prank(who);
        (appId, idx) = cat.publishVersion(slug, slug, "", label, cid, RES, "", "", 0);
    }

    /* ---- the rule itself, on both entry points ---- */

    function test_ownerPublishStartsApproved_andEmitsTheRuling() public {
        bytes32 expected = cat.appIdOf(OWNER, "mine");
        vm.expectEmit(true, true, false, true);
        emit VersionApprovalSet(expected, 0, 1);
        (bytes32 a, uint256 i) = publish(OWNER, "mine", "1", "bafyOwn1");
        assertEq(a, expected);
        assertEq(cat.getVersion(a, i).approval, cat.APPROVAL_APPROVED());
    }

    function test_ownerCfgPublishStartsApproved() public {
        vm.prank(OWNER);
        (bytes32 a, uint256 i) =
            cat.publishVersionCfg("big", "Big", "", "1", "bafyOwnBig", RES, "", "", "bafkreiCfg", 0);
        assertEq(cat.getVersion(a, i).approval, cat.APPROVAL_APPROVED());
    }

    function test_everyoneElseStillStartsPending() public {
        (bytes32 a, uint256 i) = publish(PUB, "theirs", "1", "bafyPub1");
        assertEq(cat.getVersion(a, i).approval, cat.APPROVAL_PENDING());
    }

    /* ---- the ruling is real: claim binds, and it can be unwound ---- */

    function test_ownerPublishBindsItsCidClaimImmediately() public {
        publish(OWNER, "mine", "1", "bafyShared");
        vm.prank(PUB);
        vm.expectRevert(bytes("cid listed by another app"));
        cat.publishVersion("theirs", "theirs", "", "1", "bafyShared", RES, "", "", 0);
    }

    function test_autoApprovalNeverBypassesTheClaimCheck() public {
        (bytes32 a, uint256 i) = publish(PUB, "theirs", "1", "bafyShared");
        uint8 approved = cat.APPROVAL_APPROVED();         // before the prank: an
        vm.prank(OWNER);                                  // argument call would eat it
        cat.setApproval(a, i, approved);                  // PUB's listing is live
        vm.prank(OWNER);
        vm.expectRevert(bytes("cid listed by another app"));
        cat.publishVersion("mine", "mine", "", "1", "bafyShared", RES, "", "", 0);
    }

    function test_ownerCanStillUnwindTheirOwnRuling() public {
        (bytes32 a, uint256 i) = publish(OWNER, "mine", "1", "bafyOwn1");
        uint8 rejected = cat.APPROVAL_REJECTED();         // before the prank: an
        vm.prank(OWNER);                                  // argument call would eat it
        cat.setApproval(a, i, rejected);
        assertEq(cat.getVersion(a, i).approval, cat.APPROVAL_REJECTED());
    }

    /* ---- "owner" means the CURRENT owner, at publish time ---- */

    function test_followsTheOwnershipHandoff() public {
        // pending owner is not yet the owner: no auto-approval
        vm.prank(OWNER);
        cat.transferOwnership(NEXT);
        (bytes32 n1, uint256 i1) = publish(NEXT, "next", "1", "bafyNext1");
        assertEq(cat.getVersion(n1, i1).approval, cat.APPROVAL_PENDING());

        vm.prank(NEXT);
        cat.acceptOwnership();

        // new owner auto-approves; the old owner is a plain publisher now
        (bytes32 n2, uint256 i2) = publish(NEXT, "next", "2", "bafyNext2");
        assertEq(cat.getVersion(n2, i2).approval, cat.APPROVAL_APPROVED());
        (bytes32 o1, uint256 o1i) = publish(OWNER, "old", "1", "bafyOld1");
        assertEq(cat.getVersion(o1, o1i).approval, cat.APPROVAL_PENDING());
    }

    /// The recovered-apps shape: a lineage transferred TO the owner (rev 6)
    /// publishes through the slug redirect, and those releases auto-approve
    /// like any other owner publish.
    function test_transferredToOwnerLineagePublishesApproved() public {
        (bytes32 a,) = publish(PUB, "app", "1", "bafyV1");
        vm.prank(OWNER);
        cat.transferApp(a, OWNER);
        (bytes32 same, uint256 i2) = publish(OWNER, "app", "2", "bafyV2");
        assertEq(same, a);                                // redirect kept the lineage
        assertEq(cat.getVersion(a, i2).approval, cat.APPROVAL_APPROVED());
    }

    /* ---- migration stays verbatim ---- */

    function test_importDoesNotRetroactivelyApproveOwnerRows() public {
        EnclaveAppCatalog.App memory app;
        app.appId = keccak256(abi.encodePacked(OWNER, "imported"));
        app.publisher = OWNER;
        app.slug = "imported";
        app.name = "imported";
        app.versionCount = 1;
        app.active = true;
        EnclaveAppCatalog.App[] memory apps = new EnclaveAppCatalog.App[](1);
        apps[0] = app;
        vm.prank(OWNER);
        cat.importApps(apps);

        EnclaveAppCatalog.Version[] memory vs = new EnclaveAppCatalog.Version[](1);
        vs[0].cid = "bafyImp1";
        vs[0].version = "1";
        vs[0].memMb = RES[2];
        vs[0].approval = cat.APPROVAL_PENDING();          // a pre-rev-9 pending row
        vm.prank(OWNER);
        cat.importVersions(app.appId, vs);

        // the import carries the source's history verbatim: the OWNER moving
        // the rows is not the OWNER ruling on them
        assertEq(cat.getVersion(app.appId, 0).approval, cat.APPROVAL_PENDING());
    }
}
