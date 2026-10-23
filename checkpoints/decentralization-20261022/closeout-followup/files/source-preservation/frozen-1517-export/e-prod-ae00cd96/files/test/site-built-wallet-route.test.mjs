// The PRODUCTION site bundle (scripts/build-site.mjs output, BUILT_SITE_DIR) in Chromium on the independent rig
// (test/helpers/independent-browser-rig.mjs, served from that dist/ instead of site/): the wallet popover's Broadcast
// choice in the built dashboard, then the built chunks' own sendTx and waitReceipt (located in dist/js by their unique
// refusal strings and imported at the same URLs the page loaded them from, so they share its state).
//   - profile route: the wallet only signs (anvil signs for its unlocked dev account), the profile's origins broadcast,
//     the receipt comes through them; the wallet's RPC is asked nothing else;
//   - profile route, an origin that answers the bytes' own hash but forwards nothing (the transaction exists nowhere):
//     REAL clock, the default 45 polls (~90 s, past the 40-s drop check) - the wallet is never asked whether it dropped
//     bytes it never had, the wait ends with the ordinary timeout, and nothing is resent;
//   - back to the wallet route: the wallet broadcasts (eth_sendTransaction) as before.
// Anvil (chain id 8453) is a TEST chain: acceptance here says nothing about Base mainnet inclusion. Anvil dev keys only;
// every non-loopback origin is refused and recorded.
//   run: BUILT_SITE_DIR=<tree>/site/dist node --test test/site-built-wallet-route.test.mjs   (anvil, openssl, Playwright's Chromium, the Foundry build)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { startRig, haveTools, walletScript } from "./helpers/independent-browser-rig.mjs";
const require = createRequire(new URL("../e2e/package.json", import.meta.url));
let chromium; try { ({ chromium } = require("playwright")); } catch {}
const DIST = process.env.BUILT_SITE_DIR ? path.resolve(process.env.BUILT_SITE_DIR) : null;
const skip = haveTools() || (!chromium && "needs Playwright (cd e2e && npm ci) and its Chromium") || (!DIST && "needs BUILT_SITE_DIR (a scripts/build-site.mjs output)");
const SEND_MSG = "none of the network profile's RPC endpoints could check this transaction", WAIT_MSG = "never relayed it";

/** dist-relative URLs of the built chunks that carry `needle` */
function chunksWith(needle){
  const out = [];
  for (const f of fs.readdirSync(path.join(DIST, "js"), { recursive: true }))
    if (String(f).endsWith(".js") && fs.readFileSync(path.join(DIST, "js", f), "utf8").includes(needle)) out.push("/js/" + String(f).replace(/\\/g, "/"));
  return out;
}

