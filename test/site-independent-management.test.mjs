// Independent dashboard -> host management, end to end in a real Chromium (headless) against a local chain:
//  - the dashboard is served over HTTPS at a DNS name, the management gateway answers at the operator-signed origin with a
//    certificate from a test CA this Chromium trusts (a throwaway NSS store; name checks enforced), names resolve only
//    through --host-resolver-rules (everything else is NOT FOUND, so no real DNS);
//  - the gateway is the real network/management-gateway.mjs with its real quorum authorization (LeaseReader over two of
//    the rig's RPC proxies, against anvil's real ledger, registry and session vault); the supervisor behind it is a
//    stand-in that re-verifies each EnclaveSession signature with windows/node/session-api-auth.mjs against the chain;
//  - the page uses the vendored bundle (site/vendor/management.js), its own agreed lease, the operator record from the
//    profile's directory, a persistent floor, and this browser's WebCrypto session key.
// Covered: every operation through the Manage tab; restart outcome-unknown never retried; a directory-swapped record; a
// replayed older record after a newer one (persisted floor, across a reload); a record without this dashboard; a gateway
// that refuses this origin's CORS; DNS and CA failures with the native fallback; no agreeing RPCs (page and gateway); a
// stale owner; no Enclave origin contacted; the app token never in logs or storage.
//   run: node --test test/site-independent-management.test.mjs    (anvil, openssl, certutil, Playwright's Chromium)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { keccak256, toBytes, createPublicClient, http as viemHttp, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { startRig, haveTools, walletScript, KEYS, chain } from "./helpers/independent-browser-rig.mjs";
import { copySafePasskeyCode } from "./helpers/safe-passkey-code.mjs";
import { createManagementGateway, MANAGEMENT_GATEWAY_HEADER } from "../network/management-gateway.mjs";
import { managementRecord } from "../network/management-host.mjs";
import { signManagementRecord, managementBase } from "../network/management-record.mjs";
import { managementRoute } from "../network/management-routes.mjs";
import { LeaseReader } from "../network/lease-reader.mjs";
import { createSessionApiAuth, apiBases } from "../windows/node/session-api-auth.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(new URL("../e2e/package.json", import.meta.url));
let chromium = null;
try { ({ chromium } = require("playwright")); } catch {}
const haveCertutil = (() => { try { execFileSync("certutil", ["-H"], { stdio: "ignore" }); return true; } catch (e) { return e.status != null; } })();
const skip = haveTools() || (!chromium && "needs Playwright (cd e2e && npm ci) and its Chromium") || (!haveCertutil && "needs NSS certutil");

const DASH_HOST = "dash.independent-site.net", MGMT_HOST = "mgmt.host-operator.net", MGMT2_HOST = "mgmt2.host-operator.net";
const UNTRUSTED_HOST = "mgmt-untrusted.host-operator.net", GONE_HOST = "mgmt-gone.host-operator.net";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, what, n = 120) => { for (let i = 0; i < n; i++){ const v = await f(); if (v) return v; await sleep(500); } throw new Error("timed out: " + what); };

let rig, browser, context, page, tmp, dash, DASH, runner, depId, vault, appToken = null;
const operatorAccount = privateKeyToAccount(KEYS.operator), stranger = privateKeyToAccount("0x" + "4".repeat(64));
const requests = [], refused = [], consoleText = [], pageErrors = [];
const gateways = {};            // name -> { server, origin, hits: [], origins: [] }
const sup = { hits: [], restarts: 0, mode: {}, profileEffects: [], ungated: 0 };
// the secret the gateway presents to the supervisor (the real supervisor accepts the management base only with it)
const UPSTREAM_TOKEN = randomBytes(32).toString("hex");
let sequence = 0;
const envelopes = [];
// Every resource registers its own cleanup the moment it exists, so a failure anywhere in setup (or a hung test) still
// closes the gateways, servers, browser and anvil; a watchdog bounds the whole file.
const cleanups = [];
let setupError = null;
async function cleanup(){
  while (cleanups.length){ const f = cleanups.pop(); try { await Promise.race([f(), sleep(5000)]); } catch {} }
}
const closeServer = (srv) => () => new Promise((ok) => { srv.closeAllConnections?.(); srv.close(() => ok()); });
const WATCHDOG_MS = 12 * 60 * 1000;

function pki(dir){
  const o = (args) => execFileSync("openssl", args, { stdio: "ignore" });
  const ca = (name) => { o(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "2", "-subj", "/CN=" + name,
    "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-keyout", `${dir}/${name}.key`, "-out", `${dir}/${name}.pem`]); };
  const leaf = (caName, host) => {
    o(["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-subj", "/CN=" + host, "-keyout", `${dir}/${host}.key`, "-out", `${dir}/${host}.csr`]);
    fs.writeFileSync(`${dir}/${host}.ext`, `subjectAltName=DNS:${host}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature\n`);
    o(["x509", "-req", "-in", `${dir}/${host}.csr`, "-CA", `${dir}/${caName}.pem`, "-CAkey", `${dir}/${caName}.key`, "-CAcreateserial", "-days", "1",
      "-extfile", `${dir}/${host}.ext`, "-out", `${dir}/${host}.pem`]);
    return { key: fs.readFileSync(`${dir}/${host}.key`), cert: Buffer.concat([fs.readFileSync(`${dir}/${host}.pem`), fs.readFileSync(`${dir}/${caName}.pem`)]) };
  };
  ca("trusted-ca"); ca("rogue-ca");
  o(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "1", "-subj", "/CN=host-management", "-keyout", `${dir}/native.key`, "-out", `${dir}/native.pem`]);
  return { caPem: `${dir}/trusted-ca.pem`, dash: leaf("trusted-ca", DASH_HOST), mgmt: leaf("trusted-ca", MGMT_HOST), mgmt2: leaf("trusted-ca", MGMT2_HOST),
    untrusted: leaf("rogue-ca", UNTRUSTED_HOST), native: { key: fs.readFileSync(`${dir}/native.key`), cert: fs.readFileSync(`${dir}/native.pem`) } };
}

