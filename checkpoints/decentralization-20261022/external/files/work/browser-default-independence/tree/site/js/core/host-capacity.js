/* ============================================================
   Signed host capacity in the browser (docs/network/independent-capacity.md).

   A port of network/host-capacity-record.mjs checkCapacityRecordShape /
   parseAvailability and network/host-capacity.mjs verifyHostCapacity /
   chooseRecord for the deploy dialog's host list: a record is read from
   the host's own registered endpoint and from the directories this page
   uses, and counts only when:
     - its shape and bounds are exactly v1, it lives at most 15 minutes,
       is unexpired now, and was not issued in the future;
     - hostId = keccak256(endpoint), and chain/registry are the profile's;
     - its EIP-191 signature recovers to its operator, who is the host's
       CURRENT registry operator at the page's agreed block, and the host
       is active there.
   It is the host's own word: never a reservation, never attestation. A
   missing or invalid record is "no capacity report", never "full", and
   an equivocating host (two records, one sequence) shows nothing.
   ============================================================ */
import { canonical } from "../../../network/canonical.mjs";
import { keccak256Utf8 } from "./keccak.js";
import { sha256Hex } from "./sha256.js";

export const HOST_CAPACITY_KIND = "enclave-host-capacity";
export const HOST_CAPACITY_MAX_MS = 15 * 60_000;
export const HOST_CAPACITY_MAX_JSON = 32 * 1024;
export const HOST_CAPACITY_PATH = "/v1/host/capacity";
export const DIRECTORY_CAPACITY_PATH = "/v1/host-capacity";
const CLOCK_SKEW_MS = 60_000, ENVELOPE_MAX = 64 * 1024;
const ADDRESS = /^0x[0-9a-f]{40}$/, ID = /^0x[0-9a-f]{64}$/;
const KEYS = ["version", "kind", "chainId", "registry", "hostId", "endpoint", "operator", "sequence", "issuedAt", "expiresAt", "availabilityJson"];
const SHARES = ["gpuShareFree", "cpuShareFree", "usedGpuShare", "usedCpuShare", "maxShare", "sharePoolFree", "gpuEnclaveCpuShareFree"];
const NONNEG = ["vcpusFree", "ramGbFree", "cpuGflopsFree", "nodeVcpus", "nodeRamGb", "nodeGflops", "machineRamGb", "smFree", "smTotal",
  "vramFreeGb", "gpuTflopsFree", "cardVramGb", "cardTflops", "cards", "physicalGpuCount"];
const PRICES = ["askCpuPricePerSec6", "askGpuPricePerSec6", "askShieldedPricePerSec6"];
const BOOLS = ["gpu", "claimEnabled", "fullService", "networkOptions", "waf", "configOverride", "configCidOverride", "configEdit", "shareResize",
  "cpuFallback", "gpuOptional", "secrets", "secretsInConfig", "customDomains", "devDeploy", "rateCap", "selfHostFree", "proofOfTime"];
const MAX_DEPTH = 8, MAX_KEYS = 256, MAX_ITEMS = 256, MAX_STRING = 4096, BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export const hostCapacityMessage = (r) => `enclave-network:host-capacity:v${r.version}\n${canonical(r)}`;
export const hostCapacityHash = (r) => sha256Hex(canonical(r));
export const hostIdOf = (endpoint) => keccak256Utf8(String(endpoint));

