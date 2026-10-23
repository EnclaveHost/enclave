// Custody v2 in a REAL browser (Chrome for Testing): the site's own site/js/core/custody-v2.js and the committed
// site/vendor/custody-v2.js, served same-origin from this repository's site/ tree, run the owner flow. The chain is the
// FIXTURE vault (test/helpers/custody-v2-fake-vault.mjs) in Node, bridged into the page; the "relay" is this test server's
// own fixture endpoints. Node opens what the page stored with the committee secret, and inspects EVERY request the page
// made: no v2 value is sent anywhere, and the relay copy is only deleted by the explicit, gated step. Fixture only - no
// production vault, committee or relay is involved.
//   run: node --test test/custody-v2-dashboard-browser.test.mjs   (skipped, saying so, without Chrome for Testing)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { FakeVault, VAULT, BOOK, GENESIS_COMMITTEE, committeeKey, committee, openBundle } from "./helpers/custody-v2-fake-vault.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// the lean headless shell when present (the shared test queue's 512 MiB cap: full Chrome's process tree peaked at 700 MiB),
// in one process; else Chrome for Testing
const SHELL = path.join(os.homedir(), ".cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell");
const CFT = process.env.CHROME_FOR_TESTING || (fs.existsSync(SHELL) ? SHELL : path.join(os.homedir(), ".cache/ms-playwright/chromium-1232/chrome-linux64/chrome"));
const LEAN = CFT === SHELL ? ["--single-process", "--no-zygote", "--js-flags=--max-old-space-size=128"] : [];
const skip = !fs.existsSync(CFT) && "no Chrome for Testing or headless shell";

const OWNER = "0x" + "0a".repeat(20);
const ID = "0x" + "d1".repeat(32);
const NEW_ENV = { STRIPE_KEY: "sk_live_browser_" + "n".repeat(24), DB_PASS: "browser-only-pass-9Zx" };
const RELAY_ENV = { OLD_TOKEN: "relay-held-token-" + "o".repeat(20) };
const PREDICTION = { appId: "ab".repeat(32), images: [{ releaseAdmitted: true, measurement: "cd".repeat(48), runtimeId: "ef".repeat(32) }] };

const enc = (x) => JSON.stringify(x, (k, v) => typeof v === "bigint" ? { $b: String(v) } : v instanceof Uint8Array ? { $u: Buffer.from(v).toString("hex") } : v);
const rev = (k, v) => v && typeof v === "object" && "$b" in v ? BigInt(v.$b) : v && typeof v === "object" && "$u" in v ? new Uint8Array(Buffer.from(v.$u, "hex")) : v;

const PAGE = `<!doctype html><meta charset="utf-8"><script type="module">
  import * as C2 from "/site/js/core/custody-v2.js";
  import * as V from "/site/vendor/custody-v2.js";
  const rev = (k, v) => v && typeof v === "object" && "$b" in v ? BigInt(v.$b)
    : v && typeof v === "object" && "$u" in v ? Uint8Array.from((v.$u.match(/../g) || []).map((h) => parseInt(h, 16))) : v;
  const enc = (x) => JSON.stringify(x, (k, v) => typeof v === "bigint" ? { $b: String(v) } : v instanceof Uint8Array ? { $u: Array.from(v, (b) => b.toString(16).padStart(2, "0")).join("") } : v);
  const bridge = async (op, ...args) => JSON.parse(await window.__vault(op, enc(args)), rev);
  const reader = {
    readVaultIdentity: () => bridge("identity"),
    readRelease: (a) => bridge("release", a),
    readCommittee: (a) => bridge("committee", a),
    snapshot: (fn) => fn({ block: 1n, call: (address, abi, name, args) => bridge("call", address, name, args), code: (a) => bridge("code", a) }),
  };
  window.setup = (cfg) => C2._setForTests({ lib: { ...V, createChainReaderV2: () => reader }, config: cfg, sleep: async () => {} });
  window.signer = (address) => ({ address, sendTx: (to, data) => bridge("send", address, to, data), waitReceipt: async () => ({ status: "success" }) });
  const post = async (p, body) => { const r = await fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return r.json(); };
  window.relay = { read: () => post("/relay/get", { id: "${ID}" }), exists: () => post("/relay/exists", { id: "${ID}" }), clear: () => post("/relay/clear", { payload: '{"clear":true}' }) };
  window.C2 = C2; window.ready = true;
</script>`;