/* the unbundled site over HTTPS at the dashboard's DNS name (as the rig serves it over HTTP) */
function siteServer(tls){
  const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
  const PRETTY = { "/": "/index.html", "/apps": "/apps.html", "/dashboard": "/dashboard.html" };
  return https.createServer({ ...tls }, (req, res) => {
    let p = decodeURIComponent(new URL(req.url, "https://x").pathname); p = PRETTY[p] || p;
    const root = p.startsWith("/network/") ? REPO : path.join(REPO, "site");
    const file = path.join(root, p);
    if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()){ res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    fs.createReadStream(file).pipe(res);
  });
}

/* the supervisor behind the gateway: re-verifies the owner's signature against the chain, then answers each route */
function supervisor(pc, pins){
  const auth = createSessionApiAuth({ pc, authorityPins: { deployments: pins.deployments, sessionVaultFactory: pins.sessionVaultFactory },
    bases: () => apiBases({ hosts: [managementBase(runner)], publicUrls: [] }) });
  const collect = async (s) => { const c = []; for await (const x of s) c.push(x); return Buffer.concat(c); };
  return http.createServer(async (req, res) => {
    const body = await collect(req);
    const route = managementRoute(req.method, req.url);
    const json = (status, j) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
    if (!route) return json(404, { error: "not_found" });
    if (req.headers[MANAGEMENT_GATEWAY_HEADER] !== UPSTREAM_TOKEN){ sup.ungated++; return json(403, { code: "not_allowed", message: "only the management gateway" }); }
    try {
      const s = await auth.verify({ header: req.headers.authorization, method: req.method, path: req.url, body, scope: route.scope, fresh: true });
      const owner = (await pc.readContract({ address: pins.deployments, abi: rig.abi.ledger, functionName: "get", args: [route.deploymentId] })).owner;
      const why = await auth.refusal(s, { id: route.deploymentId, owner });
      if (why) return json(403, { code: "not_allowed", message: why });
    } catch (e){ return json(e.status || 401, { code: "unauthorized", message: String(e.message) }); }
    sup.hits.push(route.op);
    const id = route.deploymentId;
    if (route.op === "status") return json(200, { id, status: "running", host: "independent/host" });
    if (route.op === "logs"){ res.writeHead(200, { "content-type": "text/plain" }); return res.end("booted\nserving on :8080\n"); }
    if (route.op === "attestation"){ const nonce = new URL(req.url, "http://x").searchParams.get("nonce");
      return json(200, { deploymentId: id, nonce, cpu: { format: "fixture-host-reported" }, note: "host-reported fixture" }); }
    if (route.op === "appToken"){ appToken = "app-" + createHash("sha256").update(String(Math.random())).digest("hex");
      return json(200, { token: appToken, tokenType: "Cookie", deployment: id, expiresAt: new Date(Date.now() + 3600e3).toISOString() }); }
    if (route.op === "cpuProfile") return json(200, { state: "complete", seconds: 10, frequencyHz: 100, error: null, format: "gperftools", bytes: 9,
      data: Buffer.from("PROFILE!!").toString("base64") });
    if (route.op === "cpuProfileControl"){ sup.profileEffects.push(JSON.parse(body)); return json(200, { state: JSON.parse(body).action === "start" ? "active" : "stopped", seconds: 10, format: "gperftools" }); }
    sup.restarts++;                                   // from here a restart has happened, whatever the answer says
    if (sup.mode.restart === "drop") return req.socket.destroy();
    return json(200, { id, status: "running", note: "Restarted in place" });
  });
}

async function gateway(name, host, browserTls, pins, readerClients, { dashboards }){
  const reader = new LeaseReader({ clients: readerClients, chainId: 8453, addressBook: "0x" + "00".repeat(20), authorityPins: pins, confirmations: 1, deadlineMs: 6000 });
  const g = { hits: [], origins: [], reader };
  g.server = createManagementGateway({ tls: rig.pkiNative, browserTls: { hostname: host, ...browserTls }, runner, pins, reader,
    upstream: `http://127.0.0.1:${rig.supervisorPort}`, upstreamToken: UPSTREAM_TOKEN, dashboards });
  g.server.on("request", (req) => { g.hits.push(req.method + " " + req.url); g.origins.push(req.headers.origin || null); });
  await new Promise((r) => g.server.listen(0, "127.0.0.1", r));
  cleanups.push(closeServer(g.server));
  g.port = g.server.address().port;
  g.origin = `https://${host}:${g.port}`;
  gateways[name] = g;
  return g;
}

