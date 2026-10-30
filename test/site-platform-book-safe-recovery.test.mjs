// A passkey account's own record on a ledger the platform administrator REPLACED (address-book profile), recovered through
// the account's own path with NO wallet anywhere: no injected provider, no wallet session. The Safe (v1.4.1, the pinned Base
// code on an anvil fork, read-only upstream) pays its own gas through the owner's bundler (test/helpers/local-bundler.mjs,
// the real EntryPoint v0.7). The administrator migrates the ledger by import (test/helpers/fork-deploy.mjs --replace-ledger)
// and repoints the original-style book; the dashboard lists what the replaced ledger still holds for the Safe's record and
// "Recover funds" is one passkey-approved user operation - never a wallet prompt. A non-recovery call to the replaced
// ledger is refused before any passkey approval.
//   node test/helpers/memory-guard.mjs --max-rss-mib 1408 --floor-available-mib 16384 -- node --test test/site-platform-book-safe-recovery.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn, execFileSync, execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as viem from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { startLocalBundler } from "./helpers/local-bundler.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(new URL("../e2e/package.json", import.meta.url));
let chromium = null; try { ({ chromium } = require("playwright")); } catch {}
const have = (cmd, args) => { try { execFileSync(cmd, args, { stdio: "ignore" }); return true; } catch { return false; } };
const skip = (!have("anvil", ["--version"]) && "needs anvil") || (!chromium && "needs Playwright's Chromium");
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", FORK_BLOCK = 52836800n;
const EP = "0x0000000071727de22e5e9d8baf0edac6f37da032";
const chain = { id: 8453, name: "base-fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } };
const run = promisify(execFile);
const LEDGER = viem.parseAbi(["function create(string,uint16,uint16,uint32,string,bool,string,address,uint256,uint256) returns (bytes32)",
  "function fund(bytes32,uint256)", "function refundableOf(bytes32) view returns (uint256)"]);
const BOOK = viem.parseAbi(["function set(bytes32,address)"]);

let rpcUrl, pc, driverWc, site, sitePort, browser, page, bundler, d, setupError = null;
const cleanups = [], pageErrors = [], requests = [], consoleLines = [];
const cleanup = async () => { while (cleanups.length) { try { await cleanups.pop()(); } catch {} } };
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const rpc = async (method, params) => { const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; };
const ready = () => { if (setupError) throw new Error("setup failed: " + setupError.message); };
const url = (p) => `http://localhost:${sitePort}${p}`;
// a mined local receipt, polled directly (test/helpers/fork-deploy.mjs explains viem's automine race)
const receiptOf = async (hash) => {
  for (const until = Date.now() + 120_000; Date.now() < until; await new Promise((r) => setTimeout(r, 250))){
    const r = await pc.getTransactionReceipt({ hash }).catch((e) => { if (e.name !== "TransactionReceiptNotFoundError") throw e; return null; });
    if (r){ assert.equal(r.status, "success"); return r; }
  }
  throw new Error("no receipt for " + hash + " after 120 s");
};
const usdcOf = (a) => pc.readContract({ address: USDC, abi: viem.erc20Abi, functionName: "balanceOf", args: [a] });
/* USDC v2.2 keeps balances in the low 255 bits of a mapping slot; find that slot on the fork (local state only) */
async function fundUsdc(account, amount){
  const bal = (a) => pc.readContract({ address: USDC, abi: viem.erc20Abi, functionName: "balanceOf", args: [a] });
  for (let slot = 0; slot < 24; slot++){
    const key = viem.keccak256(viem.encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [account, BigInt(slot)]));
    const before = await rpc("eth_getStorageAt", [USDC, key, "latest"]);
    await rpc("anvil_setStorageAt", [USDC, key, viem.pad(viem.toHex(amount), { size: 32 })]);
    if ((await bal(account)) === amount) return;
    await rpc("anvil_setStorageAt", [USDC, key, before]);
  }
  throw new Error("USDC balance slot not found");
}

