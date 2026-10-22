// The shared media fallback (site/js/core/catalog.js resolveMedia / applyMedia / mediaUrls): bounded, ordered, one resolution
// per CID per freshness window. A deterministic Image stub stands in for the browser loader (each URL's outcome scripted:
// load | error | hang) and Date.now is a test clock, so TTL expiry is stepped exactly, never waited for.
import "./helpers/dom-stub.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
let now = 1_800_000_000_000; Date.now = () => now;
const tried = [], plan = new Map();
globalThis.Image = class { set src(u) { this._u = u; if (!u) return; tried.push(u); const o = [...plan].find(([k]) => u.startsWith(k))?.[1] || "error";
  if (o === "load") setTimeout(() => this.onload && this.onload(), 5); else if (o === "error") setTimeout(() => this.onerror && this.onerror(), 5); } get src() { return this._u; } };
const C = await import("../site/js/core/catalog.js");
const CFG = await import("../site/js/core/config.js");
const PREF = "https://ipfs.enclave.host/ipfs/", IO = "https://ipfs.io/ipfs/", DWEB = "https://dweb.link/ipfs/";
const cid = (n) => "bafkreia4wrrx3ljhfog5r4sa7yd5e3d6bblbvngwyjnmce2q2f3gr" + String(n).padStart(4, "a");
const el = () => ({ style: {}, dataset: {} });
const flush = () => new Promise((r) => setTimeout(r, 0));
const reset = (p) => { tried.length = 0; plan.clear(); for (const [k, v] of Object.entries(p)) plan.set(k, v); };

