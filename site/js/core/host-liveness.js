/* ============================================================
   Off-chain host liveness for the independent dashboard - the
   SAME rule the relay, the CLI and the host agents use
   (network/host-liveness.mjs; docs/network/host-liveness.md):

     ADMISSION  the registry at ONE agreed block (active; the
                caller's own filters: runs code, posts a price).
                Nothing here relaxes it.
     LIVENESS   evidence THIS page verified for that exact row:
                an operator-signed host capacity record
                (network/host-capacity.mjs verifyHostCapacity,
                bundled unmodified as /vendor/host-capacity.js),
                or the operator's own registry write within the
                rule's window (the transition evidence).

   A record counts only when it verifies against the agreed row
   for its hostId at the snapshot the prices come from: signer =
   that row's operator, the exact registered endpoint, the
   profile's chain, the registry the (address-book) binding names
   at that snapshot, the row active, not expired, at most 15
   minutes long, and not older than (or in conflict with) one
   this tab already accepted for that host and operator. Records
   are fetched from each admitted host's own endpoint
   (GET <endpoint>/v1/host/capacity) and from any capacity
   mirrors the profile names (GET <origin>/v1/host-capacity);
   no single source is required, and whatever a source returns
   is only a candidate - a mirror cannot vouch for anything.
   An HTTP 200 without a verified record is not liveness.

   Bounded: at most MAX_HOSTS hosts read, CONCURRENCY requests in
   flight, REQUEST_TIMEOUT_MS each, TOTAL_MS per call, size-capped
   bodies. Raw envelopes are kept in tab memory for REFRESH_MS
   and re-verified on every call; nothing is stored.
   ============================================================ */
import { hostLiveness, REGISTRY_UPDATE_WINDOW_SEC } from "../../../network/host-liveness.mjs";
import { INDEPENDENT, REGISTRY_ADDRESS } from "./config.js";
import { keccak256Utf8 } from "./keccak.js";

export const LIMITS = Object.freeze({ MAX_HOSTS: 48, CONCURRENCY: 6, REQUEST_TIMEOUT_MS: 4000, TOTAL_MS: 10000,
  HOST_BODY_BYTES: 64 * 1024, DIRECTORY_BODY_BYTES: 1024 * 1024, DIRECTORY_RECORDS: 256, REFRESH_MS: 60000 });
let L = LIMITS;
// where records are read (network/host-capacity-producer.mjs HOST_CAPACITY_PATH / DIRECTORY_CAPACITY_PATH; equality is
// pinned by test/site-host-liveness.test.mjs - the host side is not part of the browser bundle)
export const HOST_CAPACITY_PATH = "/v1/host/capacity", DIRECTORY_CAPACITY_PATH = "/v1/host-capacity";

let _vendor = null, _fetch = null, _floors = null;
const hostCache = new Map();        // hostId|endpoint -> { at, envelope | null, error | null }
const dirCache = new Map();         // origin -> { at, envelopes, error }
const vendor = () => (_vendor ||= import("/vendor/host-capacity.js").catch((e) => { _vendor = null; throw e; }));
const doFetch = (...a) => (_fetch || globalThis.fetch)(...a);
/* tests: the bundle as a module object, a fetch, a fresh tab */
export function _setForTests({ vendorModule, fetchImpl, limits } = {}){
  if (vendorModule) _vendor = Promise.resolve(vendorModule);
  if (fetchImpl) _fetch = fetchImpl;
  L = Object.freeze({ ...LIMITS, ...(limits || {}) });
  _floors = null; hostCache.clear(); dirCache.clear();
}

const runsCode = (h) => !h.caps || (Number(h.caps) & 1) === 1;
/* the registry's admission for listing and pricing (unchanged): active, runs code, posts a CPU price */
export const admitted = (h) => !!h && h.active === true && runsCode(h) && Number(h.cpuPricePerSec6) > 0;
const httpsEndpoint = (e) => { try { const u = new URL(e); return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash; } catch { return false; } };

