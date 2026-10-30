// The independent dashboard, end to end in a real Chromium against a local chain (test/helpers/independent-browser-rig.mjs):
// import + check + confirm a network profile in the UI, publish a component through the real publish form to two of
// three wallet-authorized storage adapters, deploy and fund it on the pinned ledger, watch an independent host claim
// it, list it from agreeing RPC reads (and refuse a false empty list when they cannot agree), commit owner startup
// settings, publish an owner network setting to a public directory, and open/use/end a wallet session on the pinned
// session factory - with every *.enclave.host request refused and the upload-token API never called.
//   run: node --test test/site-independent-browser.test.mjs        (needs anvil, openssl and Playwright's Chromium)
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { keccak256, toBytes, parseUnits } from "viem";
import { createHash } from "node:crypto";
import { startRig, haveTools, walletScript, KEYS } from "./helpers/independent-browser-rig.mjs";
import { verifyPackage, packageCID, preparePackage, challengeAlias } from "../sdk/bootstrap/package.mjs";

const require = createRequire(new URL("../e2e/package.json", import.meta.url));
let chromium = null;
try { ({ chromium } = require("playwright")); } catch {}
const skip = haveTools() || (!chromium && "needs Playwright (cd e2e && npm ci) and its Chromium");

let rig, browser, context, page;
const requests = [], refused = [], pageErrors = [], hostProbes = [];

test.before(async () => {
  if (skip) return;
  rig = await startRig();
  // lean Chromium for the memory allocation (the same flags as the other independent browser tests): no GPU process, one
  // renderer, no extra site-isolation processes, network/audio in the browser process, a capped V8 heap
  try { browser = await chromium.launch({ args: ["--disable-gpu", "--disable-dev-shm-usage", "--renderer-process-limit=1", "--disable-extensions",
    "--disable-features=site-per-process,IsolateOrigins,Translate,OptimizationHints,MediaRouter,AudioServiceOutOfProcess",
    "--enable-features=NetworkServiceInProcess,NetworkServiceInProcess2", "--js-flags=--max-old-space-size=192"] }); }
  catch (e){ await rig.stop(); rig = null; throw new Error("Playwright Chromium is not installed: " + e.message); }
  context = await browser.newContext({ ignoreHTTPSErrors: true, reducedMotion: "reduce" });
  // Enclave refuses service: every enclave.host origin (API, upload gateway, site, DNS names) is unreachable.
  await context.route((url) => /(^|\.)enclave\.host$/i.test(url.hostname) || /upload-token/.test(url.pathname), (route) => {
    refused.push(route.request().url()); return route.abort("blockedbyclient");
  });
  // The rig's registered hosts are unresolvable *.independent.test names. The page's admission read probes only their
  // signed capacity record (js/core/host-liveness.js, GET <endpoint>/v1/host/capacity); answered here, locally, as a host
  // publishing none (404) - liveness then rests on the registry write alone. Any other path to them is refused.
  const hostNames = new Set([rig.endpoint, rig.endpoint2].map((e) => new URL(e).hostname));
  await context.route((url) => hostNames.has(url.hostname), (route) => {
    const u = new URL(route.request().url());
    if (route.request().method() === "GET" && u.pathname === "/v1/host/capacity" && !u.search) {
      hostProbes.push(u.href);
      return route.fulfill({ status: 404, headers: { "access-control-allow-origin": "*", "content-type": "text/plain" }, body: "no capacity record" });
    }
    refused.push(u.href); return route.abort("blockedbyclient");
  });
  context.on("request", (r) => requests.push(r.url()));
  await context.addInitScript({ content: walletScript({ rpc: rig.rpc, address: rig.owner }) });
  await context.addInitScript(({ address }) => {
    if (!localStorage.getItem("enclave_session")) localStorage.setItem("enclave_session", JSON.stringify({ address, rdns: "test.local.wallet" }));
  }, { address: rig.owner });
  page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e && e.message || e)));
});
test.after(async () => { await browser?.close(); await rig?.stop(); });

