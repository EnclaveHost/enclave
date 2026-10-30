// /credit/ in Chromium with the Enclave API unreachable: the page's own module graph (site/credit/credit.js, js/core/
// credit-vault-independent.js, js/core/quorum.js, /vendor/credit-vault.js) against anvil running the PRODUCTION
// credit-vault factory bytecode (test/credit-vault-fixture.mjs), a virtual authenticator holding the passkey (CDP
// WebAuthn), and an EIP-1193 wallet that pays gas from an anvil account. Every request that is not loopback is aborted
// and recorded. The factory is deployed with the page's local origin as origin0 (a browser cannot be at
// https://enclave.host here); test/credit-vault-independent.test.mjs drives the production origin itself.
//   1. production config at a local origin: the page reads but refuses to sign, and says why;
//   2. the owner's config: find the vault from the passkey alone (two taps), deploy, fund and control with exact balances,
//      the owner's wallet paying gas; the hosted dashboard is never involved;
//   3. the same passkey on ANOTHER origin with the same rpId (a tenant app): the page refuses, and a raw assertion made
//      there is refused by the vault;
//   4. no request left loopback; no page error.
//   SITE_DIR=<a built site/ tree> (optional; default: the source site/) node --test test/credit-vault-browser.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { encodeFunctionData } from "viem";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const F = await import(path.join(REPO, "test/credit-vault-fixture.mjs"));
const CV = await import(path.join(REPO, "site/js/core/credit-vault-independent.js"));
const require = createRequire(new URL("../e2e/package.json", import.meta.url));
let chromium; try { ({ chromium } = require("playwright")); } catch {}
const haveAnvil = (() => { try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = process.env.INJECT_FAILURE ? "negative-control run: only the injected test" : !chromium ? "Playwright unavailable" : !haveAnvil ? "needs Foundry's anvil" : false;
const SITE = path.resolve(process.env.SITE_DIR || path.join(REPO, "site"));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".css": "text/css" };

function serve(port, overrides){
  const served = [];
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname); served.push(p);
    if (overrides[p] !== undefined){ res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); return res.end(overrides[p]); }
    let f = path.join(SITE, p);
    if (!f.startsWith(SITE)){ res.writeHead(400); return res.end(); }
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()){ if (!p.endsWith("/")){ res.writeHead(301, { location: p + "/" }); return res.end(); } f = path.join(f, "index.html"); }
    if (!fs.existsSync(f)){ res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream", "cache-control": "no-store",
      "content-security-policy": "default-src 'self'; script-src 'self'; connect-src 'self' http://127.0.0.1:*; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'" });
    res.end(fs.readFileSync(f));
  });
  return new Promise((ok) => srv.listen(port, "127.0.0.1", () => ok({ srv, served, origin: `http://localhost:${port}` })));
}
function vkey(){
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }), id = crypto.randomBytes(16);
  return { credId: F.b64u(id), idB64: id.toString("base64"), pkcs8: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    x: "0x" + Buffer.from(jwk.x, "base64url").toString("hex"), y: "0x" + Buffer.from(jwk.y, "base64url").toString("hex") };
}

if (process.env.INJECT_FAILURE) test("INJECTED FAILURE (negative control: the suite must exit nonzero)", () => assert.fail("injected"));

