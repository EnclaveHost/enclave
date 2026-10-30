// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DexFixture} from "./DexFixture.sol";
import {LeaseGasDexAdapter} from "../src/LeaseGasDexAdapter.sol";
import {DexGasIntent} from "../src/ILeaseGasDexAdapter.sol";
import {MockSuccessorVault} from "./mocks/DexMocks.sol";
// reused read-only from r2 (local work)
import {MockLedger} from "r2/test/mocks/RouterMocks.sol";
// the lease-reserve SOURCE (work/enclave/contracts, read-only), compiled as-is: NOT a deployed-bytecode check
import {EnclaveLeaseGasReserve, IRegistryR, IL1FeeOracle} from "enclave-src/EnclaveLeaseGasReserve.sol";

/// The adapter against the actual EnclaveLeaseGasReserve source (mock ledger, mock DEX, no executor bound): deposit()
/// semantics, the (id, owner) reserve key, the struct ABI the adapter decodes, the owner's own withdraw path, and the
/// fact that bought ETH stays withdrawable by the owner of record (why this route is NOT closed-loop-credit-safe).
contract LeaseGasDexAdapterRealReserveTest is DexFixture {
    MockLedger ledger;
    EnclaveLeaseGasReserve reserve;
    LeaseGasDexAdapter adapter;
    address payer = makeAddr("payer");
    address appOwner = makeAddr("appOwner");
    address newOwner = makeAddr("newOwner");

    function setUp() public {
        _deployDex();
        ledger = new MockLedger();
        reserve = new EnclaveLeaseGasReserve(address(ledger), IRegistryR(makeAddr("registry")), IL1FeeOracle(address(0)),
            EnclaveLeaseGasReserve.Limits({maxGasPriceCeiling: 1 gwei, overheadClaimGas: 0, overheadRenewGas: 0,
                overheadReleaseGas: 0, minClaimInterval: 0, l1Bps: 0}));
        adapter = new LeaseGasDexAdapter(address(usdc), address(weth), address(router), address(factory),
            address(ledger), address(reserve), MAX_ETH);
        ledger.setOwner(ID, appOwner);
        usdc.mint(payer, 100e6);
    }

    function test_creditsOwnersKey_ownerCanWithdraw_payerCannot() public {
        uint256 quote = router.quoteIn(500, 0.004 ether);
        uint256 spent = _fund(adapter, _intent(payer, appOwner, 0.004 ether, quote + 1e6, 500));
        assertEq(spent, quote);
        assertEq(reserve.reserveOf(ID, appOwner).balanceWei, 0.004 ether);
        assertEq(reserve.reserveOf(ID, payer).balanceWei, 0);
        assertEq(address(reserve).balance, 0.004 ether);
        assertEq(usdc.balanceOf(payer), 100e6 - quote);

        vm.expectRevert(bytes("short"));
        vm.prank(payer);
        reserve.withdraw(ID, 1, payable(payer));
        // the owner of record CAN take the ETH out: bought gas is withdrawable, not closed-loop
        vm.prank(appOwner);
        reserve.withdraw(ID, 0.004 ether, payable(appOwner));
        assertEq(appOwner.balance, 0.004 ether);
    }

    function test_depositDoesNotEnableSponsorship() public {
        _fund(adapter, _intent(payer, appOwner, 0.002 ether, 10e6, 3000));
        (EnclaveLeaseGasReserve.Status st, uint256 avail,,) = reserve.statusOf(ID, 3, bytes32(0), address(1));
        assertEq(uint8(st), uint8(EnclaveLeaseGasReserve.Status.Disabled), "configure() is a separate owner step");
        assertEq(avail, 0.002 ether);
    }

    function test_ownerTransferBeforeFund_refused() public {
        ledger.setOwner(ID, newOwner);
        DexGasIntent memory i = _intent(payer, appOwner, 0.004 ether, 20e6, 500);
        _approve(adapter, i);
        vm.expectRevert(abi.encodeWithSelector(LeaseGasDexAdapter.OwnerMismatch.selector, newOwner, appOwner));
        vm.prank(payer);
        adapter.fundGas(i);
        assertEq(address(reserve).balance, 0);
        assertEq(usdc.balanceOf(payer), 100e6);
    }

    function test_ownerTransferAfterFund_reserveStaysWithPreviousOwner() public {
        _fund(adapter, _intent(payer, appOwner, 0.004 ether, 20e6, 500));
        ledger.setOwner(ID, newOwner);
        assertEq(reserve.reserveOf(ID, newOwner).balanceWei, 0);
        assertEq(reserve.reserveOf(ID, appOwner).balanceWei, 0.004 ether);
        _fund(adapter, _intent(payer, newOwner, 0.001 ether, 5e6, 100));
        assertEq(reserve.reserveOf(ID, newOwner).balanceWei, 0.001 ether);
    }

    function test_maxEthOut_withinReserveDepositBound() public {
        uint256 quote = router.quoteIn(500, MAX_ETH);
        usdc.mint(payer, quote);
        _fund(adapter, _intent(payer, appOwner, MAX_ETH, quote, 500));
        assertEq(reserve.reserveOf(ID, appOwner).balanceWei, MAX_ETH);
    }

    function test_vaultHeldDeployment_successorShape() public {
        MockSuccessorVault vault = new MockSuccessorVault(adapter, usdc, 15e6, 30e6, 2_500e6);
        ledger.setOwner(ID, address(vault));
        usdc.mint(address(vault), 30e6);
        uint256 spent = vault.fundGas(_intent(address(vault), address(vault), 0.004 ether, 10e6, 500));
        assertEq(reserve.reserveOf(ID, address(vault)).balanceWei, 0.004 ether);
        assertEq(usdc.balanceOf(address(vault)), 30e6 - spent);
        assertEq(usdc.allowance(address(vault), address(adapter)), 0);
        assertEq(vault.charged6(), spent);
    }

    function test_constructorRejectsReserveOfAnotherLedger() public {
        MockLedger other = new MockLedger();
        vm.expectRevert(abi.encodeWithSelector(LeaseGasDexAdapter.BadBinding.selector, uint8(2)));
        new LeaseGasDexAdapter(address(usdc), address(weth), address(router), address(factory), address(other),
            address(reserve), MAX_ETH);
    }
}