// The gateway's reader authorizes at a CONFIRMED block (confirmations 1: the agreed head minus one), so a claim is this
// host's current lease to it only once a later block exists. The rig's 1 s miner made that a race: an operation sent
// before the next block was correctly refused 409 not_current_runner AND remembered for the gateway's 15 s negative TTL,
// failing every operation after it. Mine the confirming block here; the gateway's authorization is unchanged.
async function claimConfirmed(id){
  const rc = await rig.write(rig.wc(KEYS.operator), rig.addresses.ledger, rig.abi.ledger, "claim", [id, runner]);
  while ((await rig.pc.getBlockNumber()) < rc.blockNumber + 1n) await rig.pc.request({ method: "evm_mine", params: [] });
}

async function publish(over = {}, account = operatorAccount){
  const record = { ...managementRecord({ operator: operatorAccount.address, runner, deployments: rig.addresses.ledger.toLowerCase(), address: "8.8.4.4", port: 8443,
    cert: rig.pkiNative.cert, now: Date.now(), browser: { origin: gateways.main.origin, dashboards: [DASH] } }), sequence: ++sequence, ...over };
  const env = await signManagementRecord(account, record);
  if (account === operatorAccount) await rig.directory.accept("management", env);
  envelopes.push(env);
  return env;
}

test.before(async () => {
  if (skip) return;
  const watchdog = setTimeout(() => { console.error("site-independent-management: watchdog fired, cleaning up"); cleanup().finally(() => process.exit(1)); }, WATCHDOG_MS);
  watchdog.unref();
  try { await setup(); }
  catch (e){ setupError = e; await cleanup(); throw e; }
});
test.after(cleanup);
const ready = () => { if (setupError) throw new Error("setup failed: " + setupError.message); };

async function setup(){
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ind-mgmt-"));
  cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
  rig = await startRig();
  cleanups.push(() => rig.stop());
  const certs = pki(tmp);
  rig.pkiNative = certs.native;
  // a throwaway NSS store trusting only the test CA (Chromium on Linux reads $HOME/.pki/nssdb)
  const home = path.join(tmp, "home"), nss = path.join(home, ".pki", "nssdb");
  fs.mkdirSync(nss, { recursive: true });
  execFileSync("certutil", ["-N", "-d", "sql:" + nss, "--empty-password"], { stdio: "ignore" });
  execFileSync("certutil", ["-A", "-d", "sql:" + nss, "-n", "independent-test-ca", "-t", "C,,", "-i", certs.caPem], { stdio: "ignore" });
  // the dashboard, over HTTPS at its own name
  dash = siteServer(certs.dash);
  await new Promise((r) => dash.listen(0, "127.0.0.1", r));
  cleanups.push(closeServer(dash));
  DASH = `https://${DASH_HOST}:${dash.address().port}`;
  const pins = { deployments: rig.addresses.ledger.toLowerCase(), registry: rig.addresses.registry.toLowerCase(), connectivity: "0x" + "00".repeat(20),
    sessionVaultFactory: rig.addresses.factory.toLowerCase() };
  rig.pins = pins;
  runner = keccak256(toBytes(rig.endpoint)).toLowerCase();
  const pc = createPublicClient({ chain, transport: viemHttp(rig.rpc) });
  const s = supervisor(pc, pins);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  cleanups.push(closeServer(s));
  rig.supervisorPort = s.address().port;
  // the gateway reads the chain through two of the rig's RPC proxies (independent of the page's reader)
  const clientsFor = (idx) => idx.map((i) => createPublicClient({ chain, transport: viemHttp(rig.profile.rpcs[i]) }));
  await gateway("main", MGMT_HOST, certs.mgmt, pins, clientsFor([1, 2]), { dashboards: [DASH] });
  await gateway("nocors", MGMT2_HOST, certs.mgmt2, pins, clientsFor([1, 2]), { dashboards: ["https://other-dash.independent-site.net"] });
  await gateway("untrusted", UNTRUSTED_HOST, certs.untrusted, pins, clientsFor([1, 2]), { dashboards: [DASH] });
  // Chromium: only this test's names resolve (to loopback); every other name is NOT FOUND, so nothing reaches real DNS
  const rules = [DASH_HOST, MGMT_HOST, MGMT2_HOST, UNTRUSTED_HOST].map((h) => `MAP ${h} 127.0.0.1`).join(", ") + ", MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE 127.0.0.2";
  // lean Chromium for the memory allocation (no GPU process, one renderer, network/audio in the browser process)
  browser = await chromium.launch({ env: { ...process.env, HOME: home }, args: ["--host-resolver-rules=" + rules, "--disable-gpu", "--disable-dev-shm-usage",
    "--renderer-process-limit=1", "--disable-extensions", "--disable-features=site-per-process,IsolateOrigins,Translate,OptimizationHints,MediaRouter,AudioServiceOutOfProcess",
    "--enable-features=NetworkServiceInProcess,NetworkServiceInProcess2", "--js-flags=--max-old-space-size=192"] });
  cleanups.push(() => browser.close());
  context = await browser.newContext({ reducedMotion: "reduce", acceptDownloads: true });
  await context.route((url) => /(^|\.)enclave\.host$/i.test(url.hostname), (route) => { refused.push(route.request().url()); return route.abort("blockedbyclient"); });
  context.on("request", (r) => requests.push(r.url()));
  await context.addInitScript({ content: walletScript({ rpc: rig.rpc, address: rig.owner }) });
  const text = JSON.stringify(rig.profile);
  await context.addInitScript(({ address, text }) => {
    if (!localStorage.getItem("enclave_session")) localStorage.setItem("enclave_session", JSON.stringify({ address, rdns: "test.local.wallet" }));
    localStorage.setItem("enclave_independent_profile", text);
    sessionStorage.setItem("enclave_independent_ack", text);
  }, { address: rig.owner, text });
  page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on("console", (m) => consoleText.push(m.text()));
  page.on("pageerror", (e) => pageErrors.push(String(e && e.message || e)));
  page.on("dialog", (d) => d.accept());
}