test("Chrome runs the custody v2 owner flow: verified vault, admit, encrypt-in-page save, migration, gated relay deletion", { skip }, async () => {
  const fake = new FakeVault(), key = committeeKey();
  fake.committees.set(GENESIS_COMMITTEE, committee(GENESIS_COMMITTEE, key.Y));
  fake.ledger.set(ID, { owner: OWNER, envelope: JSON.stringify({ config: { region: "eu" } }) });   // inline config: read off the chain
  const ID2 = "0x" + "d2".repeat(32);
  fake.ledger.set(ID2, { owner: OWNER, envelope: "" });
  const relayLog = [];
  let relayCustody = false;
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json" };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname.startsWith("/relay/")) {
      let body = ""; for await (const c of req) body += c;
      relayLog.push({ path: u.pathname, body });
      const out = u.pathname === "/relay/get" ? { id: ID, rev: 7, names: Object.keys(RELAY_ENV), env: RELAY_ENV }
        : u.pathname === "/relay/exists" ? { id: ID, exists: true, ...(relayCustody ? { custody: true } : {}) } : { id: ID, rev: 8, names: [] };
      res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(out));
    }
    if (u.pathname === "/site/__c2test.html") { res.writeHead(200, { "content-type": types[".html"] }); return res.end(PAGE); }
    // the repository tree, read-only, as the site's own relative imports expect it (site/js/core -> ../../../network/…)
    const f = path.resolve(REPO, "." + u.pathname);
    if (!f.startsWith(REPO + path.sep) || /[\\/](node_modules|\.git)[\\/]/.test(f) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ executablePath: CFT, headless: true, args: ["--disable-gpu", "--disable-extensions", "--disable-dev-shm-usage", ...LEAN] });
    const page = await browser.newPage();
    const errors = [], requests = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("request", (r) => requests.push({ url: r.url(), method: r.method(), body: r.postData() || "" }));
    await page.exposeFunction("__vault", async (op, argsJson) => {
      const a = JSON.parse(argsJson, rev), r = fake.reader;
      const out = op === "identity" ? await r.readVaultIdentity() : op === "release" ? await r.readRelease(a[0]) : op === "committee" ? await r.readCommittee(a[0])
        : op === "call" ? (await r.snapshot(async ({ call }) => ({ v: await call(a[0], null, a[1], a[2]) }))).v
        : op === "code" ? (await r.snapshot(async ({ code }) => ({ v: await code(a[0]) }))).v
        : op === "send" ? fake.execute(a[0], a[1], a[2]) : null;
      return enc(out);
    });
    const bad = [], consoleLines = [];
    page.on("response", (r) => { if (r.status() !== 200) bad.push(r.status() + " " + r.url()); });
    page.on("console", (m) => consoleLines.push(m.type() + ": " + m.text()));
    await page.goto(origin + "/site/__c2test.html");
    await page.waitForFunction(() => window.ready === true, null, { timeout: 30000 })
      .catch((e) => { throw new Error("the test page did not load: " + JSON.stringify({ errors, bad, console: consoleLines.slice(-8), requests: requests.map((r) => r.url.replace(origin, "")).slice(-12) })); });
    const cfg = { vault: VAULT, book: BOOK, chainId: 8453, rpcs: ["https://a.example", "https://b.example", "https://c.example"], independent: { state: "off" } };
    const out = await page.evaluate(async ({ cfg, ID, ID2, NEW_ENV, PREDICTION, OWNER }) => {
      const code = (p) => p.then(() => null, (e) => e.code || String(e));
      // UNSET first: the browser offers nothing and never assumes the production vault
      setup({ ...cfg, vault: "" });
      const unset = await C2.vaultState();
      const unsetSave = await code(C2.saveV2({ id: ID, env: NEW_ENV, signer: signer(OWNER) }));
      setup(cfg);
      const verified = (await C2.vaultState()).state;
      const plan = await C2.planFirstPolicy(ID, PREDICTION);
      const notAdmitted = await code(C2.saveV2({ id: ID, env: NEW_ENV, signer: signer(OWNER) }));
      const notOwner = await code(C2.saveV2({ id: ID, env: NEW_ENV, admittedRules: plan.rules, signer: signer("0x" + "0b".repeat(20)) }));
      const saved = await C2.saveV2({ id: ID, env: NEW_ENV, admittedRules: plan.rules, signer: signer(OWNER) });
      const status = await C2.statusV2(ID);
      // the second deployment: migrate its relay copy (read, store in v2), keep the copy, then the gated deletion
      // its config is the catalog version's: the owner states it has none (as the CLI's --no-config); unstated, it is refused
      const unbound = await code(C2.migrateFromRelayV2({ id: ID2, relay, signer: signer(OWNER), admittedRules: plan.rules }));
      const migrated = await C2.migrateFromRelayV2({ id: ID2, relay, signer: signer(OWNER), admittedRules: plan.rules, configOverride: { none: true } });
      const clearRefused = await code(C2.clearRelayCopyV2({ id: ID2, relay }));
      return { unset: unset.state, unsetSave, verified, label: plan.committee.label, notAdmitted, notOwner,
               secretRev: String(saved.secretRev), status: { paused: status.policy.paused, kind: status.committee.kind, policyRev: String(status.policy.policyRev) },
               unbound, migrated: { names: migrated.migratedNames, oldCopy: migrated.oldCopy.state }, clearRefused, ua: navigator.userAgent };
    }, { cfg, ID, ID2, NEW_ENV, PREDICTION, OWNER });
    relayCustody = true;
    const cleared = await page.evaluate(async (ID2) => (await C2.clearRelayCopyV2({ id: ID2, relay })).state, ID2);
    assert.deepEqual(errors, []);
    assert.match(out.ua, /Chrome\//);
    assert.equal(out.unset, "unset"); assert.equal(out.unsetSave, "vault_unset");
    assert.equal(out.verified, "verified");
    assert.match(out.label, /^SINGLE-SEAT BOOTSTRAP/);
    assert.equal(out.notAdmitted, "rules_not_admitted"); assert.equal(out.notOwner, "not_owner");
    assert.equal(out.secretRev, "1");
    assert.deepEqual(out.status, { paused: false, kind: "single-seat-bootstrap", policyRev: "1" });
    assert.equal(out.unbound, "config_unbound");
    assert.deepEqual(out.migrated, { names: Object.keys(RELAY_ENV), oldCopy: "present-relay-not-custody-aware" });
    assert.equal(out.clearRefused, "relay_not_custody_aware");
    assert.equal(cleared, "relay-reports-deleted");
    // what the page stored opens, with the committee secret, to exactly what it was given
    assert.deepEqual(openBundle({ x: key.x, id: ID, secretRev: 1n, committeeId: GENESIS_COMMITTEE, bundle: fake.bundles.get(ID).data }).env, NEW_ENV);
    assert.deepEqual(openBundle({ x: key.x, id: ID2, secretRev: 1n, committeeId: GENESIS_COMMITTEE, bundle: fake.bundles.get(ID2).data }).env, RELAY_ENV);
    // the relay saw: one read, existence probes, and exactly ONE clear - after custody was reported - carrying no value
    // (the unbound attempt stopped before the relay read: no owner signature is spent on a save that cannot happen)
    assert.deepEqual(relayLog.map((x) => x.path), ["/relay/get", "/relay/exists", "/relay/exists", "/relay/exists", "/relay/clear"]);
    assert.equal(fake.applied.length, 2, "two vault updates: the save and the migration (the unbound attempt sent none)");
    // every request the page made stayed on this origin, and none carried a v2 value (new or migrated) in the clear
    for (const r of requests) {
      assert.ok(r.url.startsWith(origin + "/"), "an off-origin request: " + r.url);
      for (const v of [...Object.values(NEW_ENV), ...Object.values(RELAY_ENV)]) {
        assert.ok(!r.body.includes(v) && !r.url.includes(v), "a value in a request: " + r.url);
        assert.ok(!r.body.toLowerCase().includes(Buffer.from(v).toString("hex")), "a hex value in a request: " + r.url);
      }
    }
    assert.ok(!requests.some((r) => r.method === "POST" && !r.url.startsWith(origin + "/relay/")), "the only POSTs are the fixture relay's");
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.close();
  }
});