/* the page restored its wallet session (async EIP-6963 discovery) */
async function walletReady(p = page){
  for (let i = 0; i < 100; i++){
    if (await p.evaluate(async () => !!(await import("/js/core/api.js")).Enclave.address).catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("the wallet never reconnected");
}
async function panel(p = page){
  await p.evaluate(() => customElements.whenDefined("c-deployments"));
  await p.waitForFunction(() => typeof document.querySelector("c-deployments")?.refresh === "function", null, { timeout: 20000 });
}
const ownedIds = async () => {
  const n = await rig.pc.readContract({ address: rig.addresses.ledger, abi: rig.abi.ledger, functionName: "count" });
  const page = await rig.pc.readContract({ address: rig.addresses.ledger, abi: rig.abi.ledger, functionName: "getPage", args: [0n, n] });
  return page;
};

test("profile import: checked against the chain, then active; a new tab must confirm it first", { skip, timeout: 120000 }, async () => {
  await page.goto(rig.site + "/dashboard");
  const panel = page.locator(".ind-mount");
  await panel.locator("summary").click();
  const text = JSON.stringify(rig.profile, null, 2);
  const fp = createHash("sha256").update(text).digest("hex");
  await panel.locator(".ind-text").fill(text);
  // a wrong published fingerprint keeps the profile unusable even though every chain check passes
  await panel.locator(".ind-expect").fill("sha256:" + "0".repeat(64));
  await panel.locator(".ind-check").click();
  await page.waitForFunction(() => /chain endpoints agree/.test(document.querySelector(".ind-out")?.textContent || ""), null, { timeout: 30000 });
  assert.match(await panel.locator(".ind-out").textContent(), /does NOT match/);
  assert.equal(await panel.locator(".ind-use").isDisabled(), true);
  await panel.locator(".ind-expect").fill("sha256:" + fp);
  await panel.locator(".ind-check").click();
  await page.waitForFunction(() => /matches the fingerprint you entered/.test(document.querySelector(".ind-out")?.textContent || ""), null, { timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector(".ind-use").disabled);
  await panel.locator(".ind-use").click();
  await page.waitForLoadState("load");
  await page.waitForSelector(".ind-on", { timeout: 20000 });
  assert.match(await page.locator(".ind-on").textContent(), /Independent mode/);
  // from here on the page runs in independent mode: everything it fetches is measured (the hosted page above,
  // before the profile existed, legitimately used the hosted API)
  requests.length = 0; refused.length = 0;
  const state = await page.evaluate(async () => { const c = await import("/js/core/config.js"); return [c.INDEPENDENT.state, c.DEPLOYMENTS_ADDRESS, c.ADDRESS_BOOK_ADDRESS]; });
  assert.deepEqual(state, ["on", rig.addresses.ledger.toLowerCase(), ""]);
  // a second tab sees the saved profile but must confirm it before anything is pinned
  const tab = await context.newPage();
  await tab.goto(rig.site + "/dashboard");
  await tab.waitForSelector(".ind-pending", { timeout: 20000 });
  assert.equal(await tab.evaluate(async () => (await import("/js/core/config.js")).DEPLOYMENTS_ADDRESS), "");
  assert.equal(await tab.locator(".ind-confirm").isDisabled(), true, "confirming needs the publisher's fingerprint");
  await tab.locator(".ind-confirm-fp").fill(fp.slice(0, 15));
  assert.equal(await tab.locator(".ind-confirm").isDisabled(), true, "fewer than 16 characters are not enough");
  await tab.locator(".ind-confirm-fp").fill("sha256:" + fp.slice(0, 16));
  await tab.locator(".ind-confirm").click();
  await tab.waitForSelector(".ind-on", { timeout: 20000 });
  await tab.close();
});

let appId, depId;
test("publish through the real form: local CID, one signature per adapter, two of three verified copies", { skip, timeout: 180000 }, async () => {
  rig.adapterModes[2] = "refuse";                  // one storage operator refuses: two copies still meet the plan
  await page.goto(rig.site + "/apps#publish");
  await page.waitForSelector("#pubFile", { state: "attached", timeout: 20000 });
  await walletReady();
  const wasm = Buffer.concat([Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00]), Buffer.alloc(600 * 1024, 7)]);
  await page.setInputFiles("#pubFile", { name: "hello.wasm", mimeType: "application/wasm", buffer: wasm });
  await page.waitForFunction(() => (document.querySelector("#pubCid")?.value || "").startsWith("baf"), null, { timeout: 60000 });
  const status = await page.locator("#pubStatus").textContent().catch(() => "");
  assert.match(status || "", /2 of 3 storage adapters returned your exact bytes/);
  const cid = await page.locator("#pubCid").inputValue();
  assert.ok(rig.held[0].has(cid) && rig.held[1].has(cid) && !rig.held[2].has(cid));
  assert.ok(rig.uploads.filter((u) => u.cid === cid).every((u) => u.path === "/add-wasm" && u.signer === rig.owner.toLowerCase()));
  for (const [sel, v] of [["#pubSlug", "hello"], ["#pubVersion", "1.0.0"], ["#pubName", "Hello"], ["#pubMem", "64"], ["#pubCpuG", "10"]])
    await page.locator(sel).fill(v);
  await page.locator("#pubSubmit").click();
  appId = await (async () => {
    for (let i = 0; i < 120; i++){
      const id = await rig.pc.readContract({ address: rig.addresses.catalog, abi: rig.abi.catalog, functionName: "appIdOf", args: [rig.owner, "hello"] }).catch(() => null);
      if (id && !/^0x0+$/.test(id)){
        const n = await rig.pc.readContract({ address: rig.addresses.catalog, abi: rig.abi.catalog, functionName: "numVersions", args: [id] }).catch(() => 0n);
        if (n > 0n) return id;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("publishVersion never landed: " + (await page.locator("#pubStatus").textContent()));
  })();
  rig.adapterModes[2] = "ok";
});

test("deploy and fund on the pinned ledger at the registry's price; an independent host claims; the list shows it", { skip, timeout: 180000 }, async () => {
  assert.ok(appId, "needs the published app");
  await walletReady();
  // the deploy's toasts (refusals) are returned so a missing record names its cause
  const deployOnce = (ref) => page.evaluate(async (ref) => {
    const toasts = [], on = (e) => toasts.push(String(e.detail && e.detail.message));
    document.addEventListener("enclave:toast", on);
    try { await (await import("/js/pages/deploy.js")).deployOnChain({ reference: ref, gpuMilli: 0, cpuMilli: 100, ports: "", isPublic: true, fundUsd: 1, asset: "USDC" }); }
    finally { document.removeEventListener("enclave:toast", on); }
    return toasts;
  }, ref);
  // an owner's own public release stays pending until the catalog admin approves it: no record, no signature
  const n0 = (await ownedIds()).length;
  const pending = await deployOnce(`catalog://${appId}/0`);
  assert.ok(pending.some((t) => /^Deploy refused: /.test(t)), "a pending release is refused: " + JSON.stringify(pending));
  assert.equal((await ownedIds()).length, n0, "no record for a pending release");
  await rig.write(rig.wc(KEYS.deployer), rig.addresses.catalog, rig.abi.catalog, "setApproval", [appId, 0n, 1]);
  const toasts = await deployOnce(`catalog://${appId}/0`);
  let row;
  for (let i = 0; i < 120 && !row; i++){
    row = (await ownedIds()).find((d) => d.owner.toLowerCase() === rig.owner.toLowerCase() && d.balance6 > 0n);
    if (!row) await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(row, "a funded deployment owned by the wallet exists; deploy toasts: " + JSON.stringify(toasts)
    + "; run log: " + JSON.stringify(((await page.locator("body").textContent().catch(() => "")) || "").match(/\[(x|!)\][^\n]{0,200}/g)));
  depId = row.id;
  assert.equal(row.appRef, `catalog://${appId}/0`);
  const cap = await rig.pc.readContract({ address: rig.addresses.ledger, abi: rig.abi.ledger, functionName: "capOf", args: [depId] });
  assert.equal(cap, 100n, "the spend ceiling is the cheapest live registered host's price for 10% of a node");
  // an independent host claims funded work from the ledger on its own (no hint, no API)
  const enclaveId = keccak256(toBytes(rig.endpoint));
  await rig.write(rig.wc("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"), rig.addresses.ledger, rig.abi.ledger, "claim", [depId, enclaveId]);
  const listed = await page.evaluate(async () => (await import("/js/core/api.js")).Enclave.listDeployments());
  const mine = listed.find((d) => d.id === depId);
  assert.equal(mine.status, "claimed"); assert.equal(mine.enclave, rig.endpoint); assert.equal(mine.independent, true);
  await page.goto(rig.site + "/dashboard");
  await walletReady(); await panel();
  await page.waitForFunction((id) => [...document.querySelectorAll(".enc-row")].some((r) => r.textContent.includes("claimed")), depId, { timeout: 30000 });
});

test("listing needs agreeing RPCs: one liar is outvoted, a split refuses (never an empty list)", { skip, timeout: 120000 }, async () => {
  assert.ok(depId, "needs the deployment");
  await walletReady(); await panel();
  rig.rpcModes[2] = "lie";
  const ok = await page.evaluate(async () => (await import("/js/core/api.js")).Enclave.listDeployments());
  assert.ok(ok.some((d) => d.id === depId && d.status === "claimed"));
  rig.rpcModes[0] = "down";
  const err = await page.evaluate(async () => { try { await (await import("/js/core/api.js")).Enclave.listDeployments(); return null; } catch (e){ return e.message; } });
  assert.match(err, /disagree|only 1 of 3/);
  await page.evaluate(() => document.querySelector("c-deployments").refresh({ spinner: true }));
  await page.waitForFunction(() => /failed read, not an empty list|Couldn’t refresh/.test(document.querySelector("c-deployments")?.textContent || ""), null, { timeout: 30000 });
  rig.rpcModes[0] = "ok"; rig.rpcModes[2] = "ok";
});

test("owner startup settings: published to the storage plan, re-read, committed by the owner's transaction", { skip, timeout: 180000 }, async () => {
  assert.ok(depId, "needs the deployment");
  await page.goto(rig.site + "/dashboard");
  await walletReady(); await panel();
  await page.evaluate(() => document.querySelector("c-deployments").refresh({ spinner: true }));
  const row = page.locator(".enc-row", { hasText: "claimed" }).first();
  await row.locator(".enc-startbtn").click();
  await row.locator(".es-app").waitFor({ timeout: 30000 });
  await row.locator(".es-cfg").fill('{"greeting":"independent"}');
  await row.locator(".es-app").fill("a1".repeat(32));
  await row.locator(".es-rt").fill("b2".repeat(32));
  const up0 = rig.uploads.length;
  await row.locator(".es-go").click();
  await page.waitForFunction(() => /\[✓\] committed:|\[x\]/.test(document.querySelector(".enc-start-status")?.textContent || ""), null, { timeout: 90000 });
  const done = await page.locator(".enc-start-status").textContent();
  assert.match(done, /\[✓\] 2 of 3 storage adapters hold the exact bytes|\[✓\] 3 of 3 storage adapters hold the exact bytes/);
  assert.match(done, /\[✓\] committed:/, done);
  // a wallet identity: unchanged, the wallet key signs each upload (v1, EIP-191)
  assert.ok(rig.uploads.length > up0 && rig.uploads.slice(up0).every((u) => u.signer === rig.owner.toLowerCase() && u.scheme === "v1"), JSON.stringify(rig.uploads.slice(up0)));
  const d = await rig.pc.readContract({ address: rig.addresses.ledger, abi: rig.abi.ledger, functionName: "get", args: [depId] });
  const env = JSON.parse(d.configCid);
  assert.equal(env.isolation.require, "snp-guest-per-app");
  const cid = packageCID(env.guestBootstrap.sha256);
  const bytes = rig.held[0].get(cid) || rig.held[1].get(cid);
  assert.ok(bytes, "the committed package is held by the adapters");
  const pkg = verifyPackage(bytes, env.guestBootstrap, { chainId: 8453, ledger: rig.addresses.ledger, deployment: depId, owner: rig.owner, appRef: d.appRef });
  assert.equal(pkg.manifest.configText, '{"greeting":"independent"}');
  assert.equal(pkg.manifest.secretsMode, "public");
});

test("a record created for owner-published startup cannot start until its settings are committed", { skip, timeout: 120000 }, async () => {
  assert.ok(appId, "needs the published app");
  await walletReady();
  const before = (await ownedIds()).length;
  const deploy = (fundUsd) => page.evaluate(async ({ ref, fundUsd }) => (await import("/js/pages/deploy.js")).deployOnChain({ reference: ref, gpuMilli: 0,
    cpuMilli: 100, ports: "", isPublic: true, fundUsd, asset: "USDC", prepareOnly: true }), { ref: `catalog://${appId}/0`, fundUsd });
  await deploy(5);                                   // funding a record that cannot start yet is refused before any signature
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal((await ownedIds()).length, before);
  await deploy(0);
  let rows;
  for (let i = 0; i < 60; i++){ rows = await ownedIds(); if (rows.length > before) break; await new Promise((r) => setTimeout(r, 500)); }
  const created = rows[rows.length - 1];
  assert.equal(rows.length, before + 1);
  assert.equal(created.owner.toLowerCase(), rig.owner.toLowerCase());
  assert.equal(created.balance6, 0n);
  assert.deepEqual(JSON.parse(created.configCid), { isolation: { require: "snp-guest-per-app" }, guestBootstrap: { version: 1, sha256: "f".repeat(64) } });
  await walletReady();
});

test("owner network setting: signed by the wallet and published to the profile's directory", { skip, timeout: 120000 }, async () => {
  assert.ok(depId, "needs the deployment");
  await page.goto(rig.site + "/dashboard");
  await walletReady(); await panel();
  await page.waitForFunction(() => [...document.querySelectorAll(".enc-row")].some((r) => r.textContent.includes("claimed")), null, { timeout: 30000 });
  const row = page.locator(".enc-row", { hasText: "claimed" }).first();
  await row.locator(".enc-netbtn").click();
  await row.locator(".enc-network-controls").waitFor({ timeout: 30000 });
  await row.locator('.enc-network-controls select[name="routes"]').selectOption("1");
  await row.locator(".enc-network-controls button[type=submit]").click();
  await page.waitForFunction(() => /Published to 1 of 1 directories/.test(document.querySelector(".enc-network-controls [data-save]")?.textContent || ""), null, { timeout: 60000 });
  const stored = await rig.directory.policy(depId);
  assert.equal(stored.envelope.policy.enclaveNetwork.routes, 1);
  assert.ok(stored.envelope.policy.nonce >= Math.floor(Date.now() / 1000) - 600);
});

test("a wallet session on the pinned factory: opened, used and ended through wallet-submitted calldata", { skip, timeout: 180000 }, async () => {
  assert.ok(appId, "needs the published app");
  await walletReady();
  const before = await rig.pc.readContract({ address: rig.addresses.usdc, abi: rig.abi.usdc, functionName: "balanceOf", args: [rig.owner] });
  const opened = await page.evaluate(async () => {
    const S = await import("/js/core/sessions.js");
    const c = await S.startSession({ budgetUsd: 2, hours: 1 });
    return { vault: c.session.handle.vault, sid: c.session.handle.sid };
  });
  const vault = await rig.pc.readContract({ address: rig.addresses.factory, abi: rig.abi.factory, functionName: "vaultFor", args: [rig.owner] });
  assert.equal(opened.vault.toLowerCase(), vault.toLowerCase());
  const created = await page.evaluate(async ({ ref }) => {
    const S = await import("/js/core/sessions.js");
    return (await S.sessionCall("deploy.create", { appRef: ref, gpuMilli: 0, cpuMilli: 100, appPort: 8080, ports: "", isPublic: true, configCid: "",
      maxRate6: 100n, env: "staging", fund6: 500000n })).txHash;
  }, { ref: `catalog://${appId}/0` });
  assert.match(created, /^0x[0-9a-f]{64}$/);
  const vaultRow = (await ownedIds()).find((d) => d.owner.toLowerCase() === vault.toLowerCase());
  assert.ok(vaultRow && vaultRow.balance6 === 500000n, "the session's vault owns a funded deployment");
  const listed = await page.evaluate(async () => (await import("/js/core/api.js")).Enclave.listDeployments());
  assert.ok(listed.some((d) => d.id === vaultRow.id), "the vault's rows are listed with the wallet's");
  await page.evaluate(async () => (await import("/js/core/sessions.js")).endSession({ quiet: true }));
  const after = await rig.pc.readContract({ address: rig.addresses.usdc, abi: rig.abi.usdc, functionName: "balanceOf", args: [rig.owner] });
  assert.equal(before - after, 500000n, "the unspent session budget returned to the owner");
});

const sessionOnChain = async (vault, sid) => (await import("../sdk/sessions/dist/node.mjs")).readSession(rig.pc, vault, sid);
const heldOf = async (vault, id) => rig.pc.readContract({ address: vault, abi: [{ type: "function", name: "held", stateMutability: "view", inputs: [{ type: "bytes32" }],
  outputs: [{ type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }] }], functionName: "held", args: [id] });

test("owner operations from the dashboard: start, add budget, extend, promote a production record, end all - each a wallet transaction to the vault", { skip, timeout: 240000 }, async () => {
  assert.ok(appId, "needs the published app");
  await page.goto(rig.site + "/dashboard");
  await walletReady(); await panel();
  await page.waitForSelector(".ind-sess", { timeout: 30000 });
  await page.locator(".ind-s-open").click();
  await page.locator("#smBudget").fill("2");
  await page.locator("#smGo").click();
  await page.waitForFunction(() => /Wallet session<\/b> live/.test(document.querySelector(".ind-sess")?.innerHTML || ""), null, { timeout: 60000 });
  const st0 = await page.evaluate(async () => { const s = await (await import("/js/core/sessions.js")).sessionStatus(); return { vault: s.vault, sid: s.sid, balance6: String(s.balance6), expiresAt: String(s.expiresAt) }; });
  assert.equal(st0.balance6, "2000000");
  // add budget: one USDC authorization bound to this top-up, submitted by the wallet (no relayer)
  await page.locator(".ind-s-top").click();
  await page.locator("#tuAmt").fill("1");
  await page.locator("#tuGo").click();
  await page.waitForFunction(() => /\$3\.00 left/.test(document.querySelector(".ind-sess")?.textContent || ""), null, { timeout: 60000 });
  // extend: the vault's extend(), sent by its owner
  await page.locator(".ind-s-ext").click();
  await page.locator("#exGo").click();
  for (let i = 0; i < 60; i++){
    const st = await page.evaluate(async () => String((await (await import("/js/core/sessions.js")).sessionStatus()).expiresAt));
    if (BigInt(st) > BigInt(st0.expiresAt) + 3600n) break;
    if (i === 59) throw new Error("the session was not extended");
    await new Promise((r) => setTimeout(r, 500));
  }
  // a session-created record, moved to production by the owner, then a version change becomes the owner's Promote
  const ref = `catalog://${appId}/0`;
  await page.evaluate(async (ref) => (await import("/js/core/sessions.js")).sessionCall("deploy.create", { appRef: ref, gpuMilli: 0, cpuMilli: 100,
    appPort: 8080, ports: "", isPublic: true, configCid: "", maxRate6: 100n, env: "staging", fund6: 200000n }), ref);
  const row = (await ownedIds()).filter((d) => d.owner.toLowerCase() === st0.vault.toLowerCase()).at(-1);
  assert.equal(Number((await heldOf(st0.vault, row.id))[0]), 1, "staging");
  await page.evaluate(async (id) => (await import("/js/core/sessions.js")).ownerOp({ op: "setEnvironment", deployment: id, environment: "prod" }), row.id);
  const [env1, promoted1] = await heldOf(st0.vault, row.id);
  assert.equal(Number(env1), 2); assert.equal(promoted1, "0x" + "00".repeat(32));
  await page.evaluate(async ({ id, ref }) => {
    const { encCall, DEP_SEL } = await import("/js/core/chain.js");
    const S = await import("/js/core/sessions.js");
    return S.ledgerSend(encCall(DEP_SEL.setAppRef, [{ t: "bytes32", v: id }, { t: "str", v: ref }]), () => { throw new Error("must not fall back to a wallet ledger call"); });
  }, { id: row.id, ref });
  const [env2, promoted2] = await heldOf(st0.vault, row.id);
  assert.equal(Number(env2), 2);
  assert.notEqual(promoted2, "0x" + "00".repeat(32), "the owner's promotion is recorded by the vault");
  // end every session: revokeAll from the owner's wallet
  page.once("dialog", (d) => d.accept());
  await page.locator(".ind-s-revoke").click();
  await page.waitForFunction(() => /Wallet session<\/b> ended|Wallet session:<\/b> none/.test(document.querySelector(".ind-sess")?.innerHTML || ""), null, { timeout: 60000 });
  assert.equal((await sessionOnChain(st0.vault, st0.sid)).live, false);
  await page.evaluate(async () => (await import("/js/core/sessions.js")).endSession({ quiet: true }));
});

test("ETH funding at the ledger's own feed, read at an agreed block; a stale feed refuses before any value is sent", { skip, timeout: 180000 }, async () => {
  assert.ok(appId, "needs the published app");
  await walletReady();
  const deploy = (extra) => page.evaluate(async ({ ref, extra }) => (await import("/js/pages/deploy.js")).deployOnChain({ reference: ref, gpuMilli: 0,
    cpuMilli: 100, ports: "", isPublic: true, ...extra }), { ref: `catalog://${appId}/0`, extra });
  const newRow = async (n0) => { for (let i = 0; i < 60; i++){ const r = await ownedIds(); if (r.length > n0) return r.at(-1); await new Promise((x) => setTimeout(x, 500)); } throw new Error("no new record"); };
  let n0 = (await ownedIds()).length;
  await deploy({ fundUsd: 1, asset: "ETH" });
  let row = await newRow(n0);
  for (let i = 0; i < 60 && row.balance6 === 0n; i++){ await new Promise((x) => setTimeout(x, 500)); row = (await ownedIds()).find((d) => d.id === row.id); }
  // usdToWei(1, 2400) = 416667 gwei; the ledger credits wei * answer / 1e20
  assert.equal(row.balance6, (416667n * 10n ** 9n * 2400n * 10n ** 8n) / 10n ** 20n);
  // a stale answer: the dashboard refuses the ETH payment (the record stays, unfunded, with a retry offered)
  const now = (await rig.pc.getBlock()).timestamp;
  await rig.write(rig.wc("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"), rig.addresses.feed, rig.abi.feed, "set", [2400n * 10n ** 8n, now - 7000n, 8n, 8n, 8]);
  n0 = (await ownedIds()).length;
  await deploy({ fundUsd: 1, asset: "ETH" });
  const stale = await newRow(n0);
  await new Promise((x) => setTimeout(x, 1500));
  assert.equal((await ownedIds()).find((d) => d.id === stale.id).balance6, 0n);
  assert.match(await page.locator("body").textContent(), /No ETH\/USD quote available right now \(the ETH\/USD feed's answer is \d+s old/);
  await rig.write(rig.wc("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"), rig.addresses.feed, rig.abi.feed, "set", [2400n * 10n ** 8n, (await rig.pc.getBlock()).timestamp, 9n, 9n, 8]);
});

test("host choice: registry hosts with posted prices; a pinned record carries the host and that host's price ceiling", { skip, timeout: 120000 }, async () => {
  assert.ok(appId, "needs the published app");
  await walletReady();
  const hosts = await page.evaluate(async () => (await import("/js/core/api.js")).Enclave.getEnclaves());
  const b = hosts.find((h) => h.endpoint === rig.endpoint2);
  assert.ok(b && b.serving === true && b.cpuPricePerSec6 === 3000, "the second host is listed with its posted price and a recent heartbeat");
  const n0 = (await ownedIds()).length;
  await page.evaluate(async ({ ref, b }) => (await import("/js/pages/deploy.js")).deployOnChain({ reference: ref, gpuMilli: 0, cpuMilli: 100, ports: "",
    isPublic: true, fundUsd: 0, asset: "USDC", pinHost: b }), { ref: `catalog://${appId}/0`, b });
  let row; for (let i = 0; i < 60; i++){ const r = await ownedIds(); if (r.length > n0){ row = r.at(-1); break; } await new Promise((x) => setTimeout(x, 500)); }
  assert.deepEqual(JSON.parse(row.configCid), { placement: { hostId: keccak256(toBytes(rig.endpoint2)) } });
  assert.equal(await rig.pc.readContract({ address: rig.addresses.ledger, abi: rig.abi.ledger, functionName: "capOf", args: [row.id] }), 300n,
    "ceiling = the chosen host's posted price for 10% of a node, not the cheapest host's");
  // an explicit ceiling below the chosen host's own total is refused before any signature, never raised to fit
  const n1 = (await ownedIds()).length;
  await page.evaluate(async ({ ref, b }) => (await import("/js/pages/deploy.js")).deployOnChain({ reference: ref, gpuMilli: 0, cpuMilli: 100, ports: "",
    isPublic: true, fundUsd: 0, asset: "USDC", pinHost: b, maxRate6: "200" }), { ref: `catalog://${appId}/0`, b });
  await page.waitForFunction(() => /above your ceiling of \$0\.72\/hr: it could never claim it\. Raise the ceiling or choose another host - nothing was sent/.test(document.body.textContent), null, { timeout: 30000 });
  await new Promise((x) => setTimeout(x, 1500));
  assert.equal((await ownedIds()).length, n1, "no record was created");
});

const capOf = (id) => rig.pc.readContract({ address: rig.addresses.ledger, abi: rig.abi.ledger, functionName: "capOf", args: [id] });
const recordOf = (id) => rig.pc.readContract({ address: rig.addresses.ledger, abi: rig.abi.ledger, functionName: "get", args: [id] });
const until = async (f, what, n = 120) => { for (let i = 0; i < n; i++){ const v = await f(); if (v) return v; await new Promise((x) => setTimeout(x, 500)); } throw new Error("timed out: " + what); };
const openRow = async (id) => {
  await page.goto(rig.site + "/dashboard");
  await walletReady(); await panel();
  await page.locator(".enc-search").fill(id.slice(2, 14));
  await page.waitForFunction(() => document.querySelectorAll(".enc-row").length === 1, null, { timeout: 30000 });
  return page.locator(".enc-row").first();
};

test("a refusing cheapest host: the ceiling never rises by itself; the owner picks a dearer host within an explicit ceiling (Host & price, no API)", { skip, timeout: 180000 }, async () => {
  assert.ok(appId, "needs the published app");
  await walletReady();
  const n0 = (await ownedIds()).length;
  await page.evaluate(async (ref) => (await import("/js/pages/deploy.js")).deployOnChain({ reference: ref, gpuMilli: 0, cpuMilli: 100, ports: "",
    isPublic: true, fundUsd: 0.5, asset: "USDC" }), `catalog://${appId}/0`);
  const id = (await until(async () => { const r = await ownedIds(); return r.length > n0 && r.at(-1).balance6 > 0n && r.at(-1); }, "funded record")).id;
  assert.equal(await capOf(id), 100n, "default ceiling: the cheapest charging host's own total");
  // host A (cheapest) never claims; host B cannot claim above the owner's ceiling, and nothing raises it
  const hostB = keccak256(toBytes(rig.endpoint2));
  await assert.rejects(rig.write(rig.wc(KEYS.operator2), rig.addresses.ledger, rig.abi.ledger, "claim", [id, hostB]));
  await new Promise((x) => setTimeout(x, 3000));
  assert.equal(await capOf(id), 100n, "no automatic ceiling increase");
  const row = await openRow(id);
  await row.locator(".enc-hostbtn").click();
  await row.locator(".enc-host-list").waitFor({ timeout: 30000 });
  const list = await row.locator(".enc-host-list").textContent();
  assert.match(list, new RegExp(rig.endpoint.replace(/\./g, "\\.") + " · \\$0\\.3600/hr for this size · within the ceiling"));
  assert.match(list, new RegExp(rig.endpoint2.replace(/\./g, "\\.") + " · \\$1\\.0800/hr for this size · above the ceiling"));
  assert.match(list, /not reserved capacity/);
  // choosing B without raising the ceiling is refused before any transaction
  await row.locator(".eh-host").selectOption(hostB);
  await row.locator(".eh-go").click();
  await page.waitForFunction(() => /above that ceiling/.test(document.querySelector(".enc-host-status")?.textContent || ""), null, { timeout: 20000 });
  assert.equal(await capOf(id), 100n);
  // the owner's explicit ceiling: B's own total, and the placement pin
  await row.locator(".eh-cap").fill("1.08");
  await row.locator(".eh-go").click();
  await until(async () => (await capOf(id)) === 300n && (await recordOf(id)).configCid.includes(hostB), "owner's ceiling and pin");
  assert.deepEqual(JSON.parse((await recordOf(id)).configCid), { placement: { hostId: hostB } });
  await rig.write(rig.wc(KEYS.operator2), rig.addresses.ledger, rig.abi.ledger, "claim", [id, hostB]);
  const d = await recordOf(id);
  assert.equal(d.runner, hostB, "the independent dearer host holds the lease");
  assert.equal(d.rate, 300n, "at its own posted total, inside the owner's ceiling");
  const again = await openRow(id);
  await again.locator(".enc-hostbtn").click();
  await page.waitForFunction(() => /host-b\.independent\.test · \$1\.0800\/hr for this size · within the ceiling · holds the lease now/.test(document.querySelector(".enc-host-list")?.textContent || ""), null, { timeout: 30000 });
});

test("quick deploy (independent): per-host totals, owner-set ceiling, host above the ceiling flagged, the chosen host and ceiling reach the record", { skip, timeout: 180000 }, async () => {
  assert.ok(appId, "needs the published app");
  await page.goto(rig.site + "/apps?app=" + appId);
  await walletReady();
  await page.locator('#appDetailView [data-act="deploy"]').first().click({ timeout: 30000 });
  await page.waitForFunction(() => (document.querySelector(".qd-indhost")?.options.length || 0) >= 3, null, { timeout: 30000 });
  const opts = await page.locator(".qd-indhost option").allTextContents();
  assert.match(opts[1], new RegExp("^" + rig.endpoint.replace(/\./g, "\\.") + " · \\$[0-9.]+/hr for this size"), "cheapest total first");
  assert.match(opts[2], new RegExp("^" + rig.endpoint2.replace(/\./g, "\\.")));
  const a = await page.locator(".qd-cap").inputValue();
  assert.ok(Math.abs(parseFloat(a) - parseFloat(/\$([0-9.]+)\/hr/.exec(opts[1])[1])) < 0.006, "suggested ceiling = the cheapest host's own total");
  await page.locator(".qd-indhost").selectOption({ index: 2 });
  const b = await page.locator(".qd-cap").inputValue();
  assert.ok(Math.abs(parseFloat(b) - 3 * parseFloat(a)) < 0.0002, "an untouched ceiling follows the chosen host (3x the price)");
  const typed = (2 * parseFloat(a)).toFixed(4);                     // above host A's total, below host B's
  await page.locator(".qd-cap").fill(typed);
  assert.match(await page.locator(".qd-capnote").textContent(), /could never take it/);
  await page.locator(".qd-indhost").selectOption({ index: 1 });
  assert.equal(await page.locator(".qd-cap").inputValue(), typed, "a ceiling the owner typed is never overwritten");
  assert.match(await page.locator(".qd-capnote").textContent(), /1 of 2 live host\(s\)/);
  await page.locator(".qd-indhost").selectOption({ index: 2 });
  await page.locator(".qd-cap").fill(b);
  assert.match(await page.locator(".qd-capnote").textContent(), /2 of 2 live host\(s\)/);
  await page.locator("#qdAmt").fill("0");
  const tos = page.locator(".qd-tosck"); if (!(await tos.isChecked())) await tos.check();
  const n0 = (await ownedIds()).length;
  await page.locator(".qd-go").click();
  const row = await until(async () => { const r = await ownedIds(); return r.length > n0 && r.at(-1); }, "record from the modal");
  assert.deepEqual(JSON.parse(row.configCid), { placement: { hostId: keccak256(toBytes(rig.endpoint2)) } });
  assert.equal(await capOf(row.id), BigInt(Math.ceil(parseFloat(b) * 1e6 / 3600)), "the owner's ceiling, exactly");
});

test("listing is bounded and resumable: partial results are labeled, transfers in and out follow the ledger's events, add by id", { skip, timeout: 240000 }, async () => {
  assert.ok(appId, "needs the published app");
  const dep = rig.wc(KEYS.deployer), ref = `catalog://${appId}/0`;
  const CREATED = keccak256(toBytes("Created(bytes32,address,string,uint16,uint16,uint256)"));
  const filler = [];
  for (let i = 0; i < 105; i++){
    const rc = await rig.write(dep, rig.addresses.ledger, rig.abi.ledger, "create", [ref, 0, 100, 8080, "", true, "", "0x" + "00".repeat(20), 0n, 100n]);
    filler.push(rc.logs.find((l) => l.topics[0] === CREATED).topics[1]);
  }
  // one of the wallet's records past the first 100-record page
  await rig.write(rig.wc(KEYS.owner), rig.addresses.ledger, rig.abi.ledger, "create", [ref, 0, 100, 8080, "", true, "", "0x" + "00".repeat(20), 0n, 100n]);
  const all = await ownedIds();
  const late = all.at(-1).id;
  assert.ok(all.findIndex((d) => d.id === late) >= 100, "the new record lies beyond the first page");
  await page.goto(rig.site + "/dashboard");
  await walletReady(); await panel();
  // let the first (default-sized) read finish, then shrink each step to one page and forget this tab's index
  await page.waitForFunction(() => /Read from the ledger at block/.test(document.querySelector(".enc-scannote")?.textContent || ""), null, { timeout: 60000 });
  await page.evaluate(async () => {
    (await import("/js/core/independent-list.js")).LIST_LIMITS.maxPages = 1;
    for (const k of Object.keys(sessionStorage)) if (k.startsWith("enclave_ind_index")) sessionStorage.removeItem(k);
    document.querySelector("c-deployments").refresh({ spinner: true });
  });
  await page.waitForFunction(() => /Partial list:<\/b> checked 100 of/.test(document.querySelector(".enc-scannote")?.innerHTML || ""), null, { timeout: 30000 });
  assert.ok(!(await page.locator(".enc-body").textContent()).includes(late), "not listed before the scan reaches it");
  // the panel keeps reading on its own until the scan is complete
  await page.waitForFunction(() => /Read from the ledger at block \d+ \(\d+ records checked\)/.test(document.querySelector(".enc-scannote")?.textContent || ""), null, { timeout: 60000 });
  const listed = async () => page.evaluate(async () => { const r = await (await import("/js/core/api.js")).Enclave.listDeployments(); return { ids: r.map((d) => d.id), scan: r.independentScan }; });
  let l = await listed();
  assert.ok(l.scan.complete && l.ids.includes(late));
  // transfers, applied from DeploymentTransferred events (no rescan): one out of the wallet, one in from elsewhere
  await rig.write(rig.wc(KEYS.owner), rig.addresses.ledger, rig.abi.ledger, "transferDeployment", [late, "0x" + "0d".repeat(20)]);
  await rig.write(dep, rig.addresses.ledger, rig.abi.ledger, "transferDeployment", [filler[3], rig.owner]);
  l = await until(async () => { const x = await listed(); return x.ids.includes(filler[3]) && x; }, "transfer in listed");
  assert.equal(l.scan.mode, "events"); assert.equal(l.scan.complete, true);
  assert.ok(!l.ids.includes(late), "transferred away: gone");
  // add by id: a deployment owned by someone else is named as such, never listed as the wallet's
  await page.evaluate(() => document.querySelector("c-deployments").refresh({ spinner: true }));
  await page.locator(".enc-watch").waitFor({ timeout: 30000 });
  await page.locator(".enc-watch").fill(filler[7]);
  await page.locator(".enc-watch-go").click();
  await page.waitForFunction((p) => (document.querySelector(".enc-scannote")?.textContent || "").includes("Not owned by this wallet: " + p), filler[7].slice(0, 10), { timeout: 30000 });
});

test("custom names: added with the challenge alias shown, edited, deleted - each the CLI's exact package bytes, committed by the owner", { skip, timeout: 300000 }, async () => {
  assert.ok(depId, "needs the deployment with committed startup settings");
  const zone = "acme.responder.example";
  const startTab = async () => {
    const row = await openRow(depId);
    await row.locator(".enc-startbtn").click();
    await row.locator(".es-hosts").waitFor({ timeout: 30000 });
    await page.waitForFunction(() => /storage adapters return the exact committed bytes/.test(document.querySelector(".enc-start-status")?.textContent || ""), null, { timeout: 30000 });
    return row;
  };
  const commit = async (row) => {
    const before = (await recordOf(depId)).configCid;
    await row.locator(".es-go").click();
    await page.waitForFunction(() => /\[✓\] committed:|\[x\]/.test(document.querySelector(".enc-start-status")?.textContent || ""), null, { timeout: 90000 });
    assert.match(await page.locator(".enc-start-status").textContent(), /\[✓\] committed:/);
    const d = await recordOf(depId);
    assert.notEqual(d.configCid, before);
    const env = JSON.parse(d.configCid), cid = packageCID(env.guestBootstrap.sha256);
    const bytes = rig.held[0].get(cid) || rig.held[1].get(cid);
    const pkg = verifyPackage(bytes, env.guestBootstrap, { chainId: 8453, ledger: rig.addresses.ledger, deployment: depId, owner: rig.owner, appRef: d.appRef });
    assert.equal(Buffer.from(preparePackage(pkg.manifest).bytes).toString("hex"), Buffer.from(bytes).toString("hex"), "the CLI's canonical bytes, exactly");
    assert.equal(pkg.manifest.configText, '{"greeting":"independent"}', "settings not touched by the names editor are preserved");
    return pkg.manifest;
  };
  // add
  let row = await startTab();
  assert.equal(await row.locator(".es-hosts").inputValue(), "");
  await row.locator(".es-hosts").fill("WWW.example.org\nshop.example.org");
  await row.locator(".es-names summary").click();
  await row.locator(".es-acme-dir").fill("https://ca.example/directory");
  await row.locator(".es-acme-ch").fill("https://responder.example");
  await row.locator(".es-acme-zone").fill(zone);
  const alias = challengeAlias(depId, rig.owner, zone);
  await page.waitForFunction((a) => (document.querySelector(".es-dns")?.textContent || "").includes(a), alias, { timeout: 20000 });
  assert.equal((await row.locator(".es-dns").textContent()).trim(),
    ["shop.example.org", "www.example.org"].map((h) => `_acme-challenge.${h}.  CNAME  ${alias}.`).join("\n"));
  assert.match(await row.locator(".es-names-preview").textContent(), /adding shop\.example\.org, www\.example\.org.*claim, not proof/s);
  let m = await commit(row);
  assert.equal(JSON.stringify(m.names), JSON.stringify({ hosts: ["shop.example.org", "www.example.org"], acme: { directory: "https://ca.example/directory", challenge: "https://responder.example", zone } }),
    "the CLI's member, in the CLI's key order");
  // edit: the form starts from the committed names; drop one name and the CA selection
  row = await startTab();
  assert.equal(await row.locator(".es-hosts").inputValue(), "shop.example.org\nwww.example.org");
  assert.equal(await row.locator(".es-acme-zone").inputValue(), zone);
  await row.locator(".es-hosts").fill("www.example.org");
  for (const s of [".es-acme-dir", ".es-acme-ch", ".es-acme-zone"]) await row.locator(s).fill("");
  assert.match(await row.locator(".es-names-preview").textContent(), /removing shop\.example\.org.*issued outside the app/s);
  m = await commit(row);
  assert.deepEqual(m.names, { hosts: ["www.example.org"] });
  // an invalid name is refused before any signature
  row = await startTab();
  await row.locator(".es-hosts").fill("app.enclave.host");
  assert.match(await row.locator(".es-names-preview").textContent(), /✗/);
  const was = (await recordOf(depId)).configCid, n = rig.uploads.length;
  await row.locator(".es-go").click();
  await page.waitForFunction(() => /\[x\]/.test(document.querySelector(".enc-start-status")?.textContent || ""), null, { timeout: 20000 });
  assert.equal((await recordOf(depId)).configCid, was); assert.equal(rig.uploads.length, n, "nothing was uploaded");
  // committed settings that cannot be read back: replacing them needs an explicit confirmation
  const cidNow = packageCID(JSON.parse(was).guestBootstrap.sha256);
  const stash = rig.held.map((m) => m.get(cidNow));
  rig.held.forEach((m) => m.delete(cidNow));
  try {
    const row2 = await openRow(depId);
    await row2.locator(".enc-startbtn").click();
    await row2.locator(".es-blind").waitFor({ timeout: 30000 });
    assert.equal(await row2.locator(".es-hosts").inputValue(), "", "nothing to prefill from");
    await row2.locator(".es-app").fill("a1".repeat(32)); await row2.locator(".es-rt").fill("b2".repeat(32));
    await row2.locator(".es-go").click();
    await page.waitForFunction(() => /confirm that you want to replace them/.test(document.querySelector(".enc-start-status")?.textContent || ""), null, { timeout: 20000 });
    assert.equal((await recordOf(depId)).configCid, was);
  } finally { stash.forEach((b, i) => b && rig.held[i].set(cidNow, b)); }
  row = await startTab();
  assert.equal(await row.locator(".es-hosts").inputValue(), "www.example.org");
  // delete
  await row.locator(".es-hosts").fill("");
  assert.match(await row.locator(".es-names-preview").textContent(), /No custom names.*removing www\.example\.org/s);
  m = await commit(row);
  assert.ok(!("names" in m), "deleted: the package has no names member");
});

test("Startup tier: SEV-SNP by default; an Enclave Shield partition only when chosen, public settings only, and it reads back", { skip, timeout: 240000 }, async () => {
  assert.ok(depId, "needs the deployment with committed startup settings");
  const open = async () => {
    const row = await openRow(depId);
    await row.locator(".enc-startbtn").click();
    await row.locator(".es-backend").waitFor({ timeout: 30000 });
    await page.waitForFunction(() => /storage adapters return the exact committed bytes/.test(document.querySelector(".enc-start-status")?.textContent || ""), null, { timeout: 30000 });
    return row;
  };
  const commit = async (row) => {
    await row.locator(".es-go").click();
    await page.waitForFunction(() => /\[✓\] committed:|\[x\]/.test(document.querySelector(".enc-start-status")?.textContent || ""), null, { timeout: 90000 });
    return page.locator(".enc-start-status").textContent();
  };
  let row = await open();
  assert.equal(await row.locator(".es-backend").inputValue(), "snp-guest-per-app", "the default, as the CLI writes it");
  assert.match(await row.locator(".es-backend-note").textContent(), /re-reads your commitment on chain before it starts/);
  await row.locator(".es-backend").selectOption("hyperv-partition-per-app");
  assert.match(await row.locator(".es-backend-note").textContent(), /Weaker than the default.*custody-v2 secrets.*must be public.*does not offer this choice yet/s);
  // custody with Shield is refused before anything is uploaded
  const n0 = rig.uploads.length, before = (await recordOf(depId)).configCid;
  await row.locator(".enc-start details summary").first().click();
  await row.locator(".es-cust").fill(JSON.stringify({ v: 2, chainId: 8453 }));
  let done = await commit(row);
  assert.match(done, /\[x\] an Enclave Shield partition never receives custody-v2 secrets/);
  assert.equal(rig.uploads.length, n0); assert.equal((await recordOf(depId)).configCid, before);
  row = await open();
  await row.locator(".es-backend").selectOption("hyperv-partition-per-app");
  done = await commit(row);
  assert.match(done, /\[✓\] committed:/, done);
  const env = JSON.parse((await recordOf(depId)).configCid);
  assert.equal(env.isolation.require, "hyperv-partition-per-app");
  const cid = packageCID(env.guestBootstrap.sha256), bytes = rig.held[0].get(cid) || rig.held[1].get(cid);
  const pkg = verifyPackage(bytes, env.guestBootstrap, { chainId: 8453, ledger: rig.addresses.ledger, deployment: depId, owner: rig.owner, appRef: (await recordOf(depId)).appRef });
  assert.equal(pkg.manifest.secretsMode, "public");
  assert.equal(Buffer.from(preparePackage(pkg.manifest).bytes).toString("hex"), Buffer.from(bytes).toString("hex"), "the same CLI package bytes for either tier");
  // it reads back as Shield; choosing the default again restores SEV-SNP
  row = await open();
  assert.equal(await row.locator(".es-backend").inputValue(), "hyperv-partition-per-app");
  await row.locator(".es-backend").selectOption("snp-guest-per-app");
  assert.match(await commit(row), /\[✓\] committed:/);
  assert.equal(JSON.parse((await recordOf(depId)).configCid).isolation.require, "snp-guest-per-app");
});

test("Connect: a native-client starting profile from the network profile's pins, with the open trust decisions named", { skip, timeout: 120000 }, async () => {
  await page.goto(rig.site + "/dashboard");
  await walletReady(); await panel();
  await page.locator(".enc-search").fill(depId.slice(2, 12));      // the list pages five rows at a time
  await page.waitForFunction(() => [...document.querySelectorAll(".enc-row")].some((r) => r.textContent.includes("claimed")), null, { timeout: 30000 });
  const row = page.locator(".enc-row", { hasText: "claimed" }).first();
  await row.locator(".enc-natbtn").click();
  const json = JSON.parse(await row.locator(".enc-nat-json").textContent());
  assert.equal(json.deploymentId, depId);
  assert.equal(json.authorityPins.deployments, rig.addresses.ledger.toLowerCase());
  assert.equal(json.checkers, null, "checker trust is left to the user");
  assert.match(await row.locator(".enc-nat-todo").textContent(), /checkers/);
});

test("nothing reached Enclave: no enclave.host request, no upload-token call, no other origin", { skip }, () => {
  if (process.env.IND_DEBUG) console.log({ refused, hosts: [...new Set(requests.map((u) => new URL(u).host))], pageErrors });
  assert.deepEqual(refused, [], "the browser never tried an Enclave origin");
  // the registered hosts' own capacity probes were answered by the local fixture above (and only that path, GET)
  const hostOrigins = new Set([rig.endpoint, rig.endpoint2].map((e) => new URL(e).origin));
  for (const u of requests.filter((u) => hostOrigins.has(new URL(u).origin)))
    assert.ok(hostProbes.includes(u), "only the local capacity fixture answered a registered host: " + u);
  const hosts = new Set(requests.filter((u) => !hostOrigins.has(new URL(u).origin)).map((u) => new URL(u).hostname));
  for (const h of hosts) assert.ok(["localhost", "127.0.0.1", "127.0.0.2"].includes(h), "unexpected origin " + h);
  assert.deepEqual(pageErrors.filter((e) => !/ResizeObserver/.test(e)), [], "no uncaught page errors");
});
