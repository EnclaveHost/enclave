// Chromium on the independent rig (test/helpers/independent-browser-rig.mjs): the unbundled dashboard under a confirmed
// profile whose three RPC origins are the rig's local proxies, with every non-loopback origin refused. The WALLET's own
// RPC is the rig's anvil port (walletScript proxies every wallet request there), so what reaches it is exactly what the
// page asked the wallet: only signing and broadcast may. Covers the wallet popover's route disclosure, a balance and a real
// transaction with its receipt through the profile, one origin down, all origins down, and a profile changed in a
// second tab. Generated anvil keys only; no real wallet, no public network.
//   run: node --test test/site-browser-rpc-routes.test.mjs     (anvil, openssl, Playwright's Chromium, the Foundry build)
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startRig, haveTools, walletScript } from "./helpers/independent-browser-rig.mjs";
const require = createRequire(new URL("../e2e/package.json", import.meta.url));
let chromium; try { ({ chromium } = require("playwright")); } catch {}
const skip = haveTools() || (!chromium && "needs Playwright (cd e2e && npm ci) and its Chromium");
const SIGN_OR_SEND = new Set(["eth_sendTransaction", "eth_signTransaction", "eth_signTypedData_v4", "personal_sign", "eth_getTransactionByHash"]);

test("browser chain consumers stay on the profile's routes; the wallet only signs and broadcasts", { skip, timeout: 300000 }, async () => {
  let rig, browser;
  const forbidden = [], walletRpc = [];
  try {
    rig = await startRig();
    browser = await chromium.launch({ args: ["--disable-gpu", "--disable-dev-shm-usage", "--renderer-process-limit=1", "--disable-extensions",
      "--disable-features=site-per-process,IsolateOrigins,Translate,OptimizationHints,MediaRouter,AudioServiceOutOfProcess",
      "--enable-features=NetworkServiceInProcess,NetworkServiceInProcess2", "--js-flags=--max-old-space-size=192"] });
    const context = await browser.newContext({ ignoreHTTPSErrors: true, reducedMotion: "reduce" });
    // the public network refuses: any origin that is not this machine
    await context.route("**/*", (route) => {
      const u = new URL(route.request().url());
      if (!["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)){ forbidden.push(u.href); return route.abort("blockedbyclient"); }
      return route.continue();
    });
    context.on("request", (r) => {
      if (!r.url().startsWith(rig.rpc)) return;
      try { const b = JSON.parse(r.postData() || "null"); for (const c of [].concat(b)) if (c && c.method) walletRpc.push(c.method); } catch {}
    });
    await context.addInitScript(({ profile, address }) => {
      const text = JSON.stringify(profile);
      if (!sessionStorage.getItem("enclave_independent_ack")){ localStorage.setItem("enclave_independent_profile", text); sessionStorage.setItem("enclave_independent_ack", text); }
      localStorage.setItem("enclave_session", JSON.stringify({ address, rdns: "test.local.wallet" }));
    }, { profile: rig.profile, address: rig.owner });
    await context.addInitScript({ content: walletScript({ rpc: rig.rpc, address: rig.owner }) });
    const page = await context.newPage();
    await page.goto(rig.site + "/dashboard");
    await page.waitForFunction(async () => !!(await import("/js/core/api.js")).Enclave.address, null, { timeout: 30000 });
    const usdc6 = await rig.pc.readContract({ address: rig.addresses.usdc, abi: rig.abi.usdc, functionName: "balanceOf", args: [rig.owner] });

    // the popover: the balance through the profile, and a reviewable statement of who broadcasts
    await page.click("#walletBtn");
    await page.waitForSelector("#walletPop:not([hidden]) #wpRpc");
    await page.waitForFunction(() => !/…/.test(document.querySelector("#wpBalUsdc")?.textContent || "…"), null, { timeout: 20000 });
    assert.equal(await page.textContent("#wpBalUsdc"), (Number(usdc6) / 1e6).toFixed(2) + " USDC");
    await page.click("#wpRpc");
    const box = await page.textContent("#wpRpcBox");
    assert.match(box, /broadcast by your wallet/);
    for (const u of rig.profile.rpcs) assert.ok(box.includes(u), "the popover names " + u);
    assert.match(box, /Wallets accept only HTTPS RPCs/, "the rig's loopback routes are plain HTTP: nothing is offered to the wallet");
    assert.equal(await page.$("#wpRpcOffer"), null);
    assert.deepEqual(walletRpc, [], "the wallet's RPC answered no read for the popover");

    // one origin down: the balance and an agreed read fail over; a real transaction is broadcast by the wallet and its
    // receipt is read through the profile
    rig.rpcModes[0] = "down";
    const one = await page.evaluate(async ({ owner, usdc }) => {
      const W = await import("/js/core/wallet.js"), C = await import("/js/core/chain.js"), IC = await import("/js/core/independent-chain.js");
      const bal = await W.usdcBalanceOf(owner);
      const snap = await IC.reader().snapshot();
      const hash = await W.sendTx(usdc, "0x095ea7b3" + owner.slice(2).toLowerCase().padStart(64, "0") + "0".repeat(64), "0x0");
      const rec = await C.waitReceipt(hash);
      return { bal, agreed: snap.rpcs.length, status: rec.status };
    }, { owner: rig.owner, usdc: rig.addresses.usdc });
    assert.equal(one.bal, Number(usdc6) / 1e6);
    assert.equal(one.agreed, 2);
    assert.equal(one.status, "0x1");
    assert.deepEqual(walletRpc, ["eth_sendTransaction"], "the wallet was asked to broadcast, and for nothing else");

    // the owner chooses the profile's endpoints to broadcast (the popover, an explicit click): the wallet only signs (anvil
    // signs for its dev account: a signing-only wallet), the signed bytes go to the profile's origins, the receipt comes
    // through them; then back to the wallet's own broadcast
    rig.rpcModes[0] = "ok";
    const openRoutes = async () => {
      if (await page.isVisible("#wpRouteProfile")) return;
      if (!(await page.isVisible("#wpRpc"))) await page.click("#walletBtn");
      await page.waitForSelector("#walletPop:not([hidden]) #wpRpc"); await page.click("#wpRpc");
    };
    await openRoutes();
    assert.equal(await page.textContent("#wpRoute"), "your wallet’s own RPC");
    await page.click("#wpRouteProfile");
    assert.equal(await page.textContent("#wpRoute"), "the network profile (your wallet signs only)");
    assert.match(await page.textContent("#wpRpcSt"), /asked only to sign/);
    const viaProfile = await page.evaluate(async ({ owner, usdc }) => {
      const W = await import("/js/core/wallet.js"), C = await import("/js/core/chain.js");
      const hash = await W.sendTx(usdc, "0x095ea7b3" + owner.slice(2).toLowerCase().padStart(64, "0") + "0".repeat(63) + "1", "0x0");
      const rec = await C.waitReceipt(hash);
      return { status: rec.status, from: rec.from.toLowerCase() };
    }, { owner: rig.owner, usdc: rig.addresses.usdc });
    assert.deepEqual(viaProfile, { status: "0x1", from: rig.owner.toLowerCase() });
    assert.deepEqual(walletRpc, ["eth_sendTransaction", "eth_signTransaction"], "the wallet signed only: its RPC broadcast nothing");
    await openRoutes();
    await page.click("#wpRouteWallet");
    assert.equal(await page.textContent("#wpRoute"), "your wallet’s own RPC");

    // every origin down: refused by name, nothing broadcast, no fallback to the wallet's RPC
    rig.rpcModes[0] = rig.rpcModes[1] = rig.rpcModes[2] = "down";
    const all = await page.evaluate(async ({ owner, usdc }) => {
      const W = await import("/js/core/wallet.js");
      const err = (p) => p.then(() => "answered", (e) => String(e.message || e));
      return { bal: await err(W.usdcBalanceOf(owner)), send: await err(W.sendTx(usdc, "0x095ea7b3" + "0".repeat(128), "0x0")) };
    }, { owner: rig.owner, usdc: rig.addresses.usdc });
    assert.notEqual(all.bal, "answered");
    assert.match(all.send, /none of the network profile's RPC endpoints could check this transaction - nothing was sent/);
    assert.deepEqual(walletRpc, ["eth_sendTransaction", "eth_signTransaction"], "nothing more reached the wallet");
    rig.rpcModes[0] = rig.rpcModes[1] = rig.rpcModes[2] = "ok";

    // the profile is replaced in a second tab: this tab stops reading and sending until it reloads
    const other = await context.newPage();
    await other.goto(rig.site + "/dashboard");
    await other.evaluate((profile) => localStorage.setItem("enclave_independent_profile", JSON.stringify({ ...profile, name: "replaced in another tab" })), rig.profile);
    const stale = await page.evaluate(async ({ owner, usdc }) => {
      const W = await import("/js/core/wallet.js"), C = await import("/js/core/chain.js");
      const err = (p) => p.then(() => "answered", (e) => String(e.message || e));
      return { read: await err(C.baseRpc("eth_blockNumber", [])), send: await err(W.sendTx(usdc, "0x095ea7b3" + "0".repeat(128), "0x0")) };
    }, { owner: rig.owner, usdc: rig.addresses.usdc });
    assert.match(stale.read, /network profile changed in another tab/);
    assert.match(stale.send, /network profile changed in another tab/);
    assert.deepEqual(walletRpc, ["eth_sendTransaction", "eth_signTransaction"]);

    for (const m of walletRpc) assert.ok(SIGN_OR_SEND.has(m), "the wallet's RPC was asked " + m);
    assert.deepEqual(forbidden, [], "no public origin was attempted");
  } finally { await browser?.close(); await rig?.stop(); }
});
