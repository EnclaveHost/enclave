/* ============================================================
   Featured slot - read side of EnclaveFeatured (per-view bids)
   + the editorial fallback while no contract is configured.

   The RANKING rule lives here by design (the contract escrows and
   settles; it does not rank): the winning campaign is the highest
   bidPerView6 that is active, still funded for at least one view,
   and whose app is currently approved + listed in the catalog -
   ties break to the older campaign. No standing campaign (or no
   contract in the address book) falls back to an editorial pick:
   the newest owner-endorsed app, so the slot is never dark.

   Views are metered by a beacon to the API gateway (deduped
   server-side per client per day); the catalog owner settles the
   counts on-chain. Only PAID campaigns beacon - the editorial
   fallback bills nobody.
   ============================================================ */
import { DEFAULT_API_BASE } from "./config.js";
import { featConfigured, featGetCampaigns, APPROVAL } from "./chain.js";
import { STORE, appVerified } from "./catalog.js";
import { emit, on } from "./util.js";

export const FEATURED = { campaigns: [], loaded: false, loading: false, at: 0 };
const FRESH_MS = 120000;

export async function loadCampaigns(force){
  if (!featConfigured()){ FEATURED.loaded = true; return; }
  if (FEATURED.loading || (FEATURED.loaded && !force && Date.now() - FEATURED.at < FRESH_MS)) return;
  FEATURED.loading = true;
  try {
    FEATURED.campaigns = await featGetCampaigns();
    FEATURED.loaded = true; FEATURED.at = Date.now();
    emit("enclave:featured", { type: "loaded" });
  } catch(e){
    // the slot is decorative: a failed read just leaves the editorial pick
    emit("enclave:featured", { type: "error", message: e.message || String(e) });
  }
  FEATURED.loading = false;
}

// deployable-by-anyone: mirrors the store grid's membership rule
const appDeployable = (a) => !!a && a.versions.length && a.active
  && a.versions.some(v => !v.yanked && v.approval === APPROVAL.approved);

/* the current occupant: { app, campaign } for a paid winner,
   { app, campaign:null } for the editorial pick, null when nothing shows */
export function pickFeatured(){
  if (!STORE.loaded || !STORE.apps.length) return null;
  if (FEATURED.loaded && FEATURED.campaigns.length){
    const standing = FEATURED.campaigns
      .filter(c => c.active && c.bidPerView6 > 0 && c.balance6 >= c.bidPerView6 && appDeployable(STORE.byId[c.appId]))
      .sort((x, y) => (y.bidPerView6 - x.bidPerView6) || (x.createdAt - y.createdAt));
    if (standing.length) return { app: STORE.byId[standing[0].appId], campaign: standing[0] };
  }
  const editorial = STORE.apps.filter(a => appDeployable(a) && appVerified(a))
    .sort((x, y) => y.updatedAt - x.updatedAt);
  return editorial.length ? { app: editorial[0], campaign: null } : null;
}

/* one metered view per app per page load; the gateway dedupes per client per
   day on top, so refresh-spam never drains an advertiser. Fire-and-forget:
   sendBeacon survives the soft navigation away. */
const _seen = new Set();
export function beaconView(appId){
  if (_seen.has(appId)) return;
  _seen.add(appId);
  try {
    const url = DEFAULT_API_BASE + "/featured-view";
    const body = JSON.stringify({ app: appId });
    // text/plain keeps the POST CORS-safelisted (no preflight - sendBeacon
    // can't answer one); the relay parses the body, not the content type
    if (!(navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: "text/plain" }))))
      fetch(url, { method: "POST", body, keepalive: true }).catch(() => {});
  } catch(e){}
}

// a mid-session address-book change (contract deployed/repointed) re-reads
on("enclave:addresses", ({ changed }) => {
  if (changed && changed.indexOf("FEATURED_ADDRESS") !== -1){
    FEATURED.loaded = false; FEATURED.loading = false;
    loadCampaigns(true);
  }
});
