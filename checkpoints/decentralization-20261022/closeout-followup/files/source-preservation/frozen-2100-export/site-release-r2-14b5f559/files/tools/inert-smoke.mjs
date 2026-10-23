// (r2 workspace: + the verified config read's CAR chunk check on /apps, from the 10-22 stage browser-smoke.mjs)
// inert-smoke.mjs <release dir> <release-check.json> <out.json>: OFFLINE smoke of the PREPARED release (adapted from the 10-22
// stage's browser-smoke.mjs). A local server serves the release's site/ read-only with the release's own headers (its ledger CSP)
// and _redirects; ONE headless-shell context (single-process, the 512-MiB recipe) with every non-local request ABORTED and counted.
//   1. public pages /, /apps, /dashboard, /credit/, /recover/: 200, no page errors, no CSP refusals, no local 4xx/5xx, the stamp;
//   2. INERT custody v2: on /dashboard, with the site's address-book cache seeded with what the production book holds (registry,
//      deployments - NO secretVaultV2, read 2026-10-23 by root), the BUILT component's Secrets panel paints "custody v2: UNSET -
//      the EnclaveAddressBook names no secretVaultV2" and shows no v2 button;
//   3. control: the same page with a cache naming secretVaultV2 = 0xE486… paints another state (RPCs are aborted, so it cannot
//      verify) and still shows no v2 button - the inert answer above comes from the book, not from a broken panel.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const [REL, CHECK, OUT] = process.argv.slice(2).map((p) => path.resolve(p));
const require = createRequire(path.join(path.dirname(path.dirname(CHECK)), "src", "package.json"));
const { chromium } = require("playwright");
const SHELL = "/home/steven/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell";
const SITE = path.join(REL, "site"), m = JSON.parse(fs.readFileSync(path.join(REL, "release.json"), "utf8"));
const check = JSON.parse(fs.readFileSync(CHECK, "utf8")), C2 = "/" + check.custodyV2Chunks[0], CAR = "/" + check.configRead.car[0];
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".wasm": "application/wasm", ".map": "application/json", ".txt": "text/plain",
  ".woff2": "font/woff2", ".webmanifest": "application/manifest+json", ".xml": "application/xml" };
