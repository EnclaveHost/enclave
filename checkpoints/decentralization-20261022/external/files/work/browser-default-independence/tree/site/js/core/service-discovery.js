/* ============================================================
   Service-index discovery in the browser (docs/network/open-participation.md).

   A port of network/service-index.mjs readServiceIndex onto the page's
   own agreed reader (js/core/quorum.js): ONE block the profile's RPCs
   agree on, the index's runtime code hash equal to the profile's pin
   (never weakened), bounded page() windows and get(operator, slot)
   lookups for operators the user already chose, so no amount of spam in
   the listing can hide them. An ad is an UNTRUSTED CANDIDATE: "the
   holder of this operator key claims a <kind> at these endpoints until
   <expiry>". It proves nothing about honesty or about who runs it, and
   nothing here is admitted automatically.

   Counting: one operator key is one participant, however many endpoints
   its ad lists (they are alternatives, never votes). Distinct keys are
   not distinct organizations, and the page says so.

   Reachability: an http: endpoint cannot be fetched by a page served
   over https (mixed content). It is listed as "not reachable from this
   page" instead of being silently dropped or treated as reachable.
   ============================================================ */
import { keccak256Hex, keccak256Utf8 } from "./keccak.js";

export const SERVICE_KINDS = Object.freeze({ directory: 1, checker: 2, storage: 3, dns: 4, replica: 5 });
export const KIND_NAMES = Object.freeze(Object.fromEntries(Object.entries(SERVICE_KINDS).map(([k, v]) => [v, k])));
export const AD_VERSION = 1;
export const LIMITS = Object.freeze({ slots: 8, endpoints: 4, endpointBytes: 256, ttlSec: 90 * 86400, page: 64, perKind: 1024 });
export const CANDIDATE_NOTICE = "Untrusted candidates: an advertisement is a self-description by its operator key. It does not prove honest "
  + "content, independence (distinct keys are not distinct organizations), an accepted host owner or checker authority. "
  + "Nothing here is admitted automatically.";
export const DISCOVERY_MAX_AGE_MS = 10 * 60 * 1000;

const ADDR = /^0x[0-9a-f]{40}$/, HASH = /^0x[0-9a-f]{64}$/;
const lc = (s) => String(s).toLowerCase();
const sel = (sig) => keccak256Utf8(sig).slice(2, 10);
const SEL = { page: sel("page(uint16,uint256,uint256)"), get: sel("get(address,uint8)") };
const w32 = (n) => BigInt(n).toString(16).padStart(64, "0");

export function validateIndexPin(pin, chainId){
  if (!pin || typeof pin !== "object") throw new Error("service index pin required");
  if (!ADDR.test(lc(pin.address || "")) || /^0x0{40}$/.test(lc(pin.address))) throw new Error("service index address required");
  if (!HASH.test(lc(pin.codeHash || ""))) throw new Error("service index codeHash required");
  return Object.freeze({ chainId, address: lc(pin.address), codeHash: lc(pin.codeHash) });
}

/* ---- endpoints: network/service-index.mjs validateEndpoint, verbatim rules ---- */
const v4 = (h) => { const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/); return m && m.slice(1).every((x) => Number(x) <= 255) ? m.slice(1).map(Number) : null; };
export function publicIPv4(h){
  const a = v4(h); if (!a) return false;
  const [x, y] = a;
  return !(x === 0 || x === 10 || x === 127 || x >= 224 || (x === 100 && y >= 64 && y <= 127) || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31)
    || (x === 192 && y === 168) || (x === 192 && y === 0 && (a[2] === 0 || a[2] === 2)) || (x === 198 && (y === 18 || y === 19))
    || (x === 198 && y === 51 && a[2] === 100) || (x === 203 && y === 0 && a[2] === 113));
}
const BAD_SUFFIX = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|private|home\.arpa|in-addr\.arpa|ip6\.arpa|onion|test|invalid|example)$/i;
export function validateEndpoint(value){
  if (typeof value !== "string" || !value.length || new TextEncoder().encode(value).length > LIMITS.endpointBytes || !/^[\x21-\x7e]+$/.test(value)) throw new Error("endpoint must be 1-256 printable ASCII bytes");
  let u; try { u = new URL(value); } catch { throw new Error("endpoint is not a URL"); }
  if (!["https:", "http:"].includes(u.protocol)) throw new Error("endpoint must be http(s)");
  if (u.username || u.password || u.search || u.hash) throw new Error("endpoint must not carry credentials, a query or a fragment");
  const h = u.hostname.toLowerCase();
  if (h.startsWith("[")) throw new Error("IPv6 literal endpoints are not accepted");
  if (v4(h)){ if (!publicIPv4(h)) throw new Error("endpoint names a non-public IPv4 address"); }
  else {
    if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/.test(h)) throw new Error("endpoint host must be a DNS name with two or more labels");
    if (BAD_SUFFIX.test(h)) throw new Error("endpoint host is a special-use or internal name");
  }
  return u.href;
}

