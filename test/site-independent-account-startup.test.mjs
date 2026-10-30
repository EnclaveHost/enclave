// The Startup tab on a record a passkey account (a Safe) holds itself, in a real headless Chromium against the local rig
// (test/helpers/independent-browser-rig.mjs: anvil with the repository's schema-16 ledger, three HTTPS storage adapters that
// verify the upload signature, registry hosts) with the PINNED Safe passkey code etched from the recorded Base snapshot (test/helpers/
// safe-passkey-code.mjs). The account is made through the account panel (one passkey with its own signer, deployed by the
// connected wallet as gas payer), selected as the dashboard identity, and creates - BY ITSELF, one passkey approval - a record
// waiting for owner-committed startup settings. The Startup tab then publishes the package: the ACCOUNT signs every storage
// upload itself (upload v2, ERC-1271 - the adapters ask the Safe's isValidSignature; the connected wallet only paid the
// deployment gas and never signs as the account), and the passkey approves the Safe's own setConfig commit.
//   node test/helpers/memory-guard.mjs --max-rss-mib 1408 --floor-available-mib 16384 -- node --max-old-space-size=256 test/site-independent-account-startup.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startRig, haveTools, walletScript, KEYS } from "./helpers/independent-browser-rig.mjs";
import { copySafePasskeyCode } from "./helpers/safe-passkey-code.mjs";
import { verifyPackage, packageCID } from "../sdk/bootstrap/package.mjs";

const require = createRequire(new URL("../e2e/package.json", import.meta.url));
let chromium = null; try { ({ chromium } = require("playwright")); } catch {}
const skip = haveTools() || (!chromium && "needs Playwright (cd e2e && npm ci) and its Chromium");

let rig, browser, page, setupError = null;
const pageErrors = [], cleanups = [];
const cleanup = async () => { while (cleanups.length) { try { await cleanups.pop()(); } catch {} } };
const rigRpc = async (method, params) => { const r = await (await fetch(rig.rpc, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json(); if (r.error) throw new Error(r.error.message); return r.result; };

test.before(async () => {
  if (skip) return;
  const watchdog = setTimeout(() => { console.error("account-startup: watchdog"); cleanup().finally(() => process.exit(1)); }, 10 * 60 * 1000); watchdog.unref();
  try {
    rig = await startRig(); cleanups.push(() => rig.stop());
    browser = await chromium.launch({ args: ["--disable-gpu", "--disable-dev-shm-usage", "--renderer-process-limit=1", "--disable-extensions",
      "--disable-features=site-per-process,IsolateOrigins,Translate,OptimizationHints,MediaRouter,AudioServiceOutOfProcess",
      "--enable-features=NetworkServiceInProcess,NetworkServiceInProcess2", "--js-flags=--max-old-space-size=192"] });
    cleanups.push(() => browser.close());
    // the rig's storage adapters use a self-signed test certificate (as in test/site-independent-browser.test.mjs)
    const context = await browser.newContext({ ignoreHTTPSErrors: true, reducedMotion: "reduce" });
    await context.route((u) => /(^|\.)enclave\.host$/i.test(u.hostname), (r) => r.abort("blockedbyclient"));
    await context.addInitScript({ content: walletScript({ rpc: rig.rpc, address: rig.owner }) });
    const text = JSON.stringify(rig.profile);
    await context.addInitScript(({ address, text }) => {
      if (!localStorage.getItem("enclave_session")) localStorage.setItem("enclave_session", JSON.stringify({ address, rdns: "test.local.wallet" }));
      localStorage.setItem("enclave_independent_profile", text); sessionStorage.setItem("enclave_independent_ack", text);
    }, { address: rig.owner, text });
    page = await context.newPage(); page.setDefaultTimeout(60000);
    page.on("pageerror", (e) => pageErrors.push(String(e && e.message || e)));
    page.on("dialog", (d) => d.accept());
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(rig.site + "/dashboard");
    const pins = await page.evaluate(async () => Object.entries((await import("/js/core/account-providers.js")).PROVIDERS["safe-passkey"].contracts)
      .map(([name, c]) => ({ name, address: c.address, codeHash: c.codeHash || null })));
    for (const c of await copySafePasskeyCode(pins, rigRpc)) if (!c.ok) throw new Error(c.name + " is not the pinned code");
  } catch (e){ setupError = e; await cleanup(); throw e; }
});
test.after(cleanup);

const waitAcct = (re, timeout = 60000) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector(".acct-status")?.textContent || ""), re.source, { timeout })
  .catch(async (e) => { throw new Error(e.message + "\nstatus: " + await page.locator(".acct-status").textContent().catch(() => "?")); });