async function walletReady(){
  for (let i = 0; i < 100; i++){
    if (await page.evaluate(async () => !!(await import("/js/core/api.js")).Enclave.address).catch(() => false)) return;
    await sleep(200);
  }
  throw new Error("the wallet never reconnected");
}
async function openManage(){
  await page.goto(DASH + "/dashboard");
  await walletReady();
  await page.evaluate(() => customElements.whenDefined("c-deployments"));
  await page.locator(".enc-search").fill(depId.slice(2, 14));
  await page.waitForFunction(() => document.querySelectorAll(".enc-row").length === 1, null, { timeout: 30000 });
  const row = page.locator(".enc-row").first();
  await row.locator(".enc-mgmtbtn").click();
  await row.locator(".enc-mgmt .em-status").waitFor({ timeout: 20000 });
  return row;
}
const statusText = () => page.locator(".enc-mgmt-status").textContent();
async function click(row, sel, done = /\[✓\]|\[x\]|\[!\]/){
  // run() clears the status pane, paints "[*] …", then the outcome; wait for an outcome line in the NEW text
  await page.evaluate(() => { const st = document.querySelector(".enc-mgmt-status"); if (st) st.dataset.prev = st.textContent; st && (st.dataset.mark = String(Math.random())); });
  const mark = await page.evaluate(() => document.querySelector(".enc-mgmt-status").dataset.mark);
  await row.locator(sel).click();
  await page.waitForFunction(({ src, mark }) => {
    const st = document.querySelector(".enc-mgmt-status");
    if (!st || st.dataset.mark !== mark) return false;
    const lines = [...st.querySelectorAll(".ln")].map((l) => l.textContent);
    if (!lines.length || !/^\[\*\]/.test(lines[0])) return false;     // this action's own pane
    return lines.slice(1).some((l) => new RegExp(src).test(l)) && [...document.querySelectorAll(".enc-mgmt-actions button")].some((b) => !b.disabled);
  }, { src: done.source, mark }, { timeout: 45000 }).catch(async (e) => {
    throw new Error(e.message + "\n--- panel status:\n" + (await row.locator(".enc-mgmt-status").textContent().catch(() => "?")));
  });
  return (await row.locator(".enc-mgmt-status .ln").allTextContents()).join("\n");
}

test("setup: a session-held deployment claimed by host A, and A's operator-signed browser record in the profile's directory", { skip, timeout: 180000 }, async () => {
  ready();
  await page.goto(DASH + "/dashboard");
  await walletReady();
  assert.equal(await page.evaluate(async () => (await import("/js/core/config.js")).INDEPENDENT.state), "on");
  const app = await page.evaluate(async () => {
    const S = await import("/js/core/sessions.js");
    const c = await S.startSession({ budgetUsd: 2, hours: 2 });
    return c.session.handle.vault;
  });
  vault = app.toLowerCase();
  // a catalog reference: this file publishes no app, and an unknown app's version fee reads as 0 (a free app), which is
  // all the vault's create checks
  const catalogRef = "catalog://0x" + "11".repeat(32) + "/0";
  await page.evaluate(async (ref) => (await import("/js/core/sessions.js")).sessionCall("deploy.create", { appRef: ref, gpuMilli: 0, cpuMilli: 100,
    appPort: 8080, ports: "", isPublic: false, configCid: "", maxRate6: 100n, env: "staging", fund6: 500000n }), catalogRef).catch((e) => { throw new Error("create: " + e.message); });
  const n = await rig.pc.readContract({ address: rig.addresses.ledger, abi: rig.abi.ledger, functionName: "count" });
  const all = await rig.pc.readContract({ address: rig.addresses.ledger, abi: rig.abi.ledger, functionName: "getPage", args: [0n, n] });
  depId = all.find((d) => d.owner.toLowerCase() === vault).id.toLowerCase();
  await claimConfirmed(depId);
  await publish();
});