/* Can THIS page fetch it? A page served over https cannot reach http: (mixed content). */
const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
function currentProtocol(){
  try { const l = globalThis.location; if (!l) return ""; if (l.protocol) return l.protocol; return l.origin ? new URL(l.origin).protocol : ""; } catch { return ""; }
}
export function reachability(endpoint, pageProtocol = currentProtocol()){
  const u = new URL(endpoint);
  // a browser blocks plain-HTTP fetches from an HTTPS page (mixed content), except to loopback, which it treats as
  // potentially trustworthy; an unknown page protocol is not guessed
  if (pageProtocol === "https:" && u.protocol === "http:" && !LOOPBACK_NAMES.has(u.hostname)) return { reachable: false, reason: "plain HTTP: a page served over HTTPS cannot reach it" };
  return { reachable: true, reason: "" };
}

/* ---- ABI: the Ad tuple (operator, slot, kind, version, sequence, expiresAt, updatedAt, descriptor, string[] endpoints) ---- */
const MAX_RETURN = 2 * 1024 * 1024;
function cursor(hex){
  const h = String(hex).replace(/^0x/, "");
  if (h.length % 2 || h.length > MAX_RETURN * 2 || !/^[0-9a-f]*$/i.test(h)) throw new Error("malformed index answer");
  const nbytes = h.length / 2;
  const word = (at) => { if (at < 0 || at + 32 > nbytes || at % 1) throw new Error("index answer out of bounds"); return h.slice(at * 2, at * 2 + 64); };
  const uint = (at) => BigInt("0x" + word(at));
  const num = (at, max) => { const v = uint(at); if (v > BigInt(max)) throw new Error("index answer value out of range"); return Number(v); };
  const bytes = (at, n) => { if (at + n > nbytes) throw new Error("index answer out of bounds"); return h.slice(at * 2, (at + n) * 2); };
  return { word, uint, num, bytes, nbytes };
}
function decodeString(c, at){
  const n = c.num(at, LIMITS.endpointBytes * 4);
  const hex = c.bytes(at + 32, n);
  const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder("utf-8", { fatal: true }).decode(b);
}
function decodeAd(c, at){
  const addrWord = c.word(at);
  if (!/^0{24}/.test(addrWord)) throw new Error("malformed operator");
  const ad = { operator: "0x" + addrWord.slice(24), slot: c.num(at + 32, 255), kind: c.num(at + 64, 65535), version: c.num(at + 96, 65535),
    sequence: c.uint(at + 128).toString(), expiresAt: c.uint(at + 160), updatedAt: c.uint(at + 192), descriptor: "0x" + c.word(at + 224) };
  const eAt = at + c.num(at + 256, MAX_RETURN);
  const n = c.num(eAt, 64);                                  // the contract bounds this to 4; refuse absurd answers outright
  const endpoints = [];
  for (let i = 0; i < n; i++) endpoints.push(decodeString(c, eAt + 32 + c.num(eAt + 32 + i * 32, MAX_RETURN)));
  return { ...ad, endpoints };
}
export function decodePage(hex){
  const c = cursor(hex);
  const arr = c.num(0, MAX_RETURN), total = c.uint(32);
  const n = c.num(arr, LIMITS.page);
  const out = [];
  for (let i = 0; i < n; i++) out.push(decodeAd(c, arr + 32 + c.num(arr + 32 + i * 32, MAX_RETURN)));
  return { ads: out, total };
}
export function decodeGet(hex){ const c = cursor(hex); return decodeAd(c, c.num(0, MAX_RETURN)); }

