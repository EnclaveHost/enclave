// REAL Chromium: a private app opened from the OWNER-SELECTED sign-in frontend (work/private-browser-access-interface.txt).
//
// What is real:
//   - Chromium, its TLS stack, cookies (HttpOnly; Secure; SameSite=Strict), fragments, history and redirects;
//   - the ACTUAL supervisor.js (unmodified child process) behind a local TLS front at https://host.pa.test:<port>
//     (= its PUBLIC_URL): its sign-in bounce page, the /__enclave/session page and its POST, sessionApi verification
//     against the chain fixture, the record judgement, and the private /x/<id> proxy to a fixture app;
//   - the owner frontend at https://owner.pa.test:<port>: the REAL site/js/core/app-access.js and the REAL vendored
//     browser bundle's checkAuthorizationWeb, with the session key signing in Chromium's WebCrypto.
// What is a fixture: the chain (a local JSON-RPC answering the session vault/factory reads for the supervisor; and, for
// the frontend, the agreed lease, registry and host-policy answers handed in as JSON, because the full independent-mode
// bootstrap needs deployed ledger contracts), the app itself, and a self-signed certificate (ignoreHTTPSErrors).
// Every request to any other origin is aborted and recorded; enclave.host and its API must never be contacted.
import { test, expect, chromium } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import { sessionKeyHash } from "../../windows/node/session-api-auth.mjs";
import { startPrivateAppSupervisor, freePort } from "../../test/helpers/private-app-supervisor.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ID_VAULT = "0x" + "a1".repeat(32), ID_DEFAULT = "0x" + "a3".repeat(32), ID_FAILOVER = "0x" + "a4".repeat(32);
const VAULT = "0x" + "88".repeat(20), SID = "0x" + "99".repeat(32), SAFE = "0x" + "5a".repeat(20);
const OTHER_VAULT = "0x" + "33".repeat(20), OTHER_SID = "0x" + "34".repeat(32), OTHER_WALLET = "0x" + "35".repeat(20);
const pins = { registry: "0x" + "06".repeat(20), deployments: "0x" + "05".repeat(20), appCatalog: "0x" + "08".repeat(20), proofOfTime: "0x" + "09".repeat(20),
  enclavePay: "0x" + "00".repeat(20), verificationFees: "0x" + "00".repeat(20), sessionVaultFactory: "0x" + "07".repeat(20), secretVaultV2: "0x" + "00".repeat(20) };
const APP = 1n << 132n;

const cleanups = [];
const t = { after: (fn) => cleanups.push(fn) };            // the helper's node:test-style hook
const W = {};