function walk(v, depth, where){
  if (depth > MAX_DEPTH) throw new Error(`availability nests deeper than ${MAX_DEPTH} at ${where}`);
  if (v === null || typeof v === "boolean") return;
  if (typeof v === "number"){ if (!Number.isFinite(v) || Math.abs(v) > Number.MAX_SAFE_INTEGER) throw new Error(`availability number out of range at ${where}`); return; }
  if (typeof v === "string"){ if (v.length > MAX_STRING) throw new Error(`availability string too long at ${where}`); return; }
  if (Array.isArray(v)){ if (v.length > MAX_ITEMS) throw new Error(`availability array too long at ${where}`); v.forEach((x, i) => walk(x, depth + 1, `${where}[${i}]`)); return; }
  if (typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype){
    const keys = Object.keys(v);
    if (keys.length > MAX_KEYS) throw new Error(`availability object too wide at ${where}`);
    for (const k of keys){ if (!/^[\x21-\x7e]{1,128}$/.test(k) || BAD_KEYS.has(k)) throw new Error(`availability key not allowed at ${where}`); walk(v[k], depth + 1, `${where}.${k}`); }
    return;
  }
  throw new Error(`availability holds a non-JSON value at ${where}`);
}
export function parseAvailability(text, window = null){
  if (typeof text !== "string" || !text.length || new TextEncoder().encode(text).length > HOST_CAPACITY_MAX_JSON) throw new Error(`availability must be JSON text of at most ${HOST_CAPACITY_MAX_JSON} bytes`);
  let a; try { a = JSON.parse(text); } catch { throw new Error("availability is not JSON"); }
  if (!a || typeof a !== "object" || Array.isArray(a)) throw new Error("availability must be a JSON object");
  walk(a, 0, "availability");
  for (const k of SHARES) if (k in a && !(typeof a[k] === "number" && a[k] >= 0 && a[k] <= 1)) throw new Error(`availability.${k} must be a share in 0..1`);
  for (const k of NONNEG) if (k in a && a[k] !== null && !(typeof a[k] === "number" && a[k] >= 0)) throw new Error(`availability.${k} must be a non-negative number`);
  for (const k of PRICES) if (k in a && !(Number.isSafeInteger(a[k]) && a[k] >= 0)) throw new Error(`availability.${k} must be a non-negative integer`);
  for (const k of BOOLS) if (k in a && typeof a[k] !== "boolean") throw new Error(`availability.${k} must be a boolean`);
  if ("type" in a && !["gpu", "cpu"].includes(a.type)) throw new Error("availability.type must be gpu or cpu");
  if ("updatedAt" in a){
    const t = typeof a.updatedAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/.test(a.updatedAt) ? Date.parse(a.updatedAt) : NaN;
    if (!Number.isFinite(t)) throw new Error("availability.updatedAt must be an ISO time");
    if (window && (t > window.issuedAt + CLOCK_SKEW_MS || t < window.issuedAt - HOST_CAPACITY_MAX_MS))
      throw new Error("availability.updatedAt is outside the record's lifetime: a stale document cannot be re-signed as fresh");
  }
  return a;
}
export function checkCapacityRecord(r, now = Date.now()){
  if (!r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).length !== KEYS.length || KEYS.some((k) => !Object.hasOwn(r, k)))
    throw new Error("a host capacity record has exactly its fields");
  if (r.version !== 1 || r.kind !== HOST_CAPACITY_KIND) throw new Error("unsupported host capacity record");
  if (!Number.isSafeInteger(r.chainId) || r.chainId <= 0 || !ADDRESS.test(r.registry || "") || !ADDRESS.test(r.operator || "") || /^0x0{40}$/.test(r.operator))
    throw new Error("a host capacity record names its chain, registry and operator (lowercase)");
  if (typeof r.endpoint !== "string" || !/^https:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/.test(r.endpoint) || r.endpoint.length > 512 || !ID.test(r.hostId || ""))
    throw new Error("a host capacity record names its registered https endpoint and hostId = keccak256(endpoint)");
  if (![r.sequence, r.issuedAt, r.expiresAt].every(Number.isSafeInteger) || r.sequence < 1 || r.sequence > r.issuedAt
    || r.expiresAt <= r.issuedAt || r.expiresAt - r.issuedAt > HOST_CAPACITY_MAX_MS)
    throw new Error(`a host capacity record lives at most ${HOST_CAPACITY_MAX_MS / 60000} minutes, and its sequence never runs ahead of its issue time`);
  if (r.issuedAt > now + CLOCK_SKEW_MS) throw new Error("a host capacity record issued in the future");
  if (r.expiresAt <= now) throw Object.assign(new Error("host capacity record expired"), { expired: true });
  if (r.hostId !== hostIdOf(r.endpoint)) throw new Error("a host capacity record names its registered https endpoint and hostId = keccak256(endpoint)");
  return { record: r, availability: parseAvailability(r.availabilityJson, r) };
}

let _recover = null;
const recover = async (message, signature) => {
  _recover ||= (await import(/* @vite-ignore */ "/vendor/discovery.js")).recoverMessageAddress;
  return (await _recover({ message, signature })).toLowerCase();
};
export const _setRecoverForTests = (f) => { _recover = f; };

/* pins = { chainId, registry }; entry = the AGREED registry row for record.hostId: { endpoint, operator, active } or null. */
export async function verifyHostCapacity(envelope, { pins, entry, now = Date.now() }){
  if (!envelope || typeof envelope !== "object" || Object.keys(envelope).sort().join(",") !== "record,signature") throw new Error("a host capacity envelope is exactly { record, signature }");
  const { record, availability } = checkCapacityRecord(envelope.record, now);
  if (record.chainId !== pins.chainId || record.registry !== String(pins.registry).toLowerCase()) throw new Error("the record is for another chain or registry");
  if (typeof envelope.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(envelope.signature)) throw new Error("the record carries no signature");
  let signer;
  try { signer = await recover(hostCapacityMessage(record), envelope.signature); } catch { throw new Error("the signature does not recover"); }
  if (signer !== record.operator) throw new Error("the record is not signed by its operator");
  if (!entry) throw new Error("the host is not in the pinned registry");
  if (entry.endpoint !== record.endpoint) throw new Error("the registry names another endpoint for this host");
  if (String(entry.operator).toLowerCase() !== signer) throw new Error("the signer is not the host's current registry operator");
  if (entry.active !== true) throw new Error("the host is not active in the registry");
  return { record, availability, signer };
}
export function chooseRecord(candidates){
  let best = null, conflict = false;
  for (const c of candidates){
    const r = c.verified.record;
    if (!best || r.sequence > best.verified.record.sequence){ best = c; conflict = false; continue; }
    if (r.sequence === best.verified.record.sequence && hostCapacityHash(r) !== hostCapacityHash(best.verified.record)) conflict = true;
  }
  return conflict ? { equivocation: true } : best;
}