/* ---- judging one ad at the agreed block's time (network/service-index.mjs judge) ---- */
export function judge(a, ts){
  const base = { operator: lc(a.operator), slot: Number(a.slot), kind: Number(a.kind), kindName: KIND_NAMES[Number(a.kind)] || null, sequence: String(a.sequence) };
  if (BigInt(a.expiresAt) <= BigInt(ts)) return { state: "expired", ...base, expiresAt: Number(a.expiresAt) };
  if (Number(a.version) !== AD_VERSION) return { state: "rejected", ...base, reason: `ad format version ${a.version} is not understood` };
  if (!base.kindName) return { state: "rejected", ...base, reason: `kind ${a.kind} is not understood` };
  try {
    if (!Array.isArray(a.endpoints) || !a.endpoints.length || a.endpoints.length > LIMITS.endpoints) throw new Error("1 to 4 endpoints");
    return { state: "listed", candidate: { ...base, version: Number(a.version), expiresAt: Number(a.expiresAt), updatedAt: Number(a.updatedAt),
      descriptor: lc(a.descriptor), endpoints: a.endpoints.map((e) => validateEndpoint(e)), trust: "untrusted-candidate" } };
  } catch (e){ return { state: "rejected", ...base, reason: e.message }; }
}

/* Read the index at ONE agreed block of `reader` -> { status, block, blockHash, blockTime, windows, candidates, rejected,
   expired, lookups, notice }. A disagreement or a code mismatch throws (never an empty list). */
export async function readServiceIndex({ reader, pin, kinds = Object.keys(SERVICE_KINDS), window = 256, lookups = [] }){
  if (!reader) throw new Error("an agreed reader is required");
  if (!Number.isSafeInteger(window) || window < 1 || window > LIMITS.perKind) throw new Error("window must be 1..1024");
  if (!Array.isArray(lookups) || lookups.length > 32) throw new Error("at most 32 operator lookups");
  const snap = await reader.snapshot();
  const code = await reader.code(snap, pin.address);
  const codeHash = code && code !== "0x" ? keccak256Hex(code) : null;
  if (codeHash !== pin.codeHash) throw new Error(`the agreed code at the service index ${pin.address} is ${codeHash || "absent"}, not the pinned ${pin.codeHash}`);
  const windows = {}, candidates = [], rejected = [];
  let expired = 0;
  for (const k of kinds){
    const kind = SERVICE_KINDS[k]; if (!kind) throw new Error("unknown kind " + k);
    const ads = []; let total = 0n;
    for (let at = 0; ads.length < window; at += LIMITS.page){
      const limit = Math.min(LIMITS.page, window - ads.length);
      const page = decodePage(await reader.call(snap, pin.address, "0x" + SEL.page + w32(kind) + w32(at) + w32(limit)));
      total = page.total; ads.push(...page.ads);
      if (page.ads.length < limit || BigInt(at + page.ads.length) >= total) break;
    }
    windows[k] = { total: Number(total), examined: ads.length, complete: BigInt(ads.length) >= total };
    for (const a of ads){
      const j = judge(a, snap.timestamp);
      if (j.state === "listed") candidates.push(j.candidate); else if (j.state === "expired") expired++; else rejected.push(j);
    }
  }
  const found = [];
  for (const l of lookups){
    if (!ADDR.test(lc(l.operator || ""))) throw new Error("lookup operator must be an address");
    const slots = l.slot == null ? [...Array(LIMITS.slots).keys()] : [Number(l.slot)];
    for (const slot of slots){
      const a = decodeGet(await reader.call(snap, pin.address, "0x" + SEL.get + w32(BigInt(lc(l.operator)) ) + w32(slot)));
      if (lc(a.operator) !== lc(l.operator)){ found.push({ operator: lc(l.operator), slot, state: "absent" }); continue; }
      const j = judge(a, snap.timestamp);
      found.push(j.state === "listed" ? { operator: lc(l.operator), slot, state: "listed", candidate: j.candidate } : { operator: lc(l.operator), slot, state: j.state, reason: j.reason || "" });
    }
  }
  const complete = Object.values(windows).every((w) => w.complete);
  return { status: complete ? "complete" : "incomplete", index: pin.address, block: snap.number, blockHash: snap.hash, blockTime: snap.timestamp,
    agreeing: snap.rpcs.length, windows, candidates, rejected, expired, lookups: found, notice: CANDIDATE_NOTICE };
}

/* One participant per operator key: { operator, kinds: {kind: [candidate]}, endpoints (every advertised endpoint once, with
   its reachability from this page) }. */
