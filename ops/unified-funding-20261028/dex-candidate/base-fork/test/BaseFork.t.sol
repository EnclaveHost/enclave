// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import {LeaseGasDexAdapter, IDXReserve, IDXLedger} from "dex-src/LeaseGasDexAdapter.sol";
import {DexGasIntent} from "dex-src/ILeaseGasDexAdapter.sol";
interface ITokenFork {
    function balanceOf(address) external view returns(uint256);
    function allowance(address,address) external view returns(uint256);
    function approve(address,uint256) external returns(bool);
}
/// Explicit opt-in Base FORK ONLY. No broadcast/signatures. Missing RPC fails; never silently skipped.
/// Token funding via Foundry storage cheatcode is simulation and does not establish live funding authority.
contract BaseForkTest is Test {
    address constant USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant WETH=0x4200000000000000000000000000000000000006;
    address constant ROUTER=0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant FACTORY=0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address constant LEDGER=0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B;
    address constant RESERVE=0x12A3f873041Dec436DaA0085B766a399A6fA3639;
    address constant OWNER=0x0b2d009c0c9Af05b12100D77F3c815fea822eE61;
    bytes32 constant DEPLOYMENT=0x9eb4e60063aa079cebed355f96b2d049457ae77bdbcd49086040282e1e4b871c;
    uint256 constant OUTPUT=20_000_000_000_000;
    uint256 constant MAX_INPUT=100_000;
    LeaseGasDexAdapter adapter;
    address payer;
    function setUp() public {
        vm.createSelectFork(vm.envString("BASE_FORK_RPC"), 53199497);
        assertEq(block.chainid,8453); assertEq(block.number,53199497); assertEq(block.timestamp,1793188341);
        assertEq(USDC.codehash,0xa6705a10bb756b5dea144591118be77d7af0c3eee3bf2dfe2583dcb0364fefab);
        assertEq(WETH.codehash,0x8a3a1f6a9f9dce633117adee5b458245835a8645a8c8726a26382a4622508b1c);
        assertEq(ROUTER.codehash,0x38bd640f47df62b2fd5a6755a63f4976ad847dc9b946ae0d145d21d16bb124e4);
        assertEq(FACTORY.codehash,0x95707a4ac71f20181a63ef7d180e3c625be5d20fc8f6f980befa966bad568132);
        assertEq(LEDGER.codehash,0x71d50076336283e774ba2ef8d5cbf7602e9cdc5dd918a7e7390c743367766682);
        assertEq(RESERVE.codehash,0xcc00efe9c79c17b34ef9edc2720939030834bf168abc52cea14dcb224304a979);
        assertEq(IDXLedger(LEDGER).get(DEPLOYMENT).owner,OWNER);
        adapter=new LeaseGasDexAdapter(USDC,WETH,ROUTER,FACTORY,LEDGER,RESERVE,0.001 ether);
        payer=makeAddr("fork-only-payer");
        deal(USDC,payer,1_000_000);
        vm.prank(payer); assertTrue(ITokenFork(USDC).approve(address(adapter),MAX_INPUT));
    }
    function intent(uint24 fee) internal view returns(DexGasIntent memory) {
        return DexGasIntent(payer,DEPLOYMENT,OWNER,OUTPUT,MAX_INPUT,fee,uint64(block.timestamp+60));
    }
    function purchase(uint24 fee,uint256 expectedIn) internal {
        uint256 beforeReserve=IDXReserve(RESERVE).reserveOf(DEPLOYMENT,OWNER).balanceWei;
        uint256 beforeUSDC=ITokenFork(USDC).balanceOf(payer);
        vm.prank(payer); uint256 spent=adapter.fundGas(intent(fee));
        assertEq(spent,expectedIn);
        assertEq(ITokenFork(USDC).balanceOf(payer),beforeUSDC-spent);
        assertEq(IDXReserve(RESERVE).reserveOf(DEPLOYMENT,OWNER).balanceWei,beforeReserve+OUTPUT);
        assertEq(ITokenFork(USDC).allowance(payer,address(adapter)),0);
        assertEq(ITokenFork(USDC).allowance(address(adapter),ROUTER),0);
        assertEq(ITokenFork(USDC).balanceOf(address(adapter)),0);
        assertEq(ITokenFork(WETH).balanceOf(address(adapter)),0);
        assertEq(address(adapter).balance,0);
    }
    function test_fee100_exactOutputRefundAndReserveCredit() public { purchase(100,47253); }
    function test_fee500_exactOutputRefundAndReserveCredit() public { purchase(500,47290); }
    function test_fee3000_exactOutputRefundAndReserveCredit() public { purchase(3000,47428); }
    function test_slippageFailurePreservesAllBalances() public {
        uint256 b=IDXReserve(RESERVE).reserveOf(DEPLOYMENT,OWNER).balanceWei;
        DexGasIntent memory i=intent(100);i.maxUsdcIn6=1;
        vm.expectRevert(); vm.prank(payer);adapter.fundGas(i);
        assertEq(ITokenFork(USDC).balanceOf(payer),1_000_000);
        assertEq(IDXReserve(RESERVE).reserveOf(DEPLOYMENT,OWNER).balanceWei,b);
        assertEq(ITokenFork(USDC).allowance(payer,address(adapter)),MAX_INPUT);
        assertEq(ITokenFork(USDC).allowance(address(adapter),ROUTER),0);
    }
}
