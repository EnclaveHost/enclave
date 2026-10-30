// The host capacity record itself, with no package imports (docs/network/independent-capacity.md): its fields, its
// bounds, its signed message and building and signing one. Shipped to hosts by the producer
// (network/host-capacity-producer.mjs); readers use network/host-capacity.mjs, which adds the keccak hostId check,
// signature recovery, registry binding, floors and the aggregate.
//
// The document travels as its exact JSON text (availabilityJson): it is full of fractional numbers (shares, GB) that
// the canonical record encoding does not admit, and readers must see byte for byte what the operator signed.
import { createHash } from "node:crypto";
import { canonical } from "./canonical.mjs";

export const HOST_CAPACITY_KIND = "enclave-host-capacity";
export const HOST_CAPACITY_MAX_MS = 15 * 60_000;
export const HOST_CAPACITY_MAX_JSON = 32 * 1024;
const CLOCK_SKEW_MS = 60_000;
const ADDRESS = /^0x[0-9a-f]{40}$/, ID = /^0x[0-9a-f]{64}$/;
const KEYS = ["version", "kind", "chainId", "registry", "hostId", "endpoint", "operator", "sequence", "issuedAt", "expiresAt", "availabilityJson"];

export const hostCapacityMessage = (r) => `enclave-network:host-capacity:v${r.version}\n${canonical(r)}`;
export const hostCapacityHash = (r) => createHash("sha256").update(canonical(r), "utf8").digest("hex");

// ---- the availability document ---------------------------------------------------------------------------------------
// Preserved as the host published it; bounded everywhere (32 KiB in all), typed where a reader decides on it: the
// aggregate and the rendering read only these fields. Ledger and manager passthroughs (ramFreeMb, nn, volumes,
// guestPool, ...) are carried, bounded, and never refused for their values: a host is not dropped over a field no
// reader uses.
const SHARES = ["gpuShareFree", "cpuShareFree", "usedGpuShare", "usedCpuShare", "maxShare", "sharePoolFree", "gpuEnclaveCpuShareFree"];
const NONNEG = ["vcpusFree", "ramGbFree", "cpuGflopsFree", "nodeVcpus", "nodeRamGb", "nodeGflops", "machineRamGb", "smFree", "smTotal",
  "vramFreeGb", "gpuTflopsFree", "cardVramGb", "cardTflops", "cards", "physicalGpuCount"];
const PRICES = ["askCpuPricePerSec6", "askGpuPricePerSec6", "askShieldedPricePerSec6"];
const BOOLS = ["gpu", "claimEnabled", "fullService", "networkOptions", "waf", "configOverride", "configCidOverride", "configEdit", "shareResize",
  "cpuFallback", "gpuOptional", "secrets", "secretsInConfig", "customDomains", "devDeploy", "rateCap", "selfHostFree", "proofOfTime"];
const MAX_DEPTH = 8, MAX_KEYS = 256, MAX_ITEMS = 256, MAX_STRING = 4096, BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function walk(v, depth, where) {
  if (depth > MAX_DEPTH) throw new Error(`availability nests deeper than ${MAX_DEPTH} at ${where}`);
  if (v === null || typeof v === "boolean") return;
  if (typeof v === "number") { if (!Number.isFinite(v) || Math.abs(v) > Number.MAX_SAFE_INTEGER) throw new Error(`availability number out of range at ${where}`); return; }
  if (typeof v === "string") { if (v.length > MAX_STRING) throw new Error(`availability string too long at ${where}`); return; }
  if (Array.isArray(v)) { if (v.length > MAX_ITEMS) throw new Error(`availability array too long at ${where}`); v.forEach((x, i) => walk(x, depth + 1, `${where}[${i}]`)); return; }
  if (typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    const keys = Object.keys(v);
    if (keys.length > MAX_KEYS) throw new Error(`availability object too wide at ${where}`);
    for (const k of keys) { if (!/^[\x21-\x7e]{1,128}$/.test(k) || BAD_KEYS.has(k)) throw new Error(`availability key not allowed at ${where}`); walk(v[k], depth + 1, `${where}.${k}`); }
    return;
  }
  throw new Error(`availability holds a non-JSON value at ${where}`);
}

