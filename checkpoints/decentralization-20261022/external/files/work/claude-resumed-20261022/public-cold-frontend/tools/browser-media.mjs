// browser-media.mjs <tree dir> <scenario> <out.json>: ONE fresh disposable Chromium page (root's memory-fitting flags) renders the REAL
// <c-app-card> and <c-app-detail> (banner) components and a dashboard chip exactly as components/deployments/deployments.js builds it, from a local static
// server over a real-copy tree. Every external request is answered by route rules - nothing leaves this machine:
//   ipfs.enclave.host   ABORTED in every scenario (the cold path root's r3 browser saw)
//   ipfs.io/ipfs/<CID>  fulfilled with a fixture PNG in "alt-ok"; aborted in "all-down"; in "recover" aborted until the outage
//                       ends, after which the page clock is stepped past MEDIA_MISS_TTL_MS and everything re-renders once
//   dweb.link           aborted; anything else external aborted
// Records the rendered thumbnail / chip / banner, per-host request counts, and whether a re-render repeats requests.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire("/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/e2e/package.json");
const { chromium } = require("playwright");
const [TREE, SCEN, OUT] = process.argv.slice(2);
const CID = "bafkreia4wrrx3ljhfog5r4sa7yd5e3d6bblbvngwyjnmce2q2f3grbu36e";   // root's observed media CIDs (raw leaf): thumbnail
const BCID = "bafkreiafoesremdf5xdsfdgj27inbatfr5infxwqw7az4wj4w3miowgety";  // banner
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const HARNESS = `<!doctype html><meta charset="utf-8"><title>media harness</title><body>
<div id="chips"></div>
<script>{ const real = Date.now.bind(Date); let skew = 0; Date.now = () => real() + skew; window.advanceClock = (ms) => { skew += ms; }; }</script>
<script type="module">
import * as C from "./js/core/catalog.js";
const { STORE, catalogRef, artOfRef } = C;
import "./components/app-card/app-card.js";
import "./components/app-detail/app-detail.js";
const app = { appId: "0x" + "ab".repeat(32), name: "Logo App", slug: "logo-app", description: "fixture", publisher: "0x" + "1".repeat(40), active: true, updatedAt: 1,
  versions: [{ approval: 1, yanked: false, verified: false, cid: "bafyfixturewasm0000000", version: "1.0.0", config: JSON.stringify({ _media: { thumbnail: "${CID}", banner: "${BCID}" } }) }] };
STORE.apps = [app]; STORE.byId = { [app.appId]: app }; STORE.loaded = true;
const card = document.createElement("c-app-card"); card.app = app; document.body.appendChild(card);
const detail = document.createElement("c-app-detail"); detail.app = app; document.body.appendChild(detail);
const ref = catalogRef(app.appId, 0);
const chipHtml = () => { const art = artOfRef(ref, "Logo App"), artAttrs = typeof C.artAttrsOfRef === "function" ? C.artAttrsOfRef(ref, "Logo App") : "";
  return '<span class="enc-thumb" style="background-image:' + art + '"' + artAttrs + ' aria-hidden="true"></span>'; };
const body = document.getElementById("chips");
window.renderChip = () => { body.innerHTML = chipHtml(); if (typeof C.hydrateMedia === "function") C.hydrateMedia(body); };
window.rerenderCard = () => { card.app = { ...app }; detail.app = { ...app }; };
window.missTtl = C.MEDIA_MISS_TTL_MS;
window.renderChip();
window.state = () => ({ thumb: (document.querySelector("c-app-card .app-thumb") || {}).style?.backgroundImage || null,
                         chip: body.querySelector(".enc-thumb").style.backgroundImage,
                         banner: (() => { const b = document.querySelector("c-app-detail .appd-banner"); return b ? { hidden: b.hidden, bg: b.style.backgroundImage } : null; })() });
</script>`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x"); if (u.pathname === "/site/media-harness.html") { res.writeHead(200, { "content-type": "text/html" }); return res.end(HARNESS); }
  const f = path.join(TREE, decodeURIComponent(u.pathname)); if (!f.startsWith(TREE) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  const ext = path.extname(f); res.writeHead(200, { "content-type": ext === ".js" || ext === ".mjs" ? "text/javascript" : ext === ".html" ? "text/html" : ext === ".css" ? "text/css" : "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const counts = {}, out = { scenario: SCEN, tree: path.basename(TREE), cid: CID, bannerCid: BCID }; let ioUp = SCEN === "alt-ok";
let browser; const deadline = setTimeout(() => { void browser?.close(); }, 90000);
try {
  browser = await chromium.launch({ headless: true, args: ["--single-process", "--no-zygote", "--in-process-gpu", "--disable-software-rasterizer", "--disable-gpu", "--disable-dev-shm-usage", "--renderer-process-limit=1",
    "--disable-extensions", "--disable-features=site-per-process,IsolateOrigins,Translate,OptimizationHints,MediaRouter,AudioServiceOutOfProcess", "--enable-features=NetworkServiceInProcess,NetworkServiceInProcess2", "--js-flags=--max-old-space-size=64"] });
  const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: 800, height: 600 } });
  await ctx.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.origin === base) return route.continue();
    counts[u.hostname] = (counts[u.hostname] || 0) + 1;
    if (ioUp && u.hostname === "ipfs.io" && (u.pathname === "/ipfs/" + CID || u.pathname === "/ipfs/" + BCID)) return route.fulfill({ status: 200, contentType: "image/png", body: PNG });
    return route.abort("blockedbyclient");
  });
  const page = await ctx.newPage(); const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/site/media-harness.html", { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForFunction(() => window.state && document.querySelector("c-app-card .app-thumb"), null, { timeout: 15000 });
  out.firstPaint = await page.evaluate(() => window.state());
  await page.waitForTimeout(4000);                        // aborted requests fail at once; well under one MEDIA_TRY_MS
  out.settled = await page.evaluate(() => window.state());
  out.countsAfterSettle = { ...counts };
  await page.evaluate(() => { window.rerenderCard(); window.renderChip(); });
  await page.waitForTimeout(1500);
  out.afterRerender = await page.evaluate(() => window.state()); out.countsAfterRerender = { ...counts };
  if (SCEN === "recover") {                                // the outage ends; one render after the negative window re-checks once
    ioUp = true; out.missTtl = await page.evaluate(() => { window.advanceClock(window.missTtl + 1000); window.rerenderCard(); window.renderChip(); return window.missTtl; });
    await page.waitForTimeout(3000);
    out.recovered = await page.evaluate(() => window.state()); out.countsAfterRecover = { ...counts };
    await page.evaluate(() => { window.rerenderCard(); window.renderChip(); }); await page.waitForTimeout(1500);
    out.afterRecoverRerender = await page.evaluate(() => window.state()); out.countsAfterRecoverRerender = { ...counts };
  }
  out.pageErrors = errors; out.completed = true; await page.close();
} catch (e) { out.error = e.message; out.completed = false; }
finally { clearTimeout(deadline); await browser?.close(); server.close(); fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n"); console.log(JSON.stringify(out)); }
