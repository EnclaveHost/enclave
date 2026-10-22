// The passkey account panel (site/js/core/account-ui.js) in a real headless Chromium with Chrome's virtual authenticator
// (CDP WebAuthn: CTAP2, internal, resident key, user verification) against the PINNED deployed Safe / passkey signer /
// 4337 module / USDC code on an anvil fork of Base (block 52,836,800, --optimism for RIP-7212). Only the repository's ledger
// and pinned session factory are deployed locally. The connected wallet is a fresh, locally-impersonated gas payer: it owns
// nothing. Flow through the real UI: create a passkey -> add a recovery key -> compute + save the account -> deploy (signer +
// Safe) -> sign in = open a session the Safe owns, approved by the passkey (ERC-1271) and simulated before submission. Then the
// account as the dashboard identity (explicit, re-verified on load): its rows only, a create held by its vault, row actions
// through its session and through Safe transactions its passkey approves, a refused stale description, and back to the wallet.
// Run under the allocation:
//   node test/helpers/memory-guard.mjs --max-rss-mib 1024 --floor-available-mib 16384 -- node --max-old-space-size=160 test/site-independent-passkey-ui.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as viem from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { walletScript } from "./helpers/independent-browser-rig.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(new URL("../e2e/package.json", import.meta.url));
let chromium = null; try { ({ chromium } = require("playwright")); } catch {}
const haveAnvil = (() => { try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = (!haveAnvil && "needs anvil") || (!chromium && "needs Playwright's Chromium");
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const FORK_BLOCK = 52836800n;
const chain = { id: 8453, name: "base-fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } };

let rpcUrl, pc, wc, payer, site, sitePort, browser, page, factory, sessionOfAbi, ledger, catalog, feed, setupError = null;
const acct = {};          // the account the first test creates: { safe, vault }
const cleanups = [], pageErrors = [], requests = [], consoleLines = [];
const cleanup = async () => { while (cleanups.length) { try { await cleanups.pop()(); } catch {} } };
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const rpc = async (method, params) => { const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; };
const ready = () => { if (setupError) throw new Error("setup failed: " + setupError.message); };

test.before(async () => {
  if (skip) return;
  const watchdog = setTimeout(() => { console.error("passkey-ui: watchdog"); cleanup().finally(() => process.exit(1)); }, 9 * 60 * 1000); watchdog.unref();
  try {
    const port = await freePort(); rpcUrl = `http://127.0.0.1:${port}`;
    const anvil = spawn("anvil", ["--port", String(port), "--fork-url", process.env.BASE_FORK_RPC || "https://mainnet.base.org", "--fork-block-number", String(FORK_BLOCK), "--optimism", "--silent", "--base-fee", "0",
      "--prune-history", "4", "--transaction-block-keeper", "16"], { stdio: "ignore" });   // bounded anvil memory: only recent block states are kept
    cleanups.push(() => anvil.kill("SIGKILL"));
    for (let i = 0; i < 120; i++){ try { await rpc("eth_chainId", []); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
    // a fresh gas payer, unlocked locally (it owns nothing; it only pays gas)
    payer = privateKeyToAccount(generatePrivateKey());
    await rpc("anvil_setBalance", [payer.address, "0x56bc75e2d63100000"]);
    await rpc("anvil_impersonateAccount", [payer.address]);
    pc = viem.createPublicClient({ chain, transport: viem.http(rpcUrl) });
    wc = viem.createWalletClient({ chain, account: payer, transport: viem.http(rpcUrl) });
    // the repository's ledger + pinned session factory, deployed by a short-lived helper process (artifacts never load here)
    const { stdout } = await promisify(execFile)("node", [path.join(REPO, "test/helpers/fork-deploy.mjs"), rpcUrl, payer.address], { maxBuffer: 1 << 20 });
    const { registry } = JSON.parse(stdout.trim().split("\n").pop());
    ({ factory, sessionOfAbi, ledger, catalog, feed } = JSON.parse(stdout.trim().split("\n").pop()));
    // the unbundled site on localhost (a secure context, so WebAuthn works)
    const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
    const PRETTY = { "/": "/index.html", "/dashboard": "/dashboard.html", "/apps": "/apps.html" };
    site = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, "http://x").pathname); p = PRETTY[p] || p;
      const root = p.startsWith("/network/") ? REPO : path.join(REPO, "site"), file = path.join(root, p);
      if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()){ res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" }); fs.createReadStream(file).pipe(res);
    });
    const sport = sitePort = await freePort();
    await new Promise((r) => site.listen(sport, "127.0.0.1", r)); cleanups.push(() => new Promise((r) => { site.closeAllConnections?.(); site.close(() => r()); }));
    const profile = { format: "enclave-browser-profile", version: 1, name: "local Base fork", chainId: 8453, rpcs: [rpcUrl, rpcUrl.replace("127.0.0.1", "localhost")], quorum: 2,
      confirmations: 0, maxBlockAgeSeconds: 86400,                       // the dashboard's validated maximum
      contractPins: { version: 1, chainId: 8453, contracts: { registry, deployments: ledger, appCatalog: catalog, proofOfTime: ledger, enclavePay: "0x" + "00".repeat(20),
        verificationFees: "0x" + "00".repeat(20), sessionVaultFactory: factory, secretVaultV2: "0x" + "00".repeat(20) } }, usdc: USDC.toLowerCase(), ethUsdFeed: feed };
    // lean Chromium for the memory allocation: no GPU process, one renderer, no extra site-isolation processes (the page has
    // no cross-origin frames), network and audio services inside the browser process, a capped V8 heap
    browser = await chromium.launch({ args: ["--disable-gpu", "--disable-dev-shm-usage", "--renderer-process-limit=1", "--disable-extensions",
      "--disable-features=site-per-process,IsolateOrigins,Translate,OptimizationHints,MediaRouter,AudioServiceOutOfProcess",
      "--enable-features=NetworkServiceInProcess,NetworkServiceInProcess2", "--js-flags=--max-old-space-size=192"] });
    cleanups.push(() => browser.close());
    const context = await browser.newContext({ reducedMotion: "reduce" });
    await context.route((u) => /(^|\.)enclave\.host$/i.test(u.hostname), (r) => r.abort("blockedbyclient"));
    context.on("request", (r) => requests.push(r.url()));
    await context.addInitScript({ content: walletScript({ rpc: rpcUrl, address: payer.address }) });
    const text = JSON.stringify(profile);
    await context.addInitScript(({ address, text }) => {
      if (!localStorage.getItem("enclave_session")) localStorage.setItem("enclave_session", JSON.stringify({ address, rdns: "test.local.wallet" }));
      localStorage.setItem("enclave_independent_profile", text); sessionStorage.setItem("enclave_independent_ack", text);
    }, { address: payer.address, text });
    page = await context.newPage(); page.setDefaultTimeout(60000);
    page.on("pageerror", (e) => pageErrors.push(String(e && e.message || e)));
    page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") consoleLines.push(m.type() + ": " + m.text()); });
    page.on("dialog", (d) => d.accept());
    // Chrome's virtual authenticator (no OS prompt, no real key): CTAP2, platform, resident keys, user verification
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(`http://localhost:${sport}/dashboard`);
  } catch (e){ setupError = e; await cleanup(); throw e; }
});
test.after(cleanup);

const status = () => page.locator(".acct-status").textContent();
// on a timeout, say what the panel said instead (the status text, page errors and console warnings)
const waitStatus = async (re) => {
  try { await page.waitForFunction((src) => new RegExp(src).test(document.querySelector(".acct-status")?.textContent || ""), re.source); }
  catch (e){ throw new Error(e.message + "\nwaiting for " + re + "\nstatus: " + await status().catch(() => "?") + "\npage errors: " + JSON.stringify(pageErrors) + "\nconsole: " + JSON.stringify(consoleLines.slice(-20))); }
};

test("through the real panel: a passkey (virtual authenticator) + a recovery key -> a Safe deployed by a gas payer -> sign in opens a session the Safe owns", { skip, timeout: 420000 }, async () => {
  ready();
  assert.equal(await page.evaluate(async () => (await import("/js/core/config.js")).INDEPENDENT.state), "on", "the profile is accepted by the dashboard");
  await page.waitForSelector(".acct-panel", { timeout: 60000 });
  await page.locator(".acct-panel > summary").click();
  await page.locator(".acct-label").fill("laptop");
  assert.equal(await page.locator(".acct-rp").inputValue(), "localhost", "the RP is this site's, shown and editable");
  await page.locator(".acct-create").click();
  await waitStatus(/passkey created under localhost/);
  const recovery = privateKeyToAccount(generatePrivateKey()).address;
  await page.locator(".acct-raddr").fill(recovery);
  await page.locator(".acct-radd").click();
  const caps = await page.locator(".acct-caps").textContent();
  assert.match(caps, /2 owner\(s\): 1 passkey\(s\) under 1 RP id\(s\) \(localhost\), 1 recovery key\(s\); 1 of 2/);
  assert.match(caps, /Every passkey is under localhost/); assert.match(caps, /Any single owner controls the account alone/);
  await page.locator(".acct-compute").click();
  await waitStatus(/your account address: 0x[0-9a-f]{40} \(not deployed yet\)/);
  const safe = /your account address: (0x[0-9a-f]{40})/.exec(await status())[1];
  await page.locator(".acct-save").click();
  await page.waitForSelector(".acct-summary", { timeout: 30000 });
  assert.equal((await page.locator(".acct-summary").textContent()).trim(), safe);
  // deploy: the signer and the Safe, each sent by the connected wallet as a mere gas payer
  await page.locator(".acct-deploy").click();
  await page.waitForSelector(".acct-call");
  assert.equal(await page.locator(".acct-call").count(), 2);
  await page.locator(".acct-send").nth(0).click(); await waitStatus(/create the signer for passkey laptop confirmed/);
  await page.locator(".acct-send").nth(1).click(); await waitStatus(/create the account confirmed/);
  assert.notEqual(await rpc("eth_getCode", [safe, "latest"]), "0x");
  const owners = await pc.readContract({ address: safe, abi: viem.parseAbi(["function getOwners() view returns (address[])"]), functionName: "getOwners" });
  assert.equal(owners.length, 2); assert.ok(owners.map((o) => o.toLowerCase()).includes(recovery.toLowerCase()));
  assert.ok(!owners.map((o) => o.toLowerCase()).includes(payer.address.toLowerCase()), "the gas payer owns nothing");
  await page.locator(".acct-verify").click(); await waitStatus(/matches the chain at block \d+/);
  // sign in: one passkey approval (threshold 1), simulated by the vault before anything is sent, then opened by the gas payer
  await page.locator(".acct-signin").click();
  await waitStatus(/the session vault accept/);
  await page.locator(".acct-send").click();
  await waitStatus(/session 0x[0-9a-f]{6}…[0-9a-f]{6} is live in vault 0x[0-9a-fA-F]{6}…[0-9a-fA-F]{6}\. It belongs to your passkey account\./);
  const vault = await pc.readContract({ address: factory, abi: viem.parseAbi(["function vaultFor(address) view returns (address)"]), functionName: "vaultFor", args: [safe] });
  const vOwner = await pc.readContract({ address: vault, abi: viem.parseAbi(["function owner() view returns (address)"]), functionName: "owner" });
  assert.equal(vOwner.toLowerCase(), safe.toLowerCase(), "the session vault belongs to the passkey account");
  const logs = await pc.getLogs({ address: vault, event: viem.parseAbiItem("event SessionOpened(bytes32 indexed sid, bytes32 indexed keyHash, uint64 expiresAt, uint256 actions, uint8 envs, uint256 budget6, string label)"), fromBlock: FORK_BLOCK + 1n });   // local blocks only: an earlier range is fetched from the public upstream
  assert.equal(logs.length, 1);
  const [, live] = await pc.readContract({ address: vault, abi: sessionOfAbi, functionName: "sessionOf", args: [logs[0].args.sid] });
  assert.equal(live, true, "the session is live on chain");
  assert.deepEqual(pageErrors.filter((e) => !/ResizeObserver/.test(e)), []);
  assert.ok(!requests.some((u) => /enclave\.host/.test(new URL(u).hostname)), "no Enclave origin");
  Object.assign(acct, { safe: safe.toLowerCase(), vault: vault.toLowerCase() });
});

const ZERO = "0x" + "00".repeat(20);
const LEDGER = viem.parseAbi([
  "function create(string appRef,uint16 gpuMilli,uint16 cpuMilli,uint32 appPort,string ports,bool isPublic,string configCid,address feeRecipient,uint256 feePerSec6,uint256 maxRate6) returns (bytes32)",
  "function transferDeployment(bytes32 id,address to)",
  "event Created(bytes32 indexed id, address indexed owner, string appRef, uint16 gpuMilli, uint16 cpuMilli, uint256 rate)",
  "event ActiveSet(bytes32 indexed id, bool active)"]);
const CATALOG = viem.parseAbi(["function publishVersion(string slug,string name,string description,string version,string cid,uint32[4] res,string ports,string config,uint256 feePerSec6) returns (bytes32 appId,uint256 index)",
  "event VersionPublished(bytes32 indexed appId, uint256 indexed index, string version, string cid)"]);
const CREATED = LEDGER.find((x) => x.name === "Created"), ACTIVE_SET = LEDGER.find((x) => x.name === "ActiveSet");
// the driver's own setup transactions (the payer key is fresh and local to this fork)
const send = async (to, abi, functionName, args) => {
  const h = await wc.writeContract({ address: to, abi, functionName, args, gas: 3_000_000n });
  const r = await pc.waitForTransactionReceipt({ hash: h }); assert.equal(r.status, "success", functionName); return r;
};
const createdIn = (r) => viem.parseEventLogs({ abi: LEDGER, logs: r.logs, eventName: "Created" })[0].args.id.toLowerCase();
const listedIds = () => page.evaluate(() => [...new Set([...document.querySelectorAll("c-deployments .enc-row [data-id]")].map((e) => e.dataset.id.toLowerCase()))]);
const waitListed = (id) => page.waitForFunction((x) => [...document.querySelectorAll("c-deployments .enc-row [data-id]")].some((e) => e.dataset.id.toLowerCase() === x), id);
const waitBar = (re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector(".id-bar")?.textContent || ""), re.source);
async function waitSuspended(id, fromBlock){
  for (let i = 0; i < 120; i++){
    const l = (await pc.getLogs({ address: ledger, event: ACTIVE_SET, args: { id }, fromBlock })).find((x) => x.args.active === false);
    if (l) return pc.getTransaction({ hash: l.transactionHash });
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("no ActiveSet(" + id + ", false); status: " + await page.locator(".acct-status").textContent().catch(() => "?"));
}
const short = (a) => String(a).slice(0, 8) + "…" + String(a).slice(-6);

test("the passkey account as the dashboard identity: explicit + verified, its rows only, create and row actions as the account, the wallet only pays", { skip, timeout: 480000 }, async () => {
  ready();
  assert.ok(acct.safe, "needs the account from the first test");
  const { safe, vault } = acct, me = payer.address.toLowerCase();
  // a fee-free app on the fork's catalog; a record the WALLET holds; and one the SAFE holds (created by the wallet, then transferred)
  const pub = await send(catalog, CATALOG, "publishVersion", ["pk-ui-app", "Passkey UI app", "", "1.0.0", "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", [0, 0, 64, 1], "", "", 0n]);
  const appId = viem.parseEventLogs({ abi: CATALOG, logs: pub.logs, eventName: "VersionPublished" })[0].args.appId, ref = "catalog://" + appId + "/0";
  Object.assign(acct, { appId });
  const walletRow = createdIn(await send(ledger, LEDGER, "create", [ref, 0, 100, 8080, "", true, "", ZERO, 0n, 100n]));
  const safeRow = createdIn(await send(ledger, LEDGER, "create", [ref, 0, 100, 8080, "", true, "", ZERO, 0n, 100n]));
  await send(ledger, LEDGER, "transferDeployment", [safeRow, safe]);

  // 1) explicit selection, verified at one agreed block
  await page.locator(".acct-use").click();
  await waitStatus(/the dashboard now acts as your passkey account 0x[0-9a-f]{6}…[0-9a-f]{6} \(verified at block \d+\)\. Your connected wallet only pays gas\./);
  // 2) a reload re-verifies it before anything is listed; owner and payer are shown apart
  await page.reload();
  await waitBar(/Acting as passkey account/);
  const bar = await page.locator(".id-bar").textContent();
  assert.equal(bar.toLowerCase(), ("Acting as passkey account " + short(safe) + " · gas paid by " + short(me) + " (the payer owns nothing here)").toLowerCase());
  await waitListed(safeRow);
  let ids = await listedIds();
  assert.ok(!ids.includes(walletRow), "the gas payer's own record is not the account's");

  // 3) create from the dashboard's deploy flow: the account's SESSION creates it, so its vault holds it; the wallet pays gas
  const b0 = await pc.getBlockNumber();
  await page.evaluate(async (ref) => (await import("/js/pages/deploy.js")).deployOnChain({ reference: ref, gpuMilli: 0, cpuMilli: 100, ports: "", isPublic: true, fundUsd: 0, maxRate6: "100" }), ref);
  const created = await pc.getLogs({ address: ledger, event: CREATED, fromBlock: b0 + 1n });
  assert.equal(created.length, 1, "one record created; status: " + await page.locator("c-deployments").textContent().then((t) => t.slice(-400)));
  assert.equal(created[0].args.owner.toLowerCase(), vault, "held by the account's session vault, not the wallet");
  const ctx = await pc.getTransaction({ hash: created[0].transactionHash });
  assert.equal(ctx.from.toLowerCase(), me, "the wallet paid the gas"); assert.equal(ctx.to.toLowerCase(), vault, "as a session action on the vault");
  const vaultRow = created[0].args.id.toLowerCase();
  await waitListed(vaultRow);

  // 4) a row action on the vault-held record: the account's session signs, the wallet submits
  const b1 = await pc.getBlockNumber();
  await page.locator(`.enc-kill[data-id="${vaultRow}"]`).click();
  const t1 = await waitSuspended(vaultRow, b1 + 1n);
  assert.equal(t1.from.toLowerCase(), me); assert.equal(t1.to.toLowerCase(), vault, "through the session vault");

  // 5) a row action on the Safe-held record: the passkey approves a Safe transaction (virtual authenticator), the Safe calls
  //    the ledger, the wallet only submits execTransaction
  const b2 = await pc.getBlockNumber();
  await page.locator(`.enc-kill[data-id="${safeRow}"]`).click();
  const t2 = await waitSuspended(safeRow, b2 + 1n);
  assert.equal(t2.from.toLowerCase(), me); assert.equal(t2.to.toLowerCase(), safe, "execTransaction on the Safe");
  assert.equal((await pc.getLogs({ address: ledger, event: ACTIVE_SET, args: { id: walletRow }, fromBlock: b0 })).length, 0, "the payer's own record was never touched");
  assert.equal(await page.evaluate(() => localStorage.getItem("enclave_wallet_session")), null, "the wallet's session pointer was never set");
  assert.ok(await page.evaluate((k) => localStorage.getItem(k), "enclave_account_session:8453:" + safe), "the account's own session pointer");

  // 6) a stale description (threshold 2; the chain says 1): refused on load, nothing listed, nothing sent, no wallet fallback
  await page.evaluate(() => { const k = "enclave_account_profile:v1:8453", p = JSON.parse(localStorage.getItem(k)); p.threshold = 2; localStorage.setItem(k, JSON.stringify(p)); });
  await page.reload();
  await waitBar(/refused/);
  assert.match(await page.locator(".id-bar").textContent(), /refused: the account's owners or threshold on chain differ from this profile \(2 owners, threshold 1\)/);
  await page.waitForFunction(() => /No apps are shown/.test(document.querySelector("c-deployments .enc-body")?.textContent || ""));
  assert.deepEqual(await listedIds(), [], "a refused account lists nothing - and not the wallet's rows either");
  const refusal = await page.evaluate(async (id) => {
    const { encCall, DEP_SEL } = await import("/js/core/chain.js"), S = await import("/js/core/sessions.js");
    try { await S.ledgerSend(encCall(DEP_SEL.setActive, [{ t: "bytes32", v: id }, { t: "uint", v: 1 }]), () => { throw new Error("WALLET FALLBACK"); }); return "sent"; }
    catch (e){ return e.message; }
  }, walletRow);
  assert.match(refusal, /not verified .*nothing was sent/);
  await page.evaluate(() => { const k = "enclave_account_profile:v1:8453", p = JSON.parse(localStorage.getItem(k)); p.threshold = 1; localStorage.setItem(k, JSON.stringify(p)); });

  // 7) "Use my connected wallet": the account's rows vanish and the wallet's own record is listed
  await page.locator(".acct-wallet").click();
  await waitBar(/Acting as your wallet/);
  await waitListed(walletRow);
  ids = await listedIds();
  assert.ok(!ids.includes(safeRow) && !ids.includes(vaultRow), "no row of the account survives the switch");
  assert.deepEqual(pageErrors.filter((e) => !/ResizeObserver/.test(e)), []);
  assert.ok(!requests.some((u) => /enclave\.host/.test(new URL(u).hostname)), "no Enclave origin");
});

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
const usdcOf = (a) => pc.readContract({ address: USDC, abi: viem.erc20Abi, functionName: "balanceOf", args: [a] });
const FUND_AUTH = viem.toFunctionSelector("fundWithAuthorization(bytes32,address,uint256,uint256,uint256,bytes32,bytes)");
const FUNDED = viem.parseAbiItem("event Funded(bytes32 indexed id, address indexed from, uint256 value)");
const VAULT = viem.parseAbi(["function held(bytes32) view returns (uint8 env, bytes32 promoted, bytes32 createdBy)"]);
const heldOf = (vault, id) => pc.readContract({ address: vault, abi: VAULT, functionName: "held", args: [id] });
async function until(fn, what, ms = 90000){
  const t0 = Date.now();
  for (;;){ const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error("timed out waiting for " + what + "; status: " + (await page.locator("body").textContent().catch(() => "?")).slice(-600)); await new Promise((r) => setTimeout(r, 500)); }
}
const logsSince = async (event, from) => (from > await pc.getBlockNumber() ? [] : pc.getLogs({ address: ledger, event, fromBlock: from }));
const createdSince = async (from) => (await logsSince(CREATED, from)).map((l) => ({ id: l.args.id.toLowerCase(), owner: l.args.owner.toLowerCase(), tx: l.transactionHash }));
const fundedSince = async (from) => (await logsSince(FUNDED, from)).map((l) => ({ id: l.args.id.toLowerCase(), from: l.args.from.toLowerCase(), value: l.args.value }));
const rowOf = (id) => page.evaluate(async (id) => { const { row } = await (await import("/js/core/independent-chain.js")).deploymentAt(id); return { owner: row.owner.toLowerCase(), appRef: row.appRef, configCid: row.configCid, balance6: String(row.balance6), active: row.active }; }, id);
const sessText = () => page.locator(".ind-sess").textContent().catch(() => "");
async function openDeployDialog(appId){
  await page.goto(`http://localhost:${sitePort}/apps?app=${appId}`);
  await page.locator('#appDetailView [data-act="deploy"]').first().click({ timeout: 60000 });
  await page.waitForSelector(".qd-cap", { timeout: 60000 });
  await page.locator(".qd-cap").fill("0.36");                              // $0.36/hr = 100 micro-USDC per second
  const tos = page.locator(".qd-tosck"); if (!(await tos.isChecked())) await tos.check();
}

test("owner operations, funding and the Apps quick-deploy dialog under the Safe identity: the account approves and pays, the wallet only submits", { skip, timeout: 900000 }, async () => {
  ready();
  assert.ok(acct.safe && acct.appId, "needs the account and the app from the earlier tests");
  const { safe, vault, appId } = acct, me = payer.address.toLowerCase();
  const start = (await pc.getBlockNumber()) + 1n;
  await fundUsdc(safe, 50_000_000n);
  await rpc("anvil_setBalance", [safe, "0xde0b6b3a7640000"]);               // 1 ETH of the account's own
  assert.equal(await usdcOf(payer.address), 0n, "the gas payer holds no USDC at all");

  // the account as the identity again (the previous test ended on the wallet)
  await page.goto(`http://localhost:${sitePort}/dashboard`);
  await page.locator(".acct-use").click();
  await waitBar(/Acting as passkey account/);
  await page.waitForFunction(() => /Account session<\/b> live/.test(document.querySelector(".ind-sess")?.innerHTML || ""), null, { timeout: 60000 });

  // 1) Add budget from the session controls: the Safe signs the USDC authorization (passkey), the wallet submits
  await page.locator(".ind-s-top").click();
  await page.locator("#tuAmt").fill("3");
  await page.locator("#tuGo").click();
  await page.waitForFunction(() => /\$3\.00 left/.test(document.querySelector(".ind-sess")?.textContent || ""), null, { timeout: 90000 });
  assert.equal(await usdcOf(safe), 47_000_000n, "the budget came from the account's USDC");

  // 2) Extend from the session controls: a signed owner operation (ERC-1271 through the passkey)
  const exp0 = BigInt(await page.evaluate(async () => String((await (await import("/js/core/sessions.js")).sessionStatus()).expiresAt)));
  await page.locator(".ind-s-ext").click();
  await page.locator("#exGo").click();
  await until(async () => BigInt(await page.evaluate(async () => String((await (await import("/js/core/sessions.js")).sessionStatus()).expiresAt))) > exp0 + 3600n, "the extension");

  // 3) the Apps quick-deploy dialog, fee-free app: created by the account's session, funded $1 from the session budget
  let b = await pc.getBlockNumber() + 1n;
  await openDeployDialog(appId);
  assert.match(await page.locator(".qd-card").textContent(), /Your passkey account owns and funds it/);
  await page.waitForFunction(() => /USDC in the account/.test(document.querySelector(".qd-balv")?.textContent || ""), null, { timeout: 30000 });
  assert.match(await page.locator(".qd-balv").textContent(), /\$3\.00 session budget · 47\.00 USDC in the account/);
  await page.locator("#qdAmt").fill("1");
  await page.locator(".qd-go").click();
  const [vRow] = await until(async () => { const c = await createdSince(b); return c.length ? c : null; }, "the dialog's record");
  assert.equal(vRow.owner, vault, "held by the account's session vault");
  const f1 = await until(async () => (await fundedSince(b)).find((f) => f.id === vRow.id), "its funding");
  assert.equal(f1.value, 1_000_000n); assert.equal(f1.from, vault, "funded from the session's budget");
  assert.equal(Number((await heldOf(vault, vRow.id))[0]), 1, "staging");

  // 4) Environment tab: move it to production (a signed owner operation)
  await page.goto(`http://localhost:${sitePort}/dashboard`);
  await waitListed(vRow.id);
  await page.locator(`.enc-envbtn[data-id="${vRow.id}"]`).click();
  await page.waitForFunction(() => /Staging\./.test(document.querySelector(".enc-env:not([hidden])")?.textContent || ""));
  await page.locator(".enc-env-prod").click();
  await until(async () => Number((await heldOf(vault, vRow.id))[0]) === 2, "production");

  // 5) Version tab on the production record: the version change becomes the account's Promote (passkey), never a wallet call
  const pub2 = await send(catalog, CATALOG, "publishVersion", ["pk-ui-app", "Passkey UI app", "", "1.0.1", "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzd2", [0, 0, 64, 1], "", "", 0n]);
  assert.equal(viem.parseEventLogs({ abi: CATALOG, logs: pub2.logs, eventName: "VersionPublished" })[0].args.index, 1n);
  await page.goto(`http://localhost:${sitePort}/dashboard`);
  await waitListed(vRow.id);
  await page.locator(`.enc-upgbtn[data-id="${vRow.id}"]`).click();
  await page.waitForSelector(".eu-sel", { timeout: 60000 });
  await page.locator(".eu-sel").selectOption("1");
  await page.locator(".eu-go").click();
  await until(async () => (await rowOf(vRow.id)).appRef === "catalog://" + appId + "/1", "the promoted version");
  assert.notEqual((await heldOf(vault, vRow.id))[1], "0x" + "00".repeat(32), "the account's promotion is recorded by the vault");

  // 6) a PAID app through the dialog: a session cannot create it, so the Safe itself does (passkey) and pays from its USDC
  // published by a separate fresh key: the publisher's fee cut must not land in the payer's wallet and blur the checks below
  const publisher = privateKeyToAccount(generatePrivateKey());
  await rpc("anvil_setBalance", [publisher.address, "0xde0b6b3a7640000"]);
  const pubWc = viem.createWalletClient({ chain, account: publisher, transport: viem.http(rpcUrl) });
  const paidHash = await pubWc.writeContract({ address: catalog, abi: CATALOG, functionName: "publishVersion", gas: 3_000_000n, args: ["pk-paid-app", "Paid app", "", "1.0.0", "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzd3", [0, 0, 64, 1], "", "", 10n] });
  const paid = await pc.waitForTransactionReceipt({ hash: paidHash }); assert.equal(paid.status, "success");
  const paidId = viem.parseEventLogs({ abi: CATALOG, logs: paid.logs, eventName: "VersionPublished" })[0].args.appId;
  b = await pc.getBlockNumber() + 1n;
  await openDeployDialog(paidId);
  await page.locator("#qdAmt").fill("2");
  await page.locator(".qd-go").click();
  const [pRow] = await until(async () => { const c = await createdSince(b); return c.length ? c : null; }, "the paid record");
  assert.equal(pRow.owner, safe, "the Safe holds the paid record itself");
  const f2 = await until(async () => (await fundedSince(b)).find((f) => f.id === pRow.id), "its funding");
  assert.equal(f2.from, safe, "funded by the account (its ERC-1271 USDC authorization)"); assert.equal(f2.value, 2_000_000n);
  assert.equal(await usdcOf(safe), 45_000_000n);

  // 7) prepare-only through the dialog: the Safe creates it, unfunded, startup disabled until its settings are committed
  b = await pc.getBlockNumber() + 1n;
  await openDeployDialog(appId);
  await page.locator(".qd-startupck").check();
  await page.locator(".qd-go").click();
  const [sRow] = await until(async () => { const c = await createdSince(b); return c.length ? c : null; }, "the prepare-only record");
  assert.equal(sRow.owner, safe);
  const env = await page.evaluate(async () => (await import("/js/core/startup-package.js")).PREPARE_ONLY_ENVELOPE);
  assert.deepEqual(JSON.parse((await rowOf(sRow.id)).configCid), env);

  // 8) ETH: the Safe creates and funds with its own ETH at the ledger's feed (deploy flow; the dialog itself offers USDC)
  b = await pc.getBlockNumber() + 1n;
  const eth0 = await pc.getBalance({ address: safe });
  await page.evaluate(async (ref) => (await import("/js/pages/deploy.js")).deployOnChain({ reference: ref, gpuMilli: 0, cpuMilli: 100, ports: "", isPublic: true, fundUsd: 1, asset: "ETH", maxRate6: "100" }), "catalog://" + appId + "/1");
  const [eRow] = await until(async () => { const c = await createdSince(b); return c.length ? c : null; }, "the ETH record");
  assert.equal(eRow.owner, safe);
  await until(async () => BigInt((await rowOf(eRow.id)).balance6) > 0n, "ETH credit");
  assert.ok((await pc.getBalance({ address: safe })) < eth0, "the account's ETH paid");

  // 9) row Top up: the Safe-held paid record from the account's USDC, the vault-held record from the session budget
  await page.goto(`http://localhost:${sitePort}/dashboard`);
  for (const [id, amount, from] of [[pRow.id, "1", safe], [vRow.id, "0.5", vault]]){
    b = await pc.getBlockNumber() + 1n;
    await waitListed(id);
    await page.locator(`.enc-fundbtn[data-id="${id}"]`).click();
    assert.equal(await page.locator(".enc-fund:not([hidden]) .ef-go").textContent(), "Pay from your account");
    await page.locator(".enc-fund:not([hidden]) .ef-amt").fill(amount);
    await page.locator(".enc-fund:not([hidden]) .ef-go").click();
    const f = await until(async () => (await fundedSince(b)).find((x) => x.id === id), "the top-up of " + id);
    assert.equal(f.from, from); assert.equal(f.value, BigInt(Math.round(Number(amount) * 1e6)));
    await page.goto(`http://localhost:${sitePort}/dashboard`);
  }

  // 9a) ETH for the record the account's session VAULT holds: the session vault funds only in USDC, so the Safe pays the
  //     ledger's fundEth from its own ETH (one passkey approval; the wallet only submits)
  await waitBar(/Acting as passkey account/);
  const FUNDED_ETH = viem.parseAbiItem("event FundedEth(bytes32 indexed id, address indexed payer, uint256 amountWei, uint256 credited6)");
  const bE = await pc.getBlockNumber() + 1n, ethE = await pc.getBalance({ address: safe });
  await page.evaluate(async (id) => { const F = await import("/js/core/fund.js"), { DEPLOYMENTS_ADDRESS } = await import("/js/core/config.js");
    return F.payForRuntime({ contract: DEPLOYMENTS_ADDRESS, deploymentRef: id, ...(await F.fundingTerms()) }, 0.5, "ETH", () => {}); }, vRow.id);
  const fe = await pc.getLogs({ address: ledger, event: FUNDED_ETH, args: { id: vRow.id }, fromBlock: bE });
  assert.equal(fe.length, 1); assert.equal(fe[0].args.payer.toLowerCase(), safe, "the account paid the ETH, for the vault-held record");
  assert.ok(fe[0].args.credited6 > 0n); assert.ok((await pc.getBalance({ address: safe })) < ethE);

  // 9b) the Safe's ledger delegation (what host management needs for records the Safe holds itself), against the DEPLOYED
  //     ledger on this fork - the repository's HEAD ledger has no setDelegate. One passkey-approved Safe transaction,
  //     simulated first, submitted by the wallet; the ledger then records Safe -> its vault.
  // (read in the page through the vendored sessions SDK, so the driver stays small)
  const delegation = (ledger) => page.evaluate(async ({ ledger, safe, vault, rpc }) => { const sdk = await (await import("/js/core/sessions.js")).sdk();
    return sdk.delegationStatus(sdk.chainClient(8453, rpc), ledger, safe, vault); }, { ledger, safe, vault, rpc: rpcUrl });
  await waitBar(/Acting as passkey account/);                               // re-verified after the reload: nothing is sent before
  let deployedLedger = null;
  for (const c of ["0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B", "0xf9e71385c5cb49844f2457ba6567de0742f8b89a"])
    if ((await delegation(c)).supported){ deployedLedger = c; break; }
  assert.ok(deployedLedger, "a deployed Base ledger with setDelegate");
  assert.equal((await delegation(deployedLedger)).granted, false);
  await page.evaluate(async ({ to, vault }) => { const S = await import("/js/core/sessions.js"); return S.safeExecute({ to, data: (await S.sdk()).setDelegateCall(vault, true).data }); }, { to: deployedLedger, vault });
  assert.equal((await delegation(deployedLedger)).granted, true, "the deployed ledger records the Safe's delegation to its vault");
  Object.assign(acct, { deployedLedger });

  // 10) End all sessions: the account's signed revokeAll; the session is over on chain
  // after a reload the identity is pending until it re-verifies, and no session serves it until then
  await page.waitForFunction(() => /Account session<\/b> live/.test(document.querySelector(".ind-sess")?.innerHTML || ""), null, { timeout: 60000 });
  const sid = await page.evaluate(async () => (await (await import("/js/core/sessions.js")).sessionStatus()).sid);
  await page.locator(".ind-s-revoke").click();
  await until(async () => { const [, live] = await pc.readContract({ address: vault, abi: sessionOfAbi, functionName: "sessionOf", args: [sid] }); return !live; }, "revokeAll");

  // 11) switching identity invalidates what this page shows and caches for the other one
  await page.locator(".acct-wallet").click();
  await waitBar(/Acting as your wallet/);
  await page.waitForFunction(() => /Wallet session:<\/b> none/.test(document.querySelector(".ind-sess")?.innerHTML || ""), null, { timeout: 30000 });
  assert.equal(await page.evaluate(async () => (await (await import("/js/core/sessions.js")).currentSession()) === null), true, "the account's session never serves the wallet");

  // the gas payer only ever submitted: it owns no record, funded nothing, holds no USDC, and every transaction it sent went to
  // the account's Safe or vault, or to the ledger carrying the Safe's own USDC authorization
  assert.ok((await createdSince(start)).every((c) => c.owner !== me));
  assert.ok((await fundedSince(start)).every((f) => f.from !== me));
  assert.equal(await usdcOf(payer.address), 0n);
  const end = await pc.getBlockNumber();
  for (let n = start; n <= end; n++){
    for (const t of (await pc.getBlock({ blockNumber: n, includeTransactions: true })).transactions){
      if (t.from.toLowerCase() !== me || !t.to) continue;
      const to = t.to.toLowerCase();
      if (to === catalog) continue;                                          // the driver's own catalog setup
      const fundBySafe = to === ledger && t.input.slice(0, 10) === FUND_AUTH && "0x" + t.input.slice(10 + 64 + 24, 10 + 128).toLowerCase() === safe;
      assert.ok(to === safe || to === vault || fundBySafe, "payer transaction to " + to + " (" + t.input.slice(0, 10) + ")");
    }
  }
  assert.deepEqual(pageErrors.filter((e) => !/ResizeObserver/.test(e)), []);
  assert.ok(!requests.some((u) => /enclave\.host/.test(new URL(u).hostname)), "no Enclave origin");
});