/** -> the parsed document, or throws. `window` = { issuedAt, expiresAt } bounds updatedAt when it is present. */
export function parseAvailability(text, window = null) {
  if (typeof text !== "string" || !text.length || Buffer.byteLength(text) > HOST_CAPACITY_MAX_JSON) throw new Error(`availability must be JSON text of at most ${HOST_CAPACITY_MAX_JSON} bytes`);
  let a;
  try { a = JSON.parse(text); } catch { throw new Error("availability is not JSON"); }
  if (!a || typeof a !== "object" || Array.isArray(a)) throw new Error("availability must be a JSON object");
  walk(a, 0, "availability");
  for (const k of SHARES) if (k in a && !(typeof a[k] === "number" && a[k] >= 0 && a[k] <= 1)) throw new Error(`availability.${k} must be a share in 0..1`);
  for (const k of NONNEG) if (k in a && a[k] !== null && !(typeof a[k] === "number" && a[k] >= 0)) throw new Error(`availability.${k} must be a non-negative number`);
  for (const k of PRICES) if (k in a && !(Number.isSafeInteger(a[k]) && a[k] >= 0)) throw new Error(`availability.${k} must be a non-negative integer`);
  for (const k of BOOLS) if (k in a && typeof a[k] !== "boolean") throw new Error(`availability.${k} must be a boolean`);
  if ("type" in a && !["gpu", "cpu"].includes(a.type)) throw new Error("availability.type must be gpu or cpu");
  if ("updatedAt" in a) {
    const t = typeof a.updatedAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/.test(a.updatedAt) ? Date.parse(a.updatedAt) : NaN;
    if (!Number.isFinite(t)) throw new Error("availability.updatedAt must be an ISO time");
    if (window && (t > window.issuedAt + CLOCK_SKEW_MS || t < window.issuedAt - HOST_CAPACITY_MAX_MS))
      throw new Error("availability.updatedAt is outside the record's lifetime: a stale document cannot be re-signed as fresh");
  }
  return a;
}

// ---- the record -------------------------------------------------------------------------------------------------------
/**
 * Structure, bounds and lifetime. -> { record, availability }. The hostId is checked to be well formed here and to be
 * keccak256(endpoint) by network/host-capacity.mjs validateHostCapacityRecord, the readers' check (keccak needs a
 * package this file does without).
 */
export function checkCapacityRecordShape(r, now = Date.now()) {
  if (!r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).length !== KEYS.length || KEYS.some((k) => !Object.hasOwn(r, k)))
    throw new Error("a host capacity record has exactly its fields");
  if (r.version !== 1 || r.kind !== HOST_CAPACITY_KIND) throw new Error("unsupported host capacity record");
  if (!Number.isSafeInteger(r.chainId) || r.chainId <= 0 || !ADDRESS.test(r.registry || "") || !ADDRESS.test(r.operator || "") || /^0x0{40}$/.test(r.operator))
    throw new Error("a host capacity record names its chain, registry and operator (lowercase)");
  if (typeof r.endpoint !== "string" || !/^https:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/.test(r.endpoint) || r.endpoint.length > 512 || !ID.test(r.hostId || ""))
    throw new Error("a host capacity record names its registered https endpoint and hostId = keccak256(endpoint)");
  if (![r.sequence, r.issuedAt, r.expiresAt].every(Number.isSafeInteger) || r.sequence < 1 || r.sequence > r.issuedAt ||
      r.expiresAt <= r.issuedAt || r.expiresAt - r.issuedAt > HOST_CAPACITY_MAX_MS)
    throw new Error(`a host capacity record lives at most ${HOST_CAPACITY_MAX_MS / 60000} minutes, and its sequence never runs ahead of its issue time`);
  if (r.issuedAt > now + CLOCK_SKEW_MS) throw new Error("a host capacity record issued in the future");
  if (r.expiresAt <= now) throw Object.assign(new Error("host capacity record expired"), { expired: true });
  return { record: r, availability: parseAvailability(r.availabilityJson, r) };
}


/**
 * A record for this host, now. hostId = keccak256(endpoint), computed by the caller (host-capacity.mjs hostIdOf, or
 * the Windows node's chain.enclaveIdOf); readers recompute it and refuse a mismatch. `sequence` defaults to the issue
 * time (monotonic for one signer's clock).
 */
export function buildCapacityRecord({ availability, chainId, registry, endpoint, hostId, operator, sequence, now = Date.now(), lifetimeMs = 5 * 60_000 }) {
  const issuedAt = Math.floor(now), text = typeof availability === "string" ? availability : JSON.stringify(availability);
  const r = { version: 1, kind: HOST_CAPACITY_KIND, chainId, registry: String(registry || "").toLowerCase(), hostId: String(hostId || "").toLowerCase(), endpoint,
              operator: String(operator || "").toLowerCase(), sequence: sequence ?? issuedAt, issuedAt, expiresAt: issuedAt + lifetimeMs, availabilityJson: text };
  checkCapacityRecordShape(r, now);
  return r;
}
/** { record, signature } signed by the record's operator account (viem LocalAccount or any { address, signMessage }). */
export async function signCapacityRecord(account, record) {
  checkCapacityRecordShape(record, record?.issuedAt);   // well formed at its own time; freshness is the verifier's question
  if (String(account?.address || "").toLowerCase() !== record.operator) throw new Error("only the record's operator signs it");
  return { record, signature: await account.signMessage({ message: hostCapacityMessage(record) }) };
}
