// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Test, console2 } from "forge-std/Test.sol";
import { SessionVault, SessionVaultFactory, CreateArgs, ISVToken, ISVBook, ISVRouter, ISVKeyAttestations }
    from "../../SessionVault.sol";
import { EnclaveDeployments } from "../../EnclaveDeployments.sol";
import { EnclaveAppCatalog } from "../../EnclaveAppCatalog.sol";
import { EnclaveAddressBook } from "../../EnclaveAddressBook.sol";
import { PaymentRouter } from "../../PaymentRouter.sol";
import { MockUSDC3009, SessionRegistryStub } from "./mocks/SessionMocks.sol";

/// Drives ONE owner's vault through random interleavings of everything that
/// moves money or session state - opens (free balance and wallet deposit),
/// spends (orders, fees, deployment create+fund), ledger refunds landing back,
/// top-ups both ways, every way a session ends, revokeAll, withdrawals, USDC
/// gifted to the vault, and time - against the REAL ledger, catalog and router.
contract SessionVaultHandler is Test {
    bytes32 constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
    uint256 constant OWNER_PK = 0x0A11CE;
    uint256 constant SK = 0x5E55;

    SessionVault public vault;
    MockUSDC3009 public usdc;
    EnclaveDeployments public ledger;
    PaymentRouter public router;
    address public owner;
    string public appRef;
    uint256 public kx; uint256 public ky;

    bytes32[] public sids;
    bytes32[] public deps;
    mapping(bytes32 => uint256) public credited;   // ghost: everything ever put into a session
    uint256 public nowTs;
    uint256 public okPay; uint256 public okCreate; uint256 public okRefund; uint256 public okTop; uint256 public okEnd;
    uint256 nonceCounter;

    constructor(SessionVault v, MockUSDC3009 u, EnclaveDeployments l, PaymentRouter r, string memory ref) {
        vault = v; usdc = u; ledger = l; router = r; appRef = ref;
        owner = vm.addr(OWNER_PK);
        (kx, ky) = vm.publicKeyP256(SK);
        nowTs = vm.getBlockTimestamp();
    }

    function sidCount() external view returns (uint256) { return sids.length; }

    function _domain() internal view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Enclave Sessions"), keccak256("1"), block.chainid,
            address(vault)));
    }

    function _grant(uint256 budget) internal returns (SessionVault.Grant memory g) {
        string[] memory acts = new string[](4);
        acts[0] = "deploy.create"; acts[1] = "deploy.fund"; acts[2] = "deploy.refund"; acts[3] = "order.pay";
        string[] memory apps = new string[](1); apps[0] = "*";
        string[] memory envs = new string[](1); envs[0] = "staging";
        g.label = "inv"; g.preset = "inv";
        g.sessionKey = keccak256(abi.encode(kx, ky));
        g.actions = acts; g.apps = apps; g.environments = envs;
        g.budget = budget; g.spendPerPeriod = 40e6; g.periodSeconds = 1 days; g.opsPerPeriod = 0;
        g.maxFeePerOp = 100_000; g.maxAppFeePerHour = 0;
        g.expiresAt = uint64(nowTs + 3 days);
        g.grantNonce = bytes32(++nonceCounter);
        g.signBefore = uint64(nowTs + 1 hours);
    }

    function _sigFor(SessionVault.Grant memory g) internal view returns (bytes32 gd, bytes memory sig) {
        gd = vault.grantDigest(g);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, gd);
        sig = abi.encodePacked(r, s, v);
    }

    function _pick(uint256 i) internal view returns (bytes32) { return sids[i % sids.length]; }

    /// a live session (scanning from i) and what it can still spend this period
    function _spendable(uint256 i) internal view returns (bytes32 sid, uint256 room) {
        for (uint256 k = 0; k < sids.length; k++) {
            sid = sids[(i + k) % sids.length];
            (SessionVault.Session memory s, bool live, ) = vault.sessionOf(sid);
            if (!live || s.balance6 == 0) continue;
            uint256 left = s.perPeriod6 > s.periodSpent6 ? s.perPeriod6 - s.periodSpent6 : 0;
            if (nowTs >= uint256(s.periodStart) + s.period) left = s.perPeriod6;
            room = s.balance6 < left ? s.balance6 : left;
            if (room > 0) return (sid, room);
        }
        return (bytes32(0), 0);
    }

    function _exec(bytes32 sid, uint8 action, bytes memory args, uint256 fee) internal returns (bool ok, bytes memory ret) {
        uint256 nonce = vault.seqOf(sid, 0);
        uint64 deadline = uint64(nowTs + 120);
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", _domain(), keccak256(abi.encode(
            keccak256("SessionCall(bytes32 sessionId,uint256 nonce,uint8 action,bytes32 argsHash,uint256 fee,uint64 deadline)"),
            sid, nonce, action, keccak256(args), fee, deadline))));
        (bytes32 r, bytes32 s) = vm.signP256(SK, sha256(abi.encodePacked(d)));
        try vault.execute(sid, nonce, action, args, fee, deadline, kx, ky, r, s) returns (bytes memory out) {
            return (true, out);
        } catch { return (false, ""); }
    }

    // ---- actions ------------------------------------------------------------------

    function openDeposit(uint256 amt) external {
        amt = bound(amt, 1, 100e6);
        if (usdc.balanceOf(address(vault)) + amt > vault.maxVault6()) return;
        SessionVault.Grant memory g = _grant(amt);
        (bytes32 gd, bytes memory sig) = _sigFor(g);
        bytes32 rd = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(),
            keccak256(abi.encode(RECEIVE_TYPEHASH, owner, address(vault), amt, uint256(0), nowTs + 1 hours, gd))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, rd);
        bytes32 sid = vault.openWithDeposit(g, sig, 0, nowTs + 1 hours, abi.encodePacked(r, s, v));
        sids.push(sid);
        credited[sid] += amt;
    }

    function openFromFree(uint256 amt) external {
        uint256 f = vault.free();
        amt = f == 0 ? 0 : bound(amt, 0, f);
        SessionVault.Grant memory g = _grant(amt);
        (, bytes memory sig) = _sigFor(g);
        bytes32 sid = vault.open(g, sig);
        sids.push(sid);
        credited[sid] += amt;
    }

    function pay(uint256 i, uint256 amt, uint256 fee) external {
        if (sids.length == 0) return;
        (bytes32 sid, uint256 room) = _spendable(i);
        if (room == 0) return;
        fee = bound(fee, 0, room / 4 < 100_000 ? room / 4 : 100_000);
        // mostly within budget; 1 in 8 deliberately over, to keep the refusals exercised
        amt = amt % 8 == 0 ? room - fee + 1 : bound(amt, 1, room - fee == 0 ? 1 : room - fee);
        (bool ok, ) = _exec(sid, 9, abi.encode(amt, bytes32("o")), fee);
        if (ok) okPay++;
    }

    function createFund(uint256 i, uint256 amt) external {
        if (sids.length == 0) return;
        (bytes32 sid, uint256 room) = _spendable(i);
        if (sid == bytes32(0)) sid = _pick(i);
        bytes memory args = abi.encode(CreateArgs({ appRef: appRef, gpuMilli: 0, cpuMilli: 1000, appPort: 8080,
            ports: "", isPublic: false, configCid: "", maxRate6: 1e6, env: 1, fund6: bound(amt, 0, room) }));
        (bool ok, bytes memory ret) = _exec(sid, 0, args, 0);
        if (ok) { deps.push(abi.decode(ret, (bytes32))); okCreate++; }
    }

    function refundDeployment(uint256 i, uint256 j) external {
        if (sids.length == 0 || deps.length == 0) return;
        (bytes32 sid, ) = _spendable(i);
        if (sid == bytes32(0)) sid = _pick(i);
        (bool ok, ) = _exec(sid, 7, abi.encode(deps[j % deps.length]), 0);
        if (ok) okRefund++;
    }

    function topUpFree(uint256 i, uint256 amt) external {
        if (sids.length == 0) return;
        uint256 f = vault.free();
        if (f == 0) return;
        amt = bound(amt, 1, f);
        bytes32 sid = _pick(i);
        vm.prank(owner);
        try vault.topUp(sid, amt, bytes32(0), 0, "") { credited[sid] += amt; okTop++; } catch {}
    }

    function topUpWallet(uint256 i, uint256 amt) external {
        if (sids.length == 0) return;
        amt = bound(amt, 1, 50e6);
        if (usdc.balanceOf(address(vault)) + amt > vault.maxVault6()) return;
        bytes32 sid = _pick(i);
        bytes32 opNonce = bytes32(++nonceCounter);
        uint64 vb = uint64(nowTs + 1 hours);
        bytes32 td = keccak256(abi.encodePacked("\x19\x01", _domain(), keccak256(abi.encode(vault.TOPUP_TYPEHASH(),
            sid, amt, opNonce, vb))));
        bytes32 rd = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(),
            keccak256(abi.encode(RECEIVE_TYPEHASH, owner, address(vault), amt, uint256(0), uint256(vb), td))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, rd);
        try vault.topUpWithAuthorization(sid, amt, opNonce, 0, vb, abi.encodePacked(r, s, v)) {
            credited[sid] += amt;
        } catch {}
    }

    function terminate(uint256 i) external {
        if (sids.length == 0 || i % 4 != 0) return;      // rarer than spending, or nothing lives long
        vm.prank(owner);
        try vault.terminate(_pick(i), bytes32(0), 0, "") { okEnd++; } catch {}
    }

    function close(uint256 i) external {
        if (sids.length == 0) return;
        try vault.close(_pick(i)) { okEnd++; } catch {}
    }

    function revokeAll(uint256 seed) external {
        if (seed % 8 != 0) return;
        bool w = seed % 16 == 0;
        vm.prank(owner);
        vault.revokeAll(w, bytes32(0), 0, "");
    }

    function withdraw(uint256 amt) external {
        uint256 f = vault.free();
        if (f == 0) return;
        vm.prank(owner);
        vault.withdraw(bound(amt, 1, f), bytes32(0), 0, "");
    }

    function gift(uint256 amt) external {
        usdc.mint(address(vault), bound(amt, 1, 5e6));
    }

    function warp(uint256 dt) external {
        nowTs += bound(dt, 1, 6 hours);
        vm.warp(nowTs);
    }
}