test("Startup tab on a record the Safe holds: the account signs its uploads (ERC-1271), the passkey approves the Safe's commit", { skip, timeout: 420000 }, async () => {
  if (setupError) throw setupError;
  for (let i = 0; i < 100 && !(await page.evaluate(async () => !!(await import("/js/core/api.js")).Enclave.address)); i++) await new Promise((r) => setTimeout(r, 200));
  await page.locator(".acct-panel > summary").click();
  await page.locator(".acct-label").fill("laptop");
  await page.locator(".acct-create").click();
  await waitAcct(/passkey created under/);
  await page.locator(".acct-compute").click();
  await waitAcct(/your account address: 0x[0-9a-f]{40} \(not deployed yet\)/);
  const safe = /your account address: (0x[0-9a-f]{40})/.exec(await page.locator(".acct-status").textContent())[1];
  await page.locator(".acct-save").click();
  await page.locator(".acct-deploy").click();
  await page.locator(".acct-send").nth(0).click(); await waitAcct(/create the signer for passkey laptop confirmed/);
  await page.locator(".acct-send").nth(1).click(); await waitAcct(/create the account confirmed/);
  await page.locator(".acct-use").click();
  await waitAcct(/the dashboard now acts as your passkey account/);
  // the account creates a record awaiting its own startup settings - by itself (no account session: one passkey approval)
  // deployOnChain as the dashboard calls it, with its own outcome: return value or error, every toast and run-log line
  const create = (reference) => page.evaluate(async (reference) => {
    const toasts = [], lines = [];
    const t = (e) => toasts.push(String(e.detail?.message)), l = (e) => { if (e.detail?.type === "line") lines.push(e.detail.txt); };
    document.addEventListener("enclave:toast", t); document.addEventListener("enclave:runlog", l);
    let ret, error = null;
    try { ret = await (await import("/js/pages/deploy.js")).deployOnChain({ reference, gpuMilli: 0, cpuMilli: 100, ports: "", isPublic: true, fundUsd: 0, prepareOnly: true }); }
    catch (e) { error = String(e?.message || e); }
    document.removeEventListener("enclave:toast", t); document.removeEventListener("enclave:runlog", l);
    return { ret: ret === undefined ? "undefined" : JSON.stringify(ret), error, toasts, lines };
  }, reference);
  const count = () => rig.pc.readContract({ address: rig.addresses.ledger, abi: rig.abi.ledger, functionName: "count" });
  const refused = async (reference, re, what) => {
    const before = await count(), o = await create(reference);
    assert.equal(await count(), before, what + ": nothing is created; outcome " + JSON.stringify(o));
    assert.match(o.toasts.join(" | "), re, what + ": " + JSON.stringify(o));
  };
  // A REAL catalog version: the browser refuses a deploy unless the app and version are currently listed and approved
  // (catalog moderation, read at deploy time). A third-party publisher's release starts PENDING; the catalog owner - the
  // platform administrator, the rig's deployer - rules on it; the publisher may delist its own app.
  const publisher = rig.wc(KEYS.operator2), slug = "safe-startup-app", CAT = { address: rig.addresses.catalog, abi: rig.abi.catalog };
  const sim = await rig.pc.simulateContract({ ...CAT, account: publisher.account, functionName: "publishVersion",
    args: [slug, "Safe startup app", "the account-startup fixture app", "1.0.0", "bafkreisafestartupfixtureapp0000000000000000000000000000000", [0, 0, 256, 100], "", "", 0n] });
  const [appId, index] = sim.result;
  await rig.write(publisher, CAT.address, CAT.abi, "publishVersion", sim.request.args);
  const reference = "catalog://" + appId.toLowerCase() + "/" + index;
  const admin = rig.wc(KEYS.deployer);
  await refused("catalog://0x" + "11".repeat(32) + "/0", /could not verify current catalog moderation|delisted/, "an app the catalog does not have");
  await refused(reference, /requires catalog approval; pending versions may only be deployed PRIVATE/, "a pending version for a public record");
  await rig.write(admin, CAT.address, CAT.abi, "setApproval", [appId, index, 1]);
  await rig.write(publisher, CAT.address, CAT.abi, "setActive", [slug, false]);
  await refused(reference, /delisted/, "a delisted app");
  await rig.write(publisher, CAT.address, CAT.abi, "setActive", [slug, true]);
  await rig.write(admin, CAT.address, CAT.abi, "setApproval", [appId, index, 2]);
  await refused(reference, /rejected by the catalog owner/, "a version the administrator rejected");
  await rig.write(admin, CAT.address, CAT.abi, "setApproval", [appId, index, 1]);
  // listed and approved: the account creates the record itself, waiting for its own startup settings
  const n0 = await count();
  const outcome = await create(reference);
  const n1 = await count();
  assert.equal(n1, n0 + 1n, "one record; deployOnChain outcome: " + JSON.stringify(outcome, null, 1));
  const rec = (await rig.pc.readContract({ address: rig.addresses.ledger, abi: rig.abi.ledger, functionName: "getPage", args: [n0, 1n] }))[0];
  const id = rec.id.toLowerCase();
  assert.equal(rec.owner.toLowerCase(), safe, "the Safe holds it itself");
  assert.equal(JSON.parse(rec.configCid).guestBootstrap.sha256, "f".repeat(64), "created with startup disabled until its settings are committed");
  // the Startup tab
  await page.goto(rig.site + "/dashboard");
  await page.evaluate(() => customElements.whenDefined("c-deployments"));
  await page.locator(".enc-search").fill(id.slice(2, 14));
  await page.waitForFunction(() => document.querySelectorAll(".enc-row").length === 1, null, { timeout: 90000 });
  const row = page.locator(".enc-row").first();
  await row.locator(".enc-startbtn").click();
  await row.locator(".es-app").waitFor({ timeout: 30000 });
  await row.locator(".es-cfg").fill('{"greeting":"from a passkey account"}');
  await row.locator(".es-app").fill("a1".repeat(32));
  await row.locator(".es-rt").fill("b2".repeat(32));
  const up0 = rig.uploads.length;
  await row.locator(".es-go").click();
  await page.waitForFunction(() => /\[✓\] committed:|\[x\]/.test(document.querySelector(".enc-start-status")?.textContent || ""), null, { timeout: 150000 });
  const done = await page.locator(".enc-start-status").textContent();
  assert.match(done, /your passkey account signs each upload itself \(ERC-1271\)/, done);
  assert.doesNotMatch(done, /signed by your wallet/, done);
  assert.match(done, /commit it on the ledger \(your passkey account approves\)/);
  assert.match(done, /\[✓\] committed:/, done);
  assert.ok(rig.uploads.length > up0 && rig.uploads.slice(up0).every((u) => u.signer === safe && u.scheme === "erc1271-v2"),
    "the Safe signed every upload itself (v2), never the payer wallet: " + JSON.stringify(rig.uploads.slice(up0)));
  const d = await rig.pc.readContract({ address: rig.addresses.ledger, abi: rig.abi.ledger, functionName: "get", args: [id] });
  assert.equal(d.owner.toLowerCase(), safe, "still the Safe's record");
  const envl = JSON.parse(d.configCid);
  const cid = packageCID(envl.guestBootstrap.sha256);
  const bytes = rig.held[0].get(cid) || rig.held[1].get(cid) || rig.held[2].get(cid);
  assert.ok(bytes, "the adapters hold the committed package");
  const pkg = verifyPackage(bytes, envl.guestBootstrap, { chainId: 8453, ledger: rig.addresses.ledger, deployment: id, owner: safe, appRef: d.appRef });
  assert.equal(pkg.manifest.configText, '{"greeting":"from a passkey account"}', "the committed settings, bound to the Safe as owner");
  assert.deepEqual(pageErrors.filter((e) => !/ResizeObserver/.test(e)), []);
});