test("/credit/ in Chromium: find, deploy, fund, control - no Enclave API", { skip, timeout: 300000 }, async (t) => {
  const stops = [];
  t.after(async () => { for (const s of stops.reverse()) try { await s(); } catch {} });
  const [pA, pB, pC] = [await F.freePort(), await F.freePort(), await F.freePort()];
  const B_ORIGIN = `http://localhost:${pB}`;
  const A = await F.startChain(8453, stops);
  const S = await F.deployStack(A, { origin: B_ORIGIN });            // the vault's pinned origin = the page at B
  const K = vkey();
  const vault = CV.deriveVault((await import(path.join(REPO, "cli/credit-vault.mjs"))).lib, K.x, K.y, S.current);
  await F.send(A, "admin", S.current.address, CV.ABI.factory, "createVault", [BigInt(K.x), BigInt(K.y)]);
  await F.send(A, "admin", S.usdc, F.CHAIN_FX.MockUSDC.abi, "mint", [vault, 100_000000n]);   // a settled top-up (test USDC)
  // the PROPOSED parallel lease-gas reserve and its own executor (test/fixtures/credit-vault-reserve-proposal.json, proposal only)
  const PROP = JSON.parse(fs.readFileSync(path.join(REPO, "test/fixtures/credit-vault-reserve-proposal.json"), "utf8"));
  const r2 = await F.deploy(A, "admin", PROP.reserve.abi, PROP.reserve.bytecode, [S.ledger, S.registry, "0x0000000000000000000000000000000000000000",
    { maxGasPriceCeiling: 1_000_000_000n, overheadClaimGas: 65000, overheadRenewGas: 55000, overheadReleaseGas: 36000, minClaimInterval: 60, l1Bps: 0 }, []]);
  const e2 = await F.deploy(A, "admin", PROP.executor.abi, PROP.executor.bytecode, [r2]);
  await F.send(A, "admin", r2, PROP.reserve.abi, "bindExecutor", [e2]);
  const { keccak256 } = await import("viem");
  const gasRecord = { format: "enclave-lease-gas-deployment/v1", chainId: 8453, reserve: r2, executor: e2, reserveCodeHash: keccak256(await A.pub.getCode({ address: r2 })),
    executorCodeHash: keccak256(await A.pub.getCode({ address: e2 })), ledger: S.ledger, registry: S.registry };
  const localCfg = (origin) => JSON.stringify({ origin, rpId: "localhost", chainId: 8453, usdc: S.usdc, factories: [S.older, S.current], rpcs: A.rpcs, quorum: 2, confirmations: 0, maxBlockAgeSeconds: 3600,
    leaseGasReserve: gasRecord });
  const prodCfg = fs.readFileSync(path.join(REPO, "site/credit/credit-config.json"), "utf8");
  const servers = [await serve(pA, { "/credit/credit-config.json": prodCfg }), await serve(pB, { "/credit/credit-config.json": localCfg(B_ORIGIN) }),
    await serve(pC, { "/credit/credit-config.json": localCfg(B_ORIGIN) })];
  stops.push(() => servers.forEach((s) => s.srv.close()));

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--disable-gpu", "--disable-dev-shm-usage", "--renderer-process-limit=1", "--disable-extensions", "--js-flags=--max-old-space-size=192"] });
  stops.push(() => browser.close());
  const ctx = await browser.newContext({ reducedMotion: "reduce" });
  const remote = [];
  await ctx.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (["localhost", "127.0.0.1"].includes(u.hostname)) return route.continue();
    remote.push(u.href); return route.abort("blockedbyclient");
  });
  // the owner's wallet: an EIP-1193 provider whose account is an anvil account (it pays the gas, nothing else)
  await ctx.addInitScript(({ rpc, payer }) => {
    window.__csp = []; addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + e.blockedURI));
    const call = async (method, params) => { const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const j = await r.json(); if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code }); return j.result; };
    window.ethereum = { request: ({ method, params }) => method === "eth_requestAccounts" ? Promise.resolve([payer]) : call(method, params || []) };
  }, { rpc: A.rpcs[0], payer: F.ACCT.payer.address });
  const page = await ctx.newPage();
  const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal",
    hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: { credentialId: K.idB64, isResidentCredential: true, rpId: "localhost",
    privateKey: K.pkcs8, userHandle: Buffer.from("owner").toString("base64"), signCount: 0 } });
  const noteText = () => page.locator("#note").textContent();
  // a wait that fails names what the page said (its #note carries every refusal and error)
  const withNote = async (p) => { try { return await p; } catch (e){ throw new Error(e.message.split("\n")[0] + " - page note: " + await noteText().catch(() => "?")); } };
  const _wfs = page.waitForSelector.bind(page), _wff = page.waitForFunction.bind(page);
  page.waitForSelector = (...a) => withNote(_wfs(...a)); page.waitForFunction = (...a) => withNote(_wff(...a));
  const waitNote = (re, timeout = 60000) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector("#note").textContent), re.source, { timeout });

  await t.test("production pins at a local origin: reads allowed, signing refused with the reason", async () => {
    await page.goto(`http://localhost:${pA}/credit/`);
    await page.waitForFunction(() => !document.querySelector("#origin-note").hidden);
    assert.match(await page.locator("#origin-note").textContent(), /signing works only at https:\/\/enclave\.host/);
    await page.click("#find-passkey");
    await waitNote(/work only at https:\/\/enclave\.host/);
    // production config: no parallel reserve is configured, so the page explains why lease gas is unavailable and offers no deposit
    assert.match(await page.locator("#gas-state").textContent(), /App lease gas is unavailable for a deployment owned by a credit vault.*offers no deposit/);
    assert.equal(await page.locator("#gas-panel").isHidden(), true);
  });

  await t.test("the owner's page: passkey -> vault -> deploy, fund, control, exact balances, wallet pays gas", async () => {
    await page.goto(`${B_ORIGIN}/credit/`);
    await page.waitForFunction(() => document.querySelector("#rpcs").value.length > 0);
    assert.equal(await page.locator("#origin-note").isHidden(), true);
    await page.click("#find-passkey");
    await page.waitForSelector(`#vaults button[data-vault="${vault}"]`, { timeout: 60000 });
    assert.match(await page.locator("#vaults").textContent(), /credit \$100\.00/);
    await page.click(`#vaults button[data-vault="${vault}"]`);
    await page.waitForFunction(() => /credit \$100\.00/.test(document.querySelector("#vault-info").textContent));
    await page.click("#payer-wallet");
    await page.waitForFunction(() => /gas paid by/.test(document.querySelector("#payer").textContent));
    const eth0 = await A.pub.getBalance({ address: F.ACCT.payer.address });
    const doOp = async (op, fill, done) => {
      await page.selectOption("#op", op);
      await fill();
      await page.click("#review");
      await page.waitForSelector("#review-panel:not([hidden])");
      await page.click("#sign");
      await page.waitForSelector("#send-panel:not([hidden])");
      const req = JSON.parse(await page.locator("#request").inputValue());
      assert.equal(req.kind, "enclave-credit-vault-request"); assert.equal(req.op, op);
      await page.click("#send");
      await waitNote(done);
      return req;
    };
    await doOp("deploy", async () => {
      await page.fill("#deploy-appref", "catalog://app/0"); await page.fill("#deploy-cpu", "500"); await page.fill("#deploy-maxrate", "1000"); await page.fill("#deploy-fund", "30");
    }, /Done: deploy executed/);
    assert.equal(await F.usdcOf(A, S, vault), 70_000000n, "exactly $30 left the vault");
    const logs = await A.pub.getLogs({ address: S.ledger, fromBlock: 0n });
    const id = logs.find((l) => l.topics[0] === "0x3b201eb11e77934b296f908775fc0a82679683fd83a1232579f1014bcf7d3239").topics[1];   // Created(id, owner, ...)
    let rec = await F.recordOf(A, S.ledger, id);
    assert.equal(F.lc(rec.owner), vault); assert.equal(rec.balance6, 30_000000n);
    await page.waitForFunction(() => /credit \$70\.00/.test(document.querySelector("#vault-info").textContent));
    await doOp("fund", async () => { await page.fill("#fund-id", id); await page.fill("#fund-amount", "12.5"); }, /Done: fund executed/);
    rec = await F.recordOf(A, S.ledger, id);
    assert.equal(rec.balance6, 42_500000n); assert.equal(await F.usdcOf(A, S, vault), 57_500000n);
    await doOp("control", async () => { await page.fill("#control-id", id); await page.selectOption("#control-action", "suspend"); }, /Done: control executed/);
    assert.equal((await F.recordOf(A, S.ledger, id)).active, false);
    assert.ok((await A.pub.getBalance({ address: F.ACCT.payer.address })) < eth0, "the owner's wallet paid the gas");
    assert.equal(await A.pub.getBalance({ address: vault }), 0n);
    // a tampered amount never reaches the passkey: the page prepares from its own form, and signing re-checks it
    await page.selectOption("#op", "fund"); await page.fill("#fund-id", id); await page.fill("#fund-amount", "1");
    await page.click("#review"); await page.waitForSelector("#review-panel:not([hidden])");
    await page.fill("#fund-amount", "2");                 // the form now says $2, the prepared op says $1
    await page.click("#sign");
    await waitNote(/not what you asked for \(a different amount\)/);
    // save the owner-held profile and reload it after a fresh page load (no account, no server)
    await page.click("#save-profile"); await waitNote(/Saved/);
    await page.goto(`${B_ORIGIN}/credit/`); await page.click("#load-saved");
    await page.waitForFunction(() => /credit \$57\.50/.test(document.querySelector("#vault-info").textContent));
    // app lease gas through the PROPOSED parallel reserve (configured on this page): deposit, passkey-signed settings, withdrawal
    await page.click("#payer-wallet"); await page.waitForFunction(() => /gas paid by/.test(document.querySelector("#payer").textContent));
    assert.equal(await page.locator("#gas-panel").isHidden(), false);
    await page.fill("#gas-id", id); await page.fill("#gas-deposit-wei", "10000000000000000"); await page.click("#gas-deposit");
    await waitNote(/Deposit sent/);
    const R2 = (fn, args) => A.pub.readContract({ address: r2, abi: PROP.reserve.abi, functionName: fn, args });
    for (let i = 0; i < 50 && (await R2("reserveOf", [id, vault])).balanceWei !== 10n ** 16n; i++) await F.sleep(100);
    assert.equal((await R2("reserveOf", [id, vault])).balanceWei, 10n ** 16n);
    for (const [sel, v] of [["#gas-max-op", "1000000000000000"], ["#gas-epoch-cap", "5000000000000000"], ["#gas-epoch-sec", "3600"], ["#gas-max-claims", "4"],
      ["#gas-renew-window", "300"], ["#gas-min-ext", "600"], ["#gas-cooldown", "1800"], ["#gas-max-price", "50000000"]]) await page.fill(sel, v);
    await page.click("#gas-configure");
    await waitNote(/Done: reserve configure executed/);
    assert.equal((await R2("reserveOf", [id, vault])).enabled, true);
    // a withdrawal needs the owner's recipient: none typed -> refused; then exactly what was signed
    await page.fill("#gas-withdraw-wei", "3000000000000000"); await page.fill("#gas-withdraw-to", ""); await page.click("#gas-withdraw");
    await waitNote(/recipient you choose/);
    await page.fill("#gas-withdraw-to", "0x000000000000000000000000000000000000d00d"); await page.click("#gas-withdraw");
    await waitNote(/Done: reserve withdraw executed/);
    assert.equal(await A.pub.getBalance({ address: "0x000000000000000000000000000000000000d00d" }), 3n * 10n ** 15n);
    await page.waitForFunction(() => /reserve 7000000000000000 wei · ENABLED · signature nonce 2/.test(document.querySelector("#gas-info").textContent));
  });

  await t.test("the same passkey on another origin (same rpId, like a tenant app): refused by the page and by the vault", async () => {
    await page.goto(`http://localhost:${pC}/credit/`);
    await page.waitForFunction(() => !document.querySelector("#origin-note").hidden);
    assert.match(await page.locator("#origin-note").textContent(), new RegExp(`signing works only at ${B_ORIGIN}`));
    // a raw assertion the browser WILL produce here (rpId localhost is valid for this origin too)
    const nonce = await F.nonceOf(A, vault), deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    const L = (await import(path.join(REPO, "cli/credit-vault.mjs"))).lib;
    const callData = CV.buildControlCall(L, { id: "0x" + "00".repeat(31) + "01", action: "resume" });
    const digest = CV.opDigest(L, "control", { vault, chainId: 8453, nonce, deadline, args: { callData } });
    const a = await page.evaluate(async ({ digest, credId }) => {
      const M = await import("/vendor/credit-vault.js");
      const r = await M.WebAuthnP256.sign({ challenge: digest, credentialId: credId, rpId: "localhost", userVerification: "required" });
      return { authenticatorData: r.metadata.authenticatorData, clientDataJSON: r.metadata.clientDataJSON, r: r.signature.r.toString(), s: r.signature.s.toString() };
    }, { digest, credId: K.credId });
    assert.match(a.clientDataJSON, new RegExp(`"origin":"http://localhost:${pC}"`));
    const data = encodeFunctionData({ abi: CV.ABI.vault, functionName: "controlDeployment", args: [callData, deadline,
      { authenticatorData: a.authenticatorData, clientDataJSON: a.clientDataJSON, r: BigInt(a.r), s: BigInt(a.s), x: BigInt(K.x), y: BigInt(K.y) }] });
    await assert.rejects(A.raw("eth_call", [{ from: F.ACCT.payer.address, to: vault, data }, "latest"]), /bad signature/, "the vault refuses another origin's assertion");
  });

  await t.test("nothing left loopback; no page errors or CSP violations", async () => {
    assert.deepEqual(remote, []);
    assert.deepEqual(errs, []);
    assert.deepEqual(await page.evaluate(() => window.__csp), []);
    assert.ok(servers[1].served.includes("/vendor/credit-vault.js"));
    assert.ok(!servers.some((s) => s.served.some((p) => /api|billing/.test(p))));
  });
});