function certs(dir) {
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-subj", "/CN=pa.test", "-days", "1",
    "-addext", "subjectAltName=DNS:host.pa.test,DNS:owner.pa.test,DNS:down.pa.test", "-keyout", dir + "/key", "-out", dir + "/cert"], { stdio: "ignore" });
  return { key: fs.readFileSync(dir + "/key"), cert: fs.readFileSync(dir + "/cert") };
}
const listen = (s, port) => new Promise((r) => s.listen(port, "127.0.0.1", r));
function front(tls, targetPort) {                          // the host's TLS front: bytes to the supervisor, unchanged
  return https.createServer(tls, (req, res) => {
    const up = http.request({ host: "127.0.0.1", port: targetPort, method: req.method, path: req.url, headers: req.headers }, (u) => { res.writeHead(u.statusCode, u.headers); u.pipe(res); });
    up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  });
}
const FRONTEND = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Owner sign-in</title><main><h1>Owner sign-in</h1><p id="st" role="status">Opening…</p></main>
<script type="module">
import * as A from "/js/core/app-access.js";
import { checkAuthorizationWeb } from "/vendor/management.js";
const st = document.getElementById("st");
const b64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
try {
  const fx = await (await fetch("/fixture.json", { cache: "no-store" })).json();
  const key = await crypto.subtle.importKey("jwk", fx.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const apiAuthorization = async (method, url, body) => {
    const u = new URL(url), hostPath = u.host + u.pathname + u.search, ts = Math.floor(Date.now() / 1000), n = b64u(crypto.getRandomValues(new Uint8Array(12)));
    const msg = "enclave-api-v1\\n" + method + "\\n" + hostPath + "\\n" + hex(await crypto.subtle.digest("SHA-256", body)) + "\\n" + ts + "\\n" + n + "\\n" + fx.vault.toLowerCase() + "\\n" + fx.sid.toLowerCase();
    const sig = b64u(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(msg)));
    return "EnclaveSession v1 vault=" + fx.vault + ",sid=" + fx.sid + ",ts=" + ts + ",n=" + n + ",x=" + fx.jwk.x + ",y=" + fx.jwk.y + ",sig=" + sig;
  };
  A._useForTests({ agreedLease: async () => fx.lr, leaseHostPolicy: async () => fx.pol,
    session: async () => ({ owner: fx.wallet, session: { handle: { vault: fx.vault, sid: fx.sid }, status: async () => fx.status, apiAuthorization } }),
    actions: async () => ({ "api.appAccess": 132 }), wallet: () => fx.wallet, owner: () => fx.wallet, checkAuthorization: checkAuthorizationWeb });
  const d = new URL(location.href).searchParams.get("d") || "";
  let p = "/"; try { p = new URLSearchParams(location.hash.slice(1)).get("p") || "/"; } catch (e) {}
  const out = await A.openPrivateApp(d, { path: p });
  st.textContent = "Opening the app at " + out.origin + "…";
  location.replace(out.url);
} catch (e) { st.setAttribute("role", "alert"); st.textContent = "Refused (" + (e.kind || "error") + "): " + e.message; }
</script></html>`;
function frontendServer(tls) {                              // the owner's own sign-in origin: static files + the fixture
  const types = { ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json" };
  return https.createServer(tls, (req, res) => {
    const u = new URL(req.url, "https://owner.pa.test");
    W.frontendHits.push(u.pathname);
    if (u.pathname === "/authorize") { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); return res.end(FRONTEND); }
    if (u.pathname === "/fixture.json") { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); return res.end(JSON.stringify(W.fixture())); }
    const file = u.pathname.startsWith("/network/") ? path.join(ROOT, u.pathname) : path.join(ROOT, "site", u.pathname);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
}

test.beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "private-access-e2e-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tls = certs(dir);
  const [hostPort, ownerPort, downPort] = [await freePort(), await freePort(), await freePort()];
  W.host = `https://host.pa.test:${hostPort}`; W.owner = `https://owner.pa.test:${ownerPort}`; W.down = `https://down.pa.test:${downPort}`;
  const owner = generateKeyPairSync("ec", { namedCurve: "P-256" }), stranger = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwkOf = (k) => k.privateKey.export({ format: "jwk" });
  const kh = (k) => { const j = jwkOf(k); return sessionKeyHash(Buffer.from(j.x, "base64url"), Buffer.from(j.y, "base64url")); };
  const live = { keyHash: kh(owner), actions: String(APP), envs: 2, expiresAt: Math.floor(Date.now() / 1000) + 3600, live: true };
  W.chain = { factory: pins.sessionVaultFactory, ledger: pins.deployments, ledgerCode: "0x", delegated: new Set(), vaults: {
    [VAULT]: { owner: SAFE, held: { [ID_VAULT]: 2, [ID_DEFAULT]: 2, [ID_FAILOVER]: 2 }, sessions: { [SID]: live } },
    [OTHER_VAULT]: { owner: OTHER_WALLET, held: {}, sessions: { [OTHER_SID]: { ...live, keyHash: kh(stranger), actions: String((1n << 200n) - 1n), envs: 3 } } } } };
  const sup = await startPrivateAppSupervisor(t, { chain: W.chain, pins, publicUrl: W.host, deployments: [
    { id: ID_VAULT, owner: VAULT, access: { frontends: [W.owner] } },
    { id: ID_DEFAULT, owner: VAULT },
    { id: ID_FAILOVER, owner: VAULT, access: { frontends: [W.down, W.owner] } } ] });
  W.tenants = sup.tenants;
  const servers = [front(tls, sup.port), frontendServer(tls)];
  await listen(servers[0], hostPort); await listen(servers[1], ownerPort);
  cleanups.push(() => { for (const s of servers) { s.closeAllConnections?.(); s.close(); } });
  // what the frontend's agreed reads report (the runner's registry endpoint is the supervisor's PUBLIC_URL)
  const lease = { owner: VAULT, runner: "0x" + "ee".repeat(32), runnerOperator: "0x" + "44".repeat(20), chainId: 8453, deployments: pins.deployments, active: true,
    isPublic: false, leaseUntil: Date.now() + 3600000, validUntil: Date.now() + 600000, blockNumber: "1000" };
  W.who = { wallet: SAFE, vault: VAULT, sid: SID, jwk: jwkOf(owner), status: { live: true, expiresAt: live.expiresAt, actions: String(APP) }, lease };
  W.stranger = { wallet: OTHER_WALLET, vault: OTHER_VAULT, sid: OTHER_SID, jwk: jwkOf(stranger), status: { live: true, expiresAt: live.expiresAt, actions: String((1n << 200n) - 1n) } };
  W.as = W.who;
  W.leaseOverride = null;
  W.fixture = () => ({ jwk: W.as.jwk, vault: W.as.vault, sid: W.as.sid, wallet: W.as.wallet, status: W.as.status, pol: { admit: true },
    lr: { current: true, host: { endpoint: W.host }, lease: { ...lease, ...(W.leaseOverride || {}), id: W.lastId } } });
});
test.afterAll(async () => { for (const f of cleanups.reverse()) { try { await f(); } catch {} } });