test("every operation through the Manage tab: status, logs, host-reported attestation, app token, CPU profile, restart", { skip, timeout: 240000 }, async () => {
  ready();
  assert.ok(depId, "needs the setup");
  const row = await openManage();
  let out = await click(row, ".em-status");
  assert.match(out, /\[✓\] host-reported status: running/);
  const trust = await row.locator(".enc-mgmt-trust").textContent();
  assert.match(trust, new RegExp("Transport: browser WebPKI · " + gateways.main.origin.replace(/[.]/g, "\\.") + " · signed by host operator " + operatorAccount.address.toLowerCase()));
  assert.match(trust, /did not check the host's TLS key \(SPKI\).*depends on DNS and a public certificate authority.*Native SPKI: not checked by this page/s);
  out = await click(row, ".em-logs");
  assert.match(out, /last 200 log lines/);
  assert.equal((await row.locator(".em-logtext").textContent()).trim(), "booted\nserving on :8080");
  out = await click(row, ".em-att");
  assert.match(out, /host-reported attestation document: NOT verified by this page/);
  const att = await row.locator(".enc-mgmt-out").textContent();
  assert.match(att, /Host-reported, not verified\..*echoes it/s);
  assert.match(att, new RegExp("attest " + depId + " --native-profile"));
  assert.doesNotMatch(att, /✓ verified|verified ✓/);
  out = await click(row, ".em-token");
  assert.match(out, /app token for this deployment \(Cookie, until/);
  assert.ok(appToken && !(await page.content()).includes(appToken), "the token is never painted");
  const [dl] = await Promise.all([page.waitForEvent("download"), row.locator(".em-token-save").click()]);
  assert.equal(fs.readFileSync(await dl.path(), "utf8"), appToken + "\n", "saved only on an explicit click");
  out = await click(row, ".em-prof");
  assert.match(out, /CPU profile: complete, 10 s, 9 bytes captured/);
  const [prof] = await Promise.all([page.waitForEvent("download"), row.locator(".em-prof-save").click()]);
  assert.equal(fs.readFileSync(await prof.path(), "utf8"), "PROFILE!!");
  await row.locator(".em-secs").fill("7");
  out = await click(row, ".em-prof-start");
  assert.match(out, /profiling started \(succeeded\): active/);
  out = await click(row, ".em-prof-stop");
  assert.match(out, /profiling stopped \(succeeded\): stopped/);
  assert.deepEqual(sup.profileEffects, [{ action: "start", seconds: 7 }, { action: "stop" }]);
  const r0 = sup.restarts;
  out = await click(row, ".em-restart");
  assert.match(out, /restart succeeded \(host-reported: running\)/);
  assert.equal(sup.restarts, r0 + 1);
  assert.deepEqual(sup.hits, ["status", "logs", "attestation", "appToken", "cpuProfile", "cpuProfileControl", "cpuProfileControl", "restart"]);
  // the page talked to the gateway only with its own exact origin, never credentials
  assert.ok(gateways.main.origins.every((o) => o === DASH));
  // the floor is persistent (localStorage), keyed like the native client's
  const floors = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("enclave_mgmt_floor:")).map((k) => [k, JSON.parse(localStorage.getItem(k))]));
  assert.equal(floors.length, 1);
  assert.equal(floors[0][1].version, 1, "the helper's composite floor");
  assert.equal(floors[0][1].operators[operatorAccount.address.toLowerCase()].sequence, sequence, "this operator's floor is the record just used");
});

test("a restart whose answer is lost: outcome unknown, check status, never resent", { skip, timeout: 120000 }, async () => {
  ready();
  const row = await openManage();
  sup.mode.restart = "drop";
  const r0 = sup.restarts, hits0 = gateways.main.hits.length;
  const out = await click(row, ".em-restart");
  assert.match(out, /\[!\] outcome unknown: .*check status before asking again/);
  assert.match(out, /Check status before asking again\. The page will not resend it\./);
  await sleep(3000);
  assert.equal(sup.restarts, r0 + 1, "delivered once");
  assert.equal(gateways.main.hits.filter((h) => /restart/.test(h) && !/^OPTIONS/.test(h)).length - gateways.main.hits.slice(0, hits0).filter((h) => /restart/.test(h) && !/^OPTIONS/.test(h)).length, 1, "one request, no retry");
  assert.equal(await row.locator(".em-restart").isDisabled(), true, "no further mutation until status is checked");
  assert.equal(await row.locator(".em-prof-start").isDisabled(), true);
  sup.mode.restart = "ok";
  await click(row, ".em-status");
  assert.equal(await row.locator(".em-restart").isDisabled(), false, "a status check re-enables it");
});

