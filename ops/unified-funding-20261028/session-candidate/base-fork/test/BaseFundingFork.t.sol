// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import {FundingSessionVault, FundingSessionVaultFactory, ISVToken, ISVBook, ISVRouter, ISVKeyAttestations}
    from "session-src/FundingSessionVault.sol";
import {LeaseGasDexAdapter, IDXReserve, IDXLedger} from "dex-r1/src/LeaseGasDexAdapter.sol";
import {DexGasIntent} from "dex-r1/src/ILeaseGasDexAdapter.sol";
interface ILegacyViews {
    function owner() external view returns(address);
    function book() external view returns(address);
    function router() external view returns(address);
    function keyAttestations() external view returns(address);
    function held(bytes32) external view returns(uint8,bytes32,bytes32);
}
interface ILegacyFactoryViews { function isVault(address) external view returns(bool); function vaultFor(address) external view returns(address); }
/// FORK ONLY. Synthetic token funding and owner impersonation are explicitly simulation, NOT signing authority.
/// Real native P256 session calls, live DEX/token/reserve/ledger and original B794 factory state. No broadcasts.
contract BaseFundingForkTest is Test {
    address constant USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant WETH=0x4200000000000000000000000000000000000006;
    address constant ROUTER=0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant FACTORY=0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address constant LEDGER=0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B;
    address constant RESERVE=0x12A3f873041Dec436DaA0085B766a399A6fA3639;
    address constant OWNER=0x0b2d009c0c9Af05b12100D77F3c815fea822eE61;
    address constant LEGACY=0xB794C4DD0e1C5E6B72281799F282BfdE7654345D;
    address constant LEGACY_FACTORY=0x1F5c887c0cDF491b16AB6c449abAfDF9B2ec9C9C;
    address constant LEGACY_IMPL=0x66C76A47209f44612343dbEAb98b8Ef77AD01F65;
    bytes32 constant DEPLOYMENT=0x9eb4e60063aa079cebed355f96b2d049457ae77bdbcd49086040282e1e4b871c;
    bytes32 constant OLD_ONE=0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c;
    bytes32 constant OLD_TWO=0x9a28642bed115105c07bea1131c56c83ae2843ce4daf07958ab36437c0528a6b;
    uint256 constant OUTPUT=20_000_000_000_000;
    uint256 constant MAX_INPUT=100_000;
    uint256 constant FEE=1000;
    uint256 constant SK=0x5E55; // public test scalar, unrelated to any user key
    LeaseGasDexAdapter adapter;
    FundingSessionVaultFactory factory;
    FundingSessionVault vault;
    bytes32 sid;
    uint256 x; uint256 y;
    address relayer;
    uint256 oldBalance;
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

        assertEq(LEGACY_FACTORY.codehash,0xc9b6214babb0126b26e818de8555c98b7e2a284b08a7cfd42f51b121e93d4f6c);
        assertEq(LEGACY_IMPL.codehash,0x3dd35d4c4bdf112e2ded90da36a16510bfe938a0c9b8b9ed4414698323efb76e);
        assertEq(LEGACY.code,abi.encodePacked(hex"363d3d373d3d3d363d73",LEGACY_IMPL,hex"5af43d82803e903d91602b57fd5bf3"));
        assertTrue(ILegacyFactoryViews(LEGACY_FACTORY).isVault(LEGACY));
        assertEq(ILegacyFactoryViews(LEGACY_FACTORY).vaultFor(OWNER),LEGACY);
        assertEq(ILegacyViews(LEGACY).owner(),OWNER);
        oldBalance=ISVToken(USDC).balanceOf(LEGACY);
        adapter=new LeaseGasDexAdapter(USDC,WETH,ROUTER,FACTORY,LEDGER,RESERVE,0.001 ether);
        factory=new FundingSessionVaultFactory(ISVToken(USDC), ISVBook(ILegacyViews(LEGACY).book()),
            ISVRouter(ILegacyViews(LEGACY).router()), ISVKeyAttestations(ILegacyViews(LEGACY).keyAttestations()),
            250e6,address(adapter),LEGACY_FACTORY);
        assertLe(address(factory.implementation()).code.length,24576,"deployable runtime required");
        vault=FundingSessionVault(factory.createVault(OWNER));
        deal(USDC,address(vault),30e6); // FORK-ONLY storage fabrication, no user's old balance used
        vm.deal(OWNER,0);
        (x,y)=vm.publicKeyP256(SK);
        FundingSessionVault.Grant memory g;
        g.label="fork gas qualification";g.preset="custom";g.sessionKey=keccak256(abi.encode(x,y));
        g.actions=new string[](1);g.actions[0]="gas.fund";
        g.apps=new string[](1);g.apps[0]="*";
        g.environments=new string[](2);g.environments[0]="staging";g.environments[1]="prod";
        g.budget=30e6;g.spendPerPeriod=30e6;g.periodSeconds=3600;g.opsPerPeriod=20;g.maxFeePerOp=10000;
        g.maxGasUsdcPerOp=100000;g.maxUsdcPerEth6=5000e6;g.maxEthPerOp=OUTPUT;
        g.expiresAt=uint64(block.timestamp+3600);g.grantNonce=keccak256("fork grant");
        vm.prank(OWNER);sid=vault.open(g,""); // owner impersonation ONLY ON FORK; offline suite tests real owner signatures
        relayer=makeAddr("funding fork relayer");
    }
    function execute(bytes32 id,address holder,uint256 maxInput, bool expectSlippage) internal returns(bytes memory) {
        bytes memory args=abi.encode(DexGasIntent(address(vault),id,holder,OUTPUT,maxInput,100,uint64(block.timestamp+60)));
        uint64 deadline=uint64(block.timestamp+60);
        bytes32 domain=keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("Enclave Sessions"),keccak256("2"),block.chainid,address(vault)));
        bytes32 h=keccak256(abi.encode(keccak256("SessionCall(bytes32 sessionId,uint256 nonce,uint8 action,bytes32 argsHash,uint256 fee,uint64 deadline)"),
            sid,uint256(0),uint8(10),keccak256(args),FEE,deadline));
        (bytes32 r,bytes32 s)=vm.signP256(SK,sha256(abi.encodePacked(keccak256(abi.encodePacked("\x19\x01",domain,h)))));
        if (expectSlippage) vm.expectRevert(abi.encodeWithSignature("Error(string)","STF"));
        vm.prank(relayer);return vault.execute(sid,0,10,args,FEE,deadline,x,y,r,s);
    }
    function purchase(bytes32 id,address holder) internal {
        uint256 beforeReserve=IDXReserve(RESERVE).reserveOf(id,holder).balanceWei;
        bytes32 heldHash;
        if(holder==LEGACY){ (uint8 env,bytes32 promoted,bytes32 creator)=ILegacyViews(LEGACY).held(id);
            assertTrue(env==1 || env==2);heldHash=keccak256(abi.encode(env,promoted,creator)); }
        (uint256 used,uint256 back)=abi.decode(execute(id,holder,MAX_INPUT,false),(uint256,uint256));
        assertEq(used,47253);assertEq(used+back,MAX_INPUT);
        (FundingSessionVault.Session memory st,,)=vault.sessionOf(sid);
        assertEq(st.balance6,30e6-used-FEE);assertEq(st.spent6,used+FEE);assertEq(st.periodSpent6,used+FEE);
        assertEq(st.periodOps,1);assertEq(vault.locked6(),st.balance6);
        assertEq(ISVToken(USDC).balanceOf(relayer),FEE);assertEq(ISVToken(USDC).balanceOf(address(vault)),st.balance6);
        assertEq(IDXReserve(RESERVE).reserveOf(id,holder).balanceWei,beforeReserve+OUTPUT);
        assertEq(IDXLedger(LEDGER).get(id).owner,holder);
        assertEq(ISVToken(USDC).allowance(address(vault),address(adapter)),0);
        assertEq(ISVToken(USDC).allowance(address(adapter),ROUTER),0);
        assertEq(ISVToken(USDC).balanceOf(LEGACY),oldBalance);assertEq(OWNER.balance,0);
        if(holder==LEGACY){ (uint8 env,bytes32 promoted,bytes32 creator)=ILegacyViews(LEGACY).held(id);
            assertEq(keccak256(abi.encode(env,promoted,creator)),heldHash); }
    }
    function test_walletHeld_realP256DexAndReserve() public {purchase(DEPLOYMENT,OWNER);}
    function test_oldVaultFirst_realP256NoCustodyMigration() public {purchase(OLD_ONE,LEGACY);}
    function test_oldVaultSecond_realP256NoCustodyMigration() public {purchase(OLD_TWO,LEGACY);}
    function test_slippageFailure_rollsBackBudgetNonceAndFee() public {
        uint256 beforeReserve=IDXReserve(RESERVE).reserveOf(OLD_ONE,LEGACY).balanceWei;
        execute(OLD_ONE,LEGACY,1,true);
        (FundingSessionVault.Session memory st,,)=vault.sessionOf(sid);
        assertEq(st.balance6,30e6);assertEq(st.spent6,0);assertEq(st.periodOps,0);assertEq(vault.seqOf(sid,0),0);
        assertEq(ISVToken(USDC).balanceOf(relayer),0);assertEq(ISVToken(USDC).balanceOf(address(vault)),30e6);
        assertEq(IDXReserve(RESERVE).reserveOf(OLD_ONE,LEGACY).balanceWei,beforeReserve);
    }
}