async function browser() {
  const b = await chromium.launch({ args: ["--host-resolver-rules=MAP host.pa.test 127.0.0.1, MAP owner.pa.test 127.0.0.1, MAP down.pa.test 127.0.0.1"] });
  const context = await b.newContext({ ignoreHTTPSErrors: true });
  const blocked = [];
  const allowed = new Set([new URL(W.host).host, new URL(W.owner).host]);
  await context.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (allowed.has(u.host)) return route.continue();
    blocked.push(u.origin + u.pathname);
    return route.abort("blockedbyclient");
  });
  return { b, context, blocked };
}
const enclaveHits = (blocked) => blocked.filter((u) => /(^|\/\/|\.)enclave\.host|nan\.host/.test(u));

test("the owner opens a private app from their chosen frontend; enclave.host and its API are never contacted", async () => {
  W.frontendHits = []; W.as = W.who; W.lastId = ID_VAULT; W.leaseOverride = null;
  const { b, context, blocked } = await browser();
  const page = await context.newPage();
  await page.goto(`${W.host}/x/${ID_VAULT}/inbox?q=1`);
  await expect(page.locator("#app")).toHaveText(`PRIVATE-APP ${ID_VAULT}`);
  expect(page.url()).toBe(`${W.host}/x/${ID_VAULT}/inbox?q=1`);                       // the path the owner asked for
  expect(W.frontendHits).toContain("/authorize");                                        // went through the owner's frontend
  const cookie = (await context.cookies(W.host)).find((c) => c.name === "enclave_app");
  expect(cookie && cookie.httpOnly && cookie.secure && cookie.sameSite === "Strict").toBeTruthy();
  expect(W.tenants[ID_VAULT].every((r) => !/enclave_app/.test(r.cookie || ""))).toBe(true);   // the app never sees it
  // the hand-off credential is gone from history: Back does not land on the #a= URL
  const hist = await page.evaluate(() => location.href);
  expect(hist.includes("#a=")).toBe(false);
  expect(enclaveHits(blocked)).toEqual([]);
  expect(blocked).toEqual([]);
  // the SAME hand-off URL used again is refused by the host (single-use), and opens nothing new
  await b.close();
});

