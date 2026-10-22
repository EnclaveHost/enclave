// The DEFAULT independent dashboard, end to end, in fresh Chromium profiles against the BUILT site.
//   - The site: scripts/build-site.mjs with a provisional default profile module (test/helpers/default-site-fixture.mjs, run
//     first as its own job), served over HTTPS on localhost. The profile packages the REAL reviewed Base authority profile
//     and the REAL service-index pin; its RPCs are three loopback proxies.
//   - The chain: an anvil fork of Base (read-only upstream) holding the real pinned contracts, the real service index and
//     its real Enclave ad, real ledger records and a real relay-era vault (test/helpers/default-independence-rig.mjs).
//   - FIXTURES (named so): dev-key actors (a service operator, a host operator with a registered fixture host, a host owner
//     that accepts the Enclave-operated metal0 host's ownership ON THE FORK), real operators impersonated on the fork only,
//     the real directory server, storage adapters and a policy mirror reached at public-looking names through routing.
//   - Every request that leaves this machine and is not a fixture is refused and recorded; Enclave's API, identity and
//     metadata origins are never contacted.
// Needs: anvil, Playwright's Chromium, network access to the Base fork upstream (read-only), and the fixture build:
//   node test/helpers/default-site-fixture.mjs --out-dir <dir>
//   DEFAULT_SITE_SUMMARY=<dir>/summary.json node test/helpers/memory-guard.mjs --max-rss-mib 1408 --floor-available-mib 16384 -- \
//     node --max-old-space-size=256 test/site-default-independence.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as viem from "viem";
import { startForkRig, walletScript, DEV, LIVE, FIXTURE_HOST, FIXTURE_DIRECTORY, CHAIN } from "./helpers/default-independence-rig.mjs";
import { mintLocalCa, serveTls } from "./helpers/local-tls.mjs";
import { startLocalBundler } from "./helpers/local-bundler.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(new URL("../e2e/package.json", import.meta.url));
let chromium = null; try { ({ chromium } = require("playwright")); } catch {}
const haveAnvil = (() => { try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const SUMMARY = process.env.DEFAULT_SITE_SUMMARY;
const skip = (!haveAnvil && "needs anvil") || (!chromium && "needs Playwright's Chromium") || ((!SUMMARY || !fs.existsSync(SUMMARY)) && "needs DEFAULT_SITE_SUMMARY from test/helpers/default-site-fixture.mjs");
const EP = "0x0000000071727de22e5e9d8baf0edac6f37da032";

let rig, browser, site, siteUrl, ca, summary, bundler, setupError = null;
const cleanups = [], pageErrors = [];
const cleanup = async () => { while (cleanups.length){ try { await cleanups.pop()(); } catch {} } };
const ready = () => { if (setupError) throw new Error("setup failed: " + setupError.message); };

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".map": "application/json", ".ico": "image/x-icon", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2" };
const PRETTY = { "/": "/index.html", "/apps": "/apps.html", "/dashboard": "/dashboard.html", "/sessions": "/sessions.html", "/host": "/host.html", "/grant": "/grant.html" };

test.before(async () => {
  if (skip) return;
  const watchdog = setTimeout(() => { console.error("default-independence: watchdog"); cleanup().finally(() => process.exit(1)); }, 25 * 60 * 1000); watchdog.unref();
  try {
    summary = JSON.parse(fs.readFileSync(SUMMARY, "utf8"));
    const dist = summary.dist;
    // the BUILT site, over HTTPS on a loopback name (a provisional profile only starts on loopback)
    ca = mintLocalCa({ host: "localhost" }); cleanups.push(() => ca.cleanup());
    site = await serveTls(ca, (req, res) => {
      let p = decodeURIComponent(new URL(req.url, "https://x").pathname); p = PRETTY[p] || p;
      const file = path.join(dist, p);
      if (!file.startsWith(dist) || !fs.existsSync(file) || !fs.statSync(file).isFile()){ res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" }); fs.createReadStream(file).pipe(res);
    });
    cleanups.push(() => site.close());
    siteUrl = "https://localhost:" + site.port;
    rig = await startForkRig(); cleanups.push(() => rig.stop());
    bundler = await startLocalBundler({ rpcUrl: rig.rpcUrl, entryPoint: EP, chain: CHAIN, setBalance: (a, v) => rig.rpc("anvil_setBalance", [a, v]) });
    cleanups.push(() => bundler.stop());
    browser = await chromium.launch({ args: ["--disable-gpu", "--disable-dev-shm-usage", "--renderer-process-limit=1", "--disable-extensions",
      "--disable-features=site-per-process,IsolateOrigins,Translate,OptimizationHints,MediaRouter,AudioServiceOutOfProcess",
      "--enable-features=NetworkServiceInProcess,NetworkServiceInProcess2", "--js-flags=--max-old-space-size=192"] });
    cleanups.push(() => browser.close());
  } catch (e){ setupError = e; await cleanup(); throw e; }
});
test.after(cleanup);
// an interrupted run still stops its own fixtures (anvil keeps its fork cache on a clean exit)
for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => { cleanup().finally(() => process.exit(130)); });

/* A FRESH browser profile: new context, routing that refuses everything off this machine but the fixtures. */
async function fresh({ wallet = null, authenticator = false, init = null, routeExtra = null } = {}){
  const context = await browser.newContext({ ignoreHTTPSErrors: true, reducedMotion: "reduce" });
  await rig.routeContext(context);
  if (routeExtra) await routeExtra(context);
  if (wallet){
    await context.addInitScript({ content: walletScript({ rpc: rig.rpcUrl, address: wallet }) });
    await context.addInitScript((address) => { if (!localStorage.getItem("enclave_session")) localStorage.setItem("enclave_session", JSON.stringify({ address, rdns: "test.local.wallet" })); }, wallet);
  }
  if (init) await context.addInitScript(init);
  const page = await context.newPage(); page.setDefaultTimeout(60000);
  page.on("pageerror", (e) => pageErrors.push(String(e && e.message || e)));
  if (authenticator){
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  }
  return { context, page, close: () => context.close() };
}
const barText = (page) => page.locator(".ind-default-bar").textContent().catch(() => "");
const waitBar = async (page, re, timeout = 180000) => {
  try { await page.waitForFunction((src) => new RegExp(src).test(document.querySelector(".ind-default-bar")?.textContent || ""), re.source, { timeout }); }
  catch (e){ throw new Error(e.message + "\nbar: " + await barText(page) + "\nrefused: " + JSON.stringify(rig.refused.slice(-8))); }
};
const waitIn = async (page, sel, re, timeout = 120000) => {
  try { await page.waitForFunction(({ sel, src }) => [...document.querySelectorAll(sel)].some((e) => new RegExp(src).test(e.textContent || "")), { sel, src: re.source }, { timeout }); }
  catch (e){ throw new Error(e.message + "\nin " + sel + ": " + (await page.locator(sel).allTextContents().catch(() => [])).join(" | ").slice(-800)); }
};
// Enclave's API / identity / metadata: never asked. (A registered host's own capacity endpoint is a HOST, listed apart.)
const enclaveService = (u) => /\/\/(api|ipfs|get|relay|sso)\.enclave\.host\//.test(u) && !/\/t\/[a-z0-9-]+\/v1\/host\/capacity$/.test(u);

test("cold start: the built site's packaged default verifies against the chain, discovers the index, and renders the catalog without Enclave", { skip, timeout: 420000 }, async () => {
  ready();
  const { page, close } = await fresh();
  try {
    await page.goto(siteUrl + "/");
    await waitBar(page, /Reviewed contracts verified at block \d+ \(\d chain endpoints agree\)/);
    await waitBar(page, /service index: \d+ candidate ad\(s\) at block \d+/);
    assert.equal(await page.evaluate(async () => (await import("/js/core/config.js").catch(() => null)) === null), true, "built site: no source modules served");
    // the catalog renders from the pinned contract through the profile's RPCs
    await page.goto(siteUrl + "/apps");
    await page.waitForFunction(() => document.querySelectorAll("c-app-card").length > 0, null, { timeout: 120000 });
    const cards = await page.locator("c-app-card").count();
    assert.ok(cards > 0, "catalog cards");
    await waitBar(page, /Reviewed contracts verified/);
    // default navigation: "Sign in" with no wallet goes to the dashboard's own passkey account panel, never the relay
    await page.locator("#walletBtn").click();
    await page.waitForURL(/\/dashboard/, { timeout: 60000 });
    await page.waitForSelector(".acct-panel", { timeout: 60000 });
    // a hosted-only page says what it is and offers only the explicit hosted choice
    await page.goto(siteUrl + "/checkout.html");
    await page.waitForSelector(".ind-hosted-only", { timeout: 60000 });
    assert.match(await page.locator(".ind-hosted-only").textContent(), /part of Enclave’s hosted service/);
    assert.deepEqual(rig.refused.filter(enclaveService), [], "no Enclave API, identity or metadata request");
  } finally { await close(); }
});

test("discovery: candidates are untrusted, one operator is one participant, plain HTTP is unreachable from this HTTPS page, the user chooses; stale and lying answers", { skip, timeout: 420000 }, async () => {
  ready();
  const { page, close } = await fresh();
  try {
    await page.goto(siteUrl + "/dashboard");
    await page.waitForSelector(".ind-discovery .ind-op", { timeout: 180000 });
    const disc = page.locator(".ind-discovery");
    // the real Enclave ad: ONE operator with four plain-HTTP endpoints, none reachable from an HTTPS page
    const enclaveOp = disc.locator('.ind-op[data-op="' + LIVE.metal0.operator + '"]');
    assert.equal(await enclaveOp.locator("li").count(), 4);
    assert.equal(await enclaveOp.locator("li .warn").count(), 4, "all four marked not reachable from this page");
    const fixtureOp = disc.locator('.ind-op[data-op="' + DEV.serviceOperator.address.toLowerCase() + '"]');
    await fixtureOp.waitFor();
    await waitIn(page, ".ind-disc-out", /This page uses no directory/);
    // nothing is used until the user chooses an operator
    await fixtureOp.locator(".ind-op-use").check();
    await waitIn(page, ".ind-disc-out", /This page uses 1 directory from 1 participant\(s\): https:\/\/dir\.operator-b\.net/);
    // a stale ad: published with a 2-minute life, then the chain moves past it -> listed as expired, never used
    await rig.publishAd({ slot: 1, endpoints: ["https://dir2.operator-b.net/"], ttlSec: 120 });
    await rig.rpc("evm_increaseTime", [300]); await rig.rpc("evm_mine", []);
    await disc.locator(".ind-disc-again").click();
    await waitIn(page, ".ind-disc-out", /expired ad\(s\) ignored/);
    assert.equal(await page.locator('.ind-disc-out li:has-text("dir2.operator-b.net")').count(), 0, "the expired endpoint is not offered");
    // the directory interface in review (directory47485): Enclave's operator republishes slot 0 with HTTPS endpoints
    // (its prepared, UNSIGNED sequence-2 ad). On this fork only: the same operator stays one participant, and its
    // endpoints become reachable from this HTTPS page. The live ad is still plain HTTP.
    await rig.publishAsOperator(LIVE.metal0.operator, { slot: 0, endpoints: ["https://134.199.235.187/", "https://134.209.248.172/", "https://165.245.191.129/", "https://146.190.246.39/"] });
    await disc.locator(".ind-disc-again").click();
    await page.waitForFunction((op) => { const el = document.querySelector('.ind-op[data-op="' + op + '"]'); return el && /https:\/\/134\.199\.235\.187\//.test(el.textContent); }, LIVE.metal0.operator, { timeout: 120000 });
    assert.equal(await enclaveOp.locator("li").count(), 4, "still one operator with four endpoints");
    assert.equal(await enclaveOp.locator("li .warn").count(), 0, "HTTPS endpoints are reachable from this page");
    // one lying RPC (fabricated index answers) is outvoted; a liar plus a dead endpoint leaves no agreement: a refusal, not a list
    rig.proxies[0].lieCall.set(LIVE.serviceIndex, () => "0x" + "00".repeat(31) + "40" + "00".repeat(31) + "09" + "00".repeat(32));
    await disc.locator(".ind-disc-again").click();
    await waitIn(page, ".ind-disc-out", /This page uses 1 directory from 1 participant/);
    rig.proxies[1].mode = "down";
    await page.locator(".ind-disc-again").click();
    await waitIn(page, ".ind-disc-out", /could not be read: .*(disagree|answered)/);
  } finally { rig.proxies.forEach((p) => p.reset()); await close(); }
});

test("new user, no wallet: a passkey account is created through the owner's bundler and becomes the identity on the default profile", { skip, timeout: 420000 }, async () => {
  ready();
  const { page, close } = await fresh({ authenticator: true });
  try {
    await page.goto(siteUrl + "/dashboard");
    assert.equal(await page.evaluate(() => typeof window.ethereum), "undefined");
    await waitBar(page, /Reviewed contracts verified/);
    await page.waitForSelector(".acct-panel", { timeout: 60000 });
    await page.locator(".acct-panel > summary").click();
    await page.locator(".acct-label").fill("laptop");
    await page.locator(".acct-shared").check();
    await page.locator(".acct-create").click();
    await waitIn(page, ".acct-status", /passkey created under localhost/);
    await page.locator(".acct-compute").click();
    await waitIn(page, ".acct-status", /your account address: 0x[0-9a-f]{40} \(not deployed yet\)/);
    const safe = /your account address: (0x[0-9a-f]{40})/.exec(await page.locator(".acct-status").textContent())[1];
    await page.locator(".acct-save").click();
    await page.waitForSelector(".acct-summary");
    await page.locator(".acct-transport").click();
    await page.locator(".acct-tr-b").fill(bundler.url);
    await page.locator(".acct-tr-save").click();
    await page.waitForSelector(".acct-gas-account:not([disabled])");
    await page.locator(".acct-gas-account").check();
    await rig.rpc("anvil_setBalance", [safe, viem.toHex(10n ** 17n)]);
    await page.locator(".acct-deploy").click();
    await waitIn(page, ".acct-status", /creating your account confirmed by the EntryPoint in 0x[0-9a-f]{64}/, 120000);
    assert.notEqual(await rig.rpc("eth_getCode", [safe, "latest"]), "0x");
    await page.locator(".acct-use").click();
    await waitIn(page, ".acct-status", /the dashboard now acts as your passkey account/);
    assert.deepEqual(rig.refused.filter(enclaveService), []);
  } finally { await close(); }
});

test("existing owner: the real Base records are listed from the chain, including those its relay-era vault holds, and one is released to the wallet", { skip, timeout: 600000 }, async () => {
  ready();
  await rig.rpc("anvil_impersonateAccount", [LIVE.existingOwner]);
  await rig.rpc("anvil_setBalance", [LIVE.existingOwner, "0x56bc75e2d63100000"]);
  const { page, close } = await fresh({ wallet: LIVE.existingOwner });
  try {
    await page.goto(siteUrl + "/dashboard");
    await waitBar(page, /Reviewed contracts verified/);
    await waitIn(page, ".enc-scannote", /Read from the ledger at block \d+ \(\d+ records checked\)/, 240000);
    await waitIn(page, ".enc-scannote", new RegExp("Includes your relay-era session vault " + LIVE.existingLegacyVault.slice(0, 10)));
    // every record of the wallet and of its relay-era vault, from the chain
    const LEDGER = viem.parseAbi(["function count() view returns (uint256)", "function getPage(uint256,uint256) view returns ((bytes32 id,address owner,string appRef,string ports,string configCid,uint16 gpuMilli,uint16 cpuMilli,uint32 appPort,bool isPublic,bool active,uint64 createdAt,uint256 rate,uint256 balance6,uint256 spent6,bytes32 runner,address runnerOperator,uint64 leaseUntil)[])"]);
    const n = await rig.pc.readContract({ address: LIVE.ledger, abi: LEDGER, functionName: "count" });
    const all = await rig.pc.readContract({ address: LIVE.ledger, abi: LEDGER, functionName: "getPage", args: [0n, n] });
    const mine = all.filter((d) => [LIVE.existingOwner, LIVE.existingLegacyVault].includes(d.owner.toLowerCase()));
    const legacy = mine.filter((d) => d.owner.toLowerCase() === LIVE.existingLegacyVault);
    assert.ok(legacy.length >= 1, "the fork holds relay-era vault records");
    const shown = await page.evaluate(() => [...document.querySelector("c-deployments")._list].map((d) => ({ id: d.id.toLowerCase(), legacy: !!d.legacyVault })));
    assert.deepEqual(shown.map((x) => x.id).sort(), mine.map((d) => d.id.toLowerCase()).sort(), "exactly the wallet's and its relay-era vault's records");
    assert.deepEqual(shown.filter((x) => x.legacy).map((x) => x.id).sort(), legacy.map((d) => d.id.toLowerCase()).sort());
    // a relay-era row: read-only, holder named, released by the vault's own owner operation
    const target = legacy[0].id.toLowerCase();
    await page.locator(".enc-search").fill(target.slice(2, 14));
    await page.waitForFunction(() => document.querySelectorAll(".enc-row").length === 1, null, { timeout: 90000 });
    const row = page.locator(".enc-row").first();
    assert.match(await row.locator(".enc-legacy").textContent(), /Held by your relay-era session vault/);
    assert.equal(await row.locator(".enc-fundbtn").count(), 0, "no Top up while the relay-era vault holds it");
    await row.locator(".enc-lrelease").click();
    await waitIn(page, ".enc-lrel-out", /released to your wallet|✗/, 180000);
    const out = await row.locator(".enc-lrel-out").textContent();
    assert.match(out, /released to your wallet/, out);
    const after = await rig.pc.readContract({ address: LIVE.ledger, abi: viem.parseAbi(["function get(bytes32) view returns ((bytes32 id,address owner,string appRef,string ports,string configCid,uint16 gpuMilli,uint16 cpuMilli,uint32 appPort,bool isPublic,bool active,uint64 createdAt,uint256 rate,uint256 balance6,uint256 spent6,bytes32 runner,address runnerOperator,uint64 leaseUntil))"]), functionName: "get", args: [target] });
    assert.equal(after.owner.toLowerCase(), LIVE.existingOwner, "the record is now the wallet's own");
  } finally { await close(); await rig.rpc("anvil_stopImpersonatingAccount", [LIVE.existingOwner]).catch(() => {}); }
});

test("a wallet user's deploy: the host owner's veto removes only its host, signed capacity is shown, and a failed storage adapter is a precise refusal", { skip, timeout: 600000 }, async () => {
  ready();
  const wallet = DEV.wallet.address.toLowerCase();
  // the fixture host signs a real capacity record; a forged one (wrong signer) rides the directory too and must be ignored
  rig.capacity.hostRecord = await rig.signCapacity({ gpu: false, cpuShareFree: 0.5, claimEnabled: true });
  rig.capacity.records = [await rig.signCapacity({ gpu: false, cpuShareFree: 0.9, claimEnabled: true }, { operator: DEV.serviceOperator })];
  const { page, close } = await fresh({ wallet });
  try {
    await page.goto(siteUrl + "/apps");
    await waitBar(page, /Reviewed contracts verified/);
    await page.waitForFunction(() => document.querySelectorAll("c-app-card [data-appid]").length > 0, null, { timeout: 120000 });
    const appId = (await page.locator("c-app-card [data-appid]").first().getAttribute("data-appid")).toLowerCase();
    // the Enclave-operated metal0 host's owner (a fixture owner on the fork) declines every version of this app
    const CAT = viem.parseAbi(["function getApp(bytes32) view returns ((bytes32 appId,address publisher,string slug,string name,string description,uint32 versionCount,uint64 createdAt,uint64 updatedAt,bool active))"]);
    const app = await rig.pc.readContract({ address: LIVE.catalog, abi: CAT, functionName: "getApp", args: [appId] });
    const refs = [...Array(Number(app.versionCount)).keys()].map((i) => "catalog://" + appId + "/" + i);
    await rig.vetoHost(LIVE.metal0.endpoint, LIVE.metal0.operator, refs);
    // the quick-deploy dialog: metal0 is not offered (and says why), every other host is
    await page.goto(siteUrl + "/apps?app=" + appId);
    await page.locator('#appDetailView [data-act="deploy"]').first().click({ timeout: 60000 });
    await page.waitForSelector(".qd-indhost", { timeout: 120000 });
    await waitIn(page, ".qd-target", /Not offered: https:\/\/api\.enclave\.host\/t\/metal0 \(its owner 0x[0-9a-f]{6}… declines this deployment\)\. Every other host is unaffected/);
    const opts = await page.locator(".qd-indhost option").allTextContents();
    assert.ok(!opts.some((o) => /metal0/.test(o)), "the vetoed host is not offered: " + opts.join(" | "));
    assert.ok(opts.some((o) => /kryptos/.test(o)), "another operator's host stays: " + opts.join(" | "));
    await waitIn(page, ".qd-indhost option", /host-b\.operator-b\.net .*host-reported, signed by its operator, expires in \d+ min: CPU share free 50%/);
    // a record awaiting the owner's startup settings, explicit ceiling, no funding
    await page.locator(".qd-cap").fill("0.36");
    await page.locator("#qdAmt").fill("0");
    const tos = page.locator(".qd-tosck"); if (!(await tos.isChecked())) await tos.check();
    await page.locator(".qd-startupck").check();
    await page.locator(".qd-go").click();
    await waitIn(page, ".term", /\[✓\] created 0x[0-9a-f]{64} with startup disabled/, 180000);
    const id = /\[✓\] created (0x[0-9a-f]{64}) with startup disabled/.exec((await page.locator(".term").allTextContents()).join(" "))[1].toLowerCase();
    assert.match((await page.locator(".term").allTextContents()).join(" "), /not offered: https:\/\/api\.enclave\.host\/t\/metal0 - its owner/);
    // Host & price on the record: the same verdicts, read again at an agreed block
    await page.goto(siteUrl + "/dashboard");
    await page.locator(".enc-search").fill(id.slice(2, 14));
    await page.waitForFunction(() => document.querySelectorAll(".enc-row").length === 1, null, { timeout: 120000 });
    const row = page.locator(".enc-row").first();
    await row.locator(".enc-hostbtn").click();
    await row.locator(".enc-host-list").waitFor({ timeout: 120000 });
    const list = await row.locator(".enc-host-list").textContent();
    assert.match(list, /api\.enclave\.host\/t\/metal0 · its owner 0x[0-9a-f]{6}… declines this deployment/, list);
    assert.match(list, /kryptos\.enclave\.containers\.Cloud Provider\.dev · (\$[0-9.]+\/hr for this size|free for this owner)/, list);
    assert.match(list, /host-b\.operator-b\.net · .*host-reported, signed by its operator, expires in \d+ min: CPU share free 50%/, "the signed capacity, not the forged 90%: " + list);
    assert.ok(!(await row.locator(".eh-host option").allTextContents()).some((o) => /metal0/.test(o)), "the vetoed host cannot be pinned");
    // Startup: one storage adapter is down -> nothing is committed, and the page says exactly why
    await row.locator(".enc-hostbtn").click();
    await row.locator(".enc-startbtn").click();
    await row.locator(".es-app").waitFor({ timeout: 60000 });
    await row.locator(".es-cfg").fill('{"greeting":"default independence"}');
    await row.locator(".es-app").fill("a1".repeat(32)); await row.locator(".es-rt").fill("b2".repeat(32));
    rig.storage.modes[1] = "down";
    await row.locator(".es-go").click();
    await page.waitForFunction(() => /\[✓\] committed:|\[x\]/.test(document.querySelector(".enc-start-status")?.textContent || ""), null, { timeout: 180000 });
    const failed = await row.locator(".enc-start-status").textContent();
    assert.match(failed, /\[x\] storage requirement not met: 1 of 2 required copies verified \(s2\.storage-b\.net: /, failed);
    assert.doesNotMatch(failed, /committed:/);
    // the adapter comes back: the same publish commits
    rig.storage.modes[1] = undefined;
    await row.locator(".es-go").click();
    await page.waitForFunction(() => /\[✓\] committed:/.test(document.querySelector(".enc-start-status")?.textContent || ""), null, { timeout: 180000 });
    assert.ok(rig.storage.uploads.filter((u) => u.signer === wallet).length >= 2, "both adapters hold the package");
    assert.deepEqual(rig.refused.filter(enclaveService), []);
  } finally { rig.storage.modes = {}; await close(); }
});

test("unknown chain and lying code: the default refuses with the reason and never falls back to the hosted service", { skip, timeout: 420000 }, async () => {
  ready();
  const before = rig.refused.length;
  // every endpoint serves another chain
  rig.proxies.forEach((p) => { p.mode = "wrong-chain"; });
  let ctx = await fresh({ wallet: DEV.wallet.address.toLowerCase() });
  try {
    await ctx.page.goto(siteUrl + "/dashboard");
    await waitBar(ctx.page, /Not verified yet: .*(chain 31337|answered)/, 120000);
    await ctx.page.waitForSelector(".ind-auth-line", { timeout: 60000 });
    assert.match(await ctx.page.locator(".ind-auth-line").textContent(), /Not verified yet/);
    // the owner's list is a failed read with the reason, never an empty account
    await waitIn(ctx.page, "c-deployments", /could not be checked|serves chain 31337|answered/, 120000);
    assert.equal(await ctx.page.locator(".enc-empty:has-text('No apps yet')").count(), 0, "never 'No apps yet' on a failed read");
  } finally { await ctx.close(); rig.proxies.forEach((p) => p.reset()); }
  // two of three endpoints agree on DIFFERENT ledger code: the reviewed code hash refuses, decisions stop
  for (const p of rig.proxies.slice(0, 2)) p.lieCode.set(LIVE.ledger, "0x6000");
  ctx = await fresh({ wallet: DEV.wallet.address.toLowerCase() });
  try {
    await ctx.page.goto(siteUrl + "/dashboard");
    await waitBar(ctx.page, /Refused: the contracts do not match their reviewed code \(deployments: code hash mismatch/, 180000);
    await waitIn(ctx.page, "c-deployments", /do not match their reviewed code/, 120000);
  } finally { await ctx.close(); rig.proxies.forEach((p) => p.reset()); }
  assert.deepEqual(rig.refused.slice(before).filter(enclaveService), [], "no hosted request under failure");
});

test("a substituted packaged profile is refused at load, with no hosted fallback and nothing signed", { skip, timeout: 300000 }, async () => {
  ready();
  const before = rig.refused.length;
  const { page, close } = await fresh({ routeExtra: async (context) => {
    // a mirror or CDN that rewrites the pinned ledger inside the bundled default profile
    await context.route((u) => u.hostname === "localhost" && /\/js\/.*\.js$/.test(u.pathname), async (route) => {
      const r = await route.fetch(); let body = await r.text();
      if (body.includes("enclave-default-profile/v1")) body = body.split(LIVE.ledger).join("0x" + "66".repeat(20));
      await route.fulfill({ response: r, body });
    });
  } });
  try {
    await page.goto(siteUrl + "/dashboard");
    await waitBar(page, /The default network profile built into this site cannot be used: .*(does not match its digest|digest mismatch)/, 60000);
    await page.waitForSelector(".ind-bad", { timeout: 60000 });
    assert.match(await page.locator(".ind-bad").textContent(), /does not fall back to Enclave’s hosted service/);
    assert.ok(await page.locator(".ind-import").count() >= 1, "the owner can choose a profile");
    assert.ok(await page.locator(".ind-hosted").count() >= 1, "the hosted service is an explicit choice, not a fallback");
    assert.deepEqual(rig.refused.slice(before).filter(enclaveService), []);
  } finally { await close(); }
});

test("no Enclave API, identity or metadata origin was contacted in any scenario; off-machine attempts are listed", { skip }, () => {
  ready();
  assert.deepEqual(rig.refused.filter(enclaveService), []);
  console.log(JSON.stringify({ contactedFixtures: [...new Set(rig.contacted.map((u) => new URL(u).origin))], refusedOffMachine: [...new Set(rig.refused)] }, null, 1));
  assert.deepEqual(pageErrors.filter((e) => !/ResizeObserver/.test(e)), []);
});