test("records: a directory-swapped record is ignored; a replayed older record after a newer one is refused, across a reload", { skip, timeout: 120000 }, async () => {
  ready();
  // a directory serves a record for this runner signed by a stranger, newer, pointing elsewhere
  const swapped = await signManagementRecord(stranger, { ...envelopes.at(-1).record, operator: stranger.address.toLowerCase(), sequence: sequence + 50,
    browser: { origin: "https://attacker.host-operator.net", dashboards: [DASH] } });
  const serve = (list) => page.route(rig.directoryUrl + "/v1/network/records", (route) => route.fulfill({ status: 200,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: JSON.stringify({ version: 1, providers: [], policies: [], publications: [], management: list }) }));
  let row = await openManage();
  await serve([envelopes.at(-1), swapped]);
  let out = await click(row, ".em-status");
  assert.match(out, /\[✓\] host-reported status/);
  assert.match(await row.locator(".enc-mgmt-trust").textContent(), new RegExp(gateways.main.origin.replace(/[.]/g, "\\.")));
  assert.ok(!requests.some((u) => u.includes("attacker.")), "the swapped origin is never contacted");
  await page.unroute(rig.directoryUrl + "/v1/network/records");
  // a newer record from the operator raises the floor; a directory that rolls back is refused
  const older = envelopes.at(-1);
  await publish();
  out = await click(row, ".em-status");
  assert.match(out, /\[✓\]/);
  await serve([older]);
  out = await click(row, ".em-status");
  assert.match(out, /\[x\] The host's management record was refused: stale management record/);
  assert.ok(await row.locator(".enc-mgmt-native .enc-mgmt-cmd").isVisible(), "the native client is offered");
  await page.unroute(rig.directoryUrl + "/v1/network/records");
  // the floor outlives the tab's page
  row = await openManage();
  await serve([older]);
  out = await click(row, ".em-status");
  assert.match(out, /stale management record/);
  await page.unroute(rig.directoryUrl + "/v1/network/records");
});

test("a record that does not list this dashboard, and a gateway that refuses its CORS: nothing reaches the supervisor", { skip, timeout: 120000 }, async () => {
  ready();
  const row = await openManage();
  // 1) the operator's record names another dashboard: refused in the page, before any request to the host
  await publish({ browser: { origin: gateways.main.origin, dashboards: ["https://other-dash.independent-site.net"] } });
  const g0 = gateways.main.hits.length, s0 = sup.hits.length;
  let out = await click(row, ".em-status");
  assert.match(out, /\[x\] This dashboard origin is not one the runner operator allowed\. Use the native client\./);
  assert.equal(gateways.main.hits.length, g0);
  // 2) the record lists this dashboard, but the gateway at that origin does not: the browser's CORS check stops it
  await publish({ browser: { origin: gateways.nocors.origin, dashboards: [DASH] } });
  out = await click(row, ".em-status");
  assert.match(out, /\[x\] the management origin could not be reached .*use the native client/);
  assert.ok(gateways.nocors.hits.length >= 1 && gateways.nocors.hits.every((h) => /^(OPTIONS|GET) /.test(h)));
  out = await click(row, ".em-restart");
  assert.match(out, /outcome unknown/, "a mutation the browser cannot see answered is never called done");
  assert.equal(sup.hits.length, s0, "the supervisor saw nothing");
  assert.match(await row.locator(".enc-mgmt-native").textContent(), new RegExp("enclave --independent .* restart " + depId));
  await click(row, ".em-status");          // clears the outcome-unknown lock (still refused, nothing sent)
});

test("DNS and CA failures: refused with the native fallback; the native path is named, never the SPKI claimed", { skip, timeout: 120000 }, async () => {
  ready();
  const row = await openManage();
  const s0 = sup.hits.length;
  await publish({ browser: { origin: `https://${GONE_HOST}:${gateways.main.port}`, dashboards: [DASH] } });
  let out = await click(row, ".em-logs");
  assert.match(out, /could not be reached \(https:\/\/mgmt-gone\.host-operator\.net:\d+\)\. If its DNS name or certificate fails, use the native client\./);
  const native = await row.locator(".enc-mgmt-native").textContent();
  assert.match(native, /pins the host’s exact TLS key over a literal IP, with no DNS name or public CA/);
  assert.match(native, new RegExp("logs " + depId + " --tail 200 --directories " + rig.directoryUrl.replace(/[.]/g, "\\.")));
  await publish({ browser: { origin: gateways.untrusted.origin, dashboards: [DASH] } });
  out = await click(row, ".em-status");
  assert.match(out, /could not be reached \(https:\/\/mgmt-untrusted/);
  assert.equal(gateways.untrusted.hits.length, 0, "an untrusted certificate ends the TLS handshake: no request");
  assert.equal(sup.hits.length, s0);
  // back to the good origin: works again
  await publish();
  out = await click(row, ".em-status");
  assert.match(out, /\[✓\] host-reported status/);
});

test("no agreeing RPCs: the page refuses before contacting the host; a gateway without quorum refuses before forwarding", { skip, timeout: 180000 }, async () => {
  ready();
  const row = await openManage();
  const g0 = gateways.main.hits.length, s0 = sup.hits.length;
  rig.rpcModes[0] = "down"; rig.rpcModes[1] = "down";
  let out = await click(row, ".em-status");
  assert.match(out, /\[x\] The chain endpoints did not agree on this deployment's lease .*Nothing was sent\./);
  assert.equal(gateways.main.hits.length, g0, "nothing reached the gateway");
  rig.rpcModes[0] = "ok"; rig.rpcModes[1] = "ok";
  // the page's quorum (RPCs 0 and 1) holds, the gateway's (RPCs 1 and 2) does not
  rig.rpcModes[2] = "lie";
  out = await click(row, ".em-restart");
  assert.match(out, /\[x\] management restart refused before reaching the supervisor \(HTTP 50[34]\)/);
  rig.rpcModes[2] = "ok";
  assert.equal(sup.hits.length, s0, "the supervisor saw nothing");
});

test("a stale owner: once the deployment has left this wallet and its vault, the next action is refused before any request", { skip, timeout: 180000 }, async () => {
  ready();
  await openManage();
  // a second deployment the vault holds, unfunded (the ledger moves a record only with no refundable escrow on it)
  await page.evaluate(async (ref) => (await import("/js/core/sessions.js")).sessionCall("deploy.create", { appRef: ref, gpuMilli: 0, cpuMilli: 100,
    appPort: 8080, ports: "", isPublic: false, configCid: "", maxRate6: 100n, env: "staging", fund6: 0n }), "catalog://0x" + "11".repeat(32) + "/0");
  const n = await rig.pc.readContract({ address: rig.addresses.ledger, abi: rig.abi.ledger, functionName: "count" });
  const second = (await rig.pc.readContract({ address: rig.addresses.ledger, abi: rig.abi.ledger, functionName: "getPage", args: [n - 1n, 1n] }))[0].id.toLowerCase();
  const owned = (id) => rig.pc.readContract({ address: rig.addresses.ledger, abi: rig.abi.ledger, functionName: "get", args: [id] }).then((d) => d.owner.toLowerCase());
  assert.equal(await owned(second), vault);
  // the owner releases it from the vault back to the wallet (a vault releases only to its owner), then hands it on
  await page.evaluate(async ({ id, to }) => (await import("/js/core/sessions.js")).ownerOp({ op: "release", deployment: id, to }), { id: second, to: rig.owner });
  await until(async () => (await owned(second)) === rig.owner.toLowerCase(), "released to the owner");
  await rig.write(rig.wc(KEYS.owner), rig.addresses.ledger, rig.abi.ledger, "transferDeployment", [second, stranger.address]);
  const g0 = gateways.main.hits.length, r0 = requests.length;
  const err = await page.evaluate(async (id) => { try { await (await import("/js/core/independent-management.js")).hostRestart(id); return null; } catch (e){ return e.message; } }, second);
  assert.match(err, new RegExp("This deployment's current owner is " + stranger.address.toLowerCase() + " \\(read at block \\d+\\), not this wallet or its session vault\\. Nothing was sent\\."));
  assert.equal(gateways.main.hits.length, g0, "the gateway saw nothing");
  assert.ok(!requests.slice(r0).some((u) => u.includes("/v1/network/records") || u.includes(MGMT_HOST)), "not even the directory: the agreed lease decides first");
});

/* ---- a passkey account (a Safe) as the dashboard identity ----
   The pinned Safe v1.4.1 / passkey signer v0.2.1 / 4337 module code is etched byte for byte from the recorded Base snapshot
   (test/fixtures/base-code/safe-passkey-code-base.json; each code hash checked against the page's own pin, no network read)
   onto this local chain, whose anvil verifies P-256 at 0x100 natively. */
const rigRpc = async (method, params) => { const r = await (await fetch(rig.rpc, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json(); if (r.error) throw new Error(r.error.message); return r.result; };
async function installSafePasskeyCode(){
  const pins = await page.evaluate(async () => Object.entries((await import("/js/core/account-providers.js")).PROVIDERS["safe-passkey"].contracts)
    .map(([name, c]) => ({ name, address: c.address, codeHash: c.codeHash || null })));
  for (const c of await copySafePasskeyCode(pins, rigRpc)) assert.equal(c.ok, true, c.name + " is the pinned code");
}
async function openManageFor(id){
  await page.goto(DASH + "/dashboard");
  await page.evaluate(() => customElements.whenDefined("c-deployments"));
  await page.locator(".enc-search").fill(id.slice(2, 14));
  await page.waitForFunction(() => document.querySelectorAll(".enc-row").length === 1, null, { timeout: 60000 });
  const row = page.locator(".enc-row").first();
  await row.locator(".enc-mgmtbtn").click();
  await row.locator(".enc-mgmt .em-status").waitFor({ timeout: 20000 });
  return row;
}
const waitAcct = (re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector(".acct-status")?.textContent || ""), re.source, { timeout: 60000 });

test("a passkey account (Safe) as the identity: Manage signs with the account's own session; a Safe-held record needs the Safe's own delegation; the wallet's identity cannot act for it", { skip, timeout: 420000 }, async () => {
  ready();
  await page.goto(DASH + "/dashboard");
  await walletReady();
  await installSafePasskeyCode();
  // Chrome's virtual authenticator (no OS prompt, no real key) on this page
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true } });
  // the account, through the account panel: one passkey under this dashboard's RP, deployed by the connected wallet (gas only)
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
  // select it, then "Start a session" from the session controls: the passkey approves, the wallet only submits
  await page.locator(".acct-use").click();
  await waitAcct(/the dashboard now acts as your passkey account/);
  await page.waitForFunction(() => /Account session:<\/b> none/.test(document.querySelector(".ind-sess")?.innerHTML || ""), null, { timeout: 60000 });
  await page.locator(".ind-s-open").click();
  await page.locator("#smBudget").fill("0");
  assert.equal(await page.locator("#smGo").textContent(), "Approve with passkey");
  await page.locator("#smGo").click();
  await page.waitForFunction(() => /Account session<\/b> live/.test(document.querySelector(".ind-sess")?.innerHTML || ""), null, { timeout: 90000 });
  const acctVault = (await page.evaluate(async () => (await (await import("/js/core/sessions.js")).sessionStatus()).vault)).toLowerCase();
  assert.equal((await rig.pc.readContract({ address: acctVault, abi: [{ type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }], functionName: "owner" })).toLowerCase(), safe);
  // two records its session creates; host A claims the first
  const catalogRef = "catalog://0x" + "11".repeat(32) + "/0";
  const create = () => page.evaluate(async (ref) => (await import("/js/core/sessions.js")).sessionCall("deploy.create", { appRef: ref, gpuMilli: 0, cpuMilli: 100,
    appPort: 8080, ports: "", isPublic: false, configCid: "", maxRate6: 100n, env: "staging", fund6: 0n }), catalogRef);
  const latestId = async () => { const n = await rig.pc.readContract({ address: rig.addresses.ledger, abi: rig.abi.ledger, functionName: "count" });
    return (await rig.pc.readContract({ address: rig.addresses.ledger, abi: rig.abi.ledger, functionName: "getPage", args: [n - 1n, 1n] }))[0].id.toLowerCase(); };
  await create(); const held = await latestId();
  await create(); const toSafe = await latestId();
  // a host claims only funded work: the test funds both records from a separate key (a gift; the dashboard plays no part)
  const giver = rig.wc(KEYS.operator2);
  await rig.write(rig.wc(KEYS.deployer), rig.addresses.usdc, rig.abi.usdc, "mint", [giver.account.address, 2_000_000n]);
  await rig.write(giver, rig.addresses.usdc, rig.abi.usdc, "approve", [rig.addresses.ledger, 2_000_000n]);
  for (const id of [held, toSafe]){
    await rig.write(giver, rig.addresses.ledger, rig.abi.ledger, "fund", [id, 500_000n]);
    await claimConfirmed(id);
  }
  const owned = (id) => rig.pc.readContract({ address: rig.addresses.ledger, abi: rig.abi.ledger, functionName: "get", args: [id] }).then((d) => d.owner.toLowerCase());
  assert.equal(await owned(held), acctVault);

  // 1) Manage on the vault-held record: signed by the ACCOUNT's session key; the host's gateway and supervisor check it on chain
  let row = await openManageFor(held);
  const h0 = sup.hits.length;
  assert.match(await click(row, ".em-status"), /\[✓\] host-reported status: running/);
  assert.equal(sup.hits.length, h0 + 1);

  // 2) release the second record from the vault to the Safe (Environment tab, a passkey-signed owner operation). A record the
  //    Safe holds itself is managed only once the Safe lets its vault act for it on the ledger; this rig's ledger (the
  //    repository's HEAD source) has no setDelegate, so the panel says so and offers nothing to sign (the Safe's delegation
  //    against the deployed ledger is exercised on the Base fork, test/site-independent-passkey-ui.test.mjs)
  await page.goto(DASH + "/dashboard");
  await page.evaluate(() => customElements.whenDefined("c-deployments"));
  await page.locator(".enc-search").fill(toSafe.slice(2, 14));
  await page.waitForFunction(() => document.querySelectorAll(".enc-row").length === 1, null, { timeout: 60000 });
  await page.locator(".enc-row").first().locator(".enc-envbtn").click();
  await page.waitForSelector(".enc-env-release");
  await page.locator(".enc-env-release").click();
  await until(async () => (await owned(toSafe)) === safe, "released to the Safe");
  row = await openManageFor(toSafe);
  const g0 = sup.hits.length;
  const refusedOut = await click(row, ".em-status");
  assert.match(refusedOut, /\[x\]/); assert.equal(sup.hits.length, g0, "the host did not act for an undelegated Safe-held record");
  await page.waitForFunction(() => /Your passkey account holds this deployment, and this ledger cannot let a session vault act for it/.test(document.querySelector(".enc-mgmt-deleg")?.textContent || ""), null, { timeout: 30000 });
  assert.equal(await row.locator(".em-deleg-go").count(), 0, "nothing to sign on a ledger without delegation");

  // 3) back to the wallet identity: the account's records are not this identity's, refused before any request
  await page.locator(".acct-wallet").click();
  await page.waitForFunction(() => /Acting as your wallet/.test(document.querySelector(".id-bar")?.textContent || ""));
  const gw0 = gateways.main.hits.length;
  const err = await page.evaluate(async (id) => { try { await (await import("/js/core/independent-management.js")).hostStatus(id); return null; } catch (e){ return e.message; } }, held);
  assert.match(err, /not this wallet or its session vault\. Nothing was sent\./);
  assert.equal(gateways.main.hits.length, gw0, "the gateway saw nothing");
});

test("nothing reached Enclave; only the dashboard, the operator origins, the profile's RPCs and directory; the app token is in no log or storage", { skip, timeout: 60000 }, async () => {
  ready();
  assert.deepEqual(refused, []);
  assert.equal(sup.ungated, 0, "every request the supervisor saw came through the gateway");
  const hosts = new Set(requests.map((u) => new URL(u).hostname));
  for (const h of hosts) assert.ok(["localhost", "127.0.0.1", DASH_HOST, MGMT_HOST, MGMT2_HOST, UNTRUSTED_HOST, GONE_HOST].includes(h), "unexpected origin " + h);
  assert.ok(appToken);
  assert.ok(!consoleText.some((t) => t.includes(appToken)), "not in the console");
  const stored = await page.evaluate(async () => {
    const dump = { local: JSON.stringify({ ...localStorage }), session: JSON.stringify({ ...sessionStorage }), idb: "" };
    for (const { name } of await indexedDB.databases()){
      const db = await new Promise((ok, no) => { const r = indexedDB.open(name); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
      for (const store of db.objectStoreNames){
        const all = await new Promise((ok) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => ok(r.result); r.onerror = () => ok([]); });
        dump.idb += JSON.stringify(all, (k, v) => (typeof v === "bigint" ? String(v) : v && v.constructor && v.constructor.name === "CryptoKey" ? "[key]" : v));
      }
      db.close();
    }
    return dump;
  });
  for (const [where, text] of Object.entries(stored)) assert.ok(!text.includes(appToken), "the app token is not in " + where);
  assert.ok(!(await page.content()).includes(appToken), "not in the DOM");
  assert.deepEqual(pageErrors.filter((e) => !/ResizeObserver/.test(e)), [], "no uncaught page errors");
});