test.before(async () => {
  if (skip) return;
  const watchdog = setTimeout(() => { console.error("platform-book-safe-recovery: watchdog"); cleanup().finally(() => process.exit(1)); }, 9 * 60 * 1000); watchdog.unref();
  try {
    const port = await freePort(); rpcUrl = `http://127.0.0.1:${port}`;
    const anvil = spawn("anvil", ["--port", String(port), "--fork-url", process.env.BASE_FORK_RPC || "https://mainnet.base.org", "--fork-block-number", String(FORK_BLOCK), "--optimism", "--silent",
      "--base-fee", "0", "--prune-history", "4", "--transaction-block-keeper", "16"], { stdio: "ignore" });
    cleanups.push(() => anvil.kill("SIGKILL"));
    for (let i = 0; i < 120; i++){ try { await rpc("eth_chainId", []); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
    await rpc("evm_setNextBlockTimestamp", [Math.floor(Date.now() / 1000)]); await rpc("evm_mine", []);
    // the TEST's own key deploys the repository's contracts and administers the book - never in the page
    const driver = privateKeyToAccount(generatePrivateKey());
    await rpc("anvil_setBalance", [driver.address, "0x56bc75e2d63100000"]);
    await rpc("anvil_impersonateAccount", [driver.address]);
    pc = viem.createPublicClient({ chain, transport: viem.http(rpcUrl), cacheTime: 0 });
    driverWc = viem.createWalletClient({ chain, account: driver.address, transport: viem.http(rpcUrl) });
    const { stdout } = await run("node", [path.join(REPO, "test/helpers/fork-deploy.mjs"), rpcUrl, driver.address, "--legacy-session-factory"], { maxBuffer: 1 << 20 });
    d = { ...JSON.parse(stdout.trim().split("\n").pop()), driver: driver.address };
    bundler = await startLocalBundler({ rpcUrl, entryPoint: EP, chain, setBalance: (a, v) => rpc("anvil_setBalance", [a, v]) });
    cleanups.push(() => bundler.stop());
    const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
    const PRETTY = { "/": "/index.html", "/dashboard": "/dashboard.html", "/apps": "/apps.html" };
    site = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, "http://x").pathname); p = PRETTY[p] || p;
      const root = p.startsWith("/network/") ? REPO : path.join(REPO, "site"), file = path.join(root, p);
      if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()){ res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" }); fs.createReadStream(file).pipe(res);
    });
    sitePort = await new Promise((r) => site.listen(0, "127.0.0.1", () => r(site.address().port)));
    cleanups.push(() => new Promise((r) => { site.closeAllConnections?.(); site.close(() => r()); }));
    // an address-book profile (the original-style book and factory), its ledger history as generated at this block
    const profile = { format: "enclave-browser-profile", version: 1, name: "local Base fork", chainId: 8453, rpcs: [rpcUrl, rpcUrl.replace("127.0.0.1", "localhost")], quorum: 2,
      confirmations: 0, maxBlockAgeSeconds: 86400, addressBook: d.book, ledgerHistory: { through: String(await pc.getBlockNumber()), ledgers: [] },
      contractPins: { version: 1, chainId: 8453, contracts: { registry: d.registry, deployments: d.ledger, appCatalog: d.catalog, proofOfTime: d.ledger, enclavePay: "0x" + "00".repeat(20),
        verificationFees: "0x" + "00".repeat(20), sessionVaultFactory: d.factory, secretVaultV2: "0x" + "00".repeat(20) } }, usdc: USDC.toLowerCase(), ethUsdFeed: d.feed };
    browser = await chromium.launch({ args: ["--disable-gpu", "--disable-dev-shm-usage", "--renderer-process-limit=1", "--disable-extensions",
      "--disable-features=site-per-process,IsolateOrigins,Translate,OptimizationHints,MediaRouter,AudioServiceOutOfProcess",
      "--enable-features=NetworkServiceInProcess,NetworkServiceInProcess2", "--js-flags=--max-old-space-size=192"] });
    cleanups.push(() => browser.close());
    const context = await browser.newContext({ reducedMotion: "reduce" });
    await context.route((u) => /(^|\.)enclave\.host$/i.test(u.hostname), (r) => r.abort("blockedbyclient"));
    context.on("request", (r) => requests.push(r.url()));
    // NO wallet: no injected provider and no stored wallet session - only the network profile
    const text = JSON.stringify(profile);
    await context.addInitScript((text) => { localStorage.setItem("enclave_independent_profile", text); sessionStorage.setItem("enclave_independent_ack", text); }, text);
    page = await context.newPage(); page.setDefaultTimeout(60000);
    page.on("pageerror", (e) => pageErrors.push(String(e && e.message || e)));
    page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") consoleLines.push(m.type() + ": " + m.text()); });
    page.on("dialog", (dlg) => dlg.accept());
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(url("/dashboard"));
  } catch (e){ setupError = e; await cleanup(); throw e; }
});
test.after(cleanup);

