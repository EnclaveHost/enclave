// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {LeaseGasFundingRouter} from "../src/LeaseGasFundingRouter.sol";
import {LeaseGasQuote} from "../src/ILeaseGasFundingRouter.sol";
import {MockToken6, MockLedger, MockSessionPayer} from "./mocks/RouterMocks.sol";
// the newer lease-reserve SOURCE (work/enclave/contracts, read-only), compiled as-is: not a deployed-bytecode check
import {EnclaveLeaseGasReserve, IRegistryR, IL1FeeOracle} from "enclave-src/EnclaveLeaseGasReserve.sol";

/// The router against the actual EnclaveLeaseGasReserve source (mock ledger, no executor bound): deposit()
/// semantics, the (id, owner) reserve key, the struct ABI the router decodes, and the owner's own withdraw path.
contract LeaseGasFundingRouterRealReserveTest is Test {
    uint256 constant P_PK = 0xA11CE;
    bytes32 constant ID = keccak256("eyes-off");

    MockToken6 usdc;
    MockLedger ledger;
    EnclaveLeaseGasReserve reserve;
    LeaseGasFundingRouter router;
    address provider;
    address payer = makeAddr("payer");
    address appOwner = makeAddr("appOwner");
    address newOwner = makeAddr("newOwner");

    function setUp() public {
        vm.chainId(8453);
        vm.warp(1_800_000_000);
        provider = vm.addr(P_PK);
        usdc = new MockToken6(6);
        ledger = new MockLedger();
        reserve = new EnclaveLeaseGasReserve(address(ledger), IRegistryR(makeAddr("registry")), IL1FeeOracle(address(0)),
            EnclaveLeaseGasReserve.Limits({maxGasPriceCeiling: 1 gwei, overheadClaimGas: 0, overheadRenewGas: 0,
                overheadReleaseGas: 0, minClaimInterval: 0, l1Bps: 0}));
        router = new LeaseGasFundingRouter(address(usdc), address(ledger), address(reserve), 0.1 ether);
        ledger.setOwner(ID, appOwner);
        usdc.mint(payer, 100e6);
        vm.prank(payer);
        usdc.approve(address(router), type(uint256).max);
        vm.deal(provider, 1 ether);
        vm.prank(provider);
        router.provide{value: 1 ether}();
    }

    function _fill(address payer_, address expectedOwner, uint256 usdcIn6, uint256 ethOut, uint256 nonce) internal {
        LeaseGasQuote memory q = LeaseGasQuote({
            payer: payer_, deployment: ID, expectedOwner: expectedOwner, usdcIn6: usdcIn6, ethOut: ethOut, nonce: nonce,
            expiry: uint64(block.timestamp + 5 minutes), provider: provider
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(P_PK, router.quoteDigest(q));
        bytes memory sig = abi.encodePacked(r, s, v);
        vm.prank(payer_);
        router.fill(q, sig);
    }

    function test_fillCreditsOwnersReserveKey_ownerCanWithdrawIt() public {
        _fill(payer, appOwner, 12e6, 0.004 ether, 1);
        assertEq(reserve.reserveOf(ID, appOwner).balanceWei, 0.004 ether);
        assertEq(reserve.reserveOf(ID, payer).balanceWei, 0);
        assertEq(address(reserve).balance, 0.004 ether);
        assertEq(usdc.balanceOf(provider), 12e6);

        // only the owner of record's key holds it: the payer cannot take it back, the owner can
        vm.expectRevert(bytes("short"));
        vm.prank(payer);
        reserve.withdraw(ID, 1, payable(payer));
        vm.prank(appOwner);
        reserve.withdraw(ID, 0.004 ether, payable(appOwner));
        assertEq(appOwner.balance, 0.004 ether);
    }

    function test_ownerTransferBeforeFill_refused() public {
        ledger.setOwner(ID, newOwner);
        LeaseGasQuote memory q = LeaseGasQuote({
            payer: payer, deployment: ID, expectedOwner: appOwner, usdcIn6: 12e6, ethOut: 0.004 ether, nonce: 1,
            expiry: uint64(block.timestamp + 5 minutes), provider: provider
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(P_PK, router.quoteDigest(q));
        bytes memory sig = abi.encodePacked(r, s, v);
        vm.expectRevert(abi.encodeWithSelector(LeaseGasFundingRouter.OwnerMismatch.selector, newOwner, appOwner));
        vm.prank(payer);
        router.fill(q, sig);
        assertEq(address(reserve).balance, 0);
        assertEq(usdc.balanceOf(payer), 100e6);
    }

    /// The reserve keeps a reserve keyed to the owner that held it: a later transfer neither moves nor exposes it.
    function test_ownerTransferAfterFill_reserveStaysWithPreviousOwner() public {
        _fill(payer, appOwner, 12e6, 0.004 ether, 1);
        ledger.setOwner(ID, newOwner);
        assertEq(reserve.reserveOf(ID, newOwner).balanceWei, 0);
        assertEq(reserve.reserveOf(ID, appOwner).balanceWei, 0.004 ether);
        _fill(payer, newOwner, 3e6, 0.001 ether, 2);
        assertEq(reserve.reserveOf(ID, newOwner).balanceWei, 0.001 ether);
    }

    function test_vaultHeldDeployment_sessionPayerShape() public {
        MockSessionPayer vault = new MockSessionPayer();
        ledger.setOwner(ID, address(vault));
        usdc.mint(address(vault), 30e6);
        LeaseGasQuote memory q = LeaseGasQuote({
            payer: address(vault), deployment: ID, expectedOwner: address(vault), usdcIn6: 30e6, ethOut: 0.01 ether,
            nonce: 1, expiry: uint64(block.timestamp + 5 minutes), provider: provider
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(P_PK, router.quoteDigest(q));
        vault.fundGas(router, usdc, q, abi.encodePacked(r, s, v));
        assertEq(reserve.reserveOf(ID, address(vault)).balanceWei, 0.01 ether);
        assertEq(usdc.balanceOf(address(vault)), 0);
        assertEq(usdc.allowance(address(vault), address(router)), 0);
    }

    function test_constructorRejectsReserveOfAnotherLedger() public {
        MockLedger other = new MockLedger();
        vm.expectRevert(abi.encodeWithSelector(LeaseGasFundingRouter.BadBinding.selector, uint8(2)));
        new LeaseGasFundingRouter(address(usdc), address(other), address(reserve), 0.1 ether);
    }
}