test("built dashboard: the Broadcast choice, the profile route with its receipt, a lost profile-sent transaction past the drop check, and the wallet route", { skip, timeout: 420000 }, async () => {
  let rig, browser;
  const forbidden = [], walletRpc = [], originRpc = [];
  try {
    assert.ok(fs.existsSync(path.join(DIST, "dashboard.html")), "a built dist/");
    assert.equal(fs.existsSync(path.join(DIST, "js", "core")), false, "bundled, not the unbundled source tree");
    const sendFiles = chunksWith(SEND_MSG), waitFiles = chunksWith(WAIT_MSG), routeFiles = chunksWith("eth_signTransaction");
    assert.ok(sendFiles.length >= 1 && waitFiles.length >= 1 && routeFiles.length >= 1, "the built chunks carry sendTx, waitReceipt and the profile route");
    rig = await startRig({ siteDir: DIST });
    browser = await chromium.launch({ args: ["--disable-gpu", "--disable-dev-shm-usage", "--renderer-process-limit=1", "--disable-extensions",
      "--disable-features=site-per-process,IsolateOrigins,Translate,OptimizationHints,MediaRouter,AudioServiceOutOfProcess",
      "--enable-features=NetworkServiceInProcess,NetworkServiceInProcess2", "--js-flags=--max-old-space-size=192"] });
    const context = await browser.newContext({ ignoreHTTPSErrors: true, reducedMotion: "reduce" });
    await context.route("**/*", (route) => {
      const u = new URL(route.request().url());
      if (!["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)){ forbidden.push(u.href); return route.abort("blockedbyclient"); }
      return route.continue();
    });
    const methods = (r) => { try { return [].concat(JSON.parse(r.postData() || "null")).filter((c) => c && c.method).map((c) => c.method); } catch { return []; } };
    const origin = (u) => new URL(u).origin, walletOrigin = origin(rig.rpc), profileOrigins = new Set(rig.profile.rpcs.map(origin));
    context.on("request", (r) => {
      const o = origin(r.url());
      if (o === walletOrigin) walletRpc.push(...methods(r));
      else if (profileOrigins.has(o)) originRpc.push(...methods(r));
    });
    await context.addInitScript(({ profile, address }) => {
      const text = JSON.stringify(profile);
      if (!sessionStorage.getItem("enclave_independent_ack")){ localStorage.setItem("enclave_independent_profile", text); sessionStorage.setItem("enclave_independent_ack", text); }
      localStorage.setItem("enclave_session", JSON.stringify({ address, rdns: "test.local.wallet" }));
    }, { profile: rig.profile, address: rig.owner });
    await context.addInitScript({ content: walletScript({ rpc: rig.rpc, address: rig.owner }) });
    const page = await context.newPage();
    const pageErrors = []; page.on("pageerror", (e) => pageErrors.push(String(e)));
    const res = await page.goto(rig.site + "/dashboard");
    assert.equal(res.status(), 200);
    assert.match(await page.content(), /js\/boot\.js\?v=[0-9a-f]{16}/, "the built HTML (boot.js bound to its build)");

    // the popover in the built page: open it once the wallet is connected, then the routes box
    for (let i = 0; i < 60 && !(await page.isVisible("#walletPop:not([hidden]) #wpRpc")); i++){ await page.click("#walletBtn").catch(() => {}); await page.waitForTimeout(500); }
    await page.click("#wpRpc");
    assert.equal(await page.textContent("#wpRoute"), "your wallet’s own RPC", "default: the wallet broadcasts");
    await page.click("#wpRouteProfile");
    assert.equal(await page.textContent("#wpRoute"), "the network profile (your wallet signs only)");
    assert.match(await page.textContent("#wpRpcSt"), /asked only to sign/);

    // the built chunks' own functions, at the URLs the page already loaded
    const found = await page.evaluate(async ({ sendFiles, waitFiles, SEND_MSG, WAIT_MSG }) => {
      const pick = async (files, needles) => { for (const f of files){ const m = await import(f);
        for (const v of Object.values(m)) if (typeof v === "function" && needles.every((n) => String(v).includes(n))) return v; } return null; };
      window.__built = { sendTx: await pick(sendFiles, [SEND_MSG, "eth_estimateGas"]), waitReceipt: await pick(waitFiles, [WAIT_MSG, "eth_getTransactionReceipt"]) };
      return { sendTx: !!window.__built.sendTx, waitReceipt: !!window.__built.waitReceipt };
    }, { sendFiles, waitFiles, SEND_MSG, WAIT_MSG });
    assert.deepEqual(found, { sendTx: true, waitReceipt: true });
    const approve = (owner, n) => "0x095ea7b3" + owner.slice(2).toLowerCase().padStart(64, "0") + n.toString(16).padStart(64, "0");

    // 1. profile route: signs only, the profile broadcasts, the receipt through the profile
    walletRpc.length = originRpc.length = 0;
    const one = await page.evaluate(async ({ usdc, data }) => {
      const hash = await window.__built.sendTx(usdc, data, "0x0");
      const rec = await window.__built.waitReceipt(hash);
      return { hash, status: rec.status, from: rec.from.toLowerCase() };
    }, { usdc: rig.addresses.usdc, data: approve(rig.owner, 1) });
    assert.deepEqual([one.status, one.from], ["0x1", rig.owner.toLowerCase()]);
    assert.deepEqual(walletRpc, ["eth_signTransaction"], "the wallet signed only: its RPC broadcast nothing and was asked nothing else");
    assert.equal(originRpc.filter((m) => m === "eth_sendRawTransaction").length, 1);
    assert.ok(originRpc.includes("eth_getTransactionReceipt"));

    // 2. profile route, accepted by an origin that loses it: the real clock past the drop check
    walletRpc.length = originRpc.length = 0;
    rig.rpcModes[0] = rig.rpcModes[1] = rig.rpcModes[2] = "swallow-raw";
    const lost = await page.evaluate(async ({ usdc, data }) => {
      const hash = await window.__built.sendTx(usdc, data, "0x0");
      const t = Date.now();
      try { await window.__built.waitReceipt(hash); return { hash, outcome: "receipt" }; }
      catch (e){ return { hash, outcome: String(e.message || e), waitedMs: Date.now() - t }; }
    }, { usdc: rig.addresses.usdc, data: approve(rig.owner, 2) });
    rig.rpcModes[0] = rig.rpcModes[1] = rig.rpcModes[2] = "ok";
    assert.match(lost.outcome, /timed out waiting for confirmation/, "the ordinary timeout");
    assert.doesNotMatch(lost.outcome, /your wallet's RPC/, "never 'dropped by your wallet'");
    assert.ok(lost.waitedMs > 45000, "real polling past DROP_AFTER (~40 s): " + lost.waitedMs + " ms");
    assert.deepEqual(walletRpc, ["eth_signTransaction"], "one signature; the wallet was never asked eth_getTransactionByHash");
    assert.equal(originRpc.filter((m) => m === "eth_sendRawTransaction").length, 1, "accepted by the first origin; nothing resent while waiting");
    assert.ok(originRpc.filter((m) => m === "eth_getTransactionReceipt").length >= 45, "every poll went to the profile");
    assert.equal(await rig.pc.getTransaction({ hash: lost.hash }).then(() => "found", () => "absent"), "absent", "it exists nowhere, as the origin lost it");

    // 3. back to the wallet route: the wallet broadcasts, as before
    for (let i = 0; i < 20 && !(await page.isVisible("#wpRouteWallet")); i++){
      if (!(await page.isVisible("#walletPop:not([hidden]) #wpRpc"))) await page.click("#walletBtn").catch(() => {});
      if (await page.isVisible("#wpRpc")) await page.click("#wpRpc").catch(() => {});
      await page.waitForTimeout(300);
    }
    await page.click("#wpRouteWallet");
    assert.equal(await page.textContent("#wpRoute"), "your wallet’s own RPC");
    walletRpc.length = originRpc.length = 0;
    const three = await page.evaluate(async ({ usdc, data }) => {
      const hash = await window.__built.sendTx(usdc, data, "0x0");
      return { status: (await window.__built.waitReceipt(hash)).status };
    }, { usdc: rig.addresses.usdc, data: approve(rig.owner, 3) });
    assert.equal(three.status, "0x1");
    assert.deepEqual(walletRpc, ["eth_sendTransaction"], "the wallet broadcast it");
    assert.equal(originRpc.filter((m) => m === "eth_sendRawTransaction").length, 0);
    assert.deepEqual(forbidden, [], "no public origin was attempted");
    if (pageErrors.length) console.log("# page errors (not asserted):", pageErrors.slice(0, 5));
  } finally { await browser?.close(); await rig?.stop(); }
});