export function operatorsOf(candidates, pageProtocol){
  const by = new Map();
  for (const c of candidates){
    const o = by.get(c.operator) || { operator: c.operator, kinds: {}, endpoints: [] };
    (o.kinds[c.kindName] ||= []).push(c);
    for (const e of c.endpoints) if (!o.endpoints.some((x) => x.url === e && x.kind === c.kindName))
      o.endpoints.push({ url: e, kind: c.kindName, slot: c.slot, expiresAt: c.expiresAt, ...reachability(e, pageProtocol) });
    by.set(c.operator, o);
  }
  return [...by.values()].sort((a, b) => (a.operator < b.operator ? -1 : 1));
}

/* ---- the user's provider choices (per profile), and the page's directory set ---- */
const choiceKey = (profileId) => "enclave_service_choices:" + profileId;
export function profileId(profile){ return keccak256Utf8(JSON.stringify({ i: profile.serviceIndex, c: profile.contracts, r: profile.rpcs })).slice(2, 18); }
export function loadChoices(profile, store = globalThis.localStorage){
  try { const v = JSON.parse(store.getItem(choiceKey(profileId(profile))) || "null");
    if (v && Array.isArray(v.directoryOperators)) return { directoryOperators: v.directoryOperators.filter((a) => ADDR.test(a)).slice(0, 16) }; } catch {}
  return { directoryOperators: [] };
}
export function saveChoices(profile, choices, store = globalThis.localStorage){
  const ops = [...new Set((choices.directoryOperators || []).map(lc).filter((a) => ADDR.test(a)))].slice(0, 16);
  store.setItem(choiceKey(profileId(profile)), JSON.stringify({ directoryOperators: ops }));
  return { directoryOperators: ops };
}

/* Per-tab cache of the last agreed read (it only nominates; a cold empty cache is a normal start). */
const CACHE_KEY = "enclave_service_index";
let _mem = null;
export async function discover({ profile, reader, force = false, now = Date.now, tab = globalThis.sessionStorage } = {}){
  if (!profile || !profile.serviceIndex) return { off: true, reason: "the network profile pins no service index" };
  const pin = validateIndexPin(profile.serviceIndex, profile.chainId);
  const fresh = (r) => r && r.index === pin.address && now() - r.at < DISCOVERY_MAX_AGE_MS;
  if (!force && fresh(_mem)) return _mem;
  if (!force){ try { const c = JSON.parse(tab.getItem(CACHE_KEY) || "null"); if (fresh(c)) return (_mem = c); } catch {} }
  const choices = loadChoices(profile);
  const res = await readServiceIndex({ reader, pin, kinds: ["directory", "storage", "replica"], window: 256,
    lookups: choices.directoryOperators.map((operator) => ({ operator })) });
  const out = { ...res, at: now() };
  _mem = out; try { tab.setItem(CACHE_KEY, JSON.stringify(out)); } catch {}
  return out;
}

/* The directories this page uses: the profile's own (explicit choices) plus the reachable directory endpoints of the
   operators the user chose. Each entry names its operator (null for a profile directory), so answers can be counted once
   per operator. Unchosen candidates are never used. */
export function pageDirectories(profile, discovery, { pageProtocol, choices = loadChoices(profile) } = {}){
  const out = [], seen = new Set();
  // the profile's own directories are the owner's explicit choice: always attempted (the browser decides), with a warning
  // when this page's protocol makes one unreachable
  for (const d of profile.directories || []) if (!seen.has(d)){
    seen.add(d); const r = reachability(d + "/", pageProtocol);
    out.push({ origin: d, operator: null, source: "profile", reachable: true, reason: "", ...(r.reachable ? {} : { warning: r.reason }) });
  }
  if (discovery && !discovery.off){
    const chosen = new Set(choices.directoryOperators);
    const ads = [...(discovery.candidates || []), ...(discovery.lookups || []).filter((l) => l.state === "listed").map((l) => l.candidate)];
    for (const c of ads) if (c.kindName === "directory" && chosen.has(c.operator)) for (const e of c.endpoints){
      const origin = new URL(e).origin;
      if (seen.has(origin)) continue;
      seen.add(origin); out.push({ origin, operator: c.operator, source: "index", expiresAt: c.expiresAt, ...reachability(e, pageProtocol) });
    }
  }
  return out;
}
/* How many distinct participants a set of answering directories represents: one per operator, one per profile origin. */
export const participantsOf = (answered) => new Set(answered.map((d) => d.operator ? "op:" + d.operator : "origin:" + d.origin)).size;
