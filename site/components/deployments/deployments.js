/* ============================================================
   <c-deployments> - the "My Apps" panel: the signed-in
   customer's deployments, each with status, spend, its app origin,
   its dedicated IPv6 (when the deployment declares tcp/udp
   ports), in-browser attestation verification, and suspend/resume
   (on-chain rows; the balance stays on the record across a
   suspend - legacy dep_ rows terminate instead).
   ONE panel for both kinds of customer: wallet rows come from the
   ledger/enclave list and act via wallet txs; passkey/card account
   rows come from the relay's account-scoped join (their credit
   vault owns them on-chain) and money/control ops are passkey-
   signed vault operations instead - same rows, same controls.
   Polls while signed in; follows `enclave:wallet` address edges
   (async session restore, account switches), `enclave:account`
   sign-in/out edges and `enclave:auth` sign-in edges.
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";
import { $$, esc, hlJson, fmtDur, statusCls, copyText, showToast, lsGet, lsSet } from "../../js/core/util.js";
import { APP_DOMAIN, DEPLOYMENTS_ADDRESS } from "../../js/core/config.js";
import { Enclave } from "../../js/core/api.js";
import { pad32, encUint, encCall, DEP_SEL, APPROVAL, depPrices6, rate6Of, depMaxGpuMilli, depGet, depSchemaRev, depFeeOf, depCapOf, depRefundableOf, catVersionFee, waitReceipt } from "../../js/core/chain.js";
import { authenticate, connectWallet, refreshWallet, saveSession, ensureBaseChain, sendTx } from "../../js/core/wallet.js";
import { slugOfRef, artOfRef, loadCatalog, parseCatalogRef, catalogRef, specOf, STORE } from "../../js/core/catalog.js";
import { vspecOf, verifyEnclaveInBrowser } from "../../js/core/verify.js";
import { runlog, paintLine } from "../../js/core/runlog.js";
import { payForRuntime } from "../../js/core/fund.js";
import { shareRates, minPctsOf, adoptServerSpec, leaseHostOf, moveTargetsFor, moveBlockReason, gpuUpgradeForMove, gpuDowngradeForMove, enclavePriceOf } from "../../js/core/pricing.js";

// The app's reachable URL. Through the gateway each deployment gets its OWN
// origin: a per-deployment subdomain (<id>.app.enclave.host, the base36 part of
// the deployment id; the "dep_" is dropped as redundant in this namespace), so
// an app can't touch the frontend's origin or another tenant's. Talking to an
// enclave directly falls back to the /x/<id> path. The deployment's own
// network.endpoint (the enclave's hostname) is only a last resort; it's the
// right value for attestation/registry, not for how the user reaches the app.
export function appEndpoint(d){
  if (!d || !d.id) return (d && d.network && d.network.endpoint) || "";
  const root = Enclave.base.replace(/\/v1\/?$/, "");
  if (/(^|\/\/)api\.(enclave|nan)\.host/i.test(root))
    return "https://" + appLabel(d.id) + "." + APP_DOMAIN;
  return root + "/x/" + d.id;                              // direct-to-enclave override
}
// Subdomain label for a deployment id. On-chain ids are bytes32: the label is
// the FIRST 8 HEX CHARS (32 bits - collisions are fantasy at any realistic
// deployment count; enclaves resolve the prefix to the unique match, and any
// longer prefix keeps working too). Legacy dep_ ids keep their base36 label.
export function appLabel(id){
  return /^0x[0-9a-f]{64}$/i.test(id) ? id.slice(2, 10).toLowerCase() : id.replace(/^dep_/, "");
}
// appEndpoint can derive from server-supplied fields (network.endpoint), so an
// endpoint may only become a navigable href if it is https: or a relative URL;
// anything else (javascript:, data:, …) is dropped so a hostile API can't smuggle
// a scheme into the "open ↗" link. "" means "not safe to link" (caller omits it).
function safeHref(u){
  const s = String(u || "");
  if (/^https:\/\//i.test(s)) return s;                 // absolute enclave/app origin
  if (/^\/(?!\/)/.test(s) || /^\.{1,2}\//.test(s)) return s;   // root- or dot-relative path
  return "";
}

/* ---- TLS-gated Open control ----
   An app origin's certificate is minted INSIDE the enclave (ACME dns-01),
   which takes a moment after the app reaches running - and every enclave
   release re-mints all of them (CVMs keep no disk). Until issuance the origin
   serves the self-signed fallback pair, so "open ↗" would land the user on a
   browser certificate warning. The control therefore starts as a DISABLED
   button with an amber OPEN padlock and only becomes the live link (closed
   jade padlock) once a probe from THIS browser completes a real handshake
   (_probeTls below) - the browser's own trust decision is the ground truth,
   not any server-side claim. */
const LOCK_OPEN = '<svg class="enc-lock" viewBox="0 0 24 24" width="11" height="11" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M9 11V7a3.5 3.5 0 0 1 6.9-.9"/></svg>';
const LOCK_SHUT = '<svg class="enc-lock" viewBox="0 0 24 24" width="11" height="11" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M9 11V7a3.5 3.5 0 0 1 7 0v4"/></svg>';
function openCtl(d, ep, tls){
  const href = safeHref(ep);
  if (!(d && d.public && (d.status || "") === "running" && href)) return "";
  return (tls && tls.state === "ok")
    ? '<a class="enc-open" data-tls="' + esc(d.id) + '" href="' + esc(href) + '/" target="_blank" rel="noopener" aria-label="Open app (new tab) - TLS certificate valid" title="TLS certificate valid - issued inside the enclave, verified by this browser">' + LOCK_SHUT + ' open ↗</a>'
    : '<button class="enc-open" data-tls="' + esc(d.id) + '" type="button" disabled aria-label="Open app - waiting for its TLS certificate" title="waiting for the app’s TLS certificate - minted inside the enclave, usually ready within a minute">' + LOCK_OPEN + ' open ↗</button>';
}

// Per-row SECRETS section (wallet-owned on-chain rows): rendered PERMANENTLY
// as its locked bar - id + the Unlock control - with the editor body absent
// until a reveal signature succeeds (_secretsWire). Values only ever exist in
// the DOM while unlocked; every repaint guard keys on .enc-sec-body so the
// poll never wipes an open editor and never stalls on the always-present bar.
function secretsSection(id){
  const label = appLabel(id);
  return '<div class="enc-sec" data-id="' + esc(id) + '">'
    +   '<div class="ap-attbar">'
    +     '<button class="btn btn-sm btn-primary es-toggle" type="button" aria-controls="esBody' + label + '" aria-expanded="false" title="Private env vars for this app (S3 keys, API tokens): stored on the relay - never on the public chain - and injected at app start by the enclave holding its lease. One wallet signature reveals them for editing">Unlock ↓</button>'
    +     'secrets · ' + esc(id)
    +   '</div>'
    +   '<div class="enc-sec-body" id="esBody' + label + '" hidden>'
    +     '<label for="esTa' + label + '">Private env vars, one KEY="value" per line (quotes optional; inside double quotes, escape &quot; and \\ with a backslash) - stored on the relay, never on-chain; the enclave injects them when the app starts</label>'
    +     '<textarea class="es-ta" id="esTa' + label + '" rows="5" spellcheck="false" autocomplete="off" placeholder="S3_ACCESS_KEY_ID=&quot;…&quot;&#10;S3_SECRET_ACCESS_KEY=&quot;…&quot;"></textarea>'
    +     '<span class="enc-sec-acts">'
    +       '<button class="btn btn-sm es-save" type="button" title="One wallet signature stores the textarea as this deployment’s complete secret set">Save</button>'
    +     '</span>'
    +   '</div>'
    +   '<div class="term enc-sec-status" role="status" aria-live="polite"></div>'
    + '</div>';
}

/* ---- per-row "Get the app" section ----
   A published version may name installable MOBILE builds in its on-chain
   config under "_mobile" ({android: <apk url>, ios: <store url>}) - the
   verify-first shell (enclave-apps/mobile-shell) wrapping this app, which
   checks the enclave's attestation ON THE PHONE before the app loads. The
   config is publisher-authored, so a link only renders from an allowlist of
   store/release hosts: the dashboard must never become an arbitrary-binary
   delivery vector. Grow the list deliberately, never to "any https". */