test("an unrelated wallet is refused before signing; a forged owner claim is refused by the host", async () => {
  W.frontendHits = []; W.lastId = ID_VAULT;
  // (a) the frontend reads the lease and refuses: the stranger's wallet/vault is not the owner. Nothing is signed or sent.
  W.as = W.stranger; W.leaseOverride = null;
  let { b, context, blocked } = await browser();
  let page = await context.newPage();
  await page.goto(`${W.host}/x/${ID_VAULT}/`);
  await expect(page.locator("#st[role=alert]")).toContainText("Refused (owner)");
  expect(W.tenants[ID_VAULT].length).toBeGreaterThanOrEqual(0);
  expect((await context.cookies(W.host)).some((c) => c.name === "enclave_app")).toBe(false);
  await b.close();
  // (b) the frontend is LIED to (its read claims the stranger's vault owns the app) and signs: the host judges the chain
  W.leaseOverride = { owner: OTHER_VAULT };
  ({ b, context, blocked } = await browser());
  page = await context.newPage();
  const before = W.tenants[ID_VAULT].length;
  await page.goto(`${W.host}/x/${ID_VAULT}/`);
  await expect(page.locator("#m")).toContainText("This host refused the sign-in: This session does not belong to the deployment's owner.");
  expect((await context.cookies(W.host)).some((c) => c.name === "enclave_app")).toBe(false);
  expect(W.tenants[ID_VAULT].length).toBe(before);                                       // nothing reached the app
  expect(enclaveHits(blocked)).toEqual([]);
  await b.close();
  W.as = W.who; W.leaseOverride = null;
});

test("the owner's first sign-in page is down: no fallback to enclave.host; an explicit choice of the owner's other page works", async () => {
  W.frontendHits = []; W.as = W.who; W.lastId = ID_FAILOVER; W.leaseOverride = null;
  const { b, context, blocked } = await browser();
  const page = await context.newPage();
  await page.goto(`${W.host}/x/${ID_FAILOVER}/`).catch(() => {});                       // bounce -> down.pa.test (aborted)
  await expect.poll(() => blocked.some((u) => u.startsWith(W.down))).toBe(true);
  // the owner opens the app link again (location.replace left no bounce entry to go Back to): the bounce now stays
  await page.goto(`${W.host}/x/${ID_FAILOVER}/`);
  await expect(page.locator("#st")).toContainText("The first sign-in page did not complete");
  const links = page.locator("a.fe");
  await expect(links).toHaveCount(2);
  await expect(links.nth(1)).toHaveText(W.owner);
  await links.nth(1).click();                                                              // the owner's explicit choice
  await expect(page.locator("#app")).toHaveText(`PRIVATE-APP ${ID_FAILOVER}`);
  expect(enclaveHits(blocked)).toEqual([]);
  await b.close();
});

test("an app whose owner chose nothing keeps the host default: the bounce still targets enclave.host (unchanged)", async () => {
  const { b, context, blocked } = await browser();
  const page = await context.newPage();
  await page.goto(`${W.host}/x/${ID_DEFAULT}/`).catch(() => {});
  await expect.poll(() => blocked.some((u) => u === "https://enclave.host/authorize")).toBe(true);
  await b.close();
});

test("a used hand-off URL is single-use: replaying it in the browser is refused by the host", async () => {
  W.frontendHits = []; W.as = W.who; W.lastId = ID_VAULT; W.leaseOverride = null;
  const { b, context } = await browser();
  const page = await context.newPage();
  let handoff = null;
  page.on("framenavigated", (f) => { if (f === page.mainFrame() && f.url().includes("/__enclave/session")) handoff = f.url(); });
  await page.goto(`${W.host}/x/${ID_VAULT}/`);
  await expect(page.locator("#app")).toHaveText(`PRIVATE-APP ${ID_VAULT}`);
  expect(handoff && handoff.includes("#a=EnclaveSession")).toBeTruthy();
  const second = await context.newPage();
  await second.goto(handoff);
  await expect(second.locator("#m")).toContainText("replayed request");
  await b.close();
});