const status = () => page.locator(".acct-status").textContent();
const waitStatus = async (re, timeout = 60000) => {
  try { await page.waitForFunction((src) => new RegExp(src).test(document.querySelector(".acct-status")?.textContent || ""), re.source, { timeout }); }
  catch (e){ throw new Error(e.message + "\nwaiting for " + re + "\nstatus: " + await status().catch(() => "?") + "\npage errors: " + JSON.stringify(pageErrors) + "\nconsole: " + JSON.stringify(consoleLines.slice(-12))); }
};

test("no wallet: the passkey account recovers its own record's funds from a replaced ledger through its own path", { skip, timeout: 480000 }, async () => {
  ready();
  assert.equal(await page.evaluate(() => typeof window.ethereum), "undefined", "no wallet in this browser");
  // the account: one passkey, the owner's bundler, the account paying its own gas (as in the no-wallet startup test)
  await page.waitForSelector(".acct-panel", { timeout: 60000 });
  await page.locator(".acct-panel > summary").click();
  await page.locator(".acct-label").fill("laptop");
  await page.locator(".acct-shared").check();
  await page.locator(".acct-create").click();
  await waitStatus(/passkey created under localhost/);
  await page.locator(".acct-compute").click();
  await waitStatus(/your account address: 0x[0-9a-f]{40} \(not deployed yet\)/);
  const safe = /your account address: (0x[0-9a-f]{40})/.exec(await status())[1];
  await page.locator(".acct-save").click();
  await page.waitForSelector(".acct-summary");
  await page.locator(".acct-transport").click();
  await page.locator(".acct-tr-b").fill(bundler.url);
  await page.locator(".acct-tr-save").click();
  await page.waitForSelector(".acct-gas-account:not([disabled])");
  await page.locator(".acct-gas-account").check();
  await waitStatus(/gas: the account pays its own, through your bundler/);
  await rpc("anvil_setBalance", [safe, viem.toHex(10n ** 17n)]);
  await page.locator(".acct-deploy").click();
  await waitStatus(/creating your account confirmed by the EntryPoint in 0x[0-9a-f]{64} \(gas [0-9.]+ ETH, paid by the account\)/, 90000);
  await page.locator(".acct-use").click();
  await waitStatus(/the dashboard now acts as your passkey account/);

  // fixture: a record the Safe holds on the original ledger, funded from the Safe's USDC before the migration (the Safe's
  // address is impersonated on this local fork only; the page never sees a key)
  await fundUsdc(safe, 5_000_000n);
  await rpc("anvil_impersonateAccount", [safe]);
  const asSafe = viem.createWalletClient({ chain, account: safe, transport: viem.http(rpcUrl) });
  const made = await receiptOf(await asSafe.writeContract({ address: d.ledger, abi: LEDGER, functionName: "create", gas: 3_000_000n,
    args: ["catalog://0x" + "11".repeat(32) + "/0", 0, 100, 8080, "", true, "", "0x" + "00".repeat(20), 0n, 100n] }));
  const id = made.logs.find((l) => l.address.toLowerCase() === d.ledger && l.topics.length === 3 && l.topics[2].endsWith(safe.slice(2))).topics[1].toLowerCase();
  await receiptOf(await asSafe.writeContract({ address: USDC, abi: viem.erc20Abi, functionName: "approve", args: [d.ledger, 1_000_000n], gas: 200_000n }));
  await receiptOf(await asSafe.writeContract({ address: d.ledger, abi: LEDGER, functionName: "fund", args: [id, 1_000_000n], gas: 1_000_000n }));
  await rpc("anvil_stopImpersonatingAccount", [safe]);
  const back = await pc.readContract({ address: d.ledger, abi: LEDGER, functionName: "refundableOf", args: [id] });
  assert.ok(back > 0n);

  // the administrator migrates the ledger (import) and repoints the book
  const { stdout } = await run("node", [path.join(REPO, "test/helpers/fork-deploy.mjs"), rpcUrl, d.driver, "--replace-ledger", d.ledger, d.registry, d.feed], { maxBuffer: 1 << 20 });
  const next = JSON.parse(stdout.trim().split("\n").pop());
  assert.ok(next.imported >= 1);
  await receiptOf(await driverWc.writeContract({ address: d.book, abi: BOOK, functionName: "set", args: [viem.stringToHex("deployments", { size: 32 }), next.ledger] }));

  // the account's dashboard, freshly loaded: the record (carried over) and what the replaced ledger still holds for it
  await page.goto(url("/dashboard"));
  const btn = page.locator(`.enc-rrefund[data-id="${id}"][data-ledger="${d.ledger}"]`);
  await btn.waitFor({ timeout: 90000 });
  assert.equal(await btn.getAttribute("data-by"), "account", "the Safe owns it there: the account's own path");
  assert.match(await page.locator(`.enc-retired[data-rid="${id}"][data-ledger="${d.ledger}"]`).textContent(), new RegExp("Owner there: " + safe));

  // a non-recovery call to the replaced ledger stops before any passkey approval or user operation
  const ops0 = bundler.received.length;
  const refused = await page.evaluate(async ({ to, data }) => { try { await (await import("/js/core/sessions.js")).safeExecute({ to, data }); return "unexpected success"; } catch (e){ return e.message; } },
    { to: d.ledger, data: viem.encodeFunctionData({ abi: LEDGER, functionName: "fund", args: [id, 1n] }) });
  assert.match(refused, /retired platform contract/);
  assert.equal(bundler.received.length, ops0, "nothing reached the bundler");

  // recovery: one passkey-approved user operation; the ledger pays the Safe; no wallet is ever asked for
  const before = await usdcOf(safe);
  await btn.click();
  await page.waitForFunction((id) => /refunded to the record's owner|✗/.test([...document.querySelectorAll(`.enc-retired[data-rid="${id}"] .enc-rref-out`)].map((e) => e.textContent).join(" "))
    || !document.querySelector(`.enc-rrefund[data-id="${id}"]`), id, { timeout: 180000 });
  const out = await page.locator(`.enc-retired[data-rid="${id}"] .enc-rref-out`).allTextContents().catch(() => []);
  assert.ok(!out.join(" ").includes("✗"), "recovery failed: " + out.join(" | ") + "\nconsole: " + JSON.stringify(consoleLines.slice(-8)));
  for (const t0 = Date.now(); (await usdcOf(safe)) !== before + back && Date.now() - t0 < 60000;) await new Promise((r) => setTimeout(r, 500));
  assert.equal(await usdcOf(safe), before + back, "refunded to the Safe");
  assert.equal(bundler.received.length, ops0 + 1, "one user operation, approved with the passkey");
  assert.equal(await page.evaluate(() => typeof window.ethereum), "undefined");
  assert.equal(await page.evaluate(() => localStorage.getItem("enclave_session")), null, "no wallet session was started");
  assert.deepEqual(pageErrors.filter((e) => !/ResizeObserver/.test(e)), []);
  assert.ok(!requests.some((u) => /enclave\.host/.test(new URL(u).hostname)), "no Enclave origin");
});