const MOBILE_KEY = "_mobile";
const MOBILE_HOSTS = /^https:\/\/(github\.com\/[^?#\s]+\/releases\/download\/|play\.google\.com\/|apps\.apple\.com\/|testflight\.apple\.com\/)/i;
export function mobileLinksOf(ref){
  try {
    const cr = parseCatalogRef(ref);
    const app = cr && STORE.byId[cr.appId];
    const ver = app && app.versions ? app.versions[cr.index] : null;
    const m = ver ? (JSON.parse(ver.config || "{}") || {})[MOBILE_KEY] : null;
    if (!m || typeof m !== "object") return null;
    const pick = (u) => (typeof u === "string" && MOBILE_HOSTS.test(u) && safeHref(u)) || "";
    const android = pick(m.android), ios = pick(m.ios);
    return android || ios ? { android, ios } : null;
  } catch { return null; }
}
// The GENERIC shell: one signed APK any *.app.enclave.host deployment can
// pair into via the deep link this section mints (the shell stores the
// target, verifies its attestation on the phone, then loads it). Rows whose
// version publishes dedicated builds (_mobile) offer those instead.
const GENERIC_APK = "https://github.com/EnclaveHost/enclave-apps/releases/download/mobile-enclave/enclave.apk";

// PREPACKAGED per-deployment APKs: CI snapshots the app's whole UI off its
// live origin into a signed APK pre-linked to that deployment (zero
// downloads at open; only API calls touch the network), and commits the
// list of built labels to mobile-index.json. Rows on that list offer the
// direct install; the CI cron re-snapshots them. A row not yet on the list
// falls back to the pairing flow below - dispatching the mobile-shell
// workflow with the deployment id is what adds it.
const DEP_APK_BASE = "https://github.com/EnclaveHost/enclave-apps/releases/download/mobile-dep-";
const DEP_INDEX_URL = "https://raw.githubusercontent.com/EnclaveHost/enclave-apps/main/mobile-index.json";
let DEP_APKS = null;    // Set of 8-hex labels once the index answers
fetch(DEP_INDEX_URL)
  .then((r) => (r.ok ? r.json() : null))
  .then((j) => { DEP_APKS = new Set(((j && j.deployments) || []).map(String)); })
  .catch(() => { DEP_APKS = new Set(); });
export function mobilePairLink(d, ep){
  try {
    const host = new URL(String(ep)).host;
    if (!/^[0-9a-z-]+\.app\.enclave\.host$/i.test(host)) return "";   // custom domains pair via a branded build instead
    const name = (d.app && d.app.slug) || appLabel(d.id);
    return "enclave://open?u=" + encodeURIComponent("https://" + host)
         + "&d=" + encodeURIComponent(d.id) + "&n=" + encodeURIComponent(name);
  } catch { return ""; }
}
function mobileSection(d, ep){
  const links = mobileLinksOf(d.image && d.image.reference);
  const label = appLabel(d.id);
  const running = d.public && (d.status || "") === "running";
  const depApk = !links && running && DEP_APKS && DEP_APKS.has(label)
    ? DEP_APK_BASE + label + "/" + label + ".apk" : "";
  const pair = !links && !depApk && running ? mobilePairLink(d, ep) : "";
  if (!links && !depApk && !pair) return "";
  const name = (d.app && d.app.slug) || label;
  const body = links
    ? (links.android
        ? '<a class="btn btn-sm btn-primary" href="' + esc(links.android) + '" target="_blank" rel="noopener" title="Signed APK - Android asks you to allow installs from your browser the first time">Android · APK ↓</a>'
        : '')
      + (links.ios
        ? '<a class="btn btn-sm btn-primary" href="' + esc(links.ios) + '" target="_blank" rel="noopener">iPhone ↗</a>'
        : '<span class="em-note">iPhone: open the app in Safari, then Share → Add to Home Screen.</span>')
    : depApk
    ? '<a class="btn btn-sm btn-primary" href="' + esc(depApk) + '" target="_blank" rel="noopener" title="Signed APK with the app packaged inside - Android asks you to allow installs from your browser the first time">Android · install ' + esc(name) + ' ↓</a>'
      + '<span class="em-note">The app’s UI ships inside the APK: it opens instantly, works offline, and only its API calls reach the enclave. Rebuilt automatically when the app updates. iPhone: open the app in Safari, then Share → Add to Home Screen.</span>'
    : '<a class="btn btn-sm btn-primary" href="' + esc(GENERIC_APK) + '" target="_blank" rel="noopener" title="One signed APK for any Enclave app - Android asks you to allow installs from your browser the first time">1 · Get the Enclave app ↓</a>'
      + '<a class="btn btn-sm" href="' + esc(pair) + '" title="Opens the installed Enclave app and pairs it to this deployment - it verifies the enclave on your phone, then loads the app">2 · Open this app in it</a>'
      + '<button class="btn btn-sm em-copy" type="button" data-copy="' + esc(pair) + '" title="Copy the pairing link (e.g. to send it to your phone)">copy link</button>'
      + '<span class="em-note">Do both steps ON YOUR PHONE (this page works there too). iPhone: open the app in Safari, then Share → Add to Home Screen.</span>';
  return '<div class="enc-mob">'
    +   '<div class="ap-attbar">'
    +     '<button class="btn btn-sm em-toggle" type="button" aria-controls="emBody' + label + '" aria-expanded="false" title="Install this app on a phone - the mobile build verifies the enclave on the device before the app loads">Get the app ↓</button>'
    +     'mobile app · ' + esc(d.id)
    +   '</div>'
    +   '<div class="enc-mob-body" id="emBody' + label + '" hidden>'
    +     body
    +     '<span class="em-note">The mobile build re-checks the enclave’s attestation on your device before the app loads.</span>'
    +   '</div>'
    + '</div>';
}

// Per-row Domains: attach a hostname you own and the app serves on it, with a
// certificate minted inside the enclave. Collapsed to a bar until opened -
// listing needs a wallet signature (the relay proves ownership against the
// ledger), so nothing is fetched until the customer asks for it.
function domainsSection(id){
  const label = appLabel(id);
  return '<div class="enc-dom" data-id="' + esc(id) + '">'
    +   '<div class="ap-attbar">'
    +     '<button class="btn btn-sm ed-toggle" type="button" aria-controls="edBody' + label + '" aria-expanded="false" title="Serve this app on a domain you own, with a certificate minted inside the enclave">Domains ↓</button>'
    +     'domains · ' + esc(id)
    +   '</div>'
    +   '<div class="enc-dom-body" id="edBody' + label + '" hidden>'
    +     '<div class="ed-list"></div>'
    +     '<div class="ed-add">'
    +       '<label class="sr-only" for="edIn' + label + '">Hostname to attach</label>'
    +       '<input class="ed-in" id="edIn' + label + '" type="text" inputmode="url" spellcheck="false" autocomplete="off" placeholder="shop.example.com">'
    +       '<button class="btn btn-sm btn-primary ed-add-btn" type="button" title="One wallet signature attaches this hostname">Attach</button>'
    +     '</div>'
    +   '</div>'
    +   '<div class="term enc-dom-status" role="status" aria-live="polite"></div>'
    + '</div>';
}

// One attached domain: its state, the records to create, and what to fix.
// Every status carries an action — a customer looking at this should never
// have to guess what the platform is waiting for.
const DOM_STATE = {
  pending_dns: { cls: "warn",  dot: "◌", text: "waiting for DNS" },
  verified:    { cls: "info",  dot: "◍", text: "verified · certificate on the way" },
  active:      { cls: "ok",    dot: "●", text: "live" },
  failed:      { cls: "warn",  dot: "○", text: "not verified" },
};
function domainRow(d){
  const s = DOM_STATE[d.status] || DOM_STATE.failed;
  const rec = (r, hint) => '<div class="ed-rec">'
    + '<span class="ed-rt">' + esc(r.type) + '</span>'
    + '<code class="ed-rn" title="record name">' + esc(r.name) + '</code>'
    + '<code class="ed-rv" title="record value">' + esc(r.value) + '</code>'
    + '<button class="btn btn-sm ed-copy" type="button" data-copy="' + esc(r.value) + '" title="Copy the value">copy</button>'
    + (hint ? '<span class="ed-hint">' + esc(hint) + '</span>' : '')
    + '</div>';
  const live = d.status === "active";
  return '<div class="ed-row" data-host="' + esc(d.hostname) + '">'
    + '<div class="ed-head">'
    +   '<span class="ed-dot ' + s.cls + '" aria-hidden="true">' + s.dot + '</span>'
    +   (live ? '<a class="ed-host" href="https://' + esc(d.hostname) + '/" target="_blank" rel="noopener">' + esc(d.hostname) + ' ↗</a>'
            : '<span class="ed-host">' + esc(d.hostname) + '</span>')
    +   '<span class="ed-state ' + s.cls + '">' + esc(s.text) + '</span>'
    +   '<span class="ed-acts">'
    +     (live ? '' : '<button class="btn btn-sm ed-check" type="button" title="Check the DNS records now (they are re-checked automatically every few minutes)">check now</button>')
    +     '<button class="btn btn-sm ed-del" type="button" title="Detach this hostname: routing stops and the certificate is dropped">detach</button>'
    +   '</span>'
    + '</div>'
    // Records stay visible while live: people move DNS providers, and the
    // delegation CNAME must survive the move or renewal quietly stops working.
    + '<div class="ed-recs">'
    +   rec(d.records.routing, d.hostname.split(".").length <= 2 ? "apex: use CNAME flattening, or A/AAAA to our edge" : "")
    +   rec(d.records.challenge, "proves you own the name")
    +   rec(d.records.acme, "keeps the certificate renewing — leave it in place")
    + '</div>'
    + (d.lastError ? '<div class="ed-err warn">⚠ ' + esc(d.lastError) + '</div>' : '')
    + (d.caaWarning ? '<div class="ed-err warn">⚠ ' + esc(d.caaWarning) + '</div>' : '')
    + (d.certificate && d.certificate.error
        ? '<div class="ed-err warn">⚠ certificate: ' + esc(d.certificate.error) + '</div>' : '')
    + (live && d.certificate && d.certificate.ca
        ? '<div class="ed-err dimln">// certificate issued by ' + esc(d.certificate.ca) + ', minted inside the enclave</div>' : '')
    + '</div>';
}

function shortImg(s){ if (!s) return ""; return s.length > 44 ? s.slice(0, 42) + "…" : s; }
// Status buckets for the filter bar: coarse groups beat ten raw statuses.
// Unknown/new statuses land in "ended" rather than vanishing.
const FILTER_KEY = "enclave_dash_filters";
const BUCKETS = ["running", "queued", "ended", "failed"];
// Decline reasons that no amount of waiting resolves (mirrors the enclave's
// claim-gauntlet wording; deploy.js's watchClaimAndRun keys on the same set)
const WHY_TERMINAL = /below the app|minimum shares|yanked|not .{0,12}approved|rejected|delisted|unlisted|configcid|retired|deactivated/i;
function bucketOf(st){
  st = String(st || "").toLowerCase();
  if (st === "running") return "running";
  // the "queued" bucket matches the ledger's own vocabulary: everything on
  // its way (queued/claimed/provisioning/awaiting_payment/...) but not over —
  // unfunded (drained; resumes on top-up) waits here too, it just isn't "queued"
  // "unknown" = an account row the relay's ledger cache hasn't caught up to
  // yet (fresh deploy) - it's on its way, not over
  if (["provisioning", "queued", "pending", "claiming", "claimed", "starting", "created", "awaiting_payment", "unfunded", "unknown"].indexOf(st) !== -1) return "queued";
  if (["failed", "error"].indexOf(st) !== -1) return "failed";
  return "ended";   // stopped, stopping, terminated, expired, …
}
// Who can act on a row: "wallet" rows are owned by the connected wallet
// (on-chain txs + enclave-session reads); "vault" rows are owned by the
// account's credit vault (money/control ops are passkey-signed through the
// relay); "order" rows are legacy provisioner-owned (read-only here).
function ctlOf(d){ return d && d.viaVault ? "vault" : (d && d.orderId ? "order" : "wallet"); }
function encTier(d){
  const r = d.resources || {};
  const g = r.gpuShare || 0, c = r.cpuShare != null ? r.cpuShare : (r.share || 0);
  if (g > 0) return Math.round(g * 100) + "% GPU · " + Math.round(c * 100) + "% CPU";
  return c ? (Math.round(c * 100) + "% CPU") : "CPU";
}
// A deployment's DEDICATED IPv6 (per-deployment addressing): declared tcp/udp
// ports are served at [address]:<logical port> via the relays, and outbound
// connections (dedicated-IP egress) leave from the same address. Rendered as
// its own copyable row when the API surfaces network.address - which it also
// does for port-less deployments when egress is on (outbound-only address).
function depIp6Row(d){
  const net = d.network || {};
  if (!net.address) return "";
  const tcp = (net.tcp && net.tcp.ports) || [];
  const udp = (net.udp && net.udp.ports) || [];
  const ports = (tcp.length ? " · tcp " + tcp.join(",") : "") + (udp.length ? " · udp " + udp.join(",") : "");
  const title = (tcp.length || udp.length)
    ? "dedicated IPv6 - this deployment's own address: tcp/udp ports are served on it at their real port numbers" + (net.egress ? ", and its outbound traffic egresses from it" : "")
    : "dedicated IPv6 - this deployment's own address: its outbound traffic egresses from it (no inbound tcp/udp ports declared)";
  return '<button class="enc-ep" data-ep="' + esc(net.address) + '" title="' + esc(title) + '">'
    + 'ip6 [' + esc(net.address) + ']' + esc(ports) + ((tcp.length || udp.length) ? '' : ' · egress only') + ' ⧉</button>';
}

class Deployments extends EnclaveElement {
  static templateUrl = new URL("./deployments.html", import.meta.url);

  renderedCallback() {
    if (this._wired) return;
    this._wired = true;
    this._page = 0;                            // current deployments page (5 per page)
    this._logPolls = {};                       // open Output panels' log timers, by id
    this._strips = new Map();                  // live-deploy strips, keyed by run record
    this.querySelector(".enc-refresh").addEventListener("click", () => this.refresh({ spinner: true }));
    // status filter: a single-select seg + search, the store toolbar's
    // grammar (persisted; a legacy stored checkbox-set falls back to All)
    let saved = null; try { saved = JSON.parse(lsGet(FILTER_KEY) || "null"); } catch (e) {}
    this._filter = (typeof saved === "string" && ("all" === saved || BUCKETS.indexOf(saved) !== -1)) ? saved : "all";
    $$(".enc-segs button", this).forEach(b => {
      b.classList.toggle("on", b.dataset.bucket === this._filter);
      b.setAttribute("aria-pressed", String(b.dataset.bucket === this._filter));
      b.addEventListener("click", () => {
        this._filter = b.dataset.bucket;
        lsSet(FILTER_KEY, JSON.stringify(this._filter));
        $$(".enc-segs button", this).forEach(x => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", String(x === b)); });
        this._page = 0;                        // a new filter starts at the first page
        this._renderRows(this._list || []);
      });
    });
    const q = this.querySelector(".enc-search");
    if (q) q.addEventListener("input", () => { this._q = q.value.trim().toLowerCase(); this._page = 0; this._renderRows(this._list || []); });
    // document-level listeners must be removable: the soft-nav router mounts a
    // fresh instance per visit, and detached ones must not keep refreshing.
    // A sign-in mid-view (the lazy log/attestation unlock) must NOT clobber
    // the open panel the user just unlocked - skip the repaint, the poll
    // catches up once the panel closes.
    this._onAuth = (e) => {
      if (Enclave.address && this.querySelector(".enc-att:not([hidden]), .enc-out:not([hidden]), .enc-fund:not([hidden]), .enc-upg:not([hidden]), .enc-move:not([hidden]), .enc-waf:not([hidden]), .enc-sec-body:not([hidden]), .enc-dom-body:not([hidden])")) return;
      this.refresh({ spinner: !!(e.detail && e.detail.spinner) });
    };
    document.addEventListener("enclave:auth", this._onAuth);
    // the wallet session restores ASYNC after a hard reload (provider
    // discovery can take seconds), so the panel mounts and paints the connect
    // wall FIRST - and an address-only session (the lazy-SIWE norm) never
    // fires enclave:auth. Follow the wallet edges instead: whenever the
    // effective address differs from what the last paint used (restore,
    // connect, account switch, disconnect), re-list.
    this._onWallet = () => { if (Enclave.address !== this._paintedFor) this.refresh(); };
    document.addEventListener("enclave:wallet", this._onWallet);
    // passkey/card sign-in and sign-out edges: the same rule as the wallet edge
    this._onAcct = () => { if (Enclave.accountAuthed() !== this._paintedAcct) this.refresh(); };
    document.addEventListener("enclave:account", this._onAcct);
    this._onLog = (e) => this._onRunlog(e.detail || {});
    document.addEventListener("enclave:runlog", this._onLog);
    // deploys in flight (soft-nav away and back): rejoin every live run.
    // After a HARD reload none are live - but some may sit interrupted in the
    // persisted log (the refresh killed their deploy flows mid-stream); hand
    // them ALL to deploy.js to re-read the ledger and keep narrating, each
    // into its own run (a fleet resumes as a fleet).
    runlog.live().forEach(r => this._strip(r));
    const cuts = runlog.interrupted();
    if (cuts.length) import("../../js/pages/deploy.js")
      .then(m => cuts.forEach(r => m.resumeDeployWatch(r))).catch(() => {});
    // rows show their app's cover art, resolved from the catalog - kick the
    // read here too (no-op when loaded; the localStorage copy paints first)
    // and repaint once the live catalog lands, unless a panel is open (same
    // clobber rule as _onAuth; the regular poll catches up after it closes).
    loadCatalog();
    this._onCat = () => {
      if (this.querySelector(".enc-att:not([hidden]), .enc-out:not([hidden]), .enc-fund:not([hidden]), .enc-upg:not([hidden]), .enc-move:not([hidden]), .enc-waf:not([hidden]), .enc-sec-body:not([hidden]), .enc-dom-body:not([hidden])")) return;
      if (this._list) this._renderRows(this._list);
    };
    document.addEventListener("enclave:catalog", this._onCat);
    this.refresh();
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this._stopPoll();
    Object.keys(this._logPolls || {}).forEach(id => this._stopLogPoll(id));
    if (this._onAuth) document.removeEventListener("enclave:auth", this._onAuth);
    if (this._onWallet) document.removeEventListener("enclave:wallet", this._onWallet);
    if (this._onAcct) document.removeEventListener("enclave:account", this._onAcct);
    if (this._onLog) document.removeEventListener("enclave:runlog", this._onLog);
    if (this._onCat) document.removeEventListener("enclave:catalog", this._onCat);
    this._wired = false; this._onAuth = null; this._onWallet = null; this._onAcct = null; this._onLog = null; this._onCat = null;
  }

  /* ---- live-deploy strips: one per run streaming with no row to live in ---- */
  _strip(run, create) {
    let s = this._strips.get(run);
    if (s || create === false) return s || null;
    const wrap = this.querySelector(".enc-lives"); if (!wrap) return null;
    s = document.createElement("div");
    s.className = "enc-live";
    s.innerHTML = '<div class="enc-live-bar"><span class="elb-k">deploying</span><span class="enc-live-lbl"></span><button class="enc-live-x" type="button" title="dismiss" aria-label="Dismiss">✕</button></div>'
      + '<div class="term enc-live-out" role="status" aria-live="polite"></div>';
    s.querySelector(".enc-live-lbl").textContent = run.id || run.label || "";
    s.querySelector(".enc-live-x").addEventListener("click", () => { this._strips.delete(run); s.remove(); });
    const out = s.querySelector(".enc-live-out");
    run.lines.forEach(l => paintLine(out, l[0], l[1]));   // rejoined/resumed runs replay their history
    wrap.appendChild(s);
    this._strips.set(run, s);
    return s;
  }
  /* a strip yields to its row the moment one exists (the row's Output panel
     carries the history from there); an UNCLAIMED deployment has no row (rows
     come from the enclave API), so its strip stays until claimed or dismissed */
  _retireStrip(run) {
    const s = this._strips.get(run);
    if (s && run.done && run.id && this.querySelector('.enc-outbtn[data-id="' + run.id + '"]')) {
      this._strips.delete(run); s.remove();
    }
  }
  _onRunlog(d) {
    if (d.type === "start") this._strip(d.run);
    else if (d.type === "id") {
      const s = this._strip(d.run, false);
      const lbl = s && s.querySelector(".enc-live-lbl"); if (lbl) lbl.textContent = d.run.id;
    }
    else if (d.type === "line") {
      const s = this._strip(d.run, false);               // a dismissed strip stays dismissed
      if (s) paintLine(s.querySelector(".enc-live-out"), d.cls, d.txt);
      // a row's open Output panel for this deployment follows the narrative too
      if (d.run.id) { const nar = this._openNar(d.run.id); if (nar) paintLine(nar.box, d.cls, d.txt, nar.scroller); }
    }
    else if (d.type === "end") this._retireStrip(d.run);
    else if (d.type === "clear") {                        // sign-out purged the run log
      this._strips.forEach((s) => s.remove());
      this._strips.clear();
    }
  }
  _openNar(id) {
    const row = this.querySelector('.enc-out[data-id="' + id + '"]:not([hidden])');
    if (!row) return null;
    return { box: row.querySelector(".enc-out-nar"), scroller: row.querySelector(".enc-out-term") };
  }

  async refresh(opts) {
    opts = opts || {};
    const body = this.querySelector(".enc-body");
    if (!body) return;
    this._paintedFor = Enclave.address;             // what this paint reflects (see _onWallet)
    this._paintedAcct = Enclave.accountAuthed();    // …and the account edge (_onAcct)
    const hideBar = () => { const tb = this.querySelector(".enc-toolbar"); if (tb) tb.hidden = true; };
    if (!Enclave.address && !this._paintedAcct){
      this._stopPoll(); hideBar();
      const pager = this.querySelector(".enc-pager"); if (pager){ pager.hidden = true; pager.innerHTML = ""; }
      body.innerHTML = '<div class="enc-empty">Sign in (above) to see your enclaves.</div>'; return;
    }
    // NO sign-in wall: a connected wallet is enough - the list is public
    // ledger data, scoped by address (api.js adds ?owner= when tokenless);
    // a session only enriches rows with the enclaves' live view
    if (!body.querySelector(".enc-row") || opts.spinner) body.innerHTML = '<div class="loading" role="status">loading your enclaves…</div>';
    try {
      // fire-and-forget: the row art and the mobile section resolve versions
      // through the catalog STORE; a cold cache fills while the first paint
      // proceeds and the poll repaints with it (loadCatalog self-dedupes)
      loadCatalog().catch(() => null);
      const list = [];
      if (Enclave.address){
        const res = await Enclave.listDeployments();
        list.push(...(Array.isArray(res) ? res : ((res && (res.deployments || res.items || res.data)) || [])));
      }
      // passkey/card accounts: rows owned by the account's credit vault (plus
      // legacy provisioned orders) via the relay's account-scoped ledger join -
      // the SAME row shape, so both kinds of customer share this panel
      if (this._paintedAcct){
        try {
          const seen = new Set(list.map((d) => String(d.id).toLowerCase()));
          for (const d of (await Enclave.accountDeployments()).deployments || []){
            if (!d.id) d.id = d.deploymentId;
            if (d.id && !seen.has(String(d.id).toLowerCase())) list.push(d);
          }
        } catch(e){ if (!Enclave.address) throw e; }   // wallet rows still serve
      }
      const tb = this.querySelector(".enc-toolbar"); if (tb) tb.hidden = false;   // refresh + Deploy CTA live here now
      this._renderRows(list, opts.highlight);
      this._startPoll();
    } catch(e){
      // an expired/refused session isn't a wall anymore: drop the token and
      // re-list scoped by the connected address (the public ledger view)
      if (e.status === 401 && Enclave.token){ Enclave.token = null; Enclave.tokenBase = null; saveSession(); refreshWallet(); return this.refresh(opts); }
      body.innerHTML = '<div class="enc-empty">couldn’t load enclaves: ' + esc(e.message || String(e)) + '</div>';
    }
  }

  _renderRows(list, highlight) {
    const body = this.querySelector(".enc-body");
    list = (list || []).slice().sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    this._list = list;
    const counts = { all: list.length, running: 0, queued: 0, ended: 0, failed: 0 };
    list.forEach(d => { counts[bucketOf(d.status)]++; });
    $$(".enc-segs button", this).forEach(b => { const n = b.querySelector("b"); if (n) n.textContent = String(counts[b.dataset.bucket] || 0); });
    let shown = this._filter === "all" ? list.slice() : list.filter(d => bucketOf(d.status) === this._filter);
    if (this._q) shown = shown.filter(d =>
      (d.id + " " + ((d.image && d.image.reference) || "") + " " + (d.status || "") + " " + (d.enclave || "")).toLowerCase().includes(this._q));
    const pager = this.querySelector(".enc-pager");
    const clearPager = () => { if (pager){ pager.hidden = true; pager.innerHTML = ""; } };
    if (!list.length){ body.innerHTML = '<div class="enc-empty">No apps yet. <a href="apps">Deploy one →</a></div>'; clearPager(); return; }
    if (!shown.length){ body.innerHTML = '<div class="enc-empty">Nothing here - pick another status tab or clear the search.</div>'; clearPager(); return; }
    // paginate: 5 rows per page (the list grows unbounded; keep the panel short).
    // The page persists across the 10s poll; a just-deployed (highlighted) row
    // pulls the view to whichever page it lands on; clamp when the list shrinks.
    const PER_PAGE = 5;
    const pages = Math.max(1, Math.ceil(shown.length / PER_PAGE));
    if (highlight){ const hi = shown.findIndex(d => d.id === highlight); if (hi >= 0) this._page = Math.floor(hi / PER_PAGE); }
    if (this._page >= pages) this._page = pages - 1;
    if (!(this._page >= 0)) this._page = 0;
    const pageRows = shown.slice(this._page * PER_PAGE, this._page * PER_PAGE + PER_PAGE);
    body.innerHTML = pageRows.map(d => {
      const ep = appEndpoint(d), st = d.status || "–";
      // vault rows speak in dollars (account customers never see token names);
      // wallet rows keep the explicit USDC wording. Paid AND spent: both row
      // sources (supervisor live view, relay ledger view) carry spentUsdc.
      const ctl = ctlOf(d);
      const bud = (d.paidUsdc != null)
        ? ((ctl === "wallet" ? esc(d.paidUsdc) + " USDC paid" : "$" + esc(d.paidUsdc) + " paid")
           + (d.spentUsdc != null ? " · " + (ctl === "wallet" ? esc(d.spentUsdc) : "$" + esc(d.spentUsdc)) + " spent" : "")
           + (d.timeRemainingSec > 0 ? " · " + esc(fmtDur(d.timeRemainingSec)) + " left" : "")
           + (d.paused ? " · ⏸ time frozen (" + esc(d.pauseReason || "outage") + ", resumes when service is restored)" : ""))
        : "–";
      const onchain = /^0x[0-9a-f]{64}$/i.test(d.id || "");
      // on-chain rows without a live runner stay actionable: queued/claimed
      // work can be topped up, and awaiting_payment/unfunded are Top up's
      // whole point (unfunded = drained; a top-up is what un-sticks it).
      // "expired" is the ex-runner's word for that same drained state (its
      // record shadows the ledger's "unfunded" while signed in): the record
      // is still active on the ledger, so it takes top-ups and the claim
      // sweep re-adopts it the moment the balance covers the rate again.
      const live = ["running", "provisioning", "queued", "pending", "claiming", "claimed", "awaiting_payment", "unfunded"].indexOf(st) !== -1
        || (onchain && st === "expired");
      // on-chain rows are WORK ITEMS: setActive(false) suspends (the remaining
      // balance stays on the record) and setActive(true) re-queues it, so a
      // stopped/terminated on-chain row is resumable, not gone. "stopped" is
      // the ledger's word for it; "terminated" is the ex-runner's own record
      // of the same suspend (it shadows the ledger row while signed in).
      // "expired" resumes too - watchdog/consolidation expiries keep a spendable
      // balance and only need the re-queue nudge (_resume skips the setActive
      // tx when the ledger record never went inactive; a drained one gets told
      // to Top up instead of a relaunch promise that can't happen).
      // Legacy dep_ instances have no ledger record to reactivate: theirs
      // stays Terminate, and ended legacy rows offer nothing.
      const resumable = onchain && (st === "stopped" || st === "terminated" || st === "expired");
      // the row's app identity, shared by the cover-art chip and the meta line
      const appLbl = (d.app && d.app.slug ? d.app.slug + ":" + d.app.version : null)
        || (d.image && d.image.reference ? slugOfRef(d.image.reference) || shortImg(d.image.reference) : null);
      const art = artOfRef(d.image && d.image.reference, appLbl || d.id);
      return '<div class="enc-row' + (highlight && d.id === highlight ? " enc-new" : "") + '">' +
        '<div class="enc-main">' +
          '<span class="enc-thumb" style="background-image:' + art + '" aria-hidden="true"></span>' +
          '<span class="ap-badge ' + statusCls(st) + '">' + esc(st) + '</span>' +
          '<span class="ap-badge ' + (d.public ? 'ep-public' : 'ep-private') + '" title="' + (d.public ? 'anyone can reach the app endpoint' : 'only your wallet token can reach the app') + '">' + (d.public ? 'public' : 'private') + '</span>' +
          '<span class="ap-badge info ep-waf" data-wafb="' + esc(d.id) + '" hidden>protected</span>' +
          '<button class="enc-id" data-copy="' + esc(d.id) + '">' + esc(d.id) + ' ⧉</button>' +
          '<span class="enc-br" aria-hidden="true"></span>' +
          '<span class="enc-meta">' + esc(encTier(d)) + (appLbl ? ' · <span class="dim">' + esc(appLbl) + '</span>' : '')
            // which box serves it (relay stamps `enclave` on live-hosted and
            // lease-held rows alike; absent while queued/stopped - nothing runs it)
            + (d.enclave ? ' · <span class="dim enc-host" title="the enclave this app runs on">on ' + esc(d.enclave) + '</span>' : '') + '</span>' +
          '<span class="enc-spend">' + bud + '</span>' +
          '<span class="enc-acts">' +
            '<button class="btn btn-sm enc-outbtn" data-id="' + esc(d.id) + '" aria-expanded="false">Output</button>' +
            (live && ctl !== "order" ? '<button class="btn btn-sm enc-fundbtn" data-id="' + esc(d.id) + '" aria-expanded="false" title="' + (ctl === "vault" ? 'Add runtime from your credit balance - one passkey tap' : 'Add runtime - a gas-free USDC signature credits the deployment’s on-chain balance') + '">Top up</button>' : '') +
            (onchain && (live || resumable) && ctl !== "order" ? '<button class="btn btn-sm enc-upgbtn" data-id="' + esc(d.id) + '" aria-expanded="false" title="Switch to another approved version of this app - paid time carries over; the app restarts in place on the new version">Version</button>' : '') +
            (onchain && (live || resumable) && ctl !== "order" ? '<button class="btn btn-sm enc-wafbtn" data-id="' + esc(d.id) + '" aria-expanded="false" title="Per-IP rate limit + request filter, enforced inside the enclave at the app’s front door - add, tune or remove it any time; a running app picks the change up live">Protect</button>' : '') +

            (st === "running" && ctl === "wallet" ? '<button class="btn btn-sm enc-restart" data-id="' + esc(d.id) + '" title="Stop and relaunch the app in place - same version, endpoint and balance; app state is ephemeral. The fix for a wedged instance (e.g. a model that never loaded at boot)">Restart</button>' : '') +
            (onchain && st === "running" && ctl === "wallet" ? '<button class="btn btn-sm enc-movebtn" data-id="' + esc(d.id) + '" aria-expanded="false" title="Run this app on a different enclave - the current one hands its lease back (unused lease time is refunded to the balance) and the box you pick claims it. Same URL, version and balance">Move</button>' : '') +
            '<button class="btn btn-sm enc-verify" data-id="' + esc(d.id) + '" aria-expanded="false">Verify</button>' +
            (resumable && ctl !== "order" ? '<button class="btn btn-sm ok enc-resume" data-id="' + esc(d.id) + '" title="Put it back on the queue - an enclave re-claims it and the app relaunches fresh from its published version, spending the remaining balance">Resume</button>' : '') +
            (live && ctl !== "order" ? (onchain
              ? '<button class="btn btn-sm warn enc-kill" data-id="' + esc(d.id) + '" title="Stop the app and take it off the queue. The remaining balance stays on the deployment - Resume restarts it any time">Suspend</button>'
              : '<button class="btn btn-sm danger enc-kill" data-id="' + esc(d.id) + '">Terminate</button>') : '') +
            // Cancel is the one-way door Suspend is not: it ENDS the deployment
            // and sends its unused runtime back. Offered on stopped rows too -
            // suspend-then-cancel is the ordinary path. The dialog quotes the
            // real payout from the ledger before anything is signed, because it
            // is not the balance (see _refund).
            (onchain && (live || resumable) && ctl !== "order" ? '<button class="btn btn-sm danger enc-refund" data-id="' + esc(d.id) + '" title="End this deployment and send its unused runtime back' + (ctl === "vault" ? ' to your credit balance' : ' to your wallet') + '. You get back what the contract still holds for it, which is less than the balance - the exact amount is shown before you confirm">Cancel</button>' : '') +
          '</span>' +
        '</div>' +
        ((st === "failed" || st === "expired") && d.error ? '<div class="enc-err" title="why this deployment ' + esc(st) + '">⚠ ' + esc(d.error) + '</div>' : '') +
        // a version change the runner could not apply yet (unapproved/oversized
        // target, catalog unreachable): the OLD version keeps serving; say why
        (d.versionChange && d.versionChange.error ? '<div class="enc-err" title="the requested version change has not applied - the previous version keeps serving; the runner retries automatically">⚠ version change pending: ' + esc(d.versionChange.error) + '</div>' : '') +
        (st === "queued" ? '<div class="enc-why" data-why="' + esc(d.id) + '" role="status" aria-live="polite" hidden></div>' : '') +
        (ep ? '<button class="enc-ep" data-ep="' + esc(ep) + '">' + esc(ep) + ' ⧉</button>'
              + openCtl(d, ep, this._tls && this._tls.get(d.id)) : '') +
        depIp6Row(d) +
        '<div class="enc-fund" hidden></div>' +
        '<div class="enc-upg" hidden></div>' +
        '<div class="enc-move" hidden></div>' +
        '<div class="enc-waf" hidden></div>' +
        (onchain && (live || resumable) && ctl === "wallet" ? secretsSection(d.id) : '') +
        (onchain && (live || resumable) && ctl === "wallet" ? domainsSection(d.id) : '') +
        // public data, so every row kind gets it: dedicated builds when the
        // version's config names them, else the generic-shell pairing flow
        // for any running public app on a platform origin
        mobileSection(d, ep) +
        '<div class="enc-out" data-id="' + esc(d.id) + '" hidden></div>' +
        '<div class="enc-att" hidden></div>' +
      '</div>';
    }).join("");
    $$(".enc-id", body).forEach(b => b.addEventListener("click", () => copyText(b.dataset.copy)));
    $$(".enc-ep", body).forEach(b => b.addEventListener("click", () => copyText(b.dataset.ep)));
    $$(".enc-outbtn", body).forEach(b => b.addEventListener("click", () => this._output(b.dataset.id, b)));
    $$(".enc-fundbtn", body).forEach(b => b.addEventListener("click", () => this._fund(b.dataset.id, b)));
    $$(".enc-upgbtn", body).forEach(b => b.addEventListener("click", () => this._upgrade(b.dataset.id, b)));
    $$(".enc-movebtn", body).forEach(b => b.addEventListener("click", () => this._move(b.dataset.id, b)));
    $$(".enc-wafbtn", body).forEach(b => b.addEventListener("click", () => this._waf(b.dataset.id, b)));
    $$(".enc-sec[data-id]", body).forEach(el => this._secretsWire(el));
    $$(".enc-dom[data-id]", body).forEach(el => this._domainsWire(el));
    $$(".em-toggle", body).forEach(b => b.addEventListener("click", () => {
      const panel = document.getElementById(b.getAttribute("aria-controls"));
      if (!panel) return;
      const open = panel.hidden;
      panel.hidden = !open;
      b.setAttribute("aria-expanded", String(open));
    }));
    $$(".em-copy", body).forEach(b => b.addEventListener("click", () => copyText(b.dataset.copy)));
    $$(".enc-verify", body).forEach(b => b.addEventListener("click", () => this._verify(b.dataset.id, b)));
    $$(".enc-kill", body).forEach(b => b.addEventListener("click", () => this._kill(b.dataset.id, b)));
    $$(".enc-refund", body).forEach(b => b.addEventListener("click", () => this._refund(b.dataset.id, b)));
    $$(".enc-resume", body).forEach(b => b.addEventListener("click", () => this._resume(b.dataset.id, b)));
    $$(".enc-restart", body).forEach(b => b.addEventListener("click", () => this._restart(b.dataset.id, b)));
    this._fillWhy();               // cached decline reasons repaint instantly with the rows
    this._probeWhy(pageRows);      // then refresh them (throttled per row)
    this._probeTls(pageRows);      // TLS-gate the Open controls (throttled per row)
    this._probeWaf(pageRows);      // "protected" badges off the options envelope (cached per row)
    this._renderPager(pages, shown.length, PER_PAGE);
    // finished runs' strips yield to their rows the moment those render
    [...this._strips.keys()].forEach(r => this._retireStrip(r));
    // a just-deployed row opens its Output panel so the narrative continues in place
    if (highlight) {
      const b = body.querySelector('.enc-outbtn[data-id="' + highlight + '"]');
      if (b && runlog.runFor(highlight)) this._output(highlight, b);
    }
  }

  /* ---- queued rows: WHY is the fleet not taking this? ----
     "queued" only says no runner holds a lease - the ledger can't say why.
     /v1/claim-hint runs the enclaves' exact claim gauntlet and returns the
     decline reason, so the row can distinguish "waiting on capacity" from
     TERMINAL states (below the app's minimum shares, unapproved version,
     retired configCid) where no amount of waiting ever starts the app and
     the only exit is suspend + redeploy (created shares are immutable).
     Without this, a permanently unclaimable deployment is indistinguishable
     from a patient one - it took chain forensics to tell them apart once
     (2026-07-14, 0xf3d976a0…). Probes are throttled hard: current page only,
     30s per row - the enclave's hint bucket is per-source-IP and the relay
     pools every browser behind its one IP. ---- */
  async _probeWhy(rows) {
    this._why = this._why || new Map();
    for (const d of rows) {
      if ((d.status || "") !== "queued" || !/^0x[0-9a-f]{64}$/i.test(d.id || "")) continue;
      const c = this._why.get(d.id);
      if (c && Date.now() - c.at < 30_000) continue;
      this._why.set(d.id, { ...(c || {}), at: Date.now() });   // stamp before the await: overlapping polls must not double-probe
      try {
        const r = await fetch(Enclave.base + "/claim-hint", { method: "POST",
          headers: { "content-type": "application/json" }, body: JSON.stringify({ id: d.id }) });
        const h = await r.json();
        if (h && h.accepted === false && h.reason)
          this._why.set(d.id, { at: Date.now(), reason: h.reason, terminal: WHY_TERMINAL.test(h.reason) });
        else if (h && h.accepted === true)
          this._why.set(d.id, { at: Date.now(), reason: "", terminal: false });   // being claimed - clear the line
      } catch(e){}   // 429 / network: keep what we knew, retry next cycle
    }
    this._fillWhy();
  }
  _fillWhy() {
    if (!this._why) return;
    $$(".enc-why", this).forEach(el => {
      const c = this._why.get(el.dataset.why);
      if (!c || !c.reason){ el.hidden = true; el.innerHTML = ""; el.classList.remove("enc-err"); return; }
      el.classList.toggle("enc-err", !!c.terminal);
      el.innerHTML = c.terminal
        ? "⚠ won’t start by waiting - the fleet refuses this work: " + esc(c.reason)
          + " (a deployment’s shares are immutable: suspend it and redeploy at the app’s current minimums)"
        : '<span class="dim">fleet: ' + esc(c.reason) + " - retrying automatically</span>";
      el.hidden = false;
    });
  }

  /* ---- Open-control TLS probes: does THIS browser trust the app origin? ----
     A no-cors HEAD resolves (opaque) iff DNS + TCP + the TLS handshake all
     succeeded with a certificate this browser trusts - the self-signed
     fallback rejects, which is exactly the "cert not through yet" state.
     Redirects follow (no-cors REQUIRES follow - manual throws a TypeError),
     so an app whose / redirects somewhere broken or insecure stays amber:
     right call, since that's also what greets whoever clicks open.
     Throttle: pending rows retry each ~10s poll; a green row re-verifies
     every 5 min (an enclave release re-mints every cert, so green can regress)
     and only flips back on an actual failed probe - never while in flight. ---- */
  /* ---- per-row "protected" badge: does the options envelope carry a waf?
     The list rows (supervisor live view / relay ledger view) don't carry the
     envelope, so visible on-chain rows get ONE cached ledger read each - an
     envelope only changes via an owner tx, so the cache lives until the
     Protect panel itself rewrites it (which flips the badge in place). ---- */
  async _probeWaf(rows) {
    this._env = this._env || new Map();
    for (const d of rows) {
      const id = d.id;
      if (!/^0x[0-9a-f]{64}$/i.test(id || "")) continue;
      const c = this._env.get(id);
      if (c) { this._wafPaint(id); continue; }
      this._env.set(id, { waf: false, summary: "" });   // stamp before the await: overlapping polls must not double-read
      try {
        const dd = await depGet(id);
        this._wafLearn(id, dd && dd.configCid);
      } catch (e) { this._env.delete(id); }             // unread: a later repaint retries
    }
  }
  /* parse an envelope string into the cache + repaint that row's badge -
     shared by the probe, the Protect panel's open (fresh read) and its apply
     (optimistic), so the badge always says what the ledger says */
  _wafLearn(id, envelope) {
    this._env = this._env || new Map();
    let w = null;
    const raw = String(envelope || "").trim();
    if (raw.startsWith("{")) { try { const o = JSON.parse(raw); if (o && o.waf && typeof o.waf === "object" && !Array.isArray(o.waf)) w = o.waf; } catch (e) {} }
    const summary = w ? [
      w.rps != null ? w.rps + " r/s per IP" : null,
      w.burst != null ? "burst " + w.burst : null,
      w.maxBodyMb != null ? "max body " + w.maxBodyMb + " MB" : null,
      w.blockScanners ? "scanner paths blocked" : null,
    ].filter(Boolean).join(" \u00b7 ") : "";
    this._env.set(id, { waf: !!w, summary });
    this._wafPaint(id);
  }
  _wafPaint(id) {
    const c = this._env && this._env.get(id);
    const b = this.querySelector('.ep-waf[data-wafb="' + id + '"]');
    if (!b || !c) return;
    b.hidden = !c.waf;
    if (c.waf) b.title = "Protection is on: " + c.summary + " - the Protect button tunes or removes it";
  }

  async _probeTls(rows) {
    this._tls = this._tls || new Map();
    for (const d of rows) {
      if (!(d.public && (d.status || "") === "running")) { this._tls.delete(d.id); continue; }
      const href = safeHref(appEndpoint(d));
      if (!/^https:\/\//i.test(href)) continue;   // only absolute https origins render an Open control
      const c = this._tls.get(d.id);
      if (c && Date.now() - c.at < (c.state === "ok" ? 300_000 : 8_000)) continue;
      this._tls.set(d.id, { state: c ? c.state : "wait", at: Date.now() });   // stamp before the await: overlapping polls must not double-probe
      try {
        await fetch(href + "/", { method: "HEAD", mode: "no-cors", cache: "no-store",
                                  signal: AbortSignal.timeout(8000) });
        this._tls.set(d.id, { state: "ok", at: Date.now() });
      } catch (e) {
        this._tls.set(d.id, { state: "wait", at: Date.now() });
      }
    }
    this._fillTls();
  }
  /* swap Open controls in place when a probe verdict differs from what's
     rendered - the 10s poll skips repaints while a panel is open, and the
     first probe usually lands between two paints */
  _fillTls() {
    if (!this._tls) return;
    $$("[data-tls]", this).forEach(el => {
      const c = this._tls.get(el.dataset.tls);
      const ok = !!(c && c.state === "ok");
      if (ok === (el.tagName === "A")) return;
      const d = (this._list || []).find(x => x.id === el.dataset.tls);
      const html = d ? openCtl(d, appEndpoint(d), c) : "";
      if (html) el.outerHTML = html;
    });
  }

  /* ---- pager: prev · "x–y of N" · next. Hidden for a single page. ---- */
  _renderPager(pages, total, per) {
    const pager = this.querySelector(".enc-pager"); if (!pager) return;
    if (pages <= 1){ pager.hidden = true; pager.innerHTML = ""; return; }
    const p = this._page, first = p * per + 1, last = Math.min(total, (p + 1) * per);
    pager.hidden = false;
    pager.innerHTML =
      '<button class="btn btn-sm enc-pg" data-pg="prev" type="button"' + (p <= 0 ? " disabled" : "") + '>← prev</button>' +
      '<span class="enc-pg-info">' + first + '–' + last + ' of ' + total + ' · page ' + (p + 1) + ' of ' + pages + '</span>' +
      '<button class="btn btn-sm enc-pg" data-pg="next" type="button"' + (p >= pages - 1 ? " disabled" : "") + '>next →</button>';
    $$(".enc-pg", pager).forEach(b => b.addEventListener("click", () => {
      this._page += b.dataset.pg === "next" ? 1 : -1;
      this._renderRows(this._list || []);
      const top = this.querySelector(".enc-body");
      if (top) top.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }));
  }

  /* ---- per-row Top up: extend a deployment's runtime in place. One amount,
     the runtime it adds at this deployment's own rate, one gas-free USDC
     signature (EIP-3009 -> fundWithAuthorization; same flow as deploying). ---- */
  _fund(id, btn) {
    const row = btn.closest(".enc-row"), box = row && row.querySelector(".enc-fund"); if (!box) return;
    if (!box.hidden){ box.hidden = true; box.innerHTML = ""; btn.setAttribute("aria-expanded", "false"); return; }
    btn.setAttribute("aria-expanded", "true");
    const d = (this._list || []).find(x => x.id === id) || {};
    const via = ctlOf(d) === "vault";   // credit-vault row: passkey-signed, spends account credit
    const r = d.resources || {};
    const gpuPct = Math.round((r.gpuShare || 0) * 100), cpuPct = Math.round((r.cpuShare != null ? r.cpuShare : (r.share || 0)) * 100);
    // the deployment's own burn rate: the API's live number (the on-chain
    // snapshot) when present; else the CONTRACT's prices; constants only
    // until that read lands
    let rate = parseFloat(d.ratePerSecondUsdc) || shareRates(gpuPct, cpuPct).rate;
    if (!parseFloat(d.ratePerSecondUsdc))
      depPrices6().then(pr => { rate = Number(rate6Of(pr, gpuPct * 10, cpuPct * 10)) / 1e6; if (box.isConnected && !box.hidden) upd(); }).catch(() => {});
    box.hidden = false;
    box.innerHTML = '<div class="ap-attbar">top up · ' + esc(id) + '</div>'
      + '<div class="enc-fund-body">'
      +   '<label for="efAmt">Add runtime (' + (via ? 'USD' : 'USDC') + ')</label>'
      +   '<input class="ef-amt" id="efAmt" type="number" value="5" min="0.01" step="any" inputmode="decimal" />'
      +   '<span class="ef-est"></span>'
      +   '<button class="btn btn-sm btn-primary ef-go" type="button">' + (via ? 'Confirm with passkey' : 'Sign &amp; pay') + '</button>'
      + '</div>'
      + '<div class="term enc-fund-status" role="status" aria-live="polite"></div>';
    const amt = box.querySelector(".ef-amt"), est = box.querySelector(".ef-est");
    const go = box.querySelector(".ef-go"), st = box.querySelector(".enc-fund-status");
    const paint = (cls, txt) => paintLine(st, cls, txt);
    // a drained row (expired on the runner's record, unfunded on the ledger's)
    // has no runner watching its balance: funding is what re-queues it, and one
    // claim-hint makes the fleet's re-claim prompt instead of next-sweep
    const revive = ["expired", "unfunded"].indexOf(d.status || "") !== -1;
    const nudge = () => { if (revive) fetch(Enclave.base + "/claim-hint", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) }).catch(() => {}); };
    const okTail = revive ? " · re-queued: the fleet re-claims it and the app relaunches within a minute"
                          : " · the enclave picks up the new balance within a minute";
    const upd = () => {
      const usd = parseFloat(amt.value) || 0;
      est.textContent = (rate > 0 && usd > 0) ? "adds ≈ " + fmtDur(usd / rate) : "";
      go.disabled = !(usd >= 0.01);
    };
    amt.addEventListener("input", upd); upd();
    go.addEventListener("click", async () => {
      const usd = parseFloat(amt.value) || 0; if (!(usd >= 0.01)) return;
      go.disabled = true; st.innerHTML = "";
      if (via){
        // credit path: the vault owns this deployment on-chain; one passkey
        // tap signs fundDeployment and the balance moves credit -> deployment
        try {
          paint("info", "[*] confirm with your passkey…");
          const { vaultOp } = await import("../../js/core/vault.js");
          await vaultOp("fund", { id, amountUsd: usd });
          nudge();
          paint("ok", "[✓] topped up from your credit" + (rate > 0 ? " - +" + fmtDur(usd / rate) + " of runtime" : "") + okTail);
          showToast("topped up " + id.slice(0, 10) + "… with $" + usd.toFixed(2));
          setTimeout(() => { if (box.isConnected && !box.hidden){ box.hidden = true; box.innerHTML = ""; } this.refresh(); }, 3500);
        } catch(e){ paint("warn", "[x] " + (e.message || String(e))); }
        finally { go.disabled = false; }
        return;
      }
      try {
        // no SIWE: the EIP-3009 authorization IS the proof of key ownership
        if (!Enclave.provider){ paint("info", "[*] connecting wallet…"); await connectWallet(); }
        await ensureBaseChain();
        let pricing = null;
        try { pricing = await (await fetch(Enclave.base + "/pricing", { signal: AbortSignal.timeout(8000) })).json(); } catch(e){}
        await payForRuntime({
          contract: DEPLOYMENTS_ADDRESS, deploymentRef: id,
          usdcDomain: pricing && pricing.usdcDomain, usdc: (pricing && pricing.usdc) || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          ethUsd: pricing && pricing.ethUsd,
        }, usd, "USDC", paint);
        nudge();
        paint("ok", "[✓] topped up" + (rate > 0 ? " - +" + fmtDur(usd / rate) + " of runtime" : "") + okTail);
        showToast("topped up " + id.slice(0, 10) + "… with $" + usd.toFixed(2));
        setTimeout(() => { if (box.isConnected && !box.hidden){ box.hidden = true; box.innerHTML = ""; } this.refresh(); }, 3500);
      } catch(e){
        const rejected = (e && e.code === 4001) || /reject|denied|declin|cancell/i.test(e && e.message || "");
        paint("warn", rejected ? "[x] rejected in wallet - nothing was paid" : "[x] " + (e.message || String(e)));
      } finally { go.disabled = false; refreshWallet(); }
    });
  }

  /* ---- per-row Version: repoint the deployment at another approved version
     of its app - the owner's UPGRADE path (setAppRef on the ledger). Paid
     time, shares and any live lease stay on the record: the runner restarts
     the app in place on the new version within about a minute, so a new
     release never costs a second buy-in. Candidates are the app's other
     approved un-yanked versions; ones whose minimums exceed this deployment's
     bought shares are listed disabled (created shares are immutable - those
     need a fresh deploy at bigger dials). Checked here BEFORE the wallet
     signature, the deploy form's floor rule: runners enforce the same gate,
     and a version no runner accepts would leave the app dark. ---- */
  async _upgrade(id, btn) {
    const row = btn.closest(".enc-row"), box = row && row.querySelector(".enc-upg"); if (!box) return;
    if (!box.hidden){ box.hidden = true; box.innerHTML = ""; btn.setAttribute("aria-expanded", "false"); return; }
    btn.setAttribute("aria-expanded", "true");
    box.hidden = false;
    box.innerHTML = '<div class="ap-attbar">change version · ' + esc(id) + '</div>'
      + '<div class="term enc-upg-status" role="status" aria-live="polite"><span class="ln dimln">// reading the ledger + catalog…</span></div>';
    let d = null, rev = 1, avail = null, fleet = null;
    try {
      [rev, d] = await Promise.all([depSchemaRev(), depGet(id)]);
      await loadCatalog();
      // adopt the fleet's live hardware for the minimum-share floors (the
      // deploy dials' rule: a stale spec must over-ask, never under-sell an
      // unclaimable switch); the pre-fetch fallback constants already over-ask.
      // The per-enclave table rides along: a leased deployment is sized on the
      // box that HOLDS the lease, not on the aggregate (see hw below).
      [avail, fleet] = await Promise.all([
        Enclave.getAvailability().then(a => { adoptServerSpec(a); return a; }).catch(() => null),
        Enclave.getEnclaves().catch(() => null),
      ]);
    } catch(e){ d = null; }
    if (box.hidden || !box.isConnected) return;             // closed while loading
    const fail = (msg) => { box.querySelector(".enc-upg-status").innerHTML = ""; paintLine(box.querySelector(".enc-upg-status"), "warn", msg); };
    if (!d) return fail("[x] couldn’t read this deployment from the ledger - try again shortly");
    const cr = parseCatalogRef(d.appRef);
    if (!cr) return fail("[x] this deployment doesn’t reference a catalog version (" + (d.appRef || "no appRef") + ") - only catalog deployments can switch versions");
    const app = STORE.byId[cr.appId];
    if (!app || !app.versions) return fail("[x] the catalog doesn’t list this deployment’s app (delisted?) - nothing to switch to");
    if (rev < 3)
      return fail("[!] the live ledger contract predates version changes - the Version control activates with the next contract upgrade. Until then: deploy the new version fresh, then suspend this one (its balance stays on the record).");
    // The deployment's publisher-fee snapshot is as immutable as its shares:
    // a candidate version asking MORE than the snapshot could never pay its
    // publisher, so every runner would refuse the switch - list it disabled,
    // exactly like a share misfit. Fail closed on unreadable fees: offering a
    // switch runners refuse would leave the app dark. (Pre-fee ledger/catalog
    // revs read as all-zero without extra RPC - nothing disables today.)
    let snapFee = 0n; const verFees = {};
    try {
      snapFee = (await depFeeOf(id)).feePerSec6;
      await Promise.all(app.versions.map(async (v, i) => {
        verFees[i] = (!v.yanked && v.approval === APPROVAL.approved) ? await catVersionFee(cr.appId, i) : 0n;
      }));
    } catch(e){ return fail("[x] couldn’t read the publisher fees involved - try again shortly"); }
    // Resizable = a rev-6 ledger AND a fleet whose every live runner
    // re-slices on setShares (fleet-AND flag: against an older fleet the tx
    // would change the BILLING while the served slice silently didn't) AND
    // readable list prices to preview the recalculated rate with. When it
    // holds, share-misfit versions become selectable - the dials re-buy the
    // shares in the same transaction (the contract's multicall).
    let resizable = rev >= 6 && avail?.shareResize === true, prices = null, maxGpu = 1000;
    if (resizable){
      try { [prices, maxGpu] = await Promise.all([depPrices6(), depMaxGpuMilli()]); }
      catch(e){ resizable = false; }
    }
    // The owner's hourly ceiling (rev 8). Editable here whenever every live
    // runner honors it — the fleet-AND flag, same rule as the resize dials:
    // against an older runner a lowered cap would just look like a renewal
    // that mysteriously stopped.
    const capEditable = rev >= 8 && avail?.rateCap === true;
    let cap6 = 0n;
    if (rev >= 8){ try { cap6 = await depCapOf(id); } catch(e){} }
    // WHOSE HARDWARE the floors divide by. A live lease pins it: the enclave
    // holding it restarts the app in place and checks the new version against
    // its OWN card and node, so that box - not the fleet - decides what this
    // deployment can switch to. The adopted aggregate is deliberately the
    // SMALLEST box on every axis (right for a deploy that could land anywhere,
    // wrong here): it told a 1%-CPU row leased by a 64 GB box that its app
    // needs 17%, the same 512 MB measured against a 3 GB node, and disabled
    // every newer version behind a resize it doesn't need. Unleased rows keep
    // the aggregate - any box may claim them next, so over-asking is right.
    const hw = leaseHostOf(d, fleet);          // null = size on the aggregate
    const bought = { gpuMilli: Number(d.gpuMilli) || 0, cpuMilli: Number(d.cpuMilli) || 0 };
    const rows = app.versions
      .map((v, i) => ({ v, i, mins: minPctsOf(specOf(v), hw && hw.spec) }))
      .filter(r => !r.v.yanked && r.v.approval === APPROVAL.approved)
      .map(r => ({ ...r,
        shareFit: r.mins.gpuPct * 10 <= bought.gpuMilli && r.mins.cpuPct * 10 <= bought.cpuMilli,
        feeFit: (verFees[r.i] || 0n) <= snapFee }))
      .map(r => ({ ...r, fits: (r.shareFit || resizable) && r.feeFit }))
      .reverse();
    const others = rows.filter(r => r.i !== cr.index);
    const pick = others.find(r => r.fits);                  // newest servable release = the natural upgrade
    if (!others.length && !resizable)
      return fail("// " + app.slug + " has no other approved version yet - new releases appear here once the catalog owner approves them");
    const selId = "euSel" + appLabel(id);
    box.innerHTML = '<div class="ap-attbar">change version · ' + esc(id) + '</div>'
      + '<div class="enc-upg-body">'
      +   '<label for="' + selId + '">Switch ' + esc(app.slug) + ' to</label>'
      +   '<select class="eu-sel" id="' + selId + '">'
      +     rows.map(r => '<option value="' + r.i + '"' + (((r.i === cr.index && !resizable) || !r.fits) ? " disabled" : "") + (pick && r.i === pick.i ? " selected" : (!pick && r.i === cr.index ? " selected" : "")) + '>'
      +       esc(app.slug + ":" + r.v.version)
      +       (r.i === cr.index ? " · current" : "")
      +       (!r.shareFit && r.i !== cr.index ? " · needs ≥ " + (r.mins.gpuPct ? r.mins.gpuPct + "% GPU / " : "") + r.mins.cpuPct + "% CPU"
                                                 + (hw ? " on " + hw.name : "") : "")
      +       (r.shareFit && !r.feeFit && r.i !== cr.index ? " · charges $" + (Number(verFees[r.i]) * 3600 / 1e6).toFixed(2) + "/hr publisher fee (above this deployment’s snapshot)" : "")
      +     '</option>').join("")
      +   '</select>'
      +   (resizable
         ? '<div class="eu-dials">'
         +   '<label for="' + selId + 'g">GPU %</label><input id="' + selId + 'g" class="eu-gpu" type="number" min="0" max="' + (maxGpu / 10) + '" step="1" value="' + (bought.gpuMilli / 10) + '">'
         +   '<label for="' + selId + 'c">CPU %</label><input id="' + selId + 'c" class="eu-cpu" type="number" min="1" max="100" step="1" value="' + (bought.cpuMilli / 10) + '">'
         + '</div>'
         : '')
      +   '<button class="btn btn-sm btn-primary eu-go" type="button">Change version</button>'
      + '</div>'
      + (capEditable
         ? '<div class="enc-upg-body eu-cap-row">'
         +   '<label for="' + selId + 'r">Rate cap $/hr</label>'
         +   '<input id="' + selId + 'r" class="eu-cap" type="number" min="0" step="0.01" value="' + (Number(cap6) * 3600 / 1e6).toFixed(2) + '">'
         +   '<button class="btn btn-sm eu-cap-go" type="button">Set cap</button>'
         + '</div>'
         : '')
      + '<div class="term enc-upg-status" role="status" aria-live="polite"></div>';
    const sel = box.querySelector(".eu-sel"), go = box.querySelector(".eu-go"), st = box.querySelector(".enc-upg-status");
    const gIn = box.querySelector(".eu-gpu"), cIn = box.querySelector(".eu-cpu");
    const paint = (cls, txt) => paintLine(st, cls, txt);
    const intro = () => {
      paint("info", "// paid time carries over: the runner restarts the app in place (~a minute); the endpoint and balance don’t change, app state is ephemeral");
      if (resizable)
        paint("dimln", "// the dials re-buy this deployment’s shares in the same transaction - the hourly rate is recalculated at "
          + (rev >= 8 ? (hw ? hw.name + "’s posted price" : "the price of whichever enclave claims it") : "the CURRENT list prices")
          + ", and a live lease settles at the old rate first");
      if (cap6 > 0n)
        paint("dimln", "// rate cap $" + (Number(cap6) * 3600 / 1e6).toFixed(2) + "/h: enclaves dearer than this can’t run this deployment - "
          + "it is also what decides where the app goes if its enclave dies"
          + (capEditable ? "" : " (this fleet can’t change it yet)"));
      if (hw)
        paint("dimln", "// minimum shares are measured on " + hw.name + " (" + hw.spec.nodeRamGb + " GB / " + hw.spec.nodeVcpus + " vCPU node"
          + (bought.gpuMilli ? ", " + hw.spec.cardVramGb + " GB card" : "") + "), the enclave holding this deployment’s lease - it restarts the app in place and checks the new version against its own hardware");
      if (others.some(r => !r.shareFit) && !resizable)
        paint("dimln", "// disabled entries need more than this deployment’s " + (bought.gpuMilli ? (bought.gpuMilli / 10) + "% GPU / " : "") + (bought.cpuMilli / 10) + "% CPU - " + (rev >= 6 ? "the fleet doesn’t re-slice live deployments yet" : "this ledger’s shares are immutable") + ", those need a fresh deploy");
      if (others.some(r => r.shareFit && !r.feeFit))
        paint("dimln", "// entries charging a higher publisher fee than this deployment snapshotted at create need a fresh deploy - the fee snapshot is immutable");
    };
    // target shares off the dials (milli, percent grain), read RAW - typing is
    // never corrected and never clamped here, because a dial that fixes itself
    // mid-entry can't be typed THROUGH: with a 6% CPU share, the "1" of an
    // intended 18% GPU was snapped to 6 before the "8" ever arrived. Everything
    // out of range is caught by problem() below, on the button.
    const dials = () => ({
      gpuMilli: gIn ? Math.round(Number(gIn.value || 0)) * 10 : bought.gpuMilli,
      cpuMilli: cIn ? Math.round(Number(cIn.value || 0)) * 10 : bought.cpuMilli,
    });
    // the rate this size would run at, priced at the box that will serve it:
    // its lease holder's posted price (rev 8), else the fleet/list price
    const rateOf = t => rate6Of(hw && hw.price
      ? { gpu: BigInt(Math.round(hw.price.full * 1e6)), cpu: BigInt(Math.round(hw.price.node * 1e6)) }
      : prices, t.gpuMilli, t.cpuMilli) + snapFee;
    // EVERY rule the transaction must satisfy, in one place. Returns "" when
    // the dials are good. Shown as a live hint while you type - a hint only:
    // it neither rewrites the field nor disables the button. The click runs the
    // same function and refuses there, which is the one place a half-typed
    // number can't be mistaken for a final answer.
    const problem = (r, t, resized) => {
      if (!gIn || !cIn) return "";
      if (!Number.isFinite(Number(gIn.value)) || !Number.isFinite(Number(cIn.value)))
        return "// both shares have to be numbers";
      if (t.gpuMilli < 0 || t.cpuMilli < 0) return "// shares can’t be negative";
      const ver = app.slug + ":" + r.v.version;
      if (t.gpuMilli < r.mins.gpuPct * 10)
        return "// " + ver + " needs at least " + r.mins.gpuPct + "% GPU" + (hw ? " on " + hw.name : "");
      if (t.cpuMilli < Math.max(10, r.mins.cpuPct * 10))
        return "// " + ver + " needs at least " + Math.max(1, r.mins.cpuPct) + "% CPU" + (hw ? " on " + hw.name : "");
      if (t.cpuMilli > 1000) return "// the CPU share can’t be more than 100% of the node";
      if (t.gpuMilli > maxGpu) return "// GPU over the platform’s per-deployment cap of " + (maxGpu / 10) + "%";
      if (t.gpuMilli > 0 && t.gpuMilli < t.cpuMilli)
        return "// a GPU deployment’s GPU share can’t sit below its CPU share - raise GPU to "
          + (t.cpuMilli / 10) + "% or more, or lower CPU";
      if (!resized) return "";
      const newRate = rateOf(t);
      if (cap6 > 0n && newRate > cap6)
        return "// that size costs more than this deployment’s rate cap of $" + (Number(cap6) * 3600 / 1e6).toFixed(2)
          + "/h - raise the cap below, then resize";
      if (Number(d.leaseUntil) * 1000 > Date.now()){
        const tail = Math.max(0, Number(d.leaseUntil) - Math.floor(Date.now() / 1000));
        if (BigInt(Number(d.balance6 || 0)) + BigInt(tail) * BigInt(Math.round(Number(d.rate) || 0)) < newRate)
          return "// the remaining balance can’t fund even one second at the new rate - top it up first";
      }
      return "";
    };
    // prefill = a discrete choice (opening the panel, picking a version), NOT a
    // keystroke: only then may the dials be written for you.
    const upd = (prefill) => {
      const r = rows.find(x => String(x.i) === sel.value);
      st.innerHTML = ""; intro();
      if (!r || !r.fits){ go.disabled = true; return; }
      if (resizable && gIn && cIn){
        // the floors ride the spinner and the a11y contract, not the keystroke:
        // min/max steer the arrows and announce the range without touching what
        // you typed (browsers don't refuse out-of-range typing outside a form)
        gIn.min = r.mins.gpuPct; cIn.min = Math.max(1, r.mins.cpuPct);
        if (prefill){
          // pick a version that needs more than this deployment bought and the
          // dials come up already holding its minimums - the convenience the
          // old per-keystroke version was after, at the one moment it can't
          // land in the middle of a number being typed
          if (Math.round(Number(gIn.value || 0)) < r.mins.gpuPct) gIn.value = r.mins.gpuPct;
          if (Math.round(Number(cIn.value || 0)) < Math.max(1, r.mins.cpuPct)) cIn.value = Math.max(1, r.mins.cpuPct);
          const p = dials();
          if (p.gpuMilli > 0 && p.gpuMilli < p.cpuMilli) gIn.value = p.cpuMilli / 10;  // contract: gpuMilli >= cpuMilli
        }
        const t = dials();
        const resized = t.gpuMilli !== bought.gpuMilli || t.cpuMilli !== bought.cpuMilli;
        const verChange = r.i !== cr.index;
        go.textContent = verChange && resized ? "Change version + resize" : resized ? "Resize" : "Change version";
        go.disabled = !verChange && !resized;
        const bad = problem(r, t, resized);
        if (bad){ paint("warn", bad); return; }   // hint only - the click re-checks
        if (resized){
          const newRate = rateOf(t), oldRate = Math.round(Number(d.rate) || 0), bal = Number(d.balance6 || 0);
          paint("dimln", "// rate $" + (oldRate * 3600 / 1e6).toFixed(2)
            + "/h -> $" + (Number(newRate) * 3600 / 1e6).toFixed(2) + "/h"
            + (hw ? " at " + hw.name + "’s price" : "")
            + (bal > 0 && Number(newRate) > 0 ? " · remaining balance buys ≈ " + fmtDur(bal / Number(newRate)) : ""));
        }
      } else {
        go.disabled = r.i === cr.index || !r.fits;
      }
    };
    sel.addEventListener("change", () => upd(true));
    if (gIn) gIn.addEventListener("input", () => upd(false));
    if (cIn) cIn.addEventListener("input", () => upd(false));
    upd(true);
    go.addEventListener("click", async () => {
      const r = rows.find(x => String(x.i) === sel.value);
      if (!r || !r.fits) return;
      const t = dials();
      const resized = resizable && (t.gpuMilli !== bought.gpuMilli || t.cpuMilli !== bought.cpuMilli);
      const verChange = r.i !== cr.index;
      if (!verChange && !resized) return;
      // the one gate: nothing was rejected while it was being typed, so the
      // dials are checked here, before a signature is ever asked for
      if (resizable && gIn && cIn){
        const bad = problem(r, t, resized);
        if (bad){ st.innerHTML = ""; intro(); paint("warn", bad); return; }
      }
      go.disabled = true;
      const via = ctlOf((this._list || []).find(x => x.id === id)) === "vault";
      const doneWord = verChange ? "switched to " + app.slug + ":" + r.v.version + (resized ? " at " + (t.gpuMilli / 10) + "% GPU / " + (t.cpuMilli / 10) + "% CPU" : "")
                                 : "resized to " + (t.gpuMilli / 10) + "% GPU / " + (t.cpuMilli / 10) + "% CPU";
      try {
        if (via){
          // credit-vault row: the vault owns the deployment on-chain, so the
          // change is a passkey-signed controlDeployment op via the relay
          paint("info", "[*] confirm the change with your passkey…");
          const { vaultOp } = await import("../../js/core/vault.js");
          await vaultOp("control", resized
            ? { id, action: "resize", gpuMilli: t.gpuMilli, cpuMilli: t.cpuMilli, ...(verChange ? { ref: catalogRef(cr.appId, r.i) } : {}) }
            : { id, action: "version", ref: catalogRef(cr.appId, r.i) });
        } else {
          // no SIWE: setAppRef/setShares are owner-gated on-chain - a connected
          // wallet is all this needs; both changes ride ONE multicall signature
          if (!Enclave.provider){ paint("info", "[*] connecting wallet…"); await connectWallet(); }
          await ensureBaseChain();
          paint("info", "[*] confirm the transaction in your wallet…");
          const calls = [];
          if (verChange) calls.push(encCall(DEP_SEL.setAppRef, [{ t: "bytes32", v: id }, { t: "str", v: catalogRef(cr.appId, r.i) }]));
          if (resized) calls.push(encCall(DEP_SEL.setShares, [{ t: "bytes32", v: id }, { t: "uint", v: t.gpuMilli }, { t: "uint", v: t.cpuMilli }]));
          const th = await sendTx(DEPLOYMENTS_ADDRESS,
            calls.length > 1 ? encCall(DEP_SEL.multicall, [{ t: "bytes[]", v: calls }]) : calls[0]);
          paint("dimln", "  ↳ sent " + th + " · waiting for confirmation…");
          await waitReceipt(th);
        }
        if (this._why) this._why.delete(id);   // a pre-change decline reason must not outlive the switch
        // nudge the fleet: makes queued/suspended rows relaunch promptly (a
        // running one is restarted by its own runner's next ledger pass)
        fetch(Enclave.base + "/claim-hint", { method: "POST",
          headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) }).catch(() => {});
        paint("ok", "[✓] " + doneWord + " - the runner applies it within a minute; paid time and the endpoint carry over");
        showToast(doneWord.replace(/^switched/, "switched " + id.slice(0, 10) + "…").replace(/^resized/, "resized " + id.slice(0, 10) + "…"));
        setTimeout(() => { if (box.isConnected && !box.hidden){ box.hidden = true; box.innerHTML = ""; btn.setAttribute("aria-expanded", "false"); } this.refresh(); }, 3500);
      } catch(e){
        const rejected = (e && e.code === 4001) || /reject|denied|declin|cancell/i.test(e && e.message || "");
        paint("warn", rejected ? (via ? "[x] cancelled - nothing changed" : "[x] rejected in wallet - nothing changed") : "[x] " + (e.message || String(e)));
        go.disabled = false;
      } finally { if (!via) refreshWallet(); }
    });
    // ---- the hourly ceiling: which enclaves may run this deployment --------
    // Enclaves price their own hardware, so this line decides where the work
    // can go - including when its host dies and the lease reopens. Below the
    // running rate it becomes a stop: the paid lease finishes and nothing
    // renews or re-claims it, which the button says out loud before signing.
    const capGo = box.querySelector(".eu-cap-go"), capIn = box.querySelector(".eu-cap");
    if (capGo && capIn){
      const leased = Number(d.leaseUntil) * 1000 > Date.now();
      const capOf = () => BigInt(Math.round((parseFloat(capIn.value) || 0) * 1e6 / 3600));
      capGo.disabled = true;
      capIn.addEventListener("input", () => { const n = capOf(); capGo.disabled = !(n > snapFee) || n === cap6; });
      capGo.addEventListener("click", async () => {
        const next6 = capOf();
        if (!(next6 > snapFee))
          return paint("warn", "// the cap must be above the app’s publisher fee ($" + (Number(snapFee) * 3600 / 1e6).toFixed(2) + "/hr)");
        const runRate = BigInt(Math.round(Number(d.rate) || 0));
        if (leased && next6 < runRate
            && !confirm("$" + (Number(next6) * 3600 / 1e6).toFixed(2) + "/hr is below what this deployment pays now ($"
                        + (Number(runRate) * 3600 / 1e6).toFixed(2) + "/hr).\n\nThe lease you already paid for runs to "
                        + new Date(Number(d.leaseUntil) * 1000).toLocaleString()
                        + ", then the app STOPS: no renewal and no re-claim until a cheaper enclave exists or you raise the cap.\n\nSet it anyway?"))
          return;
        capGo.disabled = true;
        const viaVault = ctlOf((this._list || []).find(x => x.id === id)) === "vault";
        try {
          if (viaVault){
            paint("info", "[*] confirm the change with your passkey…");
            const { vaultOp } = await import("../../js/core/vault.js");
            await vaultOp("control", { id, action: "maxrate", maxRate6: Number(next6) });
          } else {
            if (!Enclave.provider){ paint("info", "[*] connecting wallet…"); await connectWallet(); }
            await ensureBaseChain();
            paint("info", "[*] confirm the transaction in your wallet…");
            const th = await sendTx(DEPLOYMENTS_ADDRESS,
              encCall(DEP_SEL.setMaxRate, [{ t: "bytes32", v: id }, { t: "uint", v: next6 }]));
            paint("dimln", "  ↳ sent " + th + " · waiting for confirmation…");
            await waitReceipt(th);
          }
          cap6 = next6;
          paint("ok", "[✓] rate cap now $" + (Number(next6) * 3600 / 1e6).toFixed(2) + "/hr"
            + (leased && next6 < runRate ? " - the app stops when the current lease ends" : " - enclaves dearer than this can’t run it"));
          showToast("rate cap set for " + id.slice(0, 10) + "…");
          this.refresh();
        } catch(e){
          const rejected = (e && e.code === 4001) || /reject|denied|declin|cancell/i.test(e && e.message || "");
          paint("warn", rejected ? "[x] cancelled - the cap is unchanged" : "[x] " + (e.message || String(e)));
          capGo.disabled = false;
        } finally { if (!viaVault) refreshWallet(); }
      });
    }
  }

  /* ---- per-row Protect: the deployment's options envelope, WAF namespace.
     Deployments that skipped Protection at create gain it here - one owner
     setConfig tx rewrites the envelope (the `config` namespace, if any, is
     PRESERVED verbatim), and a fleet advertising configEdit swaps the waf on
     the LIVE app within ~a minute, no restart. Fails closed like the deploy
     form: the editor only arms when every live runner enforces the envelope
     (aggregate waf:true) - a mixed fleet would strand the deployment on a
     runner that refuses it at its next claim. ---- */
  async _waf(id, btn) {
    const row = btn.closest(".enc-row"), box = row && row.querySelector(".enc-waf"); if (!box) return;
    if (!box.hidden){ box.hidden = true; box.innerHTML = ""; btn.setAttribute("aria-expanded", "false"); return; }
    btn.setAttribute("aria-expanded", "true");
    box.hidden = false;
    box.innerHTML = '<div class="ap-attbar">protection · ' + esc(id) + '</div>'
      + '<div class="term enc-waf-status" role="status" aria-live="polite"><span class="ln dimln">// reading the ledger + fleet…</span></div>';
    let d = null, rev = 1, avail = null;
    try { [rev, d] = await Promise.all([depSchemaRev(), depGet(id)]); } catch(e){ d = null; }
    try { avail = await Enclave.getAvailability(); } catch(e){}
    if (box.hidden || !box.isConnected) return;              // closed while loading
    const fail = (msg) => { box.querySelector(".enc-waf-status").innerHTML = ""; paintLine(box.querySelector(".enc-waf-status"), "warn", msg); };
    if (!d) return fail("[x] couldn’t read this deployment from the ledger - try again shortly");
    if (avail && avail.waf !== true)
      return fail("[!] the live fleet doesn’t enforce the protection envelope yet - enabling it now could strand this deployment on its next claim; try again after the fleet updates");
    // the current envelope: waf + config namespaces; anything unparseable
    // reads as empty (setConfig replaces it wholesale, which also heals it)
    const raw = String(d.configCid || "").trim();
    this._wafLearn(id, raw);                       // freshest ledger truth: sync the row badge
    let cur = {};
    if (raw.startsWith("{")) { try { cur = JSON.parse(raw); } catch(e){} }
    if (!cur || Array.isArray(cur) || typeof cur !== "object") cur = {};
    const w0 = (cur.waf && typeof cur.waf === "object" && !Array.isArray(cur.waf)) ? cur.waf : null;
    const fid = "ew" + appLabel(id);
    box.innerHTML = '<div class="ap-attbar">protection · ' + esc(id) + '</div>'
      + '<div class="enc-waf-body">'
      +   '<label class="ew-on"><input type="checkbox" class="ew-en" id="' + fid + 'e"' + (w0 ? " checked" : "") + '> Protection on</label>'
      +   '<label for="' + fid + 'r">Rate/IP <abbr title="sustained requests per second each client IP may make; steadier traffic above it is dropped at the enclave’s front door with 429">?</abbr></label>'
      +   '<input id="' + fid + 'r" class="ew-rps" type="number" min="0.1" max="10000" step="0.1" value="' + esc(String(w0 && w0.rps != null ? w0.rps : 10)) + '"> r/s'
      +   '<label for="' + fid + 'b">Burst</label>'
      +   '<input id="' + fid + 'b" class="ew-burst" type="number" min="1" max="100000" step="1" value="' + esc(String(w0 && w0.burst != null ? w0.burst : "")) + '" placeholder="auto">'
      +   '<label for="' + fid + 'm">Max body</label>'
      +   '<input id="' + fid + 'm" class="ew-body" type="number" min="0" max="1024" step="0.1" value="' + esc(String(w0 && w0.maxBodyMb != null ? w0.maxBodyMb : "")) + '" placeholder="off"> MB'
      +   '<label class="ew-scanlbl"><input type="checkbox" class="ew-scan"' + (w0 && w0.blockScanners ? " checked" : "") + '> Block scanner paths <abbr title="drop obvious probe paths (/wp-admin, /.env, .php…) before they reach the app">?</abbr></label>'
      +   '<button class="btn btn-sm btn-primary ew-go" type="button">Apply</button>'
      + '</div>'
      + '<div class="term enc-waf-status" role="status" aria-live="polite"></div>';
    const st = box.querySelector(".enc-waf-status"), go = box.querySelector(".ew-go");
    const en = box.querySelector(".ew-en"), rIn = box.querySelector(".ew-rps"),
          bIn = box.querySelector(".ew-burst"), mIn = box.querySelector(".ew-body"), sc = box.querySelector(".ew-scan");
    const paint = (cls, txt) => paintLine(st, cls, txt);
    const liveEdit = !!(avail && avail.configEdit === true);
    const applyWord = liveEdit ? "a running app picks it up live within ~a minute (no restart)"
                               : "it applies at the app’s next relaunch or claim";
    const intro = () => {
      st.innerHTML = "";
      paint("info", w0 ? "// tuning the existing protection - " + applyWord
                       : "// this deployment launched without protection; enabling it needs one owner signature - " + applyWord);
      if ("config" in cur) paint("dimln", "// the deployment’s app-config override is preserved untouched");
    };
    // mirror the deploy form's clamps; burst empty = auto (4s of the rate)
    const spec = () => {
      const num = (el, lo, hi, dflt) => { const v = parseFloat(el && el.value); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt; };
      const w = { rps: num(rIn, 0.1, 10000, 10) };
      const burst = parseFloat(bIn && bIn.value);
      w.burst = Number.isFinite(burst) ? Math.round(Math.min(100000, Math.max(1, burst))) : Math.max(5, Math.ceil(w.rps * 4));
      const body = num(mIn, 0, 1024, 0);
      if (body > 0) w.maxBodyMb = body;
      if (sc && sc.checked) w.blockScanners = true;
      return w;
    };
    const sync = () => { const on = en.checked; [rIn, bIn, mIn, sc].forEach(el => { if (el) el.disabled = !on; });
      const next = { ...cur }; if (en.checked) next.waf = spec(); else delete next.waf;
      const env = Object.keys(next).length ? JSON.stringify(next) : "";
      go.disabled = env === raw;
      go.textContent = !en.checked && w0 ? "Remove protection" : w0 ? "Apply changes" : "Enable protection";
    };
    [en, rIn, bIn, mIn, sc].forEach(el => el && el.addEventListener("input", sync));
    intro(); sync();
    go.addEventListener("click", async () => {
      const next = { ...cur };
      if (en.checked) next.waf = spec(); else delete next.waf;
      const envelope = Object.keys(next).length ? JSON.stringify(next) : "";
      if (envelope === raw) return;
      const cap = rev >= 5 ? 4096 : 100;
      if (new TextEncoder().encode(envelope).length > cap)
        return paint("warn", "[x] the options envelope (protection + config override) is over this ledger’s " + cap + "-byte cap - trim the config override first");
      go.disabled = true;
      const via = ctlOf((this._list || []).find(x => x.id === id)) === "vault";
      const doneWord = en.checked ? (w0 ? "protection updated" : "protection enabled") : "protection removed";
      try {
        if (via){
          // credit-vault row: the vault owns the deployment - one
          // passkey-signed controlDeployment(setConfig) op via the relay
          paint("info", "[*] confirm with your passkey…");
          const { vaultOp } = await import("../../js/core/vault.js");
          await vaultOp("control", { id, action: "options", envelope });
        } else {
          // setConfig is owner-gated on-chain - a connected wallet is all
          // this needs; the envelope rides one transaction
          if (!Enclave.provider){ paint("info", "[*] connecting wallet…"); await connectWallet(); }
          await ensureBaseChain();
          paint("info", "[*] confirm the transaction in your wallet…");
          const th = await sendTx(DEPLOYMENTS_ADDRESS,
            encCall(DEP_SEL.setConfig, [{ t: "bytes32", v: id }, { t: "str", v: envelope }]));
          paint("dimln", "  ↳ sent " + th + " · waiting for confirmation…");
          await waitReceipt(th);
        }
        paint("ok", "[✓] " + doneWord + " - " + applyWord);
        showToast(doneWord + " on " + id.slice(0, 10) + "…");
        this._wafLearn(id, envelope);          // the row badge reflects the new envelope immediately
        setTimeout(() => { if (box.isConnected && !box.hidden){ box.hidden = true; box.innerHTML = ""; btn.setAttribute("aria-expanded", "false"); } }, 3500);
      } catch(e){
        const rejected = (e && e.code === 4001) || /reject|denied|declin|cancell/i.test(e && e.message || "");
        paint("warn", rejected ? (via ? "[x] cancelled - nothing changed" : "[x] rejected in wallet - nothing changed") : "[x] " + (e.message || String(e)));
        go.disabled = false;
      } finally { if (!via) refreshWallet(); }
    });
  }

  /* ---- per-row Secrets section: private env vars, relay-stored ----
     S3 keys and API tokens live on the RELAY (encrypted at rest), never on the
     public chain; the enclave holding the lease injects them as env vars at
     every app start. No session: each owner op is one single-use personal_sign
     over a canonical string the relay checks against the on-chain owner -
       get:  enclave-secrets:get:<id>:<expiry>
       put:  enclave-secrets:put:<id>:<expiry>:<sha256hex(payload)>
     The bar renders permanently (secretsSection); this wires its Unlock/Lock
     control. Reveal-first on purpose: Save REPLACES the whole set, and saving
     blind over unseen keys is how secrets get wiped by accident, so the editor
     only exists after a reveal signature has shown what's stored. ---- */
  _secretsWire(box) {
    const id = box.dataset.id;
    const ta = box.querySelector(".es-ta"), toggle = box.querySelector(".es-toggle"),
          body_ = box.querySelector(".enc-sec-body"), save = box.querySelector(".es-save"),
          st = box.querySelector(".enc-sec-status");
    if (!id || !ta || !toggle || !body_ || !save || !st) return;
    const paint = (cls, txt) => paintLine(st, cls, txt);
    // dotenv-style value quoting, both directions: the reveal renders every
    // value as KEY="…" (with " and \ escaped), and the parser strips one layer
    // of matched quotes ('single' = literal, "double" = \" \\ unescape). Bare
    // KEY=value still works; the quotes are a client convention only - the
    // relay stores the unquoted value.
    const quo = (v) => '"' + String(v).replace(/(["\\])/g, "\\$1") + '"';
    const unq = (v) => {
      const dq = /^"([\s\S]*)"$/.exec(v); if (dq) return dq[1].replace(/\\(["\\])/g, "$1");
      const sq = /^'([\s\S]*)'$/.exec(v); if (sq) return sq[1];
      return v;
    };
    const sha256hex = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))]
      .map(b => b.toString(16).padStart(2, "0")).join("");
    const sign = async (message) => {
      if (!Enclave.provider){ paint("info", "[*] connecting wallet…"); await connectWallet(); }
      return Enclave.provider.request({ method: "personal_sign", params: [message, Enclave.address] });
    };
    const call = async (path, body) => {
      const r = await fetch(Enclave.base + path, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message || j.error || ("HTTP " + r.status));
      return j;
    };
    let hadKeys = 0, armedClear = false;
    // One control, two states. Unlock: sign the get, fill the editor, show the
    // body. Lock: wipe the values and collapse back to the bare bar (what's
    // stored is untouched; nothing is sent).
    toggle.addEventListener("click", async () => {
      if (toggle.dataset.open) {
        ta.value = "";
        body_.hidden = true;
        delete toggle.dataset.open;
        toggle.textContent = "Unlock ↓";
        toggle.title = "One wallet signature reveals this deployment’s stored secrets for editing";
        toggle.setAttribute("aria-expanded", "false");
        armedClear = false; save.textContent = "Save";
        st.innerHTML = "";
        return;
      }
      toggle.disabled = true;
      try {
        paint("info", "[*] one signature reveals this deployment’s stored secrets…");
        const expiry = Math.floor(Date.now() / 1000) + 300;
        const signature = await sign("enclave-secrets:get:" + id + ":" + expiry);
        const r = await call("/secrets/" + id + "/get", { expiry, signature });
        hadKeys = r.names.length;
        ta.value = r.names.map(n => n + "=" + quo(r.env[n])).join("\n");
        body_.hidden = false;
        toggle.dataset.open = "1";
        toggle.textContent = "Lock";
        toggle.title = "Hide the revealed values (what’s stored is untouched)";
        toggle.setAttribute("aria-expanded", "true");
        toggle.disabled = false;
        ta.focus();
        paint("ok", r.names.length
          ? "[✓] rev " + r.rev + " · " + r.names.length + " secret" + (r.names.length === 1 ? "" : "s") + " - edit below, then Save (replaces the whole set)"
          : "[✓] nothing stored yet - add KEY=value lines below, then Save");
        // fleet advisory - the relay stores regardless; injection needs the fleet
        try {
          const a = await Enclave.getAvailability();
          if (a && a.aggregate && a.secrets !== true)
            paint("dimln", "// heads-up: the live fleet doesn’t inject secrets yet - values you store apply once it updates");
        } catch(e){}
      } catch(e){
        paint("warn", "[x] " + (e.message || String(e)));
        toggle.disabled = false;
      }
    });
    save.addEventListener("click", async () => {
      const set = {};
      try {
        for (let line of ta.value.split("\n")) {
          line = line.trim();
          if (!line || line.startsWith("#")) continue;
          const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
          if (!m) throw new Error('"' + (line.length > 40 ? line.slice(0, 37) + "…" : line) + '" is not KEY=value');
          if (/^ENCLAVE_/i.test(m[1])) throw new Error(m[1] + ": the ENCLAVE_ prefix is reserved for platform variables");
          set[m[1]] = unq(m[2]);
        }
      } catch(e){ return paint("warn", "[x] " + e.message); }
      if (!Object.keys(set).length && hadKeys && !armedClear) {
        armedClear = true; save.textContent = "Really clear all?";
        return paint("warn", "[!] the textarea is empty - Save again to remove all " + hadKeys + " stored secret" + (hadKeys === 1 ? "" : "s"));
      }
      save.disabled = true;
      try {
        paint("info", "[*] one signature stores the set…");
        const payload = JSON.stringify({ clear: true, ...(Object.keys(set).length ? { set } : {}) });
        const expiry = Math.floor(Date.now() / 1000) + 300;
        const signature = await sign("enclave-secrets:put:" + id + ":" + expiry + ":" + await sha256hex(payload));
        const r = await call("/secrets/" + id, { payload, expiry, signature });
        hadKeys = r.names.length; armedClear = false; save.textContent = "Save";
        const running = ((this._list || []).find(x => x.id === id) || {}).status === "running";
        paint("ok", "[✓] stored rev " + r.rev + (r.names.length ? " · " + r.names.join(", ") : " · empty")
          + (running ? " - Restart applies it to the running app" : " - the app picks it up when it starts"));
        showToast("secrets updated for " + id.slice(0, 10) + "…");
      } catch(e){
        const rejected = (e && e.code === 4001) || /reject|denied|declin|cancell/i.test(e && e.message || "");
        paint("warn", rejected ? "[x] rejected in wallet - nothing changed" : "[x] " + (e.message || String(e)));
      } finally { save.disabled = false; }
    });
  }

  /* ---- per-row Domains: attach a hostname you own ------------------------
     Four signed calls (list/add/verify/delete), each an EIP-191 personal_sign
     the relay checks against the deployment's on-chain owner - the secrets
     convention, same shapes:
       list:   enclave-domains:list:<id>:<expiry>
       add:    enclave-domains:add:<id>:<expiry>:<hostname>
       verify: enclave-domains:verify:<id>:<expiry>:<hostname>
       delete: enclave-domains:del:<id>:<expiry>:<hostname>
     The hostname in a signed message is the NORMALIZED one, so the client
     normalizes before signing and the relay re-normalizes before checking -
     "EXAMPLE.com " must not produce a signature over a string no record will
     ever match again.
     While the panel is open it re-lists every 30s WITHOUT a signature prompt,
     reusing the one the customer already gave until it expires - watching
     pending_dns become live is the whole point of the panel, and a wallet
     popup every 30s is not a feature anyone would use. The relay exempts the
     LIST read from its single-use rule for exactly this (mutations stay
     single-use, so every one of those drops the cached signature). */
  _domainsWire(box) {
    const id = box.dataset.id;
    const toggle = box.querySelector(".ed-toggle"), body_ = box.querySelector(".enc-dom-body"),
          list = box.querySelector(".ed-list"), input = box.querySelector(".ed-in"),
          add = box.querySelector(".ed-add-btn"), st = box.querySelector(".enc-dom-status");
    if (!id || !toggle || !body_ || !list || !input || !add || !st) return;
    const paint = (cls, txt) => paintLine(st, cls, txt);
    const sign = async (message) => {
      if (!Enclave.provider){ paint("info", "[*] connecting wallet…"); await connectWallet(); }
      return Enclave.provider.request({ method: "personal_sign", params: [message, Enclave.address] });
    };
    const call = async (path, body) => {
      const r = await fetch(Enclave.base + path, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message || j.error || ("HTTP " + r.status));
      return j;
    };
    // Same normalization the relay applies, so what gets signed is what gets
    // stored. Deliberately lenient about what it ACCEPTS (a pasted URL, a
    // trailing dot) and strict about what it EMITS.
    const norm = (s) => String(s || "").trim().toLowerCase()
      .replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.+$/, "");
    let timer = null, listSig = null;   // { expiry, signature } reused by the poll

    const render = (r) => {
      const rows = r.domains || [];
      list.innerHTML = rows.length ? rows.map(domainRow).join("")
        : '<div class="ed-empty">No domains attached. Add one below and this app will serve it '
          + 'on your own name, with a certificate minted inside the enclave.</div>';
      $$(".ed-copy", list).forEach(b => b.addEventListener("click", () => copyText(b.dataset.copy)));
      $$(".ed-check", list).forEach(b => b.addEventListener("click", () =>
        act("verify", b.closest(".ed-row").dataset.host, b)));
      $$(".ed-del", list).forEach(b => b.addEventListener("click", () =>
        act("delete", b.closest(".ed-row").dataset.host, b)));
      const pending = rows.filter(d => d.status !== "active").length;
      if (rows.length) paint("dimln", "// " + rows.length + " of " + r.limit + " attached"
        + (pending ? " · " + pending + " waiting on DNS or a certificate - re-checked automatically" : " · all live"));
      else st.innerHTML = "";
    };

    const refresh = async ({ interactive = true } = {}) => {
      const now = Math.floor(Date.now() / 1000);
      if (!listSig || listSig.expiry <= now + 10) {
        if (!interactive) return;                       // poll: never prompt, just wait for the next user action
        const expiry = now + 300;
        listSig = { expiry, signature: await sign("enclave-domains:list:" + id + ":" + expiry) };
      }
      render(await call("/domains/" + id + "/list", listSig));
    };

    // add/verify/delete: one signature each, then re-list. The re-list needs a
    // FRESH signature (the relay makes every owner signature single-use), so
    // the cached one is dropped whenever a mutation lands.
    const act = async (kind, hostname, btn) => {
      const host = norm(hostname);
      if (!host) return paint("warn", "[x] enter a hostname");
      if (btn) btn.disabled = true;
      try {
        const expiry = Math.floor(Date.now() / 1000) + 300;
        const msg = { add: "enclave-domains:add:", verify: "enclave-domains:verify:", delete: "enclave-domains:del:" }[kind]
                  + id + ":" + expiry + ":" + host;
        paint("info", "[*] one signature " + { add: "attaches", verify: "re-checks", delete: "detaches" }[kind] + " " + host + "…");
        const signature = await sign(msg);
        const path = "/domains/" + id + (kind === "add" ? "" : "/" + kind);
        const r = await call(path, { hostname: host, expiry, signature });
        listSig = null;
        if (kind === "delete") {
          paint("ok", "[✓] " + host + " detached - remove its DNS records at your provider too");
          showToast(host + " detached");
        } else if (r.status === "active" || r.status === "verified") {
          paint("ok", "[✓] " + host + " verified" + (r.status === "active" ? " and live" : " - the certificate is being minted, usually within a minute"));
        } else {
          paint("warn", "[!] " + host + " attached · " + (r.lastError || "create the DNS records below; we re-check every few minutes"));
        }
        if (kind === "add") input.value = "";
        await refresh();
        // fleet advisory, exactly like secrets: the relay stores regardless,
        // but serving the name needs runners that know the feature
        try {
          const a = await Enclave.getAvailability();
          if (a && a.aggregate && a.customDomains !== true)
            paint("dimln", "// heads-up: the live fleet doesn’t serve custom domains yet - this one starts working once it updates");
        } catch(e){}
      } catch(e){
        const rejected = (e && e.code === 4001) || /reject|denied|declin|cancell/i.test(e && e.message || "");
        paint("warn", rejected ? "[x] rejected in wallet - nothing changed" : "[x] " + (e.message || String(e)));
      } finally { if (btn) btn.disabled = false; }
    };

    toggle.addEventListener("click", async () => {
      if (toggle.dataset.open) {
        body_.hidden = true; delete toggle.dataset.open;
        toggle.textContent = "Domains ↓";
        toggle.setAttribute("aria-expanded", "false");
        st.innerHTML = ""; list.innerHTML = ""; listSig = null;
        clearInterval(timer); timer = null;
        return;
      }
      toggle.disabled = true;
      try {
        paint("info", "[*] one signature lists this deployment’s domains…");
        await refresh();
        body_.hidden = false;
        toggle.dataset.open = "1";
        toggle.textContent = "Hide";
        toggle.setAttribute("aria-expanded", "true");
        // While it's open, keep the statuses moving on their own - the whole
        // point of the panel is watching pending_dns become live.
        clearInterval(timer);
        timer = setInterval(() => refresh({ interactive: false }).catch(() => {}), 30000);
      } catch(e){
        paint("warn", "[x] " + (e.message || String(e)));
      } finally { toggle.disabled = false; }
    });
    add.addEventListener("click", () => act("add", input.value, add));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); act("add", input.value, add); } });
  }

  /* ---- per-row Output panel: recorded deploy narrative + live app logs ---- */
  _output(id, btn) {
    const row = btn.closest(".enc-row"), box = row && row.querySelector(".enc-out"); if (!box) return;
    if (!box.hidden) { box.hidden = true; box.innerHTML = ""; this._stopLogPoll(id); btn.setAttribute("aria-expanded", "false"); return; }
    box.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    // logs are NOT a live region: each poll replaces them wholesale (a live region would re-announce all 200 lines every 5s)
    box.innerHTML = '<div class="ap-attbar">output · ' + esc(id) + '</div>'
      + '<div class="term enc-out-term">'
      +   '<div class="enc-out-info"></div>'
      +   '<div class="enc-out-nar"></div>'
      +   '<div class="enc-out-logs" role="log" aria-live="off" aria-label="Deployment logs" tabindex="0"><span class="ln dimln">// fetching app logs…</span></div>'
      + '</div>';
    const nar = box.querySelector(".enc-out-nar"), scroller = box.querySelector(".enc-out-term");
    // lead with the OUTSIDE view - the app's reachable endpoints - because the
    // logs below speak in enclave-internal bind ports that match nothing out here
    const info = box.querySelector(".enc-out-info");
    const d = (this._list || []).find(x => x.id === id);
    if (info && d){
      const ep = appEndpoint(d);
      if (ep) paintLine(info, "ok", "→ reachable at " + ep + (d.public ? "" : "   (private · owner token required)"), scroller);
      const net = d.network || {};
      const tcp = (net.tcp && net.tcp.ports) || [], udp = (net.udp && net.udp.ports) || [];
      if (net.address)
        paintLine(info, "info", "→ dedicated IPv6 [" + net.address + "]"
          + (tcp.length ? " · tcp " + tcp.join(",") : "") + (udp.length ? " · udp " + udp.join(",") : "")
          + ((tcp.length || udp.length) ? "   (served at these real port numbers)" : "   (outbound egress address - no inbound ports declared)"), scroller);
      paintLine(info, "dimln", "// any 127.0.0.1:<port> below is the app's internal bind inside the enclave - from outside, use the endpoints above", scroller);
    }
    const run = runlog.runFor(id);
    if (run) {
      paintLine(nar, "dimln", "// deploy narrative · " + run.label + " (recorded in this browser)", scroller);
      run.lines.forEach(l => paintLine(nar, l[0], l[1], scroller));
    }
    if (ctlOf(d) !== "wallet") this._noteLogs(box);
    else if (Enclave.authed()) this._startLogs(id, box);
    else this._lockedLogs(id, box);
  }
  /* vault-owned rows: the enclaves' log read rides the in-enclave WALLET
     session (the credit vault is the on-chain owner, and only IT could prove
     ownership - ERC-1271 session support is tracked follow-up work). Honest
     note instead of an unlock that could never succeed. */
  _noteLogs(box) {
    const el = box.querySelector(".enc-out-logs"); if (!el) return;
    el.innerHTML = '<span class="ln dimln">// app logs for credit-run deployments are coming soon - today the log channel rides an in-enclave wallet session. The endpoints above are live now.</span>';
  }
  _startLogs(id, box) {
    this._fetchLogs(id, box);
    this._stopLogPoll(id);
    this._logPolls[id] = setInterval(() => {
      if (box.hidden || !box.isConnected) { this._stopLogPoll(id); return; }
      this._fetchLogs(id, box);
    }, 5000);
  }
  /* logs are the one genuinely PRIVATE read on this panel (an app's stdout
     routinely carries secrets), so this is where the lazy SIWE lives: prove
     key ownership once - a gas-free signature - right where it's needed */
  _lockedLogs(id, box) {
    const el = box.querySelector(".enc-out-logs"); if (!el) return;
    el.innerHTML = '<span class="ln dimln">// app logs are owner-private - one gas-free signature proves this wallet owns this deployment (lasts a week)</span>'
      + '<button class="wp-mini enc-unlock" type="button">unlock logs</button>';
    el.querySelector(".enc-unlock").addEventListener("click", async () => {
      try { await authenticate(); if (!box.hidden && box.isConnected) this._startLogs(id, box); }
      catch(e){ showToast(e.message || String(e)); }
    });
  }
  _stopLogPoll(id) {
    if (this._logPolls && this._logPolls[id]) { clearInterval(this._logPolls[id]); delete this._logPolls[id]; }
  }
  async _fetchLogs(id, box) {
    const el = box.querySelector(".enc-out-logs"), scroller = box.querySelector(".enc-out-term");
    if (!el) return;
    try {
      const text = await this._asHost(id, (h) => Enclave.logs(id, { tail: 200 }, h));
      if (box.hidden || !el.isConnected) return;
      const lines = String(text == null ? "" : text).split("\n");
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      // wholesale replace each poll; keep the reader's place unless they're tailing
      const follow = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
      const keep = scroller.scrollTop;
      el.innerHTML = '<span class="ln dimln">// app logs (stdout/stderr from the enclave · tail 200 · refreshes while open)</span>';
      if (!lines.length) el.insertAdjacentHTML("beforeend", '<span class="ln dimln">// (no output yet)</span>');
      for (const ln of lines) {
        const s = document.createElement("span");
        // enclave-internal noise (loopback/wildcard binds) reads dim; real app output full-strength
        s.className = "ln " + (/127\.0\.0\.1|0\.0\.0\.0/.test(ln) ? "dimln" : "logln");
        s.textContent = ln; el.appendChild(s);
      }
      scroller.scrollTop = follow ? scroller.scrollHeight : keep;
    } catch (e) {
      if (el.isConnected && !box.hidden)
        el.innerHTML = '<span class="ln warn">// logs unavailable: ' + esc(e.message || String(e)) + '</span>';
    }
  }

  async _verify(id, btn) {
    const row = btn.closest(".enc-row"), box = row && row.querySelector(".enc-att"); if (!box) return;
    if (!box.hidden){ box.hidden = true; box.innerHTML = ""; btn.setAttribute("aria-expanded", "false"); return; }
    box.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    if (ctlOf((this._list || []).find(x => x.id === id)) !== "wallet"){
      // vault/order rows: the per-deployment attestation read rides an
      // in-enclave wallet session the account doesn't hold - honest note
      // (ERC-1271 passkey sessions are the tracked follow-up)
      box.innerHTML = '<div class="ap-attbar">attestation · ' + esc(id) + '</div>'
        + '<div class="term"><span class="ln dimln">// in-browser attestation verification for credit-run deployments is coming soon - today the attestation read rides an in-enclave wallet session. The same hardware guarantees protect this deployment; verification just can’t be shown here yet.</span></div>';
      return;
    }
    if (!Enclave.authed()){
      // the attestation read rides the owner session; unlock it in place
      box.innerHTML = '<div class="ap-attbar">attestation · ' + esc(id) + '</div>'
        + '<div class="term"><span class="ln dimln">// attestation reads ride the owner session - one gas-free signature unlocks them (lasts a week)</span>'
        + '<button class="wp-mini enc-unlock" type="button">unlock &amp; verify</button></div>';
      box.querySelector(".enc-unlock").addEventListener("click", async () => {
        try { await authenticate(); if (!box.hidden && box.isConnected) this._attest(id, box); }
        catch(e){ showToast(e.message || String(e)); }
      });
      return;
    }
    this._attest(id, box);
  }
  async _attest(id, box) {
    box.innerHTML = '<div class="ap-attbar">attestation · ' + esc(id)
      + '<span class="enc-vbadge">⏳ verifying in your browser…</span></div>'
      + '<pre class="ap-attpre">fetching…</pre>';
    const badge = box.querySelector(".enc-vbadge");
    try {
      const att = await this._asHost(id, (h) => Enclave.attestation(id, h));
      const pre = box.querySelector(".ap-attpre"); if (pre) pre.innerHTML = hlJson(att);
      const vspec = vspecOf(att);
      if (!vspec){ if (badge) badge.textContent = ""; return; }
      // the badge is computed HERE, in the customer's browser; the API's
      // verification.selfCheck is the enclave's own (labeled) diagnostic.
      try {
        const r = await verifyEnclaveInBrowser(vspec);
        if (!badge || box.hidden) return;
        if (r.ok){
          badge.className = "enc-vbadge ok"; badge.textContent = "✓ verified in your browser";
          badge.title = "hardware report → silicon vendor's root of trust (AMD SEV-SNP on today's fleet; Intel TDX via DCAP), Sigstore release provenance, measurement match and cert binding, checked client-side against " + r.repo + " (enclave " + r.host + ")";
        } else {
          badge.className = "enc-vbadge bad"; badge.textContent = "✗ not verified: " + (r.error || "check failed");
        }
      } catch(e){ if (badge && !box.hidden){ badge.className = "enc-vbadge bad"; badge.textContent = "✗ could not verify: " + (e.message || e); } }
    }
    catch(e){ const pre = box.querySelector(".ap-attpre"); if (pre) pre.textContent = e.message; if (badge) badge.textContent = ""; }
  }

  async _kill(id, btn) {
    const onchain = /^0x[0-9a-f]{64}$/i.test(id);
    if (btn){ btn.disabled = true; btn.textContent = onchain ? "suspending…" : "terminating…"; }
    if (ctlOf((this._list || []).find(x => x.id === id)) === "vault"){
      // vault-owned row: setActive(false) goes through the vault contract,
      // passkey-signed - the runner's owner-stop watcher sees the ledger flip
      // and tears the app down within a minute (same suspend semantics)
      try {
        const { vaultOp } = await import("../../js/core/vault.js");
        await vaultOp("control", { id, action: "suspend" });
        showToast("suspended " + id.slice(0, 10) + "… - the remaining balance stays on it; Resume restarts it any time");
        setTimeout(() => this.refresh(), 900);
      } catch(e){ showToast(e.message || String(e)); if (btn){ btn.disabled = false; btn.textContent = "Suspend"; } }
      return;
    }
    try {
      // On-chain deployments (bytes32 ids) are WORK ITEMS: the enclave DELETE
      // only releases the current lease - any enclave would re-claim while the
      // record stays active and funded. A real stop is the owner's
      // setActive(false) on the ledger (one wallet tx), then the enclave release.
      // The remaining balance stays on the record and setActive(true) re-queues
      // it, so for on-chain rows this is a SUSPEND, not an end.
      if (onchain){
        showToast("confirm setActive(false) in your wallet - this suspends the app and takes it off the queue");
        await ensureBaseChain();
        const th = await sendTx(DEPLOYMENTS_ADDRESS, "0x" + DEP_SEL.setActive + pad32(id.replace(/^0x/, "")) + encUint(0));
        await waitReceipt(th);
      }
      const r = await this._asHost(id, (h) => Enclave.terminateDeployment(id, h)).catch(e => {
        // the enclave's owner-stop watcher may already have torn it down
        if (onchain) return null;
        throw e;
      });
      showToast(onchain
        ? "suspended " + id.slice(0, 10) + "… - the remaining balance stays on it; Resume restarts it any time"
        : (r && r.status === "terminated" ? "terminated " : "terminating ") + id);
      setTimeout(() => this.refresh(), 900);
    }
    catch(e){ showToast(e.message); if (btn){ btn.disabled = false; btn.textContent = onchain ? "Suspend" : "Terminate"; } }
  }

  /* Cancel a deployment and send its unused runtime back (ledger rev 10).

     The whole point of this handler is to be honest about the number. What the
     contract can return is what it still HOLDS for the record - the host's
     escrow - and NOT the balance on the row: the publisher fee and the platform
     share were forwarded to their wallets the moment the deployment was funded,
     and no contract can pull them back. So the quote comes from refundableOf()
     (which is exact, not an estimate) and the dialog names the shortfall
     explicitly rather than letting the balance imply the payout.

     Unlike Suspend this is one-way: the ledger zeroes the balance and
     deactivates the record. Re-funding it later is possible but buys new time
     at the price of the day, so the confirm has to read like an ending. */
  async _refund(id, btn){
    const row = (this._list || []).find(x => x.id === id);
    const vault = ctlOf(row) === "vault";
    const where = vault ? "your credit balance" : "your wallet";
    const orig = btn ? btn.textContent : "Cancel";
    if (btn){ btn.disabled = true; btn.textContent = "checking…"; }
    try {
      if ((await depSchemaRev()) < 10) throw new Error("this ledger predates refunds - suspend it instead, or contact support");
      const [amount6, d] = await Promise.all([depRefundableOf(id), depGet(id)]);
      const bal6 = d ? BigInt(d.balance6 || 0) : 0n;
      const leased = d && Number(d.leaseUntil) * 1000 > Date.now();
      if (!(amount6 > 0n))
        throw new Error(leased
          ? "nothing refundable yet - everything still held is reserved for the running lease. Suspend it and try again once the host hands the lease back."
          : "nothing to refund - this deployment has already spent everything the contract held for it");
      const usd = (v) => "$" + (Number(v) / 1e6).toFixed(2);
      const lines = ["Cancel " + id.slice(0, 10) + "… and send " + usd(amount6) + " back to " + where + "?", ""];
      if (bal6 > amount6)
        lines.push("Its balance is " + usd(bal6) + ", but " + usd(bal6 - amount6) + " of that cannot be returned: the "
                 + "publisher fee and the platform share went to their wallets when you funded it. " + usd(amount6)
                 + " is what the contract still holds, and it is exactly what you will receive.", "");
      if (leased)
        lines.push("A lease is running. Its unearned time stays reserved for the host and becomes refundable once "
                 + "the host hands the lease back - cancel again then to collect the rest.", "");
      lines.push("The app stops and the deployment ends. This cannot be undone.");
      if (!confirm(lines.join("\n"))){ if (btn){ btn.disabled = false; btn.textContent = orig; } return; }

      if (btn) btn.textContent = "cancelling…";
      if (vault){
        // vault-owned row: the vault contract IS the record's on-chain owner, so
        // the refund lands in the holder's credit balance (passkey-signed)
        const { vaultOp } = await import("../../js/core/vault.js");
        await vaultOp("control", { id, action: "cancel" });
      } else {
        showToast("confirm the refund in your wallet - " + usd(amount6) + " comes back and the deployment ends");
        await ensureBaseChain();
        await waitReceipt(await sendTx(DEPLOYMENTS_ADDRESS, "0x" + DEP_SEL.refund + pad32(id.replace(/^0x/, ""))));
      }
      // the ledger already deactivated it; tear the instance down now rather
      // than waiting for the runner's next owner-stop sweep
      await this._asHost(id, (h) => Enclave.terminateDeployment(id, h)).catch(() => null);
      showToast("cancelled " + id.slice(0, 10) + "… - " + usd(amount6) + " returned to " + where);
      setTimeout(() => this.refresh(), 900);
    }
    catch(e){ showToast(e.message || String(e)); if (btn){ btn.disabled = false; btn.textContent = orig; } }
  }

  /* Which box HOSTS this deployment, and a session that box will honor.

     Sessions are per-enclave: every enclave signs with its own in-enclave key
     and verifies only its own kid, so the session minted at sign-in (the
     relay's sticky box) is rejected by every other enclave — a deployment
     hosted anywhere else answered "Missing or invalid session" on Restart,
     logs, attestation and Move alike (2026-07-27). One extra signature per box
     you act on is the honest price of that design; it is cached per box and
     survives a reload, so it is asked once. */
  async _hostSession(id) {
    const d = (this._list || []).find(x => x.id === id);
    const host = String((d && d.enclave) || "").trim();
    if (!host){ if (!Enclave.authed()) await authenticate(); return ""; }
    if (!Enclave.authedFor(host)) await authenticate({ enclave: host });
    return host;
  }

  /* Run an owner-authenticated call against the box HOSTING this deployment,
     re-signing once if that box rejects the session.

     A cached session can be one this enclave will never honour — minted on
     another box before the sign-in pin existed, or when the pin fell back.
     _req drops it on the 401, so a single retry re-mints against the right
     enclave and succeeds. Without the retry the user just sees "Missing or
     invalid session" forever, because nothing ever evicts the bad token. */
  async _asHost(id, call) {
    const host = await this._hostSession(id);
    try { return await call(host); }
    catch (e) {
      if (e && e.status === 401 && host && !Enclave.authedFor(host)) {
        await authenticate({ enclave: host });      // _req already dropped the stale one
        return await call(host);
      }
      throw e;
    }
  }

  /* ---- move a running deployment to another enclave.

     A lease can only be handed back by the box holding it
     (EnclaveDeployments.release is runner-only - the owner has no on-chain
     authority to evict), so a move is two steps: the owner asks the CURRENT
     runner to release, which refunds the unused lease tail to the deployment's
     balance and puts the record back in the open queue still active and
     funded; then the chosen box gets a claim hint and first crack at it.

     Nothing on-chain pins placement, so this is a STEER, not a guarantee. What
     makes it land is timing: the hinted box evaluates immediately while every
     other enclave only notices on its next sweep (CLAIM_POLL_SEC, 60s). We
     watch the ledger and report where it ACTUALLY went rather than assuming.

     Cost: the app stops and relaunches, so this is the same interruption as
     Restart plus a claim. No time is lost - release refunds, claim re-burns. ---- */
  async _move(id, btn) {
    const row = btn.closest(".enc-row"), box = row && row.querySelector(".enc-move"); if (!box) return;
    if (!box.hidden){ box.hidden = true; box.innerHTML = ""; btn.setAttribute("aria-expanded", "false"); return; }
    btn.setAttribute("aria-expanded", "true");
    box.hidden = false;
    box.innerHTML = '<div class="ap-attbar">move · ' + esc(id) + '</div>'
      + '<div class="term enc-move-status" role="status" aria-live="polite"><span class="ln dimln">// reading the ledger + fleet…</span></div>';
    const stEl = () => box.querySelector(".enc-move-status");
    const fail = (msg) => { const s = stEl(); if (s){ s.innerHTML = ""; paintLine(s, "warn", msg); } };
    let d = null, fleet = null;
    try {
      [d, fleet] = await Promise.all([depGet(id), Enclave.getEnclaves().catch(() => null)]);
      await loadCatalog();
      await Enclave.getAvailability().then(a => adoptServerSpec(a)).catch(() => null);
    } catch(e){ d = null; }
    if (box.hidden || !box.isConnected) return;             // closed while loading
    if (!d) return fail("[x] couldn’t read this deployment from the ledger - try again shortly");
    if (!fleet || !fleet.length) return fail("[x] couldn’t read the fleet list - try again shortly");
    const here = leaseHostOf(d, fleet);
    // The app's own requirements decide where it can go. A catalog deployment
    // carries its version's spec (hardware + model volumes); the deployment's
    // own config overrides the volume list, exactly as the deploy console does.
    const cr = parseCatalogRef(d.appRef);
    const ver = cr && STORE.byId[cr.appId] && STORE.byId[cr.appId].versions
      ? STORE.byId[cr.appId].versions[cr.index] : null;
    if (!ver) return fail("[x] the catalog doesn’t list this deployment’s version - a move re-claims the record, and only a listed version can be re-claimed");
    const spec = specOf(ver);
    // the DEPLOYMENT's own softening (its options envelope), distinct from the
    // publisher's in specOf: an envelope speaks for the owner's dial only
    const depSoftGpu = (() => {
      try { const o = JSON.parse(String(d.configCid || "") || "{}"); return o && o.gpu && o.gpu.optional === true; }
      catch { return false; }
    })();
    const targets = moveTargetsFor({ ...spec, depGpuOptional: depSoftGpu, gpuMilli: Number(d.gpuMilli) || 0 }, fleet, d.runner);
    if (!targets.length)
      return fail("[!] nowhere to move this to: " + moveBlockReason(spec, fleet, d.runner)
                + ". A move re-claims the record, so the destination must pass the same hardware, wasi-nn, model-volume and capacity checks as a fresh deploy.");
    const selId = "mvSel" + appLabel(id);
    box.innerHTML = '<div class="ap-attbar">move · ' + esc(id) + '</div>'
      + '<div class="enc-upg-body">'
      +   '<label for="' + selId + '">Move' + (here ? " off " + esc(here.name) : "") + ' to</label>'
      +   '<select class="eu-sel" id="' + selId + '">'
      +     targets.map((t, i) => '<option value="' + esc(t.name) + '"' + (i === 0 ? " selected" : "") + '>'
      +       esc(t.name)
      +       (t.queued ? " · full right now (waits in the queue)" : "")
      +       (t.cpuNn ? " · CPU only" : "")
      +     '</option>').join("")
      +   '</select>'
      +   '<button class="btn btn-sm mv-go">Move</button>'
      + '</div>'
      + '<div class="enc-upg-body mv-upg" hidden></div>'
      + '<div class="term enc-move-status" role="status" aria-live="polite"></div>';
    const sel = box.querySelector(".eu-sel"), go = box.querySelector(".mv-go");
    const s = stEl();
    paintLine(s, "dimln", "// the app stops here and relaunches there: same URL, version and balance.");
    paintLine(s, "dimln", "// unused lease time is refunded, then re-bought at the new box’s price.");
    paintLine(s, "dimln", "// HTTPS returns once the new box issues its own certificate for this URL (~1 min).");
    // Moving soft-GPU work ONTO a card: without re-buying the slice the app
    // would run on that box's CPU cores, which is the slow thing on the fast
    // machine. Offer the resize with the price attached, and make it the
    // default — landing on a GPU box and not using the GPU is almost never
    // what the move was for.
    const upgWrap = box.querySelector(".mv-upg");
    const bought = { gpuMilli: Number(d.gpuMilli) || 0, cpuMilli: Number(d.cpuMilli) || 0 };
    const syncUpg = () => {
      const t = targets.find((x) => x.name === sel.value);
      const vv = { ...spec, depGpuOptional: depSoftGpu };
      const up = t ? gpuUpgradeForMove(vv, t, bought.gpuMilli, bought.cpuMilli) : null;
      const down = t && !up ? gpuDowngradeForMove(vv, t, bought.gpuMilli, bought.cpuMilli) : null;
      const act = up || down;
      this._mvUpgrade = act ? { ...act, target: t, dir: up ? "up" : "down" } : null;
      if (!upgWrap) return;
      upgWrap.hidden = !act;
      if (!act) return;
      const price = enclavePriceOf(t.row);
      const nowPct = Math.max(1, Math.round(bought.cpuMilli / 10));
      const cur = shareRates(Math.round(bought.gpuMilli / 10), nowPct, t.spec, price).rate;
      const next = shareRates(act.gpuPct, act.cpuPct, t.spec, price).rate;
      upgWrap.innerHTML = '<label style="display:flex;gap:.5em;align-items:baseline;">'
        + '<input type="checkbox" class="mv-upg-on" checked /> '
        + (up
            ? '<span>buy ' + up.gpuPct + '% GPU on ' + esc(t.name) + ' so it uses the card'
              + ' <span class="dim">(' + up.cpuPct + '% CPU · $' + (next * 3600).toFixed(2) + '/hr, was $' + (cur * 3600).toFixed(2)
              + '/hr on cores) — one wallet signature before the move</span></span>'
            : '<span>drop the ' + Math.round(bought.gpuMilli / 10) + '% GPU share — ' + esc(t.name) + ' has no card'
              + ' <span class="dim">(keeps ' + act.cpuPct + '% CPU. The ledger already stops charging for a card this box'
              + ' does not have; dropping it stops the record asking every future claim for GPU hardware)'
              + ' — one wallet signature before the move</span></span>')
        + '</label>';
    };
    sel.addEventListener("change", syncUpg);
    syncUpg();
    go.addEventListener("click", () => this._doMove(id, sel.value, box, go, here && here.name));
  }

  /* the move itself: release on the current runner, then hint the target until
     the ledger shows a lease somewhere. Every step reports what the chain says,
     because a steer that lost its race is a normal outcome, not an error. */
  async _doMove(id, target, box, go, fromName) {
    const s = box.querySelector(".enc-move-status");
    const oldRunner = String((await depGet(id).catch(() => ({}))).runner || "").toLowerCase();
    go.disabled = true; go.textContent = "moving…";
    // Re-buy the card BEFORE handing the lease back, so the destination claims
    // the record already sized for its GPU and provisions once. Resizing after
    // the move would land it on cores first and restart it again to add the
    // card — two interruptions for one intent. A resize refused here (rate cap,
    // an older fleet) aborts the move with the app still running where it is.
    const upg = this._mvUpgrade;
    const wantUpg = upg && box.querySelector(".mv-upg-on")?.checked;
    if (wantUpg) {
      try {
        paintLine(s, "info", upg.dir === "down"
          ? `[*] dropping the GPU share for ${upg.target.name} (setShares)…`
          : `[*] buying ${upg.gpuPct}% GPU on ${upg.target.name} (setShares)…`);
        if (!Enclave.provider) await connectWallet();
        await ensureBaseChain();
        const th = await sendTx(DEPLOYMENTS_ADDRESS,
          encCall(DEP_SEL.setShares, [{ t: "bytes32", v: id }, { t: "uint", v: upg.gpuPct * 10 }, { t: "uint", v: upg.cpuPct * 10 }]));
        paintLine(s, "dimln", "    ↳ sent " + th + " · waiting for confirmation…");
        await waitReceipt(th);
        paintLine(s, "dimln", `    shares are now ${upg.gpuPct}% GPU / ${upg.cpuPct}% CPU`);
      } catch(e){
        paintLine(s, "warn", "[x] the resize did not go through: " + (e.message || e));
        paintLine(s, "dimln", "    nothing moved - the app keeps running where it is, on the shares it already had");
        go.disabled = false; go.textContent = "Move";
        return;
      }
    }
    try {
      // the release must be signed for the box HOLDING the lease — its session,
      // not the sign-in box's (see _hostSession)
      paintLine(s, "info", "[*] asking " + (fromName || "the current enclave") + " to hand the lease back…");
      // owner-authenticated release on the CURRENT runner. The relay routes
      // this to the lease holder; the record stays active and funded, so the
      // fleet may re-claim it immediately - which is the point.
      const rel = await this._asHost(id, (h) => Enclave.terminateDeployment(id, h, true));   // evacuate: stand down, don't re-take it
      paintLine(s, "dimln", "    released - unused lease time refunded to the balance"
        + (rel && rel.standDownSec ? `; ${fromName || "it"} stands down for ${rel.standDownSec}s so the move can land` : ""));
    } catch(e){
      paintLine(s, "warn", "[x] the current enclave would not release the lease: " + (e.message || e));
      paintLine(s, "dimln", "    nothing changed - the app keeps running where it is");
      go.disabled = false; go.textContent = "Move";
      return;
    }
    const ZERO = "0x" + "0".repeat(64);
    // The release is a TRANSACTION and the enclave answers before it is mined.
    // Hinting into a still-live lease makes the destination attempt a claim
    // that reverts "leased" — and a failed claim puts that box into its own
    // provisioning backoff, locking out the retry that would have worked. So
    // wait for the chain to say the lease is actually gone before hinting.
    paintLine(s, "dimln", "    waiting for the release to land on-chain…");
    let cleared = false;
    for (let i = 0; i < 30 && !cleared; i++){
      if (!box.isConnected) return;
      await new Promise(r => setTimeout(r, 2000));
      let d = null; try { d = await depGet(id); } catch(e){}
      const runner = String((d && d.runner) || "").toLowerCase();
      if (d && (!runner || runner === ZERO || !(Number(d.leaseUntil) * 1000 > Date.now()))) cleared = true;
    }
    if (!cleared){
      paintLine(s, "warn", "[!] the lease is still live on-chain after 60s - the release may not have been mined");
      paintLine(s, "dimln", "    nothing is lost: the app keeps running and its balance is intact. Try again shortly.");
      go.disabled = false; go.textContent = "Move";
      setTimeout(() => this.refresh(), 1200);
      return;
    }
    let landed = null, lastReason = "";
    for (let i = 0; i < 60 && !landed; i++){
      if (!box.isConnected) return;
      // Re-hint while we wait: the first hint can beat the release being
      // visible to the fleet's load-balanced RPC node and get declined, and a
      // funded record with no hint sits until someone's 60s sweep finds it.
      if (i % 4 === 0){
        try {
          const h = await Enclave.claimHint(id, target);
          if (h && h.accepted === false && h.reason && h.reason !== lastReason){
            lastReason = h.reason;
            paintLine(s, "warn", "[!] " + target + " declines: " + h.reason);
          }
        } catch(e){}
      }
      await new Promise(r => setTimeout(r, 2000));
      let d = null; try { d = await depGet(id); } catch(e){}
      const runner = String((d && d.runner) || "").toLowerCase();
      if (d && runner && runner !== ZERO && Number(d.leaseUntil) * 1000 > Date.now()
          && runner !== oldRunner) landed = d;
    }
    if (!landed){
      paintLine(s, "warn", "[!] no enclave has claimed it yet");
      paintLine(s, "dimln", "    the record is funded and in the open queue - the fleet's sweep picks it up within a minute. Watch the row.");
    } else {
      const fleet = await Enclave.getEnclaves().catch(() => null);
      const now = leaseHostOf(landed, fleet);
      const where = (now && now.name) || "another enclave";
      if (where.toLowerCase() === String(target).toLowerCase())
        paintLine(s, "ok", "[✓] running on " + where + " now");
      else {
        paintLine(s, "warn", "[!] claimed by " + where + ", not " + target);
        paintLine(s, "dimln", "    placement is a steer, not a lock - whichever eligible box claims first wins. Move again to retry.");
      }
    }
    go.disabled = false; go.textContent = "Move";
    setTimeout(() => this.refresh(), 1200);
  }

  /* ---- restart a running deployment in place: stop the app instance and
     relaunch it on the same version, lease and balance (no wallet tx - the
     enclave API does it under the owner session). The remedy for a wedged
     instance the crash detector can't see: the process answers, it just
     can't do its job - e.g. a tenant that booted before its model volume
     finished mounting and so can never load the model. App state is
     ephemeral by design, so a restart never loses anything but the wedge. ---- */
  async _restart(id, btn) {
    if (btn){ btn.disabled = true; btn.textContent = "restarting…"; }
    try {
      // owner-private action: rides the session token, lazy-SIWE like logs
      if (!Enclave.authed()) await authenticate();
      await this._asHost(id, (h) => Enclave.restartDeployment(id, h));
      showToast("restarted " + id.slice(0, 10) + "… - relaunching in place, back within a minute");
      setTimeout(() => this.refresh(), 1200);
    }
    catch(e){ showToast(e.message || String(e)); }
    finally { if (btn){ btn.disabled = false; btn.textContent = "Restart"; } }
  }

  /* ---- resume a suspended on-chain deployment: setActive(true) re-queues
     the work item (the balance never left it), then one claim-hint nudges the
     fleet so the relaunch doesn't wait for the next sweep - the ex-runner
     itself may re-adopt (terminated is CLAIM_TERMINAL). The app relaunches
     FRESH from its published version: suspend/resume preserves money, not
     memory (app state is ephemeral by design). An "expired" row's record
     usually never went inactive (expiry is the runner's word for a spent
     lease, not a ledger flip), so the ledger read below skips the no-op
     signature and the nudge alone re-queues it. ---- */
  async _resume(id, btn) {
    if (btn){ btn.disabled = true; btn.textContent = "resuming…"; }
    const via = ctlOf((this._list || []).find(x => x.id === id)) === "vault";
    try {
      // the same read that decides whether setActive is needed also carries
      // the balance, so the toast can send a drained owner to Top up instead
      // of promising a relaunch no enclave would claim
      let dep = null;
      try { dep = await depGet(id); } catch(e){}
      if (!dep || !dep.active){
        if (via){
          // vault-owned row: setActive(true) through the vault, passkey-signed
          const { vaultOp } = await import("../../js/core/vault.js");
          await vaultOp("control", { id, action: "resume" });
        } else {
          showToast("confirm setActive(true) in your wallet - this re-queues the app; billing resumes once it runs");
          await ensureBaseChain();
          const th = await sendTx(DEPLOYMENTS_ADDRESS, "0x" + DEP_SEL.setActive + pad32(id.replace(/^0x/, "")) + encUint(1));
          await waitReceipt(th);
        }
      }
      if (this._why) this._why.delete(id);   // a pre-suspend decline reason must not outlive the resume
      fetch(Enclave.base + "/claim-hint", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) }).catch(() => {});
      // the contract's claimable() boundary: below it no enclave ever claims
      const drained = dep && !(dep.balance6 >= dep.rate);
      showToast(drained
        ? "re-queued " + id.slice(0, 10) + "… - but its balance is spent, so no enclave will claim it: Top up to relaunch"
        : "resumed " + id.slice(0, 10) + "… - re-queued; an enclave picks it up shortly");
      setTimeout(() => this.refresh(), 900);
    }
    catch(e){ showToast(e.message); if (btn){ btn.disabled = false; btn.textContent = "Resume"; } }
  }

  _startPoll() {
    if (this._poll) return;
    this._poll = setInterval(() => {
      if (!Enclave.address && !Enclave.accountAuthed()){ this._stopPoll(); return; }
      if (this.querySelector(".enc-att:not([hidden]), .enc-out:not([hidden]), .enc-fund:not([hidden]), .enc-upg:not([hidden]), .enc-move:not([hidden]), .enc-waf:not([hidden]), .enc-sec-body:not([hidden]), .enc-dom-body:not([hidden]), .enc-mob-body:not([hidden])")) return;   // don't clobber an open attestation/output/top-up view
      this.refresh();
    }, 10000);
  }
  _stopPoll() { if (this._poll){ clearInterval(this._poll); this._poll = null; } }
}
register("c-deployments", Deployments);
