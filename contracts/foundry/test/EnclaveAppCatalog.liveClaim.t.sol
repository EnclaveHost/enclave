// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../EnclaveAppCatalog.sol";

/// The rev-8 CID-claim rule. A CID's claim binds only while its NEWEST listing
/// is LIVE — owner-Approved and not yanked. A rejected, yanked, or
/// still-pending listing blocks no one: exclusivity over bytes is minted by
/// the owner's approval (the same signature that already gates deploys), which
/// also makes rejection the everyday squat remedy — no grant needed.
///
/// What these tests pin down: the claim's liveness conditions on the publish
/// path, ref-follows-newest-listing semantics once cross-app duplicates can
/// exist, and that importVersions carries a rev-8 history (shared CIDs
/// included) verbatim with the ref landing on the newest listing regardless
/// of per-app import order.
contract EnclaveAppCatalogLiveClaimTest is Test {
    EnclaveAppCatalog cat;

    address constant OWNER = address(0x0D06);
    address constant PUB = address(0xBEEF);
    address constant OTHER = address(0x07E4);
    address constant THIRD = address(0x7A1D);

    uint32[4] RES = [uint32(0), 0, 256, 10];

    string constant CID = "bafySHARED";

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

    function approve(bytes32 appId, uint256 idx, uint8 status) internal {
        vm.prank(OWNER);
        cat.setApproval(appId, idx, status);
    }

    /* ---- the schema gate pre-flights key off ---- */

    function test_schemaIsNine() public view {
        assertEq(cat.catalogSchema(), 9);
    }

    /* ---- liveness conditions of the claim ---- */

    function test_liveClaimBlocks() public {
        (bytes32 a, uint256 i) = publish(PUB, "a", "1", CID);
        approve(a, i, cat.APPROVAL_APPROVED());
        vm.prank(OTHER);
        vm.expectRevert(bytes("cid listed by another app"));
        cat.publishVersion("b", "b", "", "1", CID, RES, "", "", 0);
    }

    function test_pendingClaimDoesNotBlock() public {
        publish(PUB, "a", "1", CID);                      // stays Pending
        (bytes32 b,) = publish(OTHER, "b", "1", CID);     // must not revert
        (, bytes32 refApp,,,,,) = cat.cidStatus(CID);
        assertEq(refApp, b);                              // ref follows the newest listing
    }

    function test_rejectedClaimReleases() public {
        (bytes32 a, uint256 i) = publish(PUB, "a", "1", CID);
        approve(a, i, cat.APPROVAL_REJECTED());
        publish(OTHER, "b", "1", CID);                    // must not revert
    }

    function test_yankedClaimReleases() public {
        (bytes32 a, uint256 i) = publish(PUB, "a", "1", CID);
        approve(a, i, cat.APPROVAL_APPROVED());
        vm.prank(PUB);
        cat.yankVersion("a", i);                          // approved but pulled
        publish(OTHER, "b", "1", CID);                    // must not revert
    }

    /* ---- the paths that were always exempt stay exempt ---- */

    function test_ownRelistAlwaysAllowed() public {
        (bytes32 a, uint256 i) = publish(PUB, "a", "1", CID);
        approve(a, i, cat.APPROVAL_APPROVED());
        (, uint256 j) = publish(PUB, "a", "2", CID);      // metadata fix of live bytes
        (, bytes32 refApp, uint256 refIdx, uint8 appr,,,) = cat.cidStatus(CID);
        assertEq(refApp, a);
        assertEq(refIdx, j);                              // newest listing holds the ref
        assertEq(appr, cat.APPROVAL_PENDING());           // and re-review starts over
    }

    function test_grantOverridesLiveClaim() public {
        (bytes32 a, uint256 i) = publish(PUB, "a", "1", CID);
        approve(a, i, cat.APPROVAL_APPROVED());
        bytes32 grantee = cat.appIdOf(OTHER, "b");        // before the prank: an
        vm.prank(OWNER);                                  // argument call would eat it
        cat.grantCid(CID, grantee);
        publish(OTHER, "b", "1", CID);                    // grant beats a live claim
    }

    /* ---- the ref (and with it the claim) follows the newest listing ---- */

    function test_claimIsJudgedOnTheNewestListingOnly() public {
        (bytes32 a, uint256 ai) = publish(PUB, "a", "1", CID);
        approve(a, ai, cat.APPROVAL_REJECTED());
        (bytes32 b, uint256 bi) = publish(OTHER, "b", "1", CID); // took the ref
        approve(b, bi, cat.APPROVAL_APPROVED());

        // newest listing live -> a third app is blocked
        vm.prank(THIRD);
        vm.expectRevert(bytes("cid listed by another app"));
        cat.publishVersion("c", "c", "", "1", CID, RES, "", "", 0);

        // re-approving the SUPERSEDED row does not re-bind the claim: the ref
        // sits on the newest listing, and only its flags are consulted
        approve(a, ai, cat.APPROVAL_APPROVED());
        approve(b, bi, cat.APPROVAL_REJECTED());
        publish(THIRD, "c", "1", CID);                    // must not revert
    }

    /* ---- migration carries a rev-8 history verbatim ---- */

    function app(address pub, string memory slug) internal pure returns (EnclaveAppCatalog.App memory a) {
        a.appId = keccak256(abi.encodePacked(pub, slug));
        a.publisher = pub;
        a.slug = slug;
        a.name = slug;
        a.versionCount = 1;
        a.active = true;
    }

    function ver(string memory cid, string memory label, uint64 createdAt, uint8 approval)
        internal view returns (EnclaveAppCatalog.Version memory v)
    {
        v.cid = cid;
        v.version = label;
        v.vramMb = RES[0]; v.gpuGflops = RES[1]; v.memMb = RES[2]; v.cpuGflops = RES[3];
        v.createdAt = createdAt;
        v.approval = approval;
    }

    function test_importCarriesCrossAppCids_newestWinsTheRef() public {
        EnclaveAppCatalog.App[] memory apps = new EnclaveAppCatalog.App[](2);
        apps[0] = app(PUB, "a");
        apps[1] = app(OTHER, "b");
        vm.prank(OWNER);
        cat.importApps(apps);

        // the NEWER listing (app a, t=200) imports FIRST; the older duplicate
        // must neither revert nor steal the ref on its later import
        EnclaveAppCatalog.Version[] memory va = new EnclaveAppCatalog.Version[](1);
        va[0] = ver(CID, "1", 200, cat.APPROVAL_APPROVED());
        vm.prank(OWNER);
        cat.importVersions(apps[0].appId, va);

        EnclaveAppCatalog.Version[] memory vb = new EnclaveAppCatalog.Version[](1);
        vb[0] = ver(CID, "1", 100, cat.APPROVAL_REJECTED());
        vm.prank(OWNER);
        cat.importVersions(apps[1].appId, vb);

        (bool listed, bytes32 refApp,, uint8 appr,,,) = cat.cidStatus(CID);
        assertTrue(listed);
        assertEq(refApp, apps[0].appId);                  // newest createdAt, not last-imported
        assertEq(appr, cat.APPROVAL_APPROVED());
    }
}