/* One bounded GET: a deadline, no credentials, no redirects, at most `max` bytes. -> parsed JSON; throws with a reason. */
async function getJson(url, { max, deadline }){
  const left = deadline - Date.now();
  if (left <= 0) throw Object.assign(new Error("not checked: the page's time budget ran out"), { budget: true });
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), Math.min(L.REQUEST_TIMEOUT_MS, left));
  try {
    const r = await doFetch(url, { method: "GET", signal: ctl.signal, credentials: "omit", redirect: "error", cache: "no-store", mode: "cors",
      headers: { accept: "application/json" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const text = await boundedText(r, max);
    try { return JSON.parse(text); } catch { throw new Error("not JSON"); }
  } catch (e){
    if (e && e.name === "AbortError") throw new Error("timed out");
    throw e;
  } finally { clearTimeout(timer); }
}
async function boundedText(r, max){
  const declared = Number(r.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new Error("answer larger than " + max + " bytes");
  if (!r.body || !r.body.getReader){ const t = await r.text(); if (new TextEncoder().encode(t).length > max) throw new Error("answer larger than " + max + " bytes"); return t; }
  const rd = r.body.getReader(), parts = []; let n = 0;
  for (;;){
    const { done, value } = await rd.read();
    if (done) break;
    n += value.length;
    if (n > max){ try { await rd.cancel(); } catch {} throw new Error("answer larger than " + max + " bytes"); }
    parts.push(value);
  }
  const all = new Uint8Array(n); let o = 0; for (const p of parts){ all.set(p, o); o += p.length; }
  return new TextDecoder("utf-8", { fatal: true }).decode(all);
}
async function pool(items, n, fn){
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length){ const x = items[i++]; await fn(x); } }));
}

/* capacity mirrors the profile names (optional; validated by js/core/independent.js) */
const mirrors = () => (INDEPENDENT.state === "on" && INDEPENDENT.profile.capacityDirectories) || [];

/**
 * capacityEvidence(snap, hosts, opts) -> {
 *   signedUntil: Map(hostId -> expiresAt ms) of records verified for THIS snapshot's rows,
 *   byHost: Map(hostId -> { status: "verified"|"refused"|"unreachable"|"none"|"equivocation"|"unchecked", reason, expiresAt, issuedAt, sequence }),
 *   sources: [{ source, ok, error?, kind? }], checked, limited, complete }
 *   hosts: the registry rows of `snap` (one agreed read); opts.ids: only these host ids (e.g. the owner's own hosts);
 *   opts.registry / opts.chainId: the binding at that snapshot (defaults: the bound registry and the profile's chain).
 */
export async function capacityEvidence(snap, hosts, { ids = null, registry = REGISTRY_ADDRESS, chainId = INDEPENDENT.profile?.chainId, now = () => Date.now() } = {}){
  const t0 = Date.now(), deadline = t0 + L.TOTAL_MS;
  const binding = { chainId: Number(chainId), registry: String(registry || "").toLowerCase() };
  const out = { signedUntil: new Map(), byHost: new Map(), sources: [], checked: 0, limited: 0, complete: true, block: snap?.number ?? null };
  if (!/^0x[0-9a-f]{40}$/.test(binding.registry)){ out.complete = false; out.sources.push({ source: "registry", ok: false, error: "no registry is bound" }); return out; }
  // admitted rows of this snapshot, by hostId (the record names keccak256(endpoint)); cheapest first so a bounded read
  // reaches the hosts a buyer is likeliest to pick
  const rows = new Map();
  for (const h of hosts.filter(admitted).filter((h) => httpsEndpoint(h.endpoint))
                       .sort((a, b) => Number(a.cpuPricePerSec6) - Number(b.cpuPricePerSec6))){
    const id = keccak256Utf8(h.endpoint);
    if (ids && !ids.includes(id)) continue;
    rows.set(id, { host: h, entry: { endpoint: h.endpoint, operator: String(h.operator).toLowerCase(), active: h.active === true } });
  }
  const targets = [...rows.keys()].slice(0, L.MAX_HOSTS);
  out.limited = rows.size - targets.length;
  if (out.limited > 0){ out.complete = false; out.sources.push({ source: "registry", kind: "limit", ok: false, error: out.limited + " admitted host(s) beyond " + L.MAX_HOSTS + " were not read" }); }
  if (!targets.length) return out;
  let V;
  try { V = await vendor(); }
  catch (e){ out.complete = false; out.sources.push({ source: "verifier", ok: false, error: "the record verifier did not load: " + (e.message || e) }); return out; }
  _floors ||= new V.CapacityFloors();
  const candidates = new Map(targets.map((id) => [id, []]));
  const fresh = (c) => c && Date.now() - c.at < L.REFRESH_MS;
  // 1. mirrors: whatever they list is only a candidate for a host this snapshot admits
  await pool(mirrors(), L.CONCURRENCY, async (origin) => {
    let c = dirCache.get(origin);
    if (!fresh(c)){
      try {
        const body = await getJson(origin + DIRECTORY_CAPACITY_PATH, { max: L.DIRECTORY_BODY_BYTES, deadline });
        const list = Array.isArray(body?.records) ? body.records.slice(0, L.DIRECTORY_RECORDS) : null;
        if (!list) throw new Error("no records list");
        c = { at: Date.now(), envelopes: list, error: null };
      } catch (e){ c = { at: Date.now(), envelopes: [], error: String(e.message || e) }; if (e.budget) out.complete = false; }
      dirCache.set(origin, c);
    }
    out.sources.push({ source: origin, kind: "mirror", ok: !c.error, ...(c.error ? { error: c.error } : { records: c.envelopes.length }) });
    for (const env of c.envelopes){
      const id = String(env?.record?.hostId || "").toLowerCase();
      if (candidates.has(id)) candidates.get(id).push({ env, from: origin });
    }
  });
  // 2. each admitted host's own endpoint
  const unreachable = new Map();
  await pool(targets, L.CONCURRENCY, async (id) => {
    const { entry } = rows.get(id), key = id + "|" + entry.endpoint;
    let c = hostCache.get(key);
    if (!fresh(c)){
      try { c = { at: Date.now(), envelope: await getJson(entry.endpoint.replace(/\/$/, "") + HOST_CAPACITY_PATH, { max: L.HOST_BODY_BYTES, deadline }), error: null }; }
      catch (e){ c = { at: e.budget ? 0 : Date.now(), envelope: null, error: String(e.message || e), budget: !!e.budget }; }
      if (!c.budget) hostCache.set(key, c);
    }
    out.checked++;
    if (c.envelope) candidates.get(id).push({ env: c.envelope, from: "host" });
    else { unreachable.set(id, c.error); if (c.budget) out.complete = false; }
  });
  // 3. verify every candidate against THIS snapshot's row and binding; floors; one record per host
  for (const id of targets){
    const { entry } = rows.get(id), good = [], refused = [];
    for (const { env, from } of candidates.get(id)){
      try {
        const v = await V.verifyHostCapacity(env, { pins: binding, entry, now: now() });
        _floors.check(v.record);
        good.push({ envelope: env, verified: v, from });
      } catch (e){ refused.push(from + ": " + String(e.message || e)); }
    }
    if (good.length){
      const best = V.chooseRecord(good);
      if (best.equivocation){ out.byHost.set(id, { status: "equivocation", reason: "two different records with one sequence from this host's operator" }); continue; }
      const r = best.verified.record;
      _floors.record(r);
      out.signedUntil.set(id, r.expiresAt);
      out.byHost.set(id, { status: "verified", reason: null, expiresAt: r.expiresAt, issuedAt: r.issuedAt, sequence: r.sequence, from: best.from });
    } else if (refused.length) out.byHost.set(id, { status: "refused", reason: "signed capacity record refused (" + refused.slice(0, 2).join("; ") + ")" });
    else if (unreachable.has(id)) out.byHost.set(id, { status: unreachable.get(id).startsWith("not checked") ? "unchecked" : "unreachable",
      reason: "capacity record unavailable: " + unreachable.get(id) });
    else out.byHost.set(id, { status: "none", reason: "no signed capacity record" });
  }
  const hostsDown = [...out.byHost.values()].filter((b) => b.status === "unreachable").length;
  out.sources.push({ source: "hosts", kind: "direct", ok: hostsDown === 0, checked: out.checked, ...(hostsDown ? { error: hostsDown + " host endpoint(s) did not answer" } : {}) });
  return out;
}

