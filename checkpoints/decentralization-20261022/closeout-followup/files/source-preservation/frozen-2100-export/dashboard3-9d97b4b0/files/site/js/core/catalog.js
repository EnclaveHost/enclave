import {catalogAdmissionNotice,catalogAdmissionRefusal} from "./catalog-policy.js";
import {directUploadHeaders} from "./upload-auth.js";
/* ============================================================
   App store · on-chain catalog (EnclaveAppCatalog on Base) + IPFS CIDs
   Apps are versioned: keyed by keccak256(publisher, slug), each with an
   append-only list of releases (own CID, label, verified/yank flags).
   Browsing reads the contract via a public RPC eth_call (no wallet).

   This module is the shared READ side + the friendly-ref caches:
   the Apps page renders from it, and the Deploy page resolves
   slug:version references and pre-flights the deploy gate with it.
   Load progress is announced with `enclave:catalog` events (detail.type:
   loading | loaded | error) - pages render, this module doesn't.
   ============================================================ */
import { APP_CATALOG_ADDRESS, IPFS_IMG_GATEWAY, IPFS_IMG_FALLBACKS, IPFS_JSON_UPLOAD_URL, IPFS_WALLET_AUDIENCE, STORAGE_PLAN, INDEPENDENT } from "./config.js";
import { catConfigured, appCount, catGetAppsPage, catGetVersions, catOwner, APPROVAL, CAT_MAX } from "./chain.js";
import { lsGet, lsSet, emit, on, esc } from "./util.js";
import { minPctsOf } from "./pricing.js";
import { parseCid, artifactIdentity, hex } from "./unixfs.js";
import { Enclave, EnclaveError } from "./api.js";
import { connectWallet, personalSign } from "./wallet.js";

/* `filter` is the store tab. It opens on "featured": the approved list with the
   standing campaigns (or the editorial pick) lifted to the front, NOT a
   featured-only view. "approved" is the same list without that head group. */
export const STORE = { apps:[], byId:{}, sel:{}, owner:null, filter:"featured", loaded:false, loading:false, at:0 };

