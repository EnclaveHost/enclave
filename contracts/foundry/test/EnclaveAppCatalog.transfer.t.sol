// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../EnclaveAppCatalog.sol";

/// The rev-6 publisher-transfer surface: the compromised-publisher-key remedy.
/// A lineage moves to a new wallet with its appId (deployment references) and
/// versions intact; the old key keeps no rights, the new key publishes to the
/// SAME lineage under the same slug, and a migrated catalog reproduces the
/// redirect. Mirrors the live incident: one wallet published most of the
/// catalog, its key leaked, everything moves to the governance wallet.
contract EnclaveAppCatalogTransferTest is Test {
    EnclaveAppCatalog cat;

    address constant OWNER = address(0x0D06);        // catalog owner (deployer)
    address constant BURNER = address(0xBAD);        // the compromised publisher
    address constant SAFE = address(0x5AFE);         // the recovery destination
    address constant OTHER = address(0x07E4);

    uint32[4] RES = [uint32(0), 0, 256, 10];

    function setUp() public {
        vm.prank(OWNER);
        cat = new EnclaveAppCatalog();
    }

    function publish(address who, string memory slug, string memory ver, string memory cid)
        internal returns (bytes32 appId, uint256 idx)
    {
        vm.prank(who);
        return cat.publishVersion(slug, slug, "", ver, cid, RES, "", "{}", 0);
    }

    /* ---- the transfer itself ---- */

    function test_transferMovesPublisherAndKeepsEverythingElse() public {
        (bytes32 id, ) = publish(BURNER, "dead-drop", "1", "bafyDD1");
        uint8 approved = cat.APPROVAL_APPROVED();         // read BEFORE prank (a call consumes it)
        vm.prank(OWNER);
        cat.setApproval(id, 0, approved);

        vm.prank(OWNER);
        cat.transferApp(id, SAFE);

        EnclaveAppCatalog.App memory a = cat.getApp(id);
        assertEq(a.publisher, SAFE);
        assertEq(a.appId, id);                            // deployment refs survive
        assertEq(a.slug, "dead-drop");
        assertEq(cat.getVersion(id, 0).approval, cat.APPROVAL_APPROVED());  // rulings untouched
        assertEq(cat.appIdOf(SAFE, "dead-drop"), id);     // resolution follows the move
    }

    function test_onlyOwnerRules() public {
        (bytes32 id, ) = publish(BURNER, "keep", "1", "bafyK1");
        vm.prank(BURNER);                                 // not even the publisher themself
        vm.expectRevert(bytes("!owner"));
        cat.transferApp(id, SAFE);
        vm.prank(OWNER);
        vm.expectRevert(bytes("unknown app"));
        cat.transferApp(keccak256("nope"), SAFE);
        vm.prank(OWNER);
        vm.expectRevert(bytes("zero addr"));
        cat.transferApp(id, address(0));
        vm.prank(OWNER);
        vm.expectRevert(bytes("already publisher"));
        cat.transferApp(id, BURNER);
    }

    function test_oldKeyKeepsNoRights() public {
        (bytes32 id, ) = publish(BURNER, "tipline", "1", "bafyT1");
        vm.prank(OWNER);
        cat.transferApp(id, SAFE);

        vm.startPrank(BURNER);
        vm.expectRevert(bytes("not publisher"));          // append to the lineage
        cat.publishVersion("tipline", "tipline", "", "2", "bafyT2", RES, "", "{}", 0);
        vm.expectRevert(bytes("not publisher"));
        cat.editApp("tipline", "defaced", "");
        vm.expectRevert(bytes("not publisher"));
        cat.setActive("tipline", false);
        vm.expectRevert(bytes("not publisher"));
        cat.yankVersion("tipline", 0);
        vm.stopPrank();
    }

    function test_newKeyPublishesToTheSameLineage() public {
        (bytes32 id, ) = publish(BURNER, "pulse", "1", "bafyP1");
        vm.prank(OWNER);
        cat.transferApp(id, SAFE);

        (bytes32 id2, uint256 idx) = publish(SAFE, "pulse", "2", "bafyP2");
        assertEq(id2, id);                                // SAME lineage, not a fresh app
        assertEq(idx, 1);
        assertEq(cat.getApp(id).versionCount, 2);
        assertEq(cat.appCount(), 1);

        vm.prank(SAFE);                                   // and the other publisher rights
        cat.yankVersion("pulse", 0);
        assertTrue(cat.getVersion(id, 0).yanked);
        vm.prank(SAFE);
        cat.setActive("pulse", false);
        assertFalse(cat.getApp(id).active);
    }

    function test_destinationSlugCollisionRefused() public {
        (bytes32 id, ) = publish(BURNER, "probe", "1", "bafyPr1");
        publish(SAFE, "probe", "1", "bafyPr2");           // SAFE already owns "probe"
        vm.prank(OWNER);
        vm.expectRevert(bytes("slug taken at destination"));
        cat.transferApp(id, SAFE);
    }

    function test_burnedSlugStaysBurnedForTheOldKey() public {
        (bytes32 id, ) = publish(BURNER, "gavel", "1", "bafyG1");
        vm.prank(OWNER);
        cat.transferApp(id, SAFE);
        // the old key's structural hash names the moved lineage forever: no
        // fresh app under that slug, so nothing can shadow the transfer
        vm.prank(BURNER);
        vm.expectRevert(bytes("not publisher"));
        cat.publishVersion("gavel", "gavel", "", "9", "bafyG9", RES, "", "{}", 0);
        assertEq(cat.appIdOf(BURNER, "gavel"), id);       // existence != ownership
    }

    function test_retransferAndTransferBackHome() public {
        (bytes32 id, ) = publish(BURNER, "quorum", "1", "bafyQ1");
        vm.prank(OWNER);
        cat.transferApp(id, SAFE);
        vm.prank(OWNER);
        cat.transferApp(id, OTHER);                       // a typo'd `to` is recoverable
        assertEq(cat.getApp(id).publisher, OTHER);
        assertEq(cat.appIdOf(OTHER, "quorum"), id);
        // SAFE's redirect was cleared: their hash is free again for a new app
        (bytes32 fresh, ) = publish(SAFE, "quorum", "1", "bafyQ2");
        assertTrue(fresh != id);
        assertEq(cat.getApp(fresh).publisher, SAFE);
        // ...which now blocks a transfer back to SAFE (strict rule)
        vm.prank(OWNER);
        vm.expectRevert(bytes("slug taken at destination"));
        cat.transferApp(id, SAFE);
        // transfer back HOME lands on the structural hash, no redirect needed
        vm.prank(OWNER);
        cat.transferApp(id, BURNER);
        assertEq(cat.getApp(id).publisher, BURNER);
        assertEq(cat.appIdOf(BURNER, "quorum"), id);
        (bytes32 again, ) = publish(BURNER, "quorum", "2", "bafyQ3");
        assertEq(again, id);
    }

    function test_bulkRecoveryViaMulticall() public {
        // the admin console's one-confirmation recovery: every burner app moves
        string[3] memory slugs = ["dead-drop", "hookbin", "ballot"];
        bytes32[3] memory ids;
        for (uint256 i = 0; i < 3; i++)
            (ids[i], ) = publish(BURNER, slugs[i], "1", string.concat("bafyM", vm.toString(i)));
        bytes[] memory calls = new bytes[](3);
        for (uint256 i = 0; i < 3; i++)
            calls[i] = abi.encodeCall(EnclaveAppCatalog.transferApp, (ids[i], SAFE));
        vm.prank(OWNER);
        cat.multicall(calls);
        for (uint256 i = 0; i < 3; i++) {
            assertEq(cat.getApp(ids[i]).publisher, SAFE);
            assertEq(cat.appIdOf(SAFE, slugs[i]), ids[i]);
        }
        // multicall preserves msg.sender for the inner auth check
        vm.prank(BURNER);
        vm.expectRevert(bytes("!owner"));
        cat.multicall(calls);
    }

    /* ---- migration carries transfers ---- */

    function test_importRecreatesTheRedirect() public {
        // source: a transferred lineage (appId hashes from BURNER, publisher is SAFE)
        (bytes32 id, ) = publish(BURNER, "shoebox", "1", "bafyS1");
        vm.prank(OWNER);
        cat.transferApp(id, SAFE);
        EnclaveAppCatalog.App memory moved = cat.getApp(id);

        // target: verbatim replay, as migrate.js does
        vm.startPrank(OWNER);
        EnclaveAppCatalog target = new EnclaveAppCatalog();
        EnclaveAppCatalog.App[] memory items = new EnclaveAppCatalog.App[](1);
        items[0] = moved;
        target.importApps(items);
        vm.stopPrank();

        assertEq(target.getApp(id).publisher, SAFE);
        assertEq(target.appIdOf(SAFE, "shoebox"), id);    // redirect recreated
        vm.prank(SAFE);                                   // and it routes writes
        (bytes32 id2, ) = target.publishVersion("shoebox", "shoebox", "", "2", "bafyS2", RES, "", "{}", 0);
        assertEq(id2, id);
        vm.prank(BURNER);
        vm.expectRevert(bytes("not publisher"));
        target.publishVersion("shoebox", "shoebox", "", "3", "bafyS3", RES, "", "{}", 0);
    }

    function test_importRefusesACorruptRedirect() public {
        vm.startPrank(OWNER);
        EnclaveAppCatalog target = new EnclaveAppCatalog();
        EnclaveAppCatalog.App[] memory items = new EnclaveAppCatalog.App[](2);
        // two lineages both claiming SAFE owns "dup" — no valid source holds this
        items[0] = appRow(keccak256("lineage-1"), SAFE, "dup");
        items[1] = appRow(keccak256("lineage-2"), SAFE, "dup");
        vm.expectRevert(bytes("slug ref taken"));
        target.importApps(items);
        vm.stopPrank();
    }

    /// The mirror-image corruption: a lineage whose appId something ALREADY
    /// redirects away from. transferApp cannot produce it (its destination rule
    /// refuses a hash an app occupies), and the failure it would cause is
    /// silent and permanent — the app exists, but appIdOf sends its own
    /// publisher's slug writes somewhere else, with imports sealed behind it.
    function test_importRefusesAnAppIdAlreadyShadowed() public {
        vm.startPrank(OWNER);
        EnclaveAppCatalog target = new EnclaveAppCatalog();
        bytes32 shadowed = keccak256(abi.encodePacked(SAFE, "ghost"));
        EnclaveAppCatalog.App[] memory items = new EnclaveAppCatalog.App[](2);
        items[0] = appRow(keccak256("lineage-1"), SAFE, "ghost");   // sets _slugRef[shadowed]
        items[1] = appRow(shadowed, OTHER, "elsewhere");            // …now claims that very hash
        vm.expectRevert(bytes("appId shadowed by a redirect"));
        target.importApps(items);
        vm.stopPrank();
    }

    function test_transferStillWorksAfterSealing() public {
        // recovery order of operations: migrate -> verify -> SEAL -> transfer
        (bytes32 id, ) = publish(BURNER, "warpad", "1", "bafyW1");
        vm.startPrank(OWNER);
        cat.sealImports();
        cat.transferApp(id, SAFE);                        // not an import path
        vm.stopPrank();
        assertEq(cat.getApp(id).publisher, SAFE);
    }

    function appRow(bytes32 id, address pub, string memory slug)
        internal view returns (EnclaveAppCatalog.App memory a)
    {
        a.appId = id; a.publisher = pub; a.slug = slug; a.name = slug;
        a.versionCount = 0; a.createdAt = uint64(block.timestamp);
        a.updatedAt = uint64(block.timestamp); a.active = true;
    }
}
