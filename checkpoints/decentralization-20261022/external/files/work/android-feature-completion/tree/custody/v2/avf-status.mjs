// Google's Android attestation status list (the revocation list for hardware key attestation and RKP-issued chains), as
// the custodian's AVF verifier consults it (custody/v2/avf-evidence.mjs). custody/rules.mjs refuses "avf-pvm" partly because
// "the AVF verifier checks no attestation revocation list": this module is that check.
//
//   GET https://android.googleapis.com/attestation/status
//   { "entries": { "<certificate serial, lowercase hex>": { "status": "REVOKED" | "SUSPENDED", "reason": "..." }, ... } }
//
// The list is NOT signed; HTTPS is its only authentication. So the custodian fetches it ITSELF, over TLS made in its own
// guest, and never accepts a copy someone carried (a host, a relay, a request field). A certificate whose serial is listed,
// with any status, is refused. When the list cannot be read, the last good copy serves until it is maxAgeMs old; after that
// every AVF release is refused as "revocation unknown" (fail closed), never admitted.
import { createHash, X509Certificate } from "node:crypto";

export const GOOGLE_ATTESTATION_STATUS_URL = "https://android.googleapis.com/attestation/status";
export const STATUS_MAX_AGE_MS = 24 * 3600_000;      // Google serves it with max-age=86400
export const STATUS_MAX_BYTES = 16 << 20;
const MAX_ENTRIES = 1_000_000;
const SERIAL = /^[0-9a-f]{1,128}$/;

/** A serial as the list keys it: lowercase hex without leading zeros ("0" for zero). */
export function serialKey(s) {
  const h = String(s || "").toLowerCase().replace(/^0x/, "").replace(/:/g, "");
  if (!SERIAL.test(h)) throw new Error("not a hex certificate serial");
  return h.replace(/^0+(?=.)/, "");
}
/** The status-list keys of a chain's certificates (DER Buffers or base64 strings), leaf first. */
export function chainSerials(chain) {
  return chain.map((d) => serialKey(new X509Certificate(Buffer.isBuffer(d) ? d : Buffer.from(String(d), "base64")).serialNumber));
}

/** Parse the list's bytes strictly -> Map(serialKey -> { status, reason }). Throws for anything malformed. */
export function parseStatusList(bytes) {
  const text = Buffer.from(bytes).toString("utf8");
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error("the attestation status list is not JSON"); }
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || !doc.entries || typeof doc.entries !== "object" || Array.isArray(doc.entries))
    throw new Error("the attestation status list has no entries object");
  const keys = Object.keys(doc.entries);
  if (keys.length > MAX_ENTRIES) throw new Error("the attestation status list is implausibly long");
  const out = new Map();
  for (const k of keys) {
    const e = doc.entries[k];
    if (!e || typeof e !== "object" || typeof e.status !== "string" || !e.status) throw new Error(`the status entry for ${String(k).slice(0, 40)} has no status`);
    let key;
    try { key = serialKey(k); } catch { throw new Error(`the status list keys a non-hex serial ${String(k).slice(0, 40)}`); }
    out.set(key, { status: e.status, reason: typeof e.reason === "string" ? e.reason : null });
  }
  return out;
}

/**
 * createAvfStatusList({ url, fetchImpl, maxAgeMs, refreshMs, timeoutMs, maxBytes, now, log })
 *   -> { check(serials) -> { state: "good"|"revoked"|"unknown", reason, fetchedAt, listSha256 }, refresh(), info() }
 * check() refreshes when the copy is older than refreshMs (one fetch at a time) and judges on the copy it then holds.
 */
export function createAvfStatusList({ url = GOOGLE_ATTESTATION_STATUS_URL, fetchImpl = globalThis.fetch, maxAgeMs = STATUS_MAX_AGE_MS,
                                      refreshMs = Math.min(6 * 3600_000, Math.floor(maxAgeMs / 2)), timeoutMs = 15_000,
                                      maxBytes = STATUS_MAX_BYTES, now = Date.now, log = () => {} } = {}) {
  if (url !== GOOGLE_ATTESTATION_STATUS_URL && !/^https:\/\//.test(url)) throw new Error("the attestation status list is fetched over HTTPS only");
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 60_000 || maxAgeMs > STATUS_MAX_AGE_MS) throw new Error(`maxAgeMs must be 60 s .. ${STATUS_MAX_AGE_MS / 3600_000} h`);
  let copy = null;          // { entries, fetchedAt, sha256, bytes }
  let inflight = null, lastError = null;

  async function fetchList() {
    const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(url, { signal: ctrl.signal, redirect: "error", headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const chunks = []; let seen = 0;
      for await (const c of r.body ?? []) { seen += c.length; if (seen > maxBytes) { ctrl.abort(); throw new Error(`over ${maxBytes} bytes`); } chunks.push(Buffer.from(c)); }
      const bytes = Buffer.concat(chunks);
      const entries = parseStatusList(bytes);
      copy = { entries, fetchedAt: now(), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
      lastError = null;
      log({ ev: "avf-status-list", entries: entries.size, sha256: copy.sha256.slice(0, 16) });
      return copy;
    } finally { clearTimeout(t); }
  }
  async function refresh() {
    if (!inflight) inflight = fetchList().catch((e) => { lastError = String(e.message || e); log({ ev: "avf-status-list-failed", why: lastError }); return null; })
      .finally(() => { inflight = null; });
    return inflight;
  }
  async function check(serials) {
    if (!copy || now() - copy.fetchedAt >= refreshMs) await refresh();
    if (!copy || now() - copy.fetchedAt >= maxAgeMs)
      return { state: "unknown", reason: `the attestation status list is unavailable or older than ${Math.round(maxAgeMs / 3600_000)} h${lastError ? ` (${lastError})` : ""}`,
               fetchedAt: copy ? copy.fetchedAt : null, listSha256: copy ? copy.sha256 : null };
    for (const s of serials) {
      const e = copy.entries.get(serialKey(s));
      if (e) return { state: "revoked", reason: `certificate serial ${serialKey(s).slice(0, 24)} is ${e.status}${e.reason ? ` (${e.reason})` : ""} on Google's attestation status list`,
                      fetchedAt: copy.fetchedAt, listSha256: copy.sha256 };
    }
    return { state: "good", reason: null, fetchedAt: copy.fetchedAt, listSha256: copy.sha256 };
  }
  const info = () => ({ url, entries: copy ? copy.entries.size : null, fetchedAt: copy ? copy.fetchedAt : null, sha256: copy ? copy.sha256 : null, lastError });
  return { check, refresh, info };
}