// firewall entry: http (default web app) | http:N | tcp:N | udp:N, N in 1-49999 (labels; <1024 always remapped)
// (1080/8080/8090/8091 are infra-reserved; the enclave enforces the same rules server-side)
export const FW_ENTRY_RE = /^(http|http:\d{1,5}|tcp:\d{1,5}|udp:\d{1,5})$/;
const FW_RESERVED = [1080, 8080, 8090, 8091];
export function validPortsCsv(s){
  const parts = String(s || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
  for (const p of parts){
    if (!FW_ENTRY_RE.test(p)) return "bad port spec '" + p + "' (use http[:N], tcp:N, udp:N)";
    const n = p.includes(":") ? +p.split(":")[1] : 0;
    if (n && (n < 1 || n > 49999 || FW_RESERVED.includes(n))) return "port " + n + " not allowed (1-49999, excluding " + FW_RESERVED.join("/") + ")";
  }
  return null;
}

// The last good catalog is cached in localStorage (stale-while-revalidate):
// paint it instantly, refresh behind it, and a failed refresh keeps the page
// usable instead of replacing it with an error wall.
// Bumped whenever a cached version object gains a field the UI now depends on.
// A cache written by an OLDER site build is not merely stale, it is missing
// that field — and the site deploys independently of the catalog contract, so
// the address in the key does not change when the site does. Rev 7 is the live
// example: without `configCid`, a large-config version reads as though its
// config were the small on-chain routing manifest, and the dashboard's Config
// tab would offer that manifest as the app's config for the user to "override".
const CAT_CACHE_V = 2;
export function catCacheGet(){
  try { const c = JSON.parse(lsGet("enclave_catalog_" + APP_CATALOG_ADDRESS) || "null");
        return (c && c.v === CAT_CACHE_V && Array.isArray(c.apps)) ? c : null; } catch(e){ return null; }
}
export function catCacheSet(apps){ lsSet("enclave_catalog_" + APP_CATALOG_ADDRESS, JSON.stringify({ v: CAT_CACHE_V, at: Date.now(), apps })); }

// A loaded store older than this re-reads (in the background, behind the
// current paint) on the next loadCatalog() - i.e. the next page boot. The
// session can't get stuck on one bad read: a store that loaded empty or
// stale heals on the next visit to the Apps page instead of holding
// until a hard refresh.
const FRESH_MS = 120000;
/* The owner read gates ALL moderation UI: approve/reject/verify and the
   Pending/Rejected/Delisted queues key off STORE.owner, and "owner unknown"
   renders identically to "not the owner". A swallowed one-shot failure
   therefore stripped the owner's controls for the whole page view with no
   error and no retry - and the burst right after a publish (receipt polling +
   the catalog reload) is exactly when the public-RPC pool rate-limits, so it
   read as "I can't approve apps" moments after a successful publish. Retry
   with backoff until it lands; the emit re-renders whichever view is up. */
let _ownerBusy = false, _ownerWait = 4000;
function loadOwner(){
  if (_ownerBusy || STORE.owner !== null) return;
  _ownerBusy = true;
  catOwner().then(o => {
    STORE.owner = o.toLowerCase(); _ownerBusy = false; _ownerWait = 4000;
    emit("enclave:catalog", { type: "loaded" });
  }).catch(() => {
    setTimeout(() => { _ownerBusy = false; loadOwner(); }, _ownerWait);
    _ownerWait = Math.min(_ownerWait * 2, 60000);
  });
}
/* ---- confirmed writes the read side hasn't caught up to ----
   A moderation transaction (approve / reject / verify / yank / delist) is
   SETTLED the moment its receipt lands: the chain holds the new state. What
   the UI shows next used to be a different question, and often the wrong one.
   The post-tx re-read goes to the rotating pool of public Base RPCs at exactly
   the moment our own receipt polling has been bursting against them, so it
   either fails outright ("catalog refresh failed - showing the last good
   read", the store keeping its PRE-approval paint) or lands on a replica that
   hasn't indexed the block yet and faithfully repaints the old ruling. Either
   way the owner approved a version and watched nothing happen until a manual
   page refresh minutes later.

   So a write whose receipt has landed is recorded here and re-applied over
   every catalog read until a FRESH read agrees with it (the replicas caught
   up - drop it) or it ages out. The receipt is the authority; a lagging
   replica is not evidence against it. Persisted, because the page refresh
   that used to be the workaround must not be the thing that loses the state.
   A read showing a THIRD value (neither ours nor what we overwrote) means the
   chain moved on without us - someone else's later write - and retires the
   entry too; the TTL is only the backstop under that. */
const WRITE_TTL = 900000;                  // 15 min: far past replica lag, far short of a real divergence
const WRITE_KEY = "enclave_catalog_writes_" + APP_CATALOG_ADDRESS;
let WRITES = null;
function writesLoad(){
  if (WRITES) return WRITES;
  WRITES = {};
  let dropped = false;
  try {
    const o = JSON.parse(lsGet(WRITE_KEY) || "{}"), now = Date.now();
    for (const k in o){
      if (o[k] && now - (o[k].at || 0) < WRITE_TTL) WRITES[k] = o[k];
      else dropped = true;
    }
  } catch(e){ WRITES = {}; dropped = true; }
  if (dropped) writesSave();               // expired entries leave for good, not just for this page
  return WRITES;
}
function writesSave(){ lsSet(WRITE_KEY, JSON.stringify(WRITES || {})); }
/* Re-apply the live writes over an apps[] (in place). `fresh` marks a read
   straight off the chain: only THAT can retire an entry, by agreeing with it
   (or by having moved past it). A cached/already-patched paint agrees with
   itself, so retiring on one would hand the next lagging replica the old
   value back. */
export function applyCatalogWrites(apps, fresh){
  const w = writesLoad(), now = Date.now();
  let changed = false;
  for (const k in w){
    const e = w[k];
    if (now - (e.at || 0) >= WRITE_TTL){ delete w[k]; changed = true; continue; }
    const app = (apps || []).find(a => a.appId === e.appId);
    // an app (or version) this read doesn't carry yet - nothing to write over,
    // and nothing to conclude either: hold the entry until a read shows it
    const tgt = !app ? null : (e.idx == null ? app : app.versions[e.idx]);
    if (!tgt) continue;
    // the read caught up, or it moved somewhere neither we nor the value we
    // overwrote put it (a later write from another tab/wallet) - either way
    // the chain is authoritative again and this entry stops speaking for it
    if (fresh && (tgt[e.field] === e.value || ("was" in e && tgt[e.field] !== e.was))){ delete w[k]; changed = true; }
    else tgt[e.field] = e.value;
  }
  if (changed) writesSave();
  return apps;
}
/* Record a confirmed write and show it at once: the store is patched in place,
   re-cached and announced, so the badge and the Pending/Approved queues move
   on the RECEIPT rather than on the next catalog read that happens to land. */
export function noteCatalogWrite(appId, idx, field, value){
  const w = writesLoad();
  const app = STORE.apps.find(a => a.appId === appId);
  const tgt = !app ? null : (idx == null ? app : app.versions[idx]);
  w[appId + "|" + (idx == null ? "app" : idx) + "|" + field] =
    { appId, idx: idx == null ? null : idx, field, value, at: Date.now(),
      ...(tgt && tgt[field] !== value ? { was: tgt[field] } : {}) };   // what a read still showing this hasn't seen yet
  writesSave();
  applyCatalogWrites(STORE.apps, false);
  if (STORE.loaded) catCacheSet(STORE.apps);
  emit("enclave:catalog", { type: "loaded" });
}
/* Resolves true when a fresh chain read landed. opts.quiet marks a read whose
   failure is not load-bearing (the caller has already painted a confirmed
   write): the error still emits, flagged, so pages can skip the alarm. */
export async function loadCatalog(force, opts){
  if (!catConfigured()){ STORE.loaded = true; emit("enclave:catalog", { type: "loaded" }); return true; }
  // the owner read rides every boot until it lands - ABOVE the freshness
  // early-return, so one rate-limited miss can't leave badges/official
  // fallbacks ownerless for as long as the catalog stays fresh
  if (STORE.owner === null) loadOwner();
  if (STORE.loading || (STORE.loaded && !force && Date.now() - STORE.at < FRESH_MS)) return false;
  STORE.loading = true;
  if (!STORE.loaded){
    const cached = catCacheGet();
    if (cached){
      applyCatalogWrites(cached.apps, false);
      STORE.apps = cached.apps; STORE.byId = {}; cached.apps.forEach(a => STORE.byId[a.appId] = a);
      STORE.loaded = true; STORE.at = cached.at || 0;
      emit("enclave:catalog", { type: "loaded", stale: true });
    } else emit("enclave:catalog", { type: "loading" });
  }
  try {
    const n = await appCount();
    const apps = []; const PAGE = 50;
    for (let s = 0; s < n; s += PAGE) apps.push(...await catGetAppsPage(s, PAGE));
    await Promise.all(apps.map(async a => { a.versions = await catGetVersions(a.appId, a.versionCount); }));
    applyCatalogWrites(apps, true);            // a confirmed ruling outranks a lagging replica
    STORE.apps = apps; STORE.byId = {}; apps.forEach(a => STORE.byId[a.appId] = a);
    STORE.loaded = true; STORE.at = Date.now();
    catCacheSet(apps);
  } catch(e){
    emit("enclave:catalog", { type: "error", message: e.message || String(e), quiet: !!(opts && opts.quiet) });
    STORE.loading = false; return false;
  }
  STORE.loading = false; emit("enclave:catalog", { type: "loaded" });
  return true;
}

/* ---- version selection helpers ---- */
// Publishers and the catalog owner retain moderation history; public listings
// respect delisting, publisher yanks and catalog rejection.
export const appPrivileged = (app) => {
  const me = (Enclave.address || "").toLowerCase();
  return !!me && (app.publisher.toLowerCase() === me || me === STORE.owner);
};
export const verVisible = (app, v) => !!v && (appPrivileged(app) || (app.active === true && !v.yanked && Number(v.approval) !== APPROVAL.rejected));
// indices into app.versions the viewer may see - callers keep the REAL index
// (catalog:// refs and card-action idx are positions in the on-chain list)
export const visibleVerIdxs = (app) =>
  app.versions.reduce((idxs, v, i) => (verVisible(app, v) && idxs.push(i), idxs), []);
export function defaultIdx(app){         // prefer approved releases; explicit selection can name every version
  const vs = app.versions;
  for (let i = vs.length - 1; i >= 0; i--) if (verVisible(app, vs[i]) && !vs[i].yanked && Number(vs[i].approval) === APPROVAL.approved) return i;
  for (let i = vs.length - 1; i >= 0; i--) if (!vs[i].yanked && verVisible(app, vs[i])) return i;
  for (let i = vs.length - 1; i >= 0; i--) if (verVisible(app, vs[i])) return i;
  return -1;
}
export function selIdx(app){
  const s = STORE.sel[app.appId];
  return (s != null && s >= 0 && s < app.versions.length && verVisible(app, app.versions[s])) ? s : defaultIdx(app);
}
// platform-published apps: publisher wallet == the catalog contract deployer
export const appOfficial = (app) => !!(STORE.owner && app.publisher.toLowerCase() === STORE.owner);
// the Verified filter means "owner-endorsed": an explicit setVerified flag, or official
// (owner-published is implicit endorsement - none of the platform apps carry the flag)
export const appVerified = (app) => { const i = defaultIdx(app); return i >= 0 && (app.versions[i].verified || appOfficial(app)); };

/* ---- app media (tile thumbnail + detail-page banner) ----
   Media CIDs ride inside the version's config JSON under a reserved `_media`
   key ({ thumbnail, banner }). This keeps the EnclaveAppCatalog contract
   unchanged - the trade-off (accepted) is that media is per-version, immutable,
   and re-reviewed on change, exactly like the rest of a version's config. The
   runner delivers the whole config as ENCLAVE_CONFIG, so an app just sees an
   extra `_media` key it ignores; the dashboard's Config tab strips it from its view. */
export const MEDIA_KEY = "_media";
const cleanCid = (c) => (typeof c === "string" && /^[a-zA-Z0-9]{10,100}$/.test(c.trim())) ? c.trim() : "";
// Gateway URL for a media CID. SVG media carries a flag in _media because it
// only renders in image contexts under an exact image/svg+xml content-type,
// which the Kubo gateway derives from the ?filename extension; bare raster
// CIDs content-sniff fine without it.
export const mediaUrl = (cid, svg) => IPFS_IMG_GATEWAY + encodeURIComponent(cid) + (svg ? "?filename=enclave-logo.svg" : "");
/* Media fallback for the renderers (store tile, detail banner, dashboard chip). A CSS background has no error event, so an
   unreachable preferred gateway used to leave an EMPTY band with no placeholder (the disappearing logos). A media CID is
   resolved on use: the preferred mediaUrl first, then config.js IPFS_IMG_FALLBACKS in order, each attempt bounded by
   MEDIA_TRY_MS (an image that loads = delivered); the first gateway that delivers is used everywhere that CID appears, and
   if none does the renderer's own placeholder shows instead. The answer is kept MEDIA_HIT_TTL_MS (a gateway) or
   MEDIA_MISS_TTL_MS (none delivered); renders inside that window repaint from it with no request, the first render after it
   re-checks the whole list once (shared by every concurrent caller) while the last answer stays painted. So an outage heals
   and a dead chosen gateway is replaced on a later render, with at most one round of MEDIA_MAX_TRIES attempts per CID per
   window and no timer of its own. Gateways are transport only: never trusted beyond showing the picture, and a working URL
   is not a replica. */
export const MEDIA_TRY_MS = 8000, MEDIA_MAX_TRIES = 4, MEDIA_HIT_TTL_MS = 10 * 60 * 1000, MEDIA_MISS_TTL_MS = 60 * 1000;
const _media = new Map();   // "s:"/"r:" + cid -> { url: string|null, at } last answer, + { pending: Promise } while (re)checking
const mediaKey = (cid, svg) => (svg ? "s:" : "r:") + cid;
const mediaFresh = (e) => !!e && "url" in e && Date.now() - e.at < (e.url ? MEDIA_HIT_TTL_MS : MEDIA_MISS_TTL_MS);
// The public read gateways, preferred first: config.js IPFS_IMG_GATEWAY + IPFS_IMG_FALLBACKS (media and pinned configs share them)
const ipfsReadGateways = () => [...new Set([IPFS_IMG_GATEWAY, ...(IPFS_IMG_FALLBACKS || [])].filter((g) => /^https?:\/\/[^\s'"()]+\/$/.test(g)))];
export function mediaUrls(cid, svg){
  const c = cleanCid(cid); if (!c) return [];
  const q = svg ? "?filename=enclave-logo.svg" : "";
  return ipfsReadGateways().slice(0, MEDIA_MAX_TRIES).map((g) => g + encodeURIComponent(c) + q);
}
function mediaLoads(url, ms){
  return new Promise((done) => {
    const img = new Image(); let over = false;
    const end = (ok) => { if (over) return; over = true; clearTimeout(t); img.onload = img.onerror = null; if (!ok) img.src = ""; done(ok); };
    const t = setTimeout(() => end(false), ms);
    img.onload = () => end(true); img.onerror = () => end(false);
    img.src = url;
  });
}
// -> Promise<the first URL that delivers the CID's image, or null>; one resolution per CID at a time, reused until it expires
export function resolveMedia(cid, svg){
  const c = cleanCid(cid); if (!c) return Promise.resolve(null);
  const k = mediaKey(c, svg), e = _media.get(k);
  if (e && e.pending) return e.pending;
  if (mediaFresh(e)) return Promise.resolve(e.url);
  const pending = (async () => {
    let hit = null;
    for (const u of mediaUrls(c, svg)) { if (await mediaLoads(u, MEDIA_TRY_MS)) { hit = u; break; } }
    _media.set(k, { url: hit, at: Date.now() }); return hit;
  })();
  _media.set(k, { ...e, pending });   // the previous answer stays readable for synchronous repaints meanwhile
  return pending;
}
/* Paint `el`'s background with the CID's image (resolved as above) or, when no gateway delivers it, `fallbackCss` (a CSS
   background value, e.g. placeholderArt); `onResult(shown)` follows every paint, so a hidden optional banner comes back
   when its media recovers. A later call for another CID on the same element wins. */
export function applyMedia(el, cid, svg, fallbackCss, onResult){
  if (!el) return;
  const c = cleanCid(cid), k = c ? mediaKey(c, svg) : "";
  el.dataset.mediaKey = k;
  const paint = (u) => { if (el.dataset.mediaKey !== k) return; el.style.backgroundImage = u ? "url('" + u + "')" : (fallbackCss || ""); if (onResult) onResult(!!u); };
  if (!c) return paint(null);
  const e = _media.get(k);
  if (mediaFresh(e)) return paint(e.url);
  paint(e && "url" in e ? e.url : mediaUrl(c, svg));   // the last answer, or (first sight) the preferred URL as before
  resolveMedia(c, svg).then(paint);
}
// HTML-string renderers: mark the element with mediaAttrs(...) and call hydrateMedia(container) after inserting it
export const mediaAttrs = (cid, svg, fallbackCss) => cleanCid(cid)
  ? ' data-media-cid="' + esc(cleanCid(cid)) + '" data-media-svg="' + (svg ? "1" : "") + '" data-media-alt="' + esc(fallbackCss || "") + '"' : "";
export function hydrateMedia(root){
  if (root && root.querySelectorAll) root.querySelectorAll("[data-media-cid]").forEach((el) => applyMedia(el, el.dataset.mediaCid, el.dataset.mediaSvg === "1", el.dataset.mediaAlt || ""));
}
export function mediaOf(version){
  if (!version || !version.config) return {};
  try {
    const m = JSON.parse(version.config)[MEDIA_KEY];
    if (m && typeof m === "object" && !Array.isArray(m))
      return { thumbnail: cleanCid(m.thumbnail), banner: cleanCid(m.banner),
               thumbnailSvg: !!m.thumbnailSvg, bannerSvg: !!m.bannerSvg };
  } catch(e){}
  return {};
}
// media of an app's DEFAULT (displayed) version - what the tile + detail show
export function appMedia(app){ const i = app && app.versions ? defaultIdx(app) : -1; return i >= 0 ? mediaOf(app.versions[i]) : {}; }
// drop the reserved `_media` key from a config string (for the deploy preview /
// the publish "add version" prefill - media is edited via its own pickers)
export function stripMedia(configStr){
  if (!configStr) return "";
  try {
    const o = JSON.parse(configStr);
    if (o && typeof o === "object" && MEDIA_KEY in o){ delete o[MEDIA_KEY]; return Object.keys(o).length ? JSON.stringify(o) : ""; }
  } catch(e){}
  return configStr;
}
// fold thumbnail/banner CIDs into a config string for publishing (JSON string,
// or "" when there's neither config nor media). thumbnailSvg/bannerSvg mark
// SVG media (the /add-image gateway's verdict) so renderers can request the
// svg content-type - see mediaUrl.
export function withMedia(configStr, thumbnail, banner, thumbnailSvg, bannerSvg){
  let o = {};
  if (configStr){ try { const p = JSON.parse(configStr); if (p && typeof p === "object" && !Array.isArray(p)) o = p; } catch(e){} }
  const m = {};
  if (cleanCid(thumbnail)){ m.thumbnail = thumbnail.trim(); if (thumbnailSvg) m.thumbnailSvg = true; }
  if (cleanCid(banner)){ m.banner = banner.trim(); if (bannerSvg) m.bannerSvg = true; }
  if (Object.keys(m).length) o[MEDIA_KEY] = m; else delete o[MEDIA_KEY];
  return Object.keys(o).length ? JSON.stringify(o) : "";
}

/* Resolve what the user typed into an `image.reference` the enclave understands.
   Humans type "[publisher/]slug:version"; we look it up in the on-chain catalog
   and hand the enclave `catalog://<appId>/<versionIndex>` — the on-chain RECORD
   of that version. The record (not the deployer) carries everything approval
   covered: wasm CID, config, ports, specs. CIDs are NOT app references - a CID
   names bytes, and several versions (with different approved configs) can share
   bytes. Returns {reference, label?, error?, pending?}. */
export const catalogRef = (appId, index) => "catalog://" + appId + "/" + index;
export const parseCatalogRef = (ref) => {
  const m = /^catalog:\/\/(0x[0-9a-fA-F]{64})\/(\d{1,9})$/.exec(String(ref || "").trim());
  return m ? { appId: m[1], index: +m[2] } : null;
};
export const REF_CACHE = {};    // friendly "slug:version" -> "catalog://<appId>/<idx>" (filled by Use-in-Deploy + lookups)
export const PORTS_CACHE = {};  // friendly "slug:version" -> that version's firewall CSV (defaults the deploy)
export const SPECS_CACHE = {};  // friendly "slug:version" -> the version's RAW specs {vramMb,gpuGflops,memMb,cpuGflops}.
                                // Raw on purpose: dial floors are minPctsOf(spec) AT READ TIME, so they always
                                // divide by the currently adopted fleet hardware - caching computed percents
                                // froze them against whatever spec was live at first resolve (the 91%-vs-92%
                                // unclaimable-deployment bug of 2026-07-14)
// `volumes` rides along with the hardware numbers because it is the same KIND
// of requirement: a model volume is attached to a box, not fetched, so which
// boxes can host this version depends on it exactly as it depends on the card.
// It comes off the version's approved config (a deployment's own config
// override - the dashboard's Models tab - replaces it for that deployment).
export const specOf = (v) => ({ vramMb: Number(v && v.vramMb) || 0, gpuGflops: Number(v && v.gpuGflops) || 0,
                                memMb: Number(v && v.memMb) || 0, cpuGflops: Number(v && v.cpuGflops) || 0,
                                volumes: volumesOfConfig(v && v.config),
                                gpuOptional: gpuOptionalOfConfig(v && v.config),
                                cpuFallback: cpuFallbackOfConfig(v && v.config) });
/* The publisher's declaration that this version's GPU axes are DESIRED, not
   required: the app starts without a card and would use one if given it. Read
   from the version config, like `volumes` — immutable per version, approved
   with it, and the only place that knows the difference (on-chain the axes are
   just numbers). An unparseable config declares nothing, which leaves the
   specs required: the runner computes the same, and a console floor below the
   runner's would sell a deployment nobody can claim. */
export function gpuOptionalOfConfig(cfg){
  if (!cfg) return false;
  try {
    const o = typeof cfg === "string" ? JSON.parse(cfg) : cfg;
    return !!(o && o.gpuOptional === true);
  } catch { return false; }
}
/* What the app needs from a NODE when it runs WITHOUT a card, for a version
   whose publisher sized that case: {memMb, cpuGflops}, from the version config
   beside `gpuOptional`. The four on-chain axes are ONE set and on a soft-GPU
   app they describe the card case - the guest's own memory, with the weights
   resident in its VRAM slice. On cores those weights move into node RAM beside
   it and the matmuls become the node's work, so the CPU floor is a different
   number; nothing in the record can say that, which is why this key exists.
   Mirrors the runner's cpuFallbackOfConfig exactly, bounds included: a console
   floor BELOW the runner's sells a deployment that box will not claim. */
export function cpuFallbackOfConfig(cfg){
  if (!cfg) return null;
  let f;
  try {
    const o = typeof cfg === "string" ? JSON.parse(cfg) : cfg;
    f = o && o.cpuFallback;
  } catch { return null; }       // unparseable declares nothing; the on-chain axes hold, as they do today
  if (!f || Array.isArray(f) || typeof f !== "object") return null;
  const num = (x, max) => { const n = Number(x); return Number.isFinite(n) && n >= 0 && n <= max ? n : 0; };
  const memMb = num(f.memMb, 1048576), cpuGflops = num(f.cpuGflops, 10000000);
  return (memMb || cpuGflops) ? { memMb, cpuGflops } : null;
}
export function volumesOfConfig(cfg){
  if (!cfg) return [];
  try {
    const o = typeof cfg === "string" ? JSON.parse(cfg) : cfg;
    return Array.isArray(o && o.volumes) ? [...new Set(o.volumes.map(String).filter(Boolean))] : [];
  } catch { return []; }        // an unparseable config constrains nothing; the runner still gates the claim
}
export const CONFIG_CACHE = {}; // friendly "slug:version" -> that VERSION's default/template config JSON (pre-fills the deploy form)
export const CONFIG_CID_CACHE = {}; // friendly "slug:version" -> the CID that config lives at ("" = it is inline, and CONFIG_CACHE already has it)
/* friendly "slug:version" -> the version's INLINE on-chain field, verbatim.
   Below rev 7 that IS the config; from rev 7 a large-config version keeps only
   the routing manifest there. Either way it is the one place the placement keys
   (wasi/threads/set/volumes/gpuOptional) are guaranteed to be readable WITHOUT
   a network fetch — so every gate that decides which box can run this app reads
   THIS, never CONFIG_CACHE. CONFIG_CACHE answers a different question ("what
   will the app receive"), and for a CID version it is empty until a fetch
   lands, which would silently turn a hard placement refusal into a pass. */
export const MANIFEST_CACHE = {};

/* A rev-7 version (and a SPLIT per-deployment override) keeps its config at an IPFS CID; this reads it for the dashboard's
   Config/Models panels (prefill + override diff) and the publish form's "add version" prefill. That text is EDITABLE and
   can be submitted again (a setConfig, a new version), so it is offered ONLY when its bytes are proven to be the CID's -
   from every gateway, the preferred one included; the enclave re-verifying at launch does not cover what an operator
   republishes. The CIDs come from public ledger records (the version's configCid, the deployment envelope's configCid)
   and name configs pinned on the public, unauthenticated read gateways; requests carry no credentials or tokens and no
   header but Accept. Secrets never travel here.
   The CID string is decoded (js/core/unixfs.js parseCid: CIDv0, CIDv1 base32/base58btc, sha2-256, raw or dag-pb) and the
   proof is the runtime's own (wasm/ipfs_fetch.py fetch_verified):
     raw     the response bytes hash to the digest;
     dag-pb  a CAR (?format=car&dag-scope=all) whose every block hashes to its CID, that holds the requested CID, and
             whose walk from it rebuilds the file - js/core/ipfs-car.js, any UnixFS layout the runtime runs. When a
             gateway answers but cannot serve that CAR, its plain file bytes are accepted only if they re-import to the
             same root under the pin paths' profile (artifactIdentity: 256 KiB raw leaves, balanced, 174 links).
   Bare bytes are never trusted because a CAR is unavailable. Verified text is cached for the page under the canonical
   CIDv1 (equivalent spellings share it). Gateways: ipfsReadGateways(), preferred first, each tried once per round (a dag-pb
   CID: CAR, then the profile re-import if the gateway was reachable), at most CONFIG_MAX_ATTEMPTS requests per round,
   each bounded by CONFIG_TRY_MS and its byte cap (raw/file CAT_MAX.configMax, CAR carCap(configMax) like the runtime),
   the round by CONFIG_ROUND_MS - transfer by the fetch signal, proof work by cooperative deadline checks (after each
   await, per CAR block hash, every 1024 walk visits, before accepting): a result finishing late is neither returned nor
   cached (a best-effort bound, not hard real time: one in-flight digest may complete); a failed round answers null for
   CONFIG_MISS_TTL_MS, then the next use retries. A malformed / unsupported CID is not requested at all.
   Returns the verified JSON text, or null (callers render null as "could not load", never as the inline manifest). */
export const CONFIG_TRY_MS = 10000, CONFIG_ROUND_MS = 30000, CONFIG_MAX_TRIES = 4, CONFIG_MAX_ATTEMPTS = 8, CONFIG_MISS_TTL_MS = 30 * 1000;
const _cfgCidCache = new Map();                       // canonical CIDv1 -> its verified JSON text
const _cfgPending = new Map(), _cfgMiss = new Map();  // canonical CIDv1 -> the round in flight; -> when its last round failed
// "raw" | "dag-pb" for a CID string this page can verify content against, else null
export function configCidForm(cid){ const p = parseCid(cid); return p ? (p.codec === 0x55 ? "raw" : "dag-pb") : null; }
// one request: { text } when proven, { reached } = the gateway answered HTTP at all
async function configFrom(url, mode, want, until){
  const ms = Math.min(CONFIG_TRY_MS, until - Date.now()); if (ms <= 0) return { reached: false };
  // the round's deadline, checked cooperatively after every await and inside the CAR hash/walk loops: past it the work
  // stops at the next check and nothing is accepted (an in-flight fetch is aborted by its signal; one block digest may finish)
  const late = () => { if (Date.now() >= until) throw new Error("config read deadline passed"); };
  let r;
  try {
    // A cached immutable gateway response may predate its CORS repair: fresh headers per read; verified text is memoized.
    r = await fetch(url, { cache: "reload", credentials: "omit", signal: AbortSignal.timeout(ms),
      ...(mode === "car" ? { headers: { accept: "application/vnd.ipld.car" } } : {}) });
  } catch(e){ return { reached: false }; }
  try {
    if (!r.ok){ await r.body?.cancel(); return { reached: true }; }
    late();
    const [{ boundedBytes }, car] = await Promise.all([import("./storage-plan.js"), import("./ipfs-car.js")]);
    late();
    const max = CAT_MAX.configMax, cap = mode === "car" ? car.carCap(max) : max;
    const body = await boundedBytes(r, cap);
    late();
    if (body.length > cap) return { reached: true };
    let bytes = null;
    if (mode === "raw"){ const d = new Uint8Array(await crypto.subtle.digest("SHA-256", body)); late(); if (hex(d) === hex(want.digest)) bytes = body; }
    else if (mode === "car") bytes = await car.verifyCar(want.bytes, body, max, { check: late });
    else { const id = await artifactIdentity(body); late(); if (id.cid === want.cid) bytes = body; }   // <= 1 MiB: <= 5 digests
    if (!bytes) return { reached: true };
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    JSON.parse(text);                       // must parse, or it is not a config
    late();                                 // last check: a proof that finished after the deadline is not accepted
    return { reached: true, text };
  } catch(e){ return { reached: true }; }
}
export function fetchConfigCid(cid){
  const want = parseCid(cid); if (!want) return Promise.resolve(null);
  const k = want.cid;
  if (_cfgCidCache.has(k)) return Promise.resolve(_cfgCidCache.get(k));
  if (_cfgPending.has(k)) return _cfgPending.get(k);
  if (Date.now() - (_cfgMiss.get(k) ?? -Infinity) < CONFIG_MISS_TTL_MS) return Promise.resolve(null);
  const round = (async () => {
    const until = Date.now() + CONFIG_ROUND_MS, path = encodeURIComponent(cid);
    let attempts = 0;
    for (const g of ipfsReadGateways().slice(0, CONFIG_MAX_TRIES)){
      const modes = want.codec === 0x55 ? [["raw", g + path]] : [["car", g + path + "?format=car&dag-scope=all"], ["file", g + path]];
      for (const [mode, url] of modes){
        if (++attempts > CONFIG_MAX_ATTEMPTS) break;
        const res = await configFrom(url, mode, want, until);
        if (res.text !== undefined && Date.now() < until){ _cfgCidCache.set(k, res.text); _cfgMiss.delete(k); return res.text; }
        if (!res.reached) break;            // unreachable / out of time: this gateway's other mode would fail the same way
      }
    }
    _cfgMiss.set(k, Date.now()); return null;
  })().finally(() => _cfgPending.delete(k));
  _cfgPending.set(k, round);
  return round;
}
/* Wallet-authorize a pin: sign enclave-upload:<sha256(bytes)>:<expiry>, trade it
   at the API for a one-time HMAC token bound to exactly these bytes. Shared by
   the wasm upload, the images, and both config pins (a publisher's version
   config and a deployer's per-deployment override). */
export async function signedUploadToken(bytes){
  // independent mode has no token service: uploads are wallet-signed per adapter (independentUpload below)
  if (INDEPENDENT.state !== "off") throw new EnclaveError("Uploads in independent mode go to the profile's storage adapters, never the upload-token API.", 0);
  if (!Enclave.address){ try { await connectWallet(); } catch(_){} }
  if (!Enclave.address || !Enclave.provider) throw new EnclaveError("Connect your wallet to upload; your signature authorizes the pin.", 0);
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
  const expiry = Math.floor(Date.now() / 1000) + 300;
  try {
    const signature = await personalSign(`enclave-upload:${hash}:${expiry}`);
    const r = await fetch(Enclave.base + "/apps/upload-token", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ hash, expiry, signature }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.token) throw new EnclaveError("upload authorization failed: " + (j.message || j.error || ("HTTP " + r.status)), 0);
    return { token: j.token, address: j.address, expiry };
  } catch(err){
    if (err && (err.code === 4001 || /reject|denied|declin|cancell/i.test(err.message || ""))) throw new EnclaveError("upload canceled: you declined the wallet signature.", 0);
    throw (err instanceof EnclaveError) ? err : new EnclaveError("upload authorization failed: " + (err.message || err), 0);
  }
}

export async function signedUploadHeaders(bytes,url){
  if (!IPFS_WALLET_AUDIENCE) {
    const {token,address,expiry}=await signedUploadToken(bytes);
    return {"x-upload-address":address,"x-upload-expiry":String(expiry),"x-upload-token":token};
  }
  if (!Enclave.address) await connectWallet();
  if (!Enclave.address || !Enclave.provider) throw new EnclaveError("Connect your wallet to authorize the upload.",0);
  return directUploadHeaders({audience:IPFS_WALLET_AUDIENCE,url,address:Enclave.address,bytes,signMessage:({message})=>personalSign(message)});
}

/* Pin a config too large to sit on-chain. Wallet-signed like the wasm and the
   images — the gateway re-parses the JSON, caps the size and pins; the CID then
   goes into a VERSION RECORD (catalog rev 7, immutable and approval-covered) or
   into a DEPLOYMENT's options envelope (the same split, deployment side).
   Enclaves re-fetch and hash-verify either one, so this pin is AVAILABILITY,
   never trust: a gateway that served different bytes would fail the check, not
   change what runs. */
/* Independent mode: publish bytes to EVERY adapter in the profile's storage
   plan (js/core/storage-plan.js) - local CID, one wallet signature per
   adapter, exact-byte readback, minimum verified copies. Returns the CID and
   the availability report. No profile storage plan = uploads are off. */
export async function independentUpload(bytes, kind, onProgress){
  if (INDEPENDENT.state !== "on") throw new EnclaveError("Confirm the independent profile in Settings before uploading.", 0);
  if (!STORAGE_PLAN) throw new EnclaveError("The independent profile names no storage adapters, so uploads are off here. Paste a CID you have pinned, or add a storage plan to the profile.", 0);
  if (!Enclave.address){ try { await connectWallet(); } catch(_){} }
  if (!Enclave.address || !Enclave.provider) throw new EnclaveError("Connect your wallet: each storage adapter needs your signature for this upload.", 0);
  const { publishToPlan } = await import("./storage-plan.js");
  try {
    const report = await publishToPlan(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), kind, STORAGE_PLAN,
      { address: Enclave.address.toLowerCase(), signMessage: ({ message }) => personalSign(message) }, { onProgress });
    return { cid: report.cid, report };
  } catch(err){
    if (err && (err.code === 4001 || /reject|denied|declin|cancell/i.test(err.message || ""))) throw new EnclaveError("upload canceled: you declined a wallet signature (nothing was uploaded).", 0);
    throw (err instanceof EnclaveError) ? Object.assign(err, { report: err.report }) : Object.assign(new EnclaveError(err.message || String(err), 0), { report: err && err.report });
  }
}

export async function putConfig(text){
  if (INDEPENDENT.state !== "off"){
    const buf = new TextEncoder().encode(text);
    if (buf.byteLength > CAT_MAX.configMax) throw new EnclaveError("config too long (≤ " + CAT_MAX.configMax + " bytes)", 0);
    return (await independentUpload(buf, "json")).cid;
  }
  if (!IPFS_JSON_UPLOAD_URL) throw new EnclaveError("Large configs aren’t configured here (no config pin gateway).", 0);
  const buf = new TextEncoder().encode(text);
  if (buf.byteLength > CAT_MAX.configMax)
    throw new EnclaveError("config too long (≤ " + CAT_MAX.configMax + " bytes)", 0);
  const headers = await signedUploadHeaders(buf, IPFS_JSON_UPLOAD_URL);
  const r = await fetch(IPFS_JSON_UPLOAD_URL, { method: "POST", headers: {
    "content-type": "application/json",
    ...headers,
  }, body: buf });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.cid) throw new EnclaveError("config pin rejected: " + (j.error || ("HTTP " + r.status)), 0);
  return j.cid;
}

export function looksFriendly(s){ return s.includes(":") && !s.startsWith("ipfs://"); }
// Resolve catalog releases subject to mandatory platform moderation.
export function resolveAppRef(input, opts = {}){
  input = (input || "").trim();
  if (!input) return { reference: "", error: "Pick an app: slug:version from the Apps catalog." };
  if (input.startsWith("ipfs://") || /^(baf[a-z0-9]{10,}|Qm[1-9A-HJ-NP-Za-km-z]{20,})$/.test(input))
    return { reference: input, error: "CIDs can’t deploy - a CID names bytes, not a version (several versions can share bytes and differ in approved config). Deploy a slug:version from the Apps catalog." };
  if (!looksFriendly(input)) return { reference: input, error: "Not a slug:version reference. Deploys come from the on-chain catalog - pick an app on the Apps page." };
  // Before catalog load, a cached reference can identify the release. Once
  // loaded, read its current metadata so the moderation notice stays current.
  if (REF_CACHE[input] && !STORE.loaded) return { reference: REF_CACHE[input], label: input };
  let pub = null, rest = input;
  const slash = input.indexOf("/");
  if (slash >= 0){ pub = input.slice(0, slash).trim().toLowerCase(); rest = input.slice(slash + 1); }
  const colon = rest.lastIndexOf(":");
  const slug = rest.slice(0, colon).trim(), version = rest.slice(colon + 1).trim();
  if (!STORE.loaded) return { reference: input, label: input, pending: true };   // catalog not read yet
  let apps = (STORE.apps || []).filter(a => a.slug === slug);
  if (pub) apps = apps.filter(a => a.publisher.toLowerCase() === pub);
  if (!apps.length) return { reference: input, label: input, error: "No catalog app '" + slug + "'" + (pub ? " by " + pub : "") + "." };
  if (apps.length > 1) return { reference: input, label: input, error: "Several publishers have '" + slug + "'; qualify it: <publisher>/" + slug + ":" + version };
  const vi = apps[0].versions.findIndex(x => x.version === version);
  const v = vi >= 0 ? apps[0].versions[vi] : null;
  if (!v) return { reference: input, label: input, error: "'" + slug + "' has no live version '" + version + "'." };
  // Selection may include pending development releases; execution checks visibility.
  const refusal = catalogAdmissionRefusal(apps[0], v, {forPrivate:opts.allowPending===true});
  if (refusal) return { reference: input, label: input, error: refusal };
  if (Number(v.approval) === APPROVAL.approved) REF_CACHE[input] = catalogRef(apps[0].appId, vi);
  PORTS_CACHE[input] = v.ports || "";
  SPECS_CACHE[input] = specOf(v);         // raw specs; floors are computed at read time
  // The version's default config template (store media stripped: _media never
  // reaches an app, and an override built from this prefill must not carry it).
  // On a rev-7 version `v.config` is only the on-chain manifest, so the real
  // config is fetched from its CID — otherwise a config editor would prefill
  // the manifest and treat the user's first keystroke as an override against
  // the wrong baseline. Best effort: a gateway that won't answer leaves the
  // box empty rather than wrong, and the ENCLAVE_CONFIG the app receives is
  // resolved in-enclave regardless of what this display path managed to read.
  MANIFEST_CACHE[input] = v.config || "";
  CONFIG_CACHE[input] = stripMedia(v.config || "");
  // On a rev-7 version the line above cached only the ON-CHAIN MANIFEST. The
  // real config is at a CID and reading it is a network fetch, so it is not
  // done here (this resolver is synchronous and called from render paths):
  // CONFIG_CID_CACHE records where to get it; a consumer that shows the
  // config fetches it from there. Until then the box shows the manifest-stripped empty
  // string rather than the manifest itself, which would read as the app's
  // config and make the user's first keystroke an override against a baseline
  // that was never the config.
  CONFIG_CID_CACHE[input] = v.configCid || "";
  if (v.configCid) CONFIG_CACHE[input] = "";
  return { reference: catalogRef(apps[0].appId, vi), label: input, mins: minPctsOf(SPECS_CACHE[input]),
           notice: catalogAdmissionNotice(apps[0], v) };
}

// A mid-session address-book change (js/core/addressbook.js emits
// `enclave:addresses` when APP_CATALOG_ADDRESS et al. are repointed on-chain)
// leaves our loaded catalog reading the OLD contract. Re-read against the new
// address so pages repaint - loadCatalog emits `enclave:catalog` on completion,
// which is exactly the repaint signal the Apps page already listens for.
on("enclave:addresses", ({ changed }) => {
  if (changed && changed.indexOf("APP_CATALOG_ADDRESS") !== -1){
    STORE.loaded = false; STORE.loading = false; STORE.owner = null;
    loadCatalog(true);
  }
});

// deployment rows resolve their catalog://<appId>/<idx> reference to the app
// record - from the live STORE or the localStorage catalog cache (either may
// be populated first, depending on which page the visitor landed on).
function appOfRef(cr){
  const lists = [];
  if (Array.isArray(STORE.apps) && STORE.apps.length) lists.push(STORE.apps);
  try {
    const raw = lsGet("enclave_catalog_" + APP_CATALOG_ADDRESS);
    if (raw){ const j = JSON.parse(raw); if (j && Array.isArray(j.apps)) lists.push(j.apps); }
  } catch(e){}
  for (const apps of lists) for (const a of apps)
    if (a && a.appId === cr.appId) return { app: a, v: (a.versions || [])[cr.index] || null };
  return null;
}
// the human app name (slug:version) for a deployment row. Legacy ipfs:// rows
// return null (the caller falls back to the truncated reference): a CID can
// belong to several versions with different approved configs - naming one
// would be a guess.
export function slugOfRef(ref){
  const cr = parseCatalogRef(ref);
  const hit = cr && appOfRef(cr);
  if (!hit) return null;
  return hit.app.slug + (hit.v && hit.v.version != null ? ":" + hit.v.version : "#" + cr.index);
}
// Resolve the exact deployed version from the same live/persisted catalog as
// its name and artwork. Unknown versions must not look like zero requirements.
export function specOfRef(ref){
  const cr = parseCatalogRef(ref);
  const hit = cr && appOfRef(cr);
  return hit?.v ? specOf(hit.v) : null;
}
// the publisher wallet behind a catalog:// reference - the payee a paid app's
// fee snapshot must name (create() copies it; runners verify it at claim)
export function publisherOfRef(ref){
  const cr = parseCatalogRef(ref);
  const hit = cr && appOfRef(cr);
  return hit ? hit.app.publisher : null;
}

/* ---- generated stand-in art ----
   For apps that ship no thumbnail (store tiles AND dashboard rows): an accent
   from the site palette keyed off `key`, the enclave corner brackets, and the
   app's initial. Inline SVG data URI - nothing to fetch, can never 404; the
   same key always yields the same art, so a deployment's chip matches its
   store tile. */
const ART_ACCENTS = ["#2fe6a8", "#8fa2ff", "#ff914d", "#57d7ff", "#c08aff", "#e66bd2"];
export function placeholderArt(key, initial){
  key = String(key || "?");
  let h = 5381; for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0;
  const c = ART_ACCENTS[h % ART_ACCENTS.length];
  const ch = esc(String(initial || "?").trim().charAt(0).toUpperCase() || "?");
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180">'
    + '<rect width="320" height="180" fill="#0b0f16"/>'
    + '<circle cx="160" cy="90" r="115" fill="' + c + '" opacity=".05"/>'
    + '<circle cx="160" cy="90" r="62" fill="' + c + '" opacity=".07"/>'
    + '<path d="M26 42v-18h18M294 42v-18h-18M26 138v18h18M294 138v18h-18" stroke="' + c + '" stroke-width="2" fill="none" opacity=".55"/>'
    + '<text x="160" y="92" text-anchor="middle" dominant-baseline="central" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="64" font-weight="600" fill="' + c + '" opacity=".9">' + ch + '</text>'
    + '</svg>';
  return "url('data:image/svg+xml," + encodeURIComponent(svg) + "')";
}
// CSS background-image for a deployment row's app chip: the referenced
// version's real thumbnail when the catalog knows it, else placeholder art
// keyed by the appId (so it matches the store tile). `label` seeds the art
// for legacy ipfs:// rows the catalog can't name.
export function artOfRef(ref, label){
  const cr = parseCatalogRef(ref);
  const hit = cr && appOfRef(cr);
  const m = hit && hit.v ? mediaOf(hit.v) : {};
  if (m.thumbnail) return "url('" + mediaUrl(m.thumbnail, m.thumbnailSvg) + "')";
  const name = (hit && (hit.app.name || hit.app.slug)) || String(label || "?");
  return placeholderArt((cr && cr.appId) || ref || label, name);
}
// the same chip's media-fallback attributes (see hydrateMedia): the thumbnail CID, and the placeholder for when no gateway delivers it
export function artAttrsOfRef(ref, label){
  const cr = parseCatalogRef(ref);
  const hit = cr && appOfRef(cr);
  const m = hit && hit.v ? mediaOf(hit.v) : {};
  if (!m.thumbnail) return "";
  const name = (hit && (hit.app.name || hit.app.slug)) || String(label || "?");
  return mediaAttrs(m.thumbnail, m.thumbnailSvg, placeholderArt((cr && cr.appId) || ref || label, name));
}
