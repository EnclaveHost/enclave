// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../EnclaveAppCatalog.sol";

/// The rev-7 large-config surface. A version's ENCLAVE_CONFIG can live at an
/// IPFS CID instead of inline, lifting the 4096-byte ceiling without putting a
/// megabyte in storage (32,768 SSTOREs = ~655M gas, past Base's 400M block
/// limit — the inline field can never carry it).
///
/// What these tests pin down is the property that makes the indirection safe,
/// and that the RETIRED deployer-side configCid lacked: the CID is a field of
/// the version record — publisher-set, immutable, approval-covered — so it
/// cannot be swapped for different bytes after the owner rules on it.
contract EnclaveAppCatalogConfigCidTest is Test {
    EnclaveAppCatalog cat;

    address constant OWNER = address(0x0D06);
    address constant PUB = address(0xBEEF);
    address constant OTHER = address(0x07E4);

    uint32[4] RES = [uint32(0), 0, 256, 10];

    string constant CFG_CID = "bafkreiggconfigcidexampleaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    function setUp() public {
        vm.prank(OWNER);
        cat = new EnclaveAppCatalog();
    }

    /* ---- the schema gate readers key off ---- */

    function test_schemaIsSeven() public view {
        assertEq(cat.catalogSchema(), 7);
    }

    /* ---- publishing through the CID path ---- */

    function test_configCidIsStored() public {
        vm.prank(PUB);
        (bytes32 id, uint256 idx) =
            cat.publishVersionCfg("big", "Big", "", "1", "bafyBIG1", RES, "", "", CFG_CID, 0);

        assertEq(cat.versionConfigCid(id, idx), CFG_CID);
        assertEq(cat.getVersion(id, idx).config, "");     // no manifest passed
    }

    /// The inline field on this path is the ROUTING MANIFEST: a runner picks a
    /// box off the chain record before any IPFS fetch, so `wasi`/`threads`/
    /// `set`/`gpuOptional` have to survive on-chain even when the config body
    /// does not. Both must be readable from the same record.
    function test_routingManifestRidesAlongsideTheConfigCid() public {
        string memory manifest = "{\"wasi\":\"0.3\",\"threads\":true}";
        vm.prank(PUB);
        (bytes32 id, uint256 idx) =
            cat.publishVersionCfg("big", "Big", "", "1", "bafyBIG1", RES, "", manifest, CFG_CID, 0);

        assertEq(cat.getVersion(id, idx).config, manifest);
        assertEq(cat.versionConfigCid(id, idx), CFG_CID);
    }

    function test_routingManifestStillBoundBy4096() public {
        string memory tooBig = new string(4097);
        vm.prank(PUB);
        vm.expectRevert(bytes("config length"));
        cat.publishVersionCfg("big", "Big", "", "1", "bafyBIG1", RES, "", tooBig, CFG_CID, 0);
    }

    function test_inlinePublishLeavesConfigCidEmpty() public {
        vm.prank(PUB);
        (bytes32 id, uint256 idx) =
            cat.publishVersion("small", "Small", "", "1", "bafySM1", RES, "", "{\"a\":1}", 0);

        assertEq(cat.versionConfigCid(id, idx), "");        // the fallback signal
        assertEq(cat.getVersion(id, idx).config, "{\"a\":1}");
    }

    function test_emptyConfigCidRefused() public {
        vm.prank(PUB);
        vm.expectRevert(bytes("configCid length"));
        cat.publishVersionCfg("big", "Big", "", "1", "bafyBIG1", RES, "", "", "", 0);
    }

    function test_oversizeConfigCidRefused() public {
        string memory tooLong = new string(101);            // MAX_CID is 100
        vm.prank(PUB);
        vm.expectRevert(bytes("configCid length"));
        cat.publishVersionCfg("big", "Big", "", "1", "bafyBIG1", RES, "", "", tooLong, 0);
    }

    /* ---- the invariants publishVersion enforces still hold on this path ---- */

    function test_cidPathStartsPendingLikeAnyRelease() public {
        vm.prank(PUB);
        (bytes32 id, uint256 idx) =
            cat.publishVersionCfg("big", "Big", "", "1", "bafyBIG1", RES, "", "", CFG_CID, 0);
        assertEq(cat.getVersion(id, idx).approval, cat.APPROVAL_PENDING());
        assertEq(cat.getVersion(id, idx).verified, false);
    }

    function test_cidPathKeepsVersionLabelUniqueness() public {
        vm.prank(PUB);
        cat.publishVersionCfg("big", "Big", "", "1", "bafyBIG1", RES, "", "", CFG_CID, 0);
        vm.prank(PUB);
        vm.expectRevert(bytes("version exists"));
        cat.publishVersionCfg("big", "Big", "", "1", "bafyBIG2", RES, "", "", CFG_CID, 0);
    }

    function test_cidPathKeepsGlobalWasmCidOwnership() public {
        vm.prank(PUB);
        cat.publishVersionCfg("big", "Big", "", "1", "bafyBIG1", RES, "", "", CFG_CID, 0);
        vm.prank(OTHER);
        vm.expectRevert(bytes("cid listed by another app"));
        cat.publishVersionCfg("other", "Other", "", "1", "bafyBIG1", RES, "", "", CFG_CID, 0);
    }

    /// The same config CID under two different apps is FINE — unlike the wasm
    /// CID, a config is not an identity claim on bytes, and two apps sharing a
    /// config (or one app reusing it across versions) is ordinary.
    function test_configCidIsNotExclusive() public {
        vm.prank(PUB);
        cat.publishVersionCfg("a", "A", "", "1", "bafyA1", RES, "", "", CFG_CID, 0);
        vm.prank(OTHER);
        cat.publishVersionCfg("b", "B", "", "1", "bafyB1", RES, "", "", CFG_CID, 0);
        assertEq(cat.versionConfigCid(cat.appIdOf(OTHER, "b"), 0), CFG_CID);
    }

    /// The fee moved out of _publish into a shared helper for stack reasons;
    /// the cap must still bind on BOTH paths.
    function test_feeCapBindsOnBothPaths() public {
        uint256 over = cat.maxFeePerSec6() + 1;
        vm.prank(PUB);
        vm.expectRevert(bytes("fee > max"));
        cat.publishVersion("a", "A", "", "1", "bafyA1", RES, "", "{}", over);
        vm.prank(PUB);
        vm.expectRevert(bytes("fee > max"));
        cat.publishVersionCfg("b", "B", "", "1", "bafyB1", RES, "", "", CFG_CID, over);
    }

    function test_feeStillRecordedOnTheCidPath() public {
        vm.prank(PUB);
        (bytes32 id, uint256 idx) =
            cat.publishVersionCfg("big", "Big", "", "1", "bafyBIG1", RES, "", "", CFG_CID, 100);
        assertEq(cat.versionFee(id, idx), 100);
    }

    /* ---- immutability: the whole point of the record-side CID ---- */

    /// There is no setter. Once ruled on, the only way to change a config is a
    /// NEW version, which starts Pending again — the same guarantee the inline
    /// field has, and the one the deployer-pinned CID could not offer.
    function test_noSetterExistsForConfigCid() public {
        vm.prank(PUB);
        (bytes32 id, uint256 idx) =
            cat.publishVersionCfg("big", "Big", "", "1", "bafyBIG1", RES, "", "", CFG_CID, 0);
        uint8 approved = cat.APPROVAL_APPROVED();
        vm.prank(OWNER);
        cat.setApproval(id, idx, approved);
        // approval is a ruling on THIS CID; it is still the CID afterwards
        assertEq(cat.versionConfigCid(id, idx), CFG_CID);
    }

    /* ---- migration: an unmigratable version is a stranded lineage ---- */

    function test_importCarriesConfigCids() public {
        vm.prank(PUB);
        (bytes32 id, ) = cat.publishVersionCfg("big", "Big", "", "1", "bafyBIG1", RES, "", "", CFG_CID, 0);

        // stand up a fresh catalog and migrate the lineage into it
        vm.prank(OWNER);
        EnclaveAppCatalog dst = new EnclaveAppCatalog();

        EnclaveAppCatalog.App[] memory apps = new EnclaveAppCatalog.App[](1);
        apps[0] = cat.getApp(id);
        EnclaveAppCatalog.Version[] memory vs = new EnclaveAppCatalog.Version[](1);
        vs[0] = cat.getVersion(id, 0);

        uint256[] memory idxs = new uint256[](1);
        string[] memory cids = new string[](1);
        idxs[0] = 0;
        cids[0] = cat.versionConfigCid(id, 0);

        vm.startPrank(OWNER);
        dst.importApps(apps);
        dst.importVersions(id, vs);
        dst.importVersionConfigCids(id, idxs, cids);
        vm.stopPrank();

        assertEq(dst.versionConfigCid(id, 0), CFG_CID);
        assertEq(dst.getVersion(id, 0).config, "");
    }

    function test_importConfigCidsIsOwnerOnlyAndSealable() public {
        vm.prank(PUB);
        (bytes32 id, ) = cat.publishVersionCfg("big", "Big", "", "1", "bafyBIG1", RES, "", "", CFG_CID, 0);
        uint256[] memory idxs = new uint256[](1);
        string[] memory cids = new string[](1);
        idxs[0] = 0;
        cids[0] = CFG_CID;

        vm.prank(PUB);
        vm.expectRevert(bytes("!owner"));
        cat.importVersionConfigCids(id, idxs, cids);

        vm.prank(OWNER);
        cat.sealImports();
        vm.prank(OWNER);
        vm.expectRevert(bytes("sealed"));
        cat.importVersionConfigCids(id, idxs, cids);
    }

    function test_importConfigCidsRejectsBadIndexAndLengthMismatch() public {
        vm.prank(PUB);
        (bytes32 id, ) = cat.publishVersionCfg("big", "Big", "", "1", "bafyBIG1", RES, "", "", CFG_CID, 0);

        uint256[] memory idxs = new uint256[](1);
        string[] memory cids = new string[](2);
        idxs[0] = 0;
        vm.prank(OWNER);
        vm.expectRevert(bytes("length mismatch"));
        cat.importVersionConfigCids(id, idxs, cids);

        uint256[] memory bad = new uint256[](1);
        string[] memory one = new string[](1);
        bad[0] = 5;                                   // past the end of the history
        one[0] = CFG_CID;
        vm.prank(OWNER);
        vm.expectRevert(bytes("bad index"));
        cat.importVersionConfigCids(id, bad, one);
    }
}
