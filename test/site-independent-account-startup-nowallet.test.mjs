// The Startup tab with NO wallet anywhere (no injected provider, no wallet session), publishing to the REAL storage adapter.
// A passkey account (Safe v1.4.1, shared-signer passkey from Chrome's virtual authenticator, the PINNED Base code on an anvil
// fork, read-only upstream) creates itself through the owner's own bundler (test/helpers/local-bundler.mjs, the real
// EntryPoint v0.7) paying its own gas, creates a record waiting for owner-committed startup settings, and the Startup tab
// publishes the package: each upload is authorized by the ACCOUNT's own ERC-1271 signature (upload v2) and checked by
// work/enclave-apps/s3-ipfs-adapter built for wasm32-wasip2, run under wasmtime with minio, through the chain readers its
// operator pinned (two loopback JSON-RPC readers in front of the fork). Two adapters with distinct deployments (audiences),
// reached at distinct hostnames over HTTPS (local fronts with a throwaway certificate). The commit is the Safe's own user
// operation through the bundler. Then the browser's own authorization is replayed (refused) and sent to the other adapter
// (refused). Needs: anvil, minio, wasmtime, Playwright's Chromium, the Foundry build, and the adapter built
// (cargo build --release --target wasm32-wasip2).
//   node test/helpers/memory-guard.mjs --max-rss-mib 1408 --floor-available-mib 16384 -- node --max-old-space-size=256 test/site-independent-account-startup-nowallet.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { spawn, execFileSync, execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as viem from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { startLocalBundler } from "./helpers/local-bundler.mjs";
import { verifyPackage, packageCID } from "../sdk/bootstrap/package.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADAPTER = process.env.S3IPFS_WASM || path.resolve(REPO, "../enclave-apps/s3-ipfs-adapter/target/wasm32-wasip2/release/s3-ipfs-adapter.wasm");
const require = createRequire(new URL("../e2e/package.json", import.meta.url));
let chromium = null; try { ({ chromium } = require("playwright")); } catch {}
const have = (cmd, args) => { try { execFileSync(cmd, args, { stdio: "ignore" }); return true; } catch { return false; } };
const skip = (!have("anvil", ["--version"]) && "needs anvil") || (!have("minio", ["--version"]) && "needs minio") || (!have("wasmtime", ["--version"]) && "needs wasmtime")
  || (!fs.existsSync(ADAPTER) && "needs the adapter built for wasm32-wasip2") || (!chromium && "needs Playwright's Chromium");
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", FORK_BLOCK = 52836800n;
const EP = "0x0000000071727de22e5e9d8baf0edac6f37da032";
const chain = { id: 8453, name: "base-fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } };
const AUDS = ["0x" + "a1".repeat(32), "0x" + "b2".repeat(32)];
const run = promisify(execFile);

let rpcUrl, pc, site, sitePort, browser, page, bundler, ledger, setupError = null;
const cleanups = [], pageErrors = [], requests = [], consoleLines = [], readers = [], fronts = [];
const cleanup = async () => { while (cleanups.length) { try { await cleanups.pop()(); } catch {} } };
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const rpc = async (method, params) => { const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; };
const ready = () => { if (setupError) throw new Error("setup failed: " + setupError.message); };
const url = (p) => `http://localhost:${sitePort}${p}`;
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const closer = (srv) => () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); });

/* A pinned chain reader: an honest JSON-RPC pass-through to the fork that counts what the adapter asks. */
async function chainReader(){
  const r = { hits: 0 };
  const srv = http.createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    r.hits++;
    const up = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body });
    res.writeHead(200, { "content-type": "application/json" }); res.end(await up.text());
  });
  r.url = `http://127.0.0.1:${await listen(srv)}`;
  cleanups.push(closer(srv));
  return r;
}

/* An HTTPS front for one adapter (the adapter speaks plain HTTP inside its enclave; the fleet's TLS proxy is in front of
   it): forwards every request unchanged and records the uploads it carried. */
async function httpsFront(tls, target){
  const f = { posts: [] };
  const srv = https.createServer(tls, (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const up = http.request(target + req.url, { method: req.method, headers: { ...req.headers, host: new URL(target).host } }, (ur) => {
        const out = []; ur.on("data", (c) => out.push(c));
        ur.on("end", () => {
          if (req.method === "POST") f.posts.push({ path: req.url, status: ur.statusCode, headers: { ...req.headers }, body });
          res.writeHead(ur.statusCode, ur.headers); res.end(Buffer.concat(out));
        });
      });
      up.on("error", () => { res.writeHead(502); res.end(); });
      up.end(body);
    });
  });
  f.port = await listen(srv);
  cleanups.push(closer(srv));
  return f;
}