const rules = fs.readFileSync(path.join(SITE, "_redirects"), "utf8").split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean).map((l) => l.split(/\s+/));
const file = (p) => { const f = path.join(SITE, p); if (!f.startsWith(SITE + path.sep)) return null;
  try { const s = fs.statSync(f); if (s.isFile()) return f; if (s.isDirectory() && fs.statSync(path.join(f, "index.html")).isFile()) return path.join(f, "index.html"); } catch {} return null; };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x"); let p = decodeURIComponent(u.pathname), status = 200, f = file(p);
  if (!f) for (const [from, to, code] of rules) {
    if (from !== p && from !== "/*") continue;
    if (code === "301") { res.writeHead(301, { location: to }); return res.end(); }
    f = file(to); status = Number(code); break;
  }
  if (!f) { res.writeHead(404); return res.end(); }
  res.writeHead(status, { ...m.headers, "content-type": TYPES[path.extname(f)] || "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
// the production book's entries as root read them (custody-v2-live evidence known-state.json): no secretVaultV2
const PROD_BOOK = { registry: "0x868eB7fc5B5A84B2FF082eafc9bf40b7AAc5CCAC", deployments: "0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B" };
const external = {}, out = { release: m.cid, custodyChunk: C2, pages: [] };
let browser; const deadline = setTimeout(() => { void browser?.close(); }, 170000);
// The BUILT dashboard component's own Secrets-panel wiring (Deployments.prototype._secretsWire, the code users run) on the
// panel's markup: click Secrets, then read what the custody v2 status line paints and which v2 buttons are shown.
const vaultStateIn = async (page) => page.evaluate(async () => {
  const C = customElements.get("c-deployments");
  if (!C || typeof C.prototype._secretsWire !== "function") return { error: "c-deployments / _secretsWire not registered" };
  const id = "0x" + "d1".repeat(32), host = document.createElement("div");
  host.innerHTML = '<div class="enc-row"><button class="es-toggle" type="button">Secrets</button>'
    + '<div class="enc-sec" data-id="' + id + '"><div class="enc-sec-body" hidden><textarea class="es-ta"></textarea><span class="enc-sec-acts">'
    + '<button class="es-save" type="button">Save</button><button class="es-custody" type="button" hidden>v1</button>'
    + '<button class="es-c2-save" type="button" hidden>v2</button><button class="es-c2-pause" type="button" hidden>pause</button>'
    + '<button class="es-c2-clear" type="button" hidden>clear</button></span><div class="es-c2-cfgrow" hidden><textarea class="es-c2-cfg"></textarea>'
    + '<input type="checkbox" class="es-c2-nocfg"></div><div class="term enc-c2-status"></div></div><div class="term enc-sec-status"></div></div></div>';
  document.body.appendChild(host);
  const box = host.querySelector(".enc-sec");
  C.prototype._secretsWire.call({ _list: [] }, box);
  host.querySelector(".es-toggle").click();
  const st = box.querySelector(".enc-c2-status");
  for (let i = 0; i < 100 && !st.textContent.trim(); i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 300));
  const shown = ["es-c2-save", "es-c2-pause", "es-c2-clear"].filter((c) => !box.querySelector("." + c).hidden);
  return { v2Status: st.textContent.trim().slice(0, 400), v2ButtonsShown: shown,
           state: /custody v2: UNSET/.test(st.textContent) ? "unset" : (/custody v2: ([A-Z]+)/.exec(st.textContent) || [])[1]?.toLowerCase() || (st.textContent.includes("[✓] custody v2 vault") ? "verified" : null),
           why: st.textContent };
});
try {
  browser = await chromium.launch({ executablePath: SHELL, headless: true, args: ["--single-process", "--no-zygote", "--disable-gpu", "--disable-dev-shm-usage",
    "--disable-extensions", "--js-flags=--max-old-space-size=96"] });
  const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: 800, height: 600 }, reducedMotion: "reduce" });
  await ctx.route("**/*", (route) => { const u = new URL(route.request().url());
    if (u.origin === base) return route.continue();
    external[u.hostname] = (external[u.hostname] || 0) + 1; return route.abort("blockedbyclient"); });
  const visit = async (p, seed) => {
    const page = await ctx.newPage(), row = { path: p, seed: seed ? Object.keys(seed).sort() : null, pageErrors: [], cspRefusals: [], localBad: [], localOk: 0 };
    if (seed !== undefined) await page.addInitScript((s) => { sessionStorage.setItem("enclave_addrbook", JSON.stringify(s)); }, seed);
    page.on("pageerror", (e) => row.pageErrors.push(e.message));
    page.on("console", (c) => { if (c.type() === "error" && /Refused to|Content Security Policy/i.test(c.text())) row.cspRefusals.push(c.text().slice(0, 300)); });
    page.on("response", (r) => { const u = new URL(r.url()); if (u.origin !== base) return; if (r.status() >= 400) row.localBad.push(`${r.status()} ${u.pathname}`); else row.localOk++; });
    try {
      const resp = await page.goto(base + p, { waitUntil: "domcontentloaded", timeout: 20000 });
      row.status = resp?.status(); await page.waitForTimeout(4000);
      row.title = await page.title();
      row.stamp = await page.evaluate(() => document.querySelector("[data-build]")?.textContent ?? null);
      if (p === "/dashboard" && seed !== undefined) row.custodyV2 = await vaultStateIn(page);
      // the verified config read's CAR chunk (the 10-22 stage smoke's check): its exports run; a non-CAR body is refused
      if (p === "/apps") row.carModule = await page.evaluate(async (spec) => {
        const car = await import(spec), r = { exports: Object.keys(car).sort() };
        r.carCap = car.carCap(1 << 20);
        try { r.verifyGarbage = await car.verifyCar(new Uint8Array([0x01, 0x55, 0x12, 0x20, ...new Uint8Array(32)]), new Uint8Array([1, 2, 3]), 1 << 20); }
        catch (e) { r.verifyGarbage = "threw: " + e.message; }
        return r; }, CAR);
    } catch (e) { row.error = e.message; }
    finally { await page.close(); }
    out.pages.push(row); return row;
  };
  for (const p of ["/", "/apps", "/credit/", "/recover/"]) await visit(p);
  const inert = await visit("/dashboard", PROD_BOOK);
  const control = await visit("/dashboard", { ...PROD_BOOK, secretVaultV2: "0xE48699B8401564aaCe7A814AE4569b67a3F7eEF5" });
  out.inert = inert.custodyV2; out.control = control.custodyV2;
  out.completed = true;
} catch (e) { out.error = e.message; out.completed = false; }
finally { clearTimeout(deadline); await browser?.close(); server.close(); }
out.externalAborted = external;
const cm = out.pages.find((x) => x.path === "/apps")?.carModule; out.carModule = cm;
out.ok = out.completed === true && !!cm && ["carCap", "verifyCar"].every((e) => cm.exports.includes(e)) && cm.carCap > (1 << 20)
  && (cm.verifyGarbage === null || String(cm.verifyGarbage).startsWith("threw")) && out.pages.every((x) => !x.error && x.status === 200 && !x.pageErrors.length && !x.localBad.length && !x.cspRefusals.length)
  && out.inert?.state === "unset" && /names no secretVaultV2/.test(out.inert?.why || "") && out.inert.v2ButtonsShown.length === 0
  && !!out.control?.state && out.control.state !== "unset" && out.control.v2ButtonsShown.length === 0;
fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n"); console.log(JSON.stringify(out, null, 1));
console.log(out.ok ? "INERT-SMOKE-OK" : "INERT-SMOKE-FAILED"); process.exit(out.ok ? 0 : 1);
