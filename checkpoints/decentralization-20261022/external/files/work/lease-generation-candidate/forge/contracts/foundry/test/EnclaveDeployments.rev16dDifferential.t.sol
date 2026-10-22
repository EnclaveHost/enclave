// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {EnclaveDeployments as L16} from "../../rev16d/EnclaveDeployments.sol";
import {EnclaveDeployments as L17, IEnclaveDeploymentsLeases} from "../../EnclaveDeployments.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {LeaseRegistry, LeaseFeed, LeaseRouter} from "./LeaseRig.sol";

/// Differential: the LIVE rev-16d source (blob 3f3d2c3a, contracts/rev16d) and the rev-17 candidate, deployed side by
/// side with their own token, router and payout, driven by IDENTICAL calls from the same actors. After every step:
///   - both calls succeed or both revert, with identical return / revert data;
///   - identical logs (topics and data; the emitter mapped to its role), except the candidate's additive LeaseOpened;
///   - identical state: every Deployment tuple, earn/fee/cap/refundable/escrow/proven views, every actor's earnings and
///     bond, and every token balance.
/// The candidate's NAMED release (releaseLease with the current runner and generation) is compared against rev 16d's
/// release(id): naming the live lease must change nothing else.
contract EnclaveDeploymentsRev16dDifferentialTest is Test {
    L16 internal a;
    L17 internal b;
    MockUSDC internal ta;
    MockUSDC internal tb;
    LeaseRouter internal ra;
    LeaseRouter internal rb;
    LeaseRegistry internal reg;
    LeaseFeed internal feed;

    address internal user = makeAddr("user");
    address internal sponsor = makeAddr("sponsor");
    address internal vault = makeAddr("sessionVault");
    address internal publisher = makeAddr("publisher");
    address internal payout = makeAddr("payout");
    address internal opA = makeAddr("operatorA");
    address internal opB = makeAddr("operatorB");
    address internal provider = makeAddr("bandwidthProvider");
    bytes32 internal constant A1 = keccak256("host-a1");
    bytes32 internal constant A2 = keccak256("host-a2");
    bytes32 internal constant HB = keccak256("host-b");
    bytes32 internal constant SELF = keccak256("host-self");
    uint256 internal constant T0 = 1_700_000_000;
    bytes32 internal constant LEASE_OPENED = keccak256("LeaseOpened(bytes32,bytes32,uint64)");

    bytes32[] internal ids;
    bool internal lastOk;
    mapping(uint256 => uint256) internal okCount;   // op -> successful (both-sides) executions
    address[] internal actors;

    function setUp() public {
        vm.warp(T0);
        reg = new LeaseRegistry();
        reg.set(A1, opA, 834, 1667); reg.set(A2, opA, 900, 1700); reg.set(HB, opB, 700, 1500);
        reg.set(SELF, opB, 834, 1667); reg.setPayoutWallet(SELF, user);              // self-hosting: free (rev 12)
        feed = new LeaseFeed();
        ta = new MockUSDC(); tb = new MockUSDC();
        a = new L16(address(ta), payout, address(reg), address(feed));
        b = new L17(address(tb), payout, address(reg), address(feed));
        ra = new LeaseRouter(address(a)); rb = new LeaseRouter(address(b));
        assertLe(address(b).code.length, 24576);
        actors = [user, sponsor, vault, publisher, payout, opA, opB, provider, address(this)];
        for (uint256 i; i < actors.length; i++) {
            ta.mint(actors[i], 1_000_000e6); tb.mint(actors[i], 1_000_000e6);
            vm.startPrank(actors[i]); ta.approve(address(a), type(uint256).max); tb.approve(address(b), type(uint256).max); vm.stopPrank();
        }
        _both(address(this), abi.encodeWithSignature("setProver(address)", address(this)));
        _both(address(this), abi.encodeWithSignature("setProofRequiredFrom(uint64)", uint64(T0 + 4000)));   // the meter flips mid-run
        a.setBandwidthRouter(address(ra)); b.setBandwidthRouter(address(rb));
        a.setFeeRouter(address(ra)); b.setFeeRouter(address(rb));
        // two deployments: one with a publisher fee, one GPU-share without
        ids.push(_createBoth(abi.encodeWithSignature("create(string,uint16,uint16,uint32,string,bool,string,address,uint256,uint256)",
            "catalog://app/0", uint16(0), uint16(1000), uint32(8080), "", true, "", publisher, uint256(50), uint256(1200))));
        ids.push(_createBoth(abi.encodeWithSignature("create(string,uint16,uint16,uint32,string,bool,string,address,uint256,uint256)",
            "catalog://app/1", uint16(250), uint16(300), uint32(8080), "tcp:22", false, "{}", address(0), uint256(0), uint256(2000))));
    }

    // ---- the comparator ------------------------------------------------------------------------------------------
    function _createBoth(bytes memory data) internal returns (bytes32 id) {
        (, bytes memory ret) = _both(user, data);
        id = abi.decode(ret, (bytes32));
    }

    function _both(address actor, bytes memory data) internal returns (bool, bytes memory) { return _both2(actor, data, data, 0); }

    /// Call rev 16d with `da` and the candidate with `db` (the same bytes except for the named-release case).
    function _both2(address actor, bytes memory da, bytes memory db, uint256 value) internal returns (bool okA, bytes memory retA) {
        vm.deal(actor, actor.balance + 2 * value);
        uint256[3] memory ethA = [payout.balance, publisher.balance, address(a).balance];
        vm.recordLogs();
        vm.prank(actor); (okA, retA) = address(a).call{value: value}(da);
        Vm.Log[] memory la = vm.getRecordedLogs();
        uint256[3] memory dA = [payout.balance - ethA[0], publisher.balance - ethA[1], address(a).balance - ethA[2]];
        uint256[3] memory ethB = [payout.balance, publisher.balance, address(b).balance];
        vm.recordLogs();
        vm.prank(actor); (bool okB, bytes memory retB) = address(b).call{value: value}(db);
        Vm.Log[] memory lb = vm.getRecordedLogs();
        assertEq(okA, okB, "success differs");
        assertEq(retA, retB, "return or revert data differs");
        lastOk = okA;
        assertEq(abi.encode(dA), abi.encode([payout.balance - ethB[0], publisher.balance - ethB[1], address(b).balance - ethB[2]]), "ETH flows differ");
        _sameLogs(la, lb);
        _sameState();
    }

    function _role(address e, bool candidate) internal view returns (uint256) {
        if (e == (candidate ? address(b) : address(a))) return 1;
        if (e == (candidate ? address(tb) : address(ta))) return 2;
        if (e == (candidate ? address(rb) : address(ra))) return 3;
        return uint256(uint160(e));
    }

    function _sameLogs(Vm.Log[] memory la, Vm.Log[] memory lb) internal view {
        uint256 j;
        for (uint256 i; i < lb.length; i++) {
            if (lb[i].topics.length > 0 && lb[i].topics[0] == LEASE_OPENED && lb[i].emitter == address(b)) continue;   // additive
            assertLt(j, la.length, "candidate emits an extra log");
            assertEq(_role(la[j].emitter, false), _role(lb[i].emitter, true), "emitter");
            bytes32[] memory tb_ = lb[i].topics;
            for (uint256 t; t < tb_.length; t++) tb_[t] = _norm(tb_[t]);
            assertEq(abi.encode(la[j].topics), abi.encode(tb_), "topics");
            assertEq(la[j].data, _normData(lb[i].data), "data");
            j++;
        }
        assertEq(j, la.length, "candidate is missing a log");
    }

    /// The candidate's own ledger / token / router addresses stand for rev 16d's in a compared word.
    function _norm(bytes32 w) internal view returns (bytes32) {
        if (w == bytes32(uint256(uint160(address(b))))) return bytes32(uint256(uint160(address(a))));
        if (w == bytes32(uint256(uint160(address(tb))))) return bytes32(uint256(uint160(address(ta))));
        if (w == bytes32(uint256(uint160(address(rb))))) return bytes32(uint256(uint160(address(ra))));
        return w;
    }
    function _normData(bytes memory d) internal view returns (bytes memory o) {
        o = bytes.concat(d);
        for (uint256 k = 0; k + 32 <= o.length; k += 32) {
            bytes32 w; assembly { w := mload(add(add(o, 32), k)) }
            w = _norm(w); assembly { mstore(add(add(o, 32), k), w) }
        }
    }

    function _v(address l, bytes memory call) internal view returns (bytes memory r) {
        (bool ok, bytes memory ret) = l.staticcall(call);
        r = abi.encode(ok, ret);
    }

    function _sameState() internal view {
        bytes[] memory calls = new bytes[](16);
        uint256 n;
        for (uint256 k; k < ids.length; k++) {
            bytes32 id = ids[k];
            calls[0] = abi.encodeWithSignature("get(bytes32)", id);
            calls[1] = abi.encodeWithSignature("earnOf(bytes32)", id);
            calls[2] = abi.encodeWithSignature("feeOf(bytes32)", id);
            calls[3] = abi.encodeWithSignature("capOf(bytes32)", id);
            calls[4] = abi.encodeWithSignature("refundableOf(bytes32)", id);
            calls[5] = abi.encodeWithSignature("ownerEscrow6(bytes32)", id);
            calls[6] = abi.encodeWithSignature("provenUntil(bytes32)", id);
            calls[7] = abi.encodeWithSignature("claimable(bytes32)", id);
            calls[8] = abi.encodeWithSignature("secondsFundable(bytes32)", id);
            calls[9] = abi.encodeWithSignature("bandwidthBackingRequired6(bytes32)", id);
            calls[10] = abi.encodeWithSignature("claimableBy(bytes32,bytes32)", id, A1);
            calls[11] = abi.encodeWithSignature("rateFor(bytes32,bytes32)", id, HB);
            n = 12;
            for (uint256 c; c < n; c++) assertEq(_v(address(a), calls[c]), _v(address(b), calls[c]), "deployment view differs");
        }
        for (uint256 i; i < actors.length; i++) {
            assertEq(_v(address(a), abi.encodeWithSignature("earned6(address)", actors[i])), _v(address(b), abi.encodeWithSignature("earned6(address)", actors[i])), "earned6");
            assertEq(_v(address(a), abi.encodeWithSignature("bondOf(address)", actors[i])), _v(address(b), abi.encodeWithSignature("bondOf(address)", actors[i])), "bond");
            assertEq(ta.balanceOf(actors[i]), tb.balanceOf(actors[i]), "token balance");
        }
        assertEq(ta.balanceOf(address(a)), tb.balanceOf(address(b)), "ledger holdings");
        assertEq(ra.routed(), rb.routed(), "routed fees");
        bytes4[9] memory g = [bytes4(keccak256("count()")), bytes4(keccak256("retired()")), bytes4(keccak256("claimBond6()")),
            bytes4(keccak256("bondExitDelay()")), bytes4(keccak256("leaseSec()")), bytes4(keccak256("runnerBps()")),
            bytes4(keccak256("importsSealed()")), bytes4(keccak256("proofRequired()")), bytes4(keccak256("owner()"))];
        for (uint256 i; i < g.length; i++) assertEq(_v(address(a), abi.encodePacked(g[i])), _v(address(b), abi.encodePacked(g[i])), "global");
    }

    // ---- the operations ------------------------------------------------------------------------------------------
    function _runner(bytes32 id) internal view returns (bytes32 runner, address op, uint64 gen) {
        (runner, op,, gen) = IEnclaveDeploymentsLeases(address(b)).leaseOf(id);
    }

    function _step(uint256 r) internal {
        bytes32 id = ids[(r >> 8) % ids.length];
        uint256 x = r >> 16;
        address[3] memory ops = [opA, opA, opB];
        bytes32[4] memory hosts = [A1, A2, HB, SELF];
        uint256 op = r % 22;
        lastOk = false;
        _dispatch(op, id, x, ops, hosts);
        if (lastOk) okCount[op]++;
    }

    function _dispatch(uint256 op, bytes32 id, uint256 x, address[3] memory ops, bytes32[4] memory hosts) internal {
        if (op == 0) _both(user, abi.encodeWithSignature("fund(bytes32,uint256)", id, 1 + x % 5e6));
        else if (op == 1) _both(sponsor, abi.encodeWithSignature("fundFor(bytes32,uint256,address)", id, 1 + x % 3e6, x % 2 == 0 ? user : sponsor));
        else if (op == 2 || op == 3) { uint256 h = x % 4; _both(h == 2 || h == 3 ? opB : opA, abi.encodeWithSignature("claim(bytes32,bytes32)", id, hosts[h])); }
        else if (op == 4) _both(_caller(id, x, ops), abi.encodeWithSignature("renew(bytes32)", id));
        else if (op == 5) _both(_caller(id, x, ops), abi.encodeWithSignature("release(bytes32)", id));
        else if (op == 6) {                                                              // named release vs legacy
            (bytes32 runner, address rop, uint64 gen) = _runner(id);
            address caller = x % 4 == 0 ? ops[x % 3] : (rop == address(0) ? opA : rop);   // mostly the runner itself
            _both2(caller, abi.encodeWithSignature("release(bytes32)", id),
                abi.encodeWithSignature("releaseLease(bytes32,bytes32,uint64)", id, runner, gen), 0);
        }
        else if (op == 7 || op == 8) vm.warp(block.timestamp + 1 + x % 2400);
        else if (op == 9) _both(sponsor, abi.encodeWithSignature("settle(bytes32)", id));
        else if (op == 10) _both(address(this), abi.encodeWithSignature("creditProven(bytes32,uint64)", id, uint64(block.timestamp - x % 1800)));
        else if (op == 11) _both(x % 3 == 0 ? vault : user, abi.encodeWithSignature("refund(bytes32)", id));
        else if (op == 12) _both(user, abi.encodeWithSignature("setShares(bytes32,uint16,uint16)", id, uint16(x % 3 == 0 ? 0 : x % 400), uint16(1 + (x >> 8) % 1000)));
        else if (op == 13) _both(x % 2 == 0 ? user : vault, abi.encodeWithSignature("setMaxRate(bytes32,uint256)", id, 100 + x % 3000));
        else if (op == 14) _both(user, abi.encodeWithSignature("setActive(bytes32,bool)", id, x % 3 != 0));
        else if (op == 15) _both(user, abi.encodeWithSignature("setDelegate(address,bool)", vault, x % 2 == 0));
        else if (op == 16) _both(vault, abi.encodeWithSignature("setConfig(bytes32,string)", id, "{\"config\":{}}"));
        else if (op == 17) _both(opB, abi.encodeWithSignature("offerJobRate(bytes32,bytes32,uint96,uint64)", id, HB, uint96(x % 900), uint64(block.timestamp + x % 5000)));
        else if (op == 18) _both2(user, abi.encodeWithSignature("fundEth(bytes32)", id), abi.encodeWithSignature("fundEth(bytes32)", id), 1e12 + x % 1e15);
        else if (op == 19) _bandwidth(id, 1 + x % 2e6, (x >> 4) % 3);
        else if (op == 20) _bonds(x);
        else _both(address(this), abi.encodeWithSignature("sweepEscrow(bytes32)", id));
    }

    /// Usually the current runner (the path that can succeed), sometimes a random operator (the refusals).
    function _caller(bytes32 id, uint256 x, address[3] memory ops) internal view returns (address) {
        (, address rop,) = _runner(id);
        return x % 4 == 0 || rop == address(0) ? ops[x % 3] : rop;
    }

    /// The router is each ledger's own; the charge is the same call through it.
    function _bandwidth(bytes32 id, uint256 amount6, uint256 split) internal {
        uint256 provider6 = split == 0 ? 0 : split == 1 ? amount6 / 2 : amount6;
        vm.recordLogs();
        (bool okA, bytes memory retA) = address(ra).call(abi.encodeWithSignature("charge(address,bytes32,uint256,uint256,address)", address(a), id, amount6, provider6, provider));
        Vm.Log[] memory la = vm.getRecordedLogs();
        vm.recordLogs();
        (bool okB, bytes memory retB) = address(rb).call(abi.encodeWithSignature("charge(address,bytes32,uint256,uint256,address)", address(b), id, amount6, provider6, provider));
        Vm.Log[] memory lb = vm.getRecordedLogs();
        assertEq(okA, okB, "bandwidth success differs"); assertEq(retA, retB, "bandwidth data differs");
        lastOk = okA;
        _sameLogs(la, lb); _sameState();
    }

    function _bonds(uint256 x) internal {
        uint256 k = x % 5;
        address op = x % 2 == 0 ? opA : opB;
        if (k == 0) _both(address(this), abi.encodeWithSignature("setClaimBond(uint256,uint64)", (x >> 3) % 2 == 0 ? 0 : 5e6, uint64(1 hours)));
        else if (k == 1) _both(op, abi.encodeWithSignature("postBond(uint256)", 1 + (x >> 3) % 10e6));
        else if (k == 2) _both(op, abi.encodeWithSignature("requestBondExit()"));
        else if (k == 3) _both(op, abi.encodeWithSignature("withdrawBond(address)", op));
        else _both(address(this), abi.encodeWithSignature("slashBond(address,uint256,string)", op, 1 + (x >> 3) % 2e6, "evidence"));
    }

    // ---- fixed scenarios -------------------------------------------------------------------------------------------
    function test_claimRenewNamedReleaseRefund_matchRev16d() public {
        bytes32 id = ids[0];
        _both(user, abi.encodeWithSignature("fund(bytes32,uint256)", id, 50e6));
        _both(sponsor, abi.encodeWithSignature("fundFor(bytes32,uint256,address)", id, 7e6, sponsor));
        _both(opA, abi.encodeWithSignature("claim(bytes32,bytes32)", id, A1));
        vm.warp(T0 + 900);
        _both(opA, abi.encodeWithSignature("renew(bytes32)", id));
        _both(address(this), abi.encodeWithSignature("creditProven(bytes32,uint64)", id, uint64(T0 + 800)));
        vm.warp(T0 + 1000);
        (bytes32 runner,, uint64 gen) = _runner(id);
        _both2(opA, abi.encodeWithSignature("release(bytes32)", id), abi.encodeWithSignature("releaseLease(bytes32,bytes32,uint64)", id, runner, gen), 0);
        _both(user, abi.encodeWithSignature("refund(bytes32)", id));
        _both(opA, abi.encodeWithSignature("withdrawEarnings(address)", opA));
    }

    function test_sameOperatorMove_legacyReleaseIdenticalToRev16d() public {
        bytes32 id = ids[0];
        _both(user, abi.encodeWithSignature("fund(bytes32,uint256)", id, 20e6));
        _both(opA, abi.encodeWithSignature("claim(bytes32,bytes32)", id, A1));
        vm.warp(T0 + 1801);
        _both(opA, abi.encodeWithSignature("claim(bytes32,bytes32)", id, A2));              // the move target, same key
        _both(opA, abi.encodeWithSignature("release(bytes32)", id));                       // rev 16d's blind release, kept
    }

    function test_delegatesRetireAndPermissionlessRefund_matchRev16d() public {
        bytes32 id = ids[1];
        _both(user, abi.encodeWithSignature("fund(bytes32,uint256)", id, 30e6));
        _both(vault, abi.encodeWithSignature("setConfig(bytes32,string)", id, "x"));        // refused: no grant yet
        _both(user, abi.encodeWithSignature("setDelegate(address,bool)", vault, true));
        _both(vault, abi.encodeWithSignature("setConfig(bytes32,string)", id, "x"));
        _both(vault, abi.encodeWithSignature("transferDeployment(bytes32,address)", id, vault));   // never the delegate's
        _both(vault, abi.encodeWithSignature("refund(bytes32)", id));                          // pays the OWNER
        _both(user, abi.encodeWithSignature("setDelegate(address,bool)", vault, false));
        _both(user, abi.encodeWithSignature("fund(bytes32,uint256)", ids[0], 9e6));
        _both(address(this), abi.encodeWithSignature("retire()"));
        _both(sponsor, abi.encodeWithSignature("refund(bytes32)", ids[0]));                    // anyone, after retire
        _both(user, abi.encodeWithSignature("fund(bytes32,uint256)", ids[0], 1e6));             // refused: retired
    }

    function test_selfHostingAndJobRates_matchRev16d() public {
        bytes32 id = ids[0];
        _both(user, abi.encodeWithSignature("fund(bytes32,uint256)", id, 5e6));
        _both(opB, abi.encodeWithSignature("claim(bytes32,bytes32)", id, SELF));               // free host component
        vm.warp(T0 + 100);
        _both(opB, abi.encodeWithSignature("release(bytes32)", id));
        _both(opB, abi.encodeWithSignature("offerJobRate(bytes32,bytes32,uint96,uint64)", id, HB, uint96(300), uint64(T0 + 5000)));
        _both(opB, abi.encodeWithSignature("claim(bytes32,bytes32)", id, HB));
    }

    function test_importMigrationPath_matchesRev16d() public {
        L17.Deployment[] memory items = new L17.Deployment[](2);
        for (uint256 i; i < 2; i++) {
            items[i].id = keccak256(abi.encode("imported", i)); items[i].owner = user; items[i].appRef = "catalog://app/9";
            items[i].cpuMilli = 500; items[i].appPort = 80; items[i].active = true; items[i].rate = i == 0 ? 0 : 600;
            items[i].balance6 = 3e6; items[i].spent6 = 1e6; items[i].runner = HB; items[i].runnerOperator = opB; items[i].leaseUntil = uint64(T0 + 99);
        }
        _both(address(this), abi.encodeWithSelector(L17.importDeployments.selector, items));
        bytes32[] memory iids = new bytes32[](1); iids[0] = items[1].id;
        address[] memory to = new address[](1); to[0] = publisher;
        uint256[] memory v = new uint256[](1); v[0] = 100;
        _both(address(this), abi.encodeWithSignature("importFees(bytes32[],address[],uint256[])", iids, to, v));
        _both(address(this), abi.encodeWithSignature("importEarn(bytes32[],uint256[])", iids, v));
        v[0] = 700;
        _both(address(this), abi.encodeWithSignature("importCaps(bytes32[],uint256[])", iids, v));
        ids.push(items[0].id); ids.push(items[1].id);
        _both(address(this), abi.encodeWithSignature("fundEscrow(bytes32,uint256)", items[1].id, 1e6));
        _both(address(this), abi.encodeWithSignature("sealImports()"));
        _both(address(this), abi.encodeWithSelector(L17.importDeployments.selector, items));  // sealed
        _both(opA, abi.encodeWithSignature("claim(bytes32,bytes32)", items[1].id, A1));
        _both(opA, abi.encodeWithSignature("claim(bytes32,bytes32)", items[0].id, A2));
    }

    function test_bondsAndMulticall_matchRev16d() public {
        _both(address(this), abi.encodeWithSignature("setClaimBond(uint256,uint64)", 5e6, uint64(1 hours)));
        _both(opA, abi.encodeWithSignature("claim(bytes32,bytes32)", ids[0], A1));             // refused: no bond
        _both(opA, abi.encodeWithSignature("postBond(uint256)", 6e6));
        _both(user, abi.encodeWithSignature("fund(bytes32,uint256)", ids[0], 5e6));
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeWithSignature("setAppRef(bytes32,string)", ids[0], "catalog://app/0b");
        calls[1] = abi.encodeWithSignature("setConfig(bytes32,string)", ids[0], "{}");
        _both(user, abi.encodeWithSignature("multicall(bytes[])", calls));
        _both(opA, abi.encodeWithSignature("claim(bytes32,bytes32)", ids[0], A1));
        _both(opA, abi.encodeWithSignature("requestBondExit()"));
        vm.warp(T0 + 3601);
        _both(address(this), abi.encodeWithSignature("slashBond(address,uint256,string)", opA, 1e6, "r"));
        _both(opA, abi.encodeWithSignature("withdrawBond(address)", opA));
    }

    /// The random sequences are not vacuous: over fixed seeds every lease and money path really executes on both.
    function test_randomSequencesExerciseEveryPath() public {
        for (uint256 s = 0; s < 12; s++) for (uint256 i; i < 40; i++) _step(uint256(keccak256(abi.encode(s, i))));
        uint256[17] memory must = [uint256(0), 1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 15, 16, 17, 18, 19];
        for (uint256 k; k < must.length; k++) {
            emit log_named_uint(string(abi.encodePacked("successful op ", vm.toString(must[k]))), okCount[must[k]]);
            assertGt(okCount[must[k]], 0, "an operation never succeeded");
        }
        emit log_named_uint("successful claims (op 3)", okCount[3]);
        emit log_named_uint("successful delegate setConfig (op 16)", okCount[16]);
        emit log_named_uint("successful bond ops (op 20)", okCount[20]);
    }

    /// Gas of the lease path, rev 16d vs candidate, from identical state (logged; the candidate pays for one more
    /// SSTORE + LOG in claim and for the fallback/library hop in release).
    function test_gasDeltas() public {
        bytes32 id = ids[0];
        _both(user, abi.encodeWithSignature("fund(bytes32,uint256)", id, 50e6));
        uint256[2][4] memory g;
        bytes[4] memory da = [abi.encodeWithSignature("claim(bytes32,bytes32)", id, A1), abi.encodeWithSignature("renew(bytes32)", id),
            abi.encodeWithSignature("release(bytes32)", id), abi.encodeWithSignature("claim(bytes32,bytes32)", id, A1)];
        for (uint256 k; k < 4; k++) {
            if (k == 1) vm.warp(T0 + 600);
            uint256 x = gasleft(); vm.prank(opA); (bool ok,) = address(a).call(da[k]); g[k][0] = x - gasleft(); assertTrue(ok);
            bytes memory db = k == 2 ? abi.encodeWithSignature("releaseLease(bytes32,bytes32,uint64)", id, A1, uint64(1)) : da[k];
            x = gasleft(); vm.prank(opA); (ok,) = address(b).call(db); g[k][1] = x - gasleft(); assertTrue(ok);
        }
        string[4] memory names = ["claim (first, cold)", "renew", "release vs releaseLease", "claim (re-claim)"];
        for (uint256 k; k < 4; k++) {
            emit log_named_uint(string.concat(names[k], " rev16d"), g[k][0]);
            emit log_named_uint(string.concat(names[k], " candidate"), g[k][1]);
        }
        vm.prank(opA); (bool ok2,) = address(a).call(abi.encodeWithSignature("release(bytes32)", id));
        uint256 y = gasleft(); vm.prank(opA); (bool ok3,) = address(b).call(abi.encodeWithSignature("release(bytes32)", id));
        emit log_named_uint("legacy release(id) candidate", y - gasleft());
        assertTrue(ok2 && ok3);
    }

    /// Random interleavings of every lease, money, owner, delegate, bandwidth and bond operation.
    function testFuzz_randomSequencesMatchRev16d(uint256 seed) public {
        for (uint256 i; i < 40; i++) _step(uint256(keccak256(abi.encode(seed, i))));
    }
}