async function boundedJson(url, fetchImpl, timeoutMs){
  const r = await fetchImpl(url, { credentials: "omit", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok){ await r.body?.cancel(); throw new Error("HTTP " + r.status); }
  if (Number(r.headers.get("content-length")) > ENVELOPE_MAX * 64){ await r.body?.cancel(); throw new Error("answer too large"); }
  const t = await r.text();
  if (t.length > ENVELOPE_MAX * 64) throw new Error("answer too large");
  return JSON.parse(t);
}

/* Capacity for the agreed registry rows `hosts` ({endpoint, operator, active, hostId}): each host's own endpoint, plus the
   directories this page uses (js/core/service-discovery.js pageDirectories; unreachable ones are skipped and named).
   -> Map(hostId -> { availability, record, source, expiresInMs } | { error } | { equivocation: true }) and sources[] */
export async function readHostCapacity({ hosts, directories = [], pins, fetchImpl = (...a) => globalThis.fetch(...a), now = Date.now, timeoutMs = 6000 }){
  const byHost = new Map(hosts.filter((h) => h.active).map((h) => [hostIdOf(h.endpoint), { entry: h, found: [], errors: [] }]));
  const sources = [];
  const take = async (envelope, source) => {
    const hid = envelope && envelope.record && envelope.record.hostId;
    const slot = byHost.get(hid);
    if (!slot) return;
    try { slot.found.push({ envelope, source, verified: await verifyHostCapacity(envelope, { pins, entry: slot.entry, now: now() }) }); }
    catch (e){ slot.errors.push(source + ": " + e.message); }
  };
  await Promise.all([
    ...[...byHost.values()].map(async ({ entry }) => {
      if (!/^https:\/\//.test(entry.endpoint)){ sources.push({ source: entry.endpoint, ok: false, error: "not an https endpoint" }); return; }
      try { await take(await boundedJson(entry.endpoint.replace(/\/$/, "") + HOST_CAPACITY_PATH, fetchImpl, timeoutMs), entry.endpoint); sources.push({ source: entry.endpoint, ok: true }); }
      catch (e){ sources.push({ source: entry.endpoint, ok: false, error: e.message }); }
    }),
    ...directories.filter((d) => d.reachable !== false).map(async (d) => {
      try {
        const j = await boundedJson(d.origin + DIRECTORY_CAPACITY_PATH, fetchImpl, timeoutMs);
        const records = Array.isArray(j && j.records) ? j.records.slice(0, 1024) : [];
        for (const env of records) await take(env, d.origin);
        sources.push({ source: d.origin, operator: d.operator || null, ok: true, records: records.length });
      } catch (e){ sources.push({ source: d.origin, operator: d.operator || null, ok: false, error: e.message }); }
    }),
  ]);
  const out = new Map();
  for (const [hid, slot] of byHost){
    if (!slot.found.length){ out.set(hid, { error: slot.errors[0] || "no capacity report" }); continue; }
    const best = chooseRecord(slot.found);
    if (best.equivocation){ out.set(hid, { equivocation: true, error: "the host signed two different records with one sequence" }); continue; }
    out.set(hid, { availability: best.verified.availability, record: best.verified.record, source: best.source, expiresInMs: best.verified.record.expiresAt - now() });
  }
  return { capacity: out, sources };
}

/* One plain line for a host row. */
export function capacityLine(c){
  if (!c) return "no capacity report";
  if (c.error) return c.equivocation ? "capacity report refused: " + c.error : "no capacity report (" + c.error + ")";
  const a = c.availability, mins = Math.max(0, Math.round(c.expiresInMs / 60000));
  const parts = [];
  if (a.gpu === true) parts.push("GPU share free " + Math.round((a.gpuShareFree ?? a.maxShare ?? 0) * 100) + "%");
  if ("cpuShareFree" in a || a.gpu !== true) parts.push("CPU share free " + Math.round((a.cpuShareFree ?? a.maxShare ?? 0) * 100) + "%");
  if (a.claimEnabled === false) parts.push("not claiming new work");
  return "host-reported, signed by its operator, expires in " + mins + " min: " + (parts.join(", ") || "no figures");
}
