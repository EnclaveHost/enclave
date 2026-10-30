// Account-first, in a real headless Chromium with NO wallet at all (no injected provider, no gas payer key in the page):
// a passkey (Chrome's virtual authenticator) becomes the built-in signer of a Safe whose counterfactual address the owner
// pre-funds with ETH; the account creates ITSELF through its own first ERC-4337 user operation, sent to the owner's own
// bundler (a local stand-in, test/helpers/local-bundler.mjs, submitting to the REAL pinned EntryPoint v0.7 on an anvil fork
// of Base, read-only upstream). Then, as the dashboard identity and paying its own gas: a session, the Apps deploy dialog, a
// row action, an outcome the bundler holds back (unknown, never resent, then confirmed from the EntryPoint's event), and the
// /grant page - "Sign only" handed to a separate gas payer that checks the opened session against the grant exactly, and
// "Approve and open" through the account's own bundler.
//   node test/helpers/memory-guard.mjs --max-rss-mib 1280 --floor-available-mib 16384 -- node --max-old-space-size=256 test/site-independent-account-first.test.mjs
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
const haveAnvil = (() => { try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = (!haveAnvil && "needs anvil") || (!chromium && "needs Playwright's Chromium");
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", FORK_BLOCK = 52836800n;
const EP = "0x0000000071727de22e5e9d8baf0edac6f37da032", SHARED = "0x94a4f6affbd8975951142c3999aeab7ecee555c2";
const chain = { id: 8453, name: "base-fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } };
const run = promisify(execFile);

let rpcUrl, pc, driver, site, sitePort, browser, page, bundler, factory, ledger, catalog, setupError = null;
const cleanups = [], pageErrors = [], requests = [], consoleLines = [], tmpDirs = [];
const cleanup = async () => { while (cleanups.length) { try { await cleanups.pop()(); } catch {} } for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); };
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const rpc = async (method, params) => { const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; };
const ready = () => { if (setupError) throw new Error("setup failed: " + setupError.message); };
const url = (p) => `http://localhost:${sitePort}${p}`;

test.before(async () => {
  if (skip) return;
  const watchdog = setTimeout(() => { console.error("account-first: watchdog"); cleanup().finally(() => process.exit(1)); }, 14 * 60 * 1000); watchdog.unref();
  try {
    const port = await freePort(); rpcUrl = `http://127.0.0.1:${port}`;
    const anvil = spawn("anvil", ["--port", String(port), "--fork-url", process.env.BASE_FORK_RPC || "https://mainnet.base.org", "--fork-block-number", String(FORK_BLOCK), "--optimism", "--silent",
      "--base-fee", "0", "--prune-history", "4", "--transaction-block-keeper", "16"], { stdio: "ignore" });
    cleanups.push(() => anvil.kill("SIGKILL"));
    for (let i = 0; i < 120; i++){ try { await rpc("eth_chainId", []); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
    // the TEST's own key: it deploys the repository's ledger/factory/catalog and publishes an app - never in the page
    driver = privateKeyToAccount(generatePrivateKey());
    await rpc("anvil_setBalance", [driver.address, "0x56bc75e2d63100000"]);
    await rpc("anvil_impersonateAccount", [driver.address]);
    pc = viem.createPublicClient({ chain, transport: viem.http(rpcUrl) });
    const { stdout } = await run("node", [path.join(REPO, "test/helpers/fork-deploy.mjs"), rpcUrl, driver.address], { maxBuffer: 1 << 20 });
    const d = JSON.parse(stdout.trim().split("\n").pop());
    ({ factory, ledger, catalog } = d);
    bundler = await startLocalBundler({ rpcUrl, entryPoint: EP, chain, setBalance: (a, v) => rpc("anvil_setBalance", [a, v]) });
    cleanups.push(() => bundler.stop());
    const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
    const PRETTY = { "/": "/index.html", "/dashboard": "/dashboard.html", "/apps": "/apps.html", "/grant": "/grant.html" };
    site = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, "http://x").pathname); p = PRETTY[p] || p;
      const root = p.startsWith("/network/") ? REPO : path.join(REPO, "site"), file = path.join(root, p);
      if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()){ res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" }); fs.createReadStream(file).pipe(res);
    });
    sitePort = await freePort();
    await new Promise((r) => site.listen(sitePort, "127.0.0.1", r)); cleanups.push(() => new Promise((r) => { site.closeAllConnections?.(); site.close(() => r()); }));
    const profile = { format: "enclave-browser-profile", version: 1, name: "local Base fork", chainId: 8453, rpcs: [rpcUrl, rpcUrl.replace("127.0.0.1", "localhost")], quorum: 2,
      confirmations: 0, maxBlockAgeSeconds: 86400,
      contractPins: { version: 1, chainId: 8453, contracts: { registry: d.registry, deployments: ledger, appCatalog: catalog, proofOfTime: ledger, enclavePay: "0x" + "00".repeat(20),
        verificationFees: "0x" + "00".repeat(20), sessionVaultFactory: factory, secretVaultV2: "0x" + "00".repeat(20) } }, usdc: USDC.toLowerCase(), ethUsdFeed: d.feed };
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
const waitText = async (sel, re, timeout = 60000) => {
  try { await page.waitForFunction(({ sel, src }) => new RegExp(src).test(document.querySelector(sel)?.textContent || ""), { sel, src: re.source }, { timeout }); }
  catch (e){ throw new Error(e.message + "\nwaiting in " + sel + " for " + re + "\nfound: " + await page.locator(sel).first().textContent().catch(() => "?") + "\nbody tail: " + (await page.locator("body").textContent().catch(() => "")).slice(-500)); }
};
const SAFE_ABI = viem.parseAbi(["function getOwners() view returns (address[])", "function getThreshold() view returns (uint256)"]);
const SHARED_ABI = [{ type: "function", name: "getConfiguration", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "tuple", components: [{ name: "x", type: "uint256" }, { name: "y", type: "uint256" }, { name: "verifiers", type: "uint176" }] }] }];
const UOE = viem.parseAbiItem("event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)");
const acct = {};
// a poll from the next block is empty until that block exists (anvil refuses a range beyond its head)
const logsAfter = async (args) => (args.fromBlock > await pc.getBlockNumber() ? [] : pc.getLogs(args));

test("account-first: a passkey account creates itself through its own bundler with its own ETH - no wallet anywhere", { skip, timeout: 420000 }, async () => {
  ready();
  assert.equal(await page.evaluate(() => typeof window.ethereum), "undefined", "no wallet in this browser");
  assert.equal(await page.evaluate(async () => (await import("/js/core/config.js")).INDEPENDENT.state), "on");
  await page.waitForSelector(".acct-panel", { timeout: 60000 });
  assert.equal(new URL(page.url()).pathname, "/dashboard", "the dashboard stays usable without a wallet");
  await page.locator(".acct-panel > summary").click();
  await page.locator(".acct-label").fill("laptop");
  await page.locator(".acct-shared").check();
  await page.locator(".acct-create").click();
  await waitStatus(/passkey created under localhost/);
  const recovery = privateKeyToAccount(generatePrivateKey()).address;
  await page.locator(".acct-raddr").fill(recovery);
  await page.locator(".acct-radd").click();
  assert.match(await page.locator(".acct-caps").textContent(), /laptop is the account's built-in signer/);
  await page.locator(".acct-compute").click();
  await waitStatus(/your account address: 0x[0-9a-f]{40} \(not deployed yet\)/);
  const safe = /your account address: (0x[0-9a-f]{40})/.exec(await status())[1];
  await page.locator(".acct-save").click();
  await page.waitForSelector(".acct-summary");
  // the owner's own bundler, then the explicit choice that the account pays its own gas
  await page.locator(".acct-transport").click();
  await page.locator(".acct-tr-b").fill(bundler.url);
  await page.locator(".acct-tr-save").click();
  await page.waitForSelector(".acct-gas-account:not([disabled])");
  assert.equal(await page.locator(".acct-gas-account").isChecked(), false, "no silent default: a transport alone is not a choice");
  await page.locator(".acct-gas-account").check();
  await waitStatus(/gas: the account pays its own, through your bundler/);
  // gas is not free: with no ETH at its address, deploying is refused before any passkey prompt, naming the amount
  await page.locator(".acct-deploy").click();
  await waitStatus(/your account needs up to [0-9.]+ ETH for this operation's gas and holds 0\.000000\. Send ETH to 0x[0-9a-f]{40} from anywhere first; nothing was signed/);
  assert.equal(await rpc("eth_getCode", [safe, "latest"]), "0x"); assert.equal(bundler.received.length, 0);
  // the owner sends ETH to the counterfactual address (from anywhere; here: local fork state)
  await rpc("anvil_setBalance", [safe, viem.toHex(5n * 10n ** 16n)]);
  const b0 = await pc.getBlockNumber();
  await page.locator(".acct-deploy").click();
  await waitStatus(/creating your account confirmed by the EntryPoint in 0x[0-9a-f]{64} \(gas [0-9.]+ ETH, paid by the account\)/, 90000);
  // the chain: created by its own operation, exactly the described owners, key, module, handler and EntryPoint
  assert.notEqual(await rpc("eth_getCode", [safe, "latest"]), "0x");
  assert.equal(bundler.received.length, 1); assert.ok(bundler.received[0].factory, "the first operation carried the account's creation");
  const ev = await pc.getLogs({ address: EP, event: UOE, args: { sender: safe }, fromBlock: b0 + 1n });
  assert.equal(ev.length, 1); assert.equal(ev[0].args.success, true); assert.equal(ev[0].args.paymaster, "0x0000000000000000000000000000000000000000", "no paymaster: the account paid");
  assert.ok((await pc.getBalance({ address: safe })) < 5n * 10n ** 16n, "the account's own ETH paid the gas");
  const owners = (await pc.readContract({ address: safe, abi: SAFE_ABI, functionName: "getOwners" })).map((a) => a.toLowerCase());
  assert.deepEqual(owners, [SHARED, recovery.toLowerCase()]);
  assert.equal(await pc.readContract({ address: safe, abi: SAFE_ABI, functionName: "getThreshold" }), 1n);
  const cfg = await pc.readContract({ address: SHARED, abi: SHARED_ABI, functionName: "getConfiguration", args: [safe] });
  assert.ok(cfg.x > 0n && cfg.verifiers === 0x100n << 160n, "the passkey lives in the account's own storage");
  // the description verifies against the deployed account, and becomes the identity
  await page.locator(".acct-verify").click(); await waitStatus(/matches the chain at block \d+/);
  await page.locator(".acct-use").click();
  await waitStatus(/the dashboard now acts as your passkey account/);
  await waitText(".id-bar", /Acting as passkey account 0x[0-9a-f]{6}…[0-9a-f]{6} · gas paid by the account itself, through your bundler/);
  Object.assign(acct, { safe, recovery, x: cfg.x });
});

test("the account as identity, paying its own gas: a session, the Apps deploy dialog, a row action - every transaction through its own bundler", { skip, timeout: 420000 }, async () => {
  ready(); assert.ok(acct.safe);
  const { safe } = acct;
  // Start a session from the session controls: the passkey signs the grant as the Safe (ERC-1271 through the shared
  // signer) and approves the user operation that sends openFor
  await page.waitForFunction(() => /Account session:<\/b> none/.test(document.querySelector(".ind-sess")?.innerHTML || ""), null, { timeout: 60000 });
  await page.locator(".ind-s-open").click();
  await page.locator("#smBudget").fill("0");
  assert.equal(await page.locator("#smGo").textContent(), "Approve with passkey");
  await page.locator("#smGo").click();
  await page.waitForFunction(() => /Account session<\/b> live/.test(document.querySelector(".ind-sess")?.innerHTML || ""), null, { timeout: 120000 });
  const vault = (await pc.readContract({ address: factory, abi: viem.parseAbi(["function vaultFor(address) view returns (address)"]), functionName: "vaultFor", args: [safe] })).toLowerCase();
  assert.equal((await pc.readContract({ address: vault, abi: viem.parseAbi(["function owner() view returns (address)"]), functionName: "owner" })).toLowerCase(), safe);
  // the Apps deploy dialog: a fee-free app (published by the test's own key), created by the account's session
  const pub = await viem.createWalletClient({ chain, account: driver, transport: viem.http(rpcUrl) }).writeContract({ address: catalog,
    abi: viem.parseAbi(["function publishVersion(string slug,string name,string description,string version,string cid,uint32[4] res,string ports,string config,uint256 feePerSec6) returns (bytes32,uint256)"]),
    functionName: "publishVersion", args: ["af-app", "Account-first app", "", "1.0.0", "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbaf1", [0, 0, 64, 1], "", "", 0n], gas: 3_000_000n });
  const prc = await pc.waitForTransactionReceipt({ hash: pub });
  const appId = viem.parseEventLogs({ abi: viem.parseAbi(["event VersionPublished(bytes32 indexed appId, uint256 indexed index, string version, string cid)"]), logs: prc.logs })[0].args.appId;
  const CREATED = viem.parseAbiItem("event Created(bytes32 indexed id, address indexed owner, string appRef, uint16 gpuMilli, uint16 cpuMilli, uint256 rate)");
  const b1 = await pc.getBlockNumber();
  // the bundler under-estimates the call gas (what made deploy.create revert ExecutionFailed() = 0xacfdb444 after paying gas):
  // the page's own measurement of the account's call must carry it
  bundler.underestimateCallGas = true;
  await page.goto(url("/apps?app=" + appId));
  await page.locator('#appDetailView [data-act="deploy"]').first().click({ timeout: 60000 });
  await page.waitForSelector(".qd-cap");
  await page.locator(".qd-cap").fill("0.36");
  await page.locator("#qdAmt").fill("0");
  const tos = page.locator(".qd-tosck"); if (!(await tos.isChecked())) await tos.check();
  await page.locator(".qd-go").click();
  let created = [];
  for (let i = 0; i < 240 && !created.length; i++){ created = await logsAfter({ address: ledger, event: CREATED, fromBlock: b1 + 1n }); if (!created.length) await new Promise((r) => setTimeout(r, 500)); }
  if (created.length !== 1){
    const diag = await page.evaluate(() => ({ url: location.href, runlog: [...document.querySelectorAll(".enc-live-out, .term")].map((e) => e.textContent).join("\n---\n").slice(-2500),
      dialog: document.querySelector(".qd-card") ? { go: document.querySelector(".qd-go")?.disabled, note: document.querySelector(".qd-note")?.textContent, bal: document.querySelector(".qd-balv")?.textContent } : null,
      toast: document.querySelector("c-toast, .toast")?.textContent || "" }));
    throw new Error("no record created: " + JSON.stringify(diag, null, 1) + "\nconsole: " + JSON.stringify(consoleLines.slice(-15)) + "\npage errors: " + JSON.stringify(pageErrors));
  }
  bundler.underestimateCallGas = false;
  assert.equal(created[0].args.owner.toLowerCase(), vault, "held by the account's session vault");
  assert.ok(!consoleLines.some((l) => /independent-mode:/.test(l)), "independent mode never fetches the hosted fleet table");
  const ctx = await pc.getTransaction({ hash: created[0].transactionHash });
  assert.equal(ctx.from.toLowerCase(), bundler.key.toLowerCase(), "submitted by the owner's bundler"); assert.equal(ctx.to.toLowerCase(), EP);
  Object.assign(acct, { vault, appId, id: created[0].args.id.toLowerCase() });
  // a row action (Suspend) through the session, again a user operation of the account
  const ACTIVE = viem.parseAbiItem("event ActiveSet(bytes32 indexed id, bool active)");
  await page.goto(url("/dashboard"));
  await page.waitForFunction((x) => [...document.querySelectorAll("c-deployments .enc-row [data-id]")].some((e) => e.dataset.id.toLowerCase() === x), acct.id, { timeout: 90000 });
  const b2 = await pc.getBlockNumber();
  await page.locator(`.enc-kill[data-id="${acct.id}"]`).click();
  let act = [];
  for (let i = 0; i < 240 && !act.length; i++){ act = await logsAfter({ address: ledger, event: ACTIVE, args: { id: acct.id }, fromBlock: b2 + 1n }); if (!act.length) await new Promise((r) => setTimeout(r, 500)); }
  assert.equal(act[0].args.active, false);
  assert.equal((await pc.getTransaction({ hash: act[0].transactionHash })).from.toLowerCase(), bundler.key.toLowerCase());
});

test("an outcome the bundler holds back: unknown, blocks the next operation, never resent; then confirmed from the EntryPoint's own event", { skip, timeout: 480000 }, async () => {
  ready(); assert.ok(acct.id);
  bundler.mode = "hold";
  const n0 = bundler.received.length;
  await page.locator(`.enc-resume[data-id="${acct.id}"]`).click();
  await page.waitForFunction(() => /has no outcome for it yet .*not resent/.test(document.body.textContent || ""), null, { timeout: 200000 });
  assert.equal(bundler.received.length, n0 + 1, "delivered once");
  const pend = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), "enclave_account_pending:v1:8453:" + acct.safe);
  assert.ok(pend && /^0x[0-9a-f]{64}$/.test(pend.userOpHash));
  // another operation is refused before any signing while that outcome is unknown
  const err = await page.evaluate(async (id) => { const { encCall, DEP_SEL } = await import("/js/core/chain.js"); const S = await import("/js/core/sessions.js");
    try { await S.ledgerSend(encCall(DEP_SEL.setActive, [{ t: "bytes32", v: id }, { t: "uint", v: 0 }]), () => { throw new Error("WALLET FALLBACK"); }); return "sent"; } catch (e){ return e.message; } }, acct.id);
  assert.match(err, /has no outcome on chain yet: check it before sending another\. Nothing was signed/);
  assert.equal(bundler.received.length, n0 + 1, "never resent");
  // the account panel checks it: still pending, nothing resent
  await page.locator(".acct-pending").click();
  await waitStatus(/still has no outcome on chain at block \d+: nothing is resent/);
  // the bundler finally submits it: the panel reads the EntryPoint's event and clears it
  assert.equal(await bundler.release(), 1);
  bundler.mode = "submit";
  await page.locator(".acct-pending").click();
  await waitStatus(/\[✓\] .* succeeded in 0x[0-9a-f]{64}/);
  assert.equal(await page.evaluate((k) => localStorage.getItem(k), "enclave_account_pending:v1:8453:" + acct.safe), null);
  const ACTIVE = viem.parseAbiItem("event ActiveSet(bytes32 indexed id, bool active)");
  const last = (await logsAfter({ address: ledger, event: ACTIVE, args: { id: acct.id }, fromBlock: FORK_BLOCK + 1n })).at(-1);
  assert.equal(last.args.active, true, "the held Resume executed exactly once");
  assert.equal(bundler.received.length, n0 + 1);
});

test("/grant under the account: Sign only is handed to a SEPARATE gas payer and checked exactly; Approve and open goes through the account's own bundler", { skip, timeout: 300000 }, async () => {
  ready(); assert.ok(acct.safe);
  const { safe } = acct;
  const cli = async (...args) => JSON.parse((await run("node", [path.join(REPO, "test/helpers/grant-cli.mjs"), ...args], { maxBuffer: 1 << 20 })).stdout.trim().split("\n").pop());
  // 1) Sign only: the passkey signs as the Safe; the page simulates openFor and hands the signature back; nothing is sent from the page
  const req = await cli("request", rpcUrl, "8453", url(""), safe);
  tmpDirs.push(req.dir);
  const n0 = bundler.received.length;
  await page.goto(req.link);
  await waitText(".gr-code", new RegExp("^" + req.checkCode + "$"));
  await waitText(".gr-origin", new RegExp("^" + url("").replace(/[.:/]/g, "\\$&") + "$"));
  assert.equal((await page.locator(".gr-vault").textContent()).toLowerCase(), acct.vault, "the pinned factory's vault for the ACCOUNT");
  assert.match(await page.locator(".gr-acct").textContent(), /safe-passkey 1\.4\.1 · 2 owner\(s\), 1 passkey\(s\), threshold 1/);
  await page.locator("#grSign").click();
  await waitText(".gr-sig", /login --owner-signature 0x[0-9a-f]+ --owner 0x[0-9a-f]{40}/);
  const [, sig, owner] = /--owner-signature (0x[0-9a-f]+) --owner (0x[0-9a-f]{40})/.exec(await page.locator(".gr-sig").textContent());
  assert.equal(owner.toLowerCase(), safe); assert.equal(bundler.received.length, n0, "Sign only sends nothing");
  const payer = generatePrivateKey();
  await rpc("anvil_setBalance", [privateKeyToAccount(payer).address, "0xde0b6b3a7640000"]);
  const sub = await cli("submit", rpcUrl, factory, req.grant, sig, safe, payer);
  assert.equal(sub.from.toLowerCase(), privateKeyToAccount(payer).address.toLowerCase(), "a separate gas payer submitted it");
  assert.equal(sub.vault.toLowerCase(), acct.vault); assert.equal(sub.vaultOwner.toLowerCase(), safe, "the session belongs to the account");
  assert.equal(sub.live, true); assert.equal(sub.mismatch, null, "the vault holds exactly the grant's policy (the CLI login helper's rule)");
  // 2) a request for another owner is refused before anything is signed
  const other = await cli("request", rpcUrl, "8453", url(""), "0x" + "5b".repeat(20));
  tmpDirs.push(other.dir);
  await page.goto(other.link);
  await waitText("#grBody", /This request is for account 0x5b5b.*but you are acting as 0x[0-9a-f]{40}/);
  assert.equal(await page.locator("#grSign").count(), 0);
  // 3) Approve and open, with the account paying its own gas through its bundler
  const req2 = await cli("request", rpcUrl, "8453", url(""), safe);
  tmpDirs.push(req2.dir);
  await page.goto(req2.link);
  await waitText(".gr-code", new RegExp("^" + req2.checkCode + "$"));
  await page.locator("#grOpen").click();
  await waitText("#grBody", /Session approved and open/, 120000);
  assert.equal(bundler.received.length, n0 + 1, "one user operation from the account");
  assert.deepEqual(pageErrors.filter((e) => !/ResizeObserver/.test(e)), []);
  assert.ok(!requests.some((u) => /enclave\.host/.test(new URL(u).hostname)), "no Enclave origin");
});

test("account-first with an owner-chosen paymaster (ERC-7677): an account with NO ETH creates itself; the named paymaster pays from its EntryPoint deposit", { skip, timeout: 300000 }, async () => {
  ready();
  await page.goto(url("/dashboard"));
  await page.waitForSelector(".acct-panel", { timeout: 60000 });
  if (await page.locator(".acct-forget").count()) await page.locator(".acct-forget").click();   // a second, separate account on this browser
  await page.waitForSelector(".acct-panel > summary");
  if (!(await page.locator(".acct-create").isVisible())) await page.locator(".acct-panel > summary").click();   // no account yet: the panel starts closed
  await page.waitForSelector(".acct-create");
  await page.locator(".acct-label").fill("phone");
  await page.locator(".acct-shared").check();
  await page.locator(".acct-create").click();
  await waitStatus(/passkey created under localhost/);
  await page.locator(".acct-compute").click();
  await waitStatus(/your account address: 0x[0-9a-f]{40} \(not deployed yet\)/);
  const safe = /your account address: (0x[0-9a-f]{40})/.exec(await status())[1];
  if (acct.safe) assert.notEqual(safe, acct.safe);
  await page.locator(".acct-save").click();
  await page.waitForSelector(".acct-summary");
  // the owner's paymaster: a TEST-ONLY sponsor for exactly this account, funded at the EntryPoint by the test's own key
  const { paymaster } = JSON.parse((await run("node", [path.join(REPO, "test/helpers/test-paymaster.mjs"), rpcUrl, EP, safe, driver.address, String(10n ** 17n)])).stdout.trim().split("\n").pop());
  bundler.paymaster = paymaster;
  const EPA = viem.parseAbi(["function balanceOf(address) view returns (uint256)"]);
  const dep0 = await pc.readContract({ address: EP, abi: EPA, functionName: "balanceOf", args: [paymaster] });
  await page.locator(".acct-transport").click();
  await page.locator(".acct-tr-b").fill(bundler.url);
  await page.locator(".acct-tr-k").selectOption("verifying");
  await page.locator(".acct-tr-a").fill(paymaster);
  await page.locator(".acct-tr-u").fill(bundler.url.replace(/\/rpc$/, "/pm"));
  await page.locator(".acct-tr-save").click();
  await page.waitForSelector(".acct-gas-account:not([disabled])");
  await page.locator(".acct-gas-account").check();
  assert.equal(await pc.getBalance({ address: safe }), 0n, "the account holds no ETH at all");
  const b0 = await pc.getBlockNumber(), pm0 = bundler.pmCalls.length;
  await page.locator(".acct-deploy").click();
  await waitStatus(new RegExp("creating your account confirmed by the EntryPoint in 0x[0-9a-f]{64} \\(gas [0-9.]+ ETH, paid by your paymaster " + paymaster.slice(0, 8) + "…" + paymaster.slice(-6) + "\\)"), 90000);
  assert.notEqual(await rpc("eth_getCode", [safe, "latest"]), "0x");
  assert.equal(await pc.getBalance({ address: safe }), 0n, "still no ETH: it paid nothing");
  const ev = await pc.getLogs({ address: EP, event: UOE, args: { sender: safe }, fromBlock: b0 + 1n });
  assert.equal(ev.length, 1); assert.equal(ev[0].args.success, true); assert.equal(ev[0].args.paymaster.toLowerCase(), paymaster);
  assert.ok((await pc.readContract({ address: EP, abi: EPA, functionName: "balanceOf", args: [paymaster] })) < dep0, "the paymaster's deposit paid");
  assert.deepEqual(bundler.pmCalls.slice(pm0), ["pm_getPaymasterStubData", "pm_getPaymasterData"], "stub for the estimate, final data for the exact limits");
  const owners = (await pc.readContract({ address: safe, abi: SAFE_ABI, functionName: "getOwners" })).map((a) => a.toLowerCase());
  assert.deepEqual(owners, [SHARED]);
  await page.locator(".acct-verify").click(); await waitStatus(/matches the chain at block \d+/);
  assert.deepEqual(pageErrors.filter((e) => !/ResizeObserver/.test(e)), []);
});