/**
 * The shared rule for one registry row of the snapshot, with this page's verified evidence. Admission first (the rule
 * itself refuses inactive and unregistered rows); a refused or unreachable record leaves only the registry-write
 * evidence, with its reason attached. -> network/host-liveness.mjs result + { capacity }
 */
export function livenessOf(h, { chainNowSec, evidence = null, nowMs = Date.now(), registryUpdateWindowSec = REGISTRY_UPDATE_WINDOW_SEC } = {}){
  const id = h && h.endpoint ? keccak256Utf8(h.endpoint) : null;
  const signedUntilMs = evidence && id ? evidence.signedUntil.get(id) ?? null : null;
  const v = hostLiveness(h ? { operator: h.operator, active: h.active === true, lastSeen: Number(h.lastSeen) } : null,
    { nowMs, chainNowSec, signedUntilMs, registryUpdateWindowSec });
  const capacity = evidence && id ? evidence.byHost.get(id) || null : null;
  if (!v.live && capacity && capacity.status !== "verified" && capacity.reason) return { ...v, reason: v.reason + "; " + capacity.reason, capacity };
  return { ...v, capacity };
}

/* When the liveness was last AUTHENTICATED, in chain seconds (the relay publishes the same as lastSeen): the verified
   record's issue time, else the operator's registry write. */
export const authenticatedSeen = (h, live) => live && live.evidence === "signed-record" && live.capacity?.issuedAt
  ? Math.floor(live.capacity.issuedAt / 1000) : Number(h.lastSeen);

/* One plain sentence for the panels: outages are not "no capacity". */
export function evidenceNote(ev){
  if (!ev) return "";
  const down = ev.sources.filter((s) => !s.ok).map((s) => s.source === "hosts" ? s.error : s.source + ": " + s.error);
  return down.length ? "Liveness evidence incomplete - " + down.join("; ") + "." : "";
}