async function startAdapter(name, audience, s3){
  const port = await freePort();
  const config = { endpoint: s3.url, region: "us-east-1", bucket: s3.bucket, prefix: name + "/", credentials: { accessKeyId: s3.ak, secretAccessKey: s3.sk }, refreshSecs: 0,
    upload: { walletAudience: audience, allowOrigins: [url("")], maxJsonBytes: 65536,
      // the operator's own chain trust: its readers, its quorum; nothing from the client decides this
      contractWallets: { chainId: 8453, rpcs: readers.map((r) => r.url), quorum: 2, confirmations: 0, max_age_secs: 3600, timeout_secs: 5 } } };
  const proc = spawn("wasmtime", ["run", "-Scli", "-Stcp", "-Sinherit-network", "-Sallow-ip-name-lookup", "--env", `ENCLAVE_PORTS=http:8000=${port}`,
    "--env", "ENCLAVE_CONFIG=" + JSON.stringify(config), ADAPTER], { stdio: ["ignore", "ignore", "pipe"] });
  let log = ""; proc.stderr.on("data", (d) => { log = (log + d).slice(-4000); });
  cleanups.push(() => proc.kill("SIGKILL"));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++){ try { if ((await fetch(base + "/ping")).ok) return { base, audience, log: () => log }; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  throw new Error(name + " did not start: " + log);
}

let adapters = [];
test.before(async () => {
  if (skip) return;
  const watchdog = setTimeout(() => { console.error("account-startup-nowallet: watchdog"); cleanup().finally(() => process.exit(1)); }, 14 * 60 * 1000); watchdog.unref();
  try {
    const port = await freePort(); rpcUrl = `http://127.0.0.1:${port}`;
    const anvil = spawn("anvil", ["--port", String(port), "--fork-url", process.env.BASE_FORK_RPC || "https://mainnet.base.org", "--fork-block-number", String(FORK_BLOCK), "--optimism", "--silent",
      "--base-fee", "0", "--prune-history", "4", "--transaction-block-keeper", "16"], { stdio: "ignore" });
    cleanups.push(() => anvil.kill("SIGKILL"));
    for (let i = 0; i < 120; i++){ try { await rpc("eth_chainId", []); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
    // the fork's blocks carry the fork block's (historical) time; the adapters rightly refuse an agreed block older than
    // their max_age_secs, so this local chain is moved to the present once and later blocks follow the wall clock
    await rpc("evm_setNextBlockTimestamp", [Math.floor(Date.now() / 1000)]); await rpc("evm_mine", []);
    // the TEST's own key deploys the repository's ledger/factory/catalog - never in the page
    const driver = privateKeyToAccount(generatePrivateKey());
    await rpc("anvil_setBalance", [driver.address, "0x56bc75e2d63100000"]);
    await rpc("anvil_impersonateAccount", [driver.address]);
    pc = viem.createPublicClient({ chain, transport: viem.http(rpcUrl) });
    const { stdout } = await run("node", [path.join(REPO, "test/helpers/fork-deploy.mjs"), rpcUrl, driver.address], { maxBuffer: 1 << 20 });
    const d = JSON.parse(stdout.trim().split("\n").pop());
    ledger = d.ledger;
    bundler = await startLocalBundler({ rpcUrl, entryPoint: EP, chain, setBalance: (a, v) => rpc("anvil_setBalance", [a, v]) });
    cleanups.push(() => bundler.stop());
    // the site
    const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
    const PRETTY = { "/": "/index.html", "/dashboard": "/dashboard.html", "/apps": "/apps.html" };
    site = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, "http://x").pathname); p = PRETTY[p] || p;
      const root = p.startsWith("/network/") ? REPO : path.join(REPO, "site"), file = path.join(root, p);
      if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()){ res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" }); fs.createReadStream(file).pipe(res);
    });
    sitePort = await listen(site); cleanups.push(closer(site));
    // the storage: minio, two real adapters with their own deployments, the chain readers they pin, HTTPS in front
    for (let i = 0; i < 2; i++) readers.push(await chainReader());
    const s3 = { url: `http://127.0.0.1:${await freePort()}`, bucket: "uploads", ak: "testkey", sk: "testsecret12345" };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acct-startup-minio-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const minio = spawn("minio", ["server", "--address", s3.url.replace("http://", ""), dir], { stdio: "ignore",
      env: { ...process.env, MINIO_ROOT_USER: s3.ak, MINIO_ROOT_PASSWORD: s3.sk, MINIO_BROWSER: "off", GOMEMLIMIT: "128MiB" } });
    cleanups.push(() => minio.kill("SIGKILL"));
    for (let i = 0; i < 100; i++){ try { if ((await fetch(s3.url + "/minio/health/ready")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
    execFileSync("curl", ["-sf", "-X", "PUT", "--aws-sigv4", "aws:amz:us-east-1:s3", "--user", `${s3.ak}:${s3.sk}`, `${s3.url}/${s3.bucket}/`]);
    adapters = [await startAdapter("a", AUDS[0], s3), await startAdapter("b", AUDS[1], s3)];
    const tdir = fs.mkdtempSync(path.join(os.tmpdir(), "acct-startup-tls-"));
    cleanups.push(() => fs.rmSync(tdir, { recursive: true, force: true }));
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "1", "-keyout", path.join(tdir, "k.pem"), "-out", path.join(tdir, "c.pem"),
      "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
    const tls = { key: fs.readFileSync(path.join(tdir, "k.pem")), cert: fs.readFileSync(path.join(tdir, "c.pem")) };
    for (const a of adapters) fronts.push(await httpsFront(tls, a.base));
    const replicas = [["127.0.0.1", fronts[0], AUDS[0]], ["localhost", fronts[1], AUDS[1]]]
      .map(([host, f, audience]) => ({ upload: `https://${host}:${f.port}/add-json`, audience, gateway: `https://${host}:${f.port}/ipfs` }));
    const profile = { format: "enclave-browser-profile", version: 1, name: "local Base fork", chainId: 8453, rpcs: [rpcUrl, rpcUrl.replace("127.0.0.1", "localhost")], quorum: 2,
      confirmations: 0, maxBlockAgeSeconds: 86400,
      contractPins: { version: 1, chainId: 8453, contracts: { registry: d.registry, deployments: ledger, appCatalog: d.catalog, proofOfTime: ledger, enclavePay: "0x" + "00".repeat(20),
        verificationFees: "0x" + "00".repeat(20), sessionVaultFactory: d.factory, secretVaultV2: "0x" + "00".repeat(20) } }, usdc: USDC.toLowerCase(), ethUsdFeed: d.feed,
      storage: { version: 1, minimumCopies: 2, replicas } };
    browser = await chromium.launch({ args: ["--disable-gpu", "--disable-dev-shm-usage", "--renderer-process-limit=1", "--disable-extensions",
      "--disable-features=site-per-process,IsolateOrigins,Translate,OptimizationHints,MediaRouter,AudioServiceOutOfProcess",
      "--enable-features=NetworkServiceInProcess,NetworkServiceInProcess2", "--js-flags=--max-old-space-size=192"] });
    cleanups.push(() => browser.close());
    // the fronts use a throwaway self-signed certificate (as the rig's adapters do)
    const context = await browser.newContext({ ignoreHTTPSErrors: true, reducedMotion: "reduce" });
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

test("no wallet: a passkey account publishes startup settings to the real adapters by its own ERC-1271 signature and commits them itself", { skip, timeout: 600000 }, async () => {
  ready();
  assert.equal(await page.evaluate(() => typeof window.ethereum), "undefined", "no wallet in this browser");
  assert.equal(await page.evaluate(() => localStorage.getItem("enclave_session")), null, "no wallet session either");
  // the account: one passkey as its built-in signer, the owner's bundler, the account paying its own gas
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
  // the account is deployed through its normal path BEFORE anything uploads (the adapters refuse an undeployed account)
  await rpc("anvil_setBalance", [safe, viem.toHex(10n ** 17n)]);
  await page.locator(".acct-deploy").click();
  await waitStatus(/creating your account confirmed by the EntryPoint in 0x[0-9a-f]{64} \(gas [0-9.]+ ETH, paid by the account\)/, 90000);
  assert.notEqual(await rpc("eth_getCode", [safe, "latest"]), "0x");
  await page.locator(".acct-use").click();
  await waitStatus(/the dashboard now acts as your passkey account/);
  // a record the Safe holds itself, created for owner-committed startup (its own user operation; no host is registered on
  // this fork, so the owner names the price ceiling explicitly)
  const b0 = BigInt(await rpc("eth_blockNumber", []));
  const made = await page.evaluate(async () => { const toasts = []; document.addEventListener("enclave:toast", (e) => toasts.push(e.detail.message));
    try { return { ok: await (await import("/js/pages/deploy.js")).deployOnChain({ reference: "catalog://0x" + "11".repeat(32) + "/0", gpuMilli: 0, cpuMilli: 100,
    ports: "", isPublic: true, fundUsd: 0, prepareOnly: true, maxRate6: 100 }), toasts, runlog: [...document.querySelectorAll(".enc-live-out, .term")].map((e) => e.textContent).join(" | ").slice(-800) }; }
    catch (e){ return { error: String(e && e.message || e), toasts }; } });
  const m = /\[✓\] created (0x[0-9a-f]{64}) · held by your passkey account/.exec(made.runlog || "");
  assert.ok(m, "one record held by the Safe: " + JSON.stringify(made) + "\nconsole: " + JSON.stringify(consoleLines.slice(-8)));
  const id = m[1];
  assert.ok(BigInt(await rpc("eth_blockNumber", [])) > b0, "created on chain");
  assert.equal(await page.evaluate(async (id) => String((await (await import("/js/core/independent-chain.js")).deploymentAt(id)).row.owner).toLowerCase(), id), safe,
    "the Safe holds it itself");
  const ops0 = bundler.received.length;
  // the Startup tab
  await page.goto(url("/dashboard"));
  await page.evaluate(() => customElements.whenDefined("c-deployments"));
  await page.locator(".enc-search").fill(id.slice(2, 14));
  await page.waitForFunction(() => document.querySelectorAll(".enc-row").length === 1, null, { timeout: 90000 });
  const row = page.locator(".enc-row").first();
  await row.locator(".enc-startbtn").click();
  await row.locator(".es-app").waitFor({ timeout: 30000 });
  assert.match(await row.locator(".enc-start-body").textContent(), /Publishing asks your passkey account to approve once per storage adapter \(2\)/);
  await row.locator(".es-cfg").fill('{"greeting":"from a passkey account, no wallet"}');
  await row.locator(".es-app").fill("a1".repeat(32));
  await row.locator(".es-rt").fill("b2".repeat(32));
  const hits0 = readers.map((r) => r.hits);
  await row.locator(".es-go").click();
  await page.waitForFunction(() => /\[✓\] committed:|\[x\]/.test(document.querySelector(".enc-start-status")?.textContent || ""), null, { timeout: 240000 });
  const done = await page.locator(".enc-start-status").textContent();
  assert.match(done, /your passkey account signs each upload itself \(ERC-1271\)/, done);
  assert.match(done, /\[✓\] 2 of 2 storage adapters hold the exact bytes/, done + "\nadapter logs: " + adapters.map((a) => a.log()).join("\n"));
  assert.match(done, /commit it on the ledger \(your passkey account approves\)/, done);
  assert.match(done, /\[✓\] committed:/, done);
  // each real adapter accepted exactly one upload, authorized by the ACCOUNT (v2), checked through its pinned readers
  for (const [i, f] of fronts.entries()){
    const ok = f.posts.filter((p) => p.status === 200);
    assert.equal(ok.length, 1, "adapter " + i + ": " + JSON.stringify(f.posts.map((p) => [p.path, p.status])));
    assert.equal(ok[0].path, "/add-json");
    assert.equal(ok[0].headers["x-upload-scheme"], "erc1271-v2");
    assert.equal(ok[0].headers["x-upload-address"], safe, "the Safe itself authorized it");
    assert.ok(ok[0].headers["x-upload-signature"].length > 2 + 2 * 65, "contract signature bytes, not a 65-byte key signature");
  }
  assert.ok(readers.every((r, i) => r.hits > hits0[i]), "both pinned readers were asked");
  // the commit was the Safe's own user operation through the owner's bundler
  assert.equal(bundler.received.length, ops0 + 1, "one user operation: the setConfig commit");
  const at = await page.evaluate(async (id) => { const r = (await (await import("/js/core/independent-chain.js")).deploymentAt(id)).row;
    return { owner: String(r.owner).toLowerCase(), configCid: r.configCid, appRef: r.appRef }; }, id);
  assert.equal(at.owner, safe, "still the Safe's record");
  const envl = JSON.parse(at.configCid);
  const cid = packageCID(envl.guestBootstrap.sha256);
  for (const a of adapters){
    const back = await fetch(a.base + "/ipfs/" + cid);
    assert.equal(back.status, 200, a.base);
    const bytes = new Uint8Array(await back.arrayBuffer());
    const pkg = verifyPackage(bytes, envl.guestBootstrap, { chainId: 8453, ledger, deployment: id, owner: safe, appRef: at.appRef });
    assert.equal(pkg.manifest.configText, '{"greeting":"from a passkey account, no wallet"}', "the committed settings, bound to the Safe as owner");
  }
  // the browser's own authorization: single use at its adapter, and worthless at the other deployment
  const used = fronts[0].posts.find((p) => p.status === 200);
  const fwd = (base, p) => fetch(base + "/add-json", { method: "POST", headers: Object.fromEntries(Object.entries(p.headers).filter(([k]) => k.startsWith("x-upload-") || k === "content-type")), body: p.body });
  const replay = await fwd(adapters[0].base, used);
  assert.equal(replay.status, 409, await replay.text());
  const elsewhere = await fwd(adapters[1].base, used);
  assert.equal(elsewhere.status, 403, await elsewhere.text());
  assert.deepEqual(pageErrors.filter((e) => !/ResizeObserver/.test(e)), []);
  assert.ok(!requests.some((u) => /enclave\.host/.test(new URL(u).hostname)), "no Enclave origin");
});
