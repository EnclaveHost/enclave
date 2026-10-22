// browser-smoke.mjs <release dir> <release-check.json> <out.json>: OFFLINE smoke of the built release. A local static server serves
// the release's site/ READ-ONLY with the release's own headers (release.json: the ledger CSP with its inline-script hashes) and its
// _redirects rewrites; ONE fresh disposable Chromium context (root's memory-fitting flags, as root-public-cold-browser-r3 probe.mjs and
// public-cold-frontend browser-media.mjs) with no wallet, storage or profile loads a few public pages. EVERY non-local request is
// aborted and counted (no network, no RPC, no gateway). Records per page: status, page errors, CSP / console errors, same-origin
// responses >= 400. Then, on the apps page, imports the config reader's CAR chunk named by release-check.json (the dynamic-import
// target) and checks its exports run: carCap(1 MiB) is a number above 1 MiB; verifyCar refuses a non-CAR body.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire("/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/e2e/package.json");
const { chromium } = require("playwright");
const [REL, CHECK, OUT] = process.argv.slice(2).map((p) => path.resolve(p));
const SITE = path.join(REL, "site"), m = JSON.parse(fs.readFileSync(path.join(REL, "release.json"), "utf8"));
const check = JSON.parse(fs.readFileSync(CHECK, "utf8")), CAR = "/" + check.configRead.car[0];
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
const external = {}, out = { release: m.cid, carChunk: CAR, pages: [] };
let browser; const deadline = setTimeout(() => { void browser?.close(); }, 150000);
try {
  browser = await chromium.launch({ headless: true, args: ["--single-process", "--no-zygote", "--in-process-gpu", "--disable-software-rasterizer", "--disable-gpu", "--disable-dev-shm-usage", "--renderer-process-limit=1",
    "--disable-extensions", "--disable-features=site-per-process,IsolateOrigins,Translate,OptimizationHints,MediaRouter,AudioServiceOutOfProcess", "--enable-features=NetworkServiceInProcess,NetworkServiceInProcess2", "--js-flags=--max-old-space-size=64"] });
  const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: 800, height: 600 }, reducedMotion: "reduce" });
  await ctx.route("**/*", (route) => { const u = new URL(route.request().url());
    if (u.origin === base) return route.continue();
    external[u.hostname] = (external[u.hostname] || 0) + 1; return route.abort("blockedbyclient"); });
  for (const p of ["/", "/apps", "/dashboard", "/credit/", "/recover/"]) {
    const page = await ctx.newPage(), row = { path: p, pageErrors: [], consoleErrors: [], localBad: [], localOk: 0 };
    page.on("pageerror", (e) => row.pageErrors.push(e.message));
    page.on("console", (c) => { if (c.type() === "error") row.consoleErrors.push(c.text().slice(0, 300)); });
    page.on("response", (r) => { const u = new URL(r.url()); if (u.origin !== base) return; if (r.status() >= 400) row.localBad.push(`${r.status()} ${u.pathname}`); else row.localOk++; });
    page.on("requestfailed", (r) => { const u = new URL(r.url()); if (u.origin === base) row.localBad.push(`failed ${u.pathname} ${r.failure()?.errorText}`); });
    try {
      const resp = await page.goto(base + p, { waitUntil: "domcontentloaded", timeout: 20000 });
      row.status = resp?.status(); await page.waitForTimeout(5000);
      row.title = await page.title();
      row.stamp = await page.evaluate(() => document.querySelector("[data-build]")?.textContent ?? null);
      row.bodyChars = (await page.locator("body").innerText({ timeout: 5000 })).length;
      if (p === "/apps") row.carModule = await page.evaluate(async (spec) => {
        const car = await import(spec), r = { exports: Object.keys(car).sort() };
        r.carCap = car.carCap(1 << 20);
        try { r.verifyGarbage = await car.verifyCar(new Uint8Array([0x01, 0x55, 0x12, 0x20, ...new Uint8Array(32)]), new Uint8Array([1, 2, 3]), 1 << 20); }
        catch (e) { r.verifyGarbage = "threw: " + e.message; }
        return r; }, CAR);
    } catch (e) { row.error = e.message; }
    finally { await page.close(); }
    out.pages.push(row);
  }
  out.completed = true;
} catch (e) { out.error = e.message; out.completed = false; }
finally { clearTimeout(deadline); await browser?.close(); server.close(); }
out.externalAborted = external;
const cm = out.pages.find((x) => x.path === "/apps")?.carModule;
out.ok = out.completed === true && out.pages.every((x) => !x.error && x.status === 200 && !x.pageErrors.length && !x.localBad.length
    && !x.consoleErrors.some((t) => /Content Security Policy|Failed to load module|Failed to fetch dynamically imported/i.test(t)))
  && !!cm && ["carCap", "verifyCar"].every((e) => cm.exports.includes(e)) && cm.carCap > (1 << 20) && (cm.verifyGarbage === null || String(cm.verifyGarbage).startsWith("threw"));
fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n"); console.log(JSON.stringify(out, null, 1));
console.log(out.ok ? "BROWSER-SMOKE-OK" : "BROWSER-SMOKE-FAILED"); process.exit(out.ok ? 0 : 1);