/// forge-config: default.invariant.depth = 256
/// forge-config: default.invariant.runs = 128
contract SessionVaultInvariantTest is Test {
    SessionVaultHandler h;
    SessionVault vault;
    MockUSDC3009 usdc;
    EnclaveDeployments ledger;
    PaymentRouter router;
    address owner;

    function setUp() public {
        vm.warp(1_800_000_000);
        address p256 = 0x0000000000000000000000000000000000000100;
        (bytes32 r, bytes32 s) = vm.signP256(0xA1CE, keccak256("p"));
        (uint256 x, uint256 y) = vm.publicKeyP256(0xA1CE);
        (bool ok, bytes memory ret) = p256.staticcall(abi.encodePacked(keccak256("p"), r, s, x, y));
        if (!(ok && ret.length == 32 && ret[31] == 0x01))
            vm.etch(p256, vm.parseBytes(vm.readFile("contracts/foundry/test/fixtures/p256-verifier.hex")));

        usdc = new MockUSDC3009();
        EnclaveAddressBook book = new EnclaveAddressBook();
        ledger = new EnclaveDeployments(address(usdc), makeAddr("payout"), address(new SessionRegistryStub()), address(0));
        ledger.setProofRequiredFrom(0);
        EnclaveAppCatalog catalog = new EnclaveAppCatalog();
        router = new PaymentRouter(address(usdc), makeAddr("treasury"));
        book.set("deployments", address(ledger));
        book.set("appCatalog", address(catalog));
        SessionVaultFactory factory = new SessionVaultFactory(ISVToken(address(usdc)), ISVBook(address(book)),
            ISVRouter(address(router)), ISVKeyAttestations(address(0)), 1_000e6);
        uint32[4] memory res = [uint32(0), 0, 256, 10];
        vm.prank(makeAddr("publisher"));
        (bytes32 appId, ) = catalog.publishVersion("app", "App", "", "1", "bafyapp", res, "", "", 0);
        owner = vm.addr(0x0A11CE);
        vault = SessionVault(factory.createVault(owner));
        usdc.mint(owner, 1_000_000e6);
        string memory ref = string.concat("catalog://", vm.toString(appId), "/0");
        h = new SessionVaultHandler(vault, usdc, ledger, router, ref);
        targetContract(address(h));
    }

    uint256 tPay; uint256 tCreate; uint256 tRefund; uint256 tTop; uint256 tEnd;
    function afterInvariant() public {
        console2.log("ok pay/create/refund/topUp/end", h.okPay(), h.okCreate());
        console2.log("  ", h.okRefund(), h.okTop(), h.okEnd());
    }

    function test_handlerSmoke() public {
        h.openDeposit(30e6);
        h.pay(0, 5e6 + 1, 1000);
        h.createFund(0, 3e6);
        h.refundDeployment(0, 0);
        h.gift(2e6);
        h.topUpFree(0, 1e6);
        assertEq(h.okPay(), 1, "pay");
        assertEq(h.okCreate(), 1, "create");
        assertEq(h.okRefund(), 1, "refund");
        assertEq(h.okTop(), 1, "topup");
    }

    /// Σ effective session balances == locked6, and the vault always holds it.
    function invariant_solventAndAccounted() public view {
        uint256 sum;
        uint256 n = h.sidCount();
        for (uint256 i = 0; i < n; i++) {
            (SessionVault.Session memory s, bool live, ) = vault.sessionOf(h.sids(i));
            live;
            if (s.state == 1) sum += s.balance6;   // balance6 here is already the effective (epoch-aware) one
        }
        assertEq(sum, vault.locked6(), "sum of session balances == locked6");
        assertGe(usdc.balanceOf(address(vault)), vault.locked6(), "solvent");
        assertEq(vault.free(), usdc.balanceOf(address(vault)) - vault.locked6());
    }

    /// No allowance ever outlives the call that granted it.
    function invariant_noStandingAllowance() public view {
        assertEq(usdc.allowance(address(vault), address(ledger)), 0);
        assertEq(usdc.allowance(address(vault), address(router)), 0);
    }

    /// A session never spends more than was ever put into it.
    function invariant_spendBoundedByCredit() public view {
        uint256 n = h.sidCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 sid = h.sids(i);
            (SessionVault.Session memory s, , ) = vault.sessionOf(sid);
            assertLe(uint256(s.spent6), h.credited(sid));
        }
    }

    /// Liveness: whatever state the run reached, the owner can kill every
    /// session and take every unit out in one direct call.
    function invariant_ownerCanAlwaysRecoverEverything() public {
        uint256 snap = vm.snapshotState();
        uint256 before = usdc.balanceOf(owner);
        uint256 held = usdc.balanceOf(address(vault));
        vm.prank(owner);
        vault.revokeAll(true, bytes32(0), 0, "");
        assertEq(usdc.balanceOf(address(vault)), 0);
        assertEq(usdc.balanceOf(owner), before + held);
        vm.revertToState(snap);
    }
}