test("the edited dashboard component (deployments.js) loads in Chrome with its custody v2 controls in the Secrets panel markup", { skip }, async () => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/site/__c2load.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(`<!doctype html><meta charset="utf-8"><script type="module">
        import("/site/components/deployments/deployments.js").then(() => { window.loaded = !!customElements.get("c-deployments"); }, (e) => { window.loaded = "ERR " + e; });
      </script>`);
    }
    if (u.pathname.startsWith("/v1/") || !u.pathname.startsWith("/")) { res.writeHead(404); return res.end(); }
    const f = path.resolve(REPO, "." + u.pathname);
    if (!f.startsWith(REPO + path.sep) || /[\\/](node_modules|\.git)[\\/]/.test(f) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": /\.(m?js)$/.test(f) ? "text/javascript; charset=utf-8" : /\.html$/.test(f) ? "text/html; charset=utf-8" : "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: CFT, headless: true, args: ["--disable-gpu", "--disable-extensions", "--disable-dev-shm-usage", ...LEAN] });
    const page = await browser.newPage();
    const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
    // the page's own network (relay, RPCs) is cut: only this repository's files load
    await page.route("**/*", (route) => route.request().url().startsWith(`http://127.0.0.1:${server.address().port}/`) ? route.continue() : route.abort());
    await page.goto(`http://127.0.0.1:${server.address().port}/site/__c2load.html`);
    await page.waitForFunction(() => window.loaded !== undefined, null, { timeout: 60000 });
    assert.equal(await page.evaluate(() => window.loaded), true);
    assert.deepEqual(errors.filter((e) => !/Failed to fetch|NetworkError|net::ERR/.test(e)), []);
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.close();
  }
  // the panel's markup carries the v2 controls, each stating the signature it needs, and v1 is labelled v1
  const src = fs.readFileSync(path.join(REPO, "site/components/deployments/deployments.js"), "utf8");
  for (const cls of ["es-c2-save", "es-c2-pause", "es-c2-clear", "es-c2-cfgrow", "enc-c2-status"]) assert.ok(src.includes('class="btn btn-sm ' + cls + '"') || src.includes('class="' + cls + '"') || src.includes('class="term ' + cls + '"'), cls);
  assert.match(src, /Save to custody \(v1\)<\/button>/);
  assert.match(src, /ONE owner transaction/);
});