test("the fallback list is the existing read gateways only, in order; mediaUrl (the preferred URL) is unchanged", () => {
  assert.equal(CFG.IPFS_IMG_GATEWAY, PREF); assert.deepEqual(CFG.IPFS_IMG_FALLBACKS, [IO, DWEB]); assert.equal(CFG.IPFS_GATEWAY, IO);
  assert.equal(C.mediaUrl(cid(1)), PREF + cid(1)); assert.equal(C.mediaUrl(cid(1), true), PREF + cid(1) + "?filename=enclave-logo.svg");
  assert.deepEqual(C.mediaUrls(cid(1), true), [PREF, IO, DWEB].map((g) => g + cid(1) + "?filename=enclave-logo.svg"));
  assert.deepEqual(C.mediaUrls("not a cid!"), []); assert.ok(C.MEDIA_MAX_TRIES <= 4 && C.MEDIA_TRY_MS <= 8000);
});
test("preferred gateway delivers: one attempt, the preferred URL, no fallback request", async () => {
  reset({ [PREF]: "load" }); assert.equal(await C.resolveMedia(cid(2)), PREF + cid(2)); assert.deepEqual(tried, [PREF + cid(2)]);
});
test("preferred gateway fails (the cold path root observed): the next existing gateway delivers; the band shows it, not nothing", async () => {
  reset({ [PREF]: "error", [IO]: "load" }); const e = el();
  C.applyMedia(e, cid(3), false, "PLACEHOLDER");
  assert.equal(e.style.backgroundImage, "url('" + PREF + cid(3) + "')", "first paint as before");
  await C.resolveMedia(cid(3)); await new Promise((r) => setTimeout(r, 0));
  assert.equal(e.style.backgroundImage, "url('" + IO + cid(3) + "')"); assert.deepEqual(tried, [PREF + cid(3), IO + cid(3)]);
});
test("no gateway delivers: bounded attempts (3), then the renderer's placeholder + onResult(false); not retried inside the window", async () => {
  reset({}); const e = el(); let missing = 0;
  C.applyMedia(e, cid(4), true, "PLACEHOLDER", (shown) => { if (!shown) missing++; });
  assert.equal(await C.resolveMedia(cid(4), true), null); await new Promise((r) => setTimeout(r, 0));
  assert.equal(e.style.backgroundImage, "PLACEHOLDER"); assert.equal(missing, 1); assert.equal(tried.length, 3);
  assert.ok(C.MEDIA_MISS_TTL_MS > 0 && C.MEDIA_HIT_TTL_MS >= C.MEDIA_MISS_TTL_MS);
  const e2 = el(); C.applyMedia(e2, cid(4), true, "PLACEHOLDER2"); assert.equal(e2.style.backgroundImage, "PLACEHOLDER2", "settled: painted synchronously");
  await C.resolveMedia(cid(4), true); assert.equal(tried.length, 3, "no repeated attempts for the same CID");
});
test("a gateway that never answers is abandoned at MEDIA_TRY_MS and the next one is tried (no infinite loading)", { timeout: 20000 }, async () => {
  reset({ [PREF]: "hang", [IO]: "load" }); const t0 = performance.now();
  assert.equal(await C.resolveMedia(cid(5)), IO + cid(5));
  const ms = performance.now() - t0; assert.ok(ms >= C.MEDIA_TRY_MS - 50 && ms < C.MEDIA_TRY_MS + 2000, String(ms));
});
test("concurrent renders of the same CID share ONE resolution; a re-targeted element ignores the stale answer", async () => {
  reset({ [PREF]: "error", [IO]: "load" });
  const a = el(), b = el(); C.applyMedia(a, cid(6)); C.applyMedia(b, cid(6)); C.applyMedia(a, cid(7), false, "P7");
  await Promise.all([C.resolveMedia(cid(6)), C.resolveMedia(cid(7))]); await new Promise((r) => setTimeout(r, 0));
  assert.equal(b.style.backgroundImage, "url('" + IO + cid(6) + "')"); assert.equal(a.style.backgroundImage, "url('" + IO + cid(7) + "')");
  assert.equal(tried.filter((u) => u.includes(cid(6))).length, 2, "one resolution for cid 6 despite two renders");
});
test("an invalid or missing CID paints the placeholder and requests nothing", async () => {
  reset({}); const e = el(); let m = 0; C.applyMedia(e, "", false, "PH", (shown) => { if (!shown) m++; }); assert.equal(e.style.backgroundImage, "PH"); assert.equal(m, 1);
  C.applyMedia(e, "javascript:alert(1)", false, "PH2"); assert.equal(e.style.backgroundImage, "PH2"); assert.equal(tried.length, 0);
  assert.equal(C.mediaAttrs("x y"), ""); assert.match(C.mediaAttrs(cid(8), true, "url('data:x')"), /data-media-cid="bafkrei[^"]+" data-media-svg="1" data-media-alt="url\(&#39;data:x&#39;\)"/);
});
test("a temporary outage heals: renders inside MEDIA_MISS_TTL_MS repaint the placeholder with no request; the first render after it re-checks ONCE for all callers and the banner comes back", async () => {
  reset({}); const shown = []; const banner = Object.assign(el(), { hidden: false });
  const show = (b) => { banner.hidden = !b; shown.push(b); };
  C.applyMedia(banner, cid(10), false, "", show); assert.equal(banner.hidden, false, "first sight: preferred URL painted, banner shown as before");
  await C.resolveMedia(cid(10)); await flush(); assert.equal(banner.hidden, true); assert.equal(tried.length, 3);
  now += C.MEDIA_MISS_TTL_MS - 1;
  for (let i = 0; i < 50; i++) { C.applyMedia(banner, cid(10), false, "", show); C.hydrateMedia({ querySelectorAll: () => [Object.assign(el(), { dataset: { mediaCid: cid(10), mediaAlt: "PH" } })] }); }
  assert.equal(tried.length, 3, "inside the negative window: 100 renders, 0 requests"); assert.equal(banner.hidden, true);
  reset({ [PREF]: "error", [IO]: "load" }); now += 2;          // the outage ends; the window has just expired
  const chips = Array.from({ length: 20 }, () => el()); chips.forEach((c) => C.applyMedia(c, cid(10), false, "PH"));
  C.applyMedia(banner, cid(10), false, "", show);
  assert.equal(chips[0].style.backgroundImage, "PH", "expired: the last answer stays painted while it re-checks"); assert.equal(banner.hidden, true);
  const moved = chips[19]; C.applyMedia(moved, cid(11), false, "OTHER");   // re-targeted while the re-check is pending
  await C.resolveMedia(cid(10)); await C.resolveMedia(cid(11)); await flush();
  assert.deepEqual(tried.filter((u) => u.includes(cid(10))), [PREF + cid(10), IO + cid(10)], "21 expired renders, ONE shared re-check");
  assert.ok(chips.slice(0, 19).every((c) => c.style.backgroundImage === "url('" + IO + cid(10) + "')"));
  assert.equal(moved.style.backgroundImage, "url('" + IO + cid(11) + "')", "stale answer for cid 10 not painted on the moved element");
  assert.equal(banner.hidden, false, "recovered banner visible again"); assert.equal(banner.style.backgroundImage, "url('" + IO + cid(10) + "')");
  const n = tried.length; now += C.MEDIA_HIT_TTL_MS - 1; C.applyMedia(el(), cid(10)); await C.resolveMedia(cid(10)); assert.equal(tried.length, n, "inside the positive window: no request");
});
test("a chosen gateway that dies is replaced after MEDIA_HIT_TTL_MS, and a recovered preferred gateway wins back; none -> placeholder", async () => {
  reset({ [PREF]: "error", [IO]: "load" }); const e = el(); let last;
  C.applyMedia(e, cid(12), true, "PH", (b) => { last = b; }); await C.resolveMedia(cid(12), true); await flush();
  const svg = (g) => "url('" + g + cid(12) + "?filename=enclave-logo.svg')"; assert.equal(e.style.backgroundImage, svg(IO));
  reset({ [PREF]: "error", [IO]: "error", [DWEB]: "load" }); now += C.MEDIA_HIT_TTL_MS - 1;
  C.applyMedia(e, cid(12), true, "PH", (b) => { last = b; }); assert.equal(e.style.backgroundImage, svg(IO)); assert.equal(tried.length, 0, "no re-check inside the window");
  now += 2; C.applyMedia(e, cid(12), true, "PH", (b) => { last = b; });
  assert.equal(e.style.backgroundImage, svg(IO), "expired: last gateway painted meanwhile");
  assert.equal(await C.resolveMedia(cid(12), true), DWEB + cid(12) + "?filename=enclave-logo.svg"); await flush();
  assert.equal(e.style.backgroundImage, svg(DWEB)); assert.equal(tried.length, 3); assert.equal(last, true);
  reset({ [PREF]: "load" }); now += C.MEDIA_HIT_TTL_MS;
  C.applyMedia(e, cid(12), true, "PH", (b) => { last = b; }); await C.resolveMedia(cid(12), true); await flush();
  assert.equal(e.style.backgroundImage, svg(PREF)); assert.deepEqual(tried, [PREF + cid(12) + "?filename=enclave-logo.svg"]);
  reset({}); now += C.MEDIA_HIT_TTL_MS;
  C.applyMedia(e, cid(12), true, "PH", (b) => { last = b; }); await C.resolveMedia(cid(12), true); await flush();
  assert.equal(e.style.backgroundImage, "PH"); assert.equal(last, false); assert.equal(tried.length, 3);
});
