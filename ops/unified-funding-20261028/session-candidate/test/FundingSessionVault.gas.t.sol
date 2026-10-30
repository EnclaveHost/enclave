// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { FundingRig, FakeOldVault } from "./FundingRig.sol";
import { FundingSessionVault, FundingSessionVaultFactory, FundingSessionVaultLib, ISVToken, ISVBook, ISVRouter,
    ISVKeyAttestations } from "../src/FundingSessionVault.sol";
import { FundingGasLib } from "../src/FundingGasLib.sol";
import { SessionVault as LegacyVault } from "enclave-src/SessionVault.sol";
import { EnclaveDeployments } from "enclave-src/EnclaveDeployments.sol";
import { LeaseGasDexAdapter } from "dex-r1/src/LeaseGasDexAdapter.sol";
import { DexGasIntent } from "dex-r1/src/ILeaseGasDexAdapter.sol";
import { MockUSDC } from "enclave-src/foundry/test/mocks/MockUSDC.sol";

/// gas.fund on the successor against the REAL adapter, reserve, ledger, catalog and ORIGINAL legacy factory.
contract FundingSessionVaultGasTest is FundingRig {
    uint256 constant FEE = 20_000;   // $0.02 relay fee, under maxFeePerOp $0.05

    struct Snap {
        uint256 bal; uint256 spent; uint256 period; uint256 ops; uint256 locked; uint256 vaultUsdc;
        uint256 relayerUsdc; uint256 relayer2Usdc; uint256 treasuryUsdc; uint256 ownerUsdc;
    }

    function _snap(bytes32 sid) internal view returns (Snap memory n) {
        FundingSessionVault.Session memory s = _sess(sid);
        n = Snap(s.balance6, s.spent6, s.periodSpent6, s.periodOps, vault.locked6(), usdc.balanceOf(address(vault)),
            usdc.balanceOf(relayer), usdc.balanceOf(relayer2), usdc.balanceOf(treasury), usdc.balanceOf(owner));
    }

    function _assertUnchanged(bytes32 sid, Snap memory a) internal view {
        Snap memory b = _snap(sid);
        assertEq(b.bal, a.bal, "balance6");
        assertEq(b.spent, a.spent, "spent6");
        assertEq(b.period, a.period, "periodSpent6");
        assertEq(b.ops, a.ops, "periodOps");
        assertEq(b.locked, a.locked, "locked6");
        assertEq(b.vaultUsdc, a.vaultUsdc, "vault usdc");
        assertEq(b.relayerUsdc, a.relayerUsdc, "relayer usdc");
        assertEq(b.relayer2Usdc, a.relayer2Usdc, "relayer2 usdc");
        assertEq(b.treasuryUsdc, a.treasuryUsdc, "treasury usdc");
    }

    /// one exact op: reserve max+fee, charge actual+fee, refund the rest to the same session, fee to the submitter
    function _assertCharged(bytes32 sid, Snap memory a, uint256 used, uint256 fee, address submitter) internal view {
        Snap memory b = _snap(sid);
        assertEq(b.bal, a.bal - used - fee, "balance6 = before - actual - fee");
        assertEq(b.spent, a.spent + used + fee, "spent6 = before + actual + fee");
        assertEq(b.period, a.period + used + fee, "periodSpent6 = before + actual + fee");
        assertEq(b.ops, a.ops + 1, "exactly one op");
        assertEq(b.locked, a.locked - used - fee, "locked6");
        assertEq(b.vaultUsdc, a.vaultUsdc - used - fee, "vault usdc: one debit of actual + fee");
        assertEq(b.treasuryUsdc, a.treasuryUsdc, "gas.fund pays no treasury fee");
        assertEq(usdc.balanceOf(submitter), (submitter == relayer ? a.relayerUsdc : a.relayer2Usdc) + fee, "fee to submitter");
        assertGe(usdc.balanceOf(address(vault)), vault.locked6(), "solvent");
        assertEq(usdc.allowance(address(vault), address(adapter)), 0, "no allowance left");
    }

    // =========================================================================================== grants & encoding

    function test_nativeP256IsRequired() public view {
        _requireNativeP256();
    }

    function test_grantDigestMatchesIndependentV2Encoding() public {
        FundingSessionVault.Grant memory g = _gasGrant(30e6);
        vm.prank(relayer);
        factory.createVault(owner);
        assertEq(vault.grantDigest(g), _typed(address(vault), "2", _grantHash2(g)));
        assertEq(vault.domainSeparator(), _domain(address(vault), "2"));
        assertEq(vault.GRANT_TYPEHASH(), GRANT2_TYPEHASH);
        assertEq(FundingSessionVaultLib.actionBit("gas.fund"), 1 << 10);
        vm.expectRevert(FundingSessionVaultLib.UnknownAction.selector);
        FundingSessionVaultLib.actionBit("order.pay");
    }

    function test_v1DomainSignatureIsRefused() public {
        FundingSessionVault.Grant memory g = _gasGrant(0);
        bytes memory sigV1 = _ecdsa(OWNER_PK, _typed(address(vault), "1", _grantHash2(g)));
        vm.prank(relayer);
        vm.expectRevert(FundingSessionVault.BadSignature.selector);
        factory.openFor(owner, g, sigV1);
    }

    function test_gasPolicyStoredAndBounded() public {
        bytes32 sid = _openWithDeposit(_gasGrant(30e6));
        (uint128 a, uint128 b, uint96 c) = vault.gasPolicyOf(sid);
        assertEq(a, MAX_GAS6); assertEq(b, MAX_PX6); assertEq(c, MAX_ETH_OP);
        assertEq(_sess(sid).actions >> 10 & 1, 1);
        assertEq(_sess(sid).actions >> 9 & 1, 0);
    }

    function test_gasGrantNeedsAllThreeLimitsPositiveAndBounded() public {
        FundingSessionVault.Grant[6] memory bad;
        for (uint256 k = 0; k < 6; k++) bad[k] = _gasGrant(0);
        bad[0].maxGasUsdcPerOp = 0;
        bad[1].maxUsdcPerEth6 = 0;
        bad[2].maxEthPerOp = 0;
        bad[3].maxGasUsdcPerOp = uint256(type(uint128).max) + 1;
        bad[4].maxUsdcPerEth6 = uint256(type(uint128).max) + 1;
        bad[5].maxEthPerOp = uint256(type(uint96).max) + 1;
        for (uint256 k = 0; k < 6; k++) {
            bytes memory sig = _signGrant(bad[k]);
            vm.prank(relayer);
            vm.expectRevert(FundingGasLib.BadGasPolicy.selector);
            factory.openFor(owner, bad[k], sig);
        }
        // the bounds themselves are accepted
        FundingSessionVault.Grant memory ok = _gasGrant(0);
        ok.maxGasUsdcPerOp = type(uint128).max; ok.maxUsdcPerEth6 = type(uint128).max; ok.maxEthPerOp = type(uint96).max;
        _open(ok);
    }

    function test_nonGasGrantMustCarryZeroGasLimits() public {
        FundingSessionVault.Grant memory g = _plainGrant(0);
        g.maxEthPerOp = 1;
        bytes memory sig = _signGrant(g);
        vm.prank(relayer);
        vm.expectRevert(FundingGasLib.BadGasPolicy.selector);
        factory.openFor(owner, g, sig);
        g.maxEthPerOp = 0;
        bytes32 sid = _open(g);
        (uint128 a, uint128 b, uint96 c) = vault.gasPolicyOf(sid);
        assertEq(uint256(a) + b + c, 0);
    }

    function test_oldGrantCannotAcquireGasAction() public {
        // the ORIGINAL contract does not know the name: a v1 grant asking for it cannot even open
        string[] memory acts = new string[](1);
        acts[0] = "gas.fund";
        LegacyVault.Grant memory g = _legacyGrant(acts);
        bytes memory sig = _ecdsa(OWNER_PK, _typed(address(oldVault), "1", _grantHash1(g)));
        vm.prank(relayer);
        vm.expectRevert(bytes4(keccak256("UnknownAction()")));
        legacyFactory.openFor(owner, g, sig);
        // and an old session (actions 0..7, like the funded production one) is refused action 10 by the old code
        LegacyVault.Grant memory g2 = _legacyGrant(_oldActions());
        vm.prank(relayer);
        (, bytes32 lsid) = legacyFactory.openFor(owner, g2, _ecdsa(OWNER_PK, _typed(address(oldVault), "1", _grantHash1(g2))));
        bytes32 id = _legacyRecord(STAGING);
        Call memory c = Call(address(oldVault), "1", SK, lsid, 0, GAS, _gasArgs(id, address(oldVault)), 0,
            uint64(vm.getBlockTimestamp() + 120), relayer);
        _sendExpect(c, abi.encodeWithSelector(LegacyVault.NotAllowed.selector, uint8(10)));
    }

    function test_successorWithoutGrantedBitRefusesGasAnd9And11() public {
        bytes32 sid = _openWithDeposit(_plainGrant(30e6));
        bytes32 id = _vaultRecord(STAGING);
        _execExpect(sid, 0, GAS, _gasArgs(id, address(vault)), 0,
            abi.encodeWithSelector(FundingSessionVault.NotAllowed.selector, uint8(10)));
        _execExpect(sid, 0, 9, _gasArgs(id, address(vault)), 0,
            abi.encodeWithSelector(FundingSessionVault.NotAllowed.selector, uint8(9)));
        bytes32 gsid = _openWithDeposit(_gasGrant(30e6));
        _execExpect(gsid, 0, 9, _gasArgs(id, address(vault)), 0,
            abi.encodeWithSelector(FundingSessionVault.NotAllowed.selector, uint8(9)));
        _execExpect(gsid, 0, 11, _gasArgs(id, address(vault)), 0,
            abi.encodeWithSelector(FundingSessionVault.NotAllowed.selector, uint8(11)));
    }

    // =========================================================================================== the happy paths

    function test_vaultHeld_chargesActualPlusFee_refundsUnusedToSameSession() public {
        bytes32 sid = _openWithDeposit(_gasGrant(30e6));
        bytes32 id = _vaultRecord(STAGING);
        Snap memory a = _snap(sid);
        uint256 q = _quote(ETH_OUT);
        bytes memory res = _exec(sid, 0, GAS, _gasArgs(id, address(vault)), FEE);
        (uint256 used, uint256 back) = abi.decode(res, (uint256, uint256));
        assertEq(used, q, "charged the pool's actual input");
        assertEq(back, MAX_IN - q, "gave back the rest");
        _assertCharged(sid, a, q, FEE, relayer);
        assertEq(reserve.reserveOf(id, address(vault)).balanceWei, ETH_OUT, "exact ETH credited to the holder's key");
        assertEq(ledger.get(id).owner, address(vault), "custody unchanged");
        assertEq(_seq(sid, 0), 1);
    }

    function test_zeroFeeIsValid() public {
        bytes32 sid = _openWithDeposit(_gasGrant(30e6));
        bytes32 id = _vaultRecord(STAGING);
        Snap memory a = _snap(sid);
        _exec(sid, 0, GAS, _gasArgs(id, address(vault)), 0);
        _assertCharged(sid, a, _quote(ETH_OUT), 0, relayer);
    }

    function test_walletHeldProd_noComputeRateRequirement() public {
        bytes32 sid = _openWithDeposit(_gasGrant(30e6));
        // a wallet record whose cap ($3600/h) is far above the grant's $10/h ceiling: deploy.fund refuses it...
        bytes32 id = _walletRecord(freeRef, address(0), 0, 1e6);
        _execExpect(sid, 0, FUND, abi.encode(id, uint256(1e6)), 0,
            abi.encodeWithSelector(FundingSessionVault.RateCapOutOfRange.selector, uint256(3_600e6), uint256(10e6)));
        // ...but buying it gas buys no runtime and needs no compute top-up
        Snap memory a = _snap(sid);
        _exec(sid, 0, GAS, _gasArgs(id, owner), FEE);
        _assertCharged(sid, a, _quote(ETH_OUT), FEE, relayer);
        assertEq(reserve.reserveOf(id, owner).balanceWei, ETH_OUT);
        assertEq(ledger.get(id).owner, owner);
    }

    function test_walletHeld_needsProdInGrant() public {
        FundingSessionVault.Grant memory g = _gasGrant(30e6);
        g.environments = _strs("staging");
        bytes32 sid = _openWithDeposit(g);
        bytes32 id = _walletRecord(freeRef, address(0), 0, 1000);
        _execExpect(sid, 0, GAS, _gasArgs(id, owner), FEE,
            abi.encodeWithSelector(FundingGasLib.EnvNotAllowed.selector, uint8(PROD)));
    }

    function test_walletHeld_paidAppMustBeNamed() public {
        bytes32 sid = _openWithDeposit(_gasGrant(30e6));           // apps "*", "mine": "*" never covers a paid app
        bytes32 id = _walletRecord(storeRef, publisher, 100, 1000);
        _execExpect(sid, 0, GAS, _gasArgs(id, owner), FEE,
            abi.encodeWithSelector(FundingGasLib.AppNotAllowed.selector, storeAppId));
        FundingSessionVault.Grant memory g = _gasGrant(30e6);
        g.apps = _strs("*", vm.toString(storeAppId));
        bytes32 named = _openWithDeposit(g);
        _exec(named, 0, GAS, _gasArgs(id, owner), FEE);
        assertEq(reserve.reserveOf(id, owner).balanceWei, ETH_OUT);
    }

    function test_appAllowlistNotBypassed() public {
        FundingSessionVault.Grant memory g = _gasGrant(30e6);
        g.apps = _strs(vm.toString(storeAppId));                  // no "*"
        bytes32 sid = _openWithDeposit(g);
        bytes32 id = _walletRecord(freeRef, address(0), 0, 1000);
        _execExpect(sid, 0, GAS, _gasArgs(id, owner), FEE,
            abi.encodeWithSelector(FundingGasLib.AppNotAllowed.selector, freeAppId));
        g = _gasGrant(30e6);
        g.apps = _strs(vm.toString(freeAppId));
        bytes32 listed = _openWithDeposit(g);
        _exec(listed, 0, GAS, _gasArgs(id, owner), FEE);
    }

    // =========================================================================================== old-vault records

    function test_legacyVaultHeld_fundedInPlace() public {
        bytes32 sid = _openWithDeposit(_gasGrant(30e6));
        bytes32 id = _legacyRecord(STAGING);
        (uint8 envBefore, , ) = oldVault.held(id);
        Snap memory a = _snap(sid);
        _exec(sid, 0, GAS, _gasArgs(id, address(oldVault)), FEE);
        _assertCharged(sid, a, _quote(ETH_OUT), FEE, relayer);
        assertEq(reserve.reserveOf(id, address(oldVault)).balanceWei, ETH_OUT, "credited to the old vault's key");
        assertEq(ledger.get(id).owner, address(oldVault), "old custody untouched");
        (uint8 envAfter, , ) = oldVault.held(id);
        assertEq(envAfter, envBefore);
        assertEq(oldVault.owner(), owner);
    }

    function test_legacyVaultHeld_wrongEnvRefused() public {
        FundingSessionVault.Grant memory g = _gasGrant(30e6);
        g.environments = _strs("prod");
        bytes32 sid = _openWithDeposit(g);
        bytes32 id = _legacyRecord(STAGING);
        _execExpect(sid, 0, GAS, _gasArgs(id, address(oldVault)), FEE,
            abi.encodeWithSelector(FundingGasLib.EnvNotAllowed.selector, uint8(STAGING)));
    }

    function test_legacyVaultHeld_unadoptedRefused() public {
        bytes32 sid = _openWithDeposit(_gasGrant(30e6));
        legacyFactory.createVault(owner);
        bytes32 id = _walletRecord(freeRef, address(0), 0, 1000);
        vm.prank(owner);
        ledger.transferDeployment(id, address(oldVault));         // in the old vault, never adopted: inert
        _execExpect(sid, 0, GAS, _gasArgs(id, address(oldVault)), FEE,
            abi.encodeWithSelector(FundingGasLib.NotHeld.selector, id));
    }

    function test_fakeOldVaultRefused() public {
        bytes32 sid = _openWithDeposit(_gasGrant(30e6));
        FakeOldVault fake = new FakeOldVault(owner);               // answers owner() == owner, held() == staging
        bytes32 id = fake.make(ledger, freeRef);
        _execExpect(sid, 0, GAS, _gasArgs(id, address(fake)), FEE,
            abi.encodeWithSelector(FundingGasLib.NotMine.selector, id));
    }

    function test_someoneElsesOldVaultRefused() public {
        bytes32 sid = _openWithDeposit(_gasGrant(30e6));
        address stranger = vm.addr(OTHER_PK);
        address theirs = legacyFactory.createVault(stranger);     // a genuine clone - of someone else
        bytes32 id = _walletRecord(freeRef, address(0), 0, 1000);
        vm.prank(owner);
        ledger.transferDeployment(id, theirs);
        _execExpect(sid, 0, GAS, _gasArgs(id, theirs), FEE, abi.encodeWithSelector(FundingGasLib.NotMine.selector, id));
    }

    function test_unadoptedSuccessorRecordRefused() public {
        bytes32 sid = _openWithDeposit(_gasGrant(30e6));
        bytes32 id = _walletRecord(freeRef, address(0), 0, 1000);
        vm.prank(relayer);
        factory.createVault(owner);
        vm.prank(owner);
        ledger.transferDeployment(id, address(vault));
        _execExpect(sid, 0, GAS, _gasArgs(id, address(vault)), FEE,
            abi.encodeWithSelector(FundingGasLib.NotHeld.selector, id));
    }

    function test_wrongExpectedOwnerAndUnknownRecordRefused() public {
        bytes32 sid = _openWithDeposit(_gasGrant(30e6));
        bytes32 id = _vaultRecord(STAGING);
        _execExpect(sid, 0, GAS, _gasArgs(id, owner), FEE, abi.encodeWithSelector(FundingGasLib.NotMine.selector, id));
        bytes32 nope = keccak256("nope");
        _execExpect(sid, 0, GAS, _gasArgs(nope, address(vault)), FEE,
            abi.encodeWithSelector(FundingGasLib.UnknownDeployment.selector, nope));
    }

    // =========================================================================================== signed limits

    function test_perOpGasCap() public {
        bytes32 sid = _openWithDeposit(_gasGrant(30e6));
        bytes32 id = _vaultRecord(STAGING);
        _execExpect(sid, 0, GAS, abi.encode(_intent(id, address(vault), ETH_OUT, MAX_GAS6 + 1)), FEE,
            abi.encodeWithSelector(FundingGasLib.GasCapExceeded.selector, MAX_GAS6 + 1, MAX_GAS6));
    }

    function test_perOpEthCap() public {
        bytes32 sid = _openWithDeposit(_gasGrant(30e6));
        bytes32 id = _vaultRecord(STAGING);
        _execExpect(sid, 0, GAS, abi.encode(_intent(id, address(vault), MAX_ETH_OP + 1, MAX_IN)), FEE,
            abi.encodeWithSelector(FundingGasLib.EthCapExceeded.selector, MAX_ETH_OP + 1, MAX_ETH_OP));
        _execExpect(sid, 0, GAS, abi.encode(_intent(id, address(vault), 0, MAX_IN)), FEE,
            abi.encodeWithSelector(FundingGasLib.EthCapExceeded.selector, uint256(0), MAX_ETH_OP));
    }

    function test_priceCapExactBoundary() public {
        bytes32 sid = _openWithDeposit(_gasGrant(30e6));
        bytes32 id = _vaultRecord(STAGING);
        uint256 edge = MAX_PX6 * ETH_OUT / 1e18;                   // 12e6: exactly $3000/ETH for 0.004 ETH
        assertEq(edge * 1e18, MAX_PX6 * ETH_OUT, "fixture divides exactly");
        _execExpect(sid, 0, GAS, abi.encode(_intent(id, address(vault), ETH_OUT, edge + 1)), FEE,
            abi.encodeWithSelector(FundingGasLib.PriceCapExceeded.selector, edge + 1, ETH_OUT, MAX_PX6));
        _exec(sid, 0, GAS, abi.encode(_intent(id, address(vault), ETH_OUT, edge)), FEE);
    }

    function test_feeCap() public {
        bytes32 sid = _openWithDeposit(_gasGrant(30e6));
        bytes32 id = _vaultRecord(STAGING);
        _execExpect(sid, 0, GAS, _gasArgs(id, address(vault)), 50_001,
            abi.encodeWithSelector(FundingSessionVault.FeeTooHigh.selector, uint256(50_001), uint256(50_000)));
    }

    function test_budgetCountsMaximumPlusFee() public {
        bytes32 sid = _openWithDeposit(_gasGrant(11e6));           // actual (9.6048) + fee would fit; max + fee does not
        bytes32 id = _vaultRecord(STAGING);
        _execExpect(sid, 0, GAS, _gasArgs(id, address(vault)), FEE,
            abi.encodeWithSelector(FundingSessionVault.BudgetExceeded.selector, MAX_IN + FEE, uint256(11e6)));
        _exec(sid, 0, GAS, _gasArgs(id, address(vault)), 0);      // max + 0 fits exactly
        assertEq(_sess(sid).balance6, 11e6 - _quote(ETH_OUT));
    }

    function test_periodLimitOnMaximum_thenResetRestoresExactly() public {
        FundingSessionVault.Grant memory g = _gasGrant(30e6);
        g.spendPerPeriod = 12e6;
        g.periodSeconds = 1 hours;
        bytes32 sid = _openWithDeposit(g);
        bytes32 id = _vaultRecord(STAGING);
        uint256 q = _quote(ETH_OUT);
        _exec(sid, 0, GAS, _gasArgs(id, address(vault)), FEE);
        assertEq(_sess(sid).periodSpent6, q + FEE, "period holds actual + fee, not the maximum");
        uint256 left = 12e6 - q - FEE;
        _execExpect(sid, 1, GAS, _gasArgs(id, address(vault)), FEE,
            abi.encodeWithSelector(FundingSessionVault.PeriodLimit.selector, MAX_IN + FEE, left));
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        Snap memory a = _snap(sid);
        _exec(sid, 1, GAS, _gasArgs(id, address(vault)), FEE);
        FundingSessionVault.Session memory s = _sess(sid);
        assertEq(s.periodSpent6, q + FEE, "fresh period: exactly actual + fee");
        assertEq(s.periodOps, 1, "fresh period: one op");
        assertEq(s.balance6, a.bal - q - FEE);
    }

    function test_opsPerPeriod() public {
        FundingSessionVault.Grant memory g = _gasGrant(30e6);
        g.opsPerPeriod = 1;
        bytes32 sid = _openWithDeposit(g);
        bytes32 id = _vaultRecord(STAGING);
        _exec(sid, 0, GAS, _gasArgs(id, address(vault)), FEE);
        _execExpect(sid, 1, GAS, _gasArgs(id, address(vault)), FEE, abi.encodeWithSelector(FundingSessionVault.RateLimit.selector));
    }

    function test_argsMustBeExactlyOneIntent() public {
        bytes32 sid = _openWithDeposit(_gasGrant(30e6));
        bytes32 id = _vaultRecord(STAGING);
        _execExpect(sid, 0, GAS, abi.encode(_intent(id, address(vault), ETH_OUT, MAX_IN), uint256(0)), FEE,
            abi.encodeWithSelector(FundingGasLib.BadGasArgs.selector));
        _execExpect(sid, 0, GAS, abi.encode(id, uint256(1)), FEE, "");   // too short to hold the maximum: reverts
    }

    function test_payerMustBeThisVault() public {
        bytes32 sid = _openWithDeposit(_gasGrant(30e6));
        bytes32 id = _vaultRecord(STAGING);
        DexGasIntent memory i = _intent(id, address(vault), ETH_OUT, MAX_IN);
        i.payer = owner;
        _execExpect(sid, 0, GAS, abi.encode(i), FEE, abi.encodeWithSelector(FundingGasLib.NotPayer.selector));
    }

    function test_intentDeadlineEnforcedByAdapter() public {
        bytes32 sid = _openWithDeposit(_gasGrant(30e6));
        bytes32 id = _vaultRecord(STAGING);
        DexGasIntent memory i = _intent(id, address(vault), ETH_OUT, MAX_IN);
        i.deadline = uint64(vm.getBlockTimestamp() + 16 minutes);
        _execExpect(sid, 0, GAS, abi.encode(i), FEE, abi.encodeWithSelector(LeaseGasDexAdapter.DeadlineTooFar.selector));
    }

    function test_bookLedgerSwapRefused() public {
        bytes32 sid = _openWithDeposit(_gasGrant(30e6));
        bytes32 id = _vaultRecord(STAGING);
        EnclaveDeployments other = new EnclaveDeployments(address(usdc), payout, address(reg), address(0));
        book.set("deployments", address(other));
        _execExpect(sid, 0, GAS, _gasArgs(id, address(vault)), FEE, abi.encodeWithSelector(FundingGasLib.LedgerMismatch.selector));
    }

    // =========================================================================================== session gates

    function test_expiredRevokedDeadline() public {
        bytes32 sid = _openWithDeposit(_gasGrant(30e6));
        bytes32 id = _vaultRecord(STAGING);
        Call memory c = _call(sid, 0, GAS, _gasArgs(id, address(vault)), FEE);
        vm.warp(vm.getBlockTimestamp() + 121);
        _sendExpect(c, abi.encodeWithSelector(FundingSessionVault.Expired.selector));
        vm.warp(vm.getBlockTimestamp() + 8 days);
        _execExpect(sid, 0, GAS, _gasArgs(id, address(vault)), FEE, abi.encodeWithSelector(FundingSessionVault.NotLive.selector));
    }

    function test_revokedByOwner() public {
        bytes32 sid = _openWithDeposit(_gasGrant(30e6));
        bytes32 id = _vaultRecord(STAGING);
        vm.prank(owner);
        vault.revokeAll(false, keccak256("r"), 0, "");
        _execExpect(sid, 0, GAS, _gasArgs(id, address(vault)), FEE, abi.encodeWithSelector(FundingSessionVault.NotLive.selector));
    }

    function test_wrongKeyAndWrongChain() public {
        bytes32 sid = _openWithDeposit(_gasGrant(30e6));
        bytes32 id = _vaultRecord(STAGING);
        Call memory c = _call(sid, 0, GAS, _gasArgs(id, address(vault)), FEE);
        c.sk = SK2;                                                // a different P-256 key
        _sendExpect(c, abi.encodeWithSelector(FundingSessionVault.BadSignature.selector));
        c.sk = SK;
        (uint256 x, uint256 y, bytes32 r, bytes32 s) = _sig(c);   // signed for THIS chain
        vm.chainId(block.chainid + 1);
        vm.prank(relayer);
        vm.expectRevert(FundingSessionVault.BadSignature.selector);
        vault.execute(c.sid, c.nonce, c.action, c.args, c.fee, c.deadline, x, y, r, s);
    }

    function test_tamperedArgsOrFeeRefused() public {
        bytes32 sid = _openWithDeposit(_gasGrant(30e6));
        bytes32 id = _vaultRecord(STAGING);
        Call memory c = _call(sid, 0, GAS, _gasArgs(id, address(vault)), FEE);
        (uint256 x, uint256 y, bytes32 r, bytes32 s) = _sig(c);
        vm.startPrank(relayer);
        vm.expectRevert(FundingSessionVault.BadSignature.selector);
        vault.execute(sid, 0, GAS, abi.encode(_intent(id, address(vault), ETH_OUT, MAX_IN + 1)), FEE, c.deadline, x, y, r, s);
        vm.expectRevert(FundingSessionVault.BadSignature.selector);
        vault.execute(sid, 0, GAS, c.args, FEE + 1, c.deadline, x, y, r, s);
        vm.stopPrank();
    }

    function test_attestationGate() public {
        bytes32 m = keccak256("image-1");
        ka.set(keyHash, m);
        FundingSessionVault.Grant memory g = _gasGrant(30e6);
        g.measurement = m;
        bytes32 sid = _openWithDeposit(g);
        bytes32 id = _vaultRecord(STAGING);
        _exec(sid, 0, GAS, _gasArgs(id, address(vault)), FEE);
        ka.set(keyHash, keccak256("image-2"));
        _execExpect(sid, 1, GAS, _gasArgs(id, address(vault)), FEE, abi.encodeWithSelector(FundingSessionVault.NoAttestation.selector));
    }

    // =========================================================================================== nonces & relayers

    function test_replayAndLanes() public {
        bytes32 sid = _openWithDeposit(_gasGrant(30e6));
        bytes32 id = _vaultRecord(STAGING);
        uint256 lane1 = uint256(1) << 64;
        uint256 lane2 = uint256(2) << 64;
        Call memory c1 = _call(sid, lane1, GAS, _gasArgs(id, address(vault)), FEE);
        Call memory c2 = _call(sid, lane2, GAS, _gasArgs(id, address(vault)), FEE);
        c2.sender = relayer2;
        _send(c2);                                                 // lanes are independent: either order
        _send(c1);
        assertEq(_seq(sid, lane1), 1);
        assertEq(_seq(sid, lane2), 1);
        Snap memory a = _snap(sid);
        _sendExpect(c1, abi.encodeWithSelector(FundingSessionVault.BadNonce.selector));
        _assertUnchanged(sid, a);
        assertEq(reserve.reserveOf(id, address(vault)).balanceWei, 2 * ETH_OUT);
    }

    function test_concurrentRelayers_onlyTheSuccessfulSubmitterIsPaid() public {
        bytes32 sid = _openWithDeposit(_gasGrant(30e6));
        bytes32 id = _vaultRecord(STAGING);
        Call memory c = _call(sid, 0, GAS, _gasArgs(id, address(vault)), FEE);
        Call memory front = _call(sid, 0, GAS, _gasArgs(id, address(vault)), FEE);
        front.sender = relayer2;                                   // relayer2 front-runs the SAME signed call
        Snap memory a = _snap(sid);
        _send(front);
        _assertCharged(sid, a, _quote(ETH_OUT), FEE, relayer2);
        assertEq(usdc.balanceOf(relayer), a.relayerUsdc, "the slower relayer is paid nothing");
        Snap memory b = _snap(sid);
        _sendExpect(c, abi.encodeWithSelector(FundingSessionVault.BadNonce.selector));
        _assertUnchanged(sid, b);
    }

    // =========================================================================================== rollbacks

    function test_failedSwapChargesNothing() public {
        bytes32 sid = _openWithDeposit(_gasGrant(30e6));
        bytes32 id = _vaultRecord(STAGING);
        Snap memory a = _snap(sid);
        swapRouter.setMode(1);                                     // SHORT_OUT: the adapter's delta check fails
        _execExpect(sid, 0, GAS, _gasArgs(id, address(vault)), FEE, "");
        swapRouter.setMode(0);
        swapRouter.setPrice(TIER, 2_900e6);                        // pool now needs more than the signed maximum
        _execExpect(sid, 0, GAS, _gasArgs(id, address(vault)), FEE, bytes("Too much requested"));
        _assertUnchanged(sid, a);
        assertEq(_seq(sid, 0), 0, "nonce not consumed");
        assertEq(reserve.reserveOf(id, address(vault)).balanceWei, 0);
        assertEq(usdc.allowance(address(vault), address(adapter)), 0);
    }

    function test_feeTransferFailureRollsBackTheSwap() public {
        bytes32 sid = _openWithDeposit(_gasGrant(30e6));
        bytes32 id = _vaultRecord(STAGING);
        Snap memory a = _snap(sid);
        vm.mockCallRevert(address(usdc), abi.encodeWithSelector(MockUSDC.transfer.selector, relayer, FEE), "blocked");
        _execExpect(sid, 0, GAS, _gasArgs(id, address(vault)), FEE, bytes("blocked"));
        vm.clearMockedCalls();
        _assertUnchanged(sid, a);
        assertEq(reserve.reserveOf(id, address(vault)).balanceWei, 0, "swap rolled back with the fee");
        assertEq(_seq(sid, 0), 0);
    }

    // =========================================================================================== zero-ETH owner

    function test_zeroEthOwner_relayerOnlyFlow() public {
        assertEq(owner.balance, 0);
        assertEq(address(vault).code.length, 0, "no vault yet");
        FundingSessionVault.Grant memory g = _gasGrant(30e6);
        bytes32 gd = _typed(address(vault), "2", _grantHash2(g));
        uint256 ownerUsdc = usdc.balanceOf(owner);
        bytes32 sid = _openWithDeposit(g);                         // relayer submits grant + EIP-3009
        assertTrue(usdc.authorizationState(owner, gd), "the authorization nonce IS the grant digest");
        assertEq(usdc.balanceOf(owner), ownerUsdc - 30e6);
        assertEq(_sess(sid).balance6, 30e6);
        assertEq(vault.locked6(), 30e6);
        bytes32 id = _walletRecord(freeRef, address(0), 0, 1000);  // (made by the wallet earlier in production)
        _exec(sid, 0, GAS, _gasArgs(id, owner), FEE);              // relayer submits; earns FEE in USDC
        assertEq(reserve.reserveOf(id, owner).balanceWei, ETH_OUT);
        assertEq(owner.balance, 0, "the owner never needed ETH");
        assertEq(usdc.balanceOf(relayer), FEE);
    }

    function test_eip3009AuthorizationCannotBeReusedOrRedirected() public {
        FundingSessionVault.Grant memory g = _gasGrant(30e6);
        bytes32 gd = _typed(address(vault), "2", _grantHash2(g));
        bytes memory auth = _receiveSig(OWNER_PK, address(vault), g.budget, 0, vm.getBlockTimestamp() + 1 hours, gd);
        bytes memory sig = _signGrant(g);
        vm.prank(relayer);
        factory.openWithDepositFor(owner, g, sig, 0, vm.getBlockTimestamp() + 1 hours, auth);
        // same authorization for a different budget: the digest (nonce) differs, so the signature does not verify
        FundingSessionVault.Grant memory g2 = g;
        g2.budget = 31e6;
        bytes memory sig2 = _signGrant(g2);
        vm.prank(relayer);
        vm.expectRevert();
        factory.openWithDepositFor(owner, g2, sig2, 0, vm.getBlockTimestamp() + 1 hours, auth);
    }

    // =========================================================================================== fuzz

    /// Any in-policy (ethOut, maxIn, fee): either the whole op reverts with nothing moved, or exactly actual + fee
    /// leaves the session once, the rest stays in it, one op is counted, and the vault stays solvent.
    function testFuzz_exactAccounting(uint256 ethOut, uint256 maxIn, uint256 fee, uint256 px) public {
        ethOut = bound(ethOut, 1e9, MAX_ETH_OP);
        px = bound(px, 1_000e6, 2_990e6);
        maxIn = bound(maxIn, 1, MAX_GAS6);
        fee = bound(fee, 0, 50_000);
        swapRouter.setPrice(TIER, px);
        bytes32 sid = _openWithDeposit(_gasGrant(30e6));
        bytes32 id = _vaultRecord(STAGING);
        Snap memory a = _snap(sid);
        Call memory c = _call(sid, 0, GAS, abi.encode(_intent(id, address(vault), ethOut, maxIn)), fee);
        (uint256 x, uint256 y, bytes32 r, bytes32 s) = _sig(c);
        vm.prank(relayer);
        try vault.execute(sid, 0, GAS, c.args, fee, c.deadline, x, y, r, s) returns (bytes memory res) {
            (uint256 used, uint256 back) = abi.decode(res, (uint256, uint256));
            assertEq(used, swapRouter.quoteIn(TIER, ethOut));
            assertEq(used + back, maxIn);
            assertLe(maxIn * 1e18, MAX_PX6 * ethOut, "only in-price intents can succeed");
            _assertCharged(sid, a, used, fee, relayer);
        } catch {
            _assertUnchanged(sid, a);
            assertEq(_seq(sid, 0), 0);
        }
    }
}
